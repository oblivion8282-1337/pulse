//! Tests der beiden Fernsteuer-Ops — und damit der Verdrahtung aus Aufgabe 7.
//!
//! **Hier stand bis zum 2026-08-23, warum ein Frame bis zur Wirkung fehlt:**
//! der macOS-Injektor feuere im Testbau echt ab, ein solcher Test bediente also
//! die Maschine des Entwicklers. Das galt — und ist seit
//! `injektion_spur.rs` erledigt: `Zustand::abfeuern` zeichnet im Testbau auf,
//! statt zu posten. Der Absatz stand danach noch da und haette den naechsten
//! von einem Test abgehalten, der laengst moeglich war.
//!
//! Geprueft wird deshalb jetzt **gegen die Spur**: welcher Ereignistyp, welche
//! Marke, welche Kennzeichnung, welcher Klickstand tatsaechlich abgefeuert
//! worden waeren. Was am Schirm ankommt — also ob der WindowServer daraus macht,
//! was er soll —, bleibt Sache der Prueflinge `examples/probe_injektor` und
//! `examples/probe_wache`.

use serde_json::{Map, Value, json};

use crate::remote_input::injektion::{PULSE_MARKE, spur};
use crate::remote_input::{pruefstand, ziel};
use objc2_core_graphics::{CGEventType, CGMainDisplayID};
use pulse_fernsteuerung::format::Knopf;
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

/// Ein Strom auf dem **echten** Hauptschirm — nur so gibt es ein Rechteck, in
/// das die Anteile fallen koennen. `CGMainDisplayID` braucht keine Freigabe
/// (es fragt keine Aufnahme an), anders als die Schirmliste.
fn strom_auf_dem_hauptschirm() {
    ziel::strom_gestartet(None, ziel::Quelle::Schirm(CGMainDisplayID()));
}

fn frames(rahmen: Vec<Vec<u8>>) -> Map<String, Value> {
    karte(json!({
        "session_id": "s-1",
        "slot": 0,
        "frames": rahmen.iter().map(|r| kodiere(r)).collect::<Vec<_>>(),
    }))
}

/// **Der Test, der in Aufgabe 7 fehlte: ein Frame bis zur Wirkung.**
///
/// Bis hierher belegte kein Test, dass ueber den Op ueberhaupt etwas abgefeuert
/// wird — nur, dass die Antwortkarte stimmt. Geprueft wird gegen die Spur, also
/// gegen das, was `abfeuern` wirklich gesetzt hat.
#[test]
fn ein_frame_wird_bis_zur_wirkung_gefuehrt() {
    let _sperre = pruefstand();
    strom_auf_dem_hauptschirm();
    let _ = spur::nehmen();

    let out = super::handle(frames(vec![
        bauen::hello().as_slice().to_vec(),
        // Mitte des Schirms — der Anteil ist von der Aufloesung unabhaengig.
        bauen::maus_abs(32_767, 32_767).as_slice().to_vec(),
        bauen::maus_knopf(Knopf::Links, true).as_slice().to_vec(),
        bauen::maus_knopf(Knopf::Links, false).as_slice().to_vec(),
    ]))
    .expect("die Frames muessen durchgehen");
    ziel::strom_beendet();

    assert_eq!(out.get("processed").and_then(Value::as_u64), Some(4));
    let spur = spur::nehmen();
    assert!(!spur.is_empty(), "ueber den Op wurde nichts abgefeuert");

    // **Die Marke auf JEDEM Ereignis** — ohne sie haelt die Wache die eigene
    // Spur fuer den Host und sperrt den Steuernden mit seiner ersten Bewegung
    // aus.
    for e in &spur {
        assert_eq!(e.marke, PULSE_MARKE, "ungestempeltes Ereignis: {e:?}");
    }

    let typen: Vec<CGEventType> = spur.iter().map(|e| e.typ).collect();
    assert!(typen.contains(&CGEventType::MouseMoved), "keine Bewegung in {typen:?}");
    assert!(typen.contains(&CGEventType::LeftMouseDown), "kein Knopf runter in {typen:?}");
    assert!(typen.contains(&CGEventType::LeftMouseUp), "kein Knopf hoch in {typen:?}");

    // Der erste Klick ist der erste — der Zaehler laeuft ueber den Op-Weg mit.
    let runter = spur
        .iter()
        .find(|e| e.typ == CGEventType::LeftMouseDown)
        .expect("Knopf runter");
    assert_eq!(runter.klickstand, 1, "der erste Klick traegt Klickstand 1");
}

/// **Und bei Vorrang des Hosts darf nichts hinausgehen.** Der Zustand allein
/// belegt das nicht — er sagt nur, was der Sidecar meldet, nicht was er tut.
#[test]
fn bei_vorrang_wird_nichts_abgefeuert() {
    let _sperre = pruefstand();
    strom_auf_dem_hauptschirm();
    // Handschlag zuerst, sonst gaebe es gar keine Sitzung zu maskieren.
    super::handle(frames(vec![bauen::hello().as_slice().to_vec()])).expect("Handschlag");
    let _ = spur::nehmen();

    let mut p = frames(vec![
        bauen::maus_abs(32_767, 32_767).as_slice().to_vec(),
        bauen::maus_knopf(Knopf::Links, true).as_slice().to_vec(),
    ]);
    // Der Renderer des Hosts haengt `host_active` an jede Nachricht, wenn
    // irgendein Platz Vorrang meldet.
    p.insert("host_active".to_string(), Value::from(true));
    let out = super::handle(p).expect("wird angenommen, aber verworfen");
    ziel::strom_beendet();

    assert_eq!(out.get("state").and_then(Value::as_str), Some("host_active"));
    assert!(
        spur::nehmen().is_empty(),
        "bei Vorrang des Hosts darf kein Ereignis abgefeuert werden"
    );
}
