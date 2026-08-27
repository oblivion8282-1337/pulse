//! Der Wächter, dem ScreenCaptureKit sagt, dass es aufgehört hat.
//!
//! **Warum es das gibt.** Bis zum 2026-08-27 bekam
//! `SCStream::initWithFilter_configuration_delegate` an dieser Stelle `None` —
//! also keine Rückrufadresse. Damit hatte macOS keine Möglichkeit, uns
//! mitzuteilen, dass es die Aufnahme selbst beendet hat: Fenster geschlossen,
//! Bildschirm abgezogen, Berechtigung während der Sitzung entzogen, Nutzer hat
//! im System-Menü auf „Teilen beenden" gedrückt.
//!
//! Die Folge war nicht etwa ein Abbruch, sondern das Gegenteil: Die
//! Medienschleife (`stream_controller.rs`) dupliziert bei stehender Quelle das
//! zuletzt empfangene Bild weiter — genau richtig für einen unbewegten
//! Bildschirm, und ununterscheidbar davon, dass gar nichts mehr kommt. Beim
//! Zuschauer sah ein Abbruch deshalb aus wie ein **Standbild**, und er wartete
//! womöglich minutenlang darauf, dass es weitergeht. Der Sendende bekam
//! ebenfalls keine Meldung.
//!
//! macOS war damit an dieser Stelle schlechter gestellt als Windows, wo
//! wenigstens Fenster-Quellen erkannt werden (Bildschirme dort nicht — der in
//! der Wurzel-`CLAUDE.md` offen geführte Punkt).
//!
//! **Was hier NICHT passiert: aufräumen.** Der Wächter legt die Begründung ab,
//! mehr nicht. Beendet wird der Strom von der Medienschleife, die den Merker
//! bei ihrem nächsten Durchlauf sieht — der Rückruf kommt von einer
//! Dispatch-Queue von macOS, und von dort aus Encoder und WHIP-Sender
//! abzubauen hiesse, den Abbau in einem fremden Faden zu fahren, während der
//! eigene womöglich noch ein Bild einschiebt.
//!
//! **Warum ein eigener Typ und nicht `FrameOutput` mit zweitem Protokoll.**
//! Es sind zwei Ströme (Bild und Ton, seit dem 2026-08-20) mit je eigenem
//! `FrameOutput`, aber nur EINER Frage: lebt die Quelle noch. Ein gemeinsamer
//! Wächter mit geteiltem Merker beantwortet sie einmal; zwei Ausgaben mit je
//! eigenem Merker müssten nachträglich wieder zusammengeführt werden.

use std::sync::{Arc, Mutex};

use objc2::rc::Retained;
use objc2::{AllocAnyThread, DefinedClass, define_class, msg_send};
use objc2_foundation::{NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{SCStream, SCStreamDelegate};

/// Der geteilte Merker: `Some(begruendung)`, sobald ein Strom von sich aus
/// aufgehört hat.
pub(super) type QuelleWeg = Arc<Mutex<Option<String>>>;

pub(super) struct WaechterIvars {
    quelle_weg: QuelleWeg,
    /// Welcher der beiden Ströme — steht in der Begründung, damit „Ton weg"
    /// nicht wie „Bild weg" aussieht.
    art: &'static str,
}

define_class!(
    // SAFETY:
    // - NSObject has no subclassing requirements.
    // - StreamWaechter does not implement Drop.
    #[unsafe(super = NSObject)]
    #[ivars = WaechterIvars]
    pub(super) struct StreamWaechter;

    // SAFETY: NSObjectProtocol has no safety requirements.
    unsafe impl NSObjectProtocol for StreamWaechter {}

    // SAFETY: the selector signature matches SCStreamDelegate.
    unsafe impl SCStreamDelegate for StreamWaechter {
        #[unsafe(method(stream:didStopWithError:))]
        fn stream_did_stop(&self, _stream: &SCStream, error: &NSError) {
            let grund = format!(
                "{}-Aufnahme von macOS beendet: {}",
                self.ivars().art,
                error.localizedDescription()
            );
            eprintln!("[capture] {grund}");
            // **Nur den ERSTEN Grund behalten.** Endet der Bild-Strom, zieht
            // macOS den Ton-Strom meist gleich mit nach — die zweite Meldung
            // beschreibt dann die Folge und nicht die Ursache.
            if let Ok(mut slot) = self.ivars().quelle_weg.lock() {
                slot.get_or_insert(grund);
            }
        }
    }
);

impl StreamWaechter {
    pub(super) fn new(quelle_weg: QuelleWeg, art: &'static str) -> Retained<Self> {
        let this = Self::alloc().set_ivars(WaechterIvars { quelle_weg, art });
        // SAFETY: NSObject's init is correct.
        unsafe { msg_send![super(this), init] }
    }
}
