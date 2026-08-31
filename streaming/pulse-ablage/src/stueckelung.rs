//! Zerlegen und Wiederzusammensetzen unter dem Deckel des Gateways.
//!
//! **Der Empfaenger glaubt dem Sender nichts.** Jede Grenze, die `zerlegen`
//! einhaelt, prueft [`Sammler`] noch einmal — die Gegenstelle ist eine andere
//! Maschine, moeglicherweise mit einer anderen Fassung, moeglicherweise
//! feindlich.

use pulse_fernsteuerung::base64::{dekodiere, kodiere};

use crate::format::{Grund, MAX_STUECK_ROH, MAX_TEXT_BYTE, Rahmen};

/// Wie viele Stuecke eine Lieferung hoechstens hat.
///
/// Aus den beiden Grenzen des Formats GERECHNET statt daneben geschrieben —
/// eine dritte Zahl liefe auseinander, sobald sich eine der beiden aendert.
/// Geht die Teilung auf, ist ein Platz Reserve dabei; das schadet nichts, ein
/// Fehlalarm gegen einen ehrlichen Sender schon.
const MAX_STUECKE: u32 = (MAX_TEXT_BYTE / MAX_STUECK_ROH + 1) as u32;

/// Wie lang die Base64-Nutzlast eines Stuecks hoechstens ist.
///
/// Aus [`MAX_STUECK_ROH`] GERECHNET, aus demselben Grund wie [`MAX_STUECKE`]:
/// vier Zeichen je drei Byte, aufgerundet, weil `kodiere` immer auffuellt —
/// 5900 Byte werden zu 7868 Zeichen.
const MAX_STUECK_B64: usize = MAX_STUECK_ROH.div_ceil(3) * 4;

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
        // **Der Empfaenger glaubt dem Sender nichts — auch seine Stueckzahl
        // nicht.** Ohne diese Schranke legt `n = u32::MAX` sofort einen Vektor
        // mit vier Milliarden Plaetzen an, lange bevor das erste Byte gezaehlt
        // wird: ein einziger Rahmen genuegt fuer den Absturz. Ein ehrlicher
        // Sender kommt nie darueber, weil `zerlegen` aus denselben zwei
        // Grenzen rechnet.
        if *n > MAX_STUECKE {
            return Err(format!("n = {n} ueberschreitet {MAX_STUECKE} Stuecke"));
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
        // **Vor dem Dekodieren messen, nicht danach.** `dekodiere` legt rund
        // 0,75·`d.len()` an — ein einziges Stueck mit uebergrossem `d` haette
        // den Speicher also schon belegt, wenn die Summe darunter zaehlt. Die
        // Schranke ist die Base64-Laenge des groessten ehrlichen Stuecks:
        // MAX_STUECK_ROH Byte werden zu ceil(5900/3)*4 = 7868 Zeichen (mit
        // Fuellzeichen — `kodiere` fuellt immer auf). `hoechste_ehrliche_
        // stueckzahl_geht_durch` ist die Gegenprobe, dass sie einen echten
        // Sender nicht trifft.
        if d.len() > MAX_STUECK_B64 {
            return Err(format!("Stueck traegt {} Base64-Zeichen, hoechstens {MAX_STUECK_B64}", d.len()));
        }
        let bytes = dekodiere(d)?;
        // Die SUMME ueber alle bisherigen Stuecke, vor dem Ablegen. Die
        // Schranke darueber deckt das einzelne Stueck, diese hier die
        // Lieferung: ein Schwall kleiner Stuecke kaeme sonst ueber
        // MAX_TEXT_BYTE hinaus.
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
        assert_eq!(zerlegen(9, "").expect("passt").len(), 1, "leerer Text ist EIN Stueck, nicht null");
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

    #[test]
    fn uebergrosses_stueck_wird_vor_dem_dekodieren_abgelehnt() {
        // `dekodiere` legt rund 0,75·d.len() an. Waere die Schranke erst hinter
        // dem Dekodieren, haette ein einziger Rahmen den Speicher schon belegt,
        // wenn `self.roh` ihn zaehlt — die Schranke muss also DAVOR greifen.
        let mut s = Sammler::neu(9);
        let d = pulse_fernsteuerung::base64::kodiere(&vec![b'x'; MAX_STUECK_ROH + 3]);
        assert!(
            d.len() > MAX_STUECK_B64,
            "der Fall braucht ein Stueck ueber der Base64-Schranke: {} gegen {MAX_STUECK_B64}",
            d.len()
        );
        assert!(
            s.nimm(&Rahmen::Stueck { id: 9, i: 0, n: 1, d }).is_err(),
            "ein Stueck ueber MAX_STUECK_ROH muss abgelehnt werden"
        );
    }

    #[test]
    fn eine_stueckgrenze_darf_mitten_in_einem_zeichen_liegen() {
        // **Die Rechnung, nicht geraten.** Die erste Stueckgrenze liegt nach
        // MAX_STUECK_ROH = 5900 Byte, also zwischen Byte 5899 und 5900
        // (nullbasiert). Ein „oe"-Umlaut ist in UTF-8 zwei Byte (0xC3 0xB6).
        // Steht er ab Byte 5899, faellt sein zweites Byte ins naechste Stueck —
        // genau der Fall, den die Eigenschaft „byteweise zerlegen, erst nach
        // dem Zusammensetzen UTF-8 pruefen" abdeckt und den kein anderer Test
        // trifft: in `langer_text_kommt_vollstaendig_an` fallen alle Grenzen
        // zufaellig auf Zeichengrenzen.
        //
        // Dass die Grenze WIRKLICH im Zeichen liegt, wird nachgemessen und
        // nicht angenommen — sonst waere der Test auch dann gruen, wenn
        // `zerlegen` heimlich an Zeichengrenzen schnitte.
        let text = format!("{}ö{}", "a".repeat(MAX_STUECK_ROH - 1), "b".repeat(100));
        let stuecke = zerlegen(9, &text).expect("passt");
        assert!(stuecke.len() > 1, "der Fall braucht mindestens zwei Stuecke");
        let Rahmen::Stueck { d, .. } = &stuecke[0] else { panic!("Stueck erwartet") };
        let erstes = pulse_fernsteuerung::base64::dekodiere(d).expect("gueltiges Base64");
        assert_eq!(erstes.len(), MAX_STUECK_ROH);
        assert_eq!(
            erstes.last(),
            Some(&0xC3),
            "das erste Stueck muss mitten im Zeichen enden, sonst prueft der Test nichts"
        );
        assert_eq!(durchreichen(&text), text);
    }

    #[test]
    fn erfundene_stueckzahl_wird_abgelehnt() {
        let mut s = Sammler::neu(9);
        let fehler = s.nimm(&Rahmen::Stueck { id: 9, i: 0, n: u32::MAX, d: "aGE=".into() });
        assert!(fehler.is_err(), "n = u32::MAX muss abgelehnt werden, vor jeder Allokation");
    }

    #[test]
    fn hoechste_ehrliche_stueckzahl_geht_durch() {
        // Gegenprobe zur Schranke: sie darf den ehrlichen Sender nicht treffen.
        let text = "z".repeat(MAX_TEXT_BYTE);
        let stuecke = zerlegen(9, &text).expect("genau an der Grenze, muss passen");
        assert!(stuecke.len() as u32 <= MAX_STUECKE, "{} Stuecke gegen Schranke {MAX_STUECKE}", stuecke.len());
        let mut s = Sammler::neu(9);
        assert!(s.nimm(&stuecke[0]).is_ok(), "die Schranke darf einen echten Sender nicht abweisen");
    }
}
