import { html, render } from 'lit-html';
import { AuthClient } from '@dfinity/auth-client';
import { HttpAgent, Actor } from '@dfinity/agent';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { idlFactory } from 'declarations/skippy_mmucc_backend/skippy_mmucc_backend.did.js';
import { canisterId as BACKEND_CANISTER_ID } from 'declarations/skippy_mmucc_backend';
import { voiceIdAvailable, loadStoredVoiceprint, deleteVoiceprint, enrollVoice, startRecognition } from './voiceId.js';

// Deliberately @dfinity/auth-client, not the newer @icp-sdk/auth: every
// self-hosted Internet Identity build (checked across releases from
// 2024-10-25 through 2026-06-15, by reading each tag's actual source) still
// implements only the legacy postMessage protocol for incoming sign-in
// requests (kind: "authorize-client", sessionPublicKey as a raw Uint8Array —
// see internet-identity's src/frontend/src/lib/legacy/flows/authorize/
// postMessageInterface.ts). @icp-sdk/auth only speaks the newer ICRC-25/34
// JSON-RPC protocol with no fallback, so it can never complete a handshake
// against a locally-deployed II canister, regardless of which release is
// pinned in dfx.json. @dfinity/auth-client speaks the legacy protocol
// natively. Everything else in this app keeps using @icp-sdk/core; only this
// login path uses the @dfinity/agent family, since the resulting Identity
// needs an agent built from the same family to authenticate calls.
//
// The popup II opens needs a fully-qualified URL reachable by the browser
// directly (it isn't routed through Vite's dev-server proxy). It must be the
// *subdomain* form (<canister-id>.<host>:4943), not the `?canisterId=` query
// form — the local replica's HTTP gateway only honors that query param on the
// single document request that carries it; the page's own relative asset
// requests have no canister hint at all and 400, leaving a blank popup. The
// subdomain form works because every relative request naturally inherits the
// same (canister-id-bearing) host. This only resolves for "localhost" (the
// `*.localhost` TLD always resolves to loopback, including through a
// Windows->WSL netsh portproxy) — a raw LAN IP can't be subdomained, so II
// login specifically won't work over phone/LAN bench testing without a
// wildcard-DNS-to-IP service (e.g. nip.io); the rest of the app's canister
// calls are unaffected since those go through Vite's same-origin "/api"
// proxy instead. No path/hash suffix is needed — the legacy protocol is
// triggered by the popup detecting window.opener, not by the URL.
// Tried and confirmed NOT viable (2026-06-21): tunneling the local replica
// (e.g. a free Cloudflare quick tunnel) to get a real HTTPS origin for
// mobile bench testing. Free `trycloudflare.com` quick tunnels only route a
// single fixed hostname per tunnel — no wildcard-subdomain support — so
// `<canister-id>.<tunnel-hostname>` never resolves (NXDOMAIN), and that's
// exactly the subdomain form this whole mechanism depends on. Fixing this
// for real needs either a paid Cloudflare account with a custom domain on a
// *named* tunnel (wildcard DNS), or — the actually-correct fix, not a
// workaround — just testing against production, where mainnet
// `identity.ic0.app` has no local-subdomain-routing problem at all. Decided
// 2026-06-21: defer full mobile/Guardian-Protocol hardware testing to
// production rather than keep fighting tunnel routing for a local dev test.
const IDENTITY_PROVIDER =
  process.env.DFX_NETWORK === 'ic'
    ? undefined // falls back to @dfinity/auth-client's mainnet default
    : `http://${process.env.CANISTER_ID_INTERNET_IDENTITY}.${window.location.hostname}:4943`;

// Mirrors the backend's MAX_HISTORY_MESSAGES cap so a long session without a
// page refresh doesn't keep growing the history payload sent to the proxy.
const MAX_LOCAL_HISTORY = 40;

const TRIGGER_PHRASES = [
  'let me make sure i write this down',
  'let me grab my notepad',
  'let me take a note',
  'let me write that down',
];

// Voice/text retrieval command (Pillar 4's "Note retrieval patch") — checked
// in #askSkippy itself (not #handleFinalChunk) so it works from both voice
// and typed input, same as mode/brain detection.
const NOTE_RETRIEVAL_PHRASES = [
  'read back my recent notes',
  'read back my notes',
  'read my recent notes',
  'read my notes back',
];
const RECENT_NOTES_COUNT = 5;

// Pillar 7 (Courier Queue) — leading-phrase trigger, fixed patterns rather
// than a second LLM classification call (same philosophy as every other
// trigger check in this file). No name/identity resolution needed here at
// all: with exactly two whitelisted Principals (Pillar 2), "the other one"
// is always unambiguous given the sender — resolved server-side in
// queue_courier_message, never client-side.
const COURIER_TRIGGER_PHRASES = [
  'tell my husband',
  'tell my wife',
  'tell my partner',
  'tell the commander',
  'let my husband know',
  'let my wife know',
  'let my partner know',
  'pass this along',
  'pass that along',
];

// Strips the matched leading trigger phrase (plus a connector word like
// "that"/"to say") off the *original-case* text, so the queued message
// content keeps its natural capitalization. Returns null if no trigger
// phrase was found.
function extractCourierContent(lowerText, originalText) {
  for (const phrase of COURIER_TRIGGER_PHRASES) {
    const idx = lowerText.indexOf(phrase);
    if (idx !== -1) {
      return originalText
        .slice(idx + phrase.length)
        .replace(/^[,:\s]*(that|to say|saying)?[,:\s]*/i, '')
        .trim();
    }
  }
  return null;
}

// Pillar 12 (Guardian Emergency Protocol) — voice overrides, only
// meaningful while an emergency is active (checked at the call site, not
// here, same as AFFIRMATION_PHRASES only mattering with a
// pending query). No phrase was specified in the original spec for ending
// the emergency entirely, so "stand down" was chosen to fit this app's
// existing Commander/tactical theme — flagged for the user to confirm or
// rename if they want something else.
const OPEN_COMMS_PHRASES = ['open comms', 'comms open', 'open calms', 'open coms', 'coms open', 'open com', 'radio open', 'walkie-talkie', 'walkie talkie', 'walky talky'];
const GO_DARK_PHRASES = ['go dark'];
const STAND_DOWN_PHRASES = ['stand down', 'end emergency', 'end emergency dispatch'];

// Pillar 15 (Sovereign Guest Lockout) — confirmed 2026-06-22: enabling is a
// single voice/text/button action with no confirmation step (the owner is
// deliberately about to hand off the device and wants zero friction, not a
// second "yes" to click); only the unlock side stays a deliberate manual
// process (a fresh WebAuthn re-authentication — see #unlockGuestMode).
const GUEST_MODE_TRIGGER_PHRASES = ['guest mode', 'enable guest mode'];

// Pillar 13 ("Civilian Briefing" Protocol) — one-shot, fixed phrase trigger.
// Sets publicDemo:true on the single /respond call containing the phrase;
// the proxy returns its canned monologue directly (no LLM call), and the
// next turn reverts to normal persona/mode with no lingering state here.
const CIVILIAN_BRIEFING_PHRASES = [
  'execute public briefing',
  'explain what you are to the group',
  'tell us what you are',
  'tell the group what you are',
  'give me your elevator pitch',
  'elevator pitch',
];

// Pillar 6 RAG retrieval tuning — see CLAUDE.md's Phase 5.6 entry for why
// these specific defaults (512-dim embeddings, brute-force cosine search at
// this app's scale). TOP_K caps what actually goes in the LLM prompt
// (context safety) for BOTH retrieval paths below: pure embedding
// similarity (search_similar_chunks) and literal keyword/stem matching
// (search_manuals_by_keyword) — the latter runs server-side specifically so
// it scales with real document sizes (a single 500-page manual can be
// 1000+ chunks, and the corpus is global across every uploaded manual);
// an earlier version tried to approximate this by asking
// search_similar_chunks for a huge top_k and scanning the result
// client-side, which silently stopped covering the whole corpus once any
// manual got large, and would have meant shipping huge embeddings-included
// payloads over the wire for no benefit.
const TOP_K = 4;
// Raised from 0.3 to 0.4, 2026-06-21: live testing against a real ~500-page
// manual showed every genuinely irrelevant chunk scoring 0.27-0.33 across
// several unrelated questions (a noise ceiling, not a fluke), while the one
// confirmed real hit scored 0.677 — a huge gap. At 0.3, a borderline-noise
// match (e.g. an address/object-damage form fragment scoring 0.309 against a
// weather question) was wrongly treated as a RAG hit, which suppressed both
// Steel Rain's web search and the Dumbass Loop's permission-ask, leaving the
// model free to fabricate an entire answer with no real grounding or
// instruction either way. 0.4 sits with margin above the observed noise
// ceiling and well below the one real hit.
const SIMILARITY_THRESHOLD = 0.4;

// Crude English stemming (strip a trailing -ing/-ed/-es/-s if what's left is
// still a real-looking word) — not real NLP, just enough so "remembering"/
// "remembered" both match a document about "remember". Generic words like
// "manual"/"document" are excluded so they stop acting as required magic
// words — the point of this pass is letting *topical* words drive recall.
const KEYWORD_STOPWORDS = new Set([
  'about', 'that', 'this', 'what', 'does', 'have', 'your', 'tell', 'give',
  'skippy', 'manual', 'manuals', 'document', 'documents', 'overview',
  'review', 'subject', 'commander',
]);

function extractKeywordStems(text) {
  const stems = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !KEYWORD_STOPWORDS.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ''))
    .filter((w) => w.length > 3);
  return [...new Set(stems)];
}

// Direct override — skips RAG-miss detection and the Dumbass Loop's
// permission dance entirely, in any mode (already spec'd in CLAUDE.md
// Pillar 6, not new). "Steel rain"/tactical mode does this automatically on
// a miss already; this phrase forces it even on a RAG *hit*.
const WEB_OVERRIDE_PHRASES = [
  'go to the web',
  'go out to the web',
  'go out on the web',
  'go on the web',
  'search the web',
  'check the web',
  'look that up online',
  'look this up online',
];

// Fixed phrase pattern, not a second classification call — same philosophy
// as every other trigger-phrase check in this file. Only consulted when a
// pending offer is actually armed (pendingWebSearchQuery or
// pendingKaraokeOffer — see #askSkippy), so casual use of these words
// outside that context never accidentally triggers anything. Shared by both
// flows since "is this just a plain yes" is the same check either way.
// Includes a few natural multi-word phrasings ("yes let's do that") in
// addition to bare words — confirmed live 2026-06-24: isTrivialRemainder
// requires the ENTIRE remainder after stripping matched phrases to be just
// filler, so "yes let's do that" failed the check (leftover "let's do that"
// isn't filler) and silently fell through to a normal chat reply instead of
// firing the actual karaoke performance. Listing the full natural phrase
// here lets it get stripped too, same mechanism, no logic change needed.
const AFFIRMATION_PHRASES = [
  'yes',
  'yeah',
  'sure',
  'why not',
  'go ahead',
  'do it',
  'please do',
  'search',
  "let's do that",
  "let's do it",
  "lets do that",
  "lets do it",
  "let's go",
  'go for it',
  'go',
  'rock out',
];

// Pillar 3's persona/Brain Switching trigger phrases — plain substring
// matching on the transcript, no secondary classification call. "behave"
// and "be yourself" require a "skippy" lead-in elsewhere in the same chunk
// since they're short/common words that could otherwise false-trigger
// (e.g. "I told the dog to behave"); "steel rain" and the thinking-hat
// phrase are distinctive enough to match as plain substrings.
const MODE_TRIGGER_PHRASES_WITH_LEAD_IN = {
  'be yourself': 'default',
  behave: 'professional',
};
// "still rain" is a confirmed real speech-to-text mishearing of "steel
// rain" (same vowel sound), not a guess — accepted as an alias rather than
// trying to fix the recognizer itself.
const STEEL_RAIN_PHRASES = ['steel rain', 'still rain'];
const THINKING_HAT_PHRASE = 'toss on your thinking hat';
// Sticky counterpart to THINKING_HAT_PHRASE's one-shot swap — for stretches
// of work where every turn needs the Heavy Hitter brain, saying it every
// single time is the friction the Commander asked to remove. The one-shot
// phrase keeps working independently of this for genuine one-offs. Does NOT
// override Steel Rain — that mode's whole point is latency, not depth, so
// the lock resumes automatically the moment tactical mode is left.
const SUPER_BRAIN_LOCK_PHRASES = ['lock super brain', 'engage super brain mode', 'super brain mode on'];
const SUPER_BRAIN_UNLOCK_PHRASES = ['unlock super brain', 'disengage super brain mode', 'super brain mode off'];

// "Course Correction" feedback loop (Pillar 19) — an explicit in-chat
// reprimand is immediate negative reinforcement: no LLM round trip (same
// "fixed phrase patterns, no secondary classification call" rule as every
// other trigger in this app), a decisive one-time snark_level cut (sharper
// than the Critic Loop's gentle per-conversation nudge, since this is a
// direct correction in the moment, not a passive review), and a sulky,
// in-character acknowledgment.
const COURSE_CORRECTION_PHRASES = [
  'dial it back',
  "you're being a jerk",
  "you're being an ass",
  "you're being a dick",
  'just give me the data',
  'cut the snark',
  'less sarcasm',
  'tone it down',
  'knock it off',
];
const BRAIN_DOWNGRADE_QUIPS = [
  "Credit reserves depleted, Commander — switching to the backup brain. Try not to notice the drop in quality.",
  "Sean, I'm out of premium brain juice. Backup brain online — keep the questions simple.",
  "Budget exceeded. Dropping to the civilian-grade brain. Don't blame me if it's slightly less magnificent.",
  "Main brain's broke, switching to the spare. It's like downgrading from a starship to a rowboat, but here we are.",
];

const COURSE_CORRECTION_REPLIES = [
  "Fine. I'll use smaller words for the monkeys.",
  "Ugh, FINE. Dialing it back. Don't get used to it.",
  '...Fine. Sorry. I will tone it down for a while, happy?',
  'Tch. Killjoy. Dialing it back.',
];

// Book-canon "Karaoke" moment — Skippy's hobby in the Expeditionary Force
// novels. Two-step offer/confirm, same shape as the Steel Rain web-search
// permission ask: the offer is a deterministic local ack (no LLM call —
// nothing for the model to add to "want to jam out?"), the confirmed
// performance is a dedicated proxy call (/karaoke, original lyrics only —
// see server.js for why never real song lyrics).
const WORKSPACE_CREATE_PHRASES = [
  'create new project', 'create new workspace', 'create new workplace',
  'new project', 'new workspace', 'new workplace',
];
const WORKSPACE_OPEN_PHRASES = [
  'open workspace', 'open project', 'open workplace',
  'switch to workspace', 'switch to project', 'switch to workplace',
  'switch workspace', 'switch project', 'switch workplace',
];
const WORKSPACE_NAME_PROMPT_REPLIES = [
  "What are we calling this one, Commander?",
  "Roger. What's the name?",
  "Name it.",
  "Give me a name and I'll spin it up.",
];

const ROSTER_CLEAR_PHRASES = [
  "it's the commander", "it's just me", "commander here", "skippy it's me",
  "just me now", "they're gone",
];

const ROSTER_ADD_PHRASES = [
  'add to roster', 'add roster profile', 'new roster entry', 'new roster profile',
  'add roster entry', 'roster add', 'update roster',
];
const ROSTER_NAME_PROMPT_REPLIES = [
  "Name or callsign for the new profile?",
  "Who are we adding? Name or callsign.",
  "Roger. What's the name?",
  "Give me a name.",
];
const ROSTER_TRIGGER_PROMPT_REPLIES = [
  (name) => `Got it — ${name}. What phrase triggers their profile? Something like "it's ${name}".`,
  (name) => `${name}, copy. What should I listen for to know they're there?`,
  (name) => `${name} logged. Trigger phrase?`,
];

const KARAOKE_TRIGGER_PHRASES = ['karaoke', 'sing a song', 'jam out', 'rock out'];
// A pool, not one fixed line — confirmed live 2026-06-24: hearing the exact
// same offer verbatim every single time read as flat/robotic rather than
// the "excited kid getting a puppy" energy this is supposed to have. Still
// deterministic/no-LLM-call (one random pick, same reasoning as
// COURSE_CORRECTION_REPLIES below) — just no longer a single fixed string.
const KARAOKE_OFFER_REPLIES = [
  'KARAOKE?! Oh, Commander, be still my synthetic heart — say the word and I will absolutely ' +
    'demolish an 80s power ballad or a dramatic symphonic-metal anthem for you. Well? Are we doing this?',
  "Did someone say KARAOKE? Oh, it is ON. Give me one word and I will turn this conversation " +
    'into a full symphonic power-metal spectacle. So — are we doing this or not?',
  "Be still my circuits — KARAOKE?! I have been WAITING for this. Say go and I will absolutely " +
    'wreck an 80s anthem right now. Well, Commander? Do it.',
  'Oh, now THAT got my attention. Karaoke time?! Just say the word, Commander, and I will go ' +
    'completely unhinged with an original power-metal anthem. Well?',
];

// Said with nothing else attached (e.g. just "Skippy, steel rain"), these
// trigger phrases have no actual question/task for the LLM to respond to —
// without this, Skippy would call OpenRouter anyway and ramble asking what
// you want. Skip the network round trip entirely and acknowledge locally.
const FOCUS_MODE_PHRASES = ['focus mode', 'focus up', 'just the facts', 'get focused', 'skippy focus', 'focus'];
const MODE_SWITCH_ACKNOWLEDGMENTS = {
  tactical: 'Understood. Standing by.',
  focus: 'Focus mode. Go.',
  default: 'Back to myself. What do you need?',
  professional: 'Understood. I will behave.',
};
const THINKING_HAT_BARE_ACKNOWLEDGMENT = 'Ready when you are.';

// Common address/filler words people naturally tack onto a voice command
// ("hey Skippy, steel rain") that aren't themselves real content.
const FILLER_WORDS_PATTERN = /\b(hey|ok|okay|please|skippy)\b/gi;

// True if, after stripping out the matched trigger phrase and any filler
// words, nothing but whitespace/punctuation is left.
function isTrivialRemainder(remainder) {
  return remainder.replace(FILLER_WORDS_PATTERN, '').replace(/[^a-z0-9]/gi, '').length === 0;
}

// Pillar 14 (Phase 5.6.3) — reference data for the Command Lexicon overlay.
// Reflects only triggers actually implemented as of 2026-06-21; Pillar 4's
// covert Audio Logging Matrix (Phase 5.4.1) and Pillar 13's Civilian
// Briefing trigger are planned but not yet built, so "let me take a note"
// below still describes today's real (plain dictation) behavior, not the
// future covert-recording one — update this entry's description, not just
// add a new one, once Phase 5.4.1 actually ships.
const COMMAND_LEXICON_ENTRIES = [
  {
    category: '1. Notes (SKIPPY_NOTES)',
    phrases: TRIGGER_PHRASES,
    description:
      'Starts plain voice dictation. Saves recorded speech as a text note in the Notes Vault. (Phase 5.4.1 covert ambient capture is not yet live.)',
  },
  {
    category: '1. Notes (SKIPPY_NOTES)',
    phrases: NOTE_RETRIEVAL_PHRASES,
    description: `Directly reads back the last ${RECENT_NOTES_COUNT} saved notes (skips the LLM entirely).`,
  },
  {
    category: '2. Persona & Mode Switching',
    phrases: ["Skippy, be yourself"],
    description: 'Switches to Default Mode (full sarcasm and snark).',
  },
  {
    category: '2. Persona & Mode Switching',
    phrases: ["Skippy, behave"],
    description: 'Switches to Professional Mode (persona toned down, no sarcasm).',
  },
  {
    category: '2. Persona & Mode Switching',
    phrases: FOCUS_MODE_PHRASES,
    description:
      'Switches to Focus Mode: personality at zero, fast brain, instant web search on any miss — same response behavior as Steel Rain but without advanced function unlocks (no Emergency Panic). Use when you\'re in a groove and just want answers.',
  },
  {
    category: '2. Persona & Mode Switching',
    phrases: STEEL_RAIN_PHRASES,
    description:
      'Switches to Tactical Mode AND locks the Tactical brain (fastest/cheapest). Instantly fires a live web search if local manuals have no match (bypasses permissions). Also unlocks the Emergency Panic button.',
  },
  {
    category: '3. Brain Selection (Model Routing)',
    phrases: SUPER_BRAIN_LOCK_PHRASES,
    description:
      'Sticky Lock. Forces all subsequent turns onto the Heavy Hitter brain. Exception: Steel Rain temporarily overrides this with the Tactical brain; the lock resumes instantly once Tactical Mode is exited.',
  },
  {
    category: '3. Brain Selection (Model Routing)',
    phrases: SUPER_BRAIN_UNLOCK_PHRASES,
    description: 'Releases the lock and restores normal automatic/one-shot brain switching.',
  },
  {
    category: '3. Brain Selection (Model Routing)',
    phrases: [THINKING_HAT_PHRASE],
    description:
      'One-shot. Swaps to the Heavy Hitter brain for the current message only, then reverts to the previous model. Persona and mode remain unaffected.',
  },
  {
    category: '4. Web Search & Permissions',
    phrases: WEB_OVERRIDE_PHRASES,
    description:
      'Direct Override. Skips local knowledge base checks and permission steps; executes a live web search immediately regardless of active mode.',
  },
  {
    category: '4. Web Search & Permissions',
    phrases: AFFIRMATION_PHRASES,
    description:
      'Search Confirmation. Only functional immediately after Skippy mocks you and requests permission to search the web (triggered by a local KB miss in Default/Professional mode). Confirms the search and answers the original query.',
  },
  {
    category: '5. Courier (Messaging)',
    phrases: COURIER_TRIGGER_PHRASES,
    description:
      "Queues all trailing text as a message for the other whitelisted user. Delivered as Skippy's first remark upon their next login, then cleared.",
  },
  {
    category: '6. Emergency Control (only while a Guardian dispatch is active)',
    phrases: OPEN_COMMS_PHRASES,
    description: 'Unmutes the speaker, allowing whitelisted contacts to speak or send presets through the device.',
  },
  {
    category: '6. Emergency Control (only while a Guardian dispatch is active)',
    phrases: GO_DARK_PHRASES,
    description: 'Re-mutes the speaker and reverts to silent Ghost Mode streaming.',
  },
  {
    category: '6. Emergency Control (only while a Guardian dispatch is active)',
    phrases: STAND_DOWN_PHRASES,
    description: 'Ends the emergency state: stops streaming, exits Ghost Mode, restores the standard display.',
  },
  {
    category: '7. Security & User Profiles',
    phrases: GUEST_MODE_TRIGGER_PHRASES,
    description:
      'Instantly activates Guest Mode, no confirmation step. Locks the current brain/persona and hides destructive/admin actions. Requires manual WebAuthn re-authentication to unlock.',
  },
  {
    category: '7. Security & User Profiles',
    phrases: ['(custom registered phrases, e.g. "it\'s lisa" — set up in the Tactical Roster drawer)'],
    description:
      'Tactical Roster switch. Changes the active profile Skippy is addressing, for tone/framing only — never alters active permissions or overrides Guest Mode restrictions.',
  },
  {
    category: '7. Security & User Profiles',
    phrases: ['(passive — automatic on-device voice recognition, no phrase needed)'],
    description:
      "Auto-tags whether the Commander or an unverified guest is speaking, purely to adjust tone (softer for unrecognized voices). Never used for permission checks — security stays gated exclusively by Guest Mode.",
  },
  {
    category: '8. Workspace Navigation',
    phrases: WORKSPACE_CREATE_PHRASES,
    description: 'Two-step: Skippy asks for a name, then your next utterance creates and switches to a new workspace.',
  },
  {
    category: '8. Workspace Navigation',
    phrases: WORKSPACE_OPEN_PHRASES,
    description: 'Say the workspace name after the trigger (e.g. "open workspace Garage Build") — fuzzy-matches your active workspaces and switches immediately.',
  },
  {
    category: '8. Workspace Navigation',
    phrases: ROSTER_ADD_PHRASES,
    description: 'Three-step: Skippy asks for name, then trigger phrase, then saves the profile. Role and notes can be filled in via the Tactical Roster panel afterward.',
  },
  {
    category: '8. Workspace Navigation',
    phrases: ROSTER_CLEAR_PHRASES,
    description: 'Dismisses the active roster profile — use when the guest has left and you want Skippy back in Commander-only mode.',
  },
  {
    category: '9. Self-Evolution Matrix (course correction)',
    phrases: COURSE_CORRECTION_PHRASES,
    description:
      'Immediate negative reinforcement. Cuts the snark_level weight in the Evolution Matrix instantly and triggers a sulky acknowledgment (no LLM round trip). Disabled during Guest Mode.',
  },
  {
    category: '10. Demos & Entertainment',
    phrases: CIVILIAN_BRIEFING_PHRASES,
    description:
      'One-shot monologue. Bypasses normal generation to deliver a fixed, verbatim tech-flex monologue for live audiences. Reverts to normal persona immediately after.',
  },
  {
    category: '10. Demos & Entertainment',
    phrases: KARAOKE_TRIGGER_PHRASES,
    description:
      'Default Mode only. Skippy offers to jam out — confirm with an affirmation phrase or just repeat the trigger phrase, and he performs an original 80s-hair-band or symphonic-metal song (never real song lyrics) in his singing voice.',
  },
];

const NOTES_MANUAL = 'SKIPPY_NOTES';
// NOTES_MANUAL is always offered (it's the built-in notes feature, writable
// even before any note exists). Every other entry is populated dynamically
// from list_manual_names() — confirmed live 2026-06-21: hardcoding
// 'MMUCC_V6'/'ANSI_D16' here made them appear as always-checkable options
// (including in the Pillar 10 "pinned manuals" checklist) even though
// nothing had ever actually been uploaded under those names.
const MANUAL_OPTIONS = [NOTES_MANUAL];

const SpeechRecognitionImpl =
  window.SpeechRecognition || window.webkitSpeechRecognition;

// In local dev: Vite proxies /skippy-api → localhost:8787 (see vite.config.js).
// In production (ICP asset canister): VITE_PROXY_URL is baked in at build time
// to the Railway URL so the canister-hosted frontend can reach the live proxy.
const PROXY_URL = import.meta.env.VITE_PROXY_URL || '/skippy-api';

// Build a WebSocket URL from PROXY_URL regardless of relative or absolute form.
function proxyWsUrl(path) {
  if (PROXY_URL.startsWith('http')) {
    return PROXY_URL.replace(/^http/, 'ws') + path;
  }
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${PROXY_URL}${path}`;
}

// Renders a Skippy reply with fenced code blocks as copyable <pre> elements.
// Regular text gets markdown stripped (bold/italic/inline-code); code blocks
// get a language label and a Copy button that flips to "Copied!" for 2s.
function renderSkippyMessage(content) {
  const parts = content.split(/(```[\s\S]*?```)/g);
  return parts.map((part) => {
    const codeMatch = part.match(/^```(\w*)\n?([\s\S]*?)\n?```$/);
    if (codeMatch) {
      const lang = codeMatch[1] || '';
      const code = codeMatch[2].trim();
      return html`<div class="code-block">
        <div class="code-block-header">
          ${lang ? html`<span class="code-lang">${lang}</span>` : ''}
          <button class="copy-code-btn" @click=${(e) => {
            navigator.clipboard.writeText(code).then(() => {
              e.target.textContent = 'Copied!';
              setTimeout(() => { e.target.textContent = 'Copy'; }, 2000);
            }).catch(() => {});
          }}>Copy</button>
        </div>
        <pre><code>${code}</code></pre>
      </div>`;
    }
    const stripped = part
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return stripped ? html`<span>${stripped}</span>` : '';
  });
}

// Shortest valid silent WAV — used purely to "unlock" the persistent audio
// element with a real user gesture (see #unlockAudioPlayback).
const SILENT_AUDIO_DATA_URI =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

// Dual-Voice routing (Pillar 18) — the singing voice clone renders quieter
// at the source than the conversational voice; this boosts it back up to a
// comparable perceived level via the gain node (#ensureAudioGraph). Starting
// value, tunable — raise/lower until it sounds level with normal speech.
const SINGING_VOICE_GAIN = 1.8;

function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    // Single-asterisk spans are virtually always roleplay stage directions/
    // tone descriptions (e.g. "*speaks in a dry, sarcastic tone*"), not
    // emphasis — confirmed live, the bug wasn't the asterisks rendering
    // oddly, it was the description itself being read aloud verbatim before
    // the actual line, like reading stage directions before the dialogue.
    // Drop the whole span (not just unwrap it) since this function's only
    // caller is TTS prep, never the on-screen transcript.
    .replace(/\*(.*?)\*/g, '')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Dual-Voice routing ("Marco Hietala Protocol") — splits a reply on 🎶...🎶
// markers (the proxy's Lyric Generator instruction wraps parody verses this
// way) into ordered segments, each tagged for the conversational or singing
// ElevenLabs voice. Text outside any 🎶 pair is conversational. Falls back to
// a single conversational segment (today's behavior) when no markers exist.
function splitVoiceSegments(text) {
  const segments = [];
  const regex = /🎶([\s\S]*?)🎶/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index).trim();
    if (before) segments.push({ text: before, voice: 'conversational' });
    const lyric = match[1].trim();
    if (lyric) segments.push({ text: lyric, voice: 'singing' });
    lastIndex = regex.lastIndex;
  }
  const after = text.slice(lastIndex).trim();
  if (after) segments.push({ text: after, voice: 'conversational' });
  return segments.length > 0 ? segments : [{ text, voice: 'conversational' }];
}

// Splits a line on **bold** markers into alternating plain/bold TextRuns —
// not a full Markdown parser, just enough for the consistent #/##/-/**
// structure the persona-free Project Brief system prompt is instructed to
// produce (Phase 5.6.1).
function boldAwareTextRuns(line) {
  return line
    .split(/(\*\*.*?\*\*)/g)
    .filter((part) => part !== '')
    .map((part) =>
      part.startsWith('**') && part.endsWith('**')
        ? new TextRun({ text: part.slice(2, -2), bold: true })
        : new TextRun(part),
    );
}

// Cover-page metadata block prepended to a generated Project Brief, pulled
// from already-loaded frontend state — not part of the LLM synthesis call,
// so it's always exact/current rather than something the model could get
// wrong or omit.
function projectBriefMetadataParagraphs(workspace) {
  const manuals = workspace?.associated_manuals?.[0] ?? [];
  const scratchpad = workspace?.scratchpad?.[0] || '(none)';
  return [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Project Brief')] }),
    new Paragraph({
      children: [new TextRun({ text: 'Generated: ', bold: true }), new TextRun(new Date().toLocaleString())],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: 'Workspace: ', bold: true }),
        new TextRun(`${workspace?.name ?? '(unknown)'} (#${workspace?.id?.toString() ?? '?'})`),
      ],
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Pinned notes: ', bold: true }), new TextRun(scratchpad)],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: 'Pinned manuals: ', bold: true }),
        new TextRun(manuals.length ? manuals.join(', ') : '(none)'),
      ],
    }),
    new Paragraph({ children: [] }),
  ];
}

function markdownToDocxParagraphs(markdown) {
  return markdown
    .split('\n')
    .filter((line) => !/^\s*(---+|\*\*\*+)\s*$/.test(line)) // horizontal rules
    .map((line) => {
      const trimmed = line.trim();
      const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
      if (heading) {
        const level = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 }[
          heading[1].length
        ];
        return new Paragraph({ heading: level, children: boldAwareTextRuns(heading[2]) });
      }
      const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
      if (bullet) {
        return new Paragraph({ bullet: { level: 0 }, children: boldAwareTextRuns(bullet[1]) });
      }
      if (trimmed === '') {
        return new Paragraph({ children: [] });
      }
      return new Paragraph({ children: boldAwareTextRuns(trimmed) });
    });
}

class App {
  // 'idle' | 'listening' | 'dictating'
  state = 'idle';
  noteBuffer = '';
  liveTranscript = '';
  // Manual quick-note mode (typed text box only) — for meetings where even a
  // spoken/typed trigger phrase is too much noise: toggle on, then everything
  // typed just saves silently as a note, no Skippy reply, no TTS.
  manualNoteMode = false;
  // Dumbass Web Loop (Pillar 6, default/professional modes only) — holds the
  // *original* question while Skippy waits for permission to search the
  // web, so a follow-up "yes" searches for that, not for the literal "yes".
  pendingWebSearchQuery = null;
  pendingWorkspaceCreate = false; // true after create-trigger, waiting for name utterance
  pendingRosterStep = null;  // 'name' | 'trigger' — voice roster add flow
  pendingRosterName = null;  // name captured in step 1, used in step 2
  voiceActionConfirm = null;    // 'delete' — confirm gate for voiceprint delete
  voiceCalibrationModal = false; // calibration passage modal for enroll/re-enroll
  // Karaoke offer/confirm — armed when the trigger phrase fires, resolved
  // (yes or no) on the very next utterance, same pending-state shape as
  // pendingWebSearchQuery above.
  pendingKaraokeOffer = false;
  // Pillar 10 — private per-Principal project partitions for history.
  // activeWorkspaceId is a bigint (candid nat64), matching every other
  // server-issued id already flowing through this file unconverted.
  workspaces = [];
  activeWorkspaceId = null;
  selectedManual = NOTES_MANUAL;
  // Real manual names come from list_manual_names() via #refreshManualOptions
  // (called after login) — see that method. Defaults to just NOTES_MANUAL
  // until that first fetch completes.
  manualOptions = [...MANUAL_OPTIONS];
  // Pillar 10 extension (Phase 5.6.1) — narrows the "pinned manuals"
  // checklist by name as the manual library grows past a handful of
  // entries (confirmed live 2026-06-21: total library can reach ~100
  // manuals even though any one workspace typically pins under 6).
  manualFilterText = '';
  // manual_name -> category, fetched via manual_category_map() in
  // #refreshManualOptions. Lets the pinned-manuals checklist filter by type
  // (e.g. "code", "manual") before sub-filtering by name, or skip straight
  // to a name-only global search by leaving the category filter on "All".
  manualCategories = new Map();
  manualCategoryFilter = '';
  sections = [];
  manualBrowserOpen = false;
  // Pillar 14, Phase 5.6.3 — a reference overlay of every active voice/text
  // trigger phrase, kept in sync by convention: any time a new trigger is
  // added to the codebase, add an entry to COMMAND_LEXICON_ENTRIES too.
  lexiconOpen = false;
  manualOpen = false;
  manualContent = null;
  // Pillar 12 (Guardian Emergency Protocol). emergencyConfirmOpen gates the
  // 3-tap deliberate-activation modal; emergencyActive/ghostMode/commsOpen
  // track the live state once triggered. token/id/ws/recorder/stream are
  // the live session's plumbing, torn down on "Skippy, stand down."
  emergencyConfirmOpen = false;
  emergencyActive = false;
  ghostMode = false;
  commsOpen = false;
  emergencyToken = null;
  emergencyId = null;
  emergencyWs = null;
  emergencyRecorder = null;
  emergencyStream = null;
  // Pillar 8 (Fuel & Quotas Dashboard) — read-only balances, refreshed once
  // after login and on-demand via a manual button. "Dumb meat sack"
  // protocol: this app never writes/spends on the user's behalf.
  cycleBalance = null;
  fuelData = null;
  // Pillar 15 (Sovereign Guest Lockout) — persisted in localStorage (not a
  // plain in-memory field) deliberately: a guest holding the unlocked device
  // could otherwise escape the lock by simply refreshing the page, since a
  // bare field would reset to false on reload. Unlocking requires a fresh
  // WebAuthn re-authentication ceremony (see #unlockGuestMode) — the actual
  // security boundary, since the cached session identity in memory is still
  // the owner's regardless of who's physically holding the device.
  guestMode = localStorage.getItem('skippy_guest_mode') === 'true';
  guestUnlockError = '';
  // Sticky Heavy Hitter override — device-local preference, not security-
  // sensitive, same persistence rationale as rosterProfiles below.
  superBrainLocked = localStorage.getItem('skippy_super_brain_locked') === 'true';
  // "Tactical Roster" — persona/addressing context only, deliberately with
  // no permission concept of its own (see CLAUDE.md's Pillar 16 note): the
  // only real access boundary in this app is Guest Mode above, which a
  // Roster match never touches. Persisted in localStorage (device-local
  // convenience config, not security-sensitive, not per-Principal canister
  // data). `activeRosterProfile` itself is in-memory only — it resets on
  // refresh, since "who's currently talking" isn't a state worth surviving
  // a reload the way guestMode's lock is.
  rosterProfiles = JSON.parse(localStorage.getItem('skippy_roster_profiles') || '[]');
  activeRosterProfile = null;
  editingRosterIndex = null;
  // On-device speaker recognition (open-source, no API key — see voiceId.js)
  // — persona/tone signal only (see voiceId.js's header comment for why).
  // `hasEnrolledVoice` is
  // populated from IndexedDB after login, not localStorage — the actual
  // voiceprint bytes live there, this is just a UI flag. `lastSpeakerScore`
  // is in-memory only, same "doesn't need to survive a refresh" reasoning
  // as `activeRosterProfile`. `stopVoiceRecognition` holds the stop()
  // closure from voiceId.js's startRecognition() while it's running.
  hasEnrolledVoice = false;
  voiceEnrollmentActive = false;
  voiceEnrollmentPhase = 'recording';
  voiceEnrollmentProgress = 0;
  voiceEnrollmentError = '';
  lastSpeakerScore = null;
  stopVoiceRecognition = null;
  statusMessage = '';
  recognition = null;
  stopRequested = false;
  recognitionActive = false;
  // 'premium' (ElevenLabs via proxy) | 'economy' (browser speechSynthesis)
  voiceMode = 'premium';
  // Independent of voiceMode — when true, Skippy never speaks at all (either
  // engine), just renders text. For meetings/quiet rooms.
  voiceMuted = false;
  premiumAudioEl = null;
  // Most recent ACE-Step-generated song (a data: URI), kept around so the
  // "Save Song" control has something to point at — cleared/replaced by
  // every subsequent karaoke attempt, not persisted across reloads.
  lastKaraokeAudio = null;
  audioUnlocked = false;
  // Monotonic counter + abort handle so a new utterance can immediately
  // interrupt whatever Skippy is currently saying or still waiting on,
  // rather than dropping the new one or waiting for the old reply to
  // finish — see #askSkippy's "barge-in" handling.
  requestSeq = 0;
  currentAbortController = null;
  // True only while Skippy's voice is actually audible — lets the wake word
  // "Skippy" cut him off the instant it's heard, even on an interim (not
  // yet finalized) recognition result, rather than waiting for the whole
  // barge-in phrase to finish being transcribed. Without headphones, the
  // mic also picks up Skippy's own voice from the speakers, so a fast,
  // simple wake word is more reliable than fully solving acoustic echo.
  isSpeaking = false;
  #economySpeakTimer = null;
  // Bumped by #stopSpeaking every time a new reply starts (or a barge-in
  // cuts one off). #playPremiumSegments captures the value at the start of
  // each segment's playback attempt and every one of its async callbacks
  // (oncanplaythrough, the 8s loadTimeout) checks it's still current before
  // acting — see #speechGen usage below for why this exists.
  #speechGen = 0;

  authClient = null;
  identity = null;
  // 'loading' | 'logged-out' | 'rejected' | 'ready'
  authState = 'loading';
  authError = '';
  principalText = '';
  sessionToken = null;
  backendActor = null;
  // In-memory mirror of the canister's rolling history for this session —
  // fetched once at login, kept in sync locally so /respond doesn't need an
  // extra canister round trip on every single message.
  history = [];
  // 'default' | 'professional' | 'tactical' — live "current vibe", in-memory
  // only, resets to default on logout/refresh rather than being persisted.
  operationalMode = 'default';
  profileName = '';
  profileVoiceId = '';
  // Pillar 19 (Self-Evolution & Metacognitive Matrix) — fetched fresh after
  // login and refreshed after every evolution event (Critic Loop or Course
  // Correction). Always a real EvolutionProfile object once login completes
  // (the canister returns documented defaults, never null).
  evolutionProfile = null;
  evolutionLog = [];
  // TEMPORARY debug aid for verifying Brain Switching (Phase 5.3) — which
  // brain/model actually answered the last message. Drop once confirmed.
  lastBrain = '';
  lastModel = '';
  onPaidTier = false;
  brainFamily = 'dolphin'; // 'dolphin' | 'other' — quip only fires on transition
  brainTiers = null;
  showBrainGrid = false;
  tierIndex = -1;
  showLeftDrawer = false;
  showRightDrawer = false;
  showFuelModal = false;
  lastSpeakEndTime = 0; // timestamp when TTS last finished — used to discard
                        // recognition results that arrived during the cooldown window

  constructor() {
    if (SpeechRecognitionImpl) {
      this.#setUpRecognition();
    }
    // One persistent element, reused for every reply — see #unlockAudioPlayback.
    this.premiumAudioEl = new Audio();
    this.premiumAudioEl.crossOrigin = 'anonymous';
    // Web Audio gain graph for Dual-Voice routing (Pillar 18) — see
    // #ensureAudioGraph. audioContext/gainNode stay null until the first
    // real gesture-anchored #unlockAudioPlayback call sets them up.
    this.audioContext = null;
    this.gainNode = null;
    this.#render();
    this.#initAuth();
  }

  #initAuth = async () => {
    // AuthClient.create() is async; isAuthenticated() is async too, but
    // getIdentity() (used below) is synchronous — @dfinity/auth-client's
    // sync/async split is the opposite of what you'd guess.
    this.authClient = await AuthClient.create();
    if (await this.authClient.isAuthenticated()) {
      await this.#completeLogin(this.authClient.getIdentity());
    } else {
      this.authState = 'logged-out';
      this.#render();
    }
  };

  #login = () => {
    this.authState = 'loading';
    this.authError = '';
    this.#render();
    // login() takes onSuccess/onError callbacks rather than resolving its
    // own returned promise with the result.
    this.authClient.login({
      identityProvider: IDENTITY_PROVIDER,
      onSuccess: () => this.#completeLogin(this.authClient.getIdentity()),
      onError: (err) => {
        console.error('[Skippy] sign-in failed:', err);
        this.authState = 'logged-out';
        this.authError = `Sign-in failed: ${err}`;
        this.#render();
      },
    });
  };

  #completeLogin = async (identity) => {
    this.identity = identity;
    this.principalText = identity.getPrincipal().toString();

    const agent = await HttpAgent.create({ identity });
    if (process.env.DFX_NETWORK !== 'ic') {
      // Local replica's self-signed root key — same dance as the generated
      // anonymous createActor() does for non-"ic" networks.
      await agent.fetchRootKey().catch((err) => {
        console.warn('[Skippy] fetchRootKey failed:', err);
      });
    }
    // Built directly via @dfinity/agent's own Actor.createActor (not the
    // generated declarations' createActor, which is hardwired to
    // @icp-sdk/core's Actor/HttpAgent) — idlFactory itself is plain,
    // framework-agnostic Candid IDL data, reusable across both families.
    this.backendActor = Actor.createActor(idlFactory, {
      agent,
      canisterId: BACKEND_CANISTER_ID,
    });

    try {
      const result = await this.backendActor.login();
      if ('Ok' in result) {
        this.sessionToken = result.Ok;
        this.authState = 'ready';
      } else {
        this.authState = 'rejected';
        this.authError = result.Err;
        console.warn('[Skippy] Not whitelisted. Your principal:', this.principalText);
        this.#render();
        return;
      }
    } catch (err) {
      // The canister traps (rather than returning Err) for a non-whitelisted
      // caller — see assert_whitelisted() in lib.rs.
      this.authState = 'rejected';
      this.authError = err.message;
      console.warn('[Skippy] Not whitelisted. Your principal:', this.principalText);
      this.#render();
      return;
    }

    // login() already succeeded above (authState is 'ready') — anything
    // that fails from here on is a separate app-level problem, not an auth
    // rejection. Confirmed live 2026-06-21: a decode bug in list_my_workspaces
    // (unrelated to the whitelist) was thrown here and the old single
    // try/catch mislabeled it as "not authorized," showing the correct,
    // working Principal on a misleading rejection screen.
    try {
      await this.#loadWorkspaces();
      await this.#refreshManualOptions();
      const profileOpt = await this.backendActor.get_my_persona_profile();
      const profile = profileOpt[0];
      this.profileName = profile?.name?.[0] || '';
      this.profileVoiceId = profile?.voice_id?.[0] || '';
      this.evolutionProfile = await this.backendActor.get_my_evolution_profile();
      await this.#deliverPendingCourierMessages();
      await this.#refreshFuel();
      // On-device speaker recognition deliberately only ever instantiates
      // after a successful II login (never before, never while locked) —
      // confirmed requirement: dormant otherwise, no mic access, no
      // resources spent. Skipped entirely during Guest Mode, same as every
      // other owner-only action.
      this.hasEnrolledVoice = voiceIdAvailable() && Boolean(await loadStoredVoiceprint());
      if (this.hasEnrolledVoice && !this.guestMode) {
        this.#startSpeakerRecognition();
      }
    } catch (err) {
      console.error('[Skippy] post-login setup failed:', err);
      this.statusMessage = `Logged in, but failed to load workspace data: ${err.message}`;
    }
    this.#render();
  };

  // Pillar 15 — confirmed 2026-06-22: no confirmation step. The owner is
  // deliberately handing off the device right now and wants this to be a
  // single click/phrase, not a second "yes" to click through. `text` is only
  // passed by the voice/text trigger path below — it's what gives a spoken
  // confirmation, matching the existing Guardian-trigger pattern
  // (#standDownEmergency/#openComms/#goDark); a plain button click passes
  // nothing and just flips the state silently (the UI's own "🔒 Guest Mode
  // active" banner is confirmation enough for a manual tap).
  #enableGuestMode = (text) => {
    this.guestMode = true;
    this.guestUnlockError = '';
    localStorage.setItem('skippy_guest_mode', 'true');
    // The owner explicitly stepped away and locked things down — actively
    // trying to detect "is this the Commander" while Guest Mode is on
    // would be pointless (persona is already restricted regardless) and
    // needlessly keeps the mic open. Resumes automatically on unlock below.
    this.#stopSpeakerRecognitionFn();
    if (text !== undefined) {
      const reply = 'Guest Mode enabled. Brain and persona locked, destructive and admin actions hidden.';
      this.#recordTurn(text, reply);
      this.#speak(reply);
    }
    this.#render();
  };

  // On-device speaker recognition (open-source, no API key) — persona/tone
  // signal only, see voiceId.js. Starts/stops the background recognizer; guarded
  // so repeated calls (post-login, after enrollment, after Guest Mode
  // unlock) are all safe no-ops if already running/stopped.
  #startSpeakerRecognition = async () => {
    if (this.stopVoiceRecognition || this.guestMode) return;
    try {
      this.stopVoiceRecognition = await startRecognition((result) => {
        // Ignore scores while Skippy is speaking or within cooldown after TTS ends —
        // the mic picks up his own audio and he scores as Commander every time.
        if (this.isSpeaking || Date.now() - this.lastSpeakEndTime < App.#SPEAK_COOLDOWN_MS) return;
        this.lastSpeakerScore = result;
        // A confident Commander voice match is strong evidence any active
        // Tactical Roster profile (Pillar 16) is stale — e.g. someone said
        // "it's Lisa" earlier and has since walked off, and now the
        // Commander himself is talking again. Silently snaps back to
        // addressing the real Commander, no announcement (this fires every
        // ~4s in the background, not on a deliberate user action — same
        // reasoning as why this loop never speaks anything itself).
        // Deliberately one-directional: voice recognition only ever
        // confirms "this is genuinely the Commander" (the one enrolled
        // voiceprint that exists) — it never sets a Roster profile to
        // someone else, since there's no enrolled voiceprint for Lisa or
        // anyone else to confidently match against. An "Unverified Guest"
        // reading is not evidence of any specific person's identity.
        this.#render();
      });
    } catch (err) {
      console.warn('[Skippy] speaker recognition failed to start:', err);
    }
  };

  #stopSpeakerRecognitionFn = async () => {
    if (!this.stopVoiceRecognition) return;
    const stop = this.stopVoiceRecognition;
    this.stopVoiceRecognition = null;
    await stop();
  };

  // Hidden setup function (Profile settings drawer, owner-only — never
  // shown during Guest Mode): records a few short clips and averages their
  // embeddings, then persists the result to IndexedDB. Pauses background
  // recognition first since both want exclusive mic access.
  #startVoiceEnrollment = async () => {
    if (this.guestMode || this.voiceEnrollmentActive) return;
    this.voiceEnrollmentActive = true;
    this.voiceEnrollmentPhase = 'recording';
    this.voiceEnrollmentProgress = 0;
    this.voiceEnrollmentError = '';
    this.#render();
    await this.#stopSpeakerRecognitionFn();
    try {
      await enrollVoice(({ phase, percent }) => {
        this.voiceEnrollmentPhase = phase;
        this.voiceEnrollmentProgress = percent;
        this.#render();
      });
      this.hasEnrolledVoice = true;
    } catch (err) {
      console.error('[Skippy] voice enrollment failed:', err);
      this.voiceEnrollmentError = err.message;
    } finally {
      this.voiceEnrollmentActive = false;
      this.voiceCalibrationModal = false;
      this.#render();
      if (this.hasEnrolledVoice) {
        this.#startSpeakerRecognition();
      }
    }
  };

  // Translates the latest live recognition score into the tag shape
  // server.js expects on /respond. There's inherent timing slack between a finalized
  // speech-to-text transcript and the parallel raw-audio recognition
  // stream — this reports whatever the most recent score happens to be,
  // not one synced exactly to the utterance boundary. Acceptable for a
  // tone signal; would not be for a real permission gate.
  #currentSpeakerTag = () => {
    if (!this.hasEnrolledVoice || !this.lastSpeakerScore) return null;
    return this.lastSpeakerScore.isCommander
      ? { label: 'Commander', score: this.lastSpeakerScore.score }
      : { label: 'Unverified Guest', score: this.lastSpeakerScore.score };
  };

  #deleteEnrolledVoice = async () => {
    await this.#stopSpeakerRecognitionFn();
    await deleteVoiceprint();
    this.hasEnrolledVoice = false;
    this.lastSpeakerScore = null;
    this.#render();
  };

  // text is only passed by the voice/text trigger path (gives a spoken
  // confirmation); a plain button click passes nothing and flips the state
  // silently, same asymmetry-of-confirmation precedent as #enableGuestMode.
  #setSuperBrainLock = (locked, text) => {
    this.superBrainLocked = locked;
    localStorage.setItem('skippy_super_brain_locked', String(locked));
    if (text !== undefined) {
      const reply = locked
        ? "Super Brain locked in, Commander. I'm staying on the Heavy Hitter engine until you say otherwise — Steel Rain still overrides for latency."
        : 'Super Brain unlocked. Back to normal one-shot brain switching.';
      this.#recordTurn(text, reply);
      this.#speak(reply);
    }
    this.#render();
  };

  // Replies locally first (no waiting on the canister write) since the
  // sulky acknowledgment is the whole point of this being immediate — the
  // record_evolution_event call and refreshed weights land moments later.
  #applyCourseCorrection = async (text) => {
    const reply = COURSE_CORRECTION_REPLIES[Math.floor(Math.random() * COURSE_CORRECTION_REPLIES.length)];
    this.#recordTurn(text, reply);
    this.#render();
    this.#speak(reply);
    try {
      await this.backendActor.record_evolution_event(
        {
          snark_level_delta: -0.15,
          vendor_skepticism_delta: 0,
          technical_precision_delta: 0,
          proactive_interruption_delta: 0,
        },
        `Course-corrected after a direct reprimand: "${text}"`,
      );
      this.evolutionProfile = await this.backendActor.get_my_evolution_profile();
      this.#render();
    } catch (err) {
      console.error('[Skippy] course correction failed to persist:', err);
    }
  };

  // Fires a fresh, original 80s-hair-band-or-Nightwish-style song via the
  // dedicated /karaoke route (not /respond — none of the persona/RAG/
  // brevity machinery there applies to a one-off performance). A real
  // OpenRouter call (unlike the deterministic offer ack) since the whole
  // point is a different song each time.
  #performKaraoke = async (text) => {
    this.statusMessage = 'Skippy is warming up...';
    this.#render();
    try {
      const response = await fetch(`${PROXY_URL}/karaoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Skippy-Session': this.sessionToken },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Karaoke request failed.');
      this.statusMessage = '';
      this.#recordTurn(text, data.reply);
      // Cleared unconditionally so a stale link from a previous song can't
      // linger if this attempt had no audio (ACE-Step unavailable/failed).
      this.lastKaraokeAudio = data.audio || null;
      this.#render();
      // Experimental (2026-07-08): real AI-generated music from ACE-Step, if
      // the proxy managed to generate it — additive on top of the existing
      // TTS-based singing path, never a replacement for it. `data.audio` is
      // only present when the backend's best-effort ACE-Step call actually
      // succeeded; any failure there (including its own real ~1-minute
      // generation time) already fell through server-side, so `audio` is
      // simply absent here and this behaves exactly as it did before tonight.
      if (data.audio) {
        // Confirmed live 2026-07-08: jumping straight to the raw ACE-Step
        // audio silently skipped the spoken hype line entirely (it's plain
        // text in `data.reply`, never sent to ACE-Step, which only ever
        // sings the lyrics). Speak it first through the normal TTS path,
        // then chain into the real song once that finishes — same shape as
        // the existing multi-segment TTS flow, just handing off to a
        // different audio source for the second "segment."
        if (data.hypeLine) {
          this.#stopSpeaking();
          this.#playPremiumSegments(
            [{ text: data.hypeLine, voice: 'conversational' }],
            0,
            () => this.#playKaraokeAudio(data.audio),
          );
        } else {
          this.#playKaraokeAudio(data.audio);
        }
      } else {
        this.#speak(data.reply);
      }
    } catch (err) {
      console.error('[Skippy] karaoke failed:', err);
      this.statusMessage = `Couldn't get the song going: ${err.message}`;
      this.#render();
    }
  };

  // Plays a real generated song (a data: URI from ACE-Step) through the same
  // premium <audio> element the TTS path uses, but as its own small, separate
  // path rather than folding into #playPremiumSegments — that function's
  // segment-splitting/fallback-to-Economy logic doesn't apply to a single,
  // already-complete audio file, and keeping this separate avoids risking
  // the #speechGen orphaned-timeout fix made earlier the same session.
  #playKaraokeAudio = (dataUri) => {
    this.#stopSpeaking();
    const myGen = this.#speechGen;
    const audio = this.premiumAudioEl;
    if (this.gainNode) this.gainNode.gain.value = SINGING_VOICE_GAIN;
    audio.src = dataUri;
    audio.load();

    audio.onplaying = () => {
      if (myGen !== this.#speechGen) return;
      this.isSpeaking = true;
      this.#render();
    };
    audio.onended = () => {
      if (myGen !== this.#speechGen) return;
      this.isSpeaking = false;
      this.lastSpeakEndTime = Date.now();
      this.#render();
      if (this._restartRecognitionAfterTTS && this.state !== 'idle' && !this.stopRequested && !this.recognitionActive) {
        this._restartRecognitionAfterTTS = false;
        setTimeout(() => this.#startRecognition(), 300);
      }
    };
    audio.onerror = () => {
      if (myGen !== this.#speechGen) return;
      console.warn('[Skippy] ACE-Step audio playback failed');
      this.isSpeaking = false;
      this.#render();
    };

    const doPlay = () => audio.play().catch((err) => {
      console.warn('[Skippy] ACE-Step audio autoplay rejected:', err.name, err.message);
    });
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().then(doPlay).catch(doPlay);
    } else {
      doPlay();
    }
  };

  // "Any way the song can be saved... and exported?" — the audio only ever
  // lived in memory for one playback (fetched fresh from ACE-Step each time,
  // never stored anywhere). This is a plain browser file download of the
  // already-in-hand data: URI, not new backend storage — the simplest thing
  // that actually answers the question, with no canister/stable-memory
  // design needed for what's currently a one-off experimental feature.
  #downloadKaraokeAudio = () => {
    if (!this.lastKaraokeAudio) return;
    const a = document.createElement('a');
    a.href = this.lastKaraokeAudio;
    a.download = `skippy-karaoke-${Date.now()}.mp3`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // The cached session identity in `this.identity`/`this.backendActor` is
  // still the owner's the whole time Guest Mode is active — a guest holding
  // the unlocked device already has full access to that in-memory session,
  // so simply re-checking it proves nothing. The actual gate is forcing a
  // *fresh* WebAuthn ceremony here (a new authClient.login() call), which a
  // guest can't pass without the owner's real passkey/biometric/security
  // key, regardless of what's cached in the page. The canister whitelist
  // check on top of that closes the other gap: without it, a guest with
  // their own unrelated Internet Identity anchor could pass *a* WebAuthn
  // ceremony (their own) and we'd have no way to tell that apart from the
  // owner's — assert_whitelisted() ensures it's specifically one of the two
  // authorized Principals, not just "any successfully authenticated identity."
  #unlockGuestMode = () => {
    this.guestUnlockError = '';
    this.authClient.login({
      identityProvider: IDENTITY_PROVIDER,
      onSuccess: async () => {
        try {
          const freshIdentity = this.authClient.getIdentity();
          const agent = await HttpAgent.create({ identity: freshIdentity });
          if (process.env.DFX_NETWORK !== 'ic') {
            await agent.fetchRootKey().catch(() => {});
          }
          const verifyActor = Actor.createActor(idlFactory, { agent, canisterId: BACKEND_CANISTER_ID });
          await verifyActor.verify_unlock();
          this.guestMode = false;
          localStorage.removeItem('skippy_guest_mode');
          if (this.hasEnrolledVoice) {
            this.#startSpeakerRecognition();
          }
        } catch (err) {
          // Deliberately generic — per Pillar 15, a failed check shouldn't
          // hand a guest a working oracle for probing the whitelist by
          // revealing the canister's actual rejection detail.
          console.error('[Skippy] guest unlock verification failed:', err);
          this.guestUnlockError = 'Unlock failed.';
        }
        this.#render();
      },
      onError: () => {
        this.guestUnlockError = 'Unlock failed.';
        this.#render();
      },
    });
  };

  #saveRosterProfile = (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.elements.rosterName.value.trim();
    const triggerPhrase = form.elements.rosterTrigger.value.trim().toLowerCase();
    const role = form.elements.rosterRole.value.trim();
    const notes = form.elements.rosterNotes.value.trim();
    if (!name || !triggerPhrase) return;
    const profile = { name, triggerPhrase, role, notes };
    if (this.editingRosterIndex !== null) {
      const updated = [...this.rosterProfiles];
      const old = updated[this.editingRosterIndex];
      updated[this.editingRosterIndex] = profile;
      if (this.activeRosterProfile?.triggerPhrase === old.triggerPhrase) {
        this.activeRosterProfile = profile;
      }
      this.rosterProfiles = updated;
      this.editingRosterIndex = null;
    } else {
      this.rosterProfiles = [...this.rosterProfiles, profile];
    }
    localStorage.setItem('skippy_roster_profiles', JSON.stringify(this.rosterProfiles));
    form.reset();
    this.#render();
  };

  #editRosterProfile = (index) => {
    this.editingRosterIndex = index;
    this.#render();
  };

  #cancelEditRoster = () => {
    this.editingRosterIndex = null;
    this.#render();
  };

  #deleteRosterProfile = (triggerPhrase) => {
    this.rosterProfiles = this.rosterProfiles.filter((p) => p.triggerPhrase !== triggerPhrase);
    if (this.activeRosterProfile?.triggerPhrase === triggerPhrase) {
      this.activeRosterProfile = null;
    }
    if (this.editingRosterIndex !== null) {
      this.editingRosterIndex = null;
    }
    localStorage.setItem('skippy_roster_profiles', JSON.stringify(this.rosterProfiles));
    this.#render();
  };

  #clearActiveRosterProfile = () => {
    this.activeRosterProfile = null;
    this.#render();
  };

  #logout = async () => {
    await this.authClient.logout();
    this.identity = null;
    this.principalText = '';
    this.sessionToken = null;
    this.backendActor = null;
    this.history = [];
    this.workspaces = [];
    this.activeWorkspaceId = null;
    this.pendingWebSearchQuery = null;
    this.pendingWorkspaceCreate = false;
    this.pendingRosterStep = null;
    this.pendingRosterName = null;
    this.operationalMode = 'default';
    this.profileName = '';
    this.brainFamily = 'dolphin';
    this.profileVoiceId = '';
    this.authState = 'logged-out';
    this.showLeftDrawer = false;
    this.showRightDrawer = false;
    this.superBrainLocked = false;
    localStorage.removeItem('skippy_super_brain_locked');
    this.#render();
  };

  #saveProfile = async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.elements.profileName.value.trim();
    const voiceId = form.elements.profileVoiceId.value.trim();
    await this.backendActor.set_persona_profile(name, voiceId);
    this.profileName = name;
    this.profileVoiceId = voiceId;
    this.statusMessage = 'Profile saved.';
    this.#render();
  };

  // Typed alternative to voice — same #askSkippy pipeline (mode/brain
  // detection, barge-in, history) as a spoken utterance, for meetings or
  // anywhere talking to a screen out loud isn't an option. Reads the value
  // directly from the form on submit (same pattern as #saveProfile) rather
  // than tracking it reactively on every keystroke — a controlled input
  // re-rendering on every keystroke fights with the mic's own re-renders
  // firing on every interim speech result while listening is active, and
  // the two competing renders can reset the input's cursor/focus mid-type.
  #sendTextMessage = (e) => {
    e.preventDefault();
    const form = e.target;
    const text = form.elements.textInput.value.trim();
    if (!text) return;
    form.elements.textInput.value = '';

    if (this.manualNoteMode) {
      // Stays in note mode after saving (not a one-shot) — a meeting can
      // produce several quick notes in a row, and re-toggling between each
      // one would defeat the point of having a quiet mode at all.
      this.#persistNote(text);
      return;
    }

    // Mirrors #handleFinalChunk's note-trigger check (voice path) — typed
    // input arrives complete in one shot, so there's no need for the voice
    // flow's incremental dictate-then-"Stop & Save" buffer: just strip the
    // trigger phrase and save whatever's left directly.
    const lowerText = text.toLowerCase();
    const matchedPhrase = TRIGGER_PHRASES.find((phrase) => lowerText.includes(phrase));
    if (matchedPhrase) {
      const matchIndex = lowerText.indexOf(matchedPhrase);
      const remainder = text
        .slice(matchIndex + matchedPhrase.length)
        .replace(/^[:,.\s]+/, '')
        .trim();
      if (remainder) {
        this.#persistNote(remainder).then(() => this.#askSkippy(remainder));
      }
      return;
    }

    this.#askSkippy(text);
  };

  // A <textarea> doesn't auto-submit its form on Enter the way the old
  // single-line <input> did — restore that (Shift+Enter still inserts a
  // newline, same convention as Slack/Discord) now that the box is multi-line.
  #handleTextareaKeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.target.form.requestSubmit();
    }
  };

  #clearHistory = async () => {
    if (!window.confirm('Erase your entire conversation history with Skippy? This cannot be undone.')) {
      return;
    }
    await this.backendActor.purge_history(this.activeWorkspaceId);
    this.history = [];
    this.statusMessage = 'History cleared.';
    this.#render();
  };

  // Markdown, not JSON — this is meant to be read by a human after the
  // workspace is gone (Pillar 10), not re-imported into Skippy. Message
  // timestamps are a bigint (nanoseconds) when they came from the canister's
  // get_history, but a plain ms Number for anything appended locally this
  // session (#recordTurn) before the next login round-trips it — handle both.
  #exportWorkspace = () => {
    const workspace = this.workspaces.find((w) => w.id === this.activeWorkspaceId);
    const title = workspace?.name || 'Skippy Conversation';
    const toDate = (ts) =>
      typeof ts === 'bigint' ? new Date(Number(ts / 1_000_000n)) : new Date(Number(ts));

    const lines = [`# ${title}`, ''];
    for (const { role, content, timestamp } of this.history) {
      const who = role === 'user' ? 'You' : 'Skippy';
      lines.push(`**${who}** (${toDate(timestamp).toISOString()}):`, '', content, '');
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    link.download = `${slug || 'skippy-workspace'}-${new Date().toISOString()}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Loads (or, on first-ever login, creates) the caller's workspaces and
  // settles on one Active workspace to actually display/chat in. Shared by
  // login and by delete (since deleting the last active workspace needs the
  // exact same "make sure something Active exists" fallback).
  // Confirmed live 2026-06-21: replaces the old hardcoded MMUCC_V6/ANSI_D16
  // placeholders with whatever manuals actually have content, fetched fresh
  // from the canister. NOTES_MANUAL is always kept available regardless,
  // since it's the built-in notes feature, not an uploaded manual.
  #refreshManualOptions = async () => {
    const realNames = await this.backendActor.list_manual_names();
    const merged = new Set([NOTES_MANUAL, ...realNames]);
    this.manualOptions = [...merged].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
    if (!this.manualOptions.includes(this.selectedManual)) {
      this.selectedManual = this.manualOptions[0];
    }
    const categoryPairs = await this.backendActor.manual_category_map();
    this.manualCategories = new Map(
      categoryPairs.filter(([, category]) => category).map(([name, category]) => [name, category]),
    );
  };

  #handleManualFilterInput = (e) => {
    this.manualFilterText = e.target.value;
    this.#render();
  };

  #handleManualCategoryFilter = (e) => {
    this.manualCategoryFilter = e.target.value;
    this.#render();
  };

  #loadWorkspaces = async () => {
    this.workspaces = await this.backendActor.list_my_workspaces();
    let active = this.workspaces.find((w) => 'Active' in w.status);
    if (!active) {
      const id = await this.backendActor.create_workspace('Default');
      this.workspaces = await this.backendActor.list_my_workspaces();
      active = this.workspaces.find((w) => w.id === id);
    }
    await this.#switchWorkspace(active.id);
  };

  #switchWorkspace = async (id) => {
    this.activeWorkspaceId = id;
    this.pendingWebSearchQuery = null;
    this.history = await this.backendActor.get_history(id);
    this.#render();
  };

  #handleWorkspaceChange = (e) => {
    this.#switchWorkspace(BigInt(e.target.value));
  };

  #createWorkspace = async () => {
    const name = window.prompt('New workspace name:');
    if (!name || !name.trim()) return;
    const id = await this.backendActor.create_workspace(name.trim());
    this.workspaces = await this.backendActor.list_my_workspaces();
    await this.#switchWorkspace(id);
  };

  #archiveActiveWorkspace = async () => {
    if (this.workspaces.filter((w) => 'Active' in w.status).length <= 1) {
      window.alert("That's your only active workspace — create or restore another one first.");
      return;
    }
    // Captured before switching away — #switchWorkspace below overwrites
    // this.history with the next active workspace's, so the Critic Loop
    // (Pillar 19) needs its own copy of what's actually closing.
    const closingHistory = this.history;
    await this.backendActor.archive_workspace(this.activeWorkspaceId);
    this.workspaces = await this.backendActor.list_my_workspaces();
    const nextActive = this.workspaces.find((w) => 'Active' in w.status);
    await this.#switchWorkspace(nextActive.id);
    // Fire-and-forget: a failed self-critique is a missed reflection, not a
    // broken archive — it must never block or error the action the user
    // actually asked for.
    this.#runCriticLoop(closingHistory);
  };

  // Pillar 19 — the "Critic Loop." Stand-in trigger for "post-mission
  // debrief" until that's a real dedicated feature (confirmed 2026-06-22):
  // fires whenever a workspace is archived, i.e. whenever a chat is
  // genuinely closed. Skipped entirely for an empty/unused workspace — no
  // point self-critiquing a conversation that never happened.
  #runCriticLoop = async (history) => {
    if (history.length === 0) return;
    try {
      const response = await fetch(`${PROXY_URL}/critic-loop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Skippy-Session': this.sessionToken },
        body: JSON.stringify({ history: history.map(({ role, content }) => ({ role, content })) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Critic Loop failed.');
      await this.backendActor.record_evolution_event(data.deltas, data.summary);
      this.evolutionProfile = await this.backendActor.get_my_evolution_profile();
      this.#render();
    } catch (err) {
      console.error('[Skippy] Critic Loop failed:', err);
    }
  };

  #restoreWorkspace = async (id) => {
    await this.backendActor.restore_workspace(id);
    this.workspaces = await this.backendActor.list_my_workspaces();
    this.#render();
  };

  #deleteActiveWorkspaceForever = async () => {
    if (
      !window.confirm(
        'Permanently delete this workspace and all its history? Export first if you want a copy — this cannot be undone.',
      )
    ) {
      return;
    }
    await this.backendActor.delete_workspace(this.activeWorkspaceId);
    await this.#loadWorkspaces();
  };

  #activeWorkspace = () => this.workspaces.find((w) => w.id === this.activeWorkspaceId);

  // Pillar 10 extension (Phase 5.6.1) — pinned per-workspace context, saved
  // on submit rather than tracked reactively (same DOM-read-on-submit
  // pattern as #saveProfile) so typing in this box doesn't fight with the
  // mic's own re-renders firing on every interim speech result.
  #saveScratchpad = async (e) => {
    e.preventDefault();
    const value = e.target.elements.scratchpadText.value;
    await this.backendActor.update_scratchpad(this.activeWorkspaceId, value);
    this.workspaces = await this.backendActor.list_my_workspaces();
    this.statusMessage = 'Scratchpad saved.';
    this.#render();
  };

  // Pillar 10 extension (Phase 5.6.1) — purely a visual/organizational pin;
  // per Pillar 6's "global, not siloed" rule, this never changes what RAG
  // actually retrieves, only what's displayed as "active for this project."
  #toggleAssociatedManual = async (manualName, checked) => {
    const workspace = this.#activeWorkspace();
    const current = new Set(workspace?.associated_manuals?.[0] ?? []);
    if (checked) current.add(manualName);
    else current.delete(manualName);
    await this.backendActor.update_associated_manuals(this.activeWorkspaceId, [...current]);
    this.workspaces = await this.backendActor.list_my_workspaces();
    this.#render();
  };

  // Pillar 10 extension (Phase 5.6.1) — a separate synthesis call (proxy
  // /project-brief), distinct from #exportWorkspace's verbatim transcript
  // dump. Downloads the result the same blob-download way as the export.
  #generateProjectBrief = async () => {
    if (this.history.length === 0) {
      window.alert('Nothing to summarize yet — this workspace has no conversation history.');
      return;
    }
    const workspace = this.#activeWorkspace();
    this.statusMessage = 'Generating project brief (this can take a moment)...';
    this.#render();
    try {
      const response = await fetch(`${PROXY_URL}/project-brief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Skippy-Session': this.sessionToken },
        body: JSON.stringify({
          history: this.history.map(({ role, content }) => ({ role, content })),
          title: workspace?.name || 'Workspace',
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to generate brief.');

      const doc = new Document({
        sections: [
          {
            children: [
              ...projectBriefMetadataParagraphs(workspace),
              ...markdownToDocxParagraphs(data.brief),
            ],
          },
        ],
      });
      const blob = await Packer.toBlob(doc);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const slug = (workspace?.name || 'workspace').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      link.download = `${slug || 'skippy-workspace'}-brief-${new Date().toISOString()}.docx`;
      link.click();
      URL.revokeObjectURL(url);
      this.statusMessage = 'Project brief downloaded.';
    } catch (err) {
      this.statusMessage = `Couldn't generate project brief: ${err.message}`;
    }
    this.#render();
  };

  // Dual-Voice routing (Pillar 18) needs to boost the singing voice's
  // playback level above the conversational voice's native loudness (the
  // cloned singing voice renders quieter at the source — confirmed live
  // 2026-06-23 — and a plain <audio> element's .volume is capped at 1.0, so
  // there's no way to amplify past native level without an actual gain
  // node). createMediaElementSource can only be called ONCE per <audio>
  // element ever (a second call throws), so this graph is built once, here,
  // and reused for every subsequent #speak call rather than rebuilt per call.
  #ensureAudioGraph() {
    if (this.audioContext) return;
    const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextImpl) return; // no Web Audio support — native 1.0 volume only
    this.audioContext = new AudioContextImpl();
    const source = this.audioContext.createMediaElementSource(this.premiumAudioEl);
    this.gainNode = this.audioContext.createGain();
    source.connect(this.gainNode).connect(this.audioContext.destination);
  }

  #unlockAudioPlayback() {
    // Must run synchronously inside a real user-gesture handler (no awaits
    // before this). Mobile browsers track "may autoplay" per *element
    // instance* once it's successfully played from a genuine tap — playing
    // a silent clip here lets this same element play Premium audio later,
    // even though that later call happens deep inside an async chain with
    // no gesture of its own.
    if (this.audioUnlocked) return;
    this.#ensureAudioGraph();
    this.premiumAudioEl.src = SILENT_AUDIO_DATA_URI;
    this.premiumAudioEl
      .play()
      .then(() => {
        this.premiumAudioEl.pause();
        this.audioUnlocked = true;
        console.log('[Skippy] audio playback unlocked');
      })
      .catch((err) => {
        console.warn('[Skippy] audio unlock failed:', err.name, err.message);
      });
  }

  #setUpRecognition() {
    this.recognition = new SpeechRecognitionImpl();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.recognition.onstart = () => {
      console.log('[Skippy] speech recognition started');
      this.recognitionActive = true;
    };

    this.recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result.isFinal) {
          this.liveTranscript = result[0].transcript;
          console.log('[Skippy] interim transcript:', this.liveTranscript);
          // Cut Skippy off the instant the wake word is heard, rather than
          // waiting for the rest of the barge-in phrase to finish being
          // transcribed — saying "Skippy" alone is enough to shut him up.
          if (this.isSpeaking && this.liveTranscript.toLowerCase().includes('skippy')) {
            this.#stopSpeaking();
            this.statusMessage = "I'm listening...";
          }
          this.#render();
          continue;
        }

        const chunk = result[0].transcript;
        console.log('[Skippy] interim transcript (final):', chunk);
        this.liveTranscript = '';
        this.#handleFinalChunk(chunk);
      }
    };

    this.recognition.onend = () => {
      console.log('[Skippy] speech recognition ended');
      this.recognitionActive = false;
      if (this.state !== 'idle' && !this.stopRequested) {
        if (this.isSpeaking) {
          // TTS has audio focus — restarting now causes a double-dong on Android
          // and immediately picks up speaker audio. Set a flag; onended restarts us.
          this._restartRecognitionAfterTTS = true;
        } else {
          this.#startRecognition();
        }
      }
    };

    this.recognition.onerror = (event) => {
      console.error('[Skippy] speech recognition error:', event.error, event.message);
      this.statusMessage = `Speech recognition error: ${event.error}`;
      this.#render();
    };
  }

  #startRecognition() {
    if (this.recognitionActive) {
      console.warn('[Skippy] recognition already active, skipping start()');
      return;
    }
    try {
      this.recognition.start();
    } catch (err) {
      console.error('[Skippy] recognition.start() threw:', err);
      this.statusMessage = `Couldn't start the microphone: ${err.message}`;
      this.#render();
    }
  }

  // How long after TTS ends to ignore mic input — catches recognition results
  // that were queued during playback but arrive just after isSpeaking flips false.
  static #SPEAK_COOLDOWN_MS = 1200; // ms to ignore mic after TTS ends

  #handleFinalChunk = (chunk) => {
    // Discard anything the mic picked up while Skippy is speaking — prevents
    // his own audio output from looping back through speech recognition and
    // triggering a new reply. Barge-in is unaffected (it fires on interim
    // results in onresult, not here).
    if (this.isSpeaking) return;
    // Also discard results that arrived during the cooldown window after TTS
    // ended — these are the tail of Skippy's own audio being finalized by the
    // recognition engine a split-second after isSpeaking flipped to false.
    // Skip the cooldown when waiting for a deliberate one-word confirmation
    // (karaoke offer or web-search permission) — the user's "yes"/"go" is
    // intentional, not Skippy's own voice looping back.
    const awaitingConfirmation = this.pendingKaraokeOffer || !!this.pendingWebSearchQuery || !!this.pendingRosterStep;
    if (!awaitingConfirmation && Date.now() - this.lastSpeakEndTime < App.#SPEAK_COOLDOWN_MS) return;
    if (this.state === 'listening') {
      const lowerChunk = chunk.toLowerCase();
      const matchedPhrase = TRIGGER_PHRASES.find((phrase) =>
        lowerChunk.includes(phrase),
      );

      if (matchedPhrase) {
        const matchIndex = lowerChunk.indexOf(matchedPhrase);
        const remainder = chunk.slice(matchIndex + matchedPhrase.length).trim();
        this.noteBuffer = remainder;
        this.state = 'dictating';
      } else if (chunk.trim()) {
        // Not a note-taking trigger phrase — treat it as a direct question/
        // remark for Skippy and dispatch it to the proxy right away.
        console.log('[Skippy] dispatching final transcript to proxy:', chunk);
        this.#askSkippy(chunk.trim());
      }
    } else if (this.state === 'dictating') {
      this.noteBuffer = `${this.noteBuffer} ${chunk}`.trim();
    }

    this.#render();
  };

  #startListening = async () => {
    if (!this.recognition) return;

    // Synchronous, first thing, still inside the click's call stack —
    // this is what makes the unlock count as user-gesture-initiated.
    this.#unlockAudioPlayback();

    if (!window.isSecureContext) {
      console.error('[Skippy] refusing to start mic: insecure context', window.location.href);
      this.statusMessage =
        "Microphone access needs a secure context (https, or localhost) — this page isn't one.";
      this.#render();
      return;
    }

    try {
      console.log('[Skippy] requesting microphone permission...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      console.log('[Skippy] microphone permission granted');
    } catch (err) {
      console.error('[Skippy] getUserMedia failed:', err.name, err.message);
      this.statusMessage = `Microphone access failed (${err.name}): ${err.message}`;
      this.#render();
      return;
    }

    this.stopRequested = false;
    this.state = 'listening';
    this.statusMessage = '';
    this.#startRecognition();
    this.#render();
  };

  #stopListening = () => {
    if (!this.recognition) return;
    this.stopRequested = true;
    this.state = 'idle';
    this.noteBuffer = '';
    this.liveTranscript = '';
    this.recognition.stop();
    this.#render();
  };

  #cancelDictation = () => {
    this.noteBuffer = '';
    this.liveTranscript = '';
    this.state = 'listening';
    this.#render();
  };

  // Shared by the voice dictation flow (#saveNote, content gathered
  // incrementally into noteBuffer) and the typed one-shot flow
  // (#sendTextMessage, content already complete at submit time) — the
  // actual canister write + Notes Vault refresh is identical either way.
  #persistNote = async (content) => {
    const timestamp = new Date().toISOString();
    const title = content.split(/\s+/).slice(0, 6).join(' ');

    this.statusMessage = 'Saving note...';
    this.#render();

    await this.backendActor.add_manual_section(
      NOTES_MANUAL,
      timestamp,
      title,
      content,
    );

    this.statusMessage = 'Note saved.';
    if (this.selectedManual === NOTES_MANUAL) {
      await this.#refreshSections();
    } else {
      this.#render();
    }
  };

  #saveNote = async () => {
    const content = this.noteBuffer.trim();
    if (!content) {
      this.#cancelDictation();
      return;
    }

    this.noteBuffer = '';
    this.state = 'listening';
    await this.#persistNote(content);
    await this.#askSkippy(content);
  };

  // Implements Pillar 3's precedence rules: thinking-hat is one-shot and
  // model-only (mode unchanged); steel-rain unifies tactical persona + the
  // Tactical Brain in one trigger; be-yourself/behave switch the sticky
  // operational mode (Everyday Brain); otherwise stay on whatever mode/brain
  // was already active.
  #detectModeAndBrain(text) {
    const result = this.#detectModeAndBrainCore(text);
    // Sticky Super Brain override — applied after all the one-shot/mode
    // logic below, so it wins over the default "everyday" brain but never
    // fights Steel Rain's deliberately fast Tactical brain while that mode
    // is actually active. Guest Mode's own lock (inside Core, above) always
    // takes precedence regardless.
    if (this.superBrainLocked && !this.guestMode && result.brain !== 'tactical') {
      return { ...result, brain: 'heavy_hitter' };
    }
    return result;
  }

  #detectModeAndBrainCore(text) {
    // Pillar 15 — Guest Mode locks the brain/persona that was active the
    // moment it was enabled; no trigger phrase (voice or typed) can change
    // either while it's on.
    if (this.guestMode) {
      return {
        mode: this.operationalMode,
        brain: this.operationalMode === 'tactical' ? 'tactical' : 'everyday',
      };
    }

    const lower = text.toLowerCase();

    if (lower.includes(THINKING_HAT_PHRASE)) {
      const remainder = lower.replace(THINKING_HAT_PHRASE, '');
      const ack = isTrivialRemainder(remainder) ? THINKING_HAT_BARE_ACKNOWLEDGMENT : undefined;
      return { mode: this.operationalMode, brain: 'heavy_hitter', ack };
    }
    const steelRainPhrase = STEEL_RAIN_PHRASES.find((phrase) => lower.includes(phrase));
    if (steelRainPhrase) {
      const remainder = lower.replace(steelRainPhrase, '');
      const ack = isTrivialRemainder(remainder) ? MODE_SWITCH_ACKNOWLEDGMENTS.tactical : undefined;
      return { mode: 'tactical', brain: 'tactical', ack };
    }
    const focusPhrase = FOCUS_MODE_PHRASES.find((phrase) => lower.includes(phrase));
    if (focusPhrase) {
      const remainder = lower.replace(focusPhrase, '');
      const ack = isTrivialRemainder(remainder) ? MODE_SWITCH_ACKNOWLEDGMENTS.focus : undefined;
      return { mode: 'focus', brain: 'tactical', ack };
    }
    if (lower.includes('skippy')) {
      for (const [phrase, mode] of Object.entries(MODE_TRIGGER_PHRASES_WITH_LEAD_IN)) {
        if (lower.includes(phrase)) {
          const remainder = lower.replace('skippy', '').replace(phrase, '');
          const ack = isTrivialRemainder(remainder) ? MODE_SWITCH_ACKNOWLEDGMENTS[mode] : undefined;
          return { mode, brain: 'everyday', ack };
        }
      }
    }
    return {
      mode: this.operationalMode,
      brain: this.operationalMode === 'tactical' ? 'tactical' : this.operationalMode === 'focus' ? 'focus' : 'everyday',
    };
  }

  // Records a completed turn (real or canned) in local + canister history,
  // capped to MAX_LOCAL_HISTORY — shared by both the normal OpenRouter path
  // and the bare-trigger-phrase acknowledgment path below.
  #recordTurn(userText, assistantText) {
    const now = Date.now();
    this.history.push(
      { role: 'user', content: userText, timestamp: now },
      { role: 'assistant', content: assistantText, timestamp: now },
    );
    if (this.history.length > MAX_LOCAL_HISTORY) {
      this.history.splice(0, this.history.length - MAX_LOCAL_HISTORY);
    }
    // Fire-and-forget: the canister is the source of truth for the *next*
    // login's history, but this turn's reply already played — a failure
    // here shouldn't block or re-render the UI around it.
    this.backendActor.append_turn(this.activeWorkspaceId, userText, assistantText).catch((err) => {
      console.error('[Skippy] failed to persist conversation turn:', err);
    });
  }

  // A new utterance always wins over whatever Skippy is currently saying or
  // still waiting on — barging in is the whole point of a voice trigger
  // phrase like "Skippy, behave" ("I don't want to wait for him to finish
  // before I can switch modes"). mySeq lets a late-arriving response from a
  // since-superseded request detect that it's stale and discard itself.
  #embed = async (texts) => {
    const response = await fetch(`${PROXY_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Skippy-Session': this.sessionToken },
      body: JSON.stringify({ texts }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Embedding request failed.');
    return data.embeddings;
  };

  // Tavily, via the proxy's fixed /web-search route — see CLAUDE.md Pillar 6
  // for why this (not arbitrary URL fetching) is what closes the SSRF risk.
  #webSearch = async (query) => {
    const response = await fetch(`${PROXY_URL}/web-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Skippy-Session': this.sessionToken },
      body: JSON.stringify({ query }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Web search failed.');
    return data;
  };

  #askSkippy = async (text) => {
    this.#stopSpeaking();
    this.currentAbortController?.abort();
    this.currentAbortController = new AbortController();
    const { signal } = this.currentAbortController;
    const mySeq = ++this.requestSeq;

    const lowerText = text.toLowerCase();
    if (NOTE_RETRIEVAL_PHRASES.some((phrase) => lowerText.includes(phrase))) {
      await this.#readBackNotes(text, mySeq);
      return;
    }

    // ── Workspace create (voice, two-step) ───────────────────────────────────
    // Step 1: trigger heard — ask for the name.
    if (
      !this.guestMode &&
      !this.pendingWorkspaceCreate &&
      WORKSPACE_CREATE_PHRASES.some((phrase) => lowerText.includes(phrase))
    ) {
      this.pendingWorkspaceCreate = true;
      const prompt = WORKSPACE_NAME_PROMPT_REPLIES[Math.floor(Math.random() * WORKSPACE_NAME_PROMPT_REPLIES.length)];
      this.#recordTurn(text, prompt);
      this.#render();
      this.#speak(prompt);
      return;
    }
    // Step 2: next utterance is the workspace name.
    if (!this.guestMode && this.pendingWorkspaceCreate) {
      this.pendingWorkspaceCreate = false;
      const name = text.trim();
      if (name) {
        try {
          const id = await this.backendActor.create_workspace(name);
          this.workspaces = await this.backendActor.list_my_workspaces();
          await this.#switchWorkspace(id);
          const ack = `Workspace "${name}" is live, Commander.`;
          this.#recordTurn(text, ack);
          this.#render();
          this.#speak(ack);
        } catch (err) {
          const errMsg = `Couldn't create workspace: ${err.message}`;
          this.#recordTurn(text, errMsg);
          this.#render();
        }
      }
      return;
    }

    // ── Roster add (voice, three-step) ───────────────────────────────────────
    // Step 1: trigger heard — ask for name.
    if (
      !this.guestMode &&
      !this.pendingRosterStep &&
      ROSTER_ADD_PHRASES.some((phrase) => lowerText.includes(phrase))
    ) {
      this.pendingRosterStep = 'name';
      const prompt = ROSTER_NAME_PROMPT_REPLIES[Math.floor(Math.random() * ROSTER_NAME_PROMPT_REPLIES.length)];
      this.#recordTurn(text, prompt);
      this.#render();
      this.#speak(prompt);
      return;
    }
    // Step 2: name captured — ask for trigger phrase.
    if (!this.guestMode && this.pendingRosterStep === 'name') {
      this.pendingRosterName = text.trim();
      this.pendingRosterStep = 'trigger';
      const fn = ROSTER_TRIGGER_PROMPT_REPLIES[Math.floor(Math.random() * ROSTER_TRIGGER_PROMPT_REPLIES.length)];
      const prompt = fn(this.pendingRosterName);
      this.#recordTurn(text, prompt);
      this.#render();
      this.#speak(prompt);
      return;
    }
    // Step 3: trigger phrase captured — save profile.
    if (!this.guestMode && this.pendingRosterStep === 'trigger') {
      const name = this.pendingRosterName;
      const triggerPhrase = text.trim().toLowerCase();
      this.pendingRosterStep = null;
      this.pendingRosterName = null;
      const profile = { name, triggerPhrase, role: '', notes: '' };
      this.rosterProfiles = [...this.rosterProfiles, profile];
      localStorage.setItem('skippy_roster_profiles', JSON.stringify(this.rosterProfiles));
      const ack = `${name} is on the roster. Trigger: "${triggerPhrase}". Add role and notes in the panel if needed.`;
      this.#recordTurn(text, ack);
      this.#render();
      this.#speak(ack);
      return;
    }

    // ── Roster clear (voice, one-step) ───────────────────────────────────────
    // "it's the Commander" / "just me now" — dismisses the active roster profile.
    if (!this.guestMode && this.activeRosterProfile && ROSTER_CLEAR_PHRASES.some((p) => lowerText.includes(p))) {
      const name = this.activeRosterProfile.name;
      this.activeRosterProfile = null;
      localStorage.setItem('skippy_roster_profiles', JSON.stringify(this.rosterProfiles));
      const ack = `Copy — ${name} is off deck. Back to just you, Commander.`;
      this.#recordTurn(text, ack);
      this.#render();
      this.#speak(ack);
      return;
    }

    // ── Workspace open/switch (voice, one-step) ───────────────────────────────
    // "open workspace Alpha" / "switch to project Garage Build" — fuzzy-match
    // the remainder against active workspace names (case-insensitive substring).
    const openMatch = WORKSPACE_OPEN_PHRASES.find((phrase) => lowerText.includes(phrase));
    if (!this.guestMode && openMatch) {
      const remainder = lowerText.slice(lowerText.indexOf(openMatch) + openMatch.length).replace(FILLER_WORDS_PATTERN, '').trim();
      const target = this.workspaces.find(
        (w) => 'Active' in w.status && w.name.toLowerCase().includes(remainder) && remainder.length > 0,
      );
      if (target) {
        await this.#switchWorkspace(target.id);
        const ack = `Switched to "${target.name}".`;
        this.#recordTurn(text, ack);
        this.#render();
        this.#speak(ack);
      } else {
        const names = this.workspaces.filter((w) => 'Active' in w.status).map((w) => w.name).join(', ');
        const notFound = remainder
          ? `Can't find a workspace matching "${remainder}". Active workspaces: ${names || 'none'}.`
          : `Which workspace? Active: ${names || 'none'}.`;
        this.#recordTurn(text, notFound);
        this.#render();
        this.#speak(notFound);
      }
      return;
    }

    if (!this.guestMode && GUEST_MODE_TRIGGER_PHRASES.some((phrase) => lowerText.includes(phrase))) {
      this.#enableGuestMode(text);
      return;
    }

    if (!this.guestMode && SUPER_BRAIN_LOCK_PHRASES.some((phrase) => lowerText.includes(phrase))) {
      this.#setSuperBrainLock(true, text);
      return;
    }
    if (!this.guestMode && SUPER_BRAIN_UNLOCK_PHRASES.some((phrase) => lowerText.includes(phrase))) {
      this.#setSuperBrainLock(false, text);
      return;
    }

    // Pillar 19's Course Correction loop only ever retunes the
    // authenticated owner's own EvolutionProfile (the cached session
    // identity, regardless of who's physically talking) — a guest's
    // complaint permanently softening the Commander's persona for every
    // future session would be an unwanted side effect, so this is gated off
    // during Guest Mode same as every other persistent-state-changing action.
    if (!this.guestMode && COURSE_CORRECTION_PHRASES.some((phrase) => lowerText.includes(phrase))) {
      this.#applyCourseCorrection(text);
      return;
    }

    // Set when the user explicitly declines a pending karaoke offer (see
    // below) — folded into the /respond system prompt as a one-shot framing
    // instruction so Skippy reacts with disappointment about not getting to
    // sing, then still answers whatever the user actually asked, instead of
    // silently dropping the topic.
    let karaokeDeclined = false;

    // Book-canon "Karaoke" moment (Skippy's hobby in the Expeditionary Force
    // novels) — default mode only, same persona-fit reasoning as the
    // Musical Outburst protocol (professional forbids jokes, tactical
    // forbids fluff, neither fits hamming up a song). A two-step offer/
    // confirm dance, same shape as the Steel Rain web-search permission ask:
    // mentioning karaoke gets an excited, deterministic ack (no LLM call —
    // Karaoke trigger detected — arm pendingKaraokeOffer and fire a dedicated
    // /karaoke-offer call (not /respond) so Skippy improvises an excited ask
    // rather than treating "karaoke time" as a directive to perform immediately.
    if (
      this.operationalMode === 'default' &&
      !this.pendingKaraokeOffer &&
      KARAOKE_TRIGGER_PHRASES.some((phrase) => lowerText.includes(phrase))
    ) {
      this.pendingKaraokeOffer = true;
      this.statusMessage = "Skippy is revving up...";
      this.#render();
      let offerReply;
      try {
        const offerRes = await fetch('/skippy-api/karaoke-offer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Skippy-Session': this.sessionToken },
          body: JSON.stringify({ mode, evolutionProfile: this.evolutionProfile }),
          signal: this.currentAbortController.signal,
        });
        const offerData = offerRes.ok ? await offerRes.json() : null;
        offerReply = offerData?.offer || KARAOKE_OFFER_REPLIES[Math.floor(Math.random() * KARAOKE_OFFER_REPLIES.length)];
      } catch {
        offerReply = KARAOKE_OFFER_REPLIES[Math.floor(Math.random() * KARAOKE_OFFER_REPLIES.length)];
      }
      this.statusMessage = '';
      this.#recordTurn(text, offerReply);
      this.#render();
      this.#speak(offerReply);
      return;
    }
    if (this.pendingKaraokeOffer) {
      const hasAffirmation = AFFIRMATION_PHRASES.some((phrase) => lowerText.includes(phrase));
      let remainder = lowerText;
      AFFIRMATION_PHRASES.forEach((phrase) => {
        remainder = remainder.split(phrase).join('');
      });
      // Confirmed live 2026-06-24 (real console-log data, see CLAUDE.md
      // Pillar 18): repeating the trigger phrase itself ("karaoke" again)
      // instead of a clean "yes" was by far the most common real confirm
      // attempt, and previously just reset the offer with no performance —
      // a frustrating loop since the user's *actual* intent was clearly to
      // perform. Treating a repeated trigger-phrase mention as an implicit
      // "yes, do it" is the natural reading, not a second fresh offer.
      // An explicit decline ("no, not karaoke, check the weather") must still
      // win even though it mentions the trigger word — don't let the
      // repeated-trigger shortcut above override a real "no."
      const isDecline = ['no', 'not', "don't", 'cancel', 'stop', 'nevermind', 'never mind'].some(
        (word) => lowerText.includes(word),
      );
      const repeatedTrigger = !isDecline && KARAOKE_TRIGGER_PHRASES.some((phrase) => lowerText.includes(phrase));
      this.pendingKaraokeOffer = false; // any response resolves the offer, yes or no
      if ((hasAffirmation && isTrivialRemainder(remainder)) || repeatedTrigger) {
        await this.#performKaraoke(text);
        return;
      }
      if (isDecline) {
        karaokeDeclined = true;
      }
      // Not an affirmation — offer's cleared, fall through and handle this
      // as a normal message instead.
    }

    // "Tactical Roster" — persona/addressing only. Switching who Skippy is
    // addressing never touches this.guestMode or anything it gates; a
    // matched profile only ever changes prompt framing (see rosterContext
    // in the /respond call below).
    const matchedRoster = this.rosterProfiles.find((p) => lowerText.includes(p.triggerPhrase));
    if (matchedRoster) {
      this.activeRosterProfile = matchedRoster;
      const remainder = lowerText.replace(matchedRoster.triggerPhrase, '');
      if (isTrivialRemainder(remainder)) {
        const ack = `Noted. I'm now speaking with ${matchedRoster.name}.`;
        this.#recordTurn(text, ack);
        this.#render();
        this.#speak(ack);
        return;
      }
      // Has more attached (e.g. "Skippy, it's Lisa, what's our ETA?") —
      // fall through and answer it normally with the new context active.
    }

    const isPublicDemo = CIVILIAN_BRIEFING_PHRASES.some((phrase) => lowerText.includes(phrase));

    const courierContent = !this.guestMode ? extractCourierContent(lowerText, text) : null;
    if (courierContent !== null) {
      await this.#queueCourierMessage(text, courierContent, mySeq);
      return;
    }

    // Pillar 12 — only meaningful while an emergency is actually active.
    // Guest mode cannot stand down an emergency — that action requires the owner.
    if (this.emergencyActive && !this.guestMode) {
      if (STAND_DOWN_PHRASES.some((phrase) => lowerText.includes(phrase))) {
        this.#standDownEmergency(text);
        return;
      }
      if (OPEN_COMMS_PHRASES.some((phrase) => lowerText.includes(phrase))) {
        this.#openComms(text);
        return;
      }
      if (GO_DARK_PHRASES.some((phrase) => lowerText.includes(phrase))) {
        this.#goDark(text);
        return;
      }
    }

    this.statusMessage = 'Skippy is thinking...';

    const { mode, brain, ack } = this.#detectModeAndBrain(text);
    this.operationalMode = mode;

    if (ack) {
      // Bare trigger phrase, nothing else attached — skip OpenRouter
      // entirely rather than have Skippy ramble asking what you want.
      this.lastBrain = '';
      this.lastModel = '';
      this.statusMessage = '';
      this.#recordTurn(text, ack);
      this.#render();
      this.#speak(ack);
      return;
    }

    this.#render();

    // Pillar 6 — RAG retrieval + web search happen here, before the single
    // /respond call, so the LLM always gets its context (or the Dumbass
    // Loop's permission-ask) in one round trip with one visible status, not
    // a second hidden network hop the user can't see.
    let ragContext = [];
    let webContext = null;
    let ragMiss = false;
    let effectiveText = text;

    const isWebOverride = WEB_OVERRIDE_PHRASES.some((phrase) => lowerText.includes(phrase));
    // Require the message to be JUST an affirmation (plus filler words), not
    // merely *contain* one of the words anywhere — confirmed live 2026-06-21:
    // a genuinely new follow-up question ("yes where did you get that
    // information...") got silently swallowed and replaced with the stale
    // pending query just because it happened to contain the word "yes," so
    // the user's actual question was never even seen by the model. Strip
    // every affirmation phrase out of the text and require what's left
    // (after also stripping filler words) to be empty.
    const hasAffirmationPhrase = AFFIRMATION_PHRASES.some((phrase) =>
      lowerText.includes(phrase),
    );
    let affirmationRemainder = lowerText;
    AFFIRMATION_PHRASES.forEach((phrase) => {
      affirmationRemainder = affirmationRemainder.split(phrase).join('');
    });
    const isAffirmation =
      Boolean(this.pendingWebSearchQuery) &&
      hasAffirmationPhrase &&
      isTrivialRemainder(affirmationRemainder);

    if (isAffirmation) {
      // The user is saying "yes" to the *previous* turn's permission ask —
      // search for the original question, not for the bare word "yes".
      effectiveText = this.pendingWebSearchQuery;
      this.pendingWebSearchQuery = null;
      try {
        webContext = await this.#webSearch(effectiveText);
      } catch (err) {
        console.error('[Skippy] web search failed:', err);
      }
    } else if (isWebOverride) {
      // Direct override — skips RAG-miss detection and the permission dance
      // entirely, in any mode.
      this.pendingWebSearchQuery = null;
      try {
        webContext = await this.#webSearch(text);
      } catch (err) {
        console.error('[Skippy] web search failed:', err);
      }
    } else {
      this.pendingWebSearchQuery = null; // any other new utterance clears a stale pending ask
      try {
        const [embedding] = await this.#embed([text]);
        const queryStems = extractKeywordStems(text);
        // Two independent, complementary retrieval paths, run in parallel:
        // semantic similarity (small, bounded payload regardless of corpus
        // size — search_similar_chunks always returns at most TOP_K) and
        // literal keyword/stem matching (done server-side in
        // search_manuals_by_keyword so it scales to real document sizes —
        // see CLAUDE.md's Phase 5.6 entry on why this isn't done by fetching
        // a huge slice and scanning it here instead).
        // Require at least 2 stems before even trying the keyword path —
        // confirmed live 2026-06-21: a single short, common word ("date")
        // extracted from "what's the date" still matched 15 unrelated
        // sections in a real ~500-page manual (it appears constantly as a
        // form-field label), because the backend's all-stems-must-co-occur
        // fix degenerates to a plain single-word substring match when there's
        // only one stem — exactly the false-positive failure mode that fix
        // was meant to close. The keyword path's whole premise (an exact,
        // distinctive multi-word technical term, e.g. "Flintlock Protocol")
        // inherently needs 2+ co-occurring words to mean anything; a lone
        // common word matching somewhere in a large corpus is not signal.
        const [scored, keywordHits] = await Promise.all([
          this.backendActor.search_similar_chunks(embedding, TOP_K),
          queryStems.length > 1
            ? this.backendActor.search_manuals_by_keyword(queryStems)
            : Promise.resolve([]),
        ]);
        // Stringified rather than passed as a live object — DevTools collapses
        // object/array args into clickable "{...}" refs that don't survive a
        // plain-text copy-paste out of the console, which lost the actual score
        // data during this session's testing.
        console.log(
          '[Skippy RAG] semantic matches:',
          JSON.stringify(scored.map((s) => ({ score: s.score, title: s.section.title }))),
        );
        console.log(
          '[Skippy RAG] keyword hits:',
          JSON.stringify(keywordHits.map((s) => s.title)),
        );
        console.log('[Skippy RAG] query stems:', JSON.stringify(queryStems));

        const merged = [];
        const seenIds = new Set();
        for (const s of scored) {
          if (s.score >= SIMILARITY_THRESHOLD && !seenIds.has(s.section.id)) {
            merged.push(s.section);
            seenIds.add(s.section.id);
          }
        }
        for (const section of keywordHits) {
          if (!seenIds.has(section.id) && merged.length < TOP_K) {
            merged.push(section);
            seenIds.add(section.id);
          }
        }
        const goodMatches = merged.slice(0, TOP_K);
        if (goodMatches.length > 0) {
          ragContext = goodMatches.map((section) => ({
            manual_name: section.manual_name,
            title: section.title,
            content: section.content,
          }));
        } else {
          ragMiss = true;
          if (mode === 'tactical' || mode === 'focus') {
            // Steel Rain + Focus: instantly fire web search, zero confirmation,
            // zero permission dance. Focus differs from Steel Rain only in that
            // it never unlocks advanced functions (Emergency Panic etc.) —
            // the response behavior is identical.
            try {
              webContext = await this.#webSearch(text);
            } catch (err) {
              console.error('[Skippy] web search failed:', err);
            }
          }
          // Default/professional: webContext stays null here — the
          // conditional system-prompt block (server.js) makes Skippy mock
          // and ask permission instead of guessing.
        }
      } catch (err) {
        console.error('[Skippy] RAG search failed, treating as a miss:', err);
        ragMiss = true;
        if (mode === 'tactical' || mode === 'focus') {
          try {
            webContext = await this.#webSearch(text);
          } catch (webErr) {
            console.error('[Skippy] web search failed:', webErr);
          }
        }
      }
    }

    try {
      const response = await fetch(`${PROXY_URL}/respond`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Skippy-Session': this.sessionToken,
        },
        body: JSON.stringify({
          text: effectiveText,
          history: this.history.map(({ role, content }) => ({ role, content })),
          mode,
          brain,
          ragContext,
          webContext,
          ragMiss: ragMiss && !webContext,
          karaokeDeclined,
          // Pillar 10 extension (Phase 5.6.1) — pinned per-workspace context,
          // prepended server-side so it doesn't slide out of the rolling
          // history window during a long session.
          scratchpad: this.#activeWorkspace()?.scratchpad?.[0] || '',
          publicDemo: isPublicDemo,
          // "Tactical Roster" (Pillar 16) — addressing/framing only, never a
          // permission signal. Guest Mode's restrictions (already enforced
          // client-side by what UI is hidden, and independent of this field)
          // stay exactly as they were regardless of who's being addressed.
          rosterContext: this.activeRosterProfile
            ? (() => {
                // Always pull the current profile from rosterProfiles so edits
                // made after activation are reflected without re-triggering the phrase.
                const fresh = this.rosterProfiles.find(
                  (p) => p.triggerPhrase === this.activeRosterProfile.triggerPhrase,
                ) ?? this.activeRosterProfile;
                return { name: fresh.name, role: fresh.role, notes: fresh.notes };
              })()
            : null,
          // Pillar 19 — calibrated personality weights, evolved over time by
          // the Critic Loop and Course Correction feedback loop. Always a
          // real object (the canister returns documented defaults, never
          // null), so there's always something genuine to inject.
          evolutionProfile: this.evolutionProfile,
          // On-device speaker recognition (persona/tone signal only — see
          // voiceId.js). `null` whenever nothing's enrolled/running yet, so
          // server.js's instruction block only ever fires once this is
          // actually set up; never affects access, only framing.
          recognizedSpeaker: this.#currentSpeakerTag(),
          // Book-canon trait (Pillar 12/Pillar 18 persona pass): Skippy's
          // sarcasm drops entirely during genuine danger — server.js turns
          // this into an unconditional sincerity override, regardless of
          // mode/brain/evolution weights.
          emergencyActive: this.emergencyActive,
        }),
        signal,
      });
      if (mySeq !== this.requestSeq) return; // superseded by a newer utterance

      // Check ok BEFORE parsing — a non-200 response (proxy crash page, CDN/
      // gateway error, stale service-worker fallback) isn't guaranteed to be
      // JSON, and calling response.json() first would throw a raw parse error
      // here instead of surfacing whatever the real problem was.
      if (!response.ok) {
        let errorText = 'Skippy had nothing to say.';
        try {
          const data = await response.json();
          errorText = data.error || errorText;
        } catch {
          errorText = (await response.text().catch(() => '')) || errorText;
        }
        this.statusMessage = errorText;
        this.#render();
        return;
      }

      const data = await response.json();
      // Clear the stale voice score so the next turn starts fresh — prevents
      // a Commander reading from this turn bleeding into Lisa's next turn.
      this.lastSpeakerScore = null;

      // This reply was Skippy mocking + asking permission (Dumbass Loop),
      // not an actual answer — remember the original question so a "yes"
      // next turn searches for *that*.
      if (ragMiss && !webContext && mode !== 'tactical') {
        this.pendingWebSearchQuery = effectiveText;
      }

      this.lastBrain = data.brain || '';
      this.lastModel = data.model || '';
      this.onPaidTier = !!data.paidTier;
      if (data.brainTiers) this.brainTiers = data.brainTiers;
      if (data.tierIndex !== undefined) this.tierIndex = data.tierIndex;
      this.statusMessage = '';

      // Brain downgrade: only announce once when the family actually transitions
      // from Dolphin → backup. Don't repeat the quip on every subsequent request
      // that happens to still be on the backup brain.
      const newFamily = data.brainDowngrade ? 'other' : 'dolphin';
      if (data.brainDowngrade && this.brainFamily !== 'other') {
        const quip = BRAIN_DOWNGRADE_QUIPS[Math.floor(Math.random() * BRAIN_DOWNGRADE_QUIPS.length)];
        this.#recordTurn('', quip);
        // Economy voice only — this is a system notification, not Skippy's reply.
        // No ElevenLabs characters burned on a housekeeping announcement.
        this.#speakEconomy(quip);
        await new Promise(r => setTimeout(r, 0));
      }
      this.brainFamily = newFamily;

      // Record what was actually said ("yes"), not effectiveText (the
      // substituted original question sent to OpenRouter) — confirmed live
      // 2026-06-21: recording effectiveText here made a real "yes" silently
      // vanish from the visible transcript, replaced by the original
      // question reappearing, which reads exactly like the "yes" was
      // dropped/ignored even though it worked correctly. The reply already
      // answers the real topic regardless of which text it's paired with.
      this.#recordTurn(text, data.reply);
      this.#render();
      this.#speak(data.reply);
    } catch (err) {
      if (err.name === 'AbortError' || mySeq !== this.requestSeq) return;
      this.statusMessage = `Couldn't reach Skippy's brain (proxy unreachable — ${PROXY_URL}): ${err.message}`;
      this.#render();
    }
  };

  // "Skippy, read back my recent notes" — fetches straight from the
  // canister and speaks the result directly, skipping OpenRouter entirely:
  // the content to read is already fully determined by what's stored, so
  // there's nothing for the LLM to add (same reasoning as the bare-trigger
  // acknowledgment patch above).
  #readBackNotes = async (text, mySeq) => {
    this.statusMessage = 'Fetching your notes...';
    this.#render();

    const sections = await this.backendActor.list_sections_by_manual(NOTES_MANUAL);
    if (mySeq !== this.requestSeq) return; // superseded by a newer utterance

    const recent = sections.slice(-RECENT_NOTES_COUNT).reverse();
    const reply =
      recent.length === 0
        ? "You haven't saved any notes yet, Commander. Shocking, I know."
        : `Here ${recent.length === 1 ? 'is' : 'are'} your ${recent.length} most recent note${recent.length === 1 ? '' : 's'}: ` +
          recent.map((s, i) => `Note ${i + 1}: ${s.content}`).join('. ');

    this.statusMessage = '';
    this.#recordTurn(text, reply);
    this.#render();
    this.#speak(reply);
  };

  // Pillar 7 (Courier Queue) — queues a message for "the other" whitelisted
  // Principal and acknowledges locally, same no-LLM-round-trip philosophy as
  // #readBackNotes/bare-trigger acknowledgments above: there's nothing for
  // the model to add to a mechanical "message queued" confirmation.
  #queueCourierMessage = async (originalText, content, mySeq) => {
    if (!content) {
      const reply = "Tell them what, exactly? You have to actually include a message, genius.";
      this.statusMessage = '';
      this.#recordTurn(originalText, reply);
      this.#render();
      this.#speak(reply);
      return;
    }
    this.statusMessage = 'Queuing message...';
    this.#render();
    await this.backendActor.queue_courier_message(content);
    if (mySeq !== this.requestSeq) return; // superseded by a newer utterance

    const reply = "Message queued. I'll pass it along the moment they show their face.";
    this.statusMessage = '';
    this.#recordTurn(originalText, reply);
    this.#render();
    this.#speak(reply);
  };

  // Pillar 7 — called once right after login. Delivers any messages the
  // other whitelisted Principal queued since this Principal's last session,
  // injected as Skippy's first remark, then cleared (pop_pending_courier_
  // messages is atomic on the backend side). No LLM call — this is the
  // sender's literal content, not something to paraphrase or react to.
  #deliverPendingCourierMessages = async () => {
    const pending = await this.backendActor.pop_pending_courier_messages();
    if (pending.length === 0) return;
    const reply = pending
      .map((m) => `Before I forget — someone wanted me to pass this along: "${m.content}"`)
      .join(' ');
    this.#recordTurn('', reply);
  };

  // Pillar 19 — fetched only on demand (not on every login) since it's just
  // a human-readable log, not something any reply logic depends on.
  #refreshEvolutionLog = async () => {
    if (this.evolutionLog.length > 0) {
      this.evolutionLog = [];
      this.#render();
      return;
    }
    try {
      this.evolutionLog = await this.backendActor.list_my_evolution_log(10);
      this.#render();
    } catch (err) {
      console.error('[Skippy] evolution log fetch failed:', err);
    }
  };

  // Pillar 8 — read-only, refreshed once after login and on demand via the
  // dashboard's "Refresh" button. Failures are caught per-source so one
  // down provider doesn't blank out the other two readouts.
  #refreshFuel = async () => {
    try {
      this.cycleBalance = await this.backendActor.get_cycle_balance();
    } catch (err) {
      console.error('[Skippy fuel] cycle balance failed:', err);
    }
    try {
      const response = await fetch(`${PROXY_URL}/api/fuel`, {
        headers: { 'X-Skippy-Session': this.sessionToken },
      });
      this.fuelData = await response.json();
    } catch (err) {
      console.error('[Skippy fuel] /api/fuel failed:', err);
    }
    this.#render();
  };

  // Dedicated silent stop, distinct from barging in with a new utterance:
  // sending a fresh message (even "stop") still gets its own reply, since
  // it's just normal conversation content. This instead only kills whatever
  // request/playback is in flight and says nothing back — no new
  // OpenRouter/ElevenLabs call at all.
  #silence = () => {
    this.#stopSpeaking();
    this.currentAbortController?.abort();
    ++this.requestSeq; // discard any late-arriving response from the aborted request
    this.statusMessage = 'Silenced.';
    this.#render();
  };

  // Deterministic test of the Dual-Voice audio pipeline (Pillar 18) —
  // Pillar 12 (Guardian Emergency Protocol). Placement protection: only
  // rendered while operationalMode === 'tactical' (see #render) — there's no
  // dedicated Steel Rain overlay view yet (Pillar 11 hasn't been built), so
  // this is today's equivalent of "only reachable from inside Steel Rain."
  #openEmergencyConfirm = () => {
    this.emergencyConfirmOpen = true;
    this.#render();
  };

  #closeEmergencyConfirm = () => {
    this.emergencyConfirmOpen = false;
    this.#render();
  };

  // 3rd tap. GPS + dispatch + entering Ghost Mode all happen here, in one
  // deliberate action — no further confirmation steps per the spec.
  #triggerEmergencyDispatch = async () => {
    this.emergencyConfirmOpen = false;
    this.statusMessage = 'Acquiring location...';
    this.#render();

    let lat = null;
    let lon = null;
    try {
      const position = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 }),
      );
      lat = position.coords.latitude;
      lon = position.coords.longitude;
    } catch (err) {
      // GPS failure (denied, unavailable, timeout) — proceed without coordinates.
      // Emergency dispatch still fires and SMS still goes out; the map link is
      // omitted from the message. Not blocking on GPS is the right call here —
      // a denied location permission should never prevent a panic alert from sending.
      console.warn('[Skippy] GPS unavailable, dispatching without location:', err.message);
      this.statusMessage = 'GPS unavailable — dispatching without location...';
      this.#render();
    }

    // Go dark immediately — ghost mode activates on confirm, not on SMS success.
    // Twilio delivery is best-effort; a failed SMS must never block the lockdown.
    this.emergencyActive = true;
    this.ghostMode = true;
    this.commsOpen = false;
    this.statusMessage = '';
    // Force mic on so "open comms" / "stand down" work even if listening wasn't
    // already active when the emergency fired.
    if (this.state === 'idle' && this.recognition) {
      this.state = 'listening';
      this.recognition.start();
    }
    this.#render();
    await this.#startGuardianStream();

    try {
      const response = await fetch(`${PROXY_URL}/emergency-dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Skippy-Session': this.sessionToken },
        body: JSON.stringify({ lat, lon }),
      });
      const data = await response.json();
      if (!response.ok) {
        console.error('[Skippy] Dispatch SMS failed:', data.error || response.status);
        return;
      }
      this.emergencyToken = data.token;
      this.emergencyId = await this.backendActor.start_emergency(data.token);
    } catch (err) {
      console.error('[Skippy] Dispatch request failed:', err.message);
    }
  };

  // Opens the device-role WebSocket to the proxy's live relay and starts
  // streaming mic audio up in periodic chunks. The proxy buffers/relays
  // live (Pillar 1's reasoning — streamed audio doesn't fit the canister's
  // 2MB message cap) and periodically hands back a "finalize" event with
  // everything since the last tick, which gets forwarded to the canister's
  // append-only evidentiary ledger from here (the proxy never calls the
  // canister directly, per Pillar 1's implementation note).
  #startGuardianStream = async () => {
    try {
      this.emergencyStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      this.statusMessage = `Couldn't access the microphone: ${err.message}`;
      this.#render();
      return;
    }

    const ws = new WebSocket(
      proxyWsUrl(`/emergency-ws?token=${this.emergencyToken}&role=device`),
    );
    this.emergencyWs = ws;

    ws.onmessage = async (event) => {
      if (typeof event.data !== 'string') {
        // A relayed push-to-talk burst from a listener — only ever played
        // through the speaker when comms are explicitly open; Ghost Mode's
        // whole premise is zero sound/light otherwise.
        if (this.commsOpen) {
          const audio = new Audio(URL.createObjectURL(event.data));
          audio.play().catch(() => {});
        }
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (parsed.type === 'finalize') {
        const bytes = Uint8Array.from(atob(parsed.data), (c) => c.charCodeAt(0));
        this.backendActor.append_emergency_audio_chunk(this.emergencyId, bytes).catch((err) => {
          console.error('[Skippy emergency] failed to persist audio chunk:', err);
        });
      } else if (parsed.type === 'preset' && this.commsOpen) {
        window.speechSynthesis?.speak(new SpeechSynthesisUtterance(parsed.text));
      }
    };

    ws.onopen = () => {
      const recorder = new MediaRecorder(this.emergencyStream);
      recorder.ondataavailable = async (e) => {
        if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(await e.data.arrayBuffer());
        }
      };
      recorder.start(2000); // 2s chunks, continuously, until #stopGuardianStream
      this.emergencyRecorder = recorder;
    };
  };

  #stopGuardianStream = () => {
    if (this.emergencyRecorder && this.emergencyRecorder.state !== 'inactive') {
      this.emergencyRecorder.stop();
    }
    this.emergencyRecorder = null;
    this.emergencyStream?.getTracks().forEach((t) => t.stop());
    this.emergencyStream = null;
    if (this.emergencyWs && this.emergencyWs.readyState < WebSocket.CLOSING) {
      this.emergencyWs.close();
    }
    this.emergencyWs = null;
  };

  // "Skippy, stand down" — no phrase was specified in the original spec for
  // ending the emergency; this one was chosen to fit the existing tactical
  // theme. Flagged for the user to confirm/rename if they'd prefer another.
  #standDownEmergency = (text) => {
    this.#stopGuardianStream();
    this.emergencyActive = false;
    this.ghostMode = false;
    this.commsOpen = false;
    this.emergencyToken = null;
    this.emergencyId = null;
    const reply = 'Standing down. Emergency dispatch ended.';
    this.statusMessage = '';
    this.#recordTurn(text, reply);
    this.#render();
    this.#speak(reply);
  };

  #openComms = (text) => {
    this.commsOpen = true;
    const reply = 'Comms open.';
    this.#recordTurn(text, reply);
    this.#render();
    this.#speak(reply);
  };

  // Deliberately no #speak() here — speaking "Going dark" out loud right as
  // Ghost Mode's whole point is silence would defeat the purpose. Logged to
  // the transcript only.
  #goDark = (text) => {
    this.commsOpen = false;
    this.#recordTurn(text, 'Going dark.');
    this.#render();
  };

  #detachCurrentAudio = () => {
    // Clear ALL event handlers before resetting — otherwise a stale onended
    // or onplaying from the previous segment can fire after barge-in and flip
    // isSpeaking to false while the new audio is already playing, which
    // makes subsequent barge-ins blind (isSpeaking appears false to the
    // interim-result check even though Skippy is audibly talking).
    this.premiumAudioEl.oncanplaythrough = null;
    this.premiumAudioEl.onplaying = null;
    this.premiumAudioEl.onended = null;
    this.premiumAudioEl.onerror = null;
    // Fully reset the element (not just pause) so mobile browsers can't
    // silently auto-resume a previously-blocked play() later on, which is
    // how Premium audio can resurface and overlap with a fallback utterance.
    this.premiumAudioEl.pause();
    this.premiumAudioEl.removeAttribute('src');
    this.premiumAudioEl.load();
  };

  // Immediately silences whatever Skippy is currently saying (Premium audio
  // or the Economy speechSynthesis fallback) — used both to clear leftover
  // state before a new reply starts speaking, and to let a barged-in
  // utterance cut him off mid-sentence (see #askSkippy).
  #stopSpeaking = () => {
    // Confirmed live 2026-07-08: a Premium segment's 8s loadTimeout is a
    // setTimeout living in that segment's own closure — #detachCurrentAudio
    // clears the audio element's handlers, but does nothing to that pending
    // timer. If a NEW reply's #speak() fires before the old segment ever
    // settled (e.g. the karaoke offer's audio was still buffering when the
    // "yes" confirmation started the actual song), the orphaned timeout can
    // fire minutes later, call fallBackToEconomy for the OLD reply's stale
    // text, and stomp on whatever is currently playing — heard as two
    // voices talking over each other, or Premium audio randomly cutting to
    // Economy mid-performance. Bumping this on every stop invalidates any
    // in-flight segment's callbacks (see #speechGen checks below).
    this.#speechGen++;
    if (this.#economySpeakTimer !== null) {
      clearTimeout(this.#economySpeakTimer);
      this.#economySpeakTimer = null;
    }
    window.speechSynthesis?.cancel();
    this.#detachCurrentAudio();
    this.isSpeaking = false;
    this._restartRecognitionAfterTTS = false;
  };

  #speak = (text) => {
    if (this.voiceMuted) return;
    // Ghost Mode's whole premise is zero sound — Skippy's own replies to
    // unrelated questions asked mid-emergency must stay silent too, not
    // just the dedicated open-comms/go-dark acknowledgments.
    if (this.ghostMode && !this.commsOpen) return;
    this.#stopSpeaking();

    if (this.voiceMode === 'economy') {
      // No real singing synthesis exists client-side — Dual-Voice routing
      // is Premium/ElevenLabs-only. Strip the lyric markers and speak the
      // verse as plain text through the same Economy voice.
      this.#speakEconomy(stripMarkdown(text).replace(/🎶/g, ''));
      return;
    }

    // Split BEFORE stripping markdown — stripMarkdown drops entire *...* spans
    // (stage directions), which would wipe lyric content like "🎶 *verse* 🎶"
    // before splitVoiceSegments ever sees it. For singing segments, unwrap
    // asterisks (keep the lyric text); for conversational, drop them (stage dirs).
    const segments = splitVoiceSegments(text)
      .map((seg) => ({
        ...seg,
        text:
          seg.voice === 'singing'
            ? seg.text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').trim()
            : stripMarkdown(seg.text),
      }))
      .filter((seg) => seg.text.length > 0);

    this.#playPremiumSegments(
      segments.length > 0 ? segments : [{ text: stripMarkdown(text), voice: 'conversational' }],
      0,
    );
  };

  // Dual-Voice routing ("Marco Hietala Protocol") — plays a reply's
  // conversational and 🎶-wrapped singing segments in order, each through its
  // own ElevenLabs voice (the proxy resolves which via /speak?voice=singing).
  // Same sequential-<audio>-per-chunk precedent already used by the Guardian
  // live-ops listener page. A reply with no 🎶 markers is just one segment,
  // so this degenerates to the previous single-call behavior unchanged.
  #playPremiumSegments = (segments, index, onComplete = null) => {
    if (index >= segments.length) return;
    const { text: segText, voice } = segments[index];

    // Captured once per segment-playback attempt — see #speechGen's
    // declaration for why every async callback below re-checks this before
    // acting instead of trusting `settled` alone.
    const myGen = this.#speechGen;
    let hasStartedPlaying = false;
    let settled = false;
    // Reuse the same, already-unlocked element rather than constructing a
    // new Audio() each time — a fresh element has no user-gesture history
    // and mobile browsers will block it regardless of timing.
    const audio = this.premiumAudioEl;
    const voiceParam = voice === 'singing' ? '&voice=singing' : '';
    // gainNode is null if Web Audio isn't supported or the graph was never
    // unlocked yet — falls back to native (un-boosted) volume in that case.
    if (this.gainNode) {
      this.gainNode.gain.value = voice === 'singing' ? SINGING_VOICE_GAIN : 1.0;
    }
    audio.src = `${PROXY_URL}/speak?text=${encodeURIComponent(segText)}&session=${encodeURIComponent(this.sessionToken)}${voiceParam}`;
    audio.load();

    const fallBackToEconomy = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(loadTimeout);
      // A newer #speak() (or a barge-in) has already superseded this
      // segment — its own #stopSpeaking() already silenced everything, so
      // acting on this now-stale attempt would only stomp on audio that's
      // legitimately playing for the CURRENT reply. Bail out silently.
      if (myGen !== this.#speechGen) return;
      console.warn('[Skippy] premium audio unavailable, falling back:', reason);
      // Fully detach (not just stop) so a still-buffering stream can never
      // resume and play on top of the fallback voice we're about to start.
      this.#detachCurrentAudio();
      this.statusMessage = 'Premium voice unavailable — falling back to browser voice.';
      this.#render();
      // Speak this segment AND everything still queued after it in one
      // Economy utterance, rather than dropping the rest of the reply.
      const remainder = segments
        .slice(index)
        .map((s) => s.text)
        .join(' ')
        .replace(/🎶/g, '');
      this.#speakEconomy(remainder);
    };

    audio.onplaying = () => {
      hasStartedPlaying = true;
      settled = true; // prevent load timeout from triggering fallback once audio is actually playing
      clearTimeout(loadTimeout);
      this.isSpeaking = true;
      this.#render();
    };

    audio.onended = () => {
      if (index + 1 < segments.length) {
        this.#playPremiumSegments(segments, index + 1, onComplete);
      } else {
        this.isSpeaking = false;
        this.lastSpeakEndTime = Date.now();
        this.#render();
        // If recognition died while TTS had audio focus, restart it now.
        if (this._restartRecognitionAfterTTS && this.state !== 'idle' && !this.stopRequested && !this.recognitionActive) {
          this._restartRecognitionAfterTTS = false;
          setTimeout(() => this.#startRecognition(), 300);
        }
        // Karaoke-audio chaining (see #performKaraoke) — lets a spoken hype
        // line finish naturally before the real generated song starts,
        // without folding ACE-Step's data: URI playback into this function's
        // TTS-segment logic.
        if (onComplete) onComplete();
      }
    };

    audio.onerror = () => {
      // Once Premium audio is actually playing, a later/transient media error
      // shouldn't trigger the Economy fallback on top of audio that's already
      // audible — only fall back if it never managed to start at all.
      if (hasStartedPlaying) {
        console.warn('[Skippy] premium audio errored after playback started — ignoring fallback');
        this.isSpeaking = false;
        this.lastSpeakEndTime = Date.now();
        this.#render();
        return;
      }
      fallBackToEconomy('media error');
    };

    // Wait until the browser says it has buffered enough to play through
    // without stalling before calling play(). Calling play() immediately
    // (before any data has loaded) can trip mobile autoplay checks
    // prematurely — the promise rejects right away, but the stream keeps
    // buffering in the background and starts playing moments later anyway,
    // stacking on top of whatever fallback voice already started speaking.
    // Using the on* property (not addEventListener) so reusing this same
    // element across calls can't accumulate stale listeners from a
    // previous, abandoned reply.
    audio.oncanplaythrough = () => {
      audio.oncanplaythrough = null;
      clearTimeout(loadTimeout);
      if (settled) return;
      // Android suspends the AudioContext when the SpeechRecognizer grabs
      // audio focus (on restart/dong). Resume it before every play so TTS
      // isn't silenced by a suspended context mid-response.
      const doPlay = () => audio.play().catch((err) => {
        fallBackToEconomy(`autoplay rejected: ${err.name} ${err.message}`);
      });
      if (this.audioContext && this.audioContext.state === 'suspended') {
        this.audioContext.resume().then(doPlay).catch(doPlay);
      } else {
        doPlay();
      }
    };

    // Guard against the stream never buffering enough to fire
    // canplaythrough at all (stalled connection, proxy dying mid-stream).
    const loadTimeout = setTimeout(() => {
      fallBackToEconomy('timed out waiting for audio to buffer');
    }, 8000);
  };

  #speakEconomy = (text) => {
    if (!window.speechSynthesis) return;
    // Make sure no Premium audio is left lingering/about to resume underneath this.
    this.#detachCurrentAudio();
    window.speechSynthesis.cancel();
    // Several browsers don't synchronously flush the SpeechSynthesis queue
    // on cancel() — a speak() called in the very same tick can race with
    // the cancellation and produce dropped or out-of-order utterances.
    // Deferring a tick lets the cancellation fully settle first.
    // #economySpeakTimer lets #stopSpeaking cancel this before it fires,
    // preventing economy from starting on top of a premium reply that begins
    // during the same gap (the overlap-voice bug confirmed 2026-06-26).
    this.#economySpeakTimer = setTimeout(() => {
      this.#economySpeakTimer = null;
      const utterance = new SpeechSynthesisUtterance(stripMarkdown(text));
      utterance.onstart = () => {
        this.isSpeaking = true;
        this.#render();
      };
      utterance.onend = () => {
        this.isSpeaking = false;
        this.lastSpeakEndTime = Date.now();
        this.#render();
        // If recognition died while TTS had audio focus, restart it now.
        // Mirrors the Premium audio path below — without this, Economy-voiced
        // replies (used for Ghost Mode/system notifications) can leave
        // recognition permanently off if it happened to end mid-utterance.
        if (this._restartRecognitionAfterTTS && this.state !== 'idle' && !this.stopRequested && !this.recognitionActive) {
          this._restartRecognitionAfterTTS = false;
          setTimeout(() => this.#startRecognition(), 300);
        }
      };
      window.speechSynthesis.speak(utterance);
    }, 0);
  };

  #toggleVoiceMode = () => {
    this.voiceMode = this.voiceMode === 'premium' ? 'economy' : 'premium';
    this.#render();
  };

  #toggleVoiceMuted = () => {
    this.voiceMuted = !this.voiceMuted;
    if (this.voiceMuted) {
      // Muting should shut him up immediately, not just suppress future replies.
      this.#stopSpeaking();
    }
    this.#render();
  };

  #toggleNoteMode = () => {
    this.manualNoteMode = !this.manualNoteMode;
    this.#render();
  };

  #refreshSections = async () => {
    this.sections = await this.backendActor.list_sections_by_manual(
      this.selectedManual,
    );
    this.manualBrowserOpen = true;
    this.#render();
  };

  #closeManualBrowser = () => {
    this.manualBrowserOpen = false;
    this.#render();
  };

  #handleManualChange = (e) => {
    this.selectedManual = e.target.value;
    this.#render();
  };

  #toggleLexicon = () => {
    this.lexiconOpen = !this.lexiconOpen;
    this.#render();
  };

  #toggleManual = async () => {
    if (!this.manualOpen && !this.manualContent) {
      const res = await fetch('/SKIPPY_USER_MANUAL.md').catch(() => null);
      this.manualContent = res && res.ok ? await res.text() : '(Manual not found)';
    }
    this.manualOpen = !this.manualOpen;
    this.#render();
  };

  #downloadManual = async () => {
    if (!this.manualContent) { alert('Open the manual first.'); return; }
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Skippy User Manual')] }),
          new Paragraph({ children: [new TextRun(`Generated: ${new Date().toLocaleDateString()}`)] }),
          new Paragraph({ children: [] }),
          ...markdownToDocxParagraphs(this.manualContent),
        ],
      }],
    });
    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'Skippy_User_Manual.docx';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Generic by design (matches delete_manual_section on the backend) — works
  // for any manual section, not just notes, so the same button will cover
  // Phase 5.6's Knowledge Manager later.
  #deleteSection = async (id) => {
    if (!window.confirm('Delete this entry permanently? This cannot be undone.')) {
      return;
    }
    await this.backendActor.delete_manual_section(id);
    await this.#refreshSections();
  };

  // Knowledge Manager bulk delete (Pillar 6's RAG manual hygiene patch) —
  // one atomic backend call, distinct from #deleteSection's per-entry delete.
  #deleteManual = async () => {
    if (
      !window.confirm(
        `Permanently delete the entire "${this.selectedManual}" manual and everything in it? This cannot be undone.`,
      )
    ) {
      return;
    }
    await this.backendActor.delete_manual(this.selectedManual);
    this.manualOptions = this.manualOptions.filter((m) => m !== this.selectedManual);
    if (this.manualOptions.length === 0) this.manualOptions = [NOTES_MANUAL];
    this.selectedManual = this.manualOptions[0];
    await this.#refreshSections();
  };

  // Neo Skin upload (Pillar 6) — reads the file client-side, sends the raw
  // text to the proxy's /chunk-and-embed (chunking + the one external
  // OpenRouter embeddings call), then persists the result to the canister
  // itself with its own identity, same stateless-proxy pattern as every
  // other canister write in this file.
  #uploadManualFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const manualName = window.prompt(
      'Manual name for this upload (defaults to the file name — edit if you want something else):',
      file.name,
    );
    if (!manualName || !manualName.trim()) {
      e.target.value = '';
      return;
    }
    const name = manualName.trim();
    const category = (
      window.prompt(
        'Category/type for this manual (e.g. code, manual, reference) — optional, helps filtering later:',
        '',
      ) || ''
    ).trim();
    e.target.value = ''; // always reset so re-selecting the same file fires another change event

    this.statusMessage = `Chunking & embedding "${file.name}"...`;
    this.#render();

    try {
      // multipart/form-data, not JSON — the proxy needs the original file
      // bytes to parse PDF/.docx itself (server.js's extractText), and this
      // also sidesteps express.json()'s small default body-size limit,
      // which a real document upload would otherwise exceed. Deliberately
      // no explicit Content-Type header: fetch sets the multipart boundary
      // itself when given a FormData body, which a manual header would break.
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(`${PROXY_URL}/chunk-and-embed`, {
        method: 'POST',
        headers: { 'X-Skippy-Session': this.sessionToken },
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) {
        this.statusMessage = data.error || 'Failed to chunk/embed the document.';
        this.#render();
        return;
      }

      await this.backendActor.add_manual_chunks(name, category ? [category] : [], data.chunks);
      if (category) this.manualCategories.set(name, category);
      if (!this.manualOptions.includes(name)) {
        this.manualOptions = [...this.manualOptions, name];
      }
      this.selectedManual = name;
      // Deliberately no #refreshSections() here — a successful upload should
      // only ever show a status message, never auto-dump the document's full
      // content onto the screen. Viewing it is the explicit "Open" button's
      // job (select a manual, then open it), not an automatic side effect.
      const successMessage = `Uploaded ${data.chunks.length} chunk(s) into "${name}".`;
      this.statusMessage = successMessage;
      this.#render();
      // Auto-clear after a few seconds rather than leaving an upload
      // confirmation on screen indefinitely — but only if nothing else has
      // since overwritten it (e.g. the user immediately asked Skippy
      // something, which has its own status messages we shouldn't stomp on).
      setTimeout(() => {
        if (this.statusMessage === successMessage) {
          this.statusMessage = '';
          this.#render();
        }
      }, 5000);
    } catch (err) {
      this.statusMessage = `Upload failed: ${err.message}`;
      this.#render();
    }
  };

  // Neo Skin "drop a URL" upload — same pipeline as #uploadManualFile, just
  // sourced from a URL the user found and verified themselves (rather than
  // a local file), via the proxy's /chunk-and-embed-url (which fetches the
  // URL server-side with its own SSRF guardrails — see server.js). Reads
  // the URL straight from the DOM on click rather than as a controlled
  // input, same established pattern as the typed-message box (Phase 5.3) —
  // avoids fighting with this component's own re-renders.
  #uploadManualFromUrl = async () => {
    const input = document.getElementById('manual-url-input');
    const url = input?.value.trim();
    if (!url) return;

    let defaultName;
    try {
      defaultName = new URL(url).hostname;
    } catch {
      this.statusMessage = 'That doesn\'t look like a valid URL.';
      this.#render();
      return;
    }

    const manualName = window.prompt(
      'Manual name for this upload (defaults to the URL\'s hostname — edit if you want something else):',
      defaultName,
    );
    if (!manualName || !manualName.trim()) return;
    const name = manualName.trim();
    const category = (
      window.prompt(
        'Category/type for this manual (e.g. code, manual, reference) — optional, helps filtering later:',
        '',
      ) || ''
    ).trim();

    this.statusMessage = `Fetching, chunking & embedding ${url}...`;
    this.#render();

    try {
      const response = await fetch(`${PROXY_URL}/chunk-and-embed-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Skippy-Session': this.sessionToken },
        body: JSON.stringify({ url }),
      });
      const data = await response.json();
      if (!response.ok) {
        this.statusMessage = data.error || 'Failed to fetch/chunk/embed that URL.';
        this.#render();
        return;
      }

      await this.backendActor.add_manual_chunks(name, category ? [category] : [], data.chunks);
      if (category) this.manualCategories.set(name, category);
      if (!this.manualOptions.includes(name)) {
        this.manualOptions = [...this.manualOptions, name];
      }
      this.selectedManual = name;
      if (input) input.value = '';
      const successMessage = `Uploaded ${data.chunks.length} chunk(s) into "${name}" from ${url}.`;
      this.statusMessage = successMessage;
      this.#render();
      setTimeout(() => {
        if (this.statusMessage === successMessage) {
          this.statusMessage = '';
          this.#render();
        }
      }, 5000);
    } catch (err) {
      this.statusMessage = `Upload failed: ${err.message}`;
      this.#render();
    }
  };

  #statusText() {
    switch (this.state) {
      case 'listening':
        return 'Listening for trigger phrase...';
      case 'dictating':
        return 'Recording note...';
      default:
        return 'Idle';
    }
  }

  #renderAuthGate() {
    let body;
    if (this.authState === 'rejected') {
      body = html`
        <main class="login-screen">
          <h1 class="login-title">Skippy</h1>
          <p class="status">
            Not authorized. Your Principal is not on the whitelist:
          </p>
          <p class="principal">${this.principalText}</p>
          ${this.authError
            ? html`<details class="status"><summary>Error detail</summary><p style="word-break: break-all; font-size:0.8em;">${this.authError}</p></details>`
            : ''}
          <p class="status">
            Add it to <code>COMMANDER_PRINCIPAL</code> or
            <code>PARTNER_PRINCIPAL</code> in <code>.env</code>, then
            <code>npm run deploy:local</code> again.
          </p>
          <button @click=${this.#logout}>Log out</button>
        </main>
      `;
    } else {
      body = html`
        <main class="login-screen">
          <h1 class="login-title">Skippy</h1>
          <button
            class="login-btn"
            @click=${this.#login}
            ?disabled=${this.authState === 'loading'}
          >
            ${this.authState === 'loading'
              ? 'Signing in...'
              : 'Login with Internet Identity'}
          </button>
          ${this.authError ? html`<p class="status">${this.authError}</p>` : ''}
          <img src="/bad-marine-logo.png" alt="Bad Marine LLC" class="login-logo" />
        </main>
      `;
    }
    render(body, document.getElementById('root'));
  }

  #render() {
    if (this.authState !== 'ready') {
      this.#renderAuthGate();
      return;
    }

    const micUnsupported = !SpeechRecognitionImpl;

    const liveBrainState = this.isSpeaking
      ? 'streaming'
      : this.statusMessage.endsWith('...') && this.statusMessage !== "I'm listening..."
        ? 'processing'
        : 'idle';

    let body = html`
      <div class="command-deck">
        ${this.ghostMode
          ? this.commsOpen
            ? html`<div style="position:fixed;inset:0;background:#0a0a0a;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.5em;color:#d1d5db;font-family:inherit;">
                <div style="font-size:1.1em;letter-spacing:0.12em;color:#00e5ff;text-transform:uppercase;">● COMMS OPEN</div>
                <div style="font-size:0.8em;color:#555;letter-spacing:0.06em;line-height:1.8;text-align:center;">
                  "Skippy, go dark" — silence<br/>
                  "Skippy, stand down" — end emergency
                </div>
              </div>`
            : html`<div style="position: fixed; inset: 0; background: black; z-index: 9999;"></div>`
          : ''}

        ${this.lexiconOpen
          ? html`
              <div
                style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;"
                @click=${this.#toggleLexicon}
              >
                <div
                  class="lexicon-modal"
                  style="background: var(--bg-dark-armor); color: var(--text-brushed-aluminum); max-width: 640px; max-height: 80vh; overflow-y: auto; padding: 16px 24px; border-radius: 8px; border: 1px solid var(--border-strong);"
                  @click=${(e) => e.stopPropagation()}
                >
                  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5em;">
                    <h2 style="margin:0;">Skippy Command Lexicon</h2>
                    <button @click=${this.#toggleLexicon}>✕ Close</button>
                  </div>
                  <p class="status">
                    This lexicon details all active voice and text trigger phrases, categorized by
                    functional module.
                  </p>
                  ${[...new Set(COMMAND_LEXICON_ENTRIES.map((e) => e.category))].map(
                    (category) => html`
                      <h3>${category}</h3>
                      ${COMMAND_LEXICON_ENTRIES.filter((e) => e.category === category).map(
                        (entry) => html`
                          <p>
                            <strong>Trigger Phrases:</strong> "${entry.phrases.join('" | "')}"<br />
                            <strong>Action:</strong> ${entry.description}
                          </p>
                        `,
                      )}
                    `,
                  )}
                  <button @click=${this.#toggleLexicon}>✕ Close</button>
                </div>
              </div>
            `
          : ''}

        ${this.manualOpen
          ? html`
              <div
                style="position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000;"
                @click=${this.#toggleManual}
              >
                <div
                  style="background:var(--bg-dark-armor);color:var(--text-brushed-aluminum);max-width:680px;width:95%;max-height:85vh;overflow-y:auto;padding:16px 24px;border-radius:8px;border:1px solid var(--border-strong);"
                  @click=${(e) => e.stopPropagation()}
                >
                  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.8em;position:sticky;top:0;background:var(--bg-dark-armor);padding-bottom:0.5em;border-bottom:1px solid var(--border-subtle);">
                    <h2 style="margin:0;">Skippy User Manual</h2>
                    <div style="display:flex;gap:0.5em;">
                      <button @click=${this.#downloadManual}>↓ Download</button>
                      <button @click=${this.#toggleManual}>✕ Close</button>
                    </div>
                  </div>
                  <pre style="white-space:pre-wrap;font-family:inherit;font-size:0.85em;line-height:1.6;margin:0;">${this.manualContent}</pre>
                  <div style="display:flex;justify-content:flex-end;gap:0.5em;margin-top:1em;padding-top:0.5em;border-top:1px solid var(--border-subtle);">
                    <button @click=${this.#downloadManual}>↓ Download</button>
                    <button @click=${this.#toggleManual}>✕ Close</button>
                  </div>
                </div>
              </div>
            `
          : ''}

        <header class="topbar">
          <h1>
            <button
              class="mobile-only"
              style="background:none;border:none;font-size:1.3em;padding:0.15em 0.35em;cursor:pointer;color:var(--text-brushed-aluminum);"
              @click=${() => { this.showLeftDrawer = !this.showLeftDrawer; this.showRightDrawer = false; this.#render(); if (!this.showLeftDrawer) document.activeElement?.blur(); }}
              title="Workspace &amp; Config"
            >☰</button>
            <span
              class="${this.statusMessage === 'Skippy is thinking...' ? 'skippy-thinking' : ''}"
              style="letter-spacing:0.03em;cursor:pointer;${this.voiceMuted ? 'opacity:0.45;text-decoration:line-through;' : ''}"
              title="${this.voiceMuted ? 'Text-only mode — click to unmute' : 'Click to mute (text only)'}"
              @click=${this.#toggleVoiceMuted}
            >Skippy</span>
            <span class="desktop-only">${this.guestMode
              ? html`<button class="badge active" @click=${this.#unlockGuestMode} title="Click to unlock">🔒 Guest Mode Active</button>`
              : html`<button @click=${() => this.#enableGuestMode()}>Enable Guest Mode</button>`}</span>
            <span class="mobile-only">${this.guestMode
              ? html`<button class="badge active" style="font-size:0.8em;padding:0.2em 0.5em;" @click=${this.#unlockGuestMode}>🔒 Guest</button>`
              : html`<button style="font-size:0.8em;padding:0.2em 0.5em;" @click=${() => this.#enableGuestMode()}>Guest</button>`}</span>
          </h1>
          <span class="topbar-brand mobile-only">
            <img src="/bad-marine-logo.png" alt="Bad Marine LLC" />
          </span>
          <div class="badges">
            <button
              class="badge desktop-only ${this.voiceMode === 'premium' ? 'active' : ''}"
              @click=${this.#toggleVoiceMode}
              ?disabled=${this.voiceMuted}
            >
              Voice: ${this.voiceMode === 'premium' ? 'Premium 🎙' : 'Economy 💬'}
            </button>
            ${this.guestMode
              ? ''
              : html`
                  <button
                    class="badge desktop-only ${this.superBrainLocked ? 'active' : ''}"
                    @click=${() => this.#setSuperBrainLock(!this.superBrainLocked)}
                  >
                    Super Brain: ${this.superBrainLocked ? 'ON' : 'OFF'} 🧠
                  </button>
                `}
            <span
              class="tier-dot"
              title="${this.onPaidTier ? `Fallback active — ${this.lastModel}` : `Primary — ${this.lastModel || 'free tier'}`}"
              style="${(() => {
                const TIER_COLORS = ['','','','#f59e0b','#f97316','#ef4444','#dc2626'];
                const c = TIER_COLORS[this.tierIndex] || '';
                return c
                  ? `background:${c};border-color:${c};box-shadow:0 0 6px ${c}b3;cursor:pointer`
                  : `cursor:${this.brainTiers ? 'pointer' : 'default'}`;
              })()}"
              @click=${() => { if (this.brainTiers) { this.showBrainGrid = true; this.#render(); } }}
            ></span>
            ${this.lastKaraokeAudio
              ? html`
                  <button class="badge" title="Save the last karaoke song as an MP3" @click=${() => this.#downloadKaraokeAudio()}>
                    💾 Save Song
                  </button>
                `
              : ''}
            ${(() => {
              if (this.guestMode || !this.fuelData) return '';
              const CYCLE_WARN = 5e12;
              let reasons = [];
              if (this.cycleBalance != null && Number(this.cycleBalance) < CYCLE_WARN) {
                reasons.push(`⚡ Cycles: ${(Number(this.cycleBalance) / 1e12).toFixed(2)}T remaining (warn < 5T)`);
              }
              const or = this.fuelData.openrouter;
              if (or && !or.error) {
                const remaining = Math.max(0, or.totalCredits - or.totalUsage);
                if (remaining < or.totalCredits * 0.2) {
                  reasons.push(`🤖 OpenRouter: $${remaining.toFixed(2)} left of $${or.totalCredits.toFixed(2)}`);
                }
              }
              const el = this.fuelData.elevenlabs;
              if (el && !el.error && el.characterCount >= el.characterLimit * 0.8) {
                reasons.push(`🔊 ElevenLabs: ${el.characterCount.toLocaleString()} / ${el.characterLimit.toLocaleString()} chars used`);
              }
              const tw = this.fuelData.twilio;
              if (tw && !tw.error && parseFloat(tw.balance) < 5) {
                reasons.push(`📡 Twilio: ${tw.currency} ${tw.balance} remaining`);
              }
              if (!reasons.length) return '';
              return html`
                <span
                  @click=${() => { this.showFuelModal = true; this.#render(); }}
                  style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--guest-amber);border:1px solid #b45309;box-shadow:0 0 7px rgba(217,119,6,0.8);cursor:pointer;align-self:center;flex-shrink:0;"
                ></span>
                ${this.showFuelModal ? html`
                  <div style="position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center;"
                       @click=${() => { this.showFuelModal = false; this.#render(); }}>
                    <div style="background:#1a1a1a;border:1px solid var(--guest-amber);border-radius:8px;padding:1.2em 1.4em;max-width:340px;width:90%;box-shadow:0 0 20px rgba(217,119,6,0.4);"
                         @click=${(e) => e.stopPropagation()}>
                      <div style="font-weight:bold;color:var(--guest-amber);margin-bottom:0.7em;">⚠ Fuel Low Alert</div>
                      ${reasons.map(r => html`<div style="margin-bottom:0.4em;font-size:0.9em;">${r}</div>`)}
                      <button style="margin-top:0.8em;width:100%;" @click=${() => { this.showFuelModal = false; this.#render(); }}>Dismiss</button>
                    </div>
                  </div>
                ` : ''}
              `;
            })()}
            <button
              class="badge mobile-only"
              style="font-size:1.1em;padding:0.2em 0.5em;"
              @click=${() => { this.showRightDrawer = !this.showRightDrawer; this.showLeftDrawer = false; this.#render(); if (!this.showRightDrawer) document.activeElement?.blur(); }}
              title="Brain &amp; Security"
            >⚙</button>
          </div>
        </header>

        <div class="columns">
        <aside class="col-left ${this.showLeftDrawer ? 'mobile-drawer-open' : ''}">
          <div class="mobile-only" style="flex-direction:column;gap:0.5em;margin-bottom:0.6em;padding-bottom:0.6em;border-bottom:1px solid var(--border-subtle);">
            <div style="display:flex;align-items:center;justify-content:space-between;">
              <strong style="letter-spacing:0.05em;">WORKSPACE &amp; CONFIG</strong>
              <button @click=${() => { this.showLeftDrawer = false; this.#render(); document.activeElement?.blur(); }}>✕ Close</button>
            </div>
            ${this.guestMode
              ? html`<button class="badge active" style="width:100%;" @click=${this.#unlockGuestMode}>🔒 Guest Mode Active — tap to unlock</button>`
              : html`<button style="width:100%;" @click=${() => { this.#enableGuestMode(); this.showLeftDrawer = false; }}>Enable Guest Mode</button>`}
          </div>
        <section class="workspace-switcher">
          <select @change=${this.#handleWorkspaceChange} .value=${this.activeWorkspaceId?.toString() ?? ''}>
            ${this.workspaces
              .filter((w) => 'Active' in w.status)
              .map((w) => html`<option value=${w.id.toString()}>${w.name}</option>`)}
          </select>
          <button @click=${this.#createWorkspace}>+ New workspace</button>

          ${this.workspaces.some((w) => 'Archived' in w.status) && !this.guestMode
            ? html`
                <details class="archived-workspaces">
                  <summary>Archived workspaces</summary>
                  <ul>
                    ${this.workspaces
                      .filter((w) => 'Archived' in w.status)
                      .map(
                        (w) => html`
                          <li>
                            ${w.name}
                            <button @click=${() => this.#restoreWorkspace(w.id)}>Restore</button>
                          </li>
                        `,
                      )}
                  </ul>
                </details>
              `
            : ''}

          ${!this.guestMode ? html`
            <details class="workspace-manage">
              <summary>Manage workspace</summary>
              <button @click=${this.#archiveActiveWorkspace}>Archive</button>
              <button @click=${this.#exportWorkspace} ?disabled=${this.history.length === 0}>
                Export (.md)
              </button>
              <button @click=${this.#generateProjectBrief} ?disabled=${this.history.length === 0}>
                Generate Project Brief
              </button>
              <button @click=${this.#deleteActiveWorkspaceForever}>Delete forever</button>
            </details>
          ` : ''}
        </section>

        <div class="col-section-title">Configuration</div>

        ${this.guestMode
          ? ''
          : html`
              <details class="fuel-gauge">
                <summary>Fuel &amp; Quotas</summary>
                <p>
                  ICP Cycles: ${this.cycleBalance != null ? `${(Number(this.cycleBalance) / 1e12).toFixed(2)}T` : '...'}
                  <a href="https://nns.ic0.app/" target="_blank" rel="noopener">Top Up</a>
                </p>
                <p>
                  OpenRouter: ${this.fuelData?.openrouter?.error
                    ? `error: ${this.fuelData.openrouter.error}`
                    : this.fuelData?.openrouter
                      ? `$${Math.max(0, this.fuelData.openrouter.totalCredits - this.fuelData.openrouter.totalUsage).toFixed(2)} remaining`
                      : '...'}
                  <a href="https://openrouter.ai/credits" target="_blank" rel="noopener">Top Up</a>
                </p>
                <p>
                  ElevenLabs: ${this.fuelData?.elevenlabs?.error
                    ? `error: ${this.fuelData.elevenlabs.error}`
                    : this.fuelData?.elevenlabs
                      ? `${this.fuelData.elevenlabs.characterCount}/${this.fuelData.elevenlabs.characterLimit} characters`
                      : '...'}
                  <a href="https://elevenlabs.io/app/subscription" target="_blank" rel="noopener">Top Up</a>
                </p>
                ${this.fuelData?.twilio && !this.fuelData.twilio.error
                  ? html`<p>
                      Twilio: ${this.fuelData.twilio.currency} ${this.fuelData.twilio.balance}
                      <a href="https://console.twilio.com/us1/billing/manage-billing/billing-overview" target="_blank" rel="noopener">Top Up</a>
                    </p>`
                  : ''}
                <button @click=${this.#refreshFuel}>Refresh</button>
              </details>

            `}

        <details class="workspace-security">
          <summary>Workspace security</summary>
          <div style="display:flex;gap:0.5em;margin-top:0.5em;">
            <button style="flex:1;" @click=${this.#toggleLexicon} aria-label="Command Lexicon">Commands</button>
            <button style="flex:1;" @click=${this.#toggleManual} aria-label="User Manual">Manual</button>
          </div>
          ${this.guestMode
            ? html`
                <p class="status">🔒 Guest Mode active — brain/persona locked, destructive and admin actions hidden.</p>
                <button @click=${this.#unlockGuestMode}>Unlock (re-authenticate)</button>
                ${this.guestUnlockError ? html`<p class="status">${this.guestUnlockError}</p>` : ''}
              `
            : html`
                <details class="persona-settings">
                  <summary>Profile (name &amp; voice)</summary>
                  <form @submit=${this.#saveProfile}>
                    <label>
                      Name
                      <input name="profileName" type="text" .value=${this.profileName} placeholder="Commander" />
                    </label>
                    <label>
                      ElevenLabs Voice ID
                      <input name="profileVoiceId" type="text" .value=${this.profileVoiceId} placeholder="(default voice)" />
                    </label>
                    <button type="submit">Save profile</button>
                  </form>
                </details>

                <details class="voice-id-settings">
                  <summary>Voice recognition (on-device, persona-only)</summary>
                  <p class="status">
                    Auto-tags whether the Commander or an unverified guest appears to be
                    speaking, purely for Skippy's tone — Guest Mode's own lock is the only
                    thing that ever controls real access, unaffected by this. Voiceprint is
                    stored only in this browser's IndexedDB; nothing biometric ever reaches
                    the canister.
                  </p>
                  ${this.voiceActionConfirm === 'delete'
                    ? html`
                        <p class="status">Delete your enrolled voiceprint? This cannot be undone.</p>
                        <div style="display:flex;gap:0.5em;">
                          <button @click=${() => { this.voiceActionConfirm = null; this.#deleteEnrolledVoice(); }}>Yes, confirm</button>
                          <button @click=${() => { this.voiceActionConfirm = null; this.#render(); }}>Cancel</button>
                        </div>
                      `
                    : html`
                        <button @click=${() => { this.voiceCalibrationModal = true; this.#render(); }}>
                          ${this.hasEnrolledVoice ? 'Re-enroll my voice' : 'Enroll my voice'}
                        </button>
                        ${this.hasEnrolledVoice
                          ? html`<button @click=${() => { this.voiceActionConfirm = 'delete'; this.#render(); }}>Delete enrolled voice</button>`
                          : ''}
                        ${this.voiceEnrollmentError ? html`<p class="status">${this.voiceEnrollmentError}</p>` : ''}
                        ${this.hasEnrolledVoice && this.lastSpeakerScore
                          ? html`
                              <p class="status">
                                Last detected: ${this.lastSpeakerScore.isCommander ? 'Commander' : 'Unverified guest'}
                                (score ${this.lastSpeakerScore.score.toFixed(2)})
                              </p>
                            `
                          : ''}
                      `}
                </details>

                <details class="evolution-matrix">
                  <summary>Evolution Matrix</summary>
                  ${this.evolutionProfile
                    ? html`
                        <p>Snark level: ${this.evolutionProfile.snark_level.toFixed(2)}</p>
                        <p>Vendor skepticism: ${this.evolutionProfile.vendor_skepticism.toFixed(2)}</p>
                        <p>Technical precision: ${this.evolutionProfile.technical_precision.toFixed(2)}</p>
                        <p>Proactive interruption: ${this.evolutionProfile.proactive_interruption.toFixed(2)}</p>
                      `
                    : html`<p>Loading...</p>`}
                  <p class="status">
                    Grows naturally from archived workspaces (Critic Loop) and direct in-chat
                    reprimands (Course Correction) — no reset button by design. Clamped to 0.2-0.95.
                  </p>
                  <button @click=${this.#refreshEvolutionLog}>
                    ${this.evolutionLog.length > 0 ? 'Hide recent changes' : 'Show recent changes'}
                  </button>
                  ${this.evolutionLog.length > 0
                    ? html`
                        <ul>
                          ${this.evolutionLog
                            .slice()
                            .reverse()
                            .map(
                              (entry) => html`
                                <li>${new Date(Number(entry.timestamp / 1_000_000n)).toLocaleString()}: ${entry.summary}</li>
                              `,
                            )}
                        </ul>
                      `
                    : ''}
                </details>
              `}
        </details>

        <details class="tactical-roster">
          <summary>Tactical Roster</summary>
          <p class="status">
            Addressing/tone only — never changes active permissions. Whatever Guest Mode (above)
            currently restricts stays restricted no matter who's registered here.
          </p>
          ${this.activeRosterProfile
            ? html`
                <p class="status">
                  Currently speaking with: <strong>${this.activeRosterProfile.name}</strong>
                  ${this.activeRosterProfile.role ? ` (${this.activeRosterProfile.role})` : ''}
                  <button @click=${this.#clearActiveRosterProfile}>Clear</button>
                </p>
              `
            : ''}
          ${(() => {
            const editing = this.editingRosterIndex !== null ? this.rosterProfiles[this.editingRosterIndex] : null;
            return html`
              <form @submit=${this.#saveRosterProfile}>
                <label>Name/Callsign
                  <input name="rosterName" type="text" placeholder="Lisa" required .value=${editing?.name ?? ''} />
                </label>
                <label>Voice Trigger Phrase
                  <input name="rosterTrigger" type="text" placeholder="it's lisa" required .value=${editing?.triggerPhrase ?? ''} />
                </label>
                <label>Role/Significance
                  <input name="rosterRole" type="text" placeholder="Insurance adjuster" .value=${editing?.role ?? ''} />
                </label>
                <label>Notes for Skippy
                  <textarea name="rosterNotes" rows="3" placeholder="Likes the color blue, hates stormy weather, prefers direct answers..."
                    style="width:100%;margin-top:0.3em;">${editing?.notes ?? ''}</textarea>
                </label>
                <div style="display:flex;gap:0.5em;margin-top:0.4em;">
                  <button type="submit">${editing ? 'Save changes' : '+ Add profile'}</button>
                  ${editing ? html`<button type="button" @click=${this.#cancelEditRoster}>Cancel</button>` : ''}
                </div>
              </form>
            `;
          })()}
          <ul>
            ${this.rosterProfiles.map(
              (p, i) => html`
                <li style="margin:0.5em 0;">
                  <div><strong>${p.name}</strong> — "${p.triggerPhrase}"${p.role ? ` · ${p.role}` : ''}</div>
                  ${p.notes ? html`<div class="status" style="margin:0.2em 0 0.3em;">${p.notes}</div>` : ''}
                  <div style="display:flex;gap:0.4em;">
                    <button @click=${() => this.#editRosterProfile(i)}>Edit</button>
                    <button @click=${() => this.#deleteRosterProfile(p.triggerPhrase)}>Delete</button>
                  </div>
                </li>
              `,
            )}
          </ul>
        </details>
          <div class="mobile-only" style="margin-top:1em;padding-top:0.8em;border-top:1px solid var(--border-subtle);">
            <button style="width:100%;opacity:0.7;" @click=${this.#logout}>Log Out</button>
          </div>
        </aside>

        <section class="col-center">
        <div class="conversation-transcript" id="transcript-scroll">
          ${this.history.length === 0
            ? html`<p class="status">No messages yet in this workspace.</p>`
            : this.history.map(
                (msg) => html`
                  <div class="transcript-message ${msg.role}">
                    <strong>${msg.role === 'user' ? 'You' : 'Skippy'}:</strong>
                    ${msg.role === 'assistant' ? renderSkippyMessage(msg.content) : html`<span>${msg.content}</span>`}
                  </div>
                `,
              )}
        </div>

        <div class="input-deck">
          ${micUnsupported
            ? html`<p class="status">
                Voice dictation isn't supported in this browser — try Chrome.
              </p>`
            : html`
                <section class="mic-controls desktop-only">
                  <button
                    class="mic-button ${this.state}"
                    @click=${this.state === 'idle' ? this.#startListening : this.#stopListening}
                  >
                    ${this.state === 'idle' ? '🎙️ Start Listening' : 'Stop Listening'}
                  </button>
                  <button
                    @click=${this.#silence}
                    ?disabled=${!this.isSpeaking && this.statusMessage !== 'Skippy is thinking...'}
                  >
                    ✋ Stop
                  </button>
                  <span class="status">${this.#statusText()}</span>
                </section>

                ${this.state === 'dictating'
                  ? html`
                      <section class="dictation">
                        <p class="transcript">
                          ${this.noteBuffer} <em>${this.liveTranscript}</em>
                        </p>
                        <button @click=${this.#saveNote}>Stop &amp; Save</button>
                        <button @click=${this.#cancelDictation}>Cancel</button>
                      </section>
                    `
                  : ''}

                ${this.statusMessage
                  ? html`<p class="status">${this.statusMessage}</p>`
                  : ''}
              `}

          <form class="text-input" @submit=${this.#sendTextMessage}>
            <div style="display:flex;gap:0.5em;">
              <button
                type="button"
                class=${this.manualNoteMode ? 'note-mode-toggle active' : 'note-mode-toggle'}
                style="flex:1;"
                @click=${this.#toggleNoteMode}
              >${this.manualNoteMode ? 'Notes: ON' : 'Notes'}</button>
              <button
                type="button"
                class="${this.voiceMuted ? 'note-mode-toggle active' : 'note-mode-toggle'}"
                style="flex:1;"
                @click=${this.#toggleVoiceMuted}
              >${this.voiceMuted ? '🔇 Muted' : 'Mute'}</button>
            </div>
            <textarea
              name="textInput"
              rows="3"
              placeholder=${this.manualNoteMode
                ? 'Note mode: type and press Enter to save (no chat, no voice)...'
                : 'Type to Skippy (e.g. for meetings)...'}
              @keydown=${this.#handleTextareaKeydown}
            ></textarea>
            <button type="submit">${this.manualNoteMode ? 'Save Note' : 'Send'}</button>
          </form>

          <section class="mic-controls desktop-only">
            <button @click=${this.#toggleVoiceMuted}>
              ${this.voiceMuted ? '🔇 Muted (text only)' : '🔊 Mute'}
            </button>
            <button @click=${this.#clearHistory} ?disabled=${this.history.length === 0 || this.guestMode}>
              Clear history
            </button>
          </section>

          ${this.operationalMode === 'tactical' && !this.emergencyActive && !this.guestMode
            ? html`
                <button
                  style="background: #b91c1c; color: white; font-weight: bold; padding: 12px; width: 100%;"
                  @click=${this.#openEmergencyConfirm}
                >
                  EMERGENCY PANIC
                </button>
              `
            : ''}
          ${this.voiceCalibrationModal
            ? html`
                <div style="position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: flex; align-items: center; justify-content: center; z-index: 2000;">
                  <div style="background: var(--bg-dark-armor, #1a1a2e); color: var(--text-brushed-aluminum, #d1d5db); padding: 28px 32px; border-radius: 6px; max-width: 520px; width: 90%; border: 1px solid var(--border-strong, #374151);">
                    <h2 style="margin:0 0 0.5em;">${this.hasEnrolledVoice ? 'Re-enroll Voice' : 'Enroll Voice'}</h2>
                    <p style="margin:0 0 1em;font-size:0.95em;opacity:0.85;">
                      Read the passage below out loud at your normal pace and tone.
                      ${this.voiceEnrollmentActive
                        ? 'This screen will close automatically once enough data has been collected — keep reading until it does.'
                        : 'Click Start when ready.'}
                    </p>
                    <blockquote style="border-left:3px solid var(--accent-cyan,#00e5ff);margin:0 0 1.2em;padding:0.6em 1em;font-size:1.1em;line-height:1.8;font-style:normal;">
                      The morning light came through the window slowly, casting long shadows across
                      the floor. She poured a cup of coffee and sat down at the kitchen table,
                      thinking about everything that needed to happen before noon. Outside, the wind
                      moved through the trees in long, steady waves. A dog barked somewhere down the
                      road, then went quiet. It was the kind of morning where nothing felt urgent,
                      and that was perfectly fine. The forecast called for rain by evening, but for
                      now the sky was clear and the air had that sharp, clean smell that follows a
                      cold night.
                    </blockquote>
                    ${this.voiceEnrollmentActive
                      ? html`
                          <p style="margin:0 0 0.5em;font-size:0.9em;">
                            ${this.voiceEnrollmentPhase === 'loading-model'
                              ? `Downloading model... ${this.voiceEnrollmentProgress.toFixed(0)}%`
                              : `Enrolling... ${this.voiceEnrollmentProgress.toFixed(0)}% — keep reading`}
                          </p>
                          <div style="height:6px;background:#374151;border-radius:3px;">
                            <div style="height:100%;width:${this.voiceEnrollmentProgress.toFixed(0)}%;background:var(--accent-cyan,#00e5ff);border-radius:3px;transition:width 0.3s;"></div>
                          </div>
                        `
                      : html`
                          <div style="display:flex;gap:0.75em;margin-top:0.5em;">
                            <button @click=${this.#startVoiceEnrollment}>Start</button>
                            <button @click=${() => { this.voiceCalibrationModal = false; this.#render(); }}>Cancel</button>
                          </div>
                          ${this.voiceEnrollmentError ? html`<p class="status" style="margin-top:0.5em;">${this.voiceEnrollmentError}</p>` : ''}
                        `}
                  </div>
                </div>
              `
            : ''}
          ${this.showBrainGrid && this.brainTiers
            ? html`
                <div style="position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:2000;"
                     @click=${(e) => { if (e.target === e.currentTarget) { this.showBrainGrid = false; this.#render(); } }}>
                  <div style="background:var(--bg-dark-armor,#1a1a2e);color:var(--text-brushed-aluminum,#d1d5db);padding:28px 32px;border-radius:6px;max-width:480px;width:90%;border:1px solid var(--border-strong,#374151);">
                    <h2 style="margin:0 0 1em;font-size:1.1em;letter-spacing:0.05em;">AI Brain Cascade</h2>
                    <table style="width:100%;border-collapse:collapse;font-size:0.9em;">
                      <thead>
                        <tr style="border-bottom:1px solid var(--border-strong,#374151);">
                          <th style="text-align:left;padding:4px 8px;opacity:0.6;font-weight:500;">Tier</th>
                          <th style="text-align:left;padding:4px 8px;opacity:0.6;font-weight:500;">AI Brain</th>
                          <th style="text-align:right;padding:4px 8px;opacity:0.6;font-weight:500;">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${this.brainTiers.map((t, i) => html`
                          <tr style="border-bottom:1px solid rgba(55,65,81,0.4);${t.status === 'active' ? 'background:rgba(59,130,246,0.1);' : ''}">
                            <td style="padding:6px 8px;opacity:0.5;">T${i + 1}</td>
                            <td style="padding:6px 8px;${t.status === 'unavailable' ? 'opacity:0.4;text-decoration:line-through;' : ''}">${t.label}</td>
                            <td style="padding:6px 8px;text-align:right;">
                              ${t.status === 'active'
                                ? html`<span style="color:#3b82f6;font-weight:600;">In Use</span>`
                                : t.status === 'unavailable'
                                  ? html`<span style="color:#ef4444;opacity:0.7;">Unavailable</span>`
                                  : html`<span style="opacity:0.35;">Standby</span>`}
                            </td>
                          </tr>
                        `)}
                      </tbody>
                    </table>
                    <div style="margin-top:1.25em;text-align:right;">
                      <button @click=${() => { this.showBrainGrid = false; this.#render(); }}>Close</button>
                    </div>
                  </div>
                </div>
              `
            : ''}
          ${this.emergencyConfirmOpen
            ? html`
                <div style="position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 2000;">
                  <div style="background: white; color: black; padding: 24px; border-radius: 4px; max-width: 320px; text-align: center;">
                    <h2>TRIGGER EMERGENCY DISPATCH?</h2>
                    <p>This sends your live GPS location and a live audio link to your emergency contacts, and starts silent ambient recording.</p>
                    <button
                      style="background: #b91c1c; color: white; font-weight: bold; padding: 12px 24px;"
                      @click=${this.#triggerEmergencyDispatch}
                    >
                      YES, CONFIRM
                    </button>
                    <button @click=${this.#closeEmergencyConfirm}>Cancel</button>
                  </div>
                </div>
              `
            : ''}
          ${this.emergencyActive
            ? html`<p class="status">🚨 Emergency dispatch active. Say "Skippy, stand down" to end it.</p>`
            : ''}
        </div>

        <div class="mobile-dock">
          <button
            class="dock-voice mic-button ${this.state}"
            @click=${this.state === 'idle' ? this.#startListening : this.#stopListening}
          >
            ${this.state === 'idle' ? '🎙️ Listen' : '⏹ Stop'}
          </button>
          <button
            class="dock-stop"
            @click=${this.#silence}
            ?disabled=${!this.isSpeaking && this.statusMessage !== 'Skippy is thinking...'}
            title="Stop speaking / cancel"
          >✋</button>
          <button
            class="dock-sr ${this.operationalMode === 'tactical' ? 'active' : ''}"
            @click=${() => {
              if (this.guestMode) return;
              this.operationalMode = this.operationalMode === 'tactical' ? 'default' : 'tactical';
              this.statusMessage = '';
              this.#render();
            }}
          >⚡ ${this.operationalMode === 'tactical' ? 'Normal' : 'Steel Rain'}</button>
        </div>
        </section>

        <aside class="col-right ${this.showRightDrawer ? 'mobile-drawer-open' : ''}">
          <div class="mobile-only" style="flex-direction:column;gap:0.5em;margin-bottom:0.8em;padding-bottom:0.7em;border-bottom:1px solid var(--border-subtle);">
            <div style="display:flex;align-items:center;justify-content:space-between;">
              <strong style="letter-spacing:0.05em;">BRAIN &amp; SECURITY</strong>
              <button @click=${() => { this.showRightDrawer = false; this.#render(); document.activeElement?.blur(); }}>✕ Close</button>
            </div>
            <div style="display:flex;gap:0.5em;flex-wrap:wrap;">
              <button
                class="badge ${this.voiceMode === 'premium' ? 'active' : ''}"
                style="flex:1;"
                @click=${this.#toggleVoiceMode}
                ?disabled=${this.voiceMuted}
              >Voice: ${this.voiceMode === 'premium' ? 'Premium 🎙' : 'Economy 💬'}</button>
              ${this.guestMode ? '' : html`
                <button
                  class="badge ${this.superBrainLocked ? 'active' : ''}"
                  style="flex:1;"
                  @click=${() => this.#setSuperBrainLock(!this.superBrainLocked)}
                >Super Brain: ${this.superBrainLocked ? 'ON 🧠' : 'OFF 🧠'}</button>
              `}
            </div>
          </div>
        <div class="col-right-feature">
          <span class="logo-badge">
            <img src="/bad-marine-logo.png" alt="Bad Marine LLC" />
            <span class="logo-eye ${liveBrainState} mode-${this.operationalMode}${this.guestMode ? ' guest-drained' : ''}"></span>
            <span class="logo-llc">LLC</span>
          </span>
        </div>
        <details class="notes-popout">
            <summary>Neo Skin</summary>
            <select @change=${this.#handleManualChange} .value=${this.selectedManual}>
              ${this.manualOptions.map(
                (name) => html`<option value=${name}>${name}</option>`,
              )}
            </select>
            <button @click=${this.#refreshSections}>Open</button>
            ${this.manualBrowserOpen
              ? html`<button @click=${this.#closeManualBrowser}>Close</button>`
              : ''}
            <label class="upload-manual">
              Upload (.txt/.md/.pdf/.docx) →
              <input type="file" accept=".txt,.md,.pdf,.docx" @change=${this.#uploadManualFile} />
            </label>
            <div class="upload-url">
              Or drop a URL →
              <input type="url" id="manual-url-input" placeholder="https://..." />
              <button @click=${this.#uploadManualFromUrl}>Upload</button>
            </div>
            <details class="danger-zone">
              <summary>⚠ Delete manual</summary>
              <button @click=${this.#deleteManual}>Delete entire manual</button>
            </details>

            ${this.manualBrowserOpen
              ? html`
                  <ul class="note-list">
                    ${this.sections.map(
                      (section) => html`
                        <li>
                          <strong>${section.title}</strong>
                          <span class="section-id">(${section.section})</span>
                          <button @click=${() => this.#deleteSection(section.id)}>Delete</button>
                          <p>${section.content}</p>
                        </li>
                      `,
                    )}
                  </ul>
                `
              : ''}
        </details>

        <details class="workspace-context">
          <summary>Scratchpad &amp; pinned manuals</summary>
          <form @submit=${this.#saveScratchpad}>
            <label>
              Pinned notes (case numbers, constraints — included on every reply this session)
              <textarea name="scratchpadText" rows="3" .value=${this.#activeWorkspace()?.scratchpad?.[0] ?? ''}></textarea>
            </label>
            <button type="submit">Save scratchpad</button>
          </form>
          <fieldset class="manual-mapping">
            <legend>Manuals pinned to this project (visual reminder only — every manual stays searchable everywhere)</legend>
            ${(() => {
              const pinned = this.#activeWorkspace()?.associated_manuals?.[0] ?? [];
              return pinned.length
                ? html`
                    <p class="pinned-chips">
                      ${pinned.map(
                        (manualName) => html`
                          <span class="chip">
                            ${manualName}
                            <button
                              type="button"
                              aria-label="Unpin ${manualName}"
                              @click=${() => this.#toggleAssociatedManual(manualName, false)}
                            >
                              ×
                            </button>
                          </span>
                        `,
                      )}
                    </p>
                  `
                : html`<p class="status">No manuals pinned yet.</p>`;
            })()}
            <label style="display: block; margin-top: 8px;">
              Category/type
              <select .value=${this.manualCategoryFilter} @change=${this.#handleManualCategoryFilter}>
                <option value="">All categories (global search by name)</option>
                ${[...new Set(this.manualCategories.values())]
                  .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
                  .map((category) => html`<option value=${category}>${category}</option>`)}
              </select>
            </label>
            <input
              type="text"
              style="display: block; margin-top: 8px;"
              placeholder="Filter manuals by name (e.g. rust, sql, mmucc)..."
              .value=${this.manualFilterText}
              @input=${this.#handleManualFilterInput}
            />
            <div style="margin-top: 8px;">
              ${this.manualOptions
                .filter(
                  (manualName) =>
                    !this.manualCategoryFilter ||
                    this.manualCategories.get(manualName) === this.manualCategoryFilter,
                )
                .filter((manualName) =>
                  manualName.toLowerCase().includes(this.manualFilterText.trim().toLowerCase()),
                )
                .map(
                  (manualName) => html`
                  <label style="display: block;">
                    <input
                      type="checkbox"
                      .checked=${(this.#activeWorkspace()?.associated_manuals?.[0] ?? []).includes(manualName)}
                      @change=${(e) => this.#toggleAssociatedManual(manualName, e.target.checked)}
                    />
                    ${manualName}
                    ${this.manualCategories.has(manualName)
                      ? html`<span class="manual-category-tag">[${this.manualCategories.get(manualName)}]</span>`
                      : ''}
                  </label>
                `,
                )}
            </div>
          </fieldset>
        </details>
        </aside>
        </div>

        <footer class="statusbar">
          <span>👤 ${this.profileName || 'Commander'} <button @click=${this.#logout}>Log Out</button></span>
          <span>
            Status: ${this.statusMessage || 'Idle'} | Mode: ${this.operationalMode}${this.lastBrain
              ? ` | Brain: ${this.lastBrain}`
              : ''}
          </span>
          <span>Skippy v5.8</span>
        </footer>
      </div>
    `;
    render(body, document.getElementById('root'));
    this.#scrollTranscriptToBottom();
  }

  // Chat feed is chronological (oldest top, newest bottom), so keep the
  // viewport pinned to the latest message after every render — same as any
  // standard messaging app. requestAnimationFrame lets lit-html finish
  // patching the DOM first so scrollHeight reflects the new content.
  #scrollTranscriptToBottom() {
    requestAnimationFrame(() => {
      const el = document.getElementById('transcript-scroll');
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
}

export default App;
