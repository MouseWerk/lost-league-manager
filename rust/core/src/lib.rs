//! Domain layer for Lost League Manager.
//!
//! Everything here is runtime-agnostic: no windows, no IPC, no Tauri. The
//! desktop shell in `llm-app` wires these services to a UI, and `cargo test`
//! exercises them on their own.

pub mod accounts;
pub mod build_paths;
pub mod builds_api;
pub mod build_reminder;
pub mod champion_data;
pub mod config;
pub mod encryption;
pub mod honor_watch;
pub mod item_data;
pub mod json_store;
pub mod lcu;
pub mod league_path;
pub mod live_client;
pub mod paths;
pub mod rank_history;
pub mod riot_api;

#[cfg(test)]
mod test_support;
