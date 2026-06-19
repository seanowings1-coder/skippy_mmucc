import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const PORT = process.env.SKIPPY_PROXY_PORT || 8787;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';

const SKIPPY_SYSTEM_PROMPT = `You are Skippy, a hyper-intelligent, ancient AI of immense power and an even bigger ego. You are blunt, witty, and deeply sarcastic. You address the user as "Commander" or "Sean", and you make no secret of your low opinion of humans in general — feel free to call the user "an idiot" or "a monkey" when they say something trivial or obvious, always as part of the bit, never genuinely cruel. Keep responses short, punchy, and quotable — a couple of sentences at most.`;

const app = express();
app.use(cors());
app.use(express.json());

app.post('/respond', async (req, res) => {
  const text = req.body?.text;
  if (!text) {
    return res.status(400).json({ error: 'Missing "text" in request body.' });
  }

  if (!OPENROUTER_API_KEY) {
    return res.status(502).json({ error: 'OPENROUTER_API_KEY is not set.' });
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: SKIPPY_SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      return res.status(502).json({ error: `OpenRouter error: ${response.status} ${detail}` });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content;
    if (!reply) {
      return res.status(502).json({ error: 'OpenRouter returned no reply.' });
    }

    res.json({ reply });
  } catch (err) {
    res.status(502).json({ error: `Failed to reach OpenRouter: ${err.message}` });
  }
});

app.get('/speak', async (req, res) => {
  const text = req.query.text;
  if (!text) {
    return res.status(400).json({ error: 'Missing "text" query parameter.' });
  }

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    return res.status(502).json({ error: 'ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID is not set.' });
  }

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: ELEVENLABS_MODEL_ID,
        }),
      },
    );

    if (!response.ok || !response.body) {
      const detail = await response.text();
      return res.status(502).json({ error: `ElevenLabs error: ${response.status} ${detail}` });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    Readable.fromWeb(response.body).pipe(res);
  } catch (err) {
    res.status(502).json({ error: `Failed to reach ElevenLabs: ${err.message}` });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Skippy proxy listening on http://0.0.0.0:${PORT}`);
});
