pub mod commands;
mod sentry_scrub;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use sentry::ClientOptions;
    use sentry_scrub::before_send;
    use std::sync::Arc;
    // `SENTRY_DSN` is set at compile time by build.rs, which reads
    // `HQ_INSTALLER_SENTRY_DSN` from the CI env. On local `cargo build`
    // / `cargo tauri dev` / PR CI (where the release-only secret is not
    // in scope), build.rs emits `cargo:rustc-env=SENTRY_DSN=` (empty),
    // so `env!("SENTRY_DSN")` evaluates to `""` — an empty string has
    // no URL scheme and `"".parse::<sentry::types::Dsn>()` returns Err,
    // which would panic if we unwrapped. Gate on emptiness → None so the
    // Sentry client no-ops cleanly in dev instead of crashing at startup.
    let dsn_str = env!("SENTRY_DSN");
    let dsn: Option<sentry::types::Dsn> = if dsn_str.is_empty() {
        None
    } else {
        Some(dsn_str.parse().expect("SENTRY_DSN invalid at build time"))
    };
    let _guard = sentry::init(ClientOptions {
        dsn,
        release: Some(format!("hq-installer@{}", env!("CARGO_PKG_VERSION")).into()),
        environment: Some(
            option_env!("SENTRY_ENVIRONMENT")
                .unwrap_or("production")
                .into(),
        ),
        sample_rate: std::env::var("SENTRY_SAMPLE_RATE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1.0),
        before_send: Some(Arc::new(before_send)),
        ..Default::default()
    });
    sentry::configure_scope(|scope| {
        scope.set_tag("repo", "hq-installer");
    });

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    // Agent-browser MCP server — debug-only E2E testing hook.
    // Enabled via `--features agent-test`; binds 127.0.0.1:9876.
    #[cfg(feature = "agent-test")]
    let builder = builder.plugin(tauri_plugin_agent_test::init());

    builder
        .invoke_handler(tauri::generate_handler![
            commands::deps::check_dep,
            commands::deps::install_homebrew,
            commands::deps::install_node,
            commands::deps::install_git,
            commands::deps::install_gh,
            commands::deps::install_claude_code,
            commands::deps::install_qmd,
            commands::deps::install_yq,
            commands::deps::cancel_install,
            commands::directory::pick_directory,
            commands::directory::detect_hq,
            commands::directory::create_directory,
            commands::xcode::xcode_clt_status,
            commands::xcode::xcode_clt_install,
            commands::keychain::keychain_set,
            commands::keychain::keychain_get,
            commands::keychain::keychain_delete,
            commands::oauth::oauth_listen_for_code,
            commands::git::git_init,
            commands::git::git_probe_user,
            commands::process::spawn_process,
            commands::process::cancel_process,
            commands::template::fetch_template,
            commands::fs::write_file,
            commands::fs::home_dir,
            commands::launch::launch_claude_code,
            commands::launch::launch_claude_desktop,
            commands::install_menubar::install_menubar_app,
            commands::install_menubar::launch_menubar_app,
            commands::menubar::write_menubar_telemetry_pref,
            commands::menubar::write_menubar_hq_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
