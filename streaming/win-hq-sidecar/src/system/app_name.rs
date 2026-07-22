//! Anzeigename einer Anwendung — was der Task-Manager in der Namensspalte zeigt.
//!
//! Der Fenster-Picker im HQ-Stream-Dialog zeigte bis 2026-07-22 den rohen
//! EXE-Namen (`electron.exe`, `WindowsTerminal.exe`) plus den Fenstertitel.
//! Beides zusammen ist unruhig, und der Dateiname ist für den User keine
//! nützliche Information. Windows hinterlegt in jeder EXE eine
//! **`FileDescription`** in der Versions-Resource — daher kommen die lesbaren
//! Namen im Task-Manager („Google Chrome" statt „chrome.exe"). Genau die
//! lesen wir hier.
//!
//! Weg: PID → `OpenProcess` → `QueryFullProcessImageNameW` (voller EXE-Pfad) →
//! `GetFileVersionInfoW` → `VerQueryValueW`. Die Übersetzungstabelle
//! (`\VarFileInfo\Translation`) nennt Sprache + Codepage der eingebetteten
//! Strings; ohne die richtige Kombination im Pfad findet `FileDescription`
//! nichts (der oft kopierte Festwert `040904b0` ist nur US-Englisch/Unicode
//! und schlägt bei lokalisierten Binaries fehl).
//!
//! Alles best-effort: fehlende Rechte (Prozess eines anderen Users, erhöhte
//! Rechte), EXEs ganz ohne Versions-Resource (viele Spiele, Go-/Rust-Binaries)
//! → `None`, der Aufrufer fällt auf den Dateinamen zurück.

use windows::Win32::Foundation::{CloseHandle, HANDLE, MAX_PATH};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
    QueryFullProcessImageNameW,
};
use windows::core::{HSTRING, PCWSTR, PWSTR};

/// Lesbarer Anwendungsname zu einer Prozess-ID, oder `None`.
pub fn display_name_for_pid(pid: u32) -> Option<String> {
    let path = executable_path(pid)?;
    file_description(&path)
}

/// Voller Pfad der EXE eines Prozesses.
fn executable_path(pid: u32) -> Option<String> {
    // LIMITED_INFORMATION reicht für den Bildnamen und wird — anders als
    // PROCESS_QUERY_INFORMATION — auch für Prozesse mit höherer Integritäts-
    // stufe gewährt, solange sie demselben User gehören.
    let handle: HANDLE = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buf = [0u16; MAX_PATH as usize];
    let mut len = buf.len() as u32;
    let ok = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
    };
    unsafe {
        let _ = CloseHandle(handle);
    }
    ok.ok()?;
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

/// `FileDescription` aus der Versions-Resource einer Datei.
fn file_description(path: &str) -> Option<String> {
    let wide = HSTRING::from(path);
    let size = unsafe { GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None) };
    if size == 0 {
        return None; // keine Versions-Resource (üblich bei Spielen/Go-Binaries)
    }
    let mut data = vec![0u8; size as usize];
    unsafe { GetFileVersionInfoW(PCWSTR(wide.as_ptr()), None, size, data.as_mut_ptr().cast()) }
        .ok()?;

    // Sprache/Codepage der eingebetteten Strings — s. Modul-Doc.
    let (lang, codepage) = translation(&data)?;
    let (ptr, len) = ver_query(
        &data,
        &format!("\\StringFileInfo\\{lang:04x}{codepage:04x}\\FileDescription"),
    )?;
    // Hier ist `len` die Zeichenzahl INKLUSIVE eines evtl. abschließenden NUL.
    let text = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(ptr, len as usize) });
    let text = text.trim_end_matches('\0').trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Erste (Sprache, Codepage) aus `\VarFileInfo\Translation`.
fn translation(data: &[u8]) -> Option<(u16, u16)> {
    let (ptr, len) = ver_query(data, "\\VarFileInfo\\Translation")?;
    // Ein Eintrag = zwei u16 (LANGID + Codepage) = 4 Bytes.
    if len < 4 {
        return None;
    }
    let pair = unsafe { std::slice::from_raw_parts(ptr, 2) };
    Some((pair[0], pair[1]))
}

/// Roher `VerQueryValueW`-Zugriff auf einen Sub-Block des Versions-Blocks.
///
/// Gibt Zeiger + Länge unverändert weiter, weil die **Einheit von `len` je
/// Block verschieden** ist: bei String-Werten Zeichen, bei binären Blöcken
/// (`Translation`) Bytes. Die Deutung bleibt beim Aufrufer.
fn ver_query(data: &[u8], sub_block: &str) -> Option<(*const u16, u32)> {
    let key = HSTRING::from(sub_block);
    let mut ptr: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut len: u32 = 0;
    let ok =
        unsafe { VerQueryValueW(data.as_ptr().cast(), PCWSTR(key.as_ptr()), &mut ptr, &mut len) };
    if !ok.as_bool() || ptr.is_null() || len == 0 {
        return None;
    }
    Some((ptr.cast(), len))
}
