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

    // Die Fernsteuerung braucht beide Freigaben; welche fehlt, entscheidet die
    // Auskunft, nicht dieser Aufrufer.
    let (fernsteuerbar, grund) = crate::berechtigung::faehigkeit(
        crate::berechtigung::darf_einspielen(),
        crate::berechtigung::mithoeren_stand(),
    );

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
        // Faehigkeit hier an Freigaben, die der Nutzer jederzeit zurueckziehen
        // kann und die bei jedem Update erneut eingeholt werden muessen
        // (ad-hoc-signiertes DMG). Ein festes `true` liesse einen Mac als
        // fernsteuerbar erscheinen, dessen zugesagte Sitzung beim ersten Frame
        // wortlos stuerbe — s. `crate::berechtigung`.
        //
        // **BEIDE Freigaben, nicht nur die zum Einspielen.** Ohne
        // Eingabeueberwachung sieht die Wache den Host nicht mehr, der sich
        // seinen Rechner zurueckholen will — die Fernsteuerung waere dann
        // technisch moeglich und trotzdem unverantwortlich. Bis zum 2026-08-23
        // stand hier nur `darf_einspielen()`; das meldete genau diesen Rechner
        // als fernsteuerbar.
        "remote_input": fernsteuerbar,
        // Woran es liegt, wenn nicht. Leer, solange alles erteilt ist.
        // „Verweigert" und „nie gefragt" fuehren den Nutzer an verschiedene
        // Stellen — deshalb getrennt und nicht als gemeinsames Nein.
        "remote_input_grund": grund,
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

    /// Der Grund und die Faehigkeit muessen zueinander passen — und das laesst
    /// sich pruefen, **ohne** vom Freigabe-Zustand dieser Maschine abzuhaengen:
    /// fernsteuerbar heisst leerer Grund, nicht fernsteuerbar heisst genannter
    /// Grund. Ein spaeterer Umbau, der die Faehigkeit verschaerft und den Grund
    /// vergisst, liesse den Nutzer ratlos vor einem `false` ohne Erklaerung.
    #[test]
    fn grund_und_faehigkeit_widersprechen_sich_nicht() {
        let out = handle(Map::new()).expect("health schlug fehl");
        let gsr = out.get("gsr").expect("gsr fehlt");
        let kann = gsr.get("remote_input").and_then(Value::as_bool).expect("remote_input fehlt");
        let grund = gsr
            .get("remote_input_grund")
            .and_then(Value::as_str)
            .expect("remote_input_grund fehlt");
        if kann {
            assert!(grund.is_empty(), "fernsteuerbar, aber mit Grund: {grund}");
        } else {
            assert!(!grund.is_empty(), "nicht fernsteuerbar, aber ohne Grund");
        }
    }
}
