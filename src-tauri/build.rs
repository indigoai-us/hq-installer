fn main() {
    println!("cargo:rerun-if-env-changed=HQ_INSTALLER_SENTRY_DSN");
    println!(
        "cargo:rustc-env=SENTRY_DSN={}",
        std::env::var("HQ_INSTALLER_SENTRY_DSN").unwrap_or_default()
    );
    tauri_build::build()
}
