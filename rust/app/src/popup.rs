//! The in-game buy reminder popup.
//!
//! Our own always-on-top window rather than an injected overlay: no Overwolf,
//! no game hooking. It sits above a borderless-fullscreen client the same way
//! any topmost window does. (Exclusive fullscreen is the one case nothing but a
//! real injected overlay can draw over — a Windows toast has the same limit.)

use llm_core::build_reminder::Reminder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "reminder";
const WIDTH: f64 = 430.0;
const HEIGHT: f64 = 104.0;
pub const DURATION_MS: u64 = 7_000;

fn ensure_window(app: &AppHandle) -> anyhow::Result<tauri::WebviewWindow> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Ok(window);
    }

    // Screen bounds, not the work area: the game covers the taskbar.
    let (screen_width, screen_height) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let size = m.size();
            let scale = m.scale_factor();
            (size.width as f64 / scale, size.height as f64 / scale)
        })
        .unwrap_or((1920.0, 1080.0));

    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("reminder.html".into()))
        .title("Buy reminder")
        .inner_size(WIDTH, HEIGHT)
        .position((screen_width - WIDTH) / 2.0, screen_height * 0.09)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false) // never pulls focus out of the game
        .visible(false)
        .initialization_script(include_str!("reminder_bridge.js"));
    #[cfg(windows)]
    if let Some(dir) = crate::webview_data_dir() {
        builder = builder.data_directory(dir);
    }
    let window = builder.build()?;

    // Clicks pass straight through to the game.
    let _ = window.set_ignore_cursor_events(true);
    Ok(window)
}

/// Must not be called from the main thread: `WebviewWindowBuilder::build`
/// waits on the event loop, which the main thread is the one running.
pub fn show(app: &AppHandle, reminder: &Reminder) -> anyhow::Result<()> {
    let window = ensure_window(app)?;

    let payload = serde_json::json!({
        "index": reminder.index,
        "gold": reminder.gold,
        "currentGold": reminder.current_gold,
        "totalSteps": reminder.total_steps,
        "champKey": reminder.champ_key,
        "items": reminder.items,
        "durationMs": DURATION_MS,
        "ddragonVersion": llm_core::champion_data::latest_version(),
    });

    // The page may still be loading the first time; it asks for the last
    // payload itself once ready (see reminder_bridge.js), so both orders work.
    *LAST_PAYLOAD.lock() = Some(payload.clone());
    let _ = window.emit("buy-reminder", payload);
    let _ = window.set_always_on_top(true);
    let _ = window.show();

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(DURATION_MS)).await;
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.hide();
        }
    });
    Ok(())
}

static LAST_PAYLOAD: parking_lot::Mutex<Option<serde_json::Value>> = parking_lot::Mutex::new(None);

/// The popup page calls this on load, so a payload emitted before the webview
/// finished booting isn't lost.
#[tauri::command]
pub fn get_pending_reminder() -> Option<serde_json::Value> {
    LAST_PAYLOAD.lock().clone()
}
