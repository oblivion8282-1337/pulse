//! Der Fensterfaden: ein nur fuer Nachrichten sichtbares Fenster
//! (`HWND_MESSAGE`), das die Zwischenablage beobachtet und **verzoegert
//! rendert**.
//!
//! ## Warum ein eigener Faden sein MUSS
//!
//! Verzoegertes Rendern heisst auf Windows, dass das System synchron anruft
//! (`WM_RENDERFORMAT`), waehrend das einfuegende Programm wartet — und wir in
//! dieser Zeit auf einen Netz-Umlauf warten (rund 0,4 s, im schlechtesten Fall
//! die volle Abruf-Frist von 2 s). Der Rueckruf darf deshalb auf keinem Faden
//! liegen, der etwas anderes traegt:
//!
//! * nicht auf dem Dispatch-Faden — der beantwortet die stdio-Operationen,
//!   auch die der Fernsteuerung;
//! * **nicht auf dem Hook-Faden der Vorrang-Wache** (`remote_input::wache`):
//!   Windows haengt einen Hook, dessen Faden nicht binnen
//!   `LowLevelHooksTimeout` (Vorgabe 300 ms) antwortet, **stillschweigend ab**.
//!   Der Vorrang des Hosts fiele damit aus, und zwar unbemerkt.
//!
//! ## Und warum es ZWEI eigene Faeden sind
//!
//! Der Takt (`super::takt_starten`) laeuft nicht hier. Er muss weiterlaufen,
//! **waehrend** dieser Faden in `WM_RENDERFORMAT` blockiert — sonst liefe die
//! Abruf-Frist nie ab, und genau sie ist es, die dem wartenden Programm die
//! leere Antwort zustellt. Ein Faden, der auf sich selbst wartet, haengt.
//!
//! ## Die Sperre wird nie ueber einen Win32-Aufruf gehalten
//!
//! `EmptyClipboard` schickt dem Eigentuemer synchron ein
//! `WM_DESTROYCLIPBOARD` — im eigenen Rueckruf, auf diesem Faden. Eine
//! gehaltene `Mutex` waere dort ein Selbstblock. Deshalb: erst rechnen, dann
//! sperren, oder erst sperren, dann loslassen und aufrufen.
//!
//! **Ungeprueft auf der Entwicklungsmaschine**, wie alles Windows-Eigene hier:
//! belegt ist nur, dass die API-Aufrufe uebersetzen (Wegwerf-Crate mit der
//! `windows`-Kiste gegen `x86_64-pc-windows-msvc`). Die Rechnung darueber
//! steht vollstaendig in `pulse_ablage` (`lage` und `stand`) und ist dort
//! gefahren.

use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::{
    AddClipboardFormatListener, GetClipboardOwner, IsClipboardFormatAvailable,
    RemoveClipboardFormatListener, SetClipboardData,
};
use windows::Win32::System::Ole::CF_UNICODETEXT;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, HWND_MESSAGE,
    MSG, PostMessageW, PostQuitMessage, RegisterClassW, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP,
    WM_CLIPBOARDUPDATE, WM_RENDERFORMAT, WNDCLASSW,
};
use windows::core::{PCWSTR, w};

use super::fach;
use pulse_ablage::stand::Ablagestand;

/// Unsere eigene Nachricht: „im Auftragsbuch steht etwas".
pub(super) const WM_PULSE_ABLAGE: u32 = WM_APP + 0x51;

/// Unsere eigene Nachricht: „Schluss".
///
/// **Nicht `PostMessageW(hwnd, WM_QUIT, …)`**, obwohl das nebenan in
/// `remote_input::wache::stoppen` steht: dort geht es an einen Faden OHNE
/// Fenster (`PostThreadMessageW`), hier gibt es eins, und der dokumentierte
/// Weg ist `PostQuitMessage` aus dem Rueckruf heraus.
const WM_PULSE_ENDE: u32 = WM_APP + 0x52;

/// Wie lange ein `WM_RENDERFORMAT` hoechstens wartet.
///
/// **Ueber `pulse_ablage::sitzung::ABRUF_FRIST_MS` (2 s)**, damit im Regelfall
/// die Frist der Zustandsmaschine zuerst greift und eine geordnete leere
/// Antwort zustellt. Diese hier ist nur das Netz darunter — fuer den Fall,
/// dass der Takt-Faden gar nicht mehr laeuft. Ohne sie stuende das einfuegende
/// Programm unbegrenzt.
const RENDER_FRIST: Duration = Duration::from_millis(2_500);

/// Wartetakt der Schleife in [`rendern`].
const RENDER_TAKT: Duration = Duration::from_millis(2);

static GETEILT: Mutex<Ablagestand> = Mutex::new(Ablagestand::neu());

/// Das Fenster, solange der Faden steht — als Zahl, weil `HWND` nicht `Send`
/// ist. `0` heisst „keines".
static FENSTER: AtomicIsize = AtomicIsize::new(0);

pub(super) fn geteilt() -> MutexGuard<'static, Ablagestand> {
    GETEILT.lock().unwrap_or_else(|e| e.into_inner())
}

/// Steht der Fensterfaden? Grundlage von `Ablagequelle::wirksam` — die
/// Oberflaeche soll nichts versprechen, was nicht stattfindet.
pub(super) fn steht() -> bool {
    FENSTER.load(Ordering::Relaxed) != 0
}

pub(super) fn hwnd() -> Option<HWND> {
    match FENSTER.load(Ordering::Relaxed) {
        0 => None,
        z => Some(HWND(z as *mut core::ffi::c_void)),
    }
}

/// Den Faden aufstellen. Idempotent.
pub(super) fn starten() -> Result<(), String> {
    if steht() {
        return Ok(());
    }
    // **Im Testbau kein echtes Fenster und kein echter Zugriff auf die
    // Zwischenablage des Entwicklers.** Dieselbe Zurueckhaltung wie in
    // `remote_input::wache::starten`; `steht()` bleibt damit `false`, die
    // Zustandsmaschine laeuft gegen eine Plattform, die nichts beruehrt.
    if cfg!(test) {
        return Ok(());
    }
    let (melden, warten) = channel::<Result<isize, String>>();
    std::thread::Builder::new()
        .name("pulse-ablage".into())
        .spawn(move || faden(melden))
        .map_err(|e| format!("Ablage-Faden nicht startbar: {e}"))?;
    match warten.recv() {
        // **Gesetzt hat `FENSTER` schon der Faden selbst**, vor seiner Meldung
        // — ein zweiter Schreiber hier waere eine zweite Wahrheit ueber
        // denselben Wert.
        Ok(Ok(_)) => Ok(()),
        Ok(Err(grund)) => Err(grund),
        Err(_) => Err("Ablage-Faden endete vor seiner Meldung".to_string()),
    }
}

/// Der Faden: Fenster bauen, Beobachtung anmelden, Erfolg melden, Nachrichten
/// pumpen.
fn faden(melden: Sender<Result<isize, String>>) {
    let h = match fenster_bauen() {
        Ok(h) => h,
        Err(grund) => {
            let _ = melden.send(Err(grund));
            return;
        }
    };
    if let Err(e) = unsafe { AddClipboardFormatListener(h) } {
        let _ = melden.send(Err(format!("Ablage-Beobachtung nicht anmeldbar: {e}")));
        return;
    }
    // **Vor der Meldung setzen, nicht erst beim Empfaenger**: der Auftraggeber
    // darf sofort nach `starten()` einen Auftrag geben, und der braucht das
    // Fenster.
    FENSTER.store(h.0 as isize, Ordering::Relaxed);
    if melden.send(Ok(h.0 as isize)).is_err() {
        return;
    }
    let mut msg = MSG::default();
    // `GetMessageW` liefert 0 bei `WM_QUIT` und -1 bei einem Fehler; beides
    // beendet die Schleife. Ohne Tastatureingabe gibt es nichts zu uebersetzen.
    while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {
        unsafe { DispatchMessageW(&msg) };
    }
    // Erst abmelden, dann zerstoeren: ein `DestroyWindow` auf ein Fenster mit
    // noch angemeldeter Beobachtung liesse den Eintrag in der Kette des
    // Systems zurueck.
    FENSTER.store(0, Ordering::Relaxed);
    let _ = unsafe { RemoveClipboardFormatListener(h) };
    let _ = unsafe { DestroyWindow(h) };
}

fn fenster_bauen() -> Result<HWND, String> {
    let name: PCWSTR = w!("PulseAblageFenster");
    let klasse = WNDCLASSW {
        lpfnWndProc: Some(fensterruf),
        lpszClassName: name,
        ..Default::default()
    };
    // Ein bereits registrierter Name ist kein Fehler: der Prozess kann den
    // Faden im Leben einmal neu aufstellen.
    unsafe { RegisterClassW(&klasse) };
    unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            name,
            name,
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            // **`HWND_MESSAGE`**: ein Fenster, das nur Nachrichten empfaengt —
            // es erscheint nicht, taucht in keiner Fensterliste auf und kann
            // deshalb auch nicht versehentlich aufgenommen werden.
            Some(HWND_MESSAGE),
            None,
            None,
            None,
        )
    }
    .map_err(|e| format!("Ablage-Fenster nicht baubar: {e}"))
}

unsafe extern "system" fn fensterruf(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    match msg {
        WM_CLIPBOARDUPDATE => {
            // **Erst fragen, dann sperren.** Beide Auskuenfte sind Win32, und
            // die Sperre darf nie ueber einen solchen Aufruf gehalten werden.
            let eigner = unsafe { GetClipboardOwner() }.is_ok_and(|o| o == h);
            let text_da = unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32) }.is_ok();
            geteilt().systemmeldung(eigner, text_da);
            LRESULT(0)
        }
        WM_RENDERFORMAT if w.0 as u16 == CF_UNICODETEXT.0 => {
            rendern();
            LRESULT(0)
        }
        WM_PULSE_ABLAGE => {
            super::auftragsbuch::abarbeiten(h);
            LRESULT(0)
        }
        WM_PULSE_ENDE => {
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        // `WM_DESTROYCLIPBOARD` wird **synchron** aus unserem eigenen
        // `EmptyClipboard` heraus zugestellt, auf diesem Faden. Hier etwas zu
        // tun, das die Sperre nimmt, waere ein Selbstblock — die Buchfuehrung
        // erledigt ohnehin `WM_CLIPBOARDUPDATE`.
        //
        // `WM_RENDERALLFORMATS` bleibt ebenfalls unbeantwortet: es kommt, wenn
        // dieses Fenster mit noch offenem verzoegerten Rendern stirbt. Was dann
        // richtig ist, weiss nicht dieser Rueckruf, sondern
        // `super::beenden_endgueltig` — es schreibt den Vorbestand des Nutzers
        // zurueck, statt einen Rest der Gegenseite in der Ablage zu hinterlassen.
        _ => unsafe { DefWindowProcW(h, msg, w, l) },
    }
}

/// Der blockierende Rueckruf: **hier wartet ein fremdes Programm.**
///
/// Geliefert wird, was `Eigentum::liefern` hinterlegt (der Weg ueber die
/// Leitung), ein Abbruch, oder nach [`RENDER_FRIST`] eine leere Zeichenkette.
/// Ein Einfuegen, das nichts einfuegt, versteht jeder; ein haengendes Programm
/// nicht.
fn rendern() {
    geteilt().warten_beginnen();
    let ende = Instant::now() + RENDER_FRIST;
    let text = loop {
        if let Some(t) = geteilt().antwort_nehmen() {
            break t;
        }
        if Instant::now() >= ende {
            break String::new();
        }
        // Schlafend gewartet, nicht drehend: der Faden hat sonst nichts zu tun,
        // und ein Leerlauf verbraeuchte einen Kern, solange jemand einfuegt.
        std::thread::sleep(RENDER_TAKT);
    };
    // **Ohne `OpenClipboard`**: waehrend eines `WM_RENDERFORMAT` ist die Ablage
    // bereits fuer uns geoeffnet, und ein eigenes Oeffnen wuerde scheitern.
    if let Ok(hmem) = fach::text_speicher(&text) {
        let _ = unsafe { SetClipboardData(CF_UNICODETEXT.0 as u32, Some(hmem)) };
    }
    geteilt().warten_beenden();
}

/// Den Faden abbauen. **Ohne auf ihn zu warten** — dieser Weg laeuft auch beim
/// Prozessende, und dort wartet niemand mehr.
///
/// Was vorher passieren muss, passiert vorher: `super::beenden_endgueltig`
/// gibt erst das Eigentum ab (und schreibt den Vorbestand zurueck) und ruft
/// dann hier. Andersherum stuerbe das Fenster als Eigentuemer eines
/// verzoegerten Rendervorgangs, und die Ablage des Nutzers bliebe leer.
pub(super) fn stoppen() {
    let Some(h) = hwnd() else { return };
    let _ = unsafe { PostMessageW(Some(h), WM_PULSE_ENDE, WPARAM(0), LPARAM(0)) };
}
