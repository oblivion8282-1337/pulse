//! Die Sollwerte des HDR-Farbwegs — **unabhaengig vom Shader gerechnet**.
//!
//! Warum das eine eigene Datei ist und nicht eine Funktion neben der Messung:
//! ein Sollwert, den derselbe Code liefert, der geprueft werden soll, prueft
//! nichts. Genau daran ist am 2026-08-04 schon einmal eine Aussage ueber den
//! Player gescheitert (die numpy-Nachrechnung mass den Nachbau, nicht den
//! Shader, `docs/2026-08-04-player-farbwerte-messung.md`). Hier stehen deshalb
//! **feste Zahlen**, die aus den Normformeln stammen und nicht aus
//! `shader.wgsl`.
//!
//! **Woher die Zahlen kommen.** Aus einer Rechnung, die nur die veroeffentlichten
//! Formeln benutzt (der Rechenweg ist in der Messakte
//! `streaming/testbench/profiles/player-2026-08-06-hdr-farbweg.json` Schritt fuer
//! Schritt aufgeschrieben, samt Zwischenergebnissen in cd/m²):
//!
//! 1. **YCbCr -> R'G'B'**, BT.2020 ohne konstante Leuchtdichte, begrenzter
//!    Wertebereich, 10 bit: `y = (Y-64)/876`, `cb = (Cb-512)/896`,
//!    `cr = (Cr-512)/896`; dann mit Kr = 0,2627 und Kb = 0,0593 aus
//!    ITU-R BT.2020 Tabelle 4:
//!    `R' = y + 2(1-Kr)cr`, `B' = y + 2(1-Kb)cb`,
//!    `G' = y - (2Kb(1-Kb)/Kg)cb - (2Kr(1-Kr)/Kg)cr`, `Kg = 1-Kr-Kb`.
//! 2. **PQ-Kurve (SMPTE ST 2084), EOTF**, je Kanal — ergibt cd/m², absolut.
//! 3. **BT.2020 -> BT.709 in linearem Licht**, Matrix aus den Primaervalenzen
//!    beider Normen und dem Weisspunkt D65 nach SMPTE RP 177 (nicht aus einer
//!    abgeschriebenen Tabelle):
//!    ```text
//!     1.6604910  -0.5876411  -0.0728499
//!    -0.1245505   1.1328999  -0.0083494
//!    -0.0181508  -0.1005789   1.1187297
//!    ```
//!    Alle drei Zeilensummen sind exakt 1 — deshalb bleibt Grau grau.
//! 4a. **HDR-Ziel:** durch 80 (scRGB, IEC 61966-2-2).
//! 4b. **SDR-Ziel:** erweitertes Reinhard mit Bezug Diffusweiss 203 cd/m²
//!    (ITU-R BT.2408), `x = L/203`, `w = Spitze/203`,
//!    `y = x(1 + x/w²)/(1 + x)`, danach auf 0..1 begrenzt und sRGB-kodiert
//!    (IEC 61966-2-1).
//!
//! **Die Eingabecodes sind ganzzahlig, und der Sollwert gilt fuer GENAU diese
//! Ganzzahlen** — nicht fuer die runde Helligkeit, aus der sie entstanden sind.
//! Bei „100 cd/m² -> Y=509" sind es in Wahrheit 99,913 cd/m²; die Differenz ist
//! die Quantisierung auf zehn Bit und gehoert zur Eingabe, nicht zum Fehler.

/// Neutrales Chroma in 10 bit: Code 512 von 1023.
///
/// **Nicht 0,5.** Der frueher im Shader stehende Abzug von 0,5 lag um einen
/// halben Chroma-Code daneben und gab Grau einen Blaustich
/// (`docs/2026-08-04-player-farbwerte-messung.md`).
pub const NEUTRAL: u16 = 512;

/// Ein Pruefpunkt: Eingabe in Codewerten, Sollausgabe fuer beide Ziele.
pub struct Fall {
    pub name: &'static str,
    /// Luma-Code, 10 bit, begrenzter Wertebereich (64..940).
    pub y: u16,
    /// Chroma-Codes, 10 bit, begrenzter Wertebereich ([`NEUTRAL`] = farblos).
    pub cb: u16,
    pub cr: u16,
    /// Soll im **HDR-Fenster**: scRGB, lineares Licht, 1,0 = 80 cd/m².
    /// Werte ueber 1,0 und unter 0,0 sind hier richtig, nicht falsch.
    pub hdr: [f32; 3],
    /// Soll im **SDR-Fenster**: nach dem Zusammenschieben, begrenzt und
    /// sRGB-kodiert — also der Wert, der ins Fenster geschrieben wird.
    pub sdr: [f32; 3],
}

impl Fall {
    /// Ist die Quelle farblos? Dann muss die Ausgabe es auch sein — die
    /// Bedingung, an der die Farbmessung ihren schaerfsten Einzeltest
    /// festmacht.
    pub const fn neutral(&self) -> bool {
        self.cb == NEUTRAL && self.cr == NEUTRAL
    }
}

/// Ein farbloser Pruefpunkt.
///
/// **Der Helfer garantiert baulich, was sonst nur ein Test behaupten koennte:**
/// bei neutralem Chroma sind die drei Kanaele gleich. Von Hand dreimal
/// hingeschriebene Sollwerte koennten in einer Stelle auseinanderlaufen — und
/// die Messung meldete dann einen Farbstich, den es gar nicht gibt, oder
/// verdeckte einen, den es gibt.
const fn grau(name: &'static str, y: u16, hdr: f32, sdr: f32) -> Fall {
    Fall { name, y, cb: NEUTRAL, cr: NEUTRAL, hdr: [hdr; 3], sdr: [sdr; 3] }
}

/// Spitzenhelligkeit des Inhalts, mit der das Tone-Mapping gerechnet wird.
///
/// **1000 ist hier kein Ersatzwert, sondern Teil des Versuchsaufbaus**: mit ihr
/// muss der Fall „1000 cd/m²" hinten exakt auf 1,0 landen. Genau das ist die
/// Zusage der Kurve, und sie ist nur pruefbar, wenn die Spitze bekannt ist.
pub const SPITZE_NITS: f32 = 1000.0;

/// Der Luma-Code, bei dem der gemessene echte Strom seine Spitze hatte
/// (275 cd/m², `docs/2026-08-06-hdr-windows-amd.md` Befund 4) — als Fall Nr. 5
/// in der Tabelle, damit mindestens ein Pruefpunkt aus einer Messung stammt
/// und nicht aus einer runden Zahl.
pub const ECHTE_SPITZE_CODE: u16 = 601;

pub const FAELLE: &[Fall] = &[
    // ── Neutrales Grau: R, G und B muessen gleich herauskommen ──────────────
    //                        Name                       Y     HDR         SDR
    grau("Grau Y=64 (Schwarz)", 64, 0.0, 0.0),
    grau("Grau Y=200", 200, 0.013854, 0.065076),
    grau("Grau Y=400", 400, 0.338110, 0.378391),
    grau("Grau Y=502 (Mitte)", 502, 1.153071, 0.599778),
    grau("Grau Y=601 (echte Spitze)", ECHTE_SPITZE_CODE, 3.449873, 0.802735),
    grau("Grau Y=700", 700, 9.863248, 0.965257),
    // Y=800 und Y=940 liegen UEBER der angemeldeten Spitze — die Kurve laeuft
    // ueber 1,0 hinaus und wird begrenzt. Das ist die richtige Antwort auf
    // Inhalt, der heller ist als seine eigene Ansage, nicht ein Ausfressen.
    grau("Grau Y=800", 800, 28.108391, 1.0),
    grau("Grau Y=940 (Weiss)", 940, 125.0, 1.0),
    // ── Bekannte Helligkeiten: Code aus der PQ-Kurve vorwaerts gerechnet ────
    grau("1 cd/m2 -> Y=195", 195, 0.012402, 0.059689),
    grau("100 cd/m2 -> Y=509", 509, 1.248910, 0.615161),
    grau("203 cd/m2 -> Y=573", 573, 2.546287, 0.749393),
    // Genau die angemeldete Spitze: muss im SDR-Ziel exakt auf 1,0 fallen.
    grau("1000 cd/m2 -> Y=723", 723, 12.552399, 1.0),
    // ── Die reinen Primaervalenzen von BT.2020, je 100 cd/m² ────────────────
    //
    // In BT.709 liegen sie AUSSERHALB des Wuerfels; zwei der drei Kanaele
    // muessen negativ werden. Ein Weg, der hier auf 0 abschneidet, verliert
    // genau die weiten Farben, wegen derer HDR gefahren wird — und man saehe
    // es dem Bild nicht an, weil ein abgeschnittenes Rot immer noch rot ist.
    Fall {
        name: "BT.2020 Rot 100 cd/m2",
        y: 181,
        cb: 448,
        cr: 740,
        hdr: [2.090476, -0.156803, -0.022851],
        sdr: [0.713215, 0.0, 0.0],
    },
    Fall {
        name: "BT.2020 Gruen 100 cd/m2",
        y: 366,
        cb: 348,
        cr: 303,
        hdr: [-0.735010, 1.417011, -0.125802],
        sdr: [0.0, 0.639469, 0.0],
    },
    Fall {
        name: "BT.2020 Blau 100 cd/m2",
        y: 90,
        cb: 740,
        cr: 494,
        hdr: [-0.091381, -0.010473, 1.403311],
        sdr: [0.0, 0.0, 0.637602],
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    /// Die Tabelle selbst muss in sich stimmen — sonst prueft die Messung
    /// gegen eine Zahl, die beim Abschreiben verrutscht ist.
    ///
    /// „Bei neutralem Chroma sind die drei Kanaele gleich" steht hier NICHT
    /// mehr: seit die farblosen Faelle ueber [`grau`] entstehen, ist das
    /// baulich so und kein Test mehr wert.
    #[test]
    fn die_tabelle_ist_in_sich_stimmig() {
        for f in FAELLE {
            assert!((64..=940).contains(&f.y), "{}: Luma ausserhalb 64..940", f.name);
            assert!((64..=960).contains(&f.cb) && (64..=960).contains(&f.cr), "{}", f.name);
            // Das SDR-Ziel ist ein Fensterinhalt: nichts darf dort ausserhalb
            // von 0..1 stehen.
            for k in f.sdr {
                assert!((0.0..=1.0).contains(&k), "{}: SDR-Soll {k} ausserhalb 0..1", f.name);
            }
        }
    }

    /// Die Graustufen muessen monoton steigen — beide Ziele. Eine Kurve, die
    /// dazwischen umkehrt, waere in der Einzelzeile nicht zu erkennen.
    #[test]
    fn grau_steigt_monoton() {
        let farblos: Vec<&Fall> = FAELLE.iter().filter(|f| f.neutral()).collect();
        for paar in farblos.windows(2) {
            let (a, b) = (paar[0], paar[1]);
            if a.y >= b.y {
                continue; // die Reihe der bekannten Helligkeiten faengt neu an
            }
            assert!(b.hdr[0] > a.hdr[0], "HDR faellt: {} -> {}", a.name, b.name);
            assert!(b.sdr[0] >= a.sdr[0], "SDR faellt: {} -> {}", a.name, b.name);
        }
    }

    /// **Die Zusage der Tone-Mapping-Kurve.** Der Inhalt bei genau der
    /// angemeldeten Spitze landet auf 1,0 — und Schwarz auf 0. Zwei Punkte, an
    /// denen die Kurve exakt sein muss und nicht nur ungefaehr.
    #[test]
    fn die_spitze_landet_auf_eins_und_schwarz_auf_null() {
        let spitze = FAELLE.iter().find(|f| f.y == 723).expect("1000-cd/m2-Fall");
        assert_eq!(spitze.sdr, [1.0, 1.0, 1.0]);
        let schwarz = FAELLE.iter().find(|f| f.y == 64).expect("Schwarz-Fall");
        assert_eq!(schwarz.sdr, [0.0, 0.0, 0.0]);
        assert_eq!(schwarz.hdr, [0.0, 0.0, 0.0]);
    }

    /// Die weiten Farben muessen in BT.709 wirklich herausragen — sonst
    /// pruefte der Fall nichts.
    #[test]
    fn die_primaervalenzen_liegen_ausserhalb_von_bt709() {
        for f in FAELLE.iter().filter(|f| f.name.starts_with("BT.2020")) {
            assert!(f.hdr.iter().any(|k| *k < -0.005), "{}: kein negativer Kanal", f.name);
        }
    }
}
