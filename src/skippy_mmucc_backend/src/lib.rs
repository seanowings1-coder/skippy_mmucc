use candid::{CandidType, Decode, Deserialize, Encode};
use ic_cdk::{query, update};
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
use ic_stable_structures::storable::Bound;
use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap, StableCell, Storable};
use std::borrow::Cow;
use std::cell::RefCell;

type Memory = VirtualMemory<DefaultMemoryImpl>;

// Manual excerpts can run long (full sections of a reference manual), so give
// Storable a generous bound rather than the structures' default of a few hundred bytes.
const MAX_DOCUMENT_SECTION_SIZE: u32 = 1_000_000;

const MANUAL_SECTIONS_MEMORY_ID: MemoryId = MemoryId::new(0);
const NEXT_ID_MEMORY_ID: MemoryId = MemoryId::new(1);

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
    let id = take_next_id();
    let doc = DocumentSection { id, manual_name, section, title, content };
    MANUAL_SECTIONS.with(|s| s.borrow_mut().insert(id, doc));
    id
}

#[query]
fn get_manual_section(id: u64) -> Option<DocumentSection> {
    MANUAL_SECTIONS.with(|s| s.borrow().get(&id))
}

#[query]
fn list_sections_by_manual(manual_name: String) -> Vec<DocumentSection> {
    MANUAL_SECTIONS.with(|s| {
        s.borrow()
            .iter()
            .map(|entry| entry.value().clone())
            .filter(|doc| doc.manual_name == manual_name)
            .collect()
    })
}

#[query]
fn greet(name: String) -> String {
    format!("Hello, {}!", name)
}
