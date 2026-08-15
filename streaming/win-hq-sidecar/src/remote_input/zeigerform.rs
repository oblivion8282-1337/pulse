//! Welche **Form** der Zeiger des Hosts gerade hat — die Gegenrichtung zum
//! Cursor-Echo.
//!
//! **Warum es das braucht.** Das Cursor-Echo
//! ([`crate::capture::cursorsteuerung`]) nimmt den Host-Zeiger aus der
//! Aufnahme, damit der Steuernde nur seinen eigenen, verzögerungsfreien Zeiger
//! sieht. Was dabei verlorengeht, ist alles, was der Zeiger sonst noch
//! erzählt: der I-Balken über einem Textfeld, der Doppelpfeil an einer
//! Fensterkante, die Hand über einem Verweis, der Wartekringel. Ohne diese
//! Rückmeldung zieht der Steuernde an Kanten ins Leere und rät, ob ein Klick
//! trifft. Der Zeiger fühlt sich zwar an wie der eigene — er weiß nur nichts
//! mehr über den fremden Rechner.
//!
//! **Was hier hinausgeht, ist ein NAME und kein Bild** (`text`, `ns-resize`,
//! `pointer` …). Der Steuernde setzt damit die Form seines eigenen, lokal vom
//! Betriebssystem gezeichneten Zeigers. Das kostet ein paar Byte je
//! Formwechsel statt eines Bildes je Wechsel, bleibt verzögerungsfrei, trägt
//! über Plattformgrenzen (winit benennt seine Formen nach derselben
//! CSS-Liste, macOS und Linux übersetzen sie in ihre eigenen) und kommt beim
//! Steuernden in dessen Zeigergröße und -thema an. Der Preis: nur die
//! Standardformen. Ein Spiel oder ein Bildbearbeiter mit eigenem Zeiger fällt
//! auf [`VORGABE`] zurück — dafür bräuchte es die Pixel selbst
//! (`GetIconInfo` + `GetDIBits`), und das ist eine eigene Stufe.
//!
//! **Warum am Wecker der Wache und nicht an den Eingabe-Nachrichten.** Die Form
//! ändert sich, ohne dass jemand etwas sendet: der Zeiger steht über einer
//! Kante, die Anwendung lädt fertig, der Wartekringel geht. An die Nachrichten
//! des Steuernden gehängt erführe er von einem Wechsel nie, solange er die
//! Hand still hält. Der Wecker der Wache ([`super::wache`]) läuft ohnehin genau
//! dann, wenn eine Fernsteuerung läuft, und auf einem eigenen Faden — ein
//! zweiter Faden für eine Abfrage, die vier Mikrosekunden kostet, wäre
//! Aufwand ohne Ertrag.
//!
//! **Was hier bewusst NICHT ausgewertet wird:** ob der Zeiger überhaupt
//! sichtbar ist (`CURSOR_SHOWING`). Windows blendet ihn beim Tippen aus,
//! Videowiedergaben tun es nach ein paar Sekunden Ruhe — dem Steuernden dabei
//! jedes Mal den Zeiger wegzunehmen, nähme ihm die Orientierung, denn im Bild
//! ist ja auch keiner. Den einen Fall, in dem der Zeiger wirklich verschwinden
//! muss (Spiel mit Zeigerfang), erledigt der Player schon selbst über den Fang.

use std::sync::Mutex;

use windows::Win32::UI::WindowsAndMessaging::{
    CURSORINFO, GetCursorInfo, HCURSOR, IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_HELP,
    IDC_IBEAM, IDC_NO, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE, IDC_WAIT,
    LoadCursorW,
};
use windows::core::PCWSTR;

use super::wache;

/// Was gemeldet wird, wenn die Form keinem Standard-Zeiger entspricht — der
/// eigene Zeiger eines Spiels, ein Werkzeug-Zeiger einer Bildbearbeitung, ein
/// Zeiger, den wir schlicht nicht kennen. Der Steuernde bekommt dann den
/// gewöhnlichen Pfeil, und das ist die richtige Richtung des Irrtums: eine
/// falsche Sonderform behauptete etwas über den fremden Rechner, das nicht
/// stimmt.
const VORGABE: &str = "default";

/// Wie oft die geltende Form **wiederholt** gemeldet wird, gezählt in Weckern
/// à 100 ms ([`wache`]) — also einmal je Sekunde.
///
/// Aus demselben Grund wie beim Vorrang ([`super::vorrang`]): die Meldung fährt
/// über den `remote_signal`-Weiterleiter des Gateways, und der verwirft über
/// seinem Sekundendeckel **still**. Ohne Wiederholung bliebe ein verlorener
/// Wechsel für immer verloren — der Steuernde behielte den I-Balken, während
/// der Host längst wieder auf dem Desktop steht. Eine Nachricht je Sekunde
/// fällt gegen den 60/s-Deckel nicht ins Gewicht.
const WIEDERHOLUNG_TAKTE: u64 = 10;

/// Was von der letzten Meldung übrig ist. Beides unter **einer** Sperre, weil
/// es nur zusammen einen Sinn ergibt: die Takte zählen den Abstand zu genau
/// dieser Form, und jede Meldung setzt beide zugleich.
struct Merker {
    /// Zuletzt gemeldete Form; `None` = in dieser Sitzung noch nichts gemeldet.
    form: Option<&'static str>,
    /// Wecker seit der letzten Meldung (s. [`WIEDERHOLUNG_TAKTE`]).
    takte: u64,
}

/// Der leere Anfang — Sitzungsbeginn und [`zuruecksetzen`] gehen von hier aus.
const LEER: Merker = Merker { form: None, takte: 0 };

static MERKER: Mutex<Merker> = Mutex::new(LEER);

/// Die Sperre nehmen — auch eine vergiftete, aus demselben Grund wie in
/// [`super::Sitzung::sperre`]: [`zuruecksetzen`] liegt auf jedem Ausstiegsweg
/// der Sitzung und darf an keiner fremden Panik scheitern.
fn sperre() -> std::sync::MutexGuard<'static, Merker> {
    MERKER.lock().unwrap_or_else(|e| e.into_inner())
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

/// Die Form des gerade gezeichneten System-Zeigers.
fn ermitteln() -> &'static str {
    let mut info =
        CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
    if unsafe { GetCursorInfo(&mut info) }.is_err() {
        // Kein Grund für mehr als die Vorgabe: die Abfrage ist Beiwerk, und
        // eine Störung darf weder die Sitzung noch das Protokoll fluten (der
        // Wecker käme 100 ms später mit derselben Zeile wieder) — deshalb wird
        // der Fehler auch nicht ausgegeben.
        return VORGABE;
    }
    zu_name(info.hCursor)
}

/// Ein Zeiger-Handle in einen Namen übersetzen. Getrennt von [`ermitteln`],
/// damit der Vergleich für sich steht — er ist die einzige Stelle, an der
/// dieses Modul etwas behauptet.
fn zu_name(aktuell: HCURSOR) -> &'static str {
    if aktuell.0.is_null() {
        // Kein Zeiger gesetzt (ausgeblendet). Absichtlich nicht als eigene
        // Form gemeldet — Begründung im Modulkopf.
        return VORGABE;
    }
    for (kennung, name) in abbildung() {
        if unsafe { LoadCursorW(None, kennung) }.is_ok_and(|h| h == aktuell) {
            return name;
        }
    }
    VORGABE
}

/// Steht eine Meldung an? Reine Rechnung, damit die Regel ohne Windows und
/// ohne laufende Sitzung prüfbar ist.
///
/// Zwei Anlässe: der **Wechsel** (der Regelfall, er soll sofort hinaus) und die
/// **Auffrischung** (s. [`WIEDERHOLUNG_TAKTE`]).
fn meldung_faellig(gemeldet: Option<&str>, jetzt: &str, takte: u64) -> bool {
    gemeldet != Some(jetzt) || takte >= WIEDERHOLUNG_TAKTE
}

/// Der Wecker der Wache (alle 100 ms, aus ihrem eigenen Faden).
pub(super) fn tick() {
    // Nur während einer Fernsteuerung: der Wecker überlebt das Sitzungsende um
    // bis zu einen Takt, und ohne Steuernden gibt es niemanden, den die Form
    // angeht.
    if !super::fern_aktiv() {
        return;
    }
    // **Bei Vorrang des Hosts die Vorgabe**, nicht die echte Form: der Host
    // führt dann seinen eigenen Zeiger, der wieder im Bild ist
    // ([`super::vorrang`]) — der Steuernde soll nicht mit einem I-Balken
    // dastehen, der zu einer Bewegung gehört, die nicht seine ist.
    let jetzt = if wache::host_regt_sich() { VORGABE } else { ermitteln() };

    let faellig = {
        let mut merker = sperre();
        merker.takte += 1;
        let faellig = meldung_faellig(merker.form, jetzt, merker.takte);
        if faellig {
            *merker = Merker { form: Some(jetzt), takte: 0 };
        }
        faellig
    };
    // Außerhalb der Sperre — `emit` reiht zwar nur ein, aber es gibt keinen
    // Grund, einen fremden Kanal unter einer eigenen Sperre anzufassen.
    if faellig {
        crate::events::emit(serde_json::json!({ "ev": "remote_pointer", "shape": jetzt }));
    }
}

/// Sitzungsende: den Merker leeren, damit die nächste Sitzung ihre erste Form
/// wieder in jedem Fall meldet. Ohne das begänne sie mit der Annahme, der
/// Steuernde wisse noch, was am Ende der vorigen galt — und der hat inzwischen
/// selbst zurückgesetzt.
pub(super) fn zuruecksetzen() {
    *sperre() = LEER;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein Wechsel geht sofort hinaus — er ist der Regelfall und der einzige,
    /// den der Steuernde bemerkt.
    #[test]
    fn ein_wechsel_meldet_sofort() {
        assert!(meldung_faellig(Some("default"), "text", 1));
    }

    /// Ohne Wechsel bleibt es still, bis die Auffrischung fällig ist.
    #[test]
    fn gleiche_form_schweigt_bis_zur_auffrischung() {
        assert!(!meldung_faellig(Some("text"), "text", 1));
        assert!(!meldung_faellig(Some("text"), "text", WIEDERHOLUNG_TAKTE - 1));
        assert!(meldung_faellig(Some("text"), "text", WIEDERHOLUNG_TAKTE));
    }

    /// **Der Grund für die Auffrischung:** der Gateway verwirft über seinem
    /// Sekundendeckel still. Ginge ein Wechsel verloren und käme danach nichts
    /// mehr, behielte der Steuernde die falsche Form für den Rest der Sitzung.
    #[test]
    fn die_auffrischung_wiederholt_auch_ohne_wechsel() {
        assert!(meldung_faellig(Some("ew-resize"), "ew-resize", WIEDERHOLUNG_TAKTE + 5));
    }

    /// Die erste Form einer Sitzung geht in jedem Fall hinaus — auch wenn es
    /// die Vorgabe ist. Der Steuernde weiß sonst nicht, ob überhaupt jemand
    /// meldet.
    #[test]
    fn die_erste_form_meldet_immer() {
        assert!(meldung_faellig(None, VORGABE, 1));
    }

    /// Ein Nullzeiger ist kein Handle: kein Absturz, sondern die Vorgabe.
    #[test]
    fn ohne_zeiger_gilt_die_vorgabe() {
        assert_eq!(zu_name(HCURSOR(std::ptr::null_mut())), VORGABE);
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
