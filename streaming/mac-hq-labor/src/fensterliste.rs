//! Die Fensterliste einsammeln — der unreine Teil von [`super::obenauf`].
//!
//! `CGWindowListCopyWindowInfo` mit `kCGWindowListOptionOnScreenOnly` liefert
//! die sichtbaren Fenster **von vorn nach hinten**. Genau diese Reihenfolge ist
//! die Grundlage der Beurteilung nebenan; sie wird hier bewahrt und nirgends
//! umsortiert.
//!
//! **Was ohne Bildschirmaufnahme-Freigabe fehlt:** die Namen
//! (`kCGWindowOwnerName`, `kCGWindowName`). Nummer, Prozess, Schicht und
//! Rechteck kommen auch ohne sie — und nur die entscheiden. Der Name wird
//! deshalb als `Option` gefuehrt und ausschliesslich zum Benennen benutzt.
//!
//! **Nicht gefiltert wird nach Deckkraft** (`kCGWindowAlpha`). Es waere
//! verlockend, unsichtbare Fenster zu ueberspringen — aber ein Fenster, das
//! nichts zeigt, kann trotzdem Eingabe schlucken, und ein Filter an dieser
//! Stelle waere genau die Sorte Abkuerzung, die eine Pruefung stillschweigend
//! immer „ja" sagen laesst. Die Deckkraft wird deshalb nur mitprotokolliert.

use std::ffi::c_void;

use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFNumberType, CFString, CGRect};
use objc2_core_graphics::{
    CGRectMakeWithDictionaryRepresentation, CGWindowListCopyWindowInfo, CGWindowListOption,
    kCGNullWindowID, kCGWindowAlpha, kCGWindowBounds, kCGWindowLayer, kCGWindowNumber,
    kCGWindowOwnerName, kCGWindowOwnerPID,
};

use crate::obenauf::{Fensterzeile, Rechteck};

/// Die sichtbaren Fenster, vorn zuerst. Leer heisst: CoreGraphics hat nichts
/// hergegeben — das ist selbst schon ein Befund (s. `Lage::KeinFenster`).
pub fn sichtbare_fenster() -> Vec<Fensterzeile> {
    let Some(liste) = CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly, kCGNullWindowID)
    else {
        return Vec::new();
    };
    (0..liste.count()).filter_map(|i| zeile_lesen(&liste, i)).collect()
}

/// Die Deckkraft eines Fensters, nur fuers Protokoll (s. Modulkopf).
pub fn deckkraft(zeile: &Fensterzeile) -> Option<f64> {
    let liste = CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly, kCGNullWindowID)?;
    (0..liste.count()).find_map(|i| {
        let d = unsafe { dictionary(&liste, i) }?;
        if zahl(d, unsafe { kCGWindowNumber })? as u32 != zeile.nummer {
            return None;
        }
        gleitzahl(d, unsafe { kCGWindowAlpha })
    })
}

fn zeile_lesen(liste: &CFArray, i: isize) -> Option<Fensterzeile> {
    let d = unsafe { dictionary(liste, i) }?;
    Some(Fensterzeile {
        nummer: zahl(d, unsafe { kCGWindowNumber })? as u32,
        pid: zahl(d, unsafe { kCGWindowOwnerPID })? as i32,
        // Ohne Schichtangabe wird 0 angenommen: eine fehlende Angabe darf ein
        // Fenster nicht aus der Liste werfen, sonst faellt ausgerechnet der
        // Stoerer heraus, den die Pruefung finden soll.
        schicht: zahl(d, unsafe { kCGWindowLayer }).unwrap_or(0) as i32,
        rechteck: rechteck(d)?,
        eigner: text(d, unsafe { kCGWindowOwnerName }),
    })
}

/// # Safety
/// `liste` muss ein `CFArray` von `CFDictionary` sein — so gibt
/// `CGWindowListCopyWindowInfo` es zurueck.
unsafe fn dictionary(liste: &CFArray, i: isize) -> Option<&CFDictionary> {
    let roh = unsafe { liste.value_at_index(i) };
    if roh.is_null() { None } else { Some(unsafe { &*(roh.cast::<CFDictionary>()) }) }
}

fn wert(d: &CFDictionary, schluessel: &CFString) -> Option<*const c_void> {
    let p = unsafe { d.value((schluessel as *const CFString).cast::<c_void>()) };
    if p.is_null() { None } else { Some(p) }
}

fn zahl(d: &CFDictionary, schluessel: &CFString) -> Option<i64> {
    let p = wert(d, schluessel)?;
    let n = unsafe { &*(p.cast::<CFNumber>()) };
    let mut v: i64 = 0;
    let ok = unsafe { n.value(CFNumberType::SInt64Type, (&raw mut v).cast::<c_void>()) };
    ok.then_some(v)
}

fn gleitzahl(d: &CFDictionary, schluessel: &CFString) -> Option<f64> {
    let p = wert(d, schluessel)?;
    let n = unsafe { &*(p.cast::<CFNumber>()) };
    let mut v: f64 = 0.0;
    let ok = unsafe { n.value(CFNumberType::Float64Type, (&raw mut v).cast::<c_void>()) };
    ok.then_some(v)
}

fn text(d: &CFDictionary, schluessel: &CFString) -> Option<String> {
    let p = wert(d, schluessel)?;
    Some(unsafe { &*(p.cast::<CFString>()) }.to_string())
}

fn rechteck(d: &CFDictionary) -> Option<Rechteck> {
    let p = wert(d, unsafe { kCGWindowBounds })?;
    let b = unsafe { &*(p.cast::<CFDictionary>()) };
    let mut r = CGRect::default();
    let ok = unsafe { CGRectMakeWithDictionaryRepresentation(Some(b), &raw mut r) };
    ok.then_some(Rechteck {
        x: r.origin.x,
        y: r.origin.y,
        breite: r.size.width,
        hoehe: r.size.height,
    })
}
