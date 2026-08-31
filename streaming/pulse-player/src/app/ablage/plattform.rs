//! Die Traits, ueber die der Ablauf die Plattform anfasst — und die Fassung
//! fuer die Plattformen, die es noch nicht gibt.
//!
//! **Abgetrennt von [`super`] der Groesse wegen** (`PLAN.md` §12.1); der
//! Schnitt liegt an der Naht zwischen „was eine Plattform koennen muss" und
//! „wie `App` sie verdrahtet".

use pulse_ablage::beobachter::Beobachter;
use pulse_ablage::eigentum::Eigentum;

/// Was die Plattform ausserhalb der beiden Kisten-Traits noch beantworten
/// muss.
///
/// Alles drei sind Fragen, die `pulse-ablage` bewusst nicht stellt: „wartet
/// ein Einfuegevorgang?" ist auf jeder Plattform ein anderes Ereignis, die
/// Seriennummer ist eine reine Wayland-Not (s. `Anspruch`), und wer die Ablage
/// gerade haelt, weiss nur das Betriebssystem.
pub(crate) trait Ablagequelle {
    /// Wartet gerade ein Einfuegevorgang auf Inhalt? Auf Wayland ist das ein
    /// `wl_data_source.send` mit noch offenem Dateideskriptor.
    fn einfuegen_wartet(&mut self) -> bool;

    /// Seriennummer eines frischen Eingabeereignisses, mit der sich die
    /// Auswahl setzen laesst — `None`, solange keine vorliegt. Der Anspruch
    /// bleibt dann eingereiht, statt still zu verpuffen.
    fn seriennummer(&self) -> Option<u32>;

    /// Halten WIR die lokale Ablage gerade?
    ///
    /// **Die Plattform weiss das besser als ein Merker hier**, und darauf
    /// kommt es an: hat der Nutzer zwischendurch selbst kopiert, ist „wir
    /// haben beansprucht" laengst falsch — auf Wayland meldet das
    /// `wl_data_source.cancelled`, und das sieht nur die Plattform.
    fn eigentuemer(&self) -> bool;

    /// Beruehrt diese Umsetzung ueberhaupt eine Zwischenablage?
    ///
    /// Nur dafuer da, dass die Oberflaeche nichts verspricht, was nicht
    /// stattfindet ([`KeineAblage`] liefert `false`). **An der tatsaechlichen
    /// Verfuegbarkeit, nicht an `cfg`** — dann traegt der Schalter auch, wenn
    /// Plan 1b-2 und 1c die uebrigen Plattformen nachreichen, und er
    /// verschwindet auf einem Linux-Rechner ohne Wayland-Datengeraet.
    fn wirksam(&self) -> bool;

    /// Das Lesen der FREMDEN Auswahl eroeffnen, ohne darauf zu warten.
    ///
    /// **Warum das getrennt ist:** ob der fremde Eigentuemer je schreibt, sagt
    /// kein Protokoll zu — auf Wayland liefert `wl_data_offer.receive` einen
    /// Deskriptor, aus dem gelesen werden muss. Auf der Fensterschleife
    /// gelesen stuenden waehrenddessen Bild UND Eingabe. Die Plattform holt
    /// den Inhalt deshalb nebenher; [`Beobachter::lesen`] gibt nur noch das
    /// fertige Ergebnis heraus und blockiert nie.
    ///
    /// Idempotent: ein zweiter Anstoss waehrend eines laufenden Vorgangs tut
    /// nichts.
    fn lesen_anstossen(&mut self);

    /// Liegt ein Ergebnis vor (auch „nichts zu holen")? Nur dann ist
    /// [`Beobachter::lesen`] aussagekraeftig.
    fn lesen_bereit(&mut self) -> bool;
}

/// Alles zusammen, was eine Plattform-Umsetzung koennen muss.
///
/// **Als Objekt-Trait gefuehrt** (`&mut dyn Ablageplattform`), damit
/// [`App::mit_ablage`] EINE Fassung hat statt einer je Plattform: die
/// Umsetzung unterscheidet sich zwischen Linux und dem Rest, der Ablauf
/// darueber nicht.
pub(crate) trait Ablageplattform: Beobachter + Eigentum + Ablagequelle {}
impl<T: Beobachter + Eigentum + Ablagequelle> Ablageplattform for T {}

/// Die Plattform, die es (noch) nicht gibt: X11, Windows, macOS.
///
/// **Kein Fehlerfall.** Die Zustandsmaschine laeuft trotzdem — sie meldet nie
/// eine Aenderung, beansprucht nichts und liefert nichts. Damit gibt es genau
/// EINEN Kontrollfluss statt eines zweiten, plattformfreien Zweigs, den
/// niemand pflegt.
pub(crate) struct KeineAblage;

impl Beobachter for KeineAblage {
    fn geaendert(&mut self) -> bool {
        false
    }
    fn lesen(&self) -> Option<String> {
        None
    }
}

impl Eigentum for KeineAblage {
    fn beanspruchen(&mut self) -> Result<(), String> {
        Err("auf dieser Plattform gibt es noch keine Zwischenablage-Umsetzung".into())
    }
    fn liefern(&mut self, _text: &str) {}
    fn freigeben(&mut self, _zurueck: Option<&str>) {}
}

impl Ablagequelle for KeineAblage {
    fn einfuegen_wartet(&mut self) -> bool {
        false
    }
    fn seriennummer(&self) -> Option<u32> {
        None
    }
    fn eigentuemer(&self) -> bool {
        false
    }
    fn wirksam(&self) -> bool {
        false
    }
    fn lesen_anstossen(&mut self) {}
    /// **Immer bereit** — es gibt nichts zu holen und nichts zu warten. Ein
    /// `false` hier liesse jeden Anspruch fuer immer eingereiht liegen.
    fn lesen_bereit(&mut self) -> bool {
        true
    }
}
