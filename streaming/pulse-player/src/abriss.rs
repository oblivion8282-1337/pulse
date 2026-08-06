//! Wer die Verbindung abbaut — und wann.
//!
//! **Warum es dieses Modul gibt.** Endet eine Sitzung, meldete der Player bis
//! zum 2026-08-06 genau eine Zeile: `Track video/AV1 beendet: DataChannel is
//! not opened`. Die kommt aus [`crate::whep::pump_track`] und ist die
//! **Wirkung** eines `close()` auf der PeerConnection — sie sagt nichts
//! darueber, wer geschlossen hat. Beide moeglichen Urheber sehen von aussen
//! gleich aus:
//!
//! * der Player selbst (Stille-Abbruch, aufgegebener Decoder, geschlossenes
//!   Fenster) — dann steht der Grund seit demselben Tag in der Zeile
//!   `Sitzung endet nach … s (…)` in [`crate::session`], die VOR dem `close()`
//!   geschrieben wird;
//! * die Gegenstelle oder die Leitung (ICE scheitert, DTLS bricht ab) — dann
//!   steht dort gar nichts, und erst die Zustandswechsel hier zeigen es.
//!
//! Ohne diese Unterscheidung fuehrt die Suche in die Bibliothek statt an die
//! Stelle, an der die Entscheidung wirklich faellt. Genau so ist am
//! 2026-08-06 ein selbst ausgeloestes Sitzungsende als Fehler in webrtc-rs
//! protokolliert worden.
//!
//! Die Meldungen sind **nicht** an einen Schalter gehaengt: sie fallen nur bei
//! Zustandswechseln an, also eine Handvoll je Sitzung, und wer sie erst
//! einschalten muss, hat sie im Fehlerfall nicht.

use std::time::Instant;

use webrtc::peer_connection::RTCPeerConnection;

/// Haengt die Zustandsmeldungen an eine frisch gebaute PeerConnection.
///
/// Muss vor dem Aushandeln aufgerufen werden, sonst gehen die Wechsel des
/// Verbindungsaufbaus verloren — und gerade die trennen „kam nie zustande"
/// von „lief und ist gestorben".
///
/// **Die Zeiten hier zaehlen ab dem AUFBAU, nicht ab dem Sitzungsbeginn**, und
/// darum steht das auch in jeder Zeile. Die Sitzungsuhr in [`crate::session`]
/// startet erst, wenn `whep::connect` zurueck ist — also nach Gathering, POST
/// und SDP-Austausch. Wer „Verbindungszustand nach X s" und „Sitzung endet
/// nach Y s" nebeneinanderlegt, ohne das zu wissen, vergleicht zwei Uhren mit
/// verschiedenen Nullpunkten. Zusammengefuehrt sind sie bewusst nicht: die
/// Sitzungsuhr ist zugleich der Zeitbezug der Aufnahme, und den zu verschieben
/// waere ein Nebeneffekt an einer Stelle, die mit Diagnose nichts zu tun hat.
pub fn zustaende_melden(pc: &RTCPeerConnection) {
    let start = Instant::now();

    pc.on_peer_connection_state_change(Box::new(move |zustand| {
        eprintln!(
            "pulse-player: Verbindungszustand {:.1} s nach dem Aufbau: {zustand}",
            start.elapsed().as_secs_f64()
        );
        Box::pin(async {})
    }));

    // Der ICE-Zustand wird SEPARAT gemeldet, obwohl der Verbindungszustand
    // ihn zusammenfasst. Der Unterschied ist im Betrieb der entscheidende:
    // `disconnected` (5 s ohne Antwort auf die Zustimmungspruefung) ist eine
    // Warnung, die sich von selbst erholt, `failed` (25 s) ist endgueltig.
    // Der zusammengefasste Zustand zeigt beides als `disconnected` bzw.
    // `failed`, aber erst die ICE-Zeile daneben sagt, ob die LEITUNG gemeint
    // ist oder DTLS.
    pc.on_ice_connection_state_change(Box::new(move |zustand| {
        eprintln!(
            "pulse-player: ICE-Zustand {:.1} s nach dem Aufbau: {zustand}",
            start.elapsed().as_secs_f64()
        );
        Box::pin(async {})
    }));
}
