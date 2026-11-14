//! Item reference data from Data Dragon: the browsable shop list, gold
//! efficiency, and the ownership graph the build reminder needs.

use std::collections::{HashMap, HashSet};

use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

const MAX_ATTEMPTS: u32 = 3;

/// Community-standard gold value per point of each stat, used to estimate an
/// item's efficiency (stat value ÷ cost). Percent stats arrive from Data Dragon
/// as fractions (0.2 == 20%), so their value is quoted per 1.0 (=100%).
const GOLD_VALUES: &[(&str, f64)] = &[
    ("FlatHPPoolMod", 2.67),
    ("FlatMPPoolMod", 1.00),
    ("FlatHPRegenMod", 3.33),
    ("FlatMPRegenMod", 2.50),
    ("FlatArmorMod", 20.0),
    ("FlatSpellBlockMod", 20.0),
    ("FlatPhysicalDamageMod", 35.0),
    ("FlatMagicDamageMod", 21.75),
    ("FlatCritChanceMod", 4000.0),
    ("PercentAttackSpeedMod", 2500.0),
    ("FlatMovementSpeedMod", 12.0),
    ("PercentMovementSpeedMod", 4000.0),
    ("PercentLifeStealMod", 4000.0),
];

const STAT_LABELS: &[(&str, &str)] = &[
    ("FlatHPPoolMod", "Health"),
    ("FlatMPPoolMod", "Mana"),
    ("FlatHPRegenMod", "Health Regen"),
    ("FlatMPRegenMod", "Mana Regen"),
    ("FlatArmorMod", "Armor"),
    ("FlatSpellBlockMod", "Magic Resist"),
    ("FlatPhysicalDamageMod", "Attack Damage"),
    ("FlatMagicDamageMod", "Ability Power"),
    ("FlatCritChanceMod", "Critical Strike Chance"),
    ("PercentAttackSpeedMod", "Attack Speed"),
    ("FlatMovementSpeedMod", "Move Speed"),
    ("PercentMovementSpeedMod", "Move Speed"),
    ("PercentLifeStealMod", "Life Steal"),
];

const PERCENT_STATS: &[&str] = &[
    "FlatCritChanceMod",
    "PercentAttackSpeedMod",
    "PercentMovementSpeedMod",
    "PercentLifeStealMod",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemStat {
    pub key: String,
    pub label: String,
    pub value: f64,
    pub unit: String,
    pub gold_value: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemGold {
    pub base: i64,
    pub total: i64,
    pub sell: i64,
    pub purchasable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInfo {
    pub id: i64,
    pub name: String,
    pub icon: String,
    pub tags: Vec<String>,
    /// Shop tier: basic | epic | legendary | consumable | trinket.
    pub tier: String,
    pub depth: i64,
    pub gold: ItemGold,
    pub stats: Vec<ItemStat>,
    pub stats_gold_value: f64,
    pub efficiency: f64,
    pub description_lines: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct RawItem {
    name: String,
    total: i64,
    into: Vec<i64>,
}

#[derive(Default)]
struct Store {
    list: Vec<ItemInfo>,
    /// Every id Data Dragon knows, including the non-purchasable and
    /// map-specific ones kept out of `list`.
    raw: HashMap<i64, RawItem>,
    ids_by_name: HashMap<String, Vec<i64>>,
    ownership_cache: HashMap<i64, Vec<i64>>,
}

static STORE: Lazy<RwLock<Store>> = Lazy::new(|| RwLock::new(Store::default()));

pub fn item_list() -> Vec<ItemInfo> {
    STORE.read().list.clone()
}

pub fn item_name(id: i64) -> Option<String> {
    STORE.read().raw.get(&id).map(|i| i.name.clone())
}

pub fn item_cost(id: i64) -> i64 {
    STORE.read().raw.get(&id).map(|i| i.total).unwrap_or(0)
}

/// Item ids that mean "the gold for this item is already spent": the item
/// itself, its map-specific twins (Arena and Swarm rebalances are separate ids
/// sharing a display name), and everything any of those build into.
///
/// Without the upgrade walk, a Dark Seal reminder fires again the moment it
/// becomes Mejai's; without the twins it never clears in Arena.
pub fn ownership_ids(item_id: i64) -> Vec<i64> {
    if let Some(cached) = STORE.read().ownership_cache.get(&item_id) {
        return cached.clone();
    }

    let ids = {
        let store = STORE.read();
        let mut out: HashSet<i64> = HashSet::new();
        let mut queue = vec![item_id];
        while let Some(current) = queue.pop() {
            if !out.insert(current) {
                continue;
            }
            if let Some(raw) = store.raw.get(&current) {
                if let Some(twins) = store.ids_by_name.get(&raw.name) {
                    for twin in twins {
                        if !out.contains(twin) {
                            queue.push(*twin);
                        }
                    }
                }
                for next in &raw.into {
                    if !out.contains(next) {
                        queue.push(*next);
                    }
                }
            }
        }
        let mut ids: Vec<i64> = out.into_iter().collect();
        ids.sort_unstable();
        ids
    };

    STORE.write().ownership_cache.insert(item_id, ids.clone());
    ids
}

/// The shop's own tiering. Data Dragon's `depth` is exactly League's
/// basic/epic/legendary notion (absent means depth 1); consumables and trinkets
/// sit outside it, the way the shop lists them separately.
fn classify_tier(tags: &[String], depth: i64) -> &'static str {
    if tags.iter().any(|t| t == "Consumable") {
        return "consumable";
    }
    if tags.iter().any(|t| t == "Trinket") {
        return "trinket";
    }
    match depth {
        d if d >= 3 => "legendary",
        2 => "epic",
        _ => "basic",
    }
}

/// Riot files map-specific rebalances (Arena, Swarm, event modes) under a
/// six-digit id namespace — 223158 is Arena's Ionian Boots. They share names
/// with the originals, and listing both is most of what makes the item list
/// hard to search, so the browsable list is base items only. The raw map still
/// holds them, so ownership checks keep working in those modes.
fn is_base_game_item(id: i64) -> bool {
    id < 100_000
}

fn is_on_main_maps(maps: &HashMap<String, bool>) -> bool {
    maps.get("11").copied().unwrap_or(false) || maps.get("12").copied().unwrap_or(false)
}

fn compute_stats(raw: &HashMap<String, f64>) -> (Vec<ItemStat>, f64) {
    let mut stats = Vec::new();
    let mut total = 0.0;
    for (key, value) in raw {
        if *value == 0.0 {
            continue;
        }
        let Some((_, per_unit)) = GOLD_VALUES.iter().find(|(k, _)| k == key) else {
            continue;
        };
        let is_percent = PERCENT_STATS.contains(&key.as_str());
        let display = if is_percent {
            (value * 1000.0).round() / 10.0
        } else {
            (value * 100.0).round() / 100.0
        };
        let gold_value = (value * per_unit * 100.0).round() / 100.0;
        total += gold_value;
        stats.push(ItemStat {
            key: key.clone(),
            label: STAT_LABELS
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, l)| l.to_string())
                .unwrap_or_else(|| key.clone()),
            value: display,
            unit: if is_percent { "%".into() } else { String::new() },
            gold_value,
        });
    }
    stats.sort_by(|a, b| b.gold_value.partial_cmp(&a.gold_value).unwrap_or(std::cmp::Ordering::Equal));
    (stats, (total * 100.0).round() / 100.0)
}

/// Data Dragon's rich-text description reduced to plain lines. All markup is
/// stripped so the frontend can render with textContent only; lines wrapped in
/// @@...@@ are passive/active names it shows as small headers.
fn description_to_lines(html: &str) -> Vec<String> {
    if html.is_empty() {
        return Vec::new();
    }
    let mut text = html.to_string();
    for (pattern, replacement) in [
        ("<br>", "\n"),
        ("<br/>", "\n"),
        ("<br />", "\n"),
        ("<li>", "\n• "),
        ("</mainText>", "\n"),
        ("</stats>", "\n"),
        ("</rules>", "\n"),
        ("</li>", "\n"),
        ("</ul>", "\n"),
        ("</p>", "\n"),
    ] {
        text = text.replace(pattern, replacement);
    }
    for tag in ["passive", "active"] {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        text = text.replace(&open, "\n@@").replace(&close, "@@\n");
    }
    // Strip any remaining tags.
    let mut stripped = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => stripped.push(c),
            _ => {}
        }
    }
    stripped
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

#[derive(Deserialize)]
struct DdragonGold {
    #[serde(default)]
    base: i64,
    #[serde(default)]
    total: i64,
    #[serde(default)]
    sell: i64,
    #[serde(default)]
    purchasable: bool,
}

#[derive(Deserialize)]
struct DdragonItem {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    depth: Option<i64>,
    #[serde(default)]
    maps: HashMap<String, bool>,
    #[serde(default)]
    into: Vec<String>,
    #[serde(default)]
    gold: Option<DdragonGold>,
    #[serde(default)]
    stats: HashMap<String, f64>,
    #[serde(rename = "inStore", default)]
    in_store: Option<bool>,
    #[serde(rename = "hideFromAll", default)]
    hide_from_all: Option<bool>,
}

#[derive(Deserialize)]
struct DdragonItemFile {
    data: HashMap<String, DdragonItem>,
}

pub async fn fetch(client: &reqwest::Client) -> anyhow::Result<()> {
    let version = crate::champion_data::latest_version();
    let mut last_error = None;
    for attempt in 0..MAX_ATTEMPTS {
        match fetch_once(client, &version).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                tracing::error!("[DDragon] Item fetch attempt {}/{MAX_ATTEMPTS} failed: {e}", attempt + 1);
                last_error = Some(e);
                tokio::time::sleep(std::time::Duration::from_millis(2000 * (attempt as u64 + 1))).await;
            }
        }
    }
    tracing::warn!("[DDragon] All item fetch attempts failed, item list unavailable");
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("item fetch failed")))
}

async fn fetch_once(client: &reqwest::Client, version: &str) -> anyhow::Result<()> {
    let file: DdragonItemFile = client
        .get(format!(
            "https://ddragon.leagueoflegends.com/cdn/{version}/data/en_US/item.json"
        ))
        .send()
        .await?
        .json()
        .await?;

    let mut store = Store::default();

    // Raw map first: it must contain every id, including the ones filtered out
    // of the browsable list, or ownership checks break in Arena/ARAM.
    for (id_str, item) in &file.data {
        let Ok(id) = id_str.parse::<i64>() else { continue };
        store.raw.insert(
            id,
            RawItem {
                name: item.name.clone(),
                total: item.gold.as_ref().map(|g| g.total).unwrap_or(0),
                into: item.into.iter().filter_map(|s| s.parse().ok()).collect(),
            },
        );
        if !item.name.is_empty() {
            store.ids_by_name.entry(item.name.clone()).or_default().push(id);
        }
    }

    let mut list: Vec<ItemInfo> = Vec::new();
    for (id_str, item) in &file.data {
        let Ok(id) = id_str.parse::<i64>() else { continue };
        let Some(gold) = &item.gold else { continue };
        if !gold.purchasable || gold.total <= 0 {
            continue;
        }
        if item.in_store == Some(false) || item.hide_from_all == Some(true) {
            continue;
        }
        if !is_on_main_maps(&item.maps) || !is_base_game_item(id) {
            continue;
        }

        let (stats, stats_gold_value) = compute_stats(&item.stats);
        let efficiency = if gold.total > 0 {
            ((stats_gold_value / gold.total as f64) * 1000.0).round() / 10.0
        } else {
            0.0
        };
        let depth = item.depth.unwrap_or(1);

        list.push(ItemInfo {
            id,
            name: item.name.clone(),
            icon: format!("https://ddragon.leagueoflegends.com/cdn/{version}/img/item/{id}.png"),
            tags: item.tags.clone(),
            tier: classify_tier(&item.tags, depth).to_string(),
            depth,
            gold: ItemGold {
                base: gold.base,
                total: gold.total,
                sell: gold.sell,
                purchasable: gold.purchasable,
            },
            stats,
            stats_gold_value,
            efficiency,
            description_lines: description_to_lines(&item.description),
        });
    }

    // Data Dragon still lists a few same-name duplicates inside the base id
    // range; keep the lowest id, which is consistently the Summoner's Rift one.
    let mut by_name: HashMap<String, ItemInfo> = HashMap::new();
    for item in list {
        match by_name.get(&item.name) {
            Some(existing) if existing.id <= item.id => {}
            _ => {
                by_name.insert(item.name.clone(), item);
            }
        }
    }
    let mut deduped: Vec<ItemInfo> = by_name.into_values().collect();
    deduped.sort_by(|a, b| a.name.cmp(&b.name));
    store.list = deduped;

    let count = store.list.len();
    *STORE.write() = store;
    tracing::info!("[DDragon] Loaded {count} purchasable items (v{version})");
    Ok(())
}

/// One seeded item: (id, name, cost, builds-into, tags, depth).
#[doc(hidden)]
pub type SeedItem<'a> = (i64, &'a str, i64, &'a [i64], &'a [&'a str], i64);

/// Test seam: fills the store without touching the network.
#[doc(hidden)]
pub fn seed_for_tests(entries: &[SeedItem<'_>]) {
    let mut store = Store::default();
    for (id, name, total, into, tags, depth) in entries {
        store.raw.insert(
            *id,
            RawItem {
                name: name.to_string(),
                total: *total,
                into: into.to_vec(),
            },
        );
        store.ids_by_name.entry(name.to_string()).or_default().push(*id);
        let tags: Vec<String> = tags.iter().map(|t| t.to_string()).collect();
        store.list.push(ItemInfo {
            id: *id,
            name: name.to_string(),
            icon: String::new(),
            tier: classify_tier(&tags, *depth).to_string(),
            tags,
            depth: *depth,
            gold: ItemGold { base: *total, total: *total, sell: 0, purchasable: true },
            stats: vec![],
            stats_gold_value: 0.0,
            efficiency: 0.0,
            description_lines: vec![],
        });
    }
    *STORE.write() = store;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers_follow_data_dragon_depth() {
        let ap = vec!["SpellDamage".to_string()];
        assert_eq!(classify_tier(&ap, 1), "basic");
        assert_eq!(classify_tier(&ap, 2), "epic");
        assert_eq!(classify_tier(&ap, 3), "legendary");
        assert_eq!(classify_tier(&ap, 4), "legendary");
        assert_eq!(classify_tier(&["Consumable".to_string()], 1), "consumable");
        assert_eq!(classify_tier(&["Trinket".to_string()], 1), "trinket");
    }

    #[test]
    fn map_variant_ids_stay_out_of_the_browsable_list() {
        assert!(is_base_game_item(1001));
        assert!(is_base_game_item(7050));
        assert!(!is_base_game_item(223158), "Arena's Ionian Boots");
        assert!(!is_base_game_item(772004), "Arena's Mana Potion");
    }

    #[test]
    fn only_rift_and_howling_abyss_items_are_listed() {
        let rift: HashMap<String, bool> = [("11".to_string(), true), ("30".to_string(), false)].into();
        let arena: HashMap<String, bool> = [("11".to_string(), false), ("30".to_string(), true)].into();
        assert!(is_on_main_maps(&rift));
        assert!(!is_on_main_maps(&arena));
    }

    #[test]
    fn ownership_follows_the_upgrade_chain_and_map_twins() {
        let _guard = crate::test_support::lock();
        // Dark Seal -> Mejai's, with an Arena copy of Mejai's sharing the name.
        seed_for_tests(&[
            (1082, "Dark Seal", 350, &[3041], &["SpellDamage"], 1),
            (3041, "Mejai's Soulstealer", 1500, &[], &["SpellDamage"], 2),
            (773041, "Mejai's Soulstealer", 1235, &[], &["SpellDamage"], 2),
            (1001, "Boots", 300, &[3158], &["Boots"], 1),
            (3158, "Ionian Boots of Lucidity", 900, &[], &["Boots"], 2),
        ]);

        let seal = ownership_ids(1082);
        assert!(seal.contains(&1082));
        assert!(seal.contains(&3041), "an upgraded Dark Seal must clear its step");
        assert!(seal.contains(&773041), "the Arena copy counts too");
        assert!(!seal.contains(&1001));

        let boots = ownership_ids(1001);
        assert!(boots.contains(&3158));
        assert!(!boots.contains(&1082));
    }

    #[test]
    fn ownership_is_cached_and_stable() {
        let _guard = crate::test_support::lock();
        seed_for_tests(&[(1001, "Boots", 300, &[3158], &["Boots"], 1), (3158, "Ionian", 900, &[], &["Boots"], 2)]);
        assert_eq!(ownership_ids(1001), ownership_ids(1001));
    }

    #[test]
    fn efficiency_uses_the_community_gold_values() {
        // 80 AP at 21.75g each = 1740g of stats.
        let stats: HashMap<String, f64> = [("FlatMagicDamageMod".to_string(), 80.0)].into();
        let (rows, total) = compute_stats(&stats);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "Ability Power");
        assert_eq!(rows[0].value, 80.0);
        assert_eq!(total, 1740.0);
    }

    #[test]
    fn percent_stats_are_shown_as_percentages() {
        let stats: HashMap<String, f64> = [("PercentAttackSpeedMod".to_string(), 0.35)].into();
        let (rows, total) = compute_stats(&stats);
        assert_eq!(rows[0].value, 35.0);
        assert_eq!(rows[0].unit, "%");
        assert_eq!(total, 875.0);
    }

    #[test]
    fn descriptions_lose_their_markup() {
        let lines = description_to_lines(
            "<mainText><stats>50 Ability Power</stats><passive>Echo</passive>Deals damage.<br>Second line</mainText>",
        );
        assert!(lines.iter().all(|l| !l.contains('<')));
        assert!(lines.contains(&"@@Echo@@".to_string()));
        assert!(lines.contains(&"Second line".to_string()));
    }

    #[test]
    fn unknown_item_costs_nothing_rather_than_panicking() {
        let _guard = crate::test_support::lock();
        seed_for_tests(&[]);
        assert_eq!(item_cost(999999), 0);
        assert_eq!(item_name(999999), None);
        assert_eq!(ownership_ids(999999), vec![999999]);
    }
}
