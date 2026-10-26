import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import https from 'https';
import { spawn, spawnSync } from 'child_process';

const app = express();
const upload = multer({ dest: 'uploads/' });

function normalizeOllamaHost(rawHost) {
  const fallbackHost = 'http://127.0.0.1:11434';
  const value = (rawHost || fallbackHost).trim();

  if (!value) {
    return fallbackHost;
  }

  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return fallbackHost;
  }
}

const OLLAMA_HOST = normalizeOllamaHost(process.env.OLLAMA_HOST);
const OLLAMA_AUTO_START = process.env.OLLAMA_AUTO_START !== 'false';
let ollamaExecutableOverride = process.env.OLLAMA_EXECUTABLE || '';
let ollamaStartPromise = null;

function isLocalOllamaHost() {
  try {
    const hostname = new URL(OLLAMA_HOST).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

function findOllamaExecutable() {
  const driveInstallations = Array.from({ length: 26 }, (_, index) => (
    path.join(`${String.fromCharCode(65 + index)}:`, 'Ollama', 'ollama.exe')
  ));
  const candidates = [
    ollamaExecutableOverride,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Ollama', 'ollama.exe'),
    ...driveInstallations,
  ].filter(Boolean);

  if (process.platform === 'win32') {
    const result = spawnSync('where.exe', ['ollama.exe'], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) {
      candidates.unshift(...result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
    }
  }

  return candidates.find(candidate => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  }) || null;
}

function setOllamaExecutable(executable) {
  const value = typeof executable === 'string' ? executable.trim() : '';
  if (value && !fs.existsSync(value)) {
    throw new Error(`Ollama executable was not found at ${value}`);
  }
  if (value && path.basename(value).toLowerCase() !== 'ollama.exe') {
    throw new Error('Custom Ollama path must point to ollama.exe');
  }
  ollamaExecutableOverride = value;
}

async function ensureOllamaRunning() {
  if (!OLLAMA_AUTO_START || !isLocalOllamaHost()) return;
  if (ollamaStartPromise) return ollamaStartPromise;

  ollamaStartPromise = (async () => {
    try {
      await fetchJsonWithTimeout(`${OLLAMA_HOST}/api/tags`, OLLAMA_CHECK_TIMEOUT_MS);
      return;
    } catch {
      // Start Ollama below when the local API is not already available.
    }

    const executable = findOllamaExecutable();
    if (!executable) {
      throw new Error('Ollama is not installed or could not be located. Install it from https://ollama.com/download.');
    }

    const child = spawn(executable, ['serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    const deadline = Date.now() + OLLAMA_CHECK_TIMEOUT_MS * 3;
    while (Date.now() < deadline) {
      try {
        await fetchJsonWithTimeout(`${OLLAMA_HOST}/api/tags`, OLLAMA_CHECK_TIMEOUT_MS);
        return;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }

    throw new Error(`Ollama was found at ${executable}, but its local API did not start in time.`);
  })().finally(() => {
    ollamaStartPromise = null;
  });

  return ollamaStartPromise;
}

async function readOllamaJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function* streamOllamaResponse(response) {
  if (!response || !response.body || typeof response.body.getReader !== 'function') {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
        if (!payload || payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          if (parsed && typeof parsed === 'object') {
            yield parsed;
          }
        } catch {
          // Ignore partial or malformed NDJSON fragments while streaming.
        }
      }
    }

    const finalChunk = buffer.trim();
    if (finalChunk) {
      const payload = finalChunk.startsWith('data:') ? finalChunk.slice(5).trim() : finalChunk;
      if (payload && payload !== '[DONE]') {
        try {
          const parsed = JSON.parse(payload);
          if (parsed && typeof parsed === 'object') {
            yield parsed;
          }
        } catch {
          // Ignore malformed trailing fragments.
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

const ollama = {
  async list() {
    const response = await fetch(`${OLLAMA_HOST}/api/tags`);
    const payload = await readOllamaJsonResponse(response);
    if (!response.ok) {
      throw new Error(payload.error || `Ollama request failed with status ${response.status}`);
    }

    return {
      models: Array.isArray(payload.models) ? payload.models.map((model) => ({ name: model.name })) : [],
    };
  },

  async pull({ model, stream = true }) {
    const response = await fetch(`${OLLAMA_HOST}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream }),
    });

    if (!response.ok) {
      const payload = await readOllamaJsonResponse(response);
      throw new Error(payload.error || `Ollama pull failed with status ${response.status}`);
    }

    if (!stream) {
      return await readOllamaJsonResponse(response);
    }

    return streamOllamaResponse(response);
  },

  async generate({ model, prompt, keep_alive, options, stream = true }) {
    const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, keep_alive, stream, options }),
    });

    if (!response.ok) {
      const payload = await readOllamaJsonResponse(response);
      throw new Error(payload.error || `Ollama generate failed with status ${response.status}`);
    }

    if (!stream) {
      return await readOllamaJsonResponse(response);
    }

    return streamOllamaResponse(response);
  },

  async chat({ model, messages, keep_alive, options, stream = true }) {
    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, keep_alive, stream, options }),
    });

    if (!response.ok) {
      const payload = await readOllamaJsonResponse(response);
      throw new Error(payload.error || `Ollama chat failed with status ${response.status}`);
    }

    if (!stream) {
      return await readOllamaJsonResponse(response);
    }

    return streamOllamaResponse(response);
  },
};

const SERVER_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const DEV_TUNNEL_DIR = path.join(process.cwd(), '.tools');
const DEV_TUNNEL_EXE = path.join(DEV_TUNNEL_DIR, 'devtunnel.exe');
// How long (seconds) to keep models loaded between requests to avoid cold starts
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE
  ? parseInt(process.env.OLLAMA_KEEP_ALIVE, 10)
  : 3600; // default 1 hour
const OLLAMA_CHECK_TIMEOUT_MS = process.env.OLLAMA_CHECK_TIMEOUT_MS
  ? parseInt(process.env.OLLAMA_CHECK_TIMEOUT_MS, 10)
  : 3000;
// Default model to use (fast: deepseek-coder:1.3b, balanced: qwen2.5-coder:3b, powerful: qwen2.5-coder:7b)
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek-coder:1.3b';
// How many memory items to include in the system prompt (keeps prompts small)
const MEMORY_LIMIT = process.env.MEMORY_LIMIT ? parseInt(process.env.MEMORY_LIMIT, 10) : 10;
// How many chat messages to include from history (keeps old chats usable but faster)
const CHAT_HISTORY_LIMIT = process.env.CHAT_HISTORY_LIMIT ? parseInt(process.env.CHAT_HISTORY_LIMIT, 10) : 8;
// Context window used for generation; smaller values reduce latency on heavier models
const MODEL_NUM_CTX = process.env.MODEL_NUM_CTX ? parseInt(process.env.MODEL_NUM_CTX, 10) : 1024;
// Cap the number of generated tokens so a reply cannot run forever
const MODEL_NUM_PREDICT = process.env.MODEL_NUM_PREDICT ? parseInt(process.env.MODEL_NUM_PREDICT, 10) : 192;
// Fail a slow request instead of waiting indefinitely
const CHAT_TIMEOUT_MS = process.env.CHAT_TIMEOUT_MS ? parseInt(process.env.CHAT_TIMEOUT_MS, 10) : 120000;
// Track last used model to unload it when switching (freeing memory)
let lastLoadedModel = null;
let devTunnelProcess = null;
let devTunnelUrl = '';
let devTunnelState = 'stopped';
let devTunnelInstalling = false;

app.use(express.json());
// Simple request logger to help debug 405/route issues
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// Allow CORS for local development and handle preflight requests
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Data setup ───────────────────────────────────────────
const DATA_DIR    = './data';
const CHATS_FILE  = path.join(DATA_DIR, 'chats.json');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');

try {
  if (!fs.existsSync(DATA_DIR))    fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CHATS_FILE))  fs.writeFileSync(CHATS_FILE,  '{}');
  if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, '[]');
} catch (err) {
  console.error('❌ Failed to initialise data directory:', err.message);
  process.exit(1);
}

const loadChats  = () => JSON.parse(fs.readFileSync(CHATS_FILE,  'utf-8'));
const saveChats  = (d) => fs.writeFileSync(CHATS_FILE,  JSON.stringify(d, null, 2));
const loadMemory = () => JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
const saveMemory = (d) => fs.writeFileSync(MEMORY_FILE, JSON.stringify(d, null, 2));

// ── Get available Ollama models ──────────────────────────
app.get('/api/models', async (req, res) => {
  try {
    const list = await ollama.list();
    const models = list.models.map(m => m.name);
    res.json(models);
  } catch (err) {
    console.error('❌ /api/models error:', err.message);
    res.status(500).json({
      error: `Ollama not running or unreachable at ${OLLAMA_HOST}: ${err.message}`,
    });
  }
});

app.post('/api/models/pull', async (req, res) => {
  try {
    const model = (req.body.model || '').trim();
    if (!model) {
      return res.status(400).json({ error: 'Model name is required' });
    }

    const stream = await ollama.pull({ model, stream: true });
    let lastStatus = 'downloaded';

    for await (const part of stream) {
      if (part?.status) {
        lastStatus = part.status;
      }
    }

    res.json({ ok: true, model, status: lastStatus });
  } catch (err) {
    console.error('❌ /api/models/pull error:', err.message);
    res.status(500).json({ error: formatOllamaError(err) });
  }
});

function formatOllamaError(err) {
  const message = err?.message || 'Unknown Ollama error';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(message)) {
    return `Cannot reach Ollama at ${OLLAMA_HOST}. Start Ollama with \"ollama serve\" or set OLLAMA_HOST to the correct address.`;
  }
  return message;
}

function formatTunnelError(err) {
  const message = err?.message || 'Unknown dev tunnel error';
  if (/login|authenticate|authorization/i.test(message)) {
    return 'Dev Tunnels needs you to sign in first. Run the devtunnel login flow once, then try hosting again.';
  }
  return message;
}

async function ensureDevTunnelBinary() {
  if (fs.existsSync(DEV_TUNNEL_EXE)) {
    return DEV_TUNNEL_EXE;
  }

  if (devTunnelInstalling) {
    return DEV_TUNNEL_EXE;
  }

  devTunnelInstalling = true;
  try {
    await fs.promises.mkdir(DEV_TUNNEL_DIR, { recursive: true });
    const response = await fetch('https://aka.ms/TunnelsCliDownload/win-x64');
    if (!response.ok) {
      throw new Error(`Failed to download Dev Tunnels CLI (${response.status})`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(DEV_TUNNEL_EXE, buffer);
    return DEV_TUNNEL_EXE;
  } finally {
    devTunnelInstalling = false;
  }
}

function extractDevTunnelUrl(text) {
  const match = text.match(/https:\/\/[^\s]+devtunnels\.ms[^\s]*/i);
  return match ? match[0].replace(/[)\],.]+$/g, '') : '';
}

function stopDevTunnel() {
  if (devTunnelProcess && !devTunnelProcess.killed) {
    devTunnelProcess.kill();
  }
  devTunnelProcess = null;
  devTunnelUrl = '';
  devTunnelState = 'stopped';
}

async function startDevTunnel() {
  if (devTunnelProcess && !devTunnelProcess.killed) {
    return { state: devTunnelState, url: devTunnelUrl, port: SERVER_PORT };
  }

  const devtunnelPath = await ensureDevTunnelBinary();

  return new Promise((resolve, reject) => {
    const args = ['host', '-p', String(SERVER_PORT), '--allow-anonymous'];
    const child = spawn(devtunnelPath, args, {
      cwd: process.cwd(),
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    devTunnelProcess = child;
    devTunnelState = 'starting';
    devTunnelUrl = '';

    let settled = false;
    let startupTimer = null;

    const settle = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      resolve(payload);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      devTunnelProcess = null;
      devTunnelState = 'error';
      reject(err);
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const foundUrl = extractDevTunnelUrl(text);
      if (foundUrl) {
        devTunnelUrl = foundUrl;
        devTunnelState = 'running';
        settle({ state: 'running', url: devTunnelUrl, port: SERVER_PORT, output: text.trim() });
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (/error|failed|login|auth/i.test(text)) {
        devTunnelState = 'error';
      }
    });

    child.on('error', fail);
    child.on('exit', (code) => {
      if (devTunnelProcess === child) {
        devTunnelProcess = null;
      }
      if (!settled && code !== 0) {
        fail(new Error(`Dev Tunnels exited with code ${code}`));
      }
      if (devTunnelState === 'running') {
        devTunnelState = 'stopped';
        devTunnelUrl = '';
      }
    });

    startupTimer = setTimeout(() => {
      settle({ state: devTunnelState, url: devTunnelUrl, port: SERVER_PORT, output: 'Dev tunnel is starting...' });
    }, 5000);
  });
}

app.get('/api/tunnel/status', (req, res) => {
  res.json({
    state: devTunnelState,
    url: devTunnelUrl,
    port: SERVER_PORT,
    installed: fs.existsSync(DEV_TUNNEL_EXE),
  });
});

app.post('/api/tunnel/start', async (req, res) => {
  try {
    const result = await startDevTunnel();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: formatTunnelError(err) });
  }
});

app.post('/api/tunnel/stop', (req, res) => {
  stopDevTunnel();
  res.json({ ok: true });
});

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'LocalAI/1.0 Ollama model catalog' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function getFallbackModelCatalog() {
  return [
    { name: 'llama3.2:1b', size: 'low', label: 'Llama 3.2 1B' },
    { name: 'phi3:mini', size: 'low', label: 'Phi-3 Mini' },
    { name: 'llama3.2:3b', size: 'medium', label: 'Llama 3.2 3B' },
    { name: 'qwen2.5:3b', size: 'medium', label: 'Qwen 2.5 3B' },
    { name: 'qwen2.5-coder:3b', size: 'medium', label: 'Qwen 2.5 Coder 3B' },
    { name: 'mistral:7b', size: 'medium', label: 'Mistral 7B' },
    { name: 'llama3.1:8b', size: 'high', label: 'Llama 3.1 8B' },
    { name: 'qwen2.5-coder:7b', size: 'high', label: 'Qwen 2.5 Coder 7B' },
    { name: 'gemma2:9b', size: 'high', label: 'Gemma 2 9B' },
  ];
}

function classifyWebModel(name) {
  if (/(1b|2b|mini|small|tiny)/i.test(name)) return 'low';
  if (/(9b|10b|12b|14b|20b|27b|32b|34b|40b|70b|72b|110b|405b)/i.test(name)) return 'high';
  return 'medium';
}

async function fetchModelCatalog() {
  const html = await fetchTextWithTimeout('https://ollama.com/library', 10000);
  const names = [...html.matchAll(/href=["']\/library\/([a-z0-9._-]+)["']/gi)]
    .map(match => match[1])
    .filter((name, index, list) => list.indexOf(name) === index)
    .slice(0, 150);

  if (names.length === 0) throw new Error('Ollama library returned no models');
  return names.map(name => ({
    name,
    size: classifyWebModel(name),
    label: name,
  }));
}

app.get('/api/model-catalog', async (req, res) => {
  try {
    const models = await fetchModelCatalog();
    res.json({ source: 'ollama-library', models });
  } catch (err) {
    console.warn(`⚠️ Ollama web catalog unavailable; using fallback: ${err.message}`);
    res.json({ source: 'fallback', models: getFallbackModelCatalog() });
  }
});

async function checkOllamaStatus() {
  const tagsUrl = new URL('/api/tags', OLLAMA_HOST).toString();
  const tagsData = await fetchJsonWithTimeout(tagsUrl, OLLAMA_CHECK_TIMEOUT_MS);
  let version = null;

  try {
    const versionUrl = new URL('/api/version', OLLAMA_HOST).toString();
    const versionData = await fetchJsonWithTimeout(versionUrl, OLLAMA_CHECK_TIMEOUT_MS);
    version = typeof versionData.version === 'string' ? versionData.version : null;
  } catch (err) {
    console.warn(`⚠️ Ollama version check failed; tags endpoint is healthy: ${err.message}`);
  }

  return {
    version,
    modelCount: Array.isArray(tagsData.models) ? tagsData.models.length : 0,
  };
}

app.post('/api/ollama/config', (req, res) => {
  try {
    setOllamaExecutable(req.body.executable);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Ollama status ───────────────────────────────────────
app.get('/api/ollama/status', async (req, res) => {
  try {
    await ensureOllamaRunning();
    const status = await checkOllamaStatus();

    res.json({
      running: true,
      host: OLLAMA_HOST,
      version: status.version,
      modelCount: status.modelCount,
    });
  } catch (err) {
    res.status(503).json({
      running: false,
      host: OLLAMA_HOST,
      error: formatOllamaError(err),
    });
  }
});

// ── Web search via DuckDuckGo (no API key needed) ────────
function webSearch(query) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(query);
    const options = {
      hostname: 'api.duckduckgo.com',
      path: `/?q=${encoded}&format=json&no_html=1&skip_disambig=1`,
      method: 'GET',
      headers: { 'User-Agent': 'LocalAI/1.0' },
    };
    const req = https.request(options, (response) => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        try {
          const json = JSON.parse(data);
          const results = [];
          if (json.AbstractText) results.push(`Summary: ${json.AbstractText}`);
          if (json.RelatedTopics) {
            json.RelatedTopics.slice(0, 5).forEach(t => {
              if (t.Text) results.push(t.Text);
            });
          }
          resolve(results.length > 0 ? results.join('\n\n') : 'No results found.');
        } catch (e) {
          resolve('Could not parse search results.');
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Chat CRUD ────────────────────────────────────────────
app.get('/api/chats', (req, res) => {
  try {
    const list = Object.values(loadChats())
      .map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chats/:id', (req, res) => {
  try {
    const chat = loadChats()[req.params.id];
    if (!chat) return res.status(404).json({ error: 'Not found' });
    res.json(chat);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chats', (req, res) => {
  try {
    const chats = loadChats();
    const id    = randomUUID();
    const chat  = { id, title: 'New Chat', model: null, messages: [], updatedAt: new Date().toISOString() };
    chats[id]   = chat;
    saveChats(chats);
    res.json(chat);
  } catch (err) {
    console.error('❌ POST /api/chats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/chats/:id', (req, res) => {
  try {
    const chats = loadChats();
    if (!chats[req.params.id]) return res.status(404).json({ error: 'Not found' });
    chats[req.params.id].title = req.body.title || 'Untitled';
    saveChats(chats);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/chats/:id', (req, res) => {
  try {
    const chats = loadChats();
    delete chats[req.params.id];
    saveChats(chats);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Memory CRUD ──────────────────────────────────────────
app.get('/api/memory', (req, res) => {
  try { res.json(loadMemory()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/memory/:id', (req, res) => {
  try {
    saveMemory(loadMemory().filter(m => m.id !== req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all memories
app.delete('/api/memory', (req, res) => {
  try {
    saveMemory([]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/memory', (req, res) => {
  try {
    const memory = loadMemory();
    const item   = { id: randomUUID(), text: req.body.text, createdAt: new Date().toISOString() };
    memory.push(item);
    saveMemory(memory);
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Unload models to free memory ───────────────────────
async function unloadModel(modelName) {
  if (!modelName) return;
  try {
    console.log(`🔌 Unloading model: ${modelName}`);
    // Send empty generate request with keep_alive: 0 to unload immediately
    await ollama.generate({ model: modelName, prompt: '', keep_alive: 0 });
  } catch (e) {
    // Silent fail - model may not be loaded
  }
}

async function unloadNonActiveModels(activeModel, hintedOldModel) {
  const toUnload = new Set();

  if (hintedOldModel && hintedOldModel !== activeModel) {
    toUnload.add(hintedOldModel);
  }
  if (lastLoadedModel && lastLoadedModel !== activeModel) {
    toUnload.add(lastLoadedModel);
  }

  // Fire-and-forget so unloading does not add latency to the active request.
  for (const name of toUnload) {
    setImmediate(() => unloadModel(name));
  }
}

function getModelOptions(model) {
  const isQwen = /qwen/i.test(model);
  return {
    temperature: isQwen ? 0.2 : 0.7,
    num_ctx: isQwen ? Math.min(MODEL_NUM_CTX, 768) : MODEL_NUM_CTX,
    num_predict: isQwen ? Math.min(MODEL_NUM_PREDICT, 128) : MODEL_NUM_PREDICT,
  };
}

// ── Stream chat ──────────────────────────────────────────
app.post('/chat', upload.array('files', 10), async (req, res) => {
  try {
    const message     = req.body.message     || '';
    const chatId      = req.body.chatId      || null;
    const model       = req.body.model       || DEFAULT_MODEL;
    const useInternet = req.body.useInternet === 'true';
    const oldModel    = req.body.oldModel    || null;
    const files       = req.files || [];

    console.log(`📩 message: "${message}" | model: ${model} | internet: ${useInternet}`);

    // Keep only the current model loaded to reduce RAM/VRAM pressure.
    // Unloading happens in the background so the active request is not delayed.
    unloadNonActiveModels(model, oldModel);
    lastLoadedModel = model;

    // Read uploaded files
    let fileContext = '';
    for (const file of files) {
      const textTypes = ['text/plain','text/csv','application/json','text/html','text/markdown'];
      if (textTypes.includes(file.mimetype)) {
        const content = fs.readFileSync(file.path, 'utf-8');
        fileContext += `\n\nFile "${file.originalname}":\n${content}`;
      } else {
        fileContext += `\n\n[Attached file: ${file.originalname}]`;
      }
      fs.unlinkSync(file.path);
    }

    // Web search if internet mode on
    let searchContext = '';
    if (useInternet) {
      try {
        console.log('🌐 Searching web for:', message);
        searchContext = await webSearch(message);
        console.log('🌐 Search result:', searchContext.slice(0, 100));
      } catch (e) {
        searchContext = 'Web search failed: ' + e.message;
      }
    }

    // ── Build system prompt ──────────────────────────────
    const memory = loadMemory();
    let systemPrompt = `You are a helpful, friendly AI assistant with great memory.`;

    if (memory.length > 0) {
      systemPrompt += `\n\nIMPORTANT - Always remember these facts about the user:\n`;
      // Only include the most recent MEMORY_LIMIT entries to keep prompts small
      const recent = memory.slice(-MEMORY_LIMIT);
      recent.forEach(m => { systemPrompt += `- ${m.text}\n`; });
      if (memory.length > MEMORY_LIMIT) {
        systemPrompt += `\n(Note: Only the most recent ${MEMORY_LIMIT} memories are included to improve response performance.)\n`;
        console.log(`🔧 Memory truncated: sent ${recent.length} of ${memory.length} items`);
      }
    }

    if (useInternet && searchContext) {
      systemPrompt += `\n\nWeb search results for the user's query:\n${searchContext}\n\nUse this information to give an up-to-date answer.`;
    }

    // ── Build messages array ─────────────────────────────
    const messages = [
      { role: 'user',      content: systemPrompt },
      { role: 'assistant', content: 'Understood! I will remember everything and help you effectively.' },
    ];

    if (chatId) {
      const chats = loadChats();
      const chat  = chats[chatId];
      if (chat && chat.messages.length > 0) {
        for (const m of chat.messages.slice(-CHAT_HISTORY_LIMIT)) {
          messages.push({ role: m.role, content: m.content });
        }
        if (chat.messages.length > CHAT_HISTORY_LIMIT) {
          console.log(`🧾 History truncated: sent ${CHAT_HISTORY_LIMIT} of ${chat.messages.length} messages`);
        }
      }
    }

    const userContent = message + fileContext;
    messages.push({ role: 'user', content: userContent });

    console.log(`🧠 Memory: ${memory.length} | History: ${messages.length} | Model: ${model}`);

    // SSE headers
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');

    // Send web search notice if used
    if (useInternet && searchContext) {
      res.write(`data: ${JSON.stringify({ token: '🌐 *Searching the web...*\n\n' })}\n\n`);
    }

    let fullReply = '';
    try {
      const timeoutHandle = setTimeout(() => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: `❌ Request timed out after ${Math.round(CHAT_TIMEOUT_MS / 1000)}s. Try a smaller model or shorter chat history.` })}\n\n`);
          res.end();
        }
      }, CHAT_TIMEOUT_MS);

      const stream = await ollama.chat({
        model,
        messages,
        stream: true,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: getModelOptions(model),
      });

      for await (const chunk of stream) {
        if (res.writableEnded) break;
        const token = chunk.message?.content || '';
        if (token) {
          fullReply += token;
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
        }
      }
      clearTimeout(timeoutHandle);
    } catch (streamErr) {
      console.error('❌ Stream error:', streamErr.message || streamErr);
      console.error('❌ Stream stack:', streamErr.stack || 'No stack trace available');
      const errorMsg = streamErr.message?.includes('memory') 
        ? '❌ Ollama out of memory. Try a smaller model or close other apps.'
        : `❌ Ollama error: ${formatOllamaError(streamErr)}`;
      res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
      res.end();
      return;
    }

    // Save to history
    if (chatId) {
      const chats = loadChats();
      if (chats[chatId]) {
        chats[chatId].model = model;
        chats[chatId].messages.push({ role: 'user',      content: message   });
        chats[chatId].messages.push({ role: 'assistant', content: fullReply });
        chats[chatId].updatedAt = new Date().toISOString();
        if (chats[chatId].messages.length === 2) {
          chats[chatId].title = message.slice(0, 40) + (message.length > 40 ? '...' : '');
        }
        saveChats(chats);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
    console.log('✅ Done');

  } catch (err) {
    console.error('❌ Error:', err.message);
    // Only write SSE error if headers already sent, otherwise send JSON
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// Serve static assets after API routes to avoid accidental method conflicts
app.use(express.static('public'));

app.listen(SERVER_PORT, () => console.log(`✅ Server running at http://localhost:${SERVER_PORT}`));
