//! Das Frame-Format der Fernsteuerung — Byte fuer Byte.
//!
//! Verbindlich ist `docs/plans/2026-08-12-input-wire-protokoll-v2.md`. Alles
//! hier ist **rein**: Bytes bauen, Anteile normieren, Base64 kodieren. Wer die
//! Ereignisse einsammelt, steht in [`super`]; wer sie parst und injiziert,
//! steht in `streaming/win-hq-sidecar/src/remote_input.rs`.
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

/// Hello-Version. **2**, seit der Eingabeweg ueber die App-WebSocket laeuft und
/// die Huelle einen `slot` traegt. v1-Sender weist der Host ab; einen Bestand,
/// auf den Ruecksicht zu nehmen waere, gibt es nicht (v1 hat nie ausgeliefert).
pub const PROTOKOLL_VERSION: u8 = 2;

pub const OP_HELLO: u8 = 0x00;
pub const OP_MAUS_ABS: u8 = 0x01;
pub const OP_MAUS_REL: u8 = 0x02;
pub const OP_MAUS_KNOPF: u8 = 0x03;
pub const OP_MAUS_RAD: u8 = 0x04;
pub const OP_TASTE: u8 = 0x05;

/// Eine Windows-Raste am Mausrad (`WHEEL_DELTA`).
pub const RASTE: i32 = 120;

/// Knopf-Nummern der Leitung. **Nicht** die von winit und nicht die von
/// JavaScript — der Host bildet genau diese auf `MOUSEEVENTF_*` ab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Knopf {
    Links = 0,
    Rechts = 1,
    Mitte = 2,
    X1 = 3,
    X2 = 4,
}

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

    /// Die beiden i16-Werte einer relativen Bewegung. Nur fuer das Aufsummieren
    /// beim Zusammenfassen (s. [`super::Erfassung`]).
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

/// Rastschritte aus einer Radbewegung. `zeilen` sind winit-Zeilen oder aus
/// Pixeln abgeleitete Zeilen; das Ergebnis ist ein Vielfaches von [`RASTE`].
///
/// Mindestens eine Raste, solange die Bewegung nicht null ist: ein Touchpad
/// liefert Bruchteile, und ein auf null gerundeter Wert waere ein Rad, das sich
/// beim Streichen gar nicht dreht.
pub fn rasten(zeilen: f64) -> i16 {
    if zeilen == 0.0 || !zeilen.is_finite() {
        return 0;
    }
    let ganze = zeilen.abs().round().max(1.0);
    let wert = ganze * f64::from(RASTE) * zeilen.signum();
    wert.clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn rasten_runden_auf_ganze_schritte() {
        assert_eq!(rasten(1.0), 120);
        assert_eq!(rasten(-1.0), -120);
        assert_eq!(rasten(3.0), 360);
        assert_eq!(rasten(0.0), 0);
        // Ein Bruchteil vom Touchpad ergibt trotzdem eine ganze Raste — sonst
        // drehte sich das Rad beim Streichen gar nicht.
        assert_eq!(rasten(0.2), 120);
        assert_eq!(rasten(-0.2), -120);
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
