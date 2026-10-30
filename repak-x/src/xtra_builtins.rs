//! repakxtra: built-in mods, made by the app from the installed game's own data tables, so they follow every game update
//! without a download. Skip startup logos turns off every region flag of MarvelLogoVideoTable: a same-size edit, the
//! game's own .uasset header is kept, only the rebuilt .uexp changes, and every changed byte is checked before anything
//! is packed (the same checks as the mod script it comes from, tools/bp/skip_logo_movies.py).
//! The paks live in ~mods/.repakxtra-builtin: the library scan skips .repakxtra- folders (xtra_bundle::not_staging), so
//! loadouts, bulk switches and Repak X never see or toggle them. Off sets the .pak aside as .bak_repak (the game skips
//! it, as any mod turned off), and on puts it back when it still fits: made for this game build. Only a game update
//! rebuilds. A build is stale when the game's containers change
//! (xtra_broken::build_key), so the frontend's start-up refresh rebuilds it.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::vfx_updater::file_ops::get_uasset_tool_path;
use crate::vfx_updater::progress::NoOpProgressSink;
use crate::vfx_updater::uasset_tool::{convert_json_to_uassets, convert_uassets_to_json, ensure_vfx_uat_session, extract_vanilla_assets, pack_to_iostore};
use crate::AppState;

const FOLDER: &str = ".repakxtra-builtin";
const SKIN: &str = "Marvel/Content/Marvel/Data/DataTable/MarvelHeroSkinTable";
const LOGO: &str = "Marvel/Content/Marvel/Data/DataTable/UI/Login/MarvelLogoVideoTable";
const LOGO_FLAGS: [&str; 4] = ["bUsedInCn", "bUsedInHkMoTw", "bUsedInJpKr", "bUsedInEnRegion"];
/// The photosensitivity warning before the login screen: it moves on once its progress bar (Anim_ProgressBar, 4.75 s)
/// has filled. Skip startup logos shortens that animation to a tick.
const WARN: &str = "Marvel/Content/Marvel/UI/Blueprints/Login/WBP_Login_Panel_Warn";
pub const SKIP_INTRO: &str = "skip-intro-movies";
const IDS: [&str; 1] = [SKIP_INTRO];

/// One build at a time: they share the work folder root and UAssetTool.
static BUILDING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// repakxtra: which one is building, so switching another one off or on never waits for it
static IN_FLIGHT: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
/// Every move of a built-in's files in the game folder, held only for the moves themselves.
static INSTALL: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Waits for a build of `id` in flight, if any (another built-in's build does not hold it up).
async fn wait_for_build(id: &str) {
    if IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).as_deref() == Some(id) {
        drop(BUILDING.lock().await);
    }
}

/// Builds that failed in this run (`id|made_for`): the automatic checks (start, focus, the game closing) leave them
/// alone until the game build or the app run change, so a failing build is not redone on every focus.
/// The switch and Try again still build them.
static FAILED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// What a build of `id` is made from: the game build (a kept build and a failed try are keyed on it).
fn made_for(id: &str, build: &str) -> String {
    // repakxtra: and the recipe and the saved USMAP, so a kept build from an older recipe or USMAP is made again, and a
    // failure is tried again with a new USMAP
    let usmap = crate::vfx_updater::commands::saved_usmap_path().map(|u| Path::new(&u).file_name().unwrap_or_default().to_string_lossy().to_string()).unwrap_or_default();
    format!("{build}|r{}|{usmap}", recipe(id))
}

/// repakxtra: the files a build in progress left out for want of a newer USMAP (that USMAP's file name and how many),
/// saved with the build only once it is in the game (or kept for the next try), never before
static WAITED: std::sync::Mutex<Vec<(String, Option<String>, usize)>> = std::sync::Mutex::new(Vec::new());

fn take_waited(id: &str) -> (Option<String>, usize) {
    let mut w = WAITED.lock().unwrap_or_else(|e| e.into_inner());
    let found = w.iter().position(|(i, ..)| i == id).map(|n| w.remove(n));
    found.map(|(_, u, n)| (u, n)).unwrap_or((None, 0))
}

fn failed_key(id: &str, build: &str) -> String {
    format!("{id}|{}", made_for(id, build))
}

/// Clears IN_FLIGHT when a build ends, whichever way.
struct Flight;
impl Drop for Flight {
    fn drop(&mut self) {
        *IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
struct Saved {
    #[serde(default)]
    on: bool,
    /// The game build the files on disk were made from
    #[serde(default)]
    built_for: Option<String>,
    #[serde(default)]
    built_at: Option<u64>,
    /// What the last build changed, for the card
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    error: Option<String>,
    /// repakxtra: the last build left out game files a patch newer than this USMAP (its file name) rewrote. Once another
    /// USMAP is saved the build is out of date, and the next refresh builds it with everything
    #[serde(default)]
    waited_usmap: Option<String>,
    /// How many of its game files that build left out (waited_usmap)
    #[serde(default)]
    waiting_files: usize,
    /// repakxtra: the recipe its files were made with (`recipe`): an app update that changes how one is built rebuilds it
    #[serde(default)]
    built_recipe: u32,
    /// Anything else saved here (another edition shares this file): kept as it is when the state is saved again
    #[serde(flatten)]
    other: serde_json::Map<String, Value>,
}

/// How a built-in is built, raised whenever an app update changes what its build makes, so that built-in rebuilds once
/// after the update (and the others do not).
fn recipe(id: &str) -> u32 {
    match id {
        // the photosensitivity warning joined the startup logos: older builds rebuild with it
        SKIP_INTRO => 1,
        _ => 0,
    }
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// The build left files out for want of a newer USMAP, and one has been saved since.
fn usmap_moved(s: &Saved) -> bool {
    let saved = crate::vfx_updater::commands::saved_usmap_path().map(|u| Path::new(&u).file_name().unwrap_or_default().to_string_lossy().to_string());
    s.waited_usmap.as_ref().is_some_and(|w| saved.as_deref() != Some(w.as_str()))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinView {
    id: String,
    on: bool,
    /// On, built, and made from the installed game build
    current: bool,
    /// Files made for the installed game build are in the game
    active: bool,
    built_at: Option<u64>,
    summary: Option<String>,
    error: Option<String>,
    /// Its main file (.pak), where the Library lists it, and the size of its files
    path: String,
    size: u64,
    /// Its last build for these options failed in this run: the automatic checks do not try it again (FAILED)
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    gave_up: bool,
    /// repakxtra: in the game but partly built, these many game files left out until the game's new USMAP is out
    #[serde(skip_serializing_if = "is_zero")]
    partial: usize,
}

fn store_path() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X").join("repakxtra-builtins.json")
}

fn load() -> HashMap<String, Saved> {
    std::fs::read_to_string(store_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Every saved built-in this app does not have is set off, so the app that had it does not rebuild it on its own.
pub(crate) fn disable_legacy_choices() -> Result<(), String> {
    update(|all| all.iter_mut().filter(|(id, _)| !IDS.contains(&id.as_str())).for_each(|(_, saved)| saved.on = false))
}

/// Held for every read-change-save of the state, never across a build: two commands never write over each other.
static STATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Reads the state, changes it and saves it, as one step.
fn update<R>(f: impl FnOnce(&mut HashMap<String, Saved>) -> R) -> Result<R, String> {
    let _held = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = load();
    let r = f(&mut all);
    compat(&mut all);
    save(&all)?;
    Ok(r)
}

/// The other edition's older builds read every entry with these two lists (no serde defaults there): an entry made here
/// gets them empty, so that app can still read the file.
fn compat(all: &mut HashMap<String, Saved>) {
    for s in all.values_mut() {
        for k in ["excluded", "heroes"] {
            s.other.entry(k).or_insert_with(|| Value::Array(Vec::new()));
        }
    }
}

fn save(all: &HashMap<String, Saved>) -> Result<(), String> {
    let p = store_path();
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

fn stem(id: &str) -> String {
    format!("repakxtra-{id}_9999999_P")
}

fn paks_dir(mods: &Path) -> Option<PathBuf> {
    mods.ancestors().find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Paks"))).map(Path::to_path_buf)
}

/// The top mods folder (~mods): built-ins sit in its .repakxtra-builtin folder whatever subfolder the library shows.
fn mods_root(game_path: &Path) -> PathBuf {
    game_path.ancestors().find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("~mods"))).unwrap_or(game_path).to_path_buf()
}

fn game_build(paks: &Path) -> String {
    crate::xtra_broken::build_key(&crate::xtra_broken::game_containers(paks))
}

fn files_of(dir: &Path, id: &str) -> [PathBuf; 3] {
    let s = stem(id);
    ["pak", "utoc", "ucas"].map(|e| dir.join(format!("{s}.{e}")))
}

/// Its .pak while it is off: set aside the way any mod is turned off, its .utoc and .ucas stay.
fn parked(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{}.bak_repak", stem(id)))
}

/// The files on disk were made for this game build.
fn fits(id: &str, s: &Saved, build: &str) -> bool {
    s.built_for.as_deref() == Some(build) && !usmap_moved(s) && s.built_recipe == recipe(id)
}

/// Off: the .pak goes aside, the rest stays, so turning it on again needs no rebuild.
fn park(dir: &Path, id: &str) -> Result<(), String> {
    let pak = &files_of(dir, id)[0];
    if pak.exists() {
        let _ = std::fs::remove_file(parked(dir, id));
        std::fs::rename(pak, parked(dir, id)).map_err(|e| format!("{}: {e}. Close the game and try again", pak.display()))?;
    }
    Ok(())
}

/// On again: the set-aside .pak goes back when the rest of its set is still there. Whether it still fits is the caller's.
fn unpark(dir: &Path, id: &str) -> Result<(), String> {
    let [pak, utoc, ucas] = files_of(dir, id);
    let off = parked(dir, id);
    if off.exists() && !pak.exists() && utoc.exists() && ucas.exists() {
        std::fs::rename(&off, &pak).map_err(|e| format!("{}: {e}. Close the game and try again", off.display()))?;
    }
    Ok(())
}

fn view(id: &str, s: &Saved, dir: &Path, build: &str) -> BuiltinView {
    let present = files_of(dir, id).iter().all(|f| f.exists());
    let for_build = s.built_for.as_deref() == Some(build);
    BuiltinView {
        id: id.to_string(),
        on: s.on,
        current: s.on && fits(id, s, build) && present,
        active: s.on && for_build && present,
        built_at: s.built_at,
        summary: s.summary.clone(),
        error: s.error.clone(),
        path: files_of(dir, id)[0].to_string_lossy().to_string(),
        size: files_of(dir, id).iter().filter_map(|f| std::fs::metadata(f).ok()).map(|m| m.len()).sum(),
        gave_up: s.error.is_some() && FAILED.lock().unwrap_or_else(|e| e.into_inner()).contains(&failed_key(id, build)),
        partial: if s.on && s.waited_usmap.is_some() { s.waiting_files.max(1) } else { 0 },
    }
}

fn dirs_of(state: &Arc<Mutex<AppState>>) -> Result<(PathBuf, PathBuf), String> {
    let game_path = state.lock().unwrap().game_path.clone();
    let paks = paks_dir(&game_path).ok_or("Set the game's mods folder in Settings first")?;
    Ok((mods_root(&game_path).join(FOLDER), paks))
}

fn views(state: &Arc<Mutex<AppState>>) -> Vec<BuiltinView> {
    let all = load();
    let (dir, build) = match dirs_of(state) {
        Ok((dir, paks)) => (dir, game_build(&paks)),
        Err(_) => (PathBuf::new(), String::new()),
    };
    IDS.iter().map(|id| view(id, &all.get(*id).cloned().unwrap_or_default(), &dir, &build)).collect()
}

// ---- table edits (serde_json ports of the Python scripts) ----

fn rows_mut(d: &mut Value) -> Result<&mut Vec<Value>, String> {
    d["Exports"][0]["Table"]["Data"].as_array_mut().ok_or_else(|| "the table has no rows: its layout changed".to_string())
}

fn edit_logo_table(d: &mut Value) -> Result<usize, String> {
    let mut flipped = 0;
    for row in rows_mut(d)? {
        for p in row["Value"].as_array_mut().into_iter().flatten() {
            if p["Name"].as_str().is_some_and(|n| LOGO_FLAGS.contains(&n)) && p["Value"] == true {
                p["Value"] = Value::Bool(false);
                flipped += 1;
            }
        }
    }
    Ok(flipped)
}

/// The warning's progress bar cut to one tick: every frame number at its end (the section, its curve key, the evaluation
/// field and the cached times: the last frame, and the playback range's exclusive bound one past it) becomes 1 (and 2).
/// Same-size, in place. The end is read from the decoded animation. Outside the animation's compiled copy (CompiledData,
/// which the JSON shows only as raw bytes, and which the game plays from) the raw file must hold exactly as many of those
/// values as the decoded one, so a changed layout stops the build. `header`: the .uasset's length (export offsets count
/// from its start). Returns how many values changed.
fn shorten_warning(doc: &Value, raw: &mut [u8], header: usize) -> Result<usize, String> {
    let range = doc["Exports"].as_array().into_iter().flatten()
        .filter(|e| e["ObjectName"] == "Anim_ProgressBar")
        .flat_map(|e| e["Data"].as_array().into_iter().flatten())
        .find(|p| p["Name"] == "PlaybackRange")
        .ok_or("the warning has no Anim_ProgressBar playback range")?;
    let range = &range["Value"][0]["Value"];
    let end = range["UpperBound"]["Value"]["Value"].as_i64().ok_or("the warning's animation has no end")? as i32;
    if range["LowerBound"]["Value"]["Value"].as_i64() != Some(0) || end < 1000 {
        return Err(format!("the warning's animation is not 0 to {end} as expected"));
    }
    let last = end - 1;
    // the frame numbers the decoded file holds: what the raw one must match
    let text = doc.to_string();
    let count = |v: i32| text.matches(&format!("FFrameNumber, UAssetAPI\",\"Value\":{v}}}")).count();
    // where the compiled copy sits in the .uexp
    let compiled: Vec<(usize, usize)> = doc["Exports"].as_array().into_iter().flatten()
        .filter(|e| e["ObjectName"] == "CompiledData" && e["$type"].as_str().is_some_and(|t| t.contains("RawExport")))
        .filter_map(|e| Some(((e["SerialOffset"].as_u64()? as usize).checked_sub(header)?, e["SerialSize"].as_u64()? as usize)))
        .collect();
    let outside = |i: usize| !compiled.iter().any(|&(at, len)| i >= at && i < at + len);
    let in_raw = |v: i32| raw.windows(4).enumerate().filter(|(i, w)| *w == v.to_le_bytes() && outside(*i)).count();
    let (want_last, want_end) = (count(last), count(end));
    if want_last == 0 || in_raw(last) != want_last || in_raw(end) != want_end {
        return Err(format!("the warning's animation is laid out differently ({} and {} in the file, {want_last} and {want_end} decoded)", in_raw(last), in_raw(end)));
    }
    let mut changed = 0;
    for (from, to) in [(last, 1i32), (end, 2i32)] {
        let mut i = 0;
        while i + 4 <= raw.len() {
            if raw[i..i + 4] == from.to_le_bytes() {
                raw[i..i + 4].copy_from_slice(&to.to_le_bytes());
                changed += 1;
                i += 4;
            } else {
                i += 1;
            }
        }
    }
    Ok(changed)
}

/// Exactly `flipped` bytes changed, each 01 -> 00, size kept.
fn check_flags(a: &[u8], b: &[u8], flipped: usize) -> Result<(), String> {
    if a.len() != b.len() {
        return Err(format!("size changed {} -> {}", a.len(), b.len()));
    }
    let diff: Vec<_> = a.iter().zip(b).filter(|(x, y)| x != y).collect();
    if diff.len() != flipped || diff.iter().any(|(x, y)| (**x, **y) != (1, 0)) {
        return Err(format!("{} bytes changed for {flipped} flag flips", diff.len()));
    }
    Ok(())
}

/// repakxtra: once the saved USMAP is this game build's, the built-ins that waited for it are no longer given up on, so
/// the next refresh builds them (in this run, not only at the next start). True when it is this game build's.
pub(crate) fn usmap_arrived(paks: &Path) -> bool {
    let here = crate::vfx_updater::commands::saved_usmap_path().is_some_and(|u| Path::new(&u).is_file() && crate::xtra_niagara::usmap_behind(&u, paks).is_none());
    if here {
        let build = game_build(paks);
        let waited: Vec<String> = load().iter().filter(|(_, s)| s.error.as_deref().is_some_and(|e| e.starts_with(WAITING))).map(|(id, _)| failed_key(id, &build)).collect();
        FAILED.lock().unwrap_or_else(|e| e.into_inner()).retain(|k| !waited.contains(k));
    }
    here
}

pub(crate) const MAPPINGS_BEHIND: &str = "Not active yet. The game updated and repakxtra waits for the support files for it. It checks for them at every start";

fn read_json(p: &Path) -> Result<Value, String> {
    let t = std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?;
    let v: Value = serde_json::from_str(t.trim_start_matches('\u{feff}')).map_err(|e| format!("{}: {e}", p.display()))?;
    // UAssetTool keeps an export it cannot decode as raw bytes: the USMAP is older than the installed game
    if v["Exports"][0]["$type"].as_str().is_some_and(|t| t.contains("RawExport")) {
        return Err(MAPPINGS_BEHIND.to_string());
    }
    Ok(v)
}

fn write_json(p: &Path, v: &Value) -> Result<(), String> {
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let text = serde_json::to_string(v).map_err(|e| e.to_string())?;
    std::fs::write(p, format!("\u{feff}{text}")).map_err(|e| e.to_string())
}

/// The USMAP the VFX Updater keeps current (rivals-depot), fetched when there is none yet.
async fn usmap() -> Result<String, String> {
    if cfg!(test) {
        if let Ok(p) = std::env::var("REPAKXTRA_USMAP") {
            return Ok(p); // builtins_real with a gapped mappings file while the feed is behind the patch
        }
    }
    let _ = crate::vfx_updater::commands::vfx_check_usmap_update(false).await;
    let path = |s: crate::vfx_updater::models::VfxSettings| s.usmap_path.filter(|p| Path::new(p).exists());
    let settings = || std::fs::read_to_string(store_path().with_file_name("vfx_settings.json")).ok()
        .and_then(|t| serde_json::from_str::<crate::vfx_updater::models::VfxSettings>(&t).ok()).unwrap_or_default();
    if let Some(p) = path(settings()) {
        return Ok(p);
    }
    crate::vfx_updater::commands::vfx_check_usmap_update(true).await?;
    path(settings()).ok_or_else(|| "No USMAP mappings file yet: open the VFX Updater once to fetch it".to_string())
}

/// repakxtra: Err while a patch newer than `usmap` rewrote one of `inputs` (the game packages a built-in reads, as
/// Marvel/Content/... paths). Only the USMAP of the installed build reads those right, and an older one misreads them
/// without any error. A built-in whose files the patch left alone builds with the saved USMAP.
pub(crate) fn usmap_ready(paks: &Path, usmap: &str, inputs: &[String]) -> Result<(), String> {
    let files: Vec<String> = inputs.iter().map(|p| if p.ends_with(".uasset") { p.clone() } else { format!("{p}.uasset") }).collect();
    let changed = crate::xtra_broken::changed_since_usmap(paks, usmap, &files);
    if changed.as_ref().is_some_and(Vec::is_empty) {
        return Ok(());
    }
    let game = crate::xtra_vfx::game_cl(paks).unwrap_or(0);
    Err(match changed {
        Some(c) => format!("{WAITING} The game update changed {} of the {} game files it is built from, and the USMAP for game build {game} is not out yet. It builds as soon as it is", c.len(), files.len()),
        None => format!("{WAITING} The USMAP for game build {game} is not out yet. It builds as soon as it is"),
    })
}

/// How every wait for support files starts: the row offers no Try again, the app retries by itself.
const WAITING: &str = "Not active yet.";

/// Extracts, edits, checks and packs one built-in into `out_dir`. Returns the summary.
async fn make(tool: &Path, id: &str, paks: &Path, work: &Path, out_base: &Path) -> Result<String, String> {
    if !IDS.contains(&id) { return Err(format!("No built-in mod called {id}")); }
    let s = |p: &Path| p.to_string_lossy().to_string();
    let tool = tool.to_path_buf();
    ensure_vfx_uat_session(&tool).await?;
    let usmap = usmap().await?;
    // repakxtra: the game files it reads must be ones no patch newer than the USMAP rewrote
    usmap_ready(paks, &usmap, &[LOGO.to_string(), WARN.to_string()])?;
    let tables: &[&str] = &[LOGO];
    let (legacy, json, edited, rt, staged) = (work.join("legacy"), work.join("json"), work.join("edited"), work.join("rt"), work.join("mod"));
    let sink = NoOpProgressSink;
    let filters = [LOGO.to_string(), WARN.to_string()];
    extract_vanilla_assets(&tool, &s(paks), &s(&legacy), &filters, &sink).await?;
    convert_uassets_to_json(&tool, &usmap, &s(&legacy), &s(&json), &sink).await?;

    let (summary, flipped);
    {
        let mut logo = read_json(&json.join(format!("{LOGO}.json")))?;
        flipped = edit_logo_table(&mut logo)?;
        if flipped == 0 {
            return Err("No startup logo video was on: the game changed how they are listed".to_string());
        }
        // and the photosensitivity warning, edited in place (not through JSON): only its frame numbers change
        let warned = match read_json(&json.join(format!("{WARN}.json"))) {
            Ok(doc) => {
                let mut raw = std::fs::read(legacy.join(format!("{WARN}.uexp"))).map_err(|e| format!("{WARN}.uexp: {e}"))?;
                let header = std::fs::metadata(legacy.join(format!("{WARN}.uasset"))).map_err(|e| e.to_string())?.len() as usize;
                let changed = shorten_warning(&doc, &mut raw, header).map_err(|e| format!("The warning screen could not be skipped: {e}"))?;
                let dst = staged.join(WARN);
                std::fs::create_dir_all(dst.parent().unwrap()).map_err(|e| e.to_string())?;
                std::fs::copy(legacy.join(format!("{WARN}.uasset")), dst.with_extension("uasset")).map_err(|e| format!("{WARN}.uasset: {e}"))?;
                std::fs::write(dst.with_extension("uexp"), raw).map_err(|e| e.to_string())?;
                changed > 0
            }
            Err(_) => false, // a game without this screen: the logos still go
        };
        summary = format!("{flipped} startup logo videos turned off{}", if warned { ", and the photosensitivity warning skipped" } else { "" });
        write_json(&edited.join(format!("{LOGO}.json")), &logo)?;
    }

    convert_json_to_uassets(&tool, &usmap, &s(&edited), &s(&rt), &sink).await?;
    // the game's own header (names, imports, sizes unchanged) with the rebuilt export data, checked byte by byte
    for rel in tables {
        let dst = staged.join(rel);
        std::fs::create_dir_all(dst.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::copy(legacy.join(format!("{rel}.uasset")), dst.with_extension("uasset")).map_err(|e| format!("{rel}.uasset: {e}"))?;
        std::fs::copy(rt.join(format!("{rel}.uexp")), dst.with_extension("uexp")).map_err(|e| format!("{rel}.uexp: {e}"))?;
        let (a, b) = (std::fs::read(legacy.join(format!("{rel}.uexp"))).map_err(|e| e.to_string())?, std::fs::read(dst.with_extension("uexp")).map_err(|e| e.to_string())?);
        let name = rel.rsplit('/').next().unwrap_or(rel);
        check_flags(&a, &b, flipped).map_err(|e| format!("{name} did not rebuild cleanly ({e}), so nothing was installed"))?;
    }
    pack_to_iostore(&tool, &usmap, &s(&staged), &s(out_base), None, &sink).await?;
    Ok(summary)
}

/// Builds `id` into the built-in folder, replacing the old files only once the new ones exist.
async fn build(app: &tauri::AppHandle, id: &str, dir: &Path, paks: &Path) -> Result<(), String> {
    let _one = BUILDING.lock().await;
    *IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()) = Some(id.to_string());
    let _flight = Flight;
    let build_at_start = game_build(paks);
    let work = std::env::temp_dir().join("repak-x").join("xbuiltin").join(id);
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(work.join("out")).map_err(|e| e.to_string())?;
    let out_base = work.join("out").join(stem(id));
    // a finished build the game kept out last time (it opened while it built): made for this game and these options
    let pending = std::env::temp_dir().join("repak-x").join("xbuiltin-pending").join(id);
    let made_for = made_for(id, &build_at_start);
    let failed_key = failed_key(id, &build_at_start);
    let kept = std::fs::read_to_string(pending.join("made-for")).ok().filter(|k| *k == made_for).and_then(|_| std::fs::read_to_string(pending.join("summary")).ok());
    let (made, from) = match kept {
        Some(summary) => (Ok(summary), pending.join(stem(id))),
        None => (async { make(&get_uasset_tool_path(app)?, id, paks, &work, &out_base).await }.await, out_base.clone()),
    };
    // repakxtra: what this build left out for a newer USMAP, saved below only if it goes in (a kept one keeps its own)
    let waited = if from.starts_with(&pending) { read_waited(&pending) } else { take_waited(id) };
    let _moving = INSTALL.lock().unwrap_or_else(|e| e.into_inner());
    // turned off while it built (the switch saves first, then waits for this build): nothing goes into the game
    if !load().get(id).is_some_and(|s| s.on) {
        clean(&work);
        return park(dir, id);
    }
    // the game or Repak X may have opened while it built: checked again before any file moves
    use tauri::Manager;
    let blocked = app.try_state::<Arc<Mutex<AppState>>>().map_or(Ok(()), |st| game_guard(st.inner())).and_then(|_| crate::xtra_identity::upstream_guard()).err();
    let made = if game_build(paks) != build_at_start { Err("The game updated during the build. Check again to rebuild from the new game files".into()) } else { made };
    let result = match (made, &blocked) {
        (Ok(summary), Some(_)) => Err(match keep(&from, &pending, id, &made_for, &summary, &waited) {
            Ok(()) => "Marvel Rivals or Repak X opened while it built, so the new build waits. Close it, then try again to put it in".to_string(),
            Err(e) => format!("Marvel Rivals or Repak X opened while it built, so the new build was not installed ({e}). Close it, then try again"),
        }),
        (Ok(made), None) => place(&from, dir, id).map(|_| made),
        (Err(e), _) => Err(e),
    };
    if result.is_ok() {
        clean(&pending);
    }
    clean(&work);
    {
        let mut failed = FAILED.lock().unwrap_or_else(|e| e.into_inner());
        failed.retain(|k| *k != failed_key);
        // a build the game kept out is not a failed one: it goes in once the game closes
        if result.is_err() && blocked.is_none() {
            failed.push(failed_key);
        }
    }
    // the state as it is now: the other built-in may have changed while this one built
    update(|all| {
        let s = all.entry(id.to_string()).or_default();
        match &result {
            Ok(summary) => {
                s.built_for = Some(build_at_start.clone());
                s.built_recipe = recipe(id);
                (s.waited_usmap, s.waiting_files) = waited.clone();
                s.built_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs());
                s.summary = Some(summary.clone());
                s.error = None;
            }
            Err(e) => {
                log::warn!("[builtins] {id}: {e}");
                s.error = Some(e.clone());
                // files made for an older game build come out: an old table on a new patch can crash the game
                if blocked.is_none() && s.built_for.as_deref() != Some(game_build(paks).as_str()) && remove(dir, id).is_ok() {
                    s.built_for = None;
                }
            }
        }
    })?;
    result.map(|_| ())
}

/// Keeps a finished build (its .pak, .utoc and .ucas) for the next try, with what it was made for.
fn keep(from: &Path, pending: &Path, id: &str, made_for: &str, summary: &str, waited: &(Option<String>, usize)) -> Result<(), String> {
    if from.starts_with(pending) {
        return Ok(()); // already the kept one
    }
    clean(pending);
    std::fs::create_dir_all(pending).map_err(|e| e.to_string())?;
    for ext in ["pak", "utoc", "ucas"] {
        std::fs::copy(from.with_extension(ext), pending.join(format!("{}.{ext}", stem(id)))).map_err(|e| e.to_string())?;
    }
    std::fs::write(pending.join("summary"), summary).map_err(|e| e.to_string())?;
    // repakxtra: the files it left out for a newer USMAP go with it (read_waited)
    std::fs::write(pending.join("waited"), waited.0.as_ref().map(|u| format!("{u}
{}", waited.1)).unwrap_or_default()).map_err(|e| e.to_string())?;
    std::fs::write(pending.join("made-for"), made_for).map_err(|e| e.to_string())
}

/// What a kept build left out for a newer USMAP (keep): that USMAP's file name and how many files.
fn read_waited(pending: &Path) -> (Option<String>, usize) {
    let text = std::fs::read_to_string(pending.join("waited")).unwrap_or_default();
    let mut lines = text.lines();
    match (lines.next().filter(|u| !u.is_empty()), lines.next().and_then(|n| n.parse().ok())) {
        (Some(u), n) => (Some(u.to_string()), n.unwrap_or(1)),
        _ => (None, 0),
    }
}

/// Removes a build's work folder (temp files, minutes of extracted game data), saying so when it cannot.
fn clean(work: &Path) {
    if let Err(e) = std::fs::remove_dir_all(work) {
        if work.exists() {
            log::warn!("[builtins] could not remove {}: {e}", work.display());
        }
    }
}

fn with_ext(p: &Path, x: &str) -> PathBuf {
    PathBuf::from(format!("{}.{x}", p.to_string_lossy()))
}

/// Moves the current files aside (`.old`), all or none: a failure puts back the ones moved. Returns the moved pairs.
fn set_aside(targets: &[PathBuf]) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let mut moved = Vec::new();
    for t in targets.iter().filter(|t| t.exists()) {
        let old = with_ext(t, "old");
        let _ = std::fs::remove_file(&old);
        if let Err(e) = std::fs::rename(t, &old) {
            for (a, b) in moved.iter().rev() {
                let _ = std::fs::rename(b, a);
            }
            return Err(format!("{}: {e}. Close the game and try again", t.display()));
        }
        moved.push((t.clone(), old));
    }
    Ok(moved)
}

/// Swaps the new files in as one set: copied beside the old ones first, the old ones set aside, then renamed into
/// place. Any failure leaves the old set as it was, so the game never sees half of each.
fn place(out_base: &Path, dir: &Path, id: &str) -> Result<(), String> {
    let made = ["pak", "utoc", "ucas"].map(|e| out_base.with_extension(e));
    if !made.iter().all(|f| f.exists()) {
        return Err("UAssetTool made no IoStore files".to_string());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let targets = files_of(dir, id);
    let tmps: Vec<PathBuf> = targets.iter().map(|t| with_ext(t, "tmp")).collect();
    let drop_tmps = || tmps.iter().for_each(|t| { let _ = std::fs::remove_file(t); });
    for (from, tmp) in made.iter().zip(&tmps) {
        if let Err(e) = std::fs::copy(from, tmp) {
            drop_tmps();
            return Err(format!("{}: {e}. Nothing was changed", tmp.display()));
        }
    }
    let moved = set_aside(&targets).inspect_err(|_| drop_tmps())?;
    for (i, (tmp, to)) in tmps.iter().zip(&targets).enumerate() {
        if let Err(e) = std::fs::rename(tmp, to) {
            targets[..i].iter().for_each(|t| { let _ = std::fs::remove_file(t); });
            for (a, b) in &moved {
                let _ = std::fs::rename(b, a);
            }
            drop_tmps();
            return Err(format!("{}: {e}. Close the game and try again", to.display()));
        }
    }
    moved.iter().for_each(|(_, old)| { let _ = std::fs::remove_file(old); });
    let _ = std::fs::remove_file(parked(dir, id)); // an older set's .pak, set aside while it was off
    Ok(())
}

/// Removes the files as one set (set aside first), so a locked file never leaves half of them.
fn remove(dir: &Path, id: &str) -> Result<(), String> {
    let [pak, utoc, ucas] = files_of(dir, id);
    for (_, old) in set_aside(&[pak, utoc, ucas, parked(dir, id)])? {
        let _ = std::fs::remove_file(old);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn xtra_builtins_list(state: State<'_, Arc<Mutex<AppState>>>) -> Vec<BuiltinView> {
    views(&state)
}

/// Built-ins change files the game loads: not while it runs, as every other mod change (the bypass setting aside).
fn game_guard(state: &Arc<Mutex<AppState>>) -> Result<(), String> {
    let bypass = state.lock().map(|s| s.bypass_game_running_lock).unwrap_or(false);
    if !bypass && crate::is_game_process_running() {
        return Err("Marvel Rivals is running. Close it, then change built-in mods.".into());
    }
    Ok(())
}

/// Turns a built-in on or off, building or removing its files to match.
#[tauri::command]
pub async fn xtra_builtins_set(app: tauri::AppHandle, id: String, on: Option<bool>, state: State<'_, Arc<Mutex<AppState>>>) -> Result<Vec<BuiltinView>, String> {
    if !IDS.contains(&id.as_str()) {
        return Err(format!("No built-in mod called {id}"));
    }
    crate::xtra_identity::upstream_guard()?;
    game_guard(state.inner())?;
    let (dir, paks) = dirs_of(&state)?;
    let now_on = update(|all| {
        let s = all.entry(id.clone()).or_default();
        if let Some(on) = on {
            s.on = on;
        }
        s.error = None;
        s.on
    })?;
    if !now_on {
        // after its own build in flight: it sees the saved Off and places nothing, then its files (if any) go
        wait_for_build(&id).await;
        let parked = { let _moving = INSTALL.lock().unwrap_or_else(|e| e.into_inner()); park(&dir, &id) };
        if let Err(e) = parked {
            // still in the game: say it is still on rather than off with its files in place
            update(|all| {
                let s = all.entry(id.clone()).or_default();
                s.on = true;
                s.error = Some(e.clone());
            })?;
            return Err(e);
        }
    } else {
        let build_now = game_build(&paks);
        // back on with the same game build: the set-aside files go back in, no rebuild
        if fits(&id, &load()[&id], &build_now) {
            wait_for_build(&id).await;
            let _moving = INSTALL.lock().unwrap_or_else(|e| e.into_inner());
            unpark(&dir, &id)?;
        }
        if !view(&id, &load()[&id], &dir, &build_now).current {
            build(&app, &id, &dir, &paks).await?;
        }
    }
    Ok(views(&state))
}

/// Rebuilds every built-in that is on but missing or made from an older game build (after a game update). Run at start.
#[tauri::command]
pub async fn xtra_builtins_refresh(app: tauri::AppHandle, state: State<'_, Arc<Mutex<AppState>>>) -> Result<Vec<BuiltinView>, String> {
    let (dir, paks) = dirs_of(&state)?;
    if crate::xtra_identity::upstream_guard().is_err() || game_guard(state.inner()).is_err() {
        return Ok(views(&state)); // Repak X or the game is open: wait for the next check
    }
    usmap_arrived(&paks);
    for v in views(&state) {
        if v.on && !v.current && !v.gave_up {
            let _ = build(&app, &v.id, &dir, &paks).await; // the error is saved on the built-in and shown on its card
        }
    }
    Ok(views(&state))
}

/// The heroes whose rows differ between a mod's skin table and the game's (rows only one side has count too).
fn changed_heroes(game: &Value, modded: &Value) -> Vec<String> {
    let rows = |d: &Value| -> HashMap<String, Value> {
        d["Exports"][0]["Table"]["Data"].as_array().into_iter().flatten()
            .filter_map(|r| Some((r["Name"].as_str()?.to_string(), r["Value"].clone())))
            .collect()
    };
    let (g, m) = (rows(game), rows(modded));
    let mut out: Vec<String> = m.iter().filter(|(k, v)| g.get(*k) != Some(*v)).map(|(k, _)| k.clone())
        .chain(g.keys().filter(|k| !m.contains_key(*k)).cloned())
        .collect();
    out.sort();
    out.dedup();
    out
}

/// The hero a skin table mod changes, when it changes exactly one (the install card draws that hero's silhouette under
/// "Renders after install"). Its MarvelHeroSkinTable is decoded and compared with the game's, which is kept per game
/// build. None for anything else: no skin table, several heroes, a legacy .pak, or mappings behind the game.
/// shortcut: IoStore mods only (a legacy .pak would need unpacking first).
#[tauri::command]
pub async fn xtra_skin_table_hero(mod_path: String, state: State<'_, Arc<Mutex<AppState>>>) -> Result<Option<String>, String> {
    let (_, paks) = dirs_of(state.inner())?;
    if let Some(id) = table_hero(&mod_path, &paks).await? {
        return Ok(Some(id));
    }
    // a mod of a hero's base model (its xxxx001 skin, which the hero data never lists) names no skin: its one hero folder does
    let utoc = PathBuf::from(&mod_path).with_extension("utoc");
    if !utoc.is_file() {
        return Ok(None);
    }
    let files = tauri::async_runtime::spawn_blocking(move || crate::utoc_utils::try_read_utoc(&utoc)).await.map_err(|e| e.to_string())??;
    Ok(only_hero_folder(files.iter().map(|f| f.file_path.as_str())))
}

/// The hero id when every `Characters/<id>/` folder in the paths is the same hero, else None.
fn only_hero_folder<'a>(paths: impl Iterator<Item = &'a str>) -> Option<String> {
    let ids: HashSet<String> = paths.filter_map(|p| crate::xtra_heroes::hero_skin(p).map(|h| h.hero)).collect();
    (ids.len() == 1).then(|| ids.into_iter().next().unwrap())
}

#[cfg(test)]
mod only_hero_folder_tests {
    use super::only_hero_folder;
    #[test]
    fn one_hero_folder_names_the_hero() {
        let one = ["/Game/Marvel/Characters/1055/1055001/Meshes/SK_1055_1055001.uasset", "/Game/Marvel/Characters/1055/1055001/Blueprints/1055001_ChildBP.uasset"];
        assert_eq!(only_hero_folder(one.into_iter()), Some("1055".into()));
        let two = ["/Game/Marvel/Characters/1055/x.uasset", "/Game/Marvel/Characters/1033/y.uasset"];
        assert_eq!(only_hero_folder(two.into_iter()), None);
        assert_eq!(only_hero_folder(["/Game/Marvel/Characters/Common/z.uasset"].into_iter()), None);
    }
}

pub(crate) async fn table_hero(mod_path: &str, paks: &Path) -> Result<Option<String>, String> {
    let mod_path = mod_path.to_string();
    let utoc = PathBuf::from(&mod_path).with_extension("utoc");
    if !utoc.is_file() {
        return Ok(None);
    }
    let list = utoc.clone();
    let has_table = tauri::async_runtime::spawn_blocking(move || crate::utoc_utils::try_read_utoc(&list).map(|e| e.iter().any(|f| f.file_path.contains("MarvelHeroSkinTable"))))
        .await.map_err(|e| e.to_string())??;
    if !has_table {
        return Ok(None);
    }
    let Some(usmap) = crate::vfx_updater::commands::saved_usmap_path().filter(|u| Path::new(u).is_file() && crate::xtra_niagara::usmap_matches(u, paks)) else { return Ok(None) };
    let s = |p: &Path| p.to_string_lossy().to_string();
    let tool = PathBuf::new();
    let sink = NoOpProgressSink;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(&game_build(paks), &mut h);
    let base = std::env::temp_dir().join("repak-x").join("xskinhero");
    let game_dir = base.join(format!("game-{:016x}", std::hash::Hasher::finish(&h)));
    let game_json = game_dir.join("json").join(format!("{SKIN}.json"));
    if !game_json.exists() {
        // the cache of another game build goes
        if let Ok(entries) = std::fs::read_dir(&base) {
            entries.flatten().filter(|e| e.path() != game_dir).for_each(|e| { let _ = std::fs::remove_dir_all(e.path()); });
        }
        extract_vanilla_assets(&tool, &s(paks), &s(&game_dir.join("legacy")), &[SKIN.to_string()], &sink).await?;
        convert_uassets_to_json(&tool, &usmap, &s(&game_dir.join("legacy")), &s(&game_dir.join("json")), &sink).await?;
    }
    let mut mh = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(&mod_path, &mut mh);
    let work = base.join(format!("mod-{:016x}", std::hash::Hasher::finish(&mh)));
    let _ = std::fs::remove_dir_all(&work);
    let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
        action: "extract_iostore_legacy",
        game_paks: Some(s(paks)),
        mod_path: Some(s(&utoc)),
        output_path: Some(s(&work.join("legacy"))),
        filter_patterns: Some(vec!["MarvelHeroSkinTable".to_string()]),
        with_deps: Some(false),
        ..Default::default()
    };
    let found = crate::vfx_updater::uasset_tool::run_vfx_uat_request(&tool, &req).await.map(|r| r.success).unwrap_or(false);
    let result = if found && work.join("legacy").join(format!("{SKIN}.uasset")).exists() {
        std::fs::write(work.join("legacy").join("uasset_list.txt"), SKIN).map_err(|e| e.to_string())?;
        convert_uassets_to_json(&tool, &usmap, &s(&work.join("legacy")), &s(&work.join("json")), &sink).await?;
        match (read_json(&game_json), read_json(&work.join("json").join(format!("{SKIN}.json")))) {
            (Ok(g), Ok(m)) => {
                let heroes = changed_heroes(&g, &m);
                (heroes.len() == 1).then(|| heroes[0].clone())
            }
            _ => None,
        }
    } else {
        None
    };
    let _ = std::fs::remove_dir_all(&work);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn soft(pkg: &str, asset: &str) -> Value {
        json!({ "Value": { "AssetPath": { "PackageName": pkg, "AssetName": asset } } })
    }

    fn named(name: &str, mut v: Value) -> Value {
        v["Name"] = json!(name);
        v
    }

    fn skin_row(hero: &str) -> Value {
        let sculpt = |bp: &str| json!({ "Value": [
            { "Name": "TypeTag", "Value": [{ "Value": "Form.A" }] },
            named("ChildActor", soft(&format!("/Game/{bp}"), bp)),
            named("KawaiiCollisionAssetInBattle", soft(&format!("/Game/K{bp}"), &format!("K{bp}"))),
        ] });
        let spec = |id: u64, bp: &str| json!({ "Value": [
            { "Name": "SkinItemID", "Value": id },
            { "Name": "SculptSpecs", "Value": [sculpt(bp)] },
        ] });
        json!({ "Name": hero, "Value": [
            { "Name": "DefaultSkinItemID", "Value": 1 },
            { "Name": "SkinSpecs", "Value": [spec(1, "Default"), spec(2, "Fancy")] },
        ] })
    }

    #[test]
    fn another_editions_entries_and_fields_survive_a_save() {
        // the other edition's older builds need these on every entry (no serde defaults there)
        #[derive(Deserialize)]
        #[allow(dead_code)]
        struct Theirs { on: bool, excluded: Vec<String>, heroes: Vec<String>, quake: Option<Value> }
        let mut all: HashMap<String, Saved> = serde_json::from_str(r#"{"custom-quake":{"on":true,"excluded":[],"heroes":["1011"],"quake":{"base":"5d7a80"}}}"#).unwrap();
        all.entry(SKIP_INTRO.to_string()).or_default().on = true;
        compat(&mut all);
        let text = serde_json::to_string(&all).unwrap();
        let theirs: HashMap<String, Theirs> = serde_json::from_str(&text).unwrap();
        assert!(theirs["custom-quake"].on && theirs["custom-quake"].heroes == ["1011"] && theirs["custom-quake"].quake.is_some());
        assert!(theirs[SKIP_INTRO].on && theirs[SKIP_INTRO].excluded.is_empty());
    }

    #[test]
    fn a_fresh_install_has_every_built_in_off_and_nothing_to_build() {
        let dir = std::env::temp_dir().join(format!("xbuiltin-fresh-{}", std::process::id()));
        for id in IDS {
            let v = view(id, &Saved::default(), &dir, "build");
            assert!(!v.on && !v.active && !v.current, "{id} starts off and unbuilt");
        }
        // the start-up refresh builds only what is on
        assert!(IDS.iter().all(|id| { let v = view(id, &Saved::default(), &dir, "build"); !(v.on && !v.current) }));
    }

    #[test]
    fn a_skin_table_mod_names_the_one_hero_it_changes() {
        let table = |rows: Vec<Value>| json!({ "Exports": [{ "Table": { "Data": rows } }] });
        let game = table(vec![skin_row("1011"), skin_row("1026")]);
        let mut one = game.clone();
        one["Exports"][0]["Table"]["Data"][1]["Value"][0]["Value"] = json!(2);
        assert_eq!(changed_heroes(&game, &one), ["1026"]);
        assert!(changed_heroes(&game, &game).is_empty());
        let mut two = one.clone();
        two["Exports"][0]["Table"]["Data"][0]["Value"][0]["Value"] = json!(2);
        assert_eq!(changed_heroes(&game, &two).len(), 2, "two heroes: no single silhouette");
    }

    #[test]
    fn the_files_change_as_one_set_or_not_at_all() {
        let root = std::env::temp_dir().join(format!("xbuiltin-place-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (dir, out) = (root.join("mods"), root.join("out").join("x"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(root.join("out")).unwrap();
        let write = |base: &Path, text: &str| ["pak", "utoc", "ucas"].iter().for_each(|e| std::fs::write(base.with_extension(e), text).unwrap());
        let read = || files_of(&dir, SKIP_INTRO).map(|f| std::fs::read_to_string(f).unwrap_or_default());
        write(&out, "v1");
        place(&out, &dir, SKIP_INTRO).unwrap();
        assert_eq!(read(), ["v1", "v1", "v1"]);
        // the .ucas copy cannot be made: the old set stays whole and no temporary file is left
        write(&out, "v2");
        std::fs::create_dir_all(with_ext(&files_of(&dir, SKIP_INTRO)[2], "tmp")).unwrap();
        assert!(place(&out, &dir, SKIP_INTRO).is_err());
        assert_eq!(read(), ["v1", "v1", "v1"]);
        assert!(!with_ext(&files_of(&dir, SKIP_INTRO)[0], "tmp").exists());
        std::fs::remove_dir_all(with_ext(&files_of(&dir, SKIP_INTRO)[2], "tmp")).unwrap();
        place(&out, &dir, SKIP_INTRO).unwrap();
        assert_eq!(read(), ["v2", "v2", "v2"]);
        remove(&dir, SKIP_INTRO).unwrap();
        assert!(files_of(&dir, SKIP_INTRO).iter().all(|f| !f.exists()) && std::fs::read_dir(&dir).unwrap().count() == 0, "nothing left, no .old files");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn off_then_on_puts_the_same_files_back_without_a_rebuild() {
        let dir = std::env::temp_dir().join(format!("xbuiltin-park-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        files_of(&dir, SKIP_INTRO).iter().for_each(|f| std::fs::write(f, b"x").unwrap());
        let mut s = Saved { on: false, built_for: Some("b1".into()), built_recipe: recipe(SKIP_INTRO), ..Default::default() };
        park(&dir, SKIP_INTRO).unwrap();
        assert!(!files_of(&dir, SKIP_INTRO)[0].exists() && parked(&dir, SKIP_INTRO).exists(), "off: the game no longer loads it");
        assert!(!view(SKIP_INTRO, &s, &dir, "b1").active);
        s.on = true;
        assert!(fits(SKIP_INTRO, &s, "b1"));
        unpark(&dir, SKIP_INTRO).unwrap();
        assert!(view(SKIP_INTRO, &s, &dir, "b1").current, "on again: current with no build");
        // a game update means a rebuild
        assert!(!fits(SKIP_INTRO, &s, "b2"));
        // a new build replaces the set-aside one, and removing takes every file
        park(&dir, SKIP_INTRO).unwrap();
        remove(&dir, SKIP_INTRO).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }



    #[test]
    fn the_warning_bar_shrinks_to_a_tick() {
        let f = |v: i32| json!({ "$type": "UAssetAPI.UnrealTypes.FFrameNumber, UAssetAPI", "Value": v });
        let doc = json!({ "Exports": [
            { "ObjectName": "Anim_ProgressBar", "Data": [{ "Name": "PlaybackRange", "Value": [{ "Value": { "LowerBound": { "Value": f(0) }, "UpperBound": { "Value": f(285001) } } }] }] },
            { "ObjectName": "Section", "Data": [{ "Value": f(285000) }, { "Value": f(285000) }] },
            // bytes 16 to 20 of the .uexp (a 100-byte header before it): the compiled copy, raw in the JSON
            { "ObjectName": "CompiledData", "$type": "UAssetAPI.ExportTypes.RawExport, UAssetAPI", "SerialOffset": 116, "SerialSize": 4 }] });
        let mut raw = [&7i32.to_le_bytes()[..], &285000i32.to_le_bytes(), &285001i32.to_le_bytes(), &285000i32.to_le_bytes(), &285000i32.to_le_bytes()].concat();
        assert_eq!(shorten_warning(&doc, &mut raw, 100).unwrap(), 4, "the compiled copy shortens with the rest");
        assert_eq!(raw, [&7i32.to_le_bytes()[..], &1i32.to_le_bytes(), &2i32.to_le_bytes(), &1i32.to_le_bytes(), &1i32.to_le_bytes()].concat());
        let mut extra = [&285000i32.to_le_bytes()[..], &285000i32.to_le_bytes(), &285000i32.to_le_bytes(), &285001i32.to_le_bytes(), &0i32.to_le_bytes()].concat();
        assert!(shorten_warning(&doc, &mut extra, 100).is_err(), "a value outside the compiled copy the decoded file does not show stops the build");
    }

    #[test]
    fn intro_flags_turn_off() {
        let mut d = json!({ "Exports": [{ "Table": { "Data": [{ "Name": "Logo", "Value": [
            { "Name": "bUsedInCn", "Value": true }, { "Name": "bUsedInEnRegion", "Value": true }, { "Name": "Other", "Value": true }] }] } }] });
        assert_eq!(edit_logo_table(&mut d).unwrap(), 2);
        assert_eq!(d["Exports"][0]["Table"]["Data"][0]["Value"][2]["Value"], true);
    }

    #[test]
    fn byte_checks_accept_only_the_intended_edits() {
        assert!(check_flags(&[1, 1, 5], &[0, 1, 5], 1).is_ok());
        assert!(check_flags(&[1, 1, 5], &[0, 1, 6], 1).is_err());
    }

    #[test]
    fn a_kept_build_waits_for_the_next_try() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("out").join(stem(SKIP_INTRO));
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        for ext in ["pak", "utoc", "ucas"] {
            std::fs::write(out.with_extension(ext), ext).unwrap();
        }
        let pending = d.path().join("pending").join(SKIP_INTRO);
        keep(&out, &pending, SKIP_INTRO, "build|[]|opts", "12 startup logo videos turned off", &(None, 0)).unwrap();
        assert_eq!(std::fs::read_to_string(pending.join("made-for")).unwrap(), "build|[]|opts");
        assert_eq!(std::fs::read_to_string(pending.join(format!("{}.utoc", stem(SKIP_INTRO)))).unwrap(), "utoc");
        keep(&pending.join(stem(SKIP_INTRO)), &pending, SKIP_INTRO, "build|[]|opts", "x", &(None, 0)).unwrap();
        assert_eq!(std::fs::read_to_string(pending.join("summary")).unwrap(), "12 startup logo videos turned off", "the kept one is left as it is");
        assert!(keep(&d.path().join("missing").join("x"), &d.path().join("p2"), SKIP_INTRO, "k", "s", &(None, 0)).is_err(), "nothing to keep");
    }

    #[test]
    fn a_failed_build_waits_for_a_new_game() {
        let mut s = Saved { on: true, error: Some("Could not pack".into()), ..Default::default() };
        let dir = Path::new("nowhere");
        assert!(!view(SKIP_INTRO, &s, dir, "b1").gave_up, "not failed in this run yet");
        FAILED.lock().unwrap().push(failed_key(SKIP_INTRO, "b1"));
        assert!(view(SKIP_INTRO, &s, dir, "b1").gave_up);
        assert!(!view(SKIP_INTRO, &s, dir, "b2").gave_up, "a game update tries again");
        s.error = None;
        assert!(!view(SKIP_INTRO, &s, dir, "b1").gave_up, "switched on again (the error is cleared): it builds");
    }

    /// Builds the built-ins from the installed game into a temp folder (UAssetTool.dll must sit beside the test binary):
    ///   REPAKXTRA_PAKS=<game Paks folder> cargo test -p repak-x --bin REPAK-X builtins_real -- --ignored --nocapture
    /// REPAKXTRA_BUILTIN=<id> builds just that one.
    #[test]
    #[ignore]
    fn builtins_real() {
        let paks = PathBuf::from(std::env::var("REPAKXTRA_PAKS").expect("REPAKXTRA_PAKS"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let only = std::env::var("REPAKXTRA_BUILTIN").ok();
        for id in IDS.iter().filter(|id| only.as_deref().is_none_or(|o| o == **id)) {
            let work = std::env::temp_dir().join("repak-x").join("xbuiltin-test").join(id);
            let _ = std::fs::remove_dir_all(&work);
            std::fs::create_dir_all(work.join("out")).unwrap();
            let out = work.join("out").join(stem(id));
            let started = std::time::Instant::now();
            let made = rt.block_on(make(Path::new("."), id, &paks, &work, &out));
            println!("{id}: {made:?} in {:.1}s -> {}", started.elapsed().as_secs_f32(), out.display());
            assert!(made.is_ok() && out.with_extension("utoc").exists());
        }
    }
}
