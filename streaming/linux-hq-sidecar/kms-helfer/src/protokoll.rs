//! Das Format auf dem Draht zwischen App und Helfer — eine Anfrage, eine
//! Antwort, feste Groessen.
//!
//! **Warum es hier steht und nicht zweimal.** Beide Seiten benutzen dieses
//! Modul: der Helfer (`main.rs` derselben Kiste) und der Sidecar
//! (`capture/kms_helfer.rs`, ueber die Pfad-Abhaengigkeit). Ein zweites,
//! handgleiches Format auf der anderen Seite waere genau die Stelle, an der die
//! Fassungen unbemerkt auseinanderlaufen.
//!
//! **Die ersten zwoelf Byte der Antwort sind auf ewig festgelegt** — Kennung,
//! Fassung, Ergebnis. Das ist keine Stilfrage: ein Sidecar der Fassung 5 muss
//! die Antwort eines Helfers der Fassung 1 noch so weit lesen koennen, dass er
//! „zu alt" sagen kann. Waere der Fassungswert hinter einem Feld, das sich
//! geaendert hat, laese er Muell und meldete irgendetwas anderes. Alles ab
//! Byte 12 darf sich mit der Fassung aendern.
//!
//! Zahlen stehen little-endian, ausdruecklich und nicht in der Reihenfolge der
//! Maschine: das Format soll auch dann noch definiert sein, wenn jemand es
//! eines Tages auf einer anderen Architektur nachliest.

/// Fassung des Formats. **Erhoehen, sobald sich an Anfrage oder Antwort
/// jenseits von Byte 12 etwas aendert** — auch bei scheinbar harmlosen
/// Erweiterungen. Der Handschlag ist die einzige Stelle, an der ein alter
/// Helfer auffaellt; wer sie nicht bedient, bekommt in drei Monaten
/// Fehlerbilder ohne Ursache.
pub const FASSUNG: u32 = 1;

/// Kennung der Anfrage: „PKHA" (Pulse-KMS-Helfer-Anfrage).
pub const KENNUNG_ANFRAGE: u32 = u32::from_le_bytes(*b"PKHA");
/// Kennung der Antwort: „PKHR".
pub const KENNUNG_ANTWORT: u32 = u32::from_le_bytes(*b"PKHR");

pub const ANFRAGE_LEN: usize = 48;
pub const ANTWORT_LEN: usize = 192;

/// Laengste Ausgangsbezeichnung, die in die Anfrage passt (`DP-2`,
/// `HDMI-A-1` — 32 Byte sind reichlich).
pub const NAME_MAX: usize = 32;
const MELDUNG_MAX: usize = ANTWORT_LEN - 68;

/// Die einzige Operation. Absichtlich: je weniger der Helfer kann, desto
/// weniger kann er anrichten. Er hat keine Auflistung, kein Auswaehlen, kein
/// Schreiben — er reicht ein Bild heraus, sonst nichts.
pub const OP_BILD: u32 = 1;

pub const OK: i32 = 0;
/// Der Helfer spricht eine andere Fassung als die App.
pub const FEHLER_FASSUNG: i32 = 1;
/// Der genannte Ausgang existiert nicht oder ist nicht aktiv.
pub const FEHLER_AUSGANG: i32 = 2;
/// Der Helfer selbst hat die Rechte nicht (kein `setcap`, nicht root).
pub const FEHLER_RECHTE: i32 = 3;
/// Alles Uebrige — die Meldung sagt, was.
pub const FEHLER_SONST: i32 = 4;

/// Hoechstzahl der Bildebenen. Vier, weil `GETFB2` vier fuehrt.
pub const EBENEN_MAX: usize = 4;

fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

fn text_aus(b: &[u8]) -> String {
    let ende = b.iter().position(|&x| x == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..ende]).into_owned()
}

fn text_ein(ziel: &mut [u8], text: &str) {
    let n = text.len().min(ziel.len().saturating_sub(1));
    ziel[..n].copy_from_slice(&text.as_bytes()[..n]);
}

/// „Gib mir das aktuelle Bild dieses Ausgangs."
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anfrage {
    pub fassung: u32,
    pub op: u32,
    pub ausgang: String,
}

impl Anfrage {
    pub fn bild(ausgang: &str) -> Self {
        Self { fassung: FASSUNG, op: OP_BILD, ausgang: ausgang.to_string() }
    }

    pub fn kodieren(&self) -> [u8; ANFRAGE_LEN] {
        let mut b = [0u8; ANFRAGE_LEN];
        b[0..4].copy_from_slice(&KENNUNG_ANFRAGE.to_le_bytes());
        b[4..8].copy_from_slice(&self.fassung.to_le_bytes());
        b[8..12].copy_from_slice(&self.op.to_le_bytes());
        text_ein(&mut b[16..16 + NAME_MAX], &self.ausgang);
        b
    }

    /// `Err`, wenn die Kennung nicht stimmt — dann redet da etwas anderes mit
    /// uns, und weiterzulesen waere Raten.
    pub fn dekodieren(b: &[u8]) -> Result<Self, &'static str> {
        if b.len() < ANFRAGE_LEN {
            return Err("Anfrage zu kurz");
        }
        if u32_at(b, 0) != KENNUNG_ANFRAGE {
            return Err("keine Pulse-KMS-Anfrage");
        }
        Ok(Self {
            fassung: u32_at(b, 4),
            op: u32_at(b, 8),
            ausgang: text_aus(&b[16..16 + NAME_MAX]),
        })
    }
}

/// Eine Bildebene: Zeilenschritt und Versatz im Puffer. Der zugehoerige
/// Dateideskriptor reist getrennt (SCM_RIGHTS), in derselben Reihenfolge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ebene {
    pub pitch: u32,
    pub offset: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Antwort {
    pub fassung: u32,
    pub ergebnis: i32,
    pub width: u32,
    pub height: u32,
    pub fourcc: u32,
    pub modifier: u64,
    pub ebenen: Vec<Ebene>,
    /// Klartext im Fehlerfall. **Niemals Pfade, Kennungen oder Bildinhalte** —
    /// die Meldung wandert in das Log der App.
    pub meldung: String,
}

impl Antwort {
    pub fn fehler(ergebnis: i32, meldung: &str) -> Self {
        Self {
            fassung: FASSUNG,
            ergebnis,
            width: 0,
            height: 0,
            fourcc: 0,
            modifier: 0,
            ebenen: Vec::new(),
            meldung: meldung.to_string(),
        }
    }

    pub fn kodieren(&self) -> [u8; ANTWORT_LEN] {
        let mut b = [0u8; ANTWORT_LEN];
        b[0..4].copy_from_slice(&KENNUNG_ANTWORT.to_le_bytes());
        b[4..8].copy_from_slice(&self.fassung.to_le_bytes());
        b[8..12].copy_from_slice(&self.ergebnis.to_le_bytes());
        b[12..16].copy_from_slice(&self.width.to_le_bytes());
        b[16..20].copy_from_slice(&self.height.to_le_bytes());
        b[20..24].copy_from_slice(&self.fourcc.to_le_bytes());
        b[24..32].copy_from_slice(&self.modifier.to_le_bytes());
        let n = self.ebenen.len().min(EBENEN_MAX);
        b[32..36].copy_from_slice(&(n as u32).to_le_bytes());
        for (i, e) in self.ebenen.iter().take(EBENEN_MAX).enumerate() {
            let p = 36 + i * 8;
            b[p..p + 4].copy_from_slice(&e.pitch.to_le_bytes());
            b[p + 4..p + 8].copy_from_slice(&e.offset.to_le_bytes());
        }
        text_ein(&mut b[68..68 + MELDUNG_MAX], &self.meldung);
        b
    }

    pub fn dekodieren(b: &[u8]) -> Result<Self, &'static str> {
        if b.len() < ANTWORT_LEN {
            return Err("Antwort zu kurz");
        }
        if u32_at(b, 0) != KENNUNG_ANTWORT {
            return Err("keine Pulse-KMS-Antwort");
        }
        let n = (u32_at(b, 32) as usize).min(EBENEN_MAX);
        let ebenen = (0..n)
            .map(|i| Ebene { pitch: u32_at(b, 36 + i * 8), offset: u32_at(b, 40 + i * 8) })
            .collect();
        Ok(Self {
            fassung: u32_at(b, 4),
            ergebnis: u32_at(b, 8) as i32,
            width: u32_at(b, 12),
            height: u32_at(b, 16),
            fourcc: u32_at(b, 20),
            modifier: u64::from_le_bytes(b[24..32].try_into().unwrap()),
            ebenen,
            meldung: text_aus(&b[68..68 + MELDUNG_MAX]),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anfrage_haelt_die_runde() {
        let a = Anfrage::bild("DP-2");
        let b = Anfrage::dekodieren(&a.kodieren()).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn antwort_haelt_die_runde() {
        let a = Antwort {
            fassung: 7,
            ergebnis: OK,
            width: 2560,
            height: 1440,
            fourcc: u32::from_le_bytes(*b"AB30"),
            modifier: 0x0300_0000_0060_6014,
            ebenen: vec![Ebene { pitch: 10240, offset: 0 }, Ebene { pitch: 5120, offset: 64 }],
            meldung: String::new(),
        };
        assert_eq!(Antwort::dekodieren(&a.kodieren()).unwrap(), a);
    }

    /// Die Stelle, an der der Handschlag haengt. Wenn jemand das Format
    /// erweitert, darf sich an diesen zwoelf Byte nichts verschieben — sonst
    /// liest ein neuer Sidecar die Fassung eines alten Helfers falsch und
    /// meldet statt „zu alt" irgendetwas.
    #[test]
    fn die_ersten_zwoelf_byte_liegen_fest() {
        let b = Antwort::fehler(FEHLER_FASSUNG, "zu alt").kodieren();
        assert_eq!(&b[0..4], b"PKHR");
        assert_eq!(u32_at(&b, 4), FASSUNG);
        assert_eq!(u32_at(&b, 8) as i32, FEHLER_FASSUNG);
    }

    /// Fremde Bytes duerfen nicht als halbwegs plausible Anfrage durchgehen.
    #[test]
    fn fremdes_wird_abgewiesen() {
        assert!(Anfrage::dekodieren(&[0u8; ANFRAGE_LEN]).is_err());
        assert!(Anfrage::dekodieren(b"PKHA").is_err(), "zu kurz ist auch falsch");
        assert!(Antwort::dekodieren(&[0xffu8; ANTWORT_LEN]).is_err());
    }

    /// Ein zu langer Name darf den Puffer nicht ueberlaufen und darf auch nicht
    /// als abgeschnittener Name durchgehen, der zufaellig einen anderen Ausgang
    /// trifft — er wird abgeschnitten und passt dann auf keinen echten Namen.
    #[test]
    fn zu_langer_name_laeuft_nicht_ueber() {
        let lang = "X".repeat(200);
        let a = Anfrage::bild(&lang);
        let zurueck = Anfrage::dekodieren(&a.kodieren()).unwrap();
        assert_eq!(zurueck.ausgang.len(), NAME_MAX - 1);
    }

    /// Mehr Ebenen, als `GETFB2` fuehren kann, duerfen weder beim Schreiben
    /// noch beim Lesen ueber die vier hinausgehen — sonst zaehlte die Gegenseite
    /// mehr Dateideskriptoren, als mitgeschickt wurden.
    #[test]
    fn mehr_als_vier_ebenen_werden_gekappt() {
        let mut a = Antwort::fehler(OK, "");
        a.ebenen = vec![Ebene { pitch: 1, offset: 0 }; 9];
        assert_eq!(Antwort::dekodieren(&a.kodieren()).unwrap().ebenen.len(), EBENEN_MAX);
    }

    /// Kaputte Zeichen in der Meldung duerfen nicht panisch werden.
    #[test]
    fn ungueltiger_text_wird_nicht_panisch() {
        let mut b = Antwort::fehler(FEHLER_SONST, "x").kodieren();
        b[68] = 0xff;
        b[69] = 0xfe;
        assert!(Antwort::dekodieren(&b).is_ok());
    }
}
