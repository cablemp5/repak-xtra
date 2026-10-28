//! repakxtra: notices a game update while repakxtra is open or since it last ran (custom/gameUpdate.ts shows the toast).
//! The game's newest container time (xtra_broken::game_updated) is compared with the last one the app showed, kept in
//! %APPDATA%\Repak-X\repakxtra-game.json. The first run only stores it, so a fresh install shows no notice.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

#[derive(Serialize, Debug, PartialEq)]
pub struct GameUpdate {
    /// when the game was updated now, and when it was at the last notice (unix seconds)
    updated: u64,
    previous: u64,
}

#[derive(Serialize, Deserialize)]
struct Seen {
    updated: u64,
}

fn store() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X").join("repakxtra-game.json")
}

fn load(store: &Path) -> Option<u64> {
    std::fs::read_to_string(store).ok().and_then(|t| serde_json::from_str::<Seen>(&t).ok()).map(|s| s.updated)
}

fn save(store: &Path, updated: u64) -> Result<(), String> {
    if let Some(dir) = store.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = store.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(&Seen { updated }).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, store).map_err(|e| e.to_string())
}

/// Pure: the notice to show, and a value to store right away (only on the first run, which shows nothing).
fn decide(stored: Option<u64>, current: u64) -> (Option<GameUpdate>, Option<u64>) {
    match stored {
        _ if current == 0 => (None, None), // no game folder, or its files cannot be read
        None => (None, Some(current)),
        Some(previous) if current > previous => (Some(GameUpdate { updated: current, previous }), None),
        Some(_) => (None, None), // the same build, or an older one put back
    }
}

fn check_at(store: &Path, current: u64) -> Option<GameUpdate> {
    let (notice, first) = decide(load(store), current);
    if let Some(v) = first {
        if let Err(e) = save(store, v) {
            log::warn!("[game] could not save {}: {e}", store.display());
        }
    }
    notice
}

/// The game update since the last notice, if any.
#[tauri::command]
pub async fn xtra_game_update_check(state: State<'_, Arc<Mutex<AppState>>>) -> Result<Option<GameUpdate>, String> {
    let mods_dir = state.lock().unwrap().game_path.clone();
    tauri::async_runtime::spawn_blocking(move || check_at(&store(), crate::xtra_broken::game_updated(&mods_dir))).await.map_err(|e| e.to_string())
}

/// The notice for `updated` was shown: it never repeats.
#[tauri::command(async)]
pub fn xtra_game_update_seen(updated: u64) -> Result<(), String> {
    save(&store(), updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_decision() {
        assert_eq!(decide(None, 200), (None, Some(200)), "first run: silent, stored");
        assert_eq!(decide(Some(100), 200), (Some(GameUpdate { updated: 200, previous: 100 }), None), "newer: shown");
        assert_eq!(decide(Some(200), 200), (None, None), "same: not shown");
        assert_eq!(decide(Some(300), 200), (None, None), "older: ignored");
        assert_eq!(decide(Some(100), 0), (None, None), "unknown: ignored");
        assert_eq!(decide(None, 0), (None, None), "unknown on the first run: nothing stored");
    }

    #[test]
    fn a_seen_update_is_not_shown_again() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("sub").join("repakxtra-game.json");
        assert_eq!(check_at(&store, 100), None, "first run");
        assert_eq!(load(&store), Some(100), "stored on the first run, folder made");
        assert_eq!(check_at(&store, 200), Some(GameUpdate { updated: 200, previous: 100 }));
        assert_eq!(check_at(&store, 200), Some(GameUpdate { updated: 200, previous: 100 }), "until it is seen");
        save(&store, 200).unwrap();
        assert_eq!(check_at(&store, 200), None, "seen: never again");
        assert!(!store.with_extension("json.tmp").exists(), "the temporary file is renamed away");
    }
}
