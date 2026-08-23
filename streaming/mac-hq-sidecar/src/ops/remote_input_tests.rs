//! Tests der beiden Fernsteuer-Ops — und damit der Verdrahtung aus Aufgabe 7.
//!
//! **Was hier bewusst NICHT vorkommt: ein Frame, der wirklich injiziert.**
//! Der macOS-Injektor feuert im Testbau echt ab — er hat keinen Riegel, anders
//! als es der Kommentar in der Windows-Wache fuer seinen Zwilling behauptet
//! (der hat in Wahrheit auch keinen). Ein Test mit einem Maus- oder
//! Tastenrahmen wuerde die Maschine des Entwicklers bedienen: Zeiger springt,
//! Klick geht an das Programm im Vordergrund.
//!
//! Deshalb steht hier nur, was ohne Wirkung auf das System auskommt: der
//! Handschlag (setzt Zustand, injiziert nichts), das Schliessen und die
//! Fehlerwege der Huelle. Was tatsaechlich am Schirm passiert, nehmen die
//! Prueflinge `examples/probe_injektor` und `examples/probe_wache` ab.

use serde_json::{Map, Value, json};

use crate::remote_input::{pruefstand, ziel};
use pulse_fernsteuerung::base64::kodiere;
use pulse_fernsteuerung::bauen;

fn karte(werte: Value) -> Map<String, Value> {
    werte.as_object().expect("Objekt").clone()
}

/// Ein Hello — der Handschlag. Er setzt Zustand und injiziert nichts.
fn hello_karte() -> Map<String, Value> {
    karte(json!({
        "session_id": "s-1",
        "slot": 0,
        "frames": [kodiere(bauen::hello().as_slice())],
    }))
}

/// Der Weg, um den es in Aufgabe 7 geht: Op → Huelle → Sitzung → Antwortkarte,
/// **und zwar gegen einen angemeldeten Strom** — damit haengt hier die
/// Registrierung aus Aufgabe 6 mit der Verdrahtung aus Aufgabe 7 zusammen.
#[test]
fn handschlag_kommt_durch_den_op() {
    let _sperre = pruefstand();
    ziel::strom_gestartet(None, ziel::Quelle::Schirm(0));
    let out = super::handle(hello_karte()).expect("Handschlag muss durchgehen");
    ziel::strom_beendet();
    assert_eq!(out.get("processed").and_then(Value::as_u64), Some(1));
    assert!(out.contains_key("state"), "die Antwortkarte traegt den Zustand");
}

/// **Ohne angemeldeten Strom wird still verworfen** — die eine Ausnahme von
/// fail-closed. Streams enden asynchron, ein Platz kann zwischen Absenden und
/// Ankunft verschwinden; das ist ein Rennen, kein Angriff, und die Sitzung
/// bleibt deshalb stehen statt zu sterben.
///
/// Der Test haelt beides fest: **kein Fehler** und **nichts verarbeitet**.
/// Waere eines davon anders, faellt es hier auf und nicht am fremden Rechner.
#[test]
fn ohne_strom_wird_still_verworfen() {
    let _sperre = pruefstand();
    let out = super::handle(hello_karte()).expect("kein Fehler — nur verworfen");
    assert_eq!(out.get("processed").and_then(Value::as_u64), Some(0));
    assert_eq!(out.get("state").and_then(Value::as_str), Some("unknown_slot"));
}

/// Schliessen ist idempotent und meldet, wie viel freigegeben wurde. Ohne
/// laufende Sitzung ist das null — und **kein Fehler**.
#[test]
fn schliessen_ist_idempotent() {
    let _sperre = pruefstand();
    for _ in 0..2 {
        let out = super::super::remote_input_end::handle(Map::new()).expect("folgenlos");
        assert_eq!(out.get("state").and_then(Value::as_str), Some("ended"));
        assert_eq!(out.get("released").and_then(Value::as_u64), Some(0));
    }
}

/// Nach dem Handschlag schliesst der End-Op die Sitzung wirklich — sonst bliebe
/// sie ueber das Ende hinaus stehen, und der naechste Steuernde faende eine
/// fremde offene Sitzung vor.
#[test]
fn schliessen_beendet_eine_offene_sitzung() {
    let _sperre = pruefstand();
    ziel::strom_gestartet(None, ziel::Quelle::Schirm(0));
    super::handle(hello_karte()).expect("Handschlag");
    let out = super::super::remote_input_end::handle(Map::new()).expect("schliessen");
    assert_eq!(out.get("state").and_then(Value::as_str), Some("ended"));
    // Ein zweiter Handschlag muss danach wieder gehen — die Sitzung ist frei.
    super::handle(hello_karte()).expect("zweiter Handschlag nach dem Schliessen");
}

/// Legt der Fehler die Sitzung wirklich still — oder gibt er nur einen Fehler
/// zurueck?
///
/// **`is_err()` allein unterscheidet das nicht**, und genau darin lag der
/// Altfehler: kaputtes Base64 meldete einen Fehler und liess die Sitzung
/// laufen. Gemessen wird deshalb am Merker, den `stilllegen` ueber
/// `fern_abschalten` mit umlegt. Ein blankes `Err(anyhow!(grund))` statt des
/// Wegs ueber die Sitzung laesst ihn stehen — dann wird dieser Test rot.
fn fehler_legt_still(kaputt: Map<String, Value>) {
    ziel::strom_gestartet(None, ziel::Quelle::Schirm(0));
    super::handle(hello_karte()).expect("Handschlag");
    assert!(crate::remote_input::fern_aktiv(), "nach dem Handschlag laeuft die Sitzung");
    let ergebnis = super::handle(kaputt);
    ziel::strom_beendet();
    assert!(ergebnis.is_err(), "der Fehler muss beim Aufrufer ankommen");
    assert!(
        !crate::remote_input::fern_aktiv(),
        "und die Sitzung muss stillgelegt sein, nicht bloss der Aufruf gescheitert"
    );
}

/// **Der erste der beiden Altfehler, gegen die die Huelle gebaut ist:**
/// `slot: "0"` als Zeichenkette lief frueher still auf Platz 0.
#[test]
fn slot_als_zeichenkette_legt_die_sitzung_still() {
    let _sperre = pruefstand();
    let mut p = hello_karte();
    p.insert("slot".to_string(), Value::from("0"));
    fehler_legt_still(p);
}

/// **Der zweite:** kaputtes Base64 legte die Sitzung frueher nicht still.
#[test]
fn kaputtes_base64_legt_die_sitzung_still() {
    let _sperre = pruefstand();
    let mut p = hello_karte();
    p.insert("frames".to_string(), json!(["!!!kein-base64!!!"]));
    fehler_legt_still(p);
}

/// Beide Ops sind ueber den Dispatch erreichbar — die Verdrahtung selbst.
/// Ohne diesen Test faellt ein vergessener Zweig in `dispatch.rs` erst am
/// echten Geraet auf, und zwar als „der Mac nimmt keine Eingaben an".
#[test]
fn beide_ops_sind_im_dispatch() {
    let _sperre = pruefstand();
    for op in ["remote_input", "remote_input_end"] {
        let antwort = crate::dispatch::handle_request_line(&json!({"op": op, "id": 1}).to_string());
        let text = serde_json::to_string(&antwort).expect("serialisierbar");
        assert!(
            !text.contains("unknown op"),
            "{op} ist im Dispatch nicht verdrahtet: {text}"
        );
    }
}
