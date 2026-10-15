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

/// Removes a reserved folder that ended up holding nothing (the delete failed or found no files).
pub fn release_if_empty(dir: &Path) {
    let _ = fs::remove_dir(dir); // only succeeds when empty
}

fn expired(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .map_or(false, |age| age > KEEP)
}

fn purge_old(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if expired(&path) {
                let _ = fs::remove_dir_all(&path);
            }
        } else if path.extension().map_or(false, |x| x == "from") && expired(&path) {
            // legacy flat pair from builds before per-deletion folders
            let _ = fs::remove_file(path.with_extension(""));
            let _ = fs::remove_file(&path);
        }
    }
}

/// Puts back every file of the given deletions (ids from delete_mod), each where it was deleted from.
#[tauri::command]
pub async fn restore_trashed_mods(ids: Vec<String>) -> Result<usize, String> {
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
