//! `remote_input` — Eingabe-Frames der Fernsteuerung einspielen.
//!
//! Die Hülle des Serverwegs, eins zu eins wie der Gateway sie durchreicht
//! (`services/chat-gateway/.../ws_remote_handlers.py::handle_input`):
//!
//! ```jsonc
//! {"op":"remote_input", "id":7,
//!  "slot":0,                       // welcher der laufenden Streams gemeint ist
//!  "session_id":"…",               // optional; ein Wechsel beendet die alte Sitzung
//!  "frames":["AAI=", "AwAB"]}      // Base64, IN REIHENFOLGE
//! ```
//!
//! Antwort: `{"ok":true, "processed":<n>, "state":"live"}`. Andere Zustände:
//!
//! | `state` | heißt |
//! |---|---|
//! | `live` | eingespielt |
//! | `unknown_slot` | kein Stream auf diesem Platz → still verworfen, Sitzung steht |
//! | `unresolved_source` | Stream da, Quelle weg (Fenster zu) → verworfen |
//! | `masked` | Sichtschutz schwärzt gerade → verworfen, Gedrücktes freigegeben |
//!
//! `ok:false` heißt **fail-closed**: Protokollfehler, die Sitzung ist stillgelegt
//! und muss mit `remote_input_end` beendet werden. Zusätzlich geht ein
//! `{"ev":"remote_state","state":"input_error"}` an den Renderer.
//!
//! Frame-Format und Koordinaten-Zuordnung: `crate::remote_input` bzw.
//! `docs/plans/2026-08-12-input-wire-protokoll-v2.md`.

use anyhow::{Result, anyhow};
use serde_json::{Map, Value};

use crate::remote_input::{Sitzung, base64};

/// Obergrenze wie beim Gateway (Spezifikation, „Grenzen"): 32 Frames, 1024 Byte
/// dekodiert. Der Gateway erzwingt sie schon — hier steht sie trotzdem, weil der
/// Sidecar sich nicht darauf verlassen darf, dass vor ihm jemand geprüft hat.
const MAX_FRAMES: usize = 32;
const MAX_BYTES: usize = 1024;

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    let slot = params
        .get("slot")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(u32::MAX as u64) as u32;
    let sitzungs_id = params.get("session_id").and_then(Value::as_str);
    let roh = params
        .get("frames")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("frames ist Pflicht (Liste von Base64-Zeichenketten)"))?;
    if roh.len() > MAX_FRAMES {
        return Err(anyhow!("höchstens {MAX_FRAMES} Frames je Nachricht"));
    }

    let mut frames: Vec<Vec<u8>> = Vec::with_capacity(roh.len());
    let mut summe = 0usize;
    for wert in roh {
        let text = wert
            .as_str()
            .ok_or_else(|| anyhow!("frames müssen Base64-Zeichenketten sein"))?;
        let bytes = base64::dekodiere(text).map_err(|e| anyhow!("frames: {e}"))?;
        summe += bytes.len();
        if summe > MAX_BYTES {
            return Err(anyhow!("höchstens {MAX_BYTES} dekodierte Byte je Nachricht"));
        }
        frames.push(bytes);
    }

    let bericht = Sitzung::singleton().frames(slot, sitzungs_id, &frames)?;
    let mut out = Map::new();
    out.insert("processed".to_string(), Value::from(bericht.verarbeitet));
    out.insert("state".to_string(), Value::from(bericht.zustand));
    Ok(out)
}
