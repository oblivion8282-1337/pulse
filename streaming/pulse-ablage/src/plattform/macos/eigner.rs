//! Das Eigentuemer-Objekt: der eine Punkt, an dem macOS bei uns anklopft.
//!
//! `declareTypes:owner:` verlangt ein Objective-C-Objekt, das
//! `NSPasteboardTypeOwner` erfuellt — ein gewoehnliches Rust-`struct` kann das
//! nicht sein, deshalb `define_class!` (wortgleiches Muster wie
//! `mac-hq-sidecar/src/capture/output.rs`).
//!
//! **`pasteboardChangedOwner:` ist bewusst NICHT umgesetzt**, obwohl das
//! Protokoll es anbietet. Es beantwortet dieselbe Frage wie der
//! Aenderungszaehler („gehoert die Ablage noch uns?"), und zwei Quellen fuer
//! eine Antwort sind hier keine Absicherung, sondern eine Fehlerquelle: die
//! Meldung kaeme VOR dem naechsten Poll, der Poll saehe die Aenderung
//! anschliessend noch einmal, und aus einer fremden Kopie wuerden zwei
//! Ankuendigungen. Der Zaehler entscheidet es allein und auf einem Weg.

use objc2::rc::Retained;
use objc2::runtime::NSObject;
use objc2::{AllocAnyThread, define_class, msg_send};
use objc2_app_kit::{NSPasteboard, NSPasteboardType, NSPasteboardTypeOwner};
use objc2_foundation::NSObjectProtocol;

define_class!(
    // SAFETY:
    // - NSObject stellt keine Bedingungen ans Ableiten.
    // - Eigner setzt kein `Drop` um.
    #[unsafe(super = NSObject)]
    pub(super) struct Eigner;

    // SAFETY: NSObjectProtocol stellt keine Bedingungen.
    unsafe impl NSObjectProtocol for Eigner {}

    // SAFETY: die Signatur entspricht der des Protokolls.
    unsafe impl NSPasteboardTypeOwner for Eigner {
        /// **Hier wartet ein fremdes Programm**, und zwar so lange, wie dieser
        /// Rueckruf braucht. Genau deshalb liegt er auf einem eigenen Faden
        /// (s. [`super::faden`]) und nicht auf dem, der Bild oder Eingabe
        /// traegt.
        #[unsafe(method(pasteboard:provideDataForType:))]
        fn bereitstellen(&self, sender: &NSPasteboard, typ: &NSPasteboardType) {
            super::faden::rendern(sender, typ);
        }
    }
);

impl Eigner {
    pub(super) fn neu() -> Retained<Self> {
        let this = Self::alloc();
        // **Ohne `super(...)`, anders als die Delegaten im mac-Sidecar** — die
        // Form dort gehoert zu einer Klasse MIT Ivars (`set_ivars` liefert das
        // halb gebaute Objekt). Dieses Objekt hat keine: sein Zustand liegt in
        // den Statics des Moduls, weil es genau ein Fach je Maschine gibt.
        // SAFETY: NSObjects `init` ist das richtige.
        unsafe { msg_send![this, init] }
    }
}
