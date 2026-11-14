//! League Client Update API.
//!
//! The client writes a `lockfile` next to LeagueClient.exe holding the port and
//! a per-session password; that's the whole handshake. REST goes over HTTPS
//! with Basic auth, and a WebSocket subscription streams every client event.
//! Both use Riot's self-signed loopback certificate, so verification is off for
//! this host only.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use parking_lot::RwLock;
use serde::Deserialize;
use tokio::sync::mpsc;

#[derive(Debug, Clone, PartialEq)]
pub struct Credentials {
    pub port: u16,
    pub password: String,
    pub protocol: String,
}

/// lockfile format: `LeagueClient:<pid>:<port>:<password>:<protocol>`
pub fn parse_lockfile(contents: &str) -> Option<Credentials> {
    let parts: Vec<&str> = contents.trim().split(':').collect();
    if parts.len() < 5 {
        return None;
    }
    Some(Credentials {
        port: parts[2].parse().ok()?,
        password: parts[3].to_string(),
        protocol: parts[4].to_string(),
    })
}

pub fn read_lockfile(league_client_exe: &str) -> Option<Credentials> {
    let dir = crate::paths::league_dir(league_client_exe)?;
    let contents = std::fs::read_to_string(dir.join("lockfile")).ok()?;
    parse_lockfile(&contents)
}

/// One client event from the OnJsonApiEvent subscription.
#[derive(Debug, Clone, Deserialize)]
pub struct LcuEvent {
    #[serde(default)]
    pub uri: String,
    #[serde(default, rename = "eventType")]
    pub event_type: String,
    #[serde(default)]
    pub data: serde_json::Value,
}

/// Pulls the event payload out of the client's `[8, "OnJsonApiEvent", {...}]`
/// wire frame. Anything else on the socket is not an event.
pub fn parse_event_frame(text: &str) -> Option<LcuEvent> {
    let frame: serde_json::Value = serde_json::from_str(text).ok()?;
    let array = frame.as_array()?;
    if array.len() < 3 || array[0].as_i64() != Some(8) || array[1].as_str() != Some("OnJsonApiEvent") {
        return None;
    }
    serde_json::from_value(array[2].clone()).ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Connection {
    Connected,
    Disconnected,
}

/// Handlers registered against the client event stream.
pub type EventSender = mpsc::UnboundedSender<LcuEvent>;
pub type StatusSender = mpsc::UnboundedSender<Connection>;

#[derive(Clone)]
pub struct Lcu {
    credentials: Arc<RwLock<Option<Credentials>>>,
    client: reqwest::Client,
}

impl Lcu {
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self {
            credentials: Arc::new(RwLock::new(None)),
            client: reqwest::Client::builder()
                .danger_accept_invalid_certs(true)
                .timeout(std::time::Duration::from_secs(10))
                .build()?,
        })
    }

    pub fn connected(&self) -> bool {
        self.credentials.read().is_some()
    }

    pub fn set_credentials(&self, creds: Option<Credentials>) {
        *self.credentials.write() = creds;
    }

    fn auth_header(password: &str) -> String {
        use base64::Engine;
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("riot:{password}"))
        )
    }

    /// A client request. Returns None on any failure: 404/400/500 are routine
    /// while the client is starting or when an endpoint doesn't exist in this
    /// client version, so they're not worth surfacing as errors.
    pub async fn request(
        &self,
        method: reqwest::Method,
        endpoint: &str,
        body: Option<serde_json::Value>,
    ) -> Option<serde_json::Value> {
        let (port, password) = {
            let guard = self.credentials.read();
            let creds = guard.as_ref()?;
            (creds.port, creds.password.clone())
        };

        let mut request = self
            .client
            .request(method, format!("https://127.0.0.1:{port}{endpoint}"))
            .header("Authorization", Self::auth_header(&password))
            .header("Content-Type", "application/json");
        if let Some(body) = body {
            request = request.json(&body);
        }

        let response = request.send().await.ok()?;
        let status = response.status();
        if !status.is_success() {
            if !matches!(status.as_u16(), 400 | 404 | 500) {
                tracing::error!("LCU {endpoint}: {status}");
            }
            return None;
        }
        // Some endpoints answer 204 with an empty body.
        let text = response.text().await.ok()?;
        if text.trim().is_empty() {
            return Some(serde_json::Value::Null);
        }
        serde_json::from_str(&text).ok()
    }

    pub async fn get(&self, endpoint: &str) -> Option<serde_json::Value> {
        self.request(reqwest::Method::GET, endpoint, None).await
    }

    pub async fn post(&self, endpoint: &str, body: Option<serde_json::Value>) -> Option<serde_json::Value> {
        self.request(reqwest::Method::POST, endpoint, body).await
    }

    pub async fn patch(&self, endpoint: &str, body: serde_json::Value) -> Option<serde_json::Value> {
        self.request(reqwest::Method::PATCH, endpoint, Some(body)).await
    }

    pub async fn put(&self, endpoint: &str, body: serde_json::Value) -> Option<serde_json::Value> {
        self.request(reqwest::Method::PUT, endpoint, Some(body)).await
    }
}

/// Watches for the client, holds the event socket open while it's up, and
/// reports connect/disconnect. Runs until the receiver is dropped.
pub async fn run_event_loop(
    lcu: Lcu,
    league_path: Arc<RwLock<String>>,
    events: EventSender,
    status: StatusSender,
) {
    loop {
        let creds = { read_lockfile(&league_path.read().clone()) };
        let Some(creds) = creds else {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            continue;
        };

        lcu.set_credentials(Some(creds.clone()));
        match subscribe(&creds, &events, &status).await {
            Ok(()) => tracing::info!("[LCU] Socket closed"),
            Err(e) => tracing::debug!("[LCU] Socket ended: {e}"),
        }
        lcu.set_credentials(None);
        let _ = status.send(Connection::Disconnected);

        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

async fn subscribe(
    creds: &Credentials,
    events: &EventSender,
    status: &StatusSender,
) -> anyhow::Result<()> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let mut request = format!("wss://127.0.0.1:{}/", creds.port).into_client_request()?;
    use base64::Engine;
    request.headers_mut().insert(
        "Authorization",
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("riot:{}", creds.password))
        )
        .parse()?,
    );

    let connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()?;

    let (mut socket, _) = tokio_tungstenite::connect_async_tls_with_config(
        request,
        None,
        false,
        Some(tokio_tungstenite::Connector::NativeTls(connector)),
    )
    .await?;

    tracing::info!("[LCU] Connected");
    let _ = status.send(Connection::Connected);
    // 5 = SUBSCRIBE in the client's wamp-ish protocol.
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            r#"[5,"OnJsonApiEvent"]"#.to_string(),
        ))
        .await?;

    while let Some(message) = socket.next().await {
        let message = message?;
        if let tokio_tungstenite::tungstenite::Message::Text(text) = message {
            if let Some(event) = parse_event_frame(&text) {
                if events.send(event).is_err() {
                    break; // nobody is listening any more
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_real_lockfile() {
        let creds = parse_lockfile("LeagueClient:26496:52847:AbC-dEf_123:https").unwrap();
        assert_eq!(creds.port, 52847);
        assert_eq!(creds.password, "AbC-dEf_123");
        assert_eq!(creds.protocol, "https");
    }

    #[test]
    fn tolerates_a_trailing_newline() {
        assert!(parse_lockfile("LeagueClient:1:2:pw:https\n").is_some());
    }

    #[test]
    fn rejects_a_truncated_lockfile() {
        assert_eq!(parse_lockfile("LeagueClient:26496"), None);
        assert_eq!(parse_lockfile(""), None);
        assert_eq!(parse_lockfile("LeagueClient:1:notaport:pw:https"), None);
    }

    #[test]
    fn reads_the_event_payload_out_of_a_frame() {
        let event = parse_event_frame(
            r#"[8,"OnJsonApiEvent",{"uri":"/lol-gameflow/v1/gameflow-phase","eventType":"Update","data":"ReadyCheck"}]"#,
        )
        .unwrap();
        assert_eq!(event.uri, "/lol-gameflow/v1/gameflow-phase");
        assert_eq!(event.event_type, "Update");
        assert_eq!(event.data.as_str(), Some("ReadyCheck"));
    }

    #[test]
    fn ignores_frames_that_are_not_events() {
        assert!(parse_event_frame(r#"[5,"OnJsonApiEvent"]"#).is_none());
        assert!(parse_event_frame(r#"[8,"SomethingElse",{}]"#).is_none());
        assert!(parse_event_frame("not json").is_none());
        assert!(parse_event_frame("{}").is_none());
    }

    #[test]
    fn builds_the_basic_auth_header_the_client_expects() {
        // riot:test -> cmlvdDp0ZXN0
        assert_eq!(Lcu::auth_header("test"), "Basic cmlvdDp0ZXN0");
    }

    #[test]
    fn requests_without_credentials_do_nothing() {
        let lcu = Lcu::new().unwrap();
        assert!(!lcu.connected());
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(lcu.get("/lol-summoner/v1/current-summoner"));
        assert!(result.is_none());
    }
}
