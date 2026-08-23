//! Von Fenster-Koordinaten auf globale CoreGraphics-Punkte — die eine Rechnung,
//! an der ein Messmittel fuer Zeigerlagen als erstes luegt.
//!
//! **Warum das nicht trivial ist.** Der Injektor spricht in globalen
//! CoreGraphics-Punkten: Ursprung **oben links** auf dem Hauptschirm, y waechst
//! nach unten. Ein `NSEvent` meldet seine Lage dagegen `locationInWindow`:
//! Ursprung **unten links** im Fenster, y waechst nach oben. Wer die Umkehrung
//! vergisst, misst an der Bildschirmmitte weiterhin 0 px Abweichung — dort
//! faellt die Spiegelung nicht auf — und an den vier Ecken das Doppelte der
//! Fensterhoehe. Genau deshalb stehen in [`super::ziele`] die Ecken mit drin.

/// `locationInWindow` (Punkte, Ursprung unten links) -> globaler
/// CoreGraphics-Punkt (Punkte, Ursprung oben links).
///
/// `fenster_hoehe` und `ursprung` sind beide in **Punkten** zu uebergeben, nicht
/// in Bildpunkten: winit liefert sie als Bildpunkte, und auf einem Retina-Schirm
/// ist das der Faktor 2. Ein Messmittel, das den Faktor verschluckt, meldet auf
/// diesem Rechner die halbe oder die doppelte Lage — und beides sieht wie ein
/// Fehler des Injektors aus.
pub fn fenster_zu_global(
    im_fenster: (f64, f64),
    fenster_hoehe: f64,
    ursprung: (f64, f64),
) -> (f64, f64) {
    (ursprung.0 + im_fenster.0, ursprung.1 + (fenster_hoehe - im_fenster.1))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Die Umkehrung selbst: oberer Fensterrand (`y == hoehe`) ist global
    /// `y == 0`, unterer Rand (`y == 0`) ist `hoehe`.
    ///
    /// **Mutationsfest:** eine Fassung ohne Umkehrung (`ursprung.1 +
    /// im_fenster.1`) liefert hier 900 statt 100 und faellt durch.
    #[test]
    fn die_senkrechte_wird_umgekehrt() {
        assert_eq!(fenster_zu_global((0.0, 1000.0), 1000.0, (0.0, 0.0)), (0.0, 0.0));
        assert_eq!(fenster_zu_global((0.0, 0.0), 1000.0, (0.0, 0.0)), (0.0, 1000.0));
        assert_eq!(fenster_zu_global((10.0, 900.0), 1000.0, (0.0, 0.0)), (10.0, 100.0));
    }

    /// Die Waagerechte wird NICHT umgekehrt — sonst spiegelte das Messmittel
    /// links und rechts und meldete an der Mitte trotzdem null.
    #[test]
    fn die_waagerechte_bleibt() {
        assert_eq!(fenster_zu_global((7.0, 500.0), 1000.0, (0.0, 0.0)).0, 7.0);
        assert_eq!(fenster_zu_global((993.0, 500.0), 1000.0, (0.0, 0.0)).0, 993.0);
    }

    /// Der Fensterursprung wird auf **beiden** Achsen aufgeschlagen. Auf dem
    /// Hauptschirm ist er (0,0) und faellt weg — auf einem zweiten Schirm nicht,
    /// und genau dort saesse der Fehler (dieselbe Falle wie im Windows-Labor).
    #[test]
    fn der_fensterursprung_kommt_dazu() {
        assert_eq!(fenster_zu_global((10.0, 900.0), 1000.0, (1920.0, -300.0)), (1930.0, -200.0));
    }

    /// Die Mitte ist der Punkt, an dem eine vergessene Umkehrung NICHT
    /// auffaellt. Der Test haelt das als Warnung fest: wer nur hier misst, misst
    /// nichts.
    #[test]
    fn die_mitte_verraet_die_umkehrung_nicht() {
        let ohne_umkehrung = (500.0, 500.0);
        assert_eq!(fenster_zu_global((500.0, 500.0), 1000.0, (0.0, 0.0)), ohne_umkehrung);
    }
}
