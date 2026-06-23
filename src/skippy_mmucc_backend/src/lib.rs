use candid::{CandidType, Decode, Deserialize, Encode, Principal};
use ic_cdk::{init, post_upgrade, query, update};
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
use ic_stable_structures::storable::Bound;
use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap, StableCell, Storable};
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;

type Memory = VirtualMemory<DefaultMemoryImpl>;

// Manual excerpts can run long (full sections of a reference manual), so give
// Storable a generous bound rather than the structures' default of a few hundred bytes.
const MAX_DOCUMENT_SECTION_SIZE: u32 = 1_000_000;

const MANUAL_SECTIONS_MEMORY_ID: MemoryId = MemoryId::new(0);
const NEXT_ID_MEMORY_ID: MemoryId = MemoryId::new(1);
const COMMANDER_PRINCIPAL_MEMORY_ID: MemoryId = MemoryId::new(2);
const PARTNER_PRINCIPAL_MEMORY_ID: MemoryId = MemoryId::new(3);
const HISTORY_MEMORY_ID: MemoryId = MemoryId::new(4);
const PERSONA_PROFILES_MEMORY_ID: MemoryId = MemoryId::new(5);
const WORKSPACES_MEMORY_ID: MemoryId = MemoryId::new(6);
const COURIER_QUEUE_MEMORY_ID: MemoryId = MemoryId::new(7);
const EMERGENCY_EVENTS_MEMORY_ID: MemoryId = MemoryId::new(8);
const EMERGENCY_AUDIO_MEMORY_ID: MemoryId = MemoryId::new(9);
const EVOLUTION_PROFILES_MEMORY_ID: MemoryId = MemoryId::new(10);
const EVOLUTION_LOG_MEMORY_ID: MemoryId = MemoryId::new(11);

// Pillar 19 (Self-Evolution & Metacognitive Matrix) — hard caps on every
// personality weight, confirmed 2026-06-22: growth should be natural and
// conversational, never a runaway drift that silences the persona entirely
// (e.g. snark_level hitting 0) or breaks character consistency at the other
// extreme. No "factory reset" exists by design — out-of-bounds correction
// happens via the Course Correction feedback loop, not a revert button.
const EVOLUTION_WEIGHT_MIN: f32 = 0.2;
const EVOLUTION_WEIGHT_MAX: f32 = 0.95;

// Rolling cap on a Principal's stored conversation: applied at write time so
// both stable memory usage and the context forwarded to OpenRouter stay
// bounded, instead of growing without limit over a long-lived conversation.
const MAX_HISTORY_MESSAGES: usize = 40;

// Generous bound since this holds up to MAX_HISTORY_MESSAGES whole messages
// per Principal, not one row like DocumentSection.
const MAX_HISTORY_SIZE: u32 = 200_000;

// Session tokens are short-lived and only ever re-derived by logging in again,
// so they live in heap memory rather than stable memory — losing them on a
// canister upgrade just costs a re-login, not data.
const SESSION_TTL_NANOS: u64 = 30 * 60 * 1_000_000_000;

/// A single indexed section/clause from a reference manual. `manual_name` (e.g.
/// "MMUCC_V6", "ANSI_D16") identifies which manual it belongs to, so new manuals
/// can be added without changing the storage schema or canister interface.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct DocumentSection {
    pub id: u64,
    pub manual_name: String,
    /// Manual-specific locator, e.g. a MMUCC data element number or ANSI D.16 clause.
    pub section: String,
    pub title: String,
    pub content: String,
    /// RAG embedding vector (Pillar 6), pre-normalized to unit length at insert
    /// time so similarity search is a plain dot product. `None` for entries
    /// that aren't part of the semantic search corpus (e.g. notes saved via
    /// the plain `add_manual_section`/`#saveNote` path).
    pub embedding: Option<Vec<f32>>,
    /// Document-level type/category (e.g. "code", "manual", "reference"),
    /// chosen at upload time and applied identically to every chunk of one
    /// document — same redundant-per-row pattern as `manual_name`. `Option`
    /// from day one (see the `Workspace.scratchpad` decode bug this same
    /// session for why a bare `String` field would break old records).
    /// `None`/empty for uncategorized manuals and for plain notes.
    pub category: Option<String>,
}

impl Storable for DocumentSection {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }

    fn into_bytes(self) -> Vec<u8> {
        Encode!(&self).unwrap()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }

    const BOUND: Bound = Bound::Bounded {
        max_size: MAX_DOCUMENT_SECTION_SIZE,
        is_fixed_size: false,
    };
}

/// One chunk of an uploaded document, embedding already computed by the proxy
/// (Pillar 6) — input to the bulk `add_manual_chunks`, so a multi-chunk
/// document upload is one `#[update]` call/consensus round instead of N.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct NewChunk {
    pub section: String,
    pub title: String,
    pub content: String,
    pub embedding: Vec<f32>,
}

/// A `search_similar_chunks` result, paired with its cosine similarity score
/// so the caller (the frontend) can apply its own "is this actually a good
/// match" threshold rather than the canister silently deciding for it.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct ScoredSection {
    pub score: f32,
    pub section: DocumentSection,
}

/// A single turn in a Principal's rolling conversation history with Skippy.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct Message {
    pub role: String,
    pub content: String,
    pub timestamp: u64,
}

#[derive(CandidType, Deserialize, Clone, Debug, Default)]
pub struct ConversationHistory {
    pub messages: Vec<Message>,
}

impl Storable for ConversationHistory {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }

    fn into_bytes(self) -> Vec<u8> {
        Encode!(&self).unwrap()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }

    const BOUND: Bound = Bound::Bounded {
        max_size: MAX_HISTORY_SIZE,
        is_fixed_size: false,
    };
}

/// Composite key for `HISTORY` (Pillar 10) — each Principal can now have many
/// workspaces, each with its own rolling conversation, instead of one flat
/// stream per Principal. `Ord`/`PartialOrd` are derived field-order
/// (principal first) purely so this can key a `StableBTreeMap`; no query
/// relies on that ordering.
#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct HistoryKey {
    pub principal: Principal,
    pub workspace_id: u64,
}

impl Storable for HistoryKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }

    fn into_bytes(self) -> Vec<u8> {
        Encode!(&self).unwrap()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }

    const BOUND: Bound = Bound::Bounded {
        max_size: 64,
        is_fixed_size: false,
    };
}

/// `Active` workspaces show up in the main switcher; `Archived` ones are
/// hidden from it but stay fully intact in stable memory until either
/// restored or explicitly hard-deleted (Pillar 10 — archiving never implies
/// deletion).
#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
pub enum WorkspaceStatus {
    Active,
    Archived,
}

/// A user-defined project/context partition for conversation history
/// (Pillar 10). Private per-Principal — never shared between the two
/// whitelisted users, unlike the manual/RAG library (Pillar 6).
///
/// `scratchpad` (Pillar 10 extension, Phase 5.6.1): free text pinned to this
/// workspace and prepended to every `/respond` call for it, so critical
/// metadata (case numbers, constraints) doesn't slide out of the rolling
/// history window. `associated_manuals` is purely a visual/organizational
/// pin (a checklist of manual names) — it never changes what RAG actually
/// retrieves (Pillar 6's "global, not siloed" rule still holds; every
/// workspace can pull from every manual regardless of this list).
///
/// Both are `Option` rather than bare `String`/`Vec<String>` — confirmed
/// live 2026-06-21: Candid's decode only defaults a *missing* field to its
/// type's default when that field is `Option<T>` (decodes to `None`); a
/// plain `String`/`Vec<T>` field absent from already-stored bytes (any
/// `Workspace` record created before this change) fails to decode with a
/// hard subtyping-error trap. `None` means "empty," same as before.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct Workspace {
    pub id: u64,
    pub owner: Principal,
    pub name: String,
    pub status: WorkspaceStatus,
    pub created_at: u64,
    pub scratchpad: Option<String>,
    pub associated_manuals: Option<Vec<String>>,
}

impl Storable for Workspace {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }

    fn into_bytes(self) -> Vec<u8> {
        Encode!(&self).unwrap()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }

    const BOUND: Bound = Bound::Bounded {
        // Bumped from 2_000 — a scratchpad can hold a real paragraph of notes
        // plus a list of manual names; 10kB is comfortably generous for both
        // while still nowhere near the document-section bound.
        max_size: 10_000,
        is_fixed_size: false,
    };
}

/// Pillar 7 (Courier Queue) — a pending cross-profile message, queued by one
/// whitelisted Principal for the other. No `recipient` field needed: with
/// exactly two whitelisted Principals (Pillar 2), "the other one" is always
/// unambiguous given the sender, resolved server-side in
/// `queue_courier_message` — the frontend never needs to know the other
/// Principal's value at all.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct CourierMessage {
    pub id: u64,
    pub recipient: Principal,
    pub sender: Principal,
    pub content: String,
    pub created_at: u64,
}

impl Storable for CourierMessage {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }

    fn into_bytes(self) -> Vec<u8> {
        Encode!(&self).unwrap()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }

    const BOUND: Bound = Bound::Bounded {
        max_size: 2_000,
        is_fixed_size: false,
    };
}

/// Pillar 12 (Guardian Emergency Protocol) — one triggered panic event. The
/// `secure_token` is what the SMS link to whitelist contacts carries; the
/// proxy resolves it to find the right in-memory live-audio buffer, never
/// the canister directly (contacts viewing the live feed never call the
/// canister at all — only the device owner's own authenticated session ever
/// writes here, via `append_emergency_audio_chunk`).
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct EmergencyEvent {
    pub id: u64,
    pub owner: Principal,
    pub secure_token: String,
    pub started_at: u64,
}

impl Storable for EmergencyEvent {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }

    fn into_bytes(self) -> Vec<u8> {
        Encode!(&self).unwrap()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }

    const BOUND: Bound = Bound::Bounded {
        max_size: 500,
        is_fixed_size: false,
    };
}

/// Pillar 12 — one finalized chunk of the permanent evidentiary audio
/// ledger. Append-only by design: unlike Pillar 4's everyday audio notes,
/// this is potential evidence of a crime against the user, so no delete
/// method is ever offered for this store (confirmed in the pillar spec).
/// `data` is whatever the proxy hands the frontend to forward on — today
/// that's the raw finalized chunk bytes; real encryption-at-rest (mentioned
/// in the live spec) is a known gap, not yet implemented — see CLAUDE.md.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct EmergencyAudioChunk {
    pub id: u64,
    pub emergency_id: u64,
    pub data: Vec<u8>,
    pub created_at: u64,
}

impl Storable for EmergencyAudioChunk {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }

    fn into_bytes(self) -> Vec<u8> {
        Encode!(&self).unwrap()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }

    const BOUND: Bound = Bound::Bounded {
        // A few seconds of compressed (e.g. Opus/WebM) audio comfortably
        // fits well under 1MB; well clear of the 2MB IC message cap that's
        // exactly why this is chunked+finalized periodically rather than
        // streamed straight through, per Pillar 1's existing reasoning.
        max_size: 1_000_000,
        is_fixed_size: false,
    };
}

/// A Principal's self-set display name and ElevenLabs voice ID (Pillar 3's
/// dual-voice routing). Not secret, unlike the whitelist — settable at
/// runtime by each user for themselves, no redeploy needed.
#[derive(CandidType, Deserialize, Clone, Debug, Default)]
pub struct PersonaProfile {
    pub name: Option<String>,
    pub voice_id: Option<String>,
}

impl Storable for PersonaProfile {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }

    fn into_bytes(self) -> Vec<u8> {
        Encode!(&self).unwrap()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }

    const BOUND: Bound = Bound::Bounded {
        max_size: 2_000,
        is_fixed_size: false,
    };
}

/// Pillar 19 (Self-Evolution & Metacognitive Matrix) — a per-Principal set of
/// personality weights Skippy calibrates over time: the archive-time Critic
/// Loop (proxy-driven self-critique over a closed workspace) and the
/// immediate Course Correction feedback loop (a direct in-chat reprimand)
/// both adjust these via `record_evolution_event`, which hard-clamps every
/// field to [EVOLUTION_WEIGHT_MIN, EVOLUTION_WEIGHT_MAX]. Defaults match the
/// baseline default-mode persona — a brand-new caller hasn't evolved away
/// from anything yet.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct EvolutionProfile {
    pub snark_level: f32,
    pub vendor_skepticism: f32,
    pub technical_precision: f32,
    pub proactive_interruption: f32,
}

impl Default for EvolutionProfile {
    fn default() -> Self {
        EvolutionProfile {
            snark_level: 0.7,
            vendor_skepticism: 0.6,
            technical_precision: 0.7,
            proactive_interruption: 0.5,
        }
    }
}

impl Storable for EvolutionProfile {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }

    fn into_bytes(self) -> Vec<u8> {
        Encode!(&self).unwrap()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }

    const BOUND: Bound = Bound::Bounded {
        max_size: 200,
        is_fixed_size: false,
    };
}

/// Argument type for `record_evolution_event` — signed deltas applied to the
/// caller's current weights, not absolute values, so a partial adjustment
/// (e.g. only snark_level) doesn't require resending the other three.
#[derive(CandidType, Deserialize, Clone, Debug, Default)]
pub struct EvolutionDeltas {
    pub snark_level_delta: f32,
    pub vendor_skepticism_delta: f32,
    pub technical_precision_delta: f32,
    pub proactive_interruption_delta: f32,
}

/// An append-only explanation of why a weight changed — surfaced to the user
/// as a plain-language evolution history, distinct from the raw weights
/// themselves. No delete method, by design, same "the record speaks for
/// itself" reasoning as Pillar 12's emergency audio ledger, just much lower
/// stakes here — this is meant to be read back, not edited.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct EvolutionLogEntry {
    pub id: u64,
    pub owner: Principal,
    pub timestamp: u64,
    pub summary: String,
}

impl Storable for EvolutionLogEntry {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }

    fn into_bytes(self) -> Vec<u8> {
        Encode!(&self).unwrap()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }

    const BOUND: Bound = Bound::Bounded {
        max_size: 2_000,
        is_fixed_size: false,
    };
}

/// Returned by `validate_session` so the proxy gets everything it needs
/// (caller identity, display name, voice) from the one query it already
/// makes on every request, instead of a second round trip.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct SessionInfo {
    pub principal: Principal,
    pub name: Option<String>,
    pub voice_id: Option<String>,
}

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    static MANUAL_SECTIONS: RefCell<StableBTreeMap<u64, DocumentSection, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MANUAL_SECTIONS_MEMORY_ID)),
        ));

    static NEXT_ID: RefCell<StableCell<u64, Memory>> =
        RefCell::new(StableCell::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(NEXT_ID_MEMORY_ID)),
            0,
        ));

    // Set once via #[init] and persisted in stable memory, so the whitelist
    // survives canister upgrades without needing the deploy-time args again.
    static COMMANDER_PRINCIPAL: RefCell<StableCell<Principal, Memory>> =
        RefCell::new(StableCell::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(COMMANDER_PRINCIPAL_MEMORY_ID)),
            Principal::anonymous(),
        ));

    static PARTNER_PRINCIPAL: RefCell<StableCell<Principal, Memory>> =
        RefCell::new(StableCell::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(PARTNER_PRINCIPAL_MEMORY_ID)),
            Principal::anonymous(),
        ));

    // token -> (principal, expiry in nanoseconds since epoch)
    static SESSIONS: RefCell<HashMap<String, (Principal, u64)>> =
        RefCell::new(HashMap::new());

    static HISTORY: RefCell<StableBTreeMap<HistoryKey, ConversationHistory, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(HISTORY_MEMORY_ID)),
        ));

    static WORKSPACES: RefCell<StableBTreeMap<u64, Workspace, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(WORKSPACES_MEMORY_ID)),
        ));

    static COURIER_QUEUE: RefCell<StableBTreeMap<u64, CourierMessage, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(COURIER_QUEUE_MEMORY_ID)),
        ));

    static EMERGENCY_EVENTS: RefCell<StableBTreeMap<u64, EmergencyEvent, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(EMERGENCY_EVENTS_MEMORY_ID)),
        ));

    static EMERGENCY_AUDIO: RefCell<StableBTreeMap<u64, EmergencyAudioChunk, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(EMERGENCY_AUDIO_MEMORY_ID)),
        ));

    static PERSONA_PROFILES: RefCell<StableBTreeMap<Principal, PersonaProfile, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(PERSONA_PROFILES_MEMORY_ID)),
        ));

    static EVOLUTION_PROFILES: RefCell<StableBTreeMap<Principal, EvolutionProfile, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(EVOLUTION_PROFILES_MEMORY_ID)),
        ));

    static EVOLUTION_LOG: RefCell<StableBTreeMap<u64, EvolutionLogEntry, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(EVOLUTION_LOG_MEMORY_ID)),
        ));
}

#[init]
fn init(commander: Principal, partner: Principal) {
    COMMANDER_PRINCIPAL.with(|c| c.borrow_mut().set(commander));
    PARTNER_PRINCIPAL.with(|c| c.borrow_mut().set(partner));
}

// ic-cdk only invokes #[init] on a fresh install, never on `dfx deploy`
// upgrades of an already-installed canister — without this, every later
// deploy would silently keep whichever whitelist was set at first install,
// ignoring the --argument passed on subsequent deploys. Re-applying the same
// args here keeps `npm run deploy:local` idempotent either way.
#[post_upgrade]
fn post_upgrade(commander: Principal, partner: Principal) {
    init(commander, partner);
}

/// Traps if the caller isn't one of the two whitelisted Principals; otherwise
/// returns the caller so call sites that need it (e.g. `login`) don't have to
/// call `msg_caller()` again.
fn assert_whitelisted() -> Principal {
    let caller = ic_cdk::api::msg_caller();
    let commander = COMMANDER_PRINCIPAL.with(|c| *c.borrow().get());
    let partner = PARTNER_PRINCIPAL.with(|c| *c.borrow().get());
    if caller != commander && caller != partner {
        ic_cdk::trap("Caller is not an authorized Principal.");
    }
    caller
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn take_next_id() -> u64 {
    NEXT_ID.with(|counter| {
        let id = *counter.borrow().get();
        counter.borrow_mut().set(id + 1);
        id
    })
}

#[update]
fn add_manual_section(manual_name: String, section: String, title: String, content: String) -> u64 {
    assert_whitelisted();
    let id = take_next_id();
    let doc = DocumentSection { id, manual_name, section, title, content, embedding: None, category: None };
    MANUAL_SECTIONS.with(|s| s.borrow_mut().insert(id, doc));
    id
}

/// Bulk insert for the Neo Skin upload pipeline (Pillar 6) — one call for an
/// entire document's worth of chunks instead of N sequential
/// `add_manual_section`-style calls, each of which would be its own
/// consensus round trip.
#[update]
fn add_manual_chunks(manual_name: String, category: Option<String>, chunks: Vec<NewChunk>) -> Vec<u64> {
    assert_whitelisted();
    MANUAL_SECTIONS.with(|s| {
        let mut s = s.borrow_mut();
        chunks
            .into_iter()
            .map(|chunk| {
                let id = take_next_id();
                let doc = DocumentSection {
                    id,
                    manual_name: manual_name.clone(),
                    section: chunk.section,
                    title: chunk.title,
                    content: chunk.content,
                    embedding: Some(normalize(chunk.embedding)),
                    category: category.clone(),
                };
                s.insert(id, doc);
                id
            })
            .collect()
    })
}

fn normalize(v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm == 0.0 {
        v
    } else {
        v.into_iter().map(|x| x / norm).collect()
    }
}

/// Brute-force cosine similarity over every embedded chunk in the global
/// library (Pillar 6's "global, not siloed" RAG design — no manual_name
/// filter). Embeddings are stored pre-normalized (see `normalize` above), so
/// similarity here is a plain dot product. A `#[query]`, not an `#[update]` —
/// read-only, no consensus needed, and a brute-force scan over a
/// personal-reference-manual-scale corpus is trivially within a query call's
/// instruction budget; no ANN/HNSW indexing needed at this scale.
#[query]
fn search_similar_chunks(query_embedding: Vec<f32>, top_k: u32) -> Vec<ScoredSection> {
    assert_whitelisted();
    let query = normalize(query_embedding);
    let mut scored: Vec<ScoredSection> = MANUAL_SECTIONS.with(|s| {
        s.borrow()
            .iter()
            .filter_map(|entry| {
                let section = entry.value().clone();
                let embedding = section.embedding.as_ref()?;
                if embedding.len() != query.len() {
                    return None; // mismatched dimension (different embedding model/config) — skip rather than panic
                }
                let score = embedding.iter().zip(query.iter()).map(|(a, b)| a * b).sum::<f32>();
                Some(ScoredSection { score, section })
            })
            .collect()
    });
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_k as usize);
    scored
}

/// Literal substring search, complementary to `search_similar_chunks` —
/// pure embedding similarity is bad at "does any document literally mention
/// X" exact recall (a vague question doesn't share vocabulary with the
/// source text), so the frontend also sends word stems from the query here.
/// This runs server-side specifically so it scales with real document sizes
/// (a single 500-page manual can be 1000+ chunks, and the corpus is global
/// across every uploaded manual, not just one) — it's a cheap O(n) string
/// scan with no embedding math, so it stays fast regardless of corpus size,
/// and only the (typically small) set of actual hits crosses the wire,
/// instead of the frontend fetching a huge slice just to scan it itself.
#[query]
fn search_manuals_by_keyword(stems: Vec<String>) -> Vec<DocumentSection> {
    assert_whitelisted();
    let needles: Vec<String> = stems
        .into_iter()
        .map(|s| s.to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    if needles.is_empty() {
        return Vec::new();
    }
    MANUAL_SECTIONS.with(|s| {
        s.borrow()
            .iter()
            .filter(|entry| {
                let section = entry.value();
                let haystack = format!(
                    "{} {} {}",
                    section.manual_name.to_lowercase(),
                    section.title.to_lowercase(),
                    section.content.to_lowercase()
                );
                // ALL extracted stems must co-occur, not just any single one —
                // confirmed live 2026-06-21: with OR matching, a single common
                // word incidentally present in a large real manual (e.g. a city
                // name turning up in an address/jurisdiction example) made every
                // question mentioning it register as a false "hit," which wrongly
                // suppressed Steel Rain's web search and the Dumbass Loop's
                // permission-ask (both think local data already answered it).
                // Requiring every stem to appear together still finds genuine
                // exact-term lookups (e.g. "Flintlock Protocol" -> both stems
                // co-occur in the one real section about it) while making an
                // incidental single-word collision across a 500+ page corpus
                // astronomically less likely.
                needles.iter().all(|n| haystack.contains(n.as_str()))
            })
            .map(|entry| entry.value().clone())
            .take(50) // cap the worst case (a very common stem) — TOP_K trims further on the frontend
            .collect()
    })
}

/// Bulk delete-by-manual for the Knowledge Manager (Pillar 6's RAG manual
/// hygiene patch) — one atomic call instead of the frontend collecting ids
/// via `list_sections_by_manual` and calling `delete_manual_section` per id.
#[update]
fn delete_manual(manual_name: String) -> u64 {
    assert_whitelisted();
    MANUAL_SECTIONS.with(|s| {
        let mut s = s.borrow_mut();
        let ids: Vec<u64> = s
            .iter()
            .filter(|entry| entry.value().manual_name == manual_name)
            .map(|entry| *entry.key())
            .collect();
        for id in &ids {
            s.remove(id);
        }
        ids.len() as u64
    })
}

#[query]
fn get_manual_section(id: u64) -> Option<DocumentSection> {
    assert_whitelisted();
    MANUAL_SECTIONS.with(|s| s.borrow().get(&id))
}

// Generic by design, same as the rest of this store: notes are just sections
// under the reserved "SKIPPY_NOTES" manual name, so this one method covers
// both per-note deletion (Notes Vault) and the Knowledge Manager's "delete
// by manual" (collect ids via list_sections_by_manual, then call this per id).
#[update]
fn delete_manual_section(id: u64) -> bool {
    assert_whitelisted();
    MANUAL_SECTIONS.with(|s| s.borrow_mut().remove(&id)).is_some()
}

/// Distinct manual names that actually have at least one stored section —
/// used by the frontend to populate manual pickers/checklists with real
/// content instead of a hardcoded guess-list (confirmed live 2026-06-21: the
/// old frontend constant included `MMUCC_V6`/`ANSI_D16` as always-present
/// options even though nothing had ever been uploaded under those names,
/// which is misleading in the Pillar 10 "pinned manuals" checklist
/// specifically — checking a manual there implies it's real reference
/// material for the project).
#[query]
fn list_manual_names() -> Vec<String> {
    assert_whitelisted();
    let mut names: Vec<String> = MANUAL_SECTIONS.with(|s| {
        s.borrow()
            .iter()
            .map(|entry| entry.value().manual_name.clone())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    });
    names.sort();
    names
}

/// (manual_name, category) pairs for every manual that has a non-empty
/// category set — lets the frontend filter the pinned-manuals checklist by
/// type before sub-filtering by name. One category per manual_name (the
/// first non-empty one found among its chunks; in practice every chunk of
/// one upload shares the same category, set once at upload time).
#[query]
fn manual_category_map() -> Vec<(String, String)> {
    assert_whitelisted();
    let mut map = std::collections::BTreeMap::new();
    MANUAL_SECTIONS.with(|s| {
        for entry in s.borrow().iter() {
            let doc = entry.value();
            if let Some(category) = &doc.category {
                if !category.is_empty() {
                    map.entry(doc.manual_name.clone()).or_insert_with(|| category.clone());
                }
            }
        }
    });
    map.into_iter().collect()
}

#[query]
fn list_sections_by_manual(manual_name: String) -> Vec<DocumentSection> {
    assert_whitelisted();
    MANUAL_SECTIONS.with(|s| {
        s.borrow()
            .iter()
            .map(|entry| entry.value().clone())
            .filter(|doc| doc.manual_name == manual_name)
            .collect()
    })
}

/// Called by the frontend right after an Internet Identity sign-in. Mints a
/// short-lived opaque token bound to the caller's Principal, which the
/// frontend then forwards to the proxy (see `validate_session`) so the proxy
/// — which calls this canister as itself, not as the end user — can prove
/// the request came from an authenticated, whitelisted session without ever
/// handling the user's II delegation directly.
#[update]
async fn login() -> Result<String, String> {
    let caller = assert_whitelisted();

    let random_bytes = ic_cdk::management_canister::raw_rand()
        .await
        .map_err(|e| format!("Failed to generate session token: {:?}", e))?;
    let token = to_hex(&random_bytes);

    let now = ic_cdk::api::time();
    let expiry = now + SESSION_TTL_NANOS;
    SESSIONS.with(|s| {
        let mut sessions = s.borrow_mut();
        sessions.retain(|_, (_, exp)| now < *exp);
        sessions.insert(token.clone(), (caller, expiry));
    });

    Ok(token)
}

#[query]
fn validate_session(token: String) -> Option<SessionInfo> {
    let now = ic_cdk::api::time();
    let principal = SESSIONS.with(|s| {
        s.borrow().get(&token).and_then(|(principal, expiry)| {
            if now < *expiry {
                Some(*principal)
            } else {
                None
            }
        })
    })?;
    let profile = PERSONA_PROFILES.with(|p| p.borrow().get(&principal));
    Some(SessionInfo {
        principal,
        name: profile.as_ref().and_then(|p| p.name.clone()),
        voice_id: profile.as_ref().and_then(|p| p.voice_id.clone()),
    })
}

/// Looks up a workspace by id and traps unless the caller owns it — same
/// "trust nothing, verify ownership" shape as `assert_whitelisted`, since
/// workspace ids are caller-suppliable (returned by `create_workspace`, but
/// nothing stops a client from passing back an arbitrary u64).
fn assert_workspace_owner(caller: Principal, workspace_id: u64) -> Workspace {
    let workspace = WORKSPACES.with(|w| w.borrow().get(&workspace_id));
    match workspace {
        Some(w) if w.owner == caller => w,
        _ => ic_cdk::trap("Workspace not found or not owned by caller."),
    }
}

/// Creates a new Active workspace owned by the caller (Pillar 10). Workspaces
/// reuse the same global auto-increment counter as manual sections — there's
/// no need for a separate id space.
#[update]
fn create_workspace(name: String) -> u64 {
    let caller = assert_whitelisted();
    let id = take_next_id();
    let workspace = Workspace {
        id,
        owner: caller,
        name,
        status: WorkspaceStatus::Active,
        created_at: ic_cdk::api::time(),
        scratchpad: None,
        associated_manuals: None,
    };
    WORKSPACES.with(|w| w.borrow_mut().insert(id, workspace));
    id
}

/// Pillar 10 extension (Phase 5.6.1) — overwrites the workspace's pinned
/// scratchpad text. A plain set, not an append, matching the sidebar text
/// box's own save semantics (the whole field is edited and re-saved).
#[update]
fn update_scratchpad(workspace_id: u64, scratchpad: String) {
    let caller = assert_whitelisted();
    let mut workspace = assert_workspace_owner(caller, workspace_id);
    workspace.scratchpad = Some(scratchpad);
    WORKSPACES.with(|w| w.borrow_mut().insert(workspace_id, workspace));
}

/// Pillar 10 extension (Phase 5.6.1) — overwrites the full list of manual
/// names visually pinned to this workspace. Purely organizational: does not
/// affect what RAG actually retrieves (Pillar 6's "global, not siloed" rule).
#[update]
fn update_associated_manuals(workspace_id: u64, manuals: Vec<String>) {
    let caller = assert_whitelisted();
    let mut workspace = assert_workspace_owner(caller, workspace_id);
    workspace.associated_manuals = Some(manuals);
    WORKSPACES.with(|w| w.borrow_mut().insert(workspace_id, workspace));
}

#[query]
fn list_my_workspaces() -> Vec<Workspace> {
    let caller = assert_whitelisted();
    WORKSPACES.with(|w| {
        w.borrow()
            .iter()
            .map(|entry| entry.value().clone())
            .filter(|ws| ws.owner == caller)
            .collect()
    })
}

#[update]
fn archive_workspace(workspace_id: u64) {
    let caller = assert_whitelisted();
    let mut workspace = assert_workspace_owner(caller, workspace_id);
    workspace.status = WorkspaceStatus::Archived;
    WORKSPACES.with(|w| w.borrow_mut().insert(workspace_id, workspace));
}

#[update]
fn restore_workspace(workspace_id: u64) {
    let caller = assert_whitelisted();
    let mut workspace = assert_workspace_owner(caller, workspace_id);
    workspace.status = WorkspaceStatus::Active;
    WORKSPACES.with(|w| w.borrow_mut().insert(workspace_id, workspace));
}

/// Hard-delete (Pillar 10) — removes the workspace record and its
/// conversation history. Intended to be called only after the frontend has
/// offered the user an export; nothing server-side enforces that ordering.
#[update]
fn delete_workspace(workspace_id: u64) {
    let caller = assert_whitelisted();
    assert_workspace_owner(caller, workspace_id);
    WORKSPACES.with(|w| w.borrow_mut().remove(&workspace_id));
    HISTORY.with(|h| {
        h.borrow_mut().remove(&HistoryKey { principal: caller, workspace_id });
    });
}

/// Appends one user/assistant turn to the caller's rolling conversation
/// history for one workspace (Pillar 10) in a single round trip, trimming
/// from the front if it exceeds MAX_HISTORY_MESSAGES. The proxy never calls
/// this directly — it has no way to act as a specific end user (see Pillar
/// 1's implementation note in CLAUDE.md) — the frontend calls it with its
/// own authenticated identity right after a Skippy reply comes back.
#[update]
fn append_turn(workspace_id: u64, user_text: String, assistant_text: String) {
    let caller = assert_whitelisted();
    assert_workspace_owner(caller, workspace_id);
    let key = HistoryKey { principal: caller, workspace_id };
    let now = ic_cdk::api::time();
    HISTORY.with(|h| {
        let mut h = h.borrow_mut();
        let mut history = h.get(&key).unwrap_or_default();
        history.messages.push(Message { role: "user".to_string(), content: user_text, timestamp: now });
        history.messages.push(Message { role: "assistant".to_string(), content: assistant_text, timestamp: now });
        if history.messages.len() > MAX_HISTORY_MESSAGES {
            let excess = history.messages.len() - MAX_HISTORY_MESSAGES;
            history.messages.drain(0..excess);
        }
        h.insert(key, history);
    });
}

#[query]
fn get_history(workspace_id: u64) -> Vec<Message> {
    let caller = assert_whitelisted();
    assert_workspace_owner(caller, workspace_id);
    let key = HistoryKey { principal: caller, workspace_id };
    HISTORY.with(|h| h.borrow().get(&key).map(|history| history.messages).unwrap_or_default())
}

#[update]
fn purge_history(workspace_id: u64) {
    let caller = assert_whitelisted();
    assert_workspace_owner(caller, workspace_id);
    let key = HistoryKey { principal: caller, workspace_id };
    HISTORY.with(|h| {
        h.borrow_mut().remove(&key);
    });
}

/// Each user sets their own display name/voice — no `principal` argument,
/// caller is the key, same pattern as `append_turn`/`get_history`. Full
/// overwrite of both fields; no partial-update support needed for v1.
#[update]
fn set_persona_profile(name: String, voice_id: String) {
    let caller = assert_whitelisted();
    PERSONA_PROFILES.with(|p| {
        p.borrow_mut().insert(
            caller,
            PersonaProfile { name: Some(name), voice_id: Some(voice_id) },
        );
    });
}

#[query]
fn get_my_persona_profile() -> Option<PersonaProfile> {
    let caller = assert_whitelisted();
    PERSONA_PROFILES.with(|p| p.borrow().get(&caller))
}

/// Pillar 19 — the caller's current evolved weights, or baseline defaults if
/// they've never evolved away from them yet (no separate "has this user ever
/// evolved" flag needed; a fresh default is indistinguishable from, and
/// behaviorally identical to, a real unevolved profile).
#[query]
fn get_my_evolution_profile() -> EvolutionProfile {
    let caller = assert_whitelisted();
    EVOLUTION_PROFILES.with(|p| p.borrow().get(&caller).unwrap_or_default())
}

fn clamp_evolution_weight(value: f32) -> f32 {
    value.clamp(EVOLUTION_WEIGHT_MIN, EVOLUTION_WEIGHT_MAX)
}

/// Applies signed deltas to the caller's own weights and logs why — the one
/// place the [EVOLUTION_WEIGHT_MIN, EVOLUTION_WEIGHT_MAX] clamp is enforced,
/// so both the archive-time Critic Loop (proxy self-critique) and the
/// frontend's immediate Course Correction phrase detection funnel through
/// here rather than each re-implementing the clamp themselves.
#[update]
fn record_evolution_event(deltas: EvolutionDeltas, summary: String) -> u64 {
    let caller = assert_whitelisted();
    EVOLUTION_PROFILES.with(|p| {
        let mut p = p.borrow_mut();
        let mut profile = p.get(&caller).unwrap_or_default();
        profile.snark_level = clamp_evolution_weight(profile.snark_level + deltas.snark_level_delta);
        profile.vendor_skepticism =
            clamp_evolution_weight(profile.vendor_skepticism + deltas.vendor_skepticism_delta);
        profile.technical_precision =
            clamp_evolution_weight(profile.technical_precision + deltas.technical_precision_delta);
        profile.proactive_interruption =
            clamp_evolution_weight(profile.proactive_interruption + deltas.proactive_interruption_delta);
        p.insert(caller, profile);
    });
    let id = take_next_id();
    let entry = EvolutionLogEntry {
        id,
        owner: caller,
        timestamp: ic_cdk::api::time(),
        summary,
    };
    EVOLUTION_LOG.with(|l| l.borrow_mut().insert(id, entry));
    id
}

/// Most recent `limit` of the caller's own evolution log entries — same
/// "ascending-id store, tail of the Vec is the most recent" trick already
/// used by note retrieval, no timestamp parsing needed.
#[query]
fn list_my_evolution_log(limit: u32) -> Vec<EvolutionLogEntry> {
    let caller = assert_whitelisted();
    EVOLUTION_LOG.with(|l| {
        let mut entries: Vec<EvolutionLogEntry> = l
            .borrow()
            .iter()
            .map(|entry| entry.value().clone())
            .filter(|e| e.owner == caller)
            .collect();
        let len = entries.len();
        if len > limit as usize {
            entries = entries.split_off(len - limit as usize);
        }
        entries
    })
}

/// Pillar 7 — queues a message for "the other" whitelisted Principal. With
/// exactly two whitelisted Principals, the recipient is always unambiguous
/// given the sender: whichever of commander/partner isn't the caller.
#[update]
fn queue_courier_message(content: String) -> u64 {
    let caller = assert_whitelisted();
    let commander = COMMANDER_PRINCIPAL.with(|c| *c.borrow().get());
    let partner = PARTNER_PRINCIPAL.with(|c| *c.borrow().get());
    let recipient = if caller == commander { partner } else { commander };
    let id = take_next_id();
    let message = CourierMessage {
        id,
        recipient,
        sender: caller,
        content,
        created_at: ic_cdk::api::time(),
    };
    COURIER_QUEUE.with(|q| q.borrow_mut().insert(id, message));
    id
}

/// Pillar 7 — delivers and clears every pending message addressed to the
/// caller in one atomic call, per spec ("delivered... then cleared"). An
/// `#[update]`, not `#[query]`, since it mutates the queue.
#[update]
fn pop_pending_courier_messages() -> Vec<CourierMessage> {
    let caller = assert_whitelisted();
    COURIER_QUEUE.with(|q| {
        let mut q = q.borrow_mut();
        let pending: Vec<CourierMessage> = q
            .iter()
            .filter(|entry| entry.value().recipient == caller)
            .map(|entry| entry.value().clone())
            .collect();
        for message in &pending {
            q.remove(&message.id);
        }
        pending
    })
}

fn assert_emergency_owner(caller: Principal, emergency_id: u64) -> EmergencyEvent {
    let event = EMERGENCY_EVENTS.with(|e| e.borrow().get(&emergency_id));
    match event {
        Some(e) if e.owner == caller => e,
        _ => ic_cdk::trap("Emergency event not found or not owned by caller."),
    }
}

/// Pillar 12 — records a triggered panic event for the permanent record.
/// `secure_token` is generated by the *proxy* (not here), since the proxy
/// needs it immediately to set up its own in-memory live-audio buffer
/// before the canister is ever involved — this call just persists the
/// association for the owner's own evidentiary ledger.
#[update]
fn start_emergency(secure_token: String) -> u64 {
    let caller = assert_whitelisted();
    let id = take_next_id();
    let event = EmergencyEvent {
        id,
        owner: caller,
        secure_token,
        started_at: ic_cdk::api::time(),
    };
    EMERGENCY_EVENTS.with(|e| e.borrow_mut().insert(id, event));
    id
}

/// Pillar 12 — appends one finalized audio chunk to the permanent,
/// append-only evidentiary ledger. No corresponding delete method exists
/// for this store, deliberately — see `EmergencyAudioChunk`'s doc comment.
#[update]
fn append_emergency_audio_chunk(emergency_id: u64, data: Vec<u8>) -> u64 {
    let caller = assert_whitelisted();
    assert_emergency_owner(caller, emergency_id);
    let id = take_next_id();
    let chunk = EmergencyAudioChunk {
        id,
        emergency_id,
        data,
        created_at: ic_cdk::api::time(),
    };
    EMERGENCY_AUDIO.with(|a| a.borrow_mut().insert(id, chunk));
    id
}

#[query]
fn list_emergency_audio_chunks(emergency_id: u64) -> Vec<EmergencyAudioChunk> {
    let caller = assert_whitelisted();
    assert_emergency_owner(caller, emergency_id);
    EMERGENCY_AUDIO.with(|a| {
        a.borrow()
            .iter()
            .filter(|entry| entry.value().emergency_id == emergency_id)
            .map(|entry| entry.value().clone())
            .collect()
    })
}

#[query]
fn list_my_emergencies() -> Vec<EmergencyEvent> {
    let caller = assert_whitelisted();
    EMERGENCY_EVENTS.with(|e| {
        e.borrow()
            .iter()
            .filter(|entry| entry.value().owner == caller)
            .map(|entry| entry.value().clone())
            .collect()
    })
}

/// Pillar 8 (Fuel & Quotas Dashboard) — exposes the canister's own cycle
/// balance for the Fuel Gauge UI. Gated by the same two-Principal whitelist
/// rather than a separate admin concept — Pillar 8's spec flags that a real
/// admin/owner distinction is a future scoping question; with exactly two
/// users today, reusing assert_whitelisted() is the simplest correct choice.
#[query]
fn get_cycle_balance() -> u64 {
    assert_whitelisted();
    ic_cdk::api::canister_cycle_balance() as u64
}

/// Pillar 15 (Sovereign Guest Lockout) — the frontend's Guest Mode unlock
/// gate. Deliberately just assert_whitelisted() wrapped in a dedicated name
/// rather than a new auth mechanism: the real security boundary is the
/// frontend forcing a *fresh* WebAuthn ceremony before calling this with the
/// resulting identity (see #unlockGuestMode in App.js) — this check only
/// adds "and it must be one of the two whitelisted Principals," not "any
/// successfully authenticated identity" (e.g. a guest's own unrelated II
/// anchor).
#[query]
fn verify_unlock() -> bool {
    assert_whitelisted();
    true
}

#[query]
fn greet(name: String) -> String {
    format!("Hello, {}!", name)
}
