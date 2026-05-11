// Tauri 2 build script.
//
// For app-defined `#[tauri::command]` functions we need ACL permissions in the
// capability file, and tauri-build can autogenerate `allow-<command>` /
// `deny-<command>` permissions when we list them here. The bridge to the
// gsr-sidecar (T3a) introduces 9 such commands; see `src/streaming/`.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "gsr_health",
                "gsr_gpu_info",
                "gsr_list_monitors",
                "gsr_list_profiles",
                "gsr_list_application_audio",
                "gsr_build_argv",
                "gsr_start",
                "gsr_stop",
                "gsr_state",
            ]),
        ),
    )
    .expect("tauri build failed");
}
