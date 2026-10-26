// ── State ────────────────────────────────────────────────
let currentChatId = null;
let selectedFiles = [];
let abortController = null;
let useInternet = false;
let lastUsedModel = null;  // Track model to unload on switch
let deferredInstallPrompt = null;
let ollamaRunning = false;
const STORAGE_API_BASE = 'llmHostApiBase';
const splashScreen = document.getElementById('splash-screen');
const installBtn = document.getElementById('install-btn');
const settingsBtn = document.getElementById('settings-btn');
const ollamaStatus = document.getElementById('ollama-status');
const installOllamaBtn = document.getElementById('install-ollama-btn');
const ollamaPathInput = document.getElementById('ollama-path');
const saveOllamaPathBtn = document.getElementById('save-ollama-path-btn');
const tunnelStatus = document.getElementById('tunnel-status');
const serverUrlInput = document.getElementById('server-url');
const shareUrlOutput = document.getElementById('share-url-output');
const copyUrlBtn = document.getElementById('copy-url-btn');
const connectServerBtn = document.getElementById('connect-server-btn');
const hostBtn = document.getElementById('host-btn');
const pullModelSelect = document.getElementById('pull-model-select');
const pullModelBtn = document.getElementById('pull-model-btn');
const recommendedModelBtn = document.getElementById('recommended-model-btn');
const resourceSummary = document.getElementById('resource-summary');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const appBootTime = performance.now();
const splashMinVisibleMs = 1100;
let apiBaseUrl = normalizeApiBaseUrl(localStorage.getItem(STORAGE_API_BASE) || window.location.origin);

// ── DOM refs ─────────────────────────────────────────────
const chatBox      = document.getElementById('chat');
const input        = document.getElementById('input');
const fileInput    = document.getElementById('file');
const filePreview  = document.getElementById('file-preview');
const sendBtn      = document.getElementById('send-btn');
const stopBtn      = document.getElementById('stop-btn');
const chatList     = document.getElementById('chat-list');
const chatTitle    = document.getElementById('chat-title');
const memoryModal  = document.getElementById('memory-modal');
const memoryList   = document.getElementById('memory-list');
const memoryInput  = document.getElementById('memory-input');
const modelSelect  = document.getElementById('model-select');
const internetBtn  = document.getElementById('internet-btn');

// ── Event listeners ──────────────────────────────────────
document.getElementById('new-chat-btn').addEventListener('click', newChat);
document.getElementById('toggle-sidebar').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('collapsed');
});
document.getElementById('memory-btn').addEventListener('click', openMemory);
document.getElementById('close-memory-btn').addEventListener('click', closeMemory);
settingsBtn.addEventListener('click', openSettings);
closeSettingsBtn.addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});
document.getElementById('memory-modal').addEventListener('click', (e) => {
  if (e.target === memoryModal) closeMemory();
});
document.getElementById('add-memory-btn').addEventListener('click', addMemory);
document.getElementById('clear-memory-btn').addEventListener('click', clearAllMemory);
memoryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addMemory(); });
sendBtn.addEventListener('click', send);
stopBtn.addEventListener('click', stopStream);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
fileInput.addEventListener('change', () => {
  Array.from(fileInput.files).forEach(file => {
    if (!selectedFiles.find(f => f.name === file.name)) selectedFiles.push(file);
  });
  fileInput.value = '';
  renderFileChips();
});

connectServerBtn.addEventListener('click', connectToServer);
serverUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connectToServer();
});
copyUrlBtn.addEventListener('click', copyShareableUrl);
hostBtn.addEventListener('click', hostPublicTunnel);
pullModelBtn.addEventListener('click', pullModel);
recommendedModelBtn.addEventListener('click', async () => {
  const recommendedName = getRecommendedModelName();
  if (!recommendedName) return;
  pullModelSelect.value = recommendedName;
  const selectedOption = pullModelSelect.selectedOptions[0];
  pullModelBtn.disabled = selectedOption?.dataset.installed === 'true';
  updateResourceSummary(recommendedName);
  await pullModel();
});
installOllamaBtn.addEventListener('click', () => {
  window.open('https://ollama.com/download', '_blank', 'noopener,noreferrer');
});
saveOllamaPathBtn.addEventListener('click', saveOllamaPath);
pullModelSelect.addEventListener('change', () => {
  const selected = pullModelSelect.value;
  const selectedOption = pullModelSelect.selectedOptions[0];
  pullModelBtn.disabled = !selected || selectedOption?.dataset.installed === 'true';
  updateResourceSummary(selected);
});

// ── Internet toggle ──────────────────────────────────────
internetBtn.addEventListener('click', () => {
  useInternet = !useInternet;
  internetBtn.textContent = `🌐 Internet: ${useInternet ? 'ON' : 'OFF'}`;
  internetBtn.classList.toggle('on', useInternet);
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  refreshInstallButtonState();
});

installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  refreshInstallButtonState();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  refreshInstallButtonState();
});

// ── Model change listener ────────────────────────────────
modelSelect.addEventListener('change', () => {
  // Keep current chat; only change the model for next send.
});

// ── Init ─────────────────────────────────────────────────
bootstrapApp();

async function bootstrapApp() {
  registerServiceWorker();
  ollamaPathInput.value = localStorage.getItem('ollamaExecutablePath') || '';
  await configureOllamaPath().catch((err) => {
    console.warn('Custom Ollama path could not be configured:', err.message);
  });
  await Promise.allSettled([
    refreshOllamaStatus(),
    refreshTunnelStatus(),
    loadModels(),
    loadChatList(),
  ]);
  refreshInstallButtonState();
  syncServerUrlField();
  await refreshDownloadModelList();
  hideSplashScreen();
  setInterval(refreshOllamaStatus, 15000);
  setInterval(refreshTunnelStatus, 10000);
}

async function configureOllamaPath() {
  const executable = ollamaPathInput.value.trim();
  if (!executable) return;

  const res = await apiFetch('/api/ollama/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ executable }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
}

async function saveOllamaPath() {
  const executable = ollamaPathInput.value.trim();
  try {
    const res = await apiFetch('/api/ollama/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executable }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    localStorage.setItem('ollamaExecutablePath', executable);
    await refreshOllamaStatus();
    alert(executable ? 'Custom Ollama path saved.' : 'Custom Ollama path cleared.');
  } catch (err) {
    alert(`Could not save Ollama path: ${err.message}`);
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  }, { once: true });

  navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((registration) => {
    return registration.update().then(() => registration);
  }).then((registration) => {
    if (registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
  }).catch((err) => {
    console.warn('Service worker registration failed:', err);
  });
}

function hideSplashScreen() {
  const elapsed = performance.now() - appBootTime;
  const wait = Math.max(0, splashMinVisibleMs - elapsed);
  window.setTimeout(() => {
    splashScreen.classList.add('hidden');
    window.setTimeout(() => splashScreen.remove(), 600);
  }, wait);
}

function isAppInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function refreshInstallButtonState() {
  installBtn.hidden = !(deferredInstallPrompt && !isAppInstalled());
}

function openSettings() {
  settingsModal.classList.add('open');
  refreshDownloadModelList();
}

function closeSettings() {
  settingsModal.classList.remove('open');
}

function normalizeApiBaseUrl(value) {
  if (!value) return window.location.origin;
  const trimmed = value.trim();
  if (!trimmed) return window.location.origin;
  try {
    const normalized = trimmed.replace(/\/+$/, '');
    return new URL(normalized).origin;
  } catch (_) {
    return window.location.origin;
  }
}

function getEffectiveShareUrl() {
  const value = (shareUrlOutput.value || serverUrlInput.value || apiBaseUrl || '').trim();
  if (!value) return '';

  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return value.replace(/\/+$/, '');
  }
}

function syncShareableUrlField(value = '') {
  const candidate = (value || getEffectiveShareUrl() || apiBaseUrl || '').trim();
  if (!candidate) {
    shareUrlOutput.value = '';
    return;
  }

  try {
    const url = new URL(candidate.includes('://') ? candidate : `http://${candidate}`);
    const normalized = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    shareUrlOutput.value = normalized;
  } catch {
    shareUrlOutput.value = candidate.replace(/\/+$/, '');
  }
}

async function copyShareableUrl() {
  const value = getEffectiveShareUrl();
  if (!value) {
    alert('No URL is available to copy yet. Connect to a server or start a public tunnel first.');
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    alert('URL copied: ' + value);
  } catch (err) {
    shareUrlOutput.select();
    document.execCommand('copy');
    alert('URL copied: ' + value);
  }
}

function apiUrl(pathname) {
  return new URL(pathname, apiBaseUrl).toString();
}

function apiFetch(pathname, options) {
  return fetch(apiUrl(pathname), options);
}

function syncServerUrlField() {
  serverUrlInput.value = apiBaseUrl === window.location.origin ? '' : apiBaseUrl;
  syncShareableUrlField(serverUrlInput.value || apiBaseUrl);
}

function setApiBaseUrl(nextUrl) {
  apiBaseUrl = normalizeApiBaseUrl(nextUrl);
  localStorage.setItem(STORAGE_API_BASE, apiBaseUrl);
  syncServerUrlField();
}

async function connectToServer() {
  const enteredUrl = serverUrlInput.value.trim();
  if (!enteredUrl) {
    setApiBaseUrl(window.location.origin);
    await Promise.allSettled([refreshOllamaStatus(), loadModels(), loadChatList(), refreshTunnelStatus(), refreshDownloadModelList()]);
    return;
  }

  setApiBaseUrl(enteredUrl);
  tunnelStatus.textContent = 'Tunnel: Connecting';
  tunnelStatus.className = 'status-pill status-warn tunnel-status';

  await Promise.allSettled([refreshOllamaStatus(), loadModels(), loadChatList(), refreshTunnelStatus(), refreshDownloadModelList()]);
}

async function hostPublicTunnel() {
  hostBtn.disabled = true;
  hostBtn.textContent = 'Starting...';
  tunnelStatus.textContent = 'Tunnel: Starting';
  tunnelStatus.className = 'status-pill status-warn tunnel-status';

  try {
    const res = await apiFetch('/api/tunnel/start', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    if (data.url) {
      serverUrlInput.value = data.url;
      syncShareableUrlField(data.url);
      tunnelStatus.textContent = 'Tunnel: Ready';
      tunnelStatus.className = 'status-pill status-online tunnel-status';
      tunnelStatus.title = data.url;
      alert('Public URL ready: ' + data.url + '\nPaste it into the URL bar and click Connect to use it.');
    } else {
      tunnelStatus.textContent = 'Tunnel: Starting';
      tunnelStatus.className = 'status-pill status-warn tunnel-status';
      alert('Dev Tunnels is starting. Check the status pill for updates, then copy the public URL when it appears.');
    }

    await refreshTunnelStatus();
  } catch (err) {
    tunnelStatus.textContent = 'Tunnel: Error';
    tunnelStatus.className = 'status-pill status-offline tunnel-status';
    tunnelStatus.title = err.message;
    alert('Could not start public tunnel: ' + err.message);
  } finally {
    hostBtn.disabled = false;
    hostBtn.textContent = 'Host';
  }
}

async function refreshTunnelStatus() {
  try {
    const res = await apiFetch('/api/tunnel/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.state === 'running' && data.url) {
      tunnelStatus.textContent = 'Tunnel: Live';
      tunnelStatus.className = 'status-pill status-online tunnel-status';
      tunnelStatus.title = data.url;
      if (!serverUrlInput.value.trim() && data.url) {
        serverUrlInput.value = data.url;
      }
      syncShareableUrlField(data.url);
    } else if (data.state === 'starting') {
      tunnelStatus.textContent = 'Tunnel: Starting';
      tunnelStatus.className = 'status-pill status-warn tunnel-status';
    } else if (data.state === 'error') {
      tunnelStatus.textContent = 'Tunnel: Error';
      tunnelStatus.className = 'status-pill status-offline tunnel-status';
    } else {
      tunnelStatus.textContent = 'Tunnel: Off';
      tunnelStatus.className = 'status-pill status-pending tunnel-status';
    }
  } catch (err) {
    tunnelStatus.textContent = 'Tunnel: Unavailable';
    tunnelStatus.className = 'status-pill status-offline tunnel-status';
    tunnelStatus.title = err.message;
  }
}

async function pullModel() {
  const modelName = (pullModelSelect.value || modelSelect.value || '').trim();
  if (!modelName) {
    alert('Choose a model from the dropdown.');
    return;
  }

  if (pullModelSelect.selectedOptions[0]?.dataset.installed === 'true') {
    alert('That model is already installed on this server.');
    return;
  }

  pullModelBtn.disabled = true;
  const previousLabel = pullModelBtn.textContent;
  pullModelBtn.textContent = 'Downloading...';

  try {
    const res = await apiFetch('/api/models/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await refreshDownloadModelList();
    await loadModels();
    alert(`Model downloaded: ${data.model}`);
  } catch (err) {
    alert('Could not download model: ' + err.message);
  } finally {
    pullModelBtn.disabled = false;
    pullModelBtn.textContent = previousLabel;
  }
}

const FALLBACK_MODEL_CATALOG = [
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
let modelCatalog = FALLBACK_MODEL_CATALOG;

function getDeviceProfile() {
  const deviceMemory = navigator.deviceMemory || 4;
  const hardwareConcurrency = navigator.hardwareConcurrency || 4;
  let tier = 'low';
  if (deviceMemory >= 12 || hardwareConcurrency >= 8) tier = 'high';
  else if (deviceMemory >= 6 || hardwareConcurrency >= 6) tier = 'medium';

  return { deviceMemory, hardwareConcurrency, tier };
}

function getRecommendedModels(profile) {
  const recommendedByTier = {
    low: ['llama3.2:1b', 'phi3:mini'],
    medium: ['llama3.2:3b', 'qwen2.5:3b', 'qwen2.5-coder:3b', 'mistral:7b'],
    high: ['llama3.1:8b', 'qwen2.5-coder:7b', 'gemma2:9b'],
  };
  const available = modelCatalog.filter(item => item.size === profile.tier);
  if (available.length > 0) {
    return available.slice(0, 5).map(item => item.name);
  }
  return recommendedByTier[profile.tier] || recommendedByTier.medium;
}

function getRecommendedModelName() {
  const profile = getDeviceProfile();
  const recommended = getRecommendedModels(profile);
  return recommended[0] || 'llama3.2:3b';
}

function updateResourceSummary(selectedModel = '') {
  const profile = getDeviceProfile();
  const recommended = getRecommendedModels(profile);
  const recLabel = recommended.join(', ');
  const installedLabel = selectedModel ? `Selected: ${selectedModel}` : 'Select a model to download';
  resourceSummary.textContent = `Device: ${profile.deviceMemory} GB RAM, ${profile.hardwareConcurrency} cores. Recommended: ${recLabel}. ${installedLabel}`;
}

async function refreshDownloadModelList() {
  try {
    const [installedResponse, catalogResponse] = await Promise.all([
      apiFetch('/api/models'),
      apiFetch('/api/model-catalog'),
    ]);
    const installedModels = installedResponse.ok ? await installedResponse.json() : [];
    if (catalogResponse.ok) {
      const catalogData = await catalogResponse.json();
      if (Array.isArray(catalogData.models) && catalogData.models.length > 0) {
        modelCatalog = catalogData.models;
      }
    }
    const profile = getDeviceProfile();
    const recommendedModels = getRecommendedModels(profile);
    const recommendedSet = new Set(recommendedModels);
    const installedSet = new Set(installedModels);

    pullModelSelect.innerHTML = '';

    const installedGroup = document.createElement('optgroup');
    installedGroup.label = 'Installed on this server';
    if (installedModels.length === 0) {
      const emptyOption = document.createElement('option');
      emptyOption.value = '';
      emptyOption.textContent = 'No models installed yet';
      emptyOption.disabled = true;
      installedGroup.appendChild(emptyOption);
    } else {
      installedModels.forEach((name) => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        option.dataset.installed = 'true';
        installedGroup.appendChild(option);
      });
    }
    pullModelSelect.appendChild(installedGroup);

    const recommendedGroup = document.createElement('optgroup');
    recommendedGroup.label = `Recommended for this device (${profile.tier})`;
    modelCatalog.filter(item => recommendedSet.has(item.name)).forEach((item) => {
      if (installedSet.has(item.name)) return;
      const option = document.createElement('option');
      option.value = item.name;
      option.textContent = `${item.name} — ${item.label}`;
      recommendedGroup.appendChild(option);
    });
    if (recommendedGroup.children.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.disabled = true;
      option.textContent = 'No recommended downloads available';
      recommendedGroup.appendChild(option);
    }
    pullModelSelect.appendChild(recommendedGroup);

    const allGroup = document.createElement('optgroup');
    allGroup.label = 'All supported downloads';
    modelCatalog.filter(item => !installedSet.has(item.name)).forEach((item) => {
      if (recommendedSet.has(item.name)) return;
      const option = document.createElement('option');
      option.value = item.name;
      option.textContent = `${item.name} — ${item.label}`;
      allGroup.appendChild(option);
    });
    if (allGroup.children.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.disabled = true;
      option.textContent = 'All supported models are already installed';
      allGroup.appendChild(option);
    }
    pullModelSelect.appendChild(allGroup);

    const firstDownloadable = Array.from(pullModelSelect.options).find(option => option.value && option.dataset.installed !== 'true' && !option.disabled);
    const fallbackOption = Array.from(pullModelSelect.options).find(option => option.value && !option.disabled);
    pullModelSelect.value = (firstDownloadable || fallbackOption || { value: '' }).value;
    const selectedOption = pullModelSelect.selectedOptions[0];
    pullModelBtn.disabled = !pullModelSelect.value || selectedOption?.dataset.installed === 'true';
    updateResourceSummary(pullModelSelect.value);
  } catch (err) {
    resourceSummary.textContent = `Could not load model suggestions: ${err.message}`;
    pullModelBtn.disabled = true;
  }
}

async function refreshOllamaStatus() {
  try {
    const res = await apiFetch('/api/ollama/status');
    const data = await res.json();
    ollamaRunning = Boolean(data.running);
    if (ollamaRunning) {
      ollamaStatus.textContent = data.version ? `Ollama: Running ${data.version}` : 'Ollama: Running';
      ollamaStatus.className = 'status-pill status-online';
      ollamaStatus.title = `Connected to Ollama at ${data.host}`;
      installOllamaBtn.style.display = 'none';
    } else {
      ollamaStatus.textContent = 'Ollama: Not detected';
      ollamaStatus.className = 'status-pill status-offline';
      ollamaStatus.title = data.error || 'Ollama is not reachable';
      installOllamaBtn.style.display = 'inline-flex';
    }
  } catch (err) {
    ollamaRunning = false;
    ollamaStatus.textContent = 'Ollama: Not detected';
    ollamaStatus.className = 'status-pill status-offline';
    ollamaStatus.title = err.message || 'Ollama is not reachable';
    installOllamaBtn.style.display = 'inline-flex';
  }
}

// ── Load models from Ollama ──────────────────────────────
async function loadModels() {
  try {
    const res = await apiFetch('/api/models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const models = await res.json();
    modelSelect.innerHTML = '';
    if (models.length === 0) {
      const suggested = getRecommendedModelName();
      modelSelect.innerHTML = `<option value="">No models installed — recommended: ${suggested}</option>`;
      return;
    }
    models.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      modelSelect.appendChild(opt);
    });
  } catch (err) {
    console.error('loadModels error:', err);
    const suggested = getRecommendedModelName();
    modelSelect.innerHTML = `<option value="">⚠️ Ollama not running — recommended: ${suggested}</option>`;
  }
}

// ── Chat list ────────────────────────────────────────────
async function loadChatList() {
  try {
    const res = await apiFetch('/api/chats');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const chats = await res.json();
    chatList.innerHTML = '';
    if (chats.length === 0) {
      chatList.innerHTML = '<div style="color:#475569;font-size:0.82rem;padding:12px">No chats yet</div>';
      return;
    }
    chats.forEach(chat => {
      const item = document.createElement('div');
      item.className = 'chat-item' + (chat.id === currentChatId ? ' active' : '');
      item.dataset.id = chat.id;

      const title = document.createElement('span');
      title.className = 'chat-item-title';
      title.textContent = chat.title;

      const actions = document.createElement('div');
      actions.className = 'chat-item-actions';

      const renameBtn = document.createElement('button');
      renameBtn.textContent = '✏️';
      renameBtn.title = 'Rename';
      renameBtn.addEventListener('click', (e) => { e.stopPropagation(); renameChat(chat.id); });

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '🗑️';
      deleteBtn.title = 'Delete';
      deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteChat(chat.id); });

      actions.append(renameBtn, deleteBtn);
      item.append(title, actions);
      item.addEventListener('click', () => openChat(chat.id));
      chatList.appendChild(item);
    });
  } catch (err) {
    console.error('loadChatList error:', err);
  }
}

async function newChat() {
  try {
    const res = await apiFetch('/api/chats', { method: 'POST' });
    const text = await res.text();
    if (!res.ok || !text) throw new Error(`Server error (${res.status}): ${text}`);
    const chat = JSON.parse(text);
    currentChatId = chat.id;
    chatBox.innerHTML = '';
    showEmptyState('Send a message to start');
    chatTitle.textContent = 'New Chat';
    await loadChatList();
    input.focus();
  } catch (err) {
    console.error('newChat error:', err);
    alert('Could not create chat: ' + err.message);
  }
}

async function openChat(id) {
  try {
    currentChatId = id;
    const res = await apiFetch(`/api/chats/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const chat = await res.json();

    if (chat.model) {
      const hasOption = Array.from(modelSelect.options).some(opt => opt.value === chat.model);
      if (hasOption) {
        modelSelect.value = chat.model;
      }
      lastUsedModel = chat.model;
    }

    chatTitle.textContent = chat.title;
    chatBox.innerHTML = '';
    if (chat.messages.length === 0) {
      showEmptyState('Send a message to start');
    } else {
      chat.messages.forEach(m => appendMessage(m.role === 'assistant' ? 'bot' : 'user', m.content));
    }
    document.querySelectorAll('.chat-item').forEach(el => {
      el.classList.toggle('active', el.dataset.id === id);
    });
    input.focus();
  } catch (err) {
    console.error('openChat error:', err);
  }
}

async function renameChat(id) {
  const newTitle = prompt('New name:');
  if (!newTitle) return;
  await apiFetch(`/api/chats/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: newTitle }),
  });
  if (currentChatId === id) chatTitle.textContent = newTitle;
  await loadChatList();
}

async function deleteChat(id) {
  if (!confirm('Delete this chat?')) return;
  await apiFetch(`/api/chats/${id}`, { method: 'DELETE' });
  if (currentChatId === id) {
    currentChatId = null;
    chatBox.innerHTML = '';
    chatTitle.textContent = 'Start a new chat →';
    showEmptyState('Click "＋ New" to start');
  }
  await loadChatList();
}

// ── Memory ───────────────────────────────────────────────
async function openMemory() {
  memoryModal.classList.add('open');
  await loadMemoryList();
}
function closeMemory() { memoryModal.classList.remove('open'); }

async function loadMemoryList() {
  const res = await apiFetch('/api/memory');
  const memory = await res.json();
  memoryList.innerHTML = '';
  if (memory.length === 0) {
    memoryList.innerHTML = '<div class="no-memory">No memories yet. Add things for the AI to remember.</div>';
    return;
  }
  memory.forEach(item => {
    const div = document.createElement('div');
    div.className = 'memory-item';
    const span = document.createElement('span');
    span.textContent = item.text;
    const btn = document.createElement('button');
    btn.textContent = '🗑️';
    btn.addEventListener('click', () => deleteMemory(item.id));
    div.append(span, btn);
    memoryList.appendChild(div);
  });
}

async function addMemory() {
  const text = memoryInput.value.trim();
  if (!text) return;
  await apiFetch('/api/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  memoryInput.value = '';
  await loadMemoryList();
}

async function deleteMemory(id) {
  await apiFetch(`/api/memory/${id}`, { method: 'DELETE' });
  await loadMemoryList();
}

async function clearAllMemory() {
  if (!confirm('Clear all memories? This cannot be undone.')) return;
  try {
    const res = await apiFetch('/api/memory', { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to clear memory');
    await loadMemoryList();
  } catch (err) {
    alert('Could not clear memories: ' + err.message);
  }
}

// ── Files ────────────────────────────────────────────────
function renderFileChips() {
  filePreview.innerHTML = '';
  selectedFiles.forEach((file, i) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    const name = document.createTextNode('📄 ' + file.name + ' ');
    const btn = document.createElement('button');
    btn.textContent = '✕';
    btn.addEventListener('click', () => { selectedFiles.splice(i, 1); renderFileChips(); });
    chip.append(name, btn);
    filePreview.appendChild(chip);
  });
}

// ── Send / stream ────────────────────────────────────────
function stopStream() {
  if (abortController) { abortController.abort(); abortController = null; }
}

async function send() {
  const message = input.value.trim();
  if (!message) return;

  if (!ollamaRunning) {
    await refreshOllamaStatus();
    if (!ollamaRunning) {
      alert('Ollama is not running. Start it with ollama serve and try again.');
      return;
    }
  }

  if (!currentChatId) {
    try {
      const res = await apiFetch('/api/chats', { method: 'POST' });
      const text = await res.text();
      if (!res.ok || !text) throw new Error(`Server error (${res.status})`);
      const chat = JSON.parse(text);
      currentChatId = chat.id;
      chatTitle.textContent = 'New Chat';
      chatBox.innerHTML = '';
      await loadChatList();
    } catch (err) {
      alert('Could not create chat: ' + err.message);
      return;
    }
  }

  input.value = '';
  const userLabel = selectedFiles.length > 0
    ? message + '\n📎 ' + selectedFiles.map(f => f.name).join(', ')
    : message;
  appendMessage('user', userLabel);

  sendBtn.disabled = true;
  sendBtn.textContent = '...';
  stopBtn.disabled = false;

  const botBubble = appendMessage('bot', '▋');
  let fullText = '';
  abortController = new AbortController();

  try {
    const selectedModel = modelSelect.value;
    const formData = new FormData();
    formData.append('message', message);
    formData.append('chatId', currentChatId);
    formData.append('model', selectedModel);
    if (lastUsedModel && lastUsedModel !== selectedModel) {
      formData.append('oldModel', lastUsedModel);
    }
    formData.append('useInternet', useInternet ? 'true' : 'false');
    lastUsedModel = selectedModel;
    selectedFiles.forEach(f => formData.append('files', f));
    selectedFiles = [];
    renderFileChips();

    const res = await apiFetch('/chat', {
      method: 'POST',
      body: formData,
      signal: abortController.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unknown error');
      let errMsg = errText;
      try { errMsg = JSON.parse(errText).error; } catch (_) {}
      botBubble.textContent = '❌ ' + errMsg;
      return;
    }

    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new Error('The chat response did not include a readable stream. Please refresh and try again.');
    }
    if (res.body.locked) {
      throw new Error('The chat response stream is already locked. Please refresh the page and try again.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') { await loadChatList(); break; }
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) { botBubble.textContent = '❌ ' + parsed.error; return; }
            if (parsed.token) {
              fullText += parsed.token;
              renderBotMessage(botBubble, fullText);
              chatBox.scrollTop = chatBox.scrollHeight;
            }
          } catch (_) {}
        }
      }
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      renderBotMessage(botBubble, fullText || '⏹ Stopped.');
      botBubble.classList.add('stopped');
    } else {
      botBubble.textContent = '❌ ' + err.message;
    }
  } finally {
    abortController = null;
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    stopBtn.disabled = true;
    input.focus();
  }
}

// ── Render bot message with code blocks ──────────────────
function renderBotMessage(el, text) {
  el.innerHTML = '';
  const parts = parseCodeBlocks(text);
  parts.forEach(part => {
    if (part.type === 'text') {
      const span = document.createElement('span');
      span.textContent = part.content;
      el.appendChild(span);
    } else {
      el.appendChild(createCodeBlock(part.lang, part.content));
    }
  });
}

function parseCodeBlocks(text) {
  const parts = [];
  const regex = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) {
      parts.push({ type: 'text', content: text.slice(last, match.index) });
    }
    parts.push({ type: 'code', lang: match[1] || 'plaintext', content: match[2] });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    parts.push({ type: 'text', content: text.slice(last) });
  }
  return parts;
}

function createCodeBlock(lang, code) {
  const wrapper = document.createElement('div');
  wrapper.className = 'code-block';

  const header = document.createElement('div');
  header.className = 'code-header';

  const langLabel = document.createElement('span');
  langLabel.className = 'code-lang';
  langLabel.textContent = lang || 'code';

  const btnGroup = document.createElement('div');
  btnGroup.className = 'code-btn-group';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'code-btn';
  copyBtn.textContent = '📋 Copy';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(code).then(() => {
      copyBtn.textContent = '✅ Copied!';
      setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
    });
  });

  const dlBtn = document.createElement('button');
  dlBtn.className = 'code-btn';
  dlBtn.textContent = '⬇️ Download';
  dlBtn.addEventListener('click', () => {
    const ext = langToExt(lang);
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `code.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  });

  btnGroup.append(copyBtn, dlBtn);
  header.append(langLabel, btnGroup);

  const pre = document.createElement('pre');
  const codeEl = document.createElement('code');
  codeEl.textContent = code;
  pre.appendChild(codeEl);

  wrapper.append(header, pre);
  return wrapper;
}

function langToExt(lang) {
  const map = {
    javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts',
    python: 'py', py: 'py', html: 'html', css: 'css',
    json: 'json', bash: 'sh', shell: 'sh', sh: 'sh',
    java: 'java', cpp: 'cpp', c: 'c', go: 'go',
    rust: 'rs', php: 'php', ruby: 'rb', sql: 'sql',
    yaml: 'yaml', xml: 'xml', markdown: 'md', md: 'md',
  };
  return map[lang?.toLowerCase()] || 'txt';
}

// ── Helpers ──────────────────────────────────────────────
function appendMessage(role, text) {
  const empty = chatBox.querySelector('.empty-state');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (role === 'bot') {
    renderBotMessage(div, text);
  } else {
    div.textContent = text;
  }
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
  return div;
}

function showEmptyState(msg) {
  chatBox.innerHTML = `<div class="empty-state"><div>🤖</div>${msg}</div>`;
}