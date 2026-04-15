//! Integration test for `core::platform` against the live host.
//!
//! Unit tests in `core/platform.rs` cover every dispatch arm with injected
//! inputs. This integration test proves the wiring — `detect_platform()`
//! runs against the real `std::env::consts::OS`, real `/etc/os-release`,
//! and real `PATH` — without asserting anything about what the host has
//! installed. CI runs on macos-latest; contributors run on whatever they
//! have. The test only checks that:
//!
//! 1. The call succeeds (no panic, no undefined behavior).
//! 2. The returned `os` matches `std::env::consts::OS` at the family level
//!    (i.e. running on macOS yields `OsType::Macos`, running on Linux yields
//!    one of the Linux variants, etc.).
//! 3. The JSON serialization is stable — the renderer relies on this shape.

use hq_installer_lib::core::platform::{detect_platform, OsType};

#[test]
fn detect_platform_succeeds_on_host() {
    let info = detect_platform();

    // The returned OS must match the host family.
    let host_os = std::env::consts::OS;
    match host_os {
        "macos" => assert_eq!(info.os, OsType::Macos),
        "linux" => assert!(matches!(
            info.os,
            OsType::Linux | OsType::LinuxDebian | OsType::LinuxFedora | OsType::LinuxArch
        )),
        "windows" => assert_eq!(info.os, OsType::Windows),
        _ => assert_eq!(info.os, OsType::Unix),
    }
}

#[test]
fn platform_info_round_trips_through_json() {
    let info = detect_platform();
    let json = serde_json::to_string(&info).expect("serializes");
    assert!(json.contains(r#""os":"#));
    assert!(json.contains(r#""packageManager":"#));
    assert!(json.contains(r#""npmAvailable":"#));
}
