//! Finding the League install.

use std::path::{Path, PathBuf};

/// Riot Client records every installed product's real location here regardless
/// of drive or launcher (Steam, manual, custom), which makes it the
/// authoritative way to heal a stale configured path without asking the user.
fn installs_json() -> PathBuf {
    let program_data = std::env::var("PROGRAMDATA").unwrap_or_else(|_| r"C:\ProgramData".into());
    Path::new(&program_data)
        .join("Riot Games")
        .join("RiotClientInstalls.json")
}

fn from_installs_json() -> Option<String> {
    let raw = std::fs::read_to_string(installs_json()).ok()?;
    let data: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&raw).ok()?;

    let keys: Vec<&String> = data.keys().filter(|k| k.starts_with("league_of_legends")).collect();
    // Prefer the live channel when several are installed (PBE, etc.).
    let key = keys.iter().find(|k| k.ends_with(".live")).or_else(|| keys.first())?;
    let install_dir = data.get(*key)?.as_str()?;

    let exe = Path::new(install_dir).join("LeagueClient.exe");
    exe.exists().then(|| exe.to_string_lossy().to_string())
}

const DRIVE_SUBPATHS: &[&[&str]] = &[
    &["Riot Games", "League of Legends"],
    &["Program Files", "Riot Games", "League of Legends"],
    &["Program Files (x86)", "Riot Games", "League of Legends"],
    &["SteamLibrary", "steamapps", "common", "Riot Games", "League of Legends"],
];

fn from_common_drives() -> Option<String> {
    for drive in ["C", "D", "E", "F", "G", "H"] {
        for sub in DRIVE_SUBPATHS {
            let mut path = PathBuf::from(format!("{drive}:\\"));
            for part in *sub {
                path.push(part);
            }
            path.push("LeagueClient.exe");
            if path.exists() {
                return Some(path.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// A working LeagueClient.exe path: the configured one if it still exists,
/// otherwise an auto-detected one. None when nothing is found, so callers leave
/// an unresolvable configured path untouched rather than replacing it with a
/// guess.
pub fn resolve(configured: &str) -> Option<String> {
    if !configured.is_empty() && Path::new(configured).exists() {
        return Some(configured.to_string());
    }
    from_installs_json().or_else(from_common_drives)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_existing_configured_path_is_kept_as_is() {
        // Any file that exists will do — the check is existence, not shape.
        let existing = std::env::current_exe().unwrap();
        let path = existing.to_string_lossy().to_string();
        assert_eq!(resolve(&path).as_deref(), Some(path.as_str()));
    }

    #[test]
    fn a_missing_path_falls_through_to_detection() {
        let bogus = r"Z:\definitely\not\here\LeagueClient.exe";
        // Either a real install is found on this machine, or nothing is —
        // never the bogus path.
        assert_ne!(resolve(bogus).as_deref(), Some(bogus));
    }

    #[test]
    fn an_empty_path_is_not_treated_as_valid() {
        assert_ne!(resolve("").as_deref(), Some(""));
    }
}
