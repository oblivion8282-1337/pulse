//! Die Spur: was im Testbau **abgefeuert worden waere**.
//!
//! Aufgezeichnet wird, was an dem Ereignis entschieden wurde — nicht das
//! Ereignis selbst. Vier Felder, weil genau vier Zeilen des Injektors sonst
//! unpruefbar waeren (s. [`super::Zustand::abfeuern`]).
//!
//! **`thread_local`, nicht global.** Rusts Testlaeufer faehrt die Tests
//! nebenlaeufig; eine gemeinsame Liste vermischte ihre Ereignisse, und die
//! Tests wuerden voneinander abhaengig — die Sorte Flake, die man erst unter
//! Last sieht. Jeder Test baut ohnehin seinen eigenen Injektor.

use super::{CGEvent, CGEventField, CGEventFlags};
use objc2_core_graphics::CGEventType;
use std::cell::RefCell;

/// Was ein Ereignis beim Abfeuern trug.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Abgefeuert {
    pub typ: CGEventType,
    pub marke: i64,
    pub flags: CGEventFlags,
    pub klickstand: i64,
}

thread_local! {
    static SPUR: RefCell<Vec<Abgefeuert>> = const { RefCell::new(Vec::new()) };
}

/// Aus dem fertigen Ereignis zurueckgelesen, nicht aus den Argumenten
/// nachgebaut — sonst pruefte der Test seine eigene Erwartung gegen sich
/// selbst und nicht gegen das, was `abfeuern` wirklich gesetzt hat.
pub(super) fn vermerken(ereignis: &CGEvent) {
    let eintrag = Abgefeuert {
        typ: CGEvent::r#type(Some(ereignis)),
        marke: CGEvent::integer_value_field(Some(ereignis), CGEventField::EventSourceUserData),
        flags: CGEvent::flags(Some(ereignis)),
        klickstand: CGEvent::integer_value_field(
            Some(ereignis),
            CGEventField::MouseEventClickState,
        ),
    };
    SPUR.with(|s| s.borrow_mut().push(eintrag));
}

/// Die Spur dieses Fadens holen und leeren.
pub fn nehmen() -> Vec<Abgefeuert> {
    SPUR.with(|s| std::mem::take(&mut *s.borrow_mut()))
}
