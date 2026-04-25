use serde_json::{Map, Value};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

// Internal helper that accepts an explicit path so tests can pass a tmpdir
// path without mutating the process-global HOME env var (which causes data
// races when tests run in parallel).
fn write_telemetry_pref_to(path: PathBuf, enabled: bool) -> Result<(), String> {
    // 1. Read existing JSON → untyped Map to preserve unknown keys.
    //    Missing/unparseable → start from {} (fail-open: prefer losing
    //    zero hq-sync prefs to losing all of them).
    let mut obj: Map<String, Value> = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        Map::new()
    };

    // 2. Merge new key. Do NOT touch other keys.
    obj.insert("telemetryEnabled".into(), Value::Bool(enabled));

    // 3. Atomic write via temp file + rename.
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().ok();
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_menubar_telemetry_pref(enabled: bool) -> Result<(), String> {
    let path: PathBuf = dirs::home_dir()
        .ok_or("home dir unavailable")?
        .join(".hq/menubar.json");
    write_telemetry_pref_to(path, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_dir() -> (TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tmpdir");
        let path = dir.path().join(".hq/menubar.json");
        (dir, path)
    }

    #[test]
    fn merge_preserves_other_keys() {
        let (_dir, path) = setup_dir();
        fs::create_dir_all(path.parent().unwrap()).unwrap();

        // Pre-seed with four known keys.
        let seed = serde_json::json!({
            "hqPath": "/custom",
            "syncOnLaunch": true,
            "notifications": false,
            "autostartDaemon": null
        });
        fs::write(&path, serde_json::to_string_pretty(&seed).unwrap()).unwrap();

        write_telemetry_pref_to(path.clone(), true).expect("should succeed");

        let result: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let obj = result.as_object().unwrap();

        // All five keys must be present.
        assert!(obj.contains_key("hqPath"), "hqPath missing");
        assert!(obj.contains_key("syncOnLaunch"), "syncOnLaunch missing");
        assert!(obj.contains_key("notifications"), "notifications missing");
        assert!(
            obj.contains_key("autostartDaemon"),
            "autostartDaemon missing"
        );
        assert!(
            obj.contains_key("telemetryEnabled"),
            "telemetryEnabled missing"
        );

        // Original values must be unchanged.
        assert_eq!(obj["hqPath"], Value::String("/custom".into()));
        assert_eq!(obj["syncOnLaunch"], Value::Bool(true));
        assert_eq!(obj["notifications"], Value::Bool(false));
        assert_eq!(obj["autostartDaemon"], Value::Null);

        // New value set correctly.
        assert_eq!(obj["telemetryEnabled"], Value::Bool(true));
    }

    #[test]
    fn creates_file_when_missing() {
        let (_dir, path) = setup_dir();
        // Directory does not exist yet — the function must create it.
        write_telemetry_pref_to(path.clone(), false).expect("should succeed");

        assert!(path.exists());
        let result: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(result["telemetryEnabled"], Value::Bool(false));
    }

    #[test]
    fn handles_corrupt_file_gracefully() {
        let (_dir, path) = setup_dir();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"not valid json").unwrap();

        // Should succeed by starting from {} (fail-open).
        write_telemetry_pref_to(path.clone(), true).expect("should succeed");

        let result: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(result["telemetryEnabled"], Value::Bool(true));
    }
}
