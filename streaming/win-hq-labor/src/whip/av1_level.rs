//! Das AV1-Level im Sequenzkopf berichtigen, bevor der Strom hinausgeht.
//!
//! **Warum das nötig ist.** `av1_vulkan` schreibt in FFmpeg 8.1 immer
//! `seq_level_idx = 4`, also Level 3.0, und die Option `-level` wird dabei
//! ignoriert. Level 3.0 erlaubt aber nur 665.856 Bildpunkte je Bild — 1280x720
//! sind 921.600. Der Strom überschreitet damit das Level, das er selbst angibt,
//! und zwar schon bei der Bildgröße.
//!
//! **Was das anrichtet.** Ein Software-Decoder ignoriert die Angabe.
//! Chromiums Hardware-Decoder nicht: er nimmt den Strom an, scheitert und fällt
//! auf `dav1d` zurück. Für die Zuschauer heißt das: 8 Bit läuft, aber auf der
//! CPU; 10 Bit bleibt schwarz, weil der Software-Decoder in Chromiums WebRTC
//! keine 10 Bit kann. Der `av1_amf`-Strom hat das Problem nicht — er schreibt
//! Level 5.2.
//!
//! **Gemessen am 2026-08-02** über den Hetzner-Messstand, Edge und Brave:
//! ohne diese Korrektur 1 Rückfall auf Software und 0 Bilder bei 10 Bit; mit
//! ihr 0 Rückfälle und rund 490 Bilder in 20 s, alle drei Ströme in Hardware.
//! Messakte `intrarefresh-2026-08-02-windows-amd.json`, Abschnitt 9.
//!
//! **Warum eine Korrektur der Bits und kein Encoder-Patch.** Der Patch wäre die
//! sauberere Stelle, kostet aber einen FFmpeg-Neubau je Änderung. Hier ist es
//! ein Feld, dessen Lage aus dem Bitstrom selbst geprüft wird.
//!
//! Grundlage: AV1-Spezifikation 5.5.1 (`sequence_header_obu`) und Annex A
//! (Tabelle A.1, Level-Grenzen).

use anyhow::Result;

/// OBU-Typ des Sequenzkopfs.
const OBU_SEQUENZKOPF: u8 = 1;

/// Ab hier verlangt die Spezifikation ein `seq_tier`-Bit hinter dem Level.
const TIER_AB: u8 = 8;

/// Bit-Offset von `seq_level_idx[0]` im Rumpf — gilt nur für die Form, die
/// [`kopf_form`] prüft.
const LEVEL_BIT: usize = 24;

/// Die Level, die für uns in Frage kommen, mit ihren Grenzen aus Tabelle A.1.
///
/// `(idx, max_bildpunkte, max_breite, max_hoehe, max_punkte_je_sekunde)`.
/// Nur die tatsächlich definierten Stufen — 2.2, 2.3, 3.2, 3.3 und die
/// entsprechenden darüber sind in der Spezifikation reserviert und dürfen
/// nicht geschrieben werden.
const LEVEL: &[(u8, u64, u32, u32, u64)] = &[
    (4, 665_856, 4352, 2448, 19_975_680),          // 3.0
    (5, 1_065_024, 5504, 3096, 31_950_720),        // 3.1
    (8, 2_359_296, 6144, 3456, 70_778_880),        // 4.0  bis 1080p30
    (9, 2_359_296, 6144, 3456, 141_557_760),       // 4.1  bis 1080p60
    (12, 8_912_896, 8192, 4352, 267_386_880),      // 5.0  bis 4K30
    (13, 8_912_896, 8192, 4352, 534_773_760),      // 5.1  bis 4K60
    (14, 8_912_896, 8192, 4352, 1_069_547_520),    // 5.2  bis 4K120
    (16, 35_651_584, 16384, 8704, 1_069_547_520),  // 6.0  bis 8K30
    (17, 35_651_584, 16384, 8704, 2_139_095_040),  // 6.1  bis 8K60
    (18, 35_651_584, 16384, 8704, 4_278_190_080),  // 6.2  darueber
];

/// Das kleinste Level, das diese Bildgröße bei dieser Bildrate trägt.
///
/// **Das kleinste und nicht einfach ein großzügiges.** `av1_amf` schreibt
/// pauschal 5.2; das ist zulässig, aber es schließt Decoder aus, die nur bis
/// 4.0 können, obwohl der Inhalt dort hineinpasste. Ein Level ist eine Angabe
/// darüber, was ein Decoder mitbringen muss — je genauer, desto mehr Geräte
/// spielen den Strom.
fn kleinstes_level(breite: u32, hoehe: u32, fps: u32) -> Option<u8> {
    let punkte = u64::from(breite) * u64::from(hoehe);
    let je_sekunde = punkte * u64::from(fps.max(1));
    LEVEL
        .iter()
        .find(|(_, max_p, max_b, max_h, max_rate)| {
            punkte <= *max_p && breite <= *max_b && hoehe <= *max_h && je_sekunde <= *max_rate
        })
        .map(|(idx, ..)| *idx)
}

/// Wie [`hebe_level`], aber **ohne den Puffer des Aufrufers anzufassen**.
///
/// Liefert `None`, wenn nichts zu tun ist — und das ist der Regelfall: ein
/// Sequenzkopf steht nur an wenigen Bildern, bei Intra-Refresh sogar nur an
/// einem. Eine Kopie je Bild wäre für einen Nebeneffekt bezahlt, den es fast
/// nie gibt.
pub(crate) fn hebe_level_kopie(daten: &[u8], fps: u32) -> Result<Option<Vec<u8>>> {
    // **Ein Durchlauf, nicht zwei.** Der Regelfall ist „kein Sequenzkopf da",
    // und den beantwortet dieselbe Liste, aus der sonst gearbeitet wird.
    let obus = super::av1_entpacken::obus(daten)?;
    if !obus.iter().any(|o| o.typ == OBU_SEQUENZKOPF) {
        return Ok(None);
    }
    let mut aus = Vec::with_capacity(daten.len() + 4);
    let mut geaendert = false;
    let mut ende = 0usize;
    for obu in obus {
        ende = obu.ende;
        if obu.typ != OBU_SEQUENZKOPF {
            aus.extend_from_slice(&daten[obu.start..obu.ende]);
            continue;
        }
        match berichtige(&daten[obu.rumpf..obu.ende], fps) {
            Some(neu) => {
                // OBU mit neuer Größe wieder aufbauen: Kopfbytes unverändert,
                // Größenfeld neu, weil der Rumpf länger sein kann.
                aus.extend_from_slice(&daten[obu.start..obu.start + obu.kopf_len]);
                crate::whip::av1::schreibe_leb128(&mut aus, neu.len() as u32);
                aus.extend_from_slice(&neu);
                geaendert = true;
            }
            None => aus.extend_from_slice(&daten[obu.start..obu.ende]),
        }
    }
    // Nur der Schwanz nach dem letzten vollständigen OBU — er trägt etwas,
    // wenn der Durchlauf wegen abgeschnittener Daten früh abgebrochen hat.
    aus.extend_from_slice(&daten[ende..]);
    if !geaendert {
        return Ok(None);
    }
    Ok(Some(aus))
}

/// Form und Inhalt eines Sequenzkopfs, so weit wir ihn brauchen.
struct Form {
    level: u8,
    /// Ist hinter dem Level ein `seq_tier`-Bit?
    tier: bool,
    breite: u32,
    hoehe: u32,
}

/// Den Kopf so weit lesen, wie die Korrektur es braucht — und `None`, wenn er
/// nicht die vorausgesetzte Form hat.
///
/// **Prüft, statt anzunehmen.** Die Lage von `seq_level_idx` hängt davon ab,
/// was davor steht; ein blindes Schreiben an fester Stelle träfe sonst
/// irgendein anderes Feld, und der Schaden zeigte sich als sporadisch kaputtes
/// Bild statt als Fehler.
fn kopf_form(rumpf: &[u8]) -> Option<Form> {
    let bits = rumpf.len() * 8;
    let lies = |bit: usize| -> u8 { (rumpf[bit / 8] >> (7 - bit % 8)) & 1 };
    let lies_n = |ab: usize, n: usize| -> u32 {
        (0..n).fold(0u32, |acc, k| (acc << 1) | u32::from(lies(ab + k)))
    };
    // 4 reduced_still_picture_header · 5 timing_info · 6 initial_display_delay
    // · 7..11 operating_points_cnt_minus_1
    if bits < LEVEL_BIT + 5 || lies(4) == 1 || lies(5) == 1 || lies(6) == 1 || lies_n(7, 5) != 0 {
        return None;
    }
    let level = lies_n(LEVEL_BIT, 5) as u8;
    let tier = level >= TIER_AB;
    let mut p = LEVEL_BIT + 5 + usize::from(tier);
    if p + 8 > bits {
        return None;
    }
    let b_bits = lies_n(p, 4) as usize + 1;
    let h_bits = lies_n(p + 4, 4) as usize + 1;
    p += 8;
    if p + b_bits + h_bits > bits {
        return None;
    }
    let breite = lies_n(p, b_bits) + 1;
    let hoehe = lies_n(p + b_bits, h_bits) + 1;
    Some(Form { level, tier, breite, hoehe })
}

/// Einen Sequenzkopf-Rumpf mit berichtigtem Level neu schreiben.
///
/// `None`, wenn nichts zu tun ist (Level schon hoch genug, Form unerwartet,
/// oder keine Stufe reicht).
fn berichtige(rumpf: &[u8], fps: u32) -> Option<Vec<u8>> {
    let form = kopf_form(rumpf)?;
    let neu = kleinstes_level(form.breite, form.hoehe, fps)?;
    if neu <= form.level {
        return None;
    }
    // Als Bitfolge umbauen: bis zum Level unverändert, dann das neue Level,
    // dann das Tier-Bit falls nötig, dann der Rest **unverändert**. Der Rest
    // enthält auch die Abschlussbits; sie rücken um eine Stelle, das bleibt
    // gültig (dahinter stehen nur Nullen zur Byte-Grenze).
    let alt = entpacke(rumpf);
    let mut bits = Vec::with_capacity(alt.len() + 1);
    bits.extend_from_slice(&alt[..LEVEL_BIT]);
    schreibe(&mut bits, u32::from(neu), 5);
    if neu >= TIER_AB {
        bits.push(0); // seq_tier[0] = Main
    }
    bits.extend_from_slice(&alt[LEVEL_BIT + 5 + usize::from(form.tier)..]);
    let aus = packe(&bits);

    MELDE.call_once(|| {
        eprintln!(
            "[av1-level] Sequenzkopf berichtigt: seq_level_idx {} -> {neu} fuer {}x{} \
             — `av1_vulkan` gibt zu wenig an, s. `whip/av1_level.rs`",
            form.level, form.breite, form.hoehe
        );
    });
    Some(aus)
}

/// Einmal melden, nicht je Bild. Die Korrektur ist eine Eigenschaft des
/// Stroms, kein Ereignis.
static MELDE: std::sync::Once = std::sync::Once::new();

// ── Bits ─────────────────────────────────────────────────────────────────────
//
// Ein Bit je `u8` ist verschwenderisch und hier genau richtig: die Rümpfe sind
// zwanzig Byte lang und werden je Strom einmal angefasst. Dafür ist das
// Einfügen eines Bits mitten hinein ein `insert` statt einer Schieberei über
// Bytegrenzen — und die ist die Sorte Code, die man nur mit Mühe richtig
// bekommt und dann nie wieder liest.

/// Bytes in Bits, MSB zuerst (so liest AV1).
fn entpacke(daten: &[u8]) -> Vec<u8> {
    (0..daten.len() * 8).map(|b| (daten[b / 8] >> (7 - b % 8)) & 1).collect()
}

/// Bits zurück in Bytes. Ein angefangenes letztes Byte wird mit Nullen gefüllt.
fn packe(bits: &[u8]) -> Vec<u8> {
    let mut aus = vec![0u8; bits.len().div_ceil(8)];
    for (i, b) in bits.iter().enumerate() {
        if *b == 1 {
            aus[i / 8] |= 1 << (7 - i % 8);
        }
    }
    aus
}

/// `n` Bits eines Wertes anhängen, MSB zuerst.
fn schreibe(bits: &mut Vec<u8>, wert: u32, n: usize) {
    bits.extend((0..n).map(|k| ((wert >> (n - 1 - k)) & 1) as u8));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sequenzkopf-OBU bauen, wie `av1_vulkan` ihn liefert.
    ///
    /// Benutzt **dieselben** Bit-Hilfen wie der Produktivpfad. Das ist hier
    /// unbedenklich, weil `kopf_form` unabhängig davon liest und
    /// `rundlauf_der_testvorlage` einen falschen Packer sofort auffliegen
    /// liesse — eine zweite Fassung hätte dagegen ihre eigenen Fehler.
    fn seq_obu(level: u8, breite: u32, hoehe: u32) -> Vec<u8> {
        const MASSBITS: usize = 16;
        let mut bits: Vec<u8> = Vec::new();
        bits.extend([0; 3]); // seq_profile
        bits.push(0); // still_picture
        bits.push(0); // reduced_still_picture_header
        bits.push(0); // timing_info_present_flag
        bits.push(0); // initial_display_delay_present_flag
        bits.extend([0; 5]); // operating_points_cnt_minus_1
        bits.extend([0; 12]); // operating_point_idc[0]
        schreibe(&mut bits, u32::from(level), 5);
        if level >= TIER_AB {
            bits.push(0); // seq_tier[0]
        }
        schreibe(&mut bits, (MASSBITS - 1) as u32, 4); // frame_width_bits_minus_1
        schreibe(&mut bits, (MASSBITS - 1) as u32, 4); // frame_height_bits_minus_1
        schreibe(&mut bits, breite - 1, MASSBITS);
        schreibe(&mut bits, hoehe - 1, MASSBITS);
        bits.push(1); // Abschlussbit
        while bits.len() % 8 != 0 {
            bits.push(0);
        }
        let rumpf = packe(&bits);
        let mut v = vec![(OBU_SEQUENZKOPF << 3) | 0b10];
        crate::whip::av1::schreibe_leb128(&mut v, rumpf.len() as u32);
        v.extend_from_slice(&rumpf);
        v
    }

    fn gelesen(obu: &[u8]) -> Form {
        let o = &crate::whip::av1_entpacken::obus(obu).unwrap()[0];
        kopf_form(&obu[o.rumpf..o.ende]).expect("Form lesbar")
    }

    /// Der Kopf, den wir bauen, ist auch der, den wir lesen — sonst prüfen die
    /// folgenden Tests nur sich selbst.
    #[test]
    fn rundlauf_der_testvorlage() {
        let f = gelesen(&seq_obu(4, 1280, 720));
        assert_eq!((f.level, f.tier, f.breite, f.hoehe), (4, false, 1280, 720));
    }

    /// 720p30 passt nicht in Level 3.0 (665.856 Bildpunkte) und wird auf 3.1
    /// gehoben — ohne Tier-Bit, die Länge bleibt.
    #[test]
    fn siebenhundertzwanzig_wird_auf_3_1_gehoben() {
        let alt = seq_obu(4, 1280, 720);
        let neu = hebe_level_kopie(&alt, 30).unwrap().expect("muss berichtigen");
        let f = gelesen(&neu);
        assert_eq!(f.level, 5, "Level 3.1");
        assert!(!f.tier);
        assert_eq!((f.breite, f.hoehe), (1280, 720), "Masse duerfen sich nicht verschieben");
        assert_eq!(neu.len(), alt.len(), "ohne Tier-Bit bleibt die Laenge");
    }

    /// **1080p braucht Level 4.0, und damit kommt das `seq_tier`-Bit dazu.**
    /// Das verschiebt alles dahinter — genau der Fall, an dem eine Korrektur
    /// an fester Stelle die Bildmaße zerstoert haette.
    #[test]
    fn tausendachtzig_bekommt_das_tier_bit() {
        let alt = seq_obu(4, 1920, 1080);
        let neu = hebe_level_kopie(&alt, 30).unwrap().expect("muss berichtigen");
        let f = gelesen(&neu);
        assert_eq!(f.level, 8, "Level 4.0");
        assert!(f.tier, "ab Level 4.0 verlangt die Spezifikation seq_tier");
        assert_eq!((f.breite, f.hoehe), (1920, 1080), "Masse duerfen sich nicht verschieben");
    }

    /// 1440p sprengt schon die BILDGRÖSSE von 4.0/4.1 (2.359.296 Bildpunkte
    /// gegen 3.686.400) und landet auf 5.0 — nicht auf 4.1, wie die erste
    /// Fassung dieses Tests annahm. Die Stufen begrenzen mehreres zugleich;
    /// wer nur auf die Bildrate schaut, greift daneben.
    #[test]
    fn tausendvierhundertvierzig_landet_auf_5_0() {
        let neu = hebe_level_kopie(&seq_obu(4, 2560, 1440), 60).unwrap().expect("berichtigt");
        assert_eq!(gelesen(&neu).level, 12, "Level 5.0");
    }

    /// Und die Bildrate hebt tatsächlich weiter, bei gleicher Bildgröße:
    /// 1080p sind 2.073.600 Bildpunkte, bei 30 Bildern also 62.208.000 (passt
    /// in 4.0), bei 60 Bildern 124.416.000 — über 4.0 (70.778.880), unter 4.1
    /// (141.557.760).
    #[test]
    fn hohe_bildrate_hebt_weiter() {
        let neu = hebe_level_kopie(&seq_obu(4, 1920, 1080), 60).unwrap().expect("berichtigt");
        assert_eq!(gelesen(&neu).level, 9, "Level 4.1");
    }

    /// Ein bereits ausreichendes Level bleibt unangetastet — sonst würde die
    /// Korrektur einen Strom verschlechtern, der in Ordnung war.
    #[test]
    fn hohes_level_bleibt_stehen() {
        assert!(hebe_level_kopie(&seq_obu(13, 1280, 720), 30).unwrap().is_none());
    }

    /// **4K und darüber.** 3840x2160 sind 8.294.400 Bildpunkte und passen
    /// gerade noch in 5.0 (8.912.896); bei 60 Bildern reisst die Rate und es
    /// wird 5.1. 8K sprengt die Bildgröße aller 5.x-Stufen und landet auf 6.0.
    /// Die Tabelle reicht damit bis 8K60 — was darüber liegt, bleibt
    /// unkorrigiert und das ist besser als eine falsche Angabe.
    #[test]
    fn vier_k_und_acht_k() {
        let level = |b, h, fps| gelesen(&hebe_level_kopie(&seq_obu(4, b, h), fps).unwrap().unwrap()).level;
        assert_eq!(level(3840, 2160, 30), 12, "4K30 -> Level 5.0");
        assert_eq!(level(3840, 2160, 60), 13, "4K60 -> Level 5.1");
        assert_eq!(level(3840, 2160, 120), 14, "4K120 -> Level 5.2");
        assert_eq!(level(7680, 4320, 30), 16, "8K30 -> Level 6.0");
        assert_eq!(level(7680, 4320, 60), 17, "8K60 -> Level 6.1");
    }

    /// Jenseits der Tabelle wird NICHT geraten. Ein zu niedriges Level ist der
    /// Fehler, den diese Datei behebt — ein erfundenes wäre derselbe Fehler
    /// noch einmal.
    #[test]
    fn jenseits_der_tabelle_wird_nichts_behauptet() {
        assert!(kleinstes_level(16000, 9000, 60).is_none());
        assert!(hebe_level_kopie(&seq_obu(4, 16000, 9000), 60).unwrap().is_none());
    }

    /// Ohne Sequenzkopf wird nicht kopiert. Das ist der Regelfall: bei
    /// Intra-Refresh trägt genau ein Bild im ganzen Strom einen.
    #[test]
    fn ohne_sequenzkopf_keine_kopie() {
        let td = vec![(2u8 << 3) | 0b10, 0];
        assert!(hebe_level_kopie(&td, 30).unwrap().is_none());
    }

    /// Andere OBUs bleiben Byte für Byte erhalten.
    #[test]
    fn andere_obus_bleiben_unberuehrt() {
        let mut d = vec![(2u8 << 3) | 0b10, 0]; // Zeittrenner
        let vorher = d.clone();
        d.extend_from_slice(&seq_obu(4, 1280, 720));
        let schwanz = vec![(6u8 << 3) | 0b10, 3, 0xAA, 0xBB, 0xCC]; // Bild-OBU
        d.extend_from_slice(&schwanz);
        let neu = hebe_level_kopie(&d, 30).unwrap().expect("berichtigt");
        assert_eq!(&neu[..2], &vorher[..]);
        assert_eq!(&neu[neu.len() - schwanz.len()..], &schwanz[..]);
    }

    /// Ein Rumpf, dessen Form nicht passt, wird nicht angefasst — lieber gar
    /// keine Korrektur als eine an der falschen Stelle.
    #[test]
    fn unerwartete_form_bleibt_unberuehrt() {
        let mut d = seq_obu(4, 1280, 720);
        d[2] |= 1 << 3; // reduced_still_picture_header setzen
        assert!(hebe_level_kopie(&d, 30).unwrap().is_none());
    }
}
