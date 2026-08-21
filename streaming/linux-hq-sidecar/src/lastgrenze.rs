//! Last-Grenze für 10-bit-Streams: Auflösung × Bildrate, in Bildpunkten je
//! Sekunde.
//!
//! **Warum es sie gibt (Vorfall 2026-08-20):** 2560×1440 bei 144 Bildern/s in
//! AV1 10 bit brachte die Videoeinheit eines Linux/AMD-Zuschauers zum Hängen
//! (Kernel-Reset des Videorings; auf älterem Treiberunterbau stirbt dabei der
//! ganze Player-Prozess), dieselbe Kombination in 8 bit lief durch. Die
//! Decoder-Hardware gewöhnlicher Karten ist auf etwa „4K60"
//! (~500 Mpix/s) ausgelegt, und 10 bit kostet die Einheit das 1,5- bis
//! 2-fache an Zyklen pro Bildpunkt. Der Sender kann die Zuschauer-Hardware
//! nicht kennen — begrenzen kann er nur den eigenen Strom.
//!
//! **Warum die Grenze HIER gilt und nicht (nur) in der Oberfläche:** das Panel
//! kennt die Quellgröße vor dem Start nicht (Linux wählt die Quelle erst im
//! Portal-Dialog — Monitor oder App-Fenster, „Original" heißt: was immer dann
//! kam). Diese Stelle kennt sie: nach der Verhandlung, vor dem Encoder. Sie
//! deckt damit beide Fälle ab, die die Oberfläche nicht unterscheiden kann.
//! Die Oberfläche filtert zusätzlich vorab, wo sie die Größe weiß (benannte
//! Auflösungs-Stufen) — dieselbe Formel, zweiter Ort:
//!
//! **SPIEGEL — synchron halten mit `web/src/lib/stream/settingsCatalog.ts`**
//! (`FPS_VALUES`, `HQ_TEN_BIT_MAX_PIXELS_PER_SEC` und die Last-Regel in
//! `fpsAllowed`). Wer hier eine Stufe oder die Grenze ändert, ändert sie dort
//! mit — die beiden Listen auseinanderzuhalten hieße, Panel und Sidecar
//! empfehlen unterschiedliche Ströme.

/// Auflösung × Bildrate, ab der ein 10-bit-Strom Zuschauer-Decoder überfordert.
pub const ZEHN_BIT_MAX_PIX_PRO_SEKUNDE: u64 = 300_000_000;

/// Die Bildraten-Stufen, auf die begrenzt wird — dieselbe Leiter wie im Panel.
pub const FPS_STUFEN: [u32; 6] = [25, 30, 60, 90, 120, 144];

/// Wirksame Bildrate für diesen Strom. `(fps, true)` heisst: es wurde
/// begrenzt (und der Caller meldet das).
///
/// In 8 bit wird nie begrenzt — der Vorfall traf nur 10 bit, und 8 bit bei
/// derselben Rate lief durch. Passt keine Stufe unter die Grenze (Riesenquelle),
/// bleibt die kleinste — die Grenze ist eine Führung, kein Verbot; der Strom
/// soll weiter laufen, nur so langsam wie irgendwie möglich.
pub fn begrenzen(breite: u32, hoehe: u32, fps: u32, zehn_bit: bool) -> (u32, bool) {
    if !zehn_bit {
        return (fps, false);
    }
    // u64: 8K×240 läge mit 8,25 Mrd. Pix/s über jedem u32-Produkt.
    let pix_je_bild = breite as u64 * hoehe as u64;
    if pix_je_bild * fps as u64 <= ZEHN_BIT_MAX_PIX_PRO_SEKUNDE {
        return (fps, false);
    }
    // Größte Stufe unter der Grenze; FPS_STUFEN ist aufsteigend, also die
    // letzte, die noch passt. Keine passt → die kleinste (s.o.).
    let stufe = FPS_STUFEN
        .iter()
        .copied()
        .filter(|&stufe| pix_je_bild * stufe as u64 <= ZEHN_BIT_MAX_PIX_PRO_SEKUNDE)
        .next_back()
        .unwrap_or(FPS_STUFEN[0]);
    (stufe, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der Vorfallsfall: 1440p in 10 bit wird von 144 auf 60 begrenzt
    /// (2560×1440×144 = 531 Mpix/s, ×60 = 221 Mpix/s).
    #[test]
    fn vorfallsfall_1440p_144_wird_60() {
        assert_eq!(begrenzen(2560, 1440, 144, true), (60, true));
    }

    /// 8 bit wird nie angefasst — derselbe Strom lief ja durch.
    #[test]
    fn acht_bit_bleibt() {
        assert_eq!(begrenzen(2560, 1440, 144, false), (144, false));
        assert_eq!(begrenzen(7680, 4320, 240, false), (240, false));
    }

    /// Unter der Grenze: keine Veränderung, auch abseits der Stufen-Leiter
    /// (der Testbench darf 100 fps schicken, solange die Last passt).
    #[test]
    fn unter_der_grenze_unangetastet() {
        assert_eq!(begrenzen(1920, 1080, 100, true), (100, false));
        assert_eq!(begrenzen(2560, 1440, 60, true), (60, false));
    }

    /// 4K in 10 bit trägt höchstens 30 (3840×2160×30 = 249 Mpix/s).
    #[test]
    fn uhd_traegt_max_30() {
        assert_eq!(begrenzen(3840, 2160, 60, true), (30, true));
    }

    /// Riesenquelle: bleibt die kleinste Stufe — nie null, nie ein Abbruch.
    #[test]
    fn riesenquelle_bekommt_die_kleinste_stufe() {
        assert_eq!(begrenzen(7680, 4320, 144, true), (25, true));
    }
}
