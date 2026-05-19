//! Stream-/Server-Profile + Audio-Mode-Tabelle.
//!
//! Wire-kompatibel mit `streaming/gsr-sidecar/profiles.py` — die `list_profiles`-
//! Response (Namen, Codec-/Audio-/Container-/Bitrate-/FPS-Werte, `needs_custom_build`,
//! Notes) hat exakt dieselbe Shape wie auf Linux, damit der Renderer (`web/src/lib/stream/`)
//! plattform-blind ist.
//!
//! `ServerProfile::from_channel` baut die Push-URL für den Pulse-Channel-Pfad —
//! wenn media-svc bereits eine `push_url` mitgibt (Token drin), wird die verbatim
//! genutzt; sonst rekonstruieren wir die URL nach derselben Form wie auf Linux:
//!
//! ```text
//! RTMP: rtmp://<host>:1935/channel-<id>?user=<user>&pass=<token>
//! SRT:  srt://<host>:8890?streamid=publish:channel-<id>:<user>:<token>&pkt_size=1316
//! ```

use serde::Serialize;

/// Codec/Bitrate/FPS/Container-Preset. Wire-kompatibel mit StreamProfile aus
/// `gsr-sidecar/profiles.py`.
#[derive(Debug, Clone, Serialize)]
pub struct StreamProfile {
    pub name: &'static str,
    pub codec: &'static str,
    pub audio_codec: &'static str,
    pub container: &'static str,
    pub bitrate_kbps: u32,
    pub fps: u32,
    pub needs_custom_build: bool,
    pub notes: &'static str,
}

/// Push-Ziel — entweder verbatim aus media-svc (`push_url`) oder aus
/// `mediamtx_endpoint`+`push_protocol`+`token` rekonstruiert.
///
/// Day-1-Skelett trägt die Daten; URL-Rekonstruktion landet im start/build_argv
/// wenn die FFmpeg-Pipeline steht (Stages 5-8).
#[derive(Debug, Clone)]
#[allow(dead_code)] // Felder werden in Stage 4 (build_argv) gelesen.
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
    /// Pulse-Channel-Pfad — mirror von `ServerProfile.from_channel` aus
    /// `profiles.py`. `push_url` aus media-svc ist autoritativ.
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

/// `host` oder `host:port` → (host, port?). Ignoriert IPv6-Klammer-Form (`[::]:1935`)
/// genauso wie die Python-Variante — wer das braucht passt sich an.
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

// ── Statische Profil-Tabelle ────────────────────────────────────────────────
//
// 1:1 aus `gsr-sidecar/profiles.py`. Namen + Notes auf Deutsch wie im Original,
// damit das Settings-Modal in `web/src/lib/components/settings/SettingsScreenShare.svelte`
// auf beiden Plattformen identische Strings findet.

pub const PROFILES: &[StreamProfile] = &[
    StreamProfile {
        name: "AV1 Effizient",
        codec: "av1",
        audio_codec: "opus",
        container: "flv",
        bitrate_kbps: 4000,
        fps: 60,
        needs_custom_build: true,
        notes: "Halbe Bandbreite, gleiche Qualität. Browser muss AV1 können.",
    },
    StreamProfile {
        name: "H.264 Standard",
        codec: "h264",
        audio_codec: "opus",
        container: "flv",
        bitrate_kbps: 4000,
        fps: 60,
        needs_custom_build: true,
        notes: "Universelle Browser-Kompat, Audio in WebRTC.",
    },
    StreamProfile {
        name: "H.264 Sparmodus",
        codec: "h264",
        audio_codec: "opus",
        container: "flv",
        bitrate_kbps: 4000,
        fps: 60,
        needs_custom_build: true,
        notes: "Halbe Bandbreite, leicht pixeliger bei Bewegung.",
    },
    StreamProfile {
        name: "Custom",
        codec: "h264",
        audio_codec: "opus",
        container: "flv",
        bitrate_kbps: 4000,
        fps: 60,
        needs_custom_build: true,
        notes: "Override-Sektion in der UI nutzen.",
    },
];

#[allow(dead_code)]
pub fn profile_by_name(name: &str) -> Option<&'static StreamProfile> {
    PROFILES.iter().find(|p| p.name == name)
}

/// Audio-Modi mit Labels die der Renderer im Settings-Modal anzeigt. Werte
/// (Linux: `"default_output"` etc.) werden auf Windows in WASAPI-Endpoint-IDs
/// übersetzt; das passiert in Stage 6 (audio capture).
pub const AUDIO_MODES: &[&str] = &["Aus", "Desktop", "Mikrofon", "Desktop + Mikrofon"];

pub const APP_LABEL_PREFIX: &str = "App: ";
