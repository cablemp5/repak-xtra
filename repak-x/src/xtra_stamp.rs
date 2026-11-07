//! repakxtra: what an update made by the Mod Updater was built for. Cooked files carry no game build, so the checks fall
//! back to the file's date, which a copy, a reinstall or a repack can change. Each update repakxtra places is stamped
//! with the game build, the game's last update and the USMAP build it was made with, kept in the app's own store (no
//! file beside the mod for the game to trip on). The stamp follows the file, not its name (its .utoc's size and time
//! written, which a rename, a switch on or off and a copy keep), and the checks read "made for this game" from it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub(crate) struct Stamp {
    /// the game's newest patch build then (0 when its containers name none)
    pub game_build: u64,
    /// when the game was last updated then (seconds): what the date checks compare with
    pub game_updated: u64,
    /// the USMAP's game build
    pub usmap_build: u64,
}

fn store() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X").join("repakxtra-made-for.json")
}

fn key(mod_path: &Path) -> Option<String> {
    let (size, at) = crate::xtra_broken::file_stamp(&mod_path.with_extension("utoc"))?;
    Some(format!("{size}:{at}"))
}

fn load(store: &Path) -> HashMap<String, Stamp> {
    std::fs::read_to_string(store).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn put(store: &Path, mod_path: &Path, s: Stamp) -> Result<(), String> {
    let k = key(mod_path).ok_or_else(|| format!("{} is not there", mod_path.display()))?;
    let mut all = load(store);
    all.insert(k, s);
    let tmp = store.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(&all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, store).map_err(|e| e.to_string())
}

fn get(store: &Path, mod_path: &Path) -> Option<Stamp> {
    load(store).get(&key(mod_path)?).copied()
}

/// The stamp of the mod at `mod_path`, if repakxtra made it.
pub(crate) fn of(mod_path: &Path) -> Option<Stamp> {
    get(&store(), mod_path)
}

/// Every stamp, for a caller that looks up many mods (xtra_broken_mods): the store read once, not twice a mod.
pub(crate) fn load_all() -> HashMap<String, Stamp> {
    load(&store())
}

/// `of`, from stamps load_all read.
pub(crate) fn of_in(all: &HashMap<String, Stamp>, mod_path: &Path) -> Option<Stamp> {
    all.get(&key(mod_path)?).copied()
}

/// When the mod at `mod_path` counts as made: its file's time, or the game update it was stamped for when that is later
/// (an update copied or repacked since keeps its stamp, so it never looks older than the game it was made for).
pub(crate) fn made(mod_path: &Path, written: u64) -> u64 {
    of(mod_path).map_or(written, |s| written.max(s.game_updated))
}

/// pipeline.ts, once an update is placed: stamps it with the game and the USMAP it was made with.
#[tauri::command(async)]
pub fn xtra_vfx_stamp(mod_path: String, game_paks: String, usmap_path: String) -> Result<(), String> {
    let paks = Path::new(&game_paks);
    let s = Stamp {
        game_build: crate::xtra_vfx::game_cl(paks).unwrap_or(0),
        game_updated: crate::xtra_broken::game_containers(paks).iter().map(|c| c.2).max().unwrap_or(0),
        usmap_build: crate::xtra_niagara::usmap_build(&usmap_path).unwrap_or(0),
    };
    put(&store(), Path::new(&mod_path), s)
}

/// A mod the Mod Updater made, whether it left files out (_PARTIAL), and whether it was for the installed game (its
/// Updated tag) or an older one (flagged again, it reads Needs update).
#[derive(Serialize)]
pub struct Made {
    path: String,
    partial: bool,
    current: bool,
}

/// brokenMods.ts: which of `mod_paths` the Mod Updater made.
#[tauri::command(async)]
pub fn xtra_made_mods(mod_paths: Vec<String>, state: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::AppState>>>) -> Vec<Made> {
    let mods_dir = state.lock().unwrap().game_path.clone();
    let now = crate::xtra_broken::game_updated(&mods_dir);
    let all = load_all();
    mod_paths
        .into_iter()
        .filter_map(|p| {
            let s = of_in(&all, Path::new(&p))?;
            let stem = Path::new(&p).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            Some(Made { partial: crate::xtra_vfx::partial_stem(&stem).eq_ignore_ascii_case(&stem), current: now > 0 && s.game_updated >= now, path: p })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stamp_follows_the_file_through_a_rename_not_a_new_version() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("made.json");
        let a = dir.path().join("A_9999999_P.pak");
        std::fs::write(a.with_extension("utoc"), b"toc").unwrap();
        let s = Stamp { game_build: 3984769, game_updated: 500, usmap_build: 3984769 };
        put(&store, &a, s).unwrap();
        let b = dir.path().join("A_BROKEN_9999999_P.bak_repak");
        std::fs::rename(a.with_extension("utoc"), b.with_extension("utoc")).unwrap();
        assert_eq!(get(&store, &b), Some(s), "renamed and switched off");
        std::fs::write(b.with_extension("utoc"), b"toc, another version").unwrap();
        assert_eq!(get(&store, &b), None, "a changed file is not the one stamped");
    }
}
