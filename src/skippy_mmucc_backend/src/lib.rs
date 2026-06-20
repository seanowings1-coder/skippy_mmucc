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

    static HISTORY: RefCell<StableBTreeMap<Principal, ConversationHistory, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(HISTORY_MEMORY_ID)),
        ));

    static PERSONA_PROFILES: RefCell<StableBTreeMap<Principal, PersonaProfile, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(PERSONA_PROFILES_MEMORY_ID)),
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
    let doc = DocumentSection { id, manual_name, section, title, content };
    MANUAL_SECTIONS.with(|s| s.borrow_mut().insert(id, doc));
    id
}

#[query]
fn get_manual_section(id: u64) -> Option<DocumentSection> {
    assert_whitelisted();
    MANUAL_SECTIONS.with(|s| s.borrow().get(&id))
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

/// Appends one user/assistant turn to the caller's rolling conversation
/// history in a single round trip, trimming from the front if it exceeds
/// MAX_HISTORY_MESSAGES. The proxy never calls this directly — it has no
/// way to act as a specific end user (see Pillar 1's implementation note in
/// CLAUDE.md) — the frontend calls it with its own authenticated identity
/// right after a Skippy reply comes back.
#[update]
fn append_turn(user_text: String, assistant_text: String) {
    let caller = assert_whitelisted();
    let now = ic_cdk::api::time();
    HISTORY.with(|h| {
        let mut h = h.borrow_mut();
        let mut history = h.get(&caller).unwrap_or_default();
        history.messages.push(Message { role: "user".to_string(), content: user_text, timestamp: now });
        history.messages.push(Message { role: "assistant".to_string(), content: assistant_text, timestamp: now });
        if history.messages.len() > MAX_HISTORY_MESSAGES {
            let excess = history.messages.len() - MAX_HISTORY_MESSAGES;
            history.messages.drain(0..excess);
        }
        h.insert(caller, history);
    });
}

#[query]
fn get_history() -> Vec<Message> {
    let caller = assert_whitelisted();
    HISTORY.with(|h| h.borrow().get(&caller).map(|history| history.messages).unwrap_or_default())
}

#[update]
fn purge_history() {
    let caller = assert_whitelisted();
    HISTORY.with(|h| {
        h.borrow_mut().remove(&caller);
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

#[query]
fn greet(name: String) -> String {
    format!("Hello, {}!", name)
}
