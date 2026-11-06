//! repakxtra: Settings > Storage (custom/StorageCleanup.tsx). Frees the disk space repakxtra uses in %APPDATA%\Repak-X,
//! one section at a time, picked by the player and confirmed. Only what repakxtra itself writes is listed: Repak X keeps
//! its own files in the same folder, and settings, loadouts, and check results that remember a choice (safe off,
//! Nothing to update) are never part of it. Two sections live elsewhere and may be in use while the app runs (the VFX
//! checks' decoded game files in %TEMP%, the window's browser caches in %LOCALAPPDATA%): picking them marks them, and
//! the next start clears them before the window or any check can open them (on_start).

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// (id, folders and files under %APPDATA%\Repak-X). The frontend holds each one's name and warning.
const SECTIONS: &[(&str, &[&str])] = &[
    ("previews", &["previews"]), // without previews\work, its own section (part_paths)
    ("preview-work", &["previews/work"]),
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

/// Sections cleared at the next start (ids), with their folders under the app's local data folder (`local`).
const AT_START: [&str; 2] = ["vfx", "browser"];
fn start_paths(id: &str, local: &Path) -> Vec<PathBuf> {
    match id {
        "vfx" => vec![std::env::temp_dir().join("repak-x").join("xvfx")],
        // caches only: Local Storage, IndexedDB, and cookies (settings, loadouts, sign-ins) stay
        "browser" => {
            let web = local.join("EBWebView");
            let mut v: Vec<PathBuf> = ["Cache", "Code Cache", "GPUCache", "DawnWebGPUCache", "Service Worker/CacheStorage", "Service Worker/ScriptCache"]
                .iter().map(|p| web.join("Default").join(p)).collect();
            v.extend(["GrShaderCache", "ShaderCache", "GraphiteDawnCache"].iter().map(|p| web.join(p)));
            v
        }
        _ => Vec::new(),
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Section {
    id: &'static str,
    bytes: u64,
    /// marked to clear at the next start
    pending: bool,
}

/// The folders and files a section part stands for: previews without its work folder (Preview work files).
fn part_paths(root: &Path, part: &str) -> Vec<PathBuf> {
    if part == "previews" {
        return fs::read_dir(root.join(part)).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| !p.ends_with("work")).collect();
    }
    vec![root.join(part)]
}

fn marker() -> PathBuf {
    crate::app_dir().join("repakxtra-clear-at-start.json")
}
fn marked() -> Vec<PathBuf> {
    fs::read(marker()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
/// Only folders under %TEMP%\repak-x or %LOCALAPPDATA% are ever cleared from the marker (it is a file anyone can edit).
fn allowed(p: &Path) -> bool {
    let under = |base: Option<PathBuf>| base.is_some_and(|b| p.starts_with(&b) && p != b);
    !p.components().any(|c| matches!(c, std::path::Component::ParentDir))
        && (under(Some(std::env::temp_dir().join("repak-x"))) || under(dirs::data_local_dir()))
}

/// In main(), before the window and any command: the marked folders are renamed out of use at once, then deleted in the
/// background. The marker keeps the renamed names until they are gone, so a quit midway finishes at the next start.
pub(crate) fn on_start() {
    let list: Vec<PathBuf> = marked().into_iter().filter(|p| allowed(p)).collect();
    if list.is_empty() {
        let _ = fs::remove_file(marker());
        return;
    }
    let gone: Vec<PathBuf> = list.into_iter().filter_map(|p| {
        if p.extension().is_some_and(|e| e == "repakxtra-old") || !p.exists() { return Some(p) } // renamed already, or gone
        let old = PathBuf::from(format!("{}.repakxtra-old", p.display()));
        fs::rename(&p, &old).ok().map(|_| old)
    }).collect();
    let _ = fs::write(marker(), serde_json::to_vec(&gone).unwrap_or_default());
    std::thread::spawn(move || {
        for p in &gone { let _ = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) }; }
        if gone.iter().all(|p| !p.exists()) { let _ = fs::remove_file(marker()); }
    });
}

fn size(p: &Path) -> u64 {
    WalkDir::new(p).into_iter().filter_map(Result::ok).filter(|e| e.file_type().is_file()).filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum()
}

fn sections_at(root: &Path) -> Vec<Section> {
    SECTIONS.iter().map(|(id, parts)| Section { id, bytes: parts.iter().flat_map(|p| part_paths(root, p)).map(|p| size(&p)).sum(), pending: false }).collect()
}

fn start_sections(local: &Path) -> Vec<Section> {
    let marked = marked();
    AT_START.iter().map(|id| {
        let paths = start_paths(id, local);
        Section { id, bytes: paths.iter().map(|p| size(p)).sum(), pending: !paths.is_empty() && paths.iter().all(|p| marked.contains(p)) }
    }).collect()
}

/// Deletes the picked sections. Ids not in SECTIONS are refused, so nothing outside the list is ever touched. Returns
/// the bytes freed; a file in use (a log the app is writing) is skipped, not an error.
fn clear_at(root: &Path, ids: &[String]) -> Result<u64, String> {
    let picked: Vec<_> = ids.iter().map(|id| SECTIONS.iter().find(|s| s.0 == id).ok_or(format!("Unknown section {id}"))).collect::<Result<_, _>>()?;
    let mut freed = 0;
    for (_, parts) in picked {
        for p in parts.iter().flat_map(|part| part_paths(root, part)) {
            let before = size(&p);
            let _ = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
            freed += before.saturating_sub(size(&p));
        }
    }
    Ok(freed)
}

fn local_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path().app_local_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn xtra_storage_sections(app: tauri::AppHandle) -> Result<Vec<Section>, String> {
    let local = local_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || { let mut v = sections_at(&crate::app_dir()); v.extend(start_sections(&local)); v })
        .await.map_err(|e| e.to_string())
}

/// Marks sections to clear at the next start (AT_START ids). Returns their size now.
#[tauri::command]
pub async fn xtra_storage_clear_at_start(app: tauri::AppHandle, ids: Vec<String>) -> Result<u64, String> {
    if let Some(bad) = ids.iter().find(|id| !AT_START.contains(&id.as_str())) { return Err(format!("Unknown section {bad}")) }
    let local = local_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut all = marked();
        let mut bytes = 0;
        for p in ids.iter().flat_map(|id| start_paths(id, &local)).filter(|p| allowed(p)) {
            bytes += size(&p);
            if !all.contains(&p) { all.push(p) }
        }
        fs::write(marker(), serde_json::to_vec(&all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok(bytes)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn xtra_storage_clear(ids: Vec<String>) -> Result<u64, String> {
    // alone: no mod change, encryption, or snapshot may use the trash or a snapshot while it goes
    let _alone = crate::xtra_mutation::alone("the cleanup")?;
    // previews or the kit: never while previews render or the kit installs (they write there), held until the files are gone
    let _kit = if ids.iter().any(|id| id == "previews" || id == "preview-work" || id == "kit") {
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
        assert!(!r.join("previews/a").exists() && !r.join("repakxtra-details-cache.json").exists());
        assert!(r.join("trash/1/x.pak").exists() && r.join("webview-storage.json").exists() && r.join("state.json").exists());
    }

    #[test]
    fn previews_and_their_work_files_are_two_sections() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        let put = |p: &str, n: usize| { let p = r.join(p); fs::create_dir_all(p.parent().unwrap()).unwrap(); fs::write(p, vec![0u8; n]).unwrap() };
        put("previews/a.png", 10);
        put("previews/work/cache/x.bin", 4);
        let by_id = |id: &str| sections_at(r).into_iter().find(|s| s.id == id).unwrap().bytes;
        assert_eq!((by_id("previews"), by_id("preview-work")), (10, 4));
        clear_at(r, &["previews".into()]).unwrap();
        assert!(!r.join("previews/a.png").exists() && r.join("previews/work/cache/x.bin").exists(), "the work files stay");
        assert!(!allowed(Path::new("C:/Windows")) && !allowed(&std::env::temp_dir().join("repak-x").join("..").join("x")), "nothing outside the two roots");
    }
}
