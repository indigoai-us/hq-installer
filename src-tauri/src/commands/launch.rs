//! Launch external applications from the installer.
//!
//! `launch_claude_code` — open an interactive terminal at the HQ install path
//! and auto-run `claude` so the user lands in Claude Code pointed at their new
//! HQ. `launch_claude_desktop` — open the Claude Desktop app so the user can
//! connect their HQ folder via the app's "Connect Folder" UI.

#[cfg(windows)]
use std::path::PathBuf;
use std::process::Command;

#[cfg(windows)]
use winreg::enums::*;
#[cfg(windows)]
use winreg::RegKey;

/// PowerShell single-quote escaping: ' → ''. Apply BEFORE wrapping the
/// resulting string in single quotes when handing a literal string to
/// PowerShell. Mirrors macOS's bash single-quote escaping but using
/// PowerShell's quote-doubling rule, not bash's `'\''` trick.
#[cfg(windows)]
fn powershell_single_quote_escape(s: &str) -> String {
    s.replace('\'', "''")
}

/// Open macOS Terminal, cd into `path`, and auto-run `claude`.
///
/// Uses AppleScript via `osascript` because it's the most reliable way to
/// open a visible Terminal window and execute a command in it without
/// detaching the shell (so `claude` stays interactive).
///
/// The `path` is shell-quoted via single quotes with `'` → `'\''` escaping
/// to avoid injection in pathological install paths that contain quotes.
#[cfg(not(windows))]
#[tauri::command]
pub fn launch_claude_code(path: String) -> Result<(), String> {
    // Shell-escape the path for safe inclusion inside an AppleScript
    // double-quoted string that will be interpreted by the shell.
    // AppleScript sees the literal string after its own quoting, so we only
    // have to protect against breaking out of the shell single-quoted string.
    let escaped_path = path.replace('\'', "'\\''");

    // Shell command run inside the new Terminal window.
    let shell_cmd = format!("cd '{}' && claude", escaped_path);

    // AppleScript needs double quotes around the shell command. Escape any
    // double quotes and backslashes the shell_cmd might contain to be safe.
    let applescript_safe = shell_cmd.replace('\\', "\\\\").replace('"', "\\\"");

    let script = format!(
        r#"tell application "Terminal"
    activate
    do script "{}"
end tell"#,
        applescript_safe
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to spawn osascript: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "osascript failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    Ok(())
}

/// Open a Windows Terminal window at `path` and auto-run `claude`.
///
/// Tries `wt.exe -d '<path>' powershell -NoExit -Command claude` first.
/// `wt.exe` ships with Windows 11 — if it's missing (rare; pre-Win11 boxes
/// or stripped enterprise images), falls back to a plain PowerShell window
/// via `powershell -NoExit -Command "cd '<path>'; claude"`.
///
/// We invoke through `cmd /c start ""` rather than spawning the terminal
/// directly: `start` returns immediately without waiting for the spawned
/// process, which means the wizard's "Launch Claude Code" button doesn't
/// hang while the user works in the new terminal.
#[cfg(windows)]
#[tauri::command]
pub fn launch_claude_code(path: String) -> Result<(), String> {
    let escaped = powershell_single_quote_escape(&path);

    // First try wt.exe. The `start` shim returns 0 even if the target
    // can't be found (start is async by design), so we explicitly check
    // for wt.exe's presence first.
    let wt_present = which::which("wt").is_ok() || which::which("wt.exe").is_ok();

    let status = if wt_present {
        // wt.exe -d '<path>' powershell -NoExit -Command claude
        // The -d flag tells Windows Terminal to cd into the directory
        // before running the command — equivalent to mac's `osascript`
        // do-script "cd <path> && claude" combo.
        Command::new("cmd")
            .args([
                "/c",
                "start",
                "",
                "wt.exe",
                "-d",
                &path,
                "powershell",
                "-NoExit",
                "-Command",
                "claude",
            ])
            .status()
            .map_err(|e| format!("Failed to spawn wt.exe via cmd: {e}"))?
    } else {
        // Plain PowerShell fallback.
        // cd '<escaped>'; claude   — inside double quotes for cmd /c start.
        let ps_cmd = format!("cd '{escaped}'; claude");
        Command::new("cmd")
            .args([
                "/c",
                "start",
                "",
                "powershell",
                "-NoExit",
                "-Command",
                &ps_cmd,
            ])
            .status()
            .map_err(|e| format!("Failed to spawn PowerShell via cmd: {e}"))?
    };

    if !status.success() {
        return Err(format!(
            "Terminal launch failed (exit {})",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

/// Extract Claude Desktop's installed exe path from the `claude://`
/// protocol handler registered in the Windows registry. This is the
/// source of truth for "will a `claude://...` deep-link actually
/// launch?" — Windows' ShellExecute uses exactly this registration to
/// dispatch the URL, so if we can resolve it to a real exe, the launch
/// path works regardless of WHERE Claude Desktop installed itself
/// (Squirrel under %LOCALAPPDATA%\AnthropicClaude\, MSIX under
/// %ProgramFiles%\WindowsApps\Claude_<ver>_<hash>\app\, or a custom
/// path a future Anthropic installer chooses).
///
/// Reads `HKCU\Software\Classes\claude\shell\open\command` first (per-
/// user install, the common case), then falls back to
/// `HKCR\claude\shell\open\command` (machine-wide / MSIX), then
/// `HKLM\Software\Classes\...`. Returns `None` if no claude:// handler
/// is registered or its target doesn't exist on disk.
#[cfg(windows)]
fn claude_desktop_path_from_registry() -> Option<PathBuf> {
    const SUBKEY: &str = r"Software\Classes\claude\shell\open\command";

    // Capture the probe trace to a sidecar log file. GUI Tauri apps have
    // no console, so stderr is detached; without this we have no way to
    // tell whether the probe even ran in the installed-app context, or
    // why it concluded what it did. Best-effort write; never bubble up.
    let mut trace = String::new();
    let log_path = std::env::var("LOCALAPPDATA").ok().map(|p| {
        PathBuf::from(p)
            .join("HQ Installer")
            .join("claude-detect.log")
    });

    for (root, root_label) in [(HKEY_CURRENT_USER, "HKCU"), (HKEY_LOCAL_MACHINE, "HKLM")] {
        let raw = RegKey::predef(root)
            .open_subkey(SUBKEY)
            .and_then(|k| k.get_value::<String, _>(""));
        match &raw {
            Ok(cmd) => trace.push_str(&format!("[{root_label}] raw={cmd:?}\n")),
            Err(e) => trace.push_str(&format!("[{root_label}] read err={e}\n")),
        }
        if let Ok(cmd) = raw {
            if let Some(exe) = extract_exe_from_command(&cmd) {
                let exists = exe.exists();
                let meta_ok = std::fs::metadata(&exe).is_ok();
                trace.push_str(&format!(
                    "[{root_label}] parsed={exe:?} exists={exists} meta_ok={meta_ok}\n"
                ));
                if exists {
                    if let Some(p) = &log_path {
                        let _ = std::fs::create_dir_all(p.parent().unwrap());
                        let _ = std::fs::write(p, &trace);
                    }
                    return Some(exe);
                }
                eprintln!(
                    "[claude-desktop] {root_label} registered command points at \
                     non-existent path: {}",
                    exe.display()
                );
            } else {
                trace.push_str(&format!("[{root_label}] parse failed for raw value\n"));
            }
        }
    }
    // HKCR is a union view of HKLM\Software\Classes + HKCU\Software\Classes,
    // so the loop above covers it — kept as a comment marker, not a third
    // probe, to avoid duplicate reads.
    trace.push_str("[result] no registry-handler-resolved path; falling through\n");
    if let Some(p) = &log_path {
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        let _ = std::fs::write(p, &trace);
    }
    None
}

/// Pull the executable path out of a Windows protocol-handler command
/// string. Handlers register as either:
///   `"C:\Path with spaces\app.exe" "%1"`   (quoted — preferred form)
///   `C:\Path\app.exe %1`                   (unquoted — legacy)
/// We accept both. Returns None on syntactic garbage.
#[cfg(windows)]
fn extract_exe_from_command(cmd: &str) -> Option<PathBuf> {
    let trimmed = cmd.trim();
    if let Some(rest) = trimmed.strip_prefix('"') {
        rest.find('"').map(|end| PathBuf::from(&rest[..end]))
    } else {
        // Take everything up to the first whitespace as the exe path.
        // This loses paths with embedded spaces in unquoted form, but
        // Windows itself wouldn't dispatch those correctly either.
        trimmed.split_whitespace().next().map(PathBuf::from)
    }
}

/// Hard-coded fallback paths for the rare case where Claude Desktop is
/// installed but somehow didn't register the `claude://` handler (e.g.
/// the user dragged the unpacked exe into place themselves). These four
/// cover the documented Anthropic install locations. The registry probe
/// above is always tried first.
#[cfg(windows)]
fn claude_desktop_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let local_pb = PathBuf::from(&local);
        paths.push(local_pb.join("AnthropicClaude").join("claude.exe"));
        paths.push(local_pb.join("Programs").join("Claude").join("Claude.exe"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        paths.push(PathBuf::from(&pf).join("Claude").join("Claude.exe"));
    }
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        paths.push(PathBuf::from(&pf86).join("Claude").join("Claude.exe"));
    }

    paths
}

/// Returns true when `Claude.app` is present on disk.
///
/// Checks the standard `/Applications` location plus `~/Applications` (where
/// browsers and per-user installs sometimes land the app). The Summary screen
/// uses this to branch its CTA between "Launch Claude Desktop" and a download
/// link when Claude isn't installed yet — avoids the jarring `open -a Claude`
/// "Unable to find application" error mid-flow.
#[cfg(not(windows))]
#[tauri::command]
pub fn claude_desktop_installed() -> bool {
    let system_path = std::path::PathBuf::from("/Applications/Claude.app");
    if system_path.exists() {
        return true;
    }
    if let Ok(home) = std::env::var("HOME") {
        let user_path = std::path::PathBuf::from(home).join("Applications/Claude.app");
        if user_path.exists() {
            return true;
        }
    }
    false
}

/// Returns true when Claude Desktop is installed. Source of truth is
/// the `claude://` protocol handler registration (works for Squirrel,
/// MSIX, custom). Falls back to known install-path probing if the
/// registry says nothing.
#[cfg(windows)]
#[tauri::command]
pub fn claude_desktop_installed() -> bool {
    if claude_desktop_path_from_registry().is_some() {
        return true;
    }
    claude_desktop_candidates().iter().any(|p| p.exists())
}

/// Forward a `claude://…` deep link to macOS `open`.
///
/// Mirrors hq-sync's `open_claude_code_link`. The renderer can't call
/// `@tauri-apps/plugin-shell` `open()` for non-http(s) schemes without
/// widening `shell:allow-open` to the world; this command keeps the
/// surface tight by only forwarding `claude://` URLs. Claude Desktop is
/// registered as the system handler for the scheme, so `open <url>` is
/// all macOS needs to deep-link into a new Claude Code session.
#[cfg(not(windows))]
#[tauri::command]
pub fn open_claude_code_link(url: String) -> Result<(), String> {
    if !url.starts_with("claude://") {
        return Err(format!("refusing to open non-claude scheme: {}", url));
    }

    let output = Command::new("open")
        .arg(&url)
        .output()
        .map_err(|e| format!("Failed to run open: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "open exited {}: {}",
            output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            stderr.trim()
        ));
    }

    Ok(())
}

/// Forward a `claude://...` deep link to the Windows protocol handler.
///
/// `cmd /c start "" "<url>"` — start uses ShellExecute under the hood,
/// which dispatches the custom scheme to whatever's registered under
/// HKCU\Software\Classes\claude (Claude Desktop's installer registers
/// itself there at install time).
#[cfg(windows)]
#[tauri::command]
pub fn open_claude_code_link(url: String) -> Result<(), String> {
    if !url.starts_with("claude://") {
        return Err(format!("refusing to open non-claude scheme: {}", url));
    }

    let status = Command::new("cmd")
        .args(["/c", "start", "", &url])
        .status()
        .map_err(|e| format!("Failed to spawn cmd /c start: {e}"))?;

    if !status.success() {
        return Err(format!(
            "ShellExecute for {url} failed (exit {})",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

/// Launch the Claude Desktop macOS app via `open -a Claude`.
///
/// We can't deep-link into a specific folder — Claude Desktop has no
/// documented URL scheme for "Connect Folder" — so the frontend pairs this
/// command with a copy-able install path the user picks in Claude Code's
/// folder selector. Frontend is expected to gate this behind
/// `claude_desktop_installed` so we don't surface the "Unable to find
/// application" error path for users who don't have Claude installed yet.
#[cfg(not(windows))]
#[tauri::command]
pub fn launch_claude_desktop() -> Result<(), String> {
    let output = Command::new("open")
        .arg("-a")
        .arg("Claude")
        .output()
        .map_err(|e| format!("Failed to spawn `open`: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "open -a Claude failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    Ok(())
}

/// Launch the Claude Desktop Windows app via `cmd /c start "" <path>`,
/// which hands off to ShellExecute and returns immediately.
///
/// Prefers the registry-resolved `claude://` handler exe (any install
/// flavor — Squirrel, MSIX, custom). Falls back to the hard-coded
/// candidate list. If nothing resolves, returns Err so the wizard can
/// render the "Download Claude Desktop" CTA instead.
#[cfg(windows)]
#[tauri::command]
pub fn launch_claude_desktop() -> Result<(), String> {
    let target = claude_desktop_path_from_registry()
        .or_else(|| claude_desktop_candidates().into_iter().find(|p| p.exists()))
        .ok_or_else(|| {
            "Claude Desktop is not installed (no claude:// protocol handler and \
             no Claude.exe at the known install locations)."
                .to_string()
        })?;

    let target_str = target.to_string_lossy().to_string();

    let status = Command::new("cmd")
        .args(["/c", "start", "", &target_str])
        .status()
        .map_err(|e| format!("Failed to spawn cmd /c start: {e}"))?;

    if !status.success() {
        return Err(format!(
            "ShellExecute via `start` failed (exit {})",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

/// Add `hq_path` to Claude Desktop's
/// `%APPDATA%\Claude\claude_desktop_config.json`
/// `preferences.localAgentModeTrustedFolders` array, so when the user
/// clicks "Select folder" in Claude Code after we deep-link them in,
/// the HQ folder doesn't trigger a trust prompt.
///
/// Claude Desktop's `claude://` URL scheme does NOT support a `folder=`
/// query parameter — it routes to the right view but ignores any folder
/// hint, so we can't auto-select the project. This pre-trust is the
/// closest available improvement: one less click for the user.
///
/// Best-effort: if Claude Desktop has never been launched (the config
/// file doesn't exist), if the JSON is malformed, or if the write
/// fails for any other reason, we return Err. The caller in
/// 11-summary.tsx swallows the error and continues — the wizard must
/// not fail just because the convenience touch-up didn't land.
///
/// Idempotent: re-running with the same path is a no-op (we dedupe
/// before writing). Other keys in the JSON are preserved verbatim so
/// we don't trample the user's Claude Desktop settings.
#[cfg(windows)]
#[tauri::command]
pub fn add_claude_trusted_folder(hq_path: String) -> Result<(), String> {
    let appdata = std::env::var("APPDATA").map_err(|e| format!("APPDATA missing: {e}"))?;
    let config_path = PathBuf::from(&appdata)
        .join("Claude")
        .join("claude_desktop_config.json");

    if !config_path.exists() {
        return Err(format!(
            "Claude Desktop config not found at {} — launch Claude Desktop once \
             to initialize it, then re-run.",
            config_path.display()
        ));
    }

    let raw = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("read {}: {e}", config_path.display()))?;
    let mut root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse config: {e}"))?;

    // Navigate / create preferences.localAgentModeTrustedFolders. Use
    // serde_json's `Value` accessors so unknown adjacent keys survive the
    // round-trip unchanged.
    let prefs = root
        .as_object_mut()
        .ok_or("config is not a JSON object")?
        .entry("preferences")
        .or_insert_with(|| serde_json::json!({}));
    let trusted = prefs
        .as_object_mut()
        .ok_or("preferences is not a JSON object")?
        .entry("localAgentModeTrustedFolders")
        .or_insert_with(|| serde_json::json!([]));
    let arr = trusted
        .as_array_mut()
        .ok_or("localAgentModeTrustedFolders is not an array")?;

    // Dedupe by case-insensitive path comparison — Windows paths aren't
    // case-sensitive, and entering `C:\hq` once and `C:\HQ` later would
    // otherwise produce two entries that both grant the same trust.
    let hq_lower = hq_path.to_lowercase();
    let already_present = arr.iter().any(|v| {
        v.as_str()
            .map(|s| s.to_lowercase() == hq_lower)
            .unwrap_or(false)
    });
    if !already_present {
        arr.push(serde_json::Value::String(hq_path.clone()));
    }

    // Atomic write: serialize → temp file → rename. matches the rest of
    // the wizard's file-write style (see fs.rs, menubar.rs).
    let tmp_path = config_path.with_extension("json.tmp");
    let serialized = serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&tmp_path, serialized).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp_path, &config_path).map_err(|e| format!("rename: {e}"))?;

    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn powershell_single_quote_escape_doubles_quotes() {
        assert_eq!(powershell_single_quote_escape("plain"), "plain");
        assert_eq!(powershell_single_quote_escape("it's"), "it''s");
        assert_eq!(
            powershell_single_quote_escape("she said 'hi'"),
            "she said ''hi''"
        );
        // Backslashes are NOT escape characters in PowerShell single-quoted
        // strings — they're literal. The function should not touch them.
        assert_eq!(
            powershell_single_quote_escape(r"C:\Users\sue\hq"),
            r"C:\Users\sue\hq"
        );
    }

    #[test]
    fn open_claude_code_link_rejects_non_claude_scheme() {
        let res = open_claude_code_link("https://example.com/evil".into());
        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(err.contains("refusing to open non-claude scheme"));
    }

    #[test]
    fn extract_exe_from_command_handles_quoted_form() {
        // MSIX-registered handler (real example from a live install):
        let cmd = "\"C:\\Program Files\\WindowsApps\\Claude_1.11187.4.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe\" \"%1\"";
        let exe = extract_exe_from_command(cmd).expect("parse");
        assert_eq!(
            exe.to_string_lossy(),
            r"C:\Program Files\WindowsApps\Claude_1.11187.4.0_x64__pzs8sxrjxfjjc\app\Claude.exe"
        );
    }

    #[test]
    fn extract_exe_from_command_handles_unquoted_form() {
        let cmd = r"C:\Apps\Claude.exe %1";
        let exe = extract_exe_from_command(cmd).expect("parse");
        assert_eq!(exe.to_string_lossy(), r"C:\Apps\Claude.exe");
    }

    #[test]
    fn extract_exe_from_command_handles_quoted_no_args() {
        let cmd = "\"C:\\Apps\\Claude.exe\"";
        let exe = extract_exe_from_command(cmd).expect("parse");
        assert_eq!(exe.to_string_lossy(), r"C:\Apps\Claude.exe");
    }

    #[test]
    fn extract_exe_from_command_handles_garbage() {
        assert!(extract_exe_from_command("").is_none());
        // Empty quoted block — no closing quote.
        assert!(extract_exe_from_command("\"unterminated").is_none());
    }

    #[test]
    fn claude_desktop_candidates_includes_localappdata_programs() {
        std::env::set_var("LOCALAPPDATA", "C:\\Users\\test\\AppData\\Local");
        let cands = claude_desktop_candidates();
        let stringified: Vec<String> = cands
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        let has_local = stringified
            .iter()
            .any(|s| s.contains("AppData\\Local\\Programs\\Claude\\Claude.exe"));
        assert!(
            has_local,
            "candidates should include %LOCALAPPDATA%\\Programs\\Claude\\Claude.exe; got {stringified:?}"
        );
    }
}
