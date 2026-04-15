//! OS and package-manager detection.
//!
//! Rust port of `packages/create-hq/src/platform.ts` in the `indigoai-us/hq`
//! repo (pinned at create-hq v10.9.0–v10.9.1). Every variant of `OsType` and
//! `SystemPackageManager` — and every dispatch arm of `detect_system_pm` —
//! mirrors the TypeScript source byte-for-byte. Divergence is a bug
//! (see `docs/hq-install-spec.md` §9).
//!
//! ## Design
//!
//! Detection logic is split into two layers for testability:
//!
//! - **Pure functions** (`detect_os_from`, `detect_system_pm_with`) take
//!   explicit inputs (platform string, `/etc/os-release` contents, binary
//!   probe closure) so every OS × PM combination can be unit-tested from a
//!   single host without `#[cfg(target_os = "...")]` gating.
//! - **Host-aware wrappers** (`detect_os`, `detect_system_pm`, `detect_platform`)
//!   read the live environment and delegate to the pure layer.

use serde::{Deserialize, Serialize};

/// Operating system family, including Linux distro subfamily.
///
/// Matches `OsType` in create-hq TS source. The Linux distro variants encode
/// the package-manager dispatch key — generic `Linux` is the fallback when
/// `/etc/os-release` is missing or unparseable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OsType {
    Macos,
    LinuxDebian,
    LinuxFedora,
    LinuxArch,
    Linux,
    Windows,
    Unix,
}

/// System-level package manager. `None` means no recognized PM is installed.
///
/// Matches `SystemPackageManager` in create-hq TS source. Order of the enum
/// variants is not meaningful — dispatch is by `OsType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemPackageManager {
    Brew,
    Apt,
    Dnf,
    Yum,
    Pacman,
    Winget,
    Choco,
}

/// Snapshot of the host platform, ready to be consumed by the renderer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformInfo {
    /// Detected OS family (plus Linux distro subfamily when known).
    pub os: OsType,
    /// The native system package manager, if one is available.
    #[serde(rename = "packageManager")]
    pub package_manager: Option<SystemPackageManager>,
    /// Whether the `npm` binary is on `PATH`. Required for installing HQ
    /// (we ship via `npx create-hq`), so the UI surfaces this as a blocker.
    #[serde(rename = "npmAvailable")]
    pub npm_available: bool,
}

/// Probe whether a binary is resolvable via the current `PATH`.
///
/// Uses the `which` crate, which mirrors `which`/`where` semantics across
/// Unix and Windows. Errors (binary not found, PATH unreadable, etc.) all
/// collapse to `false` — the caller treats this as a boolean presence check.
fn has_bin(name: &str) -> bool {
    which::which(name).is_ok()
}

/// Detect OS family from `std::env::consts::OS` and `/etc/os-release`.
///
/// On Linux, reads `/etc/os-release` to narrow to a distro subfamily.
/// Missing or unparseable file falls back to generic `Linux`.
pub fn detect_os() -> OsType {
    let platform = std::env::consts::OS;
    let os_release = std::fs::read_to_string("/etc/os-release").ok();
    detect_os_from(platform, os_release.as_deref())
}

/// Pure OS detection — takes an explicit platform string and optional
/// `/etc/os-release` contents. Used by `detect_os` and the unit tests.
///
/// `platform` is the value of `std::env::consts::OS`: `"macos"`, `"linux"`,
/// `"windows"`, or an unrecognized value for which we return `Unix`.
pub fn detect_os_from(platform: &str, os_release: Option<&str>) -> OsType {
    match platform {
        "windows" => OsType::Windows,
        "macos" => OsType::Macos,
        "linux" => match os_release {
            Some(contents) => classify_linux(contents),
            None => OsType::Linux,
        },
        _ => OsType::Unix,
    }
}

/// Map `/etc/os-release` contents to a Linux distro subfamily.
///
/// Mirrors the regex dispatch in `create-hq/src/platform.ts`:
/// - debian/ubuntu: `ID_LIKE=*debian*`, `ID=ubuntu`, `ID=debian`
/// - fedora/rhel: `ID_LIKE=*fedora*`, `ID_LIKE=*rhel*`, `ID=fedora`
/// - arch: `ID=arch`, `ID_LIKE=*arch*`
///
/// Checks are case-insensitive and order-sensitive (debian beats fedora beats
/// arch if multiple would match — matches TS source behavior).
fn classify_linux(os_release: &str) -> OsType {
    let lower = os_release.to_ascii_lowercase();
    if lower.contains("id_like=") && lower.contains("debian")
        || lower.contains("id=ubuntu")
        || lower.contains("id=debian")
    {
        return OsType::LinuxDebian;
    }
    if lower.contains("id_like=") && (lower.contains("fedora") || lower.contains("rhel"))
        || lower.contains("id=fedora")
    {
        return OsType::LinuxFedora;
    }
    if lower.contains("id=arch") || (lower.contains("id_like=") && lower.contains("arch")) {
        return OsType::LinuxArch;
    }
    OsType::Linux
}

/// Resolve the native package manager for an `OsType` against the live host.
pub fn detect_system_pm(os: OsType) -> Option<SystemPackageManager> {
    detect_system_pm_with(os, has_bin)
}

/// Pure PM resolution — takes an injectable `has_bin` closure for testing.
///
/// Dispatch rules match `create-hq/src/platform.ts`:
/// - Windows: winget → choco
/// - macOS: brew
/// - linux-debian: apt
/// - linux-fedora: dnf → yum
/// - linux-arch: pacman
/// - Generic Linux / Unix fallback: apt → dnf → yum → pacman → brew
pub fn detect_system_pm_with<F>(os: OsType, has_bin: F) -> Option<SystemPackageManager>
where
    F: Fn(&str) -> bool,
{
    match os {
        OsType::Windows => {
            if has_bin("winget") {
                Some(SystemPackageManager::Winget)
            } else if has_bin("choco") {
                Some(SystemPackageManager::Choco)
            } else {
                None
            }
        }
        OsType::Macos => {
            if has_bin("brew") {
                Some(SystemPackageManager::Brew)
            } else {
                None
            }
        }
        OsType::LinuxDebian => {
            if has_bin("apt") {
                Some(SystemPackageManager::Apt)
            } else {
                None
            }
        }
        OsType::LinuxFedora => {
            if has_bin("dnf") {
                Some(SystemPackageManager::Dnf)
            } else if has_bin("yum") {
                Some(SystemPackageManager::Yum)
            } else {
                None
            }
        }
        OsType::LinuxArch => {
            if has_bin("pacman") {
                Some(SystemPackageManager::Pacman)
            } else {
                None
            }
        }
        OsType::Linux | OsType::Unix => {
            if has_bin("apt") {
                Some(SystemPackageManager::Apt)
            } else if has_bin("dnf") {
                Some(SystemPackageManager::Dnf)
            } else if has_bin("yum") {
                Some(SystemPackageManager::Yum)
            } else if has_bin("pacman") {
                Some(SystemPackageManager::Pacman)
            } else if has_bin("brew") {
                Some(SystemPackageManager::Brew)
            } else {
                None
            }
        }
    }
}

/// Snapshot the host platform: OS family, native PM, and npm availability.
pub fn detect_platform() -> PlatformInfo {
    let os = detect_os();
    PlatformInfo {
        os,
        package_manager: detect_system_pm(os),
        npm_available: has_bin("npm"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- detect_os_from: platform string dispatch ----

    #[test]
    fn detects_macos_from_darwin() {
        assert_eq!(detect_os_from("macos", None), OsType::Macos);
    }

    #[test]
    fn detects_windows() {
        assert_eq!(detect_os_from("windows", None), OsType::Windows);
    }

    #[test]
    fn unknown_platform_is_unix() {
        assert_eq!(detect_os_from("freebsd", None), OsType::Unix);
        assert_eq!(detect_os_from("openbsd", None), OsType::Unix);
    }

    #[test]
    fn linux_without_os_release_is_generic() {
        assert_eq!(detect_os_from("linux", None), OsType::Linux);
    }

    // ---- detect_os_from: Linux distro subfamilies ----

    #[test]
    fn detects_ubuntu_as_debian() {
        let os_release = r#"NAME="Ubuntu"
VERSION="22.04.3 LTS (Jammy Jellyfish)"
ID=ubuntu
ID_LIKE=debian
"#;
        assert_eq!(
            detect_os_from("linux", Some(os_release)),
            OsType::LinuxDebian
        );
    }

    #[test]
    fn detects_debian_directly() {
        let os_release = r#"NAME="Debian GNU/Linux"
VERSION="12 (bookworm)"
ID=debian
"#;
        assert_eq!(
            detect_os_from("linux", Some(os_release)),
            OsType::LinuxDebian
        );
    }

    #[test]
    fn detects_fedora() {
        let os_release = r#"NAME="Fedora Linux"
VERSION="39 (Workstation Edition)"
ID=fedora
ID_LIKE="rhel fedora"
"#;
        assert_eq!(
            detect_os_from("linux", Some(os_release)),
            OsType::LinuxFedora
        );
    }

    #[test]
    fn detects_rhel_as_fedora_family() {
        let os_release = r#"NAME="Red Hat Enterprise Linux"
VERSION="9.3 (Plow)"
ID=rhel
ID_LIKE="fedora"
"#;
        assert_eq!(
            detect_os_from("linux", Some(os_release)),
            OsType::LinuxFedora
        );
    }

    #[test]
    fn detects_arch_directly() {
        let os_release = r#"NAME="Arch Linux"
PRETTY_NAME="Arch Linux"
ID=arch
"#;
        assert_eq!(
            detect_os_from("linux", Some(os_release)),
            OsType::LinuxArch
        );
    }

    #[test]
    fn detects_manjaro_as_arch_family() {
        let os_release = r#"NAME="Manjaro Linux"
ID=manjaro
ID_LIKE=arch
"#;
        assert_eq!(
            detect_os_from("linux", Some(os_release)),
            OsType::LinuxArch
        );
    }

    #[test]
    fn unparseable_os_release_falls_back_to_linux() {
        assert_eq!(
            detect_os_from("linux", Some("garbage contents with no id lines")),
            OsType::Linux
        );
    }

    // ---- detect_system_pm_with: Windows ----

    #[test]
    fn windows_prefers_winget_over_choco() {
        let pm = detect_system_pm_with(OsType::Windows, |bin| bin == "winget" || bin == "choco");
        assert_eq!(pm, Some(SystemPackageManager::Winget));
    }

    #[test]
    fn windows_falls_back_to_choco() {
        let pm = detect_system_pm_with(OsType::Windows, |bin| bin == "choco");
        assert_eq!(pm, Some(SystemPackageManager::Choco));
    }

    #[test]
    fn windows_with_no_pm_returns_none() {
        let pm = detect_system_pm_with(OsType::Windows, |_| false);
        assert_eq!(pm, None);
    }

    // ---- detect_system_pm_with: macOS ----

    #[test]
    fn macos_with_brew() {
        let pm = detect_system_pm_with(OsType::Macos, |bin| bin == "brew");
        assert_eq!(pm, Some(SystemPackageManager::Brew));
    }

    #[test]
    fn macos_without_brew_returns_none() {
        let pm = detect_system_pm_with(OsType::Macos, |_| false);
        assert_eq!(pm, None);
    }

    // ---- detect_system_pm_with: Linux subfamilies ----

    #[test]
    fn debian_returns_apt() {
        let pm = detect_system_pm_with(OsType::LinuxDebian, |bin| bin == "apt");
        assert_eq!(pm, Some(SystemPackageManager::Apt));
    }

    #[test]
    fn debian_without_apt_returns_none() {
        let pm = detect_system_pm_with(OsType::LinuxDebian, |_| false);
        assert_eq!(pm, None);
    }

    #[test]
    fn fedora_prefers_dnf_over_yum() {
        let pm =
            detect_system_pm_with(OsType::LinuxFedora, |bin| bin == "dnf" || bin == "yum");
        assert_eq!(pm, Some(SystemPackageManager::Dnf));
    }

    #[test]
    fn fedora_falls_back_to_yum() {
        let pm = detect_system_pm_with(OsType::LinuxFedora, |bin| bin == "yum");
        assert_eq!(pm, Some(SystemPackageManager::Yum));
    }

    #[test]
    fn arch_returns_pacman() {
        let pm = detect_system_pm_with(OsType::LinuxArch, |bin| bin == "pacman");
        assert_eq!(pm, Some(SystemPackageManager::Pacman));
    }

    // ---- detect_system_pm_with: Generic Linux + Unix fallback ----

    #[test]
    fn generic_linux_finds_first_available_pm() {
        // apt wins if available
        let pm = detect_system_pm_with(OsType::Linux, |bin| bin == "apt" || bin == "dnf");
        assert_eq!(pm, Some(SystemPackageManager::Apt));
    }

    #[test]
    fn generic_linux_walks_fallback_chain() {
        // only pacman available — apt/dnf/yum all miss
        let pm = detect_system_pm_with(OsType::Linux, |bin| bin == "pacman");
        assert_eq!(pm, Some(SystemPackageManager::Pacman));
    }

    #[test]
    fn generic_linux_brew_last() {
        let pm = detect_system_pm_with(OsType::Linux, |bin| bin == "brew");
        assert_eq!(pm, Some(SystemPackageManager::Brew));
    }

    #[test]
    fn unix_uses_linux_fallback_chain() {
        let pm = detect_system_pm_with(OsType::Unix, |bin| bin == "dnf");
        assert_eq!(pm, Some(SystemPackageManager::Dnf));
    }

    // ---- serde roundtrip ----

    #[test]
    fn platform_info_serializes_to_expected_json() {
        let info = PlatformInfo {
            os: OsType::Macos,
            package_manager: Some(SystemPackageManager::Brew),
            npm_available: true,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains(r#""os":"macos""#));
        assert!(json.contains(r#""packageManager":"brew""#));
        assert!(json.contains(r#""npmAvailable":true"#));
    }

    #[test]
    fn platform_info_with_no_pm_serializes_null() {
        let info = PlatformInfo {
            os: OsType::Linux,
            package_manager: None,
            npm_available: false,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains(r#""packageManager":null"#));
    }

    #[test]
    fn debian_os_type_kebab_case() {
        let os = OsType::LinuxDebian;
        assert_eq!(serde_json::to_string(&os).unwrap(), "\"linux-debian\"");
    }
}
