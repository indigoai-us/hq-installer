//! Persistent "Use Staging Channel" toggle.
//!
//! The App-menu check item under "About HQ Installer" routes the install
//! wizard's template fetch from `indigoai-us/hq-core` (latest stable release,
//! default) to `indigoai-us/hq-core-staging` (main branch HEAD). Persisting
//! the choice in `~/.hq/installer.json` keeps the toggle stable across
//! installer relaunches without entangling with `~/.hq/menubar.json` (which
//! HQ Sync owns).
//!
//! File schema (forward-compatible — unknown keys are preserved on write):
//!
//! ```json
//! { "useStagingSource": true }
//! ```
//!
//! Missing file, parse error, or missing key all resolve to `false` — the
//! safe default that mirrors today's "latest release from hq-core" behavior.

use serde_json::{Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

const STAGING_KEY: &str = "useStagingSource";
const STAGING_REPO: &str = "indigoai-us/hq-core-staging";

/// Default `~/.hq/installer.json`. Pulled out so callers can resolve the
/// path once and pass it both to the menu builder (on startup) and to the
/// menu-event handler (on toggle).
pub fn default_installer_pref_path() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or("home dir unavailable")?
        .join(".hq/installer.json"))
}

/// Read the `useStagingSource` flag from an explicit path. Any failure
/// (missing file, unreadable bytes, invalid JSON, missing/non-bool key)
/// resolves to `false` so the installer never gets stuck on a bad config.
pub fn read_use_staging_from(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    value
        .get(STAGING_KEY)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Write the `useStagingSource` flag, preserving any other keys already in
/// the file. Mirrors the key-merge pattern in `commands::menubar` so the
/// installer never wipes prefs it doesn't know about.
pub fn write_use_staging_to(path: PathBuf, enabled: bool) -> Result<(), String> {
    let mut obj: Map<String, Value> = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        Map::new()
    };

    obj.insert(STAGING_KEY.into(), Value::Bool(enabled));

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().ok();
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Tauri command exposed to the frontend: returns the current toggle value.
/// Called by `07-template.tsx` immediately before `fetchAndExtract` to route
/// the request at staging or stable hq-core.
#[tauri::command]
pub fn get_use_staging_source() -> bool {
    match default_installer_pref_path() {
        Ok(path) => read_use_staging_from(&path),
        Err(_) => false,
    }
}

/// Candidate `gh` install paths on macOS, in priority order. Tauri apps
/// bundled as .app don't inherit the user's shell PATH (launchd hands them a
/// minimal one), so `which::which("gh")` alone misses Homebrew installs on
/// both Apple Silicon and Intel. Looked up alongside any PATH match.
const GH_FALLBACK_PATHS: &[&str] = &[
    "/opt/homebrew/bin/gh", // Apple Silicon Homebrew
    "/usr/local/bin/gh",    // Intel Homebrew
    "/usr/bin/gh",          // System install (rare)
];

/// Resolve a usable path to the `gh` binary. Pure function so it can be
/// tested without depending on whatever `gh` happens to be on the host.
///
/// Strategy:
///   1. Prefer whatever the supplied `which_path` finder returns (typically
///      `which::which("gh")` driven by the current PATH).
///   2. Fall back to known Homebrew / system install paths in priority order.
///   3. Return `None` if neither resolves to an existing file.
fn resolve_gh_binary<F>(which_path: F, fallbacks: &[&str]) -> Option<PathBuf>
where
    F: FnOnce() -> Option<PathBuf>,
{
    if let Some(p) = which_path() {
        if p.exists() {
            return Some(p);
        }
    }
    for candidate in fallbacks {
        let p = PathBuf::from(candidate);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Returns the user's GitHub token via `gh auth token`.
///
/// Required when the staging toggle is on, because `indigoai-us/hq-core-staging`
/// is private and anonymous GitHub tarball requests return 404. Errors are
/// surfaced to the frontend as readable strings so the wizard can prompt the
/// user to run `gh auth login` (rather than dumping a generic 404).
///
/// Token bytes are never logged, persisted, or returned over IPC.
fn get_github_token() -> Result<String, String> {
    let gh = resolve_gh_binary(|| which::which("gh").ok(), GH_FALLBACK_PATHS).ok_or_else(|| {
        "GitHub CLI (`gh`) not found. Install with `brew install gh`, then run `gh auth login`."
            .to_string()
    })?;

    let output = Command::new(&gh)
        .args(["auth", "token"])
        .output()
        .map_err(|e| format!("Failed to invoke `{} auth token`: {}", gh.display(), e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            "no detail".to_string()
        } else {
            stderr
        };
        return Err(format!(
            "`gh auth token` failed (exit {}). Run `gh auth login` and retry. Detail: {}",
            output.status.code().unwrap_or(-1),
            detail,
        ));
    }

    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        return Err(
            "`gh auth token` returned empty output. Run `gh auth login` and retry.".to_string(),
        );
    }
    Ok(token)
}

fn staging_tarball_url(reference: &str) -> String {
    format!("https://api.github.com/repos/{STAGING_REPO}/tarball/{reference}")
}

fn download_staging_tarball_with_token(reference: &str, token: &str) -> Result<Vec<u8>, String> {
    if reference.trim().is_empty() || reference.contains('/') || reference.contains('\\') {
        return Err("Invalid staging ref".to_string());
    }

    let response = reqwest::blocking::Client::new()
        .get(staging_tarball_url(reference))
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header(
            reqwest::header::USER_AGENT,
            format!("hq-installer/{}", env!("CARGO_PKG_VERSION")),
        )
        .bearer_auth(token)
        .send()
        .map_err(|e| format!("Network error downloading staging template: {e}"))?;

    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("Staging template not found or GitHub token lacks access.".to_string());
    }
    if !status.is_success() {
        return Err(format!(
            "GitHub staging tarball download failed: HTTP {status}"
        ));
    }

    response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .map_err(|e| format!("Failed to read staging template bytes: {e}"))
}

/// Tauri command: downloads the private staging tarball without exposing the
/// GitHub token to the renderer. The renderer receives archive bytes only.
#[tauri::command]
pub fn download_staging_tarball() -> Result<Vec<u8>, String> {
    let token = get_github_token()?;
    download_staging_tarball_with_token("main", &token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tmpdir");
        let path = dir.path().join(".hq/installer.json");
        (dir, path)
    }

    #[test]
    fn round_trip_true() {
        let (_dir, path) = setup();
        write_use_staging_to(path.clone(), true).expect("write");
        assert!(read_use_staging_from(&path));
    }

    #[test]
    fn round_trip_false() {
        let (_dir, path) = setup();
        write_use_staging_to(path.clone(), false).expect("write");
        assert!(!read_use_staging_from(&path));
    }

    #[test]
    fn missing_file_defaults_false() {
        let (_dir, path) = setup();
        assert!(!read_use_staging_from(&path));
    }

    #[test]
    fn corrupt_file_defaults_false() {
        let (_dir, path) = setup();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"not json").unwrap();
        assert!(!read_use_staging_from(&path));
    }

    #[test]
    fn write_preserves_other_keys() {
        let (_dir, path) = setup();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"otherKey": "preserved"}"#).unwrap();

        write_use_staging_to(path.clone(), true).expect("write");

        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v["otherKey"], Value::String("preserved".into()));
        assert_eq!(v["useStagingSource"], Value::Bool(true));
    }

    #[test]
    fn resolve_gh_binary_prefers_which_when_exists() {
        let dir = tempfile::tempdir().expect("tmpdir");
        let gh_path = dir.path().join("gh");
        fs::write(&gh_path, b"#!/bin/sh\necho fake").unwrap();
        // Distinct fallback that also exists but should be ignored.
        let fallback = dir.path().join("other-gh");
        fs::write(&fallback, b"x").unwrap();
        let fallback_str = fallback.to_string_lossy().into_owned();
        let fallbacks: Vec<&str> = vec![fallback_str.as_str()];

        let resolved = resolve_gh_binary(|| Some(gh_path.clone()), &fallbacks);
        assert_eq!(resolved.as_deref(), Some(gh_path.as_path()));
    }

    #[test]
    fn resolve_gh_binary_falls_back_when_which_missing() {
        let dir = tempfile::tempdir().expect("tmpdir");
        let fallback = dir.path().join("gh");
        fs::write(&fallback, b"x").unwrap();
        let fallback_str = fallback.to_string_lossy().into_owned();
        let fallbacks: Vec<&str> = vec![fallback_str.as_str()];

        let resolved = resolve_gh_binary(|| None, &fallbacks);
        assert_eq!(resolved.as_deref(), Some(fallback.as_path()));
    }

    #[test]
    fn resolve_gh_binary_falls_back_when_which_path_missing_on_disk() {
        // `which` may return a stale path that no longer exists (uninstalled
        // tool). Resolver must skip it and try the fallbacks.
        let dir = tempfile::tempdir().expect("tmpdir");
        let stale = dir.path().join("does-not-exist/gh");
        let fallback = dir.path().join("gh");
        fs::write(&fallback, b"x").unwrap();
        let fallback_str = fallback.to_string_lossy().into_owned();
        let fallbacks: Vec<&str> = vec![fallback_str.as_str()];

        let resolved = resolve_gh_binary(|| Some(stale), &fallbacks);
        assert_eq!(resolved.as_deref(), Some(fallback.as_path()));
    }

    #[test]
    fn resolve_gh_binary_returns_none_when_nothing_available() {
        let resolved = resolve_gh_binary(|| None, &["/nonexistent/path/gh"]);
        assert!(resolved.is_none());
    }

    #[test]
    fn staging_tarball_url_targets_private_staging_repo_ref() {
        assert_eq!(
            staging_tarball_url("main"),
            "https://api.github.com/repos/indigoai-us/hq-core-staging/tarball/main"
        );
    }

    #[test]
    fn staging_download_rejects_path_like_refs_before_network() {
        let err = download_staging_tarball_with_token("../main", "secret").unwrap_err();
        assert_eq!(err, "Invalid staging ref");
    }

    #[test]
    fn toggle_round_trip() {
        let (_dir, path) = setup();
        // Off → on → off
        write_use_staging_to(path.clone(), false).unwrap();
        assert!(!read_use_staging_from(&path));
        write_use_staging_to(path.clone(), true).unwrap();
        assert!(read_use_staging_from(&path));
        write_use_staging_to(path.clone(), false).unwrap();
        assert!(!read_use_staging_from(&path));
    }
}
