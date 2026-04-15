//! Tauri invoke commands exposed to the renderer.
//!
//! Each submodule owns one domain (platform detection, dependency install,
//! scaffold, cloud sync, etc.) and re-exports the `#[tauri::command]` entry
//! points consumed by `lib.rs::run`.

pub mod cloud;
pub mod deps;
pub mod platform;
pub mod scaffold;
