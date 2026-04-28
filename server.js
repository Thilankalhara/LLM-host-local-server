import { Ollama } from 'ollama';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import https from 'https';

const app = express();
const upload = multer({ dest: 'uploads/' });
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const ollama = new Ollama({ host: OLLAMA_HOST });
// How long (seconds) to keep models loaded between requests to avoid cold starts
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE
  ? parseInt(process.env.OLLAMA_KEEP_ALIVE, 10)
  : 3600; // default 1 hour
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

function formatOllamaError(err) {
  const message = err?.message || 'Unknown Ollama error';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(message)) {
    return `Cannot reach Ollama at ${OLLAMA_HOST}. Start Ollama with \"ollama serve\" or set OLLAMA_HOST to the correct address.`;
  }
  return message;
}

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

app.listen(3000, () => console.log('✅ Server running at http://localhost:3000'));
