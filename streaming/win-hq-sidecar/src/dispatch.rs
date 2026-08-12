//! Request → op-handler dispatch.
//!
//! Every op handler signature is `fn(params: Map<String, Value>) -> Result<Map<String, Value>>`.
//! Returning an `Err` becomes `{"ok": false, "error": "..."}`; returning `Ok(map)` becomes
//! `{"ok": true, ...map}`.

use serde_json::{Map, Value};

use crate::ops;
use crate::proto::{Request, Response};

/// Parse one stdin line and dispatch to the matching op handler. Returns
/// `(response, exit_after)`; `exit_after` is `true` after a successful `stop`
/// (see `dispatch`). Parse failures map to `{"id": null, "ok": false, ...}` so
/// the parent (Electron's sidecar.ts) sees a deterministic shape.
pub fn handle_request_line(line: &str) -> (Response, bool) {
    let req: Request = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => {
            return (
                Response::error(None, format!("invalid JSON request: {e}")),
                false,
            );
        }
    };
    dispatch(req)
}

/// Returns `(response, exit_after)`. `exit_after` is set after a **successful
/// `stop`**: the sidecar then terminates the whole process (see `main.rs`).
/// Hintergrund: der Capture-/Encode-Teardown lässt einen treiber-internen
/// Threadpool-Timer als dangling zurück — feuert er nach dem Stop noch, knallt
/// es mit einer Access Violation auf einem `TpWaitForTimer`-Thread. Ein
/// prompter Prozess-Exit terminiert die TP-Threads, bevor der Timer drankommt.
/// Per-Stream-Sidecar: Electron spawnt für den nächsten Stream einen frischen.
fn dispatch(req: Request) -> (Response, bool) {
    let id = req.id;
    let result: anyhow::Result<Map<String, Value>> = match req.op.as_str() {
        "health" => ops::health::handle(req.params),
        "gpu_info" => ops::gpu_info::handle(req.params),
        "list_monitors" => ops::list_monitors::handle(req.params),
        "list_windows" => ops::list_windows::handle(req.params),
        "list_application_audio" => ops::list_application_audio::handle(req.params),
        "build_argv" => ops::build_argv::handle(req.params),
        "start" => ops::start::handle(req.params),
        "stop" => ops::stop::handle(req.params),
        "state" => ops::state::handle(req.params),
        "keyframe" => ops::keyframe::handle(req.params),
        "remote_input" => ops::remote_input::handle(req.params),
        "remote_input_end" => ops::remote_input_end::handle(req.params),
        unknown => Err(anyhow::anyhow!("unknown op: {unknown}")),
    };
    let exit_after = req.op == "stop" && result.is_ok();
    match result {
        Ok(fields) => (Response::ok(id, fields), exit_after),
        // Redigiert: die Fehlerkette trägt bei Push-Fehlern die volle
        // Ziel-URL inklusive Stream-Key (s. `crate::redact`).
        Err(e) => (
            Response::error(id, crate::redact::secrets(&format!("{e:#}"))),
            false,
        ),
    }
}
