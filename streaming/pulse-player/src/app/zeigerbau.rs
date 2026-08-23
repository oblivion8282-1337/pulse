//! Aus dem, was über die Leitung kommt, einen Zeiger bauen — und ihn behalten.
//!
//! Der gewöhnliche Weg ([`super::zeigerform`]) übersetzt einen **Namen** in eine
//! winit-Form; das ist der bessere, wo er trägt, weil dann der lokale Zeiger in
//! der Größe und dem Thema dieses Rechners gezeichnet wird. Für alles, was
//! Windows nicht selbst mitbringt — die Rasierklinge einer Schnittanwendung,
//! den Werkzeugzeiger einer Bildbearbeitung, den Achsenzeiger eines
//! 3D-Programms — schickt der Host stattdessen die **Pixel**
//! (`streaming/win-hq-sidecar/src/remote_input/zeigerpixel.rs`). Hier werden sie
//! entpackt und zu einem Zeiger gemacht, den das Fenster tragen kann.
//!
//! ## Warum ein Vorrat
//!
//! `create_custom_cursor` legt beim Betriebssystem einen echten Zeiger an. Das
//! bei jeder Meldung zu tun, hiesse zehnmal je Sekunde einen neuen anzulegen und
//! den vorigen wegzuwerfen — für ein Bild, das sich gar nicht geändert hat. Der
//! Vorrat merkt sich das Gebaute unter der **Kennung**, die der Host mitschickt;
//! deshalb kann der auch nur sie schicken, sobald ein Bild einmal übertragen
//! wurde.
//!
//! ## Fremdmaterial
//!
//! Was hier hereinkommt, stammt vom Rechner eines anderen und ist über den
//! Gateway gelaufen. Jede Angabe wird deshalb geprüft, bevor sie winit erreicht
//! ([`crate::zeigerbild`] hält die Grenzen) — und **jeder** Fehlschlag ist
//! stumm: der Aufrufer setzt dann die Form, die als Name mitkam, also im
//! Zweifel den Standardpfeil. Ein Zeiger ist Rückmeldung, kein Auftrag; er darf
//! nichts zu Fall bringen.

use std::collections::HashMap;

use winit::event_loop::ActiveEventLoop;
use winit::window::CustomCursor;

use crate::fernsteuerung::rahmen::dekodiere;
use crate::proto::Zeigerbildrahmen;
use crate::zeigerbild::Zeigerbild;

/// Wie viele gebaute Zeiger behalten werden.
///
/// Passt zu dem, was der Host als „drüben bekannt" führt (`MAX_BEKANNT` in
/// `pulse-fernsteuerung/src/zeigerbuch.rs`) — beide Seiten sollen zur selben Zeit
/// vergessen, sonst schickt der Host eine blosse Kennung für ein Bild, das hier
/// längst weg ist. Schlimmstenfalls kostet das eine Sekunde Standardpfeil (bis
/// die Auffrischung das Bild wieder ganz bringt), aber je gleichmässiger die
/// beiden Zahlen sind, desto seltener passiert es.
const MAX_VORRAT: usize = 64;

/// Die gebauten Zeiger dieser Sitzung, nach Kennung.
#[derive(Default)]
pub(super) struct Vorrat {
    fertig: HashMap<String, CustomCursor>,
}

impl Vorrat {
    /// Den Zeiger zu diesem Rahmen — aus dem Vorrat, oder frisch gebaut.
    ///
    /// `None` heisst „nimm den Namen": entweder trägt der Rahmen keine Daten
    /// (der Host hielt das Bild für bekannt, hier ist es aber nicht) oder er
    /// ist fehlerhaft.
    pub(super) fn holen(
        &mut self,
        rahmen: &Zeigerbildrahmen,
        event_loop: &ActiveEventLoop,
    ) -> Option<CustomCursor> {
        if rahmen.id.is_empty() {
            return None;
        }
        if let Some(fertig) = self.fertig.get(&rahmen.id) {
            return Some(fertig.clone());
        }
        let bild = entpacken(rahmen)?;
        // `from_rgba` prüft noch einmal selbst (Masse, Haltepunkt, Punktzahl) —
        // die Prüfung davor ist trotzdem nicht überflüssig: sie ist die, deren
        // Regeln wir kennen, und sie fängt ab, was gar nicht erst zugeteilt
        // werden soll.
        let quelle = CustomCursor::from_rgba(
            bild.punkte,
            bild.breite,
            bild.hoehe,
            bild.halt_x,
            bild.halt_y,
        )
        .ok()?;
        let zeiger = event_loop.create_custom_cursor(quelle);
        // Beim Überlaufen ganz leeren statt einzeln altern — dieselbe
        // Entscheidung wie beim Host, und aus demselben Grund: die Buchführung
        // darüber, welcher am längsten nicht gebraucht wurde, wäre teurer als
        // das gelegentliche Neubauen.
        if self.fertig.len() >= MAX_VORRAT {
            self.fertig.clear();
        }
        self.fertig.insert(rahmen.id.clone(), zeiger.clone());
        Some(zeiger)
    }
}

/// Einen Rahmen von der Leitung in ein Bild verwandeln.
fn entpacken(rahmen: &Zeigerbildrahmen) -> Option<Zeigerbild> {
    let daten = rahmen.daten.as_deref()?;
    let laeufe = dekodiere(daten).ok()?;
    Zeigerbild::entpacken(rahmen.w, rahmen.h, rahmen.hx, rahmen.hy, &laeufe).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rahmen(daten: Option<&str>) -> Zeigerbildrahmen {
        Zeigerbildrahmen {
            id: "abc".to_string(),
            w: 2,
            h: 2,
            hx: 0,
            hy: 0,
            daten: daten.map(str::to_string),
        }
    }

    /// Was der Host packt, muss hier wieder herauskommen — über beide Stufen,
    /// Läufe und Base64. Der Test baut das Wort mit demselben Verfahren, das
    /// drüben sendet; die beiden Enden haben keinen anderen gemeinsamen
    /// Prüfstein.
    #[test]
    fn ein_gepacktes_bild_kommt_zurueck() {
        let vorher = Zeigerbild {
            breite: 2,
            hoehe: 2,
            halt_x: 0,
            halt_y: 0,
            punkte: vec![1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 1, 2, 3, 255],
        };
        let wort = crate::fernsteuerung::rahmen::kodiere(&vorher.packen().unwrap());
        assert_eq!(entpacken(&rahmen(Some(&wort))), Some(vorher));
    }

    /// Ohne Daten gibt es nichts zu bauen — das ist der Regelfall für ein Bild,
    /// das der Host für bekannt hält. Kein Fehler, nur kein Bild.
    #[test]
    fn ohne_daten_kein_bild() {
        assert_eq!(entpacken(&rahmen(None)), None);
    }

    /// **Jede Form des Prüfsteins kommt hier an.**
    ///
    /// Der Prüfstein (`streaming/zeigerbild-formen.json`) hält fest, was der
    /// SENDER erzeugt; dieselbe Datei prüfen der Renderer
    /// (`web/test/zeigerbild-formen.test.ts`) und der Sender selbst
    /// (`pulse-fernsteuerung/src/zeigerbuch.rs`). Der Sinn steht in der
    /// Datei: am 2026-08-17 verlangte die Prüfung im Renderer Felder, die die
    /// Kurzform gar nicht hat — beide Seiten hatten grüne Tests, weil keiner
    /// über die Sprachgrenze sah.
    ///
    /// Geprüft wird, was diese Datei entscheiden kann: die Vollform muss sich
    /// entpacken lassen, die Kurzform darf es ausdrücklich **nicht** — sie
    /// trägt keine Daten und wird über den Vorrat aufgelöst, nicht hier.
    #[test]
    fn jede_form_des_pruefsteins_wird_richtig_behandelt() {
        let pruefstein: serde_json::Value =
            serde_json::from_str(include_str!("../../../zeigerbild-formen.json"))
                .expect("Prüfstein ist gültiges JSON");
        let formen = pruefstein["formen"].as_array().expect("Liste 'formen'");
        assert!(formen.len() >= 2, "mindestens Kurz- und Vollform");
        let mut kurz = 0;
        let mut voll = 0;
        for form in formen {
            let r: Zeigerbildrahmen = serde_json::from_value(form["bild"].clone())
                .expect("der Rahmen muss sich lesen lassen");
            assert!(!r.id.is_empty(), "jede Form trägt eine Kennung");
            match r.daten {
                None => {
                    kurz += 1;
                    assert_eq!(entpacken(&r), None, "die Kurzform trägt kein Bild");
                }
                Some(_) => {
                    voll += 1;
                    let bild = entpacken(&r).expect("die Vollform muss sich entpacken lassen");
                    assert!(bild.stimmig());
                    assert_eq!(bild.breite, r.w);
                    assert_eq!(bild.hoehe, r.h);
                }
            }
        }
        assert!(kurz >= 1 && voll >= 1, "beide Ausprägungen müssen vorkommen");
    }

    /// Fremdmaterial: kaputte Wörter und Masse, die nicht zu den Daten passen,
    /// führen zu „kein Bild" — nie zu einem Absturz und nie zu einem Bild, das
    /// winit dann abweisen müsste.
    #[test]
    fn missgeformtes_ergibt_kein_bild() {
        for wort in ["nicht base64!", "AAA", "A===", "-w==", "AAAA"] {
            assert_eq!(entpacken(&rahmen(Some(wort))), None, "{wort:?}");
        }
    }

}
