//! Desktop ↔ GSR-Sidecar bridge (T3a).
//!
//! The Python sidecar in `streaming/gsr-sidecar/` speaks newline-JSON over
//! stdio: requests carry an `id`, responses echo that `id`, async events use
//! `ev`. This module owns the child process, multiplexes requests against
//! responses (one numeric ID per outbound request), and forwards events to the
//! frontend as Tauri events on the channel `gsr://event`.
//!
//! Lifecycle:
//! - **Lazy spawn**: the child is not started at app launch. The first
//!   `gsr_*` command from the frontend brings it up; users who never stream
//!   never pay for Python.
//! - **Shutdown**: on app exit (`RunEvent::Exit`) we close stdin and give the
//!   child a moment to flush; the sidecar reacts to stdin-EOF by stopping GSR
//!   and exiting cleanly. If it doesn't, we kill the process.
//!
//! The bridge is intentionally agnostic about *what* the sidecar does — it
//! shuttles JSON. See `streaming/README.md` for the wire protocol.

use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::Mutex;

pub mod commands;
pub mod sidecar;

use sidecar::Sidecar;

/// Shared, lazily-initialised handle to the sidecar process.
///
/// Wrapped in an async `Mutex` because spawning the child is racy (two
/// `gsr_*` commands could land in the same millisecond on first use) and we
/// don't want two Python instances.
#[derive(Default)]
pub struct SidecarState {
    inner: Mutex<Option<Arc<Sidecar>>>,
}

impl SidecarState {
    /// Returns the running sidecar, spawning it on first use.
    pub async fn get_or_spawn<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<Arc<Sidecar>, String> {
        let mut guard = self.inner.lock().await;
        if let Some(existing) = guard.as_ref() {
            if existing.is_alive() {
                return Ok(existing.clone());
            }
            // Child died (Python crashed, OOM, …) — drop the stale handle so
            // the next call respawns. Surfaces as one failed request; the
            // following one comes up healthy.
            log::warn!("gsr-sidecar process is no longer alive — will respawn");
            *guard = None;
        }
        let sc = Sidecar::spawn(app).await.map_err(|e| e.to_string())?;
        let arc = Arc::new(sc);
        *guard = Some(arc.clone());
        Ok(arc)
    }

    /// Best-effort shutdown of the sidecar process. Called from the
    /// `RunEvent::Exit` hook. Idempotent.
    pub async fn shutdown(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(sc) = guard.take() {
            sc.shutdown().await;
        }
    }
}

/// Register the streaming bridge with the Tauri app builder.
///
/// Adds the `SidecarState` to the managed-state pool. The actual command
/// registration happens in `lib.rs` because `tauri::generate_handler!` needs
/// to see the functions in the same crate root invocation.
pub fn manage<R: Runtime>(app: &AppHandle<R>) {
    app.manage(SidecarState::default());
}
