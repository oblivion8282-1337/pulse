//! Was ein Zustandswechsel der Verbindung bedeutet — und ob er eine Zeile wert
//! ist.
//!
//! **Warum es das gibt.** Bis zum 2026-08-27 sah kein Sidecar auf den Zustand
//! der PeerConnection: weder `on_peer_connection_state_change` noch
//! `on_ice_connection_state_change` waren irgendwo registriert (nachgesehen
//! ueber alle drei `whip/mod.rs` und diese Crate — null Treffer). Ein Abriss
//! nach dem Handschlag — Router startet neu, das Geraet wechselt vom WLAN ins
//! Mobilfunknetz, der Anbieter leitet um — wurde damit nirgends benannt.
//!
//! Bemerkt wurde er trotzdem, nur stumm: irgendwann scheitert ein
//! `write_rtp`/`write_sample`, und der Sendefaden endet sauber. Was fehlte,
//! war die AUSSAGE. Dieses Projekt trennt Fehlerursachen sonst pedantisch
//! auseinander (die Erreichbarkeits-Diagnose eines Self-Hosts unterscheidet
//! sieben Glieder einzeln); ausgerechnet der Sendeweg hatte dazu keine Zeile.
//!
//! **Was hier bewusst NICHT passiert: abbrechen.** Der Abbau haengt weiterhin
//! allein am Schreibfehler. Ein zweiter Weg, der bei `Failed` von sich aus
//! aufraeumt, liefe mit dem ersten um die Wette — und ein Wettlauf im
//! Verbindungsabbau ist in diesem Projekt schon einmal teuer geworden (die
//! Gnadenfrist der Fernsteuerung, zwei Bughunt-Runden). Diese Datei macht den
//! Abriss SICHTBAR, sie behandelt ihn nicht.
//!
//! **Warum die Rechnung hier liegt und das Melden nicht.** Die drei Sidecars
//! schreiben in verschiedenen Sprachen (Linux `tracing::warn!`, Windows und
//! macOS `eprintln!`). Geteilt wird deshalb die Einordnung, nicht die Ausgabe
//! — dasselbe Muster wie bei [`crate::bandbreite`].

use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;

/// Wie eine Zustandsmeldung einzuordnen ist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lage {
    /// Die Verbindung steht (wieder). Eine Zeile wert, weil sie das Gegenstueck
    /// zu [`Lage::Wackelt`] ist: ohne sie sieht ein Protokoll nach dauerhaftem
    /// Abriss aus, obwohl die Strecke zurueckkam.
    Steht,
    /// Voruebergehend gestoert. **Kein Abbruch** — dieser Zustand kommt bei
    /// jedem Netzwechsel vor und geht meist von selbst weg. Genau deshalb hier
    /// eine eigene Stufe: als Warnung gemeldet ist er Diagnose, als Abbruch
    /// behandelt waere er ein Fehlalarm.
    Wackelt,
    /// Endgueltig. Der Sendefaden endet ohnehin am naechsten Schreibfehler;
    /// diese Meldung sagt nur, WARUM.
    Weg,
}

impl Lage {
    /// Kurztext fuer die Log-Zeile — damit die drei Sidecars nicht drei
    /// verschiedene Formulierungen fuer dieselbe Lage erfinden.
    pub fn text(self) -> &'static str {
        match self {
            Lage::Steht => "Verbindung steht",
            Lage::Wackelt => "Verbindung gestoert (kann sich erholen)",
            Lage::Weg => "Verbindung verloren",
        }
    }
}

/// Einordnung eines PeerConnection-Zustands. `None` = keine Zeile wert.
///
/// `New`/`Connecting` sind der normale Aufbau und stehen jede Sitzung genau
/// einmal an — sie zu melden hiesse, das Protokoll mit dem Erwarteten zu
/// fuellen. `Unspecified` ist der Vorgabewert der Bibliothek und bedeutet
/// nichts.
pub fn peer_lage(zustand: RTCPeerConnectionState) -> Option<Lage> {
    match zustand {
        RTCPeerConnectionState::Connected => Some(Lage::Steht),
        RTCPeerConnectionState::Disconnected => Some(Lage::Wackelt),
        RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => Some(Lage::Weg),
        RTCPeerConnectionState::New
        | RTCPeerConnectionState::Connecting
        | RTCPeerConnectionState::Unspecified => None,
    }
}

/// Einordnung eines ICE-Zustands. `None` = keine Zeile wert.
///
/// **`Completed` gilt wie `Connected`**, nicht als eigener Fall: es heisst nur,
/// dass die Kandidatenpruefung fertig ist. Fuer die Frage „kommt etwas
/// durch?" ist das dasselbe, und zwei Zeilen fuer einen Aufbau sind eine zu
/// viel.
pub fn ice_lage(zustand: RTCIceConnectionState) -> Option<Lage> {
    match zustand {
        RTCIceConnectionState::Connected | RTCIceConnectionState::Completed => Some(Lage::Steht),
        RTCIceConnectionState::Disconnected => Some(Lage::Wackelt),
        RTCIceConnectionState::Failed | RTCIceConnectionState::Closed => Some(Lage::Weg),
        RTCIceConnectionState::New
        | RTCIceConnectionState::Checking
        | RTCIceConnectionState::Unspecified => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der Aufbau darf nicht ins Protokoll — sonst steht dort jede Sitzung
    /// dasselbe, und die eine Zeile, auf die es ankommt, geht darin unter.
    #[test]
    fn der_normale_aufbau_erzeugt_keine_zeile() {
        for z in [
            RTCPeerConnectionState::New,
            RTCPeerConnectionState::Connecting,
            RTCPeerConnectionState::Unspecified,
        ] {
            assert_eq!(peer_lage(z), None, "{z:?}");
        }
        for z in [
            RTCIceConnectionState::New,
            RTCIceConnectionState::Checking,
            RTCIceConnectionState::Unspecified,
        ] {
            assert_eq!(ice_lage(z), None, "{z:?}");
        }
    }

    /// **Der Kern: `Disconnected` ist NICHT `Failed`.** Ein Geraet, das vom
    /// WLAN ins Mobilfunknetz wechselt, laeuft durch `Disconnected` und kommt
    /// zurueck. Wer beides gleich behandelt, meldet bei jedem Netzwechsel
    /// einen Abriss — und wer dann auch noch abbraeche, beendete einen Stream,
    /// der weiterlaufen wollte.
    #[test]
    fn gestoert_und_verloren_sind_zwei_verschiedene_dinge() {
        assert_eq!(peer_lage(RTCPeerConnectionState::Disconnected), Some(Lage::Wackelt));
        assert_eq!(peer_lage(RTCPeerConnectionState::Failed), Some(Lage::Weg));
        assert_eq!(ice_lage(RTCIceConnectionState::Disconnected), Some(Lage::Wackelt));
        assert_eq!(ice_lage(RTCIceConnectionState::Failed), Some(Lage::Weg));
    }

    /// `Completed` ist kein eigener Fall (s. [`ice_lage`]).
    #[test]
    fn completed_zaehlt_wie_connected() {
        assert_eq!(ice_lage(RTCIceConnectionState::Completed), Some(Lage::Steht));
        assert_eq!(ice_lage(RTCIceConnectionState::Connected), Some(Lage::Steht));
    }

    /// Geschlossen ist verloren — auch wenn es das reguläre Ende war. Die
    /// Unterscheidung „gewollt oder nicht" kennt diese Ebene nicht, und sie
    /// zu erfinden hiesse, etwas zu behaupten.
    #[test]
    fn geschlossen_gilt_als_verloren() {
        assert_eq!(peer_lage(RTCPeerConnectionState::Closed), Some(Lage::Weg));
        assert_eq!(ice_lage(RTCIceConnectionState::Closed), Some(Lage::Weg));
    }
}
