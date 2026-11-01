// repakxtra: the mod details cache survives restarts, so a launch opens a mod's pak again only when its files changed.
// On a slow disk that is the difference between reading every pak in the library at each start and reading none.
use serde::{de::DeserializeOwned, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

static DIRTY: AtomicBool = AtomicBool::new(false);

fn file() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X").join("repakxtra-details-cache.json")
}

/// A change to the code that works out details (REPAKXTRA_DETAILS_LOGIC, a fingerprint of it from build_xtra.rs) or a
/// character data update can change what details say, so either one starts the cache over. Not the exe's date: that
/// started it over on every app update, and between a dev and a stable copy sharing it. Taken once at launch: entries
/// computed after a character data update while the app runs are saved under the launch's stamp, so the next launch
/// (which sees the newer file) starts over instead of trusting them.
fn stamp() -> String {
    static STAMP: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    STAMP.get_or_init(launch_stamp).clone()
}

fn launch_stamp() -> String {
    let mtime = |p: Option<PathBuf>| {
        p.and_then(|p| std::fs::metadata(p).ok()).and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs())
    };
    format!("{}:{}", env!("REPAKXTRA_DETAILS_LOGIC"), mtime(Some(crate::character_data::character_data_path())))
}

#[derive(Serialize, serde::Deserialize)]
struct Saved<M> {
    stamp: String,
    entries: M,
}

/// The saved entries of mods that are still there (an empty map when the build or character data changed).
pub fn load<T: DeserializeOwned>() -> HashMap<PathBuf, T> {
    let mut entries = std::fs::read(file()).map(|b| parse(&b, &stamp())).unwrap_or_default();
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
    let Ok(bytes) = serde_json::to_vec(&Saved { stamp: stamp(), entries }) else { return };
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
}
