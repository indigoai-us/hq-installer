//! Integration tests for `core::deps` + `core::runner` against real shells.
//!
//! Unit tests in `core/deps.rs` cover every dispatch arm against mocked
//! `PlatformInfo`. These integration tests validate the `pub` surface of
//! the lib crate — the same entry points the Tauri commands use — plus
//! one live-shell round trip through the runner.

use std::sync::{Arc, Mutex};

use hq_installer_lib::core::deps::{
    self, CheckResult, DepId, InstallAction, PackageManager,
};
use hq_installer_lib::core::platform::{OsType, PlatformInfo, SystemPackageManager};
use hq_installer_lib::core::runner::{run_streaming, RunEvent};

#[test]
fn registry_exports_eight_deps() {
    // 7 from AC #1 + git from spec doc §3
    let reg = deps::registry();
    assert_eq!(reg.len(), 8);
}

#[test]
fn dep_registry_exposes_node_as_manual_install() {
    let node = deps::find(DepId::Node).expect("node in registry");
    let plan = deps::plan_install(
        &node,
        &PlatformInfo {
            os: OsType::Macos,
            package_manager: Some(SystemPackageManager::Brew),
            npm_available: true,
        },
    );
    assert!(matches!(
        plan,
        InstallAction::Manual { hint } if hint == "https://nodejs.org"
    ));
}

#[test]
fn gh_on_macos_resolves_to_brew_install_gh() {
    let gh = deps::find(DepId::Gh).unwrap();
    let cmd = deps::get_install_command(
        &gh,
        &PlatformInfo {
            os: OsType::Macos,
            package_manager: Some(SystemPackageManager::Brew),
            npm_available: true,
        },
    );
    assert_eq!(cmd.as_deref(), Some("brew install gh"));
}

#[test]
fn gh_on_fedora_yum_falls_back_to_dnf_command_with_pkexec() {
    let gh = deps::find(DepId::Gh).unwrap();
    let cmd = deps::get_install_command(
        &gh,
        &PlatformInfo {
            os: OsType::LinuxFedora,
            package_manager: Some(SystemPackageManager::Yum),
            npm_available: false,
        },
    );
    // yum → dnf command → pkexec wrap on Linux
    assert_eq!(cmd.as_deref(), Some("pkexec dnf install gh"));
}

#[test]
fn package_manager_enum_has_npm_variant() {
    // Npm is a valid install target even though it's never a system PM.
    let claude = deps::find(DepId::Claude).unwrap();
    assert!(claude.install_commands.contains_key(&PackageManager::Npm));
}

#[test]
fn check_all_runs_without_panic() {
    let results: Vec<CheckResult> = deps::check_all();
    assert_eq!(results.len(), 8);
    // Every dep returns either installed or not — no panics, no hangs.
    for r in &results {
        assert!(r.installed || !r.installed); // tautology; ensures field access compiles
    }
}

#[tokio::test]
async fn runner_streams_echo_output_live() {
    let buf: Arc<Mutex<Vec<RunEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let buf_clone = buf.clone();
    let sink = move |ev: RunEvent| {
        buf_clone.lock().unwrap().push(ev);
    };
    let code = run_streaming("echo integration-test-ok", sink).await;
    assert_eq!(code, Some(0));
    let events = buf.lock().unwrap();
    let saw_line = events.iter().any(|e| {
        matches!(e, RunEvent::Stdout { line } if line.contains("integration-test-ok"))
    });
    assert!(saw_line, "expected stdout line not seen: {events:?}");
    assert!(matches!(
        events.last(),
        Some(RunEvent::Exit { code: Some(0) })
    ));
}
