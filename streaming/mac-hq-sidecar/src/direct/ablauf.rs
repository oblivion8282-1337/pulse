//! Reine Zustandsmaschine des Direktpfads — welche Übergänge es gibt und
//! welche Anfragen in welchem Zustand was antworten.
//!
//! **Warum getrennt vom Sitzungs-Code** ([`super`]): die Maschine ist der
//! Vertrag, und der Vertrag ist testbar. Sie berührt keine PeerConnection,
//! keinen Controller und keine Ereignisse — sie BUCHT nur, welche Übergänge
//! geschehen sind. Die Sitzung folgt den Buchungen; weicht eine Weigerung
//! von der Schnittstelle ab (`docs`/Vertrag zum Renderer), fällt der Test
//! hier auf, nicht erst am Player.
//!
//! Die Phasen und ihre Ereignisse:
//!
//! | Phase         | `{"ev":"state"}`      | `{"ev":"direct_state"}` |
//! |---------------|-----------------------|-------------------------|
//! | `Wartend`     | `wartend, running`    | —                       |
//! | `Ausgehandelt`| `starting`/`live`¹    | `connecting` → `live`¹  |
//! | `Aufraeumen`  | `stopped`¹ → `wartend`| `failed`²               |
//!
//! ¹ sobald die Pipeline (PC `Connected`) mitläuft; ² nur wenn der PC selbst
//! scheitert, nicht bei einem gewollten `direct_stop`.

use anyhow::{bail, Result};

/// Der Zustand der Direkt-Sitzung.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    /// Kein direkter Stream (vor `start` bzw. nach Prozess-Reinigung).
    Leer,
    /// `start(direct:true)` angenommen: es wird auf das Angebot gewartet,
    /// Aufnahme und Encoder stehen still.
    Wartend,
    /// Angebot beantwortet, PeerConnection lebt — darunter `connecting` und
    /// `live` (der PC-Zustand unterscheidet, die Buchung nicht).
    Ausgehandelt,
    /// Teardown läuft (direct_stop, PC-Fehler, Pipeline-Ende). Rennen-Schutz:
    /// in dieser Phase gibt jede Weigerung sofort `false`/Fehler.
    Aufraeumen,
}

/// Die Buchungen. Alle Methoden sind reine Zustandsübergänge ohne I/O.
#[derive(Debug)]
pub(crate) struct Ablauf {
    phase: Phase,
    /// Wurde die Senke schon an die Pipeline übergeben? Genau einmal pro
    /// Aushandlung — eine zweite Übergabe hieße, zwei Pipelines auf EINEN
    /// Sender schreiben zu lassen.
    senke_geholt: bool,
    /// Läuft die Capture-/Encode-Pipeline für diese Aushandlung? Der PC kann
    /// `Connected` mehrfach melden (Netzwechsel); starten darf sie genau
    /// einmal.
    pipeline_laeuft: bool,
}

impl Ablauf {
    pub(crate) fn neu() -> Self {
        Self { phase: Phase::Leer, senke_geholt: false, pipeline_laeuft: false }
    }

    /// Nur für die Tests — der Betrieb entscheidet über die Buchungen, nicht
    /// über das Nachsehen.
    #[cfg(test)]
    pub(crate) fn phase(&self) -> Phase {
        self.phase
    }

    /// `start(direct:true)` — nur aus dem Leerlauf. Der Controller verbietet
    /// den Doppelstart ohnehin (`already running`); diese Buchung hält die
    /// Maschine auch dort ehrlich, falls beide Wachen je auseinanderlaufen.
    pub(crate) fn bereite_vor(&mut self) -> Result<()> {
        match self.phase {
            Phase::Leer => {
                self.phase = Phase::Wartend;
                Ok(())
            }
            _ => bail!("direct session läuft bereits — erst stoppen"),
        }
    }

    /// `direct_offer` annehmen. **Der Fehlertext bei Doppel-Aushandlung ist
    /// Vertrag** (der Renderer baut darauf): exakt
    /// `direct session already negotiated`.
    pub(crate) fn aushandeln(&mut self) -> Result<()> {
        match self.phase {
            Phase::Wartend => {
                self.phase = Phase::Ausgehandelt;
                self.senke_geholt = false;
                self.pipeline_laeuft = false;
                Ok(())
            }
            Phase::Ausgehandelt => bail!("direct session already negotiated"),
            Phase::Aufraeumen => bail!("direct session räumt gerade ab — Angebot wiederholen"),
            Phase::Leer => bail!("kein direkter Stream gestartet (start mit direct:true)"),
        }
    }

    /// Aushandlung ist am BAU gescheitert (unbrauchbares Angebot, ICE):
    /// zurück nach Wartend, ein neues Angebot darf kommen. Nur wirksam,
    /// solange noch nichts an der Sitzung hängt — danach reißt nur
    /// [`Self::reissen`] ab.
    pub(crate) fn aushandlung_abgebrochen(&mut self) {
        if self.phase == Phase::Ausgehandelt && !self.senke_geholt && !self.pipeline_laeuft {
            self.phase = Phase::Wartend;
        }
    }

    /// PC meldet `Connected` → `true` genau einmal (Pipeline starten).
    pub(crate) fn verbunden(&mut self) -> bool {
        if self.phase == Phase::Ausgehandelt && !self.pipeline_laeuft {
            self.pipeline_laeuft = true;
            true
        } else {
            false
        }
    }

    /// Senke an die Pipeline übergeben — genau einmal, nur ausgehandelt.
    pub(crate) fn nimm_senke(&mut self) -> Result<()> {
        match self.phase {
            Phase::Ausgehandelt if !self.senke_geholt => {
                self.senke_geholt = true;
                Ok(())
            }
            Phase::Ausgehandelt => bail!("Direkt-Senke wurde bereits an die Pipeline übergeben"),
            _ => bail!("keine ausgehandelte Direkt-Sitzung für eine Senke"),
        }
    }

    /// Teardown einleiten. `true` = diese Buchung hat die Übergänge; der
    /// Rufer führt sie aus (Pipeline stoppen, PC schließen, wieder wartend).
    /// `false` = es lief bereits Teardown oder es gibt nichts — jede
    /// Mitteilung (z. B. `direct_state: failed` beim späten `Closed` nach
    /// eigenem Abbau) unterbleibt.
    pub(crate) fn reissen(&mut self) -> bool {
        if self.phase == Phase::Ausgehandelt {
            self.phase = Phase::Aufraeumen;
            true
        } else {
            false
        }
    }

    /// Nach dem Aufräumen: zurück nach Wartend — der Stream bleibt als
    /// Bereitschaft bestehen, ein neues Angebot darf kommen.
    pub(crate) fn wieder_wartend(&mut self) {
        if self.phase == Phase::Aufraeumen {
            self.phase = Phase::Wartend;
            self.senke_geholt = false;
            self.pipeline_laeuft = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_nur_aus_dem_leerlauf() {
        let mut a = Ablauf::neu();
        assert!(a.bereite_vor().is_ok());
        assert_eq!(a.phase(), Phase::Wartend);
        assert!(a.bereite_vor().is_err(), "Doppelstart ist ein Fehler");
    }

    /// Der WORTLAUT ist Vertrag mit dem Renderer — der Test bricht, wenn
    /// jemand ihn „verbessert".
    #[test]
    fn doppeltes_angebot_bekommt_den_vertraglichen_text() {
        let mut a = Ablauf::neu();
        a.bereite_vor().unwrap();
        a.aushandeln().unwrap();
        let fehler = a.aushandeln().unwrap_err().to_string();
        assert_eq!(fehler, "direct session already negotiated");
    }

    #[test]
    fn angebot_ohne_start_ist_ein_fehler() {
        let mut a = Ablauf::neu();
        let fehler = a.aushandeln().unwrap_err().to_string();
        assert!(fehler.contains("start"), "der Fehler soll zur Abhilfe führen: {fehler}");
    }

    /// Der komplette Vertrags-Zyklus: wartend → (Angebot) → ausgehandelt →
    /// (PC Connected) → live → (direct_stop) → wartend — und danach darf ein
    /// neues Angebot kommen. Genau das ist der Sinn der Bereitschaft.
    #[test]
    fn wartend_ausgehandelt_live_wartend() {
        let mut a = Ablauf::neu();
        a.bereite_vor().unwrap();
        a.aushandeln().unwrap();
        assert!(a.verbunden(), "das erste Connected startet die Pipeline");
        assert!(!a.verbunden(), "ein zweites Connected startet NICHT nochmal");
        a.nimm_senke().expect("die Pipeline bekommt ihre Senke");
        assert!(a.reissen(), "direct_stop reißt ab");
        a.wieder_wartend();
        assert_eq!(a.phase(), Phase::Wartend);
        a.aushandeln().expect("nach dem Teardown kommt ein neues Angebot");
    }

    #[test]
    fn senke_nur_einmal_und_nur_ausgehandelt() {
        let mut a = Ablauf::neu();
        assert!(a.nimm_senke().is_err(), "ohne Aushandlung keine Senke");
        a.bereite_vor().unwrap();
        assert!(a.nimm_senke().is_err(), "im Warten noch keine Senke");
        a.aushandeln().unwrap();
        a.nimm_senke().unwrap();
        assert!(a.nimm_senke().is_err(), "genau einmal");
    }

    #[test]
    fn spates_closed_nach_eigenem_abbau_bucht_nichts_mehr() {
        let mut a = Ablauf::neu();
        a.bereite_vor().unwrap();
        a.aushandeln().unwrap();
        assert!(a.reissen(), "direct_stop reißt ab");
        // Der PC feuert beim eigenen close() noch ein Closed — das darf
        // weder einen zweiten Teardown noch eine failed-Meldung buchen.
        assert!(!a.reissen());
        a.wieder_wartend();
        assert!(!a.reissen(), "auch im Warten gibt es nichts zu reißen");
    }

    #[test]
    fn baufehler_setzt_zurueck_zum_warten() {
        let mut a = Ablauf::neu();
        a.bereite_vor().unwrap();
        a.aushandeln().unwrap();
        a.aushandlung_abgebrochen();
        assert_eq!(a.phase(), Phase::Wartend);
        a.aushandeln().expect("ein neues Angebot darf kommen");
        // Hängt aber erst etwas an der Sitzung, greift nur noch reissen:
        a.nimm_senke().unwrap();
        a.aushandlung_abgebrochen();
        assert_eq!(a.phase(), Phase::Ausgehandelt, "mit Senke gibt es kein stilles Zurück");
    }
}
