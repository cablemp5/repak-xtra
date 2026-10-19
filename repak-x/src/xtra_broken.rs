//! repakxtra: mods that will not work in the installed game version (custom/brokenMods.ts shows them).
//! Two checks, both from files alone:
//! - broken: every game asset the mod replaces is gone from the game (an update renamed or removed it), so the mod
//!   changes nothing. The game's own asset list is read once per game build and kept in memory.
//! - risky: a Blueprint mod installed before the last game update (on or off: the warning matters before it goes on). Blueprint mods carry whole game classes, and an
//!   update that changes a class layout makes the game crash on them.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::State;

use crate::xtra_crash::asset_key;
use crate::AppState;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Verdict {
    path: String,
    /// "broken" or "risky"
    kind: &'static str,
    reason: String,
}

/// The game's Paks folder above a mods folder (~mods, or a subfolder of it).
fn paks_dir(mods_dir: &Path) -> Option<PathBuf> {
    mods_dir.ancestors().find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Paks"))).map(Path::to_path_buf)
}

/// The game's own containers (the .utoc files directly in Paks, never the mods below it).
fn game_containers(paks: &Path) -> Vec<(PathBuf, u64, u64)> {
    let mut out: Vec<_> = std::fs::read_dir(paks)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("utoc")))
        .filter_map(|p| {
            let m = std::fs::metadata(&p).ok()?;
            let at = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
            Some((p, m.len(), at))
        })
        .collect();
    out.sort();
    out
}

/// Names, sizes and dates of the containers: changes whenever an update rewrites one.
fn build_key(containers: &[(PathBuf, u64, u64)]) -> String {
    containers
        .iter()
        .map(|(p, len, at)| format!("{}:{len}:{at}", p.file_name().unwrap_or_default().to_string_lossy()))
        .collect::<Vec<_>>()
        .join("|")
}

/// Packages only (.uasset, .umap): their sidecars (.uexp, .ubulk) follow them, raw files are not game assets.
fn is_package(file: &str) -> bool {
    let f = file.to_ascii_lowercase();
    f.ends_with(".uasset") || f.ends_with(".umap")
}

/// An asset's key without its mount root: a mod lists plugin content as "MarvelGAS/Marvel/VFX/..." where the game's own
/// listing says "/Game/Marvel/VFX/...", so both compare as "marvel/vfx/...".
fn match_key(file: &str) -> String {
    let k = asset_key(file);
    k.split_once('/').map(|(_, rest)| rest.to_string()).unwrap_or(k)
}

static GAME_ASSETS: Mutex<Option<(String, Arc<HashSet<String>>)>> = Mutex::new(None);

/// Every package the installed game has, as asset keys: read from every container once per game build (about 6 s for
/// 570,000 packages) and kept in memory. Not saved: the list is close to 50 MB as text. None when nothing could be read.
fn game_assets(paks: &Path) -> Option<Arc<HashSet<String>>> {
    let containers = game_containers(paks);
    if containers.is_empty() {
        return None;
    }
    let key = build_key(&containers);
    if let Some((k, set)) = GAME_ASSETS.lock().unwrap().as_ref() {
        if *k == key {
            return Some(set.clone());
        }
    }
    let mut set = HashSet::new();
    for (utoc, ..) in &containers {
        match crate::utoc_utils::try_read_utoc(utoc) {
            Ok(entries) => set.extend(entries.iter().map(|e| &e.file_path).filter(|f| is_package(f)).map(|f| match_key(f))),
            Err(e) => log::warn!("[broken] could not read {}: {e}", utoc.display()),
        }
    }
    if set.is_empty() {
        return None; // the tool failed on every container: no verdicts rather than every mod "broken"
    }
    let set = Arc::new(set);
    *GAME_ASSETS.lock().unwrap() = Some((key, set.clone()));
    Some(set)
}

/// The verdict for one mod, or None when it looks fine. Pure: the facts come in, the words go out.
fn judge(path: &str, files: &[String], galacta: bool, has_blueprint: bool, installed: u64, game_updated: u64, game: &HashSet<String>) -> Option<Verdict> {
    let packages: Vec<String> = files.iter().filter(|f| is_package(f)).map(|f| match_key(f)).collect();
    // Project Galacta skins bring their own new files (meshes, textures, configs) by design: never "broken" for that
    if !galacta && !packages.is_empty() && !packages.iter().any(|k| game.contains(k)) {
        let n = packages.len();
        return Some(Verdict {
            path: path.to_string(),
            kind: "broken",
            reason: format!(
                "None of the {n} game file{} it replaces exist in this game version. An update renamed or removed {}, so the mod changes nothing.",
                if n == 1 { "" } else { "s" },
                if n == 1 { "it" } else { "them" }
            ),
        });
    }
    // On or off: the warning matters most before a loadout switches it on
    if has_blueprint && installed > 0 && installed < game_updated {
        return Some(Verdict {
            path: path.to_string(),
            kind: "risky",
            reason: "A Blueprint mod installed before the last game update. Updates often change the game classes it carries, and the game can crash on it. Turn it off if the game crashes, and look for an updated version.".into(),
        });
    }
    None
}

/// The mods (of `mod_paths`) that will not work, or may crash, in the installed game. Empty when the game's assets
/// cannot be read (no game folder, a custom mods folder outside the game).
#[tauri::command]
pub async fn xtra_broken_mods(mod_paths: Vec<String>, state: State<'_, Arc<Mutex<AppState>>>) -> Result<Vec<Verdict>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mods_dir = state.lock().unwrap().game_path.clone();
        let Some(paks) = paks_dir(&mods_dir) else { return Vec::new() };
        let Some(game) = game_assets(&paks) else { return Vec::new() };
        let game_updated = game_containers(&paks).iter().map(|c| c.2).max().unwrap_or(0);
        mod_paths
            .iter()
            .filter_map(|p| {
                let path = PathBuf::from(p);
                let details = crate::compute_mod_details(&path, &state).ok()?;
                let installed = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
                judge(p, &details.files, details.mod_type.contains("Project Galacta"), details.has_blueprint, installed, game_updated, &game)
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game() -> HashSet<String> {
        ["/Game/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset"].iter().map(|f| match_key(f)).collect()
    }
    fn v(files: &[&str]) -> Vec<String> {
        files.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_mod_whose_targets_are_gone_is_broken() {
        let files = v(&["../../../Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_OLD.uasset", "x/SK_1026_OLD.uexp"]);
        assert_eq!(judge("m", &files, false, false, 1, 2, &game()).map(|j| j.kind), Some("broken"));
    }

    #[test]
    fn a_mod_with_one_live_target_is_fine() {
        let files = v(&["Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset", "Marvel/Content/New/T_Extra.uasset"]);
        assert_eq!(judge("m", &files, false, false, 1, 2, &game()), None);
    }

    #[test]
    fn galacta_skins_add_new_files_and_are_not_broken() {
        let files = v(&["Marvel/Content/Marvel/Characters/1026/1026001/Textures/T_Cat_New_D.uasset"]);
        assert_eq!(judge("m.pak", &files, true, false, 1, 2, &game()), None);
        assert_eq!(judge("m.pak", &files, false, false, 1, 2, &game()).map(|j| j.kind), Some("broken"), "the same files without the Galacta tag");
    }

    #[test]
    fn plugin_content_matches_the_games_spelling() {
        let game: HashSet<String> = [match_key("../../../Marvel/Plugins/MarvelGAS/Content/Marvel/VFX/Particles/NS_A.uasset")].into();
        assert_eq!(judge("m.pak", &v(&["MarvelGAS/Marvel/VFX/Particles/NS_A.uasset"]), false, false, 1, 2, &game), None);
    }

    #[test]
    fn raw_only_mods_get_no_verdict() {
        assert_eq!(judge("m", &v(&["Marvel/Content/WwiseAudio/Windows/123.wem"]), false, false, 1, 2, &game()), None);
    }

    #[test]
    fn old_blueprint_mods_are_risky_new_ones_are_not() {
        let files = v(&["Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset"]);
        assert_eq!(judge("m.pak", &files, false, true, 100, 200, &game()).map(|j| j.kind), Some("risky"));
        assert_eq!(judge("m.bak_repak", &files, false, true, 100, 200, &game()).map(|j| j.kind), Some("risky"), "off too: it crashes once a loadout turns it on");
        assert_eq!(judge("m", &files, false, true, 300, 200, &game()), None);
    }

    /// Manual check on a real game: REPAKXTRA_PAKS=<...\Content\Paks> cargo test real_game -- --ignored --nocapture
    /// (UAssetTool.dll must sit beside the test binary). Prints how long the game's list took and each mod's verdict.
    #[test]
    #[ignore]
    fn real_game() {
        let paks = PathBuf::from(std::env::var("REPAKXTRA_PAKS").expect("REPAKXTRA_PAKS"));
        let t = std::time::Instant::now();
        let game = game_assets(&paks).expect("game assets");
        println!("game packages: {} in {:?}", game.len(), t.elapsed());
        let t = std::time::Instant::now();
        let again = game_assets(&paks).expect("cached");
        println!("second read: {} in {:?}", again.len(), t.elapsed());
        for e in std::fs::read_dir(paks.join("~mods")).unwrap().flatten() {
            let p = e.path();
            if !p.extension().is_some_and(|x| x == "pak" || x == "bak_repak") {
                continue;
            }
            let files = crate::xtra_crash::mod_files(&p);
            let hits = files.iter().filter(|f| is_package(f) && game.contains(&match_key(f))).count();
            let pk = files.iter().filter(|f| is_package(f)).count();
            let v = judge(&p.to_string_lossy(), &files, false, false, 1, 0, &game).map(|v| v.kind).unwrap_or("ok");
            println!("{v:7} {hits:4}/{pk:<4} {}", p.file_name().unwrap().to_string_lossy());
        }
    }

    #[test]
    fn paks_is_found_above_the_mods_folder() {
        let p = Path::new(r"C:\Steam\MarvelRivals\MarvelGame\Marvel\Content\Paks\~mods\Sub");
        assert_eq!(paks_dir(p), Some(PathBuf::from(r"C:\Steam\MarvelRivals\MarvelGame\Marvel\Content\Paks")));
        assert_eq!(paks_dir(Path::new(r"D:\MyMods")), None);
    }
}
