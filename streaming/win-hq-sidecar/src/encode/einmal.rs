//! Einmal-Registrierung eines prozessweiten "Bauers" — einer Fabrikfunktion,
//! die sich beim Programmstart genau einmal anmeldet (Begründung fürs Muster
//! "Anmeldung statt durchgereichtem Parameter" steht bei `senke.rs` bzw.
//! `bildencoder.rs`, wo es genutzt wird). Gemeinsame Mechanik hinter
//! `senke::registriere_senken_bauer` und `bildencoder::registriere_encoder_bauer`
//! — beide waren wortgleich dasselbe Idiom mit unterschiedlichem Typ und
//! Meldetext.

use std::sync::OnceLock;

/// Ein `OnceLock`, das eine zweite Anmeldung nicht stumm gewinnen lässt,
/// sondern ignoriert und meldet — zwei Bauer im selben Prozess wären ein
/// Aufbaufehler, und ein stilles Gewinnen des ersten würde beim Suchen
/// Stunden kosten.
pub(crate) struct EinmalBauer<T> {
    slot: OnceLock<T>,
}

impl<T> EinmalBauer<T> {
    pub(crate) const fn new() -> Self {
        Self { slot: OnceLock::new() }
    }

    /// `wert` anmelden, sofern noch keiner angemeldet ist. `warnung` ist die
    /// volle Zeile für den zweiten Fall (Modul-Tag + Meldung) — bewusst kein
    /// generischer Text hier, damit jede Anmeldestelle ihre eigene Wortwahl
    /// behält.
    pub(crate) fn registriere(&self, wert: T, warnung: &str) {
        if self.slot.set(wert).is_err() {
            eprintln!("{warnung}");
        }
    }

    pub(crate) fn get(&self) -> Option<&T> {
        self.slot.get()
    }
}
