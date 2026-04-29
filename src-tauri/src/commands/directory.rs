// commands/directory.rs — US-015
//
// Native folder picker + HQ marker detection.
//
// `pick_directory` opens an NSOpenPanel via tauri-plugin-dialog and returns
// the selected absolute path (or null on cancel). It is an ASYNC Tauri
// command that drives the non-blocking `pick_folder(callback)` API and
// bridges the result via a oneshot channel. This is the macOS-safe pattern:
// `blocking_pick_folder` on macOS requires the AppKit main thread, and when
// called from a sync command worker thread it deadlocks — particularly after
// the user moves focus away from the app window.
//
// `detect_hq` returns whether the supplied path exists and whether it looks
// like an HQ install. The marker check is intentionally loose: the presence
// of `companies/manifest.yaml` OR `.claude/CLAUDE.md` is enough to call it HQ.
// Server-side per the test contract (06-directory.test.tsx) — frontend MUST
// NOT do inline file checks.

use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

/// Expand a leading `~/` or bare `~` into `$HOME`. Falls back to the literal
/// string if `$HOME` is not set, which on macOS effectively never happens.
fn expand_tilde(s: &str) -> PathBuf {
    if s == "~" {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home);
        }
    }
    if let Some(rest) = s.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(s)
}

#[tauri::command]
pub async fn pick_directory(
    app: AppHandle,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    let mut builder = app.dialog().file();

    // Seed the dialog with the suggested starting directory if it exists.
    // NSOpenPanel rejects paths that don't exist, so we silently skip them
    // rather than erroring — the user just gets the system default.
    if let Some(p) = default_path.as_deref() {
        let expanded = expand_tilde(p);
        if expanded.exists() {
            builder = builder.set_directory(expanded);
        }
    }

    // Non-blocking `pick_folder` hands the result to the supplied callback
    // on the plugin's main-thread dispatcher. We forward it through a
    // oneshot channel so this async command can await it without ever
    // blocking a worker thread on AppKit.
    let (tx, rx) = oneshot::channel();
    builder.pick_folder(move |file_path| {
        let _ = tx.send(file_path);
    });

    match rx.await {
        Ok(Some(fp)) => fp
            .into_path()
            .map(|p| Some(p.to_string_lossy().into_owned()))
            .map_err(|e| format!("invalid path returned from dialog: {e}")),
        Ok(None) => Ok(None),
        Err(_) => Err("dialog channel closed before a result was delivered".to_string()),
    }
}

#[derive(Serialize)]
pub struct DetectHqResult {
    pub exists: bool,
    #[serde(rename = "isHq")]
    pub is_hq: bool,
}

#[derive(Serialize, Debug)]
pub struct CreateDirectoryResult {
    /// Absolute path of the resulting directory (parent + name joined).
    pub path: String,
    /// True when the directory existed prior to this call. False when this
    /// call created it. Lets the frontend decide whether to surface a
    /// "directory already exists" state vs. a fresh creation.
    pub already_existed: bool,
    /// True when the directory was non-empty at the moment of creation.
    /// Frontend uses this to warn before installing on top of arbitrary files.
    pub non_empty: bool,
}

/// Create `{parent}/{name}` if missing and report what was found.
///
/// Mirrors the safety checks in `detect_hq`: callers can chain
/// `create_directory` → `detect_hq` to learn whether the resulting path is
/// fresh, an existing HQ, or a non-empty foreign directory.
#[tauri::command]
pub fn create_directory(parent: String, name: String) -> Result<CreateDirectoryResult, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }
    if trimmed_name.contains('/') || trimmed_name.contains('\\') {
        return Err("Folder name cannot contain path separators".to_string());
    }

    let parent_path = expand_tilde(&parent);
    if !parent_path.exists() {
        return Err(format!(
            "Parent directory does not exist: {}",
            parent_path.display()
        ));
    }

    let target = parent_path.join(trimmed_name);
    let already_existed = target.exists();
    if !already_existed {
        std::fs::create_dir_all(&target)
            .map_err(|e| format!("Failed to create {}: {}", target.display(), e))?;
    }

    let non_empty = if target.is_dir() {
        match std::fs::read_dir(&target) {
            Ok(mut entries) => entries.next().is_some(),
            Err(_) => false,
        }
    } else {
        false
    };

    Ok(CreateDirectoryResult {
        path: target.to_string_lossy().into_owned(),
        already_existed,
        non_empty,
    })
}

#[tauri::command]
pub fn detect_hq(path: String) -> DetectHqResult {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return DetectHqResult {
            exists: false,
            is_hq: false,
        };
    }
    // Either marker is sufficient. `companies/manifest.yaml` is the strongest
    // signal (HQ-specific); `.claude/CLAUDE.md` covers older HQ trees that
    // didn't yet ship a manifest.
    let is_hq = p.join("companies/manifest.yaml").exists() || p.join(".claude/CLAUDE.md").exists();
    DetectHqResult {
        exists: true,
        is_hq,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn detect_hq_missing_path_returns_exists_false() {
        let r = detect_hq("/definitely/does/not/exist/9f8a7b6c".to_string());
        assert!(!r.exists);
        assert!(!r.is_hq);
    }

    #[test]
    fn detect_hq_existing_non_hq_dir() {
        let dir = tempdir().unwrap();
        let r = detect_hq(dir.path().to_string_lossy().into_owned());
        assert!(r.exists);
        assert!(!r.is_hq);
    }

    #[test]
    fn detect_hq_recognizes_manifest_marker() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("companies")).unwrap();
        fs::write(dir.path().join("companies/manifest.yaml"), "").unwrap();
        let r = detect_hq(dir.path().to_string_lossy().into_owned());
        assert!(r.exists);
        assert!(r.is_hq);
    }

    #[test]
    fn detect_hq_recognizes_claude_marker() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".claude")).unwrap();
        fs::write(dir.path().join(".claude/CLAUDE.md"), "").unwrap();
        let r = detect_hq(dir.path().to_string_lossy().into_owned());
        assert!(r.exists);
        assert!(r.is_hq);
    }

    #[test]
    fn expand_tilde_handles_prefix() {
        std::env::set_var("HOME", "/Users/test");
        assert_eq!(expand_tilde("~/hq"), PathBuf::from("/Users/test/hq"));
        assert_eq!(expand_tilde("~"), PathBuf::from("/Users/test"));
        assert_eq!(expand_tilde("/abs/path"), PathBuf::from("/abs/path"));
    }

    #[test]
    fn create_directory_makes_fresh_subfolder() {
        let parent = tempdir().unwrap();
        let result = create_directory(
            parent.path().to_string_lossy().into_owned(),
            "hq".to_string(),
        )
        .unwrap();
        assert!(!result.already_existed);
        assert!(!result.non_empty);
        assert!(parent.path().join("hq").exists());
    }

    #[test]
    fn create_directory_detects_existing_non_empty() {
        let parent = tempdir().unwrap();
        let target = parent.path().join("hq");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("README.md"), "x").unwrap();
        let result = create_directory(
            parent.path().to_string_lossy().into_owned(),
            "hq".to_string(),
        )
        .unwrap();
        assert!(result.already_existed);
        assert!(result.non_empty);
    }

    #[test]
    fn create_directory_rejects_path_separators_in_name() {
        let parent = tempdir().unwrap();
        let err = create_directory(
            parent.path().to_string_lossy().into_owned(),
            "evil/path".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("path separators"));
    }

    #[test]
    fn create_directory_rejects_missing_parent() {
        let err = create_directory(
            "/definitely/does/not/exist/zzzz".to_string(),
            "hq".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("does not exist"));
    }
}
