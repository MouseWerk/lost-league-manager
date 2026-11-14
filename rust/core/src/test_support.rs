//! Shared fixtures for the crate's tests.
//!
//! Several things here are process-global — the `LLM_DATA_DIR` environment
//! variable, the champion store, the item store — so every test that touches
//! them has to run one at a time. A per-module mutex is not enough: two modules
//! holding two different locks still run concurrently and overwrite each
//! other's data. Everything funnels through the single [`Sandbox`] below.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

static LOCK: Mutex<()> = Mutex::new(());

/// For tests that mutate a global store but need no data directory — they
/// still have to hold the one lock, or they will re-seed the item store out
/// from under a test that is mid-assertion.
pub fn lock() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct Sandbox {
    dir: PathBuf,
    _guard: MutexGuard<'static, ()>,
}

impl Sandbox {
    /// A private data directory plus the standard champion/item fixtures.
    pub fn new(tag: &str) -> Self {
        let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("llm-test-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("LLM_DATA_DIR", &dir);
        seed_reference_data();
        Self { dir, _guard: guard }
    }

    /// A data directory with no reference data loaded, for tests that don't
    /// need champions or items.
    pub fn bare(tag: &str) -> Self {
        let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("llm-test-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("LLM_DATA_DIR", &dir);
        Self { dir, _guard: guard }
    }

    /// Point the data directory somewhere else mid-test, to stand in for a
    /// different install (used by the export/import round trip).
    pub fn switch_to(&self, suffix: &str) -> PathBuf {
        let other = self.dir.with_extension(suffix);
        std::fs::create_dir_all(&other).unwrap();
        std::env::set_var("LLM_DATA_DIR", &other);
        other
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.dir).ok();
        for extra in ["import", "other"] {
            std::fs::remove_dir_all(self.dir.with_extension(extra)).ok();
        }
        std::env::remove_var("LLM_DATA_DIR");
    }
}

/// The champions and items every data-driven test shares. Real ids and real
/// costs, so a test asserting "650g" is asserting the same arithmetic the app
/// does in a match.
pub fn seed_reference_data() {
    crate::champion_data::seed_for_tests(
        &[(103, "Ahri", "Ahri"), (86, "Garen", "Garen"), (17, "Teemo", "Teemo")],
        "16.18.1",
    );
    crate::item_data::seed_for_tests(&[
        (1001, "Boots", 300, &[3158], &["Boots"], 1),
        (1082, "Dark Seal", 350, &[3041], &["SpellDamage"], 1),
        (3041, "Mejai's Soulstealer", 1500, &[], &["SpellDamage"], 2),
        (3158, "Ionian Boots of Lucidity", 900, &[], &["Boots"], 2),
        (3802, "Lost Chapter", 1200, &[], &["SpellDamage"], 2),
        (1056, "Doran's Ring", 400, &[], &["SpellDamage"], 1),
        (2003, "Health Potion", 50, &[], &["Consumable"], 1),
        (3157, "Zhonya's Hourglass", 3250, &[], &["Armor"], 3),
        (3340, "Stealth Ward", 0, &[], &["Trinket"], 1),
        (773041, "Mejai's Soulstealer", 1235, &[], &["SpellDamage"], 2),
    ]);
}
