//! Zerlegen und Wiederzusammensetzen unter dem Deckel des Gateways.
//!
//! **Der Empfaenger glaubt dem Sender nichts.** Jede Grenze, die `zerlegen`
//! einhaelt, prueft [`Sammler`] noch einmal — die Gegenstelle ist eine andere
//! Maschine, moeglicherweise mit einer anderen Fassung, moeglicherweise
//! feindlich.

use pulse_fernsteuerung::base64::{dekodiere, kodiere};

use crate::format::{Grund, MAX_STUECK_ROH, MAX_TEXT_BYTE, Rahmen};

/// Einen Text in sendefertige Stuecke zerlegen.
///
/// Ein leerer Text ergibt **ein** Stueck mit leerer Nutzlast — nicht null
/// Stuecke: der Empfaenger wartet sonst ewig auf eine Lieferung, die es nie
/// gibt.
pub fn zerlegen(id: u64, text: &str) -> Result<Vec<Rahmen>, Grund> {
    let roh = text.as_bytes();
    if roh.len() > MAX_TEXT_BYTE {
        return Err(Grund::ZuGross);
    }
    let teile: Vec<&[u8]> =
        if roh.is_empty() { vec![&[][..]] } else { roh.chunks(MAX_STUECK_ROH).collect() };
    let n = teile.len() as u32;
    Ok(teile
        .into_iter()
        .enumerate()
        .map(|(i, teil)| Rahmen::Stueck { id, i: i as u32, n, d: kodiere(teil) })
        .collect())
}

/// Sammelt die Stuecke einer Lieferung, bis sie vollstaendig ist.
pub struct Sammler {
    id: u64,
    n: Option<u32>,
    teile: Vec<Option<Vec<u8>>>,
    roh: usize,
}

impl Sammler {
    pub fn neu(id: u64) -> Sammler {
        Sammler { id, n: None, teile: Vec::new(), roh: 0 }
    }

    /// Ein Stueck aufnehmen. `Ok(Some(text))`, sobald die Lieferung vollstaendig
    /// ist; `Ok(None)`, solange noch etwas fehlt; `Err`, wenn der Rahmen nicht
    /// zu dieser Lieferung gehoert oder die Grenzen verletzt.
    pub fn nimm(&mut self, rahmen: &Rahmen) -> Result<Option<String>, String> {
        let Rahmen::Stueck { id, i, n, d } = rahmen else {
            return Err("kein Stueck".to_string());
        };
        if *id != self.id {
            return Err(format!("Stueck gehoert zu Anfrage {id}, nicht {}", self.id));
        }
        if *n == 0 {
            return Err("n = 0".to_string());
        }
        match self.n {
            None => {
                self.n = Some(*n);
                self.teile = (0..*n).map(|_| None).collect();
            }
            Some(bekannt) if bekannt != *n => {
                return Err(format!("n wechselt von {bekannt} auf {n}"));
            }
            Some(_) => {}
        }
        let platz = self.teile.get_mut(*i as usize).ok_or_else(|| format!("i={i} ausserhalb"))?;
        if platz.is_some() {
            return Err(format!("Stueck {i} kam zweimal"));
        }
        let bytes = dekodiere(d)?;
        // **Vor** dem Ablegen zaehlen, sonst haette ein Schwall den Speicher
        // schon belegt, wenn wir es merken.
        self.roh += bytes.len();
        if self.roh > MAX_TEXT_BYTE {
            return Err(format!("Lieferung ueberschreitet {MAX_TEXT_BYTE} Byte"));
        }
        *platz = Some(bytes);
        if self.teile.iter().any(Option::is_none) {
            return Ok(None);
        }
        let ganz: Vec<u8> = self.teile.iter().flatten().flatten().copied().collect();
        String::from_utf8(ganz).map(Some).map_err(|e| format!("kein gueltiges UTF-8: {e}"))
    }
}

#[cfg(test)]
mod tests {
    // `super::*` bringt `MAX_TEXT_BYTE` und `MAX_STUECK_ROH` schon mit — sie
    // stehen im `use` des Elternmoduls. Ein zweiter expliziter Import waere
    // eine Doppelung, die beim naechsten Umbenennen auseinanderliefe.
    use super::*;

    fn durchreichen(text: &str) -> String {
        let stuecke = zerlegen(9, text).expect("passt");
        let mut s = Sammler::neu(9);
        let mut fertig = None;
        for r in &stuecke {
            if let Some(t) = s.nimm(r).expect("gueltig") {
                fertig = Some(t);
            }
        }
        fertig.expect("muss fertig werden")
    }

    #[test]
    fn kurzer_text_geht_in_einem_stueck() {
        let stuecke = zerlegen(9, "hallo").expect("passt");
        assert_eq!(stuecke.len(), 1);
        assert_eq!(durchreichen("hallo"), "hallo");
    }

    #[test]
    fn umlaute_und_leerer_text_ueberstehen_den_weg() {
        assert_eq!(durchreichen("Größe: 1 µm — ok"), "Größe: 1 µm — ok");
        assert_eq!(durchreichen(""), "");
    }

    #[test]
    fn langer_text_wird_gestueckelt_und_wieder_ganz() {
        let text = "z".repeat(20_000);
        let stuecke = zerlegen(9, &text).expect("passt");
        assert!(stuecke.len() > 1, "20 kB muessen mehrere Stuecke sein");
        assert_eq!(durchreichen(&text), text);
    }

    #[test]
    fn ueber_der_grenze_wird_abgelehnt_statt_abgeschnitten() {
        // Abschneiden waere schlimmer als ablehnen: der Nutzer bekaeme drueben
        // die halbe Zeichenkette eingefuegt und merkte es womoeglich nicht.
        let zu_lang = "z".repeat(MAX_TEXT_BYTE + 1);
        assert_eq!(zerlegen(9, &zu_lang), Err(Grund::ZuGross));
    }

    #[test]
    fn stuecke_duerfen_in_beliebiger_reihenfolge_kommen() {
        let text = "z".repeat(20_000);
        let mut stuecke = zerlegen(9, &text).expect("passt");
        stuecke.reverse();
        let mut s = Sammler::neu(9);
        let mut fertig = None;
        for r in &stuecke {
            if let Some(t) = s.nimm(r).expect("gueltig") {
                fertig = Some(t);
            }
        }
        assert_eq!(fertig.expect("fertig"), text);
    }

    #[test]
    fn fremde_anfragenummer_wird_abgelehnt() {
        let stuecke = zerlegen(9, "hallo").expect("passt");
        let mut s = Sammler::neu(10);
        assert!(s.nimm(&stuecke[0]).is_err());
    }

    #[test]
    fn doppeltes_stueck_wird_abgelehnt() {
        let text = "z".repeat(20_000);
        let stuecke = zerlegen(9, &text).expect("passt");
        let mut s = Sammler::neu(9);
        s.nimm(&stuecke[0]).expect("erstes ok");
        assert!(s.nimm(&stuecke[0]).is_err(), "dasselbe Stueck zweimal ist ein Fehler");
    }

    #[test]
    fn wechselnde_gesamtzahl_wird_abgelehnt() {
        let mut s = Sammler::neu(9);
        s.nimm(&Rahmen::Stueck { id: 9, i: 0, n: 3, d: "aGE=".into() }).expect("erstes ok");
        assert!(
            s.nimm(&Rahmen::Stueck { id: 9, i: 1, n: 4, d: "aGE=".into() }).is_err(),
            "n darf sich innerhalb einer Lieferung nicht aendern"
        );
    }

    #[test]
    fn kaputtes_base64_wird_abgelehnt() {
        let mut s = Sammler::neu(9);
        assert!(s.nimm(&Rahmen::Stueck { id: 9, i: 0, n: 1, d: "!!!".into() }).is_err());
    }

    #[test]
    fn ungueltiges_utf8_wird_abgelehnt() {
        // 0xFF ist in UTF-8 nie gueltig. Ohne diese Pruefung landete Muell in
        // der Ablage des Nutzers.
        let d = pulse_fernsteuerung::base64::kodiere(&[0xFF, 0xFE]);
        let mut s = Sammler::neu(9);
        assert!(s.nimm(&Rahmen::Stueck { id: 9, i: 0, n: 1, d }).is_err());
    }

    #[test]
    fn zu_viele_bytes_werden_abgelehnt() {
        // Der Sender haelt sich an MAX_TEXT_BYTE — der Empfaenger glaubt es ihm
        // nicht. Ohne diese Pruefung koennte eine boesartige Gegenstelle
        // beliebig viel Speicher belegen, ein Stueck nach dem anderen.
        let d = pulse_fernsteuerung::base64::kodiere(&vec![b'x'; MAX_STUECK_ROH]);
        let mut s = Sammler::neu(9);
        let viele = MAX_TEXT_BYTE / MAX_STUECK_ROH + 2;
        let mut letzte = Ok(None);
        for i in 0..viele as u32 {
            letzte = s.nimm(&Rahmen::Stueck { id: 9, i, n: viele as u32, d: d.clone() });
            if letzte.is_err() {
                break;
            }
        }
        assert!(letzte.is_err(), "der Empfaenger muss bei MAX_TEXT_BYTE abbrechen");
    }
}
