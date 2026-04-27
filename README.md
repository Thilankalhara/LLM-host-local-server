# 🤖 Local AI Assistant

A fully local AI chat app powered by [Ollama](https://ollama.com) and Express.js.  
Runs 100% on your PC — no internet required, no API costs, total privacy.

---

## ✨ Features

- 💬 **Chat history** — all conversations saved and reloadable
- 🧠 **Memory** — save facts the AI always remembers
- 📎 **Multiple file uploads** — attach `.txt`, `.csv`, `.json`, `.html`, `.md` files
- ⚡ **Streaming** — see the AI typing word by word
- ⏹ **Stop button** — cancel generation anytime
- 📋 **Copy code** — one-click copy any code block
- ⬇️ **Download code** — download code blocks as files with correct extension
- ☰ **Collapsible sidebar** — more space when you need it

---

## 📋 Requirements

| Tool | Version | Download |
|------|---------|----------|
| Node.js | v18 or higher | https://nodejs.org |
| Ollama | Latest | https://ollama.com/download |

---

## 📁 Folder Structure

```
project/
├── server.js           ← Backend server
├── package.json        ← Node dependencies
├── data/               ← Auto-created on first run
│   ├── chats.json      ← Chat history
│   └── memory.json     ← Saved memories
├── uploads/            ← Temp folder for file uploads
└── public/             ← Frontend files
    ├── index.html
    ├── style.css
    └── script.js
```

---

## 🚀 Setup & Run

### Step 1 — Install Ollama

Download from https://ollama.com/download and install it.

### Step 2 — Pull an AI model

Open PowerShell or Terminal and run:

```powershell
ollama pull deepseek-coder:1.3b
```

> 💡 See other model options at the bottom of this file.

### Step 3 — Clone or download this project

Put all files in a folder. Make sure the structure matches the one above.

### Step 4 — Install Node.js packages

Open PowerShell **inside your project folder** and run:

```powershell
npm install ollama express multer
```

### Step 5 — Set module type

```powershell
npm pkg set type="module"
```

### Step 6 — Create data folder

```powershell
mkdir data
```

### Step 7 — Start the server

You can start the server in either of these ways:

**Option A (Recommended):**
```powershell
npm start
```

**Option B:**
```powershell
node server.js
```

You should see:
```
✅ Server running at http://localhost:3000
```

### Step 8 — Open in browser

Go to: **http://localhost:3000**

---

## 💬 How to Use

### Chatting
1. Click **＋ New** in the sidebar to start a new chat
2. Type your message and press **Enter** or click **Send**
3. The AI will respond word by word (streaming)
4. Click **⏹** to stop the AI mid-response

### Chat History
- All chats are saved automatically
- Click any chat in the sidebar to reload it
- Click ✏️ to rename a chat
- Click 🗑️ to delete a chat
- Click ☰ to collapse/expand the sidebar

### Memory
- Click **🧠 Memory** at the bottom of the sidebar
- Add facts like:
  - `My name is John`
  - `I prefer Python over JavaScript`
  - `I am working on a React project`
- The AI will remember these in every conversation
- Click 🗑️ next to any memory to delete it

### File Uploads
- Click **📎** to attach files (supports multiple)
- Supported: `.txt`, `.csv`, `.json`, `.html`, `.md`
- Files appear as chips — click ✕ to remove before sending

### Code Blocks
- AI responses with code show a **header bar**
- Click **📋 Copy** to copy the code to clipboard
- Click **⬇️ Download** to save the code as a file (auto-detects extension: `.py`, `.js`, `.html`, etc.)

---

## ⚙️ Changing the AI Model

Edit line in `server.js`:

```js
model: 'deepseek-coder:1.3b',
```

Replace with your model name. Check installed models:

```powershell
ollama list
```

### Recommended models for 8GB RAM

| Model | Command | Best for |
|-------|---------|----------|
| `deepseek-coder:1.3b` | `ollama pull deepseek-coder:1.3b` | Fast coding (1GB) |
| `qwen2.5-coder:3b` | `ollama pull qwen2.5-coder:3b` | Better coding (2GB) |
| `qwen2.5-coder:7b` | `ollama pull qwen2.5-coder:7b` | Best coding (4.7GB) ⭐ |
| `llama3.2:3b` | `ollama pull llama3.2:3b` | General chat (2GB) |
| `phi4-mini` | `ollama pull phi4-mini` | Smart & fast (2GB) |

> ⚠️ Do NOT use models above 5GB on 8GB RAM — Windows needs ~3GB itself.

---

## 🛠️ Troubleshooting

**"Cannot find package 'ollama'"**
```powershell
npm install ollama express multer
```

**"Cannot use import statement"**
```powershell
npm pkg set type="module"
```

**Send button does nothing**
- Open browser F12 → Console tab and check for red errors
- Make sure `node server.js` is running in the terminal
- Make sure you're in the right project folder

**No AI response / model error**
- Check Ollama is running: `ollama serve`
- Check model is installed: `ollama list`
- Make sure model name in `server.js` matches exactly

**Port already in use**
- Change `3000` to `3001` in `server.js`
- Visit `http://localhost:3001`

**"Could not create chat: Server error (405)"**

This error occurs when the browser blocks POST requests to `/api/chats` due to CORS (Cross-Origin Resource Sharing) preflight failures. **This project already includes the fix** — the code handles:

- ✅ **CORS middleware** — automatically sends required headers for browser requests
- ✅ **OPTIONS preflight handler** — responds to browser preflight checks
- ✅ **Static middleware ordering** — places API routes before static file serving to prevent method conflicts

**If you still see this error after a fresh install:**

1. Make sure you're opening the app at **http://localhost:3000** (not `file://` or another origin)
2. Make sure `npm start` is running (see terminal for `✅ Server running at http://localhost:3000`)
3. Hard-refresh the browser: `Ctrl+Shift+R` (Windows/Linux) or `Cmd+Shift+R` (Mac)
4. Check DevTools (F12) → Network tab → find the `/api/chats` request → paste the **Status**, **Request/Response Headers**, and **Response body** in an issue

The fix is built into this version — no additional setup needed. If you're on another PC and the error persists, verify:
- Node.js version is 18+ (`node --version`)
- All dependencies installed (`npm install`)
- Server logs show no errors when starting

---

## 📄 License

MIT — free to use, modify, and share.
