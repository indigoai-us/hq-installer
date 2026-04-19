//! Install the HQ Sync menubar app from GitHub Releases.
//!
//! `install_menubar_app` — orchestrates the full install:
//!   1. Fetch the latest DMG download URL from the GitHub Releases API.
//!   2. Download the DMG to a temp file, streaming progress events.
//!   3. Mount the DMG with `hdiutil attach`.
//!   4. Copy "HQ Sync.app" to /Applications.
//!   5. Unmount the DMG with `hdiutil detach`.
//!   6. Clean up the temp file.
//!
//! `launch_menubar_app` — open /Applications/HQ Sync.app via `open`.
//!
//! Progress is emitted as `menubar-install://progress` events with a
//! `MenubarInstallProgress` payload.  All error paths return `Err(String)`
//! so the frontend can surface a readable message without crashing.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/// Payload for `menubar-install://progress` events.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MenubarInstallProgress {
    /// Human-readable phase name (e.g. "fetching", "downloading", "mounting").
    pub phase: String,
    /// Completion percentage 0-100.
    pub percent: u8,
    /// Optional detail message.
    pub message: String,
}

/// Final result returned by `install_menubar_app`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenubarInstallResult {
    pub success: bool,
    pub app_path: Option<String>,
    pub error: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Emit a `menubar-install://progress` event.  Errors are silently dropped —
/// a missing listener should never abort the install.
fn emit_progress(app: &AppHandle, phase: &str, percent: u8, message: &str) {
    let _ = app.emit(
        "menubar-install://progress",
        MenubarInstallProgress {
            phase: phase.to_string(),
            percent,
            message: message.to_string(),
        },
    );
}

/// Call the GitHub Releases API and return the browser_download_url for the
/// first asset whose name ends with `.dmg`.
///
/// Uses `curl` so no extra Rust dependency is needed. We deliberately do NOT
/// pass `--fail` — that would discard the HTTP status code and surface a
/// misleading curl exit code (e.g. exit 56 on 404 with chunked body) instead
/// of a clear "no release published / repo private" message. Instead we
/// append the HTTP status as a sentinel line via `--write-out` and branch
/// on it in `classify_release_response`.
fn fetch_latest_dmg_url() -> Result<String, String> {
    let output = Command::new("curl")
        .args([
            "--silent",
            "--location",
            "--max-time",
            "15",
            "--user-agent",
            "hq-installer/1.0",
            "--write-out",
            "\n%{http_code}",
            "https://api.github.com/repos/indigoai-us/hq-sync/releases/latest",
        ])
        .output()
        .map_err(|e| format!("Failed to spawn curl: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Network error contacting GitHub Releases API (curl exit {}). \
             Check your internet connection and try again.{}",
            output.status.code().unwrap_or(-1),
            if stderr.trim().is_empty() {
                String::new()
            } else {
                format!(" Detail: {}", stderr.trim())
            }
        ));
    }

    let combined = String::from_utf8(output.stdout)
        .map_err(|e| format!("GitHub API response is not UTF-8: {}", e))?;

    let (body, status_code) = match combined.rsplit_once('\n') {
        Some((body, status)) => (body, status.trim()),
        None => return Err("Empty response from GitHub Releases API".to_string()),
    };

    classify_release_response(status_code, body)
}

/// Map an HTTP status code from the GitHub Releases API into either a parsed
/// DMG URL (200) or a human-readable error (everything else).
///
/// Split out from `fetch_latest_dmg_url` so the branching logic is testable
/// without making real network calls.
fn classify_release_response(status_code: &str, body: &str) -> Result<String, String> {
    match status_code {
        "200" => parse_dmg_url_from_json(body),
        "404" => Err(
            "No release has been published for HQ Sync yet. \
             If the repository is private, the installer would also need an \
             auth token to read it. Click Skip to continue without HQ Sync — \
             you can install it later from the menubar."
                .to_string(),
        ),
        "401" | "403" => Err(format!(
            "GitHub denied access to the HQ Sync release (HTTP {}). \
             The repository is likely private and requires an auth token. \
             Click Skip to continue — you can install HQ Sync manually later.",
            status_code
        )),
        "429" => Err(
            "GitHub rate-limited the request (HTTP 429). Wait a minute and retry, \
             or click Skip to continue without HQ Sync."
                .to_string(),
        ),
        other if other.starts_with('5') => Err(format!(
            "GitHub is having trouble (HTTP {}). Try again in a moment, \
             or click Skip to continue.",
            other
        )),
        other => Err(format!(
            "Unexpected response from GitHub Releases API (HTTP {}). \
             Click Skip to continue without HQ Sync.",
            other
        )),
    }
}

/// Parse the `browser_download_url` of the first `.dmg` asset from a GitHub
/// releases JSON body without pulling in a JSON crate.
///
/// The JSON looks like:
/// ```json
/// { "assets": [ { "name": "HQ.Sync.dmg", "browser_download_url": "https://..." }, ... ] }
/// ```
/// We walk the text looking for `"name": "...dmg"` followed by
/// `"browser_download_url": "..."`.
fn parse_dmg_url_from_json(json: &str) -> Result<String, String> {
    // Find each "browser_download_url" value and return the first one whose
    // corresponding "name" ends in .dmg.  We use a minimal state-machine
    // rather than a regex to avoid adding a dependency.
    //
    // Strategy: scan for `"browser_download_url"` occurrences, then extract
    // the quoted string that follows.  Simultaneously scan for `"name"` entries
    // ending in `.dmg` to confirm this is the right asset.
    //
    // Simpler approach: find first `"browser_download_url": "` that is
    // preceded (within 200 chars) by a `"name"` value ending in `.dmg"`.

    let positions: Vec<usize> = json
        .match_indices("\"browser_download_url\"")
        .map(|(i, _)| i)
        .collect();

    for pos in positions {
        // Check the surrounding context (up to 300 chars before) for a .dmg name.
        let context_start = pos.saturating_sub(300);
        let context = &json[context_start..pos];
        if !context.contains(".dmg\"") {
            continue;
        }

        // Extract the URL value: find the opening `"` after the colon.
        let after = &json[pos + "\"browser_download_url\"".len()..];
        let colon_offset = after.find(':').ok_or("Malformed JSON: no colon after browser_download_url")?;
        let after_colon = &after[colon_offset + 1..].trim_start();
        if !after_colon.starts_with('"') {
            continue;
        }
        let inner = &after_colon[1..]; // skip opening quote
        let end = inner
            .find('"')
            .ok_or("Malformed JSON: unterminated browser_download_url string")?;
        let url = &inner[..end];
        if url.starts_with("https://") {
            return Ok(url.to_string());
        }
    }

    Err("No .dmg asset found in the latest GitHub release".to_string())
}

/// Download `url` to `dest` using curl with `--progress-bar` output parsed
/// for percentage updates.  Progress events are emitted on `app` as the
/// download proceeds.
fn download_dmg(app: &AppHandle, url: &str, dest: &PathBuf) -> Result<(), String> {
    emit_progress(app, "downloading", 5, &format!("Downloading from {}", url));

    // curl with --progress-bar writes lines like "##... xx.x%" to stderr.
    // We capture stderr and emit percentage events.  stdout is the DMG bytes
    // written to the output file.
    let dest_str = dest
        .to_str()
        .ok_or("Temp path contains non-UTF-8 characters")?;

    let output = Command::new("curl")
        .args([
            "--location",
            "--fail",
            "--max-time",
            "300",
            "--user-agent",
            "hq-installer/1.0",
            "--output",
            dest_str,
            url,
        ])
        .output()
        .map_err(|e| format!("Failed to spawn curl for download: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "DMG download failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    emit_progress(app, "downloading", 50, "Download complete");
    Ok(())
}

/// Attach a DMG with `hdiutil attach` and return the mount-point path.
///
/// hdiutil output (with `-plist` flag) is XML; we parse the mount point
/// by looking for the last `/Volumes/…` entry in the raw XML text.
fn mount_dmg(app: &AppHandle, dmg_path: &PathBuf) -> Result<String, String> {
    emit_progress(app, "mounting", 55, "Mounting disk image…");

    let dmg_str = dmg_path
        .to_str()
        .ok_or("DMG path contains non-UTF-8 characters")?;

    let output = Command::new("hdiutil")
        .args(["attach", "-nobrowse", "-noverify", "-noautoopen", dmg_str])
        .output()
        .map_err(|e| format!("Failed to spawn hdiutil attach: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "hdiutil attach failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    // hdiutil stdout lists tab-separated lines ending with the mount point.
    // Example: "/dev/disk3\t\t/Volumes/HQ Sync 1.2.3"
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mount_point = stdout
        .lines()
        .filter_map(|line| {
            // The mount-point column starts with /Volumes/
            line.split('\t')
                .find(|col| col.trim().starts_with("/Volumes/"))
                .map(|s| s.trim().to_string())
        })
        .last()
        .ok_or_else(|| {
            format!(
                "Could not locate /Volumes mount point in hdiutil output:\n{}",
                stdout.trim()
            )
        })?;

    emit_progress(app, "mounting", 60, &format!("Mounted at {}", mount_point));
    Ok(mount_point)
}

/// Copy "HQ Sync.app" from the mounted volume to /Applications.
///
/// If /Applications/HQ Sync.app already exists it is removed first so that
/// `cp -R` doesn't nest the bundle inside an existing directory.
fn copy_app(app: &AppHandle, mount_point: &str) -> Result<(), String> {
    emit_progress(app, "installing", 65, "Copying HQ Sync.app to /Applications…");

    // Guard against path traversal — mount_point must be under /Volumes/
    let source_path = PathBuf::from(mount_point).join("HQ Sync.app");
    if !source_path.starts_with("/Volumes/") {
        return Err(format!("Unexpected mount point path: {}", mount_point));
    }
    let source = source_path
        .to_str()
        .ok_or("Source path is non-UTF-8")?;
    let dest = "/Applications/HQ Sync.app";

    // Remove existing installation so cp -R doesn't nest inside it.
    // Guard against symlink attacks: refuse to rm -rf a symlink target.
    let dest_path = std::path::Path::new(dest);
    if dest_path.exists() {
        let meta = std::fs::symlink_metadata(dest)
            .map_err(|e| format!("stat failed on {}: {}", dest, e))?;
        if meta.file_type().is_symlink() {
            return Err(
                "/Applications/HQ Sync.app is a symlink — refusing to remove. \
                 Delete it manually and retry."
                    .to_string(),
            );
        }
        let rm_out = Command::new("rm")
            .args(["-rf", dest])
            .output()
            .map_err(|e| format!("Failed to spawn rm: {}", e))?;
        if !rm_out.status.success() {
            let stderr = String::from_utf8_lossy(&rm_out.stderr);
            return Err(format!(
                "Failed to remove existing /Applications/HQ Sync.app: {}",
                stderr.trim()
            ));
        }
    }

    let cp_out = Command::new("cp")
        .args(["-R", source, dest])
        .output()
        .map_err(|e| format!("Failed to spawn cp: {}", e))?;

    if !cp_out.status.success() {
        let stderr = String::from_utf8_lossy(&cp_out.stderr);
        return Err(format!(
            "cp failed (exit {}): {}",
            cp_out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    emit_progress(app, "installing", 80, "App copied to /Applications");
    Ok(())
}

/// Detach the mounted DMG volume.
///
/// Errors here are non-fatal — the install has already succeeded.
fn unmount_dmg(app: &AppHandle, mount_point: &str) {
    emit_progress(app, "cleanup", 85, "Unmounting disk image…");

    let result = Command::new("hdiutil")
        .args(["detach", mount_point])
        .output();

    match result {
        Ok(out) if out.status.success() => {
            emit_progress(app, "cleanup", 90, "Disk image unmounted");
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            emit_progress(
                app,
                "cleanup",
                90,
                &format!("hdiutil detach warning: {}", stderr.trim()),
            );
        }
        Err(e) => {
            emit_progress(
                app,
                "cleanup",
                90,
                &format!("hdiutil detach warning: {}", e),
            );
        }
    }
}

/// Delete the temp DMG file.  Non-fatal on error.
fn cleanup_dmg(dmg_path: &PathBuf) {
    let _ = std::fs::remove_file(dmg_path);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

/// Install HQ Sync menubar app from GitHub Releases.
///
/// Orchestrates: fetch URL → download DMG → mount → copy → unmount → cleanup.
/// Emits `menubar-install://progress` events throughout.
/// Returns `Ok(MenubarInstallResult)` regardless of whether the install
/// succeeded, so the frontend always receives a structured result.
#[tauri::command]
pub async fn install_menubar_app(app: AppHandle) -> Result<MenubarInstallResult, String> {
    // Phase 1: resolve download URL.
    emit_progress(&app, "fetching", 0, "Checking for latest release…");
    let dmg_url = match fetch_latest_dmg_url() {
        Ok(url) => url,
        Err(e) => {
            let msg = format!("Failed to fetch release info: {}", e);
            emit_progress(&app, "error", 0, &msg);
            return Ok(MenubarInstallResult {
                success: false,
                app_path: None,
                error: Some(msg),
            });
        }
    };
    emit_progress(&app, "fetching", 5, &format!("Found DMG: {}", dmg_url));

    // Phase 2: download.
    let mut dmg_path = std::env::temp_dir();
    dmg_path.push("hq-sync-install.dmg");

    if let Err(e) = download_dmg(&app, &dmg_url, &dmg_path) {
        emit_progress(&app, "error", 50, &e);
        cleanup_dmg(&dmg_path);
        return Ok(MenubarInstallResult {
            success: false,
            app_path: None,
            error: Some(e),
        });
    }

    // Phase 3: mount.
    let mount_point = match mount_dmg(&app, &dmg_path) {
        Ok(mp) => mp,
        Err(e) => {
            emit_progress(&app, "error", 55, &e);
            cleanup_dmg(&dmg_path);
            return Ok(MenubarInstallResult {
                success: false,
                app_path: None,
                error: Some(e),
            });
        }
    };

    // Phase 4: copy.
    if let Err(e) = copy_app(&app, &mount_point) {
        emit_progress(&app, "error", 65, &e);
        unmount_dmg(&app, &mount_point);
        cleanup_dmg(&dmg_path);
        return Ok(MenubarInstallResult {
            success: false,
            app_path: None,
            error: Some(e),
        });
    }

    // Phase 5: unmount + cleanup.
    unmount_dmg(&app, &mount_point);
    cleanup_dmg(&dmg_path);

    emit_progress(&app, "done", 100, "HQ Sync installed successfully");

    Ok(MenubarInstallResult {
        success: true,
        app_path: Some("/Applications/HQ Sync.app".to_string()),
        error: None,
    })
}

/// Open /Applications/HQ Sync.app using the macOS `open` command.
#[tauri::command]
pub fn launch_menubar_app() -> Result<(), String> {
    let output = Command::new("open")
        .arg("/Applications/HQ Sync.app")
        .output()
        .map_err(|e| format!("Failed to spawn open: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "open failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::{classify_release_response, parse_dmg_url_from_json};

    const SAMPLE_RELEASE: &str = r#"{
        "tag_name": "v1.2.3",
        "assets": [
            {
                "name": "HQ.Sync_1.2.3_aarch64.dmg",
                "browser_download_url": "https://github.com/indigoai-us/hq-sync/releases/download/v1.2.3/HQ.Sync_1.2.3_aarch64.dmg"
            },
            {
                "name": "HQ.Sync_1.2.3_x64.dmg",
                "browser_download_url": "https://github.com/indigoai-us/hq-sync/releases/download/v1.2.3/HQ.Sync_1.2.3_x64.dmg"
            },
            {
                "name": "latest.json",
                "browser_download_url": "https://github.com/indigoai-us/hq-sync/releases/download/v1.2.3/latest.json"
            }
        ]
    }"#;

    #[test]
    fn test_parse_dmg_url_finds_first_dmg() {
        let url = parse_dmg_url_from_json(SAMPLE_RELEASE).expect("should find dmg url");
        assert!(url.starts_with("https://github.com/"));
        assert!(url.ends_with(".dmg"));
    }

    #[test]
    fn test_parse_dmg_url_ignores_non_dmg_assets() {
        let url = parse_dmg_url_from_json(SAMPLE_RELEASE).expect("should find dmg url");
        assert!(!url.ends_with(".json"), "should not return latest.json URL");
    }

    #[test]
    fn test_parse_dmg_url_no_assets_returns_err() {
        let json = r#"{"tag_name":"v1.0.0","assets":[]}"#;
        assert!(parse_dmg_url_from_json(json).is_err());
    }

    #[test]
    fn test_parse_dmg_url_non_dmg_only_returns_err() {
        let json = r#"{
            "assets": [
                {
                    "name": "latest.json",
                    "browser_download_url": "https://github.com/releases/latest.json"
                }
            ]
        }"#;
        assert!(parse_dmg_url_from_json(json).is_err());
    }

    #[test]
    fn test_classify_200_parses_body() {
        let url = classify_release_response("200", SAMPLE_RELEASE).expect("200 should parse");
        assert!(url.ends_with(".dmg"));
    }

    #[test]
    fn test_classify_404_explains_no_release_or_private() {
        let err = classify_release_response("404", "{}").expect_err("404 should error");
        assert!(err.contains("No release"), "got: {err}");
        assert!(err.contains("Skip"), "should advise Skip; got: {err}");
        assert!(!err.contains("exit 56"), "should not leak curl exit code");
    }

    #[test]
    fn test_classify_403_explains_private_repo() {
        let err = classify_release_response("403", "{}").expect_err("403 should error");
        assert!(err.contains("private"), "got: {err}");
        assert!(err.contains("403"), "should include status code; got: {err}");
    }

    #[test]
    fn test_classify_401_explains_private_repo() {
        let err = classify_release_response("401", "{}").expect_err("401 should error");
        assert!(err.contains("private"), "got: {err}");
    }

    #[test]
    fn test_classify_429_explains_rate_limit() {
        let err = classify_release_response("429", "").expect_err("429 should error");
        assert!(err.contains("rate-limited"), "got: {err}");
    }

    #[test]
    fn test_classify_5xx_explains_server_error() {
        let err = classify_release_response("503", "").expect_err("503 should error");
        assert!(err.contains("GitHub is having trouble"), "got: {err}");
    }

    #[test]
    fn test_classify_unknown_status_falls_through() {
        let err = classify_release_response("418", "").expect_err("418 should error");
        assert!(err.contains("Unexpected"), "got: {err}");
    }
}
