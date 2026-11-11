//! repakxtra: a crash-loop guard for mod details reads. A file that makes the native tool end the process (a stack
//! overflow or out of memory, which nothing can catch) would end the app again at every start, because the Library
//! reads every mod's details on its own. Before each read the mod's path goes into a marker file, cleared after. A
//! marker still there at start names the mod that ended the last run: it is skipped until its files change, and the
//! Library shows it as "Could not be read" with an offer to move it to Recently deleted.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

/// One read at a time, so the marker always names the one mod being read (the tool's own calls are one at a time too).
static READING: Mutex<()> = Mutex::new(());
/// Skipped mods: path without its extension (on and off copies are one mod) -> its fingerprint when it ended a run.
static SKIPPED: Mutex<Option<HashMap<String, (String, String)>>> = Mutex::new(None);

fn dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X")
}

fn key(path: &Path) -> String {
    path.with_extension("").to_string_lossy().to_lowercase()
}

/// The skipped list, after taking in a marker the last run left behind.
fn skipped() -> MutexGuard<'static, Option<HashMap<String, (String, String)>>> {
    let mut s = SKIPPED.lock().unwrap_or_else(|e| e.into_inner());
    if s.is_none() {
        let list = dir().join("repakxtra-unreadable-mods.json");
        let mut map: HashMap<String, (String, String)> =
            std::fs::read(&list).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let marker = dir().join("repakxtra-reading-mod.txt");
        if let Ok(text) = std::fs::read_to_string(&marker) {
            if let Some((fp, path)) = text.split_once('\n') {
                log::warn!("{path} ended the last run while its details were read, so it is skipped until it changes");
                map.insert(key(Path::new(path)), (path.to_string(), fp.to_string()));
                let _ = std::fs::write(&list, serde_json::to_vec(&map).unwrap_or_default());
            }
            let _ = std::fs::remove_file(&marker);
        }
        *s = Some(map);
    }
    s
}

/// Clears the marker when the read ends, also when it returns early or panics.
pub struct Reading(#[allow(dead_code)] MutexGuard<'static, ()>);

impl Drop for Reading {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(dir().join("repakxtra-reading-mod.txt"));
    }
}

/// Call before reading a mod's files and keep the result alive for the whole read. `fingerprint` changes whenever the
/// mod's files change. Err when this mod ended an earlier run and has not changed since.
pub fn reading(path: &Path, fingerprint: &str) -> Result<Reading, String> {
    {
        let mut s = skipped();
        let map = s.as_mut().unwrap();
        match map.get(&key(path)) {
            Some((_, fp)) if fp == fingerprint => {
                return Err(format!("Could not be read: {} closed repakxtra the last time it was read, so it is skipped until it changes", path.display()));
            }
            Some(_) => {
                // changed since (a fixed copy): read it again
                map.remove(&key(path));
                let _ = std::fs::write(dir().join("repakxtra-unreadable-mods.json"), serde_json::to_vec(&*map).unwrap_or_default());
            }
            None => {}
        }
    }
    let guard = READING.lock().unwrap_or_else(|e| e.into_inner());
    let _ = std::fs::create_dir_all(dir());
    let _ = std::fs::write(dir().join("repakxtra-reading-mod.txt"), format!("{fingerprint}\n{}", path.display()));
    // dev builds only: REPAKXTRA_CRASH_READING=<part of a path> ends the app mid-read the way a bad file did, to try this
    #[cfg(debug_assertions)]
    if std::env::var("REPAKXTRA_CRASH_READING").is_ok_and(|p| !p.is_empty() && path.to_string_lossy().contains(&p)) {
        std::process::abort();
    }
    Ok(Reading(guard))
}

/// The skipped mods that are still there, as their current paths (an on or off copy of the one that ended the run).
#[tauri::command]
pub fn unreadable_mods() -> Vec<String> {
    let s = skipped();
    s.iter()
        .flat_map(|m| m.values())
        .filter_map(|(path, _)| {
            let p = Path::new(path);
            ["pak", "bak_repak"].iter().map(|x| p.with_extension(x)).find(|c| c.is_file())
        })
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn on_and_off_copies_are_one_mod() {
        use std::path::Path;
        assert_eq!(super::key(Path::new(r"C:\m\A_P.pak")), super::key(Path::new(r"C:\m\a_p.bak_repak")));
        assert_ne!(super::key(Path::new(r"C:\m\A_P.pak")), super::key(Path::new(r"C:\m\B_P.pak")));
    }
}
