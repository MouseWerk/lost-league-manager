//! System tray icon: quick account launching and the only way to actually quit.

use llm_core::accounts;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub const ID: &str = "main-tray";

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "title", "Lost League Manager", false, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    // Up to ten accounts, launchable without opening the window.
    for account in accounts::load().iter().take(10) {
        let label = if account.label.is_empty() { &account.username } else { &account.label };
        let region = if account.region.is_empty() {
            String::new()
        } else {
            format!("  {}", account.region.to_uppercase())
        };
        menu.append(&MenuItem::with_id(
            app,
            format!("launch::{}", account.username),
            format!("{label}{region}"),
            true,
            None::<&str>,
        )?)?;
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "open", "Open", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
    Ok(menu)
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    TrayIconBuilder::with_id(ID)
        .icon(app.default_window_icon().cloned().expect("bundled window icon"))
        .tooltip("Lost League Manager")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "open" => show_main(app),
                "quit" => app.exit(0),
                other => {
                    if let Some(username) = other.strip_prefix("launch::") {
                        let launcher = app.clone();
                        let username = username.to_string();
                        tauri::async_runtime::spawn(async move {
                            let state = launcher.state::<crate::state::AppState>();
                            crate::launch::launch_account(&launcher, &state, &username).await;
                        });
                        show_main(app);
                    }
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Rebuilds the account entries after an add/edit/delete/import. The taskbar
/// jump list lists the same accounts, so it is refreshed alongside.
pub fn refresh(app: &AppHandle) {
    #[cfg(windows)]
    crate::jumplist::refresh();

    if let Some(tray) = app.tray_by_id(ID) {
        match build_menu(app) {
            Ok(menu) => {
                let _ = tray.set_menu(Some(menu));
            }
            Err(e) => tracing::error!("[Tray] Could not rebuild the menu: {e}"),
        }
    }
}
