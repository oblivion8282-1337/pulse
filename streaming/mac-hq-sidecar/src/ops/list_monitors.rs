//! `list_monitors` — display enumeration for the in-app screen picker.
//!
//! Shape (same as the Windows sidecar):
//!
//! ```jsonc
//! {"ok": true,
//!  "monitors": [{"index": 1, "name": "Display 1", "primary": true,
//!                "width": 5120, "height": 2880, "refresh_hz": 0,
//!                "x": 0, "y": 0}, ...]}
//! ```
//!
//! `x`/`y` are the top-left corner in screen coordinates — same field names
//! as the Windows sidecar, the web side doesn't branch on platform.
//!
//! `index` is 1-based and round-trips as the `capture: "display:<index>"` request
//! the renderer sends back. Backed by `SCShareableContent` (requires
//! Screen-Recording permission — without it the query errors).

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::capture;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let displays = capture::list_displays()?;
    let monitors: Vec<Value> = displays
        .into_iter()
        .map(|d| {
            json!({
                "index": d.index,
                "name": d.name,
                "primary": d.primary,
                "width": d.width,
                "height": d.height,
                "refresh_hz": d.refresh_hz,
                "x": d.x,
                "y": d.y,
            })
        })
        .collect();

    let mut out = Map::new();
    out.insert("monitors".to_string(), Value::Array(monitors));
    Ok(out)
}
