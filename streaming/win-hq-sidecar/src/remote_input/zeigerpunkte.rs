//! Wie aus dem, was GDI herausgibt, Bildpunkte werden — die reine Rechnung
//! hinter [`super::zeigerpixel`].
//!
//! **Getrennt, damit sie prüfbar ist.** Alles hier ist Umrechnung: Kanäle
//! drehen, Deckung zurückrechnen, zwei Masken verheiraten. Nichts davon braucht
//! Windows, und in [`super::zeigerpixel`] könnte es niemand ausserhalb eines
//! Windows-Rechners nachrechnen — dabei sind genau diese drei Schritte die,
//! bei denen ein Fehler nicht abstürzt, sondern still ein falsches Bild
//! erzeugt: einen zu dunklen Saum, einen Zeiger in der falschen Farbe, ein
//! Loch statt einer Form.
//!
//! Die Sorten Zeiger, die Windows kennt, und warum alles als 32 bit gelesen
//! wird, stehen im Kopf von [`super::zeigerpixel`].
//!
//! **Offener Punkt, bewusst nicht gewandert (2026-08-23).** [`entvielfachen`]
//! ist wie der Rest dieser Datei plattformfrei — rund 8 Zeilen Rechnung, 25
//! Zeilen gemessene Begründung, vier Tests — und einschlägig für macOS:
//! CGImage-Zeigerbitmaps sind ebenso vorvervielfacht wie GDIs. Es ist
//! **nicht** eines der fünf Stücke aus
//! `docs/superpowers/plans/2026-08-23-fernsteuerung-macos-1b-zweiter-schnitt.md`
//! und deshalb hier liegen geblieben; ein macOS-Autor, der das nicht weiß,
//! schreibt dieselbe Rundung neu oder lässt sie weg und bekommt schmutzige
//! Ränder, die nicht abstürzen. Wandert sie doch, gehört sie nach
//! `streaming/pulse-fernsteuerung`. `farbzeiger`/`maskenzeiger`/
//! `maske_gesetzt` sind dagegen echte GDI-Konventionen und bleiben zu Recht
//! hier.

/// Ist an dieser Stelle der Maske ein Bit gesetzt? Als 32 bit gelesen heisst
/// gesetzt „weiss"; ein einzelner Farbkanal genügt zur Unterscheidung.
pub(super) fn maske_gesetzt(maske: &[u8], nr: usize) -> bool {
    maske.get(nr * 4).is_some_and(|&b| b > 127)
}

/// Vorvervielfachtes Alpha zurückrechnen.
///
/// GDI hält Farbzeiger vorvervielfacht (die Farbe ist bereits mit der Deckung
/// verrechnet), winit verlangt ausdrücklich das Gegenteil („The alpha channel
/// is assumed to be **not** premultiplied"). Ohne die Rückrechnung kämen alle
/// halbdurchsichtigen Ränder zu dunkel heraus — ein Zeiger mit schmutzigem
/// Saum, und niemand käme auf die Ursache.
///
/// **Umgekehrt hält winit seine eigene Zusage nur auf Wayland ein**: der
/// Windows- und der X11-Weg reichen die Bytes ungerechnet weiter, obwohl GDI
/// bzw. XRender vorvervielfacht erwarten (winit 0.30.13, geprüft 2026-08-17).
/// Ein Steuernder auf Windows oder X11 sieht deshalb an halbdurchsichtigen
/// Zeigerrändern einen etwas zu hellen Saum. Das ist kein Fehler dieser
/// Rechnung und keiner des Packverfahrens — hier vermerkt, damit es später
/// niemand dafür hält und an der falschen Stelle sucht.
pub(super) fn entvielfachen(farbe: u8, deckung: u8) -> u8 {
    if deckung == 0 {
        return 0;
    }
    // Aufgerundet geteilt, damit 255 bei voller Deckung wieder 255 ergibt.
    let wert = (farbe as u32 * 255 + deckung as u32 / 2) / deckung as u32;
    wert.min(255) as u8
}

/// Ein Farbzeiger. `deckung_aus_maske` trägt die Deckung nach, wenn das
/// Farbbild keine hat (die ältere Bauart, Sorte 2 im Kopf von
/// [`super::zeigerpixel`]).
pub(super) fn farbzeiger(bgra: &[u8], deckung_aus_maske: Option<&[u8]>) -> Vec<u8> {
    let mut punkte = Vec::with_capacity(bgra.len());
    for (nr, p) in bgra.chunks_exact(4).enumerate() {
        let deckung = match deckung_aus_maske {
            // Die UND-Maske sagt, was vom Hintergrund STEHEN BLEIBT — ein
            // gesetztes Bit ist also durchsichtig, nicht deckend. Andersherum
            // gelesen käme der Zeiger als Loch in seiner Umgebung heraus.
            Some(maske) => {
                if maske_gesetzt(maske, nr) {
                    0
                } else {
                    255
                }
            }
            None => p[3],
        };
        // BGRA aus GDI, RGBA für winit.
        punkte.extend_from_slice(&[
            entvielfachen(p[2], deckung),
            entvielfachen(p[1], deckung),
            entvielfachen(p[0], deckung),
            deckung,
        ]);
    }
    punkte
}

/// Ein reiner Maskenzeiger: zwei Masken übereinander in einer doppelt hohen
/// Bitmap, oben UND, unten XOR.
///
/// | UND | XOR | Wirkung auf dem Bildschirm | hier |
/// |---|---|---|---|
/// | 0 | 0 | schwarz | schwarz, deckend |
/// | 0 | 1 | weiss | weiss, deckend |
/// | 1 | 0 | bleibt stehen | durchsichtig |
/// | 1 | 1 | wird umgekehrt | schwarz, deckend |
///
/// Die letzte Zeile ist eine **Näherung**: den Bildschirm umzukehren kann ein
/// übertragenes Bild nicht, weil es nicht weiss, worauf es liegt. Schwarz
/// gewählt, weil die umkehrenden Zeiger fast alle Schreibmarken sind und die
/// vor hellem Grund stehen. Betroffen sind ohnehin fast nur die Windows-eigenen
/// Formen — und die gehen als Name hinaus, kommen hier also gar nicht an.
pub(super) fn maskenzeiger(bgra: &[u8], punkte_je_maske: usize) -> Vec<u8> {
    let mut punkte = Vec::with_capacity(punkte_je_maske * 4);
    for nr in 0..punkte_je_maske {
        let und = maske_gesetzt(bgra, nr);
        let xor = maske_gesetzt(bgra, punkte_je_maske + nr);
        punkte.extend_from_slice(match (und, xor) {
            (true, false) => &[0, 0, 0, 0],
            (false, true) => &[255, 255, 255, 255],
            _ => &[0, 0, 0, 255],
        });
    }
    punkte
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Voll deckend bleibt die Farbe, wie sie ist — sonst verschöbe die
    /// Rückrechnung jeden gewöhnlichen Bildpunkt.
    #[test]
    fn volle_deckung_laesst_die_farbe_stehen() {
        assert_eq!(entvielfachen(255, 255), 255);
        assert_eq!(entvielfachen(128, 255), 128);
        assert_eq!(entvielfachen(0, 255), 0);
    }

    /// Halb deckend: die vorvervielfachte Farbe wird wieder aufgehellt. Genau
    /// das fehlt, wenn Zeigerränder schmutzig aussehen.
    #[test]
    fn halbe_deckung_wird_zurueckgerechnet() {
        assert_eq!(entvielfachen(64, 128), 128);
        assert_eq!(entvielfachen(128, 128), 255);
    }

    /// Gar keine Deckung: kein Teilen durch null, und die Farbe ist ohnehin
    /// bedeutungslos.
    #[test]
    fn ohne_deckung_bleibt_es_bei_null() {
        assert_eq!(entvielfachen(200, 0), 0);
    }

    /// Ein vorvervielfachter Wert kann durch Rundung über 255 geraten —
    /// geklemmt statt umgebrochen, sonst würde ein zu heller Punkt schwarz.
    #[test]
    fn ueberlauf_wird_geklemmt() {
        assert_eq!(entvielfachen(255, 1), 255);
    }

    /// Die Wahrheitstafel des Maskenzeigers, Zeile für Zeile.
    #[test]
    fn die_maskentafel_stimmt() {
        let weiss = [255u8, 255, 255, 255];
        let schwarz = [0u8, 0, 0, 255];
        // Zwei Punkte je Maske. UND: gesetzt, gelöscht — XOR: gelöscht, gesetzt.
        let mut bgra = Vec::new();
        bgra.extend_from_slice(&weiss);
        bgra.extend_from_slice(&schwarz);
        bgra.extend_from_slice(&schwarz);
        bgra.extend_from_slice(&weiss);
        let punkte = maskenzeiger(&bgra, 2);
        assert_eq!(&punkte[0..4], &[0, 0, 0, 0], "UND gesetzt, XOR nicht → durchsichtig");
        assert_eq!(&punkte[4..8], &[255, 255, 255, 255], "UND gelöscht, XOR gesetzt → weiss");
    }

    /// Beide Bits gesetzt heisst „Bildschirm umkehren" — hier deckendes
    /// Schwarz, s. Tafel oben. Festgehalten, damit die Näherung eine
    /// Entscheidung bleibt und nicht zum Zufall wird.
    #[test]
    fn das_umkehrende_feld_wird_schwarz() {
        let weiss = [255u8, 255, 255, 255];
        let mut bgra = Vec::new();
        bgra.extend_from_slice(&weiss); // UND gesetzt
        bgra.extend_from_slice(&weiss); // XOR gesetzt
        assert_eq!(maskenzeiger(&bgra, 1), vec![0, 0, 0, 255]);
    }

    /// **Die Falle der älteren Bauart.** Ein Farbbild ohne jede Deckung ist
    /// nicht durchsichtig, sondern unvollständig — die Maske trägt die Deckung.
    /// Ohne diesen Zweig überträgt die Fernsteuerung ein leeres Bild, und der
    /// Steuernde sieht überhaupt keinen Zeiger mehr.
    #[test]
    fn die_maske_traegt_die_deckung_nach() {
        // ein Punkt, blau, ohne Deckung im Farbbild
        let bgra = [255u8, 0, 0, 0];
        // UND-Bit gelöscht = dieser Punkt gehört dem Zeiger
        let maske = [0u8, 0, 0, 255];
        assert_eq!(farbzeiger(&bgra, Some(&maske)), vec![0, 0, 255, 255], "blau, voll deckend");
    }

    /// Ein gesetztes UND-Bit heisst durchsichtig. Andersherum gelesen käme der
    /// Zeiger als Loch in seiner Umgebung heraus.
    #[test]
    fn ein_gesetztes_und_bit_ist_durchsichtig() {
        assert_eq!(farbzeiger(&[255u8, 255, 255, 0], Some(&[255u8; 4])), vec![0, 0, 0, 0]);
    }

    /// BGRA aus GDI wird zu RGBA für winit. Vertauscht wäre jeder Zeiger in der
    /// falschen Farbe.
    #[test]
    fn die_kanaele_werden_gedreht() {
        // B=10, G=20, R=30, A=255
        assert_eq!(farbzeiger(&[10u8, 20, 30, 255], None), vec![30, 20, 10, 255]);
    }
}
