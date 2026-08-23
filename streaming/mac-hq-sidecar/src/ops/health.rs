//! `health` — capability probe.
//!
//! Wire-form mirrors `gsr-sidecar/control.py::op_health`:
//!
//! ```jsonc
//! {"ok": true, "gsr": {"available": ..., "source": ..., "is_flatpak": ...,
//!                       "path": ..., "version": ..., "vendor": ...,
//!                       "display_server": ..., "video_codecs": [...],
//!                       "capture_options": [...], "has_flv_patch": ...}}
//! ```
//!
//! On macOS the encoder is VideoToolbox (always present on macOS 13+). The
//! `video_codecs` list is the *real* hardware-encodable set, probed by
//! [`crate::caps`] (h264/hevc baseline; av1 only on AV1-capable silicon + an
//! FFmpeg with `av1_videotoolbox`). The renderer's `state.svelte.ts` flips
//! `stream.gsrAvailable` on `gsr.available` (with `isMac()`) to ungate the
//! HQ-Stream button, and `gpuHasAv1(video_codecs)` to gate the codec choice.

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::caps;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let path = std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(str::to_string));

    let mut gsr = json!({
        "available": true,
        "source": "builtin",
        "is_flatpak": false,
        "vendor": "apple",
        "display_server": "macos",
        // Actual hardware-encodable codecs (h264/hevc baseline; av1 only on
        // AV1-capable silicon + an FFmpeg with av1_videotoolbox).
        "video_codecs": caps::available_video_codecs(),
        // SCK can capture a display, a window or a region.
        "capture_options": ["display", "window", "region"],
        "has_flv_patch": Value::Null,
        // **Live geprueft, nicht behauptet.** Anders als unter Windows (dort
        // fest `true`, weil das Op zum Programm selbst gehoert) haengt die
        // Faehigkeit hier an einer Bedienungshilfen-Freigabe, die der Nutzer
        // jederzeit zurueckziehen kann und die bei jedem Update erneut
        // eingeholt werden muss (ad-hoc-signiertes DMG). Ein festes `true`
        // liesse einen Mac als fernsteuerbar erscheinen, dessen zugesagte
        // Sitzung beim ersten Frame wortlos stuerbe — s. `crate::berechtigung`.
        "remote_input": crate::berechtigung::darf_einspielen(),
    });
    if let Some(p) = path {
        gsr["path"] = Value::String(p);
    }

    let mut out = Map::new();
    out.insert("gsr".to_string(), gsr);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der WERT von `remote_input` haengt am Freigabe-Zustand dieser Maschine
    /// (s. `crate::berechtigung::darf_einspielen`) — das ist hier nicht
    /// pruefbar, ohne eine Wette auf die Entwicklermaschine einzugehen.
    /// Pruefbar und hier geprueft ist das DRUMHERUM: dass `health` das Feld
    /// ueberhaupt fuehrt (ohne das Feld sieht der Zuschauer den Knopf
    /// „Fernsteuerung anfragen" nie, egal wie die Maschine steht) und dass es
    /// ein Bool ist, kein `null`/String/Zahl (der Konsument, `state.svelte.ts`,
    /// unterscheidet `false` von „Feld fehlt" nicht, ein falscher Typ waere
    /// also eine stille Fehldeutung statt eines Fehlers).
    #[test]
    fn feld_remote_input_ist_vorhanden_und_bool() {
        let out = handle(Map::new()).expect("health darf nicht fehlschlagen");
        let gsr = out.get("gsr").expect("gsr-Objekt fehlt");
        let feld = gsr.get("remote_input").expect("remote_input fehlt in health.gsr");
        assert!(feld.is_boolean(), "remote_input ist kein Bool: {feld:?}");
    }
}
