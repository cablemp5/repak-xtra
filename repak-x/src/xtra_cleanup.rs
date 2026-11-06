//! repakxtra: Settings > Storage (custom/StorageCleanup.tsx). Frees the disk space repakxtra uses in %APPDATA%\Repak-X,
//! one section at a time, picked by the player and confirmed. Only what repakxtra itself writes is listed: Repak X keeps
//! its own files in the same folder, and settings, loadouts, and check results that remember a choice (safe off,
//! Nothing to update) are never part of it.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// (id, folders and files under %APPDATA%\Repak-X). The frontend holds each one's name and warning.
const SECTIONS: &[(&str, &[&str])] = &[
    ("previews", &["previews"]),
    ("trash", &["trash"]),
    ("kit", &["preview-kit", "preview-kit-download.zip", "preview-kit-latest.json"]),
    ("encryption", &["encryption-backups"]),
    ("snapshots", &["snapshots"]),
    ("plugins", &["removed-plugins"]),
    ("caches", &[
        "repakxtra-game-assets.bin", "repakxtra-game-assets.prev.bin", "repakxtra-details-cache.json", "repakxtra-mod-classes.json",
        "builtin-cache", // the logs here are Repak X's too (same names, same folder): never listed
    ]),
];

#[derive(Serialize, Debug, PartialEq)]
pub struct Section {
    id: &'static str,
    bytes: u64,
}

fn size(p: &Path) -> u64 {
    WalkDir::new(p).into_iter().filter_map(Result::ok).filter(|e| e.file_type().is_file()).filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum()
}

fn sections_at(root: &Path) -> Vec<Section> {
    SECTIONS.iter().map(|(id, parts)| Section { id, bytes: parts.iter().map(|p| size(&root.join(p))).sum() }).collect()
}

/// Deletes the picked sections. Ids not in SECTIONS are refused, so nothing outside the list is ever touched. Returns
/// the bytes freed; a file in use (a log the app is writing) is skipped, not an error.
fn clear_at(root: &Path, ids: &[String]) -> Result<u64, String> {
    let picked: Vec<_> = ids.iter().map(|id| SECTIONS.iter().find(|s| s.0 == id).ok_or(format!("Unknown section {id}"))).collect::<Result<_, _>>()?;
    let mut freed = 0;
    for (_, parts) in picked {
        for part in *parts {
            let p: PathBuf = root.join(part);
            let before = size(&p);
            let _ = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
            freed += before.saturating_sub(size(&p));
        }
    }
    Ok(freed)
}

#[tauri::command]
pub async fn xtra_storage_sections() -> Result<Vec<Section>, String> {
    tauri::async_runtime::spawn_blocking(|| sections_at(&crate::app_dir())).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn xtra_storage_clear(ids: Vec<String>) -> Result<u64, String> {
    // alone: no mod change, encryption, or snapshot may use the trash or a snapshot while it goes
    let _alone = crate::xtra_mutation::alone("the cleanup")?;
    // previews or the kit: never while previews render or the kit installs (they write there), held until the files are gone
    let _kit = if ids.iter().any(|id| id == "previews" || id == "kit") {
        Some(crate::xtra_previews::reserve("cleanup").map_err(crate::xtra_previews::busy_text)?)
    } else { None };
    tauri::async_runtime::spawn_blocking(move || clear_at(&crate::app_dir(), &ids)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clears_only_the_picked_sections() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        let put = |p: &str, n: usize| { let p = r.join(p); fs::create_dir_all(p.parent().unwrap()).unwrap(); fs::write(p, vec![0u8; n]).unwrap() };
        put("previews/a/b.png", 10);
        put("trash/1/x.pak", 5);
        put("repakxtra-details-cache.json", 3);
        put("webview-storage.json", 7); // settings and loadouts
        put("state.json", 7); // Repak X's own
        let by_id = |id: &str| sections_at(r).into_iter().find(|s| s.id == id).unwrap().bytes;
        assert_eq!((by_id("previews"), by_id("trash"), by_id("caches")), (10, 5, 3));
        assert!(clear_at(r, &["../x".into()]).is_err(), "an id outside the list");
        assert_eq!(clear_at(r, &["previews".into(), "caches".into()]).unwrap(), 13);
        assert!(!r.join("previews").exists() && !r.join("repakxtra-details-cache.json").exists());
        assert!(r.join("trash/1/x.pak").exists() && r.join("webview-storage.json").exists() && r.join("state.json").exists());
    }
}
