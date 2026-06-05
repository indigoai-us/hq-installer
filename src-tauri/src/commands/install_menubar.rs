//! Install the HQ Sync menubar app from GitHub Releases.
//!
//! `install_menubar_app` — orchestrates the full install:
//!   1. Fetch the latest DMG download URL from the GitHub Releases API.
//!   2. Download the DMG to a temp file, streaming progress events.
//!   3. Mount the DMG with `hdiutil attach`.
//!   4. Copy "HQ Sync.app" into /Applications, or ~/Applications when the
//!      system folder isn't writable (standard / non-admin accounts).
//!   5. Unmount the DMG with `hdiutil detach`.
//!   6. Clean up the temp file.
//!
//! `launch_menubar_app` — open the installed HQ Sync.app via `open`.
//!
//! Progress is emitted as `menubar-install://progress` events with a
//! `MenubarInstallProgress` payload.  All error paths return `Err(String)`
//! so the frontend can surface a readable message without crashing.

use std::path::{Path, PathBuf};
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
        "404" => Err("No release has been published for HQ Sync yet. \
             If the repository is private, the installer would also need an \
             auth token to read it. Click Skip to continue without HQ Sync — \
             you can install it later from the menubar."
            .to_string()),
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
/// For each release asset, GitHub's JSON always lists `"name"` before
/// `"browser_download_url"`, but the real payload also sprinkles a large
/// nested `"uploader"` object (>1 KB of user fields) between them. So the
/// two fields can be arbitrarily far apart *within the same asset*, but
/// the `"browser_download_url"` key itself does NOT appear anywhere else
/// in the response (the uploader's URLs all use different key names:
/// `url`, `avatar_url`, `followers_url`, etc.). That makes scanning
/// forward from a `.dmg`-named asset to the next `"browser_download_url"`
/// correct and robust against the nested bloat that breaks any
/// fixed-window heuristic.
fn parse_dmg_url_from_json(json: &str) -> Result<String, String> {
    const URL_KEY: &str = "\"browser_download_url\"";

    for (name_pos, _) in json.match_indices("\"name\"") {
        // Extract the value of this "name" field.
        let after_key = &json[name_pos + "\"name\"".len()..];
        let colon_off = match after_key.find(':') {
            Some(o) => o,
            None => continue,
        };
        let after_colon = after_key[colon_off + 1..].trim_start();
        if !after_colon.starts_with('"') {
            continue;
        }
        let inner = &after_colon[1..];
        let close = match inner.find('"') {
            Some(c) => c,
            None => continue,
        };
        let name_value = &inner[..close];

        // Only DMG assets are candidates.
        if !name_value.ends_with(".dmg") {
            continue;
        }

        // Scan forward from this asset's name to the next browser_download_url
        // — that key lives nowhere else, so no ambiguity.
        let forward_start = name_pos;
        let rel = match json[forward_start..].find(URL_KEY) {
            Some(r) => r,
            None => continue,
        };
        let url_pos = forward_start + rel;
        let after_url_key = &json[url_pos + URL_KEY.len()..];
        let url_colon = match after_url_key.find(':') {
            Some(o) => o,
            None => continue,
        };
        let after_url_colon = after_url_key[url_colon + 1..].trim_start();
        if !after_url_colon.starts_with('"') {
            continue;
        }
        let url_inner = &after_url_colon[1..];
        let url_end = match url_inner.find('"') {
            Some(e) => e,
            None => continue,
        };
        let url = &url_inner[..url_end];
        if url.starts_with("https://") {
            return Ok(url.to_string());
        }
    }

    Err("No .dmg asset found in the latest GitHub release".to_string())
}

/// Download `url` to `dest` using curl with `--progress-bar` output parsed
/// for percentage updates.  Progress events are emitted on `app` as the
/// download proceeds.
fn download_dmg(app: &AppHandle, url: &str, dest: &Path) -> Result<(), String> {
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
fn mount_dmg(app: &AppHandle, dmg_path: &Path) -> Result<String, String> {
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
        .next_back()
        .ok_or_else(|| {
            format!(
                "Could not locate /Volumes mount point in hdiutil output:\n{}",
                stdout.trim()
            )
        })?;

    emit_progress(app, "mounting", 60, &format!("Mounted at {}", mount_point));
    Ok(mount_point)
}

/// True when the current process can create entries inside `dir`.
///
/// Uses a real write probe (create + remove a uniquely-named file) rather than
/// inspecting POSIX mode bits: `/Applications` is mode `0775 root:admin` but
/// grants write to admins via an ACL, so a standard (non-admin) account — or an
/// MDM-managed Mac — would be mis-reported as "writable" by a mode-bit check
/// yet still fail the real copy with EACCES. Probing is the only reliable
/// signal. Returns false when `dir` is absent or the probe can't be created,
/// which is exactly when we want to fall back to a per-user location.
fn dir_is_writable(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(format!(".hq-sync-install-probe-{}", std::process::id()));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Choose the directory HQ Sync.app is installed into.
///
/// Prefers the system `/Applications` when writable; otherwise the per-user
/// `~/Applications`. Standard/non-admin accounts and managed Macs can't write
/// `/Applications` — without this fallback the final install step fails with
/// `cp: /Applications/HQ Sync.app: Permission denied`. Pure (no filesystem
/// access) so the decision is unit-testable: the caller supplies the
/// writability verdict and home dir. Mirrors the dual-location lookup already
/// used for Claude.app in `launch.rs`.
fn apps_dir_for(system_writable: bool, home: &Path) -> PathBuf {
    if system_writable {
        PathBuf::from("/Applications")
    } else {
        home.join("Applications")
    }
}

/// Copy "HQ Sync.app" from the mounted volume into the Applications folder and
/// return the installed path.
///
/// Installs into `/Applications` when writable, else the per-user
/// `~/Applications` (created on demand). If the chosen destination already
/// exists it is removed first so `cp -R` doesn't nest the bundle inside it.
fn copy_app(app: &AppHandle, mount_point: &str) -> Result<PathBuf, String> {
    // Guard against path traversal — mount_point must be under /Volumes/
    let source_path = PathBuf::from(mount_point).join("HQ Sync.app");
    if !source_path.starts_with("/Volumes/") {
        return Err(format!("Unexpected mount point path: {}", mount_point));
    }
    let source = source_path.to_str().ok_or("Source path is non-UTF-8")?;

    // Pick the install dir: /Applications when writable, else ~/Applications.
    let home = dirs::home_dir().ok_or("Could not resolve home directory")?;
    let apps_dir = apps_dir_for(dir_is_writable(Path::new("/Applications")), &home);
    std::fs::create_dir_all(&apps_dir)
        .map_err(|e| format!("Failed to create {}: {}", apps_dir.display(), e))?;
    let dest_path = apps_dir.join("HQ Sync.app");
    let dest = dest_path.to_str().ok_or("Destination path is non-UTF-8")?;

    emit_progress(
        app,
        "installing",
        65,
        &format!("Copying HQ Sync.app to {}…", apps_dir.display()),
    );

    // Remove existing installation so cp -R doesn't nest inside it.
    // Guard against symlink attacks: refuse to rm -rf a symlink target.
    if dest_path.exists() {
        let meta = std::fs::symlink_metadata(&dest_path)
            .map_err(|e| format!("stat failed on {}: {}", dest, e))?;
        if meta.file_type().is_symlink() {
            return Err(format!(
                "{} is a symlink — refusing to remove. Delete it manually and retry.",
                dest
            ));
        }
        let rm_out = Command::new("rm")
            .args(["-rf", dest])
            .output()
            .map_err(|e| format!("Failed to spawn rm: {}", e))?;
        if !rm_out.status.success() {
            let stderr = String::from_utf8_lossy(&rm_out.stderr);
            return Err(format!(
                "Failed to remove existing {}: {}",
                dest,
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

    emit_progress(
        app,
        "installing",
        80,
        &format!("App copied to {}", apps_dir.display()),
    );
    Ok(dest_path)
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
    let installed_path = match copy_app(&app, &mount_point) {
        Ok(p) => p,
        Err(e) => {
            emit_progress(&app, "error", 65, &e);
            unmount_dmg(&app, &mount_point);
            cleanup_dmg(&dmg_path);
            return Ok(MenubarInstallResult {
                success: false,
                app_path: None,
                error: Some(e),
            });
        }
    };

    // Phase 5: unmount + cleanup.
    unmount_dmg(&app, &mount_point);
    cleanup_dmg(&dmg_path);

    emit_progress(&app, "done", 100, "HQ Sync installed successfully");

    Ok(MenubarInstallResult {
        success: true,
        app_path: Some(installed_path.to_string_lossy().into_owned()),
        error: None,
    })
}

/// Pick which installed HQ Sync.app to open, in precedence order: the system
/// `/Applications` copy first, then the per-user `~/Applications` fallback.
/// Pure so the precedence is unit-testable; returns `None` when neither exists.
fn pick_installed_app<'a>(
    system: &'a Path,
    system_exists: bool,
    user: &'a Path,
    user_exists: bool,
) -> Option<&'a Path> {
    if system_exists {
        Some(system)
    } else if user_exists {
        Some(user)
    } else {
        None
    }
}

/// Resolve the on-disk HQ Sync.app, checking `/Applications` then
/// `~/Applications` (where the non-admin fallback install lands).
fn installed_menubar_app() -> Option<PathBuf> {
    let system = PathBuf::from("/Applications/HQ Sync.app");
    let system_exists = system.exists();
    let user = dirs::home_dir()
        .unwrap_or_default()
        .join("Applications/HQ Sync.app");
    let user_exists = user.exists();
    pick_installed_app(&system, system_exists, &user, user_exists).map(Path::to_path_buf)
}

/// Open the installed HQ Sync.app using the macOS `open` command.
///
/// Resolves the real install location — `/Applications` first, then the
/// per-user `~/Applications` fallback — so launch works for non-admin installs.
#[tauri::command]
pub fn launch_menubar_app() -> Result<(), String> {
    let app_path = installed_menubar_app()
        .ok_or("HQ Sync.app not found in /Applications or ~/Applications")?;

    let output = Command::new("open")
        .arg(&app_path)
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
    use super::{
        apps_dir_for, classify_release_response, parse_dmg_url_from_json, pick_installed_app,
    };
    use std::path::{Path, PathBuf};

    #[test]
    fn apps_dir_prefers_system_when_writable() {
        let home = Path::new("/Users/test");
        assert_eq!(apps_dir_for(true, home), PathBuf::from("/Applications"));
    }

    #[test]
    fn apps_dir_falls_back_to_user_when_system_readonly() {
        // Standard / non-admin accounts can't write /Applications — the install
        // must land in ~/Applications rather than fail with EACCES (the
        // `cp: /Applications/HQ Sync.app: Permission denied` this PR fixes).
        let home = Path::new("/Users/test");
        assert_eq!(
            apps_dir_for(false, home),
            PathBuf::from("/Users/test/Applications")
        );
    }

    #[test]
    fn pick_installed_prefers_system_then_user() {
        let system = Path::new("/Applications/HQ Sync.app");
        let user = Path::new("/Users/test/Applications/HQ Sync.app");
        // System present wins regardless of the user copy.
        assert_eq!(pick_installed_app(system, true, user, true), Some(system));
        // Only the per-user fallback present → use it.
        assert_eq!(pick_installed_app(system, false, user, true), Some(user));
        // Neither present → nothing to launch.
        assert_eq!(pick_installed_app(system, false, user, false), None);
    }

    #[test]
    fn dir_is_writable_probes_real_filesystem() {
        // Exercises the real write-probe (not mode-bit inspection) against the
        // filesystem — this is the check that decides whether /Applications is
        // usable or we fall back to ~/Applications. Assumes a non-root runner
        // (macOS CI + the pre-commit hook both run as a normal user); root
        // would bypass permission bits and make the negative case meaningless.
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("hq-probe-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // A freshly created temp dir is writable → probe true.
        assert!(
            super::dir_is_writable(&dir),
            "writable temp dir should probe as writable"
        );

        // Read + execute only (0555) models the non-admin /Applications shape:
        // entries can't be created, so the probe must report NOT writable and
        // the installer falls back to ~/Applications.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        assert!(
            !super::dir_is_writable(&dir),
            "a 0555 (no-write) dir must probe as NOT writable"
        );

        // A non-existent dir is never writable.
        assert!(!super::dir_is_writable(&dir.join("does-not-exist")));

        // Restore write so cleanup can remove the dir.
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o755));
        let _ = fs::remove_dir_all(&dir);
    }

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

    /// Snapshot of a real `/releases/latest` asset entry (with nested
    /// `uploader` object) shaped exactly like GitHub's response. The
    /// `uploader` alone is >1 KB — more than the old parser's 300-char
    /// backward context window — so before the fix this asset's
    /// `browser_download_url` would be skipped and "No .dmg asset found"
    /// would bubble up to the UI even though a DMG was clearly published.
    const REAL_RELEASE_WITH_UPLOADER: &str = r#"{
        "tag_name":"v0.1.2",
        "name":"HQ Sync v0.1.2",
        "assets":[
            {
                "url":"https://api.github.com/repos/indigoai-us/hq-sync/releases/assets/400391570",
                "id":400391570,
                "node_id":"RA_kwDOSF3Hkc4X3X2S",
                "name":"HQ-Sync_0.1.2_universal.dmg",
                "label":"",
                "uploader":{"login":"github-actions[bot]","id":41898282,"node_id":"MDM6Qm90NDE4OTgyODI=","avatar_url":"https://avatars.githubusercontent.com/in/15368?v=4","gravatar_id":"","url":"https://api.github.com/users/github-actions%5Bbot%5D","html_url":"https://github.com/apps/github-actions","followers_url":"https://api.github.com/users/github-actions%5Bbot%5D/followers","following_url":"https://api.github.com/users/github-actions%5Bbot%5D/following{/other_user}","gists_url":"https://api.github.com/users/github-actions%5Bbot%5D/gists{/gist_id}","starred_url":"https://api.github.com/users/github-actions%5Bbot%5D/starred{/owner}{/repo}","subscriptions_url":"https://api.github.com/users/github-actions%5Bbot%5D/subscriptions","organizations_url":"https://api.github.com/users/github-actions%5Bbot%5D/orgs","repos_url":"https://api.github.com/users/github-actions%5Bbot%5D/repos","events_url":"https://api.github.com/users/github-actions%5Bbot%5D/events{/privacy}","received_events_url":"https://api.github.com/users/github-actions%5Bbot%5D/received_events","type":"Bot","user_view_type":"public","site_admin":false},
                "content_type":"application/x-apple-diskimage",
                "state":"uploaded",
                "size":15569413,
                "digest":"sha256:72c898102528ade122260d57b9a6cb79194775abb6ab59c774f2cd8e24d2bd84",
                "download_count":2,
                "created_at":"2026-04-20T04:31:48Z",
                "updated_at":"2026-04-20T04:31:49Z",
                "browser_download_url":"https://github.com/indigoai-us/hq-sync/releases/download/v0.1.2/HQ-Sync_0.1.2_universal.dmg"
            }
        ]
    }"#;

    #[test]
    fn test_parse_dmg_url_finds_first_dmg() {
        let url = parse_dmg_url_from_json(SAMPLE_RELEASE).expect("should find dmg url");
        assert!(url.starts_with("https://github.com/"));
        assert!(url.ends_with(".dmg"));
    }

    /// Regression guard: the real GitHub response has a large `uploader`
    /// nested object sitting between each asset's `name` and
    /// `browser_download_url`. The parser must pair them across that gap.
    #[test]
    fn test_parse_dmg_url_pairs_name_and_url_across_uploader_object() {
        let url = parse_dmg_url_from_json(REAL_RELEASE_WITH_UPLOADER)
            .expect("should find dmg url in real-shaped release");
        assert!(url.ends_with(".dmg"), "got: {url}");
        assert!(
            url.contains("HQ-Sync_0.1.2_universal.dmg"),
            "should extract this asset's url, not a neighbour's; got: {url}"
        );
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
        assert!(
            err.contains("403"),
            "should include status code; got: {err}"
        );
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
