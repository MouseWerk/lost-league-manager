//! Recommended builds scraped from OP.GG.
//!
//! Two extraction paths, same as the Node build: the page's `__NEXT_DATA__`
//! JSON when it's there, and an ordered sweep of item icon URLs when it isn't.
//! The fallback classifies purely by id range, so callers must sanity-check
//! what comes back (see `build_paths::import_from_opgg`).

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

const OPGG_BASE: &str = "https://www.op.gg/champions";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/// Known boot item ids, used to split boots out of the flat icon sweep.
const BOOT_IDS: &[i64] = &[3006, 3009, 3010, 3020, 3047, 3111, 3117, 3158];

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Builds {
    pub champ_key: String,
    pub starting: Vec<i64>,
    pub boots: Vec<i64>,
    pub core: Vec<i64>,
    pub optional: Vec<i64>,
}

fn position_slug(position: Option<&str>) -> &'static str {
    match position.unwrap_or("").to_uppercase().as_str() {
        "TOP" => "top",
        "JUNGLE" => "jungle",
        "MIDDLE" | "MID" => "mid",
        "BOTTOM" | "ADC" => "adc",
        "UTILITY" | "SUPPORT" => "support",
        "ARAM" => "aram",
        _ => "",
    }
}

/// Data Dragon key -> OP.GG url slug.
fn champ_slug(champ_key: &str) -> String {
    champ_key.to_lowercase().replace(['\'', '.'], "")
}

fn is_item_id(n: i64) -> bool {
    (1001..=9999).contains(&n)
}

/// Depth-first hunt for an array of item ids, checking the likely key names
/// first so known sections surface before an arbitrary match does.
fn find_section(value: &Value, target_keys: &[&str], depth: usize) -> Option<Vec<i64>> {
    if depth > 12 {
        return None;
    }
    match value {
        Value::Array(items) => {
            let ids: Vec<i64> = items
                .iter()
                .filter_map(|entry| match entry {
                    Value::Number(n) => n.as_i64().filter(|v| is_item_id(*v)),
                    Value::Object(o) => ["id", "itemId", "item_id"]
                        .iter()
                        .find_map(|k| o.get(*k).and_then(|v| v.as_i64()))
                        .filter(|v| is_item_id(*v)),
                    _ => None,
                })
                .collect();
            (!ids.is_empty()).then_some(ids)
        }
        Value::Object(map) => {
            for key in target_keys {
                if let Some(child) = map.get(*key) {
                    if let Some(found) = find_section(child, target_keys, depth + 1) {
                        return Some(found);
                    }
                }
            }
            map.values()
                .find_map(|child| find_section(child, target_keys, depth + 1))
        }
        _ => None,
    }
}

fn extract_from_next_data(json: &Value) -> Option<Builds> {
    let root = json
        .get("props")
        .and_then(|p| p.get("pageProps"))
        .unwrap_or(json);

    let starting = find_section(root, &["starting", "startingItems", "starting_items", "starter"], 0);
    let boots = find_section(root, &["boots", "bootsItems", "boot"], 0);
    let core = find_section(root, &["core", "coreItems", "core_items", "mythic", "build"], 0);
    let optional = find_section(root, &["last", "lastItems", "situational", "optional"], 0);

    if core.is_none() && starting.is_none() {
        return None;
    }
    Some(Builds {
        champ_key: String::new(),
        starting: starting.unwrap_or_default().into_iter().take(4).collect(),
        boots: boots.unwrap_or_default().into_iter().take(2).collect(),
        core: core.unwrap_or_default().into_iter().take(6).collect(),
        optional: optional.unwrap_or_default().into_iter().take(4).collect(),
    })
}

static ITEM_ICON_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"/item/(\d{4,5})\.png").unwrap());
static NEXT_DATA_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?s)<script id="__NEXT_DATA__"[^>]*>(.*?)</script>"#).unwrap()
});

/// Collect item ids from icon URLs in page order, then split them by id range:
/// 1001–2999 are typically starters/components, 3000+ finished items, with
/// known boots pulled out.
fn extract_from_html(html: &str) -> Option<Builds> {
    let mut seen = std::collections::HashSet::new();
    let mut all: Vec<i64> = Vec::new();
    for cap in ITEM_ICON_RE.captures_iter(html) {
        if let Ok(id) = cap[1].parse::<i64>() {
            if is_item_id(id) && seen.insert(id) {
                all.push(id);
            }
        }
    }
    if all.len() < 3 {
        return None;
    }

    let starting: Vec<i64> = all.iter().copied().filter(|id| *id < 3000).take(4).collect();
    let boots: Vec<i64> = all.iter().copied().filter(|id| BOOT_IDS.contains(id)).take(2).collect();
    let rest: Vec<i64> = all
        .iter()
        .copied()
        .filter(|id| *id >= 3000 && !BOOT_IDS.contains(id))
        .collect();

    Some(Builds {
        champ_key: String::new(),
        starting,
        boots,
        core: rest.iter().copied().take(6).collect(),
        optional: rest.iter().copied().skip(6).take(4).collect(),
    })
}

pub async fn get_builds(
    client: &reqwest::Client,
    champ_key: &str,
    game_mode: Option<&str>,
    position: Option<&str>,
) -> Option<Builds> {
    let is_aram = game_mode.unwrap_or("").eq_ignore_ascii_case("ARAM");
    let pos = if is_aram { "aram" } else { position_slug(position) };
    let slug = champ_slug(champ_key);
    let url = if pos.is_empty() {
        format!("{OPGG_BASE}/{slug}/build")
    } else {
        format!("{OPGG_BASE}/{slug}/build/{pos}")
    };

    let html = match client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Accept-Language", "en-US,en;q=0.5")
        .header("Referer", "https://www.op.gg/")
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
    {
        Ok(res) => match res.text().await {
            Ok(text) => text,
            Err(e) => {
                tracing::info!("[Builds] {champ_key}: {e}");
                return None;
            }
        },
        Err(e) => {
            tracing::info!("[Builds] {champ_key}: {e}");
            return None;
        }
    };

    if let Some(caps) = NEXT_DATA_RE.captures(&html) {
        if let Ok(json) = serde_json::from_str::<Value>(&caps[1]) {
            if let Some(mut builds) = extract_from_next_data(&json) {
                if !builds.core.is_empty() || !builds.starting.is_empty() {
                    builds.champ_key = champ_key.to_string();
                    tracing::info!("[Builds] {champ_key}/{} via __NEXT_DATA__", if pos.is_empty() { "default" } else { pos });
                    return Some(builds);
                }
            }
        }
    }

    if let Some(mut builds) = extract_from_html(&html) {
        builds.champ_key = champ_key.to_string();
        tracing::info!(
            "[Builds] {champ_key}/{} via HTML fallback ({} core items)",
            if pos.is_empty() { "default" } else { pos },
            builds.core.len()
        );
        return Some(builds);
    }

    tracing::info!("[Builds] {champ_key}: no data found at {url}");
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_positions_to_opgg_slugs() {
        assert_eq!(position_slug(Some("MIDDLE")), "mid");
        assert_eq!(position_slug(Some("bottom")), "adc");
        assert_eq!(position_slug(Some("UTILITY")), "support");
        assert_eq!(position_slug(Some("JUNGLE")), "jungle");
        assert_eq!(position_slug(None), "");
        assert_eq!(position_slug(Some("nonsense")), "");
    }

    #[test]
    fn champion_keys_become_url_slugs() {
        assert_eq!(champ_slug("Ahri"), "ahri");
        assert_eq!(champ_slug("Cho'Gath"), "chogath");
        assert_eq!(champ_slug("Dr.Mundo"), "drmundo");
        assert_eq!(champ_slug("MonkeyKing"), "monkeyking");
    }

    #[test]
    fn html_fallback_splits_icons_by_id_range() {
        let html = r#"
            <img src="https://opgg-static/item/1056.png">
            <img src="https://opgg-static/item/2003.png">
            <img src="https://opgg-static/item/3158.png">
            <img src="https://opgg-static/item/6655.png">
            <img src="https://opgg-static/item/3157.png">
            <img src="https://opgg-static/item/3157.png">
        "#;
        let builds = extract_from_html(html).unwrap();
        assert_eq!(builds.starting, vec![1056, 2003]);
        assert_eq!(builds.boots, vec![3158]);
        assert_eq!(builds.core, vec![6655, 3157], "deduplicated, in page order");
    }

    #[test]
    fn html_fallback_gives_up_on_a_page_with_no_items() {
        assert_eq!(extract_from_html("<html>nothing here</html>"), None);
    }

    #[test]
    fn next_data_extraction_finds_named_sections() {
        let json: Value = serde_json::from_str(
            r#"{"props":{"pageProps":{"data":{
                "starting":[1056,2003],
                "boots":[3158],
                "core":[6655,3157,3089]
            }}}}"#,
        )
        .unwrap();
        let builds = extract_from_next_data(&json).unwrap();
        assert_eq!(builds.starting, vec![1056, 2003]);
        assert_eq!(builds.boots, vec![3158]);
        assert_eq!(builds.core, vec![6655, 3157, 3089]);
    }

    #[test]
    fn next_data_reads_arrays_of_objects_too() {
        let json: Value = serde_json::from_str(
            r#"{"core":[{"id":6655},{"itemId":3157},{"item_id":3089}]}"#,
        )
        .unwrap();
        let builds = extract_from_next_data(&json).unwrap();
        assert_eq!(builds.core, vec![6655, 3157, 3089]);
    }

    #[test]
    fn next_data_with_nothing_usable_is_none() {
        let json: Value = serde_json::from_str(r#"{"props":{"pageProps":{"unrelated":true}}}"#).unwrap();
        assert_eq!(extract_from_next_data(&json), None);
    }
}
