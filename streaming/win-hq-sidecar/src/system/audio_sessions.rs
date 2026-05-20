//! `list_application_audio` — Prozesse mit aktivem Audio-Output via `IAudioSessionManager2`.
//!
//! Auf Linux gibt GSR die Liste über `--list-application-audio` zurück — auf
//! Windows iterieren wir den default-render-Endpoint, schauen pro Session die
//! PID an und mappen sie via `sysinfo` auf den Process-Namen. Anti-Cheat-Spiele
//! (Vanguard, Easy Anti-Cheat) lehnen `OpenProcess(PROCESS_QUERY_INFORMATION)`
//! ab — `sysinfo` schluckt das still und der Eintrag fehlt; das Spiel selbst
//! kriegt dann „App: <name>"-Audio-Mode nicht angeboten, der Rest funktioniert.
//!
//! Wir nutzen hier `windows`-direct (statt der `wasapi`-Crate) weil der Code
//! kurz ist und so kein zweites COM-Init-Apartment dazu kommt. Die `wasapi`-
//! Crate brauchen wir erst in Stage 6 für den eigentlichen Process-Loopback.

use anyhow::{Context, Result, anyhow};
use std::collections::BTreeSet;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::core::Interface;

/// Liste der eindeutigen Prozessnamen (Endung `.exe` inklusive) deren WASAPI-
/// Audio-Session am Default-Render-Endpoint aktiv ist.
///
/// Sortiert + dedupliziert. Leerer Vec bei Fehler ist OK (Frontend zeigt dann
/// nur die statischen Modi „Aus/Desktop/Mikrofon/Desktop+Mikrofon").
pub fn list_audio_application_names() -> Result<Vec<String>> {
    let pids = unsafe { collect_session_pids()? };
    if pids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(pids_to_process_names(pids))
}

/// COM-Init + Session-Enum. Hält `CoUninitialize` per RAII bereit damit ein
/// `?` mittendrin kein dangling-Apartment hinterlässt.
unsafe fn collect_session_pids() -> Result<BTreeSet<u32>> {
    // MTA — wir wollen vom Sidecar-Hauptthread aus aufrufen können; STA würde
    // ein Message-Loop bedeuten, das passt zu Stage 6 (Capture-Thread) eh
    // nicht. `S_FALSE` = bereits initialisiert → kein Fehler.
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let already_initialised = hr.0 == 1; // S_FALSE
    if hr.is_err() {
        return Err(anyhow!("CoInitializeEx failed: {:?}", hr));
    }
    let _guard = ComGuard { skip_uninit: already_initialised };

    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .context("CoCreateInstance(MMDeviceEnumerator)")?;
    let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
        .context("GetDefaultAudioEndpoint(eRender,eConsole)")?;

    let session_mgr: IAudioSessionManager2 =
        unsafe { device.Activate(CLSCTX_ALL, None) }.context("IMMDevice::Activate")?;
    let session_enum = unsafe { session_mgr.GetSessionEnumerator() }
        .context("IAudioSessionManager2::GetSessionEnumerator")?;
    let count: i32 = unsafe { session_enum.GetCount() }
        .context("IAudioSessionEnumerator::GetCount")?;

    let mut pids: BTreeSet<u32> = BTreeSet::new();
    for i in 0..count {
        let ctrl = match unsafe { session_enum.GetSession(i) } {
            Ok(c) => c,
            Err(_) => continue, // einzelne Session kaputt — Rest weitermachen
        };
        let ctrl2: IAudioSessionControl2 = match ctrl.cast() {
            Ok(c) => c,
            Err(_) => continue, // pre-Win7-Sessions können das nicht
        };
        let pid = unsafe { ctrl2.GetProcessId() }.unwrap_or(0);
        // System-Sounds-Session läuft als PID 0 (Audio-Engine) — überspringen.
        if pid != 0 {
            pids.insert(pid);
        }
    }

    Ok(pids)
}

/// Prozessname (z.B. `"firefox.exe"`) → PID des Tree-Root-Prozesses für den
/// WASAPI-Process-Loopback.
///
/// Multi-Prozess-Apps (Chromium, Firefox, Electron) erzeugen Audio in Child-
/// Prozessen; der WASAPI-Process-Loopback mit `include_tree=true` deckt die
/// Kinder nur ab, wenn der **Root**-Prozess der Target ist. Darum: alle
/// laufenden Prozesse mit passendem Namen sammeln und den nehmen, dessen
/// Parent nicht selbst so heißt. `None` wenn kein passender Prozess läuft
/// (z.B. die App wurde zwischen Auswahl und Stream-Start geschlossen).
///
/// Match ist case-insensitiv — `list_application_audio` liefert den Namen in
/// der Schreibweise von `sysinfo`, der Renderer schickt ihn 1:1 zurück.
pub fn resolve_application_pid(name: &str) -> Option<u32> {
    use std::collections::HashSet;
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::new());

    let want = name.to_ascii_lowercase();
    let matching: Vec<&sysinfo::Process> = sys
        .processes()
        .values()
        .filter(|p| p.name().to_string_lossy().to_ascii_lowercase() == want)
        .collect();
    if matching.is_empty() {
        return None;
    }
    let match_pids: HashSet<Pid> = matching.iter().map(|p| p.pid()).collect();
    // Tree-Root = der matchende Prozess, dessen Parent NICHT auch ein Match ist.
    let root = matching
        .iter()
        .find(|p| p.parent().map(|par| !match_pids.contains(&par)).unwrap_or(true))
        .or_else(|| matching.first())
        .copied()?;
    Some(root.pid().as_u32())
}

/// PID-Set → sortierte, deduplizierte Liste von Process-Namen (basename, mit `.exe`).
fn pids_to_process_names(pids: BTreeSet<u32>) -> Vec<String> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

    let mut sys = System::new();
    let target: Vec<Pid> = pids.iter().map(|&p| Pid::from_u32(p)).collect();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&target),
        true,
        // Wir lesen nur `name()` — `new()` ohne weitere `.with_*()`-Calls hält den
        // Refresh minimal (kein CPU-Sampling, keine Pfade, keine Cmdlines).
        ProcessRefreshKind::new(),
    );

    let mut names: BTreeSet<String> = BTreeSet::new();
    for pid in pids {
        if let Some(proc) = sys.process(Pid::from_u32(pid)) {
            let n = proc.name().to_string_lossy().into_owned();
            if !n.is_empty() {
                names.insert(n);
            }
        }
    }
    names.into_iter().collect()
}

/// RAII-Wrapper für CoUninitialize. Wenn das aufrufende Thread COM schon vorher
/// initialisiert hatte (S_FALSE-Antwort), lassen wir es in Ruhe — sonst kippt
/// uns das die parent-Initialisierung.
struct ComGuard {
    skip_uninit: bool,
}
impl Drop for ComGuard {
    fn drop(&mut self) {
        if !self.skip_uninit {
            unsafe { CoUninitialize() };
        }
    }
}
