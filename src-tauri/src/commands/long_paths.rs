//! Windows long-path-support detection and enablement.
//!
//! Why: when `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\
//! LongPathsEnabled` is `0` (the OS default through Win 11), Win32
//! file APIs refuse paths over MAX_PATH (260 chars). npm packages with
//! deep nested deps blow past that — node-llama-cpp (a qmd transitive)
//! has entries up to 233 chars; combined with our managed-toolchain
//! prefix the tarball extract fails with ENOENT mid-flight, the
//! `better-sqlite3` postinstall sees a cwd that was never created and
//! reports the misleading `spawn cmd.exe ENOENT`, and the wizard's
//! "Register HQ with semantic search" step dies with the same noise.
//!
//! The setting is per-machine (HKLM) so toggling it requires admin.
//! There is no Settings app page for it — Microsoft exposes it only
//! via Group Policy Editor (Pro+ SKUs) or the registry. So we elevate
//! ourselves: `is_long_paths_enabled()` reads the value (works
//! unprivileged), `enable_long_paths()` re-spawns PowerShell with
//! `Start-Process -Verb RunAs`, triggers ONE UAC consent, writes the
//! DWORD, exits. New processes (npm.exe, node.exe, etc.) spawned
//! AFTER the write see the new behavior — no reboot required.

use std::process::Command;

use winreg::enums::*;
use winreg::RegKey;

/// Open the Windows Settings → System → For Developers page. That page
/// has an "Enable long paths" toggle on Windows 11 22H2+. Some users
/// prefer flipping the OS setting in Settings over confirming a UAC
/// prompt — this gives them that path without leaving the wizard.
///
/// Uses `ms-settings:developers` which ShellExecute dispatches to the
/// Settings app's URL handler. We invoke through `cmd /c start ""`
/// rather than letting the renderer use `tauri-plugin-shell::open` so
/// we don't have to fight Tauri's URL-scheme allowlist (which doesn't
/// include `ms-settings:` by default).
#[tauri::command]
pub fn open_long_paths_settings() -> Result<(), String> {
    let status = Command::new("cmd")
        .args(["/c", "start", "", "ms-settings:developers"])
        .status()
        .map_err(|e| format!("failed to spawn cmd: {e}"))?;
    if !status.success() {
        return Err(format!(
            "Settings open failed (exit {})",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

const SUBKEY: &str = r"SYSTEM\CurrentControlSet\Control\FileSystem";
const VALUE_NAME: &str = "LongPathsEnabled";

/// Read the current value of `LongPathsEnabled`. Returns `false` when
/// the value is `0`, missing, or unreadable — the unsafe-default
/// behavior of the OS itself.
#[tauri::command]
pub fn is_long_paths_enabled() -> bool {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    hklm.open_subkey(SUBKEY)
        .and_then(|k| k.get_value::<u32, _>(VALUE_NAME))
        .map(|v| v == 1)
        .unwrap_or(false)
}

/// Set `LongPathsEnabled = 1` via an elevated PowerShell child.
///
/// Returns `Ok("already_enabled")` if the flag is already set,
/// `Ok("enabled")` after a successful elevated write, or `Err(...)`
/// with a human-readable reason — most commonly the user declining
/// the UAC consent dialog. The error message is intentionally short
/// and actionable; the renderer surfaces it verbatim.
///
/// We invoke `Start-Process -Verb RunAs` from a non-elevated parent
/// PowerShell. The OS shows the UAC dialog; the user clicks Yes; the
/// elevated grandchild does the registry write; the parent blocks on
/// `-Wait` and propagates the grandchild's exit code via `-PassThru`.
/// If the user declines consent, `Start-Process` itself errors with
/// "The operation was canceled by the user" — we surface that as a
/// distinguishable error string so the UI can show a calmer message.
#[tauri::command]
pub fn enable_long_paths() -> Result<String, String> {
    if is_long_paths_enabled() {
        return Ok("already_enabled".to_string());
    }

    // The inner script the elevated child runs. Kept on one line so
    // PowerShell argument quoting stays simple. Writes the DWORD and
    // exits 0; any failure (registry locked, permission denied even
    // when elevated, etc.) propagates a non-zero exit.
    let inner = format!(
        "Set-ItemProperty -Path 'HKLM:\\{SUBKEY}' -Name '{VALUE_NAME}' \
         -Value 1 -Type DWord -Force"
    );

    // Outer script: Start-Process the inner script with elevation,
    // wait for it, propagate ExitCode. -WindowStyle Hidden suppresses
    // the brief PowerShell flash users sometimes find startling.
    let outer = format!(
        "$ErrorActionPreference = 'Stop'; \
         $p = Start-Process powershell -Verb RunAs -Wait -PassThru \
         -WindowStyle Hidden \
         -ArgumentList '-NoProfile','-NonInteractive','-Command',\"{inner}\"; \
         exit $p.ExitCode"
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &outer])
        .output()
        .map_err(|e| format!("failed to spawn powershell: {e}"))?;

    if output.status.success() {
        // Confirm via a fresh registry read — paranoid but cheap, and
        // catches the case where Start-Process said success but the
        // elevated child silently did nothing (e.g. policy override).
        if is_long_paths_enabled() {
            return Ok("enabled".to_string());
        }
        return Err(
            "the elevated registry write reported success but the value did not stick \
             — check that your AD policy isn't pinning LongPathsEnabled=0"
                .to_string(),
        );
    }

    // Surface the elevated child's stderr if any. The most common
    // failure is the UAC decline, which Start-Process reports as
    // "The operation was canceled by the user."
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("canceled by the user") {
        return Err("UAC consent was declined".to_string());
    }
    Err(format!(
        "elevation failed (exit {}): {}",
        output.status.code().unwrap_or(-1),
        stderr.trim()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sanity check: the read accessor never panics regardless of the
    /// registry state on the dev box. (Don't assert a specific value —
    /// that depends on what the running developer has configured.)
    #[test]
    fn is_long_paths_enabled_returns_a_bool() {
        let _ = is_long_paths_enabled();
    }
}
