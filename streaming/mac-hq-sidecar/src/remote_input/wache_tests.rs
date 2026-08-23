//! Die Tests der Wache.
//!
//! **Was sie NICHT erreichen, und das ist der Grund fuer `examples/probe_wache.rs`:**
//! der Testbau stellt keinen systemweiten Ereignis-Abgriff auf — er liefe auf
//! der Maschine des Entwicklers. Der Weg, an dem die Zusage haengt (Abgriff
//! aufstellen, Marke lesen, Schwelle anwenden), ist von hier aus unerreichbar.
//! Hier stehen die duennen Weiterleitungen, die Reihenfolge in `starten` und
//! die Startverweigerung; die Wirkung am echten System belegt der Pruefling.

use super::*;
use std::sync::atomic::AtomicUsize;

/// Die Tests fassen dieselben Statics an — nacheinander, nicht nebeneinander.
static REIHUM: Mutex<()> = Mutex::new(());

fn stumm() -> MacWache {
    MacWache::neu(|| {})
}

/// Ohne Regung gibt es keinen Vorrang — und die Frist ist eine echte Zahl.
///
/// Die Bewegungsschwelle selbst (`bewegung::zaehlt`) samt ihren Tests steht
/// in `pulse_fernsteuerung::bewegung`, die Frist-Rechnung in
/// `pulse_fernsteuerung::frist`. Hier bleibt der Nachweis, dass die duennen
/// Weiterleitungen die richtigen Werte durchreichen.
#[test]
fn ohne_regung_kein_vorrang() {
    let _reihum = REIHUM.lock().unwrap_or_else(|e| e.into_inner());
    LETZTE_REGUNG_MS.store(0, Ordering::Relaxed);
    let w = stumm();
    assert_eq!(w.rest_ms(), 0);
    assert!(!w.host_regt_sich());
    assert!(frist::frist_ms() >= 100);
}

/// Eine Regung setzt den Vorrang, und er laeuft von selbst wieder ab.
#[test]
fn regung_setzt_vorrang() {
    let _reihum = REIHUM.lock().unwrap_or_else(|e| e.into_inner());
    let w = stumm();
    vermerken();
    assert!(w.host_regt_sich());
    assert!(w.rest_ms() > 0);
    LETZTE_REGUNG_MS.store(0, Ordering::Relaxed);
    assert!(!w.host_regt_sich());
}

/// **Der Weg, an dem die Startverweigerung haengt** (Plan, Aufgabe 5,
/// Schritt 5): laesst sich der Abgriff nicht aufstellen, kommt der Fehler
/// bis zum Aufrufer durch — und die Wache gilt danach **nicht** als
/// stehend. Meldete sie faelschlich Erfolg, bekaeme der Host eine Sitzung
/// ohne Vorrang, also genau das still Schwaechere, das die Startverweigerung
/// verhindern soll.
#[test]
fn scheiternder_abgriff_verweigert_den_start() {
    let _reihum = REIHUM.lock().unwrap_or_else(|e| e.into_inner());
    stoppen();
    TEST_SCHEITERT.store(true, Ordering::SeqCst);
    let w = stumm();
    let ergebnis = w.starten();
    TEST_SCHEITERT.store(false, Ordering::SeqCst);
    assert!(ergebnis.is_err(), "der Fehler muss durchgereicht werden");
    assert!(
        !*LAUFEND.lock().unwrap_or_else(|e| e.into_inner()),
        "nach einem gescheiterten Start darf die Wache nicht als stehend gelten"
    );
}

/// Zweimal starten ist einmal starten — der Handschlag ruft es bei jedem
/// Hello.
#[test]
fn starten_ist_idempotent() {
    let _reihum = REIHUM.lock().unwrap_or_else(|e| e.into_inner());
    stoppen();
    let w = stumm();
    assert!(w.starten().is_ok());
    assert!(w.starten().is_ok());
    w.stoppen();
    w.stoppen();
}

/// **Ein laufender Vorrang ueberlebt ein zweites Hello.** Nur ein
/// Neu-Aufstellen nullt den Zaehler; das zweite `starten` steigt vorher aus.
/// Ohne diese Reihenfolge loeschte ein Transportwechsel den Vorrang,
/// waehrend der Host tippt.
#[test]
fn zweites_starten_loescht_keinen_laufenden_vorrang() {
    let _reihum = REIHUM.lock().unwrap_or_else(|e| e.into_inner());
    stoppen();
    let w = stumm();
    w.starten().unwrap();
    vermerken();
    w.starten().unwrap();
    assert!(w.host_regt_sich(), "das zweite Hello darf den Vorrang nicht loeschen");
    w.stoppen();
}

/// Das Aufstellen selbst nullt dagegen — sonst begaenne eine neue Sitzung
/// mit einem Vorrang, den niemand ausgeloest hat (Nachzuegler des alten
/// Abgriffs, den [`stoppen`] bewusst nicht abwartet).
#[test]
fn aufstellen_nullt_die_letzte_regung() {
    let _reihum = REIHUM.lock().unwrap_or_else(|e| e.into_inner());
    stoppen();
    vermerken();
    let w = stumm();
    w.starten().unwrap();
    assert!(!w.host_regt_sich(), "eine neue Wache beginnt ohne Vorrang");
    w.stoppen();
}

/// Der Takt ist Vertragspflicht des Traits: ohne ihn endet ein Vorrang nie
/// von selbst. Der Wecker laeuft nur im Nicht-Testbau — hier wird belegt,
/// dass der Rueckruf ueberhaupt bis zur Wache durchgereicht wird.
#[test]
fn der_takt_wird_durchgereicht() {
    static GERUFEN: AtomicUsize = AtomicUsize::new(0);
    let w = MacWache::neu(|| {
        GERUFEN.fetch_add(1, Ordering::SeqCst);
    });
    (w.tick)();
    assert_eq!(GERUFEN.load(Ordering::SeqCst), 1);
}

/// Die Maske deckt **alle vierzehn** Arten ab, die der Modulkopf nennt — und
/// **nicht** die Abschalt-Meldungen: die kommen unabhaengig davon, und ein
/// Bit dafuer waere ein Hinweis, dass jemand sie fuer maskierbar haelt.
///
/// **Vorher standen hier sieben von vierzehn.** Das ist keine Kleinigkeit:
/// fehlte `RightMouseDown`, saehe die Wache den rechtsklickenden Host nicht,
/// fehlte `LeftMouseDragged`, nicht den ziehenden — beides Faelle, in denen der
/// Host offensichtlich selbst arbeitet. Das *Entfernen* eines Eintrags faengt
/// zufaellig der Compiler (`[CGEventType; 14]`), das *Ersetzen* durch ein
/// Duplikat faengt nur diese Liste.
#[test]
fn maske_deckt_alle_beobachteten_arten() {
    let m = maske();
    let erwartet = [
        CGEventType::LeftMouseDown,
        CGEventType::LeftMouseUp,
        CGEventType::RightMouseDown,
        CGEventType::RightMouseUp,
        CGEventType::MouseMoved,
        CGEventType::LeftMouseDragged,
        CGEventType::RightMouseDragged,
        CGEventType::KeyDown,
        CGEventType::KeyUp,
        CGEventType::FlagsChanged,
        CGEventType::ScrollWheel,
        CGEventType::OtherMouseDown,
        CGEventType::OtherMouseUp,
        CGEventType::OtherMouseDragged,
    ];
    for t in erwartet {
        assert!(m & (1u64 << t.0) != 0, "{t:?} fehlt in der Maske");
    }
    // Und keine doppelt gesetzten Bits verstecken ein fehlendes: genau so viele
    // gesetzte Bits wie Eintraege.
    assert_eq!(
        m.count_ones() as usize,
        erwartet.len(),
        "die Maske hat nicht genau {} Bits — ein Eintrag steht doppelt",
        erwartet.len()
    );
    assert_eq!(m & (1u64 << CGEventType::Null.0), 0, "Null gehoert nicht in die Maske");
}

/// **`stoppen()` hat drei Wirkungen, und jede einzelne war ungeprueft.**
///
/// Die dritte wiegt am schwersten: zaehlt `WACHE_NR` nicht hoch, endet der
/// Abgriff-Faden nie — und da der Sidecar zwischen zwei Streams warm bleibt,
/// sammelt sich je Sitzung ein weiterer systemweiter Abgriff an.
#[test]
fn stoppen_raeumt_alle_drei_merker() {
    let _reihum = REIHUM.lock().unwrap_or_else(|e| e.into_inner());
    stoppen();
    let w = stumm();
    w.starten().unwrap();
    vermerken();
    assert!(w.host_regt_sich(), "Vorbedingung: es gibt einen Vorrang zu raeumen");
    let wecker_vorher = WECKER_NR.load(Ordering::SeqCst);
    let wache_vorher = WACHE_NR.load(Ordering::SeqCst);

    w.stoppen();

    assert!(!w.host_regt_sich(), "die letzte Regung wird mit abgeraeumt — sonst meldete ein noch fallender Wecker einen Vorrang fuer eine Sitzung, die es nicht mehr gibt");
    assert!(
        WECKER_NR.load(Ordering::SeqCst) > wecker_vorher,
        "der Wecker geht ueber seine Laufnummer — ohne das Hochzaehlen laeuft er weiter"
    );
    assert!(
        WACHE_NR.load(Ordering::SeqCst) > wache_vorher,
        "der Abgriff-Faden geht ueber seine Laufnummer — ohne das Hochzaehlen endet er nie und jede Sitzung legt einen weiteren systemweiten Abgriff an"
    );
}

/// Zweimal stoppen ist einmal stoppen — und das zweite Mal zaehlt die
/// Laufnummern **nicht** weiter hoch. Sonst ginge bei jedem Prozessende ein
/// Zaehler los, den niemand liest.
#[test]
fn stoppen_ist_idempotent() {
    let _reihum = REIHUM.lock().unwrap_or_else(|e| e.into_inner());
    stoppen();
    let w = stumm();
    w.starten().unwrap();
    w.stoppen();
    let nach_dem_ersten = WACHE_NR.load(Ordering::SeqCst);
    w.stoppen();
    assert_eq!(WACHE_NR.load(Ordering::SeqCst), nach_dem_ersten);
}

/// **Der Vorteil gegenueber Windows haengt an dieser Entscheidung.** Dort steht
/// im Code, ein abgehaengter Hook falle stillschweigend aus und das Restrisiko
/// sei notiert; macOS meldet es, und der Abgriff laesst sich zurueckholen.
///
/// Faellt `TapDisabledByTimeout` aus der Bedingung, ist der ganze Vorteil weg —
/// und zwar lautlos: die Wache stuende noch da und saehe nichts mehr.
#[test]
fn beide_abschalt_meldungen_werden_erkannt() {
    assert!(ist_abgehaengt(CGEventType::TapDisabledByTimeout));
    assert!(ist_abgehaengt(CGEventType::TapDisabledByUserInput));
}

/// Und gewoehnliche Ereignisse werden **nicht** dafuer gehalten — sonst
/// schaltete die Wache bei jeder Mausbewegung ihren Abgriff neu ein, statt sie
/// zu bewerten.
#[test]
fn gewoehnliche_ereignisse_gelten_nicht_als_abgehaengt() {
    for t in [
        CGEventType::MouseMoved,
        CGEventType::LeftMouseDown,
        CGEventType::KeyDown,
        CGEventType::FlagsChanged,
        CGEventType::ScrollWheel,
        CGEventType::Null,
    ] {
        assert!(!ist_abgehaengt(t), "{t:?} ist keine Abschalt-Meldung");
    }
}

/// **Befund K-1 der Pruefung, und der schwerste der ganzen Etappe.**
///
/// Einspielen und Mithoeren sind zwei verschiedene Freigaben. Der gefaehrliche
/// Fall ist der asymmetrische: der Host hat die Bedienungshilfen, aber nicht
/// die Eingabeueberwachung. Dann wirkt die Injektion, der Abgriff wird erstellt
/// und ist aktiv — **bekommt aber keine Ereignisse**. Der Host tippt und
/// bekommt seinen Rechner nicht zurueck.
///
/// Bis zum 2026-08-23 meldete `starten()` in diesem Fall `Ok`, weil die Prämisse
/// des Plans („CGEventTapCreate scheitert ohne Accessibility") nicht stimmt: ein
/// HOERENDER Abgriff wird auch ohne Freigabe erstellt.
#[test]
fn ohne_eingabeueberwachung_keine_wache() {
    assert!(darf_wachen(crate::berechtigung::STAND_ERTEILT).is_ok());
    for stand in ["denied", "ungefragt", "unbekannt"] {
        let ergebnis = darf_wachen(stand);
        assert!(ergebnis.is_err(), "{stand} darf die Wache nicht stehen lassen");
        let text = ergebnis.unwrap_err();
        assert!(
            text.contains(stand),
            "die Meldung muss den Stand nennen — „verweigert\" und „nie gefragt\" \
             fuehren den Nutzer an verschiedene Stellen: {text}"
        );
        assert!(
            text.contains("Eingabeueberwachung"),
            "die Meldung muss die richtige Freigabe nennen, nicht die Bedienungshilfen: {text}"
        );
    }
}
