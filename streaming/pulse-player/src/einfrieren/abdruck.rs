//! Der Fingerabdruck eines dekodierten Bildes.
//!
//! Herausgeloest aus [`super`], weil es eine eigene Frage ist: „haben zwei
//! Bilder denselben Inhalt" hat mit „steht der Decoder" nichts zu tun, und die
//! Begruendungsgeschichte der beiden ist ebenfalls eine andere.

/// Streufaktor des Abdrucks. Ungerade, also ist jeder Mischschritt umkehrbar —
/// ein einzelnes veraendertes Byte kann sich nicht herausheben.
const MISCHER: u64 = 0x517c_c1b7_2722_0a95;

/// Ein einzelner Mischschritt: `wort` in `kette` einrechnen (s. [`MISCHER`]).
#[inline(always)]
fn mische(kette: u64, wort: u64) -> u64 {
    (kette ^ wort).wrapping_mul(MISCHER)
}

/// Fingerabdruck eines Bildes: **jedes Byte zaehlt**.
///
/// **Hier stand bis zum 2026-08-05 eine Stichprobe** — „jedes 1021. Byte
/// (Primzahl, damit die Schrittweite nicht mit der Zeilenlaenge zusammenfaellt),
/// hoechstens 4096 Proben. Fuer die Frage ‚hat sich ueberhaupt etwas geaendert'
/// genuegt das." **Der letzte Satz ist falsch, und er war die Ursache des
/// gemeldeten Fehlalarms** (voll im Modulkopf): 3000 Proben auf 3,1 MB sind ein
/// Tausendstel des Bildes, ein blinkender Cursor traf sie zu rund 12 %, und weil
/// das Raster fest liegt, blieb er dauerhaft unsichtbar. Der Encoder schickte
/// 4646 kbit/s echten Bildinhalt, der Abdruck meldete „unveraendert".
///
/// Eine dichtere Stichprobe waere nur eine kleinere Version desselben Fehlers:
/// jedes feste Raster hat blinde Flecken, und ein Element, das einmal
/// danebenliegt, liegt immer daneben. Ein je Bild wechselndes Raster wuerde die
/// blinden Flecken wandern lassen, aber dann sind zwei Abdruecke nur noch bei
/// gleichem Raster vergleichbar — das kostet Zustand und macht aus „gleich?"
/// ein „gleich wie vor N Bildern?". Vollstaendig lesen ist einfacher und die
/// einzige Variante ohne Restrisiko.
///
/// **Kosten, gemessen am 2026-08-05 in derselben Kette** (1080p60 in NV12, 3,1
/// MB je Bild, zwei Laeufe ueber je 90 s auf demselben Inhalt): Dekodierzeit
/// je Bild im Mittel **3,78 ms mit der Stichprobe, 4,11 ms mit dem
/// vollstaendigen Abdruck** — 0,33 ms oder 9 %, bei unveraenderter Bildrate.
/// Das ist der Preis dafuer, dass ein veraendertes Bild nicht mehr durchrutschen
/// kann. Vier unabhaengige Ketten, damit die Multiplikationen einander nicht
/// blockieren; gelesen wird in 8-Byte-Woertern.
///
/// Fuer groessere Bilder waechst er linear mit (1440p in 10 bit sind rund
/// 11 MB, also gut das Dreifache). Wird das eng, ist die Y-Ebene allein der
/// naechste Schritt — sie traegt zwei Drittel der Daten, und ein bewegtes
/// Element ohne jede Helligkeitsaenderung gibt es praktisch nicht.
pub(super) fn bild_abdruck(planes: &[Vec<u8>]) -> u64 {
    let mut ketten = [MISCHER; 4];
    for plane in planes {
        // Die Laenge gehoert dazu: sonst gaeben zwei verschieden grosse Ebenen
        // mit gleichem Anfang denselben Abdruck.
        ketten[0] = mische(ketten[0], plane.len() as u64);

        let bloecke = plane.chunks_exact(32);
        let rest = bloecke.remainder();
        for block in bloecke {
            for (kette, bytes) in ketten.iter_mut().zip(block.chunks_exact(8)) {
                let wort = u64::from_le_bytes(bytes.try_into().unwrap());
                *kette = mische(*kette, wort);
            }
        }
        for (i, byte) in rest.iter().enumerate() {
            let kette = &mut ketten[i % 4];
            *kette = mische(*kette, u64::from(*byte));
        }
    }
    ketten.iter().fold(0u64, |abdruck, &kette| mische(abdruck, kette))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der Fingerabdruck muss zwei Dinge koennen: gleiche Bilder gleich
    /// abbilden und veraenderte verschieden.
    ///
    /// **Hier stand bis zum 2026-08-05 „Er liest nur jedes 1021. Byte — die
    /// Probe MUSS also treffen"**; seither liest er jedes Byte, es gibt also
    /// keine Probenstellen mehr, die treffen muessten. Die alten Stellen
    /// bleiben trotzdem im Test: sie sind jetzt der Regressionsschutz gegen
    /// eine Rueckkehr zur Stichprobe.
    #[test]
    fn abdruck_erkennt_veraenderung() {
        let a = vec![vec![7u8; 300_000], vec![9u8; 150_000]];
        assert_eq!(bild_abdruck(&a), bild_abdruck(&a.clone()));

        // Erstes Byte.
        let mut b = a.clone();
        b[0][0] = 8;
        assert_ne!(bild_abdruck(&a), bild_abdruck(&b));

        // Eine Stelle, die auch das alte Raster getroffen haette.
        let mut c = a.clone();
        c[0][1021 * 50] = 8;
        assert_ne!(bild_abdruck(&a), bild_abdruck(&c));

        // Andere Groesse zaehlt ebenfalls als Veraenderung.
        let d = vec![vec![7u8; 299_999], vec![9u8; 150_000]];
        assert_ne!(bild_abdruck(&a), bild_abdruck(&d));

        // Ein einzelnes Byte irgendwo mittendrin — mit der alten Stichprobe
        // ging so etwas zu 99,9 % unter.
        let mut e = a.clone();
        e[0][123_457] ^= 1;
        assert_ne!(bild_abdruck(&a), bild_abdruck(&e), "ein Byte muss reichen");
    }

    /// Der Fall, der den gemeldeten Fehlalarm ausgeloest hat: ein winziges
    /// bewegtes Element vor stehendem Rest — ein blinkender Cursor. Er MUSS
    /// auffallen, sonst zaehlt die Erkennung 90 „gleiche" Bilder, waehrend der
    /// Encoder echten Bildinhalt schickt.
    ///
    /// Die Stelle ist bewusst ein blinder Fleck des alten Rasters (jedes 1021.
    /// Byte). Das ist kein Sonderfall, sondern der Regelfall: von den
    /// Cursor-Positionen in einem 1080p-Bild sind **87 %** blind.
    #[test]
    fn abdruck_bemerkt_blinkenden_cursor() {
        const STRIDE: usize = 1920; // wie im Log: „Zeilenabstand 1920"
        let ohne = vec![vec![40u8; STRIDE * 1080], vec![128u8; STRIDE * 540]];
        let mut mit = ohne.clone();

        let (x0, y0) = (960, 520);
        let mut altes_raster_traf = false;
        for y in y0..y0 + 16 {
            for x in x0..x0 + 8 {
                let i = y * STRIDE + x;
                altes_raster_traf |= i % 1021 == 0;
                mit[0][i] = 235;
            }
        }
        assert!(
            !altes_raster_traf,
            "Pruefstelle muss ein blinder Fleck des alten Rasters sein, sonst \
             prueft der Test nichts"
        );
        assert_ne!(
            bild_abdruck(&ohne),
            bild_abdruck(&mit),
            "ein 8x16 grosser Cursor muss den Abdruck aendern"
        );
    }
}
