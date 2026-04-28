// ── State ────────────────────────────────────────────────
let currentChatId = null;
let selectedFiles = [];
let abortController = null;
let useInternet = false;
let lastUsedModel = null;  // Track model to unload on switch

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

// ── Internet toggle ──────────────────────────────────────
internetBtn.addEventListener('click', () => {
  useInternet = !useInternet;
  internetBtn.textContent = `🌐 Internet: ${useInternet ? 'ON' : 'OFF'}`;
  internetBtn.classList.toggle('on', useInternet);
});

// ── Model change listener ────────────────────────────────
modelSelect.addEventListener('change', () => {
  // Keep current chat; only change the model for next send.
});

// ── Init ─────────────────────────────────────────────────
loadModels();
loadChatList();

// ── Load models from Ollama ──────────────────────────────
async function loadModels() {
  try {
    const res = await fetch('/api/models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const models = await res.json();
    modelSelect.innerHTML = '';
    if (models.length === 0) {
      modelSelect.innerHTML = '<option value="">No models found</option>';
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
    modelSelect.innerHTML = '<option value="">⚠️ Ollama not running</option>';
  }
}

// ── Chat list ────────────────────────────────────────────
async function loadChatList() {
  try {
    const res = await fetch('/api/chats');
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
    const res = await fetch('/api/chats', { method: 'POST' });
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
    const res = await fetch(`/api/chats/${id}`);
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
  await fetch(`/api/chats/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: newTitle }),
  });
  if (currentChatId === id) chatTitle.textContent = newTitle;
  await loadChatList();
}

async function deleteChat(id) {
  if (!confirm('Delete this chat?')) return;
  await fetch(`/api/chats/${id}`, { method: 'DELETE' });
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
  const res = await fetch('/api/memory');
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
  await fetch('/api/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  memoryInput.value = '';
  await loadMemoryList();
}

async function deleteMemory(id) {
  await fetch(`/api/memory/${id}`, { method: 'DELETE' });
  await loadMemoryList();
}

async function clearAllMemory() {
  if (!confirm('Clear all memories? This cannot be undone.')) return;
  try {
    const res = await fetch('/api/memory', { method: 'DELETE' });
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

  if (!currentChatId) {
    try {
      const res = await fetch('/api/chats', { method: 'POST' });
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

    const res = await fetch('/chat', {
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

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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