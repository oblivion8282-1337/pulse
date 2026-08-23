//! Host-Cursor zur Laufzeit aus dem Stream nehmen — das Rückgrat des
//! Cursor-Echos der Fernsteuerung.
//!
//! **Warum.** Beim Steuern ohne Zeigerfang sieht der Steuernde ZWEI Zeiger:
//! seinen eigenen (sofort, das Betriebssystem zeichnet ihn über das
//! Player-Fenster) und den des Hosts im Bild — der kommt eine volle
//! Kreislaufzeit später an (2026-08-12 gemessen: ~116 ms Netz plus Bildweg)
//! und ist damit das Geisterbild, das sich als „Lag" anfühlt. Wird der
//! Host-Cursor aus der Aufnahme genommen, bleibt nur der verzögerungsfreie
//! lokale Zeiger: Zeigen und Ziehen fühlen sich an wie am eigenen Rechner,
//! obwohl sich an der Leitung nichts geändert hat.
//!
//! **Wann.** [`crate::remote_input`] schaltet am FRAME-OPCODE, nicht an einem
//! eigenen Protokollfeld: absolute Mausbewegungen heißen „der Steuernde führt
//! seinen eigenen Zeiger" → verbergen; relative Bewegungen (Zeigerfang, der
//! Steuernde sieht seinen Zeiger gerade NICHT) → zeigen, denn dann ist der
//! Host-Cursor im Bild der einzige, den es gibt. Jedes Sitzungsende stellt
//! den Ausgangszustand wieder her — auch fail-closed und das Prozessende.
//!
//! **Wessen Cursor das ist.** `IsCursorCaptureEnabled` wirkt nur auf die
//! Aufnahme-Komposition: der Host-Nutzer sieht seinen Zeiger auf dem eigenen
//! Schirm unverändert. Andere Zuschauer desselben Streams sehen während einer
//! Fernsteuerung keinen Zeiger — hingenommen, der Steuernde ist in dieser
//! Lage die Hauptperson.
//!
//! **Woher die Session kommt.** Die windows-capture-Crate legt sie nicht
//! offen; unser Patch (`patches/0001-...`) reicht sie einmal über
//! `on_session_ready` an den Capture-Handler durch, der sie hier anmeldet.
//! Ein Prozess fährt genau einen Stream (s. [`crate::remote_input::ziel`]),
//! deshalb genügt EIN Platz — eine neue Aufnahme überschreibt ihn.
//!
//! `SetIsCursorCaptureEnabled` ist auf der WGC-Session jederzeit erlaubt
//! (WinRT-agiles Objekt, die Property ist dafür gebaut); die Aufrufe kommen vom
//! Dispatch-Faden und — seit dem Vorrang des Hosts (dem Vorrang-Übergang der
//! Sitzung, angestoßen vom Wecker der Wache) — vom Wecker-Faden der Wache,
//! während der Capture-Faden liefert. Beides ist der gedeckte Fall, kein
//! Rennen: ein agiles Objekt verlangt keinen bestimmten Faden und keine eigene
//! COM-Anmeldung.

use std::sync::Mutex;

use pulse_fernsteuerung::zeigerschalter::{Schalter, Wirkung};
use windows::Graphics::Capture::GraphicsCaptureSession;

struct Platz {
    session: GraphicsCaptureSession,
    /// Die plattformfreie Zustandsführung — ob es überhaupt etwas zu
    /// verbergen gibt, ob gerade verborgen ist, und die asymmetrische
    /// Fehlerbehandlung (samt Begründung und Tests) in
    /// `pulse_fernsteuerung::zeigerschalter`. Hier bleibt nur noch die eine
    /// WinRT-Zeile.
    schalter: Schalter,
}

static PLATZ: Mutex<Option<Platz>> = Mutex::new(None);

/// Die Sperre nehmen — auch eine vergiftete, aus demselben Grund wie bei der
/// Sperre der Fernsteuer-Sitzung (`pulse_fernsteuerung::sitzung::Sitzung`):
/// der Wiederherstellungspfad läuft auch beim Prozessende und darf an keiner
/// fremden Panik scheitern.
fn sperre() -> std::sync::MutexGuard<'static, Option<Platz>> {
    PLATZ.lock().unwrap_or_else(|e| e.into_inner())
}

/// Eine frisch gestartete Aufnahme meldet ihre Session an. Überschreibt einen
/// eventuellen Vorgänger (Stream-Neustart) — dessen Session ist dann ohnehin
/// tot.
///
/// **Mit demselben OS-Gate wie `cursor_settings`** (`super::session_has`): auf
/// einem Windows ohne `IsCursorCaptureEnabled` wird gar nicht erst angemeldet,
/// statt dass später jeder Umschaltversuch fehlschlägt — die Vorgeschichte zu
/// solchen Properties ist der Win10-Supportfall bei `IsBorderRequired`
/// (`capture/mod.rs`).
pub fn anmelden(session: GraphicsCaptureSession, basis_sichtbar: bool) {
    if !super::session_has("IsCursorCaptureEnabled") {
        eprintln!("[cursor] IsCursorCaptureEnabled fehlt auf diesem Windows — Cursor-Echo aus");
        return;
    }
    *sperre() = Some(Platz { session, schalter: Schalter::neu(basis_sichtbar) });
}

/// Die Aufnahme ist beendet — Platz räumen. Kein Wiederherstellen nötig: die
/// Session stirbt mit der Aufnahme, und die nächste startet mit ihrem eigenen
/// `show_cursor`-Ausgangszustand.
pub fn abmelden() {
    *sperre() = None;
}

/// Cursor aus der Aufnahme nehmen (Fernsteuerung mit absoluter Mausführung).
/// No-op ohne laufende Aufnahme, ohne Cursor im Ausgangszustand oder wenn
/// bereits verborgen.
pub fn verbergen() {
    setzen(true);
}

/// Zurück auf den Ausgangszustand des Streams. No-op, wenn nichts verborgen
/// ist.
pub fn zeigen() {
    setzen(false);
}

fn setzen(verbergen: bool) {
    let mut platz = sperre();
    let Some(p) = platz.as_mut() else { return };
    // Ob es hier überhaupt etwas zu tun gibt (Ausgangszustand, Zustandswechsel-
    // Filter) entscheidet der Schalter — die Begründung samt Tests steht in
    // `pulse_fernsteuerung::zeigerschalter`.
    let Wirkung::Umschalten(v) = p.schalter.setzen(verbergen) else { return };
    match p.session.SetIsCursorCaptureEnabled(!v) {
        Ok(()) => {
            p.schalter.gelungen(v);
            eprintln!(
                "[cursor] Host-Cursor {} (Fernsteuerung)",
                if v { "aus dem Stream genommen" } else { "wieder im Stream" }
            );
        }
        // Die asymmetrische Fehlerbehandlung (Scheitert das VERBERGEN, wird
        // der Platz geräumt; scheitert das ZEIGEN, bleibt er stehen) sitzt in
        // `Schalter::gescheitert` — hier bleibt nur noch, ihr Ergebnis
        // umzusetzen: `true` heißt räumen.
        Err(e) => {
            eprintln!("[cursor] SetIsCursorCaptureEnabled({}): {e}", !v);
            if p.schalter.gescheitert(v) {
                eprintln!("[cursor] Cursor-Echo aus");
                *platz = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    // Ohne echte WGC-Session lässt sich hier nur der Leerlauf prüfen: kein
    // Platz angemeldet → beide Richtungen sind stille No-ops und panicken
    // nicht. Die drei eigentlichen Zusagen (nie über den Ausgangszustand
    // hinaus, nur der Zustandswechsel löst aus, die asymmetrische
    // Fehlerbehandlung) samt ihren Tests stehen jetzt in
    // `pulse_fernsteuerung::zeigerschalter` — geprüft ohne jede WGC-Session.
    // Was hier bleibt, hängt wirklich an einer laufenden Aufnahme und gehört
    // in den Zwei-Geräte-Test (docs/plans/2026-08-12-zwei-geraete-test-aufbau.md).
    #[test]
    fn ohne_aufnahme_sind_beide_richtungen_no_ops() {
        super::abmelden();
        super::verbergen();
        super::zeigen();
    }
}
