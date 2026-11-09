//! repakxtra: the three ways a change to the mods folder gets refused, in one shape, so every operation shows the same
//! dialog for each (custom/opDialogs.tsx): the game is open (the dialog waits for it to close, then retries), another
//! program holds a file (Retry), or the name is taken (Replace, Keep both). The tag leads the error text, as in
//! "[locked] Another program is using this mod file...", and toast_events leaves tagged errors to that dialog.

use std::path::{Path, PathBuf};

const TAGS: [&str; 3] = ["[game_running]", "[locked]", "[collision]"];

/// Whether an error carries one of the tags (anywhere: callers may prefix their own words).
pub fn tagged(msg: &str) -> bool {
    TAGS.iter().any(|t| msg.contains(t))
}

pub fn game_running(msg: impl std::fmt::Display) -> String {
    format!("[game_running] {msg}")
}

pub fn collision(msg: impl std::fmt::Display) -> String {
    format!("[collision] {msg}")
}

/// A file Windows reports in use (os error 32 or 33), tagged by who holds it: the game, or another program.
pub fn io(e: &std::io::Error) -> Option<String> {
    let lock = std::io::Error::from_raw_os_error(32);
    let m = crate::xtra_vfx::in_use_message(if e.raw_os_error() == Some(33) { &lock } else { e })?;
    Some(if crate::xtra_vfx::game_running() { game_running(m) } else { format!("[locked] {m}") })
}

/// Every one of `paths` that exists can be written now, so a change that moves several files never stops halfway
/// (a delete that trashed the .pak and then met the game holding the .ucas left a broken mod behind).
pub fn all_free(paths: &[PathBuf]) -> Result<(), String> {
    for p in paths.iter().filter(|p| p.is_file()) {
        if let Err(e) = std::fs::OpenOptions::new().write(true).open(p) {
            if let Some(msg) = io(&e) {
                return Err(msg);
            }
        }
    }
    Ok(())
}

/// The mod files under `dest`'s name (on, off, and IoStore), other than `own`'s.
fn taken(dest: &Path, own: &Path) -> Vec<PathBuf> {
    const EXTS: [&str; 6] = ["pak", "bak_repak", "pak_disabled", "pak.bak_repak", "utoc", "ucas"];
    let low = |p: &Path| p.to_string_lossy().to_lowercase();
    let mine: Vec<String> = EXTS.iter().map(|x| low(&crate::xtra_bundle::companion(own, x))).collect();
    EXTS.iter().map(|x| crate::xtra_bundle::companion(dest, x)).filter(|p| p.is_file() && !mine.contains(&low(p))).collect()
}

/// Where a mod moving to `dest` lands. A free name is used as is. A taken one: "replace" first moves the mod there to
/// Recently deleted (never deleted for good), "keep_both" takes the next free "Name (1)" name, and no mode is a
/// collision error for the dialog to ask about.
pub fn place(dest: &Path, own: &Path, mode: Option<&str>) -> Result<PathBuf, String> {
    let there = taken(dest, own);
    if there.is_empty() {
        return Ok(dest.to_path_buf());
    }
    match mode {
        Some("replace") => {
            // every file must be free before the first one moves, or the mod there would be left half in the trash
            for p in &there {
                if let Err(e) = std::fs::OpenOptions::new().write(true).open(p) {
                    return Err(io(&e).unwrap_or_else(|| format!("{}: {e}", p.display())));
                }
            }
            let trash = crate::xtra_trash::reserve(None)?;
            for p in &there {
                if let Err(e) = crate::xtra_trash::discard(&trash, p) {
                    crate::xtra_trash::release_if_empty(&trash);
                    return Err(io(&e).unwrap_or_else(|| format!("{}: {e}", p.display())));
                }
            }
            Ok(dest.to_path_buf())
        }
        Some("keep_both") => {
            let dir = dest.parent().unwrap_or(Path::new(""));
            let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let stem = crate::xtra_bundle::stem(&name);
            let free = crate::install_mod::install_mod_logic::free_name(dir, stem);
            Ok(dir.join(format!("{free}{}", &name[stem.len()..])))
        }
        _ => Err(collision(format!("A mod named {} is already there.", crate::xtra_dupes::bare_name(dest)))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_taken_name_is_a_collision_until_a_mode_is_picked() {
        let dir = tempfile::tempdir().unwrap();
        let p = |n: &str| dir.path().join(n);
        for n in ["A_9999999_P.pak", "Sub/A_9999999_P.bak_repak", "Sub/A_9999999_P.utoc"] {
            std::fs::create_dir_all(p(n).parent().unwrap()).unwrap();
            std::fs::write(p(n), n).unwrap();
        }
        let dest = p("Sub/A_9999999_P.pak");
        let err = place(&dest, &p("A_9999999_P.pak"), None).unwrap_err();
        assert!(err.starts_with("[collision]") && tagged(&err), "{err}");
        assert_eq!(place(&dest, &p("A_9999999_P.pak"), Some("keep_both")).unwrap(), p("Sub/A (1)_9999999_P.pak"));
        assert_eq!(place(&p("Sub/Free_9999999_P.pak"), &p("A_9999999_P.pak"), None).unwrap(), p("Sub/Free_9999999_P.pak"));
    }

    #[cfg(windows)]
    #[test]
    fn a_held_file_stops_the_whole_change() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (pak, ucas) = (dir.path().join("A_9999999_P.pak"), dir.path().join("A_9999999_P.ucas"));
        std::fs::write(&pak, "p").unwrap();
        std::fs::write(&ucas, "c").unwrap();
        assert!(all_free(&[pak.clone(), ucas.clone(), dir.path().join("missing.utoc")]).is_ok());
        let _held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&ucas).unwrap(); // as the game holds it
        let err = all_free(&[pak, ucas]).unwrap_err();
        assert!(tagged(&err), "{err}");
    }

    #[test]
    fn its_own_off_copy_is_not_a_collision() {
        let dir = tempfile::tempdir().unwrap();
        let p = |n: &str| dir.path().join(n);
        for n in ["A_9999999_P.bak_repak", "A_9999999_P.utoc", "A_9999999_P.ucas"] {
            std::fs::write(p(n), n).unwrap();
        }
        assert!(place(&p("A_9999999_P.pak"), &p("A_9999999_P.bak_repak"), None).is_ok());
    }
}
