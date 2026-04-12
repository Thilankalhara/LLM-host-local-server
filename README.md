# 🤖 Local AI Assistant

A simple local AI chat interface powered by [Ollama](https://ollama.com) and Express.js. Run your own AI models privately on your machine — no internet required.

---

## 📋 Requirements

- [Node.js](https://nodejs.org) v18 or higher
- [Ollama](https://ollama.com) installed and running
- A pulled Ollama model (e.g. `deepseek-coder:1.3b`)

---

## 📁 Folder Structure

```
project/
├── server.js
├── package.json
└── public/
    ├── index.html
    ├── style.css
    └── script.js
```

---

## 🚀 How to Run

### 1. Install Ollama

Download and install from: https://ollama.com/download

npm install 

change package.json's > "type": "module",

### 2. Pull a model

```bash
ollama pull deepseek-coder:1.3b or any 
```

### 3. Start Ollama

```bash
ollama serve
```

> Ollama usually starts automatically after install. If it's already running, skip this step.

### 4. Clone or download this project

```bash
git clone https://github.com/Thilan kalhara/local-ai-assistant.git
cd local-ai-assistant
```

### 5. Install Node dependencies

```bash
npm install
```

### 6. Start the server

```bash
node server.js
```

### 7. Open in browser

```
http://localhost:3000
```

---

## 💬 Usage

- Type a message in the input box and press **Send** or hit **Enter**
- Optionally attach a text file (`.txt`, `.csv`, `.json`, `.html`, `.md`) using the 📎 button
- The AI will read the file contents and respond based on them

---

## ⚙️ Configuration

To change the AI model, edit line in `server.js`:

```js
model: 'deepseek-coder:1.3b',
```

Replace with any model you have pulled. To see available models:

```bash
ollama list
```

Popular models:
| Model | Command |
|-------|---------|
| DeepSeek Coder 1.3b (fast, coding) | `ollama pull deepseek-coder:1.3b` |
| Llama 3.2 3b (general) | `ollama pull llama3.2:3b` |
| Qwen 2.5 3b (general) | `ollama pull qwen2.5:3b` |
| Mistral 7b (powerful) | `ollama pull mistral:7b` |

---

## 📦 Dependencies

```json
{
  "ollama": "^0.5.0",
  "express": "^4.18.0",
  "multer": "^1.4.5"
}
```

Install all with:

```bash
npm install ollama express multer
```

---

## 🛠️ Troubleshooting

**No response / error in browser:**
- Make sure Ollama is running: `ollama serve`
- Make sure the model is pulled: `ollama pull deepseek-coder:1.3b`
- Check the terminal where `node server.js` is running for error messages

**"Cannot find module" error:**
- Run `npm install` in the project folder

**Port already in use:**
- Change `3000` to another port (e.g. `3001`) in `server.js` and visit `http://localhost:3001`

---

## 📄 License

MIT — free to use and modify.
