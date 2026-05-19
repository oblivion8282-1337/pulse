//! Pulse — Windows HQ-streaming sidecar (entry point).
//!
//! Wire-format-equivalent to `streaming/gsr-sidecar/control.py` (the Linux
//! GSR sidecar): one JSON object per stdin line is a request, one JSON object
//! per stdout line is either a response (mirrors the request `id`) or an async
//! event (`{"ev": "...", ...}`, no `id`). See `streaming/README.md` for the
//! protocol and `WINDOWS_HQ_SIDECAR.md` for the porting plan.
//!
//! Identical protocol = `desktop/electron/sidecar.ts` only needs a platform
//! branch on which binary to spawn — every op name, request field, response
//! field, and event payload matches the Linux sidecar.
//!
//! Shutdown: the parent (Electron) closes our stdin. `read_line` returns 0,
//! the loop ends, drop runs, the process exits. The Linux sidecar uses a
//! SIGINT/SIGTERM handler on top — irrelevant on Windows because there is no
//! `kill -INT` here; Electron calls `child.kill('SIGTERM')` only as an escalation
//! after the stdin-close grace, and Node maps SIGTERM to `TerminateProcess`,
//! which we can't gracefully handle anyway.

use std::io::{self, BufRead, Write};

use pulse_win_hq_sidecar::dispatch;

fn main() -> anyhow::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut reader = stdin.lock();
    let mut line = String::new();

    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = dispatch::handle_request_line(trimmed);
        let serialised = serde_json::to_string(&response)?;
        writeln!(out, "{serialised}")?;
        out.flush()?;
    }

    Ok(())
}
