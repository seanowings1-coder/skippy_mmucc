import { html, render } from 'lit-html';
import { skippy_mmucc_backend } from 'declarations/skippy_mmucc_backend';

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

  constructor() {
    if (SpeechRecognitionImpl) {
      this.#setUpRecognition();
    }
    // One persistent element, reused for every reply — see #unlockAudioPlayback.
    this.premiumAudioEl = new Audio();
    this.#render();
  }

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

    await skippy_mmucc_backend.add_manual_section(
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
        headers: { 'Content-Type': 'application/json' },
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
    audio.src = `${PROXY_URL}/speak?text=${encodeURIComponent(cleanText)}`;
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
    this.sections = await skippy_mmucc_backend.list_sections_by_manual(
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

  #render() {
    const micUnsupported = !SpeechRecognitionImpl;

    let body = html`
      <main>
        <h1>Skippy Voice Notes</h1>

        <section class="voice-toggle">
          <button @click=${this.#toggleVoiceMode}>
            Voice: ${this.voiceMode === 'premium' ? 'Premium 🎙' : 'Economy 💬'}
          </button>
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
