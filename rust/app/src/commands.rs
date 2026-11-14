//! Every command the frontend can call, mirroring the Electron preload surface
//! one-for-one so `src/renderer/` runs unchanged.

use llm_core::{
    accounts, build_paths, champion_data, honor_watch, item_data, league_path, rank_history,
    riot_api,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use crate::{launch, popup, state::AppState};

type CmdResult<T> = Result<T, String>;

fn ok() -> Value {
    json!({ "success": true })
}

// ── Window ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn close_window(app: AppHandle) -> Value {
    // Closing hides to tray, matching the old behaviour: quitting is done from
    // the tray menu, so a stray click on ✕ doesn't stop the reminder watcher
    // mid-match.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    ok()
}

#[tauri::command]
pub fn minimize_window(app: AppHandle) -> Value {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.minimize();
    }
    ok()
}

#[tauri::command]
pub fn set_zoom_factor(app: AppHandle, factor: f64) -> Value {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_zoom(factor.clamp(0.5, 3.0));
    }
    ok()
}

#[tauri::command]
pub fn toggle_devtools(app: AppHandle) {
    #[cfg(debug_assertions)]
    if let Some(window) = app.get_webview_window("main") {
        if window.is_devtools_open() {
            window.close_devtools();
        } else {
            window.open_devtools();
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = app;
}

// ── Accounts ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_accounts() -> Vec<accounts::SafeAccount> {
    accounts::list_safe()
}

#[tauri::command]
pub fn add_account(app: AppHandle, input: accounts::AccountInput) -> Value {
    match accounts::add(input) {
        Ok(()) => {
            let _ = app.emit("accounts-updated", ());
            crate::tray::refresh(&app);
            ok()
        }
        Err(e) => json!({ "success": false, "message": e.to_string() }),
    }
}

#[tauri::command]
pub fn update_account(app: AppHandle, input: accounts::AccountInput) -> Value {
    match accounts::update(input) {
        Ok(()) => {
            let _ = app.emit("accounts-updated", ());
            crate::tray::refresh(&app);
            ok()
        }
        Err(e) => json!({ "success": false, "message": e.to_string() }),
    }
}

#[tauri::command]
pub fn delete_account(app: AppHandle, username: String) -> Value {
    match accounts::delete(&username) {
        Ok(()) => {
            let _ = app.emit("accounts-updated", ());
            crate::tray::refresh(&app);
            ok()
        }
        Err(e) => json!({ "success": false, "message": e.to_string() }),
    }
}

#[tauri::command]
pub fn reorder_accounts(usernames: Vec<String>) -> Value {
    match accounts::reorder(&usernames) {
        Ok(()) => ok(),
        Err(e) => json!({ "success": false, "message": e.to_string() }),
    }
}

/// Verifying the vault is the backend's job: the frontend lock screen is only
/// a curtain, and `get_account_password` refuses until this has succeeded.
#[tauri::command]
pub fn unlock_vault(state: State<'_, AppState>, password_hash: Option<String>) -> Value {
    // The frontend probes with null on boot to learn whether the vault is on.
    let Some(password_hash) = password_hash else {
        return json!({ "success": false, "message": "No password supplied" });
    };
    let stored = state.config.read().vault_password_hash.clone();
    if stored.is_empty() || stored != password_hash {
        return json!({ "success": false, "message": "Incorrect password" });
    }
    *state.vault_unlocked.write() = true;
    ok()
}

#[tauri::command]
pub fn get_account_password(state: State<'_, AppState>, username: String) -> CmdResult<String> {
    let vault_on = state.config.read().vault_enabled;
    if vault_on && !*state.vault_unlocked.read() {
        return Err("Vault is locked".into());
    }
    accounts::reveal_password(&username).ok_or_else(|| "No stored password for that account".into())
}

#[tauri::command]
pub fn get_current_account(state: State<'_, AppState>) -> Option<String> {
    state.current_account.read().clone()
}

#[tauri::command]
pub async fn export_accounts(app: AppHandle) -> Value {
    use tauri_plugin_dialog::DialogExt;

    let (blob, count) = match accounts::export_blob() {
        Ok(v) => v,
        Err(e) => return json!({ "success": false, "message": e.to_string() }),
    };

    let path = app
        .dialog()
        .file()
        .set_file_name("lost-league-accounts.llem")
        .add_filter("Lost League export", &["llem"])
        .blocking_save_file();

    let Some(path) = path.and_then(|p| p.into_path().ok()) else {
        return json!({ "success": false, "message": "Cancelled" });
    };
    match std::fs::write(&path, blob) {
        Ok(()) => json!({ "success": true, "count": count }),
        Err(e) => json!({ "success": false, "message": e.to_string() }),
    }
}

#[tauri::command]
pub async fn import_accounts(app: AppHandle) -> Value {
    use tauri_plugin_dialog::DialogExt;

    let path = app
        .dialog()
        .file()
        .add_filter("Lost League export", &["llem"])
        .blocking_pick_file();

    let Some(path) = path.and_then(|p| p.into_path().ok()) else {
        return json!({ "success": false, "message": "Cancelled" });
    };
    let blob = match std::fs::read_to_string(&path) {
        Ok(v) => v,
        Err(e) => return json!({ "success": false, "message": e.to_string() }),
    };
    match accounts::import_blob(&blob) {
        Ok(outcome) => {
            let _ = app.emit("accounts-updated", ());
            crate::tray::refresh(&app);
            json!({ "success": true, "imported": outcome.imported, "skipped": outcome.skipped })
        }
        Err(e) => json!({ "success": false, "message": e.to_string() }),
    }
}

#[tauri::command]
pub async fn open_file_dialog(app: AppHandle, options: Value) -> Value {
    use tauri_plugin_dialog::DialogExt;
    let _ = options;
    match app.dialog().file().blocking_pick_file().and_then(|p| p.into_path().ok()) {
        Some(path) => json!({ "canceled": false, "filePaths": [path.to_string_lossy()] }),
        None => json!({ "canceled": true, "filePaths": [] }),
    }
}

// ── Config ───────────────────────────────────────────────────────────────────

/// Launch-at-login is the Run key, which is the user's to change from outside
/// the app too — so the stored setting is refreshed from the registry rather
/// than trusted blindly.
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "Lost League Manager";

#[cfg(windows)]
fn registry(args: &[&str]) -> Option<std::process::Output> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("reg")
        .args(args)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .ok()
}

#[cfg(not(windows))]
fn registry(_args: &[&str]) -> Option<std::process::Output> {
    None
}

pub fn launches_at_login() -> bool {
    registry(&["query", RUN_KEY, "/v", RUN_VALUE])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn set_launch_at_login(enabled: bool) -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let quoted = format!("\"{}\"", exe.display());
    let result = if enabled {
        registry(&["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &quoted, "/f"])
    } else {
        registry(&["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
    };
    result.map(|o| o.status.success()).unwrap_or(false)
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Value {
    {
        let mut config = state.config.write();
        config.start_with_windows = launches_at_login();
    }
    serde_json::to_value(&*state.config.read()).unwrap_or_else(|_| json!({}))
}

#[tauri::command]
pub fn set_config(app: AppHandle, state: State<'_, AppState>, patch: Value) -> Value {
    let result = {
        let mut config = state.config.write();
        config.apply_patch(&patch)
    };

    if let Err(e) = state.save_config() {
        return json!({ "success": false, "message": format!("Could not save settings: {e}") });
    }

    // Mirror the settings the background workers read, and apply the ones that
    // live outside this process.
    {
        let config = state.config.read();
        state.reminder.lock().enabled = config.build_reminders_enabled;
        *state.league_path.write() = config.lol_path.clone();

        if patch.get("discordRpcEnabled").is_some() {
            let _ = state.discord.send(if config.discord_rpc_enabled {
                crate::discord::Presence::Enable
            } else {
                crate::discord::Presence::Disable
            });
        }
        if patch.get("startWithWindows").is_some()
            && !set_launch_at_login(config.start_with_windows)
        {
            tracing::error!("[Config] Could not update the launch-at-login entry");
        }
    }
    let _ = app.emit("config-updated", ());

    match result {
        Ok(()) => ok(),
        Err(rejected) => json!({
            "success": false,
            "message": format!("Rejected invalid config key(s): {}", rejected.join(", ")),
            "rejected": rejected,
        }),
    }
}

// ── Reference data ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_champion_list() -> Vec<champion_data::ChampionSummary> {
    champion_data::champion_list()
}

#[tauri::command]
pub fn get_champion_full_data(champ_key: String) -> Option<champion_data::ChampionFull> {
    champion_data::champion_full(&champ_key)
}

#[tauri::command]
pub fn get_item_list() -> Vec<item_data::ItemInfo> {
    item_data::item_list()
}

// ── Build paths ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_build_paths() -> Value {
    json!({
        "paths": build_paths::all(),
        "limits": {
            "maxSteps": build_paths::MAX_STEPS,
            "maxItemsPerStep": build_paths::MAX_ITEMS_PER_STEP,
        }
    })
}

#[tauri::command]
pub fn save_build_path(champ_key: String, steps: Vec<build_paths::Step>) -> Value {
    match build_paths::set(&champ_key, &steps) {
        Ok(steps) => json!({ "success": true, "steps": steps }),
        Err(message) => json!({ "success": false, "message": message }),
    }
}

#[tauri::command]
pub fn delete_build_path(champ_key: String) -> Value {
    match build_paths::delete(&champ_key) {
        Ok(steps) => json!({ "success": true, "steps": steps }),
        Err(message) => json!({ "success": false, "message": message }),
    }
}

#[tauri::command]
pub async fn import_build_path(
    state: State<'_, AppState>,
    champ_key: String,
    position: Option<String>,
) -> CmdResult<Value> {
    let client = state.http.clone();
    Ok(
        match build_paths::import_from_opgg(&client, &champ_key, position.as_deref()).await {
            Ok(steps) => json!({ "success": true, "steps": steps }),
            Err(message) => json!({ "success": false, "message": message }),
        },
    )
}

#[tauri::command]
pub fn resolve_build_path(champ_key: String) -> Option<build_paths::ResolvedPlan> {
    build_paths::resolve_for_champion(&champ_key)
}

/// Fires a sample popup from Settings. The real one only appears mid-match, so
/// without this there's no way to check it shows up over your game — or where
/// on screen it lands — short of queueing up.
/// Async on purpose: a sync command runs on the main thread, and building a
/// window there blocks the event loop it is waiting on — the call never
/// returns. Async commands run off the main thread, so the builder can post to
/// the loop and complete.
#[tauri::command]
pub async fn preview_build_reminder(app: AppHandle) -> Value {
    let items: Vec<llm_core::build_reminder::ReminderItem> = [1001_i64, 1082]
        .iter()
        .map(|id| llm_core::build_reminder::ReminderItem {
            id: *id,
            name: item_data::item_name(*id).unwrap_or_else(|| format!("Item {id}")),
            cost: item_data::item_cost(*id),
        })
        .collect();
    let gold: i64 = items.iter().map(|i| i.cost).sum();
    let reminder = llm_core::build_reminder::Reminder {
        index: 0,
        gold: if gold > 0 { gold } else { 650 },
        current_gold: gold + 12,
        total_steps: 3,
        champ_key: String::new(),
        items,
    };
    match popup::show(&app, &reminder) {
        Ok(()) => ok(),
        Err(e) => json!({ "success": false, "message": e.to_string() }),
    }
}

#[tauri::command]
pub fn skip_build_step(state: State<'_, AppState>, index: usize) {
    state.reminder.lock().skip_step(index);
}

// ── Stats ────────────────────────────────────────────────────────────────────

fn split_riot_id(riot_id: &str) -> Option<(String, String)> {
    let (name, tag) = riot_id.split_once('#')?;
    (!name.is_empty() && !tag.is_empty()).then(|| (name.to_string(), tag.to_string()))
}

#[tauri::command]
pub async fn get_stats(state: State<'_, AppState>, region: String, riot_id: String) -> CmdResult<Value> {
    let Some((name, tag)) = split_riot_id(&riot_id) else {
        return Ok(json!({ "success": false, "message": "Set a Riot ID (Name#TAG) on this account first" }));
    };
    let (client, key) = (state.http.clone(), state.config.read().riot_api_key.clone());

    Ok(match riot_api::get_stats(&client, &key, &name, &tag, &region).await {
        Ok(stats) => serde_json::to_value(stats).unwrap_or_else(|_| json!({ "success": false })),
        Err(e) => json!({ "success": false, "message": e.to_string() }),
    })
}

#[tauri::command]
pub async fn get_match_history(
    state: State<'_, AppState>,
    region: String,
    riot_id: String,
) -> CmdResult<Value> {
    let Some((name, tag)) = split_riot_id(&riot_id) else {
        return Ok(json!({ "success": false, "message": "That account has no Riot ID set", "games": [] }));
    };
    let (client, key) = (state.http.clone(), state.config.read().riot_api_key.clone());

    Ok(
        match riot_api::get_match_history(&client, &key, &name, &tag, &region, 5).await {
            Ok(games) => json!({ "success": true, "games": games }),
            Err(e) => json!({ "success": false, "message": e.to_string(), "games": [] }),
        },
    )
}

#[tauri::command]
pub fn get_rank_history(riot_id: String) -> Vec<rank_history::Snapshot> {
    rank_history::for_riot_id(&riot_id)
}

// ── League client ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn accept_match(state: State<'_, AppState>) -> CmdResult<Value> {
    if !state.lcu.connected() {
        return Ok(json!({ "success": false, "message": "League client is not running" }));
    }
    let lcu = state.lcu.clone();
    // The request returns None specifically on failure; this endpoint answers
    // 204 with no body on success, which is why presence is what's checked.
    // Reporting success regardless is how the old build told people "accepted!"
    // right before they got dodged.
    Ok(match lcu.post("/lol-matchmaking/v1/ready-check/accept", None).await {
        Some(_) => ok(),
        None => json!({
            "success": false,
            "message": "Ready check may have already expired - accept in the League client"
        }),
    })
}

/// Dodging is done by killing the client, the same way the Electron build did
/// it: there is no supported endpoint that backs out of champion select
/// cleanly.
#[tauri::command]
pub async fn dodge_queue() -> Value {
    match launch::kill_client_only() {
        Ok(()) => ok(),
        Err(e) => json!({ "success": false, "message": e.to_string() }),
    }
}

/// Queue type and any active dodge penalty, so the UI can warn before the user
/// commits to it.
#[tauri::command]
pub async fn get_dodge_info(state: State<'_, AppState>) -> CmdResult<Value> {
    const RANKED_QUEUE_IDS: [i64; 2] = [420, 440];

    if !state.lcu.connected() {
        return Ok(json!({ "connected": false }));
    }
    let lcu = state.lcu.clone();
    let lobby = lcu.get("/lol-lobby/v2/lobby").await;
    let errors = lcu.get("/lol-matchmaking/v1/search/errors").await;

    let queue_id = lobby
        .as_ref()
        .and_then(|l| l.get("gameConfig"))
        .and_then(|c| c.get("queueId"))
        .and_then(|q| q.as_i64());

    let dodge_error = errors.as_ref().and_then(|e| e.as_array()).and_then(|list| {
        list.iter().find(|e| {
            e.get("errorType")
                .and_then(|t| t.as_str())
                .map(|t| t.contains("DODGE"))
                .unwrap_or(false)
        })
    });

    Ok(json!({
        "connected": true,
        "isRanked": queue_id.map(|id| RANKED_QUEUE_IDS.contains(&id)).unwrap_or(false),
        "queueId": queue_id,
        "hasActivePenalty": dodge_error.is_some(),
        "penaltyMinutesRemaining": dodge_error.map(|e| {
            let seconds = e.get("penaltyTimeRemaining").and_then(|v| v.as_f64()).unwrap_or(0.0);
            (seconds / 60.0).ceil() as i64
        }),
    }))
}

#[tauri::command]
pub async fn get_lobby_members(state: State<'_, AppState>) -> CmdResult<Value> {
    let lcu = state.lcu.clone();
    Ok(lcu.get("/lol-lobby/v2/lobby/members").await.unwrap_or(json!([])))
}

#[tauri::command]
pub async fn set_profile_background(
    state: State<'_, AppState>,
    champion_name: String,
    skin_id: i64,
) -> CmdResult<Value> {
    let lcu = state.lcu.clone();
    let _ = champion_name;
    Ok(
        match lcu
            .post(
                "/lol-summoner/v1/current-summoner/summoner-profile",
                Some(json!({ "key": "backgroundSkinId", "value": skin_id })),
            )
            .await
        {
            Some(_) => ok(),
            None => json!({ "success": false, "message": "Could not set the background" }),
        },
    )
}

#[tauri::command]
pub async fn set_status_message(state: State<'_, AppState>, message: String) -> CmdResult<Value> {
    let lcu = state.lcu.clone();
    Ok(match lcu.put("/lol-chat/v1/me", json!({ "statusMessage": message })).await {
        Some(_) => ok(),
        None => json!({ "success": false, "message": "Could not set the status message" }),
    })
}

const VALID_LOCALES: &[&str] = &[
    "en_US", "en_GB", "de_DE", "es_ES", "es_MX", "fr_FR", "it_IT", "ja_JP", "ko_KR", "pl_PL",
    "pt_BR", "ro_RO", "ru_RU", "tr_TR", "zh_TW", "zh_CN", "cs_CZ", "hu_HU", "el_GR", "nl_NL",
    "vi_VN", "th_TH", "id_ID",
];

/// Rewrites the client's own settings file. The locale list is a whitelist:
/// this writes into a Riot config file, so an arbitrary string has no business
/// reaching it.
#[tauri::command]
pub async fn change_language(state: State<'_, AppState>, locale: String) -> CmdResult<Value> {
    if !VALID_LOCALES.contains(&locale.as_str()) {
        return Ok(json!({ "success": false, "message": format!("Invalid locale: {locale}") }));
    }
    let lol_path = state.config.read().lol_path.clone();
    let Some(dir) = std::path::Path::new(&lol_path).parent() else {
        return Ok(json!({ "success": false, "message": "No valid League path configured" }));
    };
    let settings = dir.join("Config").join("LeagueClientSettings.yaml");
    if !settings.exists() {
        return Ok(json!({
            "success": false,
            "message": format!("Config not found at {}", settings.display())
        }));
    }

    let content = match std::fs::read_to_string(&settings) {
        Ok(value) => value,
        Err(e) => return Ok(json!({ "success": false, "message": e.to_string() })),
    };
    let Some(replaced) = replace_locale(&content, &locale) else {
        return Ok(json!({ "success": false, "message": "Locale key not found in settings file" }));
    };
    Ok(match std::fs::write(&settings, replaced) {
        Ok(()) => ok(),
        Err(e) => json!({ "success": false, "message": e.to_string() }),
    })
}

/// Swaps the value of the first `locale: "..."` entry and leaves the rest of
/// the YAML untouched — the client rewrites this file itself, and reformatting
/// it wholesale would be asking for trouble.
fn replace_locale(content: &str, locale: &str) -> Option<String> {
    const NEEDLE: &str = "locale: \"";
    let start = content.find(NEEDLE)?;
    let value_start = start + NEEDLE.len();
    let end = content[value_start..].find('"')? + value_start;
    let mut out = String::with_capacity(content.len());
    out.push_str(&content[..value_start]);
    out.push_str(locale);
    out.push_str(&content[end..]);
    Some(out)
}

#[cfg(test)]
mod locale_tests {
    use super::replace_locale;

    const SAMPLE: &str = concat!(
        "install:\n",
        "  globals:\n",
        "    locale: \"en_US\"\n",
        "    region: \"EUW\"\n",
    );

    #[test]
    fn swaps_only_the_locale_value() {
        let out = replace_locale(SAMPLE, "de_DE").unwrap();
        assert!(out.contains("locale: \"de_DE\""));
        assert!(out.contains("region: \"EUW\""), "the rest of the file is untouched");
        assert!(out.starts_with("install:"));
    }

    #[test]
    fn a_file_without_the_key_is_left_alone() {
        assert!(replace_locale("nothing here", "de_DE").is_none());
    }
}

#[tauri::command]
pub async fn get_lcu_overview(state: State<'_, AppState>) -> CmdResult<Value> {
    if !state.lcu.connected() {
        return Ok(json!({ "connected": false }));
    }
    let lcu = state.lcu.clone();

    let summoner = lcu.get("/lol-summoner/v1/current-summoner").await;
    let ranked = lcu.get("/lol-ranked/v1/current-ranked-stats").await;
    let gameflow = lcu.get("/lol-gameflow/v1/gameflow-phase").await;
    let matches = lcu
        .get("/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=9")
        .await;
    let honor = lcu.get("/lol-honor-v2/v1/profiles").await;

    // Mastery lives at a different path depending on client version; try the
    // known shapes in order and take the first that answers with a list.
    let puuid = summoner
        .as_ref()
        .and_then(|s| s.get("puuid"))
        .and_then(|p| p.as_str())
        .map(|s| s.to_string());
    let mut mastery = Value::Array(vec![]);
    let mut candidates = vec![
        "/lol-champion-mastery/v1/local-player/top-champion-masteries?count=8".to_string(),
        "/lol-champion-mastery/v1/champion-masteries/top?count=8".to_string(),
    ];
    if let Some(puuid) = &puuid {
        candidates.insert(
            0,
            format!("/lol-champion-mastery/v1/champion-masteries/by-puuid/{puuid}/top?count=8"),
        );
    }
    for endpoint in candidates {
        if let Some(value) = lcu.get(&endpoint).await {
            if value.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                mastery = value;
                break;
            }
        }
    }

    // state.current_account is only ever set by launching through this app and
    // is never corrected afterwards — if the user switched account directly in
    // the Riot Client it goes stale. Verify it against the summoner actually
    // signed in before attributing honor data to it.
    if let (Some(summoner), Some(honor)) = (summoner.as_ref(), honor.as_ref()) {
        let logged_in = match (
            summoner.get("gameName").and_then(|v| v.as_str()),
            summoner.get("tagLine").and_then(|v| v.as_str()),
        ) {
            (Some(name), Some(tag)) => Some(format!("{name}#{tag}").to_lowercase()),
            _ => None,
        };
        let tracked = {
            let username = state.current_account.read().clone();
            username.and_then(|u| accounts::load().into_iter().find(|a| a.username == u))
        };
        if let (Some(logged_in), Some(account)) = (logged_in, tracked) {
            if account.riot_id.to_lowercase() == logged_in {
                if let Some(level) = honor.get("honorLevel").and_then(|v| v.as_i64()) {
                    honor_watch::record_level(&account.username, level);
                }
            }
        }
    }

    let games = matches
        .as_ref()
        .and_then(|m| m.get("games"))
        .and_then(|g| g.get("games"))
        .cloned()
        .unwrap_or(Value::Array(vec![]));

    Ok(json!({
        "connected": true,
        "summoner": summoner,
        "ranked": ranked,
        "gameflow": gameflow,
        "matches": games,
        "mastery": mastery,
        "honor": honor,
        "ddragonVersion": champion_data::latest_version(),
        "idToNameMap": champion_data::id_to_key_map(),
    }))
}

// ── Client maintenance ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn fix_client() -> Value {
    let killed = launch::kill_riot_processes();
    json!({ "success": true, "count": killed })
}

#[tauri::command]
pub async fn repair_client(state: State<'_, AppState>) -> CmdResult<Value> {
    let path = state.config.read().lol_path.clone();
    Ok(match launch::repair_client(&path) {
        Ok(()) => ok(),
        Err(e) => json!({ "success": false, "message": e.to_string() }),
    })
}

#[tauri::command]
pub async fn clear_client_cache(state: State<'_, AppState>) -> CmdResult<Value> {
    let path = state.config.read().lol_path.clone();
    Ok(match launch::clear_cache(&path) {
        Ok(count) => json!({ "success": true, "count": count }),
        Err(e) => json!({ "success": false, "message": e.to_string() }),
    })
}

#[tauri::command]
pub fn open_data_folder(app: AppHandle) -> Value {
    let dir = llm_core::paths::data_dir();
    let _ = app.opener().open_path(dir.to_string_lossy().to_string(), None::<&str>);
    ok()
}

// ── Launching ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn launch_account(app: AppHandle, state: State<'_, AppState>, username: String) -> CmdResult<Value> {
    Ok(launch::launch_account(&app, &state, &username).await)
}

#[tauri::command]
pub async fn launch_league_client(state: State<'_, AppState>) -> CmdResult<Value> {
    let path = state.config.read().lol_path.clone();
    Ok(match launch::launch_client_only(&path) {
        Ok(()) => ok(),
        Err(e) => json!({ "success": false, "message": e.to_string() }),
    })
}

#[tauri::command]
pub fn cancel_launch() -> Value {
    launch::cancel();
    ok()
}

// ── Links ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Value {
    // Only ever open web links: a file:// or arbitrary scheme here would let
    // page content start a local program.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return json!({ "success": false, "message": "Only http(s) links can be opened" });
    }
    let _ = app.opener().open_url(url, None::<&str>);
    ok()
}

#[tauri::command]
pub fn open_opgg(app: AppHandle, region: String, riot_id: String) -> Value {
    let Some((name, tag)) = split_riot_id(&riot_id) else {
        return json!({ "success": false, "message": "That account has no Riot ID set" });
    };
    let region = if region.is_empty() { "euw".to_string() } else { region.to_lowercase() };
    let url = format!(
        "https://www.op.gg/summoners/{region}/{}-{}",
        urlencoding(&name),
        urlencoding(&tag)
    );
    let _ = app.opener().open_url(url, None::<&str>);
    ok()
}

#[tauri::command]
pub fn open_patch_notes(app: AppHandle) -> Value {
    let _ = app.opener().open_url(
        "https://www.leagueoflegends.com/en-us/news/tags/patch-notes/",
        None::<&str>,
    );
    ok()
}

fn urlencoding(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

// ── Updates / overlay ────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

const RELEASES_API: &str = "https://api.github.com/repos/MouseWerk/lost-league-manager/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/MouseWerk/lost-league-manager/releases/latest";

/// Compares two dotted version strings numerically, so 1.10.0 sorts above
/// 1.9.0 (a string compare would get that backwards).
fn is_newer(candidate: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split(['.', '-'])
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parse(candidate), parse(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// Checks GitHub for a newer release and reports what it found.
///
/// It does not install anything. In-place updating needs Tauri's updater,
/// which requires a signing keypair and a release feed carrying Tauri
/// artifacts — the existing releases hold Electron builds, and offering those
/// to this build would be worse than saying nothing.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Value> {
    let current = app.package_info().version.to_string();
    let response = state
        .http
        .get(RELEASES_API)
        .header("User-Agent", "lost-league-manager")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await;

    let body: Value = match response {
        Ok(r) if r.status().is_success() => match r.json().await {
            Ok(v) => v,
            Err(e) => return Ok(json!({ "success": false, "message": e.to_string() })),
        },
        Ok(r) => return Ok(json!({ "success": false, "message": format!("GitHub returned {}", r.status()) })),
        Err(e) => return Ok(json!({ "success": false, "message": e.to_string() })),
    };

    let latest = body.get("tag_name").and_then(|t| t.as_str()).unwrap_or("");
    let available = is_newer(latest, &current);
    if available {
        let _ = app
            .notification()
            .builder()
            .title(format!("Update available: {latest}"))
            .body("Open the releases page to download it.")
            .show();
    }
    Ok(json!({
        "success": true,
        "updateAvailable": available,
        "version": latest.trim_start_matches('v'),
        "currentVersion": current,
        "url": RELEASES_PAGE,
    }))
}

/// Opens the releases page. See `check_for_updates` for why this build doesn't
/// install updates itself.
#[tauri::command]
pub fn install_update(app: AppHandle) -> Value {
    let _ = app.opener().open_url(RELEASES_PAGE, None::<&str>);
    json!({ "success": true, "message": "Opened the releases page" })
}

#[tauri::command]
pub fn reset_overlay_position() -> Value {
    json!({ "success": false, "message": "The in-game overlay is not part of this build" })
}

/// Re-detects the League install on startup, the way the Electron build healed
/// a stale path after a reinstall or drive change.
pub fn heal_league_path(state: &AppState) {
    let configured = state.config.read().lol_path.clone();
    if let Some(resolved) = league_path::resolve(&configured) {
        if resolved != configured {
            tracing::info!("[Boot] League install auto-detected at {resolved}");
            state.config.write().lol_path = resolved.clone();
            *state.league_path.write() = resolved;
            let _ = state.save_config();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn riot_ids_split_on_the_hash() {
        assert_eq!(split_riot_id("Name#EUW"), Some(("Name".into(), "EUW".into())));
        assert_eq!(split_riot_id("Name"), None);
        assert_eq!(split_riot_id("#EUW"), None);
        assert_eq!(split_riot_id("Name#"), None);
    }

    #[test]
    fn opgg_urls_escape_the_name() {
        assert_eq!(urlencoding("Some Name"), "Some%20Name");
        assert_eq!(urlencoding("plain"), "plain");
    }
}
