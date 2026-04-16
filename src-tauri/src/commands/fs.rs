use std::fs;
use std::path::Path;

#[tauri::command]
pub fn write_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    let file_path = Path::new(&path);

    // Create parent directories if they don't exist
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {e}"))?;
    }

    fs::write(file_path, &contents).map_err(|e| format!("Failed to write file: {e}"))
}

#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}
