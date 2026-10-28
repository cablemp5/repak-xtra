//! repakxtra: repakxtra's saved webview data (its `repakxtra.*` localStorage keys: loadouts, groups, view settings),
//! shared between the stable/test copies and the dev copy (dev.ps1) through %APPDATA%\Repak-X\webview-storage.json.
//! They run from different addresses, so each has its own localStorage; the newest save wins (custom/devStorage.ts).
//! The file is `{"at": <ms>, "data": {...}}`; the first version wrote the bare `data` object, which still reads (at 1).
//! Before a copy's own entries are replaced, they are kept in webview-storage.backup.json.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// One write at a time (these commands run off the window's thread, and every window saves), and the `at` of the newest
/// snapshot written, so a save that arrives late never replaces a newer one.
static WRITING: Mutex<u64> = Mutex::new(0);

const MAX_BYTES: usize = 32 * 1024 * 1024;

fn file(name: &str) -> PathBuf {
    crate::app_dir().join(name)
}

/// An object of string values under repakxtra.* names, so no copy ever loads anything else.
fn checked_data(v: &serde_json::Value) -> bool {
    v.as_object().is_some_and(|m| m.iter().all(|(k, v)| k.starts_with("repakxtra.") && v.is_string()))
}

/// `{"at": n, "data": {...}}`, or the first version's bare data object.
fn checked(text: &str) -> Result<(), String> {
    if text.len() > MAX_BYTES {
        return Err("The saved data is too large to copy".into());
    }
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("Not a storage copy: {e}"))?;
    let ok = match (v.get("at"), v.get("data")) {
        (Some(at), Some(data)) => at.is_u64() && checked_data(data),
        _ => checked_data(&v),
    };
    if ok { Ok(()) } else { Err("Not a storage copy".into()) }
}

/// Written through a temporary file, so a crash mid-write never leaves half a copy.
fn write(name: &str, text: &str) -> Result<(), String> {
    checked(text)?;
    fs::create_dir_all(crate::app_dir()).map_err(|e| e.to_string())?;
    let path = file(name);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn xtra_storage_snapshot_write(text: String) -> Result<(), String> {
    let at = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v.get("at").and_then(|a| a.as_u64())).unwrap_or(0);
    let mut newest = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    if !newer(at, *newest) {
        return Ok(());
    }
    write("webview-storage.json", &text)?;
    *newest = at;
    Ok(())
}

/// Pure: whether a snapshot taken at `at` may replace the newest one written this session (`newest`, 0 before any).
fn newer(at: u64, newest: u64) -> bool {
    at >= newest
}

#[tauri::command(async)]
pub fn xtra_storage_snapshot_read() -> Option<String> {
    fs::read_to_string(file("webview-storage.json")).ok().filter(|t| checked(t).is_ok())
}

/// A copy's own entries, kept just before newer ones from another copy replace them.
#[tauri::command(async)]
pub fn xtra_storage_backup_write(text: String) -> Result<(), String> {
    let _one_at_a_time = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    write("webview-storage.backup.json", &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_repakxtra_string_entries_count() {
        assert!(checked(r#"{"at":1760000000000,"data":{"repakxtra.loadouts":"[]","repakxtra.view":"cards"}}"#).is_ok());
        assert!(checked(r#"{"repakxtra.loadouts":"[]"}"#).is_ok(), "the first version's file still reads");
        assert!(checked("{}").is_ok());
        assert!(checked(r#"{"at":1,"data":{"other.key":"x"}}"#).is_err());
        assert!(checked(r#"{"at":"soon","data":{}}"#).is_err());
        assert!(checked(r#"{"other.key":"x"}"#).is_err());
        assert!(checked(r#"{"repakxtra.loadouts":[]}"#).is_err());
        assert!(checked("[1]").is_err() && checked("not json").is_err());
    }

    #[test]
    fn a_late_older_snapshot_never_replaces_a_newer_one() {
        assert!(newer(5, 0) && newer(5, 5));
        assert!(!newer(4, 5));
    }
}
