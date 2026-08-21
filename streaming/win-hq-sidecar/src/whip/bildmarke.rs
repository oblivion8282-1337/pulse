//! Die Bildmarke: eine laufende Bildnummer im Strom, statt einer gedeuteten Uhr.
//!
//! ## Warum es das gibt
//!
//! Der RTP-Zeitstempel ist eine UHR. Er sagt, wann ein Bild aufgenommen wurde,
//! nicht das wievielte es ist. Eine Luecke in einer Uhr bedeutet zweierlei, und
//! die beiden sind an ihr nicht zu unterscheiden:
//!
//! ```text
//! Sender liess einen Bildplatz aus:  1500 3000 ---- 6000   Nummern 41 42 -- 43
//! ein Bild ging verloren:            1500 3000 ---- 6000   Nummern 41 42 43 44
//! ```
//!
//! Die Zeitstempel-Zeilen sind identisch, die Nummern-Zeilen nicht. Am
//! 2026-08-21 hat der Player deshalb ein halbes Vollbild je Sekunde
//! angefordert, obwohl nichts fehlte: neun Meldungen in achtzehn Sekunden bei
//! null verworfenen Einheiten und null unreparierbaren Paketen. Volle
//! Herleitung in `docs/superpowers/specs/2026-08-21-dependency-descriptor-design.md`.
//!
//! ## Was hier steht
//!
//! Der „Dependency Descriptor" aus Anhang A.8 der AV1-RTP-Spezifikation, in
//! der kleinsten Auspraegung, die fuer einen ungeschichteten Strom gueltig ist:
//! zwei Schablonen (Vollbild, Differenzbild), ein Decode-Ziel, eine Kette.
//!
//! **Diese Datei ist ein Zwilling** — wortgleich in beiden Sidecars und im
//! Player. Die Wortgleichheit haelt `streaming/pulse-player/tests/zwillinge.rs`
//! fest, nicht dieser Kommentar. Beim aelteren Paar `zeitbasis.rs` lagen am
//! 2026-08-17 drei Kommentarzeilen unbemerkt auseinander, weil dort nur ein
//! Kommentar stand.
//!
//! **Der Schreiber ist vollstaendig, der Leser nicht.** Zum Urteilen genuegen
//! die drei Pflichtbyte; die Schablonen-Tabelle wird geschrieben, weil das
//! Format sie verlangt und libwebrtc sie auswertet, aber von uns nie gelesen.
//!
//! ## Wo die Nummer entsteht
//!
//! Im Paketierer, also HINTER dem Encoder. Verschluckt der Encoder ein Bild,
//! entsteht kein Paket und keine Nummer wird verbraucht — die Folge bleibt
//! lueckenlos, und das ist richtig: es gibt nichts zu reparieren. Genau das
//! trennt „nie erzeugt" von „verloren", und genau das kann eine Uhr nicht.

/// Der URI, unter dem die Erweiterung im SDP ausgehandelt wird.
pub const EXTMAP_URI: &str =
    "https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension";

/// Schablone 0: Vollbild. Beruft sich auf nichts, beginnt die Kette.
const SCHABLONE_VOLLBILD: u8 = 0;
/// Schablone 1: Differenzbild. Beruft sich auf das vorige Bild.
const SCHABLONE_DIFFERENZ: u8 = 1;

/// Laenge der Pflichtfelder. Ein Descriptor dieser Laenge hat per
/// Spezifikation KEINE erweiterten Felder — `sz > 3` entscheidet das, nicht
/// ein Kennzeichen im Inhalt.
pub const PFLICHT_BYTE: usize = 3;
/// Laenge mit angehaengter Schablonen-Tabelle: 24 Pflicht- und 41 Struktur-Bit,
/// auf 72 Bit aufgefuellt.
pub const MIT_TABELLE_BYTE: usize = 9;

/// Was an einem Paket steht.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bildmarke {
    /// Erstes Paket dieses Bildes.
    pub anfang: bool,
    /// Letztes Paket dieses Bildes.
    pub ende: bool,
    /// Vollbild — bestimmt die Schablone UND ob die Tabelle mitgeschrieben
    /// wird.
    pub vollbild: bool,
    /// Laufende Nummer des Bildes. Laeuft bei 65536 um, bei 60 Bildern je
    /// Sekunde also nach gut achtzehn Minuten.
    pub nummer: u16,
}

/// Schreibt Bits von hoher zu niedriger Ordnung, wie `f(n)` der
/// Spezifikation.
#[derive(Default)]
struct BitSchreiber {
    aus: Vec<u8>,
    /// Wie viele Bit im letzten Byte noch FREI sind (0 bis 8).
    frei: u8,
}

impl BitSchreiber {
    fn f(&mut self, breite: u8, wert: u32) {
        for i in (0..breite).rev() {
            if self.frei == 0 {
                self.aus.push(0);
                self.frei = 8;
            }
            self.frei -= 1;
            let bit = ((wert >> i) & 1) as u8;
            let letzter = self.aus.len() - 1;
            self.aus[letzter] |= bit << self.frei;
        }
    }

    /// Das Ergebnis; angebrochene Byte sind mit Nullen aufgefuellt, weil sie
    /// als Null angelegt und nur mit Einsen beschrieben werden.
    fn abschliessen(self) -> Vec<u8> {
        self.aus
    }
}

/// Die Marke als Bytefolge.
///
/// Bei `vollbild` haengt die Schablonen-Tabelle an — auf JEDEM Paket des
/// Vollbilds, nicht nur auf dem ersten. Grund: MediaMTX schneidet die Pakete
/// neu; laege die Tabelle nur auf dem ersten, muesste der Fork erkennen,
/// welches neue Paket das erste ist, und sie dorthin verschieben. Das waere
/// Logik, die falsch sein kann. So kopiert er die Bytes und korrigiert zwei
/// Bit. Kostet rund 540 Byte je Vollbild und liefert einem spaet
/// einsteigenden Zuschauer die Tabelle mit dem ersten Paket, das er sieht.
pub fn schreiben(m: &Bildmarke) -> Vec<u8> {
    let mut b = BitSchreiber::default();
    let schablone = if m.vollbild { SCHABLONE_VOLLBILD } else { SCHABLONE_DIFFERENZ };
    b.f(1, u32::from(m.anfang));
    b.f(1, u32::from(m.ende));
    b.f(6, u32::from(schablone));
    b.f(16, u32::from(m.nummer));
    if !m.vollbild {
        return b.abschliessen();
    }
    // Erweiterte Felder: nur die Tabelle, sonst nichts.
    b.f(1, 1); // template_dependency_structure_present_flag
    b.f(1, 0); // active_decode_targets_present_flag
    b.f(1, 0); // custom_dtis_flag
    b.f(1, 0); // custom_fdiffs_flag
    b.f(1, 0); // custom_chains_flag
    b.f(6, 0); // template_id_offset
    b.f(5, 0); // dt_cnt_minus_one — ein Decode-Ziel
    // template_layers(): zwei Schablonen in derselben Schicht, dann Schluss.
    b.f(2, 0); // next_layer_idc nach T0: gleiche Schicht
    b.f(2, 3); // next_layer_idc nach T1: Ende
    // template_dtis(): T0 ist ein Einstiegspunkt (switch), T1 erforderlich.
    b.f(2, 2);
    b.f(2, 3);
    // template_fdiffs(): T0 beruft sich auf nichts, T1 auf das vorige Bild.
    b.f(1, 0); // T0: kein fdiff folgt
    b.f(1, 1); // T1: ein fdiff folgt
    b.f(4, 0); // fdiff_minus_one = 0, also fdiff = 1
    b.f(1, 0); // T1: kein weiterer
    // template_chains(): eine Kette.
    //
    // `chain_cnt` ist `ns(DtCnt + 1)` = `ns(2)`, und `write_ns(2, 1)` schreibt
    // genau EIN Bit — nicht zwei. Und `decode_target_protected_by[0]` ist
    // `ns(chain_cnt)` = `ns(1)`, das schreibt GAR KEINES. Beides war beim
    // Nachrechnen zuerst falsch.
    b.f(1, 1);
    b.f(4, 0); // template_chain_fdiff[T0][0] — Vollbild beginnt die Kette
    b.f(4, 1); // template_chain_fdiff[T1][0] — ein Bild zurueck
    b.f(1, 0); // resolutions_present_flag
    b.abschliessen()
}

/// Nur die Bildnummer — mehr braucht das Urteil nicht.
///
/// Bewusst ohne die Tabelle: sie wird geschrieben, weil das Format sie
/// verlangt und libwebrtc sie braucht, aber die Nummer steht in den
/// Pflichtfeldern und ist ohne jede Vorkenntnis lesbar. Ein Zuschauer, der
/// zwischen zwei Vollbildern einsteigt, kann deshalb sofort zaehlen, statt auf
/// das naechste Vollbild zu warten.
pub fn nummer_lesen(daten: &[u8]) -> Option<u16> {
    if daten.len() < PFLICHT_BYTE {
        return None;
    }
    Some(u16::from(daten[1]) << 8 | u16::from(daten[2]))
}

/// Die ganze Marke, soweit sie ohne die Tabelle bestimmbar ist.
///
/// `vollbild` wird an der Schablonen-Nummer erkannt, nicht an der Laenge: ein
/// Sender darf die Tabelle auch weglassen, die Schablone bleibt dieselbe.
pub fn marke_lesen(daten: &[u8]) -> Option<Bildmarke> {
    if daten.len() < PFLICHT_BYTE {
        return None;
    }
    Some(Bildmarke {
        anfang: daten[0] & 0b1000_0000 != 0,
        ende: daten[0] & 0b0100_0000 != 0,
        vollbild: daten[0] & 0b0011_1111 == SCHABLONE_VOLLBILD,
        nummer: u16::from(daten[1]) << 8 | u16::from(daten[2]),
    })
}

/// Bildanfang und Bildende neu setzen, ohne den Rest anzufassen.
///
/// Fuer jeden, der die Pakete neu schneidet — allen voran MediaMTX. Die
/// uebrigen Felder beschreiben das BILD und bleiben, diese zwei beschreiben
/// das PAKET und muessen mitwandern.
pub fn anfang_ende_setzen(daten: &mut [u8], anfang: bool, ende: bool) {
    if daten.is_empty() {
        return;
    }
    daten[0] = (daten[0] & 0b0011_1111) | (u8::from(anfang) << 7) | (u8::from(ende) << 6);
}

/// Zaehlt die Bildnummern und meldet Luecken.
#[derive(Default)]
pub struct Bildzaehler {
    letzte: Option<u16>,
}

impl Bildzaehler {
    pub fn neu() -> Self {
        Self::default()
    }

    /// Rueckgabe: wie viele Bilder fehlen, oder `None`, wenn nichts fehlt.
    ///
    /// **Rueckwaerts heisst Umordnung, nicht Ausfall.** Nach dem Jitter-Puffer
    /// sollte das nicht vorkommen; kommt es doch, darf der Zaehler NICHT
    /// zurueckgestellt werden, sonst meldet das naechste regulaere Bild eine
    /// erfundene Luecke. Dasselbe gilt fuer eine Wiederholung.
    ///
    /// Der Umlauf bei 65536 braucht keinen Sonderfall: `wrapping_sub` macht
    /// aus 65535 nach 0 einen Schritt von eins.
    pub fn pruefen(&mut self, nummer: u16) -> Option<u16> {
        let Some(vorher) = self.letzte else {
            self.letzte = Some(nummer);
            return None;
        };
        let schritt = nummer.wrapping_sub(vorher);
        if schritt == 0 || schritt >= 0x8000 {
            return None;
        }
        self.letzte = Some(nummer);
        (schritt > 1).then(|| schritt - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **Der Prueffall, der das Format festnagelt.** Von Hand aus Anhang A.8.2
    /// der Spezifikation ausgerechnet, nicht aus dem Schreiber abgelesen —
    /// sonst prueft er nur, dass der Schreiber tut, was er tut.
    ///
    /// Herleitung der sechs Struktur-Byte: `10000` `000000` `00000` `00` `11`
    /// `10` `11` `0` `1` `0000` `0` `1` `0000` `0001` `0`, dann sieben Nullen.
    #[test]
    fn vollbild_mit_tabelle_hat_die_ausgerechnete_bytefolge() {
        let m = Bildmarke { anfang: true, ende: true, vollbild: true, nummer: 0 };
        assert_eq!(
            schreiben(&m),
            vec![0xC0, 0x00, 0x00, 0x80, 0x00, 0x3B, 0x41, 0x01, 0x00],
            "Pflichtfelder C0 00 00, dann 41 Struktur-Bit auf sechs Byte aufgefuellt"
        );
    }

    #[test]
    fn differenzbild_ist_drei_byte() {
        let m = Bildmarke { anfang: true, ende: false, vollbild: false, nummer: 0x1234 };
        assert_eq!(schreiben(&m), vec![0x81, 0x12, 0x34]);

        let m = Bildmarke { anfang: false, ende: true, vollbild: false, nummer: 1 };
        assert_eq!(schreiben(&m), vec![0x41, 0x00, 0x01]);

        let m = Bildmarke { anfang: true, ende: true, vollbild: false, nummer: u16::MAX };
        assert_eq!(schreiben(&m), vec![0xC1, 0xFF, 0xFF]);
    }

    #[test]
    fn laengen_stimmen_mit_den_konstanten() {
        let d = Bildmarke { anfang: true, ende: true, vollbild: false, nummer: 7 };
        assert_eq!(schreiben(&d).len(), PFLICHT_BYTE);
        let v = Bildmarke { vollbild: true, ..d };
        assert_eq!(schreiben(&v).len(), MIT_TABELLE_BYTE);
    }

    #[test]
    fn rundlauf_ueber_alle_kombinationen() {
        for vollbild in [false, true] {
            for anfang in [false, true] {
                for ende in [false, true] {
                    for nummer in [0u16, 1, 0x1234, u16::MAX] {
                        let m = Bildmarke { anfang, ende, vollbild, nummer };
                        let roh = schreiben(&m);
                        assert_eq!(marke_lesen(&roh), Some(m), "Rundlauf {m:?}");
                        assert_eq!(nummer_lesen(&roh), Some(nummer));
                    }
                }
            }
        }
    }

    /// Zu kurz ist kein Descriptor. Ohne diese Pruefung liest `nummer_lesen`
    /// ueber das Ende hinaus und der Player urteilt auf Zufallszahlen.
    #[test]
    fn zu_kurz_ergibt_nichts() {
        assert_eq!(nummer_lesen(&[]), None);
        assert_eq!(nummer_lesen(&[0xC0, 0x00]), None);
        assert_eq!(marke_lesen(&[0xC0, 0x00]), None);
    }

    /// Anfang und Ende sind PAKET-Eigenschaften und muessen sich aendern
    /// lassen, ohne Nummer oder Schablone zu beruehren — genau das tut
    /// MediaMTX beim Neuschneiden.
    #[test]
    fn anfang_ende_setzen_laesst_den_rest_in_ruhe() {
        let m = Bildmarke { anfang: true, ende: true, vollbild: true, nummer: 4711 };
        let mut roh = schreiben(&m);
        anfang_ende_setzen(&mut roh, false, false);
        let gelesen = marke_lesen(&roh).expect("lesbar");
        assert!(!gelesen.anfang && !gelesen.ende);
        assert_eq!(gelesen.nummer, 4711, "die Nummer bleibt");
        assert!(gelesen.vollbild, "die Schablone bleibt");
        assert_eq!(roh.len(), MIT_TABELLE_BYTE, "die Tabelle bleibt");
    }

    #[test]
    fn zaehler_meldet_nur_echte_luecken() {
        let mut z = Bildzaehler::neu();
        assert_eq!(z.pruefen(41), None, "das erste Bild ist nie eine Luecke");
        assert_eq!(z.pruefen(42), None, "lueckenlos");
        assert_eq!(z.pruefen(44), Some(1), "die 43 fehlt");
        assert_eq!(z.pruefen(45), None);
    }

    /// **Der Fall, um dessentwillen es das Ganze gibt.** Der Sender laesst
    /// einen Bildplatz aus: die Zeit springt, die Nummer nicht.
    #[test]
    fn ausgelassener_bildplatz_ist_keine_luecke() {
        let mut z = Bildzaehler::neu();
        z.pruefen(7);
        assert_eq!(z.pruefen(8), None);
    }

    #[test]
    fn umlauf_ist_ein_normaler_schritt() {
        let mut z = Bildzaehler::neu();
        z.pruefen(u16::MAX - 1);
        assert_eq!(z.pruefen(u16::MAX), None);
        assert_eq!(z.pruefen(0), None, "65535 auf 0 ist ein Schritt");
        assert_eq!(z.pruefen(1), None);
    }

    /// Eine Wiederholung und eine Umordnung duerfen weder melden noch den
    /// Zaehler zurueckstellen — sonst meldete das naechste regulaere Bild eine
    /// Luecke, die es nicht gibt.
    #[test]
    fn wiederholung_und_umordnung_stellen_nichts_zurueck() {
        let mut z = Bildzaehler::neu();
        z.pruefen(100);
        assert_eq!(z.pruefen(100), None, "Wiederholung");
        assert_eq!(z.pruefen(99), None, "Umordnung");
        assert_eq!(z.pruefen(101), None, "der Zaehler steht noch auf 100");
    }

    /// **Der Pruefstein.** Er kommt vom Sender und wird von Player und
    /// MediaMTX-Patch gegengeprueft (Muster `streaming/zeigerbild-formen.json`).
    ///
    /// Warum vom Sender: am 2026-08-17 rutschte ein Formatfehler durch beide
    /// Testnetze, weil jede Seite ihre Faelle aus derselben Vorstellung
    /// aufschrieb, aus der sie die Pruefung schrieb. Wer eine Pruefung testet,
    /// denkt sich die Faelle nicht aus, die er beim Schreiben uebersehen hat.
    ///
    /// Absichtliche Formataenderung: `PULSE_PRUEFSTEIN_SCHREIBEN=1` setzen.
    /// Ohne die Variable schreibt der Test NIE — sonst bestaetigte er jede
    /// Aenderung von selbst.
    #[test]
    fn bildmarke_pruefstein() {
        let faelle = [
            ("vollbild-einziges-paket", true, true, true, 0u16),
            ("vollbild-mittleres-paket", false, false, true, u16::MAX),
            ("differenz-erstes-paket", true, false, false, 4660),
            ("differenz-letztes-paket", false, true, false, 1),
            ("differenz-umlauf", true, true, false, u16::MAX),
        ];
        let mut zeilen = Vec::new();
        for (name, anfang, ende, vollbild, nummer) in faelle {
            let roh = schreiben(&Bildmarke { anfang, ende, vollbild, nummer });
            let hex: String = roh.iter().map(|b| format!("{b:02X}")).collect();
            zeilen.push(format!(
                "    {{ \"name\": \"{name}\", \"anfang\": {anfang}, \"ende\": {ende}, \
                 \"vollbild\": {vollbild}, \"nummer\": {nummer}, \"bytes\": \"{hex}\" }}"
            ));
        }
        let inhalt = format!(
            "{{\n  \"_kommentar\": \"Pruefstein fuer die Bildmarke (Dependency \
             Descriptor). ERZEUGT VOM SENDER durch den Test `bildmarke_pruefstein` \
             in whip/bildmarke.rs. Player und MediaMTX-Patch pruefen dagegen. Neu \
             schreiben: PULSE_PRUEFSTEIN_SCHREIBEN=1 cargo test bildmarke_pruefstein\",\
             \n  \"formen\": [\n{}\n  ]\n}}\n",
            zeilen.join(",\n")
        );
        let pfad = concat!(env!("CARGO_MANIFEST_DIR"), "/../bildmarke-formen.json");
        if std::env::var("PULSE_PRUEFSTEIN_SCHREIBEN").as_deref() == Ok("1") {
            std::fs::write(pfad, &inhalt).expect("Pruefstein schreiben");
            return;
        }
        let vorhanden = std::fs::read_to_string(pfad).expect("Pruefstein lesen");
        assert_eq!(
            vorhanden, inhalt,
            "Der Pruefstein weicht ab. Absichtlich? \
             PULSE_PRUEFSTEIN_SCHREIBEN=1 cargo test bildmarke_pruefstein"
        );
    }
}
