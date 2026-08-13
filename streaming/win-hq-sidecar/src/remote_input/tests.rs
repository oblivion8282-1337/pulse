//! Sitzungs-Zusagen der Fernsteuerung: Freigabe, Handschlag, Sitzungswechsel,
//! fail-closed. Was tatsächlich injiziert wird, prüft [`super::ausfuehrung`].

use super::injektion::pruefspur::{self, Ereignis};
use super::*;

/// Ohne echten Stream lässt sich kein Gedrücktes über die Frames aufbauen
/// (es gäbe kein Ziel). Für die Freigabe-Tests wird der Druckzustand
/// deshalb direkt gesetzt — geprüft wird ja, was beim VERWERFEN passiert,
/// nicht wie es dazu kam.
fn gedrueckt(s: &Sitzung, tasten: &[u16], knoepfe: &[u8]) {
    let mut z = s.sperre();
    for t in tasten {
        z.druck.taste(*t, true);
    }
    for k in knoepfe {
        z.druck.knopf(*k, true);
    }
}

fn ist_noch_gedrueckt(s: &Sitzung) -> usize {
    s.sperre().druck.anzahl()
}

/// Ohne laufenden Stream ist jeder Slot unbekannt — mit gesetztem Labor-Schalter
/// dagegen gibt es ein Ersatzrechteck (s. [`super::ziel`]), dann prüfen diese
/// Tests etwas anderes als gemeint.
fn labor_weg() -> bool {
    crate::env::flag("PULSE_LABOR_EINGABE_OHNE_STREAM")
}

/// Ohne Stream (und ohne Labor-Schalter) ist der Slot unbekannt: still
/// verworfen, **kein** Fehler — die Sitzung darf daran nicht sterben.
#[test]
fn unbekannter_slot_beendet_die_sitzung_nicht() {
    let _sperre = pruefstand();
    if labor_weg() {
        return;
    }
    let s = Sitzung::singleton();
    let b = s
        .frames(9, Some("test-unbekannter-slot"), &[vec![0x00, 2]], false)
        .expect("unbekannter Slot ist kein Fehler");
    assert_eq!(b.zustand, "unknown_slot");
    assert_eq!(b.verarbeitet, 0);
    s.beenden();
}

/// **Der Fund:** eine verworfene Nachricht gab früher zurück, ohne
/// freizugeben — alles Gedrückte blieb am Host physisch gedrückt. Es
/// genügt, dass der Host sein gestreamtes Fenster minimiert, damit die
/// Quelle nicht mehr auflöst und das Key-Up in diesem Zweig verschwindet.
#[test]
fn verworfene_nachricht_gibt_trotzdem_frei() {
    let _sperre = pruefstand();
    if labor_weg() {
        return;
    }
    let s = Sitzung::singleton();
    gedrueckt(s, &[0x11, 0xE01D], &[0]); // W, rechte Strg, linke Maustaste
    let b = s
        .frames(9, Some("test-freigabe"), &[vec![0x00, 2]], false)
        .expect("unbekannter Slot ist kein Fehler");
    assert_eq!(b.zustand, "unknown_slot");
    assert_eq!(ist_noch_gedrueckt(s), 0, "nichts darf gedrückt bleiben");

    // Und es wurde wirklich losgelassen, nicht nur vergessen: für jede
    // Taste ein Hoch-Ereignis, für den Knopf ein Maus-Ereignis.
    let spur = pruefspur::nimm();
    assert!(
        spur.contains(&Ereignis::Taste { scan: 0x11, hoch: true }),
        "W-Taste nicht losgelassen: {spur:?}"
    );
    assert!(
        spur.contains(&Ereignis::Taste { scan: 0x1D, hoch: true }),
        "rechte Strg-Taste nicht losgelassen: {spur:?}"
    );
    assert_eq!(
        spur.iter().filter(|e| matches!(e, Ereignis::Maus { .. })).count(),
        1,
        "genau ein Knopf-Hoch: {spur:?}"
    );
    s.beenden();
}

/// **Der Fund (Hello):** ein zweites Hello setzte nur `begruesst` und ließ
/// nichts los. Die Spezifikation ist hier normativ — „neuer Eingabestrom", der
/// Host gibt frei und beginnt leer —, und die Gegenseite baut darauf: der
/// Steuernde leert beim Stromwechsel seine eigene Gedrückt-Menge, ohne
/// Hoch-Ereignisse zu senden. Ohne die Freigabe hier bleibt die Taste am
/// fremden Rechner unten, bis die ganze Sitzung endet.
#[test]
fn zweites_hello_gibt_alles_frei_und_beginnt_leer() {
    let _ = pruefspur::nimm();
    let mut z = Zustand { begruesst: true, zeiger: Some((600, 500)), ..Zustand::default() };
    z.druck.taste(0x11, true);
    z.druck.knopf(0, true);

    handschlag(&mut z, PROTOKOLL_VERSION).expect("ein weiteres Hello ist erlaubt");

    assert!(z.begruesst, "der Handschlag gilt weiter");
    assert_eq!(z.druck.anzahl(), 0, "nichts darf gedrückt bleiben");
    assert_eq!(z.zeiger, None, "leerer Zustand schließt die Zeigerlage ein");
    let spur = pruefspur::nimm();
    assert!(
        spur.contains(&Ereignis::Taste { scan: 0x11, hoch: true }),
        "die Taste muss wirklich losgelassen worden sein: {spur:?}"
    );
    assert_eq!(
        spur.iter().filter(|e| matches!(e, Ereignis::Maus { .. })).count(),
        1,
        "und der Knopf auch: {spur:?}"
    );
}

/// Eine fremde Fassung bleibt fail-closed — auch als zweites Hello.
#[test]
fn hello_mit_fremder_fassung_wird_abgewiesen() {
    let mut z = Zustand { begruesst: true, ..Zustand::default() };
    assert!(handschlag(&mut z, 1).is_err(), "v1 hat nie ausgeliefert");
}

/// **Der Fund:** Slot-Auflösung und Sichtschutz entscheiden, bevor irgendein
/// Frame gelesen wird. Lag das Hello in dieser Nachricht, blieb `begruesst`
/// falsch — und die nächste Nachricht lief in „Eingabe vor dem
/// Hello-Handschlag", also in fail-closed, und der Renderer beendete die ganze
/// Sitzung. Reale Auslöser: der Stream läuft gerade an, der Sichtschutz
/// schwärzt genau dann, der Sidecar wurde nach `stop` neu gestartet.
///
/// Der Handschlag ist Sitzungszustand. Verworfen wird die Eingabe, nicht er.
#[test]
fn handschlag_gilt_auch_wenn_die_eingabe_verworfen_wird() {
    let mut z = Zustand::default();
    let b = nur_handschlag(&mut z, &[vec![0x00, 2]], "unresolved_source")
        .expect("ein verworfener Slot ist kein Protokollfehler");
    assert_eq!(b.zustand, "unresolved_source");
    assert_eq!(b.verarbeitet, 0, "die Eingabe zählt nicht als verarbeitet");
    assert!(z.begruesst, "der Handschlag muss trotzdem gelten");

    // Missgeformtes wird auf diesem Pfad nicht bewertet: die Eingabe ist
    // ohnehin weg, und ein Rennen ist kein Angriff.
    let mut z = Zustand::default();
    assert!(nur_handschlag(&mut z, &[vec![0xFF, 0x00]], "masked").is_ok());
    assert!(!z.begruesst);

    // Eine falsche Hello-Fassung dagegen ist kein Rennen.
    let mut z = Zustand::default();
    assert!(nur_handschlag(&mut z, &[vec![0x00, 1]], "masked").is_err());
}

/// Dasselbe über die ganze Sitzung: das Hello kommt an, während der Slot
/// unbekannt ist — danach ist die Sitzung begrüßt.
#[test]
fn handschlag_ueberlebt_den_unbekannten_slot() {
    let _sperre = pruefstand();
    if labor_weg() {
        return;
    }
    let s = Sitzung::singleton();
    let b = s.frames(9, Some("test-handschlag"), &[vec![0x00, 2]], false).unwrap();
    assert_eq!(b.zustand, "unknown_slot");
    assert!(
        s.sperre().begruesst,
        "der Handschlag darf nicht mit der Eingabe verworfen werden"
    );
    s.beenden();
}

/// **Der Fund:** fehlte `session_id`, wurde gar nicht verglichen — die
/// Nachricht erbte `begruesst` und die Gedrückt-Menge der Vorgängersitzung.
/// „Kein Feld" ist eine eigene Sitzung, keine Fortsetzung der fremden.
#[test]
fn nachricht_ohne_kennung_erbt_die_vorgaengersitzung_nicht() {
    let _sperre = pruefstand();
    if labor_weg() {
        return;
    }
    let s = Sitzung::singleton();
    s.frames(9, Some("test-A"), &[vec![0x00, 2]], false).unwrap();
    assert!(s.sperre().begruesst);
    gedrueckt(s, &[0x11], &[0]);
    let _ = pruefspur::nimm();

    let b = s.frames(9, None, &[], false).expect("kein Protokollfehler");
    assert_eq!(b.zustand, "unknown_slot");
    assert_eq!(ist_noch_gedrueckt(s), 0, "das Gedrückte der alten Sitzung");
    assert!(!s.sperre().begruesst, "und ihr Handschlag");
    assert!(
        pruefspur::nimm().contains(&Ereignis::Taste { scan: 0x11, hoch: true }),
        "wirklich losgelassen, nicht nur vergessen"
    );
    s.beenden();
}

/// Dieselbe Zusage auf dem Weg über die Hülle: ein missgeformter Slot ist
/// ein Protokollfehler — stilllegen, aber nicht ohne Freigabe.
#[test]
fn protokollfehler_der_huelle_gibt_frei_und_legt_still() {
    let _sperre = pruefstand();
    let s = Sitzung::singleton();
    gedrueckt(s, &[0x11], &[]);
    let fehler = s.protokollfehler("slot ist keine Zahl".to_string());
    assert!(fehler.to_string().contains("slot"));
    assert_eq!(ist_noch_gedrueckt(s), 0);
    assert!(
        pruefspur::nimm().contains(&Ereignis::Taste { scan: 0x11, hoch: true }),
        "die gedrückte Taste muss losgelassen worden sein"
    );
    // Stillgelegt: weitere Frames werden abgewiesen, bis beendet wird.
    assert!(s.frames(0, None, &[vec![0x00, 2]], false).is_err());
    s.beenden();
    s.beenden();
}

/// Nach dem endgültigen Schluss (Prozessende) darf **nichts** mehr
/// injiziert werden — auch nicht von einer Nachricht, die im Dispatch-Faden
/// schon auf der Sperre wartete, während der Writer-Faden freigab und
/// `process::exit` ansteuerte.
#[test]
fn nach_endgueltigem_schluss_wird_nichts_mehr_eingespielt() {
    let _sperre = pruefstand();
    let s = Sitzung::singleton();
    gedrueckt(s, &[0x11], &[]);
    assert_eq!(s.beenden_endgueltig(), 1);
    let _ = pruefspur::nimm();
    let b = s
        .frames(0, Some("test-nach-schluss"), &[vec![0x05, 0x11, 0x00, 1]], false)
        .expect("geschlossen ist kein Fehler, nur folgenlos");
    assert_eq!(b.zustand, "ended");
    assert_eq!(b.verarbeitet, 0);
    assert!(pruefspur::nimm().is_empty(), "es darf nichts injiziert werden");
    s.beenden(); // wieder öffnen, sonst sähe der nächste Test „ended"
}

/// **Der Fund:** die Sitzung nahm ihre Sperre mit `unwrap()`. Panikt
/// irgendetwas unter der Sperre, panikte danach jeder weitere Zugriff — allen
/// voran `beenden_endgueltig()` auf dem Prozess-Ende-Pfad. Dann bliebe am
/// fremden Rechner ALLES gedrückt, und der Prozess wäre weg.
///
/// Der Test vergiftet die Sperre absichtlich und verlangt die Freigabe
/// trotzdem. Er vergiftet damit den prozessweiten Singleton für den Rest des
/// Laufs — genau das ist die Probe: alle übrigen Tests müssen weiterlaufen.
#[test]
fn vergiftete_sperre_verhindert_die_freigabe_nicht() {
    let _sperre = pruefstand();
    let s = Sitzung::singleton();
    let _ = std::thread::spawn(|| {
        let _gehalten = Sitzung::singleton().sperre();
        panic!("absichtliche Panik unter der Sperre (Teil des Tests, kein Fehlschlag)");
    })
    .join();
    assert!(s.inner.is_poisoned(), "die Sperre muss vergiftet sein");

    gedrueckt(s, &[0x11], &[0]);
    assert_eq!(
        s.beenden_endgueltig(),
        2,
        "eine vergiftete Sperre darf die Freigabe nicht verhindern"
    );
    assert!(
        pruefspur::nimm().contains(&Ereignis::Taste { scan: 0x11, hoch: true }),
        "und die Freigabe muss wirklich rausgegangen sein"
    );
    s.beenden(); // den endgültigen Schluss zurücknehmen
}

/// Nichts gedrückt → nichts freizugeben, und das beliebig oft.
#[test]
fn beenden_ist_idempotent() {
    let _sperre = pruefstand();
    let s = Sitzung::singleton();
    assert_eq!(s.beenden(), 0);
    assert_eq!(s.beenden(), 0);
}

// ── Vorrang des Hosts ────────────────────────────────────────────────────────
//
// Im Testbau steht keine echte Wache (kein System-Hook, s. `wache::starten`);
// die Regung des Hosts stellt `wache::pruefhilfe`. Geprüft wird also genau das
// Stück, das dieser Datei gehört: was die SITZUNG aus einem Vorrang macht.

/// Der Kern der Zusage: regt sich der Host, wird die Fremdeingabe verworfen —
/// und alles Gedrückte geht dabei hoch. Ohne die Freigabe hielte der Host seine
/// eigene Maus, während die W-Taste des Steuernden weiterläuft.
#[test]
fn vorrang_verwirft_die_eingabe_und_gibt_frei() {
    let _sperre = pruefstand();
    let s = Sitzung::singleton();
    gedrueckt(s, &[0x11], &[0]); // W und linke Maustaste
    wache::pruefhilfe::regung();

    let b = s
        .frames(0, Some("test-vorrang"), &[vec![0x05, 0x11, 0x00, 1]], false)
        .expect("Vorrang ist kein Protokollfehler");
    assert_eq!(b.zustand, "host_active");
    assert_eq!(b.verarbeitet, 0);
    assert_eq!(ist_noch_gedrueckt(s), 0, "nichts darf gedrückt bleiben");

    let spur = pruefspur::nimm();
    assert!(
        spur.contains(&Ereignis::Taste { scan: 0x11, hoch: true }),
        "W-Taste nicht losgelassen: {spur:?}"
    );
    assert!(
        !spur.contains(&Ereignis::Taste { scan: 0x11, hoch: false }),
        "und nichts Neues gedrückt: {spur:?}"
    );
    s.beenden();
}

/// Der Vorrang ist ein Stummschalten, **kein** Abbruch: die Sitzung steht
/// weiter, und sobald der Host Ruhe gibt, läuft die Eingabe von selbst wieder.
/// Ein Abbruch verlangte einen neuen Consent-Durchgang für jede Handbewegung.
#[test]
fn nach_dem_vorrang_laeuft_die_eingabe_weiter() {
    let _sperre = pruefstand();
    if labor_weg() {
        return;
    }
    let s = Sitzung::singleton();
    wache::pruefhilfe::regung();
    assert_eq!(
        s.frames(9, Some("test-vorrang-ende"), &[vec![0x00, 2]], false).unwrap().zustand,
        "host_active"
    );
    wache::pruefhilfe::ruhe();
    // Ohne Stream ist der Slot unbekannt — entscheidend ist, dass der Vorrang
    // NICHT mehr greift und die Sitzung nie einen Fehler geliefert hat.
    assert_eq!(
        s.frames(9, Some("test-vorrang-ende"), &[vec![0x00, 2]], false).unwrap().zustand,
        "unknown_slot"
    );
    s.beenden();
}

/// **Der Handschlag überlebt den Vorrang.** Fiele er weg, liefe die nächste
/// Nachricht in „Eingabe vor dem Hello-Handschlag" — also in fail-closed —, und
/// eine Handbewegung des Hosts beendete die ganze Sitzung. Dieselbe Regel wie
/// bei Sichtschutz und unbekanntem Slot.
#[test]
fn hello_gilt_auch_unter_vorrang() {
    let _sperre = pruefstand();
    let s = Sitzung::singleton();
    wache::pruefhilfe::regung();
    s.frames(0, Some("test-vorrang-hello"), &[vec![0x00, 2]], false).expect("kein Fehler");
    assert!(s.sperre().begruesst, "das Hello muss trotz Vorrang gelten");
    s.beenden();
}

/// **Die gemerkte Zeigerlage wird entwertet.** Während des Vorrangs führt der
/// Host seinen Zeiger selbst; der erste Klick danach dürfte nicht auf der alten
/// Lage feuern, sondern erst nach einer frischen Bewegung des Steuernden (die
/// binnen eines Bildtakts kommt). Dieselbe Regel wie bei einer verworfenen
/// Bewegung.
#[test]
fn vorrang_entwertet_die_zeigerlage() {
    let _sperre = pruefstand();
    let s = Sitzung::singleton();
    {
        let mut z = s.sperre();
        z.begruesst = true;
        z.zeiger = Some((600, 500));
    }
    wache::pruefhilfe::regung();
    s.frames(0, Some("test-vorrang-lage"), &[vec![0x00, 2]], false).expect("kein Fehler");
    assert_eq!(s.sperre().zeiger, None, "die Lage darf nicht stehen bleiben");
    s.beenden();
}

/// **Der Fund (Bughunt 2026-08-14):** die Wache sitzt je Sidecar-PROZESS, und
/// Windows fährt je Stream-Platz einen eigenen. Ein Steuernder, der am
/// Vorrang-Signal sieht, wann der Host eingreift, konnte auf einen Platz
/// ausweichen, dessen Wache noch nie aufgestellt wurde — und dort die Restzeit
/// weiterarbeiten. Der Renderer des Hosts kennt alle Plätze und meldet den
/// fremden Vorrang deshalb mit; hier wird er beachtet, ohne die eigenen
/// Übergänge anzufassen.
#[test]
fn fremder_vorrang_verwirft_auch_ohne_eigene_regung() {
    let _sperre = pruefstand();
    let s = Sitzung::singleton();
    gedrueckt(s, &[0x11], &[]);
    let b = s
        .frames(0, Some("test-fremd"), &[vec![0x00, 2]], true)
        .expect("ein fremder Vorrang ist kein Protokollfehler");
    assert_eq!(b.zustand, "host_active");
    assert_eq!(ist_noch_gedrueckt(s), 0, "auch der fremde Vorrang gibt frei");
    assert!(s.sperre().begruesst, "und der Handschlag überlebt ihn");
    // Er hinterlässt aber KEINEN eigenen Vorrang: die nächste Nachricht ohne
    // Flag läuft wieder durch (hier bis zum unbekannten Slot).
    if !labor_weg() {
        assert_eq!(
            s.frames(9, Some("test-fremd"), &[vec![0x00, 2]], false).unwrap().zustand,
            "unknown_slot"
        );
    }
    s.beenden();
}

/// Der Übergang läuft **einmal**, nicht bei jeder Nachricht: die Freigabe ist
/// an den Wechsel gebunden, nicht an den Zustand. Ohne das flösse bei 125
/// Nachrichten je Sekunde ein Strom aus Meldungen und WinRT-Aufrufen.
#[test]
fn der_uebergang_laeuft_nur_einmal() {
    let _sperre = pruefstand();
    let s = Sitzung::singleton();
    wache::pruefhilfe::regung();
    assert!(vorrang::nachfuehren(&mut s.sperre()), "erster Ruf stellt den Vorrang");
    gedrueckt(s, &[0x11], &[]);
    let _ = pruefspur::nimm();
    assert!(vorrang::nachfuehren(&mut s.sperre()), "zweiter Ruf: unverändert");
    assert!(
        pruefspur::nimm().is_empty(),
        "ein unveränderter Zustand darf nichts erneut freigeben"
    );
    s.beenden();
}

#[test]
fn vermerken_fuehrt_den_druckzustand() {
    let mut druck = Druck::default();
    druck.taste(0x11, true);
    druck.taste(0x1E, true);
    druck.knopf(0, true);
    assert_eq!(druck.anzahl(), 3);
    assert!(druck.knopf_ist_unten(0));
    druck.taste(0x11, false);
    druck.knopf(0, false);
    assert_eq!(druck.anzahl(), 1);
    assert!(!druck.knopf_ist_unten(0));
}
