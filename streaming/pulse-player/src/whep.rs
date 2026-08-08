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
use webrtc::api::setting_engine::SettingEngine;
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
    /// Sperrfrist des NACK-Erzeugers, in Millisekunden. Wird von
    /// [`Self::sperre_nachfuehren`] an die gemessene Umlaufzeit angepasst.
    /// Vom Erzeuger gemessene Antwortzeit; s. [`Self::rtt_ms`].
    nack_rtt: Arc<std::sync::atomic::AtomicU64>,
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

    /// Die zuletzt gemessene Antwortzeit auf eigene Nachforderungen, in
    /// Millisekunden — oder `None`, solange nichts nachgefordert wurde.
    ///
    /// Der NACK-Erzeuger misst sie selbst und leitet seine Sperrfrist daraus
    /// ab (ein Drittel, begrenzt auf 5 bis 200 ms). Hier wird sie nur
    /// abgeholt, damit sie in der Messakte steht: ohne sie ist nicht
    /// nachvollziehbar, mit welcher Sperre ein Lauf gefahren ist.
    ///
    /// **Der naheliegende Weg ueber `get_stats()` funktioniert nicht** —
    /// webrtc-rs deklariert `current_round_trip_time`, setzt es aber fest auf
    /// 0.0 (`ice/src/agent/agent_stats.rs`) und berechnet es nirgends. Eine
    /// erste Fassung dieser Kopplung las genau dieses Feld und war damit
    /// wirkungslos; aufgefallen ist es erst, weil die Zahl in keiner Akte
    /// auftauchte.
    pub fn rtt_ms(&self) -> Option<u64> {
        match self.nack_rtt.load(std::sync::atomic::Ordering::Relaxed) {
            0 => None,
            ms => Some(ms),
        }
    }

    /// `(repariert, unreparierbar, verworfen, mehrfach_loch, zu_spaet)` der
    /// Paritaet — fuer die Statistik.
    pub fn fec_zaehler(&self) -> (u64, u64, u64, u64, u64) {
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

/// Wie lange dieselbe Sequenznummer nach einer Anforderung gesperrt bleibt.
///
/// **Das kurze Sendeintervall oben hat eine Kehrseite.** Der Erzeuger fordert
/// in jedem Takt alles an, was fehlt — auch das, wonach er vor 10 ms schon
/// gefragt hat. Bis eine Antwort zurueck sein kann, vergeht aber eine
/// Umlaufzeit; bei 59 ms gehen also sechs bis acht Anforderungen fuer dasselbe
/// Paket hinaus, und MediaMTX beantwortet jede einzeln.
///
/// Gemessen (2026-07-31, 180 s, echte Leitung): bei 5 Prozent Verlust 1354
/// kbit/s Wiederholungen mit 6,4 Kopien je Paket — fuenf Sechstel davon
/// ueberfluessig, also ueber ein Megabit je Sekunde und Zuschauer. Bei guter
/// Leitung faellt nichts an, weil nichts nachgefordert wird.
///
/// **Die ERSTE Anforderung verzoegert das nicht** — eine frische Luecke geht
/// sofort hinaus. Betroffen sind nur Wiederholungen. Der Preis: ein
/// VERLORENES NACK wird erst nach der Sperrfrist nachgeholt, und bei hohem
/// Verlust geht auch mal eine Anforderung selbst verloren.
///
/// **Genau daran haengt der richtige Wert**, und er ist NICHT die volle
/// Umlaufzeit. Gemessen bei 5 Prozent Verlust, je 120 s:
///
///     Sperre   Wiederholungen   Aufschlag   Vollbilder   endgueltig verloren
///     aus          1354 kbit/s      54,0 %            5                   14
///     20 ms         593 kbit/s      37,5 %           11                   15
///     30 ms         422 kbit/s      32,0 %           26                   26
///     60 ms         246 kbit/s      27,6 %           37                   44
///
/// Bei 20 ms bleibt der Verlust unveraendert (15 gegen 14), waehrend der
/// Wiederholungsverkehr um 56 Prozent faellt. Ab 30 ms kippt es: der Verlust
/// verdoppelt sich, bei 60 ms verdreifacht er sich. Die erste Fassung stand
/// auf 60 ms — eine Umlaufzeit — und war damit dreimal zu hoch.
///
/// 20 ms sind etwa ein Drittel der Umlaufzeit dieser Strecke. Wer deutlich
/// weiter weg sitzt, braucht mehr; sauber waere eine Kopplung an die gemessene
/// Umlaufzeit. `0` schaltet die Sperre ab.
fn nack_sperre_start() -> u64 {
    std::env::var("PULSE_PLAYER_NACK_SPERRE_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|ms| *ms <= 2000)
        .unwrap_or(20)
}

/// Soll die Sperre aus der gemessenen Antwortzeit abgeleitet werden?
///
/// **Vorgabe NEIN — die Kopplung ist gebaut, aber sie traegt noch nicht.**
/// Der Erzeuger misst die Zeit zwischen Anforderung und Ankunft selbst
/// (`patches/0002-...`), und die Messung ist in drei Anlaeufen um den Faktor
/// acht zu klein geblieben: 7 ms statt der tatsaechlichen 59. Die Sperre fiel
/// damit auf ihre Untergrenze und war wirkungslos (6,3 Kopien je Paket, also
/// der Stand vor dem Fix).
///
/// Zwei Ursachen sind gefunden und behoben — ein Mittelwert, den die vielen
/// UMSORTIERTEN Pakete nach unten zogen (jetzt abklingendes Maximum), und ein
/// Aufraeumfenster, das an die Sperre gekoppelt war und echte Antworten
/// vergass, bevor sie eintrafen. Beide reichen nicht: der gemessene Wert
/// bleibt bei 7 ms. Die dritte Ursache ist offen.
///
/// Bis dahin gilt der feste Wert aus [`nack_sperre_start`], der GEMESSEN
/// funktioniert (Kennlinie im Doc-Kommentar von [`sperre_aus_rtt`]).
/// `PULSE_PLAYER_NACK_SPERRE_AUTO=1` schaltet die Ableitung zum Weitersuchen
/// ein; `rtt_ms` in der Statistik zeigt dabei, was der Erzeuger misst.
fn nack_sperre_gekoppelt() -> bool {
    std::env::var("PULSE_PLAYER_NACK_SPERRE_AUTO").as_deref() == Ok("1")
}

/// Sperrfrist aus einer gemessenen Umlaufzeit — ein Drittel davon.
///
/// **Das Drittel stammt aus einer Messreihe, nicht aus der Theorie.** Bei 5
/// Prozent Verlust und 59 ms Umlaufzeit (je 120 s):
///
///     Sperre   Wiederholungen   Aufschlag   endgueltig verloren
///     aus          1354 kbit/s      54,0 %                   14
///     20 ms         593 kbit/s      37,5 %                   15
///     30 ms         422 kbit/s      32,0 %                   26
///     60 ms         246 kbit/s      27,6 %                   44
///
/// Bei einem Drittel (20 von 59 ms) bleibt der Verlust unveraendert, waehrend
/// der Wiederholungsverkehr um 56 Prozent faellt. Bei einer halben Umlaufzeit
/// verdoppelt sich der Verlust, bei einer ganzen verdreifacht er sich — weil
/// bei hohem Verlust auch Anforderungen selbst verlorengehen und dann erst
/// nach der Sperrfrist nachgeholt werden.
///
/// Die Grenzen fangen Ausreisser: eine Umlaufzeit von 0 (noch nicht gemessen)
/// oder 3 s (kurzer Stau) darf die Sperre nicht unbrauchbar machen.
/// **Diese Fassung ist die getestete Referenz, gerechnet wird im Patch.**
/// `patches/0002-nack-generator-resend-delay.patch` traegt dieselbe Rechnung
/// im Erzeuger — dort, wo sie gebraucht wird, aber ohne eigenen Test, weil
/// der Vendor-Baum nicht versioniert ist. Weichen beide voneinander ab,
/// schlaegt der Test hier nicht an; wer die Formel aendert, muss beide Stellen
/// anfassen.
#[allow(dead_code)]
pub fn sperre_aus_rtt(rtt: Duration) -> u64 {
    (rtt.as_millis() as u64 / 3).clamp(5, 200)
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

/// Wieviele Pakete das SRTP-Wiedergabefenster zurueckreicht.
///
/// **Die Vorgabe von webrtc-rs ist 64 — und die ist fuer eine Strecke mit
/// Nachforderung zu klein.** Bei 440 Paketen je Sekunde sind 64 Pakete rund
/// 145 Millisekunden; eine Nachlieferung braucht Umlaufzeit plus Wartezeit auf
/// der Gegenseite und liegt schon im Normalbetrieb daneben, sobald die Leitung
/// staut. Was herausfaellt, verwirft der Wiedergabeschutz still
/// (`replay_detector`: `latest_seq >= window_size + seq` -> `false`).
///
/// Das kostet nicht nur die Reparatur, es erzeugt eine Rueckkopplung: der
/// NACK-Erzeuger sieht die Luecke weiter offen und fordert alle
/// `nack_intervall()` erneut an, die Gegenseite beantwortet jede Anforderung,
/// und jede Antwort faellt wieder heraus. Gemessen am 2026-07-31
/// (`testbench/fec-fest-ab3.pcap`, 618 s):
///
/// * 910 Luecken bei 273662 Paketen = 0,33 Prozent Verlust — die Leitung ist gut
/// * 795 wurden nachgeliefert, davon **505 innerhalb** des 64er-Fensters
///   (kosten je acht Kopien, das ist die Umlaufzeit und unvermeidbar) und
///   **290 ausserhalb** — diese 290 loesen je rund 200 Nachforderungen aus
/// * die 290 tragen damit **94 Prozent aller 61805 ueberfluessigen Kopien**,
///   zusammen 945 kbit/s, von denen der Player 98 Prozent selbst wegwirft
///
/// 2048 Pakete sind bei dieser Rate gut viereinhalb Sekunden und decken den
/// gemessenen Groesstabstand (376 ms) um ein Vielfaches ab. Der Preis ist eine
/// groessere Bitmaske, also 256 Byte. **Der Angriffsschutz leidet nicht:**
/// innerhalb des Fensters verhindert die Maske jedes Duplikat weiterhin
/// luecklos, und ein Angreifer kann ohnehin nur Pakete einspielen, die die
/// SRTP-Authentifizierung bestehen — also echte, nie angekommene.
const SRTP_FENSTER: usize = 2048;

/// Wiedergabefenster, das eine Nachlieferung noch durchlaesst (s. `SRTP_FENSTER`).
fn srtp_fenster_fuer_nachlieferung() -> SettingEngine {
    let mut engine = SettingEngine::default();
    engine.set_srtp_replay_protection_window(SRTP_FENSTER);
    engine
}

/// Messakte: `testbench/profiles/nack-2026-07-29-stufe3.json`.
fn interceptors_mit_zuegigem_nack(
    media: &mut MediaEngine,
    sperre: &Arc<std::sync::atomic::AtomicU64>,
    rtt: &Arc<std::sync::atomic::AtomicU64>,
) -> Result<Registry> {
    for parameter in ["", "pli"] {
        media.register_feedback(
            RTCPFeedback { typ: "nack".to_owned(), parameter: parameter.to_owned() },
            RTPCodecType::Video,
        );
    }
    // **Der Ton hatte bis 2026-08-05 gar nichts.** Kein NACK, kein FlexFEC
    // (Chrome handelt es nicht aus, wir schon — aber MediaMTX erzeugt die
    // Paritaet nur fuer die Videospur). Er wartete im Jitterpuffer trotzdem
    // dieselben 100 ms wie das Bild — auf eine Nachlieferung, die niemand
    // anforderte. Reine Verzoegerung ohne Gegenwert.
    //
    // Ohne `pli`: eine Vollbild-Anforderung auf einer Tonspur ergibt keinen
    // Sinn. Fordert der Server keine Nachlieferung an, kostet die Anmeldung
    // nichts — sie steht dann nur im SDP.
    //
    // Zusammen mit der In-Band-Fehlerkorrektur, die der Sender seit demselben
    // Tag wirklich einschaltet (`win-hq-sidecar/src/encode/audio/mod.rs`), hat
    // die Tonspur damit zwei Wege, einen Verlust zu ueberstehen, statt keinem.
    media.register_feedback(
        RTCPFeedback { typ: "nack".to_owned(), parameter: String::new() },
        RTPCodecType::Audio,
    );

    let mut registry = Registry::new();
    registry.add(Box::new(Responder::builder()));
    registry.add(Box::new(
        Generator::builder()
            .with_interval(nack_intervall())
            .with_pulse_resend_delay(sperre.clone())
            .with_pulse_rtt_cell(rtt.clone())
            .with_pulse_auto(nack_sperre_gekoppelt()),
    ));
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
    // FlexFEC anbieten — seit 2026-08-03 der Standardweg, vorher hinter
    // `PULSE_PLAYER_FLEXFEC=1` versteckt; abschaltbar mit `=0` (fuer
    // Vergleichsmessungen und als Notausgang, falls das veraenderte Angebot
    // einem Server nicht passt). Warum umgestellt wurde — Intra-Refresh heilt
    // sich nach Verlust nicht selbst — steht im Modul-Kopf von `crate::fec`,
    // gleich beim aufgerufenen `eingeschaltet()`.
    //
    // **Was an dieser Zeile haengt.** Ohne das Angebot fehlt FlexFEC im SDP,
    // und der Server sendet dem Player ueberhaupt keine Paritaet — egal, was
    // serverseitig eingeschaltet ist. Genau so lief es bis zum 2026-08-03: der
    // Empfaenger war seit dem 2026-07-31 fertig, nur der Schalter blieb stehen.
    //
    // Die Entscheidung kommt aus `fec::eingeschaltet()` und wird hier NICHT
    // noch einmal selbst aus der Umgebung gelesen: Angebot und Auswertung
    // muessen zusammen an- und ausgehen. Zwei getrennte Abfragen koennen
    // auseinanderlaufen, und beide Richtungen sind still — angeboten ohne
    // auszuwerten heisst Aufschlag ohne Nutzen, ausgewertet ohne anzubieten
    // heisst Zaehler, die ewig auf null stehen.
    if crate::fec::eingeschaltet() {
        flexfec_anbieten(&mut media)?;
    }
    let nack_sperre = Arc::new(std::sync::atomic::AtomicU64::new(nack_sperre_start()));
    let nack_rtt = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let registry = interceptors_mit_zuegigem_nack(&mut media, &nack_sperre, &nack_rtt)?;
    let api = APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .with_setting_engine(srtp_fenster_fuer_nachlieferung())
        .build();

    let mut urls = vec![DEFAULT_STUN.to_string()];
    urls.extend(extra_ice.iter().cloned());
    let config = RTCConfiguration {
        ice_servers: vec![RTCIceServer { urls, ..Default::default() }],
        ..Default::default()
    };

    let pc = Arc::new(api.new_peer_connection(config).await?);
    // Vor dem Aushandeln: sonst fehlen genau die Wechsel des Aufbaus.
    crate::abriss::zustaende_melden(&pc);

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
        Ok(resource_url) => Ok(WhepSession {
            pc,
            resource_url,
            http,
            fec: fec_zaehler,
            nack_rtt,
        }),
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

    /// Die Formel stammt aus einer Messreihe, nicht aus der Theorie — deshalb
    /// steht hier fest, was sie liefern MUSS, samt der Grenzen fuer Ausreisser.
    #[test]
    fn sperrfrist_folgt_der_umlaufzeit_mit_grenzen() {
        // Die Messstrecke: 59 ms Umlaufzeit -> 20 ms, der Wert, bei dem der
        // Verlust unveraendert blieb und die Wiederholungen um 56 % fielen.
        assert_eq!(sperre_aus_rtt(Duration::from_millis(59)), 19);
        assert_eq!(sperre_aus_rtt(Duration::from_millis(60)), 20);

        // Untergrenze: im selben Rechenzentrum darf die Sperre nicht auf 0
        // fallen, sonst ist sie wirkungslos und die Kopien sind zurueck.
        assert_eq!(sperre_aus_rtt(Duration::from_millis(3)), 5);
        assert_eq!(sperre_aus_rtt(Duration::ZERO), 5);

        // Obergrenze: ein kurzer Stau (3 s) darf nicht dazu fuehren, dass
        // Sekunden lang nicht nachgefordert wird — der Jitter-Puffer haelt
        // 100 ms, danach ist die Reparatur ohnehin wertlos.
        assert_eq!(sperre_aus_rtt(Duration::from_secs(3)), 200);
    }

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

    /// Ein WHEP-Endpunkt antwortet mit HTTP 200 und kuendigt 200 MB Body an.
    /// Der Client liest ihn mit `res.text()` vollstaendig in einen `String`,
    /// BEVOR er prueft, ob ueberhaupt SDP drinsteht — es gibt keine
    /// Groessenbegrenzung, nur den 15-s-Zeit-Timeout.
    ///
    /// Gemessen wird nicht der Speicher (schlecht beobachtbar), sondern was
    /// die Gegenstelle loswerden konnte: mit einer Obergrenze bricht der
    /// Client nach wenigen KB ab, der Stub kommt dann ueber ~1 MB nicht
    /// hinaus. Heute nimmt der Client alle 200 MB an.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "Reproduktion Befund 22 — schlaegt bis zur Behebung absichtlich fehl"]
    async fn repro_22_whep_antwort_ohne_groessengrenze() {
        use std::io::{Read, Write};
        use std::sync::atomic::{AtomicU64, Ordering};

        /// Was der Stub hoechstens loswerden koennen DARF. SDP-Antworten sind
        /// wenige KB; 1 MB ist bereits sehr grosszuegig.
        const ERLAUBT: u64 = 1024 * 1024;
        /// Was er heute loswird.
        const ANGEKUENDIGT: u64 = 200 * 1024 * 1024;

        fn kopfende(roh: &[u8]) -> Option<usize> {
            roh.windows(4).position(|f| f == b"\r\n\r\n").map(|p| p + 4)
        }
        fn content_length(kopf: &[u8]) -> usize {
            String::from_utf8_lossy(kopf)
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length").then(|| v.trim().parse().ok())?
                })
                .unwrap_or(0)
        }

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("local_addr");
        let geschrieben = Arc::new(AtomicU64::new(0));
        let zaehler = geschrieben.clone();

        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            // Erst die Anfrage (Kopf + Offer-SDP) abnehmen, sonst haengt der
            // Client im Senden statt im Lesen.
            let mut roh = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = stream.read(&mut buf).expect("read");
                if n == 0 {
                    break;
                }
                roh.extend_from_slice(&buf[..n]);
                if let Some(p) = kopfende(&roh) {
                    if roh.len() - p >= content_length(&roh[..p]) {
                        break;
                    }
                }
            }
            let kopf = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/sdp\r\n\
                 Content-Length: {ANGEKUENDIGT}\r\n\r\n"
            );
            if stream.write_all(kopf.as_bytes()).is_err() {
                return;
            }
            let block = vec![0u8; 64 * 1024];
            let mut rest = ANGEKUENDIGT;
            while rest > 0 {
                let n = (block.len() as u64).min(rest) as usize;
                if stream.write_all(&block[..n]).is_err() {
                    break; // Client hat abgebrochen — genau das waere der Fix
                }
                zaehler.fetch_add(n as u64, Ordering::Relaxed);
                rest -= n as u64;
            }
        });

        let (tx, _rx) = mpsc::channel(64);
        let ergebnis = connect(&format!("http://{addr}/whep"), &[], tx).await;
        let fehler = match ergebnis {
            Ok(_) => panic!("die Sitzung darf mit dieser Antwort nicht zustande kommen"),
            Err(e) => format!("{e:#}"),
        };
        let _ = server.join();

        let n = geschrieben.load(Ordering::Relaxed);
        eprintln!("Stub konnte {n} Bytes absetzen; Fehler des Clients: {fehler}");
        // Beweis, dass der Body VOLLSTAENDIG gelesen wurde, bevor der Inhalt
        // geprueft wird: der Abbruch kommt aus der SDP-Pruefung dahinter.
        assert!(
            fehler.contains("kein gueltiges SDP"),
            "unerwarteter Abbruchgrund (Test misst dann etwas anderes): {fehler}"
        );
        assert!(
            n <= ERLAUBT,
            "der Client hat {n} Bytes Antwortkoerper geschluckt \
             (erlaubt waeren hoechstens {ERLAUBT}) — keine Groessenbegrenzung"
        );
    }
}
