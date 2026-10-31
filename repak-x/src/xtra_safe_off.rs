//! repakxtra: mods the Mod Updater turned off because they can crash the game stay off. A loadout switch, the Library's
//! switch or a bulk switch all go through toggle_mod, which refuses to turn one on again (custom/safeOff.ts offers Turn on
//! anyway). A mod is known by its .utoc's size and time written, never its name, so a rename keeps the block; a changed
//! file or a game update clears it, and the mod is judged again (xtra_broken.rs).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The prefix of toggle_mod's error for a blocked mod, which custom/safeOff.ts reads: `SAFE_OFF|<reason>`.
pub(crate) const MARK: &str = "SAFE_OFF|";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Off {
    reason: String,
    /// the game's last update when it was turned off
    game: u64,
    /// turned on anyway by hand: no longer blocked
    #[serde(default)]
    allowed: bool,
}

fn store() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X").join("repakxtra-safe-off.json")
}

fn load(store: &Path) -> HashMap<String, Off> {
    std::fs::read_to_string(store).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(store: &Path, all: &HashMap<String, Off>) {
    let tmp = store.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_string(all).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, store);
    }
}

/// The mod's identity, whatever its name: its .utoc's size and time written.
fn key(mod_path: &Path) -> Option<String> {
    let (size, at) = crate::xtra_broken::file_stamp(&mod_path.with_extension("utoc"))?;
    Some(format!("{size}:{at}"))
}

fn remember_in(store: &Path, mod_path: &Path, reason: &str, game: u64) {
    let Some(k) = key(mod_path) else { return };
    let mut all = load(store);
    all.insert(k, Off { reason: reason.to_string(), game, allowed: false });
    save(store, &all);
}

fn blocked_in(store: &Path, mod_path: &Path, game: u64) -> Option<String> {
    let k = key(mod_path)?;
    load(store).get(&k).filter(|o| !o.allowed && o.game == game).map(|o| o.reason.clone())
}

fn allow_in(store: &Path, mod_path: &Path) {
    let Some(k) = key(mod_path) else { return };
    let mut all = load(store);
    if let Some(o) = all.get_mut(&k) {
        o.allowed = true;
        save(store, &all);
    }
}

/// The updater turned the mod at `mod_path` off for `reason`.
pub(crate) fn remember(mods_dir: &Path, mod_path: &Path, reason: &str) {
    remember_in(&store(), mod_path, reason, crate::xtra_broken::game_updated(mods_dir));
}

/// Why the mod at `mod_path` must stay off, if it must.
pub(crate) fn blocked(mods_dir: &Path, mod_path: &Path) -> Option<String> {
    blocked_in(&store(), mod_path, crate::xtra_broken::game_updated(mods_dir))
}

/// Why the mod at `mod_path` is kept off, if it is: an update that makes it safe goes in on (custom/vfx/pipeline.ts).
#[tauri::command]
pub fn xtra_safe_off_kept(mod_path: String, state: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::AppState>>>) -> Option<String> {
    let mods_dir = state.lock().unwrap().game_path.clone();
    blocked(&mods_dir, Path::new(&mod_path))
}

/// Turn on anyway: the mod at `mod_path` may go on again (until the updater turns it off again).
#[tauri::command]
pub fn xtra_safe_off_allow(mod_path: String) {
    allow_in(&store(), Path::new(&mod_path));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blocked_mod_stays_blocked_through_a_rename_until_it_or_the_game_changes() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("off.json");
        let a = dir.path().join("A_9999999_P.bak_repak");
        std::fs::write(a.with_extension("utoc"), b"toc").unwrap();
        remember_in(&store, &a, "May crash", 200);
        assert_eq!(blocked_in(&store, &a, 200).as_deref(), Some("May crash"));
        let renamed = dir.path().join("B_9999999_P.bak_repak");
        std::fs::rename(a.with_extension("utoc"), renamed.with_extension("utoc")).unwrap();
        assert!(blocked_in(&store, &renamed, 200).is_some(), "a rename keeps the block");
        assert_eq!(blocked_in(&store, &renamed, 300), None, "a game update clears it");
        allow_in(&store, &renamed);
        assert_eq!(blocked_in(&store, &renamed, 200), None, "turned on anyway");
        std::fs::write(renamed.with_extension("utoc"), b"toc, a new version").unwrap();
        remember_in(&store, &renamed, "again", 200);
        std::fs::write(renamed.with_extension("utoc"), b"toc, the author's update").unwrap();
        assert_eq!(blocked_in(&store, &renamed, 200), None, "a changed file is judged again");
    }
}
