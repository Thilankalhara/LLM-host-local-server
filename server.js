import ollama from 'ollama';
import express from 'express';
import multer from 'multer';
import fs from 'fs';

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static('public'));

app.get('/test', (req, res) => {
  res.send('Server is running!');
});

// Changed upload.single to upload.array to support multiple files
app.post('/chat', upload.array('files', 10), async (req, res) => {
  try {
    console.log('Received message:', req.body.message);
    const message = req.body.message || '';
    const files = req.files || [];

    let finalPrompt = message;

    if (files.length > 0) {
      const textTypes = ['text/plain', 'text/csv', 'application/json', 'text/html', 'text/markdown'];
      for (const file of files) {
        console.log('File received:', file.originalname);
        if (textTypes.includes(file.mimetype)) {
          const content = fs.readFileSync(file.path, 'utf-8');
          finalPrompt += `\n\nFile: ${file.originalname}\nContents:\n${content}`;
        } else {
          finalPrompt += `\n\nUser uploaded a file: ${file.originalname} (${file.mimetype})`;
        }
        fs.unlinkSync(file.path);
      }
    }

    // Set headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    console.log('Streaming from Ollama...');

    const stream = await ollama.chat({
      model: 'qwen3.5:4b',   // update ur model here
      messages: [{ role: 'user', content: finalPrompt }],
      stream: true,
    });

    for await (const chunk of stream) {
      const token = chunk.message?.content || '';
      if (token) {
        res.write(`data: ${JSON.stringify({ token })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    console.error('Error:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});