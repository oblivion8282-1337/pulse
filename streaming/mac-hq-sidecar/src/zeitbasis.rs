//! **Dritte Fassung dieser Rechnung im Repo** (2026-08-20), neben
//! `win-hq-sidecar/src/zeitbasis.rs` und `linux-hq-sidecar/src/zeitbasis.rs`.
//! Uebernommen wurde nur, was der Sendeweg braucht. Wer hier etwas aendert,
//! sieht dort nach — und umgekehrt.

/// Takte je Sekunde der Video-Zeitbasis. **Gleich der RTP-Uhr** — die
/// Gleichheit ist Absicht und der Grund fuer die Wahl (s. Modulkopf).
pub const VIDEO_HZ: u32 = 90_000;

/// Aufnahmezeit in Sekunden seit Streambeginn → pts in Takten.
///
/// Negative Eingaben (ein Bild, das minimal VOR dem Streambeginn entstand)
/// kommen als 0 heraus statt als negativer Zeitstempel — der Aufrufer haelt
/// die Monotonie ohnehin, aber ein negativer pts waere schon auf dem Weg
/// dorthin eine Falle.
pub fn pts_aus_sekunden(sekunden: f64) -> i64 {
    if !sekunden.is_finite() || sekunden <= 0.0 {
        return 0;
    }
    (sekunden * f64::from(VIDEO_HZ)).round() as i64
}

/// Ein Bildabstand in Takten, aufgerundet.
///
/// Aufgerundet, weil jeder Nutzer unten eine UNTERGRENZE braucht („mindestens
/// so weit auseinander"): bei 60 fps sind 90000/60 glatt 1500, bei 144 aber
/// 625, und bei krummen Raten wie 30000/1001 liegt der echte Abstand
/// dazwischen. Abrunden liesse dort zwei Bilder als „weit genug auseinander"
/// durchgehen, die es nicht sind.
pub fn takte_je_bild(fps: u32) -> i64 {
    let fps = fps.max(1);
    (i64::from(VIDEO_HZ) + i64::from(fps) - 1) / i64::from(fps)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eine_sekunde_sind_neunzigtausend_takte() {
        assert_eq!(pts_aus_sekunden(1.0), 90_000);
        assert_eq!(pts_aus_sekunden(0.5), 45_000);
    }

    #[test]
    fn negative_und_kaputte_zeiten_werden_null() {
        assert_eq!(pts_aus_sekunden(-0.001), 0);
        assert_eq!(pts_aus_sekunden(f64::NAN), 0);
    }

    /// Aufrunden, nicht abrunden — sonst ist die Untergrenze keine.
    #[test]
    fn bildabstand_rundet_auf() {
        assert_eq!(takte_je_bild(60), 1_500);
        assert_eq!(takte_je_bild(144), 625);
        assert_eq!(takte_je_bild(280), 322, "90000/280 ist 321,4");
        assert_eq!(takte_je_bild(0), 90_000, "keine Division durch null");
    }
}
