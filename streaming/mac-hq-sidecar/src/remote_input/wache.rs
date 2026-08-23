//! Die Wache: sitzt der **Host** gerade selbst an Maus und Tastatur?
//!
//! Sie beantwortet die eine Frage, an der der Vorrang haengt: der Host behaelt
//! sein Geraet, indem er es anfasst — bewegt er die Maus oder tippt er, wird
//! die Fremdeingabe fuer [`frist::frist_ms`] verworfen, und jede weitere Regung
//! schiebt die Frist neu.
//!
//! **Wortgleiche Begruendung wie auf Windows** (`win-hq-sidecar/src/
//! remote_input/wache.rs`), nur mit anderem Werkzeug: dort ein
//! Low-Level-Hook, hier ein hoerender Ereignis-Abgriff (`CGEventTapCreate` mit
//! `ListenOnly`). Der naheliegende Weg — die Zeigerlage mit der zuletzt selbst
//! gesetzten vergleichen — traegt auf beiden Systemen nicht: die Injektion
//! wirkt verzoegert, und vor allem **bewegt ein Klick den Zeiger nicht**.
//! Tastatur und Maustasten waeren damit unsichtbar, und gerade sie sind das
//! deutlichste Zeichen, dass der Host selbst arbeitet.
//!
//! ## Die eigene Injektion muss draussen bleiben
//!
//! Der Abgriff sieht auch, was dieser Prozess selbst injiziert. Ungefiltert
//! loeste die erste Mausbewegung des Steuernden den Vorrang aus und sperrte ihn
//! fuer immer aus — die Fernsteuerung schaltete sich selbst ab. Erkannt wird
//! die eigene Spur an [`super::injektion::PULSE_MARKE`] in
//! `kCGEventSourceUserData`, dem Gegenstueck zu Windows' `dwExtraInfo`.
//!
//! **Dass die Marke hier ueberhaupt ankommt, ist gemessen** (2026-08-23,
//! Nachtrag 6 der Messakte): 13 von 13 injizierten Ereignissen tragen sie noch
//! an `kCGSessionEventTap`, also hinter dem WindowServer — auch die beiden
//! Arten, die macOS selbst umformt (`FlagsChanged`, `*Dragged`).
//!
//! **Fremde** Injektion (Makrotasten eines Maustreibers, Bedienhilfen) gilt
//! dagegen ausdruecklich als Host. Die Richtung des Irrtums ist hier alles: ein
//! Fehlalarm kostet den Steuernden fuenf Sekunden und heilt von selbst, ein
//! verpasster Alarm kostet den Host die zugesagte Uebernahme seines eigenen
//! Rechners.
//!
//! ## Was macOS besser kann als Windows
//!
//! Beide Systeme haengen einen zu langsamen Mithoerer ab. **Windows sagt es
//! nie** — dort steht im Code „ein Restrisiko bleibt und ist hier notiert statt
//! weggeschwiegen". macOS meldet es als [`CGEventType::TapDisabledByTimeout`]
//! **im Rueckruf**, und `CGEventTapEnable` stellt den Abgriff wieder her. Diese
//! Luecke ist hier also geschlossen, nicht nur beschrieben (s. [`mithoeren`]).
//!
//! ## Die zwei Faeden
//!
//! Der Rueckruf tut so wenig wie moeglich — einen Zeitstempel ablegen — und
//! fasst **nie** die Sitzungssperre an. Die Uebergaenge (Vorrang beginnt /
//! endet) entstehen an einem 100-ms-Wecker auf einem EIGENEN Faden. Derselbe
//! Schnitt wie auf Windows, aus demselben Grund: die Folgen eines Uebergangs
//! sind kein Nichts, und ein beschaeftigter Mithoerer wird abgehaengt — der
//! Wecker koennte sonst ausgerechnet die Wache abraeumen, die er bedient.

use std::cell::RefCell;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use objc2_core_foundation::{CFMachPort, CFRetained, CFRunLoop, kCFRunLoopDefaultMode};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventMask, CGEventTapLocation, CGEventTapOptions,
    CGEventTapPlacement, CGEventTapProxy, CGEventType,
};

use pulse_fernsteuerung::bewegung::{self, Bewegung};
use pulse_fernsteuerung::frist;
use pulse_fernsteuerung::plattform::Wache;

use super::injektion::PULSE_MARKE;

/// Wann sich der Host zuletzt geregt hat (`jetzt_ms`), `0` = noch nie.
static LETZTE_REGUNG_MS: AtomicU64 = AtomicU64::new(0);

/// Sammelstelle fuer die Bewegungsschwelle. Im Betrieb fasst sie nur der
/// Rueckruf an (der laeuft im Zusammenhang des Wache-Fadens); die Sperre ist
/// deshalb praktisch immer frei, und er nimmt sie mit `try_lock`, damit er
/// unter keinen Umstaenden wartet.
static BEWEGUNG: Mutex<Bewegung> = Mutex::new(Bewegung::neu());

/// Laufnummer des Wache-Fadens. Er prueft sie bei jedem Schleifendurchlauf und
/// geht, sobald sie fremd ist — s. [`faden`].
static WACHE_NR: AtomicU64 = AtomicU64::new(0);

/// Laufnummer des Weckers, dasselbe Muster.
static WECKER_NR: AtomicU64 = AtomicU64::new(0);

/// Steht die Wache? Haelt keine CoreFoundation-Objekte — die gehoeren dem
/// Faden, der sie erzeugt hat (s. [`faden`]).
static LAUFEND: Mutex<bool> = Mutex::new(false);

thread_local! {
    /// Der eigene Abgriff, **nur im Faden, der ihn erzeugt hat**.
    ///
    /// Der Rueckruf braucht ihn, um sich nach einer Zeitueberschreitung selbst
    /// wieder einzuschalten; er laeuft immer in genau diesem Faden. Ein Static
    /// waere hier falsch — CoreFoundation-Handles sind nicht `Sync`, und ein
    /// roher Zeiger darauf haette nur eine Freigabe-Kehrseite eingehandelt.
    static TAP: RefCell<Option<CFRetained<CFMachPort>>> = const { RefCell::new(None) };
}

/// Der RunLoop-Modus, in dem der Abgriff bedient wird.
///
/// Ein `extern static` zu lesen ist fuer Rust unsicher — hier steht die
/// Begruendung einmal, statt an jeder Fundstelle: CoreFoundation legt diese
/// Konstante beim Laden an und aendert sie nie, und die Kiste tippt sie
/// bereits als `Option<&'static CFRunLoopMode>`.
/// **Im Testbau unerreichbar, deshalb der Vermerk:** `starten` steigt dort vor
/// dem Faden aus (kein systemweiter Abgriff auf der Maschine des Entwicklers).
/// Ausdruecklich `cfg_attr(test, …)` und nicht `cfg(not(test))`: so bleibt der
/// Code auch beim `cargo test` uebersetzt und typgeprueft — nur die Meldung ist
/// stumm. Im echten Bau meldet der Compiler toten Code weiter.
#[cfg_attr(test, allow(dead_code))]
fn standard_modus() -> Option<&'static objc2_core_foundation::CFRunLoopMode> {
    unsafe { kCFRunLoopDefaultMode }
}

/// Millisekunden seit dem ersten Blick auf die Uhr — eine monotone Zahl, die in
/// ein Atomic passt (`Instant` tut das nicht).
fn jetzt_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Eine Regung des Hosts vermerken. `max(1)`, weil `0` „noch nie" bedeutet.
fn vermerken() {
    LETZTE_REGUNG_MS.store(jetzt_ms().max(1), Ordering::Relaxed);
}

/// Hat der Host gerade Vorrang?
pub fn host_regt_sich() -> bool {
    frist::host_regt_sich(LETZTE_REGUNG_MS.load(Ordering::Relaxed), jetzt_ms())
}

/// Wie lange der Vorrang noch gilt (0 = kein Vorrang).
pub fn rest_ms() -> u64 {
    frist::rest_ms(LETZTE_REGUNG_MS.load(Ordering::Relaxed), jetzt_ms())
}

/// Welche Ereignisse die Wache sehen will: Bewegung samt Ziehen, alle
/// Maustasten, Rad, Tasten und Umschalttasten-Wechsel.
///
/// Die beiden Abschalt-Meldungen stehen **nicht** darin und muessen es auch
/// nicht: sie kommen unabhaengig von der Maske (s. [`mithoeren`]).
fn maske() -> CGEventMask {
    const ARTEN: [CGEventType; 14] = [
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
    ARTEN.iter().fold(0u64, |m, t| m | (1u64 << t.0))
}

/// Der Mithoerer. Laeuft im Wache-Faden, tut so wenig wie moeglich.
#[cfg_attr(test, allow(dead_code))]
unsafe extern "C-unwind" fn mithoeren(
    _proxy: CGEventTapProxy,
    typ: CGEventType,
    ereignis: NonNull<CGEvent>,
    _info: *mut c_void,
) -> *mut CGEvent {
    // **Der Vorteil gegenueber Windows** (s. Modulkopf): macOS sagt, wenn es
    // den Abgriff abgehaengt hat. Beide Meldungen kommen unabhaengig von der
    // Maske. Auch `DisabledByUserInput` wird wieder eingeschaltet: eine still
    // tote Wache bricht die Zusage des Hosts, und abgebaut wird sie ohnehin
    // nur ueber [`stoppen`], wo der ganze Faden endet.
    if typ == CGEventType::TapDisabledByTimeout || typ == CGEventType::TapDisabledByUserInput {
        TAP.with_borrow(|t| {
            if let Some(tap) = t.as_ref() {
                CGEvent::tap_enable(tap, true);
            }
        });
        eprintln!("[remote-input] Abgriff der Wache war abgehaengt ({typ:?}) — wieder eingeschaltet");
        return ereignis.as_ptr();
    }

    let e = unsafe { ereignis.as_ref() };
    let eigen =
        CGEvent::integer_value_field(Some(e), CGEventField::EventSourceUserData) == PULSE_MARKE;

    // Nur Bewegung traegt eine Schwelle — Knopf und Taste drueckt niemand
    // versehentlich. **Ziehen zaehlt als Bewegung**, nicht als Knopf: es ist
    // dieselbe Handbewegung, macOS gibt ihr nur einen eigenen Ereignistyp.
    let bewegt = matches!(
        typ,
        CGEventType::MouseMoved
            | CGEventType::LeftMouseDragged
            | CGEventType::RightMouseDragged
            | CGEventType::OtherMouseDragged
    );
    if bewegt {
        // **Auch die eigene Bewegung wird eingetragen**, nur eben nicht gezaehlt
        // (s. `bewegung::zaehlt`) — sonst misst die Schwelle den Abstand
        // zwischen den Zeigern beider Seiten und jeder Tischstoss loest aus.
        let ort = CGEvent::location(Some(e));
        if let Ok(mut b) = BEWEGUNG.try_lock()
            && bewegung::zaehlt(&mut b, jetzt_ms(), ort.x as i32, ort.y as i32, eigen)
        {
            vermerken();
        }
    } else if !eigen {
        vermerken();
    }
    ereignis.as_ptr()
}

/// Der Faden: Abgriff aufstellen, Erfolg melden, RunLoop bedienen, aufraeumen.
///
/// **Beendet wird ueber die Laufnummer, nicht ueber `CFRunLoopStop`.** Ein
/// fremder Faden muesste dafuer die RunLoop dieses Fadens in der Hand halten —
/// CoreFoundation-Handles sind nicht `Sync`, und ein roher Zeiger darauf haette
/// ein Freigabe-Rennen eingehandelt. `run_in_mode` mit kurzer Frist kostet
/// nichts (der Faden schlaeft dazwischen) und [`stoppen`] wartet vertragsgemaess
/// ohnehin nicht auf ihn.
#[cfg_attr(test, allow(dead_code))]
fn faden(nr: u64, melden: std::sync::mpsc::Sender<Result<(), String>>) {
    let tap = unsafe {
        CGEvent::tap_create(
            CGEventTapLocation::SessionEventTap,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            maske(),
            Some(mithoeren),
            std::ptr::null_mut(),
        )
    };
    let Some(tap) = tap else {
        // Der eine Grund, aus dem das scheitert: keine Freigabe in den
        // Bedienungshilfen. Der Text nennt sie, damit niemand im Sidecar sucht.
        let _ = melden.send(Err(
            "Abgriff der Wache nicht anmeldbar — fehlt die Freigabe in \
             Systemeinstellungen › Datenschutz & Sicherheit › Bedienungshilfen?"
                .to_string(),
        ));
        return;
    };
    let Some(quelle) = CFMachPort::new_run_loop_source(None, Some(&tap), 0) else {
        let _ = melden.send(Err("RunLoop-Quelle des Abgriffs nicht baubar".to_string()));
        return;
    };
    let Some(schleife) = CFRunLoop::current() else {
        let _ = melden.send(Err("keine RunLoop im Wache-Faden".to_string()));
        return;
    };
    schleife.add_source(Some(&quelle), standard_modus());
    CGEvent::tap_enable(&tap, true);
    TAP.with_borrow_mut(|t| *t = Some(tap));

    if melden.send(Ok(())).is_err() {
        // Niemand wartet mehr (Aufrufer weg) — nicht anfangen zu wachen.
        TAP.with_borrow_mut(|t| *t = None);
        return;
    }
    while WACHE_NR.load(Ordering::SeqCst) == nr {
        CFRunLoop::run_in_mode(standard_modus(), 0.25, false);
    }
    TAP.with_borrow_mut(|t| {
        if let Some(tap) = t.as_ref() {
            CGEvent::tap_enable(tap, false);
        }
        *t = None;
    });
}

/// Der Wecker, der die Uebergaenge ausloest — **auf einem eigenen Faden**.
///
/// Der Vorrang ENDET von selbst, wenn der Host Ruhe gibt, und es kommt kein
/// Ereignis, das ihn beendet. Hinge das Ende an der naechsten Eingabe-Nachricht,
/// erfuehre ein Steuernder, der gerade nur eine Taste haelt und nichts sendet,
/// nie davon — seine Taste bliebe tot, bis er zufaellig die Maus bewegt.
#[cfg_attr(test, allow(dead_code))]
fn wecker_starten(tick: Arc<dyn Fn() + Send + Sync>) {
    let nr = WECKER_NR.fetch_add(1, Ordering::SeqCst) + 1;
    let gebaut = std::thread::Builder::new()
        .name("pulse-fern-wecker".into())
        .spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(frist::WECKER_MS));
                if WECKER_NR.load(Ordering::SeqCst) != nr {
                    return;
                }
                tick();
            }
        });
    if let Err(e) = gebaut {
        // Kein Grund, die Sitzung zu verweigern: die Wache selbst steht, und
        // der Vorrang GREIFT auch ohne Wecker — er wird bei jeder eingehenden
        // Nachricht nachgefuehrt. Nur sein ENDE bliebe liegen, solange der
        // Steuernde nichts sendet.
        eprintln!(
            "[remote-input] Wecker der Wache nicht startbar ({e}) — Vorrang endet erst mit der naechsten Eingabe"
        );
    }
}

/// **Nur im Testbau:** laesst [`starten`] den Abgriff scheitern.
///
/// Ohne diesen Schalter waere der Weg, an dem die Startverweigerung haengt, gar
/// nicht pruefbar — der Testbau stellt keinen echten systemweiten Abgriff auf
/// (er liefe auf der Maschine des Entwicklers). Ein Weg, den kein Test je
/// durchlaeuft, faellt lautlos um.
#[cfg(test)]
static TEST_SCHEITERT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn starten(tick: Arc<dyn Fn() + Send + Sync>) -> Result<(), String> {
    let mut laufend = LAUFEND.lock().unwrap_or_else(|e| e.into_inner());
    if *laufend {
        return Ok(());
    }
    // **Der Zaehler beginnt bei null.** [`stoppen`] nullt zwar selbst, wartet
    // aber bewusst nicht auf den Faden — regt sich der Host in diesem Spalt,
    // traegt der noch lebende alte Abgriff einen Zeitstempel nach, und die
    // naechste Sitzung begaenne mit einem Vorrang, den niemand ausgeloest hat.
    // Nur hier, nicht bei jedem Hello: ein Hello mitten in der Sitzung
    // (Transportwechsel, Notbremse) wuerde sonst einen laufenden Vorrang
    // loeschen, waehrend der Host tippt.
    LETZTE_REGUNG_MS.store(0, Ordering::Relaxed);
    *BEWEGUNG.lock().unwrap_or_else(|e| e.into_inner()) = Bewegung::neu();

    #[cfg(test)]
    {
        // Im Testbau laeuft kein Wecker — der Takt hat hier niemanden zu
        // treiben, und ein Faden je Test waere Rauschen. Dass der Rueckruf
        // ueberhaupt bis zur Wache durchkommt, belegt ein eigener Test.
        let _ = &tick;
        if TEST_SCHEITERT.load(Ordering::SeqCst) {
            return Err("Abgriff der Wache nicht anmeldbar — Testbau".to_string());
        }
        *laufend = true;
        return Ok(());
    }

    #[cfg(not(test))]
    {
        let nr = WACHE_NR.fetch_add(1, Ordering::SeqCst) + 1;
        let (melden, warten) = std::sync::mpsc::channel::<Result<(), String>>();
        std::thread::Builder::new()
            .name("pulse-fern-wache".into())
            .spawn(move || faden(nr, melden))
            .map_err(|e| format!("Wache-Faden nicht startbar: {e}"))?;
        // Kein `recv_timeout`: der Faden meldet sich als Erstes, noch vor der
        // Schleife. Bleibt die Meldung aus, ist er gestorben und der Kanal
        // geschlossen — dann kommt `Err` von selbst.
        match warten.recv() {
            Ok(Ok(())) => {}
            Ok(Err(grund)) => return Err(grund),
            Err(_) => return Err("Wache-Faden endete vor seiner Meldung".to_string()),
        }
        wecker_starten(tick);
        *laufend = true;
        Ok(())
    }
}

fn stoppen() {
    let mut laufend = LAUFEND.lock().unwrap_or_else(|e| e.into_inner());
    if !*laufend {
        return;
    }
    *laufend = false;
    // Die letzte Regung mit abraeumen: der Faden endet erst beim naechsten
    // Schleifendurchlauf, und ein Wecker, der bis dahin noch faellt, meldete
    // sonst einen Vorrang fuer eine Sitzung, die es nicht mehr gibt.
    LETZTE_REGUNG_MS.store(0, Ordering::Relaxed);
    WECKER_NR.fetch_add(1, Ordering::SeqCst);
    WACHE_NR.fetch_add(1, Ordering::SeqCst);
}

/// Die macOS-Wache.
///
/// **Warum sie den Takt als Rueckruf bekommt und nicht selbst die Sitzung
/// holt** (anders als auf Windows, wo der Wecker `super::sitzung()` ruft): so
/// steht sie fuer sich und laesst sich fuer sich abnehmen. Die Sitzung dieses
/// Prozesses entsteht erst mit den Ops; sie reicht dann
/// `Sitzung::vorrang_tick` herein.
pub struct MacWache {
    tick: Arc<dyn Fn() + Send + Sync>,
}

impl MacWache {
    /// `tick` wird alle [`frist::WECKER_MS`] gerufen, solange die Wache steht —
    /// das ist die Vertragspflicht aus dem [`Wache`]-Trait.
    pub fn neu(tick: impl Fn() + Send + Sync + 'static) -> Self {
        Self { tick: Arc::new(tick) }
    }
}

impl Wache for MacWache {
    fn starten(&self) -> Result<(), String> {
        starten(self.tick.clone())
    }

    fn stoppen(&self) {
        stoppen()
    }

    fn host_regt_sich(&self) -> bool {
        host_regt_sich()
    }

    fn rest_ms(&self) -> u64 {
        rest_ms()
    }
}

#[cfg(test)]
#[path = "wache_tests.rs"]
mod wache_tests;
