//! Pulse desktop shell (Tauri 2).
//!
//! Wraps the SvelteKit web app in a WebView and adds the few things a desktop
//! client needs that the browser cannot do: a global push-to-talk hotkey,
//! native notifications, single-instance behaviour and a persistent key/value
//! store for settings/tokens.
//!
//! Push-to-talk: we register a global shortcut (default `Alt+Space`) and emit
//! `ptt-down` / `ptt-up` events to the frontend, which forwards them to the
//! LiveKit voice room (see `web/src/lib/platform/ptt.ts`).

use tauri::Manager;

#[cfg(desktop)]
mod ptt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // The single-instance plugin must be registered first so a second launch
    // is funnelled back into the running instance before anything else runs.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second instance tried to start: bring the existing window to front.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
        // Autostart: registered but NOT enabled — the Settings UI can flip it on
        // later via the plugin's JS API (needs an autostart:* permission added
        // to the capability at that point; deliberately omitted from T1).
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));
    }

    builder
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(desktop)]
            ptt::setup(app.handle())?;
            // On Linux, make the store file owner-only (settings may hold tokens).
            #[cfg(target_os = "linux")]
            harden_config_dir(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Best-effort `chmod 700` of the per-app config dir + `chmod 600` of any store
/// files in it, so persisted settings/tokens aren't world-readable on shared
/// Linux boxes. Runs once at startup; the store plugin re-creates the files
/// with default perms on write, so this is a floor, not a guarantee — good
/// enough for T1, revisit if we store long-lived secrets there.
#[cfg(target_os = "linux")]
fn harden_config_dir(app: &tauri::AppHandle) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let ext = path.extension().and_then(|e| e.to_str());
            if matches!(ext, Some("json") | Some("dat") | Some("bin")) {
                let _ =
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
}
