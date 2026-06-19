//! Cross-platform AI coding tool detection used by the final wizard screen.

#[cfg(windows)]
use std::path::PathBuf;

use serde::Serialize;

use crate::commands::{deps, launch};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AiTools {
    pub claude_cli: bool,
    pub claude_desktop: bool,
    pub codex_cli: bool,
    pub codex_desktop: bool,
    pub grok_cli: bool,
    pub any: bool,
}

#[tauri::command]
pub fn check_ai_tools() -> AiTools {
    let search_path = deps::extended_search_path();
    check_ai_tools_in(
        &search_path,
        launch::is_claude_desktop_installed(),
        codex_desktop_installed(),
    )
}

fn check_ai_tools_in(search_path: &str, claude_desktop: bool, codex_desktop: bool) -> AiTools {
    let claude_cli = cli_installed("claude", search_path);
    let codex_cli = cli_installed("codex", search_path);
    let grok_cli = cli_installed("grok", search_path);
    let any = claude_cli || claude_desktop || codex_cli || codex_desktop || grok_cli;

    AiTools {
        claude_cli,
        claude_desktop,
        codex_cli,
        codex_desktop,
        grok_cli,
        any,
    }
}

fn cli_installed(binary: &str, search_path: &str) -> bool {
    let cwd = std::env::current_dir().unwrap_or_default();
    which::which_in(binary, Some(search_path), cwd).is_ok()
}

#[cfg(not(windows))]
fn codex_desktop_installed() -> bool {
    if std::path::Path::new("/Applications/Codex.app").exists() {
        return true;
    }
    dirs::home_dir()
        .map(|home| home.join("Applications/Codex.app").exists())
        .unwrap_or(false)
}

#[cfg(windows)]
fn codex_desktop_installed() -> bool {
    // Best-effort only: Codex Desktop does not have an existing protocol or
    // registry probe in this repo. Keep this conservative to avoid false
    // positives from unrelated Uninstall entries.
    let Ok(local) = std::env::var("LOCALAPPDATA") else {
        return false;
    };
    let base = PathBuf::from(local).join("Programs").join("Codex");
    base.join("Codex.exe").exists() || base.join("codex.exe").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_reflects_desktop_tools() {
        let tools = check_ai_tools_in("", true, false);
        assert!(tools.claude_desktop);
        assert!(tools.any);

        let tools = check_ai_tools_in("", false, true);
        assert!(tools.codex_desktop);
        assert!(tools.any);
    }

    #[test]
    fn any_is_false_when_no_tools_are_found() {
        let dir = tempfile::tempdir().expect("tempdir");
        let tools = check_ai_tools_in(&dir.path().to_string_lossy(), false, false);
        assert_eq!(
            tools,
            AiTools {
                claude_cli: false,
                claude_desktop: false,
                codex_cli: false,
                codex_desktop: false,
                grok_cli: false,
                any: false,
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn detects_supported_clis_on_supplied_path() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["claude", "codex", "grok"] {
            let path = dir.path().join(name);
            let mut file = std::fs::File::create(&path).expect("create fake cli");
            writeln!(file, "#!/bin/sh").expect("write shebang");
            let mut perms = file.metadata().expect("metadata").permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).expect("chmod fake cli");
        }

        let tools = check_ai_tools_in(&dir.path().to_string_lossy(), false, false);
        assert!(tools.claude_cli);
        assert!(tools.codex_cli);
        assert!(tools.grok_cli);
        assert!(tools.any);
    }
}
