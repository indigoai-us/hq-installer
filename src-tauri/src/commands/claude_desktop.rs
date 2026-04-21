// commands/claude_desktop.rs — US-019
//
// Claude desktop app detection + launch. Powers the completion-screen
// primary CTA, which routes users to the Claude desktop app when installed
// (ready / version-too-old) and to the public DMG download URL otherwise.
//
// Detection mirrors the approach the `claude` CLI uses internally for its
// `/desktop` command: check that `/Applications/Claude.app` exists, then
// read `CFBundleShortVersionString` via `defaults read` and compare against
// a minimum version. Minimum is kept in sync with the CLI's own gate.

use std::process::Command;

use serde::Serialize;

const CLAUDE_APP_PATH: &str = "/Applications/Claude.app";
const CLAUDE_DOWNLOAD_URL: &str =
    "https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect";
/// Minimum version that supports the `cwd`-bearing `claude://` deep link.
/// Matches the version gate inside the bundled `claude` CLI.
const MIN_DESKTOP_VERSION: (u32, u32, u32) = (1, 1, 2396);

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum DesktopStatus {
    NotInstalled,
    VersionTooOld {
        version: String,
        required: String,
    },
    Ready {
        version: String,
    },
}

/// Parse a `MAJOR.MINOR.PATCH` version string into a tuple.
/// Unparseable components become 0 so a malformed plist doesn't block launch.
fn parse_version(v: &str) -> (u32, u32, u32) {
    let mut parts = v.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    let patch = parts.next().unwrap_or(0);
    (major, minor, patch)
}

fn format_version(v: (u32, u32, u32)) -> String {
    format!("{}.{}.{}", v.0, v.1, v.2)
}

/// Read `CFBundleShortVersionString` from the Claude.app bundle via
/// `defaults read`. Returns `None` if `defaults` fails or emits nothing.
fn read_bundle_version() -> Option<String> {
    let output = Command::new("defaults")
        .args([
            "read",
            "/Applications/Claude.app/Contents/Info.plist",
            "CFBundleShortVersionString",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

#[tauri::command]
pub fn detect_claude_desktop() -> DesktopStatus {
    if !std::path::Path::new(CLAUDE_APP_PATH).exists() {
        return DesktopStatus::NotInstalled;
    }

    let Some(version) = read_bundle_version() else {
        return DesktopStatus::Ready {
            version: "unknown".to_string(),
        };
    };

    if parse_version(&version) < MIN_DESKTOP_VERSION {
        return DesktopStatus::VersionTooOld {
            version,
            required: format_version(MIN_DESKTOP_VERSION),
        };
    }

    DesktopStatus::Ready { version }
}

/// Percent-encode a path for inclusion in a URL query param.
/// Encodes everything outside RFC 3986 unreserved + `/` so the path stays
/// readable in logs while remaining safe in a URL.
fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let ok = b.is_ascii_alphanumeric()
            || b == b'-'
            || b == b'_'
            || b == b'.'
            || b == b'~'
            || b == b'/';
        if ok {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// Open the installed Claude desktop app at `path` via the `claude://` deep link.
/// Uses `claude://open?cwd=<path>` — the working-directory param the CLI already
/// emits for `claude://resume`. If the desktop app ignores `open` specifically,
/// macOS's `open` helper still wakes the bundle; the user lands in Claude and
/// the summary screen's instruction card tells them to type `/setup`.
#[tauri::command]
pub fn launch_claude_desktop(path: String) -> Result<(), String> {
    let url = format!("claude://open?cwd={}", percent_encode_path(&path));
    let output = Command::new("open")
        .arg(&url)
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

/// Open the Claude desktop DMG download URL in the default browser.
#[tauri::command]
pub fn open_claude_download() -> Result<(), String> {
    let output = Command::new("open")
        .arg(CLAUDE_DOWNLOAD_URL)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_semantic_versions() {
        assert_eq!(parse_version("1.1.2396"), (1, 1, 2396));
        assert_eq!(parse_version("2.0.0"), (2, 0, 0));
        assert_eq!(parse_version("1.1"), (1, 1, 0));
    }

    #[test]
    fn falls_back_to_zero_for_garbage() {
        assert_eq!(parse_version("not-a-version"), (0, 0, 0));
        assert_eq!(parse_version(""), (0, 0, 0));
    }

    #[test]
    fn version_comparison_matches_min_gate() {
        assert!(parse_version("1.1.2396") >= MIN_DESKTOP_VERSION);
        assert!(parse_version("1.1.2500") >= MIN_DESKTOP_VERSION);
        assert!(parse_version("2.0.0") >= MIN_DESKTOP_VERSION);
        assert!(parse_version("1.1.2395") < MIN_DESKTOP_VERSION);
        assert!(parse_version("1.0.9999") < MIN_DESKTOP_VERSION);
        assert!(parse_version("0.9.0") < MIN_DESKTOP_VERSION);
    }

    #[test]
    fn percent_encodes_unsafe_bytes_but_preserves_slash() {
        assert_eq!(
            percent_encode_path("/Users/alice/My HQ"),
            "/Users/alice/My%20HQ"
        );
        assert_eq!(
            percent_encode_path("/tmp/he said \"hi\""),
            "/tmp/he%20said%20%22hi%22"
        );
        assert_eq!(
            percent_encode_path("/tmp/plain_path-1.2"),
            "/tmp/plain_path-1.2"
        );
    }
}
