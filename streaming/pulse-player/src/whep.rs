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
use webrtc::api::interceptor_registry::{configure_rtcp_reports, configure_twcc_receiver_only};
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::nack::generator::Generator;
use webrtc::interceptor::nack::responder::Responder;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::{
    RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType,
};
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::rtp_transceiver::{RTCPFeedback, RTCRtpTransceiverInit};
use webrtc::track::track_remote::TrackRemote;
use webrtc::util::Marshal;

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

    /// Traegt diese Spur Bild? Entscheidet, ob eine Luecke den Video-Decoder
    /// etwas angeht — eine Tonluecke tut das NICHT.
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

/// Entfernt Stream-Tokens aus einem Text, bevor er irgendwo hingeht, wo ihn
/// jemand sehen kann.
///
/// Notwendig, weil `reqwest` bei Transportfehlern die **vollstaendige** URL an
/// die Fehlermeldung haengt (`" for url ({url})"`) — samt `?token=`. Ueber
/// `{e:#}` landete die in der Sitzungs-Fehlermeldung, von dort im
/// `player:state`-Ereignis und schliesslich sichtbar im Fehler-Overlay der
/// Kachel. Das Read-Token ist channel- und nutzergebunden, aber
/// mehrfach verwendbar: wer den Screenshot sieht, kann mitschauen.
///
/// Projektregel: niemals Stream-Keys oder Tokens loggen.
pub fn redact_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find("token=") {
        let (before, after) = rest.split_at(pos + "token=".len());
        out.push_str(before);
        // Wert bis zum naechsten Trenner verwerfen.
        let end = after.find(['&', '"', ')', ' ', '\'']).unwrap_or(after.len());
        out.push_str("<entfernt>");
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

pub struct WhepSession {
    pc: Arc<RTCPeerConnection>,
    resource_url: Option<String>,
    http: reqwest::Client,
    /// Was die Paritaet ausgerichtet hat. Wird hier gehalten, weil der
    /// Empfaenger selbst in einer Aufgabe steckt, die von aussen niemand
    /// erreicht — s. [`crate::fec::Zaehler`]. Bleibt bei null, wenn FlexFEC
    /// aus ist; die Statistik zeigt dann drei Nullen und keine Luecke.
    fec: Arc<crate::fec::Zaehler>,
}

impl WhepSession {
    /// Fordert beim Sender sofort ein Vollbild an (RTCP Picture Loss Indication).
    ///
    /// **Warum das noetig ist.** Nach einem Paketverlust darf der Decoder erst
    /// weiterarbeiten, wenn ein Einstiegspunkt kommt — sonst bekommt er ein
    /// Differenzbild ohne Referenzbild, und `libnvcuvid` stuerzt daran ab
    /// (2026-07-28 gemessen). Ohne Rueckkanal heisst "warten" aber: bis zum
    /// naechsten regulaeren Keyframe des Senders, also bei einem
    /// Zwei-Sekunden-Abstand bis zu zwei Sekunden Schwarz. Mit 1 % Verlust
    /// gemessen: 1-5 Bilder je Sekunde, drei bis fuenf Sekunden ohne Bild in
    /// einem 20-Sekunden-Lauf.
    ///
    /// Mit der Anforderung schrumpft die Wartezeit auf eine Umlaufzeit plus die
    /// Reaktionszeit des Encoders. Das ist der Unterschied zwischen "es haengt
    /// kurz" und "es ist weg" — und fuer eine spaetere Fernsteuerung der
    /// Unterschied zwischen brauchbar und unbrauchbar.
    ///
    /// Fehler werden geschluckt: eine nicht zugestellte Anforderung ist kein
    /// Grund, die Wiedergabe abzubrechen — der naechste regulaere Keyframe
    /// kommt ohnehin.
    pub async fn request_keyframe(&self, media_ssrc: u32) {
        use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
        let pli = PictureLossIndication { sender_ssrc: 0, media_ssrc };
        if let Err(e) = self.pc.write_rtcp(&[Box::new(pli)]).await {
            eprintln!("pulse-player: Vollbild-Anforderung nicht zustellbar: {e}");
        }
    }

    /// `(repariert, unreparierbar, zu_spaet)` der Paritaet — fuer die Statistik.
    pub fn fec_zaehler(&self) -> (u64, u64, u64) {
        self.fec.lesen()
    }

    /// Baut die Sitzung ab. Idempotent — mehrfaches Aufrufen ist harmlos.
    pub async fn close(&mut self) {
        let _ = self.pc.close().await;
        if let Some(url) = self.resource_url.take() {
            // Best effort: der Server laesst die Resource ohnehin auslaufen.
            let _ = self.http.delete(&url).send().await;
        }
    }
}

/// Wie oft der Player fehlende Pakete nachfordert. Vorgabe 10 ms;
/// `PULSE_PLAYER_NACK_INTERVAL_MS=100` stellt das Verhalten der Bibliothek
/// wieder her, damit der Vergleich ohne neuen Build moeglich bleibt.
fn nack_intervall() -> Duration {
    let ms = std::env::var("PULSE_PLAYER_NACK_INTERVAL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|ms| (1..=1000).contains(ms))
        .unwrap_or(10);
    Duration::from_millis(ms)
}

/// Baut die Interceptor-Registry selbst, statt `register_default_interceptors`
/// zu nehmen — **nur wegen des NACK-Sendeintervalls.**
///
/// **Warum das den Umweg wert ist.** Der Nachforderer der Bibliothek sammelt
/// erkannte Luecken und schickt sie im Takt; die Vorgabe steht auf 100 ms
/// (`interceptor-0.17.2`, `nack/generator/mod.rs:64`) und ist ueber
/// `register_default_interceptors` nicht erreichbar. Am 2026-07-29 gemessen
/// (zwei Laeufe, 1 % Verlust, je ueber 550 zugeordnete Nachlieferungen): keine
/// einzige traf frueher als 101,8 bzw. 109,6 ms ein — eine so scharfe
/// Untergrenze bei genau einem Sendeintervall ist dessen direkter Abdruck.
/// Der Jitter-Puffer hielt damals 20 ms, also war **keine** der 1121
/// Nachlieferungen rechtzeitig. MediaMTX liefert nach; es kam nur nie etwas
/// davon an. (Genau deshalb steht [`crate::proto::JITTER_MS_VORGABE`] seit dem
/// 2026-07-29 auf 100 ms — die Nachlieferungen kommen jetzt an.)
///
/// Nachgebaut wird genau das, was die Sammelfunktion tut (`configure_nack`,
/// `configure_rtcp_reports`, `configure_twcc_receiver_only`) — mit dem
/// einzigen Unterschied, dass der Generator ein eigenes Intervall bekommt.
/// Die beiden `nack`-Rueckmeldungen muessen dabei von Hand in die MediaEngine,
/// sonst verhandelt der Player sie gar nicht erst und der Rueckkanal bleibt
/// stumm — sie stehen sonst in `configure_nack`.
///
/// Nutzlasttyp, unter dem der Player Paritaetspakete anbietet. Muss mit dem
/// des Servers uebereinstimmen (`pulseFlexFECPayloadType` im MediaMTX-Patch
/// `0003-flexfec-on-whep.patch`).
const FLEXFEC_PAYLOAD_TYPE: u8 = 110;

/// Bietet FlexFEC-03 in der Verhandlung an — sonst erzeugt der Server keines.
///
/// Der Paritaets-Erzeuger im MediaMTX-Fork haengt an der SDP-Aushandlung: pions
/// Interceptor steigt sofort wieder aus, wenn die Spur keine FEC-Kennung
/// bekommen hat (`encoder_interceptor.go`, Pruefung auf
/// `PayloadTypeForwardErrorCorrection == 0`). Wer den Schalter am Server
/// umlegt, ohne dass der Zuschauer hier etwas anbietet, bekommt schweigend
/// denselben Strom wie vorher.
///
/// `flexfec-03` ist der Entwurfsstand, den auch Chromium spricht; pion nennt
/// das an seiner Voreinstellung ausdruecklich. Die Angabe `repair-window`
/// uebernimmt denselben Wert, den pion in `ConfigureFlexFEC03` setzt.
///
/// **Das hier ist nur die Anmeldung, noch keine Reparatur.** Der Player
/// verhandelt damit die Paritaetspakete und bekommt sie zugestellt; sie
/// auszuwerten ist der naechste Schritt.
fn flexfec_anbieten(media: &mut MediaEngine) -> Result<()> {
    media
        .register_codec(
            RTCRtpCodecParameters {
                capability: RTCRtpCodecCapability {
                    mime_type: "video/flexfec-03".to_owned(),
                    clock_rate: 90000,
                    channels: 0,
                    sdp_fmtp_line: "repair-window=10000000".to_owned(),
                    rtcp_feedback: vec![],
                },
                payload_type: FLEXFEC_PAYLOAD_TYPE,
                ..Default::default()
            },
            RTPCodecType::Video,
        )
        .context("FlexFEC-Codec konnte nicht registriert werden")?;
    Ok(())
}

/// Messakte: `testbench/profiles/nack-2026-07-29-stufe3.json`.
fn interceptors_mit_zuegigem_nack(media: &mut MediaEngine) -> Result<Registry> {
    for parameter in ["", "pli"] {
        media.register_feedback(
            RTCPFeedback { typ: "nack".to_owned(), parameter: parameter.to_owned() },
            RTPCodecType::Video,
        );
    }

    let mut registry = Registry::new();
    registry.add(Box::new(Responder::builder()));
    registry.add(Box::new(Generator::builder().with_interval(nack_intervall())));
    registry = configure_rtcp_reports(registry);
    configure_twcc_receiver_only(registry, media).context("TWCC-Interceptor")
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
    // Noch hinter einem Schalter: das Angebot veraendert das SDP, und der
    // Empfaenger dafuer ist erst im Bau. Ohne die Variable verhaelt sich der
    // Player wie bisher.
    if std::env::var("PULSE_PLAYER_FLEXFEC").as_deref() == Ok("1") {
        flexfec_anbieten(&mut media)?;
    }
    let registry = interceptors_mit_zuegigem_nack(&mut media)?;
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

    // Der Paritaetsstrom taucht in keinem `on_track` auf — er gehoert zu
    // keiner angemeldeten Spur. Erreichbar ist er nur ueber den
    // DTLS-Transport, und an den kommt man erst ueber einen Empfaenger, den
    // es hier bereits gibt.
    let fec_an = crate::fec::eingeschaltet();
    let fec_zaehler = Arc::new(crate::fec::Zaehler::default());
    let fec_fuer_track = fec_zaehler.clone();
    pc.on_track(Box::new(move |track, receiver, _transceiver| {
        let tx = tx.clone();
        let fec_zaehler = fec_fuer_track.clone();
        Box::pin(async move {
            // Nur am VIDEO-Track: dort liegt der geschuetzte Strom, und nur
            // dort sind Codec und Taktrate bekannt, die ein repariertes Paket
            // fuer den Empfangsweg braucht.
            let capability = track.codec().capability;
            let medien_tx = match Codec::from_mime(&capability.mime_type) {
                Some(codec) if fec_an && codec.is_video() => Some(crate::fec::starten(
                    receiver.transport(),
                    tx.clone(),
                    codec,
                    capability.clock_rate,
                    fec_zaehler,
                )),
                _ => None,
            };
            tokio::spawn(pump_track(track, tx, medien_tx));
        })
    }));

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("HTTP-Client")?;

    match negotiate(&pc, &http, whep_url).await {
        Ok(resource_url) => Ok(WhepSession { pc, resource_url, http, fec: fec_zaehler }),
        Err(e) => {
            let _ = pc.close().await;
            Err(e)
        }
    }
}

/// Offer erzeugen, ICE sammeln, an den WHEP-Endpunkt schicken, Answer setzen.
/// Meldet, welche RTCP-Rueckmeldungen der Server tatsaechlich zugesagt hat.
///
/// **Warum das eine eigene Zeile wert ist.** Ob verlorene Pakete nachgefordert
/// werden koennen (`nack`) und ob ein Vollbild anforderbar ist (`nack pli`),
/// entscheidet sich in der ANTWORT des Servers — der Player kann beides
/// anbieten und trotzdem nichts davon bekommen. Der Unterschied ist im Betrieb
/// gewaltig: ohne `nack` ist jedes verlorene Paket endgueltig verloren, und bei
/// 1 % Verlust fallen dann rund 20 Zugriffseinheiten je Sekunde aus.
///
/// Am 2026-07-28 stand genau diese Frage offen und war NICHT beantwortbar: der
/// Player initialisiert keinen Logger, `RUST_LOG` laeuft also ins Leere, und
/// die ausgehandelte Beschreibung war nirgends sichtbar. Dieselbe Ueberlegung
/// wie bei der ICE-Kandidaten-Zeile darueber — eine Zeile, die eine sonst
/// unbeantwortbare Frage beantwortet, ist ihren Platz wert.
fn melde_rueckkanal(answer: &str) {
    let (nack, pli, rtx) = rueckkanal_flags(answer);
    eprintln!(
        "pulse-player: Rueckkanal — nack {} / pli {} / rtx {}",
        if nack { "ja" } else { "NEIN" },
        if pli { "ja" } else { "NEIN" },
        if rtx { "ja" } else { "NEIN" },
    );
}

/// Wertet aus, welche RTCP-Rueckmeldungen die SDP-Antwort zusagt:
/// `(nack, nack pli, rtx)`. Reine Stringauswertung ohne Seiteneffekte —
/// von `melde_rueckkanal` getrennt, damit sie sich ohne stderr-Capture
/// direkt testen laesst.
fn rueckkanal_flags(answer: &str) -> (bool, bool, bool) {
    let hat = |was: &str| {
        answer
            .lines()
            .any(|l| l.starts_with("a=rtcp-fb:") && l.split_once(' ').is_some_and(|(_, r)| r == was))
    };
    // RTX (RFC 4588) ist EIN Weg der Nachlieferung, nicht der einzige: das
    // wiederholte Paket reist dort auf einem eigenen Payload-Typ `rtx/90000`
    // mit eigener Zaehlung, damit es die laufende Sequenznummerierung nicht
    // stoert. Der andere Weg ist, schlicht das Originalpaket unveraendert
    // noch einmal zu senden — und genau den geht pion, auf dem MediaMTX
    // aufsetzt (`nack/responder_interceptor.go::resendPackets` schreibt
    // `p.Header(), p.Payload()` zurueck).
    //
    // **`rtx NEIN` heisst deshalb NICHT "keine Nachlieferung".** Hier stand
    // bis zum 2026-07-29 das Gegenteil, und es hat eine Messung fast beendet,
    // bevor sie anfing. Nachgemessen (Mitschnitt, wiederholte
    // Sequenznummern gezaehlt): MediaMTX sagt `rtx NEIN` und liefert
    // trotzdem nach — 505 Wiederholungen bei 5 % Verlust, 4 bei 1 %, und in
    // der Nullkontrolle ueber 56651 Paketen ohne Stoerung exakt null.
    // Volles Protokoll: `testbench/profiles/decoder-2026-07-29-intra-refresh.json`.
    //
    // Die Zeile bleibt trotzdem gemeldet: sie sagt, WELCHEN der beiden Wege
    // die Gegenstelle anbietet, und das ist bei einer fremden Gegenstelle
    // nicht dasselbe wie "ob ueberhaupt".
    let rtx = answer.lines().any(|l| l.contains("rtx/"));
    (hat("nack"), hat("nack pli"), rtx)
}

async fn negotiate(
    pc: &Arc<RTCPeerConnection>,
    http: &reqwest::Client,
    whep_url: &str,
) -> Result<Option<String>> {
    let offer = pc.create_offer(None).await.context("create_offer")?;
    pc.set_local_description(offer).await.context("set_local_description")?;

    // Nicht-Trickle: warten, bis der Offer alle Kandidaten traegt. Der Timeout
    // begrenzt den Worst Case, wenn ein STUN-Server nicht antwortet.
    let started = std::time::Instant::now();
    let mut gathering = pc.gathering_complete_promise().await;
    let complete = tokio::time::timeout(ICE_GATHERING_TIMEOUT, gathering.recv()).await.is_ok();

    let sdp = pc
        .local_description()
        .await
        .ok_or_else(|| anyhow!("keine local description nach dem Gathering"))?
        .sdp;

    // Ein Offer ohne Kandidaten nimmt der Server zwar an, aber die Verbindung
    // kommt nie zustande — MediaMTX meldet dann nur "deadline exceeded while
    // waiting connection", was wie ein Serverfehler aussieht. Diese Zeile
    // macht von aussen unterscheidbar, ob es am Sammeln lag.
    let candidates = sdp.lines().filter(|l| l.starts_with("a=candidate:")).count();
    eprintln!(
        "pulse-player: ICE gesammelt: {candidates} Kandidaten in {} ms{}",
        started.elapsed().as_millis(),
        if complete { "" } else { " (ABGEBROCHEN — Zeit abgelaufen)" }
    );
    if candidates == 0 {
        bail!("keine ICE-Kandidaten gesammelt — die Verbindung koennte nicht zustande kommen");
    }

    let res = http
        .post(whep_url)
        .header(reqwest::header::CONTENT_TYPE, "application/sdp")
        .body(sdp)
        .send()
        .await
        // NICHT `.context(...)`: das wuerde den reqwest-Fehler als Ursache
        // anhaengen, und der traegt die volle URL inklusive Token.
        .map_err(|e| anyhow!("WHEP-Server nicht erreichbar: {}", redact_tokens(&e.to_string())))?;

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
    melde_rueckkanal(&answer);
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
async fn pump_track(
    track: Arc<TrackRemote>,
    tx: mpsc::Sender<RtpArrival>,
    fec_medien: Option<mpsc::Sender<(u16, Vec<u8>)>>,
) {
    let capability = track.codec().capability;
    let mime = capability.mime_type;
    let clock_rate = capability.clock_rate;
    let Some(codec) = Codec::from_mime(&mime) else {
        eprintln!("pulse-player: unbekannter Codec {mime}, Track wird ignoriert");
        return;
    };
    eprintln!("pulse-player: Track {mime} ({clock_rate} Hz) laeuft an");
    let gegenprobe_an = crate::fec::gegenprobe::eingeschaltet();

    loop {
        let packet = match track.read_rtp().await {
            Ok((packet, _)) => packet,
            Err(e) => {
                eprintln!("pulse-player: Track {mime} beendet: {e}");
                return;
            }
        };
        // Fuer die Gegenprobe braucht der Paritaets-Rechner die Bytes, so wie
        // sie ueber die Leitung kamen. `marshal` baut sie aus dem geparsten
        // Paket wieder auf — dass das byte-gleich ist, ist eine der Annahmen,
        // die die Gegenprobe mitprueft: waere es das nicht, wichen die
        // zurueckgerechneten Pakete ab.
        if (gegenprobe_an || fec_medien.is_some()) && codec.is_video() {
            if let Ok(bytes) = packet.marshal() {
                let seq = packet.header.sequence_number;
                if gegenprobe_an {
                    crate::fec::gegenprobe::medienpaket(seq, bytes.to_vec());
                }
                if let Some(m) = &fec_medien {
                    // Voll heisst: der Paritaets-Empfaenger haengt. Wegwerfen
                    // ist dann richtig — der Bildstrom selbst darf davon nicht
                    // ausgebremst werden.
                    let _ = m.try_send((seq, bytes.to_vec()));
                }
            }
        }
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
    fn tokens_werden_aus_fehlertexten_entfernt() {
        let leak = "error sending request for url (https://howispulse.com/whep/x?token=geheim123)";
        let safe = redact_tokens(leak);
        assert!(!safe.contains("geheim123"), "Token steht noch drin: {safe}");
        assert!(safe.contains("token=<entfernt>"), "{safe}");
        // Der Rest der Meldung muss erhalten bleiben, sonst ist sie wertlos.
        assert!(safe.contains("howispulse.com"), "{safe}");
    }

    #[test]
    fn redaktion_faengt_mehrere_vorkommen_und_parameter_danach() {
        let s = redact_tokens("a?token=abc&x=1 und b?token=def)");
        assert!(!s.contains("abc") && !s.contains("def"), "{s}");
        assert!(s.contains("x=1"), "Folgeparameter duerfen nicht verlorengehen: {s}");
    }

    #[test]
    fn text_ohne_token_bleibt_unveraendert() {
        let s = "ganz normale Meldung";
        assert_eq!(redact_tokens(s), s);
    }

    #[test]
    fn rueckkanal_erkennt_nack_pli_rtx() {
        let answer = "v=0\r\n\
                       a=rtcp-fb:96 nack\r\n\
                       a=rtcp-fb:96 nack pli\r\n\
                       a=rtpmap:97 rtx/90000\r\n";
        assert_eq!(rueckkanal_flags(answer), (true, true, true));
    }

    #[test]
    fn rueckkanal_ohne_zusagen() {
        let answer = "v=0\r\na=rtpmap:96 H264/90000\r\n";
        assert_eq!(rueckkanal_flags(answer), (false, false, false));
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
