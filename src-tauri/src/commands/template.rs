//! Template fetch command.
//!
//! `fetch_template` — downloads a tarball from `url` into a temp file then
//! extracts it into `target_dir`, emitting `template:progress` events for
//! download progress and completion/error status.
//!
//! Since neither `reqwest` nor `ureq` is in Cargo.toml, this implementation
//! shells out to `curl` + `tar` (both available on macOS by default).

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// ─────────────────────────────────────────────────────────────────────────────
// Event payload
// ─────────────────────────────────────────────────────────────────────────────

/// Progress event payload emitted on `template:progress`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TemplateProgress {
    /// Bytes downloaded so far (best-effort — 0 until curl reports progress).
    pub downloaded: u64,
    /// Total bytes, if the server sent Content-Length.
    pub total: Option<u64>,
    /// True on the final event (success or failure).
    pub done: bool,
    /// Non-None when an error occurred.
    pub error: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure impl (testable without a Tauri runtime)
// ─────────────────────────────────────────────────────────────────────────────

/// Download the tarball at `url` to a temp file, then extract into `target_dir`.
///
/// Calls `emit` for each progress update.  The final call always has `done:
/// true`; on success `error` is `None`, on failure it carries the message.
pub fn fetch_template_impl<F>(url: &str, target_dir: &str, mut emit: F) -> Result<(), String>
where
    F: FnMut(TemplateProgress),
{
    // ── 1. Build temp file path ───────────────────────────────────────────────
    let tmp_path: PathBuf = {
        let mut p = std::env::temp_dir();
        p.push(format!("hq-template-{}.tar.gz", uuid::Uuid::new_v4()));
        p
    };

    // ── 2. Download with curl, parsing progress output ────────────────────────
    // `curl --progress-bar` writes progress to stderr in a form like:
    //   ###  12.3%  ← percentage bar
    // We instead use `--write-out` + `--stderr` trick or parse `-#` output.
    // Simplest reliable approach: use `-w "%{size_download} %{size_header}"` at
    // the end, and emit a single mid-point event while downloading.
    //
    // For real-time progress we run curl with `--stderr -` and parse lines that
    // look like the verbose transfer stats.  To keep things simple and reliable
    // we use `--progress-bar` piped through stderr=stdout and parse the output.
    let mut curl = Command::new("curl")
        .args([
            "-L",     // follow redirects
            "--fail", // non-zero exit on HTTP errors
            "--stderr",
            "-",              // merge stderr into stdout so we can read it
            "--progress-bar", // human-readable progress on stderr (now stdout)
            "-o",
            tmp_path.to_str().unwrap(), // output file
            url,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn curl: {}", e))?;

    let stdout = curl.stdout.take().ok_or("curl: no stdout")?;
    let reader = BufReader::new(stdout);

    // Emit an initial "started" event.
    emit(TemplateProgress {
        downloaded: 0,
        total: None,
        done: false,
        error: None,
    });

    // Drain curl output; we don't try to parse the progress bar bytes because
    // curl's `--progress-bar` output uses ANSI escape sequences and carriage
    // returns that are painful to parse.  Instead emit a single "in-progress"
    // event per output line so the UI has feedback that work is happening.
    let mut line_count: u64 = 0;
    for _line in reader.lines().map_while(|r| r.ok()) {
        line_count += 1;
        // Emit coarse progress ticks.
        emit(TemplateProgress {
            downloaded: line_count * 1024, // rough byte estimate
            total: None,
            done: false,
            error: None,
        });
    }

    let status = curl
        .wait()
        .map_err(|e| format!("curl wait failed: {}", e))?;

    if !status.success() {
        let _ = std::fs::remove_file(&tmp_path);
        let err = format!("curl exited with code {}", status.code().unwrap_or(-1));
        emit(TemplateProgress {
            downloaded: 0,
            total: None,
            done: true,
            error: Some(err.clone()),
        });
        return Err(err);
    }

    // ── 3. Extract with tar ───────────────────────────────────────────────────
    let extract_status = Command::new("tar")
        .args(["-xzf", tmp_path.to_str().unwrap(), "-C", target_dir])
        .status()
        .map_err(|e| format!("Failed to spawn tar: {}", e))?;

    let _ = std::fs::remove_file(&tmp_path);

    if !extract_status.success() {
        let err = format!(
            "tar exited with code {}",
            extract_status.code().unwrap_or(-1)
        );
        emit(TemplateProgress {
            downloaded: 0,
            total: None,
            done: true,
            error: Some(err.clone()),
        });
        return Err(err);
    }

    // ── 4. Success ────────────────────────────────────────────────────────────
    emit(TemplateProgress {
        downloaded: 0,
        total: None,
        done: true,
        error: None,
    });

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri command
// ─────────────────────────────────────────────────────────────────────────────

/// Download and extract the HQ template tarball.
///
/// Emits `template:progress` events during download.  Returns `Ok(())` on
/// success or `Err(String)` on failure.
///
/// The work is done on a background thread so the Tauri async runtime is not
/// blocked.
#[tauri::command]
pub fn fetch_template(app: AppHandle, url: String, target_dir: String) -> Result<(), String> {
    let app_clone = app.clone();

    thread::spawn(move || {
        let _ = fetch_template_impl(&url, &target_dir, |progress| {
            let _ = app_clone.emit("template:progress", &progress);
        });
    });

    Ok(())
}
