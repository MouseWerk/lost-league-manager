use std::path::{Path, PathBuf};

/// The app's data directory.
///
/// Deliberately the same folder Electron used (`%APPDATA%\leaguelogin` — Electron
/// derives it from package.json's `name`, not the display name), so an install
/// that switches to this build keeps its accounts, config, rank history and
/// build paths instead of starting empty.
pub fn data_dir() -> PathBuf {
    if let Ok(explicit) = std::env::var("LLM_DATA_DIR") {
        return PathBuf::from(explicit);
    }
    let base = dirs::config_dir() // %APPDATA% on Windows
        .unwrap_or_else(std::env::temp_dir);
    base.join("leaguelogin")
}

pub fn accounts_file() -> PathBuf {
    data_dir().join("accounts.json")
}
pub fn config_file() -> PathBuf {
    data_dir().join("config.json")
}
pub fn rank_history_file() -> PathBuf {
    data_dir().join("rank-history.json")
}
pub fn honor_watch_file() -> PathBuf {
    data_dir().join("honor-watch.json")
}
pub fn build_paths_file() -> PathBuf {
    data_dir().join("build-paths.json")
}

pub fn ensure_data_dir() -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir())
}

/// The League install directory that holds `lockfile`, derived from the
/// configured path to LeagueClient.exe.
pub fn league_dir(client_exe: &str) -> Option<PathBuf> {
    Path::new(client_exe).parent().map(|p| p.to_path_buf())
}
