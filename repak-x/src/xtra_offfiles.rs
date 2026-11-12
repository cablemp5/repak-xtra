//! repakxtra: .pak.off, .utoc.off and .ucas.off files (the off state RivalsFPS gives a mod, and how people share them)
//! install like any other mod. Archives get the ".off" dropped right after they are unpacked (archives.rs); dropped or
//! picked files are copied to a staging folder under their real names first (the originals stay as they are), each
//! pak/utoc/ucas set side by side so it stays one mod.

use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// "X.pak.off" -> "X.pak" (also .utoc.off and .ucas.off, any case); None for every other name.
pub fn strip_off(name: &str) -> Option<&str> {
    let lower = name.to_ascii_lowercase();
    [".pak.off", ".utoc.off", ".ucas.off"].iter().any(|s| lower.ends_with(s)).then(|| &name[..name.len() - 4])
}

/// Renames every .off mod file under `dir` to its real name (unless that name is taken).
pub fn strip_off_names(dir: &Path) {
    for entry in WalkDir::new(dir).into_iter().filter_map(Result::ok).filter(|e| e.file_type().is_file()) {
        let Some(name) = entry.file_name().to_str() else { continue };
        if let Some(real) = strip_off(name) {
            let to = entry.path().with_file_name(real);
            if !to.exists() {
                let _ = fs::rename(entry.path(), to);
            }
        }
    }
}

/// A .off mod file already in the mods folder, made this app's own: "X.pak.off" becomes "X.bak_repak" (off, as before)
/// and its .utoc.off and .ucas.off get their real names, so the set lists, toggles, and joins loadouts like any off
/// mod. Returns the new main file for a .pak.off. Nothing is renamed over a file that is already there.
pub fn adopt(path: &Path) -> Option<PathBuf> {
    let real = strip_off(path.file_name()?.to_str()?)?;
    let stem = &real[..real.len() - 4 - usize::from(!real.to_ascii_lowercase().ends_with(".pak"))];
    let side = |ext: &str| {
        let (from, to) = (path.with_file_name(format!("{stem}.{ext}.off")), path.with_file_name(format!("{stem}.{ext}")));
        if from.is_file() && !to.exists() {
            let _ = fs::rename(from, to);
        }
    };
    if !real.to_ascii_lowercase().ends_with(".pak") {
        side(&real[stem.len() + 1..]); // a .utoc.off or .ucas.off met before its .pak.off, or with none
        return None;
    }
    let off = path.with_file_name(format!("{stem}.bak_repak"));
    if path.with_file_name(real).exists() || off.exists() || fs::rename(path, &off).is_err() {
        return None; // the same mod is already here, on or off: the .off copy stays as it is
    }
    side("utoc");
    side("ucas");
    Some(off)
}

fn has_off_files(dir: &Path) -> bool {
    WalkDir::new(dir).into_iter().filter_map(Result::ok).any(|e| e.file_name().to_str().is_some_and(|n| strip_off(n).is_some()))
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    for entry in WalkDir::new(from).into_iter().filter_map(Result::ok) {
        let rel = entry.path().strip_prefix(from).unwrap_or(entry.path());
        let target = to.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// The paths to install in place of `paths`: each .off file set (and each folder holding .off files) copied into a
/// new folder under `root` with real names; everything else unchanged. A set dropped as three files gives one path,
/// its .pak, like a normal drop.
fn stage_into(paths: Vec<String>, root: &Path) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    let mut staged: Option<PathBuf> = None;
    let mut dir = || -> Result<PathBuf, String> {
        if staged.is_none() {
            let d = root.join(format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
            fs::create_dir_all(&d).map_err(|e| format!("Could not make a staging folder: {e}"))?;
            staged = Some(d);
        }
        Ok(staged.clone().unwrap())
    };
    for p in paths {
        let path = PathBuf::from(&p);
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        if path.is_dir() && has_off_files(&path) {
            let to = dir()?.join(&name);
            copy_tree(&path, &to).map_err(|e| format!("Could not copy {name}: {e}"))?;
            strip_off_names(&to);
            out.push(to.to_string_lossy().into_owned());
        } else if let Some(real) = strip_off(&name) {
            // The whole set travels together: its siblings, on or off, go into the same folder
            let stem = &real[..real.rfind('.').unwrap_or(real.len())];
            let staging = dir()?;
            for ext in ["pak", "utoc", "ucas"] {
                for sibling in [format!("{stem}.{ext}.off"), format!("{stem}.{ext}")] {
                    let from = path.with_file_name(&sibling);
                    let to = staging.join(format!("{stem}.{ext}"));
                    if from.is_file() && !to.exists() {
                        fs::copy(&from, &to).map_err(|e| format!("Could not copy {sibling}: {e}"))?;
                    }
                }
            }
            let pak = staging.join(format!("{stem}.pak"));
            let pick = if pak.exists() { pak } else { staging.join(real) };
            let pick = pick.to_string_lossy().into_owned();
            if !out.contains(&pick) {
                out.push(pick);
            }
        } else {
            out.push(p);
        }
    }
    Ok(out)
}

/// Staging folders from earlier installs are removed once they are a day old.
fn sweep(root: &Path) {
    let day = std::time::Duration::from_secs(86_400);
    for entry in fs::read_dir(root).into_iter().flatten().filter_map(Result::ok) {
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > day);
        if old {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

#[tauri::command]
pub async fn xtra_stage_off_files(paths: Vec<String>) -> Result<Vec<String>, String> {
    // repakxtra: file copies on a blocking thread, never on the async workers every other command shares
    crate::blocking(move || {
        let root = std::env::temp_dir().join("repakxtra-off");
        if !paths.iter().any(|p| strip_off(p).is_some() || (Path::new(p).is_dir() && has_off_files(Path::new(p)))) {
            return Ok(paths);
        }
        sweep(&root);
        stage_into(paths, &root)
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_only_mod_files() {
        assert_eq!(strip_off("A_9999999_P.pak.off"), Some("A_9999999_P.pak"));
        assert_eq!(strip_off("A_9999999_P.UTOC.OFF"), Some("A_9999999_P.UTOC"));
        assert_eq!(strip_off("A.ucas.off"), Some("A.ucas"));
        assert_eq!(strip_off("A.pak"), None);
        assert_eq!(strip_off("notes.txt.off"), None);
        assert_eq!(strip_off("A.pak_disabled"), None);
    }

    #[test]
    fn stages_a_dropped_set_as_one_mod() {
        let src = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        for f in ["Skin_9999999_P.pak.off", "Skin_9999999_P.utoc.off", "Skin_9999999_P.ucas.off", "Loose.pak"] {
            fs::write(src.path().join(f), f).unwrap();
        }
        let p = |f: &str| src.path().join(f).to_string_lossy().into_owned();
        let out = stage_into(vec![p("Skin_9999999_P.pak.off"), p("Skin_9999999_P.utoc.off"), p("Skin_9999999_P.ucas.off"), p("Loose.pak")], root.path()).unwrap();
        assert_eq!(out.len(), 2, "{out:?}");
        let pak = PathBuf::from(&out[0]);
        assert_eq!(pak.file_name().unwrap(), "Skin_9999999_P.pak");
        assert!(pak.with_extension("utoc").is_file() && pak.with_extension("ucas").is_file(), "the set stays together");
        assert_eq!(fs::read_to_string(&pak).unwrap(), "Skin_9999999_P.pak.off");
        assert_eq!(out[1], p("Loose.pak"), "a normal file is left alone");
        assert!(src.path().join("Skin_9999999_P.pak.off").is_file(), "the original stays");
    }

    #[test]
    fn adopts_an_off_set_in_the_mods_folder() {
        let dir = tempfile::tempdir().unwrap();
        let p = |f: &str| dir.path().join(f);
        for f in ["A_9999999_P.pak.off", "A_9999999_P.utoc.off", "A_9999999_P.ucas.off", "B.pak.off", "B.pak", "C.utoc.off", "D.pak"] {
            fs::write(p(f), f).unwrap();
        }
        assert_eq!(adopt(&p("A_9999999_P.pak.off")), Some(p("A_9999999_P.bak_repak")));
        for f in ["A_9999999_P.bak_repak", "A_9999999_P.utoc", "A_9999999_P.ucas"] {
            assert!(p(f).is_file(), "{f}");
        }
        assert_eq!(fs::read_to_string(p("A_9999999_P.bak_repak")).unwrap(), "A_9999999_P.pak.off");
        assert_eq!(adopt(&p("A_9999999_P.utoc.off")), None, "already renamed with its pak");
        assert_eq!(adopt(&p("B.pak.off")), None);
        assert!(p("B.pak.off").is_file() && fs::read_to_string(p("B.pak")).unwrap() == "B.pak", "never over the mod that is on");
        assert_eq!(adopt(&p("C.utoc.off")), None);
        assert!(p("C.utoc").is_file(), "a side file with no .pak.off gets its name back");
        assert_eq!(adopt(&p("D.pak")), None);
    }

    #[test]
    fn unpacked_archives_lose_the_off() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("Mod")).unwrap();
        for f in ["Mod/A.pak.off", "Mod/A.utoc.off", "Mod/A.ucas.off", "Mod/readme.txt"] {
            fs::write(dir.path().join(f), "x").unwrap();
        }
        strip_off_names(dir.path());
        for f in ["Mod/A.pak", "Mod/A.utoc", "Mod/A.ucas", "Mod/readme.txt"] {
            assert!(dir.path().join(f).is_file(), "{f}");
        }
    }
}
