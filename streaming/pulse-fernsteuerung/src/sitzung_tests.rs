//! Die Sitzungs-Tests. Bis zum 2026-08-22 liefen sie nur auf Windows; seit die
//! Zustandsmaschine hier liegt, laufen sie auf jeder Maschine.
//!
//! Sitzungs-Zusagen der Fernsteuerung: Freigabe, Handschlag, Sitzungswechsel,
//! fail-closed. Was tatsächlich injiziert wird, prüft `crate::ausfuehrung`.

use crate::format::PROTOKOLL_VERSION;
use crate::pruefstand::{Ereignis, PruefInjektor, PruefUmgebung, PruefWache, ZielAntwort};
use crate::sitzung::{Sitzung, Zustand};

/// Ein vollständiger Prüfstand samt Sitzung.
///
/// **`Box::leak` mit Absicht.** Die Sitzung hält ihre Plattform als
/// `&'static dyn` — im Sidecar ist das ein echtes `static`, im Test ein
/// bewusst preisgegebener Kasten. Er lebt bis zum Prozessende, und ein
/// Testlauf hat davon ein paar Dutzend: unmessbar, und dafür braucht kein
/// Test eine Lebensdauer zu verwalten.
struct Stand {
    sitzung: Sitzung,
    inj: &'static PruefInjektor,
    wache: &'static PruefWache,
    umg: &'static PruefUmgebung,
}

fn stand() -> Stand {
    let inj: &'static PruefInjektor = Box::leak(Box::new(PruefInjektor::default()));
    let wache: &'static PruefWache = Box::leak(Box::new(PruefWache::neu()));
    let umg: &'static PruefUmgebung = Box::leak(Box::new(PruefUmgebung::default()));
    Stand { sitzung: Sitzung::neu(inj, wache, umg), inj, wache, umg }
}

/// Ein Hello-Frame, roh.
fn hello() -> Vec<u8> {
    crate::bauen::hello().as_slice().to_vec()
}

/// Eine gedrückte Taste, roh.
fn taste_runter(scan: u16) -> Vec<u8> {
    crate::bauen::taste(scan, true).as_slice().to_vec()
}

/// Ohne echten Stream lässt sich kein Gedrücktes über die Frames aufbauen
/// (es gäbe kein Ziel). Für die Freigabe-Tests wird der Druckzustand
/// deshalb direkt gesetzt — geprüft wird ja, was beim VERWERFEN passiert,
/// nicht wie es dazu kam.
fn gedrueckt(s: &Sitzung, tasten: &[u16], knoepfe: &[u8]) {
    let mut z = s.sperre();
    for t in tasten {
        z.tat.druck.taste(*t, true);
    }
    for k in knoepfe {
        z.tat.druck.knopf(*k, true);
    }
}

fn ist_noch_gedrueckt(s: &Sitzung) -> usize {
    s.sperre().tat.druck.anzahl()
}

/// Welche Knopf-Ereignisse in der Spur stehen — die Freigabe läuft über eine
/// Menge, ihre Reihenfolge ist also nicht festgelegt; **welche** Knöpfe
/// hochgehen, sehr wohl.
fn knopf_ereignisse(spur: &[Ereignis]) -> Vec<Ereignis> {
    spur.iter().filter(|e| matches!(e, Ereignis::Knopf { .. })).copied().collect()
}

/// Sagt der Prüfstand „kein Strom auf diesem Platz", ist der Slot unbekannt:
/// still verworfen, **kein** Fehler — die Sitzung darf daran nicht sterben.
#[test]
fn unbekannter_slot_beendet_die_sitzung_nicht() {
    let s = stand();
    *s.umg.ziel.lock().unwrap() = ZielAntwort::KeinStrom;
    let b = s
        .sitzung
        .frames(9, Some("test-unbekannter-slot"), &[hello()], false)
        .expect("unbekannter Slot ist kein Fehler");
    assert_eq!(b.zustand, "unknown_slot");
    assert_eq!(b.verarbeitet, 0);
    s.sitzung.beenden();
}

/// **Der Fund:** eine verworfene Nachricht gab früher zurück, ohne
/// freizugeben — alles Gedrückte blieb am Host physisch gedrückt. Es
/// genügt, dass der Host sein gestreamtes Fenster minimiert, damit die
/// Quelle nicht mehr auflöst und das Key-Up in diesem Zweig verschwindet.
///
/// **Zwei Fallstricke im Aufbau**, beide erst beim Mutationstest der
/// Umschichtung aufgefallen — die Windows-Fassung dieses Tests hatte sie
/// beide und belegte damit ihre eigene Behauptung nicht: die Sitzung muss
/// **vorher** stehen (sonst gibt schon der Sitzungswechsel frei), und in der
/// verworfenen Nachricht darf **kein Hello** liegen (sonst gibt der
/// Handschlag frei). Nur dann hängt die Freigabe wirklich am Verwerf-Pfad.
/// Gegenprobe: streicht man das `loslassen` in `nur_handschlag`, wird dieser
/// Test rot — vorher blieb er grün.
#[test]
fn verworfene_nachricht_gibt_trotzdem_frei() {
    let s = stand();
    *s.umg.ziel.lock().unwrap() = ZielAntwort::KeinStrom;
    s.sitzung
        .frames(9, Some("test-freigabe"), &[hello()], false)
        .expect("der Handschlag stellt die Sitzung her");
    let _ = s.inj.nimm();

    gedrueckt(&s.sitzung, &[0x11, 0xE01D], &[0]); // W, rechte Strg, linke Maustaste
    let b = s
        .sitzung
        .frames(9, Some("test-freigabe"), &[taste_runter(0x11)], false)
        .expect("unbekannter Slot ist kein Fehler");
    assert_eq!(b.zustand, "unknown_slot");
    assert_eq!(ist_noch_gedrueckt(&s.sitzung), 0, "nichts darf gedrückt bleiben");

    // Und es wurde wirklich losgelassen, nicht nur vergessen: für jede
    // Taste ein Hoch-Ereignis, für den Knopf ein Knopf-Ereignis.
    let spur = s.inj.nimm();
    assert!(
        spur.contains(&Ereignis::Taste { scan: 0x11, down: false }),
        "W-Taste nicht losgelassen: {spur:?}"
    );
    assert!(
        spur.contains(&Ereignis::Taste { scan: 0xE01D, down: false }),
        "rechte Strg-Taste nicht losgelassen: {spur:?}"
    );
    assert_eq!(
        knopf_ereignisse(&spur),
        vec![Ereignis::Knopf { btn: 0, down: false }],
        "genau ein Knopf-Hoch: {spur:?}"
    );
    assert_eq!(spur.len(), 3, "und sonst nichts: {spur:?}");
    s.sitzung.beenden();
}

/// **Der Fund (Hello):** ein zweites Hello setzte nur `begruesst` und ließ
/// nichts los. Die Spezifikation ist hier normativ — „neuer Eingabestrom", der
/// Host gibt frei und beginnt leer —, und die Gegenseite baut darauf: der
/// Steuernde leert beim Stromwechsel seine eigene Gedrückt-Menge, ohne
/// Hoch-Ereignisse zu senden. Ohne die Freigabe hier bleibt die Taste am
/// fremden Rechner unten, bis die ganze Sitzung endet.
#[test]
fn zweites_hello_gibt_alles_frei_und_beginnt_leer() {
    let s = stand();
    let mut z = Zustand { begruesst: true, ..Zustand::default() };
    z.tat.zeiger = Some((600, 500));
    z.tat.druck.taste(0x11, true);
    z.tat.druck.knopf(0, true);

    s.sitzung.handschlag(&mut z, PROTOKOLL_VERSION).expect("ein weiteres Hello ist erlaubt");

    assert!(z.begruesst, "der Handschlag gilt weiter");
    assert_eq!(z.tat.druck.anzahl(), 0, "nichts darf gedrückt bleiben");
    assert_eq!(z.tat.zeiger, None, "leerer Zustand schließt die Zeigerlage ein");
    let spur = s.inj.nimm();
    assert!(
        spur.contains(&Ereignis::Taste { scan: 0x11, down: false }),
        "die Taste muss wirklich losgelassen worden sein: {spur:?}"
    );
    assert_eq!(
        knopf_ereignisse(&spur),
        vec![Ereignis::Knopf { btn: 0, down: false }],
        "und der Knopf auch: {spur:?}"
    );
}

/// Eine fremde Fassung bleibt fail-closed — auch als zweites Hello.
#[test]
fn hello_mit_fremder_fassung_wird_abgewiesen() {
    let s = stand();
    let mut z = Zustand { begruesst: true, ..Zustand::default() };
    assert!(s.sitzung.handschlag(&mut z, 1).is_err(), "v1 hat nie ausgeliefert");
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
    let s = stand();
    let mut z = Zustand::default();
    let b = s
        .sitzung
        .nur_handschlag(&mut z, &[hello()], "unresolved_source")
        .expect("ein verworfener Slot ist kein Protokollfehler");
    assert_eq!(b.zustand, "unresolved_source");
    assert_eq!(b.verarbeitet, 0, "die Eingabe zählt nicht als verarbeitet");
    assert!(z.begruesst, "der Handschlag muss trotzdem gelten");

    // Missgeformtes wird auf diesem Pfad nicht bewertet: die Eingabe ist
    // ohnehin weg, und ein Rennen ist kein Angriff.
    let mut z = Zustand::default();
    assert!(s.sitzung.nur_handschlag(&mut z, &[vec![0xFF, 0x00]], "masked").is_ok());
    assert!(!z.begruesst);

    // Eine falsche Hello-Fassung dagegen ist kein Rennen.
    let mut z = Zustand::default();
    assert!(s.sitzung.nur_handschlag(&mut z, &[vec![0x00, 1]], "masked").is_err());
}

/// Dasselbe über die ganze Sitzung: das Hello kommt an, während der Slot
/// unbekannt ist — danach ist die Sitzung begrüßt.
#[test]
fn handschlag_ueberlebt_den_unbekannten_slot() {
    let s = stand();
    *s.umg.ziel.lock().unwrap() = ZielAntwort::KeinStrom;
    let b = s.sitzung.frames(9, Some("test-handschlag"), &[hello()], false).unwrap();
    assert_eq!(b.zustand, "unknown_slot");
    assert!(
        s.sitzung.sperre().begruesst,
        "der Handschlag darf nicht mit der Eingabe verworfen werden"
    );
    s.sitzung.beenden();
}

/// **Der Fund:** fehlte `session_id`, wurde gar nicht verglichen — die
/// Nachricht erbte `begruesst` und die Gedrückt-Menge der Vorgängersitzung.
/// „Kein Feld" ist eine eigene Sitzung, keine Fortsetzung der fremden.
#[test]
fn nachricht_ohne_kennung_erbt_die_vorgaengersitzung_nicht() {
    let s = stand();
    *s.umg.ziel.lock().unwrap() = ZielAntwort::KeinStrom;
    s.sitzung.frames(9, Some("test-A"), &[hello()], false).unwrap();
    assert!(s.sitzung.sperre().begruesst);
    gedrueckt(&s.sitzung, &[0x11], &[0]);
    let _ = s.inj.nimm();

    let b = s.sitzung.frames(9, None, &[], false).expect("kein Protokollfehler");
    assert_eq!(b.zustand, "unknown_slot");
    assert_eq!(ist_noch_gedrueckt(&s.sitzung), 0, "das Gedrückte der alten Sitzung");
    assert!(!s.sitzung.sperre().begruesst, "und ihr Handschlag");
    assert!(
        s.inj.nimm().contains(&Ereignis::Taste { scan: 0x11, down: false }),
        "wirklich losgelassen, nicht nur vergessen"
    );
    s.sitzung.beenden();
}

/// Dieselbe Zusage auf dem Weg über die Hülle: ein missgeformter Slot ist
/// ein Protokollfehler — stilllegen, aber nicht ohne Freigabe.
#[test]
fn protokollfehler_der_huelle_gibt_frei_und_legt_still() {
    let s = stand();
    gedrueckt(&s.sitzung, &[0x11], &[]);
    let fehler = s.sitzung.protokollfehler("slot ist keine Zahl".to_string());
    assert!(fehler.contains("slot"));
    assert_eq!(ist_noch_gedrueckt(&s.sitzung), 0);
    assert!(
        s.inj.nimm().contains(&Ereignis::Taste { scan: 0x11, down: false }),
        "die gedrückte Taste muss losgelassen worden sein"
    );
    // Stillgelegt: weitere Frames werden abgewiesen, bis beendet wird.
    assert!(s.sitzung.frames(0, None, &[hello()], false).is_err());
    s.sitzung.beenden();
    s.sitzung.beenden();
}

/// Nach dem endgültigen Schluss (Prozessende) darf **nichts** mehr
/// injiziert werden — auch nicht von einer Nachricht, die im Dispatch-Faden
/// schon auf der Sperre wartete, während der Writer-Faden freigab und
/// `process::exit` ansteuerte.
#[test]
fn nach_endgueltigem_schluss_wird_nichts_mehr_eingespielt() {
    let s = stand();
    gedrueckt(&s.sitzung, &[0x11], &[]);
    assert_eq!(s.sitzung.beenden_endgueltig(), 1);
    let _ = s.inj.nimm();
    let b = s
        .sitzung
        .frames(0, Some("test-nach-schluss"), &[taste_runter(0x11)], false)
        .expect("geschlossen ist kein Fehler, nur folgenlos");
    assert_eq!(b.zustand, "ended");
    assert_eq!(b.verarbeitet, 0);
    assert!(s.inj.nimm().is_empty(), "es darf nichts injiziert werden");
    s.sitzung.beenden(); // wieder öffnen
}

/// **Der Fund:** die Sitzung nahm ihre Sperre mit `unwrap()`. Panikt
/// irgendetwas unter der Sperre, panikte danach jeder weitere Zugriff — allen
/// voran `beenden_endgueltig()` auf dem Prozess-Ende-Pfad. Dann bliebe am
/// fremden Rechner ALLES gedrückt, und der Prozess wäre weg.
///
/// Der Test vergiftet die Sperre absichtlich und verlangt die Freigabe
/// trotzdem.
#[test]
fn vergiftete_sperre_verhindert_die_freigabe_nicht() {
    let s = stand();
    let gepanikt = std::thread::scope(|faeden| {
        faeden
            .spawn(|| {
                let _gehalten = s.sitzung.sperre();
                panic!("absichtliche Panik unter der Sperre (Teil des Tests, kein Fehlschlag)");
            })
            .join()
    });
    assert!(gepanikt.is_err(), "der Faden muss wirklich panikt haben");
    assert!(s.sitzung.inner.is_poisoned(), "die Sperre muss vergiftet sein");

    gedrueckt(&s.sitzung, &[0x11], &[0]);
    assert_eq!(
        s.sitzung.beenden_endgueltig(),
        2,
        "eine vergiftete Sperre darf die Freigabe nicht verhindern"
    );
    assert!(
        s.inj.nimm().contains(&Ereignis::Taste { scan: 0x11, down: false }),
        "und die Freigabe muss wirklich rausgegangen sein"
    );
    s.sitzung.beenden(); // den endgültigen Schluss zurücknehmen
}

/// Nichts gedrückt → nichts freizugeben, und das beliebig oft.
#[test]
fn beenden_ist_idempotent() {
    let s = stand();
    assert_eq!(s.sitzung.beenden(), 0);
    assert_eq!(s.sitzung.beenden(), 0);
}

// ── Vorrang des Hosts ────────────────────────────────────────────────────────
//
// Im Testbau steht keine echte Wache (kein System-Hook); die Regung des Hosts
// stellt `PruefWache::regen`. Geprüft wird also genau das Stück, das der
// Sitzung gehört: was sie aus einem Vorrang macht.

/// Der Kern der Zusage: regt sich der Host, wird die Fremdeingabe verworfen —
/// und alles Gedrückte geht dabei hoch. Ohne die Freigabe hielte der Host seine
/// eigene Maus, während die W-Taste des Steuernden weiterläuft.
#[test]
fn vorrang_verwirft_die_eingabe_und_gibt_frei() {
    let s = stand();
    gedrueckt(&s.sitzung, &[0x11], &[0]); // W und linke Maustaste
    s.wache.regen(true);

    let b = s
        .sitzung
        .frames(0, Some("test-vorrang"), &[taste_runter(0x11)], false)
        .expect("Vorrang ist kein Protokollfehler");
    assert_eq!(b.zustand, "host_active");
    assert_eq!(b.verarbeitet, 0);
    assert_eq!(ist_noch_gedrueckt(&s.sitzung), 0, "nichts darf gedrückt bleiben");

    let spur = s.inj.nimm();
    assert!(
        spur.contains(&Ereignis::Taste { scan: 0x11, down: false }),
        "W-Taste nicht losgelassen: {spur:?}"
    );
    assert!(
        !spur.contains(&Ereignis::Taste { scan: 0x11, down: true }),
        "und nichts Neues gedrückt: {spur:?}"
    );
    s.sitzung.beenden();
}

/// Der Vorrang ist ein Stummschalten, **kein** Abbruch: die Sitzung steht
/// weiter, und sobald der Host Ruhe gibt, läuft die Eingabe von selbst wieder.
/// Ein Abbruch verlangte einen neuen Consent-Durchgang für jede Handbewegung.
#[test]
fn nach_dem_vorrang_laeuft_die_eingabe_weiter() {
    let s = stand();
    *s.umg.ziel.lock().unwrap() = ZielAntwort::KeinStrom;
    s.wache.regen(true);
    assert_eq!(
        s.sitzung.frames(9, Some("test-vorrang-ende"), &[hello()], false).unwrap().zustand,
        "host_active"
    );
    s.wache.regen(false);
    // Ohne Stream ist der Slot unbekannt — entscheidend ist, dass der Vorrang
    // NICHT mehr greift und die Sitzung nie einen Fehler geliefert hat.
    assert_eq!(
        s.sitzung.frames(9, Some("test-vorrang-ende"), &[hello()], false).unwrap().zustand,
        "unknown_slot"
    );
    s.sitzung.beenden();
}

/// **Der Handschlag überlebt den Vorrang.** Fiele er weg, liefe die nächste
/// Nachricht in „Eingabe vor dem Hello-Handschlag" — also in fail-closed —, und
/// eine Handbewegung des Hosts beendete die ganze Sitzung. Dieselbe Regel wie
/// bei Sichtschutz und unbekanntem Slot.
#[test]
fn hello_gilt_auch_unter_vorrang() {
    let s = stand();
    s.wache.regen(true);
    s.sitzung.frames(0, Some("test-vorrang-hello"), &[hello()], false).expect("kein Fehler");
    assert!(s.sitzung.sperre().begruesst, "das Hello muss trotz Vorrang gelten");
    s.sitzung.beenden();
}

/// **Die gemerkte Zeigerlage wird entwertet.** Während des Vorrangs führt der
/// Host seinen Zeiger selbst; der erste Klick danach dürfte nicht auf der alten
/// Lage feuern, sondern erst nach einer frischen Bewegung des Steuernden (die
/// binnen eines Bildtakts kommt). Dieselbe Regel wie bei einer verworfenen
/// Bewegung.
#[test]
fn vorrang_entwertet_die_zeigerlage() {
    let s = stand();
    {
        let mut z = s.sitzung.sperre();
        z.begruesst = true;
        z.tat.zeiger = Some((600, 500));
    }
    s.wache.regen(true);
    s.sitzung.frames(0, Some("test-vorrang-lage"), &[hello()], false).expect("kein Fehler");
    assert_eq!(s.sitzung.sperre().tat.zeiger, None, "die Lage darf nicht stehen bleiben");
    s.sitzung.beenden();
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
    let s = stand();
    *s.umg.ziel.lock().unwrap() = ZielAntwort::KeinStrom;
    gedrueckt(&s.sitzung, &[0x11], &[]);
    let b = s
        .sitzung
        .frames(0, Some("test-fremd"), &[hello()], true)
        .expect("ein fremder Vorrang ist kein Protokollfehler");
    assert_eq!(b.zustand, "host_active");
    assert_eq!(ist_noch_gedrueckt(&s.sitzung), 0, "auch der fremde Vorrang gibt frei");
    assert!(s.sitzung.sperre().begruesst, "und der Handschlag überlebt ihn");
    // Er hinterlässt aber KEINEN eigenen Vorrang: die nächste Nachricht ohne
    // Flag läuft wieder durch (hier bis zum unbekannten Slot).
    assert_eq!(
        s.sitzung.frames(9, Some("test-fremd"), &[hello()], false).unwrap().zustand,
        "unknown_slot"
    );
    s.sitzung.beenden();
}

/// Der Übergang läuft **einmal**, nicht bei jeder Nachricht: die Freigabe ist
/// an den Wechsel gebunden, nicht an den Zustand. Ohne das flösse bei 125
/// Nachrichten je Sekunde ein Strom aus Meldungen und WinRT-Aufrufen.
#[test]
fn der_uebergang_laeuft_nur_einmal() {
    let s = stand();
    s.wache.regen(true);
    assert!(
        s.sitzung.vorrang_nachfuehren(&mut s.sitzung.sperre()),
        "erster Ruf stellt den Vorrang"
    );
    gedrueckt(&s.sitzung, &[0x11], &[]);
    let _ = s.inj.nimm();
    assert!(
        s.sitzung.vorrang_nachfuehren(&mut s.sitzung.sperre()),
        "zweiter Ruf: unverändert"
    );
    assert!(
        s.inj.nimm().is_empty(),
        "ein unveränderter Zustand darf nichts erneut freigeben"
    );
    s.sitzung.beenden();
}
