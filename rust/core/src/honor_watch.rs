//! Tracks each account's peak honor level so a drop can be flagged on its card,
//! and the flag clears itself once honor recovers.
//!
//! Keyed by username rather than Riot ID: honor-v2 data only exists for
//! whichever account is signed into the League client, captured at that moment.
//!
//! Chat and ranked restrictions deliberately aren't tracked. The honor-v2
//! endpoint exposes no stable, verified field for them (unlike `honorLevel`),
//! and guessing at a field name would silently never fire rather than detect
//! anything.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::{json_store, paths};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Record {
    pub peak: i64,
    pub current: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

pub type Watch = HashMap<String, Record>;

pub fn load() -> Watch {
    json_store::load_or_default(&paths::honor_watch_file(), "honor watch data")
}

fn save(watch: &Watch) {
    // Best effort: this rides along on the LCU overview, whose real job is
    // returning live data. A write failure here must never surface as a failure
    // of that unrelated operation.
    let _ = json_store::save(&paths::honor_watch_file(), watch, "honor watch data");
}

pub fn is_flagged_record(record: Option<&Record>) -> bool {
    record.map(|r| r.current < r.peak).unwrap_or(false)
}

pub fn is_flagged(username: &str) -> bool {
    is_flagged_record(load().get(username))
}

pub fn record_level(username: &str, honor_level: i64) {
    if username.is_empty() {
        return;
    }
    let mut watch = load();
    if let Some(previous) = watch.get(username) {
        if previous.current == honor_level {
            return; // unchanged — skip the write
        }
    }
    let peak = watch
        .get(username)
        .map(|p| p.peak.max(honor_level))
        .unwrap_or(honor_level);
    watch.insert(
        username.to_string(),
        Record { peak, current: honor_level, updated_at: chrono::Utc::now().timestamp_millis() },
    );
    save(&watch);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Sandbox;

    #[test]
    fn a_first_sighting_sets_the_peak_and_is_not_flagged() {
        let _sb = Sandbox::bare("honor-first");
        record_level("player", 3);
        assert!(!is_flagged("player"));
        assert_eq!(load()["player"], Record { peak: 3, current: 3, updated_at: load()["player"].updated_at });
    }

    #[test]
    fn a_drop_below_the_peak_flags_the_account() {
        let _sb = Sandbox::bare("honor-drop");
        record_level("player", 4);
        record_level("player", 2);
        assert!(is_flagged("player"));
        assert_eq!(load()["player"].peak, 4);
    }

    #[test]
    fn recovering_clears_the_flag() {
        let _sb = Sandbox::bare("honor-recover");
        record_level("player", 4);
        record_level("player", 2);
        record_level("player", 4);
        assert!(!is_flagged("player"));
    }

    #[test]
    fn a_new_high_raises_the_peak() {
        let _sb = Sandbox::bare("honor-peak");
        record_level("player", 3);
        record_level("player", 5);
        assert_eq!(load()["player"].peak, 5);
        assert!(!is_flagged("player"));
    }

    #[test]
    fn an_unchanged_level_does_not_rewrite_the_file() {
        let _sb = Sandbox::bare("honor-noop");
        record_level("player", 3);
        let first = load()["player"].updated_at;
        record_level("player", 3);
        assert_eq!(load()["player"].updated_at, first);
    }

    #[test]
    fn accounts_are_tracked_separately() {
        let _sb = Sandbox::bare("honor-multi");
        record_level("one", 4);
        record_level("one", 1);
        record_level("two", 5);
        assert!(is_flagged("one"));
        assert!(!is_flagged("two"));
    }

    #[test]
    fn an_unknown_account_is_never_flagged() {
        let _sb = Sandbox::bare("honor-unknown");
        assert!(!is_flagged("nobody"));
        assert!(!is_flagged_record(None));
    }
}
