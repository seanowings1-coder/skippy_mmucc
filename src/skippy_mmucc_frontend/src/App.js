import { html, render } from 'lit-html';
import { AuthClient } from '@dfinity/auth-client';
import { HttpAgent, Actor } from '@dfinity/agent';
import { idlFactory } from 'declarations/skippy_mmucc_backend/skippy_mmucc_backend.did.js';
import { canisterId as BACKEND_CANISTER_ID } from 'declarations/skippy_mmucc_backend';

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
// as every other trigger-phrase check in this file. Only consulted when
// pendingWebSearchQuery is actually set (see #askSkippy), so casual use of
// these words outside that context never accidentally triggers anything.
const WEB_SEARCH_AFFIRMATION_PHRASES = ['yes', 'yeah', 'go ahead', 'do it', 'please do', 'search'];

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

// Said with nothing else attached (e.g. just "Skippy, steel rain"), these
// trigger phrases have no actual question/task for the LLM to respond to —
// without this, Skippy would call OpenRouter anyway and ramble asking what
// you want. Skip the network round trip entirely and acknowledge locally.
const MODE_SWITCH_ACKNOWLEDGMENTS = {
  tactical: 'Understood. Standing by.',
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

const NOTES_MANUAL = 'SKIPPY_NOTES';
const MANUAL_OPTIONS = [NOTES_MANUAL, 'MMUCC_V6', 'ANSI_D16'];

const SpeechRecognitionImpl =
  window.SpeechRecognition || window.webkitSpeechRecognition;

// Routed through Vite's dev server (see vite.config.js's "/skippy-api" proxy
// rule) as a same-origin relative path, rather than a cross-origin :8787 URL —
// avoids Mixed Content blocks when the page is loaded over HTTPS (e.g. via a
// localtunnel/ngrok tunnel) but the proxy itself is plain HTTP.
const PROXY_URL = '/skippy-api';

// Shortest valid silent WAV — used purely to "unlock" the persistent audio
// element with a real user gesture (see #unlockAudioPlayback).
const SILENT_AUDIO_DATA_URI =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

function stripMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .trim();
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
  // Pillar 10 — private per-Principal project partitions for history.
  // activeWorkspaceId is a bigint (candid nat64), matching every other
  // server-issued id already flowing through this file unconverted.
  workspaces = [];
  activeWorkspaceId = null;
  selectedManual = NOTES_MANUAL;
  // Mutable copy — Neo Skin uploads (Pillar 6) can introduce manual names
  // beyond the 3 baked-in defaults. Known gap: this resets to the defaults
  // on a fresh page load, since there's no backend "list distinct manual
  // names" query yet — uploaded manuals are still fully there and searchable
  // (search_similar_chunks is global, not filtered by this dropdown), just
  // not relisted here until you re-upload or until that query gets added.
  manualOptions = [...MANUAL_OPTIONS];
  sections = [];
  manualBrowserOpen = false;
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
  // TEMPORARY debug aid for verifying Brain Switching (Phase 5.3) — which
  // brain/model actually answered the last message. Drop once confirmed.
  lastBrain = '';
  lastModel = '';

  constructor() {
    if (SpeechRecognitionImpl) {
      this.#setUpRecognition();
    }
    // One persistent element, reused for every reply — see #unlockAudioPlayback.
    this.premiumAudioEl = new Audio();
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
        await this.#loadWorkspaces();
        const profileOpt = await this.backendActor.get_my_persona_profile();
        const profile = profileOpt[0];
        this.profileName = profile?.name?.[0] || '';
        this.profileVoiceId = profile?.voice_id?.[0] || '';
      } else {
        this.authState = 'rejected';
        this.authError = result.Err;
      }
    } catch (err) {
      // The canister traps (rather than returning Err) for a non-whitelisted
      // caller — see assert_whitelisted() in lib.rs.
      this.authState = 'rejected';
      this.authError = err.message;
    }
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
    this.operationalMode = 'default';
    this.profileName = '';
    this.profileVoiceId = '';
    this.authState = 'logged-out';
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
    await this.backendActor.archive_workspace(this.activeWorkspaceId);
    this.workspaces = await this.backendActor.list_my_workspaces();
    const nextActive = this.workspaces.find((w) => 'Active' in w.status);
    await this.#switchWorkspace(nextActive.id);
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

  #unlockAudioPlayback() {
    // Must run synchronously inside a real user-gesture handler (no awaits
    // before this). Mobile browsers track "may autoplay" per *element
    // instance* once it's successfully played from a genuine tap — playing
    // a silent clip here lets this same element play Premium audio later,
    // even though that later call happens deep inside an async chain with
    // no gesture of its own.
    if (this.audioUnlocked) return;
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
        this.#startRecognition();
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

  #handleFinalChunk = (chunk) => {
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
      brain: this.operationalMode === 'tactical' ? 'tactical' : 'everyday',
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
    const hasAffirmationPhrase = WEB_SEARCH_AFFIRMATION_PHRASES.some((phrase) =>
      lowerText.includes(phrase),
    );
    let affirmationRemainder = lowerText;
    WEB_SEARCH_AFFIRMATION_PHRASES.forEach((phrase) => {
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
          if (mode === 'tactical') {
            // Steel Rain: instantly fire the web search, zero confirmation.
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
        // Treat an infrastructure failure (clock drift, network blip, etc.)
        // the same as a genuine RAG miss rather than silently leaving the
        // model with zero context AND zero instructions — otherwise it has
        // nothing to go on and improvises its own (often wrong) explanation
        // for why it "can't" answer, instead of following the actual
        // mock-and-ask-permission / Steel Rain protocol.
        console.error('[Skippy] RAG search failed, treating as a miss:', err);
        ragMiss = true;
        if (mode === 'tactical') {
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
        }),
        signal,
      });
      const data = await response.json();
      if (mySeq !== this.requestSeq) return; // superseded by a newer utterance

      if (!response.ok) {
        this.statusMessage = data.error || 'Skippy had nothing to say.';
        this.#render();
        return;
      }

      // This reply was Skippy mocking + asking permission (Dumbass Loop),
      // not an actual answer — remember the original question so a "yes"
      // next turn searches for *that*.
      if (ragMiss && !webContext && mode !== 'tactical') {
        this.pendingWebSearchQuery = effectiveText;
      }

      this.lastBrain = data.brain || '';
      this.lastModel = data.model || '';
      this.statusMessage = '';
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
      this.statusMessage = `Couldn't reach Skippy's brain (is the proxy running on :8787?): ${err.message}`;
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

  #detachCurrentAudio = () => {
    // Fully reset the element (not just pause) so mobile browsers can't
    // silently auto-resume a previously-blocked play() later on, which is
    // how Premium audio can resurface and overlap with a fallback utterance.
    this.premiumAudioEl.oncanplaythrough = null;
    this.premiumAudioEl.pause();
    this.premiumAudioEl.removeAttribute('src');
    this.premiumAudioEl.load();
  };

  // Immediately silences whatever Skippy is currently saying (Premium audio
  // or the Economy speechSynthesis fallback) — used both to clear leftover
  // state before a new reply starts speaking, and to let a barged-in
  // utterance cut him off mid-sentence (see #askSkippy).
  #stopSpeaking = () => {
    window.speechSynthesis?.cancel();
    this.#detachCurrentAudio();
    this.isSpeaking = false;
  };

  #speak = (text) => {
    if (this.voiceMuted) return;
    const cleanText = stripMarkdown(text);
    this.#stopSpeaking();

    if (this.voiceMode === 'economy') {
      this.#speakEconomy(cleanText);
      return;
    }

    let hasStartedPlaying = false;
    let settled = false;
    // Reuse the same, already-unlocked element rather than constructing a
    // new Audio() each time — a fresh element has no user-gesture history
    // and mobile browsers will block it regardless of timing.
    const audio = this.premiumAudioEl;
    audio.src = `${PROXY_URL}/speak?text=${encodeURIComponent(cleanText)}&session=${encodeURIComponent(this.sessionToken)}`;
    audio.load();

    const fallBackToEconomy = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(loadTimeout);
      console.warn('[Skippy] premium audio unavailable, falling back:', reason);
      // Fully detach (not just stop) so a still-buffering stream can never
      // resume and play on top of the fallback voice we're about to start.
      this.#detachCurrentAudio();
      this.statusMessage = 'Premium voice unavailable — falling back to browser voice.';
      this.#render();
      this.#speakEconomy(cleanText);
    };

    audio.onplaying = () => {
      hasStartedPlaying = true;
      this.isSpeaking = true;
      this.#render();
    };

    audio.onended = () => {
      this.isSpeaking = false;
      this.#render();
    };

    audio.onerror = () => {
      // Once Premium audio is actually playing, a later/transient media error
      // shouldn't trigger the Economy fallback on top of audio that's already
      // audible — only fall back if it never managed to start at all.
      if (hasStartedPlaying) {
        console.warn('[Skippy] premium audio errored after playback started — ignoring fallback');
        this.isSpeaking = false;
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
      audio.play().catch((err) => {
        fallBackToEconomy(`autoplay rejected: ${err.name} ${err.message}`);
      });
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
    setTimeout(() => {
      const utterance = new SpeechSynthesisUtterance(stripMarkdown(text));
      utterance.onstart = () => {
        this.isSpeaking = true;
        this.#render();
      };
      utterance.onend = () => {
        this.isSpeaking = false;
        this.#render();
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
      'Manual name for this upload (e.g. MMUCC_V6):',
      this.selectedManual,
    );
    e.target.value = ''; // always reset so re-selecting the same file fires another change event
    if (!manualName || !manualName.trim()) return;
    const name = manualName.trim();

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

      await this.backendActor.add_manual_chunks(name, data.chunks);
      if (!this.manualOptions.includes(name)) {
        this.manualOptions = [...this.manualOptions, name];
      }
      this.selectedManual = name;
      // Deliberately no #refreshSections() here — a successful upload should
      // only ever show a status message, never auto-dump the document's full
      // content onto the screen. Viewing it is the explicit "Open" button's
      // job (select a manual, then open it), not an automatic side effect.
      this.statusMessage = `Uploaded ${data.chunks.length} chunk(s) into "${name}".`;
      this.#render();
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
        <main>
          <h1>Skippy Voice Notes</h1>
          <p class="status">
            Not authorized. Your Principal is not on the whitelist:
          </p>
          <p class="principal">${this.principalText}</p>
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
        <main>
          <h1>Skippy Voice Notes</h1>
          <button
            @click=${this.#login}
            ?disabled=${this.authState === 'loading'}
          >
            ${this.authState === 'loading'
              ? 'Signing in...'
              : 'Login with Internet Identity'}
          </button>
          ${this.authError ? html`<p class="status">${this.authError}</p>` : ''}
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

    let body = html`
      <main>
        <h1>Skippy Voice Notes</h1>

        <section class="workspace-switcher">
          <select @change=${this.#handleWorkspaceChange} .value=${this.activeWorkspaceId?.toString() ?? ''}>
            ${this.workspaces
              .filter((w) => 'Active' in w.status)
              .map((w) => html`<option value=${w.id.toString()}>${w.name}</option>`)}
          </select>
          <button @click=${this.#createWorkspace}>+ New workspace</button>
          <button @click=${this.#archiveActiveWorkspace}>Archive</button>
          <button @click=${this.#exportWorkspace} ?disabled=${this.history.length === 0}>
            Export (.md)
          </button>
          <button @click=${this.#deleteActiveWorkspaceForever}>Delete forever</button>

          ${this.workspaces.some((w) => 'Archived' in w.status)
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
        </section>

        <section class="voice-toggle">
          <button
            @click=${this.#silence}
            ?disabled=${!this.isSpeaking && this.statusMessage !== 'Skippy is thinking...'}
          >
            ✋ Stop
          </button>
          <button @click=${this.#toggleVoiceMode} ?disabled=${this.voiceMuted}>
            Voice: ${this.voiceMode === 'premium' ? 'Premium 🎙' : 'Economy 💬'}
          </button>
          <button @click=${this.#toggleVoiceMuted}>
            ${this.voiceMuted ? '🔇 Muted (text only)' : '🔊 Mute'}
          </button>
          <button @click=${this.#clearHistory} ?disabled=${this.history.length === 0}>
            Clear history
          </button>
          <button @click=${this.#logout}>Log out</button>
        </section>

        <form class="text-input" @submit=${this.#sendTextMessage}>
          <button
            type="button"
            class=${this.manualNoteMode ? 'note-mode-toggle active' : 'note-mode-toggle'}
            @click=${this.#toggleNoteMode}
          >
            ${this.manualNoteMode ? '📝 Note Mode: ON' : '📝 Note Mode'}
          </button>
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

        <p class="status">Mode: ${this.operationalMode}</p>
        ${this.lastBrain
          ? html`<p class="status">Last brain: ${this.lastBrain} (${this.lastModel})</p>`
          : ''}

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

        <div class="conversation-transcript">
          ${this.history.length === 0
            ? html`<p class="status">No messages yet in this workspace.</p>`
            : // Newest first — display order only, a reversed copy. The
              // underlying this.history array stays chronological (oldest
              // first), since that's the order OpenRouter and append_turn
              // both expect.
              [...this.history].reverse().map(
                (msg) => html`
                  <p class="transcript-message ${msg.role}">
                    <strong>${msg.role === 'user' ? 'You' : 'Skippy'}:</strong> ${msg.content}
                  </p>
                `,
              )}
        </div>

        ${micUnsupported
          ? html`<p class="status">
              Voice dictation isn't supported in this browser — try Chrome.
            </p>`
          : html`
              <section class="mic-controls">
                <button
                  class="mic-button ${this.state}"
                  @click=${this.state === 'idle' ? this.#startListening : this.#stopListening}
                >
                  ${this.state === 'idle' ? 'Start Listening' : 'Stop Listening'}
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

        <section class="manual-browser">
          <select @change=${this.#handleManualChange} .value=${this.selectedManual}>
            ${this.manualOptions.map(
              (name) => html`<option value=${name}>${name}</option>`,
            )}
          </select>
          <button @click=${this.#refreshSections}>Open</button>
          ${this.manualBrowserOpen
            ? html`<button @click=${this.#closeManualBrowser}>Close</button>`
            : ''}
          <button @click=${this.#deleteManual}>Delete entire manual</button>
          <label class="upload-manual">
            Upload (.txt/.md/.pdf/.docx) →
            <input type="file" accept=".txt,.md,.pdf,.docx" @change=${this.#uploadManualFile} />
          </label>

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
        </section>
      </main>
    `;
    render(body, document.getElementById('root'));
  }
}

export default App;
