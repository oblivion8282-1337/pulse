//! REMB auswerten: was die Gegenseite an Bandbreite schätzt — gemeldet statt
//! weggeworfen.
//!
//! **Was das ist und was nicht.** MediaMTX (pion) schickt über den
//! RTCP-Rückkanal `goog-remb`-Pakete mit seiner Empfangs-Bandbreitenschätzung.
//! Bis 2026-08-13 wurden sie gelesen und verworfen — der Sender fuhr seine
//! Bitrate starr über die ganze Sitzung, und eine zu enge Leitung zahlte man
//! als wachsende Netz-Warteschlange (= schleichende Latenz), ohne dass
//! irgendwo eine Zahl stand. Diese Wacht macht daraus eine **Meldung**:
//! ein `bandwidth_low`-Event samt Schätzung, wenn die Leitung anhaltend unter
//! dem Ziel liegt, und `bandwidth_ok`, wenn sie sich erholt.
//!
//! **Bewusst KEINE automatische Bitraten-Anpassung.** FFmpeg legt bei den
//! Hardware-Encodern (NVENC/AMF) die Rate beim Öffnen fest und bietet keinen
//! Laufzeit-Reconfigure an — eine echte Adaption hieße Encoder-Neubau samt
//! IDR und sichtbarem Ruckler und gehört als eigenes, gemessenes Vorhaben
//! angegangen. Die Meldung hier ist die Vorstufe: der Client kann darauf
//! reagieren (Hinweis an den Nutzer, Neustart mit kleinerer Rate), und die
//! Messakte des Zwei-Geräte-Tests bekommt erstmals die Zahl, an der eine
//! Adaption später zu beurteilen wäre.
//!
//! **Hysterese, keine Momentaufnahme.** REMB flattert; gemeldet wird erst,
//! wenn die Schätzung [`ENG_DAUER`] lang ununterbrochen unter
//! [`ENG_ANTEIL`] × Ziel liegt, und Entwarnung erst ab [`ERHOLT_ANTEIL`] —
//! sonst käme bei einer Leitung, die um das Ziel herum pendelt, ein
//! Meldungs-Geflacker heraus.

use std::time::{Duration, Instant};

/// Unter diesem Anteil des Ziels gilt die Leitung als eng.
const ENG_ANTEIL: f64 = 0.8;
/// Ab diesem Anteil gilt sie wieder als tragfähig (bewusst über [`ENG_ANTEIL`],
/// sonst flackert die Meldung an der Grenze).
const ERHOLT_ANTEIL: f64 = 0.95;
/// So lange muss die Schätzung ununterbrochen eng sein, bevor gemeldet wird.
const ENG_DAUER: Duration = Duration::from_secs(3);
/// Takt der Log-Zeile mit der laufenden Schätzung (fürs Messprotokoll).
const LOG_ABSTAND: Duration = Duration::from_secs(10);

/// Was eine Messung ausgelöst hat — der Aufrufer setzt daraus Event und Log ab.
#[derive(Debug, PartialEq, Eq)]
pub enum Meldung {
    /// Anhaltend unter dem Ziel: `bandwidth_low` melden.
    Eng { schaetzung_kbps: u64 },
    /// Wieder tragfähig nach einer Eng-Meldung: `bandwidth_ok` melden.
    Erholt { schaetzung_kbps: u64 },
}

pub struct BandbreitenWacht {
    ziel_kbps: u32,
    eng_seit: Option<Instant>,
    eng_gemeldet: bool,
    letztes_log: Option<Instant>,
}

impl BandbreitenWacht {
    /// `ziel_kbps == 0` heißt „Ziel unbekannt" (Labor-Senke) — die Wacht bleibt
    /// dann vollständig stumm.
    pub fn neu(ziel_kbps: u32) -> Self {
        Self { ziel_kbps, eng_seit: None, eng_gemeldet: false, letztes_log: None }
    }

    /// Eine REMB-Schätzung (Bit je Sekunde) einordnen. `jetzt` kommt herein,
    /// damit die Hysterese testbar ist.
    pub fn messung(&mut self, bps: f32, jetzt: Instant) -> Option<Meldung> {
        if self.ziel_kbps == 0 || !bps.is_finite() || bps <= 0.0 {
            return None;
        }
        let schaetzung_kbps = (bps / 1000.0) as u64;
        let ziel = f64::from(self.ziel_kbps);

        if (schaetzung_kbps as f64) < ziel * ENG_ANTEIL {
            let seit = *self.eng_seit.get_or_insert(jetzt);
            if !self.eng_gemeldet && jetzt.duration_since(seit) >= ENG_DAUER {
                self.eng_gemeldet = true;
                return Some(Meldung::Eng { schaetzung_kbps });
            }
        } else {
            // Zwischen den beiden Schwellen: die Eng-Uhr stoppt (die Lage ist
            // nicht mehr eng), aber Entwarnung gibt es erst oberhalb der
            // Erholt-Schwelle.
            self.eng_seit = None;
            if self.eng_gemeldet && (schaetzung_kbps as f64) >= ziel * ERHOLT_ANTEIL {
                self.eng_gemeldet = false;
                return Some(Meldung::Erholt { schaetzung_kbps });
            }
        }
        None
    }

    /// Ist die Log-Zeile mit der laufenden Schätzung fällig? (Eigener Takt,
    /// unabhängig von den Meldungen — die Messakte braucht die Zahl auch, wenn
    /// alles gesund ist.)
    pub fn log_faellig(&mut self, jetzt: Instant) -> bool {
        match self.letztes_log {
            Some(t) if jetzt.duration_since(t) < LOG_ABSTAND => false,
            _ => {
                self.letztes_log = Some(jetzt);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kbps(v: u64) -> f32 {
        (v * 1000) as f32
    }

    #[test]
    fn meldet_erst_nach_der_eng_dauer_und_entwarnt_mit_hysterese() {
        let t0 = Instant::now();
        let mut w = BandbreitenWacht::neu(4000);

        // Sofort eng, aber noch keine Meldung — die Dauer fehlt.
        assert_eq!(w.messung(kbps(2000), t0), None);
        assert_eq!(w.messung(kbps(2000), t0 + Duration::from_secs(2)), None);
        // Nach der Eng-Dauer genau EINE Meldung.
        assert_eq!(
            w.messung(kbps(2000), t0 + Duration::from_secs(4)),
            Some(Meldung::Eng { schaetzung_kbps: 2000 })
        );
        assert_eq!(w.messung(kbps(2000), t0 + Duration::from_secs(5)), None);

        // 85 % vom Ziel: nicht mehr eng, aber noch keine Entwarnung.
        assert_eq!(w.messung(kbps(3400), t0 + Duration::from_secs(6)), None);
        // 96 %: Entwarnung, genau einmal.
        assert_eq!(
            w.messung(kbps(3840), t0 + Duration::from_secs(7)),
            Some(Meldung::Erholt { schaetzung_kbps: 3840 })
        );
        assert_eq!(w.messung(kbps(3840), t0 + Duration::from_secs(8)), None);
    }

    #[test]
    fn kurze_dellen_und_unbekanntes_ziel_bleiben_stumm() {
        let t0 = Instant::now();
        let mut w = BandbreitenWacht::neu(4000);
        // Delle unter der Eng-Dauer, dann wieder gesund: nichts.
        assert_eq!(w.messung(kbps(1000), t0), None);
        assert_eq!(w.messung(kbps(4000), t0 + Duration::from_secs(1)), None);
        assert_eq!(w.messung(kbps(1000), t0 + Duration::from_secs(2)), None);
        // Die Eng-Uhr wurde zurückgesetzt — 2 s später ist die Dauer noch
        // nicht voll.
        assert_eq!(w.messung(kbps(1000), t0 + Duration::from_secs(4)), None);

        // Ziel unbekannt (Labor): immer stumm, auch bei absurden Werten.
        let mut stumm = BandbreitenWacht::neu(0);
        assert_eq!(stumm.messung(kbps(1), t0 + Duration::from_secs(10)), None);
        assert_eq!(stumm.messung(f32::NAN, t0), None);
    }
}
