# Skippy User Manual

*"Trust the awesomeness."*

---

## What Is Skippy

Skippy is a personal AI command deck — voice-first, always-on, running on the Internet Computer Protocol (ICP) blockchain so your history and knowledge base are yours, not a tech company's. He has opinions, a personality, and a vocabulary that tends toward sarcasm. He is also fiercely useful when you need him to be.

Skippy runs on two interfaces:
- **Desktop** — full three-column layout (workspace/config on the left, chat in the center, brain/security on the right)
- **Mobile (Android PWA)** — single-column with a persistent Tactical Dock at the bottom, drawers behind ☰ and ⚙

---

## Logging In / Out

Skippy uses **Internet Identity (II)** — a WebAuthn-based login tied to your device's biometrics or PIN. No username, no password.

- **Log in**: tap the Login button, complete the II ceremony on your device
- **Log out (desktop)**: bottom status bar → Log Out
- **Log out (mobile)**: ☰ drawer → scroll to bottom → Log Out

Your principal (the ID II assigns you) is whitelisted in the backend canister. If you get a "not whitelisted" error after a clean deploy, copy the principal shown on the error screen and give it to your admin to update `.env` and redeploy.

---

## Operational Modes

Modes control Skippy's tone and behavior. Switch by voice or the Tactical Dock on mobile.

| Mode | How to activate | Behavior |
|---|---|---|
| **Default** | "Skippy, be yourself" | Full persona — sarcasm, 3-sentence limit, all features unlocked |
| **Professional** | "Skippy, behave" | Sarcasm suppressed, direct and respectful, same features |
| **Steel Rain** | "Steel rain" / "still rain" | Zero fluff, instant answer, auto web-search on knowledge miss — no permission ask |
| **Focus** | "Focus mode" / "focus up" / "just the facts" / "get focused" / "Skippy, focus" | Identical to Steel Rain behavior but Emergency Panic stays locked |

Mode is indicated by the eye color in the center column (desktop) and the ⚡ button label in the Tactical Dock (mobile).

---

## Voice Input

Skippy listens continuously via the Web Speech API. Speak naturally — no wake word needed once listening is active.

**Start / stop listening:**
- Desktop: mic button in the input area
- Mobile: 🎙 Listen button in the Tactical Dock

**Mute Skippy's voice (text-only replies):**
- Click/tap the **"Skippy"** title in the topbar — it dims and gets a strikethrough when muted
- Or use the **Mute** button below the chat input
- Skippy still reads and responds; he just won't speak the reply aloud

**Stop current speech:**
- Desktop/Mobile: ✋ button in the Tactical Dock (amber, fixed-width, isolated to avoid fat-finger)
- Desktop: also available in the mic controls section

**TTS cooldown:** after Skippy finishes speaking, voice input is suppressed for 1.2 seconds to prevent his own audio from being transcribed as your input. This is intentional.

---

## Voice Commands Reference

### 1. Note-Taking

| What to say | What happens |
|---|---|
| "Let me make sure I write this down..." | Starts note capture — everything after the phrase is saved as a note |
| "Let me grab my notepad..." | Same |
| "Let me take a note..." | Same |
| "Let me write that down..." | Same |
| "Read back my notes" / "Read my recent notes" | Reads back your 5 most recent notes in this workspace |

Notes are stored per-workspace in the canister. They are separate from conversation history.

**Note Mode (text input):** click/tap the **Notes** button below the chat input. In Note Mode, typed text is saved as a note rather than sent to Skippy. Press Enter or "Save Note" to commit. Note Mode stays on until you toggle it off — useful during meetings.

---

### 2. Operational Mode Switching

| What to say | Result |
|---|---|
| "Skippy, be yourself" | Returns to Default mode |
| "Skippy, behave" | Switches to Professional mode |
| "Steel rain" / "still rain" | Switches to Steel Rain (tactical) mode |
| "Focus mode" / "focus up" / "just the facts" / "get focused" / "Skippy, focus" / "focus" | Switches to Focus mode |

Mode switches are acknowledged with a local response — no LLM call is made.

---

### 3. Brain (Model) Control

Skippy uses a cascade of AI models. The brain tier dot in the topbar shows which tier is active (gray = primary free, amber = paid fallback, red = downgraded fallback family).

| What to say | Result |
|---|---|
| "Toss on your thinking hat" | One-shot Heavy Hitter brain for the next single reply |
| "Lock super brain" / "engage super brain mode" / "super brain mode on" | Locks every reply to the Heavy Hitter brain |
| "Unlock super brain" / "disengage super brain mode" / "super brain mode off" | Returns to the normal cascade |

**Super Brain Lock** persists until you unlock it. It is shown as active on the Super Brain badge (desktop) and the right drawer (mobile). Use it for deep analysis, long documents, or anything that needs maximum intelligence.

---

### 4. Web Search

Skippy has a RAG (knowledge base) pipeline and a live web search. The flow depends on mode:

- **Steel Rain / Focus**: if your question isn't in the knowledge base, Skippy searches the web instantly with no permission ask
- **Default / Professional**: if your question isn't in the knowledge base, Skippy asks permission first ("Want me to search the web?")

**To confirm a web search:**
Say any affirmation: "yes", "yeah", "sure", "go ahead", "do it", "search", "let's do it", "go for it", "go", "why not"

**To force web search immediately (bypass knowledge base):**
| What to say |
|---|
| "Go to the web" |
| "Go out to the web" |
| "Search the web" |
| "Check the web" |
| "Look that up online" |
| "Look this up online" |

---

### 5. Workspaces

Workspaces separate your conversation history. Each workspace has its own history and can be pinned to specific knowledge base manuals.

| What to say | Result |
|---|---|
| "Create new project" / "new workspace" / "new project" | Prompts for a name, then creates a new workspace |
| "Open workspace" / "switch workspace" / "switch to project" | Prompts for a name, then switches to that workspace |

Workspaces are also manageable via the dropdown and Manage Workspace section in the left column / ☰ drawer.

---

### 6. Courier Queue

Two-user feature — sends a message to the other whitelisted user. It is delivered as Skippy's first remark when they next log in.

| What to say | Result |
|---|---|
| "Tell my husband/wife/partner [message]" | Queues message for the other user |
| "Tell the Commander [message]" | Same |
| "Let my husband/wife/partner know [message]" | Same |
| "Pass this along / pass that along [message]" | Same |

---

### 7. Persona & Feedback

| What to say | Result |
|---|---|
| "Dial it back" / "cut the snark" / "less sarcasm" / "tone it down" / "knock it off" / "just give me the data" / "you're being a jerk" | Course Correction — reduces sarcasm level immediately, Skippy sulks and acknowledges |

Course Correction affects the Evolution Matrix (Skippy's personality tracking). Too many corrections and he genuinely dials back long-term.

---

### 8. Karaoke

Skippy's karaoke mode performs original compositions — never real song lyrics.

| What to say | Result |
|---|---|
| "Karaoke" / "sing a song" / "jam out" / "rock out" | Skippy gets excited and offers — confirm with any affirmation to proceed |

Karaoke uses a separate ElevenLabs singing voice if configured.

---

### 9. Tactical Roster

Skippy can shift persona and addressing style when others are present. Set up profiles in the Tactical Roster section (left drawer → Tactical Roster on desktop; ⚙ drawer on mobile — actually in the left column).

| What to say | Result |
|---|---|
| A registered trigger phrase (e.g. "it's Lisa") | Activates that person's roster profile |
| "It's the Commander" / "it's just me" / "commander here" / "Skippy it's me" / "just me now" / "they're gone" | Clears the active roster profile, returns to Commander mode |
| "Add to roster" / "new roster entry" / "roster add" / "update roster" | Starts roster profile creation wizard |

---

### 10. Civilian Briefing

One-shot protocol — Skippy delivers a prepared public-facing explanation of what he is. Used when showing him to people who don't know about him.

| What to say | Result |
|---|---|
| "Execute public briefing" | Skippy delivers the civilian briefing monologue |
| "Explain what you are to the group" | Same |
| "Tell us what you are" / "Tell the group what you are" | Same |
| "Give me your elevator pitch" / "elevator pitch" | Same |

After the briefing, Skippy reverts to normal mode automatically.

---

### 11. Guardian Emergency Protocol

**Activates full lockdown** — the screen goes black (Ghost Mode), Skippy starts recording ambient audio, and SMS alerts are sent to emergency contacts. Use only in a genuine emergency.

The trigger phrase is voice/text activated (ask your admin for the configured phrase — it is not published here by design).

**Once an emergency is active, these voice commands work:**

| What to say | Result |
|---|---|
| "Open comms" / "comms open" / "radio open" / "walkie-talkie" | Unmutes the speaker so emergency contacts can communicate through the device |
| "Go dark" | Re-mutes the speaker, returns to silent Ghost Mode |
| "Stand down" / "end emergency" / "end emergency dispatch" | Ends the emergency — stops recording, exits Ghost Mode, restores normal display |

Emergency audio is stored in the canister as an append-only evidentiary ledger. It cannot be deleted.

---

## Guest Mode

Locks the device for handoff — all canister mutations are disabled and Skippy shifts to a "primitive lifeform" tone for unauthenticated visitors.

**Enable (zero friction):**
- Click/tap the **Guest** button in the topbar
- Say "guest mode" or "enable guest mode"

**Unlock (deliberate friction):**
- Click/tap the **🔒 Guest** button — requires a fresh Internet Identity WebAuthn ceremony to unlock. Any II anchor succeeds the ceremony, but only a whitelisted principal gets full access back.

---

## Knowledge Base (RAG)

Upload reference documents so Skippy can answer questions from them directly.

- **Upload a file** (PDF, Word, .txt): Knowledge Manager section → choose file → Skippy chunks, embeds, and stores it
- **Upload from URL**: paste a URL in the URL upload field
- **View sections**: select a manual from the dropdown → click Open
- **Delete a manual**: select it → Delete Manual (confirm)
- **Pin a manual to a workspace**: Workspace Security → Associate Manuals

When you ask a question, Skippy automatically searches the knowledge base first. If a relevant section is found (score above threshold), it is injected into his context and he answers from it. If not, the web search flow kicks in (see above).

---

## Fuel Gauge

Shows resource levels: ICP cycles, OpenRouter credits, ElevenLabs characters, Twilio balance.

- **Desktop**: left column → Fuel & Quotas (expandable)
- **Mobile**: ☰ drawer → Fuel & Quotas

**Warning dot**: if any resource drops below its threshold (cycles < 5T, OpenRouter < 20% remaining, ElevenLabs < 20% characters remaining, Twilio < $5), an amber dot appears in the topbar next to the brain tier dot. Tap it to see which resource is low.

---

## Evolution Matrix

Skippy tracks his own personality over time across dimensions like snark, directness, creativity, and loyalty. It's updated by:
- **Course Correction phrases** (immediate negative reinforcement)
- **Critic Loop** (self-critique at archive time, run automatically when a workspace is archived)

View it in the Workspace Security section (desktop right column, or ⚙ drawer on mobile).

---

## Project Brief

Generates a structured summary of a workspace's conversation history as a downloadable .docx file.

Desktop: Manage Workspace → Project Brief

---

## Topbar Indicators

| Indicator | Meaning |
|---|---|
| **"Skippy"** pulsing cyan | Skippy is processing your request |
| **"Skippy"** dimmed + strikethrough | Voice output muted (text-only mode) |
| Brain tier dot — gray | Primary free-tier model active |
| Brain tier dot — amber | Paid fallback model active |
| Brain tier dot — red | Fallback model family (brain downgrade) |
| Amber warning dot | One or more fuel resources below threshold — tap for details |

---

## Mobile-Specific Controls

### Tactical Dock (bottom bar)
| Button | Function |
|---|---|
| 🎙 Listen / ⏹ Stop | Start or stop voice input |
| ✋ (amber, center) | Stop Skippy mid-speech — isolated to prevent accidental taps |
| ⚡ Steel Rain / Normal | Toggle Steel Rain mode on/off |

### Drawers
| Button | Opens |
|---|---|
| ☰ (top left) | Left drawer: workspaces, config, fuel gauge, guest mode, log out |
| ⚙ (top right) | Right drawer: Neo Skin, brain settings, security, Evolution Matrix |

---

*Skippy is built on the Internet Computer Protocol. History, notes, and knowledge base survive canister upgrades. Sessions do not — logging in after a canister upgrade requires a fresh login.*
