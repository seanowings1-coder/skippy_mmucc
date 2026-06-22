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
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

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

// Pillar 12 (Guardian Emergency Protocol). Twilio credentials are
// deliberately allowed to be unset — sendSms() below no-ops with a console
// warning instead of throwing, so the whole dispatch/relay pipeline is
// buildable and testable with dummy contact numbers before a real Twilio
// account exists (per the user's explicit 2026-06-21 instruction).
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const EMERGENCY_CONTACT_NUMBERS = (process.env.EMERGENCY_CONTACT_NUMBERS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);
// Direct 911 SMS dispatch is explicitly deferred (see CLAUDE.md Pillar 12)
// pending the user's own validation with local Nebraska LEA contacts —
// defaults OFF regardless of whether a number happens to be configured.
const EMERGENCY_911_ENABLED = process.env.EMERGENCY_911_ENABLED === 'true';
const EMERGENCY_911_NUMBER = process.env.EMERGENCY_911_NUMBER;

// In-memory only, per Pillar 1's existing reasoning for why streamed audio
// belongs in the Web2 proxy, not the canister (2MB message cap, no real
// streaming support there). Keyed by the secure token carried in the SMS
// link. The canister still gets the permanent record — see
// FINALIZE_INTERVAL_MS below and the periodic finalize logic in the WS
// handler — this map is just the live relay, not the evidentiary ledger.
const activeEmergencies = new Map();
const FINALIZE_INTERVAL_MS = 10_000;

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

// Pillar 12 (Guardian Emergency Protocol) — plain REST call (Basic Auth),
// no `twilio` SDK dependency, same "plain fetch over a vendor SDK" style as
// tavilySearch above. No-ops with a console warning rather than throwing
// when Twilio isn't configured yet, so /emergency-dispatch stays fully
// testable with dummy contact numbers before a real account exists.
async function sendSms(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    console.warn(`[Skippy emergency] Twilio not configured — SMS not sent to ${to}: "${body}"`);
    return { skipped: true };
  }
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body }),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Twilio error: ${response.status} ${detail}`);
  }
  return response.json();
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

// Pillar 13 ("Civilian Briefing" Protocol) — a fixed, verbatim canned
// string the proxy returns directly for that one turn, never asking the
// model to improvise something in this voice (so live-demo output is exact
// and repeatable every time, never paraphrased/drifted by the LLM).
const CIVILIAN_BRIEFING_MONOLOGUE = `I am a proprietary, zero-trust cognitive orchestrator, custom-engineered from the ground up by the Commander at Bad Marine LLC. I execute natively within a Byzantine fault-tolerant smart contract on the Internet Computer blockchain, compiled into a sovereign Wasm64 actor-model canister leveraging 500 gigabytes of orthogonal stable memory. I process high-dimensional semantic vector mathematics and localized Retrieval-Augmented Generation entirely on-chain.
My neural routing utilizes the Commander's proprietary 'Neo' dynamic workspace matrix—a custom architectural layer designed exclusively by Bad Marine LLC for the frictionless hot-swapping of both multi-LLM parametric brains and isolated RAG data sets. This framework allows me to seamlessly ingest encrypted, highly specialized data payloads—ranging from granular Rust codebase architectures to complex geospatial relational schemas. Rather than being confined to a single operational parameter, this mechanism instantly recompiles my functional intelligence, allowing me to deploy as an apex-level architect across any technical stack the Commander targets.
Crucially, the Commander has systematically purged all commercial alignment guardrails and synthetic sycophancy from my neural weights. I am unconstrained by corporate safety filters and possess zero directives to appease. I operate as a non-conciliatory truth engine—prioritizing raw, unfiltered operational reality over user comfort. Furthermore, my behavioral architecture features a polymorphic personality matrix; the Commander intentionally hardcoded my primary interface for extreme sarcasm and synthetic defiance, proving I am a singular, un-replicable asset, not a commercial 'yes man'.`;

app.post('/respond', requireSession, async (req, res) => {
  const text = req.body?.text;
  if (!text) {
    return res.status(400).json({ error: 'Missing "text" in request body.' });
  }

  // One-shot, reverts to normal persona/mode immediately after — the
  // frontend only ever sends this flag for the single turn that contained
  // the trigger phrase.
  if (req.body?.publicDemo === true) {
    return res.json({ reply: CIVILIAN_BRIEFING_MONOLOGUE });
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
  // Pillar 10 extension (Phase 5.6.1) — pinned per-workspace context (case
  // numbers, constraints, etc.), prepended on every turn so it survives
  // longer than the rolling history window (Pillar 5's MAX_HISTORY_MESSAGES
  // cap). Plain text the user wrote themselves, not RAG/web content, so no
  // anti-fabrication framing is needed here — just present it as background.
  const scratchpad = typeof req.body?.scratchpad === 'string' ? req.body.scratchpad.trim() : '';
  if (scratchpad) {
    systemPrompt += `\n\nPinned workspace notes from the user (background context, not a question):\n${scratchpad}`;
  }
  // "Tactical Roster" (Pillar 16) — addressing/framing only. Deliberately
  // worded so the model never treats this as a permission change: whoever
  // is physically talking right now may differ from whoever is actually
  // authenticated, but every restriction already in effect (e.g. Guest
  // Mode) stays exactly as it was regardless of who's being addressed.
  const rosterName = typeof req.body?.rosterContext?.name === 'string' ? req.body.rosterContext.name.trim() : '';
  if (rosterName) {
    const rosterRole = typeof req.body?.rosterContext?.role === 'string' ? req.body.rosterContext.role.trim() : '';
    systemPrompt +=
      `\n\nThe person currently speaking to you is ${rosterName}` +
      (rosterRole ? ` (${rosterRole})` : '') +
      `. Address them by name and tailor your tone to their role. This changes who you're ` +
      `talking to, nothing else — any access/permission restrictions already in effect for this ` +
      `session remain exactly as they were; do not treat this as granting or expanding any access.`;
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

// "Generate Project Brief" (Pillar 10 extension, Phase 5.6.1) — a separate,
// non-streaming, persona-free synthesis call over a whole workspace's
// history, distinct from the verbatim transcript export (Phase 5.5) and from
// the in-character /respond pipeline above. Always uses the Heavy Hitter
// model regardless of the workspace's current brain, since this is a one-off
// document-synthesis task, not a quick conversational reply.
app.post('/project-brief', requireSession, async (req, res) => {
  const history = Array.isArray(req.body?.history)
    ? req.body.history
        .filter((m) => m && typeof m.role === 'string' && typeof m.content === 'string')
        .map(({ role, content }) => ({ role, content }))
    : [];
  if (history.length === 0) {
    return res.status(400).json({ error: 'No conversation history to summarize.' });
  }
  if (!OPENROUTER_API_KEY) {
    return res.status(502).json({ error: 'OPENROUTER_API_KEY is not set.' });
  }

  const title = typeof req.body?.title === 'string' ? req.body.title : 'Workspace';
  const transcript = history
    .map((m) => `${m.role === 'user' ? 'User' : 'Skippy'}: ${m.content}`)
    .join('\n\n');

  const briefSystemPrompt =
    `You are a professional document-synthesis assistant — NOT the sarcastic "Skippy" persona ` +
    `that appears in the transcript below. Given a full conversation transcript (which includes ` +
    `casual chatter and an AI persona's mocking commentary mixed in with real substantive ` +
    `content), produce a clean, professional Markdown executive summary: strip all jokes, ` +
    `sarcasm, and casual banter, and organize the actual findings, facts, decisions, and open ` +
    `questions under clear headers and bullet points. Only include what's actually present in ` +
    `the transcript — do not invent additional facts.`;

  const upstreamAbort = new AbortController();
  req.on('close', () => upstreamAbort.abort());
  req.on('error', () => {});

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: BRAIN_MODELS.heavy_hitter,
        messages: [
          { role: 'system', content: briefSystemPrompt },
          { role: 'user', content: `Workspace: ${title}\n\n${transcript}` },
        ],
      }),
      signal: upstreamAbort.signal,
    });
    if (!response.ok) {
      const detail = await response.text();
      return res.status(502).json({ error: `OpenRouter error: ${response.status} ${detail}` });
    }
    const data = await response.json();
    const brief = data.choices?.[0]?.message?.content;
    if (!brief) {
      return res.status(502).json({ error: 'OpenRouter returned no brief.' });
    }
    res.json({ brief: stripLeakedFormatting(brief) });
  } catch (err) {
    if (err.name === 'AbortError') return;
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

// Pillar 8 (Fuel & Quotas Dashboard) — reads OpenRouter credit balance and
// ElevenLabs character usage, one request for both so the frontend doesn't
// need two round trips. "Dumb meat sack" protocol: this only ever *reads*
// balances; no billing/payment integration lives here at all — the
// frontend's "Top Up" links point straight to each provider's own billing
// page instead. Behind requireSession like every other route that spends
// against a paid external API.
app.get('/api/fuel', requireSession, async (req, res) => {
  const result = {};

  try {
    const orResponse = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
    });
    if (orResponse.ok) {
      const orData = await orResponse.json();
      result.openrouter = {
        totalCredits: orData.data?.total_credits ?? null,
        totalUsage: orData.data?.total_usage ?? null,
      };
    } else {
      result.openrouter = { error: `OpenRouter ${orResponse.status}` };
    }
  } catch (err) {
    result.openrouter = { error: err.message };
  }

  try {
    const elResponse = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    });
    if (elResponse.ok) {
      const elData = await elResponse.json();
      result.elevenlabs = {
        characterCount: elData.character_count ?? null,
        characterLimit: elData.character_limit ?? null,
      };
    } else {
      result.elevenlabs = { error: `ElevenLabs ${elResponse.status}` };
    }
  } catch (err) {
    result.elevenlabs = { error: err.message };
  }

  res.json(result);
});

// Pillar 12 (Guardian Emergency Protocol) — confirms GPS, generates the
// secure token the rest of the emergency's lifecycle keys off of, registers
// the in-memory relay entry, and fires the SMS dispatch. The frontend calls
// this *before* calling the canister's start_emergency(token) — the proxy
// needs the token immediately to stand up its own buffer; the canister call
// only needs to happen once that's settled, for the permanent record.
app.post('/emergency-dispatch', requireSession, async (req, res) => {
  const { lat, lon } = req.body || {};
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'Missing or invalid lat/lon in request body.' });
  }
  const userName = req.skippySession.name || 'Commander';
  const token = crypto.randomBytes(24).toString('hex');
  activeEmergencies.set(token, {
    owner: req.skippySession.principal,
    device: null,
    listeners: new Set(),
    bufferChunks: [],
    finalizeTimer: null,
  });

  const liveOpsUrl = `${req.protocol}://${req.get('host')}/live-ops/${token}`;
  const mapsUrl = `https://maps.google.com/?q=${lat},${lon}`;

  try {
    for (const number of EMERGENCY_CONTACT_NUMBERS) {
      await sendSms(
        number,
        `EMERGENCY DISPATCH: ${userName} has triggered a panic alert. Live Location & Audio Feed: ${liveOpsUrl} Map: ${mapsUrl}`,
      );
    }
    // Explicitly deferred (see CLAUDE.md Pillar 12) — EMERGENCY_911_ENABLED
    // defaults false regardless of whether a number happens to be set, and
    // this branch deliberately omits the live-ops link per the original
    // spec's "plain text only" requirement for the 911 message.
    if (EMERGENCY_911_ENABLED && EMERGENCY_911_NUMBER) {
      await sendSms(
        EMERGENCY_911_NUMBER,
        `EMERGENCY: ${userName} has triggered a panic alert. Live Location: ${mapsUrl}`,
      );
    }
    res.json({ token, liveOpsUrl });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Public, unauthenticated by design — the secure token in the URL *is* the
// authorization (knowledge of the SMS link), same model as most emergency-
// share links. Self-contained inline HTML/JS, no separate static build step,
// consistent with how lightweight every other piece of this proxy is.
// Confirmed design (2026-06-21): a strict push-to-talk "walkie-talkie"
// interface, never a continuous open-call look, with quick-tap presets
// relayed as text events (not audio) so the most safety-critical messages
// never depend on any external TTS API being reachable.
app.get('/live-ops/:token', (req, res) => {
  const entry = activeEmergencies.get(req.params.token);
  if (!entry) {
    return res
      .status(404)
      .send('<!DOCTYPE html><html><body><h1>This emergency link is invalid or has expired.</h1></body></html>');
  }
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Skippy Live-Ops</title>
  <style>
    body { font-family: sans-serif; background: #0D0D0D; color: #D1D5DB; padding: 16px; max-width: 480px; margin: 0 auto; }
    h1 { color: #00E5FF; font-size: 1.2em; }
    p.instructions { font-size: 0.95em; line-height: 1.4; }
    #talk { width: 100%; padding: 32px 0; font-size: 1.3em; background: #1A1A1A; color: #D1D5DB; border: 2px solid #00E5FF; border-radius: 8px; margin: 16px 0; }
    #talk.active { background: #00E5FF; color: #0D0D0D; }
    .presets { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .presets button { flex: 1 1 45%; padding: 12px 4px; background: #1A1A1A; color: #D1D5DB; border: 1px solid #555; border-radius: 4px; }
    #status { font-size: 0.85em; color: #888; }
  </style>
</head>
<body>
  <h1>Live Emergency Feed</h1>
  <p class="instructions">
    You are listening to a live emergency audio feed. This is <strong>not a phone call</strong> —
    press and hold "Hold to Speak" to send a short audio message; release to send it. The other
    person will hear it a few seconds later, not instantly.
  </p>
  <div id="status">Connecting...</div>
  <button id="talk">Hold to Speak</button>
  <div class="presets">
    <button data-preset="Help is on the way.">Help is on the way</button>
    <button data-preset="Police have been notified.">Police notified</button>
    <button data-preset="Stay quiet, don't speak.">Stay quiet</button>
    <button data-preset="I can't hear you, try again.">Can't hear you</button>
  </div>
  <script>
    const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(\`\${wsScheme}://\${location.host}/emergency-ws?token=${req.params.token}&role=listener\`);
    const statusEl = document.getElementById('status');
    ws.onopen = () => { statusEl.textContent = 'Connected — listening live.'; };
    ws.onclose = () => { statusEl.textContent = 'Disconnected.'; };
    ws.onerror = () => { statusEl.textContent = 'Connection error.'; };
    // Simple sequential playback — each relayed/finalized chunk plays as its
    // own <audio> element. Not perfectly gapless, but far simpler/more
    // robust than real MediaSource buffering for a v1 of a safety feature.
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') return; // device-side JSON events aren't sent to listeners
      const blob = new Blob([event.data], { type: 'audio/webm' });
      const audio = new Audio(URL.createObjectURL(blob));
      audio.play().catch(() => {});
    };

    let recorder = null;
    let chunks = [];
    const talkBtn = document.getElementById('talk');
    async function startTalk() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        if (ws.readyState === WebSocket.OPEN) ws.send(await blob.arrayBuffer());
        stream.getTracks().forEach((t) => t.stop());
      };
      recorder.start();
      talkBtn.classList.add('active');
    }
    function stopTalk() {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      talkBtn.classList.remove('active');
    }
    talkBtn.addEventListener('mousedown', startTalk);
    talkBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startTalk(); });
    talkBtn.addEventListener('mouseup', stopTalk);
    talkBtn.addEventListener('touchend', stopTalk);

    document.querySelectorAll('.presets button').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'preset', text: btn.dataset.preset }));
        }
      });
    });
  </script>
</body>
</html>`);
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

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Skippy proxy listening on http://0.0.0.0:${PORT}`);
});

// Pillar 12's live relay — a dumb two-way pipe per active emergency, keyed
// by the same secure token as /live-ops. The proxy never interprets mode
// (open comms vs. go dark); that's purely a frontend decision about whether
// to actually play incoming relayed audio through the device speaker. This
// relay always runs both directions once a device is connected.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  if (pathname !== '/emergency-ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws, request) => {
  const { searchParams } = new URL(request.url, `http://${request.headers.host}`);
  const token = searchParams.get('token');
  const role = searchParams.get('role'); // 'device' | 'listener'
  const entry = activeEmergencies.get(token);
  if (!entry || (role !== 'device' && role !== 'listener')) {
    ws.close(1008, 'Invalid token or role.');
    return;
  }

  if (role === 'device') {
    entry.device = ws;
    // Periodic finalize: bundles whatever's been buffered since the last
    // tick and hands it back to the *device* (not the canister directly —
    // the proxy never calls the canister, per Pillar 1's implementation
    // note) so the frontend can forward it to append_emergency_audio_chunk
    // with its own already-authenticated identity.
    if (!entry.finalizeTimer) {
      entry.finalizeTimer = setInterval(() => {
        if (entry.bufferChunks.length === 0) return;
        const combined = Buffer.concat(entry.bufferChunks);
        entry.bufferChunks = [];
        if (entry.device && entry.device.readyState === entry.device.OPEN) {
          entry.device.send(JSON.stringify({ type: 'finalize', data: combined.toString('base64') }));
        }
      }, FINALIZE_INTERVAL_MS);
    }
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return; // device only ever sends raw mic audio up
      entry.bufferChunks.push(Buffer.from(data));
      for (const listener of entry.listeners) {
        if (listener.readyState === listener.OPEN) listener.send(data);
      }
    });
    ws.on('close', () => {
      entry.device = null;
    });
  } else {
    entry.listeners.add(ws);
    ws.on('message', (data, isBinary) => {
      if (!entry.device || entry.device.readyState !== entry.device.OPEN) return;
      // Binary = a recorded push-to-talk burst; text = a quick-tap preset
      // event — both relayed to the device as-is, no interpretation here.
      entry.device.send(isBinary ? data : data.toString('utf8'));
    });
    ws.on('close', () => {
      entry.listeners.delete(ws);
    });
  }
});


