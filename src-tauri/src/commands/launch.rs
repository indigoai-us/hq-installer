//! Launch external applications from the installer.
//!
//! `launch_claude_code` — open a Terminal window at the HQ install path and
//! auto-run `claude` so the user lands in Claude Code pointed at their new HQ.

use std::process::Command;

/// Open macOS Terminal, cd into `path`, and auto-run `claude`.
///
/// Uses AppleScript via `osascript` because it's the most reliable way to
/// open a visible Terminal window and execute a command in it without
/// detaching the shell (so `claude` stays interactive).
///
/// The `path` is shell-quoted via single quotes with `'` → `'\''` escaping
/// to avoid injection in pathological install paths that contain quotes.
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
