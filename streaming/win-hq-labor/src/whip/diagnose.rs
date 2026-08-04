//! Was beim WHIP-Aufbau schiefging — und zwar SO, dass man es sieht.
//!
//! **Warum das ein eigenes Modul ist.** Eine WebRTC-Sitzung, die nicht
//! zustande kommt, ist von außen vollkommen stumm: der POST gelingt, der
//! Server antwortet mit `201 Created`, `connect` kehrt erfolgreich zurück —
//! und dann passiert einfach nichts mehr. Am Sender ist kein Fehler zu sehen,
//! nur am Server läuft nach zehn Sekunden ein Zeitablauf ab. Am 2026-08-02 hat
//! genau diese Stummheit eine Stunde gekostet.
//!
//! `whip/mod.rs` ist ansonsten eine **wortgleiche Kopie** aus dem Linux-Labor
//! (`streaming/hq-labor/src/whip/mod.rs`); beide sollen vergleichbar bleiben.
//! Deshalb liegt alles, was hier dazugekommen ist, daneben statt darin.

use anyhow::{Result, bail};
use webrtc::peer_connection::RTCPeerConnection;

/// Zustandswechsel von ICE und Verbindung ins Log hängen.
///
/// Die Rückrufe fangen **nichts** ein, und das ist wesentlich: hielten sie
/// eine Referenz auf die Peer-Verbindung, hielte diese über ihren eigenen
/// Handler sich selbst am Leben und `close()` gäbe sie nie frei.
pub fn verbindung_mitschreiben(pc: &RTCPeerConnection) {
    pc.on_ice_connection_state_change(Box::new(|zustand| {
        tracing::info!(target: "whip", ?zustand, "ICE-Zustand");
        Box::pin(async {})
    }));
    pc.on_peer_connection_state_change(Box::new(|zustand| {
        tracing::info!(target: "whip", ?zustand, "Verbindungszustand");
        Box::pin(async {})
    }));
    pc.on_ice_candidate(Box::new(|kandidat| {
        if let Some(k) = kandidat {
            // Auf `debug`, weil es je Kandidat eine Zeile ist: hier steht,
            // WELCHE Adressen der Sender anbietet — die halbe Antwort, wenn
            // ein Paar nie zustande kommt.
            tracing::debug!(target: "whip", kandidat = %k.to_string(), "eigener Kandidat");
        }
        Box::pin(async {})
    }));
}

/// Das fertige Angebot prüfen, bevor es hinausgeht.
///
/// **Ohne Kandidaten ist der Handschlag schon hier verloren**, aber er sieht
/// bis zuletzt gesund aus: der Server legt sogar eine Sitzung an und lässt sie
/// dann in einen Zeitablauf laufen, weil er nie erfährt, wohin er antworten
/// soll. Deshalb wird gezählt statt gehofft.
pub fn angebot_pruefen(sdp: &str, sammeln_vollstaendig: bool) -> Result<()> {
    let kandidaten = sdp.matches("a=candidate:").count();
    if kandidaten == 0 {
        bail!(
            "Angebot ohne einen einzigen ICE-Kandidaten (Sammeln {}) — der Server \
             koennte nicht antworten. Meist eine Firewall-Regel auf diesem Binary \
             oder ein blockierter UDP-Port.",
            if sammeln_vollstaendig { "abgeschlossen" } else { "abgelaufen" }
        );
    }
    tracing::info!(target: "whip", kandidaten, sammeln_vollstaendig, "Angebot fertig");
    Ok(())
}

/// Die Antwort des Servers protokollieren. Die Kandidatenzahl der Gegenseite
/// ist die andere Hälfte: stehen auf beiden Seiten welche und es kommt
/// trotzdem keine Verbindung zustande, liegt es nicht am Angebot.
pub fn antwort_mitschreiben(status: reqwest::StatusCode, antwort_sdp: &str) {
    tracing::info!(
        target: "whip",
        %status,
        antwort_kandidaten = antwort_sdp.matches("a=candidate:").count(),
        "Antwort erhalten"
    );
}

#[cfg(test)]
mod tests {
    use super::angebot_pruefen;

    #[test]
    fn ohne_kandidaten_ist_ein_fehler() {
        let ohne = "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";
        assert!(angebot_pruefen(ohne, true).is_err(), "ein Angebot ohne Kandidaten muss absagen");
    }

    #[test]
    fn mit_kandidaten_geht_durch() {
        let mit = "v=0\r\na=candidate:1 1 udp 2130706431 192.168.0.2 51820 typ host\r\n";
        assert!(angebot_pruefen(mit, true).is_ok());
    }
}
