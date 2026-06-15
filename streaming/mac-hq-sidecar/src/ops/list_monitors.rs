//! `list_monitors` — display enumeration for the in-app screen picker.
//!
//! Shape (same as the Windows sidecar):
//!
//! ```jsonc
//! {"ok": true,
//!  "monitors": [{"index": 1, "name": "Studio Display", "primary": true,
//!                "width": 5120, "height": 2880, "refresh_hz": 60}, ...]}
//! ```
//!
//! Day-1 stub: returns an empty list. The renderer currently only calls this on
//! `isWindows()` (see `web/src/lib/stream/settings.svelte.ts`), so an empty list
//! is harmless until the macOS path is wired.
//!
//! TODO(stage: capture): enumerate `SCShareableContent.current.displays`
//! (async — block on a one-shot completion handler) → map each `SCDisplay` to
//! `{index, name, primary, width, height, refresh_hz}`. The `index` round-trips
//! as the `capture: "display:<id>"` request the renderer sends back. A
//! CoreGraphics fallback (`CGGetActiveDisplayList` + `CGDisplayPixelsWide/High`)
//! works without SCK if needed for an early bring-up.

use anyhow::Result;
use serde_json::{Map, Value};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let mut out = Map::new();
    out.insert("monitors".to_string(), Value::Array(vec![]));
    Ok(out)
}
