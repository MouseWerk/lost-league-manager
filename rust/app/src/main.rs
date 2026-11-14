// The frameless window is the whole UI; no console should appear behind it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Lost League Manager — desktop shell.
//!
//! Rust replaces what used to be the Electron main process. The frontend in
//! `src/renderer/` is unchanged and unaware of the swap: `bridge.js` is
//! injected before any page script and re-creates the `window.electronAPI`
//! surface on top of Tauri commands and events.
//!
//! What deliberately isn't here: Overwolf's game-events provider and its
//! injected overlay, which are Electron-only and have no Rust equivalent. The
//! build reminder no longer needs them — it reads Riot's own Live Client Data
//! API and draws its own always-on-top window.

mod commands;
mod discord;
#[cfg(windows)]
mod jumplist;
mod launch;
mod popup;
mod state;
mod tray;

use llm_core::{
    accounts, build_reminder, champion_data, config::Config, item_data, lcu, live_client,
};
use serde_json::json;
use state::AppState;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

fn main() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .init();

    if let Err(e) = llm_core::paths::ensure_data_dir() {
        tracing::error!("[Boot] Could not create the data directory: {e}");
    }

    let config = Config::load();
    let start_minimized = config.start_minimized;
    let app_state = match AppState::new(config) {
        Ok(state) => state,
        Err(e) => {
            tracing::error!("[Boot] Could not initialise: {e}");
            std::process::exit(1);
        }
    };

    // Pre-v2 passwords are re-encrypted under the current machine-bound key.
    match accounts::migrate_legacy_passwords() {
        Ok(0) => {}
        Ok(n) => tracing::info!("[Auth] Migrated {n} password(s)"),
        Err(e) => tracing::error!("[Auth] Password migration failed: {e}"),
    }
    commands::heal_league_path(&app_state);

    // A jump list entry (and the Electron build's shortcuts) start the app with
    // --launch=<account>.
    let launch_on_start = std::env::args()
        .find_map(|a| a.strip_prefix("--launch=").map(|v| v.to_string()));

    // One instance per data directory. Normally that means one instance,
    // matching the Electron build: a second launch — a jump list entry, a
    // desktop shortcut — hands its arguments to the running app and exits
    // rather than opening a second window. An explicit LLM_DATA_DIR is a
    // genuinely separate install (that is how the test suite runs alongside a
    // live app), so it is left to run on its own.
    let shares_the_default_data_dir = std::env::var("LLM_DATA_DIR").is_err();

    let mut builder = tauri::Builder::default();
    if shares_the_default_data_dir {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            if let Some(username) = argv
                .iter()
                .find_map(|a| a.strip_prefix("--launch=").map(|v| v.to_string()))
            {
                let launcher = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = launcher.state::<AppState>();
                    launch::launch_account(&launcher, &state, &username).await;
                });
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::close_window,
            commands::minimize_window,
            commands::set_zoom_factor,
            commands::toggle_devtools,
            commands::get_accounts,
            commands::add_account,
            commands::update_account,
            commands::delete_account,
            commands::reorder_accounts,
            commands::unlock_vault,
            commands::get_account_password,
            commands::get_current_account,
            commands::export_accounts,
            commands::import_accounts,
            commands::open_file_dialog,
            commands::get_config,
            commands::set_config,
            commands::get_champion_list,
            commands::get_champion_full_data,
            commands::get_item_list,
            commands::get_build_paths,
            commands::save_build_path,
            commands::delete_build_path,
            commands::import_build_path,
            commands::resolve_build_path,
            commands::preview_build_reminder,
            commands::skip_build_step,
            commands::get_stats,
            commands::get_match_history,
            commands::get_rank_history,
            commands::accept_match,
            commands::dodge_queue,
            commands::get_dodge_info,
            commands::get_lobby_members,
            commands::get_lcu_overview,
            commands::set_profile_background,
            commands::set_status_message,
            commands::change_language,
            commands::fix_client,
            commands::repair_client,
            commands::clear_client_cache,
            commands::open_data_folder,
            commands::launch_account,
            commands::launch_league_client,
            commands::cancel_launch,
            commands::open_external,
            commands::open_opgg,
            commands::open_patch_notes,
            commands::get_version,
            commands::check_for_updates,
            commands::install_update,
            commands::reset_overlay_position,
            popup::get_pending_reminder,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            let mut main_builder =
                WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("index.html".into()))
                .title("Lost League Manager")
                .inner_size(1100.0, 680.0)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .center()
                .visible(!start_minimized)
                .initialization_script(include_str!("bridge.js"));
            #[cfg(windows)]
            if let Some(dir) = webview_data_dir() {
                main_builder = main_builder.data_directory(dir);
            }
            let window = main_builder.build()?;

            // Closing hides to tray; quitting is deliberate, from the tray menu,
            // so a stray ✕ doesn't kill the reminder watcher mid-match.
            let hide_handle = handle.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Some(window) = hide_handle.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
            });

            tray::create(&handle)?;
            #[cfg(windows)]
            jumplist::refresh();
            spawn_reference_data(handle.clone());

            if let Some(username) = launch_on_start.clone() {
                let launcher = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let state = launcher.state::<AppState>();
                    launch::launch_account(&launcher, &state, &username).await;
                });
            }
            spawn_reminder_watcher(handle.clone());
            spawn_lcu_watcher(handle.clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the application");
}

/// WebView2 runs one browser process per user-data folder, shared across
/// processes. An instance on its own data directory needs its own webview
/// folder too, or it silently attaches to the running app's browser process —
/// which, among other things, drops the remote-debugging flag the end-to-end
/// suite relies on.
#[cfg(windows)]
pub fn webview_data_dir() -> Option<std::path::PathBuf> {
    let dir = std::env::var("LLM_DATA_DIR").ok()?;
    let path = std::path::PathBuf::from(dir).join("webview");
    std::fs::create_dir_all(&path).ok()?;
    Some(path)
}

/// Champions first, then items — item tiers and costs are read against the
/// champion fetch's version.
fn spawn_reference_data(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = {
            let state = app.state::<AppState>();
            state.http.clone()
        };
        if let Err(e) = champion_data::fetch(&client).await {
            tracing::error!("[Boot] Champion data unavailable: {e}");
        }
        if let Err(e) = item_data::fetch(&client).await {
            tracing::error!("[Boot] Item data unavailable: {e}");
        }
        let _ = app.emit("reference-data-ready", ());
    });
}

/// Polls the game's Live Client Data API and delivers build-path reminders.
fn spawn_reminder_watcher(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut client = match live_client::LiveClient::new() {
            Ok(client) => client,
            Err(e) => {
                tracing::error!("[LiveClient] Could not start: {e}");
                return;
            }
        };
        tracing::info!("[LiveClient] Watching for a live match on 127.0.0.1:2999");

        let mut was_in_game = false;
        loop {
            let snapshot = client.fetch().await;
            let interval = client.poll_interval();

            match snapshot {
                Some(snapshot) => {
                    was_in_game = true;
                    let fired = {
                        let state = app.state::<AppState>();
                        let mut reminder = state.reminder.lock();
                        reminder.handle_snapshot(&snapshot)
                    };
                    if let Some(reminder) = fired {
                        deliver_reminder(&app, &reminder);
                    }
                }
                None if was_in_game => {
                    was_in_game = false;
                    let state = app.state::<AppState>();
                    state.reminder.lock().reset();
                }
                None => {}
            }
            tokio::time::sleep(interval).await;
        }
    });
}

fn deliver_reminder(app: &tauri::AppHandle, reminder: &build_reminder::Reminder) {
    let (popup_enabled, toast_enabled) = {
        let state = app.state::<AppState>();
        let config = state.config.read();
        (config.build_reminder_popup, config.build_reminder_toast)
    };

    tracing::info!("[BuildReminder] {} ({})", reminder.title(), reminder.body());

    // Our own popup: the one delivery that's actually on top of the game.
    if popup_enabled {
        if let Err(e) = popup::show(app, reminder) {
            tracing::error!("[BuildReminder] Popup failed: {e}");
        }
    }
    if toast_enabled {
        if let Err(e) = app
            .notification()
            .builder()
            .title(reminder.title())
            .body(reminder.body())
            .show()
        {
            tracing::error!("[BuildReminder] Toast failed: {e}");
        }
    }
    let _ = app.emit("build-reminder", reminder);
}

/// Watches for the League client and republishes its events to the frontend.
fn spawn_lcu_watcher(app: tauri::AppHandle) {
    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel();
    let (status_tx, mut status_rx) = tokio::sync::mpsc::unbounded_channel();

    let (client, league_path) = {
        let state = app.state::<AppState>();
        (state.lcu.clone(), state.league_path.clone())
    };
    tauri::async_runtime::spawn(lcu::run_event_loop(client, league_path, events_tx, status_tx));

    // Connection state.
    let status_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(status) = status_rx.recv().await {
            match status {
                lcu::Connection::Connected => {
                    let _ = status_app.emit("lcu-connected", ());
                    detect_logged_in_account(&status_app).await;
                }
                lcu::Connection::Disconnected => {
                    let _ = status_app.emit("lcu-disconnected", ());
                    let state = status_app.state::<AppState>();
                    let _ = state.discord.send(discord::Presence::Idle);
                }
            }
        }
    });

    // Client events the UI cares about.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events_rx.recv().await {
            match event.uri.as_str() {
                "/lol-gameflow/v1/gameflow-phase" => {
                    let phase = event.data.as_str().unwrap_or("").to_string();
                    let _ = app.emit("lcu-gameflow", phase.clone());
                    {
                        let state = app.state::<AppState>();
                        let _ = state.discord.send(discord::Presence::Phase(phase.clone()));
                    }

                    if phase == "ReadyCheck" {
                        let (toast, auto_accept) = {
                            let state = app.state::<AppState>();
                            let config = state.config.read();
                            (config.toast_on_queue_pop, config.auto_accept)
                        };
                        if toast {
                            let _ = app
                                .notification()
                                .builder()
                                .title("Match Found!")
                                .body("Your queue has popped — ready to accept?")
                                .show();
                        }
                        if auto_accept {
                            let state = app.state::<AppState>();
                            let lcu = state.lcu.clone();
                            tauri::async_runtime::spawn(async move {
                                if lcu.post("/lol-matchmaking/v1/ready-check/accept", None).await.is_none() {
                                    tracing::error!("[LCU] Auto-accept failed — the ready check may have expired");
                                }
                            });
                        }
                    }
                    if phase == "InProgress" {
                        let minimize = {
                            let state = app.state::<AppState>();
                            let value = state.config.read().minimize_on_game_start;
                            value
                        };
                        if minimize {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.hide();
                            }
                        }
                    }
                }
                "/lol-champ-select/v1/session" => match event.event_type.as_str() {
                    "Create" | "Update" => {
                        let _ = app.emit("champ-select-update", event.data.clone());
                        maybe_randomise_skin(&app, &event.data).await;
                    }
                    "Delete" => {
                        let _ = app.emit("champ-select-end", ());
                    }
                    _ => {}
                },
                // The client resets chat availability on its own; put it back
                // whenever the logged-in account is set to appear offline.
                "/lol-chat/v1/me"
                    if event.event_type == "Update"
                        && event.data.get("availability").and_then(|v| v.as_str()) != Some("offline")
                        && current_account_setting(&app, |a| a.appear_offline) =>
                {
                    set_appear_offline(&app).await;
                }
                _ => {}
            }
        }
    });
}

/// Reads a per-account setting for whichever stored account is logged in.
fn current_account_setting<T>(app: &tauri::AppHandle, pick: impl Fn(&accounts::Account) -> T) -> T
where
    T: Default,
{
    let username = {
        let state = app.state::<AppState>();
        let value = state.current_account.read().clone();
        value
    };
    let Some(username) = username else {
        return T::default();
    };
    accounts::load()
        .iter()
        .find(|a| a.username == username)
        .map(pick)
        .unwrap_or_default()
}

async fn set_appear_offline(app: &tauri::AppHandle) {
    let lcu = {
        let state = app.state::<AppState>();
        state.lcu.clone()
    };
    if lcu.put("/lol-chat/v1/me", json!({ "availability": "offline" })).await.is_none() {
        tracing::error!("[LCU] Could not set availability to offline");
    }
}

/// Picks a random owned skin once the player's champion is locked in, for
/// accounts with that option turned on.
async fn maybe_randomise_skin(app: &tauri::AppHandle, session: &serde_json::Value) {
    if !current_account_setting(app, |a| a.auto_skin_random) {
        return;
    }
    let Some(local_cell) = session.get("localPlayerCellId").and_then(|v| v.as_i64()) else {
        return;
    };
    // Only once the pick is locked: changing a skin before that is ignored.
    let locked_in = session
        .get("actions")
        .and_then(|a| a.as_array())
        .map(|rounds| {
            rounds.iter().flat_map(|r| r.as_array().cloned().unwrap_or_default()).any(|action| {
                action.get("actorCellId").and_then(|v| v.as_i64()) == Some(local_cell)
                    && action.get("type").and_then(|v| v.as_str()) == Some("pick")
                    && action.get("completed").and_then(|v| v.as_bool()) == Some(true)
            })
        })
        .unwrap_or(false);
    if !locked_in {
        return;
    }

    let lcu = {
        let state = app.state::<AppState>();
        state.lcu.clone()
    };
    let Some(skins) = lcu.get("/lol-champ-select/v1/skin-carousel-skins").await else {
        return;
    };
    let owned: Vec<i64> = skins
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|s| {
                    s.get("ownership")
                        .and_then(|o| o.get("owned"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                })
                .filter_map(|s| s.get("id").and_then(|v| v.as_i64()))
                .collect()
        })
        .unwrap_or_default();
    if owned.is_empty() {
        return;
    }
    let choice = owned[rand::random::<usize>() % owned.len()];
    let _ = lcu
        .patch(
            "/lol-champ-select/v1/session/my-selection",
            json!({ "selectedSkinId": choice }),
        )
        .await;
}

/// Notices which stored account is logged in, even when League was started
/// outside this app, so the dashboard can highlight it.
async fn detect_logged_in_account(app: &tauri::AppHandle) {
    let lcu = {
        let state = app.state::<AppState>();
        state.lcu.clone()
    };
    let Some(session) = lcu.get("/lol-login/v1/session").await else {
        return;
    };
    let Some(username) = session.get("username").and_then(|v| v.as_str()) else {
        return;
    };
    let matched = accounts::load()
        .into_iter()
        .find(|a| a.username.eq_ignore_ascii_case(username));
    if let Some(account) = matched {
        {
            let state = app.state::<AppState>();
            *state.current_account.write() = Some(account.username.clone());
        }
        let appear_offline = account.appear_offline;
        let _ = app.emit("active-account-detected", account.username);
        if appear_offline {
            set_appear_offline(app).await;
        }
    }
}
