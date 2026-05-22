pub mod commands;
mod sentry_scrub;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use sentry::ClientOptions;
    use sentry_scrub::before_send;
    use std::sync::Arc;
    use tauri::menu::{
        AboutMetadataBuilder, CheckMenuItemBuilder, MenuBuilder, PredefinedMenuItem, SubmenuBuilder,
    };
    use tauri::Emitter;
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

    // Custom macOS App Menu — same structure Tauri auto-generates by default,
    // plus a CheckMenuItem ("Use Staging Channel") inserted directly below
    // "About HQ Installer". The toggle's persisted state lives in
    // ~/.hq/installer.json (see commands::staging) and survives restarts. On
    // toggle, we flip the file, update the menu checkmark, and emit
    // `staging-source://changed` so any open screen can react if it cares
    // (today the wizard reads the flag fresh on each fetch attempt).
    let builder = builder.setup(|app| {
        let pref_path = commands::staging::default_installer_pref_path()
            .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
        let initial_checked = commands::staging::read_use_staging_from(&pref_path);

        let about_metadata = AboutMetadataBuilder::new()
            .name(Some("HQ Installer".to_string()))
            .version(Some(env!("CARGO_PKG_VERSION").to_string()))
            .build();

        let staging_item = CheckMenuItemBuilder::with_id(
            "toggle_staging_source",
            "Use Staging Channel (hq-core-staging)",
        )
        .checked(initial_checked)
        .build(app)?;

        let app_submenu = SubmenuBuilder::new(app, "HQ Installer")
            .item(&PredefinedMenuItem::about(
                app,
                Some("About HQ Installer"),
                Some(about_metadata),
            )?)
            .separator()
            .item(&staging_item)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;

        let menu = MenuBuilder::new(app).item(&app_submenu).build()?;
        app.set_menu(menu)?;

        // Capture the item + path by clone so the event handler can flip the
        // check state and persist without re-resolving by ID. CheckMenuItem
        // is cheaply Clone — internally a handle to the underlying muda item.
        let staging_item_for_event = staging_item.clone();
        let pref_path_for_event = pref_path.clone();
        app.on_menu_event(move |app_handle, event| {
            if event.id() == staging_item_for_event.id() {
                // Toggle: derive the new value from the menu's reported
                // check state (not from re-reading the file) so the UI is
                // always source of truth for "what did the user just click".
                let new_value = staging_item_for_event.is_checked().unwrap_or(false);
                if let Err(err) =
                    commands::staging::write_use_staging_to(pref_path_for_event.clone(), new_value)
                {
                    eprintln!("[hq-installer] failed to persist staging toggle: {err}");
                }
                let _ = app_handle.emit("staging-source://changed", new_value);
            }
        });

        Ok(())
    });

    builder
        .invoke_handler(tauri::generate_handler![
            commands::deps::check_dep,
            commands::deps::install_homebrew,
            commands::deps::install_node,
            commands::deps::install_git,
            commands::deps::install_gh,
            commands::deps::install_claude_code,
            commands::deps::install_qmd,
            commands::deps::install_hq_cli,
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
            commands::fs::create_symlink,
            commands::launch::launch_claude_code,
            commands::launch::launch_claude_desktop,
            commands::launch::open_claude_code_link,
            commands::launch::claude_desktop_installed,
            commands::install_menubar::install_menubar_app,
            commands::install_menubar::launch_menubar_app,
            commands::menubar::write_menubar_telemetry_pref,
            commands::menubar::write_menubar_hq_path,
            commands::staging::get_use_staging_source,
            commands::staging::get_github_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
