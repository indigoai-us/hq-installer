//! hq-installer Tauri 2 runtime entry.
//!
//! Module layout mirrors the fork-and-share contract in
//! `docs/hq-install-spec.md`:
//!
//! - `core/` — pure Rust ports of `create-hq/src/*.ts` (no Tauri deps).
//! - `commands/` — thin `#[tauri::command]` wrappers exposed to the renderer.

pub mod commands;
pub mod core;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::platform::detect_platform,
            commands::deps::dep_registry,
            commands::deps::check_deps,
            commands::deps::install_dep,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
