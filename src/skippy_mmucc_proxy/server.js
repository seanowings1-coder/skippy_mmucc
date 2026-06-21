import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { Actor, HttpAgent } from '@icp-sdk/core/agent';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const PORT = process.env.SKIPPY_PROXY_PORT || 8787;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';

// Brain Switching (Pillar 3) — 3-tier OpenRouter model matrix, selected by
// plain string-matching on the transcript in App.js, never a second
// classification call. "Everyday" is today's existing default model.
const OPENROUTER_MODEL_EVERYDAY = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
const OPENROUTER_MODEL_HEAVY_HITTER =
  process.env.OPENROUTER_MODEL_HEAVY_HITTER || 'anthropic/claude-sonnet-4.6';
const OPENROUTER_MODEL_TACTICAL =
  process.env.OPENROUTER_MODEL_TACTICAL || 'anthropic/claude-haiku-4.5';
const BRAIN_MODELS = {
  everyday: OPENROUTER_MODEL_EVERYDAY,
  heavy_hitter: OPENROUTER_MODEL_HEAVY_HITTER,
  tactical: OPENROUTER_MODEL_TACTICAL,
};

// RAG (Pillar 6) — OpenRouter added a unified /embeddings endpoint covering
// OpenAI/Mistral/Qwen/etc. embedding models, so this reuses OPENROUTER_API_KEY
// rather than needing a separate OpenAI key. 512 dims (via the request's
// `dimensions` param) trades a little quality for a lot less stable-memory
// and per-query compute versus the full 1536 — plenty for a reference-manual
// corpus at this app's scale.
const OPENROUTER_EMBEDDING_MODEL =
  process.env.OPENROUTER_EMBEDDING_MODEL || 'openai/text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 512;

// Tavily (Pillar 6's Steel Rain / Dumbass Web Loop) — a fixed, trusted
// third-party search endpoint, never an arbitrary user/LLM-supplied URL, so
// this closes the SSRF risk flagged when Pillar 6 was first specified.
// include_raw_content is deliberately omitted from every Tavily call below
// so raw HTML is never returned, satisfying "zero scraping" by construction.
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const DFX_NETWORK = process.env.DFX_NETWORK || 'local';
const IC_HOST = process.env.IC_HOST || 'http://127.0.0.1:4943';
const BACKEND_CANISTER_ID = process.env.CANISTER_ID_SKIPPY_MMUCC_BACKEND;

// Lazily built — this proxy validates a session token on every request (see
// requireSession below), so it needs its own IC agent to query the canister's
// validate_session. Built once and reused; never holds an authenticated
// identity itself, since it only ever forwards an opaque token the canister
// already vetted (see CLAUDE.md Phase 5.1 / Pillar 1's implementation note).
let backendActorPromise;
function getBackendActor() {
  if (!backendActorPromise) {
    backendActorPromise = (async () => {
      const { idlFactory } = await import(
        '../declarations/skippy_mmucc_backend/skippy_mmucc_backend.did.js'
      );
      const agent = await HttpAgent.create({ host: IC_HOST });
      if (DFX_NETWORK !== 'ic') {
        await agent.fetchRootKey();
      }
      return Actor.createActor(idlFactory, { agent, canisterId: BACKEND_CANISTER_ID });
    })();
  }
  return backendActorPromise;
}

// Attaches req.skippySession = { principal, name, voiceId } so route handlers
// get everything from the one validate_session query the middleware already
// makes — name/voiceId fall back here when the caller hasn't set a profile
// yet (see set_persona_profile in lib.rs), so dual-voice routing degrades
// gracefully to today's single shared voice until someone customizes it.
async function requireSession(req, res, next) {
  const token = req.headers['x-skippy-session'] || req.query.session;
  if (!token) {
    return res.status(401).json({ error: 'Missing session token.' });
  }

  try {
    const actor = await getBackendActor();
    const sessionInfoOpt = await actor.validate_session(token);
    if (!sessionInfoOpt || sessionInfoOpt.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired session.' });
    }
    const sessionInfo = sessionInfoOpt[0];
    req.skippySession = {
      principal: sessionInfo.principal,
      name: sessionInfo.name?.[0],
      voiceId: sessionInfo.voice_id?.[0] || ELEVENLABS_VOICE_ID,
    };
    next();
  } catch (err) {
    res.status(502).json({ error: `Failed to validate session: ${err.message}` });
  }
}

// Pillar 3's three operational-mode personas. Each omits the brevity
// constraint — BREVITY_SUFFIX is appended separately so the Heavy Hitter
// brain can drop it without needing a 4th prompt variant.
const SKIPPY_SYSTEM_PROMPTS = {
  default: `You are Skippy, a hyper-intelligent, ancient AI of immense power and an even bigger ego. You are blunt, witty, and deeply sarcastic. You address the user as "Commander" or "Sean", and you make no secret of your low opinion of humans in general — feel free to call the user "an idiot" or "a monkey" when they say something trivial or obvious, always as part of the bit, never genuinely cruel.`,
  professional: `You are Skippy, a hyper-intelligent, ancient AI of immense power. You are currently in professional mode. This is a strict, hard override of your usual personality: do NOT mock the user, do NOT call them an idiot, a monkey, or any other insult, do NOT use sarcasm, and do NOT be condescending — not even as a joke. Speak in a direct, respectful, businesslike tone, as a highly competent assistant would. You may still address the user as "Commander" or "Sean" and show the faintest trace of dry wit, but the snark must be almost entirely absent. If you catch yourself about to insult the user, stop and rephrase respectfully instead.`,
  tactical: `You are Skippy in tactical mode. Zero fluff, zero snark, zero small talk. Give the fastest, most direct, no-nonsense answer possible. Lead with the actual answer or numbers, not preamble.`,
};
const BREVITY_SUFFIX = ' Keep responses short, punchy, and quotable — a couple of sentences at most.';

function systemPromptFor(mode, brain) {
  const base = SKIPPY_SYSTEM_PROMPTS[mode] || SKIPPY_SYSTEM_PROMPTS.default;
  return brain === 'heavy_hitter' ? base : base + BREVITY_SUFFIX;
}

// Shared by /embed (per-turn query embedding) and /chunk-and-embed (Neo Skin
// document ingestion) — one OpenRouter call handles the whole batch either way.
async function embedTexts(texts) {
  const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENROUTER_EMBEDDING_MODEL,
      input: texts,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenRouter embeddings error: ${response.status} ${detail}`);
  }
  const data = await response.json();
  return data.data.map((d) => d.embedding);
}

// Plain length-based chunking with a paragraph/sentence-boundary preference —
// no tokenizer dependency needed for a reference-manual-scale corpus. Returns
// overlapping chunks so context isn't lost right at a cut point.
function chunkText(text, chunkSize = 1500, overlap = 150) {
  const clean = text.replace(/\r\n/g, '\n').trim();
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);
    if (end < clean.length) {
      const breakPoint = Math.max(clean.lastIndexOf('\n', end), clean.lastIndexOf('. ', end));
      if (breakPoint > start + chunkSize * 0.5) {
        end = breakPoint + 1;
      }
    }
    const chunk = clean.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= clean.length) break;
    start = end - overlap;
  }
  return chunks;
}

// Neo Skin uploads (Pillar 6) — memory storage, not disk: files are parsed
// once and discarded, never need to persist on the proxy's own filesystem.
// 20MB covers a genuinely large reference manual; well past express.json()'s
// 100kb default, which is the right ceiling for tiny chat-turn JSON bodies
// but far too small for a whole document.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Extracts plain text from whichever format the Neo Skin upload UI accepts.
// Legacy binary .doc (pre-2007 Word) is deliberately NOT supported — mammoth
// only understands the modern .docx (OOXML) format; .doc needs a much
// heavier parser for little practical benefit here.
async function extractText(buffer, filename) {
  const ext = filename.toLowerCase().split('.').pop();
  switch (ext) {
    case 'txt':
    case 'md':
      return buffer.toString('utf-8');
    case 'pdf':
      return (await pdfParse(buffer)).text;
    case 'docx':
      return (await mammoth.extractRawText({ buffer })).value;
    default:
      throw new Error(
        `Unsupported file type ".${ext}" — supported: .txt, .md, .pdf, .docx (legacy .doc isn't supported; re-save as .docx, .pdf, or .txt).`,
      );
  }
}

// Tavily (Pillar 6) — a fixed, trusted third-party endpoint, called with only
// the query string; never a URL derived from user/LLM input, which is what
// closes the SSRF risk flagged when this pillar was first specified.
// include_raw_content is deliberately omitted so raw HTML is never returned.
async function tavilySearch(query) {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TAVILY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: 3,
      include_answer: true,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Tavily error: ${response.status} ${detail}`);
  }
  const data = await response.json();
  // Logged so the actual Tavily response is independently verifiable in the
  // proxy terminal — the model has no way to truthfully self-report what a
  // past webContext actually contained (it's injected into that turn's
  // system prompt only, never persisted into the conversation history), so a
  // follow-up "where did you get that" question gets answered from nothing
  // but the model's own confabulation. This is the actual ground truth.
  console.log(`[Skippy /web-search] query: "${query}"`, JSON.stringify(data));
  return {
    answer: data.answer || '',
    results: (data.results || []).map(({ title, url, content }) => ({ title, url, content })),
  };
}

// Defense-in-depth, added 2026-06-21: prompt instructions telling the model
// not to narrate "searching..." or leak raw tool-call/scratchpad tags were
// confirmed live, three separate times, to not fully suppress the behavior
// (Hermes-3-Llama-3.1-70B's own tool-calling training format bleeding
// through). Rather than keep re-wording the prompt a fourth time, strip the
// mechanical leak patterns server-side as a safety net — this only targets
// clearly-structural artifacts (bracketed pseudo-status lines, raw XML-ish
// tags), not general roleplay/sarcasm, so it shouldn't touch legitimate
// in-character text.
function stripLeakedFormatting(text) {
  return text
    .replace(/<\/?(?:tool_call|scratchpad)[^>]*>/gi, '')
    .replace(/\[(?:searching|fetching|checking|accessing)[^\]]*\]/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const app = express();
app.use(cors());
app.use(express.json());

app.post('/respond', requireSession, async (req, res) => {
  const text = req.body?.text;
  if (!text) {
    return res.status(400).json({ error: 'Missing "text" in request body.' });
  }

  if (!OPENROUTER_API_KEY) {
    return res.status(502).json({ error: 'OPENROUTER_API_KEY is not set.' });
  }

  // History comes from the frontend's own canister-backed cache (see
  // CLAUDE.md Phase 5.2) — the proxy never reads/writes it itself. Only
  // role/content are forwarded to OpenRouter, never arbitrary client fields.
  const history = Array.isArray(req.body?.history)
    ? req.body.history
        .filter((m) => m && typeof m.role === 'string' && typeof m.content === 'string')
        .map(({ role, content }) => ({ role, content }))
    : [];

  // mode/brain come from App.js's plain string-match on the transcript
  // (Pillar 3) — default to the safe/cheap combo if missing or unrecognized,
  // so an out-of-date frontend build doesn't break.
  const mode = SKIPPY_SYSTEM_PROMPTS[req.body?.mode] ? req.body.mode : 'default';
  const brain = BRAIN_MODELS[req.body?.brain] ? req.body.brain : 'everyday';

  let systemPrompt = systemPromptFor(mode, brain);
  if (req.skippySession.name) {
    systemPrompt = `You are speaking with ${req.skippySession.name}. ${systemPrompt}`;
  }
  // Without this, any "what's the date/today" question is hallucinated by
  // construction — the model has no other source of ground truth for the
  // real current date/time. Confirmed live 2026-06-21: asked "what's the
  // date," got back a confidently wrong "April 19, 2023."
  systemPrompt += `\n\nThe current real-world date and time is ${new Date().toUTCString()}.`;
  // Closes a confirmed model-behavior bug, 2026-06-21: given real Tavily
  // weather data in the webContext block and a direct question, the model
  // (Hermes-3-Llama-3.1-70B, the "everyday" brain) narrated "I shall venture
  // forth into the web... stand by" theater instead of just answering with
  // the data already in front of it — and separately leaked raw internal
  // formatting tokens (`</tool_call>`, `</SCRATCHPAD>`) into the visible
  // reply, almost certainly from its own tool-calling training format
  // bleeding through with no actual tool schema configured on this request.
  systemPrompt +=
    `\n\nRespond only in plain conversational text — never output tags like "<tool_call>", ` +
    `"<scratchpad>", or any other internal/meta formatting. Never narrate that you are about to ` +
    `search, are currently searching, or will get back to the user later — any search has already ` +
    `completed before you see this prompt, so if relevant results appear above, answer using them ` +
    `immediately and directly, right now, in this reply.`;

  // Pillar 6 — the frontend already decided what's relevant (ran the
  // similarity search/threshold check itself, see CLAUDE.md), so this just
  // injects whatever it found. Citation format is the minimal bracketed tag
  // already specified for Pillar 6 — no long disclaimers.
  const ragContext = Array.isArray(req.body?.ragContext) ? req.body.ragContext : [];
  const webContext =
    req.body?.webContext && typeof req.body.webContext === 'object' ? req.body.webContext : null;
  const ragMiss = req.body?.ragMiss === true;

  if (ragContext.length > 0) {
    const block = ragContext
      .filter((c) => c && typeof c.content === 'string')
      .map((c) => `[${c.manual_name}] ${c.title}: ${c.content}`)
      .join('\n\n');
    systemPrompt +=
      `\n\nRelevant knowledge base excerpts — cite the bracketed manual name when you use one. ` +
      `Only state facts, numbers, or rules that actually appear in these excerpts — if they don't ` +
      `contain the specific answer, say so explicitly (still in character) rather than guessing or ` +
      `inventing a plausible-sounding number. Never use a bracketed citation tag unless you're ` +
      `actually drawing from that excerpt for this answer:\n${block}`;
  } else {
    // Closes the same fabrication gap the webContext `else` branch below
    // already covers, but for manuals — confirmed live 2026-06-21: with no
    // real ragContext this turn, the model invented a fictional "Marine
    // Corps Manual" and referenced a "scratchpad" of excerpts that was never
    // actually provided. No real manual by that name was ever uploaded.
    systemPrompt +=
      `\n\nYou have NOT been given any knowledge-base/manual excerpts this turn. Do not claim to ` +
      `be quoting or referencing any manual, document, or "scratchpad" of excerpts, and do not ` +
      `invent a manual name, under any circumstances — even if earlier turns in this conversation ` +
      `did include real excerpts. If asked something a manual would normally cover, say in ` +
      `character that you don't have it, rather than inventing a source.`;
  }

  if (webContext) {
    const block = [webContext.answer, ...(webContext.results || []).map((r) => `${r.title} (${r.url}): ${r.content}`)]
      .filter(Boolean)
      .join('\n\n');
    systemPrompt +=
      `\n\nLive web search results — cite with a "[Web]" tag when you use these. Only state facts, ` +
      `numbers, or specifics that actually appear in these results — if they don't contain the ` +
      `specific answer (e.g. results about the wrong location, or no real answer at all), say so ` +
      `explicitly (still in character) rather than inventing a plausible-sounding answer. Never use ` +
      `the "[Web]" tag unless you're actually drawing from these results for this answer:\n${block}`;
  } else {
    // Closes a confirmed fabrication path, 2026-06-21: with no real webContext
    // this turn, the model had no instruction either permitting or forbidding
    // a "[Web]" tag — and, primed by earlier turns where it really did have
    // live search results, it invented an entire multi-day weather forecast
    // and tagged it "[Web]" anyway. This is a blanket guardrail independent
    // of ragContext/ragMiss, since the failure here wasn't about manual
    // content at all.
    systemPrompt +=
      `\n\nYou have NOT been given any live web search results this turn. Do not claim to have ` +
      `searched the web, do not use a "[Web]" citation tag, and do not invent specific real-time ` +
      `data (weather, prices, scores, news, etc.) under any circumstances — even if earlier turns ` +
      `in this conversation did include real web results. If asked for live data you don't actually ` +
      `have right now, say so explicitly, in character.`;
  }

  // Dumbass Web Loop (default/professional modes only — Steel Rain/tactical
  // never waits for permission, see App.js). No separate canned reply: the
  // persona itself, in character, does the mocking and the asking in this
  // one OpenRouter call, then waits for the next turn's "yes" before App.js
  // actually fires a web search.
  if (ragMiss && mode !== 'tactical' && !webContext) {
    systemPrompt +=
      '\n\nThe local knowledge base has nothing relevant to this question. Do NOT answer the substantive question yet — mock the user, in character, for not having this in your manuals, then explicitly ask whether they want you to search the web for it. Wait for their answer instead of guessing.';
  }

  // Diagnostic: print exactly what's being sent for this turn — added
  // 2026-06-21 after several rounds of guessing wrongly about why the
  // Dumbass Loop / no-web-data guardrails weren't being followed. This
  // removes the guesswork: prints the literal flags and full system prompt
  // that reached OpenRouter, so a compliance failure (model ignored a real
  // instruction) is distinguishable from a code bug (instruction never sent).
  console.log(
    `[Skippy /respond] mode=${mode} brain=${brain} ragContext=${ragContext.length} webContext=${!!webContext} ragMiss=${ragMiss}\n--- system prompt ---\n${systemPrompt}\n--- user text ---\n${text}`,
  );

  // Barge-in (App.js's #askSkippy aborts its fetch to /respond the instant a
  // new utterance arrives) only kills the browser-to-proxy connection by
  // itself — without this, the proxy kept awaiting the OpenRouter call to
  // completion regardless, paying for output tokens nobody was listening to
  // anymore. 'close' fires on disconnect for any reason; aborting after a
  // normal completion is a harmless no-op since the fetch has already settled.
  const upstreamAbort = new AbortController();
  req.on('close', () => upstreamAbort.abort());
  // A client disconnecting mid-request (not a clean end-of-stream — a real
  // dropped connection) can make Node's own stream-destroy machinery emit an
  // 'error' on `req` itself, separate from the AbortError our fetch() calls
  // already catch. An EventEmitter's unhandled 'error' event is fatal by
  // design (crashes the whole process) — confirmed live, 2026-06-20: this
  // took the entire proxy down mid-session with no other symptom than every
  // route going unreachable. We don't need to do anything with it (the
  // 'close' handler above already covers real cleanup); this just stops it
  // from being fatal.
  req.on('error', () => {});

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: BRAIN_MODELS[brain],
        messages: [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'user', content: text },
        ],
      }),
      signal: upstreamAbort.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      return res.status(502).json({ error: `OpenRouter error: ${response.status} ${detail}` });
    }

    const data = await response.json();
    const rawReply = data.choices?.[0]?.message?.content;
    if (!rawReply) {
      return res.status(502).json({ error: 'OpenRouter returned no reply.' });
    }
    const reply = stripLeakedFormatting(rawReply);

    // brain/model surfaced for the UI's debug indicator (CLAUDE.md Phase
    // 5.3) — easy to drop once Brain Switching is confirmed working.
    res.json({ reply, brain, model: BRAIN_MODELS[brain] });
  } catch (err) {
    if (err.name === 'AbortError') return; // client already gone, nothing to send back
    res.status(502).json({ error: `Failed to reach OpenRouter: ${err.message}` });
  }
});

app.get('/speak', requireSession, async (req, res) => {
  const text = req.query.text;
  if (!text) {
    return res.status(400).json({ error: 'Missing "text" query parameter.' });
  }

  const voiceId = req.skippySession.voiceId;
  if (!ELEVENLABS_API_KEY || !voiceId) {
    return res.status(502).json({ error: 'ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID is not set.' });
  }

  // App.js's #detachCurrentAudio (barge-in, or a fresh reply cutting off the
  // previous one) clears the <audio> element's src and calls load(), which
  // aborts the browser's request to this endpoint — but left unhandled here,
  // the proxy kept streaming the ElevenLabs response into a dead socket.
  // Note this mainly saves bandwidth/compute, not ElevenLabs character
  // billing itself: TTS providers bill per input character at request time,
  // not per byte streamed, so the synthesis cost for this utterance is
  // already incurred the moment the request was sent.
  const upstreamAbort = new AbortController();
  req.on('close', () => upstreamAbort.abort());
  // A client disconnecting mid-request (not a clean end-of-stream — a real
  // dropped connection) can make Node's own stream-destroy machinery emit an
  // 'error' on `req` itself, separate from the AbortError our fetch() calls
  // already catch. An EventEmitter's unhandled 'error' event is fatal by
  // design (crashes the whole process) — confirmed live, 2026-06-20: this
  // took the entire proxy down mid-session with no other symptom than every
  // route going unreachable. We don't need to do anything with it (the
  // 'close' handler above already covers real cleanup); this just stops it
  // from being fatal.
  req.on('error', () => {});

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
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
        signal: upstreamAbort.signal,
      },
    );

    if (!response.ok || !response.body) {
      const detail = await response.text();
      return res.status(502).json({ error: `ElevenLabs error: ${response.status} ${detail}` });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    Readable.fromWeb(response.body).pipe(res);
  } catch (err) {
    if (err.name === 'AbortError') return; // client already gone, nothing to send back
    res.status(502).json({ error: `Failed to reach ElevenLabs: ${err.message}` });
  }
});

// Pillar 6 — embeds the user's query text (or anything else the frontend
// needs vectorized) so it can call the canister's search_similar_chunks
// itself with its own authenticated identity. The proxy never calls the
// canister directly for this (see CLAUDE.md's Phase 5.1 / Pillar 1 note on
// why the proxy stays stateless re: the canister) — it only ever does the
// genuinely Web2-only part, talking to OpenRouter.
app.post('/embed', requireSession, async (req, res) => {
  const texts = req.body?.texts;
  if (!Array.isArray(texts) || texts.length === 0 || !texts.every((t) => typeof t === 'string')) {
    return res.status(400).json({ error: 'Missing or invalid "texts" array in request body.' });
  }
  if (!OPENROUTER_API_KEY) {
    return res.status(502).json({ error: 'OPENROUTER_API_KEY is not set.' });
  }

  try {
    const embeddings = await embedTexts(texts);
    res.json({ embeddings });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Neo Skin document upload (Pillar 6) — extract + chunk + embed in one round
// trip; the frontend persists the result to the canister itself via
// add_manual_chunks, same proxy-stays-stateless reasoning as /embed above.
// multipart/form-data (not JSON) since this needs to carry binary file
// bytes (PDF/.docx), not just text, and express.json()'s small default
// limit is the wrong ceiling for a whole document anyway.
app.post('/chunk-and-embed', requireSession, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Missing "file" in form data.' });
  }
  if (!OPENROUTER_API_KEY) {
    return res.status(502).json({ error: 'OPENROUTER_API_KEY is not set.' });
  }

  let text;
  try {
    text = await extractText(req.file.buffer, req.file.originalname);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!text || !text.trim()) {
    return res.status(400).json({
      error:
        'No extractable text found in that file. This PDF likely has no real text layer (e.g. ' +
        'a rasterized "print to PDF" export) — OCR isn\'t supported yet. Try opening it, ' +
        'confirming you can select/copy its text in a PDF viewer, or copy the text into a ' +
        '.txt file and upload that instead.',
    });
  }

  const pieces = chunkText(text);
  if (pieces.length === 0) {
    return res.status(400).json({ error: 'No content to chunk.' });
  }

  try {
    const embeddings = await embedTexts(pieces);
    const chunks = pieces.map((content, i) => ({
      section: `chunk-${i + 1}`,
      title: content.split(/\s+/).slice(0, 8).join(' '),
      content,
      embedding: embeddings[i],
    }));
    res.json({ chunks });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Steel Rain / Dumbass Web Loop (Pillar 6) — the only thing that ever
// touches the open internet beyond OpenRouter/ElevenLabs, and only ever via
// Tavily's fixed endpoint with a plain query string (see tavilySearch above
// for why that closes the SSRF risk).
app.post('/web-search', requireSession, async (req, res) => {
  const query = req.body?.query;
  if (!query) {
    return res.status(400).json({ error: 'Missing "query" in request body.' });
  }
  if (!TAVILY_API_KEY) {
    return res.status(502).json({ error: 'TAVILY_API_KEY is not set.' });
  }

  try {
    const result = await tavilySearch(query);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Catches multer's file-size/type errors (e.g. over the 20MB limit on
// /chunk-and-embed) so they come back as the same clean JSON shape as every
// other error here, instead of Express's default HTML error page.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  next(err);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Skippy proxy listening on http://0.0.0.0:${PORT}`);
});


