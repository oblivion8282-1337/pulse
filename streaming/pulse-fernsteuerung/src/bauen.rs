//! Das Frame-Format der Fernsteuerung — Byte fuer Byte.
//!
//! Verbindlich ist `docs/plans/2026-08-12-input-wire-protokoll-v2.md`. Alles
//! hier ist **rein**: Bytes bauen, Anteile normieren, Base64 kodieren. Wer die
//! Ereignisse einsammelt, steht beim Sender (`fernsteuerung/mod.rs` im
//! `pulse-player`); wer sie parst, steht nebenan in [`crate::rahmen`]; wer sie
//! einspielt, im Sidecar der jeweiligen Plattform.
//!
//! Little-endian, Byte 0 = Opcode, feste Laengen:
//!
//! | Opcode | Name | Aufbau | Laenge |
//! |---|---|---|---|
//! | `0x00` | Hello | `[0x00][u8 version]` | 2 B |
//! | `0x01` | MouseMoveAbs | `[0x01][u16 x][u16 y]` | 5 B |
//! | `0x02` | MouseMoveRel | `[0x02][i16 dx][i16 dy]` | 5 B |
//! | `0x03` | MouseButton | `[0x03][u8 btn][u8 down]` | 3 B |
//! | `0x04` | MouseWheel | `[0x04][i16 dv][i16 dh]` | 5 B |
//! | `0x05` | Key | `[0x05][u16 scan][u8 down]` | 4 B |
//!
//! **Der Host ist fail-closed**: unbekannter Opcode, falsche Laenge oder ein
//! unbekannter Knopf beenden die Sitzung. Deshalb wird hier nie geraten —
//! was sich nicht sauber abbilden laesst, wird gar nicht erst gesendet.

use crate::format::*;

/// Ein fertiger Frame. `Copy` und ohne Heap: bei bis zu 900 Mausabtastungen je
/// Sekunde waere eine `Vec` je Ereignis eine Zuteilung je Ereignis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rahmen {
    bytes: [u8; 5],
    len: u8,
}

impl Rahmen {
    fn neu(bytes: [u8; 5], len: u8) -> Self {
        Self { bytes, len }
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.bytes[..self.len as usize]
    }

    pub fn opcode(&self) -> u8 {
        self.bytes[0]
    }

    /// Darf dieser Frame unter Last verworfen werden?
    ///
    /// **Nur Bewegungen.** Eine verschluckte Bewegung ist nichts, ein
    /// verschlucktes Key-Up ist eine klemmende Taste — das ist der Grund, warum
    /// diese Frage am Opcode haengt und nicht an einem zweiten Feld, das beim
    /// Einreihen vergessen werden koennte.
    pub fn ist_bewegung(&self) -> bool {
        matches!(self.opcode(), OP_MAUS_ABS | OP_MAUS_REL)
    }

    /// Braucht dieser Frame eine Positionierung VOR sich?
    ///
    /// Knopf und Rad tragen **keine eigene Koordinate**: der Host wendet sie
    /// dort an, wo sein Zeiger gerade steht. Faellt die Bewegung weg, die
    /// unmittelbar vor ihnen stand, klickt der ferne Rechner an einer
    /// beliebigen Stelle — beim Ziehen und Ablegen auch noch an einer anderen
    /// als beim Druecken. Deshalb SCHUETZEN diese Frames ihre Positionierung
    /// gegen die Flutkontrolle (s. `fernsteuerung::schlange` im Player); die
    /// Invariante lautet:
    /// entweder gehen Positionierung und Anhaengsel gemeinsam hinaus, oder
    /// keines von beiden.
    ///
    /// Tasten stehen bewusst nicht in dieser Liste — ein Scancode trifft die
    /// Tastatur, nicht den Zeiger.
    pub fn braucht_position(&self) -> bool {
        matches!(self.opcode(), OP_MAUS_KNOPF | OP_MAUS_RAD)
    }

    /// Die beiden i16-Werte einer relativen Bewegung. Nur fuer das Aufsummieren
    /// beim Zusammenfassen (s. `fernsteuerung::Erfassung` im Player).
    pub fn rel_werte(&self) -> Option<(i16, i16)> {
        if self.opcode() != OP_MAUS_REL {
            return None;
        }
        Some((
            i16::from_le_bytes([self.bytes[1], self.bytes[2]]),
            i16::from_le_bytes([self.bytes[3], self.bytes[4]]),
        ))
    }
}

/// `0x00` — MUSS der erste Frame einer Sitzung sein.
pub fn hello() -> Rahmen {
    Rahmen::neu([OP_HELLO, PROTOKOLL_VERSION, 0, 0, 0], 2)
}

/// `0x01` — Anteile 0..65535, bezogen auf das Videobild des gemeinten Slots.
pub fn maus_abs(x: u16, y: u16) -> Rahmen {
    let [x0, x1] = x.to_le_bytes();
    let [y0, y1] = y.to_le_bytes();
    Rahmen::neu([OP_MAUS_ABS, x0, x1, y0, y1], 5)
}

/// `0x02` — Pixel-Differenz bei gefangenem Zeiger (+x rechts, +y runter).
pub fn maus_rel(dx: i16, dy: i16) -> Rahmen {
    let [x0, x1] = dx.to_le_bytes();
    let [y0, y1] = dy.to_le_bytes();
    Rahmen::neu([OP_MAUS_REL, x0, x1, y0, y1], 5)
}

/// `0x03`
pub fn maus_knopf(knopf: Knopf, runter: bool) -> Rahmen {
    Rahmen::neu([OP_MAUS_KNOPF, knopf as u8, u8::from(runter), 0, 0], 3)
}

/// `0x04` — Windows-Rastschritte, `dv > 0` = vom Nutzer weg.
pub fn maus_rad(dv: i16, dh: i16) -> Rahmen {
    let [v0, v1] = dv.to_le_bytes();
    let [h0, h1] = dh.to_le_bytes();
    Rahmen::neu([OP_MAUS_RAD, v0, v1, h0, h1], 5)
}

/// `0x05` — Scancode Satz 1, erweiterte Tasten als `0xE0xx`.
pub fn taste(scan: u16, runter: bool) -> Rahmen {
    let [s0, s1] = scan.to_le_bytes();
    Rahmen::neu([OP_TASTE, s0, s1, u8::from(runter), 0], 4)
}

/// Anteil 0..1 auf die 65536 Stufen der Leitung bringen.
///
/// **Anteile, nicht Pixel** — die Begruendung steht in der Wire-Spec: Pixelwerte
/// verlangten, dass beide Seiten die Geometrie des Hosts kennen und einig sind,
/// und jede Verzoegerung dabei setzt Klicks an die falsche Stelle.
///
/// Geklemmt statt umgebrochen: ein Anteil knapp ueber 1,0 (Rundung an der
/// rechten Kante) darf nicht als 0 auf der linken Seite ankommen.
pub fn anteil_zu_u16(anteil: f64) -> u16 {
    if !anteil.is_finite() {
        return 0;
    }
    (anteil.clamp(0.0, 1.0) * 65535.0).round() as u16
}

/// Rastschritte aus Radbewegungen — **mit Rest ueber Ereignisse hinweg**.
///
/// **Hier stand bis zum 2026-08-12 eine reine Funktion, die jede Teilbewegung
/// auf mindestens eine ganze Raste aufrundete.** Die Absicht war richtig (ein
/// Streichen darf nicht wirkungslos bleiben), die Rechnung nicht: ein
/// Windows-Praezisions-Touchpad liefert `LineDelta` in Schritten von rund 0,33,
/// aus denen so je 120 wurden — **dreifache Scrollgeschwindigkeit** beim Host.
/// Unter Wayland (`PixelDelta`, rund 100 Ereignisse je Sekunde) noch weit mehr.
///
/// Deshalb wird der Bruchteil jetzt aufgehoben und beim naechsten Ereignis
/// mitgezaehlt: drei Schritte zu 0,33 ergeben zusammen eine Raste statt drei,
/// und die Summe ueber eine Geste stimmt. Ein einzelner winziger Stups bewirkt
/// dafuer nichts mehr — das ist der Preis und der richtige: das Rad dreht sich
/// dann eben erst beim naechsten.
///
/// Je Achse ein eigener Rest: senkrecht und waagerecht sind unabhaengige
/// Gesten, und ein gemeinsamer Rest liesse eine waagerechte Bewegung eine
/// senkrechte ausloesen.
#[derive(Debug, Default, Clone, Copy)]
pub struct Rastensammler {
    rest_v: f64,
    rest_h: f64,
}

impl Rastensammler {
    /// `zeilen` sind winit-Zeilen oder aus Pixeln abgeleitete Zeilen, bereits in
    /// Windows-Vorzeichen. Das Ergebnis ist ein Vielfaches von [`RASTE`].
    pub fn schritte(&mut self, senkrecht: f64, waagerecht: f64) -> (i16, i16) {
        (Self::achse(&mut self.rest_v, senkrecht), Self::achse(&mut self.rest_h, waagerecht))
    }

    /// Rest verwerfen — beim Beginn eines neuen Eingabestroms. Was von der
    /// vorigen Geste liegenblieb, gehoert nicht in die naechste.
    pub fn zuruecksetzen(&mut self) {
        *self = Self::default();
    }

    fn achse(rest: &mut f64, zeilen: f64) -> i16 {
        if !zeilen.is_finite() || !rest.is_finite() {
            *rest = 0.0;
            return 0;
        }
        *rest += zeilen;
        // Hoechstens so viele Rasten, wie in ein `i16` passen (273·120 = 32760).
        let grenze = f64::from(i16::MAX / RASTE as i16);
        let ganze = rest.trunc().clamp(-grenze, grenze);
        *rest -= ganze;
        // Was die Klemmung abgeschnitten hat, wird verworfen statt aufgehoben:
        // sonst rollte das Rad nach einem Ausreisser noch sekundenlang nach.
        // Regulaer liegt der Rest immer unter einer ganzen Raste.
        if rest.abs() >= 1.0 {
            *rest = 0.0;
        }
        (ganze * f64::from(RASTE)) as i16
    }
}

/// Ganze Bildpunkte aus einer Bruchteil-Bewegung — der Rest bleibt liegen und
/// zaehlt beim naechsten Ereignis mit.
///
/// Dieselbe Idee wie beim [`Rastensammler`] und aus demselben Grund: Wayland
/// liefert ueber `relative_pointer` beschleunigte Bruchteile, und jedes
/// Ereignis fuer sich gerundet ergab bei langsamem Zielen null — der Zeiger
/// beim Host bewegte sich gar nicht.
///
/// Abgeschnitten statt gerundet (`trunc`): so ist der Rest immer kleiner als
/// ein Punkt und traegt nie ein Vorzeichen gegen die Bewegungsrichtung.
pub fn ganze_punkte(rest: &mut f64, wert: f64) -> i16 {
    if !wert.is_finite() || !rest.is_finite() {
        *rest = 0.0;
        return 0;
    }
    *rest += wert;
    let ganz = rest.trunc().clamp(f64::from(i16::MIN), f64::from(i16::MAX));
    *rest -= ganz;
    // Nur, wenn die Klemmung oben zugeschlagen hat: der Ueberschuss wird
    // verworfen statt aufgehoben, sonst liefe der Zeiger danach nach.
    if rest.abs() >= 1.0 {
        *rest = 0.0;
    }
    ganz as i16
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Base64 mit Auffuellzeichen, wie es die Huelle auf der Leitung verlangt.
///
/// **Selbst geschrieben statt als Abhaengigkeit**: fuenfundzwanzig Zeilen gegen
/// eine weitere Kiste im Lizenz- und Pflegehaushalt, und die laengste Eingabe
/// hier ist fuenf Byte lang.
pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for block in bytes.chunks(3) {
        let b = [block[0], *block.get(1).unwrap_or(&0), *block.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let zeichen = |verschiebung: u32| B64[((n >> verschiebung) & 0x3f) as usize] as char;
        out.push(zeichen(18));
        out.push(zeichen(12));
        out.push(if block.len() > 1 { zeichen(6) } else { '=' });
        out.push(if block.len() > 2 { zeichen(0) } else { '=' });
    }
    out
}

/// Die Gegenrichtung zu [`base64`] — gebraucht fuer das **Zeigerbild** des
/// Hosts (`app/zeigerbau.rs`), das als einziges etwas Binaeres in DIESE Richtung
/// schickt.
///
/// **Streng, nicht grosszuegig**, gleichlautend mit dem Sidecar
/// (`remote_input/base64.rs::dekodiere`): nur das Standard-Alphabet, kein
/// URL-safe, keine Leerzeichen, keine Zeilenumbrueche, und die Fuellung ist
/// Pflicht. Der einzige Sender fuellt ohnehin auf; wer hier nachsichtig waere,
/// naehme Woerter an, die keine Gegenstelle je erzeugt.
///
/// Fehler ohne Text: der Aufrufer faellt auf den Namen des Zeigers zurueck und
/// hat mit einer Begruendung nichts anzufangen — sie kaeme im Takt der
/// Auffrischung immer wieder.
pub fn base64_zurueck(wort: &str) -> Result<Vec<u8>, ()> {
    let roh = wort.as_bytes();
    if roh.len() % 4 != 0 {
        return Err(());
    }
    let kern = roh.strip_suffix(b"==").or_else(|| roh.strip_suffix(b"=")).unwrap_or(roh);
    if kern.contains(&b'=') {
        return Err(());
    }
    let mut aus = Vec::with_capacity(kern.len() * 3 / 4);
    let mut sammler: u32 = 0;
    let mut bits: u32 = 0;
    for &z in kern {
        let wert = match z {
            b'A'..=b'Z' => z - b'A',
            b'a'..=b'z' => z - b'a' + 26,
            b'0'..=b'9' => z - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(()),
        };
        sammler = (sammler << 6) | u32::from(wert);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            aus.push((sammler >> bits) as u8);
        }
    }
    Ok(aus)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der Dekodierer gegen bekannte Woerter — dieselben, an denen der
    /// Kodierer im Sidecar haengt (`remote_input/base64.rs`).
    #[test]
    fn base64_zurueck_liest_bekannte_woerter() {
        assert_eq!(base64_zurueck("AAI="), Ok(vec![0x00, 0x02]));
        assert_eq!(base64_zurueck("AwAB"), Ok(vec![0x03, 0x00, 0x01]));
        assert_eq!(base64_zurueck("/w=="), Ok(vec![0xFF]));
        assert_eq!(base64_zurueck("+w=="), Ok(vec![0xFB]));
        assert_eq!(base64_zurueck(""), Ok(vec![]));
    }

    /// **Die eigentliche Zusage:** kodieren und zurueck ergibt dasselbe, ueber
    /// alle drei Restlaengen — die Fuellung ist genau dort die Fehlerquelle.
    #[test]
    fn base64_hin_und_zurueck_ergibt_dasselbe() {
        for laenge in 0..40usize {
            let bytes: Vec<u8> = (0..laenge).map(|i| (i * 37 % 256) as u8).collect();
            assert_eq!(base64_zurueck(&base64(&bytes)), Ok(bytes), "Laenge {laenge}");
        }
    }

    /// Fremdmaterial wird abgewiesen: fehlende Fuellung, Fuellung mitten im
    /// Wort, URL-safe-Zeichen, Leerraum.
    #[test]
    fn base64_zurueck_weist_fremdes_ab() {
        for wort in ["AAA", "A===", "A=AA", "-w==", "_w==", "AA I", "AA\nI", "A"] {
            assert!(base64_zurueck(wort).is_err(), "{wort:?}");
        }
    }

    #[test]
    fn hello_traegt_version_zwei() {
        assert_eq!(hello().as_slice(), &[0x00, 0x02]);
    }

    #[test]
    fn maus_abs_ist_fuenf_byte_little_endian() {
        // 0x1234 -> [0x34, 0x12]
        assert_eq!(maus_abs(0x1234, 0xabcd).as_slice(), &[0x01, 0x34, 0x12, 0xcd, 0xab]);
    }

    #[test]
    fn maus_rel_traegt_vorzeichen() {
        let r = maus_rel(-2, 3);
        assert_eq!(r.as_slice(), &[0x02, 0xfe, 0xff, 0x03, 0x00]);
        assert_eq!(r.rel_werte(), Some((-2, 3)));
    }

    #[test]
    fn knopf_nummern_sind_die_der_leitung() {
        // NICHT die winit-Reihenfolge — ein unbekannter Knopf beendet beim
        // Host die Sitzung, also muss diese Zuordnung stimmen.
        assert_eq!(maus_knopf(Knopf::Links, true).as_slice(), &[0x03, 0, 1]);
        assert_eq!(maus_knopf(Knopf::Rechts, false).as_slice(), &[0x03, 1, 0]);
        assert_eq!(maus_knopf(Knopf::Mitte, true).as_slice(), &[0x03, 2, 1]);
        assert_eq!(maus_knopf(Knopf::X1, true).as_slice(), &[0x03, 3, 1]);
        assert_eq!(maus_knopf(Knopf::X2, true).as_slice(), &[0x03, 4, 1]);
    }

    #[test]
    fn rad_ist_fuenf_byte() {
        assert_eq!(maus_rad(120, -120).as_slice(), &[0x04, 0x78, 0x00, 0x88, 0xff]);
    }

    #[test]
    fn taste_ist_vier_byte() {
        assert_eq!(taste(0x1e, true).as_slice(), &[0x05, 0x1e, 0x00, 0x01]);
    }

    /// Eine erweiterte Taste traegt den `0xE0`-Vorsatz im HOHEN Byte, und
    /// little-endian steht der damit an dritter Stelle.
    #[test]
    fn erweiterte_taste_traegt_e0_im_hohen_byte() {
        assert_eq!(taste(0xe01d, true).as_slice(), &[0x05, 0x1d, 0xe0, 0x01]);
        assert_eq!(taste(0xe04b, false).as_slice(), &[0x05, 0x4b, 0xe0, 0x00]);
    }

    #[test]
    fn randwerte_der_normierung() {
        assert_eq!(anteil_zu_u16(0.0), 0);
        assert_eq!(anteil_zu_u16(1.0), 65535);
        assert_eq!(anteil_zu_u16(0.5), 32768);
    }

    /// Ausserhalb des Bildes darf nichts umbrechen: ein Anteil knapp ueber 1,0
    /// muss rechts ankommen, nicht links.
    #[test]
    fn normierung_klemmt_statt_umzubrechen() {
        assert_eq!(anteil_zu_u16(1.0001), 65535);
        assert_eq!(anteil_zu_u16(-0.5), 0);
        assert_eq!(anteil_zu_u16(f64::NAN), 0);
    }

    #[test]
    fn ganze_zeilen_werden_zu_ganzen_rasten() {
        let mut s = Rastensammler::default();
        assert_eq!(s.schritte(1.0, 0.0), (120, 0));
        assert_eq!(s.schritte(-1.0, 0.0), (-120, 0));
        assert_eq!(s.schritte(3.0, -2.0), (360, -240));
        assert_eq!(s.schritte(0.0, 0.0), (0, 0));
    }

    /// **Der Touchpad-Fall.** Drei Teilschritte zu 0,33 sind zusammen eine
    /// Raste — vorher waren es drei, also dreifache Geschwindigkeit.
    #[test]
    fn teilbewegungen_sammeln_sich_statt_sich_zu_verdreifachen() {
        let mut s = Rastensammler::default();
        assert_eq!(s.schritte(0.33, 0.0), (0, 0));
        assert_eq!(s.schritte(0.33, 0.0), (0, 0));
        assert_eq!(s.schritte(0.33, 0.0), (0, 0));
        assert_eq!(s.schritte(0.33, 0.0), (120, 0), "der vierte Schritt fuellt die Raste");
        // Und die Summe stimmt weiter: 30 Schritte zu 0,33 sind 9,9 Zeilen.
        let mut ganze = 1;
        for _ in 0..26 {
            ganze += s.schritte(0.33, 0.0).0 / 120;
        }
        assert_eq!(ganze, 9, "30 x 0,33 = 9,9 Zeilen -> 9 volle Rasten");
    }

    /// Der Rest gilt je Achse. Sonst loeste eine waagerechte Geste senkrechte
    /// Rasten aus.
    #[test]
    fn die_achsen_haben_getrennte_reste() {
        let mut s = Rastensammler::default();
        assert_eq!(s.schritte(0.6, 0.6), (0, 0));
        assert_eq!(s.schritte(0.6, 0.0), (120, 0));
        assert_eq!(s.schritte(0.0, 0.6), (0, 120));
    }

    /// Vor- und zurueckstreichen hebt sich auf, statt zwei Rasten in
    /// Gegenrichtung zu erzeugen.
    #[test]
    fn gegenlaeufige_teilbewegungen_heben_sich_auf() {
        let mut s = Rastensammler::default();
        assert_eq!(s.schritte(0.5, 0.0), (0, 0));
        assert_eq!(s.schritte(-0.5, 0.0), (0, 0));
        assert_eq!(s.schritte(1.0, 0.0), (120, 0), "der Rest steht wieder bei null");
    }

    /// Ein neuer Eingabestrom faengt ohne den Rest des alten an.
    #[test]
    fn zuruecksetzen_verwirft_den_rest() {
        let mut s = Rastensammler::default();
        assert_eq!(s.schritte(0.9, 0.9), (0, 0));
        s.zuruecksetzen();
        assert_eq!(s.schritte(0.9, 0.9), (0, 0), "der alte Rest zaehlt nicht mit");
    }

    /// Ausreisser klemmen ins `i16` und rollen danach nicht nach.
    #[test]
    fn ausreisser_klemmen_und_rollen_nicht_nach() {
        let mut s = Rastensammler::default();
        let (v, h) = s.schritte(100_000.0, -100_000.0);
        assert_eq!((v, h), (32_760, -32_760));
        assert_eq!(s.schritte(0.0, 0.0), (0, 0), "kein Nachlauf aus dem Rest");
        assert_eq!(s.schritte(f64::NAN, f64::INFINITY), (0, 0));
        assert_eq!(s.schritte(1.0, 1.0), (120, 120), "nach Unsinn wieder brauchbar");
    }

    #[test]
    fn nur_bewegungen_sind_verwerfbar() {
        assert!(maus_abs(1, 2).ist_bewegung());
        assert!(maus_rel(1, 2).ist_bewegung());
        assert!(!taste(0x1e, true).ist_bewegung());
        assert!(!maus_knopf(Knopf::Links, true).ist_bewegung());
        assert!(!maus_rad(120, 0).ist_bewegung());
        assert!(!hello().ist_bewegung());
    }

    /// Knopf und Rad haengen an der Bewegung vor ihnen — Tasten nicht.
    #[test]
    fn knopf_und_rad_brauchen_eine_positionierung() {
        assert!(maus_knopf(Knopf::Links, true).braucht_position());
        assert!(maus_knopf(Knopf::Links, false).braucht_position());
        assert!(maus_rad(120, 0).braucht_position());
        assert!(!taste(0x1e, true).braucht_position());
        assert!(!hello().braucht_position());
        assert!(!maus_abs(1, 2).braucht_position());
        assert!(!maus_rel(1, 2).braucht_position());
    }

    /// Bruchteile relativer Bewegungen sammeln sich, statt zu verschwinden —
    /// und ein Ausreisser rollt danach nicht nach.
    #[test]
    fn ganze_punkte_heben_den_rest_auf() {
        let mut rest = 0.0;
        assert_eq!(ganze_punkte(&mut rest, 0.4), 0);
        assert_eq!(ganze_punkte(&mut rest, 0.4), 0);
        assert_eq!(ganze_punkte(&mut rest, 0.4), 1, "drei Bruchteile ergeben den ersten Punkt");
        assert_eq!(ganze_punkte(&mut rest, -1.5), -1);
        assert_eq!(ganze_punkte(&mut rest, 100_000.0), i16::MAX);
        assert_eq!(ganze_punkte(&mut rest, 0.0), 0, "kein Nachlauf aus dem Rest");
        assert_eq!(ganze_punkte(&mut rest, f64::NAN), 0);
        assert_eq!(ganze_punkte(&mut rest, 2.0), 2, "nach Unsinn wieder brauchbar");
    }

    #[test]
    fn base64_kodiert_mit_auffuellung() {
        assert_eq!(base64(&[]), "");
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Manx"), "TWFueA==");
        assert_eq!(base64(&[0xff, 0xff, 0xff]), "////");
        assert_eq!(base64(&[0xfb, 0xff, 0xfe]), "+//+");
        // Der Hello-Frame, wie ihn die Gegenseite sieht.
        assert_eq!(base64(hello().as_slice()), "AAI=");
    }
}
