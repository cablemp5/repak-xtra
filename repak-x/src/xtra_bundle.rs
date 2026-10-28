//! repakxtra: one place that knows a mod's files (the .pak, or its off copy, plus .utoc/.ucas) and moves them as a set.
//! Earlier code built companion names with `with_extension("")` then `with_extension("ucas")`, which drops two
//! extensions: "Skin.v2_9999999_P.pak" looked for "Skin.ucas". `companion` replaces only the final suffix.
//! `move_all` renames a whole set, refuses to replace anything, and puts every file back if one rename fails.

use std::fs;
use std::path::{Path, PathBuf};

/// Final suffixes a mod file can carry, longest first so ".pak.bak_repak" wins over ".bak_repak".
const SUFFIXES: [&str; 6] = [".pak.bak_repak", ".bak_repak", ".pak_disabled", ".pak", ".utoc", ".ucas"];

/// "Skin.v2_9999999_P.pak" -> "Skin.v2_9999999_P" (also the off and container names, any case). Earlier dots stay.
pub fn stem(file_name: &str) -> &str {
    let lower = file_name.to_ascii_lowercase();
    SUFFIXES
        .iter()
        .find(|s| lower.ends_with(*s))
        .map_or(file_name, |s| &file_name[..file_name.len() - s.len()])
}

/// The `ext` ("utoc" or "ucas") file that belongs with `pak` (an on, off or container path), whether or not it exists.
pub fn companion(pak: &Path, ext: &str) -> PathBuf {
    let name = pak.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    pak.with_file_name(format!("{}.{}", stem(name), ext))
}

/// The .utoc and .ucas next to `pak` that exist.
pub fn existing_companions(pak: &Path) -> Vec<PathBuf> {
    ["utoc", "ucas"].iter().map(|e| companion(pak, e)).filter(|p| p.is_file()).collect()
}

/// Two paths name the same file on Windows (case and trailing dots or spaces do not count).
fn same_name(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().trim_end_matches(['.', ' ']).to_lowercase();
    norm(a) == norm(b)
}

/// Renames every `(from, to)` pair, or none: a `to` that already exists (and is not its own `from` in another case)
/// stops the whole move before anything changes, and a failed rename undoes the ones before it. Returns an error
/// naming the file when it stops; if undoing also fails, the error says which files are where.
pub fn move_all(moves: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    for (from, to) in moves {
        if !from.exists() {
            return Err(format!("{} is missing", from.display()));
        }
        if to.exists() && !same_name(from, to) {
            return Err(format!("{} already exists", to.display()));
        }
    }
    let mut done: Vec<&(PathBuf, PathBuf)> = Vec::new();
    for pair in moves {
        if let Err(e) = fs::rename(&pair.0, &pair.1) {
            let mut stuck = Vec::new();
            for (from, to) in done.iter().rev() {
                if fs::rename(to, from).is_err() {
                    stuck.push(format!("{} (should be {})", to.display(), from.display()));
                }
            }
            let mut msg = format!("Could not rename {}: {}", pair.0.display(), e);
            if !stuck.is_empty() {
                msg.push_str(&format!(". These files could not be put back: {}", stuck.join(", ")));
            }
            return Err(msg);
        }
        done.push(pair);
    }
    Ok(())
}

/// Puts each new file (`staged` -> `dest`) in place as one step. Files already at a `dest` go to Recently deleted first
/// (returned: that deletion's trash id), so a replaced mod can be restored. If anything fails, the old files are put
/// back and the staged files stay where they were.
pub fn replace_all(moves: &[(PathBuf, PathBuf)]) -> Result<Option<String>, String> {
    replace_all_retiring(moves, &[])
}

/// `replace_all`, also moving `retire` (other files of the replaced mod, such as its off copy or another priority's
/// name) to the same Recently deleted entry.
pub fn replace_all_retiring(moves: &[(PathBuf, PathBuf)], retire: &[PathBuf]) -> Result<Option<String>, String> {
    let mut old: Vec<&PathBuf> = moves.iter().map(|(_, d)| d).filter(|d| d.exists()).collect();
    for r in retire {
        if r.exists() && !old.iter().any(|o| same_name(o, r)) {
            old.push(r);
        }
    }
    if old.is_empty() {
        return move_all(moves).map(|_| None);
    }
    replace_with(moves, &old, &crate::xtra_trash::reserve(None)?)
}

fn replace_with(moves: &[(PathBuf, PathBuf)], old: &[&PathBuf], dir: &Path) -> Result<Option<String>, String> {
    let put_back = |done: &[&PathBuf]| {
        for d in done.iter().rev() {
            let _ = crate::xtra_trash::put_back(dir, d);
        }
        crate::xtra_trash::release_if_empty(dir);
    };
    for (i, d) in old.iter().enumerate() {
        if let Err(e) = crate::xtra_trash::discard(dir, d) {
            put_back(&old[..i]);
            return Err(format!("Could not move the old {} aside: {}", d.display(), e));
        }
    }
    if let Err(e) = move_all(moves) {
        put_back(old);
        return Err(e);
    }
    Ok(dir.file_name().map(|n| n.to_string_lossy().to_string()))
}

/// A new private folder inside `parent` for files that are not ready yet (same drive, so moving them in is a rename).
/// Its name starts with a dot and `sweep_staging` removes leftovers from a run that was closed midway.
pub fn staging_dir(parent: &Path, tag: &str) -> Result<PathBuf, String> {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let dir = parent.join(format!(".repakxtra-{}-{}-{}", tag, std::process::id(), t));
    fs::create_dir(&dir).map_err(|e| format!("Could not create {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// For WalkDir::filter_entry over the mods folder: skips staging folders, so a half-built install never lists as a mod.
pub fn not_staging(e: &walkdir::DirEntry) -> bool {
    !(e.file_type().is_dir() && e.file_name().to_string_lossy().starts_with(".repakxtra-"))
}

/// Removes staging folders a closed or crashed run left under `mods` (one level of subfolders deep), so the game
/// never loads a half-built copy. Only names `staging_dir` makes are touched; the replaced files are in the trash.
pub fn sweep_staging(mods: &Path) {
    let is_staging = |n: &str| ["installing", "incoming", "encrypt"].iter().any(|t| n.starts_with(&format!(".repakxtra-{}-", t)));
    let mut dirs = vec![mods.to_path_buf()];
    while let Some(d) = dirs.pop() {
        for e in fs::read_dir(&d).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let Ok(meta) = fs::symlink_metadata(e.path()) else { continue };
            if !meta.is_dir() || meta.file_type().is_symlink() { continue; }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 { continue; } // no junction traversal
            }
            if is_staging(&name) {
                let _ = fs::remove_dir_all(e.path());
            } else if !name.starts_with(".repakxtra-") {
                dirs.push(e.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abandoned_encryption_stays_off_and_is_swept_without_touching_originals() {
        let d = tempfile::tempdir().unwrap();
        let original = d.path().join("Skin.bak_repak");
        fs::write(&original, b"original").unwrap();
        let nested = d.path().join("collection").join("hero");
        fs::create_dir_all(&nested).unwrap();
        let stage = staging_dir(&nested, "encrypt").unwrap();
        fs::write(stage.join("Skin.bak_repak"), b"encrypted").unwrap();
        fs::write(stage.join("Skin.utoc"), b"toc").unwrap();
        fs::write(stage.join("Skin.ucas"), b"cas").unwrap();
        assert!(!stage.join("Skin.pak").exists());
        sweep_staging(d.path());
        assert!(!stage.exists());
        assert_eq!(fs::read(original).unwrap(), b"original");
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("repakxtra-bundle-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn companion_keeps_earlier_dots() {
        let p = Path::new("C:/m/Skin.v2_9999999_P.pak");
        assert_eq!(companion(p, "ucas"), Path::new("C:/m/Skin.v2_9999999_P.ucas"));
        assert_eq!(companion(Path::new("C:/m/Name.v2.bak_repak"), "utoc"), Path::new("C:/m/Name.v2.utoc"));
        assert_eq!(companion(Path::new("C:/m/Name.pak.bak_repak"), "utoc"), Path::new("C:/m/Name.utoc"));
        assert_eq!(companion(Path::new("C:/m/Name.PAK"), "utoc"), Path::new("C:/m/Name.utoc"));
        assert_eq!(companion(Path::new("C:/m/Plain.pak"), "ucas"), Path::new("C:/m/Plain.ucas"));
    }

    #[test]
    fn unrelated_short_name_is_never_picked() {
        let d = tmp("sentinel");
        fs::write(d.join("Name.v2.pak"), b"p").unwrap();
        fs::write(d.join("Name.ucas"), b"unrelated").unwrap();
        assert!(existing_companions(&d.join("Name.v2.pak")).is_empty());
        fs::write(d.join("Name.v2.ucas"), b"c").unwrap();
        assert_eq!(existing_companions(&d.join("Name.v2.pak")), vec![d.join("Name.v2.ucas")]);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn move_all_refuses_a_taken_name_and_changes_nothing() {
        let d = tmp("taken");
        for n in ["A_9999999_P.pak", "A_9999999_P.ucas", "A_99999999_P.ucas"] {
            fs::write(d.join(n), n).unwrap();
        }
        let moves = vec![
            (d.join("A_9999999_P.pak"), d.join("A_99999999_P.pak")),
            (d.join("A_9999999_P.ucas"), d.join("A_99999999_P.ucas")),
        ];
        assert!(move_all(&moves).is_err());
        assert!(d.join("A_9999999_P.pak").exists() && !d.join("A_99999999_P.pak").exists());
        assert_eq!(fs::read(d.join("A_99999999_P.ucas")).unwrap(), b"A_99999999_P.ucas");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn replace_keeps_the_old_files_in_the_trash_and_puts_them_back_on_failure() {
        let d = tmp("replace");
        let trash = d.join("trash");
        fs::create_dir_all(&trash).unwrap();
        fs::create_dir_all(d.join("stage")).unwrap();
        fs::write(d.join("M.pak"), b"old").unwrap();
        fs::write(d.join("stage").join("M.pak.part"), b"new").unwrap();
        fs::write(d.join("stage").join("M.utoc.part"), b"new").unwrap();
        let moves = vec![
            (d.join("stage").join("M.pak.part"), d.join("M.pak")),
            (d.join("stage").join("M.utoc.part"), d.join("M.utoc")),
        ];
        let old = [&d.join("M.pak")];
        assert!(replace_with(&moves, &old, &trash).is_ok());
        assert_eq!(fs::read(d.join("M.pak")).unwrap(), b"new");
        assert_eq!(fs::read(trash.join("M.pak")).unwrap(), b"old");

        // a failing move (the folder for the second file is missing) leaves the old file installed
        let trash2 = d.join("trash2");
        fs::create_dir_all(&trash2).unwrap();
        fs::write(d.join("stage").join("M.pak.part"), b"newer").unwrap();
        let bad = vec![
            (d.join("stage").join("M.pak.part"), d.join("M.pak")),
            (d.join("stage").join("gone.part"), d.join("M.ucas")),
        ];
        assert!(replace_with(&bad, &[&d.join("M.pak")], &trash2).is_err());
        assert_eq!(fs::read(d.join("M.pak")).unwrap(), b"new");
        assert!(d.join("stage").join("M.pak.part").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn move_all_undoes_earlier_renames_when_one_fails() {
        let d = tmp("undo");
        fs::write(d.join("B.pak"), b"p").unwrap();
        fs::write(d.join("B.utoc"), b"t").unwrap();
        // the second target sits in a folder that does not exist, so that rename fails after the first succeeded
        let moves = vec![(d.join("B.pak"), d.join("C.pak")), (d.join("B.utoc"), d.join("nope").join("C.utoc"))];
        assert!(move_all(&moves).is_err());
        assert!(d.join("B.pak").exists() && d.join("B.utoc").exists() && !d.join("C.pak").exists());
        let _ = fs::remove_dir_all(&d);
    }
}
