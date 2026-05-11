//! Push-to-talk via a global shortcut.
//!
//! On press we emit `ptt-down`, on release `ptt-up`. The frontend listens for
//! these (only when `isTauri()`) and toggles the LiveKit mic — see
//! `web/src/lib/platform/ptt.ts`. The shortcut works even when the window is
//! not focused, which is the whole point of doing it in Rust.
//!
//! For T1 the shortcut is hardcoded to `Alt+Space`. Making it configurable
//! (re-register on a Tauri command from the Settings UI) is a later step;
//! the seam is `register_ptt_shortcut`, which is the only thing that would
//! need to be re-invoked.

use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Default push-to-talk shortcut: Alt+Space.
fn default_ptt_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::Space)
}

/// Register the global-shortcut plugin (with our handler) and the PTT binding.
/// Called once from the Tauri `setup` hook.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let ptt = default_ptt_shortcut();
    let ptt_for_handler = ptt.clone();

    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if shortcut == &ptt_for_handler {
                    let name = match event.state() {
                        ShortcutState::Pressed => "ptt-down",
                        ShortcutState::Released => "ptt-up",
                    };
                    if let Err(e) = app.emit(name, ()) {
                        log::warn!("failed to emit {name}: {e}");
                    }
                }
            })
            .build(),
    )?;

    if let Err(e) = app.global_shortcut().register(ptt) {
        // Don't abort startup if the OS won't give us the hotkey (e.g. it's
        // already grabbed by another app) — the in-window keyboard PTT path
        // still works. Just log it.
        log::warn!("could not register push-to-talk shortcut (Alt+Space): {e}");
    }
    Ok(())
}
