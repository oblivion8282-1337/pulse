//! Base64-Dekodierung für das `frames`-Feld — von Hand, mit Absicht.
//!
//! **Warum keine Kiste dafür:** die Eingabe-Frames sind 2 bis 5 Byte groß, die
//! Nachricht höchstens 1024 Byte (Grenze aus der Spezifikation, gateway-seitig
//! erzwungen). Eine Abhängigkeit für dreißig Zeilen aufzunehmen, kostet mehr
//! Pflege, als sie spart — und der Sidecar hat heute keine.
//!
//! **Streng, nicht großzügig:** nur das Standard-Alphabet, kein URL-safe, keine
//! Leerzeichen, kein Zeilenumbruch. Der Gateway prüft mit `validate=True` gegen
//! genau dieses Alphabet; wer hier großzügiger wäre, ließe Frames durch, die
//! eine Ebene tiefer nie ankommen dürfen — und die Fernsteuerung ist der
//! falsche Ort, um beim Format zu raten (fail-closed).

/// Ein Base64-Wort dekodieren. Fehler → der Aufrufer weist die ganze Nachricht
/// ab; ein halb dekodierter Frame wäre schlimmer als gar keiner.
pub fn dekodiere(s: &str) -> Result<Vec<u8>, String> {
    let roh = s.as_bytes();
    // Füllzeichen nur am Ende, höchstens zwei.
    let kern = roh
        .strip_suffix(b"==")
        .or_else(|| roh.strip_suffix(b"="))
        .unwrap_or(roh);
    if kern.contains(&b'=') {
        return Err("Füllzeichen '=' mitten im Wort".to_string());
    }
    // Vier Zeichen tragen drei Byte; ein Rest von genau einem Zeichen trägt
    // nichts und ist deshalb kein gültiges Wort.
    if kern.len() % 4 == 1 {
        return Err("ungültige Länge".to_string());
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

    /// Ohne Füllzeichen ist es dasselbe Wort — manche Kodierer lassen sie weg.
    #[test]
    fn fuellung_ist_freiwillig() {
        assert_eq!(dekodiere("AAI").unwrap(), dekodiere("AAI=").unwrap());
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
        assert!(dekodiere("AAAAA").is_err());
        assert!(dekodiere("A=AA").is_err());
    }
}
