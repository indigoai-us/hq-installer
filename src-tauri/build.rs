fn main() {
    println!("cargo:rerun-if-env-changed=HQ_INSTALLER_SENTRY_DSN");
    println!(
        "cargo:rustc-env=SENTRY_DSN={}",
        std::env::var("HQ_INSTALLER_SENTRY_DSN").unwrap_or_default()
    );
    #[cfg(not(windows))]
    {
        tauri_build::build();
    }

    #[cfg(windows)]
    {
        let attrs = tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new_without_app_manifest()
                .app_manifest(include_str!("app.manifest")),
        );
        tauri_build::try_build(attrs).expect("tauri-build failed");
        println!("cargo:rerun-if-changed=app.manifest");
    }
}
