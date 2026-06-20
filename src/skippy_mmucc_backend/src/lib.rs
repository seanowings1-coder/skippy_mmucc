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
fn validate_session(token: String) -> Option<Principal> {
    let now = ic_cdk::api::time();
    SESSIONS.with(|s| {
        s.borrow().get(&token).and_then(|(principal, expiry)| {
            if now < *expiry {
                Some(*principal)
            } else {
                None
            }
        })
    })
}

#[query]
fn greet(name: String) -> String {
    format!("Hello, {}!", name)
}
