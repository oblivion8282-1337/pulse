//! Tauri `#[command]` thin wrappers around the sidecar's RPC.
//!
//! Each command lazily spawns the sidecar (via `SidecarState::get_or_spawn`)
//! and routes through a single `call_op` helper. Errors come back to the
//! frontend as JSON-stringified strings — the typed wrapper in `web/src/lib/
//! stream/gsr.ts` re-shapes them.

use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Runtime, State};

use super::SidecarState;

/// Slow ops get a longer per-call timeout. `start` waits for the Wayland
/// portal dialog (user interaction!) and for GSR to actually open its
/// pipeline; `stop` does a soft-kill with up to 5s of escalation in the
/// controller.
const START_TIMEOUT: Duration = Duration::from_secs(60);
const STOP_TIMEOUT: Duration = Duration::from_secs(15);

async fn call_op<R: Runtime>(
    app: &AppHandle<R>,
    state: &State<'_, SidecarState>,
    op: &str,
    params: Value,
    op_timeout: Option<Duration>,
) -> Result<Value, String> {
    let sc = state.get_or_spawn(app).await?;
    sc.call(op, params, op_timeout).await
}

#[tauri::command]
pub async fn gsr_health<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SidecarState>,
) -> Result<Value, String> {
    call_op(&app, &state, "health", Value::Null, None).await
}

#[tauri::command]
pub async fn gsr_gpu_info<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SidecarState>,
) -> Result<Value, String> {
    call_op(&app, &state, "gpu_info", Value::Null, None).await
}

#[tauri::command]
pub async fn gsr_list_monitors<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SidecarState>,
) -> Result<Value, String> {
    call_op(&app, &state, "list_monitors", Value::Null, None).await
}

#[tauri::command]
pub async fn gsr_list_profiles<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SidecarState>,
) -> Result<Value, String> {
    call_op(&app, &state, "list_profiles", Value::Null, None).await
}

#[tauri::command]
pub async fn gsr_list_application_audio<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SidecarState>,
) -> Result<Value, String> {
    call_op(&app, &state, "list_application_audio", Value::Null, None).await
}

#[tauri::command]
pub async fn gsr_build_argv<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SidecarState>,
    args: Value,
) -> Result<Value, String> {
    call_op(&app, &state, "build_argv", args, None).await
}

#[tauri::command]
pub async fn gsr_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SidecarState>,
    args: Value,
) -> Result<Value, String> {
    call_op(&app, &state, "start", args, Some(START_TIMEOUT)).await
}

#[tauri::command]
pub async fn gsr_stop<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SidecarState>,
) -> Result<Value, String> {
    call_op(&app, &state, "stop", Value::Null, Some(STOP_TIMEOUT)).await
}

#[tauri::command]
pub async fn gsr_state<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SidecarState>,
) -> Result<Value, String> {
    call_op(&app, &state, "state", Value::Null, None).await
}
