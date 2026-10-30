//! repakxtra: mods that will not work in the installed game version (custom/brokenMods.ts shows them).
//! Two checks, both from files alone:
//! - broken: every game asset the mod replaces is gone from the game (an update renamed or removed it), so the mod
//!   changes nothing. The game's own asset list is read once per game build and kept in memory.
//! - vfx: a VFX mod made before a game update that rewrote game files it replaces (on or off). Its effects can look wrong
//!   or crash the game until it is rebuilt on the new files (custom/vfx/, the VFX Updater).
//!   A material mod (a skin's material instances, xtra_vfx::updatable) gets it too, when the update rewrote one of those.
//! - risky: a Blueprint mod whose game classes the last game update changed (on or off: the warning matters before it goes
//!   on). Blueprint mods carry whole game classes, and an update that changes a class layout makes the game crash on them.
//!   xtra_layout.rs compares its classes with the game's. Until it has, a mod installed before the update is flagged by date.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::xtra_crash::asset_key;
use crate::AppState;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    path: String,
    /// "broken" or "risky"
    kind: &'static str,
    reason: String,
    /// For "vfx": its Niagara files (systems, emitters, curve atlases) the update rewrote. The VFX Updater cannot rebuild
    /// them, so it leaves them out and the update is partial
    #[serde(skip_serializing_if = "is_zero")]
    stale_niagara: usize,
    /// For "vfx": how many of the files the VFX Updater decodes a patch newer than the saved USMAP rewrote. While it is
    /// not 0 the update waits for the USMAP of the installed build (changed_since_usmap)
    #[serde(skip_serializing_if = "is_zero")]
    usmap_wait: usize,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// A Niagara system, emitter or curve atlas, by its name (pipeline.ts NIAGARA_BY_NAME).
fn is_niagara(key: &str) -> bool {
    let name = key.rsplit('/').next().unwrap_or(key);
    ["ns_", "ne_", "curveatlas_"].iter().any(|p| name.starts_with(p))
}

/// The game build that inserted properties into material instances' overrides (xtra_mi_layout.rs): one cooked before
/// it crashes the game when it overrides a later property.
const MATERIAL_LAYOUT_BUILD: u64 = 3984769;

/// When the installed game took that build (its first patch container from it on), None before it.
fn material_layout_patched(containers: &[(PathBuf, u64, u64)]) -> Option<u64> {
    containers.iter().filter(|(p, ..)| container_cl(p).is_some_and(|cl| cl >= MATERIAL_LAYOUT_BUILD)).map(|c| c.2).min()
}

fn is_material_instance(key: &str) -> bool {
    key.rsplit('/').next().unwrap_or(key).starts_with("mi_")
}

/// The game's Paks folder above a mods folder (~mods, or a subfolder of it).
pub(crate) fn paks_dir(mods_dir: &Path) -> Option<PathBuf> {
    mods_dir.ancestors().find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Paks"))).map(Path::to_path_buf)
}

/// A container name the game ships (pakchunk0-Windows, pakchunkVFX-Windows, Patch_-Windows_1.1.3962284_P, global), not
/// a loader or mod an older install put directly in Paks.
fn is_game_container(file_name: &str) -> bool {
    let n = file_name.to_ascii_lowercase();
    n.ends_with(".utoc") && (n.starts_with("pakchunk") || n.starts_with("patch_") || n == "global.utoc")
}

/// The game's own containers (the game's .utoc files directly in Paks, never the mods below it or beside it).
pub(crate) fn game_containers(paks: &Path) -> Vec<(PathBuf, u64, u64)> {
    let mut out: Vec<_> = std::fs::read_dir(paks)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().is_some_and(|n| is_game_container(&n.to_string_lossy())))
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
pub(crate) fn match_key(file: &str) -> String {
    let k = asset_key(file);
    k.split_once('/').map(|(_, rest)| rest.to_string()).unwrap_or(k)
}

/// Asset key -> when the newest game container holding it was written (seconds): an update's patch container holds
/// only what the update changed.
pub(crate) type GameAssets = HashMap<String, u64>;
static GAME_ASSETS: Mutex<Option<(String, Arc<GameAssets>)>> = Mutex::new(None);

/// Every package the installed game has, as asset keys: read from every container once per game build (about 6 s for
/// 570,000 packages) and kept in memory. Not saved: the list is close to 50 MB as text. None when nothing could be read.
pub(crate) fn game_assets(paks: &Path) -> Option<Arc<GameAssets>> {
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
    let mut builds = AssetBuilds::default();
    for (utoc, _, at) in &containers {
        let cl = container_cl(utoc).unwrap_or(0); // a base chunk: older than every patch
        match crate::utoc_utils::try_read_utoc(utoc) {
            Ok(entries) => {
                for f in entries.iter().map(|e| &e.file_path).filter(|f| is_package(f)) {
                    let newest = set.entry(match_key(f)).or_insert(0);
                    *newest = (*newest).max(*at);
                    let build = builds.by_package.entry(match_key(f)).or_insert(0);
                    *build = (*build).max(cl);
                }
            }
            Err(e) => {
                log::warn!("[broken] could not read {}: {e}", utoc.display());
                builds.unread = builds.unread.max(cl);
            }
        }
    }
    if set.is_empty() {
        return None; // the tool failed on every container: no verdicts rather than every mod "broken"
    }
    let set = Arc::new(set);
    *GAME_BUILDS.lock().unwrap_or_else(|e| e.into_inner()) = Some((key.clone(), Arc::new(builds)));
    *GAME_ASSETS.lock().unwrap() = Some((key, set.clone()));
    Some(set)
}

/// Per package, the newest game build whose patch container holds it (0: only the base chunks), read with GameAssets.
/// `unread`: the newest build among containers that could not be read (their packages are unknown).
#[derive(Default)]
pub(crate) struct AssetBuilds {
    by_package: HashMap<String, u64>,
    unread: u64,
}
static GAME_BUILDS: Mutex<Option<(String, Arc<AssetBuilds>)>> = Mutex::new(None);

/// Each file's stamp in the installed game: the newest patch build holding it and when that container was written. A file
/// the game updated sits in a newer patch container, and a container replaced in place has a new write time, so the same
/// stamp means the same bytes. None when a container could not be read (every file is then read again).
pub(crate) fn package_stamps(paks: &Path, files: &[String]) -> Option<Vec<String>> {
    let assets = game_assets(paks)?;
    let key = build_key(&game_containers(paks));
    let builds = GAME_BUILDS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|(k, _)| *k == key).map(|(_, b)| b.clone())?;
    if builds.unread > 0 {
        return None;
    }
    Some(files.iter().map(|f| {
        let k = match_key(f);
        format!("{}:{}", builds.by_package.get(&k).copied().unwrap_or(0), assets.get(&k).copied().unwrap_or(0))
    }).collect())
}

/// Of `files` (paths inside a mod), those whose game copy an update rewrote after `since` (seconds): cooked for an
/// older game build. None when the game's files in `paks` (its Paks folder) cannot be read.
pub(crate) fn rewritten_since(paks: &Path, files: &[String], since: u64) -> Option<Vec<String>> {
    let game = game_assets(paks)?;
    Some(stale_in(&game, files, since))
}

static EFFECTS: Mutex<Option<(String, Arc<Vec<String>>)>> = Mutex::new(None);

/// The game's Niagara systems and camera shakes, as Marvel/... package paths in their own case without an extension,
/// read once per game build (about 6 s). The effect built-ins find newer heroes' effects in it (xtra_visual_builtins.rs).
pub(crate) fn game_effects(paks: &Path) -> Arc<Vec<String>> {
    let containers = game_containers(paks);
    let key = build_key(&containers);
    if let Some((k, list)) = EFFECTS.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if *k == key {
            return list.clone();
        }
    }
    let mut out = std::collections::BTreeSet::new();
    for (utoc, ..) in &containers {
        for e in crate::utoc_utils::try_read_utoc(utoc).unwrap_or_default() {
            let path = e.file_path.trim_start_matches("../../../");
            let Some(path) = path.strip_suffix(".uasset") else { continue };
            let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
            if name.starts_with("ns_") || name.starts_with("camerashake") {
                out.insert(path.to_string());
            }
        }
    }
    let list = Arc::new(out.into_iter().collect::<Vec<_>>());
    *EFFECTS.lock().unwrap_or_else(|e| e.into_inner()) = Some((key, list.clone()));
    list
}

/// The game build in a patch container's name (Patch_-Windows_1.1.3962284_P.utoc), None for a base chunk.
pub(crate) fn container_cl(utoc: &Path) -> Option<u64> {
    let name = utoc.file_stem()?.to_string_lossy().to_string();
    name.strip_suffix("_P")?.rsplit(['.', '_']).next()?.parse::<u64>().ok().filter(|cl| *cl > 100_000)
}

/// Of the game packages `files` names, those a patch newer than `usmap` rewrote, by the build in each patch container's
/// name (never file dates, which a repair or copy can change): decoding them needs the USMAP of the installed game build.
/// A class layout change makes the cooker rewrite every package using the class, so a package no newer patch holds
/// keeps the layout `usmap` reads right. Empty when `usmap` is not behind the game. None when it cannot be told (no game
/// asset list, a USMAP without a build, a newer patch that could not be read): the caller waits.
pub(crate) fn changed_since_usmap(paks: &Path, usmap: &str, files: &[String]) -> Option<Vec<String>> {
    if crate::xtra_niagara::usmap_behind(usmap, paks).is_none() {
        return Some(Vec::new());
    }
    let u = crate::xtra_niagara::usmap_build(usmap)?;
    game_assets(paks)?;
    let key = build_key(&game_containers(paks));
    let builds = GAME_BUILDS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|(k, _)| *k == key).map(|(_, b)| b.clone())?;
    if builds.unread > u {
        return None;
    }
    Some(changed_in(&builds.by_package, files, u))
}

fn changed_in(by_package: &HashMap<String, u64>, files: &[String], usmap_build: u64) -> Vec<String> {
    files.iter().filter(|f| is_package(f) && by_package.get(&match_key(f)).is_some_and(|cl| *cl > usmap_build)).cloned().collect()
}

/// How many of the files the VFX Updater would decode from the mod at `utoc` a patch newer than `usmap` rewrote (all of
/// them, at least 1, when that cannot be told). 0: it can be updated with `usmap`.
pub(crate) fn usmap_wait(paks: &Path, usmap: &str, utoc: &Path) -> usize {
    let files: Vec<String> = match crate::utoc_utils::try_read_utoc(utoc) {
        Ok(entries) => entries.iter().map(|e| e.file_path.clone()).filter(|f| decoded_by_vfx(f)).collect(),
        Err(_) => return 1,
    };
    changed_since_usmap(paks, usmap, &files).map_or(files.len().max(1), |c| c.len())
}

/// The VFX Updater's gate for one mod (pipeline.ts): Some while the USMAP is older than the game, with the builds and
/// how many files the update would decode that the newer patch rewrote (it waits when that is not 0).
#[tauri::command]
pub fn xtra_vfx_usmap_wait(mod_path: String, game_paks: String, usmap_path: String) -> Option<UsmapWait> {
    let paks = Path::new(&game_paks);
    let (usmap, game) = crate::xtra_niagara::usmap_behind(&usmap_path, paks)?;
    let changed = usmap_wait(paks, &usmap_path, &Path::new(&mod_path).with_extension("utoc"));
    Some(UsmapWait { usmap, game, changed })
}

#[derive(Serialize)]
pub struct UsmapWait {
    usmap: u64,
    game: u64,
    changed: usize,
}

/// What the VFX Updater decodes of a mod: everything but textures and meshes, which pass through (pipeline.ts PASS_BY_NAME).
pub(crate) fn decoded_by_vfx(file: &str) -> bool {
    let name = file.rsplit(['/', '\\']).next().unwrap_or(file).to_ascii_lowercase();
    is_package(&name) && !["t_", "sk_", "sm_"].iter().any(|p| name.starts_with(p))
}

fn stale_in(game: &GameAssets, files: &[String], since: u64) -> Vec<String> {
    files.iter().filter(|f| is_package(f) && game.get(&match_key(f)).is_some_and(|at| *at > since)).cloned().collect()
}

/// The facts about one mod that judge reads.
struct Facts<'a> {
    files: &'a [String],
    galacta: bool,
    vfx: bool,
    /// not a VFX mod, but it carries material instances the VFX Updater rebuilds (a skin's glow, xtra_vfx::updatable)
    materials: bool,
    /// its update sits beside it (<name>_UPDATED_9999999_P, or this is <name>_BROKEN beside <name>): the update is judged, not the original again
    fixed: bool,
    has_blueprint: bool,
    /// when the mod was made (seconds): its file's modified time, which installs set to the source's (xtra_made.rs)
    installed: u64,
    /// its Niagara files are in an older layout although it was written after the update (xtra_niagara.rs layout scan)
    old_layout: bool,
    /// its classes against the game's (xtra_layout.rs): None not checked yet, Some(None) they match, Some(Some(reason))
    /// the game's have what its copies lack
    layout: Option<Option<String>>,
    /// made before MATERIAL_LAYOUT_BUILD with no update beside it, and no update since found nothing to rewrite in it
    old_materials: bool,
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
            stale_niagara: 0,
            usmap_wait: 0,
        });
    }
    // A VFX mod carries cooked copies of the game's materials and blueprints: an update that rewrote them leaves it stale
    let stale: Vec<&String> = packages.iter().filter(|k| game.get(*k).is_some_and(|at| *at > m.installed)).collect();
    let changed = stale.len();
    if m.vfx && !m.fixed && m.old_layout {
        let niagara = packages.iter().filter(|k| is_niagara(k) && game.contains_key(*k)).count();
        return Some(Verdict {
            path: path.to_string(),
            kind: "vfx",
            reason: "Its Niagara effects are in the layout of an older game build, although the file is newer than the last game update (an earlier update made with an old USMAP, or an old mod installed again). The game can crash on them. The VFX Updater rebuilds them on the new game files.".into(),
            stale_niagara: niagara.max(1),
            usmap_wait: 0,
        });
    }
    if m.vfx && !m.fixed && m.installed > 0 && changed > 0 {
        return Some(Verdict {
            path: path.to_string(),
            kind: "vfx",
            reason: format!(
                "A game update changed {changed} of the game files this VFX mod replaces, so its effects may look wrong or crash the game. The VFX Updater rebuilds it on the new game files."
            ),
            stale_niagara: stale.iter().filter(|k| is_niagara(k)).count(),
            usmap_wait: 0,
        });
    }
    // A material mod: the updater rebuilds only its material instances and KO prompts, so a rewritten texture alone does not count
    let stale_mi = stale.iter().filter(|k| is_material_instance(k)).count();
    let stale_ko = stale.iter().filter(|k| crate::xtra_vfx::is_ko_prompt(k.rsplit('/').next().unwrap_or(k))).count();
    if m.materials && !m.fixed && m.installed > 0 && stale_mi + stale_ko > 0 {
        let what = match (stale_mi, stale_ko) {
            (0, _) => "the KO prompt".to_string(),
            (_, 0) => format!("{stale_mi} of the material instances"),
            _ => format!("{stale_mi} of the material instances and the KO prompt"),
        };
        return Some(Verdict {
            path: path.to_string(),
            kind: "vfx",
            reason: format!(
                "A game update changed {what} this mod replaces, so {} may look wrong. The VFX Updater rebuilds {} on the new game files.",
                if stale_mi == 0 { "it" } else { "its materials" },
                if stale_mi + stale_ko == 1 { "it" } else { "them" }
            ),
            stale_niagara: 0,
            usmap_wait: 0,
        });
    }
    // its material instances in the older layout, whether or not the game rewrote them: the game can crash loading them
    let mi = packages.iter().filter(|k| is_material_instance(k)).count();
    if m.old_materials && mi > 0 {
        return Some(Verdict {
            path: path.to_string(),
            kind: "vfx",
            reason: format!(
                "Made before the game update that changed how materials are stored, so {} can crash the game. The VFX Updater rewrites {} in the new layout.",
                if mi == 1 { "its material".to_string() } else { format!("its {mi} materials") },
                if mi == 1 { "it" } else { "them" }
            ),
            stale_niagara: 0,
            usmap_wait: 0,
        });
    }
    // On or off: the warning matters most before a loadout switches it on
    let risky = |reason: String| Some(Verdict { path: path.to_string(), kind: "risky", reason, stale_niagara: 0, usmap_wait: 0 });
    match &m.layout {
        _ if !m.has_blueprint => None,
        // what the update changed decides, whatever the date: one made after it from old files is caught too
        Some(Some(reason)) => risky(reason.clone()),
        Some(None) => None,
        // not compared yet: the date stands in until the background check has looked
        None if m.installed > 0 && m.installed < game_updated => risky("A Blueprint mod installed before the last game update. Updates often change the game classes it carries, and the game can crash on it. Turn it off if the game crashes, and look for an updated version.".into()),
        None => None,
    }
}

/// A mod an update found nothing to rebuild in (its report said Nothing to update), or one Check for VFX update looked at
/// (xtra_vfx_check.rs): its .utoc's size and time then, and the game's last update then. Until one of them changes it is
/// not flagged, or, when the check found it `outdated`, flagged whatever its date.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
struct Checked {
    size: u64,
    modified: u64,
    game: u64,
    #[serde(default)]
    outdated: bool,
    /// written by an update that rewrites older material layouts (xtra_mi_layout.rs): an earlier "nothing to update"
    /// could not read such materials, so it does not stop that flag
    #[serde(default)]
    material_layout: bool,
}

fn checked_store() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X").join("repakxtra-vfx-checked.json")
}

fn load_checked(store: &Path) -> HashMap<String, Checked> {
    std::fs::read_to_string(store).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub(crate) fn checked_key(utoc: &Path) -> String {
    utoc.to_string_lossy().replace('\\', "/").to_lowercase()
}

pub(crate) fn file_stamp(utoc: &Path) -> Option<(u64, u64)> {
    let m = std::fs::metadata(utoc).ok()?;
    Some((m.len(), m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs()))
}

/// What was found about `utoc` as the file it is now and in this game: Some(outdated), or None (nothing yet, or it changed).
fn checked_now(store: &HashMap<String, Checked>, utoc: &Path, game_updated: u64) -> Option<bool> {
    store.get(&checked_key(utoc)).filter(|c| file_stamp(utoc) == Some((c.size, c.modified)) && game_updated <= c.game).map(|c| c.outdated)
}

/// A "nothing to update" for `utoc` as it is now, from an update that rewrites older material layouts.
fn layout_cleared(store: &HashMap<String, Checked>, utoc: &Path, game_updated: u64) -> bool {
    store.get(&checked_key(utoc)).is_some_and(|c| file_stamp(utoc) == Some((c.size, c.modified)) && game_updated <= c.game && !c.outdated && c.material_layout)
}

fn remember_checked(store: &Path, utoc: &Path, game_updated: u64, outdated: bool) -> Result<(), String> {
    let (size, modified) = file_stamp(utoc).ok_or_else(|| format!("{} is not there", utoc.display()))?;
    let mut all = load_checked(store);
    all.insert(checked_key(utoc), Checked { size, modified, game: game_updated, outdated, material_layout: true });
    let tmp = store.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(&all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, store).map_err(|e| e.to_string())
}

/// When the game was last updated (its newest container's time), for the mods folder `mods_dir`. 0 when not known.
pub(crate) fn game_updated(mods_dir: &Path) -> u64 {
    paks_dir(mods_dir).map_or(0, |p| game_containers(&p).iter().map(|c| c.2).max().unwrap_or(0))
}

/// What a check found about the mod at `utoc` (xtra_vfx_check.rs), kept until the mod or the game changes.
pub(crate) fn record_check(mods_dir: &Path, utoc: &Path, outdated: bool) -> Result<(), String> {
    remember_checked(&checked_store(), utoc, game_updated(mods_dir), outdated)
}

/// An update of `mod_path` said Nothing to update: Needs VFX update stops flagging it until the mod or the game changes.
#[tauri::command(async)]
pub fn xtra_vfx_no_update(mod_path: String, state: State<'_, Arc<Mutex<AppState>>>) -> Result<(), String> {
    let mods_dir = state.lock().unwrap().game_path.clone();
    record_check(&mods_dir, &Path::new(&mod_path).with_extension("utoc"), false)
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
        let layout_patched = material_layout_patched(&game_containers(&paks));
        let base = |p: &Path| p.with_extension("").to_string_lossy().to_lowercase();
        let installed_mods: HashSet<String> = mod_paths.iter().map(|p| base(Path::new(p))).collect();
        let checked = load_checked(&checked_store());
        let (layouts, usmap_id) = (crate::xtra_layout::load_done(), crate::xtra_layout::usmap_id());
        // an update beside it: <name>_UPDATED next to the original, or the original renamed <name>_BROKEN next to the update
        // each folder's stems, so an _UPDATED name that takes the priority (two originals that would clash) is found
        let mut by_dir: HashMap<PathBuf, HashSet<String>> = HashMap::new();
        for p in &mod_paths {
            let p = Path::new(p);
            if let (Some(d), Some(s)) = (p.parent(), p.file_stem()) {
                by_dir.entry(d.to_path_buf()).or_default().insert(s.to_string_lossy().to_lowercase());
            }
        }
        let none = HashSet::new();
        let has_fix = |path: &Path| {
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let siblings = path.parent().and_then(|d| by_dir.get(d)).unwrap_or(&none);
            // and <name>_ORIGINAL beside its partial update (<name>_PARTIAL): kept for a full update later, not flagged now
            let partial = crate::xtra_vfx::original_stem(&stem).eq_ignore_ascii_case(&stem).then(|| crate::xtra_vfx::partial_stem(&stem));
            [crate::xtra_vfx::fixed_stem_among(&stem, siblings), crate::xtra_vfx::unbroken_stem(&stem)]
                .iter()
                .chain(partial.iter())
                .any(|fixed| !fixed.eq_ignore_ascii_case(&stem) && installed_mods.contains(&base(&path.with_file_name(format!("{fixed}.pak")))))
        };
        // a partial update whose original was kept: once the USMAP matches the game, the original's Niagara files can be
        // carried over too (xtra_niagara.rs), and updating the partial one starts from its original
        let full_possible = crate::xtra_niagara::saved_usmap_matches(&paks);
        let can_finish = |path: &Path| {
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            full_possible
                && crate::xtra_vfx::partial_stem(&stem).eq_ignore_ascii_case(&stem)
                && installed_mods.contains(&base(&path.with_file_name(format!("{}.pak", crate::xtra_vfx::original_stem(&stem)))))
        };
        let mut verdicts = mod_paths
            .iter()
            .filter_map(|p| {
                let path = PathBuf::from(p);
                if can_finish(&path) {
                    return Some(Verdict {
                        path: p.clone(),
                        kind: "vfx",
                        reason: "Updated without its Niagara effects while the USMAP was older than the game. The USMAP matches the game now, so the VFX Updater can try a full update from its kept original.".into(),
                        stale_niagara: 0,
                        usmap_wait: 0,
                    });
                }
                // a check found it built for an older game version: flagged whatever its date says
                let found = checked_now(&checked, &path.with_extension("utoc"), game_updated);
                if found == Some(true) && !has_fix(&path) {
                    return Some(Verdict {
                        path: p.clone(),
                        kind: "vfx",
                        reason: "Check for VFX update found its materials still built for an earlier game version, so they may look wrong. The VFX Updater rebuilds them on the new game files.".into(),
                        stale_niagara: 0,
                        usmap_wait: 0,
                    });
                }
                let details = crate::compute_mod_details(&path, &state).ok()?;
                let installed = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
                let vfx = details.category == "VFX";
                let facts = Facts {
                    files: &details.files,
                    galacta: details.mod_type.contains("Project Galacta"),
                    vfx,
                    materials: !vfx && crate::xtra_vfx::updatable(&details.category, &details.files),
                    // an update found nothing to rebuild in it (this file, this game): judged like one with its fix beside it
                    fixed: has_fix(&path) || found == Some(false),
                    has_blueprint: details.has_blueprint,
                    installed,
                    old_layout: details.category == "VFX" && crate::xtra_niagara::known_old_layout(&path),
                    layout: crate::xtra_layout::found_now(&layouts, &path.with_extension("utoc"), game_updated, &usmap_id),
                    old_materials: layout_patched.is_some_and(|at| installed > 0 && installed < at) && !has_fix(&path)
                        && !layout_cleared(&checked, &path.with_extension("utoc"), game_updated),
                };
                judge(p, &facts, game_updated, &game)
            })
            .collect::<Vec<Verdict>>();
        // A mod that needs an update can be updated with the saved USMAP when no patch newer than it rewrote the files
        // the update decodes. Otherwise it waits for the USMAP of the installed build, and its reason says which
        let usmap = crate::vfx_updater::commands::saved_usmap_path().filter(|u| Path::new(u).is_file());
        if let Some((u, g)) = usmap.as_deref().and_then(|u| crate::xtra_niagara::usmap_behind(u, &paks)) {
            for v in verdicts.iter_mut().filter(|v| v.kind == "vfx") {
                v.usmap_wait = usmap_wait(&paks, usmap.as_deref().unwrap_or_default(), &Path::new(&v.path).with_extension("utoc"));
                v.reason += &if v.usmap_wait > 0 {
                    format!(" It waits for the USMAP of game build {g}: the update changed {} of the files it rebuilds, which the saved USMAP (build {u}) would read wrong.", v.usmap_wait)
                } else {
                    format!(" No patch newer than the saved USMAP (build {u}) changed the files the VFX Updater rebuilds, so it can be updated now, before the USMAP of game build {g} is out.")
                };
            }
        }
        verdicts
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packages_cooked_for_the_usmap_build_read_right_with_it() {
        assert_eq!(container_cl(Path::new("Patch_-Windows_1.1.3984769_P.utoc")), Some(3984769));
        assert_eq!(container_cl(Path::new("pakchunk0-Windows.utoc")), None);
        // by build, never by date: A is in today's patch, B last in the USMAP's own, C only in the base chunks
        let builds: HashMap<String, u64> = [
            (match_key("Marvel/Content/Marvel/A.uasset"), 3984769),
            (match_key("Marvel/Content/Marvel/B.uasset"), 3962284),
            (match_key("Marvel/Content/Marvel/C.uasset"), 0),
        ]
        .into();
        let files = v(&["../../../Marvel/Content/Marvel/A.uasset", "Marvel/Content/Marvel/B.uasset", "Marvel/Content/Marvel/C.uasset"]);
        assert_eq!(changed_in(&builds, &files, 3962284), v(&["../../../Marvel/Content/Marvel/A.uasset"]), "only what a newer patch holds waits");
        assert!(changed_in(&builds, &files, 3984769).is_empty(), "the USMAP of the installed build reads everything");
        assert_eq!(changed_in(&builds, &files, 3939753).len(), 2, "an older USMAP: both newer patches count");
        assert!(decoded_by_vfx("Marvel/Content/X/MI_Glow.uasset") && decoded_by_vfx("x/NS_Hit.uasset"));
        assert!(!decoded_by_vfx("x/T_Glow_D.uasset") && !decoded_by_vfx("x/SK_Body.uasset") && !decoded_by_vfx("x/MI_Glow.uexp"));
    }

    #[test]
    fn only_the_games_own_containers_count() {
        for n in ["pakchunk0-Windows.utoc", "pakchunkVFX-Windows.utoc", "Patch_-Windows_1.1.3962284_P.utoc", "global.utoc"] {
            assert!(is_game_container(n), "{n}");
        }
        for n in ["!ProjectGalacta_9999999_P.utoc", "!ProjectSigeon_9999999_P.utoc", "MyMod_P.utoc", "pakchunk0-Windows.pak"] {
            assert!(!is_game_container(n), "{n}: a loader, a mod or no container");
        }
    }

    /// The game holds SK_1026_1026001, last written at 100 (seconds).
    fn game() -> GameAssets {
        [(match_key("/Game/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset"), 100)].into()
    }
    fn v(files: &[&str]) -> Vec<String> {
        files.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn the_material_layout_patch_is_its_first_container_from_that_build_on() {
        let c = |n: &str, at| (PathBuf::from(format!("Paks/{n}")), 1, at);
        assert_eq!(material_layout_patched(&[c("pakchunk0-Windows.utoc", 5), c("Patch_-Windows_1.1.3962284_P.utoc", 10)]), None);
        assert_eq!(material_layout_patched(&[c("Patch_-Windows_1.1.3962284_P.utoc", 10), c("Patch_-Windows_1.1.3984769_P.utoc", 20), c("Patch_-Windows_1.1.3990000_P.utoc", 30)]), Some(20));
    }
    fn facts(files: &[String], installed: u64) -> Facts<'_> {
        Facts { files, galacta: false, vfx: false, materials: false, fixed: false, has_blueprint: false, installed, old_layout: false, layout: None, old_materials: false }
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
    fn a_blueprint_mods_layout_check_decides_over_its_date() {
        let files = v(&[LIVE]);
        let bp = |installed, layout| Facts { has_blueprint: true, layout, ..facts(&files, installed) };
        assert_eq!(judge("m.pak", &bp(100, Some(None)), 200, &game()), None, "older than the update, but its classes match the game's");
        let found = judge("m.pak", &bp(300, Some(Some("The game's WBP_X has 1 function this copy lacks (OnA).".into()))), 200, &game()).unwrap();
        assert_eq!((found.kind, found.reason.as_str()), ("risky", "The game's WBP_X has 1 function this copy lacks (OnA)."), "newer than the update, made from old files");
        assert_eq!(judge("m.pak", &bp(100, None), 200, &game()).map(|j| j.kind), Some("risky"), "not compared yet: the date stands in");
        assert_eq!(judge("m.pak", &Facts { layout: Some(Some("x".into())), ..facts(&files, 100) }, 200, &game()), None, "not a Blueprint mod");
    }

    #[test]
    fn a_vfx_verdict_counts_its_stale_niagara_files() {
        let mut game = game();
        for f in ["/Game/Marvel/VFX/NS_Burst.uasset", "/Game/Marvel/VFX/CurveAtlas_1026.uasset", "/Game/Marvel/VFX/MI_Glow.uasset"] {
            game.insert(match_key(f), 100);
        }
        let files = v(&["Marvel/Content/Marvel/VFX/NS_Burst.uasset", "Marvel/Content/Marvel/VFX/CurveAtlas_1026.uasset", "Marvel/Content/Marvel/VFX/MI_Glow.uasset"]);
        let verdict = judge("m.pak", &Facts { vfx: true, ..facts(&files, 50) }, 200, &game).unwrap();
        assert_eq!((verdict.kind, verdict.stale_niagara), ("vfx", 2), "the material is rebuilt, the two Niagara files are left out");
    }

    #[test]
    fn a_vfx_mod_older_than_its_game_files_needs_a_fix() {
        let files = v(&[LIVE, "Marvel/Content/Marvel/VFX/NS_Own.uasset"]);
        let vfx = |installed| Facts { vfx: true, has_blueprint: true, ..facts(&files, installed) };
        let verdict = judge("m.pak", &vfx(50), 200, &game()).unwrap();
        assert_eq!((verdict.kind, verdict.reason.contains("changed 1 of")), ("vfx", true), "the VFX verdict wins over risky");
        assert_eq!(judge("m.pak", &vfx(150), 200, &game()).map(|j| j.kind), Some("risky"), "made after its files changed: only the Blueprint warning");
        assert_eq!(judge("m.pak", &Facts { vfx: true, ..facts(&files, 150) }, 200, &game()), None);
        assert_eq!(judge("m.pak", &Facts { vfx: true, old_layout: true, ..facts(&files, 150) }, 200, &game()).map(|j| j.kind), Some("vfx"), "newer than the update, still in the old layout");
        let mats = v(&["Marvel/Content/Marvel/Characters/1026/1026001/Materials/Lobby/MI_1026001_Eyes.uasset", LIVE]);
        assert_eq!(judge("m.pak", &Facts { materials: true, old_materials: true, ..facts(&mats, 150) }, 200, &game()).map(|j| j.kind), Some("vfx"), "materials from before the layout change");
        assert_eq!(judge("m.pak", &Facts { old_materials: true, ..facts(&files, 150) }, 200, &game()), None, "no material instance, nothing to rewrite");
        assert_eq!(judge("m.pak", &Facts { vfx: false, ..facts(&files, 50) }, 200, &game()), None, "only VFX mods");
        assert_eq!(judge("m.pak", &Facts { fixed: true, ..vfx(50) }, 200, &game()).map(|j| j.kind), Some("risky"), "fixed already: its copy is judged instead");
    }

    #[test]
    fn nothing_to_update_holds_until_the_mod_or_the_game_changes() {
        let dir = tempfile::tempdir().unwrap();
        let (store, utoc) = (dir.path().join("checked.json"), dir.path().join("Swap_9999999_P.utoc"));
        std::fs::write(&utoc, b"toc").unwrap();
        remember_checked(&store, &utoc, 200, false).unwrap();
        let all = load_checked(&store);
        assert_eq!(checked_now(&all, &utoc, 200), Some(false), "the same file, the same game");
        assert_eq!(checked_now(&all, Path::new(&utoc.to_string_lossy().to_uppercase()), 200), Some(false), "any spelling of the path");
        assert_eq!(checked_now(&all, &utoc, 300), None, "the game updated since");
        remember_checked(&store, &utoc, 200, true).unwrap();
        assert_eq!(checked_now(&load_checked(&store), &utoc, 200), Some(true), "a check found it outdated");
        std::fs::write(&utoc, b"toc v2").unwrap();
        assert_eq!(checked_now(&all, &utoc, 200), None, "the mod changed");
    }

    #[test]
    fn a_material_mod_needs_a_fix_only_when_its_material_instances_changed() {
        let mut game = game();
        for f in ["/Game/Marvel/Characters/1026/1026800/Materials/MI_Body.uasset", "/Game/Marvel/Characters/1026/1026800/Texture/T_Body_D.uasset"] {
            game.insert(match_key(f), 100);
        }
        let mi = "Marvel/Content/Marvel/Characters/1026/1026800/Materials/MI_Body.uasset";
        let tex = "Marvel/Content/Marvel/Characters/1026/1026800/Texture/T_Body_D.uasset";
        let skin = v(&[mi, tex]);
        let verdict = judge("m.pak", &Facts { materials: true, ..facts(&skin, 50) }, 200, &game).unwrap();
        assert_eq!((verdict.kind, verdict.reason.contains("changed 1 of the material instances")), ("vfx", true));
        let textures = v(&[tex]);
        assert_eq!(judge("m.pak", &Facts { materials: true, ..facts(&textures, 50) }, 200, &game), None, "a rewritten texture alone");
        assert_eq!(judge("m.pak", &Facts { materials: true, ..facts(&skin, 150) }, 200, &game), None, "made after the update");
        assert_eq!(judge("m.pak", &facts(&skin, 50), 200, &game), None, "not a material mod");
        let ko = "Marvel/Content/Marvel/UI/Blueprints/Battle/Custom/1026/WBP_Battle_Kill_1026_V3.uasset";
        game.insert(match_key("/Game/Marvel/UI/Blueprints/Battle/Custom/1026/WBP_Battle_Kill_1026_V3.uasset"), 100);
        let verdict = judge("m.pak", &Facts { materials: true, ..facts(&v(&[ko]), 50) }, 200, &game).unwrap();
        assert_eq!((verdict.kind, verdict.reason.contains("changed the KO prompt")), ("vfx", true), "a KO prompt the update rewrote");
    }

    #[test]
    fn stale_files_are_those_the_game_rewrote_after_the_mod() {
        let files = vec![
            "Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset".to_string(),
            "Marvel/Content/Marvel/VFX/NS_ModOnly.uasset".to_string(),
            "Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uexp".to_string(),
        ];
        assert_eq!(stale_in(&game(), &files, 50), vec![files[0].clone()], "older than the game's copy, packages only");
        assert!(stale_in(&game(), &files, 150).is_empty(), "made after the game's copy");
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
        let patched = material_layout_patched(&game_containers(&paks));
        println!("material layout patch installed at {patched:?}");
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
            let v = judge(&p.to_string_lossy(), &Facts { vfx, old_materials: patched.is_some_and(|at| installed < at), ..facts(&files, installed) }, 0, &game).map(|v| v.kind).unwrap_or("ok");
            println!("{v:7} {hits:4}/{pk:<4} newer {newer:4} {}", p.file_name().unwrap().to_string_lossy());
        }
    }

    /// Manual check of the layout check on a real game: REPAKXTRA_PAKS=<...\Content\Paks> cargo test real_game_layout --
    /// --ignored --nocapture (the saved USMAP must match the game). Each Blueprint mod's verdict by date (before) and with
    /// its classes compared (after), and how long each took. Reads only: nothing is saved.
    #[test]
    #[ignore]
    fn real_game_layout() {
        let paks = PathBuf::from(std::env::var("REPAKXTRA_PAKS").expect("REPAKXTRA_PAKS"));
        let usmap = crate::vfx_updater::commands::saved_usmap_path().expect("a saved USMAP");
        assert!(crate::xtra_niagara::usmap_matches(&usmap, &paks), "the saved USMAP is not this game build's");
        let game = game_assets(&paks).expect("game assets");
        let updated = game_containers(&paks).iter().map(|c| c.2).max().unwrap_or(0);
        let state = Arc::new(Mutex::new(crate::AppState { game_path: paks.join("~mods"), ..Default::default() }));
        let work = std::env::temp_dir().join("repak-x").join("xclass-test");
        let vanilla = crate::xtra_vfx::vanilla_dir(&paks.to_string_lossy(), &usmap);
        let mut mods: Vec<PathBuf> = std::fs::read_dir(paks.join("~mods")).unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "pak" || x == "bak_repak")).collect();
        mods.sort();
        let (all, mut n, mut total) = (std::time::Instant::now(), 0, std::time::Duration::ZERO);
        for p in mods {
            let Ok(d) = crate::compute_mod_details(&p, &state) else { continue };
            if !d.has_blueprint {
                continue;
            }
            let installed = std::fs::metadata(&p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
            let vfx = d.category == "VFX";
            let facts = |layout| Facts {
                files: &d.files,
                galacta: d.mod_type.contains("Project Galacta"),
                vfx,
                materials: !vfx && crate::xtra_vfx::updatable(&d.category, &d.files),
                fixed: false,
                has_blueprint: true,
                installed,
                old_layout: vfx && crate::xtra_niagara::known_old_layout(&p),
                layout,
                old_materials: false,
            };
            let label = |v: Option<Verdict>| v.map_or("ok", |v| match v.kind {
                "risky" => "May crash",
                "vfx" => "Needs VFX",
                k => k,
            });
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            let before = judge(&name, &facts(None), updated, &game);
            let t = std::time::Instant::now();
            let r = tauri::async_runtime::block_on(crate::xtra_layout::check_mod(&paks, &usmap, &p.with_extension("utoc"), &d.files, &work, &vanilla));
            let took = t.elapsed();
            let (after, note) = match &r {
                Ok(o) if o.reason.is_some() => (judge(&name, &facts(Some(o.reason.clone())), updated, &game), "older than the game".to_string()),
                Ok(o) if o.complete => (judge(&name, &facts(Some(None)), updated, &game), "matches the game".to_string()),
                Ok(_) => (judge(&name, &facts(None), updated, &game), "partly read, date rule".to_string()),
                Err(e) => (judge(&name, &facts(None), updated, &game), format!("not checked, date rule: {e}")),
            };
            println!("{:9} -> {:9} {:5.1}s  {name}  [{note}]", label(before), label(after), took.as_secs_f64());
            // shown even when a VFX verdict outranks it
            if let Ok(crate::xtra_layout::Outcome { reason: Some(why), .. }) = &r {
                println!("      {why}");
            }
            n += 1;
            total += took;
        }
        let _ = std::fs::remove_dir_all(&work);
        println!("{n} Blueprint mods checked in {:.1}s ({:.1}s all told)", total.as_secs_f64(), all.elapsed().as_secs_f64());
    }

    #[test]
    fn paks_is_found_above_the_mods_folder() {
        let p = Path::new(r"C:\Steam\MarvelRivals\MarvelGame\Marvel\Content\Paks\~mods\Sub");
        assert_eq!(paks_dir(p), Some(PathBuf::from(r"C:\Steam\MarvelRivals\MarvelGame\Marvel\Content\Paks")));
        assert_eq!(paks_dir(Path::new(r"D:\MyMods")), None);
    }
}
