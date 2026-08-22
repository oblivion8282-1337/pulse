//! Was der Rechner gerade zu bieten hat: Bildschirme, Fenster, Anwendungen.
//!
//! Alles hier haengt an `SCShareableContent`, und das verlangt die
//! Bildschirmaufnahme-Berechtigung. Fehlt sie, antwortet macOS nicht mit einem
//! Fehler, sondern gar nicht — deshalb wartet [`shareable_content`] mit einer
//! Zeitgrenze und nennt den wahrscheinlichen Grund im Fehlertext. Ohne diesen
//! Hinweis sieht ein fehlendes Recht wie ein haengender Sidecar aus.
//!
//! Am 2026-08-21 aus `mod.rs` herausgeloest (Projektgrenze 350 Zeilen).
//! Reiner Umzug, kein Umbau.

use std::sync::Mutex;
use std::sync::mpsc::channel;
use std::time::Duration;

use anyhow::{Result, anyhow};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::Message;
use objc2_core_graphics::CGMainDisplayID;
use objc2_foundation::NSError;
use objc2_screen_capture_kit::{
    SCDisplay, SCRunningApplication, SCShareableContent, SCWindow,
};

use super::{AssumeSend, DisplayInfo, WindowInfo};

// ── Content query ────────────────────────────────────────────────────────────

/// Block on `SCShareableContent.getShareableContentWithCompletionHandler:` and
/// hand back the retained content. Requires Screen-Recording permission — without
/// it the completion handler returns an error (or times out).
pub(super) fn shareable_content() -> Result<Retained<SCShareableContent>> {
    let (tx, rx) = channel::<Result<AssumeSend<Retained<SCShareableContent>>, String>>();
    let tx = Mutex::new(Some(tx));

    let handler = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        let result = unsafe {
            if let Some(content) = content.as_ref() {
                Ok(AssumeSend(content.retain()))
            } else if let Some(err) = error.as_ref() {
                Err(err.localizedDescription().to_string())
            } else {
                Err("getShareableContent returned no content and no error".to_string())
            }
        };
        if let Ok(mut guard) = tx.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(result);
            }
        }
    });

    // SAFETY: completion-handler block matches the documented signature.
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };

    match rx.recv_timeout(Duration::from_secs(8)) {
        Ok(Ok(content)) => Ok(content.0),
        Ok(Err(msg)) => Err(anyhow!("SCShareableContent error: {msg}")),
        Err(_) => Err(anyhow!(
            "SCShareableContent timed out (Screen-Recording-Permission fehlt?)"
        )),
    }
}

/// Enumerate displays for `list_monitors`.
pub fn list_displays() -> Result<Vec<DisplayInfo>> {
    let content = shareable_content()?;
    let main_id = CGMainDisplayID();
    let displays = unsafe { content.displays() };

    let mut out = Vec::new();
    for (i, display) in displays.iter().enumerate() {
        let display_id = unsafe { display.displayID() };
        let width = unsafe { display.width() } as i64;
        let height = unsafe { display.height() } as i64;
        out.push(DisplayInfo {
            index: i + 1,
            display_id,
            name: format!("Display {display_id}"),
            primary: display_id == main_id,
            width,
            height,
            // TODO(stage: polish): CGDisplayCopyDisplayMode → refresh rate.
            refresh_hz: 0,
        });
    }
    Ok(out)
}

/// Application names for the audio picker (specific-app capture + the
/// desktop-audio exclude list). SCK has no "is this app producing audio?" query,
/// so we approximate with the running applications that own at least one
/// on-screen window — the user-facing apps, deduped + sorted — which is the set
/// worth offering. (The Windows/Linux lists are "apps with an active audio
/// session"; macOS can't narrow that far without a private CoreAudio tap.)
pub fn list_audio_applications() -> Result<Vec<String>> {
    let content = shareable_content()?;
    let windows = unsafe { content.windows() };

    let mut names = std::collections::BTreeSet::new();
    for w in windows.iter() {
        // Keep only normal, on-screen app windows: `windowLayer == 0` drops the
        // menu bar / Dock / Spotlight / Control Center system layers, and a
        // minimum size drops tiny helper windows. This turns "every running
        // process with a surface" into "the apps the user actually sees".
        if !unsafe { w.isOnScreen() } || unsafe { w.windowLayer() } != 0 {
            continue;
        }
        let frame = unsafe { w.frame() };
        if frame.size.width < 120.0 || frame.size.height < 120.0 {
            continue;
        }
        if let Some(app) = unsafe { w.owningApplication() } {
            let name = unsafe { app.applicationName() }.to_string();
            if !name.is_empty() {
                names.insert(name);
            }
        }
    }
    Ok(names.into_iter().collect())
}

/// Capturable windows for the source picker — same "normal, on-screen, sizeable
/// window" filter as [`list_audio_applications`], but returns each window with
/// its CG id + title so the user can stream a single window instead of a whole
/// display.
pub fn list_capture_windows() -> Result<Vec<WindowInfo>> {
    let content = shareable_content()?;
    let windows = unsafe { content.windows() };

    let mut out = Vec::new();
    for w in windows.iter() {
        if !unsafe { w.isOnScreen() } || unsafe { w.windowLayer() } != 0 {
            continue;
        }
        let frame = unsafe { w.frame() };
        if frame.size.width < 120.0 || frame.size.height < 120.0 {
            continue;
        }
        let app = unsafe { w.owningApplication() }
            .map(|a| unsafe { a.applicationName() }.to_string())
            .unwrap_or_default();
        let title = unsafe { w.title() }
            .map(|t| t.to_string())
            .unwrap_or_default();
        out.push(WindowInfo {
            window_id: unsafe { w.windowID() },
            title,
            app,
            width: frame.size.width as i64,
            height: frame.size.height as i64,
        });
    }
    Ok(out)
}

/// Find a window by its CG id in the current shareable content.
pub(super) fn find_window(
    content: &SCShareableContent,
    window_id: u32,
) -> Option<Retained<SCWindow>> {
    let windows = unsafe { content.windows() };
    windows
        .iter()
        .find(|w| unsafe { w.windowID() } == window_id)
        .map(|w| w.retain())
}

/// Running applications matching any of `names` (by `applicationName`) or the
/// given `also_pid` (used to find Pulse's own Electron process via getppid).
pub(super) fn resolve_applications(
    content: &SCShareableContent,
    names: &[String],
    also_pid: Option<i32>,
) -> Vec<Retained<SCRunningApplication>> {
    let apps = unsafe { content.applications() };
    let mut out = Vec::new();
    for a in apps.iter() {
        let name = unsafe { a.applicationName() }.to_string();
        let pid = unsafe { a.processID() };
        if also_pid == Some(pid) || names.iter().any(|n| n == &name) {
            out.push(a.retain());
        }
    }
    out
}

/// Resolve the 1-based display index (clamped to the main display).
pub(super) fn pick_display(content: &SCShareableContent, display_index: usize) -> Result<Retained<SCDisplay>> {
    let displays = unsafe { content.displays() };
    let count = displays.len();
    if count == 0 {
        return Err(anyhow!("keine Displays gefunden"));
    }
    let idx = if display_index >= 1 && display_index <= count {
        display_index - 1
    } else {
        0
    };
    Ok(displays.objectAtIndex(idx))
}
