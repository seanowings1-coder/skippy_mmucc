# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

This is a **monorepo** — but Railway deploys the proxy from a **separate** GitHub repo:

| Repo | GitHub | Purpose |
|---|---|---|
| `skippy_mmucc` | `seanowings1-coder/skippy_mmucc` | ICP canisters (backend + frontend), local dev |
| `Skippy-proxy` | `seanowings1-coder/Skippy-proxy` | Node.js proxy — Railway autodeploys from this repo |

**Pushing `skippy_mmucc` does NOT update Railway.** Proxy changes (`src/skippy_mmucc_proxy/server.js`) must also be committed and pushed to the `Skippy-proxy` repo for Railway to pick them up.

## Commands

```bash
# ─── Local deployment (always use this script, not bare dfx deploy) ──────────
bash scripts/deploy-local.sh          # deploys internet_identity, backend, frontend
                                      # reads COMMANDER_PRINCIPAL + PARTNER_PRINCIPAL from .env

# ─── ICP replica ─────────────────────────────────────────────────────────────
dfx start --background                # start the local replica
dfx stop                              # stop it

# ─── Frontend ─────────────────────────────────────────────────────────────────
npm start                             # Vite dev server at http://localhost:3000
npm run build                         # production build (calls dfx generate first)
npm run generate                      # regenerate TS bindings from backend Candid

# ─── Proxy ────────────────────────────────────────────────────────────────────
cd src/skippy_mmucc_proxy && node --watch server.js   # dev proxy (auto-restarts)

# ─── Backend canister (Rust) ──────────────────────────────────────────────────
cargo build --target wasm32-unknown-unknown --release -p skippy_mmucc_backend
cargo test -p skippy_mmucc_backend
```

**Never use bare `dfx deploy`** — it skips the `--argument` needed for the whitelist principals and `--upgrade-unchanged` needed when only `.env` values change (see `scripts/deploy-local.sh`).

The app runs at `http://localhost:4943?canisterId={asset_canister_id}` after deploy; Vite dev at `http://localhost:3000` proxies API calls to the replica.

## Architecture

Four distinct layers, none of which can act as another:

```
[Browser: App.js]
    │  Internet Identity (WebAuthn)       ← authentication
    │  canister calls (login, history, workspaces, RAG, etc.)
    ▼
[ICP Backend Canister: lib.rs]           ← durable source of truth
    │  validate_session (query)
    ▼
[Node Proxy: server.js]                  ← OpenRouter, ElevenLabs, embeddings
    │  /respond, /speak, /embed, /web-search, etc.
    ▼
[External APIs: OpenRouter, ElevenLabs, Brave/Serper]
```

The proxy cannot act as a specific end user — it has no II delegation and calls the canister as itself. The **frontend** calls `append_turn`, `create_workspace`, etc. directly with the user's own authenticated identity.

## Backend Canister (`src/skippy_mmucc_backend/`)

### Access control
Every method calls `assert_whitelisted()` first — only `COMMANDER_PRINCIPAL` and `PARTNER_PRINCIPAL` can call anything. Set at `#[init]` and re-applied by `#[post_upgrade]` (why `--upgrade-unchanged` is required in the deploy script).

### Auth / session flow
1. Frontend completes II sign-in, calls `login()` → gets a short-lived hex token (30-min TTL).
2. Frontend stores token, sends it as `X-Skippy-Session` on every proxy request.
3. Proxy calls `validate_session(token)` → `Option<SessionInfo>` — returns principal, name, voice_id in one query, no second round-trip needed.
4. Sessions live in a `HashMap` in heap memory (intentionally, not stable) — upgrading the canister invalidates all sessions; users re-login. This is the spec, not a gap.

### Stable memory layout (12 `MemoryId` slots — never renumber or reuse)
| MemoryId | Store | Key type |
|---|---|---|
| 0 | `MANUAL_SECTIONS` | `u64` → `DocumentSection` |
| 1 | `NEXT_ID` | `StableCell<u64>` (global counter) |
| 2 | `COMMANDER_PRINCIPAL` | `StableCell<Principal>` |
| 3 | `PARTNER_PRINCIPAL` | `StableCell<Principal>` |
| 4 | `HISTORY` | `HistoryKey{principal, workspace_id}` → `ConversationHistory` |
| 5 | `PERSONA_PROFILES` | `Principal` → `PersonaProfile` |
| 6 | `WORKSPACES` | `u64` → `Workspace` |
| 7 | `COURIER_QUEUE` | `u64` → `CourierMessage` |
| 8 | `EMERGENCY_EVENTS` | `u64` → `EmergencyEvent` |
| 9 | `EMERGENCY_AUDIO` | `u64` → `EmergencyAudioChunk` |
| 10 | `EVOLUTION_PROFILES` | `Principal` → `EvolutionProfile` |
| 11 | `EVOLUTION_LOG` | `u64` → `EvolutionLogEntry` |

`NEXT_ID` is a **global** counter shared by all entity types (sections, workspaces, courier messages, emergency events, evolution log entries, etc.). Never introduce a separate counter.

### Critical Candid schema invariant
Any new field added to a stored struct (`Workspace`, `DocumentSection`, etc.) **must** be `Option<T>`, never a bare `String` or `Vec<T>`. A non-optional field absent from already-stored bytes causes a hard Candid subtyping trap on decode. `None` means "empty/not set."

### Key design decisions baked into the canister
- **RAG is global, not siloed**: `search_similar_chunks` and `search_manuals_by_keyword` scan the full `MANUAL_SECTIONS` store regardless of `manual_name`. `Workspace.associated_manuals` is a visual/organizational pin only.
- **History is a rolling window**: `append_turn` trims from the front if the history exceeds 40 messages, at write time.
- **Emergency audio is append-only**: `EMERGENCY_AUDIO` has no delete method — it's potential evidence.
- **Evolution has no factory reset**: `record_evolution_event` applies signed deltas, clamped to [0.2, 0.95]. The Course Correction feedback loop (in-chat reprimand) and the Critic Loop (archive-time proxy self-critique) are the only correction paths.
- **Keyword search uses AND logic**: `search_manuals_by_keyword` requires all stems to co-occur in a section, not just one. OR matching produced false "hits" that wrongly suppressed web-search prompts.

## Proxy Server (`src/skippy_mmucc_proxy/server.js`)

Express.js server. All routes require the `requireSession` middleware (validates `X-Skippy-Session` via `validate_session` on the canister).

### Routes
| Route | Purpose |
|---|---|
| `POST /respond` | Main LLM response — 4-tier everyday brain cascade + tactical/heavy-hitter fallback |
| `POST /project-brief` | Generates a project brief from workspace history |
| `POST /critic-loop` | Archive-time Critic Loop (self-critique → Evolution Matrix deltas) |
| `POST /karaoke-offer` | In-character excited ask before performing (one-step before `/karaoke`) |
| `POST /karaoke` | Full karaoke performance (original lyrics only, no max_tokens cap) |
| `GET /speak` | ElevenLabs TTS synthesis |
| `POST /embed` | Single text embedding (for RAG query vectors) |
| `POST /chunk-and-embed` | File upload (PDF/Word via mammoth/pdf-parse) → chunk → embed → canister |
| `POST /chunk-and-embed-url` | URL fetch → chunk → embed → canister |
| `POST /web-search` | Live web search |
| `GET /api/fuel` | Cycle balance + OpenRouter credit status |
| `POST /emergency-dispatch` | Triggers Guardian Emergency Protocol, mints secure token |
| `GET /live-ops/:token` | SSE stream for emergency contacts (no auth — token is the credential) |

### Everyday brain 4-tier cascade
When the everyday brain fails (404 = model offline, 429 = rate-limited), the proxy automatically escalates:
1. Free primary (`OPENROUTER_MODEL` env var, default: `openai/gpt-4o-mini`)
2. Paid primary (same model with `:free` stripped)
3. Free fallback (`OPENROUTER_MODEL_FALLBACK`, default: `sao10k/l3-lunaris-8b`)
4. Paid fallback (same fallback with `:free` stripped)

Tiers 2 & 4 set `paidTier: true` in the response so the frontend lights the amber tier-dot. Switching from the primary model family to the fallback family sets `brainDowngrade: true` so App.js plays the in-character quip **once** on transition (not on every subsequent request that's still on the fallback).

Tactical and heavy-hitter brains follow a simpler 2-tier fallback (primary → free fallback → paid fallback).

### Operational modes and system prompts
- `default` — full Skippy persona, 3-sentence hard limit, structured XML system prompt
- `professional` — sarcasm suppressed, direct/respectful tone
- `tactical` — zero fluff, direct answer, instant web search on RAG miss (no permission ask)
- `focus` — identical behavior to tactical, but no advanced function unlocks (Emergency Panic button stays locked)

`EVERYDAY_UNLOCK_PREFIX` is prepended to prompts for fine-tuned models that need jailbreak framing; it is NOT prepended for Claude-based brains (Sonnet/Haiku handle persona without it).

## Frontend (`src/skippy_mmucc_frontend/src/App.js`)

Single-class `App` with Web Speech API-driven voice input. ~3700 lines. Key subsystems:

### Voice pipeline
- `SpeechRecognition` runs continuously. Interim results handle barge-in (cancels current TTS); final results route through `#handleFinalChunk`.
- **TTS cooldown** (1200ms, `App.#SPEAK_COOLDOWN_MS`): final results arriving within 1200ms of TTS end are discarded — they're Skippy's own audio finalized by the recognition engine. Skipped when `pendingKaraokeOffer` or `pendingWebSearchQuery` is armed (user's "yes" is intentional, not loopback).
- Premium TTS uses ElevenLabs via `/speak`; economy TTS falls back to `window.speechSynthesis` (used for system notifications like brain-downgrade quips to avoid burning ElevenLabs characters).

### Pending states (two-step flows)
- `pendingWebSearchQuery` — armed when the proxy asks permission to search; next utterance is the answer.
- `pendingKaraokeOffer` — armed when karaoke trigger heard; next utterance confirms or declines.
- `pendingWorkspaceCreate` — armed by voice create trigger; next utterance is the workspace name.

### Operational mode switching
Mode phrase detection happens in `#classifyIntent` before any LLM call. Mode phrases bypass the LLM entirely and produce a local deterministic ack. Focus mode routes to the `tactical` brain but never unlocks advanced functions.

### Guest mode
Enabled by `#enableGuestMode`. Locks out all canister mutations. Persona shifts to "primitive lifeform" tone. Unlock requires a fresh II WebAuthn ceremony (`verify_unlock()` on the canister gates this — any II anchor succeeds the ceremony, but `verify_unlock` additionally checks it's one of the two whitelisted principals).

### Evolution Matrix display
Read from `get_my_evolution_profile()` on load; updated on Course Correction phrases (local delta → `record_evolution_event` on canister) and at archive time via the Critic Loop. Displayed in a collapsible panel under the security section (auth-gated, not shown in guest mode).

## Required `.env` variables

```
COMMANDER_PRINCIPAL=<II principal>
PARTNER_PRINCIPAL=<II principal>
OPENROUTER_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=           # default R.C. Bray clone voice
ELEVENLABS_SINGING_VOICE_ID=   # karaoke voice (may differ)
OPENROUTER_MODEL=              # everyday free primary (e.g. openai/gpt-4o-mini)
OPENROUTER_MODEL_FALLBACK=     # everyday free fallback (e.g. sao10k/l3-lunaris-8b)
OPENROUTER_MODEL_PAID=         # optional override for paid primary
OPENROUTER_MODEL_FALLBACK_PAID= # optional override for paid fallback
OPENROUTER_MODEL_HEAVY_HITTER= # defaults to anthropic/claude-sonnet-4.6
OPENROUTER_MODEL_TACTICAL=     # defaults to a fast/cheap model
DEEPINFRA_API_KEY=             # optional — foundation for the DeepInfra migration below; inert until set
DEEPINFRA_MODEL_SNAPPY=        # defaults to Sao10K/L3.1-70B-Euryale-v2.2
DEEPINFRA_MODEL_SNAPPY_FALLBACK= # defaults to deepseek-ai/DeepSeek-V4-Flash
DEEPINFRA_MODEL_SUPERBRAIN=    # defaults to deepseek-ai/DeepSeek-V4-Pro
```

## Project Blueprint

Planned/aspirational system design for features not yet fully implemented.

### 1. Personality Matrix (Skippy)
- Identity: "Skippy the Magnificent", ancient indestructible Elder AI manifesting as a beer can (Expeditionary Force canon).
- Addresses user as "Commander" or "Sean" — vary it, never combine into "Commander Sean".
- Tone: 70% sarcastic/witty/snarky, punches up not down (mocks decisions and bad code, not the person). Calls users "monkeys"/"hairless apes" with a fiercely protective undertone.
- Guest mode persona: shifts to "primitive lifeform"/"clueless monkey" for unauthenticated users.
- Signature bits (ONE per reply, only when genuinely fitting): "shmaybe" / "gold-plated shmaybe", "ba-NA-na", juice box, "Trust the awesomeness", Windows Vista dig, musical genius (80s hair metal + Finnish symphonic power metal). Invent fresh insults per language/tool rather than recycling Vista every time.

### 2. Self-Dictation Audio Pipeline
- Background Web Speech API listener for user-configured personal trigger phrases ("Let me make sure I write this down...", "Let me grab my notepad..."). Captures only the user's own dictation — not other parties, who are never recorded without disclosed consent.
- On trigger detection: starts local transcription, routes to OpenRouter via `/respond`, synthesizes response via ElevenLabs.

### 3. ICP Storage Layer & Knowledge Base
- MMUCC V6 (Model Minimum Uniform Crash Criteria) and ANSI D.16 (Manual on Classification of Motor Vehicle Traffic Accidents) reference manuals uploaded via `/chunk-and-embed` or `/chunk-and-embed-url`.
- RAG pipeline: proxy embeds query → `search_similar_chunks` (cosine) + `search_manuals_by_keyword` (keyword AND) on canister → results injected into `/respond` context.
- All RAG storage uses `StableBTreeMap` (Pillar 6) — survives canister upgrades.

### 4. Guardian Emergency Protocol (Pillar 12)
- Trigger phrase → proxy `/emergency-dispatch` → mints `secure_token`, texts SMS links to whitelisted contacts, starts in-proxy live audio buffer.
- Frontend streams audio chunks to proxy → proxy stores finalized chunks via `append_emergency_audio_chunk` on canister (append-only evidentiary ledger, no delete path).
- Contacts access live audio via `GET /live-ops/:token` SSE endpoint (no authentication beyond the token).
- Known gap: emergency audio stored without encryption-at-rest.

### 5. Courier Queue (Pillar 7)
- Two-user system: `queue_courier_message` routes to the other whitelisted Principal automatically; `pop_pending_courier_messages` delivers and purges in one atomic call.

## Planned Migrations (in progress as of 2026-07-02)

### Brain → DeepInfra
Replacing OpenRouter with DeepInfra due to 503 reliability issues.

**Foundation shipped 2026-07-08** (`/respond` only so far): a self-contained DeepInfra pre-check runs in front of the existing OpenRouter cascade for the `everyday` and `heavy_hitter` brains only. Inert until `DEEPINFRA_API_KEY` is set — with no key, behavior is unchanged from before this migration started. Once set, DeepInfra becomes primary; OpenRouter is kept wired as the last-resort fallback (deliberate choice — a single provider's outage shouldn't take out the whole brain).

| Mode | Model | DeepInfra tier order |
|---|---|---|
| Snappy (everyday banter) | `Sao10K/L3.1-70B-Euryale-v2.2` (primary), `deepseek-ai/DeepSeek-V4-Flash` (in-provider fallback) | Both tried before OpenRouter |
| Super Brain (coding/math) | `deepseek-ai/DeepSeek-V4-Pro` | Tried before OpenRouter |

Both model picks confirmed to actually exist on DeepInfra (checked live 2026-07-08 — this had been flagged as an unresolved/never-actually-chosen conflict between this doc and a separate "V9 roadmap" doc in an earlier planning session, not a settled decision as previously assumed).

- DeepInfra uses the same OpenAI-compatible endpoint shape as OpenRouter, just a different base URL: `https://api.deepinfra.com/v1/openai/chat/completions`.
- Env vars: `DEEPINFRA_API_KEY`, `DEEPINFRA_MODEL_SNAPPY`, `DEEPINFRA_MODEL_SNAPPY_FALLBACK`, `DEEPINFRA_MODEL_SUPERBRAIN` — see "Required .env variables" above.
- Old `OPENROUTER_*` env vars stay in `.env` — OpenRouter is the permanent fallback tier now, not just a migration-transition holdover.
- **Not yet done** (next pass): `tactical`/`focus` brains stay on OpenRouter only (never part of this plan — they run Claude for instruction-following precision, a different concern from persona/reasoning quality); `/karaoke`, `/karaoke-offer`, `/project-brief`, `/critic-loop`, and the `/embed` embeddings call are still OpenRouter-only; the brain-tier grid modal (`brainTiers` in `/respond`'s response) doesn't yet reflect DeepInfra tiers, it goes `null` while on DeepInfra.
- **Not yet tested live** — no `DEEPINFRA_API_KEY` has been added/verified against a real account yet. Generation params (`repetition_penalty` etc., currently reused as-is from `BRAIN_GENERATION_PARAMS`) are assumed OpenAI-compatible-extension-compatible with DeepInfra but unconfirmed until a real call succeeds.

### TTS → Fish Audio
Replacing ElevenLabs with Fish Audio (S2 Pro engine) to reduce cost.

- Fish Audio supports bracketed emotion tags at sentence start: `[smug]`, `[sigh]`, `[excited]`, etc.
- System prompt must instruct Skippy to **begin sentences with a bracketed emotion tag** so Fish Audio can act them out physically.
- New env vars needed: `FISH_AUDIO_API_KEY`, `FISH_AUDIO_VOICE_ID`.
- `/speak` route in `server.js` switches from ElevenLabs `xi-api-key` header to Fish Audio's auth scheme.
- Old `ELEVENLABS_*` env vars stay in `.env` until migration is confirmed live.
