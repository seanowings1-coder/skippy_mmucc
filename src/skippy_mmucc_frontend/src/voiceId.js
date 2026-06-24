// On-device speaker recognition — second pivot (2026-06-23), this time to
// reduce single-maintainer supply-chain risk rather than to work around a
// vendor gate. The first open-source attempt
// (@jaehyun-ko/speaker-verification) was rejected for being a small,
// independently-maintained wrapper the agent picked via web search rather
// than something the user could vet. Replaced with **Hugging Face's own
// officially-maintained `@huggingface/transformers`**, running
// **Microsoft's WavLM speaker-verification model** (ONNX, ported for
// browser use by the transformers.js team) — bigger-name org on both the
// runtime library and the model weights. Trade-off, accepted by the user:
// a much larger one-time download (~100MB quantized vs. ~7.5MB for the
// package this replaced).
//
// Still a persona/tone signal only — unchanged across every engine swap so
// far, and for the same reason every time: a voice match (even a real
// biometric one) has zero cryptographic backing and can be spoofed by a
// recording/replay, so it can never gate real capability. Guest Mode's
// WebAuthn-gated unlock remains the sole real permission boundary in this
// app, completely unaffected by whatever this module reports. All
// inference runs on-device via WASM; no raw audio or embedding ever leaves
// the browser or touches the canister/proxy.
//
// Honest network-dependency caveat, same shape as the previous pivot: the
// ~100MB quantized ONNX model is fetched once from Hugging Face's public
// CDN on first use (no login, no key, no approval queue — a normal public
// file download) and relies on the browser's ordinary HTTP cache
// afterward. That's a real difference from "never touches the network,
// ever," even though it fully satisfies "no API keys or vendor
// gatekeeping."
import { AutoProcessor, AutoModel, load_audio, cos_sim } from '@huggingface/transformers';

const MODEL_ID = 'Xenova/wavlm-base-sv';
const SAMPLE_RATE = 16000;

// Cosine similarity. Set from real live measurements 2026-06-23, not the
// model card's clean-WAV reference numbers (~0.93-0.96 same-speaker, ~0.71
// different-speaker) — real browser-mic conditions in this app turned out
// to depend heavily on mic positioning:
//   - Same speaker, mic close/well-positioned: 0.82, 0.87, 0.96
//   - Same speaker, mic further away (webcam in its normal resting spot):
//     0.57, 0.64
//   - Different speaker (a YouTube video played through speakers, picked
//     up by the mic): ~0.6-0.65
// 0.75 sits with margin above the observed different-speaker ceiling and
// below the good-mic-position same-speaker floor. Important known
// limitation, not fully fixable by threshold tuning alone: mic distance
// swings the Commander's own score nearly as much as actual speaker
// identity does (0.57 vs 0.96) — a poorly-positioned mic can still
// genuinely cause the Commander to read as "Unverified Guest." This is a
// tone signal, not a security gate, so that failure mode just costs a
// slightly more formal reply, never an access change. Re-tune further with
// a real second person's live voice (not played through speakers) if
// possible — the YouTube-through-speakers test is itself a degraded proxy
// for a real second speaker, not a clean reference.
export const SPEAKER_MATCH_THRESHOLD = 0.75;

// Three short clips averaged together for a more robust enrollment than a
// single utterance, while still giving the UI's percentage progress
// display something meaningful to show (33/67/100%).
const ENROLLMENT_CLIPS = 3;
const ENROLLMENT_CLIP_MS = 3000;
const ENROLLMENT_CLIP_GAP_MS = 500;
// This model compares discrete recorded clips, not a live per-frame
// stream, so background recognition is a periodic re-check rather than
// truly continuous — consistent with the existing "most recent score, not
// synced exactly to the utterance" caveat already documented at the
// App.js call site.
const RECOGNITION_CLIP_MS = 2500;
const RECOGNITION_INTERVAL_MS = 4000;

// Browsers apply automatic gain control, noise suppression, and echo
// cancellation to mic audio by default. All three are well-known to
// degrade speaker-verification accuracy specifically, since they normalize
// away exactly the dynamic-range/spectral characteristics that distinguish
// one voice from another — disabled on general principle as a real
// improvement, independent of any specific test result. (An earlier
// comment here cited a same-speaker-vs-different-speaker score comparison
// as live evidence this was needed; that comparison turned out to actually
// be the same person both times — see [[project-skippy-mmucc-phase-5-8-5-speaker-recognition]]
// — so treat this fix as justified by the general literature, not yet by
// a confirmed live measurement in this app.) Disabled here only — the Web
// Speech API dictation/voice-command pipeline elsewhere in this app wants
// the opposite (cleaner audio for transcription accuracy), so this is
// scoped to this module's own getUserMedia calls, not a global change.
const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
};

const DB_NAME = 'skippy_voiceprints';
const DB_VERSION = 1;
const STORE_NAME = 'profiles';
// Exactly one enrolled voice per browser profile (the device owner) —
// guests are never enrolled, only ever recognized as "not a match."
const COMMANDER_KEY = 'commander';

let modelPromise = null;
// `onDownloadProgress` only ever matters for whichever call actually
// triggers the real download (the first one, ever, per page load) — once
// `modelPromise` resolves, every later caller's callback is simply never
// invoked, since there's nothing left to download. Confirmed necessary
// live 2026-06-23: with no progress feedback at all, the ~100MB model
// download (measured ~650KB/s on this network, so 2-3 real minutes) looked
// indistinguishable from a hang — enrollment sat at "0%" the whole time
// because the only progress callback that existed was per-clip, and the
// very first clip's embedding call is the one blocked on this download.
function getModel(onDownloadProgress) {
  if (!modelPromise) {
    const progress_callback = (info) => {
      if (info.status === 'progress') onDownloadProgress?.(Math.round(info.progress));
    };
    modelPromise = (async () => {
      const processor = await AutoProcessor.from_pretrained(MODEL_ID, { progress_callback });
      // Explicit dtype rather than relying on transformers.js's own
      // default (which is version-dependent) — 'q8' is the ~100MB
      // 8-bit-quantized weight file, not the 400MB+ full-precision one.
      const model = await AutoModel.from_pretrained(MODEL_ID, { dtype: 'q8', progress_callback });
      return { processor, model };
    })();
  }
  return modelPromise;
}

async function getEmbedding(blob, onDownloadProgress) {
  const { processor, model } = await getModel(onDownloadProgress);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const audio = await load_audio(objectUrl, SAMPLE_RATE);
    const inputs = await processor(audio);
    const { embeddings } = await model(inputs);
    return Float32Array.from(embeddings.data);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// Always true — no API key/account/approval gate exists for this engine.
// Kept as a named export so App.js needs no changes across engine swaps.
export function voiceIdAvailable() {
  return true;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadStoredVoiceprint() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(COMMANDER_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function saveVoiceprint(embedding) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(embedding, COMMANDER_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteVoiceprint() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(COMMANDER_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Records exactly one short clip from an already-open MediaStream and
// resolves with the resulting webm Blob. Explicit bitrate, not the
// MediaRecorder default — confirmed live 2026-06-23: the default low-bitrate
// Opus encode visibly degraded same-speaker scores (a real enrolled voice
// scored 0.64 against itself, far below this model's own ~0.93+ same-speaker
// reference numbers from clean WAV test clips).
function recordClip(stream, durationMs) {
  return new Promise((resolve, reject) => {
    const recorder = new MediaRecorder(stream, { audioBitsPerSecond: 128000 });
    const chunks = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm' }));
    recorder.onerror = (e) => reject(e.error || new Error('MediaRecorder error'));
    recorder.start();
    setTimeout(() => recorder.stop(), durationMs);
  });
}

function averageEmbeddings(embeddings) {
  const length = embeddings[0].length;
  const avg = new Float32Array(length);
  for (const emb of embeddings) {
    for (let i = 0; i < length; i++) avg[i] += emb[i];
  }
  for (let i = 0; i < length; i++) avg[i] /= embeddings.length;
  return avg;
}

/**
 * Records ENROLLMENT_CLIPS short clips, averages their embeddings, and
 * persists the result to IndexedDB. Calls
 * `onProgress({ phase: 'loading-model' | 'recording', percent })` — the
 * 'loading-model' phase only ever fires on a fresh page load (the one-time
 * ~100MB download), 'recording' tracks per-clip enrollment progress as
 * before. Throws on mic-permission denial or any inference failure — the
 * caller owns UI/error display.
 */
export async function enrollVoice(onProgress) {
  const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  try {
    const embeddings = [];
    for (let i = 0; i < ENROLLMENT_CLIPS; i++) {
      const blob = await recordClip(stream, ENROLLMENT_CLIP_MS);
      const embedding = await getEmbedding(blob, (percent) => {
        onProgress?.({ phase: 'loading-model', percent });
      });
      embeddings.push(embedding);
      onProgress?.({ phase: 'recording', percent: Math.round(((i + 1) / ENROLLMENT_CLIPS) * 100) });
      if (i < ENROLLMENT_CLIPS - 1) await sleep(ENROLLMENT_CLIP_GAP_MS);
    }
    const finalEmbedding = averageEmbeddings(embeddings);
    await saveVoiceprint(finalEmbedding);
    return finalEmbedding;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/**
 * Starts a polling recognition loop: records a short clip every
 * RECOGNITION_INTERVAL_MS, compares it to the stored voiceprint, and calls
 * onResult({ isCommander, score }). Returns an async stop() function; safe
 * to call if nothing is actually enrolled yet (resolves to a no-op stop).
 */
export async function startRecognition(onResult) {
  const storedEmbedding = await loadStoredVoiceprint();
  if (!storedEmbedding) return async () => {};

  const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  let running = true;

  (async () => {
    while (running) {
      try {
        const blob = await recordClip(stream, RECOGNITION_CLIP_MS);
        if (!running) break;
        const embedding = await getEmbedding(blob);
        const score = cos_sim(storedEmbedding, embedding);
        onResult({ isCommander: score >= SPEAKER_MATCH_THRESHOLD, score });
      } catch (err) {
        console.warn('[Skippy] speaker recognition clip failed:', err);
      }
      if (running) await sleep(RECOGNITION_INTERVAL_MS);
    }
  })();

  return async () => {
    running = false;
    stream.getTracks().forEach((t) => t.stop());
  };
}
