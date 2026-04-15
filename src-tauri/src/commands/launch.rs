//! Tauri invoke commands for the Success screen (US-009).
//!
//! Two entry points:
//!   * `launch_claude_code(cwd)` — spawns `claude` in the user's freshly
//!     installed HQ directory so they can immediately start working.
//!   * `reveal_in_file_manager(path)` — opens the platform file manager
//!     (Finder on macOS, Explorer on Windows, xdg-open on Linux) at the
//!     given path.
//!
//! Both commands are *fire-and-forget*: they spawn a detached child
//! process and return the outcome of the spawn itself (not the child's
//! exit status). The installer window stays up until the user closes it
//! explicitly — we don't want the GUI to vanish the moment they click
//! the CTA.
//!
//! # Why not plugin-shell's command API?
//!
//! `tauri-plugin-shell` has a `Command` API, but it requires every
//! executable to be declared in the app's capabilities manifest with a
//! full arg allowlist. For an installer that hands off to *any*
//! arbitrary HQ directory + whichever `claude` binary is on `PATH`,
//! that allowlist approach is awkward. A direct `std::process::Command`
//! spawn from inside a Tauri command runs in the installer's own
//! process context and sidesteps the allowlist entirely.

use std::path::PathBuf;
use std::process::Command;

/// Outcome of a launch attempt, serialized as a kebab-case discriminated
/// union so the renderer can branch on `result`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case", tag = "result")]
pub enum LaunchOutcome {
    /// Child process spawned successfully. `pid` is best-effort — some
    /// platforms may not surface it for detached children.
    Spawned {
        command: String,
        pid: Option<u32>,
    },
    /// Spawn failed. `kind` classifies the failure so the renderer can
    /// pick the right fallback UI (copyable command vs generic error).
    Err {
        kind: LaunchErrorKind,
        message: String,
    },
}

/// Stable categorization of launch failures for the renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LaunchErrorKind {
    /// The target binary wasn't found on `PATH` (ENOENT). User should
    /// see a fallback like "copy this command" instead of a raw error.
    NotFound,
    /// Target path doesn't exist on disk.
    CwdMissing,
    /// Catch-all for IO errors during spawn.
    SpawnFailed,
}

/// Launch Claude Code in the user's HQ directory.
///
/// Pure function so unit tests don't actually spawn anything — they
/// drive the error paths with a faked `spawner`. The `#[tauri::command]`
/// wrapper at the bottom pins the real spawner.
pub fn launch_claude_code_with<F>(cwd: String, spawner: F) -> LaunchOutcome
where
    F: FnOnce(&str, &PathBuf) -> std::io::Result<Option<u32>>,
{
    let cwd_path = PathBuf::from(&cwd);
    if !cwd_path.exists() {
        return LaunchOutcome::Err {
            kind: LaunchErrorKind::CwdMissing,
            message: format!("{} does not exist", cwd),
        };
    }

    match spawner("claude", &cwd_path) {
        Ok(pid) => LaunchOutcome::Spawned {
            command: "claude".to_string(),
            pid,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => LaunchOutcome::Err {
            kind: LaunchErrorKind::NotFound,
            message: "claude CLI is not on PATH — install Claude Code first".to_string(),
        },
        Err(e) => LaunchOutcome::Err {
            kind: LaunchErrorKind::SpawnFailed,
            message: e.to_string(),
        },
    }
}

/// Open the given path in the system file manager.
///
/// Same shape as `launch_claude_code_with` — test seam via `spawner`.
pub fn reveal_in_file_manager_with<F>(path: String, spawner: F) -> LaunchOutcome
where
    F: FnOnce(&str, &[&str]) -> std::io::Result<Option<u32>>,
{
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return LaunchOutcome::Err {
            kind: LaunchErrorKind::CwdMissing,
            message: format!("{} does not exist", path),
        };
    }

    let (bin, args): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("open", vec![&path])
    } else if cfg!(target_os = "windows") {
        ("explorer", vec![&path])
    } else {
        // Linux fallback: xdg-open works for most desktop environments.
        ("xdg-open", vec![&path])
    };

    match spawner(bin, &args) {
        Ok(pid) => LaunchOutcome::Spawned {
            command: bin.to_string(),
            pid,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => LaunchOutcome::Err {
            kind: LaunchErrorKind::NotFound,
            message: format!("{} is not on PATH", bin),
        },
        Err(e) => LaunchOutcome::Err {
            kind: LaunchErrorKind::SpawnFailed,
            message: e.to_string(),
        },
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Real spawners (production)
// ─────────────────────────────────────────────────────────────────────────

fn spawn_claude_real(bin: &str, cwd: &PathBuf) -> std::io::Result<Option<u32>> {
    let child = Command::new(bin).current_dir(cwd).spawn()?;
    Ok(Some(child.id()))
}

fn spawn_reveal_real(bin: &str, args: &[&str]) -> std::io::Result<Option<u32>> {
    let child = Command::new(bin).args(args).spawn()?;
    Ok(Some(child.id()))
}

// ─────────────────────────────────────────────────────────────────────────
// Tauri command entry points
// ─────────────────────────────────────────────────────────────────────────

/// Renderer-visible wrapper around `launch_claude_code_with`.
#[tauri::command]
pub async fn launch_claude_code(cwd: String) -> LaunchOutcome {
    launch_claude_code_with(cwd, spawn_claude_real)
}

/// Renderer-visible wrapper around `reveal_in_file_manager_with`.
#[tauri::command]
pub async fn reveal_in_file_manager(path: String) -> LaunchOutcome {
    reveal_in_file_manager_with(path, spawn_reveal_real)
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn launch_claude_code_with_missing_cwd_returns_cwd_missing() {
        let result = launch_claude_code_with(
            "/nonexistent/path/that/should/not/exist/xyz-12345".to_string(),
            |_, _| unreachable!("spawner must not be called"),
        );
        match result {
            LaunchOutcome::Err { kind, .. } => {
                assert_eq!(kind, LaunchErrorKind::CwdMissing)
            }
            other => panic!("expected CwdMissing, got {:?}", other),
        }
    }

    #[test]
    fn launch_claude_code_with_notfound_maps_to_not_found_kind() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let result = launch_claude_code_with(
            tmp.path().to_string_lossy().to_string(),
            |_, _| Err(io::Error::new(io::ErrorKind::NotFound, "no such binary")),
        );
        match result {
            LaunchOutcome::Err { kind, message } => {
                assert_eq!(kind, LaunchErrorKind::NotFound);
                assert!(message.contains("PATH"), "message mentions PATH");
            }
            other => panic!("expected NotFound, got {:?}", other),
        }
    }

    #[test]
    fn launch_claude_code_with_generic_io_maps_to_spawn_failed() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let result = launch_claude_code_with(
            tmp.path().to_string_lossy().to_string(),
            |_, _| Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied")),
        );
        match result {
            LaunchOutcome::Err { kind, .. } => {
                assert_eq!(kind, LaunchErrorKind::SpawnFailed)
            }
            other => panic!("expected SpawnFailed, got {:?}", other),
        }
    }

    #[test]
    fn launch_claude_code_with_success_returns_spawned() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let result = launch_claude_code_with(
            tmp.path().to_string_lossy().to_string(),
            |bin, _| {
                assert_eq!(bin, "claude");
                Ok(Some(4242))
            },
        );
        match result {
            LaunchOutcome::Spawned { command, pid } => {
                assert_eq!(command, "claude");
                assert_eq!(pid, Some(4242));
            }
            other => panic!("expected Spawned, got {:?}", other),
        }
    }

    #[test]
    fn reveal_in_file_manager_with_missing_path_returns_cwd_missing() {
        let result = reveal_in_file_manager_with(
            "/nonexistent/xyz-67890".to_string(),
            |_, _| unreachable!("spawner must not be called"),
        );
        match result {
            LaunchOutcome::Err { kind, .. } => {
                assert_eq!(kind, LaunchErrorKind::CwdMissing)
            }
            other => panic!("expected CwdMissing, got {:?}", other),
        }
    }

    #[test]
    fn reveal_in_file_manager_with_success_picks_platform_binary() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let result = reveal_in_file_manager_with(
            tmp.path().to_string_lossy().to_string(),
            |bin, args| {
                // Pinning exact bin name here is OS-conditional; just assert
                // we got one of the expected values and that the path made
                // it into the args array.
                assert!(
                    matches!(bin, "open" | "explorer" | "xdg-open"),
                    "unexpected binary: {}",
                    bin
                );
                assert_eq!(args.len(), 1, "should pass the path as the only arg");
                Ok(Some(1337))
            },
        );
        match result {
            LaunchOutcome::Spawned { pid, .. } => assert_eq!(pid, Some(1337)),
            other => panic!("expected Spawned, got {:?}", other),
        }
    }

    #[test]
    fn launch_outcome_serializes_kebab_case_tag() {
        let v = LaunchOutcome::Spawned {
            command: "claude".to_string(),
            pid: Some(1),
        };
        let json = serde_json::to_string(&v).expect("serde");
        assert!(json.contains("\"result\":\"spawned\""));
        assert!(json.contains("\"command\":\"claude\""));
    }

    #[test]
    fn launch_error_kind_serializes_kebab_case() {
        let v = LaunchOutcome::Err {
            kind: LaunchErrorKind::NotFound,
            message: "x".to_string(),
        };
        let json = serde_json::to_string(&v).expect("serde");
        assert!(json.contains("\"kind\":\"not-found\""));
        assert!(json.contains("\"result\":\"err\""));
    }
}
