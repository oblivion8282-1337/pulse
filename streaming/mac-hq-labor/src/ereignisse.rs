//! Was am Fenster wirklich ankommt — abgegriffen als `NSEvent`.
//!
//! ## Warum nicht winits Ereignisse
//!
//! winit traegt das Fenster, aber es reicht **den Klickstand nicht durch**
//! (`NSEvent.clickCount`). Genau der ist auf macOS der eine Wert, den der
//! Injektor selbst fuellen muss: der WindowServer zaehlt Doppelklicks nicht
//! (gemessen 2026-08-23, Messung 2 der Messakte). Ein Messmittel ohne
//! Klickstand koennte die einzige macOS-eigene Zutat des Injektors nicht
//! nachweisen.
//!
//! Der Abgriff sitzt deshalb auf `addLocalMonitorForEventsMatchingMask:` —
//! **im eigenen Prozess**, dort wo `NSApplication` die Ereignisse an die
//! Fenster verteilt. Das ist dieselbe Strecke, die eine echte Anwendung geht.
//!
//! **Und es ist ausdruecklich NICHT ein `CGEventTap`.** Ein Abgriff dort saehe
//! das Ereignis, bevor irgendeine Anwendung es bekommt — und damit nicht das,
//! was dieses Messmittel behauptet zu messen. Die Falle ist im Repo schon
//! einmal aufgeschlagen: der Stempel-Pruefling mass zuerst an der Stelle, auf
//! die injiziert wird, sah 13 von 13 Marken und belegte damit gar nichts
//! (Nachtrag 6 der Messakte).
//!
//! Der Rueckgabewert des Blocks ist immer das Ereignis selbst — es wird
//! mitgelesen, nicht geschluckt.

use std::cell::RefCell;
use std::rc::Rc;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventType};
use objc2_foundation::MainThreadMarker;

use crate::lage::fenster_zu_global;
use crate::protokoll::{Aufzeichnung, Klick, Protokoll, Rad, Taste};
use crate::tasten;

/// Fensterlage und -hoehe in **Punkten**. Ohne sie traegt kein Mausereignis
/// eine brauchbare Lage.
#[derive(Clone, Copy, Debug)]
pub struct Geometrie {
    pub ursprung: (f64, f64),
    pub hoehe: f64,
    /// Hoehe des **Hauptschirms**, ebenfalls in Punkten.
    ///
    /// Gebraucht fuer Ereignisse ohne Fensterbezug: deren `locationInWindow`
    /// ist in Bildschirmkoordinaten, und die haben ihren Ursprung unten links
    /// auf dem Hauptschirm. Gemessen am 2026-08-23: das ist kein Randfall — ab
    /// dem Ziel in der rechten unteren Ecke (macOS' Kurznotiz-Ecke) kamen
    /// **alle** weiteren Bewegungen ohne Fensterbezug an, und ein Pruefziel,
    /// das sie verwirft, meldet dann vier von acht Zielen als nie angekommen.
    pub schirm_hoehe: f64,
}

pub struct Sammler {
    pub protokoll: Protokoll,
    pub daten: Aufzeichnung,
    pub geometrie: Option<Geometrie>,
    /// Welche Umschalttasten gerade gehalten werden — die Buchfuehrung, aus der
    /// [`tasten::umschalt_runter`] Runter von Hoch trennt.
    pub gehalten: std::collections::BTreeSet<u16>,
}

/// Alle Arten, die dieses Messmittel auswertet.
fn maske() -> NSEventMask {
    NSEventMask::MouseMoved
        | NSEventMask::LeftMouseDragged
        | NSEventMask::RightMouseDragged
        | NSEventMask::OtherMouseDragged
        | NSEventMask::LeftMouseDown
        | NSEventMask::LeftMouseUp
        | NSEventMask::RightMouseDown
        | NSEventMask::RightMouseUp
        | NSEventMask::OtherMouseDown
        | NSEventMask::OtherMouseUp
        | NSEventMask::ScrollWheel
        | NSEventMask::KeyDown
        | NSEventMask::KeyUp
        | NSEventMask::FlagsChanged
}

/// Meldet den Abgriff an. Der Rueckgabewert muss leben, solange gemessen wird —
/// faellt er, ist der Abgriff weg und der Lauf misst wortlos nichts mehr.
pub fn abgriff_anmelden(sammler: Rc<RefCell<Sammler>>) -> Option<Retained<AnyObject>> {
    let block = RcBlock::new(move |ereignis: std::ptr::NonNull<NSEvent>| {
        let ereignis = unsafe { ereignis.as_ref() };
        if let Ok(mut s) = sammler.try_borrow_mut() {
            aufnehmen(&mut s, ereignis);
        }
        // Weiterreichen, nicht schlucken.
        (ereignis as *const NSEvent).cast_mut()
    });
    unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(maske(), &block) }
}

fn aufnehmen(s: &mut Sammler, ereignis: &NSEvent) {
    let typ = ereignis.r#type();
    match typ {
        NSEventType::MouseMoved
        | NSEventType::LeftMouseDragged
        | NSEventType::RightMouseDragged
        | NSEventType::OtherMouseDragged => bewegung(s, ereignis, typ),
        NSEventType::LeftMouseDown
        | NSEventType::RightMouseDown
        | NSEventType::OtherMouseDown => klick(s, ereignis, true),
        NSEventType::LeftMouseUp | NSEventType::RightMouseUp | NSEventType::OtherMouseUp => {
            klick(s, ereignis, false)
        }
        NSEventType::ScrollWheel => rad(s, ereignis),
        NSEventType::KeyDown => taste(s, ereignis, Some(true)),
        NSEventType::KeyUp => taste(s, ereignis, Some(false)),
        NSEventType::FlagsChanged => taste(s, ereignis, None),
        _ => {}
    }
}

/// Die globale Lage eines Mausereignisses — oder `None` samt Grund.
fn globale_lage(s: &mut Sammler, ereignis: &NSEvent) -> Option<(f64, f64)> {
    let Some(g) = s.geometrie else {
        s.daten.ohne_geometrie += 1;
        return None;
    };
    let mtm = MainThreadMarker::new()?;
    let p = ereignis.locationInWindow();
    if ereignis.window(mtm).is_none() {
        // **Ohne zugehoeriges Fenster ist `locationInWindow` in
        // BILDSCHIRM-Koordinaten**, nicht in Fensterkoordinaten — dieselbe
        // Umkehrung, aber gegen den Hauptschirm statt gegen das Fenster.
        // Das als Fensterlage zu rechnen ergaebe eine erfundene Zahl; es zu
        // verwerfen ergaebe einen Lauf, der Ziele als nie angekommen meldet,
        // die sehr wohl ankamen (gemessen, s. `Geometrie::schirm_hoehe`).
        s.daten.ohne_fenster += 1;
        return Some(fenster_zu_global((p.x, p.y), g.schirm_hoehe, (0.0, 0.0)));
    }
    Some(fenster_zu_global((p.x, p.y), g.hoehe, g.ursprung))
}

fn bewegung(s: &mut Sammler, ereignis: &NSEvent, typ: NSEventType) {
    let vorher = s.daten.ohne_fenster;
    let Some(lage) = globale_lage(s, ereignis) else {
        s.protokoll.zeile("maus_bewegt_ohne_lage", serde_json::json!({ "typ": typ.0 }));
        return;
    };
    let bezug = if s.daten.ohne_fenster > vorher { "schirm" } else { "fenster" };
    s.daten.bewegungen.push(lage);
    s.protokoll.zeile(
        "maus_bewegt",
        serde_json::json!({ "x": lage.0, "y": lage.1, "typ": typ.0, "bezug": bezug }),
    );
}

fn klick(s: &mut Sammler, ereignis: &NSEvent, runter: bool) {
    let lage = globale_lage(s, ereignis);
    let k = Klick {
        knopf: ereignis.buttonNumber() as i64,
        runter,
        klickstand: ereignis.clickCount() as i64,
        lage,
    };
    s.protokoll.zeile(
        "maus_taste",
        serde_json::json!({
            "knopf": k.knopf, "runter": k.runter, "klickstand": k.klickstand,
            "x": lage.map(|l| l.0), "y": lage.map(|l| l.1),
        }),
    );
    s.daten.klicks.push(k);
}

fn rad(s: &mut Sammler, ereignis: &NSEvent) {
    // Vier Zahlen, weil macOS zwei Paare fuehrt: `delta*` in Rasten/Zeilen
    // (das Gegenstueck zur Windows-Raste) und `scrollingDelta*` in Punkten,
    // sobald ein Trackpad feine Schritte liefert. Welches Paar ein injiziertes
    // Zeilen-Rollereignis fuellt, ist nicht vorherzusagen — deshalb stehen
    // beide im Protokoll statt einer Auswahl, die schon eine Deutung waere.
    let r = Rad {
        dy: ereignis.deltaY(),
        dx: ereignis.deltaX(),
        roll_dy: ereignis.scrollingDeltaY(),
        roll_dx: ereignis.scrollingDeltaX(),
        fein: ereignis.hasPreciseScrollingDeltas(),
    };
    s.protokoll.zeile(
        "rad",
        serde_json::json!({
            "dy": r.dy, "dx": r.dx, "roll_dy": r.roll_dy, "roll_dx": r.roll_dx, "fein": r.fein,
        }),
    );
    s.daten.raeder.push(r);
}

fn taste(s: &mut Sammler, ereignis: &NSEvent, runter: Option<bool>) {
    let vk = ereignis.keyCode();
    let umschalt = ereignis.modifierFlags().0 as u64;
    // Ein `FlagsChanged` sagt nicht, ob gedrueckt oder losgelassen wurde. Das
    // steht im geraetebezogenen Bit der gemeldeten Kennzeichnung — und nur dort
    // steht auch, ob es die linke oder die rechte Taste war.
    let runter = runter.unwrap_or_else(|| tasten::umschalt_runter(&s.gehalten, vk, umschalt));
    if runter {
        s.gehalten.insert(vk);
    } else {
        s.gehalten.remove(&vk);
    }
    let t = Taste { virtualcode: vk, scancode: tasten::scancode(vk), runter, umschalt };
    s.protokoll.zeile(
        "taste",
        serde_json::json!({
            "vk": t.virtualcode, "scan": t.scancode, "runter": t.runter,
            "umschalt": format!("{:#x}", t.umschalt),
            // Die beiden Kennzeichnungs-Auskuenfte getrennt: das seitenscharfe
            // Geraetebit fehlt bei injizierten Ereignissen (gemessen), das
            // seitenblinde Sammelbit ist da. Wer spaeter meint, die Seite aus
            // der Kennzeichnung lesen zu koennen, sieht es hier schwarz auf
            // weiss. Die Seite steht im Virtualcode, nicht in den Flags.
            "seitenbit": tasten::geraetebit(vk).is_some_and(|b| t.umschalt & b != 0),
            "sammelbit": tasten::sammelbit(vk).is_some_and(|b| t.umschalt & b != 0),
        }),
    );
    s.daten.tasten.push(t);
}
