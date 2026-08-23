//! Tests zu [`super`].
//!
//! ## Was hier prueft — und was ausdruecklich nicht
//!
//! Geprueft wird die **Entscheidung** eines Weckers: was hinausgeht, wann der
//! Rueckfall kippt, und dass seine beiden Haelften zusammen hinausgehen. Alles
//! davon ist reine Rechnung mit Argumenten und laeuft auf jeder Maschine.
//!
//! Nicht geprueft wird, was ScreenCaptureKit daraus macht — dafuer gibt es
//! `examples/probe_zeigerecho.rs` und den Zwei-Geraete-Lauf. Und nicht
//! geprueft wird die Buchfuehrung selbst: die hat ihre Tests in
//! `pulse-fernsteuerung/src/zeigerbuch.rs` und gilt fuer jeden Sender.
//!
//! ## Die eine Zahl, die hier bewusst NICHT festgenagelt ist
//!
//! Wie oft aufgefrischt wird, gehoert der Kiste (einmal je Sekunde bei
//! 100-ms-Weckern). [`die_auffrischung_geht_auch_ohne_wechsel_hinaus`] haelt
//! deshalb nur fest, was der SENDER zu verantworten hat: dass ueberhaupt
//! aufgefrischt wird und nicht bei jedem Wecker. Eine hier abgeschriebene Zahl
//! ginge beim naechsten Verstellen drueben still auseinander.

use super::*;
use pulse_zeigerbild::Zeigerbild;
use std::cell::{Cell, RefCell};

/// Ein 2x2-Zeiger aus lauter gleichen Punkten. Verschiedene Fuellungen ergeben
/// verschiedene Kennungen — mehr braucht die Entscheidung hier nicht.
fn probe_bild(fuellung: u8) -> Zeigerbild {
    Zeigerbild { breite: 2, hoehe: 2, halt_x: 1, halt_y: 0, punkte: vec![fuellung; 2 * 2 * 4] }
}

/// Der Regelfall dieser Plattform: ein eigenes Bild.
fn mit_bild() -> Stand {
    Stand::Eigen(probe_bild(9))
}

/// Der Rueckfall-Fall: die Abfrage hat nichts geliefert
/// (`zeigerform::ermitteln_mit` macht daraus die Vorgabe).
fn ohne_bild() -> Stand {
    Stand::Name(VORGABE)
}

/// Ein frisches Buch. **Nicht `&mut Zeigerbuch::LEER`** — das ist eine
/// Konstante, und jede Nennung erzeugt eine eigene Kurzzeit-Kopie; ein Test,
/// der ueber mehrere Runden zaehlt, zaehlte dann jedes Mal ab null.
fn leeres_buch() -> Zeigerbuch {
    Zeigerbuch::LEER
}

/// Ein Rueckfall-Stand, wie ihn der Wecker hereinreicht. `seit_meldung: 0` =
/// gerade eben gemeldet, also weit vor der naechsten Wiederholung.
fn stand(gilt: bool) -> Rueckfallstand {
    Rueckfallstand { gilt, seit_meldung: 0 }
}

fn lage() -> Zeigerlage {
    *LAGE.lock().unwrap_or_else(|e| e.into_inner())
}

// ── Die Vorrang-Weiche ──────────────────────────────────────────────────────

/// **Bei Vorrang des Hosts geht die Vorgabe hinaus — und die Abfrage bleibt
/// ungestellt.**
///
/// Beides steht als Pflicht im Kopf von `pulse_fernsteuerung::zeigerbuch`. Wer
/// die Weiche vergisst, meldet dem Steuernden den I-Balken einer Bewegung, die
/// gar nicht seine ist; wer nur die Weiche baut und trotzdem ermittelt, laesst
/// AppKit arbeiten, waehrend der Host selbst am Rechner sitzt.
#[test]
fn bei_vorrang_geht_die_vorgabe_hinaus_und_die_abfrage_bleibt_ungestellt() {
    let gefragt = Cell::new(0u8);
    let ermitteln = || {
        gefragt.set(gefragt.get() + 1);
        mit_bild()
    };
    let r = runde(&mut leeres_buch(), stand(false), true, ermitteln);
    assert_eq!(gefragt.get(), 0, "bei Vorrang wird der Systemzeiger nicht abgefragt");
    let n = r.form.expect("die erste Form meldet immer");
    assert_eq!(n["shape"], VORGABE);
    assert!(n.get("bild").is_none(), "bei Vorrang geht auch kein Bild hinaus");
}

/// **Der Vorrang ruehrt den Rueckfall nicht an** — in keiner Richtung. Eine
/// uebersprungene Abfrage sagt nichts darueber aus, ob sie noch traegt; wer sie
/// als „nichts geliefert" wertete, schaltete den Rueckfall bei jeder
/// Handbewegung des Hosts ein und gleich wieder aus.
#[test]
fn der_vorrang_ruehrt_den_rueckfall_nicht_an() {
    for gilt in [false, true] {
        let r = runde(&mut leeres_buch(), stand(gilt), true, mit_bild);
        assert_eq!(r.rueckfall.gilt, gilt, "Rueckfall {gilt} haette stehen bleiben muessen");
        assert_eq!(r.melden, None, "und es gibt nichts zu melden");
    }
}

// ── Der Regelweg ────────────────────────────────────────────────────────────

/// Ohne Vorrang geht das eigene Bild hinaus — und **nicht** unter einem
/// erfundenen Namen. macOS hat keine Namenstabelle (`super::zeigerform`).
#[test]
fn ohne_vorrang_geht_das_eigene_bild_hinaus() {
    let n = runde(&mut leeres_buch(), stand(false), false, mit_bild)
        .form
        .expect("die erste Form meldet immer");
    assert_eq!(n["shape"], VORGABE, "ein eigener Zeiger traegt die Vorgabe als Namen");
    assert!(n["bild"]["daten"].is_string(), "das erste Bild geht ganz hinaus");
}

/// **Die Auffrischung geht auch ohne Wechsel hinaus.**
///
/// Der Gateway verwirft `remote_signal` ueber seinem Sekundendeckel **still**.
/// Ohne Wiederholung bliebe ein verlorener Wechsel fuer den Rest der Sitzung
/// verloren, und niemand kaeme auf die Ursache. Wer hier einen Wechselfilter
/// davorschiebt („dieselbe Form, also nichts senden"), bricht genau diese
/// Selbstheilung — und zwar unsichtbar, denn im Normalfall aendert das nichts.
///
/// Die Schranken sind absichtlich weit (s. Modulkopf): sie trennen „frischt
/// auf" von „frischt nie auf" und von „sendet bei jedem Wecker".
#[test]
fn die_auffrischung_geht_auch_ohne_wechsel_hinaus() {
    const WECKER: usize = 30;
    let mut buch = leeres_buch();
    let meldungen =
        (0..WECKER).filter(|_| runde(&mut buch, stand(false), false, mit_bild).form.is_some()).count();
    assert!(meldungen >= 2, "in {WECKER} Weckern kam keine einzige Auffrischung ({meldungen})");
    assert!(meldungen <= 5, "es wurde bei fast jedem Wecker gemeldet ({meldungen})");
}

// ── Der Rueckfall ───────────────────────────────────────────────────────────

/// Liefert die Abfrage nichts, beginnt der Rueckfall.
#[test]
fn ohne_bild_beginnt_der_rueckfall() {
    assert_eq!(runde(&mut leeres_buch(), stand(false), false, ohne_bild).melden, Some(true));
}

/// Traegt sie wieder, endet er. Ohne diese Richtung bliebe der Steuernde nach
/// einer einzigen misslungenen Abfrage bis zum Sitzungsende ohne eigenen
/// Zeiger.
#[test]
fn mit_bild_endet_der_rueckfall() {
    assert_eq!(runde(&mut leeres_buch(), stand(true), false, mit_bild).melden, Some(false));
}

/// Gemeldet wird nur der **Wechsel**. Sonst ginge zehnmal je Sekunde ein
/// `updateConfiguration` an ScreenCaptureKit und ein Rahmen an den Steuernden.
#[test]
fn ein_unveraenderter_rueckfall_meldet_nichts() {
    assert_eq!(runde(&mut leeres_buch(), stand(false), false, mit_bild).melden, None);
    assert_eq!(runde(&mut leeres_buch(), stand(true), false, ohne_bild).melden, None);
}

/// **Die beiden Haelften des Rueckfalls gehen zusammen hinaus.**
///
/// Nur die Meldung: der Steuernde blendet seinen Zeiger aus und hat gar keinen.
/// Nur die Aufnahme: er hat zwei. Der Mitschreiber faengt beide Richtungen des
/// Fehlers und zusaetzlich ein gekipptes Argument.
#[test]
fn beide_haelften_des_rueckfalls_gehen_zusammen_hinaus() {
    for aktiv in [true, false] {
        let spur = RefCell::new(Vec::new());
        umschalten(
            aktiv,
            |a| spur.borrow_mut().push(("zeiger", a)),
            |a| spur.borrow_mut().push(("meldung", a)),
        );
        assert_eq!(spur.into_inner(), vec![("zeiger", aktiv), ("meldung", aktiv)]);
    }
}

/// Die Felder, auf die der Renderer hoert. Er reicht sie als `remote_signal`
/// `kind:"zeiger_im_bild"` mit `data:{"aktiv":…}` weiter; wer hier umbenennt,
/// muss dort mitziehen.
#[test]
fn die_meldung_traegt_die_felder_der_leitung() {
    for aktiv in [true, false] {
        let m = meldung(aktiv);
        assert_eq!(m["ev"], "remote_pointer_in_frame");
        assert_eq!(m["aktiv"], aktiv);
    }
}

/// **Ein geltender Rueckfall wird wiederholt gemeldet.**
///
/// Der Gateway verwirft `remote_signal` ueber seinem Sekundendeckel still, und
/// den teilt sich diese Meldung mit dem Vorrang, der Zeigerform und dem ganzen
/// ICE-Schwall des P2P-Handschlags. Ginge das erste „aktiv" dabei verloren,
/// saehe der Steuernde bis zum Sitzungsende zwei Zeiger. Die Gegenseite
/// schluckt die Wiederholungen selbst (`web/src/lib/remote/zeigerImBild.ts`) —
/// sie zu senden ist Sache dieses Senders.
#[test]
fn ein_geltender_rueckfall_wird_wiederholt() {
    let mut r = stand(false);
    let mut meldungen = 0;
    for _ in 0..3 * WIEDERHOLUNG_TAKTE {
        let runde = runde(&mut leeres_buch(), r, false, ohne_bild);
        r = runde.rueckfall;
        if runde.melden == Some(true) {
            meldungen += 1;
        }
    }
    assert_eq!(meldungen, 3, "Wechsel plus zwei Wiederholungen in drei Sekunden");
}

/// **Ein beendeter Rueckfall wird NICHT wiederholt.**
///
/// Sonst ginge fuer jede laufende Sitzung je Sekunde ein „nicht aktiv" hinaus,
/// obwohl im Regelfall nie etwas anderes galt — Dauerlast fuer einen Fall, den
/// auf der Gegenseite schon das Zuruecksetzen beim Sitzungsende abfaengt.
#[test]
fn ein_beendeter_rueckfall_wird_nicht_wiederholt() {
    let mut r = stand(true);
    let mut meldungen = Vec::new();
    for _ in 0..3 * WIEDERHOLUNG_TAKTE {
        let runde = runde(&mut leeres_buch(), r, false, mit_bild);
        r = runde.rueckfall;
        meldungen.extend(runde.melden);
    }
    assert_eq!(meldungen, vec![false], "genau einmal ‚nicht mehr aktiv‘, dann Ruhe");
}

/// Die Wiederholung laeuft auch **waehrend des Vorrangs** weiter: er dauert
/// fuenf Sekunden, und in denen kaeme sonst gar nichts nach. Kippen kann der
/// Rueckfall dabei trotzdem nicht — die Abfrage wird ja uebersprungen.
#[test]
fn die_wiederholung_laeuft_auch_bei_vorrang_weiter() {
    let mut r = stand(true);
    let mut meldungen = 0;
    for _ in 0..2 * WIEDERHOLUNG_TAKTE {
        let runde = runde(&mut leeres_buch(), r, true, mit_bild);
        r = runde.rueckfall;
        assert!(r.gilt, "der Vorrang darf den Rueckfall nicht kippen");
        if runde.melden.is_some() {
            meldungen += 1;
        }
    }
    assert_eq!(meldungen, 2, "zwei Wiederholungen in zwei Sekunden");
}

// ── Wer bestimmt, ob der Zeiger in der Aufnahme steht ───────────────────────

/// **Der Rueckfall sticht das Cursor-Echo.**
///
/// Die vierte Zeile ist der Fall, um den es geht: die Sitzung will den
/// Host-Zeiger heraus (absolute Mausbewegung), der Rueckfall braucht ihn drin.
/// Waere die Regel ein blosses `wunsch`, kaempften Wecker und Verteiler
/// gegeneinander — zehnmal je Sekunde herein, bei jeder Mausbewegung wieder
/// hinaus, und der Steuernde saehe ein Flackern statt eines Zeigers.
#[test]
fn der_rueckfall_sticht_den_wunsch_der_sitzung() {
    let f = |wunsch, rueckfall| zeiger_gehoert_in_die_aufnahme(Zeigerlage { wunsch, rueckfall });
    assert!(f(true, false), "ohne Fernsteuerung steht der Zeiger im Bild");
    assert!(!f(false, false), "Cursor-Echo nimmt ihn heraus");
    assert!(f(false, true), "der Rueckfall holt ihn zurueck, auch gegen das Echo");
    assert!(f(true, true), "und beides zugleich bleibt drin");
}

/// Dasselbe ueber die echten Merker dieses Prozesses: ein laufender Rueckfall
/// haelt den Zeiger auch dann im Bild, wenn danach **weitere** absolute
/// Mausbewegungen hereinkommen. Ohne die gemeinsame Lage schriebe die letzte
/// Bewegung den Rueckfall nieder.
#[test]
fn ein_laufender_rueckfall_ueberlebt_weitere_mausbewegungen() {
    let _sperre = crate::remote_input::pruefstand();
    zeiger_der_sitzung(false);
    assert!(!zeiger_gehoert_in_die_aufnahme(lage()), "das Echo hat den Zeiger herausgenommen");

    umschalten(true, |a| lage_aendern(|l| l.rueckfall = a), |_| {});
    assert!(zeiger_gehoert_in_die_aufnahme(lage()), "der Rueckfall holt ihn herein");

    zeiger_der_sitzung(false);
    assert!(zeiger_gehoert_in_die_aufnahme(lage()), "und haelt ihn gegen die naechste Bewegung");
}

/// **Eine geaenderte Lage wird auch angewandt** — und mit dem richtigen Wert.
///
/// Ein Rueckfall, der nur seinen Merker setzt und die Aufnahme nie anfasst,
/// saehe von aussen wie ein Erfolg aus: die Meldung ginge hinaus, der Steuernde
/// blendete seinen Zeiger aus, und im Bild waere trotzdem keiner. Der Test
/// faehrt beide Richtungen ueber dieselbe Naht, die im Betrieb
/// `capture::cursorsteuerung` traegt.
#[test]
fn eine_geaenderte_lage_wird_angewandt() {
    let _sperre = crate::remote_input::pruefstand();
    let gesehen = Cell::new(None);
    lage_aendern_mit(|l| l.wunsch = false, |v| gesehen.set(Some(v)));
    assert_eq!(gesehen.get(), Some(false), "das Cursor-Echo nimmt den Zeiger heraus");
    lage_aendern_mit(|l| l.rueckfall = true, |v| gesehen.set(Some(v)));
    assert_eq!(gesehen.get(), Some(true), "der Rueckfall holt ihn zurueck");
}

// ── Das Sitzungsende ────────────────────────────────────────────────────────

/// **Das Sitzungsende leert das Buch — ueber den Weg, den die Kiste geht.**
///
/// Geprueft wird nicht `Zeigerbuch::zuruecksetzen` (das hat drueben seinen
/// Test), sondern die Verdrahtung: `Sitzung::beenden` ruft
/// `Umgebung::sitzung_beendet`, und das muss hier landen. Bleibt die
/// Trait-Funktion leer, beginnt die naechste Sitzung mit der Annahme, der
/// Steuernde kenne noch die Form vom Ende der vorigen — und meldet ihm die
/// erste Form gar nicht.
#[test]
fn das_sitzungsende_leert_das_buch() {
    let _sperre = crate::remote_input::pruefstand();
    assert!(runde(&mut buch(), stand(false), false, mit_bild).form.is_some(), "die erste Form meldet");
    assert!(runde(&mut buch(), stand(false), false, mit_bild).form.is_none(), "danach schweigt es");

    crate::remote_input::sitzung().beenden();

    let neu = runde(&mut buch(), stand(false), false, mit_bild).form.expect("nach dem Ende meldet es");
    assert!(neu["bild"]["daten"].is_string(), "und zwar wieder mit vollem Bild");
}

/// **Das Sitzungsende raeumt auch den Rueckfall.**
///
/// Bliebe er stehen, faende die naechste Sitzung ihn gesetzt vor, es gaebe
/// keinen Uebergang — und damit keine Meldung. Ihr Steuernder saehe seinen
/// eigenen Zeiger UND den des Hosts im Bild, und zwar bis zum Ende.
#[test]
fn das_sitzungsende_raeumt_den_rueckfall() {
    let _sperre = crate::remote_input::pruefstand();
    umschalten(true, |a| lage_aendern(|l| l.rueckfall = a), |_| {});
    assert!(lage().rueckfall, "Vorbedingung: der Rueckfall gilt");

    crate::remote_input::sitzung().beenden();

    assert_eq!(lage(), LAGE_ANFANG, "das Sitzungsende faellt auf die Ausgangslage zurueck");
    assert_eq!(
        runde(&mut leeres_buch(), stand(lage().rueckfall), false, ohne_bild).melden,
        Some(true),
        "die naechste Sitzung bekommt ihren Uebergang samt Meldung wieder"
    );
}
