//! repakxtra: the VFX Updater (custom/vfx/), on top of the upstream VFX Updater's UAssetTool steps (vfx_updater/).
//! Adds what the frontend's pipeline needs beyond them: a fresh temp folder per run, a cache of the game's own assets per
//! game build (every mod of a batch reuses one extraction), type detection that names what it could not read, placing the
//! fixed mod beside the original (on or off like it, the original turned off, an older fixed copy to Recently deleted),
//! and the installed game's build.

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Emitter, Manager, State, Window};

use crate::vfx_updater::models::VfxPipelineProgress;
use crate::vfx_updater::progress::{TauriVfxProgressSink, VfxProgressSink};
use crate::vfx_updater::uasset_tool::{run_vfx_uat_request, VfxUatRequest};
use crate::AppState;

fn base_dir() -> PathBuf {
    std::env::temp_dir().join("repak-x").join("xvfx")
}

/// The game's Paks folder's build: changes whenever an update rewrites a container (xtra_broken::build_key).
fn build_hash(game_paks: &Path) -> String {
    let key = crate::xtra_broken::build_key(&crate::xtra_broken::game_containers(game_paks));
    let mut h = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// The one VFX run in progress, app-wide: the VFX Updater window's batch or a right-click update in the main window.
/// Both share base_dir(), and a run clears the others' folders (make_dirs), so two must never overlap. Held in the
/// backend so a claim is atomic across windows, kept until its owner lets go (no time limit: a long step stays held),
/// and let go when the window that took it closes.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunLock {
    token: String,
    window: String,
    name: Option<String>,
}
static RUN: Mutex<Option<RunLock>> = Mutex::new(None);

fn announce(app: &tauri::AppHandle) {
    let held = RUN.lock().unwrap().clone();
    let _ = app.emit("vfx_lock_changed", held);
}

/// Takes the run lock for `token` (one per run), or renews its name. False when another run holds it.
#[tauri::command]
pub fn xtra_vfx_claim(window: Window, token: String, name: Option<String>) -> bool {
    let fresh = {
        let mut run = RUN.lock().unwrap();
        match run.as_mut() {
            Some(l) if l.token != token => return false,
            Some(l) => {
                l.name = name;
                false
            }
            None => {
                *run = Some(RunLock { token: token.clone(), window: window.label().to_string(), name });
                true
            }
        }
    };
    if fresh {
        // a window closed mid-run lets go of its lock
        let label = window.label().to_string();
        let app = window.app_handle().clone();
        window.on_window_event(move |e| {
            if matches!(e, tauri::WindowEvent::Destroyed) {
                let mut run = RUN.lock().unwrap();
                if run.as_ref().is_some_and(|l| l.window == label) {
                    *run = None;
                    drop(run);
                    announce(&app);
                }
            }
        });
    }
    announce(window.app_handle());
    true
}

/// Lets go of the run lock, if `token` holds it.
#[tauri::command]
pub fn xtra_vfx_release(window: Window, token: String) {
    {
        let mut run = RUN.lock().unwrap();
        if run.as_ref().is_some_and(|l| l.token == token) {
            *run = None;
        }
    }
    announce(window.app_handle());
}

/// Who holds the run lock, if anyone.
#[tauri::command]
pub fn xtra_vfx_lock() -> Option<RunLock> {
    RUN.lock().unwrap().clone()
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VfxDirs {
    mod_extract: String,
    mod_json: String,
    edited_json: String,
    final_uassets: String,
    stage: String,
    /// The game's own assets for this game build, shared by every run until the game updates
    vanilla_extract: String,
    vanilla_json: String,
    /// Which asset keys the vanilla folders already hold (or the game lacks): custom/vfx/pipeline.ts reads and writes it
    vanilla_index: String,
}

/// Run ids become folder names.
fn valid_run_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The USMAP file's identity (path, size, time written): the game's JSON decoded with one USMAP is no use with another.
fn usmap_hash(usmap: &str) -> String {
    let meta = std::fs::metadata(usmap).ok();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    usmap.to_lowercase().hash(&mut h);
    meta.as_ref().map(|m| m.len()).hash(&mut h);
    meta.and_then(|m| m.modified().ok()).hash(&mut h);
    format!("{:08x}", h.finish() as u32)
}

fn make_dirs(game_paks: &str, run_id: &str, usmap: &str) -> Result<VfxDirs, String> {
    if !valid_run_id(run_id) {
        return Err(format!("Invalid run id: {run_id}"));
    }
    let base = base_dir();
    let run = base.join(format!("run-{run_id}"));
    let vanilla = base.join(format!("vanilla-{}-{}", build_hash(Path::new(game_paks)), usmap_hash(usmap)));
    // Earlier runs and other game builds or USMAPs go: one run at a time (the window waits out a cancelled one), and a
    // cache from another build or USMAP would hand out old or wrongly decoded game files
    if let Ok(entries) = std::fs::read_dir(&base) {
        for e in entries.flatten() {
            let p = e.path();
            if p != run && p != vanilla && p.is_dir() {
                let _ = std::fs::remove_dir_all(&p);
            }
        }
    }
    let _ = crate::vfx_updater::file_ops::cleanup_vfx_temp_directories(); // the upstream updater's rvfx_* leftovers
    let _ = std::fs::remove_dir_all(&run);
    let s = |p: PathBuf| -> Result<String, String> {
        std::fs::create_dir_all(&p).map_err(|e| format!("Could not create {}: {e}", p.display()))?;
        Ok(p.to_string_lossy().replace('\\', "/"))
    };
    Ok(VfxDirs {
        mod_extract: s(run.join("mod_extract"))?,
        mod_json: s(run.join("mod_json"))?,
        edited_json: s(run.join("edited_json"))?,
        final_uassets: s(run.join("final_uassets"))?,
        stage: s(run.join("stage"))?,
        vanilla_extract: s(vanilla.join("extract"))?,
        vanilla_json: s(vanilla.join("json"))?,
        vanilla_index: vanilla.join("index.json").to_string_lossy().replace('\\', "/"),
    })
}

#[tauri::command]
pub fn xtra_vfx_dirs(game_paks: String, run_id: String, usmap_path: Option<String>) -> Result<VfxDirs, String> {
    make_dirs(&game_paks, &run_id, usmap_path.as_deref().unwrap_or(""))
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Detected {
    /// "material_instance", "blueprint" or "other"
    kind: &'static str,
    class: Option<String>,
    /// Why the tool could not read it (then kind is "other": it passes through as it was)
    error: Option<String>,
}

/// detect_type's class name as the kind the pipeline edits (the upstream updater's mapping). detect_type names the first
/// export's class, and some material instances list their user data first: "maybe" has the pipeline look at the JSON.
fn kind_of(class: &str) -> &'static str {
    match class.trim().to_ascii_lowercase().as_str() {
        "material_instance" | "materialinstance" | "materialinstanceconstant" | "materialinstancedynamic" => "material_instance",
        "blueprint" | "blueprintgeneratedclass" | "canvaspanelslot" => "blueprint",
        c if c.ends_with("assetuserdata") => "maybe",
        _ => "other",
    }
}

async fn detect(usmap_path: &str, paths: &[String], progress: &dyn VfxProgressSink) -> Result<HashMap<String, Detected>, String> {
    let tool = PathBuf::new(); // the in-process library ignores it
    let mut out = HashMap::new();
    let mut failed = None;
    for (i, batch) in paths.chunks(100).enumerate() {
        let request = VfxUatRequest { action: "detect_type", file_paths: Some(batch.to_vec()), usmap_path: Some(usmap_path), ..Default::default() };
        match run_vfx_uat_request(&tool, &request).await {
            Ok(r) if r.success => {
                for item in r.data.as_ref().and_then(|d| d.get("results")).and_then(|v| v.as_array()).into_iter().flatten() {
                    let Some(path) = item.get("path").and_then(|v| v.as_str()) else { continue };
                    let class = item.get("asset_type").and_then(|v| v.as_str()).map(String::from);
                    let error = item.get("error").and_then(|v| v.as_str()).map(String::from);
                    out.insert(path.to_string(), Detected { kind: class.as_deref().map_or("other", kind_of), class, error });
                }
            }
            Ok(r) => failed = Some(r.message),
            Err(e) => failed = Some(e),
        }
        let done = ((i + 1) * 100).min(paths.len());
        progress.emit(VfxPipelineProgress { stage: "Reading asset types".into(), step: 1, current: done, total: paths.len(), message: format!("Read {done} of {} asset types", paths.len()) });
    }
    // Nothing came back: say why, rather than treat every asset as one to pass through (the old silent no-op)
    match failed {
        Some(e) if out.is_empty() && !paths.is_empty() => Err(format!("Could not read the mod's asset types: {e}")),
        _ => Ok(out),
    }
}

/// Each asset's kind, with the tool's reason when it could not read one.
#[tauri::command]
pub async fn xtra_vfx_detect(window: Window, usmap_path: String, paths: Vec<String>) -> Result<HashMap<String, Detected>, String> {
    detect(&usmap_path, &paths, &TauriVfxProgressSink::new(&window)).await
}

/// A mod's file stem split before its priority suffix ("_<digits>_P" or "_P"): ("A", "_9999999_P").
fn split_priority(stem: &str) -> (&str, &str) {
    let b = stem.trim();
    let cut = b.rfind('_').filter(|&i| b[i + 1..].eq_ignore_ascii_case("P")).map(|i| {
        let head = &b[..i];
        head.rfind('_').filter(|&j| j + 1 < i && head[j + 1..].bytes().all(|c| c.is_ascii_digit())).unwrap_or(i)
    });
    let cut = cut.unwrap_or(b.len());
    (&b[..cut], &b[cut..])
}

/// The name without a trailing `marker` (case aside).
fn strip_marker<'a>(name: &'a str, marker: &str) -> &'a str {
    let n = marker.len();
    if name.len() > n && name.is_char_boundary(name.len() - n) && name[name.len() - n..].eq_ignore_ascii_case(marker) {
        &name[..name.len() - n]
    } else {
        name
    }
}

/// `<name>_UPDATED_9999999_P` for a mod's file stem: the name without its priority suffix (and without an earlier
/// _UPDATED, so fixing a fixed mod keeps its name), spaces as underscores.
pub(crate) fn fixed_stem(stem: &str) -> String {
    let b = strip_marker(split_priority(stem).0, "_UPDATED");
    let b = b.trim().split_whitespace().collect::<Vec<_>>().join("_");
    format!("{b}_UPDATED_9999999_P")
}

/// The stems (lowercase) of the mod files in `dir`.
fn stems_in(dir: &Path) -> HashSet<String> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let x = p.extension()?.to_string_lossy().to_lowercase();
            MOD_EXTS.contains(&x.as_str()).then(|| p.file_stem().map(|s| s.to_string_lossy().to_lowercase()))?
        })
        .collect()
}

/// fixed_stem, unless another original among `siblings` (the stems in the same folder, lowercase) gets the same name, as
/// A_100_P and A_200_P both would: then the original's priority goes into the name (A_100_UPDATED_9999999_P), so one
/// mod's update never takes the place of another's.
pub(crate) fn fixed_stem_among(stem: &str, siblings: &HashSet<String>) -> String {
    let plain = fixed_stem(stem);
    if plain.eq_ignore_ascii_case(stem) {
        return plain; // an update itself
    }
    let me = stem.to_lowercase();
    let original = |s: &String| *s != me && !fixed_stem(s).eq_ignore_ascii_case(s); // another original, not an update
    if !siblings.iter().any(|s| original(s) && fixed_stem(s).eq_ignore_ascii_case(&plain)) {
        return plain;
    }
    // with the priority: A_100_P and A_200_P differ. Names that differ only in spaces and underscores (A B_100_P and
    // A_B_100_P) still meet, so then the exact original name's hash goes in too
    let tagged = |s: &str| {
        let (b, p) = split_priority(s);
        let tag: String = p.chars().filter(|c| c.is_ascii_digit()).collect();
        let b = strip_marker(b, "_UPDATED").trim().split_whitespace().collect::<Vec<_>>().join("_");
        format!("{b}_{}", if tag.is_empty() { "0" } else { &tag })
    };
    let mine = tagged(stem);
    if !siblings.iter().any(|s| original(s) && tagged(s).eq_ignore_ascii_case(&mine)) {
        return format!("{mine}_UPDATED_9999999_P");
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    stem.trim().hash(&mut h);
    format!("{mine}_{:06x}_UPDATED_9999999_P", h.finish() & 0xff_ffff)
}

/// `<name>_BROKEN<priority>`: the name the original takes when its update keeps the mod's own name.
pub(crate) fn broken_stem(stem: &str) -> String {
    let (b, p) = split_priority(stem);
    format!("{}_BROKEN{p}", strip_marker(b, "_BROKEN"))
}

/// The mod's own name for a `_BROKEN` original (the name its update has), or the name itself.
pub(crate) fn unbroken_stem(stem: &str) -> String {
    let (b, p) = split_priority(stem);
    format!("{}{p}", strip_marker(b, "_BROKEN"))
}

const MOD_EXTS: [&str; 5] = ["pak", "bak_repak", "pak_disabled", "utoc", "ucas"];

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Placed {
    /// The fixed mod's .pak (on) or .bak_repak (off)
    fixed: String,
    /// The original's main file now (its .bak_repak when it was turned off)
    original: String,
    /// The original was on and is now off
    turned_off: bool,
    /// An older fixed copy (or the fixed mod's previous version) went to Recently deleted
    replaced: bool,
    /// The original went to Recently deleted (trash_original), off, so restoring it never clashes with the update
    trashed: bool,
    /// The update is in, but something around it did not go as asked (the original could not go to Recently deleted)
    warning: Option<String>,
}

/// Puts a packed fix (`staged_base` + .utoc/.ucas/.pak) beside the mod it was made from (`source`, its .utoc), on or off
/// like the source. With `keep_name` (the default) the fix takes the mod's own name and the original is renamed
/// `<name>_BROKEN` (broken_stem), so loadouts and tags keep pointing at the working copy. Without it the fix is named
/// fixed_stem_among (`_UPDATED`) and the original keeps its name. With `turn_off_original` an original that was on goes
/// off (its .pak becomes .bak_repak). With `trash_original` the original then goes to Recently deleted, turned off
/// first; if it cannot, it stays (off) and `warning` says why. Files already holding either name go to Recently deleted
/// first (an older update, an older broken copy). The update is copied into the mods folder under temporary names before
/// anything else changes, so a copy that fails part way (a full disk) leaves the mod as it was; every later failure puts
/// back what moved and names any file it could not. Returns the names tags should carry over to.
fn place(source: &Path, staged_base: &Path, turn_off_original: bool, keep_name: bool, trash_original: bool, trash_root: &Path) -> Result<(Placed, String, Vec<String>), String> {
    let dir = source.parent().ok_or("The mod has no folder")?;
    let stem = source.file_stem().ok_or("The mod has no name")?.to_string_lossy().to_string();
    let files = |s: &str| MOD_EXTS.iter().map(|x| dir.join(format!("{s}.{x}"))).filter(|p| p.exists()).collect::<Vec<_>>();
    let was_on = dir.join(format!("{stem}.pak")).exists();
    // where the fix goes, and where the original ends up
    let (target, kept) = if keep_name { (unbroken_stem(&stem), broken_stem(&stem)) } else { (fixed_stem_among(&stem, &stems_in(dir)), stem.clone()) };
    let eq = |a: &str, b: &str| a.eq_ignore_ascii_case(b);
    // updating an _UPDATED copy without keep_name: the new update replaces it
    let replace = eq(&target, &kept);
    let turn_off = (turn_off_original || trash_original) && was_on && !replace;
    if was_on && dir.join(format!("{stem}.bak_repak")).exists() {
        return Err(format!("Both an on and an off copy of {stem} are in the mods folder. Delete one of them, then update it again."));
    }
    let staged = |x: &str| PathBuf::from(format!("{}.{x}", staged_base.to_string_lossy()));
    for x in ["utoc", "ucas", "pak"] {
        if !staged(x).exists() {
            return Err(format!("The fixed mod's .{x} is missing"));
        }
    }

    // 1. the update into the mods folder under temporary names (the game loads none of them): a copy that fails part way
    //    leaves only these, and they go
    let tmp = |x: &str| dir.join(format!("{target}.{x}.repakxtra-tmp"));
    let mut temps: Vec<PathBuf> = Vec::new();
    for x in ["utoc", "ucas", "pak"] {
        let to = tmp(x);
        temps.push(to.clone()); // a partial copy goes too
        if let Err(e) = std::fs::rename(staged(x), &to).or_else(|_| std::fs::copy(staged(x), &to).map(|_| ())) {
            for t in &temps {
                let _ = std::fs::remove_file(t);
            }
            return Err(format!("Could not copy the update into the mods folder: {e}. Nothing in the mods folder changed."));
        }
    }
    let drop_temps = || {
        for t in &temps {
            let _ = std::fs::remove_file(t);
        }
    };

    // 2. what stands in the way: the names the fix and the original move to, unless the original is already there
    let mut existing = Vec::new();
    for s in if replace { vec![&target] } else { vec![&target, &kept] } {
        if replace || !eq(s, &stem) {
            existing.extend(files(s));
        }
    }
    let trash = if existing.is_empty() {
        None
    } else {
        match crate::xtra_trash::reserve_in(trash_root, None) {
            Ok(t) => Some(t),
            Err(e) => {
                drop_temps();
                return Err(e);
            }
        }
    };
    let mut trashed = Vec::new();
    let mut renamed: Vec<(PathBuf, PathBuf)> = Vec::new();
    // puts back what moved, and names what it could not
    let undo = |trashed: &[PathBuf], renamed: &[(PathBuf, PathBuf)]| -> Vec<String> {
        let mut stuck = Vec::new();
        for (from, to) in renamed.iter().rev() {
            if let Err(e) = std::fs::rename(to, from) {
                stuck.push(format!("{} is still named {} ({e})", from.display(), to.display()));
            }
        }
        if let Some(t) = &trash {
            for p in trashed {
                if let Err(e) = crate::xtra_trash::put_back(t, p) {
                    stuck.push(format!("{} is in Settings > Recently deleted ({e})", p.display()));
                }
            }
            crate::xtra_trash::release_if_empty(t);
        }
        stuck
    };
    let fail = |msg: String, stuck: Vec<String>| {
        if stuck.is_empty() {
            format!("{msg} The mod is as it was.")
        } else {
            format!("{msg} Some files could not be put back: {}.", stuck.join(". "))
        }
    };
    for p in &existing {
        if let Err(e) = crate::xtra_trash::discard(trash.as_ref().unwrap(), p) {
            drop_temps();
            return Err(fail(format!("Could not move {} to Recently deleted: {e}.", p.display()), undo(&trashed, &renamed)));
        }
        trashed.push(p.clone());
    }

    // 3. the original to its new name, and off
    for from in if replace { Vec::new() } else { files(&stem) } {
        let x = from.extension().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
        let x = if turn_off && x.eq_ignore_ascii_case("pak") { "bak_repak".to_string() } else { x };
        let to = dir.join(format!("{kept}.{x}"));
        if to == from {
            continue;
        }
        if let Err(e) = std::fs::rename(&from, &to) {
            drop_temps();
            return Err(fail(format!("Could not rename the original {}: {e}.", from.display()), undo(&trashed, &renamed)));
        }
        renamed.push((from, to));
    }

    // 4. the update to its own names: renames in one folder
    let main = dir.join(format!("{target}.{}", if was_on { "pak" } else { "bak_repak" }));
    let finals = [(tmp("utoc"), dir.join(format!("{target}.utoc"))), (tmp("ucas"), dir.join(format!("{target}.ucas"))), (tmp("pak"), main.clone())];
    for (i, (from, to)) in finals.iter().enumerate() {
        if let Err(e) = std::fs::rename(from, to) {
            // the update's files already moved go back to their temporary names (and then away); one that cannot is named
            let mut stuck: Vec<String> = finals[..i]
                .iter()
                .filter_map(|(t, done)| std::fs::rename(done, t).err().map(|re| format!("{} is still in the mods folder ({re})", done.display())))
                .collect();
            drop_temps();
            stuck.extend(undo(&trashed, &renamed));
            return Err(fail(format!("Could not put the update in place: {e}."), stuck));
        }
    }

    let original = if replace { main.clone() } else { dir.join(format!("{kept}.{}", if was_on && !turn_off { "pak" } else { "bak_repak" })) };
    // 5. the original to Recently deleted, as one deletion of its own. The update is in either way: a failure puts back
    //    what moved and says so, naming any file left in Recently deleted
    let mut warning = None;
    let gone_word = |e: &str| format!("The original could not go to Recently deleted ({e}), so it stays in the mods folder, off.");
    let trashed = trash_original && !replace && {
        let gone = files(&kept);
        match crate::xtra_trash::reserve_in(trash_root, None) {
            Ok(t) => {
                let mut moved = Vec::new();
                let mut err = None;
                for f in &gone {
                    match crate::xtra_trash::discard(&t, f) {
                        Ok(_) => moved.push(f.clone()),
                        Err(e) => {
                            err = Some(format!("{}: {e}", f.display()));
                            break;
                        }
                    }
                }
                let ok = err.is_none();
                if let Some(e) = err {
                    let stuck: Vec<String> = moved.iter().filter_map(|f| crate::xtra_trash::put_back(&t, f).err().map(|pe| format!("{} ({pe})", f.display()))).collect();
                    warning = Some(if stuck.is_empty() {
                        gone_word(&e)
                    } else {
                        format!("The original could not go to Recently deleted ({e}), and some of its files could not be put back: {}. Restore them from Settings > Recently deleted.", stuck.join(", "))
                    });
                }
                crate::xtra_trash::release_if_empty(&t);
                ok && !gone.is_empty()
            }
            Err(e) => {
                warning = Some(gone_word(&e));
                false
            }
        }
    };
    let p = |p: &Path| p.to_string_lossy().to_string();
    let placed = Placed { fixed: p(&main), original: p(&original), turned_off: turn_off, replaced: !existing.is_empty(), trashed, warning };
    Ok((placed, stem, vec![target, kept]))
}

#[tauri::command]
pub fn xtra_vfx_place(source: String, staged_base: String, turn_off_original: bool, keep_name: Option<bool>, trash_original: Option<bool>, state: State<'_, Arc<Mutex<AppState>>>) -> Result<Placed, String> {
    crate::xtra_identity::upstream_guard()?;
    // renaming or replacing containers the game has loaded: not while it runs, as every other mod change
    let bypass = state.lock().map(|s| s.bypass_game_running_lock).unwrap_or(false);
    if !bypass && crate::is_game_process_running() {
        return Err("Marvel Rivals is running. Close it, then update again. The mod was not changed.".into());
    }
    let trash_original = trash_original.unwrap_or(false);
    let (placed, from, to) = place(Path::new(&source), Path::new(&staged_base), turn_off_original, keep_name.unwrap_or(true), trash_original, &crate::xtra_trash::trash_dir())?;
    let mut s = state.lock().unwrap();
    let key = |stem: &str| crate::get_mod_key(Path::new(&format!("{stem}.pak")));
    if let Some(tags) = s.mod_tags.get(&key(&from)).cloned() {
        for t in &to {
            s.mod_tags.entry(key(t)).or_insert_with(|| tags.clone());
        }
        let _ = crate::save_state(&s);
    }
    Ok(placed)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VfxMods {
    mods: Vec<VfxMod>,
    /// What could not be read: folders the scan could not open, mods whose contents could not be read. Not empty means
    /// the list may be missing mods
    problems: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VfxMod {
    /// The mod's main file (.pak, or .bak_repak when it is off)
    path: String,
    utoc: String,
    enabled: bool,
    /// Its name in the Library (a custom name, or the file's)
    name: String,
    hero: Option<String>,
    /// When its file was written (seconds), for Newest first
    modified: u64,
}

/// The mods folder's VFX mods (the Library's VFX type) the VFX Updater can update: IoStore mods, no originals with an update
/// beside them (<name>_BROKEN, or <name> next to <name>_UPDATED). Details come from the Library's cache, so after the first look this is quick.
#[tauri::command]
pub async fn xtra_vfx_mods(window: Window, state: State<'_, Arc<Mutex<AppState>>>) -> Result<VfxMods, String> {
    let mods = crate::get_pak_files(state.clone()).await?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // the Library's scan skips what it cannot open: walk again and keep those, so a partial list says so
        let root = state.lock().unwrap().game_path.clone();
        let mut problems: Vec<String> = walkdir::WalkDir::new(&root)
            .into_iter()
            .filter_entry(crate::xtra_bundle::not_staging)
            .filter_map(|e| e.err())
            .map(|e| e.path().map_or_else(|| e.to_string(), |p| format!("{}: {e}", p.display())))
            .collect();
        let unread = Mutex::new(Vec::<String>::new());
        // each folder's stems: an update counts only beside its own original
        let mut by_dir: HashMap<PathBuf, HashSet<String>> = HashMap::new();
        for m in &mods {
            if let (Some(d), Some(s)) = (m.path.parent(), m.path.file_stem()) {
                by_dir.entry(d.to_path_buf()).or_default().insert(s.to_string_lossy().to_lowercase());
            }
        }
        let total = mods.len();
        let list = mods
            .into_iter()
            .enumerate()
            .filter_map(|(i, m)| {
                if i % 8 == 0 || i + 1 == total {
                    let _ = window.emit("vfx_mods_progress", serde_json::json!({ "done": i + 1, "total": total }));
                }
                let utoc = m.utoc_path.clone()?;
                let stem = m.path.file_stem()?.to_string_lossy().to_string();
                let siblings = by_dir.get(m.path.parent()?)?;
                // an original whose update sits beside it: <name>_BROKEN, or <name> next to <name>_UPDATED from before
                let fixed = fixed_stem_among(&stem, siblings);
                if !unbroken_stem(&stem).eq_ignore_ascii_case(&stem) || (!fixed.eq_ignore_ascii_case(&stem) && siblings.contains(&fixed.to_lowercase())) {
                    return None;
                }
                let details = match crate::compute_mod_details(&m.path, &state) {
                    Ok(d) => d,
                    Err(e) => {
                        unread.lock().unwrap().push(format!("{}: {e}", m.path.display()));
                        return None;
                    }
                };
                (details.category == "VFX").then(|| VfxMod {
                    name: m.custom_name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| split_priority(&stem).0.to_string()),
                    hero: m.character_name.clone(),
                    path: m.path.to_string_lossy().to_string(),
                    utoc: utoc.to_string_lossy().to_string(),
                    enabled: m.enabled,
                    modified: m.modified_date,
                })
            })
            .collect::<Vec<_>>();
        problems.extend(unread.into_inner().unwrap());
        VfxMods { mods: list, problems }
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GameBuild {
    /// When the newest game container was written (seconds): the last update
    updated: u64,
    /// The changelist in the newest patch container's name (Patch_-Windows_1.1.<cl>_P.utoc)
    cl: Option<u64>,
}

fn game_build(paks: &Path) -> GameBuild {
    let containers = crate::xtra_broken::game_containers(paks);
    let cl = containers
        .iter()
        .filter_map(|(p, ..)| {
            let name = p.file_stem()?.to_string_lossy().to_string();
            let core = name.strip_suffix("_P")?;
            core.rsplit(|c: char| c == '.' || c == '_').next()?.parse::<u64>().ok()
        })
        .filter(|cl| *cl > 100_000)
        .max();
    GameBuild { updated: containers.iter().map(|c| c.2).max().unwrap_or(0), cl }
}

/// The installed game's last update and build, for the Update VFX mods notice and the USMAP check.
#[tauri::command]
pub fn xtra_game_build(state: State<'_, Arc<Mutex<AppState>>>) -> GameBuild {
    let mods = state.lock().unwrap().game_path.clone();
    mods.ancestors().find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Paks"))).map(game_build).unwrap_or_default()
}

/// Of `files` (paths inside the mod at `mod_path`), those whose game copy an update rewrote after the mod was written.
/// The updater copies Niagara files as they are, and one still cooked for the old game can crash it (Niagara properties
/// renumbered in 3962284), so a run leaves these out of the update.
/// shortcut: "written" is the mod file's date, so a mod reinstalled after the update looks current; read the packages'
/// cook build instead if they ever carry one.
fn stale(mod_path: &str, files: &[String]) -> Result<Vec<String>, String> {
    let path = Path::new(mod_path);
    let written = std::fs::metadata(path).and_then(|m| m.modified()).map_err(|e| format!("{}: {e}", path.display()))?;
    let written = written.duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    Ok(path.parent().and_then(|dir| crate::xtra_broken::rewritten_since(dir, files, written)).unwrap_or_default())
}

#[tauri::command]
pub async fn xtra_vfx_stale(mod_path: String, files: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || stale(&mod_path, &files)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfx_updater::{commands as c, file_ops, logging, pipeline, progress::NoOpProgressSink};
    use serde_json::{json, Value};
    use std::io::{BufRead, Write};

    #[test]
    fn fixed_names_drop_the_priority_and_keep_one_updated() {
        assert_eq!(fixed_stem("BlueColoredVFX_9999999_P"), "BlueColoredVFX_UPDATED_9999999_P");
        assert_eq!(fixed_stem("BlueColoredVFX_UPDATED_9999999_P"), "BlueColoredVFX_UPDATED_9999999_P");
        assert_eq!(fixed_stem("bp-lime-vfx_vfx_noPG_v1_P"), "bp-lime-vfx_vfx_noPG_v1_UPDATED_9999999_P");
        assert_eq!(fixed_stem("My Mod 2"), "My_Mod_2_UPDATED_9999999_P");
        assert_eq!(fixed_stem("!JIRA_x_123_P"), "!JIRA_x_UPDATED_9999999_P");
        assert_eq!(fixed_stem("v_2_P_x"), "v_2_P_x_UPDATED_9999999_P");
    }

    #[test]
    fn broken_names_keep_the_priority_and_one_marker() {
        assert_eq!(broken_stem("BlueColoredVFX_9999999_P"), "BlueColoredVFX_BROKEN_9999999_P");
        assert_eq!(broken_stem("BlueColoredVFX_BROKEN_9999999_P"), "BlueColoredVFX_BROKEN_9999999_P");
        assert_eq!(broken_stem("bp-lime_P"), "bp-lime_BROKEN_P");
        assert_eq!(broken_stem("Plain"), "Plain_BROKEN");
        assert_eq!(unbroken_stem("BlueColoredVFX_BROKEN_9999999_P"), "BlueColoredVFX_9999999_P");
        assert_eq!(unbroken_stem("BlueColoredVFX_9999999_P"), "BlueColoredVFX_9999999_P");
    }

    #[test]
    fn updated_names_take_the_priority_when_two_originals_would_clash() {
        let set = |v: &[&str]| v.iter().map(|s| s.to_lowercase()).collect::<HashSet<_>>();
        assert_eq!(fixed_stem_among("A_9999999_P", &set(&["A_9999999_P", "B_P"])), "A_UPDATED_9999999_P", "no clash, the usual name");
        assert_eq!(fixed_stem_among("A_100_P", &set(&["A_100_P", "A_200_P"])), "A_100_UPDATED_9999999_P");
        assert_eq!(fixed_stem_among("A_200_P", &set(&["A_100_P", "A_200_P"])), "A_200_UPDATED_9999999_P");
        assert_eq!(fixed_stem_among("A_100_P", &set(&["A_100_P", "A_UPDATED_9999999_P"])), "A_UPDATED_9999999_P", "its earlier update is not a clash");
        assert_eq!(fixed_stem_among("A_100_UPDATED_9999999_P", &set(&["A_100_UPDATED_9999999_P", "A_200_P"])), "A_100_UPDATED_9999999_P", "an update keeps its name");
        // names that differ only in a space and an underscore get the exact name's hash, so they still differ
        let both = set(&["A B_100_P", "A_B_100_P"]);
        let (x, y) = (fixed_stem_among("A B_100_P", &both), fixed_stem_among("A_B_100_P", &both));
        assert!(x != y && x.starts_with("A_B_100_") && x.ends_with("_UPDATED_9999999_P"), "{x} {y}");
    }

    #[test]
    fn place_leaves_the_mod_as_it_was_when_the_update_cannot_be_copied() {
        let root = std::env::temp_dir().join(format!("xvfx-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mods = root.join("mods");
        for x in ["pak", "utoc", "ucas"] {
            touch(&mods.join(format!("A_9999999_P.{x}")), "old");
        }
        for x in ["utoc", "ucas"] {
            touch(&root.join(format!("stage/out.{x}")), "new"); // no .pak staged after the first check passes: see below
        }
        touch(&root.join("stage/out.pak"), "new");
        // a directory where the .pak's temporary copy must go makes that copy fail after the .utoc and .ucas moved
        std::fs::create_dir_all(mods.join("A_9999999_P.pak.repakxtra-tmp")).unwrap();
        std::fs::write(mods.join("A_9999999_P.pak.repakxtra-tmp").join("x"), "block").unwrap();
        let err = place(&mods.join("A_9999999_P.utoc"), &root.join("stage/out"), true, true, false, &root.join("trash")).unwrap_err();
        assert!(err.contains("Nothing in the mods folder changed"), "{err}");
        for x in ["pak", "utoc", "ucas"] {
            assert_eq!(std::fs::read_to_string(mods.join(format!("A_9999999_P.{x}"))).unwrap(), "old", "the original is untouched");
        }
        assert!(!mods.join("A_BROKEN_9999999_P.bak_repak").exists());
        assert!(!mods.join("A_9999999_P.utoc.repakxtra-tmp").exists() && !mods.join("A_9999999_P.ucas.repakxtra-tmp").exists(), "no temporary copies left");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn kinds_match_the_upstream_mapping() {
        assert_eq!(kind_of("MaterialInstanceConstant"), "material_instance");
        assert_eq!(kind_of("BlueprintGeneratedClass"), "blueprint");
        assert_eq!(kind_of("NiagaraSystem"), "other");
        assert_eq!(kind_of("DatasmithAssetUserData"), "maybe", "a material instance whose user data comes first");
    }

    #[test]
    fn game_build_reads_the_newest_patch_changelist() {
        let dir = std::env::temp_dir().join(format!("xvfx-build-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for n in ["pakchunk0-Windows.utoc", "Patch_-Windows_1.1.3939753_P.utoc", "Patch_-Windows_1.1.3962284_P.utoc", "global.utoc"] {
            std::fs::write(dir.join(n), b"x").unwrap();
        }
        let b = game_build(&dir);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(b.cl, Some(3962284));
        assert!(b.updated > 0);
    }

    fn touch(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn place_puts_the_fix_beside_the_original_and_turns_it_off() {
        let root = std::env::temp_dir().join(format!("xvfx-place-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mods = root.join("mods").join("Sub");
        for x in ["pak", "utoc", "ucas"] {
            touch(&mods.join(format!("A_9999999_P.{x}")), "old");
            touch(&root.join(format!("stage/out.{x}")), "new");
        }
        let (placed, from, to) = place(&mods.join("A_9999999_P.utoc"), &root.join("stage/out"), true, false, false, &root.join("trash")).unwrap();
        assert_eq!((from.as_str(), to[0].as_str()), ("A_9999999_P", "A_UPDATED_9999999_P"));
        assert!(placed.turned_off && !placed.replaced);
        assert!(mods.join("A_UPDATED_9999999_P.pak").exists(), "on, like the original was");
        assert!(mods.join("A_9999999_P.bak_repak").exists() && !mods.join("A_9999999_P.pak").exists(), "the original is off");
        assert_eq!(std::fs::read_to_string(mods.join("A_UPDATED_9999999_P.ucas")).unwrap(), "new");

        // an off original makes an off fix, and is left alone
        for x in ["utoc", "ucas", "pak"] {
            touch(&root.join(format!("stage/out.{x}")), "newer");
        }
        let (placed, ..) = place(&mods.join("A_9999999_P.utoc"), &root.join("stage/out"), true, false, false, &root.join("trash")).unwrap();
        assert!(!placed.turned_off && placed.replaced, "the previous fix went to Recently deleted");
        assert!(mods.join("A_UPDATED_9999999_P.bak_repak").exists() && !mods.join("A_UPDATED_9999999_P.pak").exists());
        assert_eq!(std::fs::read_to_string(mods.join("A_UPDATED_9999999_P.ucas")).unwrap(), "newer");
        assert_eq!(std::fs::read_dir(root.join("trash")).unwrap().count(), 1, "the old fix is in the trash given, never the app's");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn place_keeps_the_name_on_the_update_and_renames_the_original_broken() {
        let root = std::env::temp_dir().join(format!("xvfx-keep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mods = root.join("mods");
        let stage = |text: &str| {
            for x in ["utoc", "ucas", "pak"] {
                touch(&root.join(format!("stage/out.{x}")), text);
            }
        };
        for x in ["pak", "utoc", "ucas"] {
            touch(&mods.join(format!("A_9999999_P.{x}")), "old");
        }
        stage("new");
        let (placed, from, to) = place(&mods.join("A_9999999_P.utoc"), &root.join("stage/out"), true, true, false, &root.join("trash")).unwrap();
        assert_eq!((from.as_str(), to.join(",").as_str()), ("A_9999999_P", "A_9999999_P,A_BROKEN_9999999_P"));
        assert!(placed.turned_off && !placed.replaced);
        assert_eq!(std::fs::read_to_string(mods.join("A_9999999_P.pak")).unwrap(), "new", "the update has the name, on like the original");
        assert_eq!(std::fs::read_to_string(mods.join("A_9999999_P.ucas")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(mods.join("A_BROKEN_9999999_P.bak_repak")).unwrap(), "old", "the original is renamed and off");
        assert_eq!(std::fs::read_to_string(mods.join("A_BROKEN_9999999_P.utoc")).unwrap(), "old");
        assert!(!mods.join("A_BROKEN_9999999_P.pak").exists());
        assert!(placed.original.ends_with("A_BROKEN_9999999_P.bak_repak"));

        // updating the update again: the older broken copy goes to Recently deleted, the newest original is kept
        stage("newer");
        let (placed, ..) = place(&mods.join("A_9999999_P.utoc"), &root.join("stage/out"), true, true, false, &root.join("trash")).unwrap();
        assert!(placed.replaced);
        assert_eq!(std::fs::read_to_string(mods.join("A_9999999_P.pak")).unwrap(), "newer");
        assert_eq!(std::fs::read_to_string(mods.join("A_BROKEN_9999999_P.bak_repak")).unwrap(), "new");

        // updating the broken copy: it stays where it is, the update in its name goes to Recently deleted
        stage("newest");
        let (placed, ..) = place(&mods.join("A_BROKEN_9999999_P.utoc"), &root.join("stage/out"), true, true, false, &root.join("trash")).unwrap();
        assert!(placed.replaced && !placed.turned_off, "the broken copy was off already");
        assert_eq!(std::fs::read_to_string(mods.join("A_9999999_P.bak_repak")).unwrap(), "newest", "off, like the copy it was made from");
        assert!(!mods.join("A_9999999_P.pak").exists(), "the earlier update is in Recently deleted");
        assert_eq!(std::fs::read_to_string(mods.join("A_BROKEN_9999999_P.bak_repak")).unwrap(), "new");
        assert_eq!(std::fs::read_dir(root.join("trash")).unwrap().count(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn place_can_send_the_original_to_recently_deleted_off() {
        let root = std::env::temp_dir().join(format!("xvfx-trash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mods = root.join("mods");
        for x in ["pak", "utoc", "ucas"] {
            touch(&mods.join(format!("A_9999999_P.{x}")), "old");
            touch(&root.join(format!("stage/out.{x}")), "new");
        }
        let (placed, ..) = place(&mods.join("A_9999999_P.utoc"), &root.join("stage/out"), false, true, true, &root.join("trash")).unwrap();
        assert!(placed.trashed && placed.turned_off, "trashed, and turned off first even without Turn off");
        assert_eq!(std::fs::read_to_string(mods.join("A_9999999_P.pak")).unwrap(), "new", "the update is in, on");
        assert!(!mods.join("A_BROKEN_9999999_P.bak_repak").exists() && !mods.join("A_BROKEN_9999999_P.utoc").exists(), "no original left in the mods folder");
        let entries: Vec<_> = std::fs::read_dir(root.join("trash")).unwrap().flatten().collect();
        assert_eq!(entries.len(), 1, "one deletion in Recently deleted");
        let names: Vec<String> = std::fs::read_dir(entries[0].path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert!(names.iter().any(|n| n == "A_BROKEN_9999999_P.bak_repak"), "it comes back off: {names:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    fn s(v: &Value, k: &str) -> String {
        v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
    }
    fn list(v: &Value, k: &str) -> Vec<String> {
        v.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
    }

    /// One frontend command, run the way its Tauri command would (no window: progress goes nowhere).
    async fn call(cmd: &str, a: &Value) -> Result<Value, String> {
        let tool = std::path::PathBuf::from(uasset_toolkit::native_library_path().map_err(|e| e.to_string())?);
        let p = &NoOpProgressSink;
        Ok(match cmd {
            "vfx_cleanup_temp_directories" => json!(file_ops::cleanup_vfx_temp_directories()?),
            "vfx_start_session" => {
                let _ = logging::init_vfx_log(&std::env::temp_dir().join("repakxtra-vfx-bench"));
                json!(crate::vfx_updater::uasset_tool::ensure_vfx_uat_session(&tool).await?)
            }
            "vfx_stop_session" => json!(c::vfx_stop_session().await?),
            "vfx_create_pipeline_directories" => json!(c::vfx_create_pipeline_directories()?),
            "vfx_create_step_directory" => json!(c::vfx_create_step_directory(s(a, "stepName"))?),
            "vfx_get_uasset_tool_path" => json!(c::vfx_get_uasset_tool_path()?),
            "vfx_extract_mod_assets" => json!(pipeline::step_extract_mod_assets(&tool, &s(a, "gamePaks"), &s(a, "modPath"), &s(a, "outputDir"), p).await?),
            "vfx_get_asset_classes" => json!(crate::vfx_updater::uasset_tool::batch_detect_asset_types(&tool, &s(a, "usmapPath"), &list(a, "uassetPaths"), p).await?),
            "vfx_copy_uasset_files" => json!(c::vfx_copy_uasset_files(list(a, "sourcePaths"), s(a, "sourceBaseDir"), s(a, "destBaseDir")).await?),
            "vfx_convert_uassets_to_json" => json!(pipeline::step_convert_mod_to_json(&tool, &s(a, "usmapPath"), &s(a, "inputDir"), &s(a, "outputDir"), p).await?),
            "vfx_extract_vanilla_assets" => json!(pipeline::step_extract_vanilla_assets(&tool, &s(a, "gamePaks"), &s(a, "outputDir"), &list(a, "filterPatterns"), p).await?),
            "vfx_read_json_file" => json!(c::vfx_read_json_file(s(a, "path")).await?),
            "vfx_write_json_file" => json!(c::vfx_write_json_file(s(a, "path"), s(a, "content")).await?),
            "vfx_convert_json_to_uassets" => json!(pipeline::step_convert_json_to_uassets(&tool, &s(a, "usmapPath"), &s(a, "inputDir"), &s(a, "outputDir"), p).await?),
            "vfx_pack_to_iostore" => {
                let allowed = a.get("allowedAssets").filter(|v| v.is_array()).map(|_| list(a, "allowedAssets"));
                json!(pipeline::step_pack_to_iostore(&tool, &s(a, "usmapPath"), &s(a, "inputDir"), &s(a, "outputBase"), allowed.as_deref(), p).await?)
            }
            "vfx_check_usmap_update" => json!(c::vfx_check_usmap_update(a.get("force").and_then(Value::as_bool).unwrap_or(false)).await?),
            "xtra_vfx_dirs" => json!(make_dirs(&s(a, "gamePaks"), &s(a, "runId"), &s(a, "usmapPath"))?),
            "xtra_vfx_stale" => json!(stale(&s(a, "modPath"), &list(a, "files"))?),
            "xtra_vfx_detect" =>json!(detect(&s(a, "usmapPath"), &list(a, "paths"), p).await?),
            _ => return Err(format!("unknown command {cmd}")),
        })
    }

    /// Serves frontend commands over stdin/stdout for .agent/vfx/bench.mjs (local), which runs the real pipeline code in
    /// Node against the real game and mods (UAssetTool.dll must sit beside the test binary):
    ///   cargo test -p repak-x --bin REPAK-X vfx_rpc -- --ignored --nocapture
    /// Each stdin line is {"id", "cmd", "args"}, each answer a stdout line "@@RPC {"id", "ok", "value"|"error"}".
    #[test]
    #[ignore]
    fn vfx_rpc() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let mut out = std::io::stdout();
        writeln!(out, "@@READY").unwrap();
        out.flush().unwrap();
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
            let args = req.get("args").cloned().unwrap_or(Value::Null);
            let answer = match rt.block_on(call(&s(&req, "cmd"), &args)) {
                Ok(value) => json!({ "id": req["id"], "ok": true, "value": value }),
                Err(error) => json!({ "id": req["id"], "ok": false, "error": error }),
            };
            writeln!(out, "@@RPC {answer}").unwrap();
            out.flush().unwrap();
        }
    }
}
