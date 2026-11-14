//! Launching an account, and the client-maintenance actions from Tools.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use llm_core::accounts;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

static CANCELLED: AtomicBool = AtomicBool::new(false);

pub fn cancel() {
    CANCELLED.store(true, Ordering::SeqCst);
    kill_login_script();
}

fn command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// The Riot Client executable that sits alongside the configured League path.
fn riot_client_path() -> Option<PathBuf> {
    let program_data = std::env::var("PROGRAMDATA").unwrap_or_else(|_| r"C:\ProgramData".into());
    let installs = Path::new(&program_data).join("Riot Games/RiotClientInstalls.json");
    let raw = std::fs::read_to_string(installs).ok()?;
    let data: serde_json::Map<String, Value> = serde_json::from_str(&raw).ok()?;
    for key in ["rc_live", "rc_default", "rc_beta"] {
        if let Some(path) = data.get(key).and_then(|v| v.as_str()) {
            if Path::new(path).exists() {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

/// Where login.ps1 lives — next to the executable once bundled, in the repo
/// during development.
fn login_script(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resource) = app.path().resolve("resources/scripts/login.ps1", tauri::path::BaseDirectory::Resource) {
        if resource.exists() {
            return Some(resource);
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources/scripts/login.ps1");
    dev.exists().then_some(dev)
}

fn emit_status(app: &AppHandle, message: &str, progress: u8) {
    let _ = app.emit("login-status", json!({ "message": message, "progress": progress }));
}

/// Maps a line of the login script's chatter to what the launch overlay shows.
fn progress_for(line: &str) -> Option<(&'static str, u8)> {
    let checks: &[(&str, &str, u8)] = &[
        ("Waiting for Riot Client", "Waiting for client window…", 55),
        ("Found window", "Client found, entering login…", 65),
        ("Credentials submitted", "Waiting for League to start…", 80),
        ("Polling for League", "Waiting for League to start…", 82),
        ("Launch triggered", "Launching League…", 88),
        ("League client detected", "League is launching!", 95),
        ("League client is now", "League is starting!", 97),
        ("Login script complete", "Done!", 100),
    ];
    checks
        .iter()
        .find(|(needle, _, _)| line.contains(needle))
        .map(|(_, message, pct)| (*message, *pct))
}

pub async fn launch_account(app: &AppHandle, state: &AppState, username: &str) -> Value {
    CANCELLED.store(false, Ordering::SeqCst);

    let vault_on = state.config.read().vault_enabled;
    if vault_on && !*state.vault_unlocked.read() {
        return json!({ "success": false, "message": "Unlock the vault first" });
    }

    let Some(account) = accounts::load().into_iter().find(|a| a.username == username) else {
        return json!({ "success": false, "message": "Account not found" });
    };
    let Some(password) = accounts::reveal_password(username) else {
        return json!({
            "success": false,
            "message": "That account's password could not be decrypted — re-enter it in the account form"
        });
    };

    let _ = app.emit(
        "launch-account-info",
        json!({
            "username": account.username,
            "label": account.label,
            "region": account.region,
            "riotId": account.riot_id,
        }),
    );
    emit_status(app, "Starting Riot Client…", 20);

    *state.current_account.write() = Some(username.to_string());

    let riot_client = riot_client_path();
    let league_path = state.config.read().lol_path.clone();

    // Launch the exe directly rather than through a shell: a configured path
    // containing quotes would otherwise be a command-injection vector.
    if let Some(client) = &riot_client {
        let _ = command(client.to_string_lossy().as_ref())
            .args(["--launch-product=league_of_legends", "--launch-patchline=live"])
            .spawn();
    } else if Path::new(&league_path).exists() {
        let _ = command(&league_path).spawn();
    } else {
        return json!({ "success": false, "message": "No valid Riot Client or League path configured" });
    }

    emit_status(app, "Waiting for client window...", 50);

    let Some(script) = login_script(app) else {
        return json!({ "success": false, "message": "login.ps1 is missing from this install" });
    };

    let mut child = match command("powershell.exe")
        .args([
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script.to_string_lossy().as_ref(),
            "-Username",
            &account.username,
            "-RiotClientPath",
            riot_client.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default().as_str(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => return json!({ "success": false, "message": format!("Could not start the login script: {e}") }),
    };

    // The password goes over stdin, never argv: another local process can read
    // a command line (Task Manager shows it), which would leak the credential
    // despite it being encrypted at rest.
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(format!("{password}\n").as_bytes());
    }
    drop(child.stdin.take());

    let stdout = child.stdout.take();
    let app_for_reader = app.clone();
    let reader = std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                tracing::info!("[Login Script] {line}");
                if let Some((message, progress)) = progress_for(&line) {
                    emit_status(&app_for_reader, message, progress);
                }
            }
        }
    });

    let status = tokio::task::spawn_blocking(move || child.wait()).await;
    let _ = reader.join();

    if CANCELLED.load(Ordering::SeqCst) {
        return json!({ "success": false, "message": "Cancelled" });
    }
    match status {
        Ok(Ok(status)) if status.success() => {
            emit_status(app, "Done!", 100);
            json!({ "success": true })
        }
        Ok(Ok(status)) => json!({
            "success": false,
            "message": format!("The login script exited with code {}", status.code().unwrap_or(-1))
        }),
        _ => json!({ "success": false, "message": "The login script did not finish" }),
    }
}

pub fn launch_client_only(league_path: &str) -> anyhow::Result<()> {
    if let Some(client) = riot_client_path() {
        command(client.to_string_lossy().as_ref())
            .args(["--launch-product=league_of_legends", "--launch-patchline=live"])
            .spawn()?;
        return Ok(());
    }
    if Path::new(league_path).exists() {
        command(league_path).spawn()?;
        return Ok(());
    }
    anyhow::bail!("No valid Riot Client or League path configured")
}

const RIOT_PROCESSES: &[&str] = &[
    "LeagueClient.exe",
    "LeagueClientUx.exe",
    "LeagueClientUxRender.exe",
    "RiotClientServices.exe",
    "RiotClientUx.exe",
    "RiotClientUxRender.exe",
    "RiotClientCrashHandler.exe",
];

fn kill_login_script() {
    let _ = command("taskkill").args(["/IM", "powershell.exe", "/F"]).output();
}

/// Ends just the League client and leaves the Riot Client running. This is how
/// a dodge is performed: there is no supported endpoint that backs out of
/// champion select cleanly.
pub fn kill_client_only() -> anyhow::Result<()> {
    let mut any = false;
    for name in ["LeagueClient.exe", "LeagueClientUx.exe"] {
        if let Ok(output) = command("taskkill").args(["/IM", name, "/F"]).output() {
            any |= output.status.success();
        }
    }
    if any {
        Ok(())
    } else {
        anyhow::bail!("The League client does not appear to be running")
    }
}

/// Ends every Riot process — the "client is stuck" button.
pub fn kill_riot_processes() -> usize {
    let mut killed = 0;
    for name in RIOT_PROCESSES {
        if let Ok(output) = command("taskkill").args(["/IM", name, "/F"]).output() {
            if output.status.success() {
                killed += 1;
            }
        }
    }
    killed
}

/// Starts Riot's own repair tool against the League install.
pub fn repair_client(league_path: &str) -> anyhow::Result<()> {
    let client = riot_client_path().ok_or_else(|| anyhow::anyhow!("Riot Client not found"))?;
    let dir = Path::new(league_path)
        .parent()
        .ok_or_else(|| anyhow::anyhow!("League path has no parent directory"))?;
    command(client.to_string_lossy().as_ref())
        .args([
            "--launch-product=league_of_legends",
            "--launch-patchline=live",
            "--repair",
        ])
        .current_dir(dir)
        .spawn()?;
    Ok(())
}

/// Clears the client's caches. Only removes known cache directories, never the
/// install itself.
pub fn clear_cache(league_path: &str) -> anyhow::Result<usize> {
    let dir = Path::new(league_path)
        .parent()
        .ok_or_else(|| anyhow::anyhow!("League path has no parent directory"))?;

    let mut removed = 0;
    for relative in ["Cache", "Logs", "Config/LeagueClientSettings.yaml"] {
        let target = dir.join(relative);
        if !target.exists() {
            continue;
        }
        let result = if target.is_dir() {
            std::fs::remove_dir_all(&target)
        } else {
            std::fs::remove_file(&target)
        };
        match result {
            Ok(()) => removed += 1,
            Err(e) => tracing::warn!("[Tools] Could not remove {}: {e}", target.display()),
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_script_chatter_maps_to_progress() {
        assert_eq!(progress_for("Waiting for Riot Client window..."), Some(("Waiting for client window…", 55)));
        assert_eq!(progress_for("Credentials submitted"), Some(("Waiting for League to start…", 80)));
        assert_eq!(progress_for("Login script complete"), Some(("Done!", 100)));
    }

    #[test]
    fn unrelated_output_does_not_move_the_bar() {
        assert_eq!(progress_for("some unrelated debug line"), None);
        assert_eq!(progress_for(""), None);
    }

    #[test]
    fn cache_clearing_refuses_a_pathless_target() {
        assert!(clear_cache("").is_err());
    }
}
