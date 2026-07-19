//! Encoder baseline values + push-target construction.
//!
//! `ServerProfile::from_channel` builds the push URL for the Pulse channel path
//! — if media-svc already passed a `push_url` (token inside), it's used
//! verbatim; otherwise we reconstruct it in the same form as on Linux:
//!
//! ```text
//! RTMP: rtmp://<host>:1935/channel-<id>?user=<user>&pass=<token>
//! SRT:  srt://<host>:8890?streamid=publish:channel-<id>:<user>:<token>&pkt_size=1316
//! ```

use serde_json::{Map, Value};

/// Codec/bitrate/fps/container baseline that unset overrides fall back to.
#[derive(Debug, Clone)]
pub struct StreamProfile {
    pub codec: &'static str,
    pub audio_codec: &'static str,
    pub container: &'static str,
    pub bitrate_kbps: u32,
    pub fps: u32,
}

/// Push target — either verbatim from media-svc (`push_url`) or reconstructed
/// from `mediamtx_endpoint` + `push_protocol` + `token`.
#[derive(Debug, Clone)]
#[allow(dead_code)] // fields read by build_argv / the future start pipeline.
pub struct ServerProfile {
    pub name: String,
    pub push_protocol: String,
    pub push_host: String,
    pub push_port: u16,
    pub push_path: String,
    pub auth_user: String,
    pub push_url: Option<String>,
}

#[allow(dead_code)]
impl ServerProfile {
    /// Pulse channel path — mirror of `ServerProfile.from_channel` in
    /// `profiles.py`. A `push_url` from media-svc is authoritative.
    pub fn from_channel(
        channel_id: &str,
        token: &str,
        mediamtx_endpoint: &str,
        push_protocol: &str,
        push_url: Option<String>,
    ) -> Self {
        let (host, endpoint_port) = parse_endpoint(mediamtx_endpoint);
        let default_port: u16 = if push_protocol == "rtmp" { 1935 } else { 8890 };
        let push_port = endpoint_port.unwrap_or(default_port);

        let auth_user = if token.is_empty() {
            "publisher".to_string()
        } else {
            token.chars().take(16).collect::<String>()
        };

        let channel_path = format!("channel-{channel_id}");

        Self {
            name: channel_path.clone(),
            push_protocol: push_protocol.to_string(),
            push_host: host,
            push_port,
            push_path: channel_path,
            auth_user,
            push_url,
        }
    }
}

/// `host` or `host:port` → (host, port?). Ignores the IPv6 bracket form
/// (`[::]:1935`) just like the Python variant.
fn parse_endpoint(endpoint: &str) -> (String, Option<u16>) {
    if endpoint.starts_with('[') {
        return (endpoint.to_string(), None);
    }
    match endpoint.split_once(':') {
        Some((host, port_str)) => match port_str.parse::<u16>() {
            Ok(port) => (host.to_string(), Some(port)),
            Err(_) => (endpoint.to_string(), None),
        },
        None => (endpoint.to_string(), None),
    }
}

// ── Baseline values ──────────────────────────────────────────────────────────
//
// The four-entry profile catalogue that used to live here was dropped on
// 2026-07-19 together with the `list_profiles` op; these are exactly the values
// of its former "Custom" entry, which is the only one the renderer ever asked
// for. Full rationale in `streaming/win-hq-sidecar/src/profiles.rs`.

pub static BASELINE: StreamProfile = StreamProfile {
    codec: "h264",
    audio_codec: "opus",
    container: "flv",
    bitrate_kbps: 4000,
    fps: 60,
};

/// The `profile` field from `start`/`build_argv` is a label only since the
/// catalogue went away: it shows up in the diagnostic argv but no longer
/// selects anything. Older renderers still send it — its absence is not an error.
pub fn profile_label(params: &Map<String, Value>) -> &str {
    params.get("profile").and_then(Value::as_str).unwrap_or("Custom")
}

pub const APP_LABEL_PREFIX: &str = "App: ";
