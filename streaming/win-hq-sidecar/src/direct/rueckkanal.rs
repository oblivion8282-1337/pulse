//! Rückkanal und Verdrahtung des Direkt-PC — die Seiten der Sitzung, die
//! etwas EMPFANGEN (Zustandsmeldungen, RTCP) und das Stück, das die
//! Pipeline kennt ([`DirectSenke`]).
//!
//! **Warum getrennt von [`super`].** Die Sitzungs-Datei trägt den Lebens-
//! zyklus (Buchungen, Teardown, Senken-Übergabe); hier liegt, was im
//! Betrieb dauerhaft läuft: die EINE Zustands-Anmeldung des PCs, der
//! RTCP-Lesefaden und die Senke. Drei Dinge, die alle dieselbe Eigenschaft
//! teilen — sie gehören zur Sitzung, ohne ihre Entscheidungen zu treffen.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtcp::payload_feedbacks::receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;

use crate::encode::senke::PaketSenke;
use super::sitzung;

/// DIE Zustands-Anmeldung des Direkt-PC — von [`super::Sitzung`] genau
/// einmal gesetzt. Nur Logging außerhalb der zwei entscheidenden Zustände;
/// `Disconnected` ist wie im WHIP-Weg KEIN Abbruch (Netzwechsel erholt
/// sich), der Abbau hier passiert über den Teardown oder den Schreibfehler
/// der Pipeline.
pub(super) fn verdrahte_pc(sender: &pulse_whip::direct::DirectSender) {
    let pc = sender.pc();
    pc.on_peer_connection_state_change(Box::new(move |zustand| {
        Box::pin(async move {
            if let Some(lage) = pulse_whip::verbindung::peer_lage(zustand) {
                eprintln!("[direct] peer {zustand:?}: {}", lage.text());
            }
            match zustand {
                RTCPeerConnectionState::Connected => sitzung().pc_verbunden(),
                RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => {
                    sitzung().pc_gescheitert()
                }
                _ => {}
            }
        })
    }));
    pc.on_ice_connection_state_change(Box::new(move |zustand| {
        Box::pin(async move {
            if let Some(lage) = pulse_whip::verbindung::ice_lage(zustand) {
                eprintln!("[direct] ice {zustand:?}: {}", lage.text());
            }
        })
    }));
}

/// RTCP der Gegenseite lesen — derselbe Loop wie im WHIP-Weg (dort in
/// `WhipSender::connect_async`), aber auf der Seite des Sidecars, weil die
/// Behandlungssprache (Keyframe-Anforderung, Bandbreiten-Events) seine ist:
/// PLI/FIR → `crate::keyframe::request_keyframe`, REMB → die Wacht mit den
/// bekannten Events. `PULSE_WHIP_IGNORE_PLI=1` wirkt auch hier als
/// Trennschnitt für Messungen.
pub(super) fn rtcp_schleife(
    sender: Arc<webrtc::rtp_transceiver::rtp_sender::RTCRtpSender>,
    ziel_kbps: u32,
) {
    pulse_whip::direct::laufzeit().spawn(async move {
        let mut bandbreite = pulse_whip::bandbreite::BandbreitenWacht::neu(ziel_kbps);
        let antworten = std::env::var("PULSE_WHIP_IGNORE_PLI").as_deref() != Ok("1");
        let mut angefordert: u64 = 0;
        // Fehler beim Lesen dürfen den Rueckkanal NICHT dauerhaft schliessen
        // (Messung und Begruendung im WHIP-Loop: ein Lesefehler wäre sonst
        // das Ende für immer).
        let mut fehler_am_stueck = 0u32;
        loop {
            let (pakete, _) = match sender.read_rtcp().await {
                Ok(v) => {
                    fehler_am_stueck = 0;
                    v
                }
                Err(e) => {
                    fehler_am_stueck += 1;
                    if fehler_am_stueck >= 5 {
                        eprintln!("[direct] RTCP-Lesen beendet: {e}");
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    continue;
                }
            };
            for p in &pakete {
                let any = p.as_any();
                if let Some(remb) = any.downcast_ref::<ReceiverEstimatedMaximumBitrate>() {
                    crate::whip::remb_auswerten(&mut bandbreite, remb.bitrate, ziel_kbps);
                    continue;
                }
                if any.downcast_ref::<PictureLossIndication>().is_some()
                    || any.downcast_ref::<FullIntraRequest>().is_some()
                {
                    if antworten {
                        crate::keyframe::request_keyframe();
                    }
                    angefordert += 1;
                    // JEDE melden — dieselbe Begruendung wie im WHIP-Loop.
                    eprintln!("[direct] Vollbild angefordert (insgesamt {angefordert})");
                }
            }
        }
    });
}

/// Der Direkt-Sender als [`PaketSenke`] — das Stück, das die Pipeline kennt.
/// Dasselbe Forma wie [`crate::whip::senke::WhipSenke`]; `close` ist im
/// Sender idempotent, Senke und Sitzung können also beide aufräumen.
pub(super) struct DirectSenke {
    sender: Arc<pulse_whip::direct::DirectSender>,
}

impl DirectSenke {
    pub(super) fn neu(sender: Arc<pulse_whip::direct::DirectSender>) -> Self {
        Self { sender }
    }
}

impl PaketSenke for DirectSenke {
    fn video(&mut self, daten: &[u8], pts: Option<i64>) -> Result<()> {
        self.sender.send(daten, pts)
    }

    fn audio(&mut self, daten: &[u8], dauer: Duration) -> Result<()> {
        self.sender.send_audio(daten, dauer)
    }

    fn schliesse(&mut self) {
        self.sender.close();
    }
}
