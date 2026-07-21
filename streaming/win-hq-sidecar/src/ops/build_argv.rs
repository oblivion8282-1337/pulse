//! `build_argv` — die FFmpeg-argv die `start` ausführen würde.
//!
//! Linux: liefert die `gpu-screen-recorder`-argv. Windows: liefert die
//! Pseudo-argv aus `stream_controller::build_argv_redacted` (dieselbe
//! Diagnose-Form, die auch die `start`-Response trägt). Der Renderer zeigt
//! das im Stats/Debug-Panel an — Format-Toleranz ist hoch, der String ist
//! diagnostisch nicht programmatisch.
//!
//! Läuft über denselben Parse-Pfad wie `start` (`ops::start::parse_start_params`)
//! — Wire-Parität zu Linux, wo `op_build_argv`/`op_start` dasselbe Body-Parsing
//! teilen (`gsr-sidecar/control.py`). Anders als `start` wird hier NIE der
//! `StreamController` angefasst — reines Parsen + Diagnose-argv-Bau.

use anyhow::Result;
use serde_json::{Map, Value};

use crate::ops::start::parse_start_params;
use crate::stream_controller::build_argv_redacted;

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    let start_params = parse_start_params(&params)?;
    let argv = build_argv_redacted(&start_params);

    let mut out = Map::new();
    // Gleicher Binary-Name wie in `build_argv_redacted`s argv[0] — eigenes
    // Feld für die Shape-Parität zu Linux' `{"binary": ..., "argv": [...]}`.
    out.insert(
        "binary".to_string(),
        Value::String("pulse-win-hq-sidecar.exe".to_string()),
    );
    out.insert(
        "argv".to_string(),
        Value::Array(argv.into_iter().map(Value::String).collect()),
    );
    Ok(out)
}
