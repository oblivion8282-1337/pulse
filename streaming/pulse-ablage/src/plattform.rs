//! Die Traits, ueber die der Ablauf die Plattform anfasst — und die Fassung
//! fuer die Plattformen, die es noch nicht gibt.
//!
//! **Lag bis zum 2026-08-31 im Player** (`app/ablage/plattform.rs`) und ist mit
//! [`crate::lage`] hierher gezogen, als der Windows-Host dazukam: die Traits
//! beschreiben, was eine Plattform koennen muss, und diese Frage stellt sich
//! auf jeder von ihnen gleich. Eine zweite Fassung im Sidecar waere genau die
//! Kopie, gegen die die gemeinsamen Kisten gebaut sind.

/// Die macOS-Umsetzung — **beide Rollen teilen sie**, deshalb liegt sie hier
/// und nicht beim Verbraucher (Begruendung im Modulkopf dort).
#[cfg(target_os = "macos")]
pub mod macos;

/// Die Windows-Umsetzung — aus demselben Grund hier, seit dem 2026-08-31: sie
/// lag im `win-hq-sidecar`, solange Windows nur den Host kannte; mit dem
/// Steuernden im Player hat sie zwei Verbraucher (Begruendung im Modulkopf
/// dort).
#[cfg(target_os = "windows")]
pub mod windows;

use crate::beobachter::Beobachter;
use crate::eigentum::Eigentum;

/// Was die Plattform ausserhalb der beiden Kisten-Traits noch beantworten
/// muss.
///
/// Alles drei sind Fragen, die `pulse-ablage` bewusst nicht stellt: „wartet
/// ein Einfuegevorgang?" ist auf jeder Plattform ein anderes Ereignis, die
/// Seriennummer ist eine reine Wayland-Not (s. `Anspruch`), und wer die Ablage
/// gerade haelt, weiss nur das Betriebssystem.
pub trait Ablagequelle {
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
    /// Verfuegbarkeit, nicht an `cfg`** — der Schalter trug deshalb ohne
    /// Zutun, als macOS und Windows nachkamen, und er verschwindet auf einem
    /// Linux-Rechner ohne Wayland-Datengeraet ebenso wie auf einer Maschine,
    /// auf der der Fensterfaden nicht aufzustellen war.
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
/// **Als Objekt-Trait gefuehrt** (`&mut dyn Ablageplattform`), damit der
/// Ablauf darueber EINE Fassung hat statt einer je Plattform (im Player
/// `App::mit_ablage`, in den beiden Sidecars `ablage::mit`): die Umsetzung
/// unterscheidet sich zwischen Wayland, Windows und dem Rest, der Ablauf
/// darueber nicht.
pub trait Ablageplattform: Beobachter + Eigentum + Ablagequelle {}
impl<T: Beobachter + Eigentum + Ablagequelle> Ablageplattform for T {}

/// Die Plattform, die es an dieser Stelle (noch) nicht gibt.
///
/// Im Player heisst das X11 (Wayland traegt dort, macOS ueber [`macos`] und
/// Windows ueber [`windows`]); in den Sidecars und im Player jede Sitzung, die
/// nicht Traeger ist. **Der Name meint „hier keine", nicht „auf diesem
/// Betriebssystem keine"** — auf einem Linux-Rechner ohne Wayland-Datengeraet
/// gibt es keine, obwohl es die Umsetzung gibt.
///
/// **Kein Fehlerfall.** Die Zustandsmaschine laeuft trotzdem — sie meldet nie
/// eine Aenderung, beansprucht nichts und liefert nichts. Damit gibt es genau
/// EINEN Kontrollfluss statt eines zweiten, plattformfreien Zweigs, den
/// niemand pflegt.
pub struct KeineAblage;

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
