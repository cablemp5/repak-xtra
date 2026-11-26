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
    // the trash first: a swap journal's path into it is rewritten only once its entry is in the new folder
    m.pending.sort_by_key(|n| !n.eq_ignore_ascii_case("trash"));
    m.pending.retain(|n| !move_name(old, new, n, since));
    write_atomic(&marker, &serde_json::to_string(&m)?)?;
    Ok(Some(m.pending))
}

/// True when nothing of `name` is left to move and the paths it stores point at the new folder.
fn move_name(old: &Path, new: &Path, name: &str, since: Option<SystemTime>) -> bool {
    let (from, to) = (old.join(name), new.join(name));
    let lower = name.to_ascii_lowercase();
    let moved = if gone(&from) {
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
    // also after a part moved: the files that did are rewritten now (a journal that moved must name the new trash)
    let rewritten = rewrite_paths(old, new, &lower);
    moved && rewritten
}

/// Not there at all: any other error (denied, in use) is not "moved".
fn gone(p: &Path) -> bool {
    fs::symlink_metadata(p).is_err_and(|e| e.kind() == io::ErrorKind::NotFound)
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
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(e) => {
                done &= e.kind() == io::ErrorKind::NotFound; // gone: a payload moved with its record
                continue;
            }
        };
        let dest = to.join(&name);
        if meta.is_dir() {
            let Ok(files) = fs::read_dir(&path) else {
                done = false; // unreadable now: never taken for "not ours"
                continue;
            };
            let has_record = files.flatten().any(|f| f.file_name().to_string_lossy().ends_with(".from"));
            let theirs = match fs::symlink_metadata(path.join("meta.json")) {
                Ok(_) => true,
                Err(e) if e.kind() == io::ErrorKind::NotFound => false,
                Err(_) => {
                    done = false; // cannot tell whose it is now
                    continue;
                }
            };
            if !theirs && (has_record || dest.exists()) {
                done &= move_entry(&path, &dest, since);
            }
        } else if let Some(payload) = name.strip_suffix(".from") {
            if late(&meta, since) {
                continue; // an older build's deletion: its record is new, its file keeps the mod's old date, both stay
            }
            let file = from.join(payload);
            let file_moved = gone(&file) || move_entry(&file, &to.join(payload), since);
            // the record follows once the file is in the new folder, also when its old copy could not be deleted yet
            let record_moved = (file_moved || to.join(payload).exists()) && move_entry(&path, &dest, since);
            done &= file_moved && record_moved;
        } else if to.join(format!("{name}.from")).exists() && gone(&from.join(format!("{name}.from"))) {
            // a file whose record moved before (its own record still here means it is that record's, handled above)
            done &= move_entry(&path, &dest, since);
        }
    }
    done
}

/// A trash entry: renamed whole, or merged into the part a run before moved. One an older build made after the move
/// started stays in the old folder.
fn move_entry(from: &Path, to: &Path, since: Option<SystemTime>) -> bool {
    if fs::symlink_metadata(from).is_ok_and(|m| late(&m, since)) {
        return true;
    }
    if fs::symlink_metadata(to).is_ok() { move_over(from, to, since, false) } else { rename_whole(from, to) }
}

/// Written (a file) or made (a folder) after the move started: an older build's, so it stays in the old folder.
fn late(meta: &fs::Metadata, since: Option<SystemTime>) -> bool {
    let at = if meta.is_dir() { meta.created() } else { meta.modified() };
    since.is_some_and(|s| at.is_ok_and(|t| t > s))
}

/// Renames `from` to `to`. On another drive it copies into a staging name first and puts it in place only once the
/// whole copy is there (a half-copied trash entry or kit never shows), then deletes the original. False when it could
/// not (in use).
fn rename_whole(from: &Path, to: &Path) -> bool {
    match fs::rename(from, to) {
        Ok(()) => true,
        Err(e) if e.raw_os_error() == Some(ERROR_NOT_SAME_DEVICE) => {
            let name = to.file_name().unwrap_or_default().to_string_lossy();
            let stage = to.with_file_name(format!("{name}.{}.repakxtra-copying", std::process::id()));
            let _ = remove_any(&stage);
            if copy_over(from, &stage).is_err() || fs::rename(&stage, to).is_err() {
                let _ = remove_any(&stage);
                return false;
            }
            remove_copied(from, to) // what was written since the copy stays, and a retry finds `to` and leaves it
        }
        Err(_) => false,
    }
}

/// Deletes the parts of `from` whose copy is in `to` (same size and time, fs::copy keeps the time), never a file
/// written since the copy. True when `from` is gone.
fn remove_copied(from: &Path, to: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(from) else { return true };
    if meta.is_dir() && !meta.file_type().is_symlink() {
        for e in fs::read_dir(from).into_iter().flatten().flatten() {
            remove_copied(&e.path(), &to.join(e.file_name()));
        }
        return fs::remove_dir(from).is_ok();
    }
    fs::metadata(to).is_ok_and(|m| m.is_file() && m.len() == meta.len() && m.modified().ok() == meta.modified().ok())
        && fs::remove_file(from).is_ok()
}

/// Compared a block at a time, so a large mod never sits in memory twice.
fn same_content(a: &Path, b: &Path) -> bool {
    use std::io::Read;
    let len = |p: &Path| fs::metadata(p).map(|m| m.len()).ok();
    if len(a).is_none() || len(a) != len(b) {
        return false;
    }
    let (Ok(mut x), Ok(mut y)) = (fs::File::open(a), fs::File::open(b)) else { return false };
    let (mut bx, mut by) = (vec![0u8; 1 << 16], vec![0u8; 1 << 16]);
    loop {
        let n = match x.read(&mut bx) {
            Ok(n) => n,
            Err(_) => return false,
        };
        if n == 0 {
            return y.read(&mut by[..1]).is_ok_and(|m| m == 0); // and `b` ends there too
        }
        if y.read_exact(&mut by[..n]).is_err() || bx[..n] != by[..n] {
            return false;
        }
    }
}

fn remove_any(p: &Path) -> io::Result<()> {
    if fs::symlink_metadata(p)?.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) }
}

/// Moves `from` to `to`. A folder that cannot be renamed whole (a file in it is in use), or whose `to` exists already
/// (a retry, after a run made it), merges file by file, never replacing a file `to` has: at the top level the old file
/// is kept beside it as `<name>.from-Repak-X`, inside a folder the new one wins and the old is left. Links (junctions)
/// are moved, never walked. Files written after the move started are an older build's and stay. True when nothing of
/// `from` is left to move.
fn move_over(from: &Path, to: &Path, since: Option<SystemTime>, top: bool) -> bool {
    let meta = match fs::symlink_metadata(from) {
        Ok(meta) => meta,
        Err(e) => return e.kind() == io::ErrorKind::NotFound,
    };
    let folder = meta.is_dir() && !meta.file_type().is_symlink();
    if late(&meta, since) {
        return true;
    }
    if fs::symlink_metadata(to).is_err() {
        // a retry walks folders instead of renaming them whole, so what an older build wrote into one since stays
        if !(folder && since.is_some()) && rename_whole(from, to) {
            return true;
        }
        if !folder || fs::create_dir_all(to).is_err() {
            return false;
        }
    } else if !folder {
        if !meta.file_type().is_symlink() && same_content(from, to) {
            return fs::remove_file(from).is_ok(); // a copy across drives that could not delete its original
        }
        let beside = to.with_file_name(format!("{}.from-Repak-X", to.file_name().unwrap_or_default().to_string_lossy()));
        return !top || meta.file_type().is_symlink() || fs::symlink_metadata(&beside).is_ok() || rename_whole(from, &beside);
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
    let mut done = true;
    for f in &files {
        let text = match fs::read_to_string(f) {
            Ok(text) => text,
            Err(e) => {
                done &= e.kind() == io::ErrorKind::NotFound;
                continue;
            }
        };
        // a swap journal names its trash entry, which recover() puts files back from: it points at the new folder once
        // the entry is there, and until then keeps naming the old one
        let entry = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v.get("trash")?.as_str().map(str::to_string));
        if name == "swap-journal" && entry.is_some_and(|t| !gone(Path::new(&t)) && moved_to(&t, old, new).is_some_and(|n| !n.exists())) {
            done = false;
            continue;
        }
        let fixed = rewrite(&text, old, new);
        done &= fixed == text || write_atomic(f, &fixed).is_ok();
    }
    done
}

/// Where a path under the old folder is in the new one (None for a path outside it).
fn moved_to(path: &str, old: &Path, new: &Path) -> Option<PathBuf> {
    let o = old.to_string_lossy();
    let rest = path.get(o.len()..).filter(|_| path.len() > o.len() && path[..o.len()].eq_ignore_ascii_case(&o))?;
    rest.strip_prefix(&['\\', '/'][..]).map(|r| new.join(r))
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

/// Written whole to a temporary file and synced first, so a crash never leaves half a marker (read as nothing to move).
fn write_atomic(path: &Path, text: &str) -> io::Result<()> {
    use std::io::Write;
    // this process's own name: two starts at the same moment never write into one temporary file
    let tmp = path.with_file_name(format!("{}.{}.tmp", path.file_name().unwrap_or_default().to_string_lossy(), std::process::id()));
    let mut f = fs::File::create(&tmp)?;
    f.write_all(text.as_bytes())?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
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

    /// A marker as a run that stopped midway leaves it, started now: every old file made before this call predates it.
    fn marker(new: &Path, pending: &[&str]) {
        std::thread::sleep(Duration::from_millis(100)); // file times trail the clock by up to a timer tick (15.6 ms)
        let started = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
        put(&new.join(MARKER), &serde_json::to_string(&Marker { started, pending: pending.iter().map(|s| s.to_string()).collect() }).unwrap());
        std::thread::sleep(Duration::from_millis(100));
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
        put(&new.join("labels.json"), "labels");
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
        // the same file already in place (a copy that could not delete its original) is not kept twice
        assert!(!old.join("labels.json").exists() && !new.join("labels.json.from-Repak-X").exists());
    }

    #[test]
    fn what_an_old_build_writes_after_the_move_started_stays_behind() {
        let (_t, old, new) = dirs();
        put(&old.join(r"previews\before.png"), "before");
        put(&old.join(r"trash\held\a.pak"), "mod");
        put(&old.join(r"trash\held\a.pak.from"), r"C:\mods\a.pak");
        put(&old.join(r"sounds\mine.wav"), "mine");
        // an earlier pair of this name moved already, then an older build trashes the same mod again after the start
        put(&new.join(r"trash\flat_late.pak"), "the mod, with its old date");
        put(&new.join(r"trash\flat_late.pak.from"), r"C:\mods\flat_late.pak");
        put(&old.join(r"trash\flat_late.pak"), "the mod, with its old date");
        marker(&new, &["previews", "trash", "sounds"]);
        put(&old.join(r"sounds\theirs.wav"), "an old build's sound");
        put(&old.join(r"previews\after.png"), "an old build's render");
        put(&old.join(r"previews\after.3d\model.glb"), "an old build's folder");
        put(&old.join(r"trash\later\b.pak"), "an old build's deletion");
        put(&old.join(r"trash\later\b.pak.from"), r"C:\mods\b.pak");
        put(&old.join(r"trash\flat_late.pak.from"), r"C:\mods\flat_late.pak");
        put(&new.join(r"previews\x.png"), "made since");
        assert_eq!(move_between(&old, &new).unwrap(), Some(vec![]));
        assert!(new.join(r"previews\before.png").exists() && new.join(r"trash\held\a.pak").exists());
        assert!(!new.join(r"previews\after.png").exists() && old.join(r"previews\after.png").exists());
        assert!(!new.join(r"previews\after.3d").exists() && old.join(r"previews\after.3d\model.glb").exists());
        assert!(!new.join(r"trash\later").exists() && old.join(r"trash\later\b.pak").exists());
        assert!(old.join(r"trash\flat_late.pak.from").exists() && old.join(r"trash\flat_late.pak").exists(), "the late pair stays together");
        // a folder the cut-off run never reached is walked on the retry, not renamed whole
        assert!(new.join(r"sounds\mine.wav").exists() && !new.join(r"sounds\theirs.wav").exists() && old.join(r"sounds\theirs.wav").exists());
    }

    #[test]
    fn a_trash_entry_split_by_an_earlier_run_still_moves() {
        let (_t, old, new) = dirs();
        // the earlier run moved the records but not the files (in use): a folder entry and a flat pair
        put(&old.join(r"trash\split\a.pak"), "mod");
        put(&new.join(r"trash\split\a.pak.from"), r"C:\mods\a.pak");
        put(&old.join(r"trash\flat.pak"), "mod");
        put(&new.join(r"trash\flat.pak.from"), r"C:\mods\flat.pak");
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
        assert_eq!(move_between(&old, &new).unwrap(), Some(vec!["trash".to_string(), "preview-kit".to_string(), "previews".to_string()]));
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

    #[cfg(windows)]
    #[test]
    fn the_swap_journal_keeps_its_trash_paths_until_the_trash_moved() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_t, old, new) = dirs();
        let old_json = old.to_string_lossy().replace('\\', r"\\");
        put(&old.join(r"trash\swap\a.pak"), "mod");
        put(&old.join(r"trash\swap\a.pak.from"), r"C:\mods\a.pak");
        put(&old.join(r"trash\free\b.pak"), "mod");
        put(&old.join(r"trash\free\b.pak.from"), r"C:\mods\b.pak");
        put(&old.join(r"swap-journal\j.json"), &format!(r#"{{"trash": "{old_json}\\trash\\swap"}}"#));
        put(&old.join(r"swap-journal\k.json"), &format!(r#"{{"trash": "{old_json}\\trash\\free"}}"#));
        let held = fs::OpenOptions::new().read(true).share_mode(0).open(old.join(r"trash\swap\a.pak")).unwrap();
        assert_eq!(move_between(&old, &new).unwrap(), Some(vec!["trash".to_string(), "swap-journal".to_string()]));
        // the held entry's journal still names the old trash, where its files are; the other one follows its entry
        let new_json = new.to_string_lossy().replace('\\', r"\\");
        assert!(read(&new.join(r"swap-journal\j.json")).contains(&format!(r"{old_json}\\trash")));
        assert!(read(&new.join(r"swap-journal\k.json")).contains(&format!(r"{new_json}\\trash\\free")));
        drop(held);
        assert_eq!(move_between(&old, &new).unwrap(), Some(vec![]));
        assert!(read(&new.join(r"swap-journal\j.json")).contains(&format!(r"{new_json}\\trash\\swap")));
        assert!(new.join(r"trash\swap\a.pak").exists());
    }

    #[test]
    fn only_whole_folder_names_are_rewritten_in_any_case() {
        let (old, new) = (Path::new(r"C:\U\Roaming\Repak-X"), Path::new(r"C:\U\Roaming\repakxtra"));
        assert_eq!(moved_to(r"c:\u\roaming\repak-x\trash\E", old, new), Some(PathBuf::from(r"C:\U\Roaming\repakxtra\trash\E")));
        assert_eq!(moved_to(r"C:\U\Roaming\Repak-Xtra\trash", old, new), None);
        assert_eq!(moved_to(r"C:\mods\a.pak", old, new), None);
        let text = r#"{"a": "C:\\U\\Roaming\\Repak-X\\usmap\\m", "b": "C:\\U\\Roaming\\Repak-Xtra\\c", "c": "c:/u/roaming/repak-x/d", "d": "C:\\U\\ROAMING\\REPAK-X\\e"}"#;
        assert_eq!(rewrite(text, old, new), r#"{"a": "C:\\U\\Roaming\\repakxtra\\usmap\\m", "b": "C:\\U\\Roaming\\Repak-Xtra\\c", "c": "C:/U/Roaming/repakxtra/d", "d": "C:\\U\\Roaming\\repakxtra\\e"}"#);
    }
}
