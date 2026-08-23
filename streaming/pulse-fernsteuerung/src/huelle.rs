//! `remote_input` — Eingabe-Frames der Fernsteuerung einspielen.
//!
//! Die Hülle des Serverwegs, eins zu eins wie der Gateway sie durchreicht
//! (`services/chat-gateway/.../ws_remote_handlers.py::handle_input`):
//!
//! ```jsonc
//! {"op":"remote_input", "id":7,
//!  "slot":0,                       // welcher der laufenden Streams gemeint ist
//!  "session_id":"…",               // optional; ein Wechsel beendet die alte Sitzung
//!  "host_active":false,            // optional; ein ANDERER Platz meldet Vorrang
//!  "frames":["AAI=", "AwAB"]}      // Base64, IN REIHENFOLGE
//! ```
//!
//! **Auch das Fehlen von `session_id` ist ein Wechsel**
//! ([`crate::sitzung::Sitzung::frames`]): eine Nachricht ohne Feld setzt die
//! Sitzung zurück, statt `begrüßt` und die Gedrückt-Menge der Vorgängersitzung
//! zu erben. Dieser Sidecar verlässt sich ausdrücklich nicht darauf, dass vor
//! ihm jemand geprüft hat.
//!
//! Antwort: `{"ok":true, "processed":<n>, "state":"live"}`. Andere Zustände:
//!
//! | `state` | heißt |
//! |---|---|
//! | `live` | eingespielt |
//! | `unknown_slot` | kein Stream auf diesem Platz → still verworfen, Sitzung steht |
//! | `unresolved_source` | Stream da, Quelle weg (Fenster zu) → verworfen |
//! | `masked` | Sichtschutz schwärzt gerade → verworfen, Gedrücktes freigegeben |
//! | `host_active` | der Host sitzt selbst an Maus/Tastatur → verworfen, bis er Ruhe gibt |
//! | `ended` | Prozess fährt herunter, die Sitzung ist endgültig zu |
//!
//! **Jeder verworfene Zustand gibt alles Gedrückte frei** — die Spezifikation
//! verlangt das ausdrücklich, sonst klemmt eine Taste am fremden Rechner.
//!
//! `ok:false` heißt **fail-closed**: Protokollfehler, die Sitzung ist stillgelegt
//! und muss mit `remote_input_end` beendet werden. Zusätzlich geht ein
//! `{"ev":"remote_state","state":"input_error"}` an den Renderer
//! ([`crate::plattform::Umgebung::fehler_melden`], ausgelöst über
//! [`crate::sitzung::Sitzung::protokollfehler`]).
//!
//! Frame-Format und Koordinaten-Zuordnung: [`crate::rahmen`] bzw.
//! [`crate::zuordnung`], `docs/plans/2026-08-12-input-wire-protokoll-v2.md`.
//!
//! **Was hier NICHT steht:** das `handle()` der jeweiligen Plattform. Es holt
//! die eine Sitzung des Prozesses, ruft [`huelle_lesen`] und
//! [`crate::sitzung::Sitzung::frames`] auf und hüllt einen Protokollfehler in
//! die dortige Fehlerbehandlung (unter Windows `anyhow`). Das sind zehn
//! Zeilen und die einzige Stelle, die den Prozess kennt.

use serde_json::{Map, Value};

use crate::base64;

/// Obergrenze wie beim Gateway (Spezifikation, „Grenzen"): 32 Frames, 1024 Byte
/// dekodiert. Der Gateway erzwingt sie schon — hier steht sie trotzdem, weil der
/// Sidecar sich nicht darauf verlassen darf, dass vor ihm jemand geprüft hat.
const MAX_FRAMES: usize = 32;
const MAX_BYTES: usize = 1024;

/// Der Platz aus der Hülle — **nicht zurechtgebogen**.
///
/// Hier stand `.and_then(Value::as_u64).unwrap_or(0)`: `slot: -1`, `slot: 1.5`
/// und `slot: "0"` liefen damit still auf Platz 0. Auf einem Rechner mit
/// mehreren Streams heißt das ein Klick auf dem falschen Bildschirm — und
/// niemand erfährt davon. Missgeformt ist deshalb ein **Protokollfehler**
/// (fail-closed: stilllegen und alles freigeben).
///
/// Ein Platz **außerhalb des Bereichs** ist etwas anderes und bleibt harmlos:
/// er wandert unverändert weiter und wird eine Ebene tiefer zum „unbekannten
/// Slot" — still verworfen, Sitzung läuft weiter (Spezifikation, „Der `slot`":
/// sonst genügte ein `slot: 999`, um eine laufende Fernsteuerung abzuwürgen).
/// Deshalb wird hier auch **nicht** auf `u32` gekappt, sondern der volle Wert
/// gereicht.
///
/// Fehlt das Feld ganz, ist Platz 0 gemeint: der Prozess fährt genau einen
/// Stream, und das Feld gibt es erst, seit es mehrere geben kann.
fn slot_aus(params: &Map<String, Value>) -> Result<u64, String> {
    match params.get("slot") {
        None | Some(Value::Null) => Ok(0),
        Some(Value::Number(n)) => n
            .as_u64()
            .ok_or_else(|| format!("slot {n} ist keine nicht-negative ganze Zahl")),
        Some(anderes) => Err(format!("slot muss eine Zahl sein, war {anderes}")),
    }
}

/// Die Kennung aus der Hülle. Fehlt sie, ist es eine Sitzung **ohne** Kennung —
/// und damit eine eigene, nicht die Fortsetzung der vorherigen (s. Modul-Doku).
/// Ein Feld, das keine Zeichenkette ist, ist missgeformt: dann lieber
/// fail-closed als eine fremde Sitzung stillschweigend weiterführen.
fn sitzungs_id_aus(params: &Map<String, Value>) -> Result<Option<&str>, String> {
    match params.get("session_id") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(anderes) => Err(format!("session_id muss eine Zeichenkette sein, war {anderes}")),
    }
}

/// Die Frames aus der Hülle dekodieren.
///
/// **Jeder** Fehler hier ist ein Protokollfehler und geht über
/// [`crate::sitzung::Sitzung::protokollfehler`] — zu viele Frames, kaputtes
/// Base64, ein Eintrag der keine Zeichenkette ist, ein fehlendes Feld. Hier
/// standen nackte `anyhow!`: die gingen zwar als `ok:false` zurück, legten die
/// Sitzung aber weder still noch gaben sie das Gedrückte frei — die im Modulkopf
/// zugesagte Eigenschaft „jeder verworfene Zustand gibt frei" galt damit nur
/// meistens. Die Grenzen erzwingt schon der Gateway; kommt hier trotzdem etwas
/// darüber an, stimmt etwas nicht, und dann ist Beenden richtiger als Raten.
fn frames_aus(params: &Map<String, Value>) -> Result<Vec<Vec<u8>>, String> {
    let roh = params
        .get("frames")
        .and_then(Value::as_array)
        .ok_or_else(|| "frames ist Pflicht (Liste von Base64-Zeichenketten)".to_string())?;
    if roh.len() > MAX_FRAMES {
        return Err(format!("höchstens {MAX_FRAMES} Frames je Nachricht"));
    }

    let mut frames: Vec<Vec<u8>> = Vec::with_capacity(roh.len());
    let mut summe = 0usize;
    for wert in roh {
        let text = wert
            .as_str()
            .ok_or_else(|| "frames müssen Base64-Zeichenketten sein".to_string())?;
        let bytes = base64::dekodiere(text).map_err(|e| format!("frames: {e}"))?;
        summe += bytes.len();
        if summe > MAX_BYTES {
            return Err(format!("höchstens {MAX_BYTES} dekodierte Byte je Nachricht"));
        }
        frames.push(bytes);
    }
    Ok(frames)
}

/// Die ganze Hülle lesen. Ein Fehler ist an **jeder** Stelle derselbe: ein
/// Protokollfehler, der die Sitzung stilllegt und alles Gedrückte freigibt.
///
/// Liefert `(slot, session_id, frames)` — die drei Teile, die `handle()` der
/// jeweiligen Plattform (s. Modulkopf) an [`crate::sitzung::Sitzung::frames`]
/// weiterreicht. `handle()` selbst gibt es in dieser Kiste absichtlich nicht.
pub type Huelle<'a> = (u64, Option<&'a str>, Vec<Vec<u8>>);

pub fn huelle_lesen(params: &Map<String, Value>) -> Result<Huelle<'_>, String> {
    Ok((
        slot_aus(params)?,
        sitzungs_id_aus(params)?,
        frames_aus(params)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use crate::pruefstand::{PruefInjektor, PruefUmgebung, PruefWache, ZielAntwort};
    use crate::sitzung::{Bericht, Sitzung};

    fn params(wert: Value) -> Map<String, Value> {
        json!({"slot": wert, "frames": ["AAI="]})
            .as_object()
            .unwrap()
            .clone()
    }

    /// Eine frische, ungeteilte Sitzung — kein globaler Zustand, jeder Test
    /// bekommt seine eigene (s. `lib.rs`-Doku, `pruefstand.rs`-Doku).
    fn frische_sitzung() -> Sitzung {
        let inj: &'static PruefInjektor = Box::leak(Box::new(PruefInjektor::default()));
        let wache: &'static PruefWache = Box::leak(Box::new(PruefWache::neu()));
        let umg: &'static PruefUmgebung = Box::leak(Box::new(PruefUmgebung::default()));
        Sitzung::neu(inj, wache, umg)
    }

    /// Was `handle()` auf jeder Plattform tut (s. Modulkopf) — hier lokal
    /// nachgebaut, weil `handle()` selbst in dieser Kiste nicht existiert: es
    /// ist die eine Stelle, die den Prozess kennt.
    fn wie_handle(sitzung: &Sitzung, params: Map<String, Value>) -> Result<Bericht, String> {
        let (slot, sitzungs_id, frames) = match huelle_lesen(&params) {
            Ok(teile) => teile,
            Err(grund) => return Err(sitzung.protokollfehler(grund)),
        };
        // Wie in `handle()`: fehlt das Feld oder ist es missgeformt, gilt
        // „kein fremder Vorrang" — keiner der Tests hier setzt es.
        let fremder_vorrang = params.get("host_active").and_then(Value::as_bool).unwrap_or(false);
        sitzung.frames(slot, sitzungs_id, &frames, fremder_vorrang)
    }

    /// Fehlt der Platz, ist 0 gemeint; steht er da, gilt er genau so.
    #[test]
    fn platz_wird_genommen_wie_er_dasteht() {
        assert_eq!(slot_aus(&Map::new()), Ok(0));
        assert_eq!(slot_aus(&params(json!(0))), Ok(0));
        assert_eq!(slot_aus(&params(json!(3))), Ok(3));
        // Außerhalb des Bereichs wird NICHT gekappt — eine Ebene tiefer wird
        // daraus „unbekannter Slot", und dafür muss die Zahl echt sein.
        assert_eq!(slot_aus(&params(json!(999))), Ok(999));
        assert_eq!(slot_aus(&params(json!(5_000_000_000u64))), Ok(5_000_000_000));
    }

    /// **Der Fund:** `-1`, `1.5` und `"0"` wurden still auf Platz 0 gebogen —
    /// also auf einen Klick auf dem falschen Bildschirm. Jetzt sind es
    /// Protokollfehler.
    #[test]
    fn missgeformter_platz_wird_nicht_zurechtgebogen() {
        for wert in [json!(-1), json!(1.5), json!("0"), json!(true), json!([0])] {
            assert!(
                slot_aus(&params(wert.clone())).is_err(),
                "slot {wert} hätte abgewiesen werden müssen"
            );
        }
    }

    /// Und über die ganze Operation: missgeformt → `Err` (fail-closed, die
    /// Sitzung ist danach stillgelegt und alles Gedrückte freigegeben).
    #[test]
    fn missgeformter_platz_ist_fail_closed() {
        let sitzung = frische_sitzung();
        assert!(wie_handle(&sitzung, params(json!(-1))).is_err());
        // Stillgelegt — ein wohlgeformter Aufruf kommt jetzt auch nicht durch.
        assert!(wie_handle(&sitzung, params(json!(0))).is_err());
    }

    /// **Der Fund:** zu viele Frames, kaputtes Base64 und ein Nicht-String
    /// gingen als nacktes `anyhow!` zurück — also ohne Freigabe und ohne
    /// Stilllegen. Der missgeformte Slot direkt darüber macht es richtig; hier
    /// galt die Zusage „jeder verworfene Zustand gibt frei" nur meistens.
    ///
    /// Geprüft wird die Stilllegung, denn sie entsteht **nur** über
    /// [`crate::sitzung::Sitzung::protokollfehler`] — und der gibt frei
    /// (belegt in `sitzung_tests.rs`).
    ///
    /// **Die Byte-Grenze braucht eine eigene, direkte Prüfung.** Jeder
    /// tatsächlich gültige Frame ist höchstens 5 Byte lang
    /// ([`crate::rahmen::InputFrame::parse`]), und `MAX_FRAMES` erlaubt
    /// höchstens 32 davon — zusammen also nie mehr als 160 Byte. Ein zu
    /// langer EINZELNER Frame scheitert deshalb so oder so eine Ebene tiefer
    /// am Parser (falsche Länge), MAX_BYTES hin oder her: über `wie_handle`
    /// allein wäre die Byte-Grenze nicht von einem entfernten `if` zu
    /// unterscheiden — beide Fassungen enden fail-closed, nur auf
    /// verschiedenen Wegen. Deshalb prüft `zu_lang` zusätzlich `frames_aus`
    /// direkt: nur so scheitert die Nachricht nachweislich AN DER HÜLLE, nicht
    /// zufällig erst beim Parser dahinter (eine Mutationsprobe hat genau das
    /// bestätigt, s. Bericht).
    #[test]
    fn kaputte_frames_sind_fail_closed() {
        let zu_viele: Vec<Value> = (0..=MAX_FRAMES).map(|_| json!("AAI=")).collect();
        let zu_lang = json!(["A".repeat(2048)]); // 1536 Byte > MAX_BYTES
        for frames in [
            json!(["***"]),        // kein Base64
            json!(["AAI"]),        // Füllung fehlt
            json!([7]),            // kein String
            json!("AAI="),         // gar keine Liste
            json!(zu_viele),
            zu_lang,
        ] {
            let p = json!({"slot": 0, "frames": frames.clone()}).as_object().unwrap().clone();
            assert!(frames_aus(&p).is_err(), "{frames} hätte an der Hülle scheitern müssen");

            let sitzung = frische_sitzung();
            assert!(
                wie_handle(&sitzung, p.clone()).is_err(),
                "{frames} hätte fail-closed sein müssen"
            );
            assert!(
                wie_handle(&sitzung, params(json!(0))).is_err(),
                "{frames} hätte die Sitzung stilllegen müssen"
            );
        }
    }

    /// Eine Kennung, die keine Zeichenkette ist, wäre stillschweigend „keine
    /// Kennung" geworden — fail-closed ist hier billiger als raten.
    #[test]
    fn missgeformte_kennung_ist_fail_closed() {
        assert_eq!(sitzungs_id_aus(&Map::new()), Ok(None));
        let mit = |wert: Value| {
            json!({"slot": 0, "session_id": wert, "frames": ["AAI="]})
                .as_object()
                .unwrap()
                .clone()
        };
        assert_eq!(sitzungs_id_aus(&mit(json!(null))), Ok(None));
        assert_eq!(sitzungs_id_aus(&mit(json!("abc"))), Ok(Some("abc")));
        assert!(sitzungs_id_aus(&mit(json!(7))).is_err());
        let sitzung = frische_sitzung();
        assert!(wie_handle(&sitzung, mit(json!(7))).is_err());
    }

    /// Ein Platz außerhalb des Bereichs dagegen: still verworfen, die Sitzung
    /// läuft weiter. Ein `slot: 999` darf keine Fernsteuerung abwürgen.
    ///
    /// Die Umgebung wird hier ausdrücklich auf `KeinStrom` gestellt — genau
    /// das liefert eine echte Plattform für einen Platz jenseits ihrer
    /// Schranke (`crate::slot::im_bereich`). Was dieser Test zusätzlich zur
    /// Schranken-Prüfung in `slot.rs` belegt: [`huelle_lesen`] weist so einen
    /// Wert nicht selbst zurück, sondern reicht ihn unverändert weiter.
    #[test]
    fn platz_ausserhalb_des_bereichs_verwirft_nur() {
        for wert in [json!(999), json!(5_000_000_000u64)] {
            let inj: &'static PruefInjektor = Box::leak(Box::new(PruefInjektor::default()));
            let wache: &'static PruefWache = Box::leak(Box::new(PruefWache::neu()));
            let umg: &'static PruefUmgebung = Box::leak(Box::new(PruefUmgebung::default()));
            *umg.ziel.lock().unwrap() = ZielAntwort::KeinStrom;
            let sitzung = Sitzung::neu(inj, wache, umg);

            let bericht = wie_handle(&sitzung, params(wert.clone())).expect("kein Protokollfehler");
            assert_eq!(bericht.zustand, "unknown_slot", "slot {wert}");
            assert_eq!(bericht.verarbeitet, 0);
        }
    }
}
