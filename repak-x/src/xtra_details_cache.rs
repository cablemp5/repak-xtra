// repakxtra: the mod details cache survives restarts, so a launch opens a mod's pak again only when its files changed.
// On a slow disk that is the difference between reading every pak in the library at each start and reading none.
use serde::{de::DeserializeOwned, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

static DIRTY: AtomicBool = AtomicBool::new(false);
/// The hash of the character data the app loaded first (`character_data_loaded`), and whether it loaded a different
/// list since.
static LOADED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
static CHANGED: AtomicBool = AtomicBool::new(false);

fn file() -> PathBuf {
    crate::app_dir().join("repakxtra-details-cache.json")
}

/// A change to the code that works out details (REPAKXTRA_DETAILS_LOGIC, a fingerprint of it from build_xtra.rs) or
/// other character data can change what details say, so either one starts the cache over. Not the exe's date: that
/// started it over on every app update, and between a dev and a stable copy sharing it. Not the character data file's
/// change time either: the daily check used to save the same list again, and the new time alone made the next launch
/// read every pak in the library.
fn stamp() -> String {
    stamp_of(env!("REPAKXTRA_DETAILS_LOGIC"), LOADED.get().map(String::as_str))
}

/// Pure.
fn stamp_of(logic: &str, character_data: Option<&str>) -> String {
    format!("{logic}:{}", character_data.unwrap_or("none"))
}

/// Pure: the stamp a save writes. Once the app loaded other character data than at launch, the cache holds entries
/// from before and after it, so every later save gets a stamp no launch has and the next launch starts over, also
/// when the old list is back by then.
fn save_stamp(launch: &str, changed: bool) -> String {
    if changed { format!("{launch}+changed") } else { launch.to_string() }
}

/// The hook where character_data.rs fills the list details are worked out from: at launch (before `load`), after an
/// update, and on a manual refresh. The first list is the launch's stamp, and a different one later marks every save
/// from then on (`save_stamp`).
pub fn character_data_loaded<T: Serialize>(skins: &[T]) {
    let now = list_hash(skins);
    if *LOADED.get_or_init(|| now.clone()) != now {
        CHANGED.store(true, Ordering::Relaxed);
    }
}

/// A list's items as JSON lines in sorted order, so two lists holding the same items in any order compare the same.
fn sorted_lines<T: Serialize>(items: &[T]) -> Option<Vec<String>> {
    let mut lines = items.iter().map(serde_json::to_string).collect::<Result<Vec<String>, _>>().ok()?;
    lines.sort();
    Some(lines)
}

/// Pure: a list by its items in their order ("unreadable" for one that cannot be written as JSON). The order counts:
/// of two rows with one skin id, the later one is the skin a lookup finds.
fn list_hash<T: Serialize>(items: &[T]) -> String {
    use sha2::{Digest, Sha256};
    serde_json::to_vec(items).map_or_else(|_| "unreadable".to_string(), |json| format!("{:x}", Sha256::digest(json)))
}

/// True when the JSON list saved at `path` holds exactly these items, in any order: saving them again would change
/// nothing but the file's change time (and, for character data, leave one more backup file a day).
pub fn same_list<T: Serialize + DeserializeOwned>(path: &Path, items: &[T]) -> bool {
    let saved = std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<Vec<T>>(&b).ok()).and_then(|saved| sorted_lines(&saved));
    saved.is_some() && saved == sorted_lines(items)
}

#[derive(Serialize, serde::Deserialize)]
struct Saved<M> {
    stamp: String,
    entries: M,
}

/// The saved entries (an empty map when the build or character data changed). Those of mods no longer at their path
/// stay until the first full scan, which moves the ones renamed or moved while the app was closed and drops the rest
/// (main_tauri.rs details_after_scan).
pub fn load<T: DeserializeOwned>() -> HashMap<PathBuf, T> {
    std::fs::read(file()).map(|b| parse(&b, &stamp())).unwrap_or_default()
}

/// Pure: the entries in a saved cache, none when it was written under another stamp or cannot be read.
fn parse<T: DeserializeOwned>(bytes: &[u8], stamp: &str) -> HashMap<PathBuf, T> {
    serde_json::from_slice::<Saved<HashMap<PathBuf, T>>>(bytes).ok()
        .filter(|s| s.stamp == stamp)
        .map(|s| s.entries)
        .unwrap_or_default()
}

pub fn mark_dirty() {
    DIRTY.store(true, Ordering::Relaxed);
}

/// True once after each change, so the caller copies the cache only when there is something new to write.
pub fn take_dirty() -> bool {
    DIRTY.swap(false, Ordering::Relaxed)
}

/// Written beside the file, then swapped in, so a crash mid-write never leaves half a cache. Entries of files no
/// longer there stay out (memory keeps them for the session, main_tauri.rs adopt_moved_details).
pub fn save<T: Serialize>(entries: &HashMap<PathBuf, T>) {
    let entries: HashMap<&PathBuf, &T> = entries.iter().filter(|(p, _)| p.exists()).collect();
    let entries = &entries;
    let path = file();
    let tmp = path.with_extension("json.tmp");
    // a path JSON cannot hold (not UTF-8) fails every time: not retried. A disk error is, at the next save.
    let Ok(bytes) = serde_json::to_vec(&Saved { stamp: save_stamp(&stamp(), CHANGED.load(Ordering::Relaxed)), entries }) else { return };
    if std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, &path)).is_err() {
        mark_dirty();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_cache_comes_back_only_under_its_own_stamp() {
        let entries: HashMap<PathBuf, u32> = [(PathBuf::from("C:/mods/a.pak"), 7)].into();
        let bytes = serde_json::to_vec(&Saved { stamp: "1:2".to_string(), entries: &entries }).unwrap();
        assert_eq!(parse::<u32>(&bytes, "1:2"), entries);
        assert!(parse::<u32>(&bytes, "1:3").is_empty(), "a new build or character data starts over");
        assert!(parse::<u32>(b"not json", "1:2").is_empty());
    }

    #[test]
    fn the_stamp_follows_the_character_data_and_the_details_logic() {
        let (one, other) = (list_hash(&["a", "b"]), list_hash(&["a", "c"]));
        assert_eq!(one, list_hash(&["a", "b"]), "the same list, whatever the file's change time or layout");
        assert_ne!(one, other);
        assert_ne!(one, list_hash(&["b", "a"]), "another order can change which of two rows a lookup finds");
        let a = stamp_of("1", Some(&one));
        assert_ne!(a, stamp_of("1", Some(&other)), "other character data starts over");
        assert_ne!(a, stamp_of("2", Some(&one)), "new details logic starts over");
        assert_ne!(a, stamp_of("1", None));
        assert_eq!(save_stamp(&a, false), a, "character data as at launch: the next launch keeps the cache");
        let mixed = save_stamp(&a, true);
        assert!(mixed != a && mixed != stamp_of("1", Some(&other)), "changed while running: no launch has this stamp, whichever list it loads");
    }

    #[test]
    fn a_list_already_on_disk_is_the_same_in_any_order() {
        let path = std::env::temp_dir().join(format!("repakxtra-same-list-{}.json", std::process::id()));
        std::fs::write(&path, "[\n  \"b\",\n  \"a\"\n]").unwrap();
        assert!(same_list(&path, &["a".to_string(), "b".to_string()]));
        assert!(!same_list(&path, &["a".to_string()]), "one fewer");
        assert!(!same_list(&path, &["a".to_string(), "c".to_string()]), "one changed");
        assert!(!same_list(&path, &["a".to_string(), "b".to_string(), "b".to_string()]), "one twice");
        std::fs::write(&path, "not json").unwrap();
        assert!(!same_list(&path, &["a".to_string()]));
        std::fs::remove_file(&path).unwrap();
        assert!(!same_list(&path, &["a".to_string()]), "no file yet");
    }
}
