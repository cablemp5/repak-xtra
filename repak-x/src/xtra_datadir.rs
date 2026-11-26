//! repakxtra: its own data folder, %APPDATA%\repakxtra. Every copy used to share %APPDATA%\Repak-X with the official
//! Repak X, whose 2.4.0 empties every trash folder it cannot read and rewrites the files both apps keep there. The first
//! start of a build with this module moves repakxtra's data out, in main() before anything reads it:
//! - renamed (instant on one drive, one copy of the truth): every name that is not on KEEP or COPY
//! - left in place: Repak X's own (KEEP)
//! - copied: what both apps read (COPY), so Repak X keeps working with its copy
//! - the trash entry by entry, each whole: repakxtra's (with .from records) move, Repak X's (meta.json) and unknown
//!   ones stay
//! The marker repakxtra-moved.json holds when the move started and the names still to move, written before the first
//! one moves. A name that cannot move now (previews, while its generator idles after a close) stays listed and moves at
//! a later start, merged into what this run made without replacing anything. Files written to the old folder after the
//! move started (an older build still in use) are never brought over.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MARKER: &str = "repakxtra-moved.json";
/// Repak X's own, never moved (lowercase; mods.db*, logs and character data backups are matched in `kept`).
const KEEP: [&str; 5] = ["state.json", "last_seen_version.txt", "pending_custom_tags.json", "temp", "character_data_starsong_pin.txt"];
/// Read by both apps: copied, and the old one stays for Repak X.
const COPY: [&str; 6] = ["hero", "hero_cache.json", "usmap", "character_data.json", "vfx_settings.json", "character_data_last_check.txt"];
/// Without these the app starts without its settings, loadouts, install sources, or Recently deleted: asked about.
const NEEDED: [&str; 4] = ["repakxtra-state.json", "webview-storage.json", "installed_sources.json", "trash"];
/// Programs, not data: moved whole or not at all, so a half-moved kit never counts as installed.
const WHOLE: [&str; 1] = ["preview-kit"];
const ERROR_NOT_SAME_DEVICE: i32 = 17;

#[derive(serde::Serialize, serde::Deserialize)]
struct Marker {
    /// Unix milliseconds when the move started: files written to the old folder after it are an older build's.
    started: u64,
    pending: Vec<String>,
}

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
    KEEP.contains(&n.as_str()) || n.starts_with("mods.db") || n.ends_with(".log") || n.ends_with(".log.old") || n.starts_with("character_data_backup")
}

/// main(), before anything reads the data folder: moves what is left to move. Returns a line for the log.
pub fn move_out() -> Option<String> {
    let (old, new) = (old_dir(), dir());
    let app = crate::xtra_edition::APP_NAME;
    let (left, problem) = match move_between(&old, &new) {
        Ok(None) => return None,
        Ok(Some(left)) => {
            let needed: Vec<&str> = left.iter().map(String::as_str).filter(|n| NEEDED.iter().any(|x| x.eq_ignore_ascii_case(n))).collect();
            let problem = (!needed.is_empty()).then(|| format!("Some of it is in use by another program and could not move yet: {}.\n\n\
                Close Repak X and any other program using {}, then open {app} again.", needed.join(", "), old.display()));
            (left, problem)
        }
        Err(e) => (Vec::new(), Some(format!("It could not move from {}:\n{e}", old.display()))),
    };
    #[cfg(windows)]
    if let Some(problem) = &problem {
        let text = format!("{app} keeps its data in its own folder now, {}. {problem}\n\nStart now without it? It stays in the old \
                            folder for now and comes over at a later start.", new.display());
        if !crate::xtra_identity::ask_continue(&text) {
            std::process::exit(0);
        }
    }
    Some(match (&problem, left.is_empty()) {
        (Some(p), true) => format!("Data folder: {}", p.replace('\n', " ")),
        (_, true) => format!("Data folder: moved to {}", new.display()),
        (_, false) => format!("Data folder: moved to {}, still in use and moving at a later start: {}", new.display(), left.join(", ")),
    })
}

/// Ok(None) when there was nothing to move, else the names still left after this run.
fn move_between(old: &Path, new: &Path) -> io::Result<Option<Vec<String>>> {
    let marker = new.join(MARKER);
    let mut first = false;
    let mut m = match fs::read_to_string(&marker) {
        // an unreadable marker moves nothing more: whatever is left stays safe in the old folder
        Ok(text) => serde_json::from_str::<Marker>(&text).unwrap_or(Marker { started: 0, pending: Vec::new() }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let pending: Vec<String> = match fs::read_dir(old) {
                Ok(list) => list.map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned())).collect::<io::Result<Vec<_>>>()?
                    .into_iter().filter(|n| !kept(n)).collect(),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(), // a new user: nothing to bring
                Err(e) => return Err(e),
            };
            let started = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
            fs::create_dir_all(new)?;
            let m = Marker { started, pending };
            write_atomic(&marker, &serde_json::to_string(&m)?)?;
            first = true;
            m
        }
        Err(e) => return Err(e),
    };
    if m.pending.is_empty() {
        return Ok(None);
    }
    // only a retry skips late files: on the first run nothing is late (a file dated ahead still moves)
    let since = (!first).then(|| UNIX_EPOCH + Duration::from_millis(m.started));
    m.pending.retain(|n| !move_name(old, new, n, since));
    write_atomic(&marker, &serde_json::to_string(&m)?)?;
    Ok(Some(m.pending))
}

/// True when nothing of `name` is left to move and the paths it stores point at the new folder.
fn move_name(old: &Path, new: &Path, name: &str, since: Option<SystemTime>) -> bool {
    let (from, to) = (old.join(name), new.join(name));
    let lower = name.to_ascii_lowercase();
    let moved = if fs::symlink_metadata(&from).is_err() {
        true // moved by a run cut off before it saved the marker, or deleted since
    } else if lower == "trash" {
        move_trash(&from, &to, since)
    } else if COPY.contains(&lower.as_str()) {
        copy_over(&from, &to).is_ok()
    } else if WHOLE.contains(&lower.as_str()) {
        fs::symlink_metadata(&to).is_ok() || rename_whole(&from, &to) // one set up meanwhile wins, the old one is left
    } else {
        move_over(&from, &to, since, true)
    };
    moved && rewrite_paths(old, new, &lower)
}

/// Only repakxtra's entries, each whole: folders with .from records and no meta.json (Repak X's), and the older flat
/// `<name>` + `<name>.from` pairs, file before record. An entry part of which moved already (a run before) is ours too.
fn move_trash(from: &Path, to: &Path, since: Option<SystemTime>) -> bool {
    let Ok(list) = fs::read_dir(from) else { return false };
    if fs::create_dir_all(to).is_err() {
        return false;
    }
    let mut done = true;
    for e in list {
        let Ok(e) = e else {
            done = false;
            continue;
        };
        let (path, name) = (e.path(), e.file_name().to_string_lossy().into_owned());
        let (dest, Ok(meta)) = (to.join(&name), fs::symlink_metadata(&path)) else { continue }; // a payload moved with its record
        if meta.is_dir() {
            let has_record = fs::read_dir(&path).into_iter().flatten().flatten().any(|f| f.file_name().to_string_lossy().ends_with(".from"));
            if !path.join("meta.json").exists() && (has_record || dest.exists()) {
                done &= move_entry(&path, &dest, since);
            }
        } else if let Some(payload) = name.strip_suffix(".from") {
            let file = from.join(payload);
            done &= (fs::symlink_metadata(&file).is_err() || move_entry(&file, &to.join(payload), since)) && move_entry(&path, &dest, since);
        } else if to.join(format!("{name}.from")).exists() {
            done &= move_entry(&path, &dest, since);
        }
    }
    done
}

/// A trash entry: renamed whole, or merged into the part a run before moved.
fn move_entry(from: &Path, to: &Path, since: Option<SystemTime>) -> bool {
    if fs::symlink_metadata(to).is_ok() { move_over(from, to, since, false) } else { rename_whole(from, to) }
}

/// Renames `from` to `to`, or on another drive copies, checks, and deletes. False when it could not (in use).
fn rename_whole(from: &Path, to: &Path) -> bool {
    match fs::rename(from, to) {
        Ok(()) => true,
        Err(e) if e.raw_os_error() == Some(ERROR_NOT_SAME_DEVICE) => {
            copy_over(from, to).is_ok() && if from.is_dir() { fs::remove_dir_all(from) } else { fs::remove_file(from) }.is_ok()
        }
        Err(_) => false,
    }
}

/// Moves `from` to `to`. A folder that cannot be renamed whole (a file in it is in use), or whose `to` exists already
/// (a retry, after a run made it), merges file by file, never replacing a file `to` has: at the top level the old file
/// is kept beside it as `<name>.from-Repak-X`, inside a folder the new one wins and the old is left. Links (junctions)
/// are moved, never walked. Files written after the move started are an older build's and stay. True when nothing of
/// `from` is left to move.
fn move_over(from: &Path, to: &Path, since: Option<SystemTime>, top: bool) -> bool {
    let Ok(meta) = fs::symlink_metadata(from) else { return true };
    let folder = meta.is_dir() && !meta.file_type().is_symlink();
    if !folder && since.is_some_and(|s| meta.modified().is_ok_and(|t| t > s)) {
        return true;
    }
    if fs::symlink_metadata(to).is_err() {
        if rename_whole(from, to) {
            return true;
        }
        if !folder || fs::create_dir_all(to).is_err() {
            return false;
        }
    } else if !folder {
        let beside = to.with_file_name(format!("{}.from-Repak-X", to.file_name().unwrap_or_default().to_string_lossy()));
        return !top || meta.file_type().is_symlink() || fs::symlink_metadata(&beside).is_ok() || fs::rename(from, &beside).is_ok();
    } else if !to.is_dir() {
        return true; // a file took the name: it wins
    }
    let Ok(list) = fs::read_dir(from) else { return false };
    let mut done = true;
    for e in list {
        done &= e.is_ok_and(|e| move_over(&e.path(), &to.join(e.file_name()), since, false));
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
    let part = to.with_file_name(format!("{}.repakxtra-copying", to.file_name().unwrap_or_default().to_string_lossy()));
    let copied = fs::copy(from, &part).and_then(|n| {
        if n == fs::metadata(from)?.len() { fs::rename(&part, to) } else { Err(io::Error::other("copy came out short")) }
    });
    if copied.is_err() {
        let _ = fs::remove_file(&part);
    }
    copied
}

/// Points the absolute paths a moved name stores at the new folder. False when a file could not be read or rewritten,
/// so the name stays listed and the next start tries again.
fn rewrite_paths(old: &Path, new: &Path, name: &str) -> bool {
    let files: Vec<PathBuf> = match name {
        "vfx_settings.json" => vec![new.join(name)],
        "previews" => vec![new.join(r"previews\index.json")],
        "swap-journal" => match fs::read_dir(new.join(name)) {
            Ok(list) => match list.map(|e| e.map(|e| e.path())).collect() {
                Ok(files) => files,
                Err(_) => return false,
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => return true,
            Err(_) => return false,
        },
        _ => return true,
    };
    files.iter().all(|f| match fs::read_to_string(f) {
        Ok(text) => {
            let fixed = rewrite(&text, old, new);
            fixed == text || write_atomic(f, &fixed).is_ok()
        }
        Err(e) => e.kind() == io::ErrorKind::NotFound,
    })
}

/// The old folder as JSON stores it (each backslash doubled) or written with forward slashes, in any case, only where a
/// separator follows, so a longer name never matches.
fn rewrite(text: &str, old: &Path, new: &Path) -> String {
    let (o, n) = (old.to_string_lossy(), new.to_string_lossy());
    let escaped = |s: &str| s.replace('\\', r"\\");
    let slashed = |s: &str| s.replace('\\', "/");
    let text = replace_ci(text, &format!(r"{}\\", escaped(&o)), &format!(r"{}\\", escaped(&n)));
    replace_ci(&text, &format!("{}/", slashed(&o)), &format!("{}/", slashed(&n)))
}

/// `str::replace` ignoring ASCII case (paths on Windows). ASCII lowering keeps every byte offset.
fn replace_ci(text: &str, pat: &str, rep: &str) -> String {
    let (lower, pat_lower) = (text.to_ascii_lowercase(), pat.to_ascii_lowercase());
    let (mut out, mut last) = (String::with_capacity(text.len()), 0);
    for (i, _) in lower.match_indices(&pat_lower) {
        out.push_str(&text[last..i]);
        out.push_str(rep);
        last = i + pat.len();
    }
    out.push_str(&text[last..]);
    out
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

    fn dirs() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let (old, new) = (t.path().join("Repak-X"), t.path().join("repakxtra"));
        (t, old, new)
    }

    /// A marker as a run that stopped midway (or a session after it) leaves it, started an hour ago.
    fn marker(new: &Path, pending: &[&str]) {
        let started = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 - 3_600_000;
        put(&new.join(MARKER), &serde_json::to_string(&Marker { started, pending: pending.iter().map(|s| s.to_string()).collect() }).unwrap());
    }

    /// Backdates a file, so it reads as written before the marker's start.
    fn backdate(p: &Path) {
        fs::File::options().write(true).open(p).unwrap().set_modified(SystemTime::now() - Duration::from_secs(7200)).unwrap();
    }

    fn pending(new: &Path) -> Vec<String> {
        serde_json::from_str::<Marker>(&read(&new.join(MARKER))).unwrap().pending
    }

    #[test]
    fn the_first_start_moves_keeps_copies_and_splits_the_trash() {
        let (_t, old, new) = dirs();
        for keep in ["state.json", "last_seen_version.txt", "mods.db", "mods.db-wal", "pending_custom_tags.json", "repak_vfx.log", "repak_vfx.log.old", "character_data_backup_1.json", "character_data_backup.json"] {
            put(&old.join(keep), "upstream");
        }
        put(&old.join("repakxtra-state.json"), "settings");
        put(&old.join("installed_sources.json"), "sources");
        put(&old.join(r"previews\a.png"), "png");
        put(&old.join(r"preview-kit\python\python.exe"), "exe");
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
        put(&old.join(r"trash\loose.pak"), "no record");

        assert_eq!(move_between(&old, &new).unwrap(), Some(vec![]));
        assert_eq!(read(&new.join("repakxtra-state.json")), "settings");
        assert!(!old.join("repakxtra-state.json").exists() && !old.join("previews").exists());
        assert_eq!(read(&new.join(r"previews\a.png")), "png");
        assert!(new.join(r"preview-kit\python\python.exe").exists());
        for keep in ["state.json", "mods.db-wal", "pending_custom_tags.json", "repak_vfx.log", "character_data_backup_1.json", "character_data_backup.json"] {
            assert!(old.join(keep).exists() && !new.join(keep).exists(), "{keep}");
        }
        assert!(old.join(r"Usmap\m.usmap").exists() && read(&new.join(r"Usmap\m.usmap")) == "map");
        assert!(old.join(r"hero\1011.png").exists() && new.join(r"hero\1011.png").exists());
        let new_json = new.to_string_lossy().replace('\\', r"\\");
        assert!(read(&new.join("vfx_settings.json")).contains(&format!(r"{new_json}\\usmap")));
        assert!(read(&old.join("vfx_settings.json")).contains(&format!(r"{old_json}\\usmap")));
        assert!(read(&new.join(r"previews\index.json")).contains(&format!(r"{new_json}\\previews")));
        assert!(new.join(r"trash\ours\a.pak.from").exists() && new.join(r"trash\flat.pak").exists() && new.join(r"trash\flat.pak.from").exists());
        assert!(old.join(r"trash\theirs\b.pak").exists() && old.join(r"trash\odd\c.pak").exists() && old.join(r"trash\loose.pak").exists());
        assert!(!new.join(r"trash\theirs").exists() && !old.join(r"trash\ours").exists() && !new.join(r"trash\loose.pak").exists());

        // the second start does nothing, and what an old build writes to the old folder afterwards stays there
        put(&old.join("repakxtra-state.json"), "an old build's");
        assert_eq!(move_between(&old, &new).unwrap(), None);
        assert_eq!(read(&new.join("repakxtra-state.json")), "settings");
    }

    #[test]
    fn a_new_user_gets_an_empty_folder_and_nothing_to_move() {
        let (_t, old, new) = dirs();
        assert_eq!(move_between(&old, &new).unwrap(), None);
        assert!(pending(&new).is_empty());
    }

    #[test]
    fn a_cut_off_move_resumes_and_merges_without_replacing() {
        let (_t, old, new) = dirs();
        put(&old.join(r"previews\a.png"), "old a");
        put(&old.join(r"previews\b.png"), "old b");
        put(&old.join("labels.json"), "labels");
        put(&old.join("installed_sources.json"), "every source");
        for f in [r"previews\a.png", r"previews\b.png", "labels.json", "installed_sources.json"] {
            backdate(&old.join(f));
        }
        // a run listed the names, then stopped (one had moved), and a session after it made its own files
        marker(&new, &["moved-before.json", "previews", "labels.json", "installed_sources.json"]);
        put(&new.join("moved-before.json"), "x");
        put(&new.join(r"previews\a.png"), "new a");
        put(&new.join("installed_sources.json"), "one source");
        assert_eq!(move_between(&old, &new).unwrap(), Some(vec![]));
        assert_eq!(read(&new.join(r"previews\a.png")), "new a");
        assert_eq!(read(&new.join(r"previews\b.png")), "old b");
        assert_eq!(read(&new.join("labels.json")), "labels");
        // a top-level file never vanishes: the session's stays in use, the old one is kept beside it
        assert_eq!(read(&new.join("installed_sources.json")), "one source");
        assert_eq!(read(&new.join("installed_sources.json.from-Repak-X")), "every source");
    }

    #[test]
    fn what_an_old_build_writes_after_the_move_started_stays_behind() {
        let (_t, old, new) = dirs();
        put(&old.join(r"previews\before.png"), "before");
        backdate(&old.join(r"previews\before.png"));
        put(&old.join(r"previews\after.png"), "an old build's render");
        marker(&new, &["previews"]);
        put(&new.join(r"previews\x.png"), "made since");
        assert_eq!(move_between(&old, &new).unwrap(), Some(vec![]));
        assert!(new.join(r"previews\before.png").exists());
        assert!(!new.join(r"previews\after.png").exists() && old.join(r"previews\after.png").exists());
    }

    #[test]
    fn a_trash_entry_split_by_an_earlier_run_still_moves() {
        let (_t, old, new) = dirs();
        // the earlier run moved the records but not the files (in use): a folder entry and a flat pair
        put(&old.join(r"trash\split\a.pak"), "mod");
        put(&new.join(r"trash\split\a.pak.from"), r"C:\mods\a.pak");
        put(&old.join(r"trash\flat.pak"), "mod");
        put(&new.join(r"trash\flat.pak.from"), r"C:\mods\flat.pak");
        for f in [r"trash\split\a.pak", r"trash\flat.pak"] {
            backdate(&old.join(f));
        }
        marker(&new, &["trash"]);
        assert_eq!(move_between(&old, &new).unwrap(), Some(vec![]));
        assert_eq!(read(&new.join(r"trash\split\a.pak")), "mod");
        assert_eq!(read(&new.join(r"trash\flat.pak")), "mod");
        assert!(!old.join(r"trash\split").exists() && !old.join(r"trash\flat.pak").exists());
    }

    #[cfg(windows)]
    #[test]
    fn a_file_in_use_stays_listed_and_moves_at_a_later_start() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_t, old, new) = dirs();
        put(&old.join(r"previews\busy.webp"), "busy");
        put(&old.join(r"previews\free.png"), "free");
        put(&old.join("repakxtra-state.json"), "settings");
        put(&old.join(r"preview-kit\python\python.exe"), "exe");
        put(&old.join(r"preview-kit\kit.json"), "{}");
        put(&old.join(r"trash\held\a.pak"), "mod");
        put(&old.join(r"trash\held\a.pak.from"), r"C:\mods\a.pak");
        let open = |p: &str| fs::OpenOptions::new().read(true).share_mode(0).open(old.join(p)).unwrap();
        let held = (open(r"previews\busy.webp"), open(r"preview-kit\python\python.exe"), open(r"trash\held\a.pak"));
        assert_eq!(move_between(&old, &new).unwrap(), Some(vec!["preview-kit".to_string(), "previews".to_string(), "trash".to_string()]));
        // what was free moved now, so the app runs on it, and a program folder or trash entry never moves in part
        assert_eq!(read(&new.join(r"previews\free.png")), "free");
        assert!(new.join("repakxtra-state.json").exists());
        assert!(!new.join("preview-kit").exists() && old.join(r"preview-kit\kit.json").exists());
        assert!(!new.join(r"trash\held").exists() && old.join(r"trash\held\a.pak.from").exists());
        drop(held);
        assert_eq!(move_between(&old, &new).unwrap(), Some(vec![]));
        assert_eq!(read(&new.join(r"previews\busy.webp")), "busy");
        assert!(new.join(r"preview-kit\python\python.exe").exists() && new.join(r"trash\held\a.pak").exists());
        assert!(!old.join("previews").exists() && !old.join("preview-kit").exists());
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_is_moved_never_walked() {
        let (t, old, new) = dirs();
        let shared = t.path().join("shared-cache");
        put(&shared.join("keep.png"), "not ours to move");
        fs::create_dir_all(&old).unwrap();
        let made = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(old.join("previews")).arg(&shared).output().unwrap();
        assert!(made.status.success());
        marker(&new, &["previews"]);
        put(&new.join(r"previews\x.png"), "made since"); // the target exists, so this is a merge
        assert_eq!(move_between(&old, &new).unwrap(), Some(vec![]));
        assert!(shared.join("keep.png").exists() && !new.join(r"previews\keep.png").exists());
    }

    #[test]
    fn only_whole_folder_names_are_rewritten_in_any_case() {
        let (old, new) = (Path::new(r"C:\U\Roaming\Repak-X"), Path::new(r"C:\U\Roaming\repakxtra"));
        let text = r#"{"a": "C:\\U\\Roaming\\Repak-X\\usmap\\m", "b": "C:\\U\\Roaming\\Repak-Xtra\\c", "c": "c:/u/roaming/repak-x/d", "d": "C:\\U\\ROAMING\\REPAK-X\\e"}"#;
        assert_eq!(rewrite(text, old, new), r#"{"a": "C:\\U\\Roaming\\repakxtra\\usmap\\m", "b": "C:\\U\\Roaming\\Repak-Xtra\\c", "c": "C:/U/Roaming/repakxtra/d", "d": "C:\\U\\Roaming\\repakxtra\\e"}"#);
    }
}
