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

const TRIGGER_PHRASES = [
  'let me make sure i write this down',
  'let me grab my notepad',
];

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
  selectedManual = NOTES_MANUAL;
  sections = [];
  statusMessage = '';
  recognition = null;
  stopRequested = false;
  recognitionActive = false;
  // 'premium' (ElevenLabs via proxy) | 'economy' (browser speechSynthesis)
  voiceMode = 'premium';
  skippyReply = '';
  premiumAudioEl = null;
  audioUnlocked = false;
  awaitingSkippyReply = false;

  authClient = null;
  identity = null;
  // 'loading' | 'logged-out' | 'rejected' | 'ready'
  authState = 'loading';
  authError = '';
  principalText = '';
  sessionToken = null;
  backendActor = null;

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
    this.authState = 'logged-out';
    this.#render();
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

  #saveNote = async () => {
    const content = this.noteBuffer.trim();
    if (!content) {
      this.#cancelDictation();
      return;
    }

    const timestamp = new Date().toISOString();
    const title = content.split(/\s+/).slice(0, 6).join(' ');

    this.noteBuffer = '';
    this.state = 'listening';
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

    await this.#askSkippy(content);
  };

  #askSkippy = async (text) => {
    if (this.awaitingSkippyReply) {
      // A reply is already in flight — letting a second one dispatch
      // concurrently is exactly how replies arrive back out of order and
      // stack/interrupt each other's speech. Drop this one instead.
      console.warn('[Skippy] already waiting on a reply — ignoring overlapping request:', text);
      return;
    }
    this.awaitingSkippyReply = true;
    this.statusMessage = 'Skippy is thinking...';
    this.#render();

    try {
      const response = await fetch(`${PROXY_URL}/respond`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Skippy-Session': this.sessionToken,
        },
        body: JSON.stringify({ text }),
      });
      const data = await response.json();

      if (!response.ok) {
        this.statusMessage = data.error || 'Skippy had nothing to say.';
        this.#render();
        return;
      }

      this.skippyReply = data.reply;
      this.statusMessage = '';
      this.#render();
      this.#speak(data.reply);
    } catch (err) {
      this.statusMessage = `Couldn't reach Skippy's brain (is the proxy running on :8787?): ${err.message}`;
      this.#render();
    } finally {
      this.awaitingSkippyReply = false;
    }
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

  #speak = (text) => {
    const cleanText = stripMarkdown(text);

    // Clear any leftover state from a previous turn before starting a new one.
    window.speechSynthesis?.cancel();
    this.#detachCurrentAudio();

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
    };

    audio.onerror = () => {
      // Once Premium audio is actually playing, a later/transient media error
      // shouldn't trigger the Economy fallback on top of audio that's already
      // audible — only fall back if it never managed to start at all.
      if (hasStartedPlaying) {
        console.warn('[Skippy] premium audio errored after playback started — ignoring fallback');
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
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(stripMarkdown(text)));
    }, 0);
  };

  #toggleVoiceMode = () => {
    this.voiceMode = this.voiceMode === 'premium' ? 'economy' : 'premium';
    this.#render();
  };

  #refreshSections = async () => {
    this.sections = await this.backendActor.list_sections_by_manual(
      this.selectedManual,
    );
    this.#render();
  };

  #handleManualChange = (e) => {
    this.selectedManual = e.target.value;
    this.#render();
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

        <section class="voice-toggle">
          <button @click=${this.#toggleVoiceMode}>
            Voice: ${this.voiceMode === 'premium' ? 'Premium 🎙' : 'Economy 💬'}
          </button>
          <button @click=${this.#logout}>Log out</button>
        </section>

        ${this.skippyReply
          ? html`<p class="skippy-reply">${this.skippyReply}</p>`
          : ''}

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
            ${MANUAL_OPTIONS.map(
              (name) => html`<option value=${name}>${name}</option>`,
            )}
          </select>
          <button @click=${this.#refreshSections}>Refresh</button>

          <ul class="note-list">
            ${this.sections.map(
              (section) => html`
                <li>
                  <strong>${section.title}</strong>
                  <span class="section-id">(${section.section})</span>
                  <p>${section.content}</p>
                </li>
              `,
            )}
          </ul>
        </section>
      </main>
    `;
    render(body, document.getElementById('root'));
  }
}

export default App;
