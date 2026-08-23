//! Die Zeitrechnung des Host-Vorrangs — reine Arithmetik, ohne Uhr.
//!
//! Wie lange nach der letzten Regung des Hosts seine Eingabe noch Vorrang hat
//! ([`rest_ms`], [`host_regt_sich`]) und wie lang die Frist selbst ist
//! ([`frist_ms`], ueberschreibbar per `PULSE_FERN_VORRANG_MS`). Die Uhr bleibt
//! plattformseitig: `jetzt_ms()` haengt dort an einem prozessweiten
//! `OnceLock<Instant>` (ein `Instant` passt nicht in ein Atomic), und die
//! letzte Regung an einem prozessweiten Atomic. Diese Kiste bekommt beide
//! Zahlen nur als Argumente hereingereicht — und genau das macht die Rechnung
//! pruefbar, ohne eine echte Uhr laufen zu lassen.

use std::sync::OnceLock;

/// Wie lange nach der letzten Regung des Hosts seine Eingabe Vorrang hat.
pub const VORRANG_FRIST_MS: u64 = 5_000;

/// Abstand der Übergangsprüfung — der Wecker selbst liegt bei der jeweiligen
/// Plattform (unter Windows `wecker_starten` in `remote_input::wache`).
pub const WECKER_MS: u64 = 100;

/// Die Frist, einmal gelesen. `PULSE_FERN_VORRANG_MS` setzt sie um — gedacht
/// für den Zwei-Geräte-Test, wo fünf Sekunden je Durchgang die Messung
/// beherrschen. Geklemmt, damit ein Vertipper die Zusage nicht aufhebt.
pub fn frist_ms() -> u64 {
    static FRIST: OnceLock<u64> = OnceLock::new();
    *FRIST.get_or_init(|| {
        std::env::var("PULSE_FERN_VORRANG_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(|v| v.clamp(100, 60_000))
            .unwrap_or(VORRANG_FRIST_MS)
    })
}

/// Hat der Host gerade Vorrang?
pub fn host_regt_sich(letzte_regung_ms: u64, jetzt_ms: u64) -> bool {
    rest_ms(letzte_regung_ms, jetzt_ms) > 0
}

/// Wie lange der Vorrang noch gilt (0 = kein Vorrang). Geht als Zahl an den
/// Renderer, damit der Steuernde „noch 4 s" sehen kann statt nur „gesperrt".
pub fn rest_ms(letzte_regung_ms: u64, jetzt_ms: u64) -> u64 {
    if letzte_regung_ms == 0 {
        return 0;
    }
    frist_ms().saturating_sub(jetzt_ms.saturating_sub(letzte_regung_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `0` heisst „noch nie geregt" — nicht „vor sehr langer Zeit".
    ///
    /// **Die Uhrzeit hier ist der ganze Test.** Mit einem `jetzt` jenseits der
    /// Frist (etwa 10_000 bei 5_000 Frist) liefert schon die blosse
    /// Saettigungsrechnung 0, und der Sonderfall liesse sich streichen, ohne
    /// dass etwas rot wird — genau so stand es hier, und eine Mutationsprobe
    /// hat es gefunden. Ein `jetzt` INNERHALB der Frist trennt die beiden
    /// Faelle: ohne den Sonderfall kaeme `frist - 1` heraus.
    #[test]
    fn ohne_regung_kein_vorrang() {
        assert_eq!(rest_ms(0, 1), 0, "0 heisst nie geregt, nicht 'vor 1 ms'");
        assert!(!host_regt_sich(0, 1));
        // Und auch jenseits der Frist bleibt es dabei.
        assert_eq!(rest_ms(0, 10_000), 0);
        assert!(!host_regt_sich(0, 10_000));
    }

    /// Die Frist laeuft ab, sie springt nicht.
    #[test]
    fn die_frist_laeuft_linear_ab() {
        let f = frist_ms();
        assert_eq!(rest_ms(1_000, 1_000), f);
        assert_eq!(rest_ms(1_000, 1_000 + f / 2), f - f / 2);
        assert_eq!(rest_ms(1_000, 1_000 + f), 0);
        assert_eq!(rest_ms(1_000, 1_000 + f + 1), 0, "danach bleibt sie bei null");
    }

    /// **Eine rueckwaerts laufende Uhr darf keinen ewigen Vorrang erzeugen.**
    /// `saturating_sub` faengt es ab; ohne diese Zusage liefe `jetzt < letzte`
    /// auf einen Unterlauf und der Host behielte sein Geraet fuer immer.
    #[test]
    fn eine_rueckwaerts_laufende_uhr_verlaengert_nicht() {
        assert!(rest_ms(5_000, 4_000) <= frist_ms());
        assert!(host_regt_sich(5_000, 4_000), "noch innerhalb der Frist");
    }

    /// Die Grenzen der Umgebungsvariablen sind eine Zusage, kein Vorschlag.
    #[test]
    fn die_frist_bleibt_in_ihren_grenzen() {
        let f = frist_ms();
        assert!((100..=60_000).contains(&f), "frist_ms() = {f}");
    }
}
