const input = document.getElementById('input');
const fileInput = document.getElementById('file');
const chat = document.getElementById('chat');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const filePreview = document.getElementById('file-preview');

let abortController = null;
let selectedFiles = []; // track files manually

// When user picks files, add to selectedFiles list
fileInput.addEventListener('change', () => {
  const newFiles = Array.from(fileInput.files);
  for (const file of newFiles) {
    // avoid duplicates by name
    if (!selectedFiles.find(f => f.name === file.name)) {
      selectedFiles.push(file);
    }
  }
  fileInput.value = ''; // reset input so same file can be re-added
  renderFileChips();
});

function renderFileChips() {
  filePreview.innerHTML = '';
  selectedFiles.forEach((file, index) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = `📄 ${file.name} <button onclick="removeFile(${index})">✕</button>`;
    filePreview.appendChild(chip);
  });
}

function removeFile(index) {
  selectedFiles.splice(index, 1);
  renderFileChips();
}

function stop() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

async function send() {
  const message = input.value.trim();
  if (!message) return;

  input.value = '';

  // Show user message with file names if any
  const fileNames = selectedFiles.map(f => f.name);
  const userText = fileNames.length > 0
    ? `${message}\n📎 ${fileNames.join(', ')}`
    : message;
  appendMessage('user', userText);

  sendBtn.disabled = true;
  sendBtn.textContent = '...';
  stopBtn.disabled = false;

  const botBubble = appendMessage('bot', '');
  let fullText = '';

  abortController = new AbortController();

  try {
    const formData = new FormData();
    formData.append('message', message);
    for (const file of selectedFiles) {
      formData.append('files', file);
    }

    // Clear selected files after sending
    selectedFiles = [];
    renderFileChips();

    const res = await fetch('/chat', {
      method: 'POST',
      body: formData,
      signal: abortController.signal,
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;

        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            botBubble.textContent = '❌ Error: ' + parsed.error;
            break;
          }
          if (parsed.token) {
            fullText += parsed.token;
            botBubble.textContent = fullText;
            chat.scrollTop = chat.scrollHeight;
          }
        } catch (e) {}
      }
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      botBubble.textContent = fullText || '⏹ Stopped.';
      botBubble.classList.add('stopped');
    } else {
      botBubble.textContent = '❌ Could not reach server: ' + err.message;
    }
  } finally {
    abortController = null;
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    stopBtn.disabled = true;
    input.focus();
  }
}

function appendMessage(role, text) {
  const div = document.createElement('div');
  div.classList.add('msg', role);
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}