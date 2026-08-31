//! Das Ablagefach selbst: die vier Win32-Vorgaenge auf der Zwischenablage.
//!
//! **Abgetrennt von [`super::fenster`] der Groesse wegen** (`PLAN.md` §12.1);
//! der Schnitt liegt trotzdem an einer Naht: dort steht, WER wann etwas tut
//! (Faden, Nachrichtenschleife, Auftragsbuch), hier steht, WAS dabei mit dem
//! Betriebssystem gesprochen wird.
//!
//! **Jede Funktion hier laeuft auf dem Fensterfaden.** Das ist keine
//! Empfehlung: `WM_RENDERFORMAT` wird an den Eigentuemer zugestellt, und
//! Eigentuemer wird das Fenster, mit dem `OpenClipboard` gerufen wurde. Wer
//! von einem anderen Faden beansprucht, bekommt den Rueckruf dort — auf einem
//! Faden ohne Nachrichtenschleife also gar nicht.
//!
//! **Ungeprueft auf der Entwicklungsmaschine** (s. [`super::fenster`]): belegt
//! ist, dass es uebersetzt.

use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND, SetLastError, WIN32_ERROR};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardOwner, OpenClipboard,
    SetClipboardData,
};
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows::Win32::System::Ole::CF_UNICODETEXT;

/// Beanspruchen **ohne Daten zu hinterlegen** — das ist das verzoegerte
/// Rendern.
pub(super) fn beanspruchen(h: HWND) -> Result<(), String> {
    unsafe { OpenClipboard(Some(h)) }.map_err(|e| format!("OpenClipboard: {e}"))?;
    let ergebnis = (|| {
        unsafe { EmptyClipboard() }.map_err(|e| format!("EmptyClipboard: {e}"))?;
        // **`SetClipboardData` mit NULL meldet Erfolg als Fehler.** Die Huelle
        // der `windows`-Kiste wertet einen NULL-Rueckgabewert als Fehlschlag —
        // beim verzoegerten Rendern IST NULL aber der Erfolgswert (es gibt
        // keinen Speicher, auf den ein Handle zeigen koennte). Unterscheidbar
        // sind die beiden Faelle nur ueber `GetLastError`: deshalb vorher auf
        // 0 setzen und einen Fehler mit Code 0 als Erfolg lesen. Ohne diesen
        // Kniff scheiterte JEDER Anspruch — und zwar mit einer Fehlermeldung,
        // die nichts sagt.
        unsafe { SetLastError(WIN32_ERROR(0)) };
        match unsafe { SetClipboardData(CF_UNICODETEXT.0 as u32, None) } {
            Ok(_) => Ok(()),
            Err(e) if e.code().is_ok() => Ok(()),
            Err(e) => Err(format!("SetClipboardData: {e}")),
        }
    })();
    let _ = unsafe { CloseClipboard() };
    ergebnis
}

/// Den gemerkten Vorbestand zurueckschreiben — mit echtem Inhalt, nicht
/// verzoegert.
pub(super) fn zurueckschreiben(h: HWND, text: &str) -> Result<(), String> {
    let hmem = text_speicher(text)?;
    unsafe { OpenClipboard(Some(h)) }.map_err(|e| format!("OpenClipboard: {e}"))?;
    let ergebnis = (|| {
        unsafe { EmptyClipboard() }.map_err(|e| format!("EmptyClipboard: {e}"))?;
        unsafe { SetClipboardData(CF_UNICODETEXT.0 as u32, Some(hmem)) }
            .map(|_| ())
            .map_err(|e| format!("SetClipboardData: {e}"))
    })();
    let _ = unsafe { CloseClipboard() };
    ergebnis
}

/// Die Ablage raeumen und das Eigentum abgeben.
///
/// **`OpenClipboard(None)` ist hier der Unterschied**: `EmptyClipboard` weist
/// das Eigentum dem Fenster zu, mit dem geoeffnet wurde — ohne Fenster bleibt
/// es unbesetzt. Mit unserem Fenster blieben wir Eigentuemer einer leeren
/// Ablage, und der naechste `GetClipboardOwner`-Vergleich meldete uns weiter
/// als Halter.
pub(super) fn raeumen() -> Result<(), String> {
    unsafe { OpenClipboard(None) }.map_err(|e| format!("OpenClipboard: {e}"))?;
    let ergebnis = unsafe { EmptyClipboard() }.map_err(|e| format!("EmptyClipboard: {e}"));
    let _ = unsafe { CloseClipboard() };
    ergebnis
}

/// Die FREMDE Ablage lesen.
pub(super) fn lesen(h: HWND) -> Option<String> {
    // **Nie die eigene lesen.** Halten wir sie mit verzoegertem Rendern,
    // schickte `GetClipboardData` uns selbst ein `WM_RENDERFORMAT` — auf
    // diesem Faden, mitten in diesem Aufruf. Das waere ein Selbstblock bis in
    // die Render-Frist. Und was dort laege, kaeme ohnehin von der Gegenseite:
    // „nichts Eigenes" ist die richtige Antwort.
    if unsafe { GetClipboardOwner() }.is_ok_and(|o| o == h) {
        return None;
    }
    unsafe { OpenClipboard(None) }.ok()?;
    let text = (|| {
        let hmem = HGLOBAL(unsafe { GetClipboardData(CF_UNICODETEXT.0 as u32) }.ok()?.0);
        let zeiger = unsafe { GlobalLock(hmem) } as *const u16;
        if zeiger.is_null() {
            return None;
        }
        let mut laenge = 0usize;
        // Die Zeichenkette ist NUL-abgeschlossen; eine Laengenangabe gibt es
        // nicht. Am Deckel wird abgebrochen — `zerlegen` machte daraus ohnehin
        // ein `zu_gross`, und bis dahin zu lesen kostet nur Speicher.
        while laenge <= MAX_ZEICHEN && unsafe { *zeiger.add(laenge) } != 0 {
            laenge += 1;
        }
        let roh = unsafe { std::slice::from_raw_parts(zeiger, laenge) };
        let text = String::from_utf16_lossy(roh);
        let _ = unsafe { GlobalUnlock(hmem) };
        Some(text)
    })();
    let _ = unsafe { CloseClipboard() };
    text.filter(|t| !t.is_empty())
}

/// Obergrenze fuer das Lesen, in UTF-16-Einheiten.
///
/// `MAX_TEXT_BYTE` (64 KiB) zaehlt Bytes in UTF-8; eine UTF-16-Einheit wird
/// daraus hoechstens drei Bytes. Etwas mehr zu lesen als noetig ist richtig
/// herum: der Deckel wird in `zerlegen` gezogen, und der soll `zu_gross`
/// melden koennen statt einen abgeschnittenen Text zu liefern.
const MAX_ZEICHEN: usize = pulse_ablage::format::MAX_TEXT_BYTE;

/// Einen beweglichen Speicher mit der UTF-16-Fassung des Textes anlegen.
///
/// **Der Speicher wird NICHT freigegeben**, wenn `SetClipboardData` ihn
/// annimmt: das System uebernimmt ihn dann. Scheitert der Aufruf, bleibt er
/// liegen — ein Fall, der genau einmal je fehlgeschlagenem Einfuegen eintritt
/// und dessen Aufraeumen mehr Fehlerquellen schuefe als es Speicher spart.
pub(super) fn text_speicher(text: &str) -> Result<HANDLE, String> {
    let mut breit: Vec<u16> = text.encode_utf16().collect();
    breit.push(0);
    let bytes = breit.len() * std::mem::size_of::<u16>();
    let hmem = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) }
        .map_err(|e| format!("GlobalAlloc: {e}"))?;
    let ziel = unsafe { GlobalLock(hmem) } as *mut u16;
    if ziel.is_null() {
        return Err("GlobalLock lieferte nichts".to_string());
    }
    unsafe { std::ptr::copy_nonoverlapping(breit.as_ptr(), ziel, breit.len()) };
    let _ = unsafe { GlobalUnlock(hmem) };
    Ok(HANDLE(hmem.0))
}
