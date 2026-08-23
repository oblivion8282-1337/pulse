//! Worauf zielt ein Platz gerade? — die macOS-Haelfte von
//! `pulse_fernsteuerung::plattform::Umgebung::ziel`.
//!
//! ## Punkte, nicht Pixel — und das ist auf macOS keine Kleinigkeit
//!
//! Die Aufnahme laeuft in **Pixeln** (auf einem Retina-Schirm doppelt so viele
//! wie Punkte), `CGEventPost` will **Punkte**. Das Quell-Rechteck kommt deshalb
//! aus [`CGDisplayBounds`] bzw. den Fenster-Massen des Fenster-Servers, **nie**
//! aus der Aufnahmegroesse: die waere auf jedem Retina-Schirm um den Faktor der
//! Skalierung daneben, und zwar so, dass ein Klick in der linken oberen Ecke
//! noch sitzt und einer in der Mitte schon nicht mehr. Die Anteilsrechnung der
//! Kiste (`pulse_fernsteuerung::zuordnung`) rettet den Rest.
//!
//! ## Zwei Koordinatensysteme, und nur eines ist hier gemeint
//!
//! * **Anzeigeraum** (CoreGraphics): Ursprung **oben links** der Hauptanzeige,
//!   y waechst nach unten. `CGDisplayBounds`, `kCGWindowBounds` und
//!   `CGEventPost` sprechen alle diese Sprache — und nur sie kommt hier vor.
//! * **AppKit**: Ursprung **unten links**, y waechst nach oben. `NSWindow.frame`
//!   und `NSScreen.frame` liefern das.
//!
//! Wer sie verwechselt, bekommt Klicks, die senkrecht gespiegelt sind — und das
//! sieht aus wie ein Fehler in der Klemmung, nicht wie ein Koordinatensystem.
//!
//! ## Warum das Fensterrechteck NICHT aus `SCWindow.frame` kommt
//!
//! Naheliegend waere, das `SCWindow` der laufenden Aufnahme zu behalten und
//! seinen `frame` zu lesen. Dagegen spricht die Bauart: ein `SCWindow` stammt
//! aus einem `SCShareableContent`-Schnappschuss, sein `frame` ist also der Stand
//! **der Abfrage**. Der Vertrag verlangt aber ausdruecklich jedes Mal frisch,
//! „Fenster bewegen sich". Gefragt wird deshalb der Fenster-Server selbst
//! ([`CGWindowListCopyWindowInfo`] fuer genau diese eine Kennung), was billig
//! genug fuer den Takt einzelner Nachrichten ist.
//!
//! **Wie weit das gemessen ist** (2026-08-23, `examples/probe_ziel.rs`): beide
//! Wege liefern fuer ein **unbewegtes** Fenster dieselben Masse (1205×854 am
//! Pruefstueck), der hiesige Weg stimmt also. Dass ein gehaltenes `SCWindow`
//! beim Verschieben zurueckbleibt, ist **nicht nachgestellt** — es folgt aus der
//! Bauart des Schnappschusses, nicht aus einer Messung. Der frische Weg kostet
//! nichts, also gibt es keinen Anlass, es darauf ankommen zu lassen.

use std::ffi::c_void;
use std::sync::Mutex;

use objc2_core_foundation::{CFArray, CFDictionary, CGRect};
use objc2_core_graphics::{
    CGDirectDisplayID, CGDisplayBounds, CGWindowID, CGWindowListCopyWindowInfo, CGWindowListOption,
    kCGWindowBounds,
};

use pulse_fernsteuerung::plattform::Zielsuche;
use pulse_fernsteuerung::slot;
use pulse_fernsteuerung::zuordnung::Rechteck;

/// Woraus dieser Strom sein Bild nimmt.
///
/// Bewusst nur die **Kennung**, kein Aufnahme-Objekt: hier soll nichts liegen,
/// das altern kann (s. Modulkopf).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quelle {
    Schirm(CGDirectDisplayID),
    Fenster(CGWindowID),
}

struct AktiverStrom {
    /// Der erklaerte Platz — `None` = nicht genannt.
    ///
    /// Der mac-`start` liest heute keinen `slot`; damit gilt die Regel „ein
    /// Strom ohne erklaerten Platz traegt jeden Platz" (`slot::traegt_slot`),
    /// dieselbe wie auf Windows und aus demselben Grund.
    slot: Option<u32>,
    quelle: Quelle,
}

static AKTIV: Mutex<Option<AktiverStrom>> = Mutex::new(None);

fn registrierung() -> std::sync::MutexGuard<'static, Option<AktiverStrom>> {
    AKTIV.lock().unwrap_or_else(|e| e.into_inner())
}

/// Welche Quelle nimmt dieser Strom auf? `None`, wenn sie sich nicht bestimmen
/// laesst.
///
/// **`None` heisst: nicht anmelden.** Die Fernsteuerung findet dann keinen Strom
/// und verwirft still — das ist fail-closed. Der Rueckfall auf „irgendeinen
/// Schirm" waere die schlechtere Wahl: er zielte auf einen Schirm, den der
/// Steuernde gar nicht sieht, und niemand merkte es.
pub fn quelle_aus(fenster_id: Option<u32>, schirm_index: usize) -> Option<Quelle> {
    if let Some(id) = fenster_id {
        return Some(Quelle::Fenster(id));
    }
    let schirme = crate::capture::list_displays().ok()?;
    // `display_index` ist 1-basiert (s. `ops::start::parse_display_index`), und
    // ein Index ausserhalb der Liste faellt auf den ersten Schirm zurueck —
    // dieselbe Regel, nach der die Aufnahme ihre Groesse waehlt. Sonst zielte
    // die Eingabe woandershin als das Bild.
    let eintrag = schirme
        .iter()
        .find(|d| d.index == schirm_index)
        .or_else(|| schirme.first())?;
    Some(Quelle::Schirm(eintrag.display_id))
}

/// Vom [`crate::stream_controller`] beim Start gerufen.
///
/// **Anders als auf Windows steht die Quelle hier schon fest**: der mac-`start`
/// waehlt Schirm oder Fenster, bevor die Aufnahme laeuft. Es gibt deshalb kein
/// zweites `ziel_gebunden` — und damit auch keine Stelle, an der zwei
/// Aufloesungen auseinanderlaufen koennten.
pub fn strom_gestartet(slot: Option<u32>, quelle: Quelle) {
    *registrierung() = Some(AktiverStrom { slot, quelle });
}

/// Vom [`crate::stream_controller`] gerufen, wenn der Strom endet.
///
/// **Auf macOS ist das Pflicht, nicht Hoeflichkeit.** Der Sidecar bleibt
/// zwischen zwei Streams warm (kein frischer Prozess je Strom, anders als auf
/// Windows) — ein vergessenes Abmelden liesse die Fernsteuerung auf einen Strom
/// zielen, den es nicht mehr gibt. Auf Windows raeumt der Prozesswechsel das
/// nebenbei ab, hier niemand.
pub fn strom_beendet() {
    *registrierung() = None;
}

/// Den Platz aufloesen. Nimmt **jedes Mal** die aktuelle Lage — der Aufrufer
/// darf das Ergebnis fuer die Dauer einer Nachricht halten, nicht fuer die
/// Sitzung.
pub fn ziel_fuer_slot(angefragt: u64) -> Zielsuche {
    // Jenseits der Schranke gibt es diesen Platz nirgends im System — unbekannt,
    // nicht „vom ungenannten Strom getragen" (s. `slot::SLOT_MAX`).
    if !slot::im_bereich(angefragt) {
        return Zielsuche::KeinStrom;
    }
    let quelle = {
        let reg = registrierung();
        match reg.as_ref().filter(|s| slot::traegt_slot(s.slot, angefragt)) {
            Some(s) => s.quelle,
            None => return Zielsuche::KeinStrom,
        }
    };
    // **`sichtbar` ist auf macOS immer `true`**, und das ist kein Versehen: den
    // Sichtschutz traegt auf Windows der Faellt-zurueck-auf-den-Schirm-Weg
    // (Fenster weg → Schirm, geschwaerzt). Den gibt es hier nicht — ein Fenster,
    // das verschwindet, liefert kein Rechteck, und das ist der Fall unten.
    // Ein pauschales `false` legte die Fernsteuerung fuer JEDEN Strom still.
    Zielsuche::Gefunden { rechteck: rechteck(quelle), sichtbar: true }
}

/// Das Quell-Rechteck in Punkten, oder `None`, wenn die Quelle gerade nicht
/// aufloesbar ist (Schirm abgesteckt, Fenster zu). Der Aufrufer verwirft die
/// Bewegung dann und entwertet die gemerkte Zeigerlage.
fn rechteck(quelle: Quelle) -> Option<Rechteck> {
    match quelle {
        Quelle::Schirm(id) => aus_cgrect(CGDisplayBounds(id)),
        Quelle::Fenster(id) => fenster_rechteck(id),
    }
}

/// `CGRect` → [`Rechteck`]. `None` bei einem **entarteten** Rechteck.
///
/// Ein abgestecktes Display liefert `CGDisplayBounds` ein Null-Rechteck statt
/// eines Fehlers; ein leeres Rechteck heisst hier also „nicht aufloesbar" und
/// nicht „ein Punkt gross". Die Klemmrechnung der Kiste weist ein entartetes
/// Rechteck ohnehin zurueck — sie hier abzufangen macht die Diagnose ehrlich.
fn aus_cgrect(r: CGRect) -> Option<Rechteck> {
    let links = r.origin.x as i32;
    let oben = r.origin.y as i32;
    let rechts = links + r.size.width as i32;
    let unten = oben + r.size.height as i32;
    (rechts > links && unten > oben).then_some(Rechteck { links, oben, rechts, unten })
}

/// Das Rechteck eines Fensters, direkt beim Fenster-Server erfragt.
///
/// `CGWindowListCopyWindowInfo` mit `IncludingWindow` liefert hoechstens einen
/// Eintrag: existiert das Fenster nicht mehr, ist die Liste leer — genau das
/// heisst „nicht aufloesbar".
fn fenster_rechteck(id: CGWindowID) -> Option<Rechteck> {
    // `CGRectMakeWithDictionaryRepresentation` ist in der Kiste nicht gebunden.
    // Selbst deklariert statt die vier Zahlen einzeln aus dem Woerterbuch zu
    // klauben: die Umwandlung gehoert CoreGraphics, und eine eigene laege bei
    // jeder kuenftigen Aenderung des Formats daneben.
    unsafe extern "C-unwind" {
        fn CGRectMakeWithDictionaryRepresentation(dict: *const c_void, rect: *mut CGRect) -> bool;
    }

    let liste: objc2_core_foundation::CFRetained<CFArray> =
        CGWindowListCopyWindowInfo(CGWindowListOption::OptionIncludingWindow, id)?;
    if liste.count() < 1 {
        return None;
    }
    let eintrag = unsafe { liste.value_at_index(0) } as *const CFDictionary;
    if eintrag.is_null() {
        return None;
    }
    let masse = unsafe { (*eintrag).value(kCGWindowBounds as *const _ as *const c_void) };
    if masse.is_null() {
        return None;
    }
    let mut rect = CGRect::default();
    if !unsafe { CGRectMakeWithDictionaryRepresentation(masse, &mut rect) } {
        return None;
    }
    aus_cgrect(rect)
}

#[cfg(test)]
#[path = "ziel_tests.rs"]
mod ziel_tests;
