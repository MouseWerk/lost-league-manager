//! User-authored shopping plans, one per champion: "when I can afford 650g on
//! Ahri, buy Boots + Dark Seal". `build_reminder` watches live gold in-game and
//! pings once a step becomes affordable.
//!
//! On disk (build-paths.json):
//!   { "version": 1, "paths": { "Ahri": { "key": "Ahri", "steps": [...] } } }
//! A step: { "items": [id, ...], "gold": 650, "autoGold": true }
//!
//! `autoGold` only drives the editor (keep the threshold in step with the
//! summed item cost as items come and go); the reminder only reads `gold`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::{builds_api, champion_data, item_data, json_store, paths};

pub const MAX_STEPS: usize = 12;
pub const MAX_ITEMS_PER_STEP: usize = 6;
const MAX_GOLD: i64 = 30_000;

/// Rough price bands used to sanity-check what the scraper hands back. OP.GG's
/// structured data isn't always available, and the HTML fallback classifies by
/// id range — which happily files a 2800g legendary under "starting items". A
/// first step that only fires at 3250g is worse than no first step.
const STARTER_MAX_COST: i64 = 500;
const BOOTS_COST_RANGE: (i64, i64) = (300, 1400);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub items: Vec<i64>,
    pub gold: i64,
    #[serde(default = "default_true")]
    pub auto_gold: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub key: String,
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Store {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub paths: HashMap<String, Plan>,
}

fn one() -> u32 {
    1
}

/// A step with the metadata the reminder needs attached.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedItem {
    pub id: i64,
    pub name: String,
    pub cost: i64,
    pub ownership_ids: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedStep {
    pub gold: i64,
    pub items: Vec<ResolvedItem>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPlan {
    pub champ_key: String,
    pub steps: Vec<ResolvedStep>,
}

/// An earlier build of this feature also allowed plans on a champion class and
/// keyed everything "<scope>:<key>". Classes are gone; carry the champion plans
/// over to the flat key and drop the rest.
fn migrate(raw: HashMap<String, serde_json::Value>) -> HashMap<String, Plan> {
    let mut out = HashMap::new();
    for (id, entry) in raw {
        if id.starts_with("class:") {
            continue;
        }
        let key = id.strip_prefix("champion:").unwrap_or(&id).to_string();
        let Some(steps) = entry.get("steps") else { continue };
        let Ok(steps) = serde_json::from_value::<Vec<Step>>(steps.clone()) else { continue };
        if steps.is_empty() {
            continue;
        }
        out.insert(key.clone(), Plan { key, steps });
    }
    out
}

pub fn load() -> Store {
    #[derive(Deserialize, Default)]
    struct RawStore {
        #[serde(default)]
        paths: HashMap<String, serde_json::Value>,
    }
    let raw: RawStore = json_store::load_or_default(&paths::build_paths_file(), "build paths");
    Store {
        version: 1,
        paths: migrate(raw.paths),
    }
}

fn save(store: &Store) -> anyhow::Result<()> {
    json_store::save(&paths::build_paths_file(), store, "build paths")
}

fn is_known_champion(key: &str) -> bool {
    !key.is_empty() && champion_data::champion_id_by_key(key).is_some()
}

/// Everything that lands on disk goes through here. The frontend is the only
/// caller, but a step list with a negative threshold or a bogus item id would
/// silently break the in-game reminder rather than fail loudly, so normalise
/// first and drop what can't be salvaged.
pub fn sanitize_steps(steps: &[Step]) -> Vec<Step> {
    let mut out = Vec::new();
    for raw in steps.iter().take(MAX_STEPS) {
        let mut items: Vec<i64> = Vec::new();
        for id in &raw.items {
            if (1000..=99_999).contains(id) && !items.contains(id) {
                items.push(*id);
            }
            if items.len() == MAX_ITEMS_PER_STEP {
                break;
            }
        }
        if items.is_empty() {
            continue;
        }
        let summed: i64 = items.iter().map(|id| item_data::item_cost(*id)).sum();
        let gold = if raw.auto_gold || raw.gold < 0 { summed } else { raw.gold };
        out.push(Step {
            items,
            gold: gold.min(MAX_GOLD),
            auto_gold: raw.auto_gold,
        });
    }
    out
}

pub fn get(champ_key: &str) -> Option<Plan> {
    load().paths.get(champ_key).cloned()
}

pub fn all() -> HashMap<String, Plan> {
    load().paths
}

/// Saving an empty step list deletes the plan — that's how "remove the last
/// step" and "Delete plan" both arrive here.
pub fn set(champ_key: &str, steps: &[Step]) -> Result<Vec<Step>, String> {
    if !is_known_champion(champ_key) {
        return Err(format!("Unknown champion: {champ_key}"));
    }
    let clean = sanitize_steps(steps);
    let mut store = load();
    if clean.is_empty() {
        store.paths.remove(champ_key);
    } else {
        store.paths.insert(
            champ_key.to_string(),
            Plan { key: champ_key.to_string(), steps: clean.clone() },
        );
    }
    save(&store).map_err(|e| format!("Could not save build paths: {e}"))?;
    Ok(clean)
}

pub fn delete(champ_key: &str) -> Result<Vec<Step>, String> {
    set(champ_key, &[])
}

pub fn resolve_for_champion(champ_key: &str) -> Option<ResolvedPlan> {
    let plan = load().paths.get(champ_key)?.clone();
    if plan.steps.is_empty() {
        return None;
    }
    Some(ResolvedPlan {
        champ_key: champ_key.to_string(),
        steps: plan
            .steps
            .iter()
            .map(|step| ResolvedStep {
                gold: step.gold,
                items: step
                    .items
                    .iter()
                    .map(|id| ResolvedItem {
                        id: *id,
                        name: item_data::item_name(*id).unwrap_or_else(|| format!("Item {id}")),
                        cost: item_data::item_cost(*id),
                        ownership_ids: item_data::ownership_ids(*id),
                    })
                    .collect(),
            })
            .collect(),
    })
}

/// Seeds a plan from OP.GG's recommended build, so a usable starting point is
/// one click rather than a dozen item searches. Each core item becomes its own
/// step priced at its full cost — the gold you need in hand to walk out of the
/// shop with it.
pub async fn import_from_opgg(
    client: &reqwest::Client,
    champ_key: &str,
    position: Option<&str>,
) -> Result<Vec<Step>, String> {
    if !is_known_champion(champ_key) {
        return Err(format!("Unknown champion: {champ_key}"));
    }
    let is_aram = position.unwrap_or("").eq_ignore_ascii_case("ARAM");
    let builds = builds_api::get_builds(
        client,
        champ_key,
        if is_aram { Some("ARAM") } else { Some("CLASSIC") },
        if is_aram { None } else { position },
    )
    .await
    .ok_or_else(|| {
        let role = match position {
            Some(p) if !p.is_empty() && !is_aram => format!(" ({})", p.to_lowercase()),
            _ => String::new(),
        };
        format!("OP.GG had no build for {champ_key}{role}")
    })?;

    Ok(steps_from_builds(&builds))
        .and_then(|steps| {
            if steps.is_empty() {
                Err(format!("OP.GG returned no usable items for {champ_key}"))
            } else {
                Ok(steps)
            }
        })
        .and_then(|steps| set(champ_key, &steps))
}

/// Split out from the network call so the filtering rules are testable without
/// scraping anything.
pub fn steps_from_builds(builds: &builds_api::Builds) -> Vec<Step> {
    let mut used: Vec<i64> = Vec::new();
    // Trinkets and other unbuyables come back priced at 0; an item already
    // placed earlier shouldn't get a second step of its own.
    let usable = |id: i64, used: &[i64], min: Option<i64>, max: Option<i64>| {
        let cost = item_data::item_cost(id);
        cost > 0
            && !used.contains(&id)
            && min.map(|m| cost >= m).unwrap_or(true)
            && max.map(|m| cost <= m).unwrap_or(true)
    };

    let mut steps: Vec<Step> = Vec::new();

    let starting: Vec<i64> = builds
        .starting
        .iter()
        .copied()
        .filter(|id| usable(*id, &used, None, Some(STARTER_MAX_COST)))
        .take(3)
        .collect();
    for id in &starting {
        used.push(*id);
    }
    if !starting.is_empty() {
        steps.push(Step { items: starting, gold: 0, auto_gold: true });
    }

    if let Some(boot) = builds
        .boots
        .iter()
        .copied()
        .find(|id| usable(*id, &used, Some(BOOTS_COST_RANGE.0), Some(BOOTS_COST_RANGE.1)))
    {
        used.push(boot);
        steps.push(Step { items: vec![boot], gold: 0, auto_gold: true });
    }

    for id in &builds.core {
        if !usable(*id, &used, None, None) {
            continue;
        }
        used.push(*id);
        steps.push(Step { items: vec![*id], gold: 0, auto_gold: true });
    }

    // auto_gold steps get their threshold from the summed item cost.
    sanitize_steps(&steps)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::test_support::Sandbox;

    fn step(items: &[i64], gold: i64, auto: bool) -> Step {
        Step { items: items.to_vec(), gold, auto_gold: auto }
    }

    #[test]
    fn auto_threshold_sums_the_item_costs() {
        let _sb = Sandbox::new("auto");
        let saved = set("Ahri", &[step(&[1001, 1082], 0, true)]).unwrap();
        assert_eq!(saved[0].gold, 650);
    }

    #[test]
    fn a_typed_threshold_is_kept() {
        let _sb = Sandbox::new("manual");
        let saved = set("Ahri", &[step(&[3802], 1300, false)]).unwrap();
        assert_eq!(saved[0].gold, 1300);
    }

    #[test]
    fn unknown_champions_are_rejected() {
        let _sb = Sandbox::new("unknown");
        assert!(set("Notachamp", &[step(&[1001], 0, true)]).is_err());
    }

    #[test]
    fn bogus_ids_and_negative_thresholds_are_cleaned_up() {
        let _sb = Sandbox::new("junk");
        let saved = set(
            "Ahri",
            &[step(&[7, -3], 0, true), step(&[1001], -50, false), step(&[1001, 1001], 0, true)],
        )
        .unwrap();
        assert_eq!(saved.len(), 2, "the all-bogus step is dropped");
        assert_eq!(saved[0].gold, 300, "a negative threshold falls back to item cost");
        assert_eq!(saved[1].items, vec![1001], "duplicate items collapse");
    }

    #[test]
    fn saving_no_steps_deletes_the_plan() {
        let _sb = Sandbox::new("delete");
        set("Ahri", &[step(&[1001], 0, true)]).unwrap();
        assert!(get("Ahri").is_some());
        delete("Ahri").unwrap();
        assert!(get("Ahri").is_none());
        assert!(resolve_for_champion("Ahri").is_none());
    }

    #[test]
    fn resolving_attaches_names_costs_and_ownership() {
        let _sb = Sandbox::new("resolve");
        set("Ahri", &[step(&[1082], 0, true)]).unwrap();
        let plan = resolve_for_champion("Ahri").unwrap();
        assert_eq!(plan.steps[0].items[0].name, "Dark Seal");
        assert_eq!(plan.steps[0].items[0].cost, 350);
        assert!(plan.steps[0].items[0].ownership_ids.contains(&3041));
    }

    #[test]
    fn a_champion_without_a_plan_resolves_to_nothing() {
        let _sb = Sandbox::new("none");
        assert!(resolve_for_champion("Garen").is_none());
    }

    #[test]
    fn legacy_scoped_keys_migrate_and_class_plans_are_dropped() {
        let _sb = Sandbox::new("migrate");
        std::fs::write(
            paths::build_paths_file(),
            r#"{"version":1,"paths":{
                "champion:Ahri":{"scope":"champion","key":"Ahri","steps":[{"items":[1001],"gold":300,"autoGold":true}]},
                "class:Mage":{"scope":"class","key":"Mage","steps":[{"items":[1082],"gold":350,"autoGold":true}]}
            }}"#,
        )
        .unwrap();

        let store = load();
        assert_eq!(store.paths.len(), 1, "the class plan is dropped");
        assert!(store.paths.contains_key("Ahri"), "the champion plan keeps its steps");
        assert_eq!(store.paths["Ahri"].steps[0].gold, 300);
    }

    #[test]
    fn import_drops_items_that_cannot_be_starters() {
        let _sb = Sandbox::new("import");
        // What the HTML fallback produces on a bad day: a 3250g legendary
        // classified as a starting item.
        let builds = builds_api::Builds {
            champ_key: "Ahri".into(),
            starting: vec![1056, 2003, 3157],
            boots: vec![3158],
            core: vec![3802, 3157],
            optional: vec![],
        };
        let steps = steps_from_builds(&builds);

        assert_eq!(steps[0].items, vec![1056, 2003], "Zhonya's is not a starting item");
        assert_eq!(steps[0].gold, 450);
        assert_eq!(steps[1].items, vec![3158], "boots step");
        assert_eq!(steps[2].items, vec![3802]);
        assert_eq!(steps[3].items, vec![3157], "it belongs in core instead");

        let all_ids: Vec<i64> = steps.iter().flat_map(|s| s.items.clone()).collect();
        let unique: std::collections::HashSet<i64> = all_ids.iter().copied().collect();
        assert_eq!(all_ids.len(), unique.len(), "no item twice");
        assert!(steps.iter().all(|s| s.gold > 0));
        assert!(steps[0].gold <= 1000, "the opening buy must be affordable");
    }

    #[test]
    fn import_skips_zero_cost_trinkets() {
        let _sb = Sandbox::new("trinket");
        let builds = builds_api::Builds {
            champ_key: "Ahri".into(),
            starting: vec![3340, 1056],
            boots: vec![],
            core: vec![],
            optional: vec![],
        };
        let steps = steps_from_builds(&builds);
        assert_eq!(steps[0].items, vec![1056]);
    }

    #[test]
    fn a_plan_longer_than_the_cap_is_trimmed() {
        let _sb = Sandbox::new("cap");
        let many: Vec<Step> = (0..20).map(|_| step(&[1001], 300, false)).collect();
        let saved = set("Ahri", &many).unwrap();
        assert_eq!(saved.len(), MAX_STEPS);
    }

    #[test]
    fn a_step_cannot_hold_more_than_six_items() {
        let _sb = Sandbox::new("six");
        let saved = set("Ahri", &[step(&[1001, 1082, 3041, 3158, 3802, 1056, 2003, 3157], 0, false)]).unwrap();
        assert_eq!(saved[0].items.len(), MAX_ITEMS_PER_STEP);
    }
}
