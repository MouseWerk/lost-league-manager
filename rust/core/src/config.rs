//! Persisted app settings.
//!
//! The Node build kept a hand-written whitelist of settable keys with a type
//! check per key, because `set-config` used to `Object.assign` raw renderer
//! input straight into live config. Here the struct *is* the whitelist: serde
//! rejects unknown keys and wrong types on the way in, so a compromised or
//! buggy frontend can't inject `riotApiKey` or `vaultPasswordHash` with the
//! wrong shape.

use serde::{Deserialize, Serialize};

use crate::{json_store, paths};

fn default_lol_path() -> String {
    r"C:\Riot Games\League of Legends\LeagueClient.exe".to_string()
}
fn default_scale() -> f64 {
    1.0
}
fn default_hotkey() -> String {
    "Ctrl+Shift+H".to_string()
}

/// Field names match the JSON the Node build wrote, so an existing config.json
/// loads unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub lol_path: String,
    pub auto_accept: bool,
    pub overlay_enabled: bool,
    pub overlay_show_ranked: bool,
    pub overlay_show_builds: bool,
    pub overlay_opacity: f64,
    pub overlay_hotkey: String,
    pub overlay_locked: bool,
    pub build_reminders_enabled: bool,
    pub build_reminder_popup: bool,
    pub build_reminder_toast: bool,
    pub ui_scale: f64,
    pub start_with_windows: bool,
    pub start_minimized: bool,
    pub minimize_on_game_start: bool,
    pub check_updates_on_startup: bool,
    pub toast_on_queue_pop: bool,
    pub discord_rpc_enabled: bool,
    pub riot_api_key: String,
    pub vault_enabled: bool,
    pub vault_password_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_patch_notes_version: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            lol_path: default_lol_path(),
            auto_accept: false,
            overlay_enabled: false,
            overlay_show_ranked: true,
            overlay_show_builds: true,
            overlay_opacity: default_scale(),
            overlay_hotkey: default_hotkey(),
            overlay_locked: false,
            build_reminders_enabled: true,
            build_reminder_popup: true,
            build_reminder_toast: true,
            ui_scale: default_scale(),
            start_with_windows: false,
            start_minimized: false,
            minimize_on_game_start: false,
            check_updates_on_startup: true,
            toast_on_queue_pop: true,
            discord_rpc_enabled: true,
            riot_api_key: String::new(),
            vault_enabled: false,
            vault_password_hash: String::new(),
            last_seen_patch_notes_version: None,
        }
    }
}

impl Config {
    pub fn load() -> Self {
        json_store::load_or_default(&paths::config_file(), "config")
    }

    pub fn save(&self) -> anyhow::Result<()> {
        json_store::save(&paths::config_file(), self, "config")
    }

    /// Applies a partial update from the frontend. Only keys present in the
    /// patch are touched; anything the struct doesn't know, or that carries the
    /// wrong type, is reported back rather than silently dropped — the Node
    /// build used to answer "success" for updates that never applied.
    pub fn apply_patch(&mut self, patch: &serde_json::Value) -> Result<(), Vec<String>> {
        let Some(obj) = patch.as_object() else {
            return Err(vec!["payload is not an object".into()]);
        };

        let mut current = serde_json::to_value(&*self).expect("config serializes");
        let current_obj = current.as_object_mut().expect("config is an object");

        let mut rejected = Vec::new();
        for (key, value) in obj {
            let Some(existing) = current_obj.get(key) else {
                rejected.push(key.clone());
                continue;
            };
            if !same_json_kind(existing, value) {
                rejected.push(key.clone());
                continue;
            }
            current_obj.insert(key.clone(), value.clone());
        }

        match serde_json::from_value::<Config>(current) {
            Ok(updated) => {
                *self = updated;
                if rejected.is_empty() {
                    Ok(())
                } else {
                    Err(rejected)
                }
            }
            Err(_) => Err(obj.keys().cloned().collect()),
        }
    }
}

/// Numbers are interchangeable (2 vs 2.0), everything else must match kind.
fn same_json_kind(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    use serde_json::Value::*;
    match (a, b) {
        (Number(_), Number(_)) => true,
        (String(_), String(_)) => true,
        (Bool(_), Bool(_)) => true,
        (Null, String(_)) | (String(_), Null) => true, // optional string fields
        (Null, Null) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_the_node_build() {
        let c = Config::default();
        assert!(c.build_reminders_enabled);
        assert!(c.build_reminder_popup);
        assert!(!c.overlay_enabled);
        assert_eq!(c.overlay_hotkey, "Ctrl+Shift+H");
        assert_eq!(c.ui_scale, 1.0);
    }

    #[test]
    fn reads_a_config_written_by_the_node_build() {
        // A real-shaped config.json, including a key this build doesn't know.
        let raw = r#"{
            "lolPath": "D:\\Riot\\LeagueClient.exe",
            "autoAccept": true,
            "uiScale": 1.25,
            "riotApiKey": "RGAPI-xxx",
            "someRemovedLegacyKey": 5
        }"#;
        let c: Config = serde_json::from_str(raw).expect("unknown keys must not break loading");
        assert_eq!(c.lol_path, r"D:\Riot\LeagueClient.exe");
        assert!(c.auto_accept);
        assert_eq!(c.ui_scale, 1.25);
        assert_eq!(c.riot_api_key, "RGAPI-xxx");
        // untouched keys keep their defaults
        assert!(c.toast_on_queue_pop);
    }

    #[test]
    fn patch_applies_known_keys() {
        let mut c = Config::default();
        c.apply_patch(&json!({ "autoAccept": true, "uiScale": 1.5 })).unwrap();
        assert!(c.auto_accept);
        assert_eq!(c.ui_scale, 1.5);
    }

    #[test]
    fn patch_reports_unknown_keys_instead_of_pretending_they_applied() {
        let mut c = Config::default();
        let err = c.apply_patch(&json!({ "autoAccept": true, "notARealSetting": 1 })).unwrap_err();
        assert_eq!(err, vec!["notARealSetting".to_string()]);
        assert!(c.auto_accept, "valid keys in the same patch still apply");
    }

    #[test]
    fn patch_rejects_wrong_types() {
        let mut c = Config::default();
        let err = c.apply_patch(&json!({ "autoAccept": "yes please" })).unwrap_err();
        assert_eq!(err, vec!["autoAccept".to_string()]);
        assert!(!c.auto_accept);
    }

    #[test]
    fn patch_cannot_smuggle_a_wrongly_typed_secret() {
        let mut c = Config::default();
        let err = c.apply_patch(&json!({ "vaultPasswordHash": 12345 })).unwrap_err();
        assert_eq!(err, vec!["vaultPasswordHash".to_string()]);
        assert_eq!(c.vault_password_hash, "");
    }
}
