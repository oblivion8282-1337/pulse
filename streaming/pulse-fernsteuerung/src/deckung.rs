//! Vorvervielfachtes Alpha zurückrechnen — die eine Rechnung, die **jeder**
//! Sender von Zeigerbildern braucht.
//!
//! **Herkunft und offener Rest.** Bis zum 2026-08-23 stand [`entvielfachen`]
//! ausschliesslich in `win-hq-sidecar/src/remote_input/zeigerpunkte.rs`, mitten
//! zwischen echten GDI-Konventionen (`farbzeiger`, `maskenzeiger`,
//! `maske_gesetzt`) — die gehören dort auch hin. Diese eine Funktion aber nicht:
//! sie kennt kein Betriebssystem, und der macOS-Sender braucht sie
//! wortgleich, weil CGImage-Zeigerbitmaps ebenso vorvervielfacht sind wie
//! GDIs. Der Kommentar dort sagt seit dem 2026-08-23 selbst, wohin sie gehört,
//! wenn sie wandert: hierher.
//!
//! **Sie ist erst halb gewandert.** Die Windows-Fassung steht noch, weil die
//! Etappe, in der dieses Modul entstand, den Windows-Sidecar nicht anfassen
//! durfte (parallele Arbeit auf demselben Baum). Damit gibt es für die Dauer
//! einer Etappe zwei Fassungen derselben acht Zeilen. Wer als Nächstes
//! `win-hq-sidecar/src/remote_input/zeigerpunkte.rs` anfasst, ersetzt die
//! dortige `entvielfachen` samt ihrer vier Tests durch
//! `use pulse_fernsteuerung::deckung::entvielfachen;` — die Kiste steht in
//! dessen `Cargo.toml` bereits. Solange das aussteht, gilt: **wer hier etwas
//! ändert, ändert es dort mit.** Der Fehler, den das verhindert, stürzt nicht
//! ab; er sieht aus wie ein Zeiger mit schmutzigem Saum, und nur auf einer der
//! beiden Plattformen.

/// Vorvervielfachtes Alpha zurückrechnen.
///
/// Beide Quellen halten Farbzeiger vorvervielfacht (die Farbe ist bereits mit
/// der Deckung verrechnet): GDI unter Windows, CoreGraphics unter macOS. winit
/// verlangt ausdrücklich das Gegenteil („The alpha channel is assumed to be
/// **not** premultiplied"). Ohne die Rückrechnung kämen alle halbdurchsichtigen
/// Ränder zu dunkel heraus — ein Zeiger mit schmutzigem Saum, und niemand käme
/// auf die Ursache.
///
/// **Umgekehrt hält winit seine eigene Zusage nur auf Wayland ein**: der
/// Windows- und der X11-Weg reichen die Bytes ungerechnet weiter, obwohl GDI
/// bzw. XRender vorvervielfacht erwarten (winit 0.30.13, geprüft 2026-08-17).
/// Ein Steuernder auf Windows oder X11 sieht deshalb an halbdurchsichtigen
/// Zeigerrändern einen etwas zu hellen Saum. Das ist kein Fehler dieser
/// Rechnung und keiner des Packverfahrens — hier vermerkt, damit es später
/// niemand dafür hält und an der falschen Stelle sucht.
pub fn entvielfachen(farbe: u8, deckung: u8) -> u8 {
    if deckung == 0 {
        return 0;
    }
    // Kaufmännisch gerundet (`+ deckung/2`), nicht abgeschnitten: ohne den
    // Term käme halb deckendes 64 als 127 statt 128 heraus, und jeder weiche
    // Rand läge eine Stufe zu dunkel. (Der Windows-Zwilling schreibt an dieser
    // Stelle „Aufgerundet geteilt, damit 255 bei voller Deckung wieder 255
    // ergibt" — das trifft die Rechnung nicht: bei voller Deckung teilt sie
    // ohnehin durch 255, der Term trägt den halb deckenden Fall. Hier
    // berichtigt, dort noch nicht, weil die Datei in dieser Etappe nicht
    // angefasst werden durfte.)
    let wert = (farbe as u32 * 255 + deckung as u32 / 2) / deckung as u32;
    wert.min(255) as u8
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
}
