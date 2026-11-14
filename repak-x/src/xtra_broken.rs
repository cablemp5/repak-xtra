//! repakxtra: mods that will not work in the installed game version (custom/brokenMods.ts shows them).
//! Two checks, both from files alone:
//! - broken: every game asset the mod replaces is gone from the game (an update renamed or removed it), so the mod
//!   changes nothing. The game's own asset list is read once per game build, saved, and kept in memory.
//! - vfx: a mod whose materials a check found built for an older game (xtra_vfx_check.rs), or whose Niagara files are in
//!   an older layout (xtra_niagara.rs). Its effects can look wrong or crash the game until the Mod Updater rebuilds it.
//! - risky: a Blueprint mod whose game classes the last game update changed (on or off: the warning matters before it goes
//!   on), as xtra_layout.rs found by comparing them with the game's, a mesh with bones its rebuilt skeleton lacks
//!   (xtra_mesh.rs), or an Animation Blueprint the game cooked again since the mod was made.
//! A badge only ever comes from what a check found, never from a guess a later check could take back (a mod older than
//! the game update, say): those made badges appear and vanish in the Library (cable's rule). Until a mod is checked it
//! has no badge.

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
    /// For "risky": nothing the Mod Updater does fixes it (a mesh with bones its skeleton lacks), so it turns the mod
    /// off rather than rebuild its materials and call it safe
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    off_only: bool,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// A Niagara system, emitter or curve atlas, by its name (pipeline.ts NIAGARA_BY_NAME).
fn is_niagara(key: &str) -> bool {
    let name = key.rsplit('/').next().unwrap_or(key);
    ["ns_", "ne_", "curveatlas_"].iter().any(|p| name.starts_with(p))
}

/// An Animation Blueprint, by its name. shortcut: ABP_ names only, list classes (xtra_uat_cli::classes) if a mod ever
/// names one otherwise.
fn is_anim_blueprint(key: &str) -> bool {
    key.rsplit('/').next().unwrap_or(key).starts_with("abp_")
}

/// An encrypted mod's reason (brokenMods.ts ENCRYPTED reads its start, to drop it while Keep mods encrypted is on).
pub(crate) const ENCRYPTED: &str = "Encrypted: the game's Season 11 check cannot read its file list, so it reports the mod, and Project Galacta skips it. The Mod Updater decrypts it, or turn on Keep mods encrypted in its Advanced to leave it as it is.";

/// An animation or montage (an emote's), by where it sits or its montage name. shortcut: by path and name, list
/// classes (xtra_uat_cli::classes) if a mod ever keeps one elsewhere under another name.
pub(crate) fn is_animation(key: &str) -> bool {
    !is_anim_blueprint(key) && (key.contains("/animations/") || key.ends_with("_mt"))
}

/// The game build that inserted properties into material instances' overrides (xtra_mi_layout.rs): one cooked before
/// it crashes the game when it overrides a later property (scripts/usmap-diff.py lists what each patch moved).
const MATERIAL_LAYOUT_BUILD: u64 = 3984769;

fn is_material_instance(key: &str) -> bool {
    key.rsplit('/').next().unwrap_or(key).starts_with("mi_")
}

/// A mod's material instances (match_key), by class where the name does not tell. Most are MI_<name>, but 407 of the
/// 144,420 material instances the layout patch rewrote are not (M_Herodetail_BlackBG_1030, PP_Sceen_Effect_Dying_Ins:
/// 117 of them UI materials), and a copy cooked before it crashes the game all the same. So a mod with another package
/// that patch or a later one rewrote has its container listed with classes (xtra_uat_cli::classes, about 0.3 s), once
/// per file. Also whether that is all of them: false when the listing was needed but could not be read (no command line,
/// a failed listing, classes it could not name), so only the MI_ names are in, and the caller must not call it clean.
pub(crate) fn material_instances(paks: &Path, utoc: &Path, files: &[String]) -> (Vec<String>, bool) {
    material_instances_with(asset_builds(paks).as_deref(), paks, utoc, files)
}

/// material_instances with the game's builds read once by the caller (a check of every mod: two folder reads a mod less).
fn material_instances_with(builds: Option<&AssetBuilds>, paks: &Path, utoc: &Path, files: &[String]) -> (Vec<String>, bool) {
    let keys: Vec<String> = files.iter().filter(|f| is_package(f)).map(|f| match_key(f)).collect();
    let mut out: Vec<String> = keys.iter().filter(|k| is_material_instance(k)).cloned().collect();
    let rewritten = builds.is_some_and(|b| {
        // textures, meshes and Niagara files are never material instances
        let other = |k: &str| ["t_", "sk_", "sm_", "ns_", "ne_"].iter().any(|p| k.rsplit('/').next().unwrap_or(k).starts_with(p));
        keys.iter().any(|k| !is_material_instance(k) && !other(k) && b.by_package.get(k).is_some_and(|cl| *cl >= MATERIAL_LAYOUT_BUILD))
    });
    let listed = if rewritten { listed(paks, utoc).map(|l| l.into_iter().filter(|k| !k.starts_with('!')).collect()) } else { Some(Vec::new()) };
    let complete = listed.is_some();
    out.extend(listed.unwrap_or_default());
    out.sort();
    out.dedup();
    (out, complete)
}

/// The packages of `utoc` this game cannot load as they are, (damaged, moved) counts (xtra_uat_cli::class_marks): an
/// export an earlier update left without its class, and a game class a game update moved to another script package.
/// None when the container could not be listed.
pub(crate) fn class_marks(paks: &Path, utoc: &Path) -> Option<(usize, usize)> {
    let l = listed(paks, utoc)?;
    Some((l.iter().filter(|k| k.starts_with("!damaged:")).count(), l.iter().filter(|k| k.starts_with("!moved:")).count()))
}

/// The material instances in the container `utoc` by their class, and its marked packages as "!<mark>:<key>"
/// (xtra_uat_cli::listing), kept per file (its size and time written) and decoder, in memory and in
/// repakxtra-mod-classes.json: each listing runs a process (about 0.3 s), and every launch asked again for every mod
/// an update touched.
fn listed(paks: &Path, utoc: &Path) -> Option<Vec<String>> {
    static SEEN: Mutex<Option<HashMap<String, ((u64, u64), Vec<String>)>>> = Mutex::new(None);
    let file = crate::app_dir().join("repakxtra-mod-classes.json");
    // (the game's build too: the marks say what this game lacks or moved, which its next update can change)
    let key = format!("{}|{}", decoder_key(utoc, crate::xtra_vfx::parser_id()), crate::xtra_vfx::game_cl(paks).unwrap_or(0));
    let stamp = file_stamp(utoc);
    let known = |m: &mut Option<HashMap<String, ((u64, u64), Vec<String>)>>| {
        m.get_or_insert_with(|| std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()).get(&key).filter(|(s, _)| Some(*s) == stamp).map(|(_, f)| f.clone())
    };
    if let Some(found) = known(&mut SEEN.lock().unwrap_or_else(|e| e.into_inner())) {
        return Some(found);
    }
    let listed = crate::xtra_uat_cli::listing(utoc, paks)?;
    // a class it could not name (no script objects): not known, and asked again next time. A marked package says its
    // own: a class the game moved reads as unknown when it is the package's own
    if listed.is_empty() || listed.iter().any(|(_, c, mark)| mark.is_empty() && (c.is_empty() || c.to_ascii_lowercase().contains("unknown"))) {
        return None;
    }
    let found: Vec<String> = listed.iter().filter(|(_, c, _)| c.starts_with("MaterialInstance")).map(|(p, _, _)| match_key(p))
        .chain(listed.iter().filter(|(_, _, mark)| !mark.is_empty()).map(|(p, _, mark)| format!("!{mark}:{}", match_key(p))))
        .collect();
    if let Some(s) = stamp {
        let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
        let all = seen.get_or_insert_with(HashMap::new);
        all.insert(key, (s, found.clone()));
        // shortcut: written whole on each new listing (a few hundred mods, a few KB). Trim entries of removed mods if it ever grows large
        let _ = std::fs::write(&file, serde_json::to_string(&*all).unwrap_or_default());
    }
    Some(found)
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

/// The game's own containers (the game's .utoc files directly in Paks, never the mods below it or beside it): path,
/// .utoc size, and when it was written (settled: the time it was first seen with these sizes).
pub(crate) fn game_containers(paks: &Path) -> Vec<(PathBuf, u64, u64)> {
    #[allow(unused_mut)]
    let mut found: Vec<_> = std::fs::read_dir(paks)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().is_some_and(|n| is_game_container(&n.to_string_lossy())))
        .filter_map(|p| {
            let m = std::fs::metadata(&p).ok()?;
            let at = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
            let ucas = std::fs::metadata(p.with_extension("ucas")).map_or(0, |m| m.len());
            Some((p, m.len(), ucas, at))
        })
        .collect();
    // tests build containers in temp folders: never in the app's own store
    #[cfg(not(test))]
    settle_saved(&mut found);
    let mut out: Vec<_> = found.into_iter().map(|(p, len, _, at)| (p, len, at)).collect();
    out.sort();
    out
}

/// A Steam "verify files" or a copy can rewrite a container's time with nothing in it changed, and every check reads that
/// time as a game update: the asset list read again, every mod checked again, current VFX mods flagged. So a container
/// keeps the time it was first seen with while its .utoc and .ucas sizes stay the same. `known`: full path -> (utoc
/// size, ucas size, time). True when `known` changed. Pure.
/// shortcut: sizes stand in for content, so an update that rewrote a container to the exact same two sizes would be
/// missed. Hash the .utoc (a few MB) if one ever does.
fn settle(found: &mut [(PathBuf, u64, u64, u64)], known: &mut HashMap<String, (u64, u64, u64)>) -> bool {
    let mut changed = false;
    for (p, utoc, ucas, at) in found.iter_mut() {
        let key = checked_key(p);
        match known.get(&key) {
            Some(&(u, c, first)) if u == *utoc && c == *ucas => *at = first,
            _ => {
                known.insert(key, (*utoc, *ucas, *at));
                changed = true;
            }
        }
    }
    changed
}

#[cfg(not(test))]
fn settle_saved(found: &mut [(PathBuf, u64, u64, u64)]) {
    static KNOWN: Mutex<Option<HashMap<String, (u64, u64, u64)>>> = Mutex::new(None);
    let file = crate::app_dir().join("repakxtra-game-containers.json");
    let mut known = KNOWN.lock().unwrap_or_else(|e| e.into_inner());
    let known = known.get_or_insert_with(|| std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default());
    if settle(found, known) {
        let tmp = file.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, serde_json::to_string(&*known).unwrap_or_default()).and_then(|_| std::fs::rename(&tmp, &file)) {
            log::warn!("[broken] could not save the container times: {e}");
        }
    }
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
pub(crate) fn is_package(file: &str) -> bool {
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
/// only what the update changed. Keyed by a 64-bit fingerprint of the key, not its text: the game's 570,000 keys took
/// about 150 MB as text and take about 18 MB as numbers. Two keys share a fingerprint about once in 100 million lists
/// this size, and that would at worst change one mod's badge.
#[derive(Default)]
pub(crate) struct GameAssets(HashMap<u64, u64>);

impl GameAssets {
    pub(crate) fn get(&self, key: &str) -> Option<&u64> {
        self.0.get(&fingerprint(key))
    }
    pub(crate) fn contains_key(&self, key: &str) -> bool {
        self.0.contains_key(&fingerprint(key))
    }
    pub(crate) fn insert(&mut self, key: impl AsRef<str>, value: u64) {
        self.0.insert(fingerprint(key.as_ref()), value);
    }
    /// Keeps the larger of the value stored for `key` and `value`.
    fn raise(&mut self, key: &str, value: u64) {
        let v = self.0.entry(fingerprint(key)).or_insert(0);
        *v = (*v).max(value);
    }
    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }
}

impl<const N: usize> From<[(String, u64); N]> for GameAssets {
    fn from(pairs: [(String, u64); N]) -> Self {
        let mut g = GameAssets::default();
        for (k, v) in pairs {
            g.insert(k, v);
        }
        g
    }
}

/// FNV-1a: the same number for the same key in every build and on every PC, so the saved list stays readable.
pub(crate) fn fingerprint(key: &str) -> u64 {
    key.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3))
}

static GAME_ASSETS: Mutex<Option<(String, Arc<GameAssets>)>> = Mutex::new(None);

/// Every package the installed game has, as asset keys: read from every container once per game build (about 7 s and
/// a few GB of memory while UAssetTool lists 570,000 packages), then saved (saved_assets) so a launch without a game
/// update loads it in a moment instead. Kept in memory once read. None when nothing could be read.
pub(crate) fn game_assets(paks: &Path) -> Option<Arc<GameAssets>> {
    game_assets_if(paks, || true)
}

/// game_assets, but reading the containers themselves (not the saved list) only when `may_read` says so: the background
/// checks pass "the game is not running", so its frame rate never pays for the 7 s and few GB.
pub(crate) fn game_assets_if(paks: &Path, may_read: impl Fn() -> bool) -> Option<Arc<GameAssets>> {
    let containers = game_containers(paks);
    if containers.is_empty() {
        return None;
    }
    let key = build_key(&containers);
    let cached = || GAME_ASSETS.lock().unwrap().as_ref().filter(|(k, _)| *k == key).map(|(_, set)| set.clone());
    if let Some(set) = cached() {
        return Some(set);
    }
    // one reader at a time: the checks that start together at launch wait for the first instead of each reading it all
    static READING: Mutex<()> = Mutex::new(());
    let _one = READING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(set) = cached() {
        return Some(set);
    }
    let t = std::time::Instant::now();
    // the saved list is for these containers and this version of the code that reads them (build_xtra.rs)
    let saved_key = format!("{key}|{}", env!("REPAKXTRA_ASSETS_LOGIC"));
    // two slots: app copies whose reading code differs (a newer build beside an older one, another edition) each keep
    // theirs, instead of evicting each other's and paying the full read on every launch after the other ran
    let (file, prev) = (saved_assets(), saved_assets().with_extension("prev.bin"));
    let (set, builds) = match load_saved(&file, &saved_key).or_else(|| load_saved(&prev, &saved_key)) {
        Some(saved) => {
            log::info!("[broken] game asset list loaded: {} packages in {:?}", saved.0.len(), t.elapsed());
            saved
        }
        None if !may_read() => return None,
        None => {
            let (set, builds, complete) = read_containers(&containers);
            if set.0.is_empty() {
                return None; // the tool failed on every container: no verdicts rather than every mod "broken"
            }
            // a container that could not be read is tried again next launch, not saved as missing
            if complete {
                if let Err(e) = save(&file, &saved_key, &set, &builds) {
                    log::warn!("[broken] could not save the game asset list: {e}");
                }
            }
            log::info!("[broken] game asset list read: {} packages in {:?}", set.0.len(), t.elapsed());
            (set, builds)
        }
    };
    let set = Arc::new(set);
    *GAME_BUILDS.lock().unwrap_or_else(|e| e.into_inner()) = Some((key.clone(), Arc::new(builds)));
    *GAME_ASSETS.lock().unwrap() = Some((key, set.clone()));
    Some(set)
}

/// The asset list from the containers themselves, and whether every one could be read.
fn read_containers(containers: &[(PathBuf, u64, u64)]) -> (GameAssets, AssetBuilds, bool) {
    let (mut set, mut builds, mut complete) = (GameAssets::default(), AssetBuilds::default(), true);
    for (utoc, _, at) in containers {
        let cl = container_cl(utoc).unwrap_or(0); // a base chunk: older than every patch
        match crate::utoc_utils::try_read_utoc(utoc) {
            Ok(entries) => {
                for f in entries.iter().map(|e| &e.file_path).filter(|f| is_package(f)) {
                    let k = match_key(f);
                    set.raise(&k, *at);
                    builds.by_package.raise(&k, cl);
                }
            }
            Err(e) => {
                log::warn!("[broken] could not read {}: {e}", utoc.display());
                builds.unread = builds.unread.max(cl);
                complete = false;
            }
        }
    }
    builds.complete = complete;
    (set, builds, complete)
}

/// Where the game's asset list is saved between launches (one game build's, about 14 MB).
fn saved_assets() -> PathBuf {
    crate::app_dir().join("repakxtra-game-assets.bin")
}

const SAVED_MAGIC: &[u8; 8] = b"RXGAMES1";

/// The next little-endian u64 of `r`, which moves past it.
fn take_word(r: &mut &[u8]) -> Option<u64> {
    let (w, rest) = r.split_first_chunk::<8>()?;
    *r = rest;
    Some(u64::from_le_bytes(*w))
}

/// The saved list, when it was saved for exactly this `key` (build_key plus the reading code's stamp). Layout,
/// little-endian u64s after the magic: key length, key bytes, unread, count, then per package its fingerprint,
/// GameAssets and AssetBuilds value.
fn load_saved(file: &Path, key: &str) -> Option<(GameAssets, AssetBuilds)> {
    let bytes = std::fs::read(file).ok()?;
    let mut r = bytes.strip_prefix(SAVED_MAGIC.as_slice())?;
    let len = usize::try_from(take_word(&mut r)?).ok()?;
    if r.get(..len)? != key.as_bytes() {
        return None; // another game build's list, or one the reading code has changed since
    }
    r = &r[len..];
    let unread = take_word(&mut r)?;
    let count = usize::try_from(take_word(&mut r)?).ok()?;
    // exactly `count` records left, checked before allocating: a damaged count is a reread, never a huge allocation
    if count == 0 || count.checked_mul(24) != Some(r.len()) {
        return None;
    }
    let mut set = GameAssets(HashMap::with_capacity(count));
    let mut builds = AssetBuilds { by_package: GameAssets(HashMap::with_capacity(count)), unread, complete: true };
    for _ in 0..count {
        let (fp, at, cl) = (take_word(&mut r)?, take_word(&mut r)?, take_word(&mut r)?);
        set.0.insert(fp, at);
        builds.by_package.0.insert(fp, cl);
    }
    Some((set, builds))
}

fn save(file: &Path, key: &str, set: &GameAssets, builds: &AssetBuilds) -> std::io::Result<()> {
    let mut out = Vec::with_capacity(32 + key.len() + set.0.len() * 24);
    out.extend_from_slice(SAVED_MAGIC);
    out.extend_from_slice(&(key.len() as u64).to_le_bytes());
    out.extend_from_slice(key.as_bytes());
    for w in [builds.unread, set.0.len() as u64] {
        out.extend_from_slice(&w.to_le_bytes());
    }
    for (fp, at) in &set.0 {
        for w in [*fp, *at, builds.by_package.0.get(fp).copied().unwrap_or(0)] {
            out.extend_from_slice(&w.to_le_bytes());
        }
    }
    // written beside it and swapped in, so a crash mid-write never leaves half a list that loads
    let tmp = file.with_extension("bin.tmp");
    std::fs::write(&tmp, &out)?;
    // only once the new list is safely written: the list it replaces moves to the second slot (the older of two goes)
    let _ = std::fs::rename(file, file.with_extension("prev.bin"));
    std::fs::rename(&tmp, file)
}

/// Per package, the newest game build whose patch container holds it (0: only the base chunks), read with GameAssets.
/// `unread`: the newest build among containers that could not be read (their packages are unknown).
#[derive(Default)]
pub(crate) struct AssetBuilds {
    by_package: GameAssets,
    unread: u64,
    /// every container was read (a saved list always was: one with an unread container is never saved)
    complete: bool,
}

/// Whether the game's asset list has every container in it: only then does "no package of it is newer" hold, and a check
/// from an earlier game update may carry over (the background scans).
pub(crate) fn asset_list_complete(paks: &Path) -> bool {
    asset_builds(paks).is_some_and(|b| b.complete)
}

/// Whether no game copy of `files` (paths inside a mod) was rewritten after `since`, by a complete asset list. A check's
/// answer from a game update at `since` then still holds: a class layout change rewrites every package using the class
/// (changed_since_usmap), so an untouched package reads the same.
pub(crate) fn untouched_since(paks: &Path, files: &[String], since: u64) -> bool {
    asset_list_complete(paks) && game_assets(paks).is_some_and(|g| stale_in(&g, files, since).is_empty())
}
static GAME_BUILDS: Mutex<Option<(String, Arc<AssetBuilds>)>> = Mutex::new(None);

/// Of `files` (paths inside a mod), those whose game copy an update rewrote after `since` (seconds): cooked for an
/// older game build. None when the game's files in `paks` (its Paks folder) cannot be read.
pub(crate) fn rewritten_since(paks: &Path, files: &[String], since: u64) -> Option<Vec<String>> {
    let game = game_assets(paks)?;
    Some(stale_in(&game, files, since))
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
    let builds = asset_builds(paks)?;
    if builds.unread > u {
        return None;
    }
    Some(changed_in(&builds.by_package, files, u))
}

/// Of `files` (paths inside a mod), its skeletal meshes whose skeleton (`<mesh>_Skeleton`) the game rebuilt after `made`:
/// the ones xtra_mesh.rs reads. Package paths without the extension.
pub(crate) fn meshes_with_rebuilt_skeleton(paks: &Path, files: &[String], made: u64) -> Vec<String> {
    let Some(game) = game_assets(paks) else { return Vec::new() };
    files
        .iter()
        .filter(|f| is_package(f))
        .filter(|f| {
            let k = match_key(f);
            let name = k.rsplit('/').next().unwrap_or(&k).to_string();
            name.starts_with("sk_") && !name.ends_with("_skeleton") && !name.ends_with("_physicsasset") && game.get(&format!("{k}_skeleton")).is_some_and(|at| *at > made)
        })
        .map(|f| f.replace('\\', "/").trim_end_matches(".uasset").to_string())
        .collect()
}

/// The game's packages' builds (AssetBuilds), read with its asset list.
fn asset_builds(paks: &Path) -> Option<Arc<AssetBuilds>> {
    game_assets(paks)?;
    let key = build_key(&game_containers(paks));
    GAME_BUILDS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|(k, _)| *k == key).map(|(_, b)| b.clone())
}

fn changed_in(by_package: &GameAssets, files: &[String], usmap_build: u64) -> Vec<String> {
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
    /// a materials check or an update's Nothing to update cleared it: its materials only, never its meshes or animations
    cleared: bool,
    has_blueprint: bool,
    /// when the mod was made (seconds): its file's modified time, which installs set to the source's (xtra_made.rs)
    installed: u64,
    /// the game's last update moved how animations are stored (AnimSequenceBase, xtra_usmap_diff newest_moved)
    anims_moved: bool,
    /// its Niagara files are in an older layout although it was written after the update (xtra_niagara.rs layout scan)
    old_layout: bool,
    /// its classes against the game's (xtra_layout.rs): None not checked yet, Some(None) they match, Some(Some(reason))
    /// the game's have what its copies lack
    layout: Option<Option<String>>,
    /// a mesh with more bones than its rebuilt skeleton (xtra_mesh.rs), the reason
    mesh: Option<String>,
    /// packages the game cannot load as they are (class_marks): (left without a class by an earlier update, using a
    /// game class a game update moved)
    class_marks: (usize, usize),
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
        off_only: false,
        });
    }
    // an emote an earlier update left without a class (the game crashes on it), or one that still names a class a
    // game update moved (Season 11: AnimNotifyState_SetComponentsInActorVisible). The Mod Updater repairs both
    let (damaged, moved) = m.class_marks;
    if !m.fixed && damaged + moved > 0 {
        let files = |n: usize| if n == 1 { "1 of its files".to_string() } else { format!("{n} of its files") };
        return Some(Verdict {
            path: path.to_string(),
            kind: "vfx",
            reason: if damaged > 0 {
                format!("An earlier update left {} without a game class, so the game crashes on it. The Mod Updater rebuilds it from its original.", files(damaged))
            } else {
                format!("A game update moved a game class that {} use{}, so the game cannot load {}. The Mod Updater points {} at the class's new place.", files(moved), if moved == 1 { "s" } else { "" }, if moved == 1 { "it" } else { "them" }, if moved == 1 { "it" } else { "them" })
            },
            stale_niagara: 0,
            usmap_wait: 0,
            off_only: false,
        });
    }
    // a mesh with more bones than the skeleton the game rebuilt since the mod was made (xtra_mesh.rs read both): first,
    // since rebuilding the mod's materials (any Needs update below) would leave the mesh as it is
    if let Some(reason) = m.mesh.as_ref().filter(|_| !m.fixed) {
        return Some(Verdict { path: path.to_string(), kind: "risky", reason: reason.clone(), stale_niagara: 0, usmap_wait: 0, off_only: true });
    }
    // the game files it replaces that the game rewrote since the mod was made
    let stale: Vec<&String> = packages.iter().filter(|k| game.get(*k).is_some_and(|at| *at > m.installed)).collect();
    if m.vfx && !m.fixed && !m.cleared && m.old_layout {
        let niagara = packages.iter().filter(|k| is_niagara(k) && game.contains_key(*k)).count();
        return Some(Verdict {
            path: path.to_string(),
            kind: "vfx",
            reason: "Its Niagara effects are in the layout of an older game build, although the file is newer than the last game update (an earlier update made with an old USMAP, or an old mod installed again). The game can crash on them. The Mod Updater rebuilds them on the new game files.".into(),
            stale_niagara: niagara.max(1),
            usmap_wait: 0,
        off_only: false,
        });
    }
    // On or off: the warning matters most before a loadout switches it on
    let risky = |reason: String| Some(Verdict { path: path.to_string(), kind: "risky", reason, stale_niagara: 0, usmap_wait: 0, off_only: false });
    // an Animation Blueprint the game cooked again since the mod was made (3984769 moved AnimBlueprintGeneratedConstantData
    // and cooked 9 again): whatever its functions look like, nothing here rebuilds it
    let anims = stale.iter().filter(|k| is_anim_blueprint(k)).count();
    if !m.fixed && m.installed > 0 && anims > 0 {
        return risky(format!(
            "A game update changed how Animation Blueprints are stored and rebuilt the game's copy of {} since this mod was made, so the game can crash on it. Nothing here can rebuild {}: turn the mod off until its author updates it.",
            if anims == 1 { "its Animation Blueprint".to_string() } else { format!("its {anims} Animation Blueprints") },
            if anims == 1 { "it" } else { "them" }
        ));
    }
    // an animation or montage made before the game update that moved how animations are stored (4042190 inserted two
    // AnimSequenceBase properties): the emote does not play and the game crashes a moment later. The Mod Updater
    // rewrites it in the new layout
    let moved_anims = packages.iter().filter(|k| is_animation(k)).count();
    if m.anims_moved && !m.fixed && m.installed > 0 && m.installed < game_updated && moved_anims > 0 {
        return Some(Verdict {
            path: path.to_string(),
            kind: "vfx",
            reason: format!(
                "A game update changed how animations are stored, and {} made before it, so the emote does not play and the game can crash. The Mod Updater rewrites {} in the new layout.",
                if moved_anims == 1 { "its animation was".to_string() } else { format!("its {moved_anims} animations were") },
                if moved_anims == 1 { "it" } else { "them" }
            ),
            stale_niagara: 0,
            usmap_wait: 0,
            off_only: false,
        });
    }
    // a KO prompt mod: the Mod Updater rebuilds its widget on the game's new copy, so Needs update, not May crash
    let ko = m.materials && !m.fixed && !m.cleared && crate::xtra_ko::ko_only_files(m.files);
    let needs = |reason: String| Some(Verdict { path: path.to_string(), kind: "vfx", reason, stale_niagara: 0, usmap_wait: 0, off_only: false });
    match &m.layout {
        _ if !m.has_blueprint => None,
        Some(Some(reason)) if ko => needs(format!("{reason} The Mod Updater rebuilds the KO prompt on the new game files.")),
        // what the update changed decides, whatever the date: one made after it from old files is caught too
        Some(Some(reason)) => risky(reason.clone()),
        Some(None) => None,
        // not compared yet: no badge until the background check has looked
        None => None,
    }
}

/// An inconclusive material comparison replaces date guesses, never evidence from another asset check.
fn judge_checked(path: &str, mut facts: Facts<'_>, updated: u64, game: &GameAssets, unknown: Option<&str>) -> Option<Verdict> {
    let Some(reason) = unknown else { return judge(path, &facts, updated, game) };
    // a kept original (its update beside it) is not judged again: an old "not known" on it is no badge either
    if facts.old_layout || facts.fixed { return judge(path, &facts, updated, game); }
    facts.vfx = false;
    facts.materials = false;
    judge(path, &facts, updated, game).or_else(|| Some(Verdict {
        path: path.into(), kind: "unknown", reason: reason.into(), stale_niagara: 0, usmap_wait: 0, off_only: false,
    }))
}

/// The checks' "not known" for `utoc` goes (every decoder's): a later check settled it without a badge.
pub(crate) fn forget_uncertain(utoc: &Path) {
    let _one = CHECKED_WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let (store, key) = (checked_store(), checked_key(utoc));
    let mut all = load_checked(&store);
    let before = all.len();
    all.retain(|k, c| c.unknown.is_none() || !k.strip_prefix(key.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with('|')));
    if all.len() != before {
        if let Err(e) = save_checked(&store, &all) {
            log::warn!("[vfx check] {}: {e}", utoc.display());
        }
    }
}

/// Mods (checked_key) whose "not known" came from the check before 0.59, which counted shader-less materials and the
/// modder's own as not known: the background scan looks at them once more.
pub(crate) fn legacy_uncertain() -> HashSet<String> {
    load_checked(&checked_store())
        .iter()
        .filter(|(_, c)| c.unknown.as_deref().is_some_and(|u| u.starts_with("The material layout was read, but custom shader data matches no known game version")))
        .map(|(k, _)| k.split('|').next().unwrap_or(k).to_string())
        .collect()
}

/// Only a note for the flag: a store that cannot be written never fails the check that found it.
pub(crate) fn record_uncertain(mods_dir: &Path, utoc: &Path, reason: String) {
    if let Err(e) = remember_checked(&checked_store(), utoc, game_updated(mods_dir), false, false, Some(reason)) {
        log::warn!("[vfx check] {}: {e}", utoc.display());
    }
}

/// A mod an update found nothing to rebuild in (its report said Nothing to update), or one Check for VFX update looked at
/// (xtra_vfx_check.rs): its .utoc's size and time then, and the game's last update then. Until one of them changes it is
/// not flagged, or, when the check found it `outdated`, flagged whatever its date.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
struct Checked {
    #[serde(default)]
    unknown: Option<String>,
    #[serde(default)]
    parser: String,
    size: u64,
    modified: u64,
    game: u64,
    #[serde(default)]
    outdated: bool,
    /// written by an update that rewrites older material layouts (xtra_mi_layout.rs): an earlier "nothing to update"
    /// could not read such materials, so it does not stop that flag
    #[serde(default)]
    material_layout: bool,
    /// outdated because its material instances are in an older property layout (whatever its date says)
    #[serde(default)]
    old_layout: bool,
    /// an update read every animation in it in today's layout (xtra_mi_layout.rs told each one) and found nothing to
    /// rewrite: the date rule for animations made before the game update stops flagging it
    #[serde(default)]
    anims_told: bool,
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

/// A record's key in a store kept per decoder (xtra_vfx parser_id, or a USMAP id that includes it). The stable, test and
/// dev copies decode with their own tools: with one record per mod each switch replaced the other's answers and the next
/// launch read every mod again (268 records across 6 decoders, 2026-11-04).
pub(crate) fn decoder_key(utoc: &Path, decoder: &str) -> String {
    format!("{}|{decoder}", checked_key(utoc))
}

/// A store's record for `utoc` under `decoder`, else the one written before records were kept per decoder (the caller
/// still compares the decoder written inside it).
pub(crate) fn record_of<'a, T>(all: &'a HashMap<String, T>, utoc: &Path, decoder: &str) -> Option<&'a T> {
    all.get(&decoder_key(utoc, decoder)).or_else(|| all.get(&checked_key(utoc)))
}

pub(crate) fn file_stamp(utoc: &Path) -> Option<(u64, u64)> {
    let m = std::fs::metadata(utoc).ok()?;
    Some((m.len(), m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs()))
}

/// What was found about `utoc` as the file it is now and in this game: Some(outdated), or None (nothing yet, or it changed).
#[cfg(test)]
fn checked_now(store: &HashMap<String, Checked>, utoc: &Path, game_updated: u64) -> Option<bool> {
    checked_record(store, utoc, game_updated).map(|c| c.outdated)
}

/// The record of `utoc` as it is now, for this game: kept per decoder (decoder_key), this decoder's own first, else a
/// clearance any decoder wrote, else a finding any decoder wrote.
fn checked_record<'a>(store: &'a HashMap<String, Checked>, utoc: &Path, game_updated: u64) -> Option<&'a Checked> {
    let (key, stamp, parser) = (checked_key(utoc), file_stamp(utoc), crate::xtra_vfx::parser_id());
    let of_mod = || {
        store
            .iter()
            .filter(|(k, _)| k.strip_prefix(key.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with('|')))
            .map(|(_, c)| c)
            .filter(|c| stamp == Some((c.size, c.modified)) && game_updated <= c.game)
    };
    // this decoder's own record first, else another's (the other edition, or the app before its last update): a mod
    // found built for an older game keeps its badge through an app update, until this decoder's own scan looks again
    of_mod().find(|c| c.parser == parser).or_else(|| of_mod().find(|c| !c.outdated && c.unknown.is_none())).or_else(|| of_mod().find(|c| c.unknown.is_none()))
}

/// A "nothing to update" for `utoc` as it is now, from an update that rewrites older material layouts.
#[cfg(test)]
fn layout_cleared(store: &HashMap<String, Checked>, utoc: &Path, game_updated: u64) -> bool {
    checked_record(store, utoc, game_updated).is_some_and(|c| !c.outdated && c.unknown.is_none() && c.material_layout)
}

/// The user's Nothing to update and the background check can write the Checked store at once: one read-modify-write at a time.
static CHECKED_WRITING: Mutex<()> = Mutex::new(());

fn save_checked(store: &Path, all: &HashMap<String, Checked>) -> Result<(), String> {
    let tmp = store.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, store).map_err(|e| e.to_string())
}

/// What a check found about the mod at `utoc` in the game update at `from` (or later), carried to `to`: the scan found the
/// game rewrote none of its packages since, so the same files give the same answer.
pub(crate) fn carry_checked(utoc: &Path, from: u64, to: u64) {
    let _one = CHECKED_WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let (store, key, stamp) = (checked_store(), checked_key(utoc), file_stamp(utoc));
    let mut all = load_checked(&store);
    let mut moved = false;
    for (k, c) in all.iter_mut() {
        if k.strip_prefix(key.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with('|')) && stamp == Some((c.size, c.modified)) && c.game >= from && c.game < to {
            c.game = to;
            moved = true;
        }
    }
    if moved {
        if let Err(e) = save_checked(&store, &all) {
            log::warn!("[vfx check] {}: {e}", utoc.display());
        }
    }
}

fn remember_checked(store: &Path, utoc: &Path, game_updated: u64, outdated: bool, old_layout: bool, unknown: Option<String>) -> Result<(), String> {
    let _one = CHECKED_WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let (size, modified) = file_stamp(utoc).ok_or_else(|| format!("{} is not there", utoc.display()))?;
    let mut all = load_checked(store);
    // An inconclusive scan cannot replace a verified repair or a confirmed fault in the same file and game.
    if unknown.is_some() && checked_record(&all, utoc, game_updated).is_some_and(|c| c.unknown.is_none()) { return Ok(()); }
    // both writers read the material layout first (pipeline.ts relayout, xtra_vfx_check.rs): a "nothing" from them holds for it
    // Older apps do not understand unknown: retain their warning rather than granting a false clearance.
    let outdated = outdated || unknown.is_some();
    // a clearance holds for every decoder (as before records were kept per decoder): it replaces their findings too
    if !outdated {
        let key = checked_key(utoc);
        all.retain(|k, _| !k.strip_prefix(key.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with('|')));
    }
    let parser = crate::xtra_vfx::parser_id();
    all.insert(decoder_key(utoc, parser), Checked { unknown, parser: parser.to_string(), size, modified, game: game_updated, outdated, material_layout: true, old_layout, anims_told: false });
    save_checked(store, &all)
}

/// When the game was last updated (its newest container's time), for the mods folder `mods_dir`. 0 when not known.
/// The background checks' progress line (custom/brokenMods.ts): which check, the mod it is on and its place in the
/// list. Sent only for a mod about to be read, never for one already checked.
pub(crate) fn scan_progress(app: &tauri::AppHandle, step: &'static str, at: usize, total: usize, mod_path: &Path) {
    use tauri::Emitter;
    let _ = app.emit("mod-scan-progress", serde_json::json!({ "step": step, "at": at + 1, "total": total, "path": mod_path.to_string_lossy() }));
}

pub(crate) fn game_updated(mods_dir: &Path) -> u64 {
    paks_dir(mods_dir).map_or(0, |p| game_containers(&p).iter().map(|c| c.2).max().unwrap_or(0))
}

/// What a check found about the mod at `utoc` (xtra_vfx_check.rs), kept until the mod or the game changes. `old_layout`:
/// it is outdated for material instances in an older property layout.
pub(crate) fn record_check(mods_dir: &Path, utoc: &Path, outdated: bool, old_layout: bool) -> Result<(), String> {
    remember_checked(&checked_store(), utoc, game_updated(mods_dir), outdated, old_layout, None)
}

/// An update of `mod_path` said Nothing to update: Needs VFX update stops flagging it until the mod or the game changes.
/// `anims_told`: the update's layout pass told every file's layout and none needed rewriting, its animations included.
#[tauri::command(async)]
pub fn xtra_vfx_no_update(mod_path: String, anims_told: Option<bool>, state: State<'_, Arc<Mutex<AppState>>>) -> Result<(), String> {
    let mods_dir = state.lock().unwrap().game_path.clone();
    let utoc = Path::new(&mod_path).with_extension("utoc");
    record_check(&mods_dir, &utoc, false, false)?;
    if anims_told == Some(true) {
        let _one = CHECKED_WRITING.lock().unwrap_or_else(|e| e.into_inner());
        let (store, mut all) = (checked_store(), load_checked(&checked_store()));
        if let Some(c) = all.get_mut(&decoder_key(&utoc, crate::xtra_vfx::parser_id())) {
            c.anims_told = true;
            save_checked(&store, &all)?;
        }
    }
    Ok(())
}

/// Drops every record of `utocs` (checked_key, any decoder) from the JSON store at `store`. How many went.
fn forget_in(store: &Path, utocs: &[String]) -> usize {
    let Some(mut all) = std::fs::read_to_string(store).ok().and_then(|t| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&t).ok()) else { return 0 };
    let before = all.len();
    all.retain(|k, _| !utocs.iter().any(|key| k.strip_prefix(key.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with('|'))));
    let gone = before - all.len();
    if gone > 0 {
        let _ = std::fs::write(store, serde_json::Value::Object(all).to_string());
    }
    gone
}

/// The Mod Updater's Scan: the background checks forget these mods, so the run it starts reads each one fresh. A
/// clearance (Nothing to update) stays: the fresh check overwrites it only with what it finds.
#[tauri::command(async)]
pub fn xtra_scan_forget(mod_paths: Vec<String>) -> usize {
    let utocs: Vec<String> = mod_paths.iter().map(|p| checked_key(&Path::new(p).with_extension("utoc"))).collect();
    // and an earlier "not known": the fresh check decides again (an outdated finding is rewritten by what it finds)
    for p in &mod_paths {
        forget_uncertain(&Path::new(p).with_extension("utoc"));
    }
    [crate::xtra_vfx_check::scan_store(), crate::xtra_layout::store(), crate::xtra_mesh::store(), crate::xtra_niagara::layout_store()]
        .iter()
        .map(|s| forget_in(s, &utocs))
        .sum()
}

/// The mods (of `mod_paths`) that will not work, or may crash, in the installed game. Empty when the game's assets
/// cannot be read (no game folder, a custom mods folder outside the game).
#[tauri::command]
pub async fn xtra_broken_mods(mod_paths: Vec<String>, state: State<'_, Arc<Mutex<AppState>>>) -> Result<Vec<Verdict>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mods_dir = state.lock().unwrap().game_path.clone();
        let Some(paks) = paks_dir(&mods_dir) else { return Ok(Vec::new()) };
        let Some(game) = game_assets_if(&paks, || !crate::xtra_vfx::game_running()) else {
            // not read while the game runs: the badges so far stay (brokenMods.ts keeps them on an error), and the next
            // focus without the game reads it
            if crate::xtra_vfx::game_running() {
                crate::xtra_vfx::note_stopped();
                return Err("The game's file list is read once the game is closed.".to_string());
            }
            return Ok(Vec::new());
        };
        let containers = game_containers(&paks);
        let game_updated = containers.iter().map(|c| c.2).max().unwrap_or(0);
        let stamps = crate::xtra_stamp::load_all();
        let base = |p: &Path| p.with_extension("").to_string_lossy().to_lowercase();
        let installed_mods: HashSet<String> = mod_paths.iter().map(|p| base(Path::new(p))).collect();
        let checked = load_checked(&checked_store());
        let (layouts, usmap_id) = (crate::xtra_layout::load_done(), crate::xtra_layout::usmap_id());
        let meshes = crate::xtra_mesh::load_done();
        let anims_moved = crate::xtra_usmap_diff::newest_moved("AnimSequenceBase");
        let niagara_layouts = crate::xtra_niagara::known_layouts(&paks);
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
                // an older update (<name>_UPDATED) whose own update took the mod's name (<name>, made here for this game):
                // each run made <name> again and left this one flagged, back under Needs an update with nothing said
                || crate::xtra_vfx::update_base_stem(&stem).is_some_and(|b| {
                    let newer = path.with_file_name(format!("{b}.pak"));
                    installed_mods.contains(&base(&newer)) && crate::xtra_stamp::of_in(&stamps, &newer).is_some_and(|s| s.game_updated >= game_updated)
                })
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
        // mods with animations have their container listed for class marks, several at a time (about half a second
        // each, once per file: listed keeps them). shortcut: animations only, where Season 11 moved a class; list
        // every mod if a later update moves a class other kinds use
        use rayon::prelude::*;
        let marked: HashMap<&String, (usize, usize)> = mod_paths
            .par_iter()
            .filter_map(|p| {
                let path = PathBuf::from(p);
                if crate::xtra_setup::is_managed_loader(&path) || crate::xtra_builtins::in_folder(&path) { return None; }
                let details = crate::compute_mod_details(&path, &state).ok()?;
                if !details.files.iter().any(|f| is_package(f) && is_animation(&match_key(f))) { return None; }
                Some((p, class_marks(&paks, &path.with_extension("utoc"))?))
            })
            .collect();
        let mut verdicts = mod_paths
            .iter()
            .filter_map(|p| {
                let path = PathBuf::from(p);
                if crate::xtra_setup::is_managed_loader(&path) { return None; }
                // repakxtra: another app's built-in is judged by the game build its app last built it for
                if crate::xtra_builtins::in_folder(&path) {
                    return crate::xtra_builtins::outdated_elsewhere(&path, &paks)
                        .map(|reason| Verdict { path: p.clone(), kind: "risky", reason, stale_niagara: 0, usmap_wait: 0, off_only: false });
                }
                if can_finish(&path) {
                    return Some(Verdict {
                        path: p.clone(),
                        kind: "vfx",
                        reason: "Updated without its Niagara effects while the USMAP was older than the game. The USMAP matches the game now, so the Mod Updater can try a full update from its kept original.".into(),
                        stale_niagara: 0,
                        usmap_wait: 0,
                    off_only: false,
                    });
                }
                // a check found it built for an older game version: flagged whatever its date says
                let record = checked_record(&checked, &path.with_extension("utoc"), game_updated);
                let found = record.filter(|c| c.unknown.is_none()).map(|c| c.outdated);
                if found == Some(true) && !has_fix(&path) {
                    return Some(Verdict {
                        path: p.clone(),
                        kind: "vfx",
                        reason: if record.is_some_and(|c| c.old_layout) {
                            "Its materials are stored in the layout of an older game build, whatever the file's date says, so the game can crash loading them. The Mod Updater rewrites them in the new layout.".into()
                        } else {
                            "Check for update found its materials still built for an earlier game version, so they may look wrong. The Mod Updater rebuilds them on the new game files.".into()
                        },
                        stale_niagara: 0,
                        usmap_wait: 0,
                    off_only: false,
                    });
                }
                let details = crate::compute_mod_details(&path, &state).ok()?;
                let installed = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
                // an update repakxtra made: the game it was made for. One an earlier version made has no stamp: it counts as
                // old as the original beside it, since it carries what that version could not rebuild
                let installed = match crate::xtra_stamp::of_in(&stamps, &path) {
                    Some(s) => installed.max(s.game_updated), // xtra_stamp::made, from the store read once
                    None => crate::xtra_vfx::original_of(&path.with_extension("utoc"))
                        .and_then(|o| std::fs::metadata(o).and_then(|m| m.modified()).ok())
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map_or(installed, |o| installed.min(o.as_secs())),
                };
                let vfx = details.category == "VFX";
                let facts = Facts {
                    files: &details.files,
                    galacta: details.mod_type.contains("Project Galacta"),
                    vfx,
                    materials: !vfx && crate::xtra_vfx::updatable(&details.category, &details.files),
                    mesh: crate::xtra_mesh::found_now(&meshes, &path.with_extension("utoc"), game_updated),
                    class_marks: marked.get(p).copied().unwrap_or_default(),
                    // an update found nothing to rebuild in it (this file, this game): judged like one with its fix beside it
                    fixed: has_fix(&path),
                    cleared: found == Some(false),
                    has_blueprint: details.has_blueprint,
                    installed,
                    anims_moved: anims_moved && !record.is_some_and(|c| c.anims_told && !c.outdated && c.unknown.is_none()),
                    old_layout: details.category == "VFX" && crate::xtra_niagara::known_old_layout(&path, &niagara_layouts),
                    layout: crate::xtra_layout::found_now(&layouts, &path.with_extension("utoc"), game_updated, &usmap_id),
                };
                judge_checked(p, facts, game_updated, &game, record.and_then(|c| c.unknown.as_deref()))
                    // last: any other finding says more, and its update comes out unencrypted anyway
                    .or_else(|| (!has_fix(&path) && crate::xtra_encrypt::encrypted(&path.with_extension("utoc"))).then(|| Verdict {
                        path: p.to_string(),
                        kind: "vfx",
                        reason: ENCRYPTED.into(),
                        stale_niagara: 0,
                        usmap_wait: 0,
                        off_only: false,
                    }))
            })
            .collect::<Vec<Verdict>>();
        // an update the Mod Updater made for this game is never flagged Needs update or Safety unknown again (the Mod
        // Updater's list says Updated), unless the new USMAP can finish a partial one, its files are in an older layout,
        // or its class references do not load, each of which can crash the game
        verdicts.retain(|v| {
            let p = Path::new(&v.path);
            let utoc = p.with_extension("utoc");
            let made = crate::xtra_stamp::of_in(&stamps, p);
            // an inconclusive check of a mod this updater rebuilt is noise, whichever game it was made for
            if v.kind == "unknown" && made.is_some() { return false; }
            v.kind != "vfx"
                || v.reason == ENCRYPTED // an update kept encrypted (Keep mods encrypted) is still encrypted
                || can_finish(p)
                || crate::xtra_niagara::known_old_layout(p, &niagara_layouts)
                || checked_record(&checked, &utoc, game_updated).is_some_and(|c| c.outdated && c.old_layout)
                // or an earlier update left its files without a class (or naming a moved one): the game crashes on it
                || marked.get(&&v.path).is_some_and(|(damaged, moved)| damaged + moved > 0)
                || !made.is_some_and(|s| s.game_updated >= game_updated)
        });
        // A mod that needs an update can be updated with the saved USMAP when no patch newer than it rewrote the files
        // the update decodes. Otherwise it waits for the USMAP of the installed build, and its reason says which
        let usmap = crate::vfx_updater::commands::saved_usmap_path().filter(|u| Path::new(u).is_file());
        if let Some((u, g)) = usmap.as_deref().and_then(|u| crate::xtra_niagara::usmap_behind(u, &paks)) {
            for v in verdicts.iter_mut().filter(|v| v.kind == "vfx" && v.reason != ENCRYPTED) {
                v.usmap_wait = usmap_wait(&paks, usmap.as_deref().unwrap_or_default(), &Path::new(&v.path).with_extension("utoc"));
                v.reason += &if v.usmap_wait > 0 {
                    format!(" It waits for the USMAP of game build {g}: the update changed {} of the files it rebuilds, which the saved USMAP (build {u}) would read wrong.", v.usmap_wait)
                } else {
                    format!(" No patch newer than the saved USMAP (build {u}) changed the files the Mod Updater rebuilds, so it can be updated now, before the USMAP of game build {g} is out.")
                };
            }
        }
        // textures the game cannot read, from the preview kit's texture check (xtra_viewer.rs): Broken, over a weaker verdict
        for (path, reason) in crate::xtra_viewer::texcheck_reasons(&mod_paths) {
            match verdicts.iter_mut().find(|v| v.path == path) {
                Some(v) if v.kind == "broken" => {}
                Some(v) => *v = Verdict { path, kind: "broken", reason, stale_niagara: 0, usmap_wait: 0, off_only: false },
                None => verdicts.push(Verdict { path, kind: "broken", reason, stale_niagara: 0, usmap_wait: 0, off_only: false }),
            }
        }
        Ok(verdicts)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_forget_drops_only_that_mods_records() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("s.json");
        std::fs::write(&store, r#"{"c:/m/a_p.utoc|x":1,"c:/m/a_p.utoc":2,"c:/m/a_p.utoc|9|8|y":3,"c:/m/a_p2.utoc|x":4}"#).unwrap();
        assert_eq!(forget_in(&store, &[checked_key(Path::new(r"C:\m\A_P.utoc"))]), 3);
        assert_eq!(std::fs::read_to_string(&store).unwrap(), r#"{"c:/m/a_p2.utoc|x":4}"#, "a name that only starts the same stays");
    }

    #[test]
    fn an_extracted_package_and_the_game_listing_share_a_key() {
        // game_copies skips what the asset list lacks: an extract's path and the container's entry must key alike
        for (extracted, listed) in [
            ("Marvel/Content/Marvel/VFX/Materials/MI_Glow.uasset", "../../../Marvel/Content/Marvel/VFX/Materials/MI_Glow.uasset"),
            ("Marvel/Plugins/MarvelGAS/Content/Marvel/VFX/NS_Hit.uasset", "../../../Marvel/Plugins/MarvelGAS/Content/Marvel/VFX/NS_Hit.uasset"),
        ] {
            assert_eq!(match_key(extracted), match_key(listed), "{extracted}");
        }
    }

    #[test]
    fn a_container_keeps_its_time_until_its_sizes_change() {
        let mut known = HashMap::new();
        let p = PathBuf::from("C:/Paks/pakchunk0-Windows.utoc");
        let mut found = vec![(p.clone(), 10, 500, 100)];
        assert!(settle(&mut found, &mut known), "first seen: stored");
        assert_eq!(found[0].3, 100);
        found[0].3 = 900; // a Steam verify wrote it again, the same bytes
        assert!(!settle(&mut found, &mut known), "same sizes: nothing stored");
        assert_eq!(found[0].3, 100, "keeps the first time, so no game update is seen");
        let mut patched = vec![(p, 10, 600, 950)]; // an update grew its .ucas
        assert!(settle(&mut patched, &mut known));
        assert_eq!(patched[0].3, 950, "a real change keeps its new time");
    }

    #[test]
    fn packages_cooked_for_the_usmap_build_read_right_with_it() {
        assert_eq!(container_cl(Path::new("Patch_-Windows_1.1.3984769_P.utoc")), Some(3984769));
        assert_eq!(container_cl(Path::new("pakchunk0-Windows.utoc")), None);
        // by build, never by date: A is in today's patch, B last in the USMAP's own, C only in the base chunks
        let builds: GameAssets = [
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
    fn saved_asset_list_loads_back_only_for_the_same_game_build() {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("assets.bin");
        let (mut set, mut builds) = (GameAssets::default(), AssetBuilds { unread: 7, ..Default::default() });
        for (i, f) in ["Marvel/Content/Marvel/A.uasset", "Marvel/Content/Marvel/B.uasset"].iter().enumerate() {
            set.insert(match_key(f), 100 + i as u64);
            builds.by_package.insert(match_key(f), 3962284 * i as u64);
        }
        save(&file, "pakchunk0:1:2", &set, &builds).unwrap();
        let (got, got_builds) = load_saved(&file, "pakchunk0:1:2").expect("same build");
        assert_eq!(got.len(), 2);
        assert_eq!(got.get(&match_key("../../../Marvel/Content/Marvel/B.uasset")), Some(&101));
        assert_eq!(got_builds.by_package.get(&match_key("Marvel/Content/Marvel/B.uasset")), Some(&3962284));
        assert_eq!(got_builds.unread, 7);
        assert!(!got.contains_key(&match_key("Marvel/Content/Marvel/C.uasset")));
        assert!(load_saved(&file, "pakchunk0:1:3").is_none(), "another game build's list is not used");
        let bytes = std::fs::read(&file).unwrap();
        std::fs::write(&file, &bytes[..bytes.len() - 5]).unwrap();
        assert!(load_saved(&file, "pakchunk0:1:2").is_none(), "a cut-off file is not used");
        // the count after magic, key length, key and unread: a damaged one is refused before anything is allocated
        let mut damaged = bytes.clone();
        let at = 8 + 8 + "pakchunk0:1:2".len() + 8;
        damaged[at..at + 8].copy_from_slice(&u64::MAX.to_le_bytes());
        std::fs::write(&file, &damaged).unwrap();
        assert!(load_saved(&file, "pakchunk0:1:2").is_none(), "a damaged count is not trusted");
        assert_ne!(fingerprint("marvel/a"), fingerprint("marvel/b"));
        assert_eq!(fingerprint("a"), 0xaf63_dc4c_8601_ec8c, "FNV-1a's published value: the saved list reads the same in every build");
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
    fn facts(files: &[String], installed: u64) -> Facts<'_> {
        Facts { files, galacta: false, vfx: false, materials: false, fixed: false, cleared: false, has_blueprint: false, installed, anims_moved: false, old_layout: false, layout: None, mesh: None, class_marks: (0, 0) }
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
    fn a_blueprint_mod_gets_no_badge_from_its_date_alone() {
        let files = v(&[LIVE]);
        let bp = |installed, layout| Facts { has_blueprint: true, layout, ..facts(&files, installed) };
        assert_eq!(judge("m.pak", &bp(100, None), 200, &game()), None, "older than the update, not compared yet: no guess a later check takes back");
        assert_eq!(judge("m.bak_repak", &bp(100, Some(Some("x".into()))), 200, &game()).map(|j| j.kind), Some("risky"), "off too, once the check found it");
    }

    #[test]
    fn a_blueprint_mods_layout_check_decides_over_its_date() {
        let files = v(&[LIVE]);
        let bp = |installed, layout| Facts { has_blueprint: true, layout, ..facts(&files, installed) };
        assert_eq!(judge("m.pak", &bp(100, Some(None)), 200, &game()), None, "older than the update, but its classes match the game's");
        let found = judge("m.pak", &bp(300, Some(Some("The game's WBP_X has 1 function this copy lacks (OnA).".into()))), 200, &game()).unwrap();
        assert_eq!((found.kind, found.reason.as_str()), ("risky", "The game's WBP_X has 1 function this copy lacks (OnA)."), "newer than the update, made from old files");
        assert_eq!(judge("m.pak", &bp(100, None), 200, &game()), None, "not compared yet: no badge");
        assert_eq!(judge("m.pak", &Facts { layout: Some(Some("x".into())), ..facts(&files, 100) }, 200, &game()), None, "not a Blueprint mod");
    }

    #[test]
    fn a_vfx_verdict_counts_its_stale_niagara_files() {
        let mut game = game();
        for f in ["/Game/Marvel/VFX/NS_Burst.uasset", "/Game/Marvel/VFX/CurveAtlas_1026.uasset", "/Game/Marvel/VFX/MI_Glow.uasset"] {
            game.insert(match_key(f), 100);
        }
        let files = v(&["Marvel/Content/Marvel/VFX/NS_Burst.uasset", "Marvel/Content/Marvel/VFX/CurveAtlas_1026.uasset", "Marvel/Content/Marvel/VFX/MI_Glow.uasset"]);
        let verdict = judge("m.pak", &Facts { vfx: true, old_layout: true, ..facts(&files, 50) }, 200, &game).unwrap();
        assert_eq!((verdict.kind, verdict.stale_niagara), ("vfx", 2), "the material is rebuilt, the two Niagara files are left out");
    }

    #[test]
    fn a_vfx_mod_gets_a_badge_only_from_a_check() {
        let files = v(&[LIVE, "Marvel/Content/Marvel/VFX/NS_Own.uasset"]);
        let vfx = |installed| Facts { vfx: true, ..facts(&files, installed) };
        assert_eq!(judge("m.pak", &vfx(50), 200, &game()), None, "game files newer than the mod: a guess the materials check could take back");
        assert_eq!(judge("m.pak", &Facts { old_layout: true, ..vfx(150) }, 200, &game()).map(|j| j.kind), Some("vfx"), "the Niagara scan found the old layout");
        assert_eq!(judge("m.pak", &Facts { old_layout: true, cleared: true, ..vfx(150) }, 200, &game()), None, "a materials check cleared it");
    }

    #[test]
    fn another_decoders_finding_stands_until_this_one_looks() {
        let dir = tempfile::tempdir().unwrap();
        let (utoc, store) = (dir.path().join("mod.utoc"), dir.path().join("checked.json"));
        std::fs::write(&utoc, b"toc").unwrap();
        remember_checked(&store, &utoc, 200, true, true, None).unwrap();
        let theirs: HashMap<String, Checked> = load_checked(&store).into_iter().map(|(k, mut c)| { c.parser = "other".into(); (format!("{k}|other"), c) }).collect();
        assert_eq!(checked_now(&theirs, &utoc, 200), Some(true), "found outdated by another decoder: still flagged");
        assert_eq!(checked_now(&theirs, &utoc, 300), None, "not after the game updated again");
    }

    #[test]
    fn inconclusive_materials_replace_date_guesses_but_keep_confirmed_risks() {
        let files = v(&[LIVE]);
        let unknown = || Facts { vfx: true, ..facts(&files, 50) };
        assert_eq!(judge_checked("m.pak", unknown(), 200, &game(), Some("Custom shader data")).unwrap().kind, "unknown");
        assert_eq!(judge_checked("m.pak", unknown(), 200, &game(), None), None, "no check, no badge");
        assert_eq!(judge_checked("m.pak", Facts { old_layout: true, ..unknown() }, 200, &game(), Some("Custom shader data")).unwrap().kind, "vfx");
        assert_eq!(judge_checked("m.pak", Facts { mesh: Some("Bone mismatch".into()), ..unknown() }, 200, &game(), Some("Custom shader data")).unwrap().kind, "risky");
        assert_eq!(judge_checked("m.pak", Facts { has_blueprint: true, layout: Some(Some("Class changed".into())), ..unknown() }, 200, &game(), Some("Custom shader data")).unwrap().kind, "risky");
        let dir = tempfile::tempdir().unwrap();
        let utoc = dir.path().join("mod.utoc");
        let store = dir.path().join("checked.json");
        std::fs::write(&utoc, b"toc").unwrap();
        remember_checked(&store, &utoc, 200, false, false, Some("Unknown".into())).unwrap();
        let saved = load_checked(&store);
        assert_eq!(checked_record(&saved, &utoc, 200).unwrap().unknown.as_deref(), Some("Unknown"));
        assert!(!layout_cleared(&saved, &utoc, 200));
        assert!(checked_record(&saved, &utoc, 300).is_none());
    }

    #[test]
    fn nothing_to_update_holds_until_the_mod_or_the_game_changes() {
        let dir = tempfile::tempdir().unwrap();
        let (store, utoc) = (dir.path().join("checked.json"), dir.path().join("Swap_9999999_P.utoc"));
        std::fs::write(&utoc, b"toc").unwrap();
        remember_checked(&store, &utoc, 200, false, false, None).unwrap();
        remember_checked(&store, &utoc, 200, false, false, Some("Custom shader data".into())).unwrap();
        let all = load_checked(&store);
        assert!(layout_cleared(&all, &utoc, 200), "an inconclusive scan must retain a successful repair's clearance");
        assert_eq!(checked_now(&all, &utoc, 200), Some(false), "the same file, the same game");
        assert_eq!(checked_now(&all, Path::new(&utoc.to_string_lossy().to_uppercase()), 200), Some(false), "any spelling of the path");
        assert_eq!(checked_now(&all, &utoc, 300), None, "the game updated since");
        let mut other = all.clone();
        other.values_mut().for_each(|c| c.parser = String::new());
        assert!(layout_cleared(&other, &utoc, 200), "a clearance outlives a parser change, a legacy one too");
        other.values_mut().for_each(|c| c.outdated = true);
        assert_eq!(checked_now(&other, &utoc, 200), Some(true), "a finding outlives a parser change too, until this decoder looks");
        remember_checked(&store, &utoc, 200, true, true, None).unwrap();
        remember_checked(&store, &utoc, 200, false, false, Some("Unknown".into())).unwrap();
        assert_eq!(checked_now(&load_checked(&store), &utoc, 200), Some(true), "a check found it outdated");
        assert!(checked_record(&load_checked(&store), &utoc, 200).unwrap().unknown.is_none(), "uncertainty cannot replace a confirmed fault");
        remember_checked(&store, &utoc, 300, false, false, Some("New game".into())).unwrap();
        assert_eq!(checked_record(&load_checked(&store), &utoc, 300).unwrap().unknown.as_deref(), Some("New game"), "a new game invalidates the previous evidence");
        std::fs::write(&utoc, b"toc v2").unwrap();
        assert_eq!(checked_now(&all, &utoc, 200), None, "the mod changed");
    }

    #[test]
    fn a_material_or_ko_mod_gets_a_badge_only_from_a_check() {
        let mut game = game();
        let mi = "Marvel/Content/Marvel/Characters/1026/1026800/Materials/MI_Body.uasset";
        game.insert(match_key("/Game/Marvel/Characters/1026/1026800/Materials/MI_Body.uasset"), 100);
        assert_eq!(judge("m.pak", &Facts { materials: true, ..facts(&v(&[mi]), 50) }, 200, &game), None, "the game rewrote its material: the materials check decides, not the date");
        let ko = "Marvel/Content/Marvel/UI/Blueprints/Battle/Custom/1026/WBP_Battle_Kill_1026_V3.uasset";
        game.insert(match_key("/Game/Marvel/UI/Blueprints/Battle/Custom/1026/WBP_Battle_Kill_1026_V3.uasset"), 100);
        let ko_files = v(&[ko, &ko.replace(".uasset", ".uexp")]);
        let kp = |layout| Facts { materials: true, has_blueprint: true, layout, ..facts(&ko_files, 50) };
        assert_eq!(judge("m.pak", &kp(Some(Some("x".into()))), 200, &game).map(|v| v.kind), Some("vfx"), "the class check found a change: Needs update, the updater rebuilds it");
        assert_eq!(judge("m.pak", &kp(None), 200, &game), None, "not compared yet");
        let other = v(&[ko, "Marvel/Content/Marvel/UI/Blueprints/WBP_Other.uasset"]);
        assert_eq!(judge("m.pak", &Facts { materials: true, has_blueprint: true, layout: Some(Some("x".into())), ..facts(&other, 150) }, 200, &game).map(|v| v.kind), Some("risky"), "another Blueprint too");
    }

    #[test]
    fn a_mesh_is_flagged_only_when_it_has_bones_its_rebuilt_skeleton_lacks() {
        let mesh = "Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset";
        let mut game = game();
        game.insert(match_key(mesh), 10);
        game.insert(match_key("/Game/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001_Skeleton.uasset"), 100);
        let files = v(&[mesh]);
        assert_eq!(judge("m.pak", &facts(&files, 50), 200, &game), None, "a rebuilt skeleton alone (24 working swaps had one)");
        let found = judge("m.pak", &Facts { mesh: Some("SK_X has 302 bones and the game's skeleton 242".into()), ..facts(&files, 50) }, 200, &game).unwrap();
        assert_eq!((found.kind, found.off_only), ("risky", true), "the Mod Updater turns it off, it cannot rebuild a mesh");
        let mi = "Marvel/Content/Marvel/Characters/1026/1026001/Materials/MI_1026001_Body.uasset";
        game.insert(match_key(mi), 100);
        let both = v(&[mesh, mi]);
        let found = judge("m.pak", &Facts { materials: true, mesh: Some("x".into()), ..facts(&both, 50) }, 200, &game).unwrap();
        assert_eq!((found.kind, found.off_only), ("risky", true), "stale materials too: still turned off, never rebuilt with the mesh kept");
        let found = judge("m.pak", &Facts { materials: true, cleared: true, mesh: Some("x".into()), ..facts(&both, 50) }, 200, &game).unwrap();
        assert_eq!((found.kind, found.off_only), ("risky", true), "a materials check that cleared it never hides its mesh");
    }

    #[test]
    fn an_animation_blueprint_the_game_cooked_again_may_crash() {
        let abp = "Marvel/Content/Marvel/Characters/1026/1026001/Animations/ABP_1026001.uasset";
        let mut game = game();
        game.insert(match_key(abp), 100);
        let files = v(&[abp]);
        let found = judge("m.pak", &Facts { has_blueprint: true, layout: Some(None), ..facts(&files, 50) }, 200, &game).unwrap();
        assert_eq!((found.kind, found.reason.contains("Animation Blueprint")), ("risky", true), "whatever its class check found");
        assert_eq!(judge("m.pak", &Facts { has_blueprint: true, layout: Some(None), ..facts(&files, 150) }, 200, &game), None, "made after the game's copy changed");
    }

    #[test]
    fn an_animation_made_before_the_update_that_moved_animations_needs_an_update() {
        let emote = "Marvel/Content/Marvel/Characters/1026/1026001/Animations/Emotes/Emote_10260012010.uasset";
        let montage = "Marvel/Content/MysterySeat/WP_MysterySeat_MT.uasset";
        let mut game = game();
        game.insert(match_key(emote), 100);
        game.insert(match_key(montage), 100);
        let files = v(&[emote, montage]);
        let moved = |installed| Facts { anims_moved: true, ..facts(&files, installed) };
        let found = judge("m.pak", &moved(50), 200, &game).unwrap();
        assert_eq!((found.kind, found.reason.contains("its 2 animations were")), ("vfx", true), "{}", found.reason);
        assert_eq!(judge("m.pak", &moved(250), 200, &game), None, "made after the update");
        assert_eq!(judge("m.pak", &facts(&files, 50), 200, &game), None, "the update did not move animations");
        assert_eq!(judge("m.pak", &Facts { fixed: true, ..moved(50) }, 200, &game), None, "its update sits beside it");
        // made after the update, but an earlier update left a file without its class, or it names a class the game moved
        let found = judge("m.pak", &Facts { class_marks: (2, 0), ..facts(&files, 300) }, 200, &game).unwrap();
        assert_eq!((found.kind, found.reason.contains("left 2 of its files without a game class")), ("vfx", true), "{}", found.reason);
        let found = judge("m.pak", &Facts { class_marks: (0, 1), ..facts(&files, 300) }, 200, &game).unwrap();
        assert_eq!((found.kind, found.reason.contains("moved a game class that 1 of its files uses")), ("vfx", true), "{}", found.reason);
        assert_eq!(judge("m.pak", &Facts { class_marks: (0, 1), fixed: true, ..facts(&files, 300) }, 200, &game), None, "the kept original beside its update");
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
        let niagara_layouts = crate::xtra_niagara::known_layouts(&paks);
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
                mesh: None,
                class_marks: (0, 0),
                fixed: false,
                cleared: false,
                has_blueprint: true,
                installed,
                anims_moved: false,
                old_layout: vfx && crate::xtra_niagara::known_old_layout(&p, &niagara_layouts),
                layout,
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
                Ok(_) => (judge(&name, &facts(None), updated, &game), "partly read, no badge".to_string()),
                Err(e) => (judge(&name, &facts(None), updated, &game), format!("not checked, no badge: {e}")),
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
