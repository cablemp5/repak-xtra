//! repakxtra: mesh mods against the game's current skeletons. A skeletal mesh is bound to its skeleton's bones, and a
//! mesh with bones its skeleton does not have can crash the game when it loads. When the game rebuilt a mod's mesh
//! skeleton after the mod was made (3962284 rebuilt Black Panther's default ones), the background scan reads the mod's
//! mesh (its bone count, UAssetTool's skeletal_mesh_info) and the game's current skeleton (its bone tree) once per mod
//! file and game update. Only more bones than the skeleton has flags it: a rebuilt skeleton alone flagged 24 default
//! skin swaps here that work (2026-10-31). Kept in repakxtra-mesh-checked.json; xtra_broken.rs turns a finding into May
//! crash.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Done {
    size: u64,
    modified: u64,
    game: u64,
    /// the May crash reason, None when every mesh fits its skeleton
    reason: Option<String>,
}

fn store() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X").join("repakxtra-mesh-checked.json")
}

pub(crate) fn load_done() -> HashMap<String, Done> {
    std::fs::read_to_string(store()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// What the scan found for the mod at `utoc` as it is now, in this game: Some(reason) when a mesh has more bones than
/// its skeleton, None when it fits or was not checked.
pub(crate) fn found_now(all: &HashMap<String, Done>, utoc: &Path, game_updated: u64) -> Option<String> {
    all.get(&crate::xtra_broken::checked_key(utoc))
        .filter(|d| crate::xtra_broken::file_stamp(utoc) == Some((d.size, d.modified)) && game_updated <= d.game)
        .and_then(|d| d.reason.clone())
}

fn checked(all: &HashMap<String, Done>, utoc: &Path, game_updated: u64) -> bool {
    all.get(&crate::xtra_broken::checked_key(utoc)).is_some_and(|d| crate::xtra_broken::file_stamp(utoc) == Some((d.size, d.modified)) && game_updated <= d.game)
}

/// The bone count UAssetTool's skeletal_mesh_info prints for a mesh (`Bone Count: 302`).
fn bone_count(info: &str) -> Option<usize> {
    info.lines().find_map(|l| l.trim().strip_prefix("Bone Count:")).and_then(|n| n.trim().parse().ok())
}

/// A skeleton's bone count: its BoneTree's entries (one per bone).
fn skeleton_bones(j: &serde_json::Value) -> Option<usize> {
    j["Exports"].as_array()?.iter().flat_map(|e| e["Data"].as_array().into_iter().flatten()).find(|p| p["Name"] == "BoneTree").and_then(|p| p["Value"].as_array()).map(Vec::len)
}

/// The meshes of the mod at `utoc` (`meshes`: package paths without extension) checked against the game's skeletons.
async fn check_mod(paks: &Path, usmap: &str, utoc: &Path, meshes: &[String], work: &Path) -> Result<Option<String>, String> {
    let cli = crate::xtra_uat_cli::cli().ok_or("UAssetTool's command line is not there")?;
    let (mx, gx) = (work.join("mod"), work.join("game"));
    let _ = std::fs::remove_dir_all(work);
    let extract = |out: &Path, with_mod: bool, rels: &[String]| crate::vfx_updater::uasset_tool::VfxUatRequest {
        action: "extract_iostore_legacy",
        game_paks: Some(paks.to_string_lossy().to_string()),
        mod_path: with_mod.then(|| utoc.to_string_lossy().to_string()),
        output_path: Some(out.to_string_lossy().to_string()),
        filter_patterns: Some(rels.iter().map(|r| crate::xtra_niagara::tail_filter(r)).collect()),
        with_deps: Some(false),
        ..Default::default()
    };
    let skeletons: Vec<String> = meshes.iter().map(|m| format!("{m}_Skeleton")).collect();
    for (out, with_mod, rels) in [(&mx, true, meshes), (&gx, false, &skeletons[..])] {
        let r = crate::vfx_updater::uasset_tool::run_vfx_uat_request(Path::new(""), &extract(out, with_mod, rels)).await?;
        if !r.success {
            return Err(r.message);
        }
    }
    let gj = work.join("game_json");
    crate::xtra_niagara::stage(&gx, &work.join("game_in"), &skeletons, true)?;
    crate::xtra_niagara::to_json(usmap, &work.join("game_in"), &gj, &crate::vfx_updater::progress::NoOpProgressSink).await?;
    let (mut over, mut compared) = (Vec::new(), 0);
    for (mesh, skel) in meshes.iter().zip(&skeletons) {
        let file = mx.join(format!("{mesh}.uasset"));
        let Ok(sj) = crate::xtra_niagara::read_json(&gj.join(format!("{skel}.json"))) else { continue };
        let Some(have) = skeleton_bones(&sj) else { continue };
        let mut cmd = std::process::Command::new(&cli);
        cmd.arg("skeletal_mesh_info").arg(&file).arg(usmap);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000 | 0x0000_4000); // no window, below normal priority
        }
        let out = tauri::async_runtime::spawn_blocking(move || cmd.output()).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
        let Some(needs) = bone_count(&String::from_utf8_lossy(&out.stdout)) else { continue };
        compared += 1;
        log::info!("[mesh] {mesh}: {needs} bones, the game's skeleton {have}");
        if needs > have {
            over.push(format!("{} has {needs} bones and the game's skeleton {have}", mesh.rsplit('/').next().unwrap_or(mesh)));
        }
    }
    // nothing read is not "fits": tried again by the next scan
    if compared == 0 {
        return Err("none of its meshes or the game's skeletons could be read".into());
    }
    Ok((!over.is_empty()).then(|| format!("A game update rebuilt the skeleton this mod's mesh is bound to, and the mesh has bones it no longer has ({}). The game can crash loading it. Turn it off until its author updates it.", over.join(", "))))
}

static SCAN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Checks the mesh mods among `mod_paths` whose skeleton the game rebuilt since they were made, once per file and game
/// update, and returns how many it checked. Steps aside like every background scan (xtra_vfx.rs background_may_run).
#[tauri::command]
pub async fn xtra_mesh_scan(mod_paths: Vec<String>, state: State<'_, Arc<Mutex<AppState>>>) -> Result<usize, String> {
    let Ok(_one) = SCAN.try_lock() else { return Ok(0) };
    let state = state.inner().clone();
    let mods_dir = state.lock().unwrap().game_path.clone();
    let Some(paks) = crate::xtra_broken::paks_dir(&mods_dir) else { return Ok(0) };
    let Some(usmap) = crate::vfx_updater::commands::saved_usmap_path().filter(|u| crate::xtra_niagara::usmap_matches(u, &paks)) else { return Ok(0) };
    let game = crate::xtra_broken::game_updated(&mods_dir);
    let work = std::env::temp_dir().join("repak-x").join("xmesh").join(std::process::id().to_string());
    let mut all = load_done();
    let mut n = 0;
    for p in mod_paths {
        if !crate::xtra_vfx::background_may_run() {
            break;
        }
        let path = PathBuf::from(&p);
        if crate::xtra_builtins::in_folder(&path) {
            continue; // built-ins: xtra_builtins judges them by the game build they were made for, never these checks
        }
        let utoc = path.with_extension("utoc");
        if checked(&all, &utoc, game) {
            continue;
        }
        let Some((size, modified)) = crate::xtra_broken::file_stamp(&utoc) else { continue };
        let (st, pc, pk) = (state.clone(), path.clone(), paks.clone());
        let meshes = tauri::async_runtime::spawn_blocking(move || {
            let d = crate::compute_mod_details(&pc, &st).ok()?;
            let made = crate::xtra_stamp::made(&pc, modified);
            Some(crate::xtra_broken::meshes_with_rebuilt_skeleton(&pk, &d.files, made))
        })
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
        if meshes.is_empty() {
            continue;
        }
        match check_mod(&paks, &usmap, &utoc, &meshes, &work).await {
            Ok(reason) => {
                all.insert(crate::xtra_broken::checked_key(&utoc), Done { size, modified, game, reason });
                let _ = std::fs::write(store(), serde_json::to_string(&all).unwrap_or_default());
                n += 1;
            }
            Err(e) => log::warn!("[mesh] {p}: {e}"), // tried again by the next scan
        }
    }
    let _ = std::fs::remove_dir_all(&work);
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On a PC with the game and the mods (--ignored --nocapture): each named mod's meshes against the game's skeletons.
    #[tokio::test]
    #[ignore]
    async fn real_mesh_mods() {
        let paks = PathBuf::from(r"C:\Program Files (x86)\Steam\steamapps\common\MarvelRivals\MarvelGame\Marvel\Content\Paks");
        let usmap = crate::vfx_updater::commands::saved_usmap_path().expect("a saved USMAP");
        for name in ["GalacticClawDefaultSwap_9999999_P", "JackedVoidPantherV2Mesh_9999999_P"] {
            let utoc = paks.join("~mods").join(format!("{name}.utoc"));
            let files: Vec<String> = crate::utoc_utils::try_read_utoc(&utoc).unwrap().into_iter().map(|e| e.file_path).collect();
            let meshes = crate::xtra_broken::meshes_with_rebuilt_skeleton(&paks, &files, 0);
            let t = std::time::Instant::now();
            let r = check_mod(&paks, &usmap, &utoc, &meshes, &std::env::temp_dir().join("repakxtra-mesh-test")).await;
            println!("{name}: {meshes:?} -> {r:?} in {:?}", t.elapsed()); // Err when nothing was compared
        }
    }

    #[test]
    fn bones_are_read_from_the_mesh_info_and_the_skeletons_bone_tree() {
        assert_eq!(bone_count("  === Reference Skeleton ===\n    Bone Count: 302\n    RefBonePose Count: 302"), Some(302));
        assert_eq!(bone_count("no mesh here"), None);
        let j = serde_json::json!({ "Exports": [{ "Data": [{ "Name": "BoneTree", "Value": [{}, {}, {}] }, { "Name": "Sockets", "Value": [] }] }] });
        assert_eq!(skeleton_bones(&j), Some(3));
    }
}
