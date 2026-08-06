//! Der Fingerabdruck eines Bildes, das im Grafikspeicher LIEGENBLEIBT.
//!
//! Auf dem Zero-Copy-Weg (`crate::zerocopy`) gibt es keine Ebenen im
//! Hauptspeicher mehr, also kann [`super::abdruck::bild_abdruck`] dort nicht
//! arbeiten. Gerechnet wird der Abdruck deshalb auf der GPU
//! (`render::abdruck`, Shader `render/abdruck.wgsl`); hier steht, WAS gerechnet
//! wird, in einer Fassung, die ohne GPU pruefbar ist — und der Briefkasten, ueber
//! den das Ergebnis zurueck zum Decoder kommt.
//!
//! ## Zwei Freiheiten, die dieser Abdruck hat
//!
//! * **Er muss dem CPU-Abdruck NICHT gleichen.** Verglichen wird er nur mit
//!   sich selbst (der Waechter fragt „wie oft in Folge derselbe Wert"), und ein
//!   Wechsel zwischen beiden Wegen mitten im Strom findet nicht statt: schaltet
//!   Zero-Copy ab, faengt die Zaehlung ohnehin neu an.
//! * **Die Luma-Ebene allein genuegt** — sie traegt zwei Drittel der Daten, und
//!   ein bewegtes Element ohne jede Helligkeitsaenderung gibt es praktisch
//!   nicht. Das stand bei [`super::abdruck::bild_abdruck`] bereits als
//!   vorgesehener naechster Schritt.
//!
//! ## Wie er gebaut ist — und warum nicht als Summe
//!
//! Auf der GPU laufen die Bildpunkte in unbestimmter Reihenfolge und parallel
//! durch. Die Verknuepfung muss also **kommutativ** sein, sonst haenge das
//! Ergebnis an der Reihenfolge der Recheneinheiten und schwankte von Bild zu
//! Bild. Genommen wird deshalb eine Summe modulo 2^32 — aber **nicht ueber die
//! Helligkeitswerte**.
//!
//! Eine Summe der Werte waere genau der Fehler, der am 2026-08-05 teuer gelernt
//! wurde, nur in anderer Gestalt: sie mittelt. Ein Bildpunkt von 40 auf 41 und
//! ein zweiter von 41 auf 40 heben sich auf; ein 8x16 grosser Cursor auf
//! flaechigem Grund verschiebt eine Summe ueber zwei Millionen Werte um ein
//! Zehntausendstel — und nach der Rundung auf ganze Zahlen bleibt davon je nach
//! Inhalt gar nichts.
//!
//! Summiert wird deshalb **je Bildpunkt ein gemischter Wert, in den die
//! Position eingeht**: `mische(mische(index) ^ wert)`. [`mische`] ist eine
//! Bijektion (Murmur3 `fmix32`), und `k ^ wert` ist bei festem `k` in `wert`
//! ebenfalls umkehrbar. Aendert sich EIN Bildpunkt, aendert sich sein Beitrag
//! garantiert, und damit die Summe — es gibt keinen Wert, auf den ein
//! Bildpunkt „ausweichen" koennte, ohne aufzufallen. Zwei solche Summen mit
//! verschiedenen Positionsschluesseln ergeben die 64 bit; dass beide zugleich
//! zurueckfallen, ist der Fall, gegen den keine Reduktion auf endlich viele Bit
//! schuetzt.
//!
//! **Der Zwilling im Shader muss mitziehen.** [`luma_abdruck`] und
//! `render/abdruck.wgsl` rechnen dasselbe, in denselben 32-bit-Ueberlaeufen;
//! `render::abdruck` prueft im Test, dass beide auf demselben Bild denselben
//! Wert liefern. Wer eine der beiden Seiten aendert, aendert beide.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Murmur3 `fmix32` — eine Bijektion auf u32.
///
/// **Dass sie umkehrbar ist, ist die ganze Begruendung** (s. Modulkopf): nur
/// deshalb kann kein veraenderter Bildpunkt denselben Beitrag liefern wie
/// vorher. Eine beliebige „Streufunktion" taete es nicht.
#[cfg(test)]
#[inline(always)]
fn mische(x: u32) -> u32 {
    let mut h = x;
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h
}

/// Zweiter Positionsschluessel, damit die beiden Haelften des Abdrucks nicht
/// dieselbe Rechnung sind. Beliebig gewaehlt (Murmur2-Konstante), nur ungleich
/// null muss er sein.
#[cfg(test)]
const ZWEITER: u32 = 0x5bd1_e995;

/// Der Abdruck der Luma-Ebene — **die Fassung, die ohne GPU laeuft**.
///
/// **Nur uebersetzt, wenn Tests laufen** (`#[cfg(test)]`). Im Betrieb rechnet
/// ausschliesslich der Shader; diese Fassung ist seine PRUEFBARE Beschreibung.
/// Sie hier stehen zu lassen, obwohl sie niemand aufruft, ist der Punkt: an ihr
/// laesst sich ohne Grafikkarte zeigen, dass ein einzelner Bildpunkt auffaellt,
/// und `render::abdruck` weist auf echter Hardware nach, dass der Shader
/// dasselbe rechnet. Ohne diesen zweiten Nachweis waere sie eine Behauptung
/// ueber fremden Code.
///
/// Zwilling von `render/abdruck.wgsl`. Gerechnet wird ueber den NUTZANTEIL
/// (`breite` x `hoehe`), nicht ueber die ganze Textur: der Decoder rundet die
/// Textur auf (bei AV1 auf Vielfache von 128), und was in der Auffuellung
/// steht, ist nicht unsere Sache.
///
/// `zehn_bit` unterscheidet, was ein Bildpunkt ist: ein Byte (NV12) oder ein
/// 16-bit-Wort (P010, die zehn Bit sitzen oben). Der Shader bekommt denselben
/// Unterschied als Skalierungsfaktor — beide lesen am Ende dieselbe ganze Zahl.
#[cfg(test)]
pub fn luma_abdruck(daten: &[u8], breite: u32, hoehe: u32, stride: usize, zehn_bit: bool) -> u64 {
    let mut a: u32 = 0;
    let mut b: u32 = 0;
    let breite_u = breite as usize;
    for y in 0..hoehe as usize {
        for x in 0..breite_u {
            let wert = if zehn_bit {
                let off = y * stride + x * 2;
                match (daten.get(off), daten.get(off + 1)) {
                    (Some(lo), Some(hi)) => u32::from(u16::from_le_bytes([*lo, *hi])),
                    _ => 0,
                }
            } else {
                u32::from(daten.get(y * stride + x).copied().unwrap_or(0))
            };
            let index = (y * breite_u + x) as u32;
            a = a.wrapping_add(mische(mische(index) ^ wert));
            b = b.wrapping_add(mische(mische(index ^ ZWEITER) ^ wert));
        }
    }
    (u64::from(a) << 32) | u64::from(b)
}

/// Wie viele Abdruecke hoechstens auf ihre Abholung warten.
///
/// Der Decoder leert den Briefkasten in jedem Durchgang, im Betrieb liegt also
/// hoechstens eine Handvoll darin. Der Deckel ist gegen den Fall, dass der
/// Decoder stehenbleibt und der Renderer weiterrechnet — dann waechst hier
/// sonst unbegrenzt Speicher, den niemand je liest. Verworfen wird der
/// AELTESTE: fuer die Frage „aendert sich das Bild noch" ist das juengste
/// Ergebnis das wertvollere.
const PLAETZE: usize = 16;

/// Der Rueckweg vom Renderer zum Decoder.
///
/// **Warum ueberhaupt ein Briefkasten und kein Kanal:** die beiden reden sonst
/// nur in eine Richtung (Decoder-Thread → Kanal → Fenster-Thread). Ein zweiter
/// Kanal muesste durch `session.rs` und `app` hindurchgereicht werden; der
/// Briefkasten faehrt stattdessen im Bild selbst mit
/// (`zerocopy::GpuBild::briefkasten`) und ist damit automatisch der richtige,
/// auch wenn mehrere Sitzungen gleichzeitig laufen. Ein globaler Kanal wuerde
/// deren Abdruecke vermischen.
#[derive(Default)]
pub struct Briefkasten {
    schlange: Mutex<VecDeque<u64>>,
}

impl Briefkasten {
    pub fn neu() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Vom Renderer: ein fertig gerechneter Abdruck.
    pub fn einwerfen(&self, abdruck: u64) {
        let Ok(mut s) = self.schlange.lock() else { return };
        if s.len() >= PLAETZE {
            s.pop_front();
        }
        s.push_back(abdruck);
    }

    /// Vom Decoder: der aelteste wartende Abdruck.
    pub fn nehmen(&self) -> Option<u64> {
        self.schlange.lock().ok()?.pop_front()
    }
}

/// Ab wie vielen unbeantworteten GPU-Bildern der Rueckweg als tot gilt.
const STUMME_BILDER: u32 = 60;

/// Und wie lange er dafuer zusaetzlich geschwiegen haben muss.
///
/// Beide Bedingungen zusammen, nicht eine: beim Anlauf, beim Fenster-Wechsel
/// und waehrend eines Formatwechsels bleibt das Zeichnen kurz aus, ohne dass
/// etwas kaputt waere. Fuenf Sekunden bei laufender Bildausgabe sind dagegen
/// kein Ruckler mehr.
const STUMME_DAUER: Duration = Duration::from_secs(5);

/// Der Zulauf der GPU-Abdruecke auf der Decoder-Seite.
///
/// **Er ist zur Haelfte eine Wache ueber die Wache.** Rechnet der Renderer die
/// Abdruecke nicht (Pipeline liess sich nicht bauen, Bindung abgelehnt, das
/// Fenster zeichnet gar nicht mehr), dann kaeme beim Einfrier-Waechter nie ein
/// Bild an — er zaehlte nichts, meldete nichts, und der schnelle Weg liefe
/// ungesichert. Genau der Zustand, den es hier zu vermeiden gilt. Deshalb
/// zaehlt der Zulauf mit, wie viele GPU-Bilder ohne Antwort hinausgegangen
/// sind, und sagt dem Aufrufer, wann er den Weg aufzugeben hat.
pub struct Zulauf {
    kasten: Arc<Briefkasten>,
    /// GPU-Bilder seit dem letzten eingetroffenen Abdruck.
    stumm: u32,
    /// Wann das erste davon hinausging.
    seit: Instant,
}

impl Default for Zulauf {
    fn default() -> Self {
        Self { kasten: Briefkasten::neu(), stumm: 0, seit: Instant::now() }
    }
}

impl Zulauf {
    /// Der Briefkasten, der jedem GPU-Bild mitgegeben wird.
    pub fn kasten(&self) -> &Arc<Briefkasten> {
        &self.kasten
    }

    /// Ein Bild ist auf dem GPU-Weg hinausgegangen.
    pub fn bild_hinaus(&mut self) {
        self.bild_hinaus_zur_zeit(Instant::now());
    }

    fn bild_hinaus_zur_zeit(&mut self, jetzt: Instant) {
        // Die Uhr startet beim ERSTEN unbeantworteten Bild, nicht beim letzten
        // Abdruck: sonst faellt eine lange Pause ohne GPU-Bilder (Ruecklesen,
        // Standbild vor dem Verbindungsaufbau) dem naechsten Bild zur Last.
        if self.stumm == 0 {
            self.seit = jetzt;
        }
        self.stumm = self.stumm.saturating_add(1);
    }

    /// Alles Eingetroffene in den Waechter geben.
    ///
    /// `true` heisst **„der Rueckweg ist tot"** — der Aufrufer schaltet den
    /// Zero-Copy-Weg dann ab. Sagt das nur einmal je Aussetzer: danach faengt
    /// die Zaehlung von vorn an.
    pub fn einspeisen(&mut self, wacht: &mut super::EinfrierWacht) -> bool {
        self.einspeisen_zur_zeit(wacht, Instant::now())
    }

    fn einspeisen_zur_zeit(&mut self, wacht: &mut super::EinfrierWacht, jetzt: Instant) -> bool {
        let mut gekommen = false;
        while let Some(abdruck) = self.kasten.nehmen() {
            wacht.bild_von_der_gpu(abdruck);
            gekommen = true;
        }
        if gekommen {
            self.stumm = 0;
            return false;
        }
        if self.stumm >= STUMME_BILDER && jetzt.saturating_duration_since(self.seit) >= STUMME_DAUER
        {
            self.stumm = 0;
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der Massstab, den der CPU-Abdruck erfuellt und der hier genauso gelten
    /// muss: **ein Byte reicht**. Eine Reduktion, die ueber die Helligkeiten
    /// mittelt, faellt hier durch.
    #[test]
    fn ein_einzelner_bildpunkt_reicht() {
        const B: u32 = 1920;
        const H: u32 = 1080;
        let ohne = vec![40u8; (B * H) as usize];
        for stelle in [0usize, 1, 123_457, (B * H) as usize - 1] {
            let mut mit = ohne.clone();
            mit[stelle] = 41;
            assert_ne!(
                luma_abdruck(&ohne, B, H, B as usize, false),
                luma_abdruck(&mit, B, H, B as usize, false),
                "ein Bildpunkt an Stelle {stelle} muss auffallen"
            );
        }
    }

    /// Gleiche Bilder gleich — sonst zaehlte der Waechter dauernd „Bewegung"
    /// und schliefe nie ein.
    #[test]
    fn gleiche_bilder_geben_denselben_abdruck() {
        let a: Vec<u8> = (0..64 * 64).map(|i| (i % 251) as u8).collect();
        assert_eq!(
            luma_abdruck(&a, 64, 64, 64, false),
            luma_abdruck(&a.clone(), 64, 64, 64, false)
        );
    }

    /// Der Fall, der den Fehlalarm vom 2026-08-05 ausgeloest hat: ein winziges
    /// bewegtes Element vor stehendem Rest — ein blinkender Cursor. Auf einer
    /// GEMITTELTEN Reduktion verschwindet er (128 von 2 073 600 Bildpunkten),
    /// hier muss er auffallen.
    #[test]
    fn ein_blinkender_cursor_faellt_auf() {
        const B: usize = 1920;
        const H: usize = 1080;
        let ohne = vec![40u8; B * H];
        let mut mit = ohne.clone();
        for y in 520..536 {
            for x in 960..968 {
                mit[y * B + x] = 235;
            }
        }
        assert_ne!(
            luma_abdruck(&ohne, B as u32, H as u32, B, false),
            luma_abdruck(&mit, B as u32, H as u32, B, false),
            "ein 8x16 grosser Cursor muss den Abdruck aendern"
        );
    }

    /// Die Position gehoert dazu. Zwei Bildpunkte, die ihre Werte TAUSCHEN,
    /// lassen jede blosse Summe unveraendert — dieser Abdruck nicht.
    #[test]
    fn vertauschte_bildpunkte_fallen_auf() {
        let mut a = vec![10u8; 256];
        a[7] = 200;
        let mut b = vec![10u8; 256];
        b[200] = 200;
        assert_ne!(luma_abdruck(&a, 16, 16, 16, false), luma_abdruck(&b, 16, 16, 16, false));
    }

    /// Die Auffuellung der Textur zaehlt NICHT mit: gelesen wird der
    /// Nutzanteil, und der Zeilenabstand darf groesser sein als die Breite.
    #[test]
    fn die_auffuellung_bleibt_draussen() {
        let stride = 128usize;
        let mut a = vec![0u8; stride * 8];
        let mut b = a.clone();
        // Nur ausserhalb der genutzten 100 Spalten schreiben.
        for y in 0..8 {
            b[y * stride + 120] = 255;
        }
        assert_eq!(luma_abdruck(&a, 100, 8, stride, false), luma_abdruck(&b, 100, 8, stride, false));
        // Zur Gegenprobe: INNERHALB muss es auffallen.
        a[3 * stride + 99] = 1;
        assert_ne!(luma_abdruck(&a, 100, 8, stride, false), luma_abdruck(&b, 100, 8, stride, false));
    }

    /// Bei zehn Bit steht der Wert in einem 16-bit-Wort. Aendert sich nur das
    /// obere Byte (dort sitzen bei P010 die Nutzbits), muss es auffallen.
    #[test]
    fn zehn_bit_liest_das_ganze_wort() {
        let a = vec![0u8; 32 * 2 * 4];
        let mut b = a.clone();
        b[2 * 5 + 1] = 0x40;
        assert_ne!(luma_abdruck(&a, 32, 4, 64, true), luma_abdruck(&b, 32, 4, 64, true));
    }

    /// Der Briefkasten darf nicht unbegrenzt wachsen, wenn niemand abholt.
    #[test]
    fn der_briefkasten_ist_gedeckelt() {
        let k = Briefkasten::neu();
        for i in 0..(PLAETZE as u64 * 3) {
            k.einwerfen(i);
        }
        let mut gezaehlt = 0;
        let mut letzter = 0;
        while let Some(v) = k.nehmen() {
            gezaehlt += 1;
            letzter = v;
        }
        assert_eq!(gezaehlt, PLAETZE, "hoechstens {PLAETZE} duerfen liegenbleiben");
        assert_eq!(letzter, PLAETZE as u64 * 3 - 1, "die juengsten muessen es sein");
    }

    /// Kommen Abdruecke, ist alles in Ordnung — auch nach vielen Bildern.
    #[test]
    fn ein_lebendiger_rueckweg_meldet_nichts() {
        let mut z = Zulauf::default();
        let mut w = super::super::EinfrierWacht::default();
        let start = Instant::now();
        for i in 0..600u64 {
            z.bild_hinaus_zur_zeit(start + Duration::from_millis(i * 16));
            z.kasten().einwerfen(i);
            assert!(!z.einspeisen_zur_zeit(&mut w, start + Duration::from_millis(i * 16)));
        }
    }

    /// **Der Fall, um den es geht.** Der Renderer liefert nichts — dann darf
    /// der schnelle Weg nicht einfach ungesichert weiterlaufen.
    #[test]
    fn ein_stummer_rueckweg_wird_aufgegeben() {
        let mut z = Zulauf::default();
        let mut w = super::super::EinfrierWacht::default();
        let start = Instant::now();
        let mut gemeldet = false;
        for i in 0..600u64 {
            let jetzt = start + Duration::from_millis(i * 16);
            z.bild_hinaus_zur_zeit(jetzt);
            gemeldet |= z.einspeisen_zur_zeit(&mut w, jetzt);
        }
        assert!(gemeldet, "60 Bilder und 5 Sekunden ohne Abdruck muessen auffallen");
    }

    /// Eine kurze Pause im Zeichnen ist kein toter Rueckweg — sonst faellt der
    /// Weg bei jedem Fensterwechsel um.
    #[test]
    fn eine_kurze_pause_reicht_nicht() {
        let mut z = Zulauf::default();
        let mut w = super::super::EinfrierWacht::default();
        let start = Instant::now();
        for i in 0..120u64 {
            let jetzt = start + Duration::from_millis(i * 16); // 120 Bilder in 1,9 s
            z.bild_hinaus_zur_zeit(jetzt);
            assert!(!z.einspeisen_zur_zeit(&mut w, jetzt), "1,9 s duerfen nicht reichen");
        }
    }
}
