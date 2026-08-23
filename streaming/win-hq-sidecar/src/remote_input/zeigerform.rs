//! Welche **Form** der Zeiger des Hosts gerade hat — die Windows-Hälfte.
//!
//! **Die Buchführung liegt seit dem 2026-08-23 in
//! [`pulse_fernsteuerung::zeigerbuch`]**: was zuletzt gemeldet wurde, was die
//! Gegenseite schon kennt, wann aufgefrischt wird und wie die Nachricht
//! aussieht. Dort steht auch, warum es dieses Merkmal überhaupt gibt (das
//! Cursor-Echo nimmt den Host-Zeiger aus dem Bild und mit ihm alles, was seine
//! Form erzählt) und welche vier Pflichten beim Sidecar bleiben.
//! **Nicht wieder hierher zurückkopieren** — die Datei existiert nur noch
//! einmal.
//!
//! Was hier bleibt, kennt Windows: die Tabelle der Standard-Zeiger
//! ([`abbildung`]), die Abfrage des gerade gezeichneten Zeigers ([`ermitteln`])
//! und die Übersetzung Handle → Name ([`zu_name`]). Dazu die drei Zeilen, die
//! die Kiste an diesen Prozess anschließen: die eine Buchführung samt ihrer
//! Sperre, der Wecker und das Einreihen in den Ereigniskanal.
//!
//! **`CURSOR_SHOWING` bleibt bewusst unausgewertet.** Die Begründung steht
//! einmal, und zwar drüben ([`pulse_fernsteuerung::zeigerbuch`], Abschnitt „Was
//! hier bewusst NICHT entschieden wird") — sie gilt für jeden Sender, nicht nur
//! für diesen. Hier steht nur der Name des Windows-Merkmals, damit die Suche
//! danach hier landet.

use std::sync::Mutex;

use windows::Win32::UI::WindowsAndMessaging::{
    CURSORINFO, GetCursorInfo, HCURSOR, IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_HELP,
    IDC_IBEAM, IDC_NO, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE, IDC_WAIT,
    LoadCursorW,
};
use windows::core::PCWSTR;

use super::{wache, zeigerpixel};
use pulse_fernsteuerung::zeigerbuch::{Stand, VORGABE, Zeigerbuch};

/// Die eine Buchführung dieses Prozesses.
///
/// Sie liegt hier und nicht in der Kiste: die hält bewusst **keinen** globalen
/// Zustand (s. deren `lib.rs`), damit ihre Tests ohne prozessweite Reihenfolge
/// auskommen. Womit ein Wirt seine eine Buchführung schützt, ist seine Sache.
static BUCH: Mutex<Zeigerbuch> = Mutex::new(Zeigerbuch::LEER);

/// Die Sperre nehmen — auch eine vergiftete, aus demselben Grund wie bei der
/// Sperre der Fernsteuer-Sitzung (`pulse_fernsteuerung::sitzung::Sitzung`):
/// [`zuruecksetzen`] liegt auf jedem Ausstiegsweg der Sitzung und darf an
/// keiner fremden Panik scheitern.
fn sperre() -> std::sync::MutexGuard<'static, Zeigerbuch> {
    BUCH.lock().unwrap_or_else(|e| e.into_inner())
}

/// Die Abbildung Windows-Zeiger → Name. Als Funktion statt als `static`, weil
/// [`PCWSTR`] ein roher Zeiger ist; die Werte selbst sind Konstanten des
/// Betriebssystems, das Aufbauen kostet nichts.
///
/// **Nicht zwischengespeichert:** `LoadCursorW` auf einen Standard-Zeiger ist
/// ein Nachschlagen ohne Ladevorgang, und die Handles wechseln, wenn der Nutzer
/// sein Zeigerschema umstellt (`SetSystemCursor`). Ein gemerktes Handle wäre
/// danach falsch, und die Fernsteuerung meldete für den Rest der Sitzung nur
/// noch [`VORGABE`].
///
/// Ohne Entsprechung bleiben `IDC_UPARROW` und die Personen-/Nadel-Zeiger:
/// dafür gibt es in der CSS-Liste nichts, und etwas Ähnliches zu nehmen wäre
/// geraten. Sie fallen auf [`VORGABE`].
fn abbildung() -> [(PCWSTR, &'static str); 13] {
    [
        (IDC_ARROW, VORGABE),
        (IDC_IBEAM, "text"),
        (IDC_HAND, "pointer"),
        (IDC_WAIT, "wait"),
        (IDC_APPSTARTING, "progress"),
        (IDC_CROSS, "crosshair"),
        (IDC_HELP, "help"),
        (IDC_NO, "not-allowed"),
        (IDC_SIZEWE, "ew-resize"),
        (IDC_SIZENS, "ns-resize"),
        (IDC_SIZENWSE, "nwse-resize"),
        (IDC_SIZENESW, "nesw-resize"),
        (IDC_SIZEALL, "move"),
    ]
}

/// Der gerade gezeichnete System-Zeiger.
fn ermitteln() -> Stand {
    let mut info =
        CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
    if unsafe { GetCursorInfo(&mut info) }.is_err() {
        // Kein Grund für mehr als die Vorgabe: die Abfrage ist Beiwerk, und
        // eine Störung darf weder die Sitzung noch das Protokoll fluten (der
        // Wecker käme 100 ms später mit derselben Zeile wieder) — deshalb wird
        // der Fehler auch nicht ausgegeben.
        return Stand::Name(VORGABE);
    }
    match zu_name(info.hCursor) {
        Some(name) => Stand::Name(name),
        // **Der Zeiger wird bei JEDEM Wecker frisch ausgelesen**, nicht am
        // Handle festgemacht. Windows gibt die Zahl eines freigegebenen Zeigers
        // an den nächsten weiter; wer sie als Ausweis nähme, zeigte irgendwann
        // ein Bild, das zu einem längst verworfenen Zeiger gehört. Das Auslesen
        // ist eine Kopie von wenigen Kilobyte und fällt zehnmal je Sekunde
        // neben der laufenden Bildschirmaufnahme nicht ins Gewicht.
        None => zeigerpixel::bild_holen(info.hCursor).map_or(Stand::Name(VORGABE), Stand::Eigen),
    }
}

/// Ein Zeiger-Handle in einen Namen übersetzen. Getrennt von [`ermitteln`],
/// damit der Vergleich für sich steht — er ist die einzige Stelle, an der
/// dieses Modul etwas behauptet.
///
/// `None` heisst **nicht** „Fehler", sondern „kein Zeiger, den Windows selbst
/// mitbringt" — und damit: hol die Pixel.
fn zu_name(aktuell: HCURSOR) -> Option<&'static str> {
    if aktuell.0.is_null() {
        // Kein Zeiger gesetzt (ausgeblendet). Absichtlich nicht als eigene
        // Form gemeldet — Begründung im Modulkopf. Auch kein Bild: es gibt
        // keines.
        return Some(VORGABE);
    }
    for (kennung, name) in abbildung() {
        if unsafe { LoadCursorW(None, kennung) }.is_ok_and(|h| h == aktuell) {
            return Some(name);
        }
    }
    None
}

/// Der Wecker der Wache (alle 100 ms, aus ihrem eigenen Faden).
///
/// Hier stehen die vier Pflichten beisammen, die
/// [`pulse_fernsteuerung::zeigerbuch`] dem Sender überlässt: der Takt (dieser
/// Wecker), der [`Stand`], die Vorrang-Weiche und das Einreihen außerhalb der
/// eigenen Sperre.
pub(super) fn tick() {
    // Nur während einer Fernsteuerung: der Wecker überlebt das Sitzungsende um
    // bis zu einen Takt, und ohne Steuernden gibt es niemanden, den die Form
    // angeht.
    if !super::fern_aktiv() {
        return;
    }
    // **Bei Vorrang des Hosts die Vorgabe**, nicht die echte Form: der Host
    // führt dann seinen eigenen Zeiger, der wieder im Bild ist
    // (Vorrang-Übergang der Sitzung) — der Steuernde soll nicht mit einem
    // I-Balken dastehen, der zu einer Bewegung gehört, die nicht seine ist. Aus
    // demselben Grund geht dann auch kein Bild hinaus. Und `ermitteln` läuft
    // dabei **gar nicht erst**: es kostet `GetCursorInfo`, bis zu dreizehn
    // `LoadCursorW` und im schlechten Fall das Auslesen der Pixel — während der
    // Host selbst arbeitet.
    let stand = if wache::host_regt_sich() { Stand::Name(VORGABE) } else { ermitteln() };
    // Die Sperre endet mit dieser Anweisung, das Einreihen läuft außerhalb:
    // `emit` reiht zwar nur ein, aber es gibt keinen Grund, einen fremden Kanal
    // unter einer eigenen Sperre anzufassen.
    let nachricht = sperre().nachricht(&stand);
    if let Some(n) = nachricht {
        crate::events::emit(n);
    }
}

/// Sitzungsende: das Buch leeren, damit die nächste Sitzung ihre erste Form
/// wieder in jedem Fall meldet (Begründung bei
/// [`Zeigerbuch::zuruecksetzen`]).
pub(super) fn zuruecksetzen() {
    sperre().zuruecksetzen();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein Nullzeiger ist kein Handle: kein Absturz, sondern die Vorgabe — und
    /// ausdrücklich **kein** Anlass, Pixel zu suchen, denn es gibt keine.
    #[test]
    fn ohne_zeiger_gilt_die_vorgabe() {
        assert_eq!(zu_name(HCURSOR(std::ptr::null_mut())), Some(VORGABE));
    }

    /// Jede Form der Tabelle ist ein Name aus der CSS-Liste, den winit auf der
    /// Gegenseite kennt (`streaming/pulse-player/src/app/zeigerform.rs`). Der Test
    /// hält die beiden Enden zusammen: ein hier erfundener Name käme drüben
    /// wortlos als Standardpfeil an.
    #[test]
    fn alle_formen_sind_bekannte_namen() {
        const BEKANNT: &[&str] = &[
            "default",
            "text",
            "pointer",
            "wait",
            "progress",
            "crosshair",
            "help",
            "not-allowed",
            "ew-resize",
            "ns-resize",
            "nwse-resize",
            "nesw-resize",
            "move",
        ];
        for (_, name) in abbildung() {
            assert!(BEKANNT.contains(&name), "{name} steht nicht auf der Liste des Players");
        }
    }
}
