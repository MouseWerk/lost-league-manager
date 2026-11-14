//! Champion reference data from Data Dragon.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

const FALLBACK_VERSION: &str = "14.1.1";
const MAX_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChampionSummary {
    pub id: i64,
    pub name: String,
    /// Data Dragon key, e.g. "MonkeyKing".
    pub key: String,
    pub icon_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChampionFull {
    pub name: String,
    pub title: String,
    pub tags: Vec<String>,
    pub partype: String,
    pub info: serde_json::Value,
    pub stats: serde_json::Value,
}

#[derive(Default)]
struct Store {
    version: String,
    /// display name lowercased -> numeric champion id
    by_name: HashMap<String, i64>,
    /// numeric id -> Data Dragon key
    id_to_key: HashMap<i64, String>,
    list: Vec<ChampionSummary>,
    full: HashMap<String, ChampionFull>,
}

static STORE: Lazy<RwLock<Store>> = Lazy::new(|| {
    RwLock::new(Store {
        version: FALLBACK_VERSION.to_string(),
        ..Default::default()
    })
});

pub fn latest_version() -> String {
    STORE.read().version.clone()
}

pub fn champion_list() -> Vec<ChampionSummary> {
    STORE.read().list.clone()
}

pub fn champion_full(key: &str) -> Option<ChampionFull> {
    STORE.read().full.get(key).cloned()
}

pub fn id_to_key_map() -> HashMap<i64, String> {
    STORE.read().id_to_key.clone()
}

pub fn champion_id_by_key(key: &str) -> Option<i64> {
    let store = STORE.read();
    store
        .id_to_key
        .iter()
        .find(|(_, k)| k.as_str() == key)
        .map(|(id, _)| *id)
}

/// Display name (lowercased) -> Data Dragon key. Needed because several keys
/// don't follow the naive "strip punctuation" rule: Wukong is MonkeyKing,
/// Cho'Gath is Chogath, Nunu & Willump is Nunu.
pub fn name_to_key_map() -> HashMap<String, String> {
    let store = STORE.read();
    store
        .by_name
        .iter()
        .filter_map(|(name, id)| store.id_to_key.get(id).map(|k| (name.clone(), k.clone())))
        .collect()
}

/// Live-game player payload -> Data Dragon key. `raw_champion_name` is the
/// localisation key ("game_character_displayname_Ahri") when the game provides
/// it, which needs no guessing; otherwise resolve the display name.
pub fn resolve_champion_key(raw_champion_name: Option<&str>, champion_name: Option<&str>) -> Option<String> {
    const PREFIX: &str = "game_character_displayname_";
    if let Some(raw) = raw_champion_name {
        if let Some(rest) = raw.strip_prefix(PREFIX) {
            return Some(rest.to_string());
        }
    }
    let display = champion_name.or(raw_champion_name)?;
    if display.is_empty() {
        return None;
    }
    if let Some(mapped) = STORE.read().by_name.get(&display.to_lowercase()) {
        if let Some(key) = STORE.read().id_to_key.get(mapped) {
            return Some(key.clone());
        }
    }
    Some(display.replace([' ', '\'', '.', '&'], ""))
}

#[derive(Deserialize)]
struct DdragonChampion {
    key: String,
    id: String,
    name: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    partype: String,
    #[serde(default)]
    info: serde_json::Value,
    #[serde(default)]
    stats: serde_json::Value,
}

#[derive(Deserialize)]
struct DdragonChampionFile {
    data: HashMap<String, DdragonChampion>,
}

pub async fn fetch(client: &reqwest::Client) -> anyhow::Result<()> {
    let mut last_error = None;
    for attempt in 0..MAX_ATTEMPTS {
        match fetch_once(client).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                tracing::error!("[DDragon] Attempt {}/{MAX_ATTEMPTS} failed: {e}", attempt + 1);
                last_error = Some(e);
                tokio::time::sleep(std::time::Duration::from_millis(2000 * (attempt as u64 + 1))).await;
            }
        }
    }
    tracing::warn!("[DDragon] All attempts failed, using fallback version {FALLBACK_VERSION}");
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("champion fetch failed")))
}

async fn fetch_once(client: &reqwest::Client) -> anyhow::Result<()> {
    let versions: Vec<String> = client
        .get("https://ddragon.leagueoflegends.com/api/versions.json")
        .send()
        .await?
        .json()
        .await?;
    let version = versions
        .first()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("empty version list"))?;

    let file: DdragonChampionFile = client
        .get(format!(
            "https://ddragon.leagueoflegends.com/cdn/{version}/data/en_US/champion.json"
        ))
        .send()
        .await?
        .json()
        .await?;

    let mut store = Store {
        version: version.clone(),
        ..Default::default()
    };
    for champ in file.data.values() {
        let id: i64 = champ.key.parse().unwrap_or(0);
        let icon_url = format!(
            "https://ddragon.leagueoflegends.com/cdn/{version}/img/champion/{}.png",
            champ.id
        );
        store.by_name.insert(champ.name.to_lowercase(), id);
        store.id_to_key.insert(id, champ.id.clone());
        store.list.push(ChampionSummary {
            id,
            name: champ.name.clone(),
            key: champ.id.clone(),
            icon_url,
        });
        store.full.insert(
            champ.id.clone(),
            ChampionFull {
                name: champ.name.clone(),
                title: champ.title.clone(),
                tags: champ.tags.clone(),
                partype: champ.partype.clone(),
                info: champ.info.clone(),
                stats: champ.stats.clone(),
            },
        );
    }
    store.list.sort_by(|a, b| a.name.cmp(&b.name));
    let count = store.list.len();
    *STORE.write() = store;

    tracing::info!("[DDragon] Loaded {count} champions (v{version})");
    Ok(())
}

/// Test seam: populate the store without touching the network.
#[doc(hidden)]
pub fn seed_for_tests(entries: &[(i64, &str, &str)], version: &str) {
    let mut store = Store {
        version: version.to_string(),
        ..Default::default()
    };
    for (id, key, name) in entries {
        store.by_name.insert(name.to_lowercase(), *id);
        store.id_to_key.insert(*id, key.to_string());
        store.list.push(ChampionSummary {
            id: *id,
            name: name.to_string(),
            key: key.to_string(),
            icon_url: String::new(),
        });
        store.full.insert(
            key.to_string(),
            ChampionFull {
                name: name.to_string(),
                title: String::new(),
                tags: vec![],
                partype: String::new(),
                info: serde_json::Value::Null,
                stats: serde_json::Value::Null,
            },
        );
    }
    *STORE.write() = store;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_the_localisation_key_without_guessing() {
        let key = resolve_champion_key(Some("game_character_displayname_MonkeyKing"), Some("Wukong"));
        assert_eq!(key.as_deref(), Some("MonkeyKing"));
    }

    #[test]
    fn falls_back_to_stripping_punctuation_when_unknown() {
        // No store seeded for this name: the naive rule still gets most names.
        let key = resolve_champion_key(None, Some("Miss Fortune"));
        assert_eq!(key.as_deref(), Some("MissFortune"));
        assert_eq!(resolve_champion_key(None, Some("Dr. Mundo")).as_deref(), Some("DrMundo"));
    }

    #[test]
    fn no_name_resolves_to_nothing() {
        assert_eq!(resolve_champion_key(None, None), None);
        assert_eq!(resolve_champion_key(None, Some("")), None);
    }
}
