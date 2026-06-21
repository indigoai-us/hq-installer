use sha2::{Digest, Sha256};

/// App-specific salt so the fingerprint can't be trivially reversed to a MAC or
/// correlated against another app that hashes the same MAC.
const FINGERPRINT_SALT: &[u8] = b"hq-installer/device-fingerprint/v1";

/// Stable, privacy-preserving device fingerprint.
///
/// Returns the SHA-256 hex of (salt + the primary network interface's MAC
/// address). The raw MAC never leaves the device — only this one-way hash is
/// returned — but the same machine yields the same fingerprint, which is what
/// lets the install funnel spot a repeat install. Returns an empty string when
/// no MAC is available (the caller treats that as "no device id").
#[tauri::command]
pub fn device_fingerprint() -> Result<String, String> {
    let mac = mac_address::get_mac_address().map_err(|e| e.to_string())?;
    let Some(mac) = mac else {
        return Ok(String::new());
    };
    let mut hasher = Sha256::new();
    hasher.update(FINGERPRINT_SALT);
    hasher.update(mac.bytes());
    let digest = hasher.finalize();
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
}
