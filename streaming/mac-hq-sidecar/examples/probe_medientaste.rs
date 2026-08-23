//! Wird eine injizierte **F8** unterwegs zur Medientaste?
//!
//! Auf einem Mac sind F7/F8/F9 ab Werk Zurück/Wiedergabe/Vor. Alle drei stehen
//! im Vokabular der Fernsteuerung. Deutet macOS ein injiziertes `kVK_F8` in ein
//! Wiedergabe-Ereignis um, dann pausiert ein Steuernder die Musik des Hosts,
//! statt F8 zu senden — und zwar ohne dass irgendwo ein Fehler entstuende.
//!
//! ## Warum diese Messung nichts ausloest
//!
//! Der naheliegende Versuch — F8 injizieren und nachsehen, ob Musik startet —
//! hat eine Nebenwirkung und beantwortet die Frage trotzdem nur halb: er sagt
//! nicht, **was** ankommt. Hier haengt stattdessen ein **aktiver** Abgriff
//! (`CGEventTapOptions::Default`, nicht `ListenOnly`) an `kCGSessionEventTap` —
//! also hinter dem WindowServer, wo eine Umdeutung bereits geschehen waere, und
//! vor der Anwendung. Er liest ab, was dort liegt, und gibt fuer Tasten- und
//! Systemereignisse im Messfenster einen Nullzeiger zurueck: das Ereignis ist
//! damit verworfen und erreicht keine Anwendung.
//!
//! Das Messfenster ist eng (nur waehrend der eigenen Injektion). Waehrend eines
//! Laufs nicht tippen — was in dieser Zeit ankommt, wird verworfen, auch echte
//! Tastendruecke.
//!
//! ## Was die Zahlen bedeuten
//!
//! * `Typ 10/11` mit `keycode 100` = `kVK_F8` — **keine** Umdeutung, F8 kommt
//!   als F8 an.
//! * `Typ 14` (NSSystemDefined) = Umdeutung in ein Medien-Ereignis
//!   (`NX_KEYTYPE_PLAY`). Dann braucht die Tastentabelle eine Sonderbehandlung.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use objc2_core_foundation::{CFMachPort, CFRunLoop, kCFRunLoopDefaultMode};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventTapProxy, CGEventType,
};
use pulse_fernsteuerung::druck::Druck;
use pulse_fernsteuerung::plattform::Injektor;
use pulse_mac_hq_sidecar::remote_input::injektion::{MacInjektor, PULSE_MARKE};

static MESSEN: AtomicBool = AtomicBool::new(false);
/// (Ereignistyp, Tastencode, zurueckgelesene Marke, verworfen)
static GESEHEN: Mutex<Vec<(i64, i64, i64, bool)>> = Mutex::new(Vec::new());

/// Ereignisarten, die im Messfenster nicht weitergereicht werden: Tastendruck,
/// Loslassen, Umschalttasten-Wechsel und `NSSystemDefined` — die vier, in denen
/// eine F8 stecken koennte, gleich wie sie gedeutet wurde.
fn zurueckhalten(typ: i64) -> bool {
    matches!(typ, 10 | 11 | 12 | 14)
}

unsafe extern "C-unwind" fn abgriff(
    _proxy: CGEventTapProxy,
    typ: CGEventType,
    ereignis: NonNull<CGEvent>,
    _info: *mut c_void,
) -> *mut CGEvent {
    if typ == CGEventType::TapDisabledByTimeout || typ == CGEventType::TapDisabledByUserInput {
        return ereignis.as_ptr();
    }
    let t = typ.0 as i64;
    if !MESSEN.load(Ordering::SeqCst) {
        return ereignis.as_ptr();
    }
    let e = unsafe { ereignis.as_ref() };
    let marke = CGEvent::integer_value_field(Some(e), CGEventField::EventSourceUserData);
    let code = CGEvent::integer_value_field(Some(e), CGEventField::KeyboardEventKeycode);
    let weg = zurueckhalten(t);
    GESEHEN.lock().unwrap().push((t, code, marke, weg));
    if weg {
        // Nullzeiger = verworfen. Deshalb loest dieser Lauf nichts aus, auch
        // wenn die Antwort „ja, wird umgedeutet" lautet.
        return std::ptr::null_mut();
    }
    ereignis.as_ptr()
}

fn main() {
    let tap = unsafe {
        CGEvent::tap_create(
            CGEventTapLocation::SessionEventTap,
            CGEventTapPlacement::HeadInsertEventTap,
            // **Aktiv, nicht hoerend** — nur so laesst sich das Ereignis
            // zurueckhalten.
            CGEventTapOptions::Default,
            u64::MAX,
            Some(abgriff),
            std::ptr::null_mut(),
        )
    }
    .expect("kein Abgriff — fehlt die Bedienungshilfen-Freigabe?");
    let quelle = CFMachPort::new_run_loop_source(None, Some(&tap), 0).expect("RunLoop-Quelle");
    let schleife = CFRunLoop::current().expect("RunLoop");
    let modus = unsafe { kCFRunLoopDefaultMode };
    schleife.add_source(Some(&quelle), modus);
    CGEvent::tap_enable(&tap, true);

    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let inj = MacInjektor::neu().expect("Injektor");
        let leer = Druck::default();
        MESSEN.store(true, Ordering::SeqCst);
        // Scancode Satz 1 0x42 = F8 (Tabelle: → kVK_F8 = 100).
        inj.taste(0x42, true, &leer);
        std::thread::sleep(std::time::Duration::from_millis(120));
        inj.taste(0x42, false, &leer);
        std::thread::sleep(std::time::Duration::from_millis(250));
        MESSEN.store(false, Ordering::SeqCst);
    });

    CFRunLoop::run_in_mode(modus, 1.5, false);

    let gesehen = GESEHEN.lock().unwrap();
    println!("PULSE_MARKE = {PULSE_MARKE:#x}, kVK_F8 = 100\n");
    if gesehen.is_empty() {
        println!("FEHL nichts gesehen — kam die Injektion nicht durch?");
        std::process::exit(1);
    }
    for (typ, code, marke, weg) in gesehen.iter() {
        println!(
            "  Typ {typ:>3}  keycode {code:>4}  Marke {}  {}",
            if *marke == PULSE_MARKE { "ja  " } else { "nein" },
            if *weg { "→ verworfen" } else { "→ durchgereicht" }
        );
    }
    let umgedeutet = gesehen.iter().any(|(t, ..)| *t == 14);
    let als_f8 = gesehen.iter().any(|(t, c, ..)| (*t == 10 || *t == 11) && *c == 100);
    println!();
    if umgedeutet {
        println!("BEFUND: F8 wird umgedeutet — ein NSSystemDefined (Typ 14) ist aufgetaucht.");
        println!("        Die Tastentabelle braucht dafuer eine Sonderbehandlung.");
    } else if als_f8 {
        println!("BEFUND: keine Umdeutung — F8 kommt hinter dem WindowServer als kVK_F8 an.");
    } else {
        println!("BEFUND: unklar — weder Typ 14 noch keycode 100 gesehen.");
        std::process::exit(1);
    }
}
