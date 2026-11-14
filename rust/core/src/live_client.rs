//! Riot's Live Client Data API — the small HTTP server the game itself runs on
//! 127.0.0.1:2999 during a match.
//!
//! It ships with League, needs no auth, no API key and no third-party runtime,
//! which is why the build reminder reads gold from here. The certificate it
//! presents is Riot's own self-signed one, so verification is off for this
//! host; the request never leaves the loopback interface.

use serde::Deserialize;

const HTTPS_BASE: &str = "https://127.0.0.1:2999/liveclientdata";
const HTTP_BASE: &str = "http://127.0.0.1:2999/liveclientdata";

pub const IDLE_POLL_MS: u64 = 5_000; // no game running — just probing
pub const LIVE_POLL_MS: u64 = 1_000; // in a match — gold changes constantly

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ActivePlayer {
    #[serde(default, rename = "summonerName")]
    pub summoner_name: Option<String>,
    #[serde(default, rename = "riotIdGameName")]
    pub riot_id_game_name: Option<String>,
    #[serde(default, rename = "riotId")]
    pub riot_id: Option<String>,
    #[serde(default, rename = "currentGold")]
    pub current_gold: Option<f64>,
    #[serde(default)]
    pub level: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct PlayerItem {
    #[serde(default, rename = "itemID")]
    pub item_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Player {
    #[serde(default, rename = "summonerName")]
    pub summoner_name: Option<String>,
    #[serde(default, rename = "riotIdGameName")]
    pub riot_id_game_name: Option<String>,
    #[serde(default, rename = "riotId")]
    pub riot_id: Option<String>,
    #[serde(default, rename = "championName")]
    pub champion_name: Option<String>,
    #[serde(default, rename = "rawChampionName")]
    pub raw_champion_name: Option<String>,
    #[serde(default)]
    pub items: Vec<PlayerItem>,
    #[serde(default, rename = "isDead")]
    pub is_dead: Option<bool>,
}

impl Player {
    pub fn item_ids(&self) -> Vec<i64> {
        self.items.iter().filter_map(|i| i.item_id).collect()
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GameData {
    #[serde(default, rename = "gameTime")]
    pub game_time: Option<f64>,
    #[serde(default, rename = "gameMode")]
    pub game_mode: Option<String>,
}

/// One `/allgamedata` response.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Snapshot {
    #[serde(default, rename = "activePlayer")]
    pub active_player: Option<ActivePlayer>,
    #[serde(default, rename = "allPlayers")]
    pub all_players: Vec<Player>,
    #[serde(default, rename = "gameData")]
    pub game_data: Option<GameData>,
}

/// Every name the game might identify a player by, lowercased, plus the part
/// before the '#'. The active player and the roster entry for the same person
/// don't always spell it the same way — one carries a bare game name, the other
/// a full Riot ID.
fn identity_keys(values: &[Option<&str>]) -> Vec<String> {
    let mut out = Vec::new();
    for value in values.iter().flatten() {
        if value.is_empty() {
            continue;
        }
        let lower = value.to_lowercase();
        if let Some((before, _)) = lower.split_once('#') {
            if !before.is_empty() {
                out.push(before.to_string());
            }
        }
        out.push(lower);
    }
    out
}

impl Snapshot {
    pub fn current_gold(&self) -> Option<i64> {
        self.active_player.as_ref()?.current_gold.map(|g| g.floor() as i64)
    }

    /// The local player's row in the roster.
    pub fn me(&self) -> Option<&Player> {
        let active = self.active_player.as_ref()?;
        let mine = identity_keys(&[
            active.riot_id_game_name.as_deref(),
            active.summoner_name.as_deref(),
            active.riot_id.as_deref(),
        ]);
        if mine.is_empty() {
            return None;
        }
        self.all_players.iter().find(|p| {
            identity_keys(&[
                p.riot_id_game_name.as_deref(),
                p.summoner_name.as_deref(),
                p.riot_id.as_deref(),
            ])
            .iter()
            .any(|k| mine.contains(k))
        })
    }

    #[doc(hidden)]
    pub fn for_tests(active_name: &str, roster_name: &str, champion: &str, gold: i64, items: &[i64]) -> Self {
        Snapshot {
            active_player: Some(ActivePlayer {
                summoner_name: Some(active_name.to_string()),
                current_gold: Some(gold as f64),
                ..Default::default()
            }),
            all_players: vec![
                Player {
                    summoner_name: Some("SomeoneElse".into()),
                    champion_name: Some("Garen".into()),
                    ..Default::default()
                },
                Player {
                    summoner_name: Some(roster_name.to_string()),
                    riot_id_game_name: Some(roster_name.to_string()),
                    champion_name: Some(champion.to_string()),
                    raw_champion_name: Some(format!("game_character_displayname_{champion}")),
                    items: items.iter().map(|id| PlayerItem { item_id: Some(*id) }).collect(),
                    is_dead: Some(false),
                    ..Default::default()
                },
            ],
            game_data: Some(GameData { game_time: Some(300.0), game_mode: Some("CLASSIC".into()) }),
        }
    }
}

pub struct LiveClient {
    client: reqwest::Client,
    base: &'static str,
    base_confirmed: bool,
    in_game: bool,
}

impl LiveClient {
    pub fn new() -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true) // Riot's self-signed loopback cert
            .timeout(std::time::Duration::from_millis(2500))
            .build()?;
        Ok(Self { client, base: HTTPS_BASE, base_confirmed: false, in_game: false })
    }

    pub fn in_game(&self) -> bool {
        self.in_game
    }

    pub fn poll_interval(&self) -> std::time::Duration {
        std::time::Duration::from_millis(if self.in_game { LIVE_POLL_MS } else { IDLE_POLL_MS })
    }

    async fn get(&self, base: &str) -> Option<Snapshot> {
        let res = self.client.get(format!("{base}/allgamedata")).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        res.json::<Snapshot>().await.ok()
    }

    /// Everything the reminder needs in one request. None whenever there's no
    /// match in progress — including the loading screen, where the server is up
    /// but answers with errors.
    pub async fn fetch(&mut self) -> Option<Snapshot> {
        if let Some(snapshot) = self.get(self.base).await {
            self.base_confirmed = true;
            self.set_in_game(true);
            return Some(snapshot);
        }
        // Be forgiving about the scheme until one is known to work, rather than
        // silently never connecting if Riot ever changes it.
        if !self.base_confirmed {
            let alt = if self.base == HTTPS_BASE { HTTP_BASE } else { HTTPS_BASE };
            if let Some(snapshot) = self.get(alt).await {
                self.base = alt;
                self.base_confirmed = true;
                tracing::info!("[LiveClient] Using {alt}");
                self.set_in_game(true);
                return Some(snapshot);
            }
        }
        self.set_in_game(false);
        None
    }

    fn set_in_game(&mut self, value: bool) {
        if self.in_game != value {
            self.in_game = value;
            tracing::info!("[LiveClient] {}", if value { "Match detected" } else { "Match ended" });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL_SHAPE: &str = r#"{
        "activePlayer": {
            "summonerName": "Tester#EUW",
            "currentGold": 654.7,
            "level": 6
        },
        "allPlayers": [
            { "summonerName": "Other", "championName": "Garen", "items": [] },
            {
                "summonerName": "Tester",
                "riotIdGameName": "Tester",
                "championName": "Ahri",
                "rawChampionName": "game_character_displayname_Ahri",
                "isDead": false,
                "items": [ { "itemID": 1082, "count": 1 }, { "itemID": 1001 } ]
            }
        ],
        "gameData": { "gameTime": 421.5, "gameMode": "CLASSIC" }
    }"#;

    #[test]
    fn parses_a_real_shaped_payload() {
        let snap: Snapshot = serde_json::from_str(REAL_SHAPE).unwrap();
        assert_eq!(snap.current_gold(), Some(654), "gold floors, never rounds up");
        let me = snap.me().expect("finds the local player");
        assert_eq!(me.champion_name.as_deref(), Some("Ahri"));
        assert_eq!(me.item_ids(), vec![1082, 1001]);
    }

    #[test]
    fn matches_me_across_riot_id_and_game_name_spellings() {
        // Active player carries the tagged Riot ID, the roster carries the bare
        // game name — the pairing the live client actually produces.
        let snap: Snapshot = serde_json::from_str(REAL_SHAPE).unwrap();
        assert!(snap.me().is_some());

        let flipped: Snapshot = serde_json::from_str(
            r#"{"activePlayer":{"summonerName":"Tester","currentGold":10},
                "allPlayers":[{"riotIdGameName":"Tester","riotId":"Tester#EUW","championName":"Ahri"}]}"#,
        )
        .unwrap();
        assert!(flipped.me().is_some(), "and the other way around");
    }

    #[test]
    fn an_unknown_player_is_not_mistaken_for_me() {
        let snap: Snapshot = serde_json::from_str(
            r#"{"activePlayer":{"summonerName":"Me"},
                "allPlayers":[{"summonerName":"SomeoneElse","championName":"Garen"}]}"#,
        )
        .unwrap();
        assert!(snap.me().is_none());
    }

    #[test]
    fn missing_pieces_do_not_panic() {
        let empty: Snapshot = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.current_gold(), None);
        assert!(empty.me().is_none());
    }

    #[test]
    fn unknown_fields_from_a_future_patch_are_ignored() {
        let snap: Snapshot = serde_json::from_str(
            r#"{"activePlayer":{"currentGold":100,"brandNewField":42},"somethingElse":[1,2,3]}"#,
        )
        .unwrap();
        assert_eq!(snap.current_gold(), Some(100));
    }

    #[test]
    fn poll_interval_speeds_up_in_a_match() {
        let mut lc = LiveClient::new().unwrap();
        assert_eq!(lc.poll_interval().as_millis(), IDLE_POLL_MS as u128);
        lc.set_in_game(true);
        assert_eq!(lc.poll_interval().as_millis(), LIVE_POLL_MS as u128);
    }
}
