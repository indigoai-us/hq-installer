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

trait PasswordCredential {
    fn set_password(&self, secret: &str) -> Result<(), keyring::Error>;
    fn delete_credential(&self) -> Result<(), keyring::Error>;
}

impl PasswordCredential for keyring::Entry {
    fn set_password(&self, secret: &str) -> Result<(), keyring::Error> {
        keyring::Entry::set_password(self, secret)
    }

    fn delete_credential(&self) -> Result<(), keyring::Error> {
        keyring::Entry::delete_credential(self)
    }
}

fn is_duplicate_item_error(err: &keyring::Error) -> bool {
    let keyring::Error::PlatformFailure(platform_err) = err else {
        return false;
    };

    let rendered = platform_err.to_string().to_ascii_lowercase();
    rendered.contains("errsecduplicateitem")
        || rendered.contains("-25299")
        || rendered.contains("specified item already exists in the keychain")
        || (rendered.contains("already exists") && rendered.contains("keychain"))
        || rendered.contains("error_already_exists")
        || rendered.contains("windows error code 183")
}

fn set_password_with_duplicate_recovery(
    entry: &impl PasswordCredential,
    secret: &str,
) -> Result<(), String> {
    match entry.set_password(secret) {
        Ok(()) => Ok(()),
        Err(e) if is_duplicate_item_error(&e) => {
            if let Err(delete_err) = entry.delete_credential() {
                eprintln!(
                    "[hq-keychain] failed to delete duplicate keychain item before retry: {delete_err}"
                );
                return Err(keychain_err(format!(
                    "delete duplicate keychain item before retry: {delete_err}"
                )));
            }
            entry.set_password(secret).map_err(keychain_err)
        }
        Err(e) => Err(keychain_err(e)),
    }
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
    // Writing must be idempotent. An existing entry can block the in-place
    // update — most notably macOS returns errSecDuplicateItem ("the specified
    // item already exists in the keychain") when the stored item's ACL is bound
    // to a different code signature (reinstalls, an updated signing identity,
    // or unsigned dev builds). Only that duplicate-item condition is safe to
    // recover by deleting and recreating; storage access, cancellation, and
    // transient backend errors must leave the existing secret untouched.
    set_password_with_duplicate_recovery(&entry, secret)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[derive(Debug)]
    struct FakeBackendError(&'static str);

    impl std::fmt::Display for FakeBackendError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }

    impl std::error::Error for FakeBackendError {}

    struct FakeCredential {
        first_set_error: RefCell<Option<keyring::Error>>,
        delete_error: RefCell<Option<keyring::Error>>,
        set_calls: Cell<usize>,
        delete_calls: Cell<usize>,
    }

    impl FakeCredential {
        fn new(first_set_error: keyring::Error) -> Self {
            Self {
                first_set_error: RefCell::new(Some(first_set_error)),
                delete_error: RefCell::new(None),
                set_calls: Cell::new(0),
                delete_calls: Cell::new(0),
            }
        }

        fn with_delete_error(
            first_set_error: keyring::Error,
            delete_error: keyring::Error,
        ) -> Self {
            Self {
                first_set_error: RefCell::new(Some(first_set_error)),
                delete_error: RefCell::new(Some(delete_error)),
                set_calls: Cell::new(0),
                delete_calls: Cell::new(0),
            }
        }
    }

    impl PasswordCredential for FakeCredential {
        fn set_password(&self, _secret: &str) -> Result<(), keyring::Error> {
            self.set_calls.set(self.set_calls.get() + 1);
            if let Some(err) = self.first_set_error.borrow_mut().take() {
                Err(err)
            } else {
                Ok(())
            }
        }

        fn delete_credential(&self) -> Result<(), keyring::Error> {
            self.delete_calls.set(self.delete_calls.get() + 1);
            if let Some(err) = self.delete_error.borrow_mut().take() {
                Err(err)
            } else {
                Ok(())
            }
        }
    }

    fn platform_error(message: &'static str) -> keyring::Error {
        keyring::Error::PlatformFailure(Box::new(FakeBackendError(message)))
    }

    #[test]
    fn set_password_retries_after_specific_duplicate_item_error() {
        let entry = FakeCredential::new(platform_error(
            "Security framework error: errSecDuplicateItem (-25299)",
        ));

        set_password_with_duplicate_recovery(&entry, "secret").expect("duplicate retry succeeds");

        assert_eq!(entry.set_calls.get(), 2);
        assert_eq!(entry.delete_calls.get(), 1);
    }

    #[test]
    fn set_password_non_duplicate_error_does_not_delete() {
        let entry = FakeCredential::new(keyring::Error::NoStorageAccess(Box::new(
            FakeBackendError("locked keychain"),
        )));

        let err = set_password_with_duplicate_recovery(&entry, "secret")
            .expect_err("non-duplicate set error should be returned");

        assert!(err.contains("locked keychain"), "unexpected error: {err}");
        assert_eq!(entry.set_calls.get(), 1);
        assert_eq!(
            entry.delete_calls.get(),
            0,
            "non-duplicate set failures must not delete existing credentials"
        );
    }

    #[test]
    fn set_password_duplicate_delete_failure_is_returned() {
        let entry = FakeCredential::with_delete_error(
            platform_error("The specified item already exists in the keychain."),
            keyring::Error::NoStorageAccess(Box::new(FakeBackendError("delete denied"))),
        );

        let err = set_password_with_duplicate_recovery(&entry, "secret")
            .expect_err("delete failure should be returned");

        assert!(err.contains("delete denied"), "unexpected error: {err}");
        assert_eq!(entry.set_calls.get(), 1);
        assert_eq!(entry.delete_calls.get(), 1);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows smoke tests — exercise the real Credential Manager backend
// ─────────────────────────────────────────────────────────────────────────────
//
// These are full round-trip tests that hit the OS keystore. They're gated
// to Windows + serial execution because Credential Manager state is process-
// global and concurrent test runs will collide.

#[cfg(all(test, windows))]
mod windows_smoke {
    use super::*;
    use uuid::Uuid;

    /// PRD US-005 acceptance: store + retrieve + delete a token via Windows
    /// Credential Manager and verify it round-trips.
    #[test]
    fn round_trip_set_get_delete_windows_credential_manager() {
        let service = format!("test-cognito-{}", Uuid::new_v4());
        let account = "test-user@indigo.ai";
        let secret = "fake-cognito-id-token-abc123";

        // Store.
        keychain_set_impl(&service, account, secret).expect("set should succeed");

        // Retrieve.
        let retrieved = keychain_get_impl(&service, account).expect("get should succeed");
        assert_eq!(
            retrieved.as_deref(),
            Some(secret),
            "stored secret should round-trip"
        );

        // Delete.
        keychain_delete_impl(&service, account).expect("delete should succeed");

        // Verify gone.
        let after = keychain_get_impl(&service, account).expect("get-after-delete OK");
        assert!(after.is_none(), "secret should be gone after delete");

        // Delete again — must be idempotent.
        keychain_delete_impl(&service, account).expect("second delete should succeed (idempotent)");
    }
}
