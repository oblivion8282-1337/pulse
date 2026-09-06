//! Direkter P2P-Weg zum Host-Sidecar: **der Player ist Offerer.**
//!
//! Der Unterschied zum WHEP-Weg ([`crate::whep`]) liegt allein im Transport
//! der SDP und darin, wer den Offer schreibt:
//!
//!  1. `direct_start` (stdio-RPC): PeerConnection bauen — STUN-only, KEIN
//!     TURN, dieselben recvonly-Transceiver wie beim WHEP — Offer erzeugen,
//!     ICE-Gathering abwarten (nicht-trickle) und den Offer-SDP als Antwort
//!     zurueckgeben.
//!  2. Der Offer reist ueber die Electron-Huelle zum Renderer und von dort
//!     zum Host; der Weg zurueck ist derselbe. Der Player sieht davon nur den
//!     `direct_signal`-Request mit der Answer.
//!  3. `direct_signal` setzt die Answer, danach laeuft der Medienweg ueber
//!     genau dieselben Stufen wie beim WHEP — der Empfaenger-Aufbau ist der
//!     GEMEINSAME ([`crate::whep::baue_empfaenger_pc`]), damit Jitter-Puffer,
//!     Depacketisierer und Decoder nicht zweimal existieren.
//!
//! Der Verbindungszustand geht als `direct_state`-Ereignis nach vorne
//! (`connecting` / `live` / `failed` / `closed`), auf demselben stdout-Kanal
//! wie `player:state`. **Doppelmeldungen sind ausgefiltert** — webrtc-rs
//! durchlaeuft mehrere Uebergaenge mit demselben Text (New, Connecting), und
//! der Renderer soll auf identische Ereignisse nicht zweimal reagieren
//! muessen.
//!
//! Vollbild-Anforderungen laufen wie beim WHEP ueber RTCP-PLI an die
//! PeerConnection ([`DirektSitzung::request_keyframe`]); das Nachfordern
//! verlorener Pakete uebernimmt der eingebaute NACK-Responder/Generator aus
//! dem gemeinsamen Aufbau — nichts davon wird hier von Hand gebaut.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use tokio::sync::mpsc;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

use crate::rpc::StdoutWriter;
use crate::whep::{
    baue_empfaenger_pc, bildmarke_id, melde_rueckkanal, offer_mit_kandidaten, EmpfaengerBau,
    RtpArrival,
};

/// Welche Netz-Schnittstellen beim Kandidaten-Sammeln infrage kommen.
///
/// **Bewusst eine Namensliste und keine Adresslogik.** Loopback und die
/// virtuellen Adapter (Docker/WSL/Hyper-V) tragen auf jedem System andere
/// Adressen, aber recht einheitliche Namen. Der Filter darf eher daneben-
/// liegen, indem er zu wenige Kandidaten liefert (sichtbar in der
/// ICE-Zeile des Aufbaus), als eine Adresse durchlassen, die der Sidecar
/// nie erreichen kann.
///
/// Gilt NUR fuer den Direktweg — der WHEP-Weg reicht seinen Verkehr ohnehin
/// an MediaMTX, und dessen Verhalten darf sich um keinen Grad aendern.
///
/// Ausgeschlossen (Vereinbarung zur Schnittstelle): `lo`/`lo0` und alles mit
/// „loopback“ im Namen, `docker*`, `veth*`, `br-*`, `virbr*`, `vEthernet*`
/// (Hyper-V/WSL unter Windows) und alles mit „wsl“ im Namen.
pub(crate) fn schnittstelle_ok(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    if n == "lo" || n == "lo0" || n.contains("loopback") {
        return false;
    }
    !(n.contains("docker")
        || n.contains("veth")
        || n.contains("br-")
        || n.contains("virbr")
        || n.contains("vethernet")
        || n.contains("wsl"))
}

/// Die m-Zeilen eines SDP, als Medientexte (`"video"`, `"audio"`) in
/// Reihenfolge. Reine Stringauswertung — damit laesst sich ohne Verbindung
/// pruefen, dass der Offer die beiden Spuren traegt, fuer die der
/// Empfangsweg gebaut wurde (erst Video, dann Audio, s. den doc-Kommentar
/// von [`crate::whep::baue_empfaenger_pc`]).
pub(crate) fn medienzeilen(sdp: &str) -> Vec<&str> {
    sdp.lines()
        .filter_map(|l| l.strip_prefix("m="))
        .filter_map(|rest| rest.split_whitespace().next())
        .collect()
}

/// Verbindungszustand als Text des `direct_state`-Ereignisses.
///
/// `disconnected` wird zu `failed` gemeldet, obwohl er sich oft erholt — der
/// Renderer haengt daran die sichtbare Umschaltung, und fuer sie ist „Bild
/// weg“ derselbe Fall wie „Verbindung weg“. Die stderr-Zeile aus
/// [`crate::abriss`] unterscheidet weiterhin.
fn zustand_als_text(zustand: RTCPeerConnectionState) -> &'static str {
    match zustand {
        RTCPeerConnectionState::Connected => "live",
        RTCPeerConnectionState::Disconnected | RTCPeerConnectionState::Failed => "failed",
        RTCPeerConnectionState::Closed => "closed",
        // New, Connecting, Unspecified: der Aufbau laeuft.
        _ => "connecting",
    }
}

/// Eine direkte P2P-Sitzung aus Sicht des Players (Offerer und Empfaenger).
///
/// Vor [`DirektSitzung::start`] existiert keine PeerConnection — die Sitzung
/// wartet auf den RPC, und alle Zaehler melden ihre Neutralwerte. Das ist
/// gewollt: die Sitzungsschleife in [`crate::session`] sieht beide Wege
/// gleich, ohne Sonderfaelle vor dem ersten Paket.
pub struct DirektSitzung {
    pc: Option<Arc<RTCPeerConnection>>,
    fec: Arc<crate::fec::Zaehler>,
    nack_rtt: Arc<std::sync::atomic::AtomicU64>,
    /// Die ausgehandelte Nummer der Bildmarke aus der ANTWORT (s.
    /// [`crate::whep::bildmarke_id`]); 0 = nicht ausgehandelt. Bleibt vor der
    /// Antwort und ohne Marke null — dann urteilt die Sitzung ueber fehlende
    /// Bilder gar nicht, wie beim WHEP-Weg auch.
    marken_id: u8,
    /// Seit wann ist die Aushandlung durch? Grundlage der „kein Bild nach N
    /// Sekunden“-Frist, die im Direktmodus erst mit der Answer zu laufen
    /// beginnt (s. [`crate::session`]).
    aushandelt: Option<Instant>,
    /// Zuletzt gemeldeter Zustandstext — gegen Dopplungen im Ereignisstrom.
    zuletzt: Arc<Mutex<Option<&'static str>>>,
    stdout: StdoutWriter,
}

impl DirektSitzung {
    /// Neue Direkt-Sitzung ohne PeerConnection. `stdout` ist der
    /// Ereigniskanal fuer die `direct_state`-Meldungen.
    pub fn neu(stdout: StdoutWriter) -> Self {
        Self {
            pc: None,
            fec: Arc::default(),
            nack_rtt: Arc::default(),
            marken_id: 0,
            aushandelt: None,
            zuletzt: Arc::new(Mutex::new(None)),
            stdout,
        }
    }

    /// Baut die PeerConnection, erzeugt den Offer mit gesammelten Kandidaten
    /// und liefert seinen SDP-Text zurueck. Danach verbindet sich die
    /// PeerConnection, sobald die Answer gesetzt wird.
    ///
    /// Ein zweiter Aufruf ist ein Fehler: es gibt genau einen
    /// Aushandlungszyklus; fuer einen Neuanlauf dient ein neues `open`.
    pub async fn start(&mut self, tx: mpsc::Sender<RtpArrival>) -> Result<String> {
        if self.pc.is_some() {
            bail!("direct_start wurde bereits aufgerufen");
        }
        // STUN-only, kein TURN (Vereinbarung zum Direktweg): der Sidecar ist
        // im selben Netz oder ueber echtes NAT erreichbar; ein Relais ist
        // fuer den Fall nicht vorgesehen und wuerde die Latenz der
        // Fernsteuerung verdoppeln. Der Schnittstellen-Filter hält Loopback-
        // und virtuelle Adapter aus dem Gathering heraus (Begruendung am
        // doc-Kommentar von `schnittstelle_ok`).
        let EmpfaengerBau { pc, fec, nack_rtt, .. } =
            baue_empfaenger_pc(&tx, &[], |setting: &mut SettingEngine| {
                setting.set_interface_filter(Box::new(schnittstelle_ok));
            })
            .await?;
        // Dieselben Zustandsmeldungen nach stderr wie beim WHEP — plus die
        // Uebersetzung in `direct_state`-Ereignisse im SELBEN Callback,
        // weil webrtc-rs nur einen je Zustand haelt (s. `crate::abriss`).
        crate::abriss::zustaende_melden_mit(&pc, Some(self.zustand_forwarder()));
        let sdp = offer_mit_kandidaten(&pc).await?;
        // Der Offer muss die beiden Spuren tragen, fuer die der Empfang
        // gebaut wurde — und in der Reihenfolge, die der Sidecar erwartet.
        // Reine Selbstkontrolle am eigenen SDP: scheitert sie, stimmt der
        // gemeinsame Aufbau nicht mehr, und der Fehler gehoert laut gemeldet
        // statt als stiller Empfangsausfall beim Sidecar.
        if medienzeilen(&sdp) != ["video", "audio"] {
            let _ = pc.close().await;
            bail!("Offer traegt nicht genau Video- und Audio-m-Zeile: {:?}", medienzeilen(&sdp));
        }
        self.pc = Some(pc);
        self.fec = fec;
        self.nack_rtt = nack_rtt;
        self.melde("connecting");
        Ok(sdp)
    }

    /// Setzt die Answer des Hosts. Erst danach laeuft der Verbindungsaufbau
    /// (ICE, DTLS) und das erste `direct_state` kann zu `live` werden.
    pub async fn antwort(&mut self, sdp: &str) -> Result<()> {
        let Some(pc) = self.pc.as_ref() else {
            bail!("direct_signal ohne direct_start — es gibt keine PeerConnection");
        };
        if !sdp.contains("v=") {
            bail!("Answer war kein gueltiges SDP");
        }
        pc.set_remote_description(RTCSessionDescription::answer(sdp.to_owned())?)
            .await
            .context("set_remote_description")?;
        // Dieselben Rueckkanal-Meldungen wie beim WHEP: der Sidecar ist eine
        // fremde Gegenstelle, und nack/pli/rtx/Bildmarke entscheiden dort
        // ueber Reparatur und Verlusturteile.
        melde_rueckkanal(sdp);
        self.marken_id = bildmarke_id(sdp);
        self.aushandelt = Some(Instant::now());
        Ok(())
    }

    /// Fordert beim Sidecar ein Vollbild an (RTCP Picture Loss Indication).
    /// Derselbe Mechanismus und dieselbe Begruendung wie beim WHEP-Weg
    /// (`whep::WhepSession::request_keyframe`): nach einem Verlust liefert
    /// der Decoder erst wieder ab, wenn ein Einstiegspunkt kommt. Vor dem
    /// Aufbau ein No-op — anforderbar ist nur, was schon verbindet.
    pub async fn request_keyframe(&self, media_ssrc: u32) {
        use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
        let Some(pc) = self.pc.as_ref() else { return };
        let pli = PictureLossIndication { sender_ssrc: 0, media_ssrc };
        if let Err(e) = pc.write_rtcp(&[Box::new(pli)]).await {
            eprintln!("pulse-player: Vollbild-Anforderung nicht zustellbar: {e}");
        }
    }

    /// Die ausgehandelte Nummer der Bildmarke; 0 = nicht (yet) ausgehandelt.
    pub fn marken_id(&self) -> u8 {
        self.marken_id
    }

    /// Zuletzt gemessene NACK-Antwortzeit in Millisekunden (s. die
    /// `rtt_ms`-Doku am WHEP-Pendant); `None` vor dem Aufbau.
    pub fn rtt_ms(&self) -> Option<u64> {
        match self.nack_rtt.load(std::sync::atomic::Ordering::Relaxed) {
            0 => None,
            ms => Some(ms),
        }
    }

    /// `(repariert, unreparierbar, verworfen, mehrfach_loch, zu_spaet)` der
    /// Paritaet — fuer die Statistik. Vor dem Aufbau durchgehend null.
    pub fn fec_zaehler(&self) -> (u64, u64, u64, u64, u64) {
        self.fec.lesen()
    }

    /// Seit wann ist die Aushandlung durch? `None`, solange die Sitzung auf
    /// `direct_start`/`direct_signal` wartet.
    pub fn aushandelt_ab(&self) -> Option<Instant> {
        self.aushandelt
    }

    /// Baut die Sitzung ab. Idempotent — mehrfaches Aufrufen ist harmlos.
    /// Das `closed`-Ereignis kommt vom Zustands-Callback der PeerConnection;
    /// der explizite Ruf unten sichert nur den Fall, dass der Callback schon
    /// gefeuert hat, bevor die Meldung abgesetzt werden konnte.
    pub async fn close(&mut self) {
        if let Some(pc) = self.pc.take() {
            let _ = pc.close().await;
        }
        self.melde("closed");
    }

    /// Den Zustands-Callback fuer die PeerConnection bauen: setzt jeden
    /// Wechsel auf einen DEDUPLIZIERTEN `direct_state`-Text um.
    fn zustand_forwarder(
        &self,
    ) -> Arc<dyn Fn(RTCPeerConnectionState) + Send + Sync> {
        let zuletzt = self.zuletzt.clone();
        let stdout = self.stdout.clone();
        Arc::new(move |zustand| {
            let text = zustand_als_text(zustand);
            let mut g = match zuletzt.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            if *g != Some(text) {
                *g = Some(text);
                stdout.send(&crate::proto::Event::new(
                    "direct_state",
                    serde_json::json!({ "state": text }),
                ));
            }
        })
    }

    /// `direct_state` aus dem Sitzungskontext heraus melden (fuer die
    /// Zustände, die kein Zustandswechsel der PeerConnection ausloest).
    fn melde(&mut self, text: &'static str) {
        let mut g = match self.zuletzt.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if *g != Some(text) {
            *g = Some(text);
            self.stdout.send(&crate::proto::Event::new(
                "direct_state",
                serde_json::json!({ "state": text }),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der Filter soll genau die Adapter ausschliessen, die der Sidecar nie
    /// erreichen kann — und alles andere durchlassen, denn ein zu scharfer
    /// Filter ist der schlimmere Fehler: er hinterlaesst GAR keinen
    /// Kandidaten und damit eine stille tote Verbindung.
    #[test]
    fn schnittstellen_filter_laesst_reale_netze_durch() {
        assert!(schnittstelle_ok("Ethernet"));
        assert!(schnittstelle_ok("WLAN"));
        assert!(schnittstelle_ok("eth0"));
        assert!(schnittstelle_ok("en0"));
        assert!(schnittstelle_ok("以太网"), "Namen sind nicht immer ASCII");
    }

    #[test]
    fn schnittstellen_filter_faengt_loopback() {
        assert!(!schnittstelle_ok("lo"));
        assert!(!schnittstelle_ok("lo0"));
        assert!(!schnittstelle_ok("Loopback Pseudo-Interface 1"));
    }

    #[test]
    fn schnittstellen_filter_faengt_virtuelle_adapter() {
        // Docker unter Linux, Hyper-V/WSL unter Windows, klassische
        // Linux-Bridge- und Tap-Namen.
        assert!(!schnittstelle_ok("docker0"));
        assert!(!schnittstelle_ok("br-1a2b3c4d"));
        assert!(!schnittstelle_ok("vetha1b2c3"));
        assert!(!schnittstelle_ok("virbr0"));
        assert!(!schnittstelle_ok("vEthernet (WSL)"));
        assert!(!schnittstelle_ok("WSL"));
        assert!(!schnittstelle_ok("Ethernet 2 (WSL)"), "WSL im Namen reicht");
    }

    /// Der Offer ist der Vertrag mit dem Sidecar: genau zwei m-Zeilen, erst
    /// Video, dann Audio — dieselbe Reihenfolge wie beim WHEP-Angebot.
    #[test]
    fn medienzeilen_liefert_reihenfolge() {
        let sdp = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n\
                   m=video 9 UDP/TLS/RTP/SAVPF 96\r\n\
                   m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
        assert_eq!(medienzeilen(sdp), vec!["video", "audio"]);
        assert_ne!(medienzeilen(sdp), vec!["audio", "video"], "die Reihenfolge ist der Punkt");
        assert!(medienzeilen("v=0\r\n").is_empty(), "ohne m-Zeilen leer bleiben");
    }

    /// Die Uebersetzung ist der einzige Ort, an dem der Renderer zwischen
    /// den Ereignistexten unterscheiden kann — sie muss vollstaendig und
    /// ohne Ueberraschungen sein.
    #[test]
    fn verbindungszustaende_bekamen_feste_texte() {
        use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState as S;
        assert_eq!(zustand_als_text(S::New), "connecting");
        assert_eq!(zustand_als_text(S::Connecting), "connecting");
        assert_eq!(zustand_als_text(S::Connected), "live");
        // Disconnected gilt als failed: fuer den Renderer ist „Bild weg“
        // derselbe Fall wie „Verbindung weg“ (Begruendung am doc-Kommentar).
        assert_eq!(zustand_als_text(S::Disconnected), "failed");
        assert_eq!(zustand_als_text(S::Failed), "failed");
        assert_eq!(zustand_als_text(S::Closed), "closed");
        assert_eq!(zustand_als_text(S::Unspecified), "connecting");
    }
}
