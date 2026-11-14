//! Solo-queue rank snapshots, one series per Riot ID, behind the profile
//! sparkline.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::{json_store, paths};

/// A few hundred rank changes is years of play for an active account; the cap
/// keeps the file from growing without bound.
const MAX_SNAPSHOTS_PER_ACCOUNT: usize = 200;

const TIER_ORDER: &[&str] = &[
    "IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER",
    "CHALLENGER",
];
const APEX_TIERS: &[&str] = &["MASTER", "GRANDMASTER", "CHALLENGER"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Snapshot {
    #[serde(rename = "t")]
    pub timestamp: i64,
    pub tier: String,
    #[serde(default)]
    pub division: String,
    pub lp: i64,
    pub score: i64,
}

pub type History = HashMap<String, Vec<Snapshot>>;

fn division_index(division: &str) -> i64 {
    match division.to_uppercase().as_str() {
        "IV" => 0,
        "III" => 1,
        "II" => 2,
        "I" => 3,
        _ => 0,
    }
}

/// One monotonic number for "how far up the ladder is this", so the sparkline
/// shows real progress across promotions instead of raw LP — which resets to 0
/// on every promotion and would draw a misleading cliff exactly when a player
/// ranks up.
pub fn rank_score(tier: &str, division: &str, lp: i64) -> Option<i64> {
    let tier_upper = tier.to_uppercase();
    let tier_index = TIER_ORDER.iter().position(|t| *t == tier_upper)? as i64;
    let division_index = if APEX_TIERS.contains(&tier_upper.as_str()) {
        0
    } else {
        division_index(division)
    };
    Some(tier_index * 400 + division_index * 100 + lp)
}

pub fn load() -> History {
    json_store::load_or_default(&paths::rank_history_file(), "rank history")
}

fn save(history: &History) {
    // Best effort: this rides along on the stats lookup, whose real job is
    // returning display data. A write failure here must never surface as a
    // failure of that unrelated operation.
    let _ = json_store::save(&paths::rank_history_file(), history, "rank history");
}

/// Records a snapshot for `riot_id`, deduped against the last stored entry —
/// appended only when the rank actually changed.
///
/// Compares tier and division as well as the score: LP can briefly read over
/// 100 within a division right after a big win, before the promotion shows up
/// in the tier/division fields, which would otherwise collapse two genuinely
/// different ladder states onto one score.
pub fn record(riot_id: &str, tier: &str, division: &str, lp: i64) {
    let Some(score) = rank_score(tier, division, lp) else {
        return; // unranked or an unrecognised tier — nothing to plot
    };

    let mut history = load();
    let series = history.entry(riot_id.to_lowercase()).or_default();

    if let Some(last) = series.last() {
        if last.score == score && last.tier.eq_ignore_ascii_case(tier) && last.division.eq_ignore_ascii_case(division) {
            return;
        }
    }

    series.push(Snapshot {
        timestamp: chrono::Utc::now().timestamp_millis(),
        tier: tier.to_string(),
        division: division.to_string(),
        lp,
        score,
    });
    if series.len() > MAX_SNAPSHOTS_PER_ACCOUNT {
        let overflow = series.len() - MAX_SNAPSHOTS_PER_ACCOUNT;
        series.drain(0..overflow);
    }
    save(&history);
}

pub fn for_riot_id(riot_id: &str) -> Vec<Snapshot> {
    load().get(&riot_id.to_lowercase()).cloned().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Sandbox;

    #[test]
    fn score_rises_monotonically_up_the_ladder() {
        let gold4 = rank_score("GOLD", "IV", 0).unwrap();
        let gold1 = rank_score("GOLD", "I", 0).unwrap();
        let plat4 = rank_score("PLATINUM", "IV", 0).unwrap();
        assert!(gold4 < gold1 && gold1 < plat4);
    }

    #[test]
    fn a_promotion_never_looks_like_a_drop() {
        // Gold IV at 99 LP, then promoted to Gold III at 0 LP.
        let before = rank_score("GOLD", "IV", 99).unwrap();
        let after = rank_score("GOLD", "III", 0).unwrap();
        assert!(after > before, "the sparkline must not dip on a promotion");
    }

    #[test]
    fn apex_tiers_ignore_division() {
        assert_eq!(rank_score("MASTER", "I", 250), rank_score("MASTER", "IV", 250));
    }

    #[test]
    fn unranked_has_no_score() {
        assert_eq!(rank_score("UNRANKED", "", 0), None);
        assert_eq!(rank_score("", "", 0), None);
    }

    #[test]
    fn records_only_actual_changes() {
        let _sb = Sandbox::bare("rank");
        record("player#euw", "GOLD", "IV", 20);
        record("player#euw", "GOLD", "IV", 20);
        assert_eq!(for_riot_id("player#euw").len(), 1, "an unchanged rank is not a new snapshot");

        record("player#euw", "GOLD", "III", 5);
        assert_eq!(for_riot_id("player#euw").len(), 2);
    }

    #[test]
    fn distinguishes_a_promotion_that_scores_the_same() {
        let _sb = Sandbox::bare("rank-promo");
        // Both land on the same score; tier/division tell them apart.
        record("p#euw", "GOLD", "IV", 100);
        record("p#euw", "GOLD", "III", 0);
        assert_eq!(for_riot_id("p#euw").len(), 2);
    }

    #[test]
    fn riot_ids_are_matched_case_insensitively() {
        let _sb = Sandbox::bare("rank-case");
        record("Player#EUW", "GOLD", "IV", 20);
        assert_eq!(for_riot_id("player#euw").len(), 1);
    }

    #[test]
    fn history_is_capped() {
        let _sb = Sandbox::bare("rank-cap");
        for lp in 0..(MAX_SNAPSHOTS_PER_ACCOUNT + 25) {
            record("p#euw", "GOLD", "IV", lp as i64);
        }
        let series = for_riot_id("p#euw");
        assert_eq!(series.len(), MAX_SNAPSHOTS_PER_ACCOUNT);
        assert!(series.first().unwrap().lp > 0, "the oldest entries are the ones dropped");
    }

    #[test]
    fn an_unknown_account_has_an_empty_series() {
        let _sb = Sandbox::bare("rank-empty");
        assert!(for_riot_id("nobody#eu").is_empty());
    }
}
