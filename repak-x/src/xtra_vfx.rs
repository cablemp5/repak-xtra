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

/// UAssetTool (in-process .NET) decodes a batch of files in parallel, and .NET's default workstation garbage collector
/// makes those threads wait on each other. The server collector decodes the same 89 Niagara files in 50 s instead of 87,
/// byte for byte the same JSON (2026-10-23). Read when the runtime starts, so this runs first thing in main, before any
/// other thread. A value the user set stays. The server collector holds more memory, so PCs under 16 GB keep the default
/// (on a 16 GB PC with other apps open, a Niagara decode already fills the RAM either way, 2026-10-24).
pub(crate) fn tune_dotnet_gc() {
    if std::env::var_os("DOTNET_gcServer").is_some() {
        return;
    }
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    // 16 GB PCs report a little under 16 GB (15.9 here), so the line sits at 15
    if sys.total_memory() >= 15 * 1024 * 1024 * 1024 {
        std::env::set_var("DOTNET_gcServer", "1");
    }
}

/// The background checks' work folders, one per app run (temp/repak-x/<kind>/<process id>): each check clears its own,
/// but an app closed mid-check leaves it (49 of them, 42.8 GB, here on 2026-10-31). At start, those of runs no longer
/// alive go; another copy's (the stable app beside the dev copy) stays while it runs.
pub(crate) fn sweep_work_dirs() {
    sweep_in(&std::env::temp_dir().join("repak-x"));
}

fn sweep_in(root: &Path) {
    use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
    let mut left: Vec<(PathBuf, u32)> = Vec::new();
    for kind in ["xcheck", "xclass", "xmesh", "pakhalf"] {
        for e in std::fs::read_dir(root.join(kind)).into_iter().flatten().flatten() {
            // "<pid>" or "<pid>-<n>"
            let n = e.file_name().to_string_lossy().to_string();
            if let Ok(pid) = n.split('-').next().unwrap_or_default().parse::<u32>() {
                left.push((e.path(), pid));
            }
        }
    }
    if left.is_empty() {
        return;
    }
    let s = System::new_with_specifics(RefreshKind::new().with_processes(ProcessRefreshKind::new()));
    let me = std::process::id();
    for (dir, pid) in left {
        if pid != me && s.process(Pid::from_u32(pid)).is_none() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

fn base_dir() -> PathBuf {
    std::env::temp_dir().join("repak-x").join("xvfx")
}

/// The game's Paks folder's build: changes whenever an update rewrites a container (xtra_broken::build_key).
pub(crate) fn build_hash(game_paks: &Path) -> String {
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

/// Whether a background scan may take its next mod: not while an update runs (it uses the same tool and folders), a
/// Check for update the user started runs, or the game runs (its frame rate matters more). Every background scan asks
/// before each mod, so any of those stops them within one mod, and the next scan goes on where they stopped (each keeps
/// its progress per mod).
pub(crate) fn background_may_run() -> bool {
    xtra_vfx_lock().is_none() && !crate::xtra_vfx_check::user_checking() && !crate::is_game_process_running()
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
pub(crate) fn usmap_hash(usmap: &str) -> String {
    let meta = std::fs::metadata(usmap).ok();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    usmap.to_lowercase().hash(&mut h);
    meta.as_ref().map(|m| m.len()).hash(&mut h);
    meta.and_then(|m| m.modified().ok()).hash(&mut h);
    format!("{:08x}", h.finish() as u32)
}

/// The game's own assets for this game build and USMAP, shared by every run (and the Niagara layout check).
pub(crate) fn vanilla_dir(game_paks: &str, usmap: &str) -> PathBuf {
    base_dir().join(format!("vanilla-{}-{}", build_hash(Path::new(game_paks)), usmap_hash(usmap)))
}

fn make_dirs(game_paks: &str, run_id: &str, usmap: &str) -> Result<VfxDirs, String> {
    if !valid_run_id(run_id) {
        return Err(format!("Invalid run id: {run_id}"));
    }
    let base = base_dir();
    let run = base.join(format!("run-{run_id}"));
    let vanilla = vanilla_dir(game_paks, usmap);
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

#[tauri::command(async)]
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
    // repakxtra: each request reads the USMAP again (about 0.3 s), so a few large requests, not one per 100 files
    const CHUNK: usize = 400;
    for (i, batch) in paths.chunks(CHUNK).enumerate() {
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
        let done = ((i + 1) * CHUNK).min(paths.len());
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

/// The mods the VFX Updater offers: the Library's VFX type (material instances under /VFX/) and any other mod with a
/// material instance, wherever it lives, like a skin's own body materials with glowing colors. The update rebuilds every
/// material instance on the game's copy the same way, whatever its folder. Also the right-click Update VFX
/// (custom/vfx/quick.ts canUpdateVfx, the same rule). A recolored KO prompt (its widget, WBP_Battle_Kill_<hero>) is
/// rebuilt too: its colors are carried onto the game's copy like a blueprint's.
pub(crate) fn updatable(category: &str, files: &[String]) -> bool {
    category == "VFX"
        || files.iter().any(|f| {
            let name = f.replace('\\', "/").rsplit('/').next().unwrap_or_default().to_ascii_lowercase();
            (name.starts_with("mi_") || is_ko_prompt(&name)) && name.ends_with(".uasset")
        })
}

/// A KO prompt widget, by its file or asset name (lowercase): WBP_Battle_Kill_1026_V3.
pub(crate) fn is_ko_prompt(name: &str) -> bool {
    name.starts_with("wbp_battle_kill_")
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

/// A name without its priority suffix, split into the mod's own name and, for an update, its version: 1 for
/// `<name>_UPDATED`, n for `<name>_UPDATED_V<n>`, None for an original.
fn update_version(name: &str) -> (&str, Option<u32>) {
    let l = name.to_ascii_lowercase();
    if let Some(i) = l.rfind("_updated_v") {
        if let Ok(n) = name[i + 10..].parse::<u32>() {
            return (&name[..i], Some(n));
        }
    }
    if l.ends_with("_updated") && name.len() > 8 {
        return (&name[..name.len() - 8], Some(1));
    }
    (name, None)
}

/// Whether a mod's file stem is an update named by fixed_stem (`_UPDATED`, `_UPDATED_V2`, ...).
fn is_update(stem: &str) -> bool {
    update_version(split_priority(stem).0).1.is_some()
}

/// `<name>_UPDATED_9999999_P` for a mod's file stem: the name without its priority suffix, spaces as underscores. An
/// update of an update is its next version: `<name>_UPDATED_V2_9999999_P`, then V3, so each one is kept apart.
pub(crate) fn fixed_stem(stem: &str) -> String {
    let (b, version) = update_version(split_priority(stem).0);
    let b = b.trim().split_whitespace().collect::<Vec<_>>().join("_");
    match version {
        None => format!("{b}_UPDATED_9999999_P"),
        Some(n) => format!("{b}_UPDATED_V{}_9999999_P", n + 1),
    }
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
    if is_update(stem) {
        return plain; // an update's next version: named after it, no other original's name to clash with
    }
    let me = stem.to_lowercase();
    let original = |s: &String| *s != me && !is_update(s); // another original, not an update
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

/// The name without the markers an update gives (_BROKEN, _ORIGINAL, _PARTIAL), and its priority suffix.
fn unmarked(stem: &str) -> (&str, &str) {
    let (b, p) = split_priority(stem);
    (["_BROKEN", "_ORIGINAL", "_PARTIAL"].iter().fold(b, |b, m| strip_marker(b, m)), p)
}

/// `<name>_PARTIAL<priority>`: an update that left out Niagara files made for an older game build.
pub(crate) fn partial_stem(stem: &str) -> String {
    let (b, p) = unmarked(stem);
    format!("{b}_PARTIAL{p}")
}

/// `<name>_ORIGINAL<priority>`: the original beside a partial update, kept (off) for a full update once one is possible.
pub(crate) fn original_stem(stem: &str) -> String {
    let (b, p) = unmarked(stem);
    format!("{b}_ORIGINAL{p}")
}

const MOD_EXTS: [&str; 5] =["pak", "bak_repak", "pak_disabled", "utoc", "ucas"];

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Placed {
    /// The fixed mod's .pak (on) or .bak_repak (off)
    fixed: String,
    /// The original's main file before the update, for loadouts to move from
    source: String,
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
/// back what moved and names any file it could not. A `partial` update (Niagara files left out) is always
/// `<name>_PARTIAL` and its original always stays, off, as `<name>_ORIGINAL`, whatever the naming and originals choices,
/// so a full update can start from it later. Returns the names tags should carry over to.
fn place(source: &Path, staged_base: &Path, turn_off_original: bool, keep_name: bool, trash_original: bool, partial: bool, trash_root: &Path) -> Result<(Placed, String, Vec<String>), String> {
    let dir = source.parent().ok_or("The mod has no folder")?;
    let stem = source.file_stem().ok_or("The mod has no name")?.to_string_lossy().to_string();
    let files = |s: &str| MOD_EXTS.iter().map(|x| dir.join(format!("{s}.{x}"))).filter(|p| p.exists()).collect::<Vec<_>>();
    let was_on = dir.join(format!("{stem}.pak")).exists();
    // a full update made from the original a partial update kept: named as if made from the mod itself, and it takes
    // the partial update's place (on or off like it, the copy loadouts hold)
    let kept_original = original_stem(&stem).eq_ignore_ascii_case(&stem);
    let from_kept = !partial && kept_original;
    let base = if from_kept { unmarked(&stem).0.to_string() + unmarked(&stem).1 } else { stem.clone() };
    // full or partial again, the new update replaces the partial one beside the kept original, on or off like it
    let superseded = kept_original.then(|| partial_stem(&stem)).filter(|s| !files(s).is_empty());
    let update_on = superseded.as_ref().map_or(was_on, |s| dir.join(format!("{s}.pak")).exists());
    // where the fix goes, and where the original ends up
    let (target, kept) = if partial && partial_stem(&stem).eq_ignore_ascii_case(&stem) {
        (stem.clone(), stem.clone()) // a partial update made again from itself: it replaces itself, _ORIGINAL stays as it is
    } else if partial {
        (partial_stem(&stem), original_stem(&stem))
    } else if keep_name {
        (unbroken_stem(&base), broken_stem(&base))
    } else {
        (fixed_stem_among(&base, &stems_in(dir)), base.clone())
    };
    let trash_original = trash_original && !partial;
    // made again from the original: the update it replaces is on or off, and the new one follows it
    let update_on = if superseded.is_none() && !target.eq_ignore_ascii_case(&stem) && !files(&target).is_empty() { dir.join(format!("{target}.pak")).exists() } else { update_on };
    let eq = |a: &str, b: &str| a.eq_ignore_ascii_case(b);
    // an update made again from itself (a _PARTIAL one): the new one replaces it
    let replace = eq(&target, &kept);
    let turn_off = (turn_off_original || trash_original || partial) && was_on && !replace;
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
    for s in if replace { vec![&target] } else { vec![&target, &kept] }.into_iter().chain(superseded.as_ref()) {
        if replace || !eq(s, &stem) {
            for f in files(s) {
                if !existing.contains(&f) {
                    existing.push(f);
                }
            }
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
    let main = dir.join(format!("{target}.{}", if update_on { "pak" } else { "bak_repak" }));
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
    // loadouts and tags move from the copy they held: the partial update a full one replaced, else the original
    let (from, from_on) = superseded.map_or((stem, was_on), |s| (s, update_on));
    let source = dir.join(format!("{from}.{}", if from_on { "pak" } else { "bak_repak" }));
    let placed = Placed { fixed: p(&main), source: p(&source), original: p(&original), turned_off: turn_off, replaced: !existing.is_empty(), trashed, warning };
    Ok((placed, from, vec![target, kept]))
}

#[tauri::command]
pub async fn xtra_vfx_place(source: String, staged_base: String, turn_off_original: bool, keep_name: Option<bool>, trash_original: Option<bool>, partial: Option<bool>, state: State<'_, Arc<Mutex<AppState>>>) -> Result<Placed, String> {
    // repakxtra: file moves on a blocking thread, never on the async workers every other command shares
    let state = state.inner().clone();
    crate::xtra_builtins::fixed_place(Path::new(&source))?; // its own app rebuilds it for the new game build
    crate::blocking(move || {
    let _mutation = crate::xtra_mutation::edit()?;
    crate::xtra_identity::upstream_guard()?;
    // renaming or replacing containers the game has loaded: not while it runs, as every other mod change
    let bypass = state.lock().map(|s| s.bypass_game_running_lock).unwrap_or(false);
    if !bypass && crate::is_game_process_running() {
        return Err("Marvel Rivals is running. Close it, then update again. The mod was not changed.".into());
    }
    let trash_original = trash_original.unwrap_or(false);
    let (placed, from, to) = place(Path::new(&source), Path::new(&staged_base), turn_off_original, keep_name.unwrap_or(true), trash_original, partial.unwrap_or(false), &crate::xtra_trash::trash_dir())?;
    let mut s = state.lock().unwrap();
    let key = |stem: &str| crate::get_mod_key(Path::new(&format!("{stem}.pak")));
    if let Some(tags) = s.mod_tags.get(&key(&from)).cloned() {
        for t in &to {
            s.mod_tags.entry(key(t)).or_insert_with(|| tags.clone());
        }
        let _ = crate::save_state(&s);
    }
    Ok(placed)
    }).await
}

/// Turns the mod at `mod_path` (its .utoc, .pak or .bak_repak) off when it is on: what an update could not make safe,
/// and a May crash mod the updater cannot rebuild, stay off rather than crash the game. Its off copy, or None when it
/// was off already. Not while the game runs, as every other mod change. `reason` keeps it off (xtra_safe_off.rs) until
/// the mod or the game changes, or the user turns it on anyway.
#[tauri::command]
pub async fn xtra_vfx_turn_off(window: Window, mod_path: String, reason: Option<String>, state: State<'_, Arc<Mutex<AppState>>>) -> Result<Option<String>, String> {
    let pak = Path::new(&mod_path).with_extension("pak");
    if let Some(why) = reason.as_deref() {
        let mods_dir = state.lock().unwrap().game_path.clone();
        crate::xtra_safe_off::remember(&mods_dir, &pak, why); // off already too: it stays off
    }
    if !pak.is_file() {
        return Ok(None);
    }
    let bypass = state.lock().map(|s| s.bypass_game_running_lock).unwrap_or(false);
    if !bypass && crate::is_game_process_running() {
        return Err("Marvel Rivals is running. Close it, then try again.".into());
    }
    crate::toggle_mod(pak.to_string_lossy().to_string(), window, state).await?;
    Ok(Some(pak.with_extension("bak_repak").to_string_lossy().to_string()))
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
    /// It carries Niagara systems or emitters (the window's Niagara badge, and its time estimate)
    niagara: bool,
    /// Not a VFX mod: listed for its material instances (a skin's glow), grouped apart in the window
    materials: bool,
    /// A UI mod (the Library's UI type) listed for its UI materials, in the window's UI mods group
    ui: bool,
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
        let paks = crate::xtra_broken::paks_dir(&root);
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
                // by class too: a UI material named M_..._Inst is no MI_ (xtra_broken::material_instances)
                let listed = updatable(&details.category, &details.files)
                    || paks.as_ref().is_some_and(|p| !crate::xtra_broken::material_instances(p, &utoc, &details.files).0.is_empty());
                listed.then(|| VfxMod {
                    name: m.custom_name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| split_priority(&stem).0.to_string()),
                    // the mod list leaves it empty for most mods: the details name it (the window's hero filter)
                    hero: m.character_name.clone().filter(|c| !c.is_empty()).or_else(|| Some(details.character_name.clone()).filter(|c| !c.is_empty())),
                    path: m.path.to_string_lossy().to_string(),
                    utoc: utoc.to_string_lossy().to_string(),
                    enabled: m.enabled,
                    modified: m.modified_date,
                    niagara: has_niagara(&details.files),
                    materials: details.category != "VFX",
                    ui: details.category == "UI",
                })
            })
            .collect::<Vec<_>>();
        problems.extend(unread.into_inner().unwrap());
        VfxMods { mods: list, problems }
    })
    .await
    .map_err(|e| e.to_string())
}

/// A hybrid mod's .pak half (the legacy .pak beside its .utoc; `main` is any of the mod's files): its packages and raw
/// files (audio banks, configs) extracted into `out` beside what is there, never over it. Their paths under `out`:
/// packages by their .uasset or .umap, raw files as they are. Empty when the .pak holds only the IoStore chunk list.
/// Without this an update read and packed only the .utoc half, and the rest of the mod was gone from it.
pub(crate) fn pak_half(main: &Path, out: &Path) -> Result<Vec<String>, String> {
    let pak = ["pak", "bak_repak"].iter().map(|x| main.with_extension(x)).find(|p| p.is_file()).ok_or("the mod's .pak is not there")?;
    let aes = Some(crate::install_mod::AES_KEY_HEX);
    let own = |f: &str| {
        let l = f.to_ascii_lowercase();
        !l.contains("chunknames") && !l.contains("patched_files")
    };
    let listed = uasset_toolkit::list_pak_files(&pak.to_string_lossy(), aes).map_err(|e| format!("{}: {e}", pak.display()))?;
    if !listed.iter().any(|f| own(f)) {
        return Ok(Vec::new());
    }
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let tmp = std::env::temp_dir().join("repak-x").join("pakhalf").join(format!("{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&tmp);
    let r = (|| {
        crate::xtra_extract::extract_pak_all(&pak.to_string_lossy(), &tmp.to_string_lossy(), aes)?;
        let mut found = Vec::new();
        for e in walkdir::WalkDir::new(&tmp).into_iter().flatten().filter(|e| e.file_type().is_file()) {
            let Ok(rel) = e.path().strip_prefix(&tmp) else { continue };
            let rel_s = rel.to_string_lossy().replace('\\', "/");
            if !own(&rel_s) {
                continue;
            }
            let to = out.join(rel);
            if to.exists() {
                continue; // the .utoc half's copy stands
            }
            std::fs::create_dir_all(to.parent().unwrap_or(out)).map_err(|e| e.to_string())?;
            std::fs::rename(e.path(), &to).or_else(|_| std::fs::copy(e.path(), &to).map(|_| ())).map_err(|e| e.to_string())?;
            let x = rel_s.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
            if !["uexp", "ubulk", "uptnl"].contains(&x.as_str()) {
                found.push(to.to_string_lossy().replace('\\', "/"));
            }
        }
        Ok::<_, String>(found)
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    r
}

/// pipeline.ts: pak_half for the mod at `mod_path` into the run's mod extract.
#[tauri::command]
pub async fn xtra_vfx_pak_half(mod_path: String, mod_extract: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || pak_half(Path::new(&mod_path), Path::new(&mod_extract))).await.map_err(|e| e.to_string())?
}

/// The mod's packages by class, keyed by their path in the mod (lowercase, no extension), from its container's listing
/// (xtra_uat_cli::classes): pipeline.ts reads a material or blueprint named like a texture or mesh (T_, SK_, SM_) as
/// what it is, never passing it on unread. None without the command line.
#[tauri::command]
pub async fn xtra_vfx_classes(mod_path: String, game_paks: String) -> Option<HashMap<String, String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let listed = crate::xtra_uat_cli::classes(&Path::new(&mod_path).with_extension("utoc"), Path::new(&game_paks))?;
        let key = |p: &str| {
            let p = p.replace('\\', "/").to_lowercase();
            let p = p.trim_start_matches("../");
            p.strip_suffix(".uasset").unwrap_or(p).to_string()
        };
        Some(listed.into_iter().map(|(p, c)| (key(&p), c)).collect())
    })
    .await
    .ok()
    .flatten()
}

/// Whether a mod's files hold a Niagara system or emitter (NS_ or NE_).
fn has_niagara(files: &[String]) -> bool {
    files.iter().any(|f| {
        let n = f.replace('\\', "/").rsplit('/').next().unwrap_or_default().to_ascii_lowercase();
        (n.starts_with("ns_") || n.starts_with("ne_")) && n.ends_with(".uasset")
    })
}

/// Of `mod_paths`, the mods that carry Niagara (the setup report's flag). Details come from the Library's cache.
#[tauri::command]
pub async fn xtra_niagara_mods(mod_paths: Vec<String>, state: State<'_, Arc<Mutex<AppState>>>) -> Result<Vec<String>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        mod_paths.into_iter().filter(|p| crate::compute_mod_details(&PathBuf::from(p), &state).is_ok_and(|d| has_niagara(&d.files))).collect()
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

/// The installed game's build (its newest patch changelist), when the container names carry one.
pub(crate) fn game_cl(paks: &Path) -> Option<u64> {
    game_build(paks).cl
}

/// The installed game's last update and build, for the Update VFX mods notice and the USMAP check.
#[tauri::command(async)]
pub fn xtra_game_build(state: State<'_, Arc<Mutex<AppState>>>) -> GameBuild {
    let mods = state.lock().unwrap().game_path.clone();
    mods.ancestors().find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Paks"))).map(game_build).unwrap_or_default()
}

/// Of `files` (paths inside the mod at `mod_path`), those whose game copy an update rewrote after the mod was written.
/// The updater copies Niagara files as they are, and one still cooked for the old game can crash it (Niagara properties
/// renumbered in 3962284), so a run leaves these out of the update.
/// shortcut: "written" is the mod file's modified time, when the mod was made for installs since xtra_made.rs (an archive
/// entry's packed time). An older install from an archive dates from its install, so it looks current; read the packages'
/// cook build instead if they ever carry one.
fn stale(mod_path: &str, game_paks: &str, files: &[String]) -> Result<Vec<String>, String> {
    let path = Path::new(mod_path);
    let written = std::fs::metadata(path).and_then(|m| m.modified()).map_err(|e| format!("{}: {e}", path.display()))?;
    let written = written.duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let written = crate::xtra_stamp::made(path, written);
    // the game set in Setup, never one guessed from the mod's folder: a mod chosen from Downloads is checked too
    Ok(crate::xtra_broken::rewritten_since(Path::new(game_paks), files, written).unwrap_or_default())
}

/// The original an update at `mod_path` (a .utoc) was made from, when it is still beside it: `<name>_ORIGINAL` for a
/// partial update, `<name>_BROKEN` for one that kept the mod's name, the original `<name>_..._P` for a `_UPDATED` one.
pub(crate) fn original_of(mod_path: &Path) -> Option<PathBuf> {
    let stem = mod_path.file_stem()?.to_string_lossy().to_string();
    let dir = mod_path.parent()?;
    // the file as it is spelled on disk (stems_in is lowercase)
    let utoc = |s: &str| {
        std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| {
            p.extension().is_some_and(|x| x.eq_ignore_ascii_case("utoc")) && p.file_stem().is_some_and(|f| f.to_string_lossy().eq_ignore_ascii_case(s))
        })
    };
    if partial_stem(&stem).eq_ignore_ascii_case(&stem) {
        return utoc(&original_stem(&stem));
    }
    let broken = broken_stem(&stem);
    if !broken.eq_ignore_ascii_case(&stem) {
        if let Some(o) = utoc(&broken) {
            return Some(o);
        }
    }
    if is_update(&stem) {
        let siblings = stems_in(dir);
        let me = stem.to_lowercase();
        return siblings.iter().find(|t| **t != me && !is_update(t) && fixed_stem_among(t, &siblings).eq_ignore_ascii_case(&stem)).and_then(|t| utoc(t));
    }
    None
}

/// What an update of `mod_path` (a .utoc) starts from: the original it was made from when that is still there (an
/// earlier update can lack what it left out, or carry what an older version of the updater got wrong), else itself.
fn source_of(mod_path: &Path) -> PathBuf {
    original_of(mod_path).unwrap_or_else(|| mod_path.to_path_buf())
}

#[tauri::command(async)]
pub fn xtra_vfx_source(mod_path: String) -> String {
    source_of(Path::new(&mod_path)).to_string_lossy().to_string()
}

#[tauri::command]
pub async fn xtra_vfx_stale(mod_path: String, game_paks: String, files: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || stale(&mod_path, &game_paks, &files)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfx_updater::{commands as c, file_ops, logging, pipeline, progress::NoOpProgressSink};
    use serde_json::{json, Value};
    use std::io::{BufRead, Write};

    #[test]
    fn work_folders_of_runs_no_longer_alive_go_and_live_ones_stay() {
        let root = tempfile::tempdir().unwrap();
        let me = std::process::id();
        let dead = 4_000_000_001u32; // above any Windows process id
        for d in [format!("xcheck/{me}"), format!("xcheck/{dead}"), format!("pakhalf/{dead}-3"), format!("xmesh/{me}"), "xcheck/notapid".to_string()] {
            std::fs::create_dir_all(root.path().join(d).join("game")).unwrap();
        }
        sweep_in(root.path());
        assert!(root.path().join(format!("xcheck/{me}")).exists() && root.path().join(format!("xmesh/{me}")).exists(), "this run's stay");
        assert!(!root.path().join(format!("xcheck/{dead}")).exists() && !root.path().join(format!("pakhalf/{dead}-3")).exists(), "a closed run's go");
        assert!(root.path().join("xcheck/notapid").exists(), "what is not a run's is left alone");
    }

    #[test]
    fn an_update_starts_again_from_the_original_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        let touch = |s: &str| std::fs::write(dir.path().join(format!("{s}.utoc")), b"t").unwrap();
        let p = |s: &str| dir.path().join(format!("{s}.utoc"));
        for s in ["A_9999999_P", "A_BROKEN_9999999_P", "B_100_P", "B_UPDATED_9999999_P", "C_PARTIAL_9999999_P", "C_ORIGINAL_9999999_P", "D_9999999_P"] {
            touch(s);
        }
        assert_eq!(original_of(&p("A_9999999_P")), Some(p("A_BROKEN_9999999_P")), "kept the name: its _BROKEN original");
        assert_eq!(original_of(&p("B_UPDATED_9999999_P")), Some(p("B_100_P")), "an _UPDATED one: the original it was named after");
        assert_eq!(original_of(&p("C_PARTIAL_9999999_P")), Some(p("C_ORIGINAL_9999999_P")));
        assert_eq!(original_of(&p("D_9999999_P")), None, "no original beside it: it starts from itself");
        assert_eq!(original_of(&p("A_BROKEN_9999999_P")), None, "the original itself");
    }

    #[test]
    fn niagara_is_an_ns_or_ne_uasset() {
        let files = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(has_niagara(&files(&["Marvel/Content/Marvel/VFX/NS_Burst.uasset"])));
        assert!(has_niagara(&files(&[r"Marvel\Content\VFX\ne_Spark.UASSET"])), "backslashes and case");
        assert!(!has_niagara(&files(&["Marvel/Content/Marvel/VFX/MI_Glow.uasset", "Marvel/Content/NS_Burst.uexp"])));
    }

    #[test]
    fn a_mod_with_material_instances_anywhere_can_be_updated() {
        let files = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(updatable("VFX", &[]), "the Library's VFX type");
        // a skin's own materials (MCU Black Aqua Shine): classed Texture, still material instances to rebuild
        assert!(updatable("Texture", &files(&["Marvel/Content/Marvel/Characters/1026/1026800/Materials/MI_1026800_Body_01.uasset", "Marvel/Content/Marvel/Characters/1026/1026800/Texture/T_1026800_Head_D.uasset"])));
        assert!(updatable("Mesh", &files(&["Marvel\\Content\\X\\mi_body.uasset"])), "any case, any slash");
        assert!(!updatable("Texture", &files(&["Marvel/Content/X/T_Body_D.uasset", "Marvel/Content/X/MI_Body.uexp"])), "textures only, or a material's .uexp alone");
        assert!(!updatable("Audio", &files(&["Marvel/Content/Audio/Mission_MI_01.bnk"])), "MI_ inside another name is not one");
        assert!(updatable("UI", &files(&["Marvel/Content/Marvel/UI/Blueprints/Battle/Custom/1026/WBP_Battle_Kill_1026_V3.uasset"])), "a KO prompt");
        assert!(!updatable("UI", &files(&["Marvel/Content/Marvel/UI/Blueprints/Battle/WBP_Battle_Hud.uasset"])), "another widget");
    }

    #[test]
    fn fixed_names_drop_the_priority_and_keep_one_updated() {
        assert_eq!(fixed_stem("BlueColoredVFX_9999999_P"), "BlueColoredVFX_UPDATED_9999999_P");
        assert_eq!(fixed_stem("BlueColoredVFX_UPDATED_9999999_P"), "BlueColoredVFX_UPDATED_V2_9999999_P", "an update of an update is its next version");
        assert_eq!(fixed_stem("BlueColoredVFX_UPDATED_V2_9999999_P"), "BlueColoredVFX_UPDATED_V3_9999999_P");
        assert_eq!(fixed_stem("BlueColoredVFX_updated_v9_9999999_P"), "BlueColoredVFX_UPDATED_V10_9999999_P", "any case, past 9");
        assert_eq!(fixed_stem("Mod_UPDATED_Vx_9999999_P"), "Mod_UPDATED_Vx_UPDATED_9999999_P", "not a version: an original's own name");
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
        assert_eq!(fixed_stem_among("A_100_UPDATED_9999999_P", &set(&["A_100_UPDATED_9999999_P", "A_200_P"])), "A_100_UPDATED_V2_9999999_P", "an update's next version");
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
        let err = place(&mods.join("A_9999999_P.utoc"), &root.join("stage/out"), true, true, false, false, &root.join("trash")).unwrap_err();
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
        let (placed, from, to) = place(&mods.join("A_9999999_P.utoc"), &root.join("stage/out"), true, false, false, false, &root.join("trash")).unwrap();
        assert_eq!((from.as_str(), to[0].as_str()), ("A_9999999_P", "A_UPDATED_9999999_P"));
        assert!(placed.turned_off && !placed.replaced);
        assert!(mods.join("A_UPDATED_9999999_P.pak").exists(), "on, like the original was");
        assert!(mods.join("A_9999999_P.bak_repak").exists() && !mods.join("A_9999999_P.pak").exists(), "the original is off");
        assert_eq!(std::fs::read_to_string(mods.join("A_UPDATED_9999999_P.ucas")).unwrap(), "new");

        // made again from the off original: the new fix is on or off like the fix it replaces, the original left alone
        for x in ["utoc", "ucas", "pak"] {
            touch(&root.join(format!("stage/out.{x}")), "newer");
        }
        let (placed, ..) = place(&mods.join("A_9999999_P.utoc"), &root.join("stage/out"), true, false, false, false, &root.join("trash")).unwrap();
        assert!(!placed.turned_off && placed.replaced, "the previous fix went to Recently deleted");
        assert!(mods.join("A_UPDATED_9999999_P.pak").exists() && !mods.join("A_UPDATED_9999999_P.bak_repak").exists(), "on, like the fix it replaces");
        assert!(mods.join("A_9999999_P.bak_repak").exists(), "the original stays off");
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
        let (placed, from, to) = place(&mods.join("A_9999999_P.utoc"), &root.join("stage/out"), true, true, false, false, &root.join("trash")).unwrap();
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
        let (placed, ..) = place(&mods.join("A_9999999_P.utoc"), &root.join("stage/out"), true, true, false, false, &root.join("trash")).unwrap();
        assert!(placed.replaced);
        assert_eq!(std::fs::read_to_string(mods.join("A_9999999_P.pak")).unwrap(), "newer");
        assert_eq!(std::fs::read_to_string(mods.join("A_BROKEN_9999999_P.bak_repak")).unwrap(), "new");

        // updating the broken copy: it stays where it is, the update in its name goes to Recently deleted
        stage("newest");
        let (placed, ..) = place(&mods.join("A_BROKEN_9999999_P.utoc"), &root.join("stage/out"), true, true, false, false, &root.join("trash")).unwrap();
        assert!(placed.replaced && !placed.turned_off, "the broken copy was off already");
        assert_eq!(std::fs::read_to_string(mods.join("A_9999999_P.pak")).unwrap(), "newest", "on, like the update it replaces");
        assert!(!mods.join("A_9999999_P.bak_repak").exists(), "the earlier update is in Recently deleted");
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
        let (placed, ..) = place(&mods.join("A_9999999_P.utoc"), &root.join("stage/out"), false, true, true, false, &root.join("trash")).unwrap();
        assert!(placed.trashed && placed.turned_off, "trashed, and turned off first even without Turn off");
        assert_eq!(std::fs::read_to_string(mods.join("A_9999999_P.pak")).unwrap(), "new", "the update is in, on");
        assert!(!mods.join("A_BROKEN_9999999_P.bak_repak").exists() && !mods.join("A_BROKEN_9999999_P.utoc").exists(), "no original left in the mods folder");
        let entries: Vec<_> = std::fs::read_dir(root.join("trash")).unwrap().flatten().collect();
        assert_eq!(entries.len(), 1, "one deletion in Recently deleted");
        let names: Vec<String> = std::fs::read_dir(entries[0].path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert!(names.iter().any(|n| n == "A_BROKEN_9999999_P.bak_repak"), "it comes back off: {names:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn updating_an_update_makes_its_next_version_and_keeps_it() {
        let root = std::env::temp_dir().join(format!("xvfx-version-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mods = root.join("mods");
        for x in ["pak", "utoc", "ucas"] {
            touch(&mods.join(format!("A_UPDATED_9999999_P.{x}")), "v1");
            touch(&root.join(format!("stage/out.{x}")), "v2");
        }
        let (placed, ..) = place(&mods.join("A_UPDATED_9999999_P.utoc"), &root.join("stage/out"), true, false, false, false, &root.join("trash")).unwrap();
        assert!(placed.turned_off && !placed.replaced && placed.fixed.ends_with("A_UPDATED_V2_9999999_P.pak"));
        assert_eq!(std::fs::read_to_string(mods.join("A_UPDATED_V2_9999999_P.pak")).unwrap(), "v2", "the new version, on");
        assert_eq!(std::fs::read_to_string(mods.join("A_UPDATED_9999999_P.bak_repak")).unwrap(), "v1", "the earlier one, kept and off");

        // a partial update made again from itself replaces itself and never touches its _ORIGINAL
        for x in ["pak", "utoc", "ucas"] {
            touch(&mods.join(format!("B_PARTIAL_9999999_P.{x}")), "p1");
            touch(&root.join(format!("stage/out.{x}")), "p2");
        }
        touch(&mods.join("B_ORIGINAL_9999999_P.bak_repak"), "original");
        let (placed, ..) = place(&mods.join("B_PARTIAL_9999999_P.utoc"), &root.join("stage/out"), true, true, true, true, &root.join("trash")).unwrap();
        assert!(placed.replaced && !placed.trashed);
        assert_eq!(std::fs::read_to_string(mods.join("B_PARTIAL_9999999_P.pak")).unwrap(), "p2");
        assert_eq!(std::fs::read_to_string(mods.join("B_ORIGINAL_9999999_P.bak_repak")).unwrap(), "original");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_partial_update_keeps_its_original_off_beside_it() {
        assert_eq!(partial_stem("A_9999999_P"), "A_PARTIAL_9999999_P");
        assert_eq!(original_stem("A_BROKEN_9999999_P"), "A_ORIGINAL_9999999_P");
        assert_eq!(partial_stem("A_ORIGINAL_9999999_P"), "A_PARTIAL_9999999_P");
        let root = std::env::temp_dir().join(format!("xvfx-partial-{}", std::process::id()));
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
        // Recently deleted was asked for, and the update would keep the name: a partial one does neither
        let (placed, from, to) = place(&mods.join("A_9999999_P.utoc"), &root.join("stage/out"), false, true, true, true, &root.join("trash")).unwrap();
        assert_eq!((from.as_str(), to.join(",").as_str()), ("A_9999999_P", "A_PARTIAL_9999999_P,A_ORIGINAL_9999999_P"));
        assert!(placed.turned_off && !placed.trashed && placed.source.ends_with("A_9999999_P.pak"));
        assert_eq!(std::fs::read_to_string(mods.join("A_PARTIAL_9999999_P.pak")).unwrap(), "new", "the update, on like the original");
        assert_eq!(std::fs::read_to_string(mods.join("A_ORIGINAL_9999999_P.bak_repak")).unwrap(), "old", "the original, kept and off");
        assert!(!mods.join("A_9999999_P.pak").exists() && !root.join("trash").exists());

        // again from the kept original (a later run): the earlier partial update goes, the original stays where it is
        stage("newer");
        let (placed, ..) = place(&mods.join("A_ORIGINAL_9999999_P.utoc"), &root.join("stage/out"), true, true, false, true, &root.join("trash")).unwrap();
        assert!(placed.replaced && !placed.turned_off && placed.source.ends_with("A_PARTIAL_9999999_P.pak"));
        assert_eq!(std::fs::read_to_string(mods.join("A_PARTIAL_9999999_P.pak")).unwrap(), "newer", "on, like the partial update it replaced");
        assert_eq!(std::fs::read_to_string(mods.join("A_ORIGINAL_9999999_P.bak_repak")).unwrap(), "old");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_full_update_from_the_kept_original_takes_the_partial_ones_place() {
        let root = std::env::temp_dir().join(format!("xvfx-full-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mods = root.join("mods");
        for x in ["utoc", "ucas"] {
            touch(&mods.join(format!("A_PARTIAL_9999999_P.{x}")), "partial");
            touch(&mods.join(format!("A_ORIGINAL_9999999_P.{x}")), "old");
            touch(&root.join(format!("stage/out.{x}")), "full");
        }
        touch(&mods.join("A_PARTIAL_9999999_P.pak"), "partial"); // on, in loadouts
        touch(&mods.join("A_ORIGINAL_9999999_P.bak_repak"), "old"); // kept, off
        touch(&root.join("stage/out.pak"), "full");
        assert_eq!(source_of(&mods.join("A_PARTIAL_9999999_P.utoc")), mods.join("A_ORIGINAL_9999999_P.utoc"), "a partial update starts from its original");
        assert_eq!(source_of(&mods.join("B_PARTIAL_9999999_P.utoc")), mods.join("B_PARTIAL_9999999_P.utoc"), "unless there is none");
        let (placed, from, to) = place(&mods.join("A_ORIGINAL_9999999_P.utoc"), &root.join("stage/out"), true, true, false, false, &root.join("trash")).unwrap();
        assert_eq!((from.as_str(), to.join(",").as_str()), ("A_PARTIAL_9999999_P", "A_9999999_P,A_BROKEN_9999999_P"), "tags come from the partial update");
        assert_eq!(std::fs::read_to_string(mods.join("A_9999999_P.pak")).unwrap(), "full", "the mod's own name, on like the partial update");
        assert_eq!(std::fs::read_to_string(mods.join("A_BROKEN_9999999_P.bak_repak")).unwrap(), "old", "the original follows the naming choice");
        assert!(!mods.join("A_PARTIAL_9999999_P.pak").exists() && !mods.join("A_ORIGINAL_9999999_P.utoc").exists());
        assert!(placed.replaced && placed.source.ends_with("A_PARTIAL_9999999_P.pak"), "loadouts move from the partial update");
        assert_eq!(std::fs::read_dir(root.join("trash")).unwrap().count(), 1, "the partial update is in Recently deleted");
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
            "vfx_extract_vanilla_assets" => json!(pipeline::step_extract_vanilla_assets(&tool, &s(a, "gamePaks"), &s(a, "outputDir"), &list(a, "filterPatterns"), &list(a, "noDeps"), p).await?),
            "vfx_read_json_file" => json!(c::vfx_read_json_file(s(a, "path")).await?),
            "vfx_write_json_file" => json!(c::vfx_write_json_file(s(a, "path"), s(a, "content")).await?),
            "vfx_convert_json_to_uassets" => json!(pipeline::step_convert_json_to_uassets(&tool, &s(a, "usmapPath"), &s(a, "inputDir"), &s(a, "outputDir"), p).await?),
            "vfx_pack_to_iostore" => {
                let allowed = a.get("allowedAssets").filter(|v| v.is_array()).map(|_| list(a, "allowedAssets"));
                json!(pipeline::step_pack_to_iostore(&tool, &s(a, "usmapPath"), &s(a, "inputDir"), &s(a, "outputBase"), allowed.as_deref(), p).await?)
            }
            "vfx_check_usmap_update" => json!(c::vfx_check_usmap_update(a.get("force").and_then(Value::as_bool).unwrap_or(false)).await?),
            "xtra_vfx_dirs" => json!(make_dirs(&s(a, "gamePaks"), &s(a, "runId"), &s(a, "usmapPath"))?),
            "xtra_vfx_stale" => json!(stale(&s(a, "modPath"), &s(a, "gamePaks"), &list(a, "files"))?),
            "xtra_vfx_detect" =>json!(detect(&s(a, "usmapPath"), &list(a, "paths"), p).await?),
            "xtra_vfx_source" => json!(xtra_vfx_source(s(a, "modPath"))),
            "xtra_skin_table_hero" => json!(crate::xtra_builtins::table_hero(&s(a, "modPath"), Path::new(&s(a, "gamePaks"))).await?),
            "xtra_vfx_old_layout" => json!(crate::xtra_niagara::xtra_vfx_old_layout(s(a, "modPath"), s(a, "gamePaks"), s(a, "usmapPath"), list(a, "files"), a.get("modExtract").and_then(Value::as_str).map(String::from)).await?),
            "xtra_vfx_relayout" => json!(crate::xtra_mi_layout::run(&s(a, "modPath"), &s(a, "gamePaks"), &s(a, "usmapPath"), &s(a, "modExtract"), &list(a, "files"), &s(a, "stageDir"), p).await?),
            "xtra_vfx_niagara" => {
                let vanilla = PathBuf::from(s(a, "vanillaExtract")).parent().map(Path::to_path_buf).unwrap_or_default();
                let work = PathBuf::from(s(a, "stageDir")).join("niagara");
                json!(crate::xtra_niagara::run(&s(a, "gamePaks"), &s(a, "usmapPath"), Path::new(&s(a, "modExtract")), &list(a, "files"), Path::new(&s(a, "finalUassets")), &work, &vanilla, p).await?)
            }
            // repakxtra 0.39: the commands the pipeline gained
            "xtra_vfx_classes" => json!(xtra_vfx_classes(s(a, "modPath"), s(a, "gamePaks")).await),
            "xtra_vfx_pak_half" => json!(pak_half(Path::new(&s(a, "modPath")), Path::new(&s(a, "modExtract")))?),
            "xtra_vfx_verify" => json!(crate::xtra_mi_layout::verify(&s(a, "usmapPath"), &s(a, "dir"), &list(a, "rels"), &s(a, "jsonDir"), &s(a, "stageDir"), p).await?),
            "xtra_vfx_merge_tables" => json!(crate::xtra_tables::merge_tables(&s(a, "gamePaks"), &s(a, "usmapPath"), &s(a, "modExtract"), &list(a, "files"), &s(a, "out"), &s(a, "stageDir"), p).await?),
            "xtra_game_build" => json!(Path::new(&s(a, "gamePaks")).is_dir().then(|| game_build(Path::new(&s(a, "gamePaks")))).unwrap_or_else(|| game_build(Path::new(&format!("{}", std::env::var("REPAKXTRA_PAKS").unwrap_or_default()))))),
            "xtra_vfx_usmap_wait" => json!(crate::xtra_broken::xtra_vfx_usmap_wait(s(a, "modPath"), s(a, "gamePaks"), s(a, "usmapPath"))),
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
        tune_dotnet_gc(); // as main does, before UAssetTool loads
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
