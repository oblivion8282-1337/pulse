//! Der Direktpfad-Sender: derselbe schmale Zuschnitt wie `WhipSender` in den
//! Sidecars (`connect`/`send`/`send_audio`/`close`), nur ist er ANTWORTER
//! statt Angeboter.
//!
//! **Warum hier und nicht (nur) im Sidecar.** Paketierung, Taktgeber,
//! SDP-Bau und Bildmarke liegen seit dem 2026-08-20 gemeinsam in dieser
//! Crate — der Direktpfad braucht dieselben Teile. Was er NICHT hier tut:
//! Rückkanal-Behandlung. PLI/FIR müssen beim Aufrufer landen (im Sidecar:
//! `crate::keyframe::request_keyframe`), und die Zustandsmeldungen der
//! Verbindung sind dessen Ereignis-Sprache. Deshalb stellt [`DirectSender`]
//! Spur und PC bereit ([`DirectSender::video_sender`],
//! [`DirectSender::pc`]); wer die Rückkanäle liest und welche Zustands-
//! übersicht er daraus macht, bleibt Sache des Aufrufers. **Es darf nur EIN
//! Zustands-Handler je PC angemeldet werden** (webrtc-rs ersetzt, nicht
//! stapelt) — der Sender meldet keinen eigenen an.
//!
//! **Aushandlung.** `connect` bekommt das ANGEBOT des Players (nicht die
//! Answer — die erzeugt es selbst, ein Antworter kann ohne Angebot keine
//! bauen) und kehrt erst zurück, wenn der Answer alle Kandidaten trägt
//! (nicht-trickle). Ab da ist die Sitzung verdrahtet: `send`/`send_audio`
//! paketieren und takten wie im WHIP-Weg, nur dass die Gegenseite der Player
//! ist und kein MediaMTX.
//!
//! **Kein FlexFEC auf diesem Weg.** MediaMTX erzeugte ihn auf dem Server-Pfad;
//! der Player bietet ihn nicht an. Verlust-Reparatur läuft deshalb über den
//! NACK-Responder (`register_default_interceptors`, an unserer `nack`-
//! Rückmeldung) und die Vollbild-Anforderung — der Responder ist mit dem
//! selben Media-Engine-Aufbau aktiv wie im WHIP-Weg.

pub mod rtc;
pub mod sdp;
pub mod stun;

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result};
use bytes::Bytes;
use webrtc::api::media_engine::MIME_TYPE_AV1;
use webrtc::media::Sample;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp::codecs::h264::H264Payloader;
use webrtc::rtp::header::Header;
use webrtc::rtp::packet::Packet;
use webrtc::rtp::packetizer::Payloader;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

use pulse_bildmarke as bildmarke;
use pulse_bildmarke::EXTMAP_URI;

use crate::av1::{self, SpurZustand};
use crate::h264::h264_ist_vollbild;
use crate::pacer;

/// Eigene Laufzeit des Direktpfads — bewusst getrennt von anderen Wegen,
/// dieselbe Begründung wie beim WHIP-Sender des Sidecars: ein hängender
/// Aushandlungs-Aufruf darf den Medienstrom nicht mit anhalten.
///
/// Öffentlich, weil der Aufrufer seinen RTCP-Lesefaden auf DENSELBEN Pool
/// stellen soll, statt einen zweiten zu bauen.
pub fn laufzeit() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("direct tokio runtime bauen")
    })
}

/// Eine Dauer, aus der webrtc-rs **genau** `takte` RTP-Takte macht. Dieselbe
/// Falle wie im WHIP-Sender (`dauer_fuer_takte` dort): `as u32` schneidet ab,
/// 1/30 s mal 90000 ergibt in f64 2999,999… und daraus wird 2999 — 20 ms je
/// Minute Wanderung, ohne dass ein Fehler auftaucht. Die halbe Takt-Zugabe
/// ist dort gemessen und begründet; hier gilt dieselbe Rechnung für den Ton.
pub fn dauer_fuer_takte(takte: u32, uhr: u32) -> Duration {
    let ns = (f64::from(takte) + 0.5) * 1e9 / f64::from(uhr);
    Duration::from_nanos(ns.round() as u64)
}

/// Wie ein encodiertes Bild in RTP-Nutzlasten zerfaellt. Derselbe Schnitt wie
/// im WHIP-Sender: der eigene AV1-Paketierer, webrtc-rs' H.264-Zerleger.
enum Paketierer {
    Av1,
    H264(H264Payloader),
}

/// Soll gegen Ist des Taktgebers ins Protokoll — Form und Begruendung im
/// WHIP-Sender (`melde_verteilung` dort). Nur das Etikett unterscheidet sich.
fn melde_verteilung(soll_ms: f64, ist_ms: f64, pakete: usize) {
    eprintln!(
        "[direct] Verteilung je Bild: soll {soll_ms:.2} ms, ist {ist_ms:.2} ms ({pakete} Pakete)"
    );
}

/// Was der Aufbau über den Strom wissen muss. Die Maße sind die des ANGEBOTS
/// (fmtp-Stufe), nicht die der Aufnahme — die steht beim Aushandeln noch
/// nicht fest; eine zu HOCH angesetzte H.264-Stufe ist folgenlos, eine zu
/// niedrige die dokumentierte Fehlerklasse (`crate::sdp::codec_capability`).
#[derive(Debug, Clone)]
pub struct Konfig {
    /// Codec-Kurzname wie im `start`-Request — `"h264"` oder `"av1"`.
    pub codec_slug: &'static str,
    pub fps: u32,
    pub breite: u32,
    pub hoehe: u32,
    /// Ziel-Bitrate — Maßstab für die REMB-Einordnung beim Aufrufer.
    pub bitrate_kbps: u32,
}

pub struct DirectSender {
    track: Bildspur,
    audio: Arc<TrackLocalStaticSample>,
    pc: Arc<RTCPeerConnection>,
    /// Der Video-Sender — der Aufrufer liest hier RTCP ab (PLI/FIR/REMB).
    video_sender: Arc<webrtc::rtp_transceiver::rtp_sender::RTCRtpSender>,
    codec_slug: &'static str,
    /// Die ausgehandelte Nummer der Bildmarke; 0 = nicht ausgehandelt
    /// (genau wie im WHIP-Sender: „Marke oder nichts").
    marken_id: AtomicU8,
    geschlossen: AtomicBool,
}

struct Bildspur {
    zustand: Mutex<(SpurZustand, Paketierer)>,
    pacer: Option<pacer::Pacer>,
    track: Arc<TrackLocalStaticRTP>,
}

impl DirectSender {
    /// Baut PC und Spuren. Noch KEINE Aushandlung — die passiert in
    /// [`DirectSender::connect`], getrennt, weil der Aufrufer erst hier
    /// zwischen Baufehler (Encoder-/Konfig-Seite) und Aushandlungsfehler
    /// (Gegenseite) unterscheiden kann.
    pub fn neu(konfig: &Konfig) -> Result<Self> {
        rtc::sorge_krypto_provider();
        let cap = crate::sdp::codec_capability(konfig.codec_slug, konfig.breite, konfig.hoehe, konfig.fps)?;
        let audio_cap = crate::sdp::opus_capability();
        let fps = konfig.fps.max(1);
        // Der echte Bildabstand — geht an den Taktgeber. Die Bild-Zeitstempel
        // selbst kommen aus dem Encoder-`pts` (wie im WHIP-Sender begründet).
        let frame_dauer = Duration::from_secs_f64(1.0 / f64::from(fps));

        let api = rtc::baue_api(&cap, &audio_cap)?;
        let pc = Arc::new(api.new_peer_connection(rtc::eis_konfiguration()).await_val());
        let _ = &pc;
        unreachable!()
    }
}
