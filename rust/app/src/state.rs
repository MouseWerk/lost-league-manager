use std::sync::Arc;

use llm_core::{build_reminder::BuildReminder, config::Config, lcu::Lcu};
use parking_lot::{Mutex, RwLock};

pub struct AppState {
    pub config: RwLock<Config>,
    pub http: reqwest::Client,
    pub lcu: Lcu,
    pub reminder: Mutex<BuildReminder>,
    /// Which stored account this app launched, if any. Only ever set by a
    /// launch; verified against the logged-in summoner before it's trusted for
    /// anything account-specific.
    pub current_account: RwLock<Option<String>>,
    /// Session-only. True once the vault password has been verified by the
    /// backend for this run; gates `get_account_password`, because the
    /// frontend's lock screen alone is not a trust boundary — anyone with
    /// devtools can call the command directly.
    pub vault_unlocked: RwLock<bool>,
    /// Shared with the LCU watcher, which re-reads it every reconnect so a
    /// path change in Settings takes effect without a restart.
    pub league_path: Arc<RwLock<String>>,
    /// Drives Discord Rich Presence.
    pub discord: crate::discord::Sender,
}

impl AppState {
    pub fn new(config: Config) -> anyhow::Result<Self> {
        let league_path = Arc::new(RwLock::new(config.lol_path.clone()));
        let mut reminder = BuildReminder::default();
        reminder.enabled = config.build_reminders_enabled;
        let discord = crate::discord::spawn(config.discord_rpc_enabled);

        Ok(Self {
            config: RwLock::new(config),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()?,
            lcu: Lcu::new()?,
            reminder: Mutex::new(reminder),
            current_account: RwLock::new(None),
            vault_unlocked: RwLock::new(false),
            league_path,
            discord,
        })
    }

    pub fn save_config(&self) -> anyhow::Result<()> {
        self.config.read().save()
    }
}
