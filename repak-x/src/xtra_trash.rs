//! repakxtra: deleting a mod moves its files to a trash folder so the delete can be undone.
//! The trash lives in the app data dir, not under ~mods, because the game loads paks in
//! subfolders too. Each deletion gets its own folder trash\<id> (the frontend's id, or a fresh
//! one), so Undo restores exactly that deletion's files. Entries older than KEEP are purged on the
//! next delete; flat `<name>` + `<name>.from` pairs from older builds only expire.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const KEEP: Duration = Duration::from_secs(7 * 24 * 3600);

fn trash_dir() -> PathBuf {
    crate::app_dir().join("trash")
}

/// Trash ids become folder names: letters, digits, hyphens and underscores only.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn move_file(from: &Path, to: &Path) -> io::Result<()> {
    // rename fails across drives; copy + delete covers that
    if fs::rename(from, to).is_err() {
        if let Err(e) = fs::copy(from, to) {
            let _ = fs::remove_file(to); // a partial copy is not data: the original is still there
            return Err(e);
        }
        // the original is still in use: drop the copy, or it would sit in the trash forever with no record
        fs::remove_file(from).map_err(|e| {
            let _ = fs::remove_file(to);
            e
        })?;
    }
    Ok(())
}

/// Reserves the folder for one deletion (one delete_mod call). A supplied id that already exists
/// is an error before anything moves.
pub fn reserve(id: Option<String>) -> Result<PathBuf, String> {
    reserve_in(&trash_dir(), id)
}

fn reserve_in(root: &Path, id: Option<String>) -> Result<PathBuf, String> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    if let Some(id) = &id {
        if !valid_id(id) {
            return Err(format!("Invalid trash id: {id}"));
        }
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    purge_old(root);
    loop {
        let name = id.clone().unwrap_or_else(|| {
            let t = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
            format!("{t}-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
        });
        let dir = root.join(&name);
        match fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && id.is_none() => continue,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Err(format!("Trash id {name} is already used")),
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Drop-in replacement for fs::remove_file on mod files: moves `path` into the reserved folder.
pub fn discard(dir: &Path, path: &Path) -> io::Result<()> {
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?
        .to_string_lossy()
        .to_string();
    let to = dir.join(&name);
    let sidecar = dir.join(format!("{name}.from"));
    // The .from sidecar records where to restore to; written first, so trashed data always has one.
    // create_new: never overwrite a prior entry
    let mut record = fs::OpenOptions::new().write(true).create_new(true).open(&sidecar)?;
    if let Err(e) = io::Write::write_all(&mut record, path.to_string_lossy().as_bytes()) {
        drop(record);
        let _ = fs::remove_file(&sidecar);
        return Err(e);
    }
    drop(record);
    let moved = if to.exists() {
        Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} is already in the trash", to.display())))
    } else {
        move_file(path, &to)
    };
    if let Err(e) = moved {
        // An unused sidecar would block restoring the rest of this deletion
        if path.exists() && !to.exists() {
            let _ = fs::remove_file(&sidecar);
        }
        return Err(e);
    }
    Ok(())
}

/// Undoes one `discard`: moves the file back to `path` and drops its record. Used when a replacement that trashed the
/// old files fails before the new ones are in place.
pub fn put_back(dir: &Path, path: &Path) -> io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    move_file(&dir.join(&name), path)?;
    let _ = fs::remove_file(dir.join(format!("{name}.from")));
    Ok(())
}

/// Deleting a mods subfolder: every file in it (and in its subfolders) goes to the trash first, one deletion per folder
/// so files with the same name in two folders never collide, then the empty folders go. A file that cannot move stops it
/// before any folder is removed; what already moved can be restored from Recently deleted. Returns the deletions' ids, so
/// the frontend's Undo can put the whole folder back (restore recreates the folders the files came from).
pub fn discard_tree(folder: &Path) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    discard_tree_in(&trash_dir(), folder, &mut ids)?;
    fs::remove_dir_all(folder).map_err(|e| e.to_string())?;
    Ok(ids)
}

fn discard_tree_in(root: &Path, folder: &Path, ids: &mut Vec<String>) -> Result<(), String> {
    // file_type() does not follow links: a junction or symlink inside is never walked into (its target may be outside
    // ~mods); remove_dir_all later removes only the link itself
    let mut files = Vec::new();
    let mut subs = Vec::new();
    for e in fs::read_dir(folder).map_err(|e| e.to_string())?.flatten() {
        match e.file_type() {
            Ok(t) if t.is_file() => files.push(e.path()),
            Ok(t) if t.is_dir() => subs.push(e.path()),
            _ => {}
        }
    }
    if !files.is_empty() {
        let dir = reserve_in(root, None)?;
        ids.push(dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
        for f in &files {
            discard(&dir, f).map_err(|e| format!("{}: {e}", f.display()))?;
        }
    }
    for sub in &subs {
        discard_tree_in(root, sub, ids)?;
    }
    Ok(())
}

/// Removes a reserved folder that ended up holding nothing (the delete failed or found no files).
pub fn release_if_empty(dir: &Path) {
    let _ = fs::remove_dir(dir); // only succeeds when empty
}

fn expired(path: &Path) -> bool {
    fs::metadata(path).and_then(|m| m.modified()).ok().map_or(false, too_old)
}

fn too_old(t: SystemTime) -> bool {
    SystemTime::now().duration_since(t).map_or(false, |age| age > KEEP)
}

/// When a deletion happened: its oldest .from record (written as the files moved, and kept by a rename into a folder),
/// else the folder's own time.
fn deleted_at(dir: &Path) -> Option<SystemTime> {
    let records = fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.extension().map_or(false, |x| x == "from"));
    records.filter_map(|p| fs::metadata(p).and_then(|m| m.modified()).ok()).min()
        .or_else(|| fs::metadata(dir).and_then(|m| m.modified()).ok())
}

fn purge_old(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if deleted_at(&path).map_or(false, too_old) {
                let _ = fs::remove_dir_all(&path);
            }
        } else if path.extension().map_or(false, |x| x == "from") && expired(&path) {
            // legacy flat pair from builds before per-deletion folders
            let _ = fs::remove_file(path.with_extension(""));
            let _ = fs::remove_file(&path);
        }
    }
}

/// One deletion in the trash, for Settings > Recently deleted: its id, where its files were (the .pak first, for the
/// mod's name), their total size, and when it was deleted (seconds since 1970; it is purged KEEP later).
#[derive(serde::Serialize, Debug)]
pub struct TrashedMod {
    id: String,
    paths: Vec<String>,
    size: u64,
    deleted: u64,
    expires: u64,
}

/// Every deletion still in the trash, newest first (expired ones go first, as on the next delete).
#[tauri::command]
pub fn list_trashed_mods() -> Vec<TrashedMod> {
    let root = trash_dir();
    purge_old(&root);
    adopt_flat(&root);
    list_in(&root)
}

/// A mod's files share this: its name without the pak, container and on/off extensions.
fn mod_stem(name: &str) -> String {
    let mut s = name.to_string();
    while let Some(x) = [".bak_repak", ".pak_disabled", ".pak", ".utoc", ".ucas", ".sig"].iter().find(|x| s.to_lowercase().ends_with(*x)) {
        s.truncate(s.len() - x.len());
    }
    s
}

/// Flat `<name>` + `<name>.from` pairs from older builds move into one folder per mod, so they list, restore and empty
/// like every other deletion. The rename keeps each record's time, so they still expire 7 days after their delete.
fn adopt_flat(root: &Path) {
    let mut by_mod: std::collections::BTreeMap<String, Vec<PathBuf>> = Default::default();
    for e in fs::read_dir(root).into_iter().flatten().flatten() {
        let sidecar = e.path();
        if sidecar.is_file() && sidecar.extension().map_or(false, |x| x == "from") && sidecar.with_extension("").is_file() {
            let name = sidecar.with_extension("").file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            by_mod.entry(mod_stem(&name)).or_default().push(sidecar);
        }
    }
    for (_, sidecars) in by_mod {
        let Ok(dir) = reserve_in(root, None) else { continue };
        for sidecar in sidecars {
            let trashed = sidecar.with_extension("");
            let (Some(t), Some(s)) = (trashed.file_name(), sidecar.file_name()) else { continue };
            // the data first: a record never points at data that stayed behind
            if fs::rename(&trashed, dir.join(t)).is_ok() && fs::rename(&sidecar, dir.join(s)).is_err() {
                let _ = fs::rename(dir.join(t), &trashed); // put it back beside its record
            }
        }
        release_if_empty(&dir);
    }
}

fn list_in(root: &Path) -> Vec<TrashedMod> {
    let secs = |t: SystemTime| t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let mut out: Vec<TrashedMod> = fs::read_dir(root).into_iter().flatten().flatten().filter_map(|e| {
        let dir = e.path();
        let id = dir.file_name()?.to_string_lossy().to_string();
        if !dir.is_dir() || !valid_id(&id) {
            return None;
        }
        let mut paths = Vec::new();
        let mut size = 0;
        for f in fs::read_dir(&dir).ok()?.flatten() {
            let sidecar = f.path();
            if sidecar.extension().map_or(true, |x| x != "from") {
                continue;
            }
            let Ok(original) = fs::read_to_string(&sidecar) else { continue };
            size += fs::metadata(sidecar.with_extension("")).map_or(0, |m| m.len());
            paths.push(original);
        }
        if paths.is_empty() {
            return None;
        }
        // the .pak first (or a switched-off mod's .bak_repak / .pak_disabled): the mod is named after it
        let pak = |p: &str| [".pak", ".bak_repak", ".pak_disabled"].iter().any(|x| p.to_lowercase().ends_with(x));
        paths.sort_by_key(|p| (!pak(p), p.clone()));
        let deleted = deleted_at(&dir).map_or(0, secs);
        Some(TrashedMod { id, paths, size, deleted, expires: deleted + KEEP.as_secs() })
    }).collect();
    out.sort_by(|a, b| b.deleted.cmp(&a.deleted));
    out
}

/// Deletes the given deletions from the trash for good (they cannot be restored after this).
#[tauri::command]
pub fn empty_trashed_mods(ids: Vec<String>) -> Result<usize, String> {
    empty_in(&trash_dir(), &ids)
}

fn empty_in(root: &Path, ids: &[String]) -> Result<usize, String> {
    if let Some(bad) = ids.iter().find(|id| !valid_id(id)) {
        return Err(format!("Invalid trash id: {bad}"));
    }
    let mut gone = 0;
    let mut errors = Vec::new();
    for id in ids {
        match fs::remove_dir_all(root.join(id)) {
            Ok(()) => gone += 1,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => errors.push(format!("{id}: {e}")),
        }
    }
    if errors.is_empty() { Ok(gone) } else { Err(format!("Could not delete {}", errors.join("; "))) }
}

/// Puts back every file of the given deletions (ids from delete_mod), each where it was deleted from. Not while Repak X
/// is open, nor while the game runs (unless Settings bypasses that lock, as for every other mod change).
#[tauri::command]
pub async fn restore_trashed_mods(ids: Vec<String>, state: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::AppState>>>) -> Result<usize, String> {
    crate::xtra_identity::upstream_guard()?; // Undo moves files back into the mods folder: not while Repak X is open
    let bypass = state.lock().map(|s| s.bypass_game_running_lock).unwrap_or(false);
    if !bypass && crate::is_game_process_running() {
        return Err("Marvel Rivals is running. Close it first, then restore.".into());
    }
    restore_from(&trash_dir(), &ids)
}

fn restore_from(root: &Path, ids: &[String]) -> Result<usize, String> {
    if let Some(bad) = ids.iter().find(|id| !valid_id(id)) {
        return Err(format!("Invalid trash id: {bad}"));
    }
    let mut restored = 0;
    let mut errors = Vec::new();
    for id in ids {
        let dir = root.join(id);
        // Read every record of this deletion before moving anything
        let mut records: Vec<(PathBuf, PathBuf, PathBuf)> = Vec::new(); // (sidecar, trashed, original)
        let mut problem = None;
        match fs::read_dir(&dir) {
            Err(e) => problem = Some(format!("trash {id}: {e}")),
            Ok(entries) => {
                for entry in entries.flatten() {
                    let sidecar = entry.path();
                    if sidecar.extension().map_or(true, |x| x != "from") {
                        continue;
                    }
                    let trashed = sidecar.with_extension("");
                    match fs::read_to_string(&sidecar) {
                        Ok(p) if trashed.is_file() => records.push((sidecar, trashed, PathBuf::from(p))),
                        Ok(_) => problem = Some(format!("{} is missing from the trash", trashed.display())),
                        Err(e) => problem = Some(format!("{}: {e}", sidecar.display())),
                    }
                    if problem.is_some() {
                        break;
                    }
                }
            }
        }
        if problem.is_none() {
            if let Some((_, _, original)) = records.iter().find(|(_, _, o)| o.exists()) {
                problem = Some(format!("{} already exists, left the trashed copy alone", original.display()));
            }
        }
        if let Some(p) = problem {
            errors.push(p);
            continue;
        }
        for (sidecar, trashed, original) in records {
            if let Some(parent) = original.parent() {
                let _ = fs::create_dir_all(parent); // its folder may have been deleted since
            }
            match move_file(&trashed, &original) {
                Ok(()) => {
                    let _ = fs::remove_file(&sidecar);
                    restored += 1;
                }
                Err(e) => errors.push(format!("{}: {e}", original.display())),
            }
        }
        release_if_empty(&dir);
    }
    if errors.is_empty() {
        Ok(restored)
    } else {
        Err(format!("Restored {restored} file(s); failed: {}", errors.join("; ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique temp root per test: (mods folder, trash root)
    fn roots(test: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("repakx-trash-{test}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("mods")).unwrap();
        (base.join("mods"), base.join("trash"), base)
    }

    fn put(p: &Path, data: &[u8]) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, data).unwrap();
    }

    #[test]
    fn older_flat_deletions_list_as_one_mod_each() {
        let (mods, root, base) = roots("adopt");
        fs::create_dir_all(&root).unwrap();
        for f in ["Old_9999999_P.bak_repak", "Old_9999999_P.ucas", "Old_9999999_P.utoc", "Other.pak"] {
            put(&root.join(f), b"abc");
            put(&root.join(format!("{f}.from")), mods.join(f).to_string_lossy().as_bytes());
        }
        put(&root.join("Stray.pak"), b"x"); // data without a record is left alone
        let when = fs::metadata(root.join("Old_9999999_P.ucas.from")).unwrap().modified().unwrap();
        adopt_flat(&root);
        let list = list_in(&root);
        assert_eq!(list.len(), 2, "{list:?}");
        let old = list.iter().find(|t| t.paths.len() == 3).expect("the three files of Old are one deletion");
        assert!(old.paths[0].ends_with("Old_9999999_P.bak_repak"), "{:?}", old.paths);
        assert_eq!(old.size, 9);
        let secs = when.duration_since(UNIX_EPOCH).unwrap().as_secs();
        assert!(old.deleted.abs_diff(secs) <= 2, "the deletion keeps its time");
        assert!(root.join("Stray.pak").exists() && !root.join("Old_9999999_P.ucas").exists());
        assert_eq!(mod_stem("A.b_9999999_P.pak.bak_repak"), "A.b_9999999_P");
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn folder_delete_trashes_every_file_and_restores() {
        let (mods, root, base) = roots("tree");
        put(&mods.join("Hulk/A_9999999_P.pak"), b"1");
        put(&mods.join("Hulk/Old/A_9999999_P.pak"), b"22"); // same name in a subfolder
        let mut ids = Vec::new();
        discard_tree_in(&root, &mods.join("Hulk"), &mut ids).unwrap();
        fs::remove_dir_all(mods.join("Hulk")).unwrap();
        let list = list_in(&root);
        assert_eq!(list.len(), 2, "one deletion per folder: {list:?}");
        assert_eq!(ids.len(), 2, "every deletion's id comes back for Undo");
        restore_from(&root, &ids).unwrap();
        assert_eq!(fs::read(mods.join("Hulk/Old/A_9999999_P.pak")).unwrap(), b"22", "restored into the folder it was deleted from");
        assert!(mods.join("Hulk/A_9999999_P.pak").exists());
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(windows)]
    #[test]
    fn folder_delete_never_follows_a_junction() {
        let (mods, root, base) = roots("junction");
        put(&base.join("outside/Keep.pak"), b"k");
        put(&mods.join("Hulk/A.pak"), b"a");
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(mods.join("Hulk").join("link")).arg(base.join("outside")).output().unwrap();
        assert!(made.status.success(), "mklink /J failed");
        discard_tree_in(&root, &mods.join("Hulk"), &mut Vec::new()).unwrap();
        fs::remove_dir_all(mods.join("Hulk")).unwrap();
        assert!(base.join("outside/Keep.pak").exists(), "the junction's target is outside the folder and stays");
        assert_eq!(list_in(&root).len(), 1);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn lists_and_empties_deletions() {
        let (mods, root, base) = roots("list");
        let a = reserve_in(&root, Some("a".into())).unwrap();
        put(&mods.join("Skin_9999999_P.utoc"), b"12345");
        put(&mods.join("Skin_9999999_P.pak"), b"12");
        discard(&a, &mods.join("Skin_9999999_P.utoc")).unwrap();
        discard(&a, &mods.join("Skin_9999999_P.pak")).unwrap();
        let empty = reserve_in(&root, Some("empty".into())).unwrap(); // a reserved folder with nothing in it is not listed
        let list = list_in(&root);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "a");
        assert!(list[0].paths[0].ends_with("Skin_9999999_P.pak"), "the .pak first: {:?}", list[0].paths);
        assert_eq!((list[0].paths.len(), list[0].size), (2, 7));
        assert_eq!(list[0].expires - list[0].deleted, KEEP.as_secs());
        assert!(empty_in(&root, &["../x".into()]).is_err(), "ids never leave the trash");
        assert_eq!(empty_in(&root, &["a".into(), "gone".into()]).unwrap(), 1);
        assert!(!a.exists() && list_in(&root).is_empty());
        let _ = fs::remove_dir(empty);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn discard_then_restore_round_trip() {
        let (mods, trash, base) = roots("roundtrip");
        let pak = mods.join("M_9999999_P.bak_repak");
        let ucas = mods.join("M_9999999_P.ucas");
        let other = mods.join("Other_9999999_P.pak");
        for f in [&pak, &ucas, &other] {
            put(f, b"x");
        }
        let a = reserve_in(&trash, Some("a".into())).unwrap();
        discard(&a, &pak).unwrap();
        discard(&a, &ucas).unwrap();
        let b = reserve_in(&trash, Some("b".into())).unwrap();
        discard(&b, &other).unwrap();
        assert!(!pak.exists() && !ucas.exists() && !other.exists());

        assert_eq!(restore_from(&trash, &["a".into()]).unwrap(), 2);
        assert!(pak.exists() && ucas.exists() && !other.exists());
        assert!(!a.exists(), "emptied id folder is removed");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn same_name_in_two_folders_restores_to_its_own_folder() {
        let (mods, trash, base) = roots("twofolders");
        let in_a = mods.join("A").join("X_9999999_P.pak");
        let in_b = mods.join("B").join("X_9999999_P.pak");
        put(&in_a, b"a");
        put(&in_b, b"b");
        let one = reserve_in(&trash, Some("one".into())).unwrap();
        discard(&one, &in_a).unwrap();
        let two = reserve_in(&trash, Some("two".into())).unwrap();
        discard(&two, &in_b).unwrap();

        assert_eq!(restore_from(&trash, &["one".into()]).unwrap(), 1);
        assert_eq!(fs::read(&in_a).unwrap(), b"a");
        assert!(!in_b.exists() && two.join("X_9999999_P.pak").exists(), "B's copy stays trashed");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn same_path_deleted_twice_keeps_the_second_copy() {
        let (mods, trash, base) = roots("twice");
        let pak = mods.join("M_9999999_P.pak");
        put(&pak, b"first");
        let one = reserve_in(&trash, Some("one".into())).unwrap();
        discard(&one, &pak).unwrap();
        put(&pak, b"second");
        let two = reserve_in(&trash, Some("two".into())).unwrap();
        discard(&two, &pak).unwrap();

        assert_eq!(restore_from(&trash, &["one".into()]).unwrap(), 1);
        assert_eq!(fs::read(&pak).unwrap(), b"first");
        let err = restore_from(&trash, &["two".into()]).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(fs::read(two.join("M_9999999_P.pak")).unwrap(), b"second");
        assert!(two.join("M_9999999_P.pak.from").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn reused_and_path_like_ids_are_rejected() {
        let (_, trash, base) = roots("ids");
        reserve_in(&trash, Some("x".into())).unwrap();
        assert!(reserve_in(&trash, Some("x".into())).is_err(), "reused id");
        for bad in ["", "..", "a/b", "a\\b", "C:", "a.b", "é"] {
            assert!(reserve_in(&trash, Some(bad.into())).is_err(), "reserve {bad:?}");
            assert!(restore_from(&trash, &[bad.into()]).is_err(), "restore {bad:?}");
        }
        // the whole list is checked before any I/O
        assert!(restore_from(&trash, &["x".into(), "../x".into()]).unwrap_err().contains("Invalid"));
        assert!(trash.join("x").exists());
        // without an id each call gets a fresh folder
        let a = reserve_in(&trash, None).unwrap();
        let b = reserve_in(&trash, None).unwrap();
        assert_ne!(a, b);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn sidecar_write_failure_leaves_the_source() {
        let (mods, trash, base) = roots("sidecar");
        let pak = mods.join("M_9999999_P.pak");
        put(&pak, b"x");
        let dir = reserve_in(&trash, Some("s".into())).unwrap();
        fs::create_dir(dir.join("M_9999999_P.pak.from")).unwrap(); // a directory where the sidecar goes
        assert!(discard(&dir, &pak).is_err());
        assert_eq!(fs::read(&pak).unwrap(), b"x");
        assert!(!dir.join("M_9999999_P.pak").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn move_failure_leaves_no_orphan_sidecar() {
        use std::os::windows::fs::OpenOptionsExt;
        let (mods, trash, base) = roots("movefail");
        let pak = mods.join("M_9999999_P.pak");
        let ucas = mods.join("M_9999999_P.ucas");
        put(&pak, b"p");
        put(&ucas, b"u");
        let dir = reserve_in(&trash, Some("m".into())).unwrap();
        discard(&dir, &pak).unwrap();
        {
            // no sharing: rename and copy both fail while this handle is open
            let _lock = fs::OpenOptions::new().read(true).share_mode(0).open(&ucas).unwrap();
            assert!(discard(&dir, &ucas).is_err());
        }
        assert!(ucas.exists() && !dir.join("M_9999999_P.ucas.from").exists());
        fs::remove_file(&ucas).unwrap(); // the user deals with the stuck file; the trashed pak still restores
        assert_eq!(restore_from(&trash, &["m".into()]).unwrap(), 1);
        assert_eq!(fs::read(&pak).unwrap(), b"p");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn purge_expires_old_id_folders_and_flat_pairs() {
        let (_, trash, base) = roots("purge");
        let old = trash.join("old");
        put(&old.join("M.pak"), b"x");
        put(&trash.join("Flat.pak"), b"x");
        put(&trash.join("Flat.pak.from"), b"C:/x/Flat.pak");
        put(&trash.join("Fresh.pak"), b"x");
        put(&trash.join("Fresh.pak.from"), b"C:/x/Fresh.pak");
        let past = SystemTime::now() - KEEP - Duration::from_secs(60);
        for p in [&old, &trash.join("Flat.pak.from")] {
            let mut o = fs::OpenOptions::new();
            o.write(true);
            #[cfg(windows)]
            std::os::windows::fs::OpenOptionsExt::custom_flags(&mut o, 0x0200_0000); // FILE_FLAG_BACKUP_SEMANTICS opens folders
            o.open(p).unwrap().set_modified(past).unwrap();
        }
        purge_old(&trash);
        assert!(!old.exists() && !trash.join("Flat.pak").exists() && !trash.join("Flat.pak.from").exists());
        assert!(trash.join("Fresh.pak").exists() && trash.join("Fresh.pak.from").exists());
        let _ = fs::remove_dir_all(&base);
    }
}
