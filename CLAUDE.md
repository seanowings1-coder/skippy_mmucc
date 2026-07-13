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
| `POST /respond` | Main LLM response — peer fall-forward + cross-tier escalation (everyday/heavy_hitter) or Steel Rain race (tactical/focus) |
| `POST /project-brief` | Generates a project brief from workspace history |
| `POST /critic-loop` | Archive-time Critic Loop (self-critique → Evolution Matrix deltas) |
| `POST /karaoke-offer` | In-character excited ask before performing (one-step before `/karaoke`) |
| `POST /karaoke` | Full karaoke performance (original lyrics only, no max_tokens cap) |
| `GET /speak` | Fish Audio TTS synthesis (migrated from ElevenLabs 2026-07-12 — see Planned Migrations) |
| `POST /embed` | Single text embedding (for RAG query vectors) |
| `POST /chunk-and-embed` | File upload (PDF/Word via mammoth/pdf-parse) → chunk → embed → canister |
| `POST /chunk-and-embed-url` | URL fetch → chunk → embed → canister |
| `POST /web-search` | Live web search |
| `GET /api/fuel` | Cycle balance + OpenRouter/ElevenLabs/DeepInfra/Twilio balance status |
| `GET /api/deepinfra-topup` | Mints a fresh, single-use DeepInfra Stripe billing portal URL (not cacheable, unlike other providers' static Top Up links) |
| `POST /emergency-dispatch` | Triggers Guardian Emergency Protocol, mints secure token |
| `GET /live-ops/:token` | SSE stream for emergency contacts (no auth — token is the credential) |

### Everyday / Heavy Hitter brains (`/respond`)
See "Brain → DeepInfra migration" below for the full peer-fall-forward + cross-tier-escalation design — that section is the source of truth, not duplicated here. In short: 2-3 genuine peer models per tier, tried in order, everyday escalates to Heavy Hitter on total failure, Heavy Hitter hard-errors on its own total failure. Everyday peers can be individually deselected from the brain-grid modal (sticky via `localStorage`).

Tactical/focus brains do NOT use this peer system — they use the Steel Rain race below, falling through to a separate simpler sequential cascade (primary → paid primary → Claude Haiku → free fallback → paid fallback) only if the race itself fails entirely.

Note: `/karaoke` and `/karaoke-offer` still use their own, older 7-tier `EVERYDAY_CASCADE` array (3 free OpenRouter models down to 4 paid) independently of `/respond` — that array was deliberately kept, not dead code, when `/respond`'s own use of it was replaced.

### Steel Rain / tactical race (`tactical` and `focus` only)
Tactical/focus's original design intent (clarified 2026-07-09, not implemented until then) is latency, not just fallback: fire two paid, fast-but-knowledgeable brains **simultaneously** — `DEEPINFRA_MODEL_TACTICAL` (default `deepseek-ai/DeepSeek-V4-Flash`) and OpenRouter's Claude Haiku (`OPENROUTER_MODEL_TACTICAL_PAID`) — and use whichever answers first, aborting the loser. This is why tactical/focus unlock the Emergency Panic button and default mode doesn't: speed is a safety property here, not a preference. Both racers are paid by design (no free tier in the race) — costs roughly double per Steel Rain/focus turn versus a single call, an accepted tradeoff. If **both** racers fail, falls through unchanged to the existing sequential cascade below (Sonnet → Haiku → free Llama → paid Llama) as the true last resort. Inert (no race, falls straight to the old sequential path) if `DEEPINFRA_API_KEY` isn't set.

### Operational modes and system prompts
- `default` — full Skippy persona, 3-sentence hard limit, structured XML system prompt
- `professional` — sarcasm suppressed, direct/respectful tone
- `tactical` — zero fluff, direct answer, instant web search on RAG miss (no permission ask), Steel Rain race (see above)
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
FISH_AUDIO_API_KEY=            # /speak's active TTS provider since 2026-07-12
FISH_AUDIO_VOICE_ID=           # cloned Skippy voice (reference_id)
FISH_AUDIO_SINGING_VOICE_ID=   # optional — falls back to FISH_AUDIO_VOICE_ID if unset
ELEVENLABS_API_KEY=            # legacy — no longer called by /speak, kept per migration plan below
ELEVENLABS_VOICE_ID=           # legacy — former default R.C. Bray clone voice
ELEVENLABS_SINGING_VOICE_ID=   # legacy — former karaoke voice
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
DEEPINFRA_MODEL_TACTICAL=      # defaults to deepseek-ai/DeepSeek-V4-Flash — Steel Rain race entrant
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
- On trigger detection: starts local transcription, routes to OpenRouter via `/respond`, synthesizes response via `/speak` (Fish Audio).

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
Replacing OpenRouter with DeepInfra due to 503 reliability issues. `DEEPINFRA_API_KEY` is live and verified working (Railway + local); with no key set, everyday/heavy_hitter's peer ladders skip their DeepInfra entrant and fall forward through whichever OpenRouter peers remain — inert-but-safe, not broken.

**Redesigned 2026-07-09** (superseding the 2026-07-08 "pre-check bolted in front of the OpenRouter cascade" foundation): user's clarified original intent was never a quality-descending cascade (strong free models down to weak paid ones) — every brain tier should have 2-3 genuine PEERS, comparable in personality-fit and raw power, that fall forward sequentially (hit first, no response, hit second...). If an entire tier's peers are exhausted, escalate to the next higher tier and repeat its own fall-forward, rather than degrading further or erroring immediately.

| Tier | Peers (fall-forward order) | On total failure |
|---|---|---|
| Everyday ("Snappy") | Euryale 70B (DeepInfra) → DeepSeek V4 Flash (DeepInfra) → Dolphin Venice, paid (OpenRouter) | Escalate to Heavy Hitter |
| Heavy Hitter ("Super Brain") | DeepSeek V4 Pro (DeepInfra) → Claude Sonnet 4.6 (OpenRouter) → Hermes 4 405B (OpenRouter) | Hard error — top of the ladder, no further fallback |
| Steel Rain (tactical/focus) | DeepSeek V4 Flash (DeepInfra) **raced against** Claude Haiku (OpenRouter), not sequenced — see "Steel Rain / tactical race" above. Deliberately NOT part of the everyday↔heavy_hitter ladder; only entered by the trigger phrase. | Falls through to the old sequential Sonnet→Haiku→free→paid cascade as true last resort |

All peers confirmed to actually exist via each provider's live `/models` listing before being hardcoded (2026-07-09) — this project's standing discipline since the Aurora-XL-v3.14 fabrication incident. `paidTier`/`brainDowngrade` were re-purposed again: every peer in both ladders is paid by design (no free-tier peer anywhere in either list — the OpenRouter free tier hit a hard rate wall during this same session's karaoke testing), so `paidTier` now means "didn't come from the very first, fastest-expected peer," and `brainDowngrade` only fires on a genuine cross-tier escalation (within-tier peer fallback is not a downgrade — the peers are meant to be comparably good, not a ladder).

Claude Sonnet stays in the Heavy Hitter rotation *with its guardrails intact, deliberately* — user's explicit call: "you are going to be my 800 pound monster for coding... I don't need to be diving off the bridge." This is the one place in the app where real safety behavior over persona is wanted, unlike Everyday/Steel Rain where "no guardrails, stay in character" is the actual requirement.

Heavy Hitter also gets a dedicated persona dial-down in the system prompt (applies regardless of `mode`): ~90-95% direct task-focused answer, minimal Skippy personality — "when I'm coding I really don't have time for a skippy being an ass." Professional mode ("be nice mode") was tuned the same session to allow a little real attitude/light sarcasm rather than near-zero — the hard line is still no mockery/insults/condescension toward the user, not zero personality.

- DeepInfra uses the same OpenAI-compatible endpoint shape as OpenRouter, just a different base URL: `https://api.deepinfra.com/v1/openai/chat/completions`.
- Env vars: `DEEPINFRA_API_KEY`, `DEEPINFRA_MODEL_SNAPPY`, `DEEPINFRA_MODEL_SNAPPY_FALLBACK`, `DEEPINFRA_MODEL_SUPERBRAIN`, `DEEPINFRA_MODEL_TACTICAL` — see "Required .env variables" above.
- **Not yet done** (next pass): `/karaoke`, `/karaoke-offer`, `/project-brief`, `/critic-loop`, and the `/embed` embeddings call are still OpenRouter-only, on the old `EVERYDAY_CASCADE` array (kept — still actively used by those routes, not dead code even though `/respond` no longer uses it for everyday).

### TTS → Fish Audio — SHIPPED 2026-07-12, live-tested and confirmed working
Replaced ElevenLabs with Fish Audio (`s2-pro` model) in `/speak` to reduce cost. `POST https://api.fish.audio/v1/tts`, `Authorization: Bearer $FISH_AUDIO_API_KEY`, `model: s2-pro` header, body `{ text, reference_id: voiceId, format: 'mp3' }` — response is a raw MP3 stream, same shape as the old ElevenLabs call, so the existing `Readable.fromWeb(...).pipe(res)` piping needed no changes. Both `requireSession`/`speakRequireSession`'s per-Principal `voiceId` fallback now default to `FISH_AUDIO_VOICE_ID` instead of `ELEVENLABS_VOICE_ID`. Verified against the real API (402 insufficient-credit before the account had funds, then a genuine 200 + playable MP3) before shipping. Committed `skippy_mmucc` `084f409` / `Skippy-proxy` `56aa204`, pushed, confirmed live via Railway deploy log and a real in-app voice test.

- **Known un-migrated caveat**: a Principal with a custom `voice_id` already stored via `set_persona_profile` (from before this migration) still holds an old ElevenLabs ID, which would now be sent to Fish Audio as `reference_id` and fail — check Workspace Security → Profile if either Principal ever set a custom value there.
- **Emotion tags — deliberately NOT implemented, open design conflict, do not add without resolving this first**: Fish Audio supports bracketed emotion tags (`[smug]`, `[sigh]`, `[excited]`) at sentence start, and the original plan was to have the system prompt instruct Skippy to emit them. But the 2026-07-11 persona session added an explicit opposite rule to `<system_constraints>` — "Never prefix any sentence with bracketed metadata like `[tone: dry]`" — to stop the Async Janitor's internal `[tone: X]` shorthand from leaking into live dialogue (see `CLAUDE.md`'s persona-recitation-snowball history). Adding emotion-tag instructions on top without very carefully reconciling the two (the model needs to reliably tell `[smug]` apart from `[tone: dry]`, a distinction this project's own experience says needs a concrete example, not just abstract wording) risks reopening that exact leak. Scope this as its own pass with A/B testing, not a quick addition.
- **Cost caveat, not yet resolved**: Fish Audio is currently running a "S2.1 Pro free for developers" promo — the live test cost $0.00 and didn't touch the account's separate pay-as-you-go "Team Wallet" balance at all. Real steady-state per-character cost (~$0.015/1K chars, vs ElevenLabs Turbo's ~$0.05/1K chars) is unconfirmed until the promo ends and real metered billing is observed. Also unresolved: whether the $15/mo Fish Audio Plus plan is required for API access at all, or just for keeping the cloned voice private (10 private voice slots) — see the Plus-plan memory note, test by downgrading only once the promo visibly ends.
- `ELEVENLABS_*` env vars and the `/api/fuel` ElevenLabs balance check are untouched — kept per the original plan until this migration has more real-world runtime, and because `/karaoke`, `/karaoke-offer`, `/project-brief`, and `/critic-loop` are still fully OpenRouter/ElevenLabs and out of scope for this pass.
