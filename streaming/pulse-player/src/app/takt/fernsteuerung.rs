//! Der Vorhalt waehrend einer **Fernsteuerung** — ein Wert, zwei Betriebsarten.
//!
//! Kindmodul von [`super`] und nicht Nachbar: es fasst `vorhalt` und
//! `vorhalt_vor_fern` an, und die sind privat. Getrennt liegt es trotzdem, weil
//! der Ausgabe-Takt sonst die Groessen-Policy reisst (PLAN.md §12.1) — und weil
//! die Begruendung fuer den Wert laenger ist als die Rechnung dahinter.

use std::time::Duration;

use super::Ausgabetakt;

/// Vorhalt waehrend einer Fernsteuerung (s. [`Ausgabetakt::fernsteuerung`]).
///
/// **Nicht 0.** Die Ankunft schwankt ueber eine echte Leitung messbar: am
/// 2026-08-12 ueber den Serverweg bis 21 ms, mit rund 15 Bildern je Sekunde
/// mehr als 5 ms daneben. Ohne jeden Vorhalt wird daraus sichtbares Ruckeln
/// statt Verzoegerung — und wer steuert, braucht ein ruhiges Bild noch mehr als
/// wer zusieht. 15 ms liegen unter der gemessenen Schwankung und sparen
/// trotzdem die Haelfte.
pub const FERN_VORHALT_MS: u32 = 15;

impl Ausgabetakt {
/// Vorhalt fuer die Dauer einer Fernsteuerung absenken — und danach genau
    /// den Wert wiederherstellen, der vorher galt.
    ///
    /// **Warum ueberhaupt.** Der Vorhalt glaettet Schwankungen der Leitung; beim
    /// ZUSEHEN ist das ein guter Tausch, beim STEUERN zahlt man ihn als
    /// Verzoegerung im geschlossenen Kreis (Eingabe hin, Bild zurueck). Gemessen
    /// am 2026-08-12 ueber den Serverweg: Netz hin und zurueck rund 116 ms, der
    /// Vorhalt kam mit 30 ms obendrauf — ein Viertel dessen, was sich ueberhaupt
    /// beeinflussen laesst.
    ///
    /// **Warum hier und nicht in der App.** Der Player weiss ohnehin, wann eine
    /// Fernsteuerung laeuft (`input_capture`). Von aussen gesetzt braeuchte es
    /// einen zweiten Wert fuer „zurueck auf normal", der die Vorgabe von hier
    /// doppelt — und ein Zurueckstellen, das ausfaellt, sobald die App abstuerzt
    /// oder die Sitzung unerwartet endet. Dann bliebe der Rechner
    /// ruckelanfaellig, ohne dass es je jemand bemerkte.
    ///
    /// **Nur senken, nie anheben.** Wer selbst schon tiefer eingestellt hat
    /// (`PULSE_PLAYER_AUSGABETAKT_MS`, Pruefstand), bekommt seinen Wert nicht
    /// von der Fernsteuerung angehoben.
    pub fn fernsteuerung(&mut self, aktiv: bool) {
        if aktiv {
            if self.vorhalt_vor_fern.is_some() {
                return;
            }
            self.vorhalt_vor_fern = Some(self.vorhalt);
            let ziel = self.vorhalt.min(Duration::from_millis(u64::from(FERN_VORHALT_MS)));
            self.setze_vorhalt(ziel.as_millis() as u32);
        } else if let Some(alt) = self.vorhalt_vor_fern.take() {
            self.setze_vorhalt(alt.as_millis() as u32);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(takt: &Ausgabetakt) -> u128 {
        takt.vorhalt.as_millis()
    }

    #[test]
    fn senkt_ab_und_gibt_genau_den_alten_wert_zurueck() {
        let mut takt = Ausgabetakt::neu(30);
        takt.fernsteuerung(true);
        assert_eq!(ms(&takt), u128::from(FERN_VORHALT_MS));
        takt.fernsteuerung(false);
        assert_eq!(ms(&takt), 30, "der Wert VOR der Fernsteuerung, keine Vorgabe");
    }

    #[test]
    fn hebt_einen_selbst_gesetzten_tieferen_wert_nicht_an() {
        // `PULSE_PLAYER_AUSGABETAKT_MS=5` am Pruefstand: die Fernsteuerung darf
        // daraus keine 15 machen, sonst misst der Pruefstand etwas anderes, als
        // er eingestellt hat.
        let mut takt = Ausgabetakt::neu(5);
        takt.fernsteuerung(true);
        assert_eq!(ms(&takt), 5);
        takt.fernsteuerung(false);
        assert_eq!(ms(&takt), 5);
    }

    #[test]
    fn zweimal_einschalten_verliert_den_gemerkten_wert_nicht() {
        // Ein zweites `input_capture` mit `enabled: true` (Slot- oder
        // Sitzungswechsel mitten in der Fernsteuerung) darf den gemerkten Stand
        // nicht mit dem bereits abgesenkten ueberschreiben — sonst bliebe der
        // Player nach dem Ende dauerhaft auf dem kleinen Vorhalt.
        let mut takt = Ausgabetakt::neu(30);
        takt.fernsteuerung(true);
        takt.fernsteuerung(true);
        takt.fernsteuerung(false);
        assert_eq!(ms(&takt), 30);
    }

    #[test]
    fn ausschalten_ohne_einschalten_aendert_nichts() {
        let mut takt = Ausgabetakt::neu(30);
        takt.fernsteuerung(false);
        assert_eq!(ms(&takt), 30);
    }
}
