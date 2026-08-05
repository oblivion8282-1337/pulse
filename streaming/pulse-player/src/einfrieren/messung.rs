//! Messwerkzeug fuer [`crate::einfrieren`] — **im Betrieb vollstaendig aus.**
//!
//! Nichts hier wird ausgeliefert eingeschaltet; jede Funktion haengt an einer
//! Umgebungsvariablen, die nur der Pruefstand setzt. Trotzdem liegt das Zeug im
//! Baum und nicht in einem Patch, und zwar aus dem Grund, der im Kopf von
//! `streaming/testbench/README.md` steht: **eine Messung, die von Handgriffen
//! abhaengt, wird selten wiederholt.** Die Reihe vom 2026-08-06 (Takt eines
//! Standbildes ueber Codec, Bildrate, Aufloesung und Betriebsart) waere ohne
//! diese Schalter eine Reihe ueber ein halbes Dutzend verschiedener Binaries
//! gewesen — und damit keine Reihe. `PULSE_PLAYER_EINFRIER_MS=1` hat am Ende
//! sogar den Vorher-Nachher-Vergleich mit **einem** Binary erlaubt: es schaltet
//! die neue Zeitbedingung praktisch ab und stellt damit den vorigen Stand her.
//!
//! | Variable | wofuer |
//! |---|---|
//! | `PULSE_PLAYER_TAKT_LOG=1` | Abstaende zwischen zwei veraenderten Bildern melden |
//! | `PULSE_PLAYER_EINFRIER_AUS=1` | die Abhilfe unterdruecken (s.u., Pflicht fuer eine Taktmessung) |
//! | `PULSE_PLAYER_EINFRIER_BILDER=<n>` | `super::EINFRIER_BILDER` verstellen |
//! | `PULSE_PLAYER_EINFRIER_MS=<n>` | `super::EINFRIER_DAUER` verstellen |
//! | `PULSE_PLAYER_EINFRIER_BYTES=<n>` | `super::EINFRIER_BYTES` verstellen |
//!
//! Die drei Schwellen sind einzeln verstellbar, weil sie drei verschiedene
//! Fragen stellen und eine Messung immer nur eine davon variieren darf.

/// Ueber wie viele Bilder eine Zeile der Takt-Diagnose gebildet wird.
const TAKT_BLOCK: u32 = 600;

/// Hoechstens so viele verschiedene Abstaende je Zeile.
const TAKT_SPALTEN: usize = 8;

/// Ist die Takt-Diagnose eingeschaltet (`PULSE_PLAYER_TAKT_LOG=1`)?
///
/// **Sie beantwortet genau eine Frage**: in welchem Abstand sich das dekodierte
/// Bild aendert. Bei laufendem Inhalt ist das 1, bei stehendem der Vollbild-Takt
/// des Senders. Ohne diese Zahl laesst sich nicht entscheiden, ob ein
/// Beobachtungsfenster oberhalb des Taktes ueberhaupt moeglich ist — geraten
/// wurde daran schon einmal genug.
pub(super) fn takt_log() -> bool {
    static AN: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AN.get_or_init(|| std::env::var("PULSE_PLAYER_TAKT_LOG").as_deref() == Ok("1"))
}

/// Unterdrueckt die Abhilfe (`PULSE_PLAYER_EINFRIER_AUS=1`).
///
/// **Kontrolle fuer die Taktmessung, nichts fuer den Betrieb.** Die Rettung
/// leert den Decoder und erzwingt ein Vollbild; danach codiert der Encoder den
/// unveraenderten Inhalt neu und veraendert das Bild zwei bis vier Sekunden lang
/// in jedem Bild (s. `super::BEWEGUNGS_KETTE`). Wer den natuerlichen Takt des
/// Senders messen will, misst mit eingeschalteter Abhilfe also deren Nachwirkung
/// mit — und bekommt den Takt nie zu sehen.
pub(super) fn abhilfe_aus() -> bool {
    static AUS: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AUS.get_or_init(|| std::env::var("PULSE_PLAYER_EINFRIER_AUS").as_deref() == Ok("1"))
}

/// Eine Zahl aus der Umgebung ziehen, sonst die Vorgabe.
pub(super) fn zahl(name: &str, vorgabe: u32) -> u32 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(vorgabe)
}

/// Eine Dauer aus der Umgebung ziehen (in Millisekunden), sonst die Vorgabe.
pub(super) fn dauer(name: &str, vorgabe: std::time::Duration) -> std::time::Duration {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .map(std::time::Duration::from_millis)
        .unwrap_or(vorgabe)
}

/// Sammelt die Abstaende zwischen zwei veraenderten Bildern und meldet sie
/// blockweise. Ohne [`takt_log`] wird nichts angelegt und nichts gerechnet.
///
/// **Beim Auswerten wissen:** gemeldet wird nur ein VOLLER Block. Was nach dem
/// letzten Block passiert, steht in keiner Zeile — am 2026-08-06 sah deshalb
/// ein Lauf so aus, als habe der Player ohne einen einzigen langen Lauf
/// gemeldet („1x1680 120x1, alarme=1"). Der Stillstand lag hinter dem dritten
/// Block. Wer Meldungen gegen Abstaende rechnet, muss die Logzeilen der Reihe
/// nach lesen, nicht nur die Summe.
#[derive(Default)]
pub(super) struct TaktDiagnose {
    /// Bilder seit dem letzten veraenderten Bild.
    seit_wechsel: u32,
    /// Bilder im laufenden Block.
    bilder: u32,
    /// Beobachtete Abstaende samt Haeufigkeit.
    abstaende: Vec<(u32, u32)>,
    /// Bloecke seit Beginn — damit sich eine Zeile im Log zuordnen laesst.
    block: u32,
}

impl TaktDiagnose {
    pub(super) fn bild(&mut self, veraendert: bool) {
        self.bilder += 1;
        self.seit_wechsel += 1;
        if veraendert {
            let abstand = self.seit_wechsel;
            self.seit_wechsel = 0;
            match self.abstaende.iter_mut().find(|(w, _)| *w == abstand) {
                Some((_, n)) => *n += 1,
                None => self.abstaende.push((abstand, 1)),
            }
        }
        if self.bilder >= TAKT_BLOCK {
            self.melden();
        }
    }

    fn melden(&mut self) {
        self.block += 1;
        self.abstaende.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let wechsel: u32 = self.abstaende.iter().map(|(_, n)| n).sum();
        let liste: Vec<String> = self
            .abstaende
            .iter()
            .take(TAKT_SPALTEN)
            .map(|(w, n)| format!("{w}x{n}"))
            .collect();
        let rest = self.abstaende.len().saturating_sub(TAKT_SPALTEN);
        eprintln!(
            "pulse-player: Takt-Diagnose Block {}: {} Bilder, {wechsel} Wechsel, \
             Abstaende {}{}",
            self.block,
            self.bilder,
            liste.join(" "),
            if rest > 0 { format!(" (+{rest} weitere)") } else { String::new() }
        );
        self.bilder = 0;
        self.abstaende.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Die Diagnose muss den ABSTAND zaehlen, nicht die Wechsel: ein Standbild
    /// mit einem Wechsel je 120 Bildern und ein laufender Inhalt sehen sonst
    /// gleich aus, sobald man nur zaehlt, wie oft sich etwas geaendert hat —
    /// und genau diese Verwechslung waere in der Messreihe vom 2026-08-06 nicht
    /// aufgefallen, weil beide Faelle dieselbe Zeile ergaeben.
    #[test]
    fn takt_diagnose_zaehlt_abstaende_nicht_wechsel() {
        // Einen Block minus eins, damit nicht gemeldet und geleert wird.
        let mut standbild = TaktDiagnose::default();
        for i in 0..TAKT_BLOCK - 1 {
            standbild.bild(i % 120 == 0);
        }
        assert_eq!(standbild.abstaende, vec![(1, 1), (120, 4)]);

        let mut laufend = TaktDiagnose::default();
        for _ in 0..TAKT_BLOCK - 1 {
            laufend.bild(true);
        }
        assert_eq!(laufend.abstaende, vec![(1, TAKT_BLOCK - 1)]);
    }

    /// Ein voller Block wird gemeldet und geleert — sonst waechst die Liste
    /// ueber die Laufzeit und die Zeile im Log traegt keinen Zeitbezug mehr.
    #[test]
    fn voller_block_wird_gemeldet_und_geleert() {
        let mut d = TaktDiagnose::default();
        for _ in 0..TAKT_BLOCK {
            d.bild(true);
        }
        assert_eq!(d.block, 1);
        assert_eq!(d.bilder, 0);
        assert!(d.abstaende.is_empty());
    }

    /// Ohne gesetzte Variable bleibt die Vorgabe stehen — sonst haenge das
    /// Verhalten des Players an einer Umgebung, die niemand gesetzt hat.
    #[test]
    fn ohne_umgebung_gilt_die_vorgabe() {
        assert_eq!(zahl("PULSE_PLAYER_GIBT_ES_NICHT", 90), 90);
        assert_eq!(
            dauer("PULSE_PLAYER_GIBT_ES_AUCH_NICHT", std::time::Duration::from_millis(2500)),
            std::time::Duration::from_millis(2500)
        );
    }
}
