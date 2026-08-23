//! Pruefling fuer die macOS-**Wache**: faehrt echte Ereignisse durch den echten
//! Ereignis-Abgriff und laesst die Wache selbst bezeugen, was sie gesehen hat.
//!
//! **Warum es diesen Pruefling braucht.** Der Testbau stellt keinen systemweiten
//! Abgriff auf — er liefe auf der Maschine des Entwicklers. Damit ist der ganze
//! Weg, an dem die Zusage haengt (Abgriff aufstellen, Marke lesen, Schwelle
//! anwenden), von keinem Unit-Test beruehrt. Die acht gruenen Tests in
//! `remote_input::wache` pruefen die duennen Weiterleitungen und die
//! Startverweigerung; **die eine Frage, an der alles haengt, koennen sie nicht
//! beantworten**: bleibt die eigene Injektion draussen?
//!
//! Geht sie nicht draussen, loest die erste Mausbewegung des Steuernden den
//! Vorrang aus und sperrt ihn fuer den Rest der Sitzung aus — die Fernsteuerung
//! schaltet sich selbst ab.
//!
//! **Vorsicht:** der Pruefling bewegt den echten Zeiger. Waehrend eines Laufs
//! nicht die Maus anfassen — eine echte Handbewegung ist genau das, was die
//! Wache melden SOLL, und liesse den Lauf falsch aussehen. Er klickt und tippt
//! nicht.
//!
//! Laeufe (`cargo run --example probe_wache -- <lauf>`):
//!
//! * `eigen` (Vorgabe) — die zentrale Zusage: der eigene Injektor faehrt den
//!   Zeiger quer ueber den Schirm, die Wache bleibt still. `--ohne-marke` ist
//!   die Gegenprobe: derselbe Weg mit ungestempelten Ereignissen MUSS ausloesen.
//!   Erst beide Laeufe zusammen belegen etwas — ein stiller Lauf allein koennte
//!   auch eine Wache sein, die gar nichts sieht.
//! * `schwelle` — ein Zittern unter [`bewegung::SCHWELLE_PX`] loest nicht aus,
//!   ein Sprung darueber sofort. Beide ungestempelt, also aus Sicht der Wache
//!   der Host selbst.
//! * `ablauf` — der Vorrang endet von selbst, ohne dass ein Ereignis ihn
//!   beendet. Die Frist wird dafuer auf 300 ms gekuerzt.

use std::sync::atomic::{AtomicUsize, Ordering};

use objc2_core_foundation::CGPoint;
use objc2_core_graphics::{
    CGEvent, CGEventSource, CGEventSourceStateID, CGEventTapLocation, CGEventType, CGMouseButton,
    CGScrollEventUnit,
};
use pulse_fernsteuerung::bewegung::SCHWELLE_PX;
use pulse_fernsteuerung::plattform::{Injektor, Wache};
use pulse_fernsteuerung::druck::Druck;
use pulse_mac_hq_sidecar::remote_input::injektion::MacInjektor;
use pulse_mac_hq_sidecar::remote_input::wache::MacWache;

/// Wie oft der Takt gerufen wurde — nebenbei der Nachweis, dass der Wecker
/// laeuft (die Vertragspflicht des `Wache`-Traits, die keine Signatur erzwingt).
static TAKTE: AtomicUsize = AtomicUsize::new(0);

/// Eine Bewegung **ohne** Stempel — aus Sicht der Wache also der Host.
///
/// Nicht ueber `MacInjektor`: der stempelt jedes Ereignis, und genau das ist
/// hier nicht gewollt. Eine fremde Quelle ist zugleich die ehrlichere Probe —
/// so sieht eine Makrotaste eines Maustreibers aus, und die soll als Host
/// gelten.
fn fremd_bewegen(x: i32, y: i32) {
    let Some(quelle) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
        eprintln!("keine CGEventSource");
        return;
    };
    let ort = CGPoint { x: f64::from(x), y: f64::from(y) };
    if let Some(e) =
        CGEvent::new_mouse_event(Some(&quelle), CGEventType::MouseMoved, ort, CGMouseButton::Left)
    {
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&e));
    }
}

/// Ein Rad-Ereignis **ohne** Stempel — der Gegenpart zu `inj.maus_rad`.
fn fremd_rad() {
    let Some(quelle) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
        return;
    };
    if let Some(e) = CGEvent::new_scroll_wheel_event2(
        Some(&quelle),
        CGScrollEventUnit::Line,
        1,
        1,
        0,
        0,
    ) {
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&e));
    }
}

fn kurz() {
    std::thread::sleep(std::time::Duration::from_millis(40));
}

fn wache() -> MacWache {
    MacWache::neu(|| {
        TAKTE.fetch_add(1, Ordering::Relaxed);
    })
}

/// Zeigt an, ob der Lauf die Erwartung getroffen hat, und gibt den Ausgangscode.
fn urteil(was: &str, erwartet: bool, ist: bool) -> bool {
    let zeichen = if erwartet == ist { "OK  " } else { "FEHL" };
    println!("{zeichen} {was}: erwartet {erwartet}, gemessen {ist}");
    erwartet == ist
}

fn lauf_eigen(ohne_marke: bool) -> bool {
    let w = wache();
    if let Err(e) = w.starten() {
        eprintln!("Wache nicht aufstellbar: {e}");
        return false;
    }
    kurz();
    let inj = match MacInjektor::neu() {
        Ok(i) => i,
        Err(e) => {
            eprintln!("Injektor nicht baubar: {e}");
            return false;
        }
    };
    let leer = Druck::default();
    // Weit ueber die Schwelle, in vielen Schritten — so wie ein Steuernder
    // fuehrt, nicht als einzelner Sprung.
    for i in 0..30 {
        let x = 400 + i * 20;
        if ohne_marke {
            fremd_bewegen(x, 400);
        } else {
            inj.maus_setzen((x, 400), &leer);
        }
        kurz();
    }
    // **Und jetzt der Zweig, den bis zum 2026-08-23 kein Lauf beruehrt hat**
    // (Befund W-1 der Pruefung): alles, was KEINE Bewegung ist, geht im
    // Mithoerer durch `} else if !eigen {` und vermerkt sofort, ohne Schwelle.
    // Mit `!eigen` → `true` loeste der erste gestempelte Klick des Steuernden
    // den Vorrang aus und jeder weitere schoebe die Frist — dauerhafter
    // Selbstausschluss, und die vier alten Laeufe waren alle gruen.
    //
    // Gewaehlt sind Rad, Seitenknopf und eine reine Umschalttaste: drei Dinge,
    // die durch denselben Zweig laufen und am Schirm folgenlos sind. Ein
    // Linksklick ginge an das Programm im Vordergrund.
    if ohne_marke {
        fremd_rad();
    } else {
        inj.maus_rad(120, 0);
    }
    kurz();
    if !ohne_marke {
        // Seitenknopf X1 und Umschalt — beide gestempelt. Ungestempelt lassen
        // wir sie weg: das Rad oben hat den Fall schon belegt, und ein fremder
        // Knopfdruck ginge an ein fremdes Fenster.
        inj.maus_knopf(3, true);
        kurz();
        inj.maus_knopf(3, false);
        kurz();
        inj.taste(0x2a, true, &leer);
        kurz();
        inj.taste(0x2a, false, &leer);
        kurz();
    }
    let regt_sich = w.host_regt_sich();
    let gut = urteil(
        if ohne_marke {
            "ungestempelte Bewegung und ungestempeltes Rad"
        } else {
            "eigene Injektion: Bewegung, Rad, Knopf und Taste"
        },
        ohne_marke,
        regt_sich,
    );
    if !ohne_marke && regt_sich {
        eprintln!(
            "  → Die Wache haelt die eigene Spur fuer den Host. Genau so sperrt sich\n  \
               die Fernsteuerung mit ihrer ersten Mausbewegung selbst aus."
        );
    }
    w.stoppen();
    gut
}

fn lauf_schwelle() -> bool {
    let w = wache();
    if let Err(e) = w.starten() {
        eprintln!("Wache nicht aufstellbar: {e}");
        return false;
    }
    kurz();
    // Nullpunkt setzen — die erste gesehene Lage zaehlt nie (s. `bewegung`).
    fremd_bewegen(800, 400);
    kurz();
    // Zittern: je 2 px hin und zurueck, Summe bleibt unter der Schwelle, weil
    // das Zeitfenster dazwischen ablaeuft.
    //
    // **Nach JEDEM Schritt pruefen, nicht am Ende** (Befund der Pruefung): die
    // Frist steht in diesem Lauf auf 300 ms und die Pausen ebenso — ein
    // ausgeloester Vorrang waere beim Blick am Ende laengst abgelaufen, und der
    // Lauf waere auch bei kaputter Schwelle gruen gewesen.
    let mut gut = true;
    for i in 0..6 {
        let x = 800 + i % 2 * 2;
        fremd_bewegen(x, 400);
        kurz();
        if w.host_regt_sich() {
            gut &= urteil(&format!("Zittern unter der Schwelle (Schritt {i})"), false, true);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    if gut {
        gut &= urteil("Zittern unter der Schwelle (alle 6 Schritte)", false, false);
    }
    // Und jetzt ein Sprung weit darueber.
    fremd_bewegen(800 + SCHWELLE_PX as i32 * 20, 400);
    kurz();
    gut &= urteil("Sprung ueber die Schwelle", true, w.host_regt_sich());
    w.stoppen();
    gut
}

fn lauf_ablauf() -> bool {
    let w = wache();
    if let Err(e) = w.starten() {
        eprintln!("Wache nicht aufstellbar: {e}");
        return false;
    }
    kurz();
    fremd_bewegen(600, 600);
    kurz();
    fremd_bewegen(900, 600);
    kurz();
    let mut gut = urteil("nach der Regung", true, w.host_regt_sich());
    println!("  Rest: {} ms", w.rest_ms());
    std::thread::sleep(std::time::Duration::from_millis(500));
    gut &= urteil("nach dem Ablauf der Frist", false, w.host_regt_sich());
    // Der Wecker laeuft auf einem eigenen Faden — bei 100 ms Takt und rund
    // 700 ms Lauf muessen einige Schlaege angekommen sein.
    let takte = TAKTE.load(Ordering::Relaxed);
    println!(
        "{} Wecker: {takte} Schlaege (Vertragspflicht des Traits)",
        if takte >= 3 { "OK  " } else { "FEHL" }
    );
    gut &= takte >= 3;
    w.stoppen();
    gut
}

fn main() {
    // Vor dem ersten Blick auf die Frist — sie wird einmalig gelesen.
    unsafe { std::env::set_var("PULSE_FERN_VORRANG_MS", "300") };

    let args: Vec<String> = std::env::args().skip(1).collect();
    let lauf = args.first().map(String::as_str).unwrap_or("eigen");
    let ohne_marke = args.iter().any(|a| a == "--ohne-marke");

    println!("Waehrend des Laufs die Maus nicht anfassen.\n");
    let gut = match lauf {
        "eigen" => lauf_eigen(ohne_marke),
        "schwelle" => lauf_schwelle(),
        "ablauf" => lauf_ablauf(),
        anderes => {
            eprintln!("unbekannter Lauf: {anderes} (eigen | schwelle | ablauf)");
            false
        }
    };
    if !gut {
        std::process::exit(1);
    }
}
