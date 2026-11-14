//! Riot Developer API: ranked stats, mastery and recent matches for an
//! account the League client isn't currently logged into.

use serde::{Deserialize, Serialize};

use crate::{champion_data, rank_history};

/// User-facing region strings -> Riot platform routing values. CN is absent
/// from the developer API entirely: Tencent operates those servers separately.
const REGION_TO_PLATFORM: &[(&str, &str)] = &[
    ("na", "na1"), ("na1", "na1"),
    ("euw", "euw1"), ("euw1", "euw1"),
    ("eune", "eun1"), ("eun1", "eun1"),
    ("kr", "kr"),
    ("sea", "sea"),
    ("br", "br1"), ("br1", "br1"),
    ("las", "la1"), ("la1", "la1"),
    ("lan", "la2"), ("la2", "la2"),
    ("oce", "oc1"), ("oc1", "oc1"),
    ("tr", "tr1"), ("tr1", "tr1"),
    ("ru", "ru"),
    ("jp", "jp1"), ("jp1", "jp1"),
    ("ph", "ph2"), ("ph2", "ph2"),
    ("sg", "sg2"), ("sg2", "sg2"),
    ("th", "th2"), ("th2", "th2"),
    ("tw", "tw2"), ("tw2", "tw2"),
    ("vn", "vn2"), ("vn2", "vn2"),
    ("cn", "cn"),
];

const PLATFORM_TO_REGIONAL: &[(&str, &str)] = &[
    ("na1", "americas"), ("br1", "americas"), ("la1", "americas"), ("la2", "americas"),
    ("euw1", "europe"), ("eun1", "europe"), ("tr1", "europe"), ("ru", "europe"),
    ("kr", "asia"), ("jp1", "asia"),
    ("sea", "sea"), ("oc1", "sea"), ("ph2", "sea"), ("sg2", "sea"),
    ("th2", "sea"), ("tw2", "sea"), ("vn2", "sea"),
];

pub fn platform_for(region: &str) -> &'static str {
    REGION_TO_PLATFORM
        .iter()
        .find(|(name, _)| *name == region.to_lowercase())
        .map(|(_, p)| *p)
        .unwrap_or("euw1")
}

pub fn regional_for(platform: &str) -> &'static str {
    PLATFORM_TO_REGIONAL
        .iter()
        .find(|(p, _)| *p == platform)
        .map(|(_, r)| *r)
        .unwrap_or("europe")
}

fn cap_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => String::new(),
    }
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RankedSummary {
    pub tier: String,
    pub lp: String,
    pub win_lose: String,
    pub ratio: String,
    /// Unformatted, for rank history. Riot's ranked-entries API calls the
    /// division `rank`, unlike the LCU's `division` for the same idea.
    #[serde(skip)]
    pub raw_tier: String,
    #[serde(skip)]
    pub raw_division: String,
    #[serde(skip)]
    pub raw_lp: i64,
}

impl RankedSummary {
    pub fn unranked() -> Self {
        Self { tier: "Unranked".into(), ..Default::default() }
    }
}

#[derive(Debug, Deserialize)]
struct LeagueEntry {
    #[serde(rename = "queueType", default)]
    queue_type: String,
    #[serde(default)]
    tier: String,
    #[serde(default)]
    rank: String,
    #[serde(rename = "leaguePoints", default)]
    league_points: i64,
    #[serde(default)]
    wins: i64,
    #[serde(default)]
    losses: i64,
}

fn format_entry(entry: &LeagueEntry) -> Option<RankedSummary> {
    if entry.tier.is_empty() || entry.tier.eq_ignore_ascii_case("UNRANKED") {
        return None;
    }
    let is_apex = ["MASTER", "GRANDMASTER", "CHALLENGER"].contains(&entry.tier.as_str());
    let tier = if is_apex {
        cap_first(&entry.tier)
    } else {
        format!("{} {}", cap_first(&entry.tier), entry.rank).trim().to_string()
    };
    let total = entry.wins + entry.losses;
    Some(RankedSummary {
        tier,
        lp: format!("{} LP", entry.league_points),
        win_lose: format!("{}W {}L", entry.wins, entry.losses),
        ratio: if total > 0 {
            format!("{}%", (entry.wins as f64 / total as f64 * 100.0).round() as i64)
        } else {
            String::new()
        },
        raw_tier: entry.tier.clone(),
        raw_division: entry.rank.clone(),
        raw_lp: entry.league_points,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MasteryChampion {
    pub name: String,
    pub icon: Option<String>,
    pub points: i64,
    pub level: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub success: bool,
    pub tier: String,
    pub lp: String,
    pub win_lose: String,
    pub ratio: String,
    pub flex_tier: String,
    pub flex_lp: String,
    pub flex_win_lose: String,
    pub flex_ratio: String,
    pub mastery_champions: Vec<MasteryChampion>,
    pub icon_src: String,
    pub level: String,
    pub source: String,
}

#[derive(Debug, Deserialize)]
struct AccountDto {
    puuid: String,
}

#[derive(Debug, Deserialize)]
struct SummonerDto {
    #[serde(rename = "profileIconId", default)]
    profile_icon_id: Option<i64>,
    #[serde(rename = "summonerLevel", default)]
    summoner_level: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct MasteryDto {
    #[serde(rename = "championId")]
    champion_id: i64,
    #[serde(rename = "championPoints", default)]
    champion_points: i64,
    #[serde(rename = "championLevel", default)]
    champion_level: i64,
}

async fn get_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
) -> anyhow::Result<T> {
    let response = client
        .get(url)
        .header("X-Riot-Token", api_key)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;

    match response.status().as_u16() {
        200 => Ok(response.json().await?),
        401 | 403 => anyhow::bail!("Riot API key rejected — it may have expired (they last 24h for development keys)"),
        404 => anyhow::bail!("Account not found on that region"),
        429 => anyhow::bail!("Riot API rate limit reached — try again in a minute"),
        other => anyhow::bail!("Riot API returned {other}"),
    }
}

pub async fn get_stats(
    client: &reqwest::Client,
    api_key: &str,
    game_name: &str,
    tag_line: &str,
    region: &str,
) -> anyhow::Result<Stats> {
    if api_key.is_empty() {
        anyhow::bail!("No Riot API key set — add one in Settings → Riot API Key");
    }
    if region.eq_ignore_ascii_case("cn") {
        anyhow::bail!(
            "CN server stats require the League client to be running (Tencent servers are not on the Riot API)"
        );
    }

    let platform = platform_for(region);
    let regional = regional_for(platform);

    let account: AccountDto = get_json(
        client,
        &format!(
            "https://{regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/{}/{}",
            urlencode(game_name),
            urlencode(tag_line)
        ),
        api_key,
    )
    .await?;

    let summoner: SummonerDto = get_json(
        client,
        &format!(
            "https://{platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/{}",
            account.puuid
        ),
        api_key,
    )
    .await?;

    let entries: Vec<LeagueEntry> = get_json(
        client,
        &format!(
            "https://{platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/{}",
            account.puuid
        ),
        api_key,
    )
    .await?;

    let solo = entries
        .iter()
        .find(|e| e.queue_type == "RANKED_SOLO_5x5")
        .and_then(format_entry)
        .unwrap_or_else(RankedSummary::unranked);
    let flex = entries
        .iter()
        .find(|e| e.queue_type == "RANKED_FLEX_SR")
        .and_then(format_entry)
        .unwrap_or_else(RankedSummary::unranked);

    if !solo.raw_tier.is_empty() {
        rank_history::record(
            &format!("{game_name}#{tag_line}"),
            &solo.raw_tier,
            &solo.raw_division,
            solo.raw_lp,
        );
    }

    // Best effort: a mastery hiccup shouldn't fail the whole card.
    let mastery_champions = match get_json::<Vec<MasteryDto>>(
        client,
        &format!(
            "https://{platform}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/{}/top?count=3",
            account.puuid
        ),
        api_key,
    )
    .await
    {
        Ok(top) => {
            let id_to_key = champion_data::id_to_key_map();
            top.into_iter()
                .map(|c| {
                    let key = id_to_key.get(&c.champion_id).cloned();
                    let full = key.as_ref().and_then(|k| champion_data::champion_full(k));
                    MasteryChampion {
                        name: full
                            .map(|f| f.name)
                            .or_else(|| key.clone())
                            .unwrap_or_else(|| format!("Champion {}", c.champion_id)),
                        icon: key.map(|k| {
                            format!(
                                "https://ddragon.leagueoflegends.com/cdn/{}/img/champion/{k}.png",
                                champion_data::latest_version()
                            )
                        }),
                        points: c.champion_points,
                        level: c.champion_level,
                    }
                })
                .collect()
        }
        Err(e) => {
            tracing::info!("[Stats] mastery lookup failed: {e}");
            Vec::new()
        }
    };

    let version = champion_data::latest_version();
    let icon_id = summoner.profile_icon_id.unwrap_or(29);

    Ok(Stats {
        success: true,
        tier: solo.tier,
        lp: solo.lp,
        win_lose: solo.win_lose,
        ratio: solo.ratio,
        flex_tier: flex.tier,
        flex_lp: flex.lp,
        flex_win_lose: flex.win_lose,
        flex_ratio: flex.ratio,
        mastery_champions,
        icon_src: format!(
            "https://ddragon.leagueoflegends.com/cdn/{version}/img/profileicon/{icon_id}.png"
        ),
        level: summoner.summoner_level.map(|l| l.to_string()).unwrap_or_default(),
        source: "riot-api".into(),
    })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MatchSummary {
    pub match_id: String,
    pub win: bool,
    /// Data Dragon key, e.g. "MonkeyKing".
    pub champion_name: String,
    pub kda: String,
}

#[derive(Debug, Deserialize)]
struct MatchDto {
    info: MatchInfo,
}

#[derive(Debug, Deserialize)]
struct MatchInfo {
    #[serde(default)]
    participants: Vec<Participant>,
}

#[derive(Debug, Deserialize)]
struct Participant {
    #[serde(default)]
    puuid: String,
    #[serde(default)]
    win: bool,
    #[serde(rename = "championName", default)]
    champion_name: String,
    #[serde(default)]
    kills: i64,
    #[serde(default)]
    deaths: i64,
    #[serde(default)]
    assists: i64,
}

/// The recent-games strip on the profile card.
pub async fn get_match_history(
    client: &reqwest::Client,
    api_key: &str,
    game_name: &str,
    tag_line: &str,
    region: &str,
    count: usize,
) -> anyhow::Result<Vec<MatchSummary>> {
    if api_key.is_empty() {
        anyhow::bail!("No Riot API key set — add one in Settings → Riot API Key");
    }
    let platform = platform_for(region);
    let regional = regional_for(platform);

    let account: AccountDto = get_json(
        client,
        &format!(
            "https://{regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/{}/{}",
            urlencode(game_name),
            urlencode(tag_line)
        ),
        api_key,
    )
    .await?;

    let ids: Vec<String> = get_json(
        client,
        &format!(
            "https://{regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/{}/ids?start=0&count={count}",
            account.puuid
        ),
        api_key,
    )
    .await?;

    let mut out = Vec::new();
    for match_id in ids {
        // One bad match (a remake the API still lists, say) shouldn't sink the
        // whole strip — skip it rather than failing the batch.
        let detail: MatchDto = match get_json(
            client,
            &format!("https://{regional}.api.riotgames.com/lol/match/v5/matches/{match_id}"),
            api_key,
        )
        .await
        {
            Ok(value) => value,
            Err(e) => {
                tracing::info!("[MatchHistory] {match_id}: {e}");
                continue;
            }
        };
        if let Some(me) = detail.info.participants.iter().find(|p| p.puuid == account.puuid) {
            out.push(MatchSummary {
                match_id,
                win: me.win,
                champion_name: me.champion_name.clone(),
                kda: format!("{}/{}/{}", me.kills, me.deaths, me.assists),
            });
        }
    }
    Ok(out)
}

/// Minimal percent-encoding for a Riot ID path segment.
fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regions_map_to_platforms() {
        assert_eq!(platform_for("euw"), "euw1");
        assert_eq!(platform_for("EUW1"), "euw1");
        assert_eq!(platform_for("kr"), "kr");
        assert_eq!(platform_for("lan"), "la2");
        assert_eq!(platform_for("unknown-region"), "euw1", "falls back rather than failing");
    }

    #[test]
    fn platforms_map_to_regional_hosts() {
        assert_eq!(regional_for("na1"), "americas");
        assert_eq!(regional_for("euw1"), "europe");
        assert_eq!(regional_for("kr"), "asia");
        assert_eq!(regional_for("oc1"), "sea");
    }

    #[test]
    fn formats_a_ranked_entry_the_way_the_ui_expects() {
        let entry = LeagueEntry {
            queue_type: "RANKED_SOLO_5x5".into(),
            tier: "GOLD".into(),
            rank: "II".into(),
            league_points: 41,
            wins: 30,
            losses: 20,
        };
        let s = format_entry(&entry).unwrap();
        assert_eq!(s.tier, "Gold II");
        assert_eq!(s.lp, "41 LP");
        assert_eq!(s.win_lose, "30W 20L");
        assert_eq!(s.ratio, "60%");
        assert_eq!((s.raw_tier.as_str(), s.raw_division.as_str(), s.raw_lp), ("GOLD", "II", 41));
    }

    #[test]
    fn apex_tiers_drop_the_division() {
        let entry = LeagueEntry {
            queue_type: "RANKED_SOLO_5x5".into(),
            tier: "CHALLENGER".into(),
            rank: "I".into(),
            league_points: 1200,
            wins: 100,
            losses: 50,
        };
        assert_eq!(format_entry(&entry).unwrap().tier, "Challenger");
    }

    #[test]
    fn an_unplayed_queue_has_no_win_rate() {
        let entry = LeagueEntry {
            queue_type: "RANKED_FLEX_SR".into(),
            tier: "SILVER".into(),
            rank: "IV".into(),
            league_points: 0,
            wins: 0,
            losses: 0,
        };
        assert_eq!(format_entry(&entry).unwrap().ratio, "");
    }

    #[test]
    fn unranked_entries_format_to_nothing() {
        let entry = LeagueEntry {
            queue_type: "RANKED_SOLO_5x5".into(),
            tier: String::new(),
            rank: String::new(),
            league_points: 0,
            wins: 0,
            losses: 0,
        };
        assert!(format_entry(&entry).is_none());
    }

    #[test]
    fn riot_ids_with_spaces_and_symbols_are_encoded() {
        assert_eq!(urlencode("Some Name"), "Some%20Name");
        assert_eq!(urlencode("tag#1"), "tag%231");
        assert_eq!(urlencode("plain"), "plain");
    }

    #[test]
    fn a_match_maps_to_the_strip_entry_for_me() {
        let detail: MatchDto = serde_json::from_str(
            r#"{"info":{"participants":[
                {"puuid":"other","win":true,"championName":"Garen","kills":9,"deaths":1,"assists":3},
                {"puuid":"mine","win":false,"championName":"MonkeyKing","kills":2,"deaths":7,"assists":4}
            ]}}"#,
        )
        .unwrap();
        let me = detail.info.participants.iter().find(|p| p.puuid == "mine").unwrap();
        assert!(!me.win);
        assert_eq!(me.champion_name, "MonkeyKing");
        assert_eq!(format!("{}/{}/{}", me.kills, me.deaths, me.assists), "2/7/4");
    }

    #[tokio::test]
    async fn match_history_needs_an_api_key_too() {
        let client = reqwest::Client::new();
        let err = get_match_history(&client, "", "Name", "EUW", "euw", 5).await.unwrap_err();
        assert!(err.to_string().contains("No Riot API key"), "{err}");
    }

    #[tokio::test]
    async fn a_missing_api_key_fails_with_a_useful_message() {
        let client = reqwest::Client::new();
        let err = get_stats(&client, "", "Name", "EUW", "euw").await.unwrap_err();
        assert!(err.to_string().contains("No Riot API key"), "{err}");
    }

    #[tokio::test]
    async fn cn_is_rejected_before_any_request() {
        let client = reqwest::Client::new();
        let err = get_stats(&client, "key", "Name", "CN", "cn").await.unwrap_err();
        assert!(err.to_string().contains("CN server"), "{err}");
    }
}
