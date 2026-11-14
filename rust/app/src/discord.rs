//! Discord Rich Presence.
//!
//! Deliberately carries no account or summoner identifiers — only the League
//! client's coarse gameflow phase, the same as the Electron build published.

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use tokio::sync::mpsc;

const CLIENT_ID: &str = "1523021601606602902";

/// Served from the public repo so no asset upload in the Discord developer
/// portal is needed — Discord resolves external image URLs directly.
const LARGE_IMAGE_URL: &str =
    "https://raw.githubusercontent.com/MouseWerk/lost-league-manager/master/src/renderer/assets/logo.png";

const IDLE_LABEL: &str = "Managing Accounts";
const RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(15);

/// Discord allows at most two buttons, and only shows them on *other* people's
/// view of the profile — never your own.
const BUTTONS: &[(&str, &str)] = &[
    ("Official Website", "https://www.lostleague.com/"),
    ("Download", "https://github.com/MouseWerk/lost-league-manager/releases/latest"),
];

pub fn phase_label(phase: &str) -> &'static str {
    match phase {
        "None" => "In Main Menu",
        "Lobby" => "In Lobby",
        "Matchmaking" => "In Queue",
        "ReadyCheck" => "Accepting Match",
        "ChampSelect" => "In Champion Select",
        "GameStart" => "Loading Into Game",
        "InProgress" => "In Game",
        "Reconnect" => "Reconnecting To Game",
        "WaitingForStats" | "PreEndOfGame" | "EndOfGame" => "Post-Game",
        _ => IDLE_LABEL,
    }
}

#[derive(Debug, Clone)]
pub enum Presence {
    /// No client connected.
    Idle,
    /// A gameflow phase straight from the LCU.
    Phase(String),
    /// The user turned the integration off; drop the connection.
    Disable,
    /// ...and back on.
    Enable,
}

pub type Sender = mpsc::UnboundedSender<Presence>;

struct Rpc {
    client: Option<DiscordIpcClient>,
    started_at: i64,
    enabled: bool,
    current: String,
}

impl Rpc {
    fn new(enabled: bool) -> Self {
        Self {
            client: None,
            started_at: chrono::Utc::now().timestamp(),
            enabled,
            current: IDLE_LABEL.to_string(),
        }
    }

    /// Connects if needed, then publishes `self.current`. Any failure drops the
    /// client so the next tick reconnects — Discord being closed is normal, not
    /// an error worth shouting about.
    fn apply(&mut self) {
        if !self.enabled {
            return;
        }
        if self.client.is_none() {
            let Ok(mut client) = DiscordIpcClient::new(CLIENT_ID) else {
                return;
            };
            match client.connect() {
                Ok(()) => {
                    tracing::info!("[DiscordRPC] Connected");
                    self.client = Some(client);
                }
                Err(_) => return, // Discord isn't running; try again later
            }
        }

        let buttons = BUTTONS
            .iter()
            .map(|(label, url)| activity::Button::new(label, url))
            .collect();
        let activity = activity::Activity::new()
            .details(&self.current)
            .assets(activity::Assets::new().large_image(LARGE_IMAGE_URL).large_text("Lost League Manager"))
            .timestamps(activity::Timestamps::new().start(self.started_at))
            .buttons(buttons);

        if let Some(client) = self.client.as_mut() {
            if client.set_activity(activity).is_err() {
                tracing::info!("[DiscordRPC] Disconnected, will retry");
                self.client = None;
            }
        }
    }

    fn shutdown(&mut self) {
        if let Some(client) = self.client.as_mut() {
            let _ = client.close();
        }
        self.client = None;
    }
}

/// Starts the presence worker and hands back the channel to drive it.
pub fn spawn(enabled: bool) -> Sender {
    let (tx, mut rx) = mpsc::unbounded_channel::<Presence>();

    tauri::async_runtime::spawn(async move {
        let mut rpc = Rpc::new(enabled);
        rpc.apply();

        loop {
            // Either a new presence arrives, or the retry timer fires and we
            // attempt a (re)connection with whatever the last state was.
            let update = tokio::time::timeout(RETRY_DELAY, rx.recv()).await;
            match update {
                Ok(Some(Presence::Idle)) => rpc.current = IDLE_LABEL.to_string(),
                Ok(Some(Presence::Phase(phase))) => rpc.current = phase_label(&phase).to_string(),
                Ok(Some(Presence::Enable)) => rpc.enabled = true,
                Ok(Some(Presence::Disable)) => {
                    rpc.enabled = false;
                    rpc.shutdown();
                    continue;
                }
                Ok(None) => break, // sender dropped — app is shutting down
                Err(_) => {}       // timeout: fall through and retry
            }
            rpc.apply();
        }
        rpc.shutdown();
    });

    tx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gameflow_phases_map_to_labels() {
        assert_eq!(phase_label("Lobby"), "In Lobby");
        assert_eq!(phase_label("ChampSelect"), "In Champion Select");
        assert_eq!(phase_label("InProgress"), "In Game");
        assert_eq!(phase_label("EndOfGame"), "Post-Game");
        assert_eq!(phase_label("WaitingForStats"), "Post-Game");
    }

    #[test]
    fn an_unknown_phase_falls_back_to_idle() {
        assert_eq!(phase_label("SomeNewPhase"), IDLE_LABEL);
        assert_eq!(phase_label(""), IDLE_LABEL);
    }

    #[test]
    fn the_presence_carries_no_account_identifiers() {
        // Everything published is a fixed label or a public URL; nothing here
        // is derived from the signed-in account.
        for phase in ["None", "Lobby", "InProgress", "anything"] {
            let label = phase_label(phase);
            assert!(!label.contains('#'), "{label}");
        }
        assert!(BUTTONS.iter().all(|(_, url)| url.starts_with("https://")));
    }
}
