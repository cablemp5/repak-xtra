//! repakxtra: its own data folder, %APPDATA%\repakxtra. Every copy used to share %APPDATA%\Repak-X with the official
//! Repak X, whose 2.4.0 empties every trash folder it cannot read and rewrites the files both apps keep there. The first
//! start of a build with this module moves repakxtra's data out, in main() before anything reads it:
//! - renamed (instant on one drive, one copy of the truth): every name that is not on KEEP or COPY
//! - left in place: Repak X's own (KEEP)
//! - copied: what both apps read (COPY), so Repak X keeps working with its copy
//! - the trash entry by entry: repakxtra's (with .from records) move, Repak X's (meta.json) and unknown ones stay
//! The marker repakxtra-moved.json lists the names still to move and is written before the first one moves. A name that
//! cannot move now (previews, while its generator idles after a close) stays listed and moves at a later start, merged
//! into what this run made without replacing anything. What an older build writes to the old folder later is not
//! listed, so it stays there and is never merged back.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const MARKER: &str = "repakxtra-moved.json";
/// Repak X's own, never moved (lowercase; mods.db*, logs and character data backups are matched in `kept`).
const KEEP: [&str; 5] = ["state.json", "last_seen_version.txt", "pending_custom_tags.json", "temp", "character_data_starsong_pin.txt"];
/// Read by both apps: copied, and the old one stays for Repak X.
const COPY: [&str; 5] = ["hero", "hero_cache.json", "usmap", "character_data.json", "vfx_settings.json"];
/// Without these the app starts without its settings, loadouts, install sources, or Recently deleted: asked about.
const NEEDED: [&str; 4] = ["repakxtra-state.json", "webview-storage.json", "installed_sources.json", "trash"];
/// Files that store absolute paths into the data folder (a folder: every file in it).
const WITH_PATHS: [&str; 3] = ["vfx_settings.json", "previews/index.json", "swap-journal"];

fn base() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// %APPDATA%\repakxtra: every repakxtra data path goes through this (crate::app_dir).
pub fn dir() -> PathBuf {
    base().join("repakxtra")
}

/// %APPDATA%\Repak-X, the folder shared with Repak X before.
pub fn old_dir() -> PathBuf {
    base().join("Repak-X")
}

fn kept(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    KEEP.contains(&n.as_str()) || n.starts_with("mods.db") || n.ends_with(".log") || n.ends_with(".log.old") || n.starts_with("character_data_backup_")
}

/// main(), before anything reads the data folder: moves what is left to move. Returns a line for the log.
pub fn move_out() -> Option<String> {
    let (old, new) = (old_dir(), dir());
    let left = match move_between(&old, &new) {
        Ok(None) => return None,
        Ok(Some(left)) => left,
        Err(e) => return Some(format!("Data folder: could not move {} to {}: {e}", old.display(), new.display())),
    };
    let needed: Vec<&str> = left.iter().map(String::as_str).filter(|n| NEEDED.iter().any(|x| x.eq_ignore_ascii_case(n))).collect();
    #[cfg(windows)]
    if !needed.is_empty() {
        let app = crate::xtra_edition::APP_NAME;
        let text = format!("{app} keeps its data in its own folder now, but some of it is in use by another program and could not \
                            move from {} yet: {}.\n\nClose Repak X and any other program using it, then open {app} again.\n\nStart \
                            now anyway? It moves at a later start.", old.display(), needed.join(", "));
        if !crate::xtra_identity::ask_continue(&text) {
            std::process::exit(0);
        }
    }
    Some(if left.is_empty() {
        format!("Data folder: moved to {}", new.display())
    } else {
        format!("Data folder: moved to {}, still in use and moving at a later start: {}", new.display(), left.join(", "))
    })
}

/// Ok(None) when there was nothing to move, else the names still left after this run.
fn move_between(old: &Path, new: &Path) -> io::Result<Option<Vec<String>>> {
    let marker = new.join(MARKER);
    let pending = match fs::read_to_string(&marker) {
        // an unreadable marker moves nothing more: whatever is left stays safe in the old folder
        Ok(text) => serde_json::from_str::<Vec<String>>(&text).unwrap_or_default(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let names: Vec<String> = match fs::read_dir(old) {
                Ok(list) => list.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| !kept(n)).collect(),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(), // a new user: nothing to bring
                Err(e) => return Err(e),
            };
            fs::create_dir_all(new)?;
            write_atomic(&marker, &serde_json::to_string(&names)?)?;
            names
        }
        Err(e) => return Err(e),
    };
    if pending.is_empty() {
        return Ok(None);
    }
    let left: Vec<String> = pending.into_iter().filter(|n| !move_name(old, new, n)).collect();
    rewrite_paths(old, new);
    write_atomic(&marker, &serde_json::to_string(&left)?)?;
    Ok(Some(left))
}

/// True when nothing of `name` is left to move.
fn move_name(old: &Path, new: &Path, name: &str) -> bool {
    let (from, to) = (old.join(name), new.join(name));
    if fs::symlink_metadata(&from).is_err() {
        return true; // moved by a run cut off before it saved the marker, or deleted since
    }
    let lower = name.to_ascii_lowercase();
    if lower == "trash" {
        move_trash(&from, &to)
    } else if COPY.contains(&lower.as_str()) {
        copy_over(&from, &to).is_ok()
    } else {
        move_over(&from, &to)
    }
}

/// Only repakxtra's entries: folders with .from records and no meta.json (Repak X's), and the older flat
/// `<name>` + `<name>.from` pairs. Unknown entries stay.
fn move_trash(from: &Path, to: &Path) -> bool {
    if fs::create_dir_all(to).is_err() {
        return false;
    }
    let mut done = true;
    for e in fs::read_dir(from).into_iter().flatten().flatten() {
        let (path, name) = (e.path(), e.file_name().to_string_lossy().into_owned());
        let ours = if path.is_dir() {
            !path.join("meta.json").exists()
                && fs::read_dir(&path).into_iter().flatten().flatten().any(|f| f.file_name().to_string_lossy().ends_with(".from"))
        } else {
            name.ends_with(".from") || from.join(format!("{name}.from")).exists()
        };
        if ours {
            done &= move_over(&path, &to.join(&name));
        }
    }
    done
}

/// Renames `from` to `to`. On another drive: copy, check, delete. When `to` exists already (a retry, after a run made
/// it) or a folder cannot be renamed whole (a file in it is in use), the folder merges file by file and a file `to`
/// already has is kept, the old one left behind. True when nothing of `from` is left to move.
fn move_over(from: &Path, to: &Path) -> bool {
    const ERROR_NOT_SAME_DEVICE: i32 = 17;
    if fs::symlink_metadata(to).is_err() {
        match fs::rename(from, to) {
            Ok(()) => return true,
            Err(e) if e.raw_os_error() == Some(ERROR_NOT_SAME_DEVICE) => {
                return copy_over(from, to).is_ok() && if from.is_dir() { fs::remove_dir_all(from) } else { fs::remove_file(from) }.is_ok();
            }
            Err(_) if from.is_dir() => {
                if fs::create_dir_all(to).is_err() {
                    return false;
                }
            }
            Err(_) => return false,
        }
    }
    if !(from.is_dir() && to.is_dir()) {
        return true; // `to` has its own already: it wins
    }
    let mut done = true;
    for e in fs::read_dir(from).into_iter().flatten().flatten() {
        done &= move_over(&e.path(), &to.join(e.file_name()));
    }
    let _ = fs::remove_dir(from); // fails while anything stayed behind
    done
}

/// Copies `from` to `to`, skipping files `to` has. Each file lands under a temporary name first and is checked by size,
/// so a cut-off copy never leaves a short file that a retry would skip.
fn copy_over(from: &Path, to: &Path) -> io::Result<()> {
    if from.is_dir() {
        fs::create_dir_all(to)?;
        for e in fs::read_dir(from)? {
            let e = e?;
            copy_over(&e.path(), &to.join(e.file_name()))?;
        }
        return Ok(());
    }
    if to.exists() {
        return Ok(());
    }
    let part = to.with_file_name(format!("{}.part", to.file_name().unwrap_or_default().to_string_lossy()));
    let copied = fs::copy(from, &part).and_then(|n| {
        if n == fs::metadata(from)?.len() { fs::rename(&part, to) } else { Err(io::Error::other("copy came out short")) }
    });
    if copied.is_err() {
        let _ = fs::remove_file(&part);
    }
    copied
}

/// Points paths stored in the moved files at the new folder.
fn rewrite_paths(old: &Path, new: &Path) {
    for rel in WITH_PATHS {
        let p = new.join(rel);
        let files: Vec<PathBuf> = if p.is_dir() { fs::read_dir(&p).into_iter().flatten().flatten().map(|e| e.path()).collect() } else { vec![p] };
        for f in files {
            let Ok(text) = fs::read_to_string(&f) else { continue };
            let fixed = rewrite(&text, old, new);
            if fixed != text {
                let _ = write_atomic(&f, &fixed);
            }
        }
    }
}

/// The old folder as JSON stores it (each backslash doubled), only where a separator follows, so a longer name never
/// matches.
fn rewrite(text: &str, old: &Path, new: &Path) -> String {
    let json = |p: &Path| p.to_string_lossy().replace('\\', r"\\");
    let (o, n) = (json(old), json(new));
    text.replace(&format!(r"{o}\\"), &format!(r"{n}\\")).replace(&format!("{o}/"), &format!("{n}/"))
}

fn write_atomic(path: &Path, text: &str) -> io::Result<()> {
    let tmp = path.with_file_name(format!("{}.tmp", path.file_name().unwrap_or_default().to_string_lossy()));
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(p: &Path, text: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    fn read(p: &Path) -> String {
        fs::read_to_string(p).unwrap()
    }

    #[test]
    fn the_first_start_moves_keeps_copies_and_splits_the_trash() {
        let t = tempfile::tempdir().unwrap();
        let (old, new) = (t.path().join("Repak-X"), t.path().join("repakxtra"));
        for keep in ["state.json", "last_seen_version.txt", "mods.db", "mods.db-wal", "pending_custom_tags.json", "repak_vfx.log", "repak_vfx.log.old", "character_data_backup_1.json"] {
            put(&old.join(keep), "upstream");
        }
        put(&old.join("repakxtra-state.json"), "settings");
        put(&old.join("installed_sources.json"), "sources");
        put(&old.join(r"previews\a.png"), "png");
        put(&old.join(r"Usmap\m.usmap"), "map");
        put(&old.join(r"hero\1011.png"), "face");
        let old_json = old.to_string_lossy().replace('\\', r"\\");
        put(&old.join("vfx_settings.json"), &format!(r#"{{"usmapPath": "{old_json}\\usmap\\m.usmap"}}"#));
        put(&old.join(r"previews\index.json"), &format!(r#"{{"err": "{old_json}\\previews\\work"}}"#));
        put(&old.join(r"trash\ours\a.pak"), "mod");
        put(&old.join(r"trash\ours\a.pak.from"), r"C:\mods\a.pak");
        put(&old.join(r"trash\theirs\meta.json"), "{}");
        put(&old.join(r"trash\theirs\b.pak"), "mod");
        put(&old.join(r"trash\odd\c.pak"), "mod");
        put(&old.join(r"trash\flat.pak"), "mod");
        put(&old.join(r"trash\flat.pak.from"), r"C:\mods\flat.pak");

        assert_eq!(move_between(&old, &new).unwrap(), Some(vec![]));
        // moved
        assert_eq!(read(&new.join("repakxtra-state.json")), "settings");
        assert!(!old.join("repakxtra-state.json").exists() && !old.join("previews").exists());
        assert_eq!(read(&new.join(r"previews\a.png")), "png");
        // Repak X's stay, and only there
        for keep in ["state.json", "mods.db-wal", "pending_custom_tags.json", "repak_vfx.log", "character_data_backup_1.json"] {
            assert!(old.join(keep).exists() && !new.join(keep).exists(), "{keep}");
        }
        // shared: in both
        assert!(old.join(r"Usmap\m.usmap").exists() && read(&new.join(r"Usmap\m.usmap")) == "map");
        assert!(old.join(r"hero\1011.png").exists() && new.join(r"hero\1011.png").exists());
        // stored paths point at the new folder in the moved copies, Repak X's copy keeps its own
        let new_json = new.to_string_lossy().replace('\\', r"\\");
        assert!(read(&new.join("vfx_settings.json")).contains(&format!(r"{new_json}\\usmap")));
        assert!(read(&old.join("vfx_settings.json")).contains(&format!(r"{old_json}\\usmap")));
        assert!(read(&new.join(r"previews\index.json")).contains(&format!(r"{new_json}\\previews")));
        // the trash: ours moved, Repak X's and unknown ones stayed
        assert!(new.join(r"trash\ours\a.pak.from").exists() && new.join(r"trash\flat.pak").exists() && new.join(r"trash\flat.pak.from").exists());
        assert!(old.join(r"trash\theirs\b.pak").exists() && old.join(r"trash\odd\c.pak").exists());
        assert!(!new.join(r"trash\theirs").exists() && !old.join(r"trash\ours").exists());

        // the second start does nothing, and what an old build writes to the old folder afterwards stays there
        put(&old.join("repakxtra-state.json"), "an old build's");
        assert_eq!(move_between(&old, &new).unwrap(), None);
        assert_eq!(read(&new.join("repakxtra-state.json")), "settings");
    }

    #[test]
    fn a_new_user_gets_an_empty_folder_and_nothing_to_move() {
        let t = tempfile::tempdir().unwrap();
        let (old, new) = (t.path().join("Repak-X"), t.path().join("repakxtra"));
        assert_eq!(move_between(&old, &new).unwrap(), None);
        assert_eq!(read(&new.join(MARKER)), "[]");
    }

    #[test]
    fn a_cut_off_move_resumes_and_merges_without_replacing() {
        let t = tempfile::tempdir().unwrap();
        let (old, new) = (t.path().join("Repak-X"), t.path().join("repakxtra"));
        put(&old.join(r"previews\a.png"), "old a");
        put(&old.join(r"previews\b.png"), "old b");
        put(&old.join("labels.json"), "labels");
        // a run listed the names, then stopped: one already moved, previews not, and a session made a newer previews\a.png
        put(&new.join(MARKER), r#"["moved-before.json", "previews", "labels.json"]"#);
        put(&new.join("moved-before.json"), "x");
        put(&new.join(r"previews\a.png"), "new a");
        assert_eq!(move_between(&old, &new).unwrap(), Some(vec![]));
        assert_eq!(read(&new.join(r"previews\a.png")), "new a");
        assert_eq!(read(&new.join(r"previews\b.png")), "old b");
        assert_eq!(read(&new.join("labels.json")), "labels");
        assert_eq!(read(&new.join(MARKER)), "[]");
    }

    #[cfg(windows)]
    #[test]
    fn a_file_in_use_stays_listed_and_moves_at_a_later_start() {
        use std::os::windows::fs::OpenOptionsExt;
        let t = tempfile::tempdir().unwrap();
        let (old, new) = (t.path().join("Repak-X"), t.path().join("repakxtra"));
        put(&old.join(r"previews\busy.webp"), "busy");
        put(&old.join(r"previews\free.png"), "free");
        put(&old.join("repakxtra-state.json"), "settings");
        let held = fs::OpenOptions::new().read(true).share_mode(0).open(old.join(r"previews\busy.webp")).unwrap();
        assert_eq!(move_between(&old, &new).unwrap(), Some(vec!["previews".to_string()]));
        // what was free moved now, so the app runs on it
        assert_eq!(read(&new.join(r"previews\free.png")), "free");
        assert!(new.join("repakxtra-state.json").exists());
        drop(held);
        assert_eq!(move_between(&old, &new).unwrap(), Some(vec![]));
        assert_eq!(read(&new.join(r"previews\busy.webp")), "busy");
        assert!(!old.join("previews").exists());
    }

    #[test]
    fn only_whole_folder_names_are_rewritten() {
        let (old, new) = (Path::new(r"C:\U\Roaming\Repak-X"), Path::new(r"C:\U\Roaming\repakxtra"));
        let text = r#"{"a": "C:\\U\\Roaming\\Repak-X\\usmap\\m", "b": "C:\\U\\Roaming\\Repak-Xtra\\c", "c": "C:\\U\\Roaming\\Repak-X/d"}"#;
        assert_eq!(rewrite(text, old, new), r#"{"a": "C:\\U\\Roaming\\repakxtra\\usmap\\m", "b": "C:\\U\\Roaming\\Repak-Xtra\\c", "c": "C:\\U\\Roaming\\repakxtra/d"}"#);
    }
}
