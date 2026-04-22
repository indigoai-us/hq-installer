pub mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            commands::install_menubar::install_menubar_app,
            commands::install_menubar::launch_menubar_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
