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
//! (WinRT-agiles Objekt, die Property ist dafür gebaut); der Aufruf kommt vom
//! Dispatch-Faden, während der Capture-Faden liefert — das ist der gedeckte
//! Fall, kein Rennen.

use std::sync::Mutex;

use windows::Graphics::Capture::GraphicsCaptureSession;

struct Platz {
    session: GraphicsCaptureSession,
    /// Zeigt der Stream den Cursor von Haus aus (`show_cursor` der
    /// `start`-Anfrage)? Nur dann gibt es etwas zu verbergen — und „zeigen"
    /// heißt immer nur: zurück auf diesen Ausgangszustand, nie darüber
    /// hinaus. Wer ohne Cursor streamt, bekommt ihn durch eine Fernsteuerung
    /// nicht untergeschoben.
    basis_sichtbar: bool,
    /// Ist der Cursor GERADE von uns verborgen? Hält die Property-Aufrufe
    /// auf Zustandswechsel beschränkt — bei bis zu 125 Eingabe-Nachrichten je
    /// Sekunde wäre ein WinRT-Aufruf pro Nachricht vermeidbare Arbeit.
    verborgen: bool,
}

static PLATZ: Mutex<Option<Platz>> = Mutex::new(None);

/// Die Sperre nehmen — auch eine vergiftete, aus demselben Grund wie
/// [`crate::remote_input::Sitzung::sperre`]: der Wiederherstellungspfad läuft
/// auch beim Prozessende und darf an keiner fremden Panik scheitern.
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
    *sperre() = Some(Platz { session, basis_sichtbar, verborgen: false });
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
    if !p.basis_sichtbar || p.verborgen == verbergen {
        return;
    }
    match p.session.SetIsCursorCaptureEnabled(!verbergen) {
        Ok(()) => {
            p.verborgen = verbergen;
            eprintln!(
                "[cursor] Host-Cursor {} (Fernsteuerung)",
                if verbergen { "aus dem Stream genommen" } else { "wieder im Stream" }
            );
        }
        // Scheitert der Aufruf (Session im Abbau, Property vom Treiber
        // abgelehnt), wird der Platz GERÄUMT statt nur gemeldet: setzen()
        // läuft je Eingabe-Nachricht — bis 125/s —, und ohne das Räumen
        // wiederholte sich derselbe WinRT-Fehlschlag samt stderr-Zeile mit
        // jeder Nachricht (der Zustandswechsel-Filter oben greift nur nach
        // einem ERFOLG). Eine neue Aufnahme meldet ohnehin frisch an.
        Err(e) => {
            eprintln!("[cursor] SetIsCursorCaptureEnabled({}): {e} — Cursor-Echo aus", !verbergen);
            *platz = None;
        }
    }
}

#[cfg(test)]
mod tests {
    // Ohne echte WGC-Session lässt sich hier nur der Leerlauf prüfen: kein
    // Platz angemeldet → beide Richtungen sind stille No-ops und panicken
    // nicht. Der Rest hängt an einer laufenden Aufnahme und gehört in den
    // Zwei-Geräte-Test (docs/plans/2026-08-12-zwei-geraete-test-aufbau.md).
    #[test]
    fn ohne_aufnahme_sind_beide_richtungen_no_ops() {
        super::abmelden();
        super::verbergen();
        super::zeigen();
    }
}
