//! Holt `CGEventTapEnable` einen abgehaengten Abgriff wirklich zurueck?
//!
//! **Warum das eigens geprueft gehoert.** Der Modulkopf von
//! `remote_input::wache` behauptet einen Vorteil gegenueber Windows: dort steht
//! im Code, ein abgehaengter Hook falle stillschweigend aus und das Restrisiko
//! sei notiert — macOS melde es und der Abgriff lasse sich zurueckholen. Die
//! Entscheidung (`ist_abgehaengt`) haelt ein Unit-Test. Die **Wirkung** hielt
//! bis zum 2026-08-23 nichts: eine Mutation, die das `tap_enable(tap, true)`
//! ersatzlos strich, ueberlebte alle Tests und alle Pruefling-Laeufe. Der ganze
//! behauptete Vorteil war gebaut und von nichts beruehrt.
//!
//! ## Aufbau
//!
//! Ein eigener Abgriff mit einem absichtlich **langsamen** Rueckruf: das erste
//! Ereignis laesst ihn zwei Sekunden schlafen. macOS haengt ihn dafuer ab und
//! meldet das als `kCGEventTapDisabledByTimeout` im Rueckruf — genau der Weg,
//! den die Wache benutzt. Danach wird geheilt und geprueft, ob wieder
//! Ereignisse ankommen.
//!
//! **`ListenOnly`, nicht `Default`** — ein hoerender Abgriff haelt die
//! Ereigniskette nicht auf. Mit einem filternden wuerde der schlafende Rueckruf
//! die Maschine zwei Sekunden lang taub stellen.
//!
//! Der Lauf prueft damit den Mechanismus, auf dem die Heilung der Wache beruht,
//! nicht ihren Code — dieselbe Trennung wie ueberall hier: reine Entscheidung
//! im Test, Wirkung am echten System.

use std::cell::RefCell;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

use objc2_core_foundation::{CFMachPort, CFRetained, CFRunLoop, kCFRunLoopDefaultMode};
use objc2_core_graphics::{
    CGEvent, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventTapProxy,
    CGEventType,
};
use pulse_fernsteuerung::druck::Druck;
use pulse_fernsteuerung::plattform::Injektor;
use pulse_mac_hq_sidecar::remote_input::injektion::MacInjektor;

/// Schon einmal geschlafen? Nur das erste Ereignis bremst.
static GEBREMST: AtomicBool = AtomicBool::new(false);
/// Hat macOS den Abgriff abgehaengt und es gemeldet?
static ABGEHAENGT: AtomicBool = AtomicBool::new(false);
/// Ereignisse **nach** der Heilung.
static NACH_HEILUNG: AtomicUsize = AtomicUsize::new(0);
/// Soll geheilt werden? Mit `--ohne-heilung` nicht — das ist die Gegenprobe.
static HEILEN: AtomicBool = AtomicBool::new(true);
static PROTOKOLL: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Die zweite Welle laeuft auf einer eigenen Hoehe, damit sie sich von
/// nachlaufenden Ereignissen der ersten unterscheiden laesst.
const ZWEITE_WELLE_Y: i32 = 700;

/// Wann die Abschalt-Meldung kam und wann das erste Ereignis danach ankam —
/// die Differenz ist die Zeit, in der die Wache blind waere.
static MELDUNG_UM: Mutex<Option<Instant>> = Mutex::new(None);
static ERSTES_DANACH: Mutex<Option<Instant>> = Mutex::new(None);

thread_local! {
    static TAP: RefCell<Option<CFRetained<CFMachPort>>> = const { RefCell::new(None) };
}

unsafe extern "C-unwind" fn mithoeren(
    _proxy: CGEventTapProxy,
    typ: CGEventType,
    ereignis: NonNull<CGEvent>,
    _info: *mut c_void,
) -> *mut CGEvent {
    if typ == CGEventType::TapDisabledByTimeout || typ == CGEventType::TapDisabledByUserInput {
        ABGEHAENGT.store(true, Ordering::SeqCst);
        *MELDUNG_UM.lock().unwrap() = Some(Instant::now());
        PROTOKOLL.lock().unwrap().push(format!("abgehaengt gemeldet: {typ:?}"));
        if HEILEN.load(Ordering::SeqCst) {
            TAP.with_borrow(|t| {
                if let Some(tap) = t.as_ref() {
                    CGEvent::tap_enable(tap, true);
                }
            });
            PROTOKOLL.lock().unwrap().push("geheilt (tap_enable true)".to_string());
        } else {
            // **Direkt nachfragen statt aus dem Ereignisfluss zu raten.**
            let aktiv = TAP.with_borrow(|t| t.as_ref().map(|tap| CGEvent::tap_is_enabled(tap)));
            PROTOKOLL.lock().unwrap().push(format!(
                "NICHT geheilt (Gegenprobe) — tap_is_enabled = {aktiv:?}"
            ));
        }
        return ereignis.as_ptr();
    }
    // **Nur die zweite Welle zaehlt, erkannt an ihrer Hoehe.** Erst zaehlte
    // dieser Lauf alles nach der Abhaeng-Meldung — und die Gegenprobe legte den
    // Fehler offen: es kamen 15 Ereignisse an, obwohl gar nicht geheilt wurde.
    // Das waren gepufferte Ereignisse der ERSTEN Welle, die noch in der
    // RunLoop-Warteschlange standen. Ein Lauf, der sie mitzaehlt, meldet die
    // Heilung als gelungen, auch wenn sie nichts tut.
    let ort = CGEvent::location(Some(unsafe { ereignis.as_ref() }));
    if ABGEHAENGT.load(Ordering::SeqCst) && (ort.y as i32) == ZWEITE_WELLE_Y {
        NACH_HEILUNG.fetch_add(1, Ordering::SeqCst);
        let mut erstes = ERSTES_DANACH.lock().unwrap();
        if erstes.is_none() {
            *erstes = Some(Instant::now());
        }
    } else if !ABGEHAENGT.load(Ordering::SeqCst) && !GEBREMST.swap(true, Ordering::SeqCst) {
        // Der Bremsklotz: einmal lange genug schlafen, dass macOS den Abgriff
        // fuer zu langsam haelt.
        PROTOKOLL.lock().unwrap().push("Rueckruf bremst absichtlich (2 s)".to_string());
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
    ereignis.as_ptr()
}

fn main() {
    HEILEN.store(!std::env::args().any(|a| a == "--ohne-heilung"), Ordering::SeqCst);

    let tap = unsafe {
        CGEvent::tap_create(
            CGEventTapLocation::SessionEventTap,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            u64::MAX,
            Some(mithoeren),
            std::ptr::null_mut(),
        )
    }
    .expect("kein Abgriff — fehlt die Bedienungshilfen-Freigabe?");
    let quelle = CFMachPort::new_run_loop_source(None, Some(&tap), 0).expect("RunLoop-Quelle");
    let schleife = CFRunLoop::current().expect("RunLoop");
    let modus = unsafe { kCFRunLoopDefaultMode };
    schleife.add_source(Some(&quelle), modus);
    CGEvent::tap_enable(&tap, true);
    TAP.with_borrow_mut(|t| *t = Some(tap));

    std::thread::spawn(|| {
        let inj = MacInjektor::neu().expect("Injektor");
        let leer = Druck::default();
        // Erste Welle: bremst den Rueckruf aus.
        for i in 0..40 {
            inj.maus_setzen((600 + i * 5, 500), &leer);
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        // Zweite Welle, nach der Heilung — auf eigener Hoehe (s. oben). Die
        // Pause laesst die Warteschlange der ersten Welle leerlaufen.
        // Kurz warten, damit die Warteschlange der ersten Welle leerlaeuft —
        // aber kurz genug, um die Rueckkehr zeitlich zu fassen.
        std::thread::sleep(std::time::Duration::from_millis(150));
        for i in 0..60 {
            inj.maus_setzen((800 - i * 5, ZWEITE_WELLE_Y), &leer);
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
    });

    CFRunLoop::run_in_mode(modus, 6.0, false);

    // **Der Zustand am ENDE**, aus dem Hauptfaden — im Rueckruf gemessen sagt er
    // nur, wie es im Augenblick der Meldung stand.
    let aktiv_am_ende = TAP.with_borrow(|t| t.as_ref().map(|tap| CGEvent::tap_is_enabled(tap)));
    for zeile in PROTOKOLL.lock().unwrap().iter() {
        println!("  {zeile}");
    }
    println!("  tap_is_enabled am Ende des Laufs = {aktiv_am_ende:?}");
    let luecke = MELDUNG_UM
        .lock()
        .unwrap()
        .and_then(|m| ERSTES_DANACH.lock().unwrap().map(|e| e.duration_since(m)));
    match luecke {
        Some(d) => println!("  erstes Ereignis nach der Meldung: +{} ms", d.as_millis()),
        None => println!("  nach der Meldung kam kein Ereignis mehr an"),
    }
    let abgehaengt = ABGEHAENGT.load(Ordering::SeqCst);
    let danach = NACH_HEILUNG.load(Ordering::SeqCst);
    println!();
    if !abgehaengt {
        println!("FEHL macOS hat den Abgriff nicht abgehaengt — der Bremsklotz war zu kurz.");
        println!("     Ohne Abhaengen sagt dieser Lauf nichts; die Grenze ist nicht dokumentiert.");
        std::process::exit(1);
    }
    println!("OK   macOS meldet das Abhaengen im Rueckruf");
    println!("     Ereignisse der zweiten Welle (y={ZWEITE_WELLE_Y}): {danach}");
    if HEILEN.load(Ordering::SeqCst) {
        if danach > 0 {
            println!("OK   nach tap_enable(true) kommen wieder Ereignisse an");
        } else {
            println!("FEHL nach der Heilung kam nichts mehr — CGEventTapEnable holt ihn nicht zurueck");
            std::process::exit(1);
        }
    } else if danach == 0 {
        println!("OK   Gegenprobe: ohne Heilung bleibt der Abgriff stumm");
    } else {
        println!("BEFUND: der Abgriff liefert ohne Heilung weiter ({danach} Ereignisse).");
        println!("        Die Abschalt-Meldung ist bei einem HOERENDEN Abgriff also");
        println!("        keine dauerhafte Abschaltung. Siehe tap_is_enabled oben.");
    }
}
