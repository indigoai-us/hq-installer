//! Tauri invoke command for platform detection.
//!
//! The renderer calls `invoke<PlatformInfo>('detect_platform')` on mount to
//! drive the dependency-install step of the wizard. This thin command is the
//! only Tauri surface for the core platform module — the actual detection
//! logic lives in `core::platform`.

use crate::core::platform::{self, PlatformInfo};

/// Detect the host OS, native package manager, and npm availability.
///
/// This is a synchronous, read-only probe — safe to call on every wizard
/// mount without side effects.
#[tauri::command]
pub fn detect_platform() -> PlatformInfo {
    platform::detect_platform()
}
