pub mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::deps::check_dep,
            commands::deps::install_homebrew,
            commands::deps::install_node,
            commands::deps::install_git,
            commands::deps::install_gh,
            commands::deps::install_claude_code,
            commands::deps::install_qmd,
            commands::deps::cancel_install,
            commands::xcode::xcode_clt_status,
            commands::xcode::xcode_clt_install,
            commands::keychain::keychain_set,
            commands::keychain::keychain_get,
            commands::keychain::keychain_delete,
            commands::git::git_init,
            commands::git::git_probe_user,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
