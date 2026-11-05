//! repakxtra: snapshots of the mods folder (Setup > Snapshots, custom/SnapshotCard.tsx). A snapshot is a full copy of
//! ~mods and the Setup files in Binaries\Win64 (dsound.dll and plugins\) in %APPDATA%\Repak-X\snapshots\<unix secs>.
//! A game update, a reinstall, or Steam's Verify integrity of game files can leave mods or the bypass missing. Restore
//! puts back only what is gone and never overwrites or deletes a file that is there, so it cannot undo later changes.
//! A mod counts as there under another priority (a rename) or switched off (.bak_repak), so restore never doubles one.

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::State;
use walkdir::WalkDir;

/// The newest snapshots kept: making a fourth deletes the oldest.
const KEEP: usize = 3;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Snapshot {
    id: String,
    created: u64,
    files: usize,
    bytes: u64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Restored {
    mods: usize,
    setup: usize,
}

fn root() -> PathBuf {
    crate::app_dir().join("snapshots")
}

/// Every file under `dir` as (path relative to `dir`, size).
fn files(dir: &Path) -> Vec<(PathBuf, u64)> {
    WalkDir::new(dir).into_iter().filter_map(Result::ok).filter(|e| e.file_type().is_file())
        .filter_map(|e| Some((e.path().strip_prefix(dir).ok()?.to_path_buf(), e.metadata().ok()?.len())))
        .collect()
}

/// The Setup files beside the game exe: the loader (on or off) and every plugin, as paths relative to Win64.
fn setup_files(win64: &Path) -> Vec<(PathBuf, u64)> {
    let mut out: Vec<_> = ["dsound.dll", "dsound.dll.disabled"].iter().map(PathBuf::from)
        .filter_map(|p| Some((p.clone(), fs::metadata(win64.join(&p)).ok()?.len()))).collect();
    out.extend(files(&win64.join("plugins")).into_iter().map(|(p, n)| (Path::new("plugins").join(p), n)));
    out
}

/// One mod file's identity whatever its folder, priority, or on/off state: "X_9999999_P.bak_repak" -> "x.pak".
fn mod_key(rel: &Path) -> String {
    let name = rel.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let (stem, ext) = name.rsplit_once('.').unwrap_or((&name, ""));
    let ext = if ext == "bak_repak" { "pak" } else { ext };
    static PRIORITY: OnceLock<regex_lite::Regex> = OnceLock::new();
    let re = PRIORITY.get_or_init(|| regex_lite::Regex::new(r"^!?(.*?)(_9+)?(_p)?$").unwrap());
    let base = re.captures(stem).and_then(|c| c.get(1)).map_or(stem, |m| m.as_str());
    format!("{base}.{ext}")
}

/// A Setup file's identity: the loader on or off is the same file.
fn setup_key(rel: &Path) -> String {
    rel.to_string_lossy().to_lowercase().trim_end_matches(".disabled").to_string()
}

fn copy_all(list: &[(PathBuf, u64)], from: &Path, to: &Path) -> std::io::Result<()> {
    for (rel, _) in list {
        let dest = to.join(rel);
        fs::create_dir_all(dest.parent().unwrap_or(to))?;
        fs::copy(from.join(rel), dest)?;
    }
    Ok(())
}

fn create_at(root: &Path, id: &str, mods: &Path, win64: &Path) -> Result<Snapshot, String> {
    let (m, s) = (files(mods), setup_files(win64));
    if m.is_empty() && s.is_empty() {
        return Err("The mods folder is empty: there is nothing to snapshot.".into());
    }
    let dir = root.join(id);
    let made = copy_all(&m, mods, &dir.join("mods")).and_then(|_| copy_all(&s, win64, &dir.join("win64")));
    if let Err(e) = made {
        let _ = fs::remove_dir_all(&dir); // a half copy (a full disk) is never offered as a snapshot
        return Err(format!("Could not make the snapshot: {e}"));
    }
    let mut all = list_at(root);
    for old in all.split_off(KEEP.min(all.len())) {
        let _ = fs::remove_dir_all(root.join(&old.id));
    }
    all.into_iter().find(|x| x.id == id).ok_or_else(|| "The snapshot was not saved.".into())
}

fn list_at(root: &Path) -> Vec<Snapshot> {
    let mut out: Vec<_> = fs::read_dir(root).into_iter().flatten().flatten().filter_map(|e| {
        let id = e.file_name().to_string_lossy().to_string();
        let created = id.parse().ok()?;
        let all = files(&e.path());
        Some(Snapshot { id, created, files: all.len(), bytes: all.iter().map(|f| f.1).sum() })
    }).collect();
    out.sort_by(|a, b| b.created.cmp(&a.created));
    out
}

/// What the snapshot has that is gone now: (mod files, Setup files), as paths relative to its mods\ and win64\.
fn missing_at(snap: &Path, mods: &Path, win64: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let have: HashSet<_> = files(mods).iter().map(|f| mod_key(&f.0)).collect();
    let have_setup: HashSet<_> = setup_files(win64).iter().map(|f| setup_key(&f.0)).collect();
    let gone_mods = files(&snap.join("mods")).into_iter().map(|f| f.0).filter(|p| !have.contains(&mod_key(p))).collect();
    let gone_setup = files(&snap.join("win64")).into_iter().map(|f| f.0).filter(|p| !have_setup.contains(&setup_key(p))).collect();
    (gone_mods, gone_setup)
}

fn restore_at(snap: &Path, mods: &Path, win64: &Path) -> Result<Restored, String> {
    let (gone_mods, gone_setup) = missing_at(snap, mods, win64);
    let put = |list: &[PathBuf], from: &Path, to: &Path| -> Result<usize, String> {
        let mut n = 0;
        for rel in list.iter().filter(|r| !to.join(r).exists()) {
            let dest = to.join(rel);
            fs::create_dir_all(dest.parent().unwrap_or(to)).and_then(|_| fs::copy(from.join(rel), &dest))
                .map_err(|e| format!("Could not put back {}: {e}", rel.display()))?;
            n += 1;
        }
        Ok(n)
    };
    Ok(Restored { mods: put(&gone_mods, &snap.join("mods"), mods)?, setup: put(&gone_setup, &snap.join("win64"), win64)? })
}

/// Snapshot ids are folder names: digits only, so an id never reaches outside the snapshots folder.
fn snap_dir(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.bytes().all(|c| c.is_ascii_digit()) {
        return Err("Unknown snapshot".into());
    }
    Ok(root().join(id))
}

fn dirs_of(state: &State<'_, Arc<Mutex<crate::AppState>>>) -> Result<(PathBuf, PathBuf), String> {
    let mods = state.lock().unwrap().game_path.clone();
    let win64 = crate::xtra_setup::win64_dir(&mods).ok_or("Set the game mods path in Settings first")?;
    Ok((mods, win64))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn snapshot_list() -> Result<Vec<Snapshot>, String> {
    blocking(|| Ok(list_at(&root()))).await
}

/// The size a snapshot would be now: (files, bytes).
#[tauri::command]
pub async fn snapshot_estimate(state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<(usize, u64), String> {
    let (mods, win64) = dirs_of(&state)?;
    blocking(move || {
        let all: Vec<_> = files(&mods).into_iter().chain(setup_files(&win64)).collect();
        Ok((all.len(), all.iter().map(|f| f.1).sum()))
    }).await
}

#[tauri::command]
pub async fn snapshot_create(state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<Snapshot, String> {
    let _mutation = crate::xtra_mutation::edit()?; // no mod changes halfway through the copy
    let (mods, win64) = dirs_of(&state)?;
    let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs().to_string();
    blocking(move || create_at(&root(), &id, &mods, &win64)).await
}

/// How much of the newest snapshot is gone: (snapshot, mod files gone, Setup files gone). The startup check reads it.
#[tauri::command]
pub async fn snapshot_missing(state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<Option<(Snapshot, usize, usize)>, String> {
    let (mods, win64) = dirs_of(&state)?;
    blocking(move || {
        let Some(newest) = list_at(&root()).into_iter().next() else { return Ok(None) };
        let (m, s) = missing_at(&root().join(&newest.id), &mods, &win64);
        Ok(Some((newest, m.len(), s.len())))
    }).await
}

#[tauri::command]
pub async fn snapshot_restore(id: String, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<Restored, String> {
    let _mutation = crate::xtra_mutation::edit()?;
    crate::xtra_identity::upstream_guard()?;
    if crate::is_game_process_running() {
        return Err("Marvel Rivals is running. Close it first.".into());
    }
    let (mods, win64) = dirs_of(&state)?;
    let snap = snap_dir(&id)?;
    blocking(move || restore_at(&snap, &mods, &win64)).await
}

#[tauri::command]
pub async fn snapshot_delete(id: String) -> Result<(), String> {
    let dir = snap_dir(&id)?;
    blocking(move || fs::remove_dir_all(&dir).map_err(|e| format!("Could not delete the snapshot: {e}"))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(p: &Path, body: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    #[test]
    fn keys_ignore_priority_folder_and_off_state() {
        assert_eq!(mod_key(Path::new("A/Cool_9999999_P.pak")), "cool.pak");
        assert_eq!(mod_key(Path::new("Cool_P.bak_repak")), "cool.pak");
        assert_eq!(mod_key(Path::new("!Cool_99_P.utoc")), "cool.utoc");
        assert_eq!(setup_key(Path::new("dsound.dll.disabled")), "dsound.dll");
    }

    #[test]
    fn restore_puts_back_only_what_is_gone() {
        let t = tempfile::tempdir().unwrap();
        let (root, mods, win64) = (t.path().join("snaps"), t.path().join("mods"), t.path().join("win64"));
        put(&mods.join("Sub/Skin_P.pak"), "skin");
        put(&mods.join("Gone_P.pak"), "gone");
        put(&mods.join("Off_P.pak"), "off");
        put(&mods.join("Edited_P.pak"), "old");
        put(&win64.join("dsound.dll"), "loader");
        put(&win64.join("plugins/Bypass.asi"), "asi");
        let s = create_at(&root, "100", &mods, &win64).unwrap();
        assert_eq!((s.files, s.bytes), (6, 4 + 4 + 3 + 3 + 6 + 3));

        // a game update: one mod and the bypass gone; others renamed, switched off, or changed by the user since
        fs::remove_file(mods.join("Gone_P.pak")).unwrap();
        fs::remove_file(win64.join("plugins/Bypass.asi")).unwrap();
        fs::rename(mods.join("Sub/Skin_P.pak"), mods.join("Sub/Skin_9999999_P.pak")).unwrap();
        fs::rename(mods.join("Off_P.pak"), mods.join("Off_P.bak_repak")).unwrap();
        fs::write(mods.join("Edited_P.pak"), "new").unwrap();
        fs::rename(win64.join("dsound.dll"), win64.join("dsound.dll.disabled")).unwrap();

        assert_eq!(restore_at(&root.join("100"), &mods, &win64).unwrap(), Restored { mods: 1, setup: 1 });
        assert_eq!(fs::read_to_string(mods.join("Gone_P.pak")).unwrap(), "gone");
        assert_eq!(fs::read_to_string(win64.join("plugins/Bypass.asi")).unwrap(), "asi");
        assert!(!mods.join("Sub/Skin_P.pak").exists() && !mods.join("Off_P.pak").exists(), "renamed and off mods are not doubled");
        assert!(!win64.join("dsound.dll").exists(), "the loader stays off");
        assert_eq!(fs::read_to_string(mods.join("Edited_P.pak")).unwrap(), "new", "a changed file is never overwritten");
        assert_eq!(restore_at(&root.join("100"), &mods, &win64).unwrap(), Restored { mods: 0, setup: 0 }, "a second restore changes nothing");
    }

    #[test]
    fn keeps_the_newest_three() {
        let t = tempfile::tempdir().unwrap();
        let (root, mods, win64) = (t.path().join("snaps"), t.path().join("mods"), t.path().join("win64"));
        assert!(create_at(&root, "1", &mods, &win64).is_err(), "nothing to copy");
        put(&mods.join("A_P.pak"), "a");
        for id in ["1", "2", "3", "4"] {
            create_at(&root, id, &mods, &win64).unwrap();
        }
        assert_eq!(list_at(&root).iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["4", "3", "2"]);
        assert!(snap_dir("..\\x").is_err() && snap_dir("").is_err());
    }
}
