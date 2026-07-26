//! WHEP-Client (`draft-ietf-wish-whep`) auf webrtc-rs.
//!
//! Bewusst derselbe Ablauf wie der Browser-Client in
//! `web/src/lib/stream/whep.ts`, damit sich beide Wege gleich verhalten:
//!
//!  1. `RTCPeerConnection`, je ein recvonly-Transceiver fuer Video und Audio.
//!  2. Offer erzeugen, `set_local_description`, ICE-Gathering abwarten
//!     (nicht-Trickle — die einfachste von MediaMTX unterstuetzte Variante).
//!  3. `POST <whepUrl>` mit `Content-Type: application/sdp`, Body = Offer-SDP.
//!     201 traegt die Answer im Body und die Resource-URL im `Location`-Header.
//!  4. `set_remote_description(answer)`.
//!  5. Abbau: `close()` + best-effort `DELETE <resourceUrl>`.
//!
//! Die WHEP-URL traegt bereits `?token=` (von media-svc nach dem
//! Membership-Check gemintet). Sie wird unveraendert durchgereicht.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use tokio::sync::mpsc;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
use webrtc::track::track_remote::TrackRemote;

/// Fester Standard-STUN wie im Browser-Client. Bei host-networking-MediaMTX
/// meist unnoetig, hilft aber hinter NAT und schadet nie.
const DEFAULT_STUN: &str = "stun:stun.l.google.com:19302";

/// Obergrenze fuers ICE-Gathering, bevor der Offer trotzdem rausgeht.
const ICE_GATHERING_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Codec {
    H264,
    Av1,
    Opus,
}

impl Codec {
    fn from_mime(mime: &str) -> Option<Self> {
        match mime.to_ascii_lowercase().as_str() {
            "video/h264" => Some(Self::H264),
            "video/av1" | "video/av1x" => Some(Self::Av1),
            "audio/opus" => Some(Self::Opus),
            _ => None,
        }
    }

    pub fn is_video(self) -> bool {
        matches!(self, Self::H264 | Self::Av1)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::H264 => "h264",
            Self::Av1 => "av1",
            Self::Opus => "opus",
        }
    }
}

/// Ein eingetroffenes RTP-Paket samt Track-Kontext.
///
/// Bewusst roh: Umsortieren macht [`crate::jitter`], Zusammensetzen
/// [`crate::depacket`]. Nur so ist der Jitter-Puffer steuerbar.
#[derive(Debug)]
pub struct RtpArrival {
    pub codec: Codec,
    /// Abtastrate des Tracks (90000 fuer Video, 48000 fuer Opus) — noetig, um
    /// RTP-Zeitstempel in Wanduhrzeit umzurechnen. Wird erst mit der
    /// Tonausgabe gebraucht (A/V-Synchronisierung), steht aber schon hier,
    /// weil nur der Track sie kennt.
    #[allow(dead_code)]
    pub clock_rate: u32,
    pub packet: webrtc::rtp::packet::Packet,
    /// Ankunftszeitpunkt, Grundlage fuer die Puffer-Freigabe.
    pub arrived: Instant,
}

pub struct WhepSession {
    pc: Arc<RTCPeerConnection>,
    resource_url: Option<String>,
    http: reqwest::Client,
}

impl WhepSession {
    /// Baut die Sitzung ab. Idempotent — mehrfaches Aufrufen ist harmlos.
    pub async fn close(&mut self) {
        let _ = self.pc.close().await;
        if let Some(url) = self.resource_url.take() {
            // Best effort: der Server laesst die Resource ohnehin auslaufen.
            let _ = self.http.delete(&url).send().await;
        }
    }
}

/// Stellt eine recvonly-WHEP-Sitzung her und schiebt fertige Frames in `tx`.
///
/// Kehrt zurueck, sobald die SDP-Aushandlung durch ist; die Frames laufen
/// danach asynchron ein. Ein Fehler beim Aufbau raeumt die halbfertige
/// PeerConnection selbst wieder ab.
pub async fn connect(
    whep_url: &str,
    extra_ice: &[String],
    tx: mpsc::Sender<RtpArrival>,
) -> Result<WhepSession> {
    let mut media = MediaEngine::default();
    media
        .register_default_codecs()
        .context("Standard-Codecs konnten nicht registriert werden")?;
    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media)
        .context("Interceptor-Registry fehlgeschlagen")?;
    let api = APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .build();

    let mut urls = vec![DEFAULT_STUN.to_string()];
    urls.extend(extra_ice.iter().cloned());
    let config = RTCConfiguration {
        ice_servers: vec![RTCIceServer { urls, ..Default::default() }],
        ..Default::default()
    };

    let pc = Arc::new(api.new_peer_connection(config).await?);

    // RTCRtpTransceiverInit ist nicht Clone — je Aufruf frisch bauen.
    let recvonly = || {
        Some(RTCRtpTransceiverInit {
            direction: RTCRtpTransceiverDirection::Recvonly,
            send_encodings: vec![],
        })
    };
    pc.add_transceiver_from_kind(RTPCodecType::Video, recvonly())
        .await
        .context("Video-Transceiver")?;
    pc.add_transceiver_from_kind(RTPCodecType::Audio, recvonly())
        .await
        .context("Audio-Transceiver")?;

    pc.on_track(Box::new(move |track, _receiver, _transceiver| {
        let tx = tx.clone();
        Box::pin(async move {
            tokio::spawn(pump_track(track, tx));
        })
    }));

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("HTTP-Client")?;

    match negotiate(&pc, &http, whep_url).await {
        Ok(resource_url) => Ok(WhepSession { pc, resource_url, http }),
        Err(e) => {
            let _ = pc.close().await;
            Err(e)
        }
    }
}

/// Offer erzeugen, ICE sammeln, an den WHEP-Endpunkt schicken, Answer setzen.
async fn negotiate(
    pc: &Arc<RTCPeerConnection>,
    http: &reqwest::Client,
    whep_url: &str,
) -> Result<Option<String>> {
    let offer = pc.create_offer(None).await.context("create_offer")?;
    pc.set_local_description(offer).await.context("set_local_description")?;

    // Nicht-Trickle: warten, bis der Offer alle Kandidaten traegt. Der Timeout
    // begrenzt den Worst Case, wenn ein STUN-Server nicht antwortet.
    let mut gathering = pc.gathering_complete_promise().await;
    let _ = tokio::time::timeout(ICE_GATHERING_TIMEOUT, gathering.recv()).await;

    let sdp = pc
        .local_description()
        .await
        .ok_or_else(|| anyhow!("keine local description nach dem Gathering"))?
        .sdp;

    let res = http
        .post(whep_url)
        .header(reqwest::header::CONTENT_TYPE, "application/sdp")
        .body(sdp)
        .send()
        .await
        .context("WHEP-Server nicht erreichbar")?;

    let status = res.status();
    if !status.is_success() {
        bail!("WHEP-POST fehlgeschlagen: HTTP {status}");
    }
    let location = res
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    let answer = res.text().await.context("Answer-Body")?;
    if !answer.contains("v=") {
        bail!("WHEP-Antwort war kein gueltiges SDP");
    }
    pc.set_remote_description(RTCSessionDescription::answer(answer)?)
        .await
        .context("set_remote_description")?;

    Ok(location.and_then(|loc| resolve_resource_url(whep_url, &loc)))
}

/// Nur gleiche Herkunft folgen — verhindert, dass ein manipulierter
/// `Location`-Header das Abbau-DELETE auf einen fremden Host umlenkt.
/// Gleiche Regel wie im Browser-Client.
fn resolve_resource_url(whep_url: &str, location: &str) -> Option<String> {
    let base = reqwest::Url::parse(whep_url).ok()?;
    let resolved = base.join(location).ok()?;
    let same_origin = resolved.scheme() == base.scheme()
        && resolved.host_str() == base.host_str()
        && resolved.port_or_known_default() == base.port_or_known_default();
    same_origin.then(|| resolved.to_string())
}

/// Liest RTP von einem Track und schiebt die Pakete unveraendert weiter.
/// Endet, wenn der Track schliesst oder der Empfaenger weg ist.
async fn pump_track(track: Arc<TrackRemote>, tx: mpsc::Sender<RtpArrival>) {
    let capability = track.codec().capability;
    let mime = capability.mime_type;
    let clock_rate = capability.clock_rate;
    let Some(codec) = Codec::from_mime(&mime) else {
        eprintln!("pulse-player: unbekannter Codec {mime}, Track wird ignoriert");
        return;
    };
    eprintln!("pulse-player: Track {mime} ({clock_rate} Hz) laeuft an");

    loop {
        let packet = match track.read_rtp().await {
            Ok((packet, _)) => packet,
            Err(e) => {
                eprintln!("pulse-player: Track {mime} beendet: {e}");
                return;
            }
        };
        let arrival = RtpArrival { codec, clock_rate, packet, arrived: Instant::now() };
        if tx.send(arrival).await.is_err() {
            return; // Verbraucher ist weg
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codec_aus_mime() {
        assert_eq!(Codec::from_mime("video/H264"), Some(Codec::H264));
        assert_eq!(Codec::from_mime("video/AV1"), Some(Codec::Av1));
        assert_eq!(Codec::from_mime("audio/opus"), Some(Codec::Opus));
        assert_eq!(Codec::from_mime("video/VP9"), None);
    }

    #[test]
    fn resource_url_nur_bei_gleicher_herkunft() {
        let base = "https://howispulse.com/whep/x?token=abc";
        assert_eq!(
            resolve_resource_url(base, "/whep/session/1").as_deref(),
            Some("https://howispulse.com/whep/session/1")
        );
        // fremder Host wird verworfen
        assert_eq!(resolve_resource_url(base, "https://evil.example/x"), None);
    }
}
