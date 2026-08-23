//! Base64 für das `frames`-Feld — von Hand, mit Absicht, in beide Richtungen.
//!
//! **Die einzige Fassung in dieser Kiste.** Bis zum Zusammenlegen lag hier nur
//! [`dekodiere`], und `bauen.rs` führte eine zweite, vollständige Kopie
//! (`B64`/`base64`/`base64_zurueck`) — über Kreuz benutzt: der Player kodierte
//! mit der Kopie, der Sidecar dekodierte mit dem Original. Jetzt bauen beide
//! Richtungen auf demselben Alphabet.
//!
//! **Warum keine Kiste dafür:** die Eingabe-Frames sind 2 bis 5 Byte groß, die
//! Nachricht höchstens 1024 Byte (Grenze aus der Spezifikation, gateway-seitig
//! erzwungen). Eine Abhängigkeit für dreißig Zeilen aufzunehmen, kostet mehr
//! Pflege, als sie spart — und der Sidecar hat heute keine.
//!
//! **Streng, nicht großzügig:** nur das Standard-Alphabet, kein URL-safe, keine
//! Leerzeichen, kein Zeilenumbruch, und die **Füllung ist Pflicht**. Der Gateway
//! prüft mit `base64.b64decode(..., validate=True)`, und das verlangt genau das;
//! wer hier großzügiger wäre, ließe Frames durch, die eine Ebene tiefer nie
//! ankommen dürfen — und die Fernsteuerung ist der falsche Ort, um beim Format
//! zu raten (fail-closed). Beide Sender füllen ohnehin auf (`btoa` im Renderer,
//! `pulse-player::fernsteuerung::rahmen::kodiere`), es gibt also niemanden, der
//! auf Nachsicht angewiesen wäre.

/// Ein Base64-Wort dekodieren. Fehler → der Aufrufer weist die ganze Nachricht
/// ab; ein halb dekodierter Frame wäre schlimmer als gar keiner.
pub fn dekodiere(s: &str) -> Result<Vec<u8>, String> {
    let roh = s.as_bytes();
    // Die Länge muss ein Vielfaches von vier sein — das ist die Prüfung, die
    // hier gefehlt hat. Vorher wurde nur EIN `=` oder `==` abgeschnitten, ohne
    // zu prüfen, ob die Füllung zur Länge passt: `"AAI=="` und `"="` gingen
    // durch, obwohl der Gateway beide abweist. Ungefährlich, aber dieses Modul
    // sagt Gleichheit mit dem Gateway zu, und eine Zusage, die nur meistens
    // gilt, ist keine.
    if roh.len() % 4 != 0 {
        return Err("Länge ist kein Vielfaches von vier (Füllzeichen fehlen?)".to_string());
    }
    // Füllzeichen nur am Ende, höchstens zwei.
    let kern = roh
        .strip_suffix(b"==")
        .or_else(|| roh.strip_suffix(b"="))
        .unwrap_or(roh);
    if kern.contains(&b'=') {
        return Err("Füllzeichen '=' mitten im Wort".to_string());
    }
    let mut aus = Vec::with_capacity(kern.len() * 3 / 4);
    let mut sammler: u32 = 0;
    let mut bits: u32 = 0;
    for &z in kern {
        let wert = sechs_bit(z).ok_or_else(|| format!("ungültiges Zeichen {:?}", z as char))?;
        sammler = (sammler << 6) | wert as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            aus.push((sammler >> bits) as u8);
        }
    }
    Ok(aus)
}

/// Das Standard-Alphabet, in Senderichtung.
const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Bytes zu einem Base64-Wort. Die **Gegenrichtung** zu [`dekodiere`], und aus
/// demselben Grund von Hand: dreissig Zeilen sind keine Abhängigkeit wert.
///
/// Gebraucht wird sie für das Zeigerbild (`zeigerpixel`) — der einzige
/// Weg, auf dem dieser Sidecar etwas Binäres nach aussen gibt. Die Eingabe geht
/// in die andere Richtung, deshalb stand hier bisher nur der Dekodierer.
///
/// **Gefüllt wird immer**, aus demselben Grund wie beim Dekodieren: die
/// Gegenseiten (Gateway und Player) verlangen eine Füllung, die zur Länge passt.
pub fn kodiere(bytes: &[u8]) -> String {
    let mut aus = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for block in bytes.chunks(3) {
        // Auf drei Byte auffüllen und merken, wie viele davon echt waren — die
        // fehlenden werden am Ende zu '='.
        let mut drei = [0u8; 3];
        drei[..block.len()].copy_from_slice(block);
        let wort = (drei[0] as u32) << 16 | (drei[1] as u32) << 8 | drei[2] as u32;
        for i in 0..4 {
            // Ein Zeichen deckt sechs Bit ab; ab dem (block.len()+1)-ten Zeichen
            // stünde nur noch Füllung.
            if i <= block.len() {
                aus.push(ALPHABET[(wort >> (18 - i * 6)) as usize & 0x3F] as char);
            } else {
                aus.push('=');
            }
        }
    }
    aus
}

/// Zeichen → 6-Bit-Wert im Standard-Alphabet, `None` = gehört nicht dazu.
fn sechs_bit(z: u8) -> Option<u8> {
    Some(match z {
        b'A'..=b'Z' => z - b'A',
        b'a'..=b'z' => z - b'a' + 26,
        b'0'..=b'9' => z - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Die Frames aus der Spezifikation, wie der Steuernde sie schickt.
    #[test]
    fn echte_frames() {
        // Hello v2 = [0x00, 0x02]
        assert_eq!(dekodiere("AAI=").unwrap(), vec![0x00, 0x02]);
        // MouseButton links runter = [0x03, 0x00, 0x01]
        assert_eq!(dekodiere("AwAB").unwrap(), vec![0x03, 0x00, 0x01]);
        // MouseMoveAbs Mitte = [0x01, 0xFF, 0x7F, 0xFF, 0x7F]
        assert_eq!(
            dekodiere("Af9//38=").unwrap(),
            vec![0x01, 0xFF, 0x7F, 0xFF, 0x7F]
        );
    }

    #[test]
    fn leeres_wort_ist_leer() {
        assert_eq!(dekodiere("").unwrap(), Vec::<u8>::new());
    }

    /// Die Füllung ist **Pflicht**, nicht Zierde: der Gateway
    /// (`b64decode(validate=True)`) weist ein ungefülltes Wort ab, und beide
    /// Sender füllen auf. Was hier durchkäme, käme dort nie an.
    #[test]
    fn fuellung_ist_pflicht() {
        assert!(dekodiere("AAI").is_err());
        assert!(dekodiere("/w").is_err());
        assert_eq!(dekodiere("AAI=").unwrap(), vec![0x00, 0x02]);
    }

    /// **Der Fund:** die Füllung muss zur Länge passen. `"AAI=="` (ein Zeichen
    /// zu viel gefüllt) und `"="` (Füllung ohne Inhalt) gingen früher durch,
    /// obwohl der Gateway beide abweist.
    #[test]
    fn fuellung_muss_zur_laenge_passen() {
        assert!(dekodiere("AAI==").is_err());
        assert!(dekodiere("=").is_err());
        assert!(dekodiere("==").is_err());
        assert!(dekodiere("====").is_err());
        assert!(dekodiere("A===").is_err());
    }

    #[test]
    fn ganze_bytebreite() {
        assert_eq!(dekodiere("/w==").unwrap(), vec![0xFF]);
        assert_eq!(dekodiere("+w==").unwrap(), vec![0xFB]);
    }

    #[test]
    fn fremde_zeichen_werden_abgewiesen() {
        // URL-safe gehört NICHT dazu (der Gateway lässt es auch nicht durch).
        assert!(dekodiere("-w==").is_err());
        assert!(dekodiere("_w==").is_err());
        assert!(dekodiere("AA I").is_err());
        assert!(dekodiere("AA\nI").is_err());
    }

    #[test]
    fn kaputte_laenge_und_fuellung() {
        assert!(dekodiere("A").is_err());
        assert!(dekodiere("AAA").is_err());
        assert!(dekodiere("AAAAA").is_err());
        assert!(dekodiere("A=AA").is_err());
    }

    /// Die Senderichtung gegen bekannte Wörter — dieselben, an denen der
    /// Dekodierer oben hängt, nur andersherum gelesen.
    #[test]
    fn kodiert_bekannte_woerter() {
        assert_eq!(kodiere(&[0x00, 0x02]), "AAI=");
        assert_eq!(kodiere(&[0x03, 0x00, 0x01]), "AwAB");
        assert_eq!(kodiere(&[0x01, 0xFF, 0x7F, 0xFF, 0x7F]), "Af9//38=");
        assert_eq!(kodiere(&[0xFF]), "/w==");
        assert_eq!(kodiere(&[0xFB]), "+w==");
        assert_eq!(kodiere(&[]), "");
    }

    /// **Die eigentliche Zusage:** was hier hinausgeht, muss der Dekodierer der
    /// Gegenseite wieder hereinbekommen. Alle drei Restlängen abgedeckt — die
    /// Füllung ist genau dort die Fehlerquelle.
    #[test]
    fn kodieren_und_dekodieren_ergeben_dasselbe() {
        for laenge in 0..40usize {
            let bytes: Vec<u8> = (0..laenge).map(|i| (i * 37 % 256) as u8).collect();
            let wort = kodiere(&bytes);
            assert_eq!(wort.len() % 4, 0, "Länge {laenge} ist nicht gefüllt");
            assert_eq!(dekodiere(&wort).unwrap(), bytes, "Länge {laenge}");
        }
    }

    /// Die klassischen Lehrbuch-Beispiele, dazu die beiden Fälle, in denen ein
    /// Sechs-Bit-Wert genau auf den letzten Index des Alphabets fällt (63 =
    /// `/`) bzw. den vorletzten (62 = `+`) — hierher gezogen aus `bauen.rs`,
    /// das bis zum Zusammenlegen eine zweite, über Kreuz benutzte Fassung
    /// dieses Moduls war (Sidecar dekodierte hier, Player kodierte dort).
    #[test]
    fn kodiert_klassische_beispiele() {
        assert_eq!(kodiere(b"M"), "TQ==");
        assert_eq!(kodiere(b"Ma"), "TWE=");
        assert_eq!(kodiere(b"Man"), "TWFu");
        assert_eq!(kodiere(b"Manx"), "TWFueA==");
        assert_eq!(kodiere(&[0xff, 0xff, 0xff]), "////");
        assert_eq!(kodiere(&[0xfb, 0xff, 0xfe]), "+//+");
        // Der Hello-Frame, wie ihn die Gegenseite sieht.
        assert_eq!(kodiere(crate::bauen::hello().as_slice()), "AAI=");
    }
}
