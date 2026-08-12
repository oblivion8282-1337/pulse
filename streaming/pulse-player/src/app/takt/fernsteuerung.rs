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
/// **Gemessen, nicht gerechnet.** Der erste Ansatz waren 15 ms, hergeleitet aus
/// der Ankunfts-Schwankung (bis 21 ms ueber den Serverweg). Der Feldversuch am
/// 2026-08-12 mit 5 ms war deutlich besser als diese Rechnung erwarten liess —
/// derselbe Weg, dieselbe Leitung, 227 Messfenster:
///
/// | | Vorhalt 30 ms | Vorhalt 5 ms |
/// |---|---|---|
/// | Netz-bis-Schirm | 26-33 ms | **5,5 ms** |
/// | Bildabstand | 15,8-17,4 ms | 0,7-24,3 ms |
/// | „verspaetet" | 451 im Lauf | rund 55 je Sekunde |
///
/// **Was 5 ms wirklich bedeuten:** der Puffer haelt fast nichts mehr zurueck,
/// die Bilder gehen heraus, sobald sie da sind. Der Abstand schwankt dadurch
/// messbar — das ist die Gegenleistung, und sie ist bewusst eingekauft. Beim
/// Steuern zaehlt der geschlossene Kreis aus Eingabe hin und Bild zurueck; von
/// den rund 116 ms Netz laesst sich nichts abziehen, von diesen 26 ms fast
/// alles. Am Bild beurteilt war das Ruckeln dabei nicht wahrnehmbar.
///
/// **Nicht 0.** Auch bei 5 ms bleibt eine Warteschlange, die eine verspaetete
/// Einheit noch einsortieren kann. Bei 0 faellt die Reihenfolge-Korrektur ganz
/// weg — das ist ein anderer Zustand, kein „noch etwas schneller".
///
/// Wer es ruhiger will, stellt es am Pruefstand ueber
/// `PULSE_PLAYER_AUSGABETAKT_MS` gegen — dieser Wert hebt einen tiefer
/// gesetzten nie an.
pub const FERN_VORHALT_MS: u32 = 5;

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
        // `PULSE_PLAYER_AUSGABETAKT_MS=2` am Pruefstand: die Fernsteuerung darf
        // daraus keine 5 machen, sonst misst der Pruefstand etwas anderes, als
        // er eingestellt hat. Bewusst UNTER [`FERN_VORHALT_MS`] gewaehlt —
        // gleichauf wuerde der Test bestehen, ohne irgendetwas zu pruefen.
        let mut takt = Ausgabetakt::neu(2);
        takt.fernsteuerung(true);
        assert_eq!(ms(&takt), 2);
        takt.fernsteuerung(false);
        assert_eq!(ms(&takt), 2);
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
