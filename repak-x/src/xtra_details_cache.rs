// repakxtra: the mod details cache survives restarts, so a launch opens a mod's pak again only when its files changed.
// On a slow disk that is the difference between reading every pak in the library at each start and reading none.
use serde::{de::DeserializeOwned, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

static DIRTY: AtomicBool = AtomicBool::new(false);
/// New character data was saved after this launch's stamp was taken (`character_data_same`).
static CHANGED: AtomicBool = AtomicBool::new(false);
static STAMP: std::sync::OnceLock<String> = std::sync::OnceLock::new();

fn file() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X").join("repakxtra-details-cache.json")
}

/// A change to the code that works out details (REPAKXTRA_DETAILS_LOGIC, a fingerprint of it from build_xtra.rs) or a
/// character data update can change what details say, so either one starts the cache over. Not the exe's date: that
/// started it over on every app update, and between a dev and a stable copy sharing it. Taken once at launch (`load`),
/// and a save after the character data changed gets a stamp of its own (`save_stamp`).
fn stamp() -> String {
    STAMP.get_or_init(|| stamp_of(env!("REPAKXTRA_DETAILS_LOGIC"), std::fs::read(crate::character_data::character_data_path()).ok().as_deref())).clone()
}

/// Pure: the stamp a save writes. Once new character data was saved while the app runs, the cache holds entries from
/// before and after it, so every later save gets a stamp no launch has and the next launch starts over, also when the
/// file is back to its old bytes by then.
fn save_stamp(launch: &str, changed: bool) -> String {
    if changed { format!("{launch}+changed") } else { launch.to_string() }
}

/// The hook in character_data.rs's save: true when the file already holds this list, so the save leaves it alone.
/// A save that goes on after the launch's stamp was taken is new character data for a running app (`save_stamp`). One
/// before it (the bundled list on a first run) is what the stamp then describes.
pub fn character_data_same<T: Serialize + DeserializeOwned>(path: &Path, items: &[T]) -> bool {
    let same = same_list(path, items);
    if !same && STAMP.get().is_some() {
        CHANGED.store(true, Ordering::Relaxed);
    }
    same
}

/// Pure. The character data by its bytes, not its change time: the daily check used to save the same list again, and
/// the new change time alone made the next launch read every pak in the library.
fn stamp_of(logic: &str, character_data: Option<&[u8]>) -> String {
    use sha2::{Digest, Sha256};
    format!("{logic}:{}", character_data.map_or_else(|| "none".to_string(), |b| format!("{:x}", Sha256::digest(b))))
}

/// True when the JSON list saved at `path` holds exactly these items, in any order: saving them again would change
/// nothing but the file's change time (and, for character data, leave one more backup file a day).
fn same_list<T: Serialize + DeserializeOwned>(path: &Path, items: &[T]) -> bool {
    let sorted = |items: &[T]| {
        let mut lines = items.iter().map(serde_json::to_string).collect::<Result<Vec<String>, _>>().ok()?;
        lines.sort();
        Some(lines)
    };
    let saved = std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<Vec<T>>(&b).ok()).and_then(|saved| sorted(&saved));
    saved.is_some() && saved == sorted(items)
}

#[derive(Serialize, serde::Deserialize)]
struct Saved<M> {
    stamp: String,
    entries: M,
}

/// The saved entries of mods that are still there (an empty map when the build or character data changed).
pub fn load<T: DeserializeOwned>() -> HashMap<PathBuf, T> {
    let stamp = stamp(); // at launch also when no cache is saved yet: a first save must not take a later update's stamp
    let mut entries = std::fs::read(file()).map(|b| parse(&b, &stamp)).unwrap_or_default();
    entries.retain(|p, _| p.exists());
    entries
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

/// Written beside the file, then swapped in, so a crash mid-write never leaves half a cache.
pub fn save<T: Serialize>(entries: &HashMap<PathBuf, T>) {
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
    fn the_stamp_follows_the_character_data_bytes_and_the_details_logic() {
        let a = stamp_of("1", Some(b"[1]"));
        assert_eq!(a, stamp_of("1", Some(b"[1]")), "the same bytes, whatever the file's change time");
        assert_ne!(a, stamp_of("1", Some(b"[1,2]")), "new character data starts over");
        assert_ne!(a, stamp_of("2", Some(b"[1]")), "new details logic starts over");
        assert_ne!(a, stamp_of("1", None));
        assert_eq!(save_stamp(&a, false), a, "character data as at launch: the next launch keeps the cache");
        let mixed = save_stamp(&a, true);
        assert!(mixed != a && mixed != stamp_of("1", Some(b"[1,2]")), "changed while running: no launch has this stamp, whichever bytes it finds");
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
