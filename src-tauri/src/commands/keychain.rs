//! Secure token storage via macOS Keychain using the `keyring` crate.
//!
//! `keychain_set`    — write a secret for a (service, account) pair.
//! `keychain_get`    — read a secret; returns `None` if not found.
//! `keychain_delete` — remove a secret; idempotent (no error if absent).
//!
//! All services are automatically prefixed with `com.indigoai.hq-installer`.
//! Callers pass only the sub-service name (e.g. `"cognito"`, `"pat"`).

use serde_json::json;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE_PREFIX: &str = "com.indigoai.hq-installer";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Build the fully-qualified Keychain service name.
fn full_service(sub_service: &str) -> String {
    format!("{}.{}", SERVICE_PREFIX, sub_service)
}

/// Serialize an error into the structured JSON string expected by the TS side.
fn keychain_err(message: impl std::fmt::Display) -> String {
    serde_json::to_string(&json!({
        "code": "KEYCHAIN_ERROR",
        "message": message.to_string()
    }))
    .unwrap()
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure impl functions (testable without a Tauri runtime)
// ─────────────────────────────────────────────────────────────────────────────

/// Write `secret` to the Keychain under `(service, account)`.
///
/// `service` is the caller-supplied sub-service name; the prefix is added here.
pub fn keychain_set_impl(service: &str, account: &str, secret: &str) -> Result<(), String> {
    let svc = full_service(service);
    let entry = keyring::Entry::new(&svc, account).map_err(keychain_err)?;
    entry.set_password(secret).map_err(keychain_err)
}

/// Read the secret for `(service, account)` from the Keychain.
///
/// Returns `Ok(None)` when no entry exists; only errors on a real Keychain
/// failure (permission denied, OS error, etc.).
pub fn keychain_get_impl(service: &str, account: &str) -> Result<Option<String>, String> {
    let svc = full_service(service);
    let entry = keyring::Entry::new(&svc, account).map_err(keychain_err)?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(keychain_err(e)),
    }
}

/// Delete the Keychain entry for `(service, account)`.
///
/// Idempotent: returns `Ok(())` if the entry does not exist.
pub fn keychain_delete_impl(service: &str, account: &str) -> Result<(), String> {
    let svc = full_service(service);
    let entry = keyring::Entry::new(&svc, account).map_err(keychain_err)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // idempotent
        Err(e) => Err(keychain_err(e)),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

/// Write a secret to the macOS Keychain.
#[tauri::command]
pub fn keychain_set(service: String, account: String, secret: String) -> Result<(), String> {
    keychain_set_impl(&service, &account, &secret)
}

/// Read a secret from the macOS Keychain.
///
/// Returns `null` (serialised as `None`) when no entry exists.
#[tauri::command]
pub fn keychain_get(service: String, account: String) -> Result<Option<String>, String> {
    keychain_get_impl(&service, &account)
}

/// Delete a Keychain entry (idempotent).
#[tauri::command]
pub fn keychain_delete(service: String, account: String) -> Result<(), String> {
    keychain_delete_impl(&service, &account)
}
