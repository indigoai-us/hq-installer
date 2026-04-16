// commands/directory.rs — US-015
//
// Native folder picker + HQ marker detection.
//
// `pick_directory` opens an NSOpenPanel via tauri-plugin-dialog and returns
// the selected absolute path (or null on cancel). It runs as a sync Tauri
// command so the dialog plugin's `blocking_pick_folder` can dispatch to the
// macOS main thread internally — Tauri executes sync commands on a worker
// thread, so we don't deadlock the JS bridge.
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
pub fn pick_directory(
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

    match builder.blocking_pick_folder() {
        Some(fp) => fp
            .into_path()
            .map(|p| Some(p.to_string_lossy().into_owned()))
            .map_err(|e| format!("invalid path returned from dialog: {e}")),
        None => Ok(None),
    }
}

#[derive(Serialize)]
pub struct DetectHqResult {
    pub exists: bool,
    #[serde(rename = "isHq")]
    pub is_hq: bool,
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
    let is_hq = p.join("companies/manifest.yaml").exists()
        || p.join(".claude/CLAUDE.md").exists();
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
}
