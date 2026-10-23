//! repakxtra: mods that will not work in the installed game version (custom/brokenMods.ts shows them).
//! Two checks, both from files alone:
//! - broken: every game asset the mod replaces is gone from the game (an update renamed or removed it), so the mod
//!   changes nothing. The game's own asset list is read once per game build and kept in memory.
//! - vfx: a VFX mod made before a game update that rewrote game files it replaces (on or off). Its effects can look wrong
//!   or crash the game until it is rebuilt on the new files (custom/vfx/, the VFX Updater).
//! - risky: a Blueprint mod installed before the last game update (on or off: the warning matters before it goes on). Blueprint mods carry whole game classes, and an
//!   update that changes a class layout makes the game crash on them.

use std::collections::{HashMap, HashSet};
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
pub(crate) fn game_containers(paks: &Path) -> Vec<(PathBuf, u64, u64)> {
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
pub(crate) fn build_key(containers: &[(PathBuf, u64, u64)]) -> String {
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

/// Asset key -> when the newest game container holding it was written (seconds): an update's patch container holds
/// only what the update changed.
type GameAssets = HashMap<String, u64>;
static GAME_ASSETS: Mutex<Option<(String, Arc<GameAssets>)>> = Mutex::new(None);

/// Every package the installed game has, as asset keys: read from every container once per game build (about 6 s for
/// 570,000 packages) and kept in memory. Not saved: the list is close to 50 MB as text. None when nothing could be read.
fn game_assets(paks: &Path) -> Option<Arc<GameAssets>> {
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
    let mut set = GameAssets::new();
    for (utoc, _, at) in &containers {
        match crate::utoc_utils::try_read_utoc(utoc) {
            Ok(entries) => {
                for f in entries.iter().map(|e| &e.file_path).filter(|f| is_package(f)) {
                    let newest = set.entry(match_key(f)).or_insert(0);
                    *newest = (*newest).max(*at);
                }
            }
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

/// The facts about one mod that judge reads.
struct Facts<'a> {
    files: &'a [String],
    galacta: bool,
    vfx: bool,
    /// its update sits beside it (<name>_UPDATED_9999999_P, or this is <name>_BROKEN beside <name>): the update is judged, not the original again
    fixed: bool,
    has_blueprint: bool,
    /// when the mod's file was written (seconds)
    installed: u64,
}

/// The verdict for one mod, or None when it looks fine. Pure: the facts come in, the words go out.
fn judge(path: &str, m: &Facts, game_updated: u64, game: &GameAssets) -> Option<Verdict> {
    let packages: Vec<String> = m.files.iter().filter(|f| is_package(f)).map(|f| match_key(f)).collect();
    // Project Galacta skins bring their own new files (meshes, textures, configs) by design: never "broken" for that
    if !m.galacta && !packages.is_empty() && !packages.iter().any(|k| game.contains_key(k)) {
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
    // A VFX mod carries cooked copies of the game's materials and blueprints: an update that rewrote them leaves it stale
    let changed = packages.iter().filter(|k| game.get(*k).is_some_and(|at| *at > m.installed)).count();
    if m.vfx && !m.fixed && m.installed > 0 && changed > 0 {
        return Some(Verdict {
            path: path.to_string(),
            kind: "vfx",
            reason: format!(
                "A game update changed {changed} of the game files this VFX mod replaces, so its effects may look wrong or crash the game. The VFX Updater rebuilds it on the new game files."
            ),
        });
    }
    // On or off: the warning matters most before a loadout switches it on
    if m.has_blueprint && m.installed > 0 && m.installed < game_updated {
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
        let base = |p: &Path| p.with_extension("").to_string_lossy().to_lowercase();
        let installed_mods: HashSet<String> = mod_paths.iter().map(|p| base(Path::new(p))).collect();
        // an update beside it: <name>_UPDATED next to the original, or the original renamed <name>_BROKEN next to the update
        let has_fix = |path: &Path| {
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            [crate::xtra_vfx::fixed_stem(&stem), crate::xtra_vfx::unbroken_stem(&stem)]
                .iter()
                .any(|fixed| !fixed.eq_ignore_ascii_case(&stem) && installed_mods.contains(&base(&path.with_file_name(format!("{fixed}.pak")))))
        };
        mod_paths
            .iter()
            .filter_map(|p| {
                let path = PathBuf::from(p);
                let details = crate::compute_mod_details(&path, &state).ok()?;
                let installed = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
                let facts = Facts {
                    files: &details.files,
                    galacta: details.mod_type.contains("Project Galacta"),
                    vfx: details.category == "VFX",
                    fixed: has_fix(&path),
                    has_blueprint: details.has_blueprint,
                    installed,
                };
                judge(p, &facts, game_updated, &game)
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The game holds SK_1026_1026001, last written at 100 (seconds).
    fn game() -> GameAssets {
        [(match_key("/Game/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset"), 100)].into()
    }
    fn v(files: &[&str]) -> Vec<String> {
        files.iter().map(|s| s.to_string()).collect()
    }
    fn facts(files: &[String], installed: u64) -> Facts<'_> {
        Facts { files, galacta: false, vfx: false, fixed: false, has_blueprint: false, installed }
    }
    const LIVE: &str = "Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset";

    #[test]
    fn a_mod_whose_targets_are_gone_is_broken() {
        let files = v(&["../../../Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_OLD.uasset", "x/SK_1026_OLD.uexp"]);
        assert_eq!(judge("m", &facts(&files, 1), 2, &game()).map(|j| j.kind), Some("broken"));
    }

    #[test]
    fn a_mod_with_one_live_target_is_fine() {
        let files = v(&[LIVE, "Marvel/Content/New/T_Extra.uasset"]);
        assert_eq!(judge("m", &facts(&files, 1), 2, &game()), None);
    }

    #[test]
    fn galacta_skins_add_new_files_and_are_not_broken() {
        let files = v(&["Marvel/Content/Marvel/Characters/1026/1026001/Textures/T_Cat_New_D.uasset"]);
        assert_eq!(judge("m.pak", &Facts { galacta: true, ..facts(&files, 1) }, 2, &game()), None);
        assert_eq!(judge("m.pak", &facts(&files, 1), 2, &game()).map(|j| j.kind), Some("broken"), "the same files without the Galacta tag");
    }

    #[test]
    fn plugin_content_matches_the_games_spelling() {
        let game: GameAssets = [(match_key("../../../Marvel/Plugins/MarvelGAS/Content/Marvel/VFX/Particles/NS_A.uasset"), 1)].into();
        assert_eq!(judge("m.pak", &facts(&v(&["MarvelGAS/Marvel/VFX/Particles/NS_A.uasset"]), 1), 2, &game), None);
    }

    #[test]
    fn raw_only_mods_get_no_verdict() {
        assert_eq!(judge("m", &facts(&v(&["Marvel/Content/WwiseAudio/Windows/123.wem"]), 1), 2, &game()), None);
    }

    #[test]
    fn old_blueprint_mods_are_risky_new_ones_are_not() {
        let files = v(&[LIVE]);
        let bp = |installed| Facts { has_blueprint: true, ..facts(&files, installed) };
        assert_eq!(judge("m.pak", &bp(100), 200, &game()).map(|j| j.kind), Some("risky"));
        assert_eq!(judge("m.bak_repak", &bp(100), 200, &game()).map(|j| j.kind), Some("risky"), "off too: it crashes once a loadout turns it on");
        assert_eq!(judge("m", &bp(300), 200, &game()), None);
    }

    #[test]
    fn a_vfx_mod_older_than_its_game_files_needs_a_fix() {
        let files = v(&[LIVE, "Marvel/Content/Marvel/VFX/NS_Own.uasset"]);
        let vfx = |installed| Facts { vfx: true, has_blueprint: true, ..facts(&files, installed) };
        let verdict = judge("m.pak", &vfx(50), 200, &game()).unwrap();
        assert_eq!((verdict.kind, verdict.reason.contains("changed 1 of")), ("vfx", true), "the VFX verdict wins over risky");
        assert_eq!(judge("m.pak", &vfx(150), 200, &game()).map(|j| j.kind), Some("risky"), "made after its files changed: only the Blueprint warning");
        assert_eq!(judge("m.pak", &Facts { vfx: true, ..facts(&files, 150) }, 200, &game()), None);
        assert_eq!(judge("m.pak", &Facts { vfx: false, ..facts(&files, 50) }, 200, &game()), None, "only VFX mods");
        assert_eq!(judge("m.pak", &Facts { fixed: true, ..vfx(50) }, 200, &game()).map(|j| j.kind), Some("risky"), "fixed already: its copy is judged instead");
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
            let installed = std::fs::metadata(&p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
            let hits = files.iter().filter(|f| is_package(f) && game.contains_key(&match_key(f))).count();
            let newer = files.iter().filter(|f| is_package(f) && game.get(&match_key(f)).is_some_and(|at| *at > installed)).count();
            let pk = files.iter().filter(|f| is_package(f)).count();
            let vfx = p.to_string_lossy().to_lowercase().contains("vfx");
            let v = judge(&p.to_string_lossy(), &Facts { vfx, ..facts(&files, installed) }, 0, &game).map(|v| v.kind).unwrap_or("ok");
            println!("{v:7} {hits:4}/{pk:<4} newer {newer:4} {}", p.file_name().unwrap().to_string_lossy());
        }
    }

    #[test]
    fn paks_is_found_above_the_mods_folder() {
        let p = Path::new(r"C:\Steam\MarvelRivals\MarvelGame\Marvel\Content\Paks\~mods\Sub");
        assert_eq!(paks_dir(p), Some(PathBuf::from(r"C:\Steam\MarvelRivals\MarvelGame\Marvel\Content\Paks")));
        assert_eq!(paks_dir(Path::new(r"D:\MyMods")), None);
    }
}
