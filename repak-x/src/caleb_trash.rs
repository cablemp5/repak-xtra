//! caleb fork: deleting a mod moves its files to a trash folder so the delete can be undone.
//! The trash lives in the app data dir, not under ~mods, because the game loads paks in
//! subfolders too. Entries older than KEEP are purged on the next delete.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const KEEP: Duration = Duration::from_secs(7 * 24 * 3600);

fn trash_dir() -> PathBuf {
    crate::app_dir().join("trash")
}

/// Stem shared by all files of one mod (.pak, .bak_repak, .pak.bak_repak, .pak_disabled, .ucas, .utoc).
fn mod_stem(name: &str) -> &str {
    let mut s = name;
    for ext in [".bak_repak", ".pak_disabled", ".pak", ".ucas", ".utoc"] {
        if let Some(t) = s.strip_suffix(ext) {
            s = t;
        }
    }
    s
}

fn move_file(from: &Path, to: &Path) -> io::Result<()> {
    // rename fails across drives; copy + delete covers that
    if fs::rename(from, to).is_err() {
        fs::copy(from, to)?;
        // the original is still in use: drop the copy, or it would sit in the trash forever with no record
        fs::remove_file(from).map_err(|e| {
            let _ = fs::remove_file(to);
            e
        })?;
    }
    Ok(())
}

/// Drop-in replacement for fs::remove_file on mod files.
pub fn discard(path: &Path) -> io::Result<()> {
    discard_to(&trash_dir(), path)
}

fn discard_to(dir: &Path, path: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    purge_old(dir);
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?
        .to_string_lossy()
        .to_string();
    move_file(path, &dir.join(&name))?;
    // The .from sidecar records where to restore to; its mtime is the delete time
    fs::write(dir.join(format!("{name}.from")), path.to_string_lossy().as_bytes())
}

fn purge_old(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let sidecar = entry.path();
        if sidecar.extension().map_or(true, |x| x != "from") {
            continue;
        }
        let expired = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .map_or(false, |age| age > KEEP);
        if expired {
            let _ = fs::remove_file(sidecar.with_extension(""));
            let _ = fs::remove_file(&sidecar);
        }
    }
}

/// Puts every trashed file of the given mods back where it was deleted from.
#[tauri::command]
pub async fn restore_trashed_mods(paths: Vec<String>) -> Result<usize, String> {
    restore_from(&trash_dir(), &paths)
}

fn restore_from(dir: &Path, paths: &[String]) -> Result<usize, String> {
    let stems: Vec<String> = paths
        .iter()
        .filter_map(|p| Path::new(p).file_name())
        .map(|n| mod_stem(&n.to_string_lossy()).to_string())
        .collect();
    let mut restored = 0;
    let mut errors = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let sidecar = entry.path();
        if sidecar.extension().map_or(true, |x| x != "from") {
            continue;
        }
        let trashed = sidecar.with_extension("");
        let name = trashed.file_name().unwrap_or_default().to_string_lossy().to_string();
        if !stems.iter().any(|s| s == mod_stem(&name)) {
            continue;
        }
        let original = match fs::read_to_string(&sidecar) {
            Ok(p) => PathBuf::from(p),
            Err(e) => {
                errors.push(format!("{name}: {e}"));
                continue;
            }
        };
        if original.exists() {
            errors.push(format!("{} already exists, left the trashed copy alone", original.display()));
            continue;
        }
        match move_file(&trashed, &original) {
            Ok(()) => {
                let _ = fs::remove_file(&sidecar);
                restored += 1;
            }
            Err(e) => errors.push(format!("{name}: {e}")),
        }
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

    #[test]
    fn stems_match_across_mod_files() {
        for n in ["A_9999999_P.pak", "A_9999999_P.bak_repak", "A_9999999_P.pak.bak_repak", "A_9999999_P.pak_disabled", "A_9999999_P.ucas", "A_9999999_P.utoc"] {
            assert_eq!(mod_stem(n), "A_9999999_P", "{n}");
        }
    }

    #[test]
    fn discard_then_restore_round_trip() {
        let base = std::env::temp_dir().join(format!("repakx-trash-test-{}", std::process::id()));
        let mods = base.join("mods");
        let trash = base.join("trash");
        fs::create_dir_all(&mods).unwrap();
        let pak = mods.join("M_9999999_P.bak_repak");
        let ucas = mods.join("M_9999999_P.ucas");
        let other = mods.join("Other_9999999_P.pak");
        for f in [&pak, &ucas, &other] {
            fs::write(f, b"x").unwrap();
        }
        discard_to(&trash, &pak).unwrap();
        discard_to(&trash, &ucas).unwrap();
        discard_to(&trash, &other).unwrap();
        assert!(!pak.exists() && !ucas.exists());

        let n = restore_from(&trash, &[pak.to_string_lossy().to_string()]).unwrap();
        assert_eq!(n, 2);
        assert!(pak.exists() && ucas.exists() && !other.exists());
        let _ = fs::remove_dir_all(&base);
    }
}
