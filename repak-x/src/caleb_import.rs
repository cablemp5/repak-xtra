//! caleb fork: hands the app a loadouts file dropped at %APPDATA%\Repak-X\caleb-import-loadouts.json
//! (written by scripts/tags-to-loadouts.py), once. The file is renamed after it is read so the same
//! loadouts are never imported twice; the frontend merges them (custom/loadoutStore.ts).

use std::fs;
use std::path::Path;

const PENDING: &str = "caleb-import-loadouts.json";

fn take(dir: &Path) -> Result<Option<String>, String> {
    let file = dir.join(PENDING);
    if !file.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    fs::rename(&file, dir.join(format!("caleb-import-loadouts.imported-{stamp}.json"))).map_err(|e| e.to_string())?;
    Ok(Some(text))
}

#[tauri::command]
pub async fn take_pending_loadouts() -> Result<Option<String>, String> {
    take(&crate::app_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hands_the_file_over_once() {
        let dir = std::env::temp_dir().join(format!("caleb-import-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(take(&dir).unwrap(), None);
        fs::write(dir.join(PENDING), "[]").unwrap();
        assert_eq!(take(&dir).unwrap().as_deref(), Some("[]"));
        assert_eq!(take(&dir).unwrap(), None);
        let _ = fs::remove_dir_all(&dir);
    }
}
