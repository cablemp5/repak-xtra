//! repakxtra: built-in mods, made by the app from the installed game's own data tables, so they follow every game update
//! and new skin without a download. Force default skin repoints every non-default skin of each hero (minus the excluded
//! heroes) to the hero's default skin in MarvelHeroSkinTable and HeroGallery/UISkinTable. Skip startup logos turns off
//! every region flag of MarvelLogoVideoTable. Both are same-size edits: the game's own .uasset header is kept, only the
//! rebuilt .uexp changes, and every changed byte is checked against the intended edits before anything is packed (the
//! same checks as the mod scripts they come from, tools/bp/default_skin_tables.py and skip_logo_movies.py).
//! The paks live in ~mods/.repakxtra-builtin: the library scan skips .repakxtra- folders (xtra_bundle::not_staging), so
//! loadouts, bulk switches and Repak X never see or toggle them. Off sets the .pak aside as .bak_repak (the game skips
//! it, as any mod turned off), and on puts it back when it still fits: made for this game build with these heroes. Only
//! a change of heroes or a game update rebuilds. A build is stale when the game's containers change
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
const UI: &str = "Marvel/Content/Marvel/Data/DataTable/HeroGallery/UISkinTable";
const LOGO: &str = "Marvel/Content/Marvel/Data/DataTable/UI/Login/MarvelLogoVideoTable";
const LOGO_FLAGS: [&str; 4] = ["bUsedInCn", "bUsedInHkMoTw", "bUsedInJpKr", "bUsedInEnRegion"];
pub const DEFAULT_SKIN: &str = "force-default-skin";
pub const SKIP_INTRO: &str = "skip-intro-movies";
pub const CUSTOM_QUAKE: &str = "custom-quake"; // repakxtra: xtra_quake.rs
const IDS: [&str; 3] = [DEFAULT_SKIN, SKIP_INTRO, CUSTOM_QUAKE];

/// One build at a time: they share the work folder root and UAssetTool.
static BUILDING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// repakxtra: which one is building, so switching another one off or on never waits for it (CustomQuake takes minutes)
static IN_FLIGHT: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
/// Set when the built-in building now is switched off: CustomQuake stops at its next batch instead of minutes later.
static STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn stopped() -> bool {
    STOP.load(std::sync::atomic::Ordering::Relaxed)
}
/// Every move of a built-in's files in the game folder, held only for the moves themselves.
static INSTALL: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Waits for a build of `id` in flight, if any (another built-in's build does not hold it up). `stop`: switched off, so
/// that build gives up early (CustomQuake checks between batches). Turning it on never stops it.
async fn wait_for_build(id: &str, stop: bool) {
    if IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).as_deref() == Some(id) {
        if stop {
            STOP.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        drop(BUILDING.lock().await);
    }
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
    on: bool,
    /// Hero ids (1011) whose skins stay as they are (Force default skin only)
    excluded: Vec<String>,
    /// The game build the files on disk were made from
    built_for: Option<String>,
    /// The excluded heroes those files were made with: a failed rebuild leaves the older files and their heroes in place
    #[serde(default)]
    built_excluded: Vec<String>,
    /// The last build had nothing to change (every hero excluded), so no files are needed
    #[serde(default)]
    nothing: bool,
    built_at: Option<u64>,
    /// What the last build changed, for the card
    summary: Option<String>,
    /// Every hero id the skin table held at the last build, so heroes the bundled hero list lacks still show
    heroes: Vec<String>,
    error: Option<String>,
    /// CustomQuake's options, and the ones its files were made with (xtra_quake.rs)
    #[serde(default)]
    quake: Option<crate::xtra_quake::Options>,
    #[serde(default)]
    built_quake: Option<crate::xtra_quake::Options>,
    /// CustomQuake: the other quake mods that were on at the last build or refresh (read off the main thread)
    #[serde(default)]
    overlaps: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinView {
    id: String,
    on: bool,
    excluded: Vec<String>,
    /// On, built, and made from the installed game build with the saved heroes
    current: bool,
    /// Files made for the installed game build are in the game (maybe with an older hero choice)
    active: bool,
    built_at: Option<u64>,
    summary: Option<String>,
    heroes: Vec<String>,
    error: Option<String>,
    /// Its main file (.pak), where the Library lists it, and the size of its files
    path: String,
    size: u64,
    /// CustomQuake: its options, and the mods that are on and change the same map files
    #[serde(skip_serializing_if = "Option::is_none")]
    quake: Option<crate::xtra_quake::Options>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    overlaps: Vec<String>,
}

fn store_path() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X").join("repakxtra-builtins.json")
}

fn load() -> HashMap<String, Saved> {
    std::fs::read_to_string(store_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Held for every read-change-save of the state, never across a build: two commands never write over each other.
static STATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Reads the state, changes it and saves it, as one step.
fn update<R>(f: impl FnOnce(&mut HashMap<String, Saved>) -> R) -> Result<R, String> {
    let _held = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = load();
    let r = f(&mut all);
    save(&all)?;
    Ok(r)
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

/// The files on disk were made for this game build with the heroes chosen now.
fn fits(s: &Saved, build: &str) -> bool {
    let mut made = s.built_excluded.clone();
    made.sort();
    let mut wanted = s.excluded.clone();
    wanted.sort();
    s.built_for.as_deref() == Some(build) && made == wanted && s.built_quake.clone().unwrap_or_default() == s.quake.clone().unwrap_or_default()
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
        excluded: s.excluded.clone(),
        current: s.on && fits(s, build) && (present || s.nothing),
        active: s.on && for_build && present,
        built_at: s.built_at,
        summary: s.summary.clone(),
        heroes: s.heroes.clone(),
        error: s.error.clone(),
        path: files_of(dir, id)[0].to_string_lossy().to_string(),
        size: files_of(dir, id).iter().filter_map(|f| std::fs::metadata(f).ok()).map(|m| m.len()).sum(),
        quake: (id == CUSTOM_QUAKE).then(|| s.quake.clone().unwrap_or_default()),
        overlaps: if id == CUSTOM_QUAKE && s.on { s.overlaps.clone() } else { Vec::new() },
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

fn prop<'a>(s: &'a Value, n: &str) -> Option<&'a Value> {
    s["Value"].as_array()?.iter().find(|x| x["Name"] == n)
}

fn prop_mut<'a>(s: &'a mut Value, n: &str) -> Option<&'a mut Value> {
    s["Value"].as_array_mut()?.iter_mut().find(|x| x["Name"] == n)
}

fn path_of(p: &Value) -> (String, String) {
    let a = &p["Value"]["AssetPath"];
    (a["PackageName"].as_str().unwrap_or("None").to_string(), a["AssetName"].as_str().unwrap_or("None").to_string())
}

/// An edit: the soft path (package, asset) a property had and the one it takes
type Edit = ((String, String), (String, String));

/// `dst` takes `src`'s soft object path; logged only when it changes.
fn set_path(dst: &mut Value, src: &Value, log: &mut Vec<Edit>) {
    let (old, new) = (path_of(dst), path_of(src));
    if old != new {
        dst["Value"] = src["Value"].clone();
        log.push((old, new));
    }
}

fn rows_mut(d: &mut Value) -> Result<&mut Vec<Value>, String> {
    d["Exports"][0]["Table"]["Data"].as_array_mut().ok_or_else(|| "the table has no rows: its layout changed".to_string())
}

fn missing(what: &str, row: &Value) -> String {
    format!("{} has no {what}: the table layout changed", row["Name"].as_str().unwrap_or("a row"))
}

/// Every playable hero row (10xx) of MarvelHeroSkinTable.
fn hero_ids(skin: &Value) -> Vec<String> {
    skin["Exports"][0]["Table"]["Data"].as_array().into_iter().flatten()
        .filter_map(|r| r["Name"].as_str())
        .filter(|n| n.len() == 4 && n.starts_with("10") && n.bytes().all(|b| b.is_ascii_digit()))
        .map(str::to_string)
        .collect()
}

fn edit_skin_table(d: &mut Value, heroes: &HashSet<String>, log: &mut Vec<Edit>) -> Result<usize, String> {
    let tag = |sc: &Value| prop(sc, "TypeTag").and_then(|t| t["Value"][0]["Value"].as_str()).map(str::to_string);
    let mut n = 0;
    for row in rows_mut(d)? {
        if !row["Name"].as_str().is_some_and(|h| heroes.contains(h)) {
            continue;
        }
        let dflt = prop(row, "DefaultSkinItemID").ok_or_else(|| missing("DefaultSkinItemID", row))?["Value"].clone();
        let specs = prop(row, "SkinSpecs").and_then(|p| p["Value"].as_array()).ok_or_else(|| missing("SkinSpecs", row))?;
        let base_at = specs.iter().position(|s| prop(s, "SkinItemID").is_some_and(|p| p["Value"] == dflt)).ok_or_else(|| missing("default skin spec", row))?;
        // the default skin's forms by tag, in order: a form the default lacks takes its first one
        let forms: Vec<(Option<String>, Value)> = prop(&specs[base_at], "SculptSpecs").and_then(|p| p["Value"].as_array())
            .ok_or_else(|| missing("SculptSpecs", row))?.iter().map(|sc| (tag(sc), sc.clone())).collect();
        if forms.is_empty() {
            return Err(missing("default form", row));
        }
        let name = row["Name"].clone();
        let specs = prop_mut(row, "SkinSpecs").and_then(|p| p["Value"].as_array_mut()).ok_or_else(|| missing("SkinSpecs", &name))?;
        for (i, s) in specs.iter_mut().enumerate() {
            if i == base_at {
                continue;
            }
            n += 1;
            let Some(sculpts) = prop_mut(s, "SculptSpecs").and_then(|p| p["Value"].as_array_mut()) else { continue };
            for sc in sculpts {
                if prop(sc, "ChildActor").is_none_or(|p| path_of(p).0 == "None") {
                    continue; // an unused second form (Phoenix 1054102): left blank
                }
                let t = tag(sc);
                let src = &forms.iter().find(|(ft, _)| ft.is_some() && *ft == t).unwrap_or(&forms[0]).1;
                for f in ["ChildActor", "KawaiiCollisionAssetInBattle"] {
                    if let (Some(dst), Some(from)) = (prop_mut(sc, f), prop(src, f)) {
                        set_path(dst, from, log);
                    }
                }
            }
        }
    }
    Ok(n)
}

fn edit_ui_table(d: &mut Value, heroes: &HashSet<String>, log: &mut Vec<Edit>) -> Result<usize, String> {
    let ident = |r: &Value, k: &str| prop(r, "Identifier").and_then(|p| p["Value"].as_array())
        .and_then(|a| a.iter().find(|x| x["Name"] == k)).and_then(|x| x["Value"].as_str()).map(str::to_string);
    let like = |r: &Value| prop(r, "ResultInfo").and_then(|p| p["Value"].as_array()).and_then(|a| a.iter().find(|y| y["Name"] == "LikeActorClass")).cloned();
    let rows = rows_mut(d)?;
    let dflt: HashMap<(String, String), Value> = rows.iter()
        .filter(|r| ident(r, "SkinID").as_deref() == Some("001"))
        .filter_map(|r| Some(((ident(r, "HeroID")?, ident(r, "ShapeID")?), r.clone())))
        .filter(|((h, _), _)| heroes.contains(h))
        .collect();
    let mut n = 0;
    for r in rows.iter_mut() {
        let (Some(h), Some(shape)) = (ident(r, "HeroID"), ident(r, "ShapeID")) else { continue };
        if !heroes.contains(&h) || ident(r, "SkinID").as_deref() == Some("001") {
            continue;
        }
        // a shape the default lacks (Kumiho's form) uses its shape 0 row
        let Some(src) = dflt.get(&(h.clone(), shape)).or_else(|| dflt.get(&(h, "0".to_string()))) else { continue };
        n += 1;
        for f in ["ShowActorClass", "KawaiiCollisionAssetGallery"] {
            if let (Some(from), Some(dst)) = (prop(src, f).cloned(), prop_mut(r, f)) {
                set_path(dst, &from, log);
            }
        }
        if let Some(from) = like(src) {
            if let Some(dst) = prop_mut(r, "ResultInfo").and_then(|p| p["Value"].as_array_mut()).and_then(|a| a.iter_mut().find(|y| y["Name"] == "LikeActorClass")) {
                set_path(dst, &from, log);
            }
        }
    }
    Ok(n)
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

/// Same size, and every changed byte lies in a 16-byte (package FName, asset FName) pair that went from an edit's old
/// path to its new one, exactly one pair per edit. Returns why it does not.
fn check_paths(a: &[u8], b: &[u8], names: &[String], edits: &[Edit]) -> Result<(), String> {
    if a.len() != b.len() {
        return Err(format!("size changed {} -> {}", a.len(), b.len()));
    }
    let idx: HashMap<&str, u32> = names.iter().enumerate().map(|(i, n)| (n.as_str(), i as u32)).collect();
    let pat = |(pkg, asset): &(String, String)| -> Result<Vec<u8>, String> {
        let i = |n: &str| idx.get(n).copied().ok_or_else(|| format!("{n} is not in the name map"));
        Ok([i(pkg)?, 0, i(asset)?, 0].iter().flat_map(|v| v.to_le_bytes()).collect())
    };
    let mut covered = vec![false; a.len()];
    let mut spans = 0;
    for (old, new) in edits.iter().collect::<HashSet<_>>() {
        let (po, pn) = (pat(old)?, pat(new)?);
        for k in 0..a.len().saturating_sub(15) {
            if a[k..k + 16] == po[..] && b[k..k + 16] == pn[..] {
                spans += 1;
                covered[k..k + 16].iter_mut().for_each(|c| *c = true);
            }
        }
    }
    let stray = (0..a.len()).filter(|&x| a[x] != b[x] && !covered[x]).count();
    if stray > 0 || spans != edits.len() {
        return Err(format!("{spans} path pairs changed for {} edits, {stray} stray bytes", edits.len()));
    }
    Ok(())
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

/// Extracts, edits, checks and packs one built-in into `out_dir`. Returns the summary and the hero ids seen.
async fn make(tool: &Path, id: &str, excluded: &[String], quake: &crate::xtra_quake::Options, paks: &Path, work: &Path, out_base: &Path) -> Result<(String, Vec<String>), String> {
    let s = |p: &Path| p.to_string_lossy().to_string();
    let tool = tool.to_path_buf();
    ensure_vfx_uat_session(&tool).await?;
    let usmap = usmap().await?;
    if id == CUSTOM_QUAKE { // repakxtra: new 1x1 packages, not a table edit
        return crate::xtra_quake::make(&tool, &usmap, paks, work, out_base, quake, &game_build(paks), stopped).await.map(|summary| (summary, Vec::new()));
    }
    let tables: &[&str] = if id == DEFAULT_SKIN { &[SKIN, UI] } else { &[LOGO] };
    let (legacy, json, edited, rt, staged) = (work.join("legacy"), work.join("json"), work.join("edited"), work.join("rt"), work.join("mod"));
    let sink = NoOpProgressSink;
    let filters: Vec<String> = tables.iter().map(|t| t.to_string()).collect();
    extract_vanilla_assets(&tool, &s(paks), &s(&legacy), &filters, &sink).await?;
    convert_uassets_to_json(&tool, &usmap, &s(&legacy), &s(&json), &sink).await?;

    let mut logs: Vec<Vec<Edit>> = Vec::new();
    let (mut heroes_seen, summary, flipped);
    if id == DEFAULT_SKIN {
        let mut skin = read_json(&json.join(format!("{SKIN}.json")))?;
        let mut ui = read_json(&json.join(format!("{UI}.json")))?;
        heroes_seen = hero_ids(&skin);
        let heroes: HashSet<String> = heroes_seen.iter().filter(|h| !excluded.contains(h)).cloned().collect();
        let (mut a, mut b) = (Vec::new(), Vec::new());
        let skins = edit_skin_table(&mut skin, &heroes, &mut a)?;
        edit_ui_table(&mut ui, &heroes, &mut b)?;
        summary = format!("{} heroes, {skins} skins set to default", heroes.len());
        write_json(&edited.join(format!("{SKIN}.json")), &skin)?;
        write_json(&edited.join(format!("{UI}.json")), &ui)?;
        logs.push(a);
        logs.push(b);
        flipped = 0;
    } else {
        let mut logo = read_json(&json.join(format!("{LOGO}.json")))?;
        flipped = edit_logo_table(&mut logo)?;
        if flipped == 0 {
            return Err("No startup logo video was on: the game changed how they are listed".to_string());
        }
        heroes_seen = Vec::new();
        summary = format!("{flipped} startup logo videos turned off");
        write_json(&edited.join(format!("{LOGO}.json")), &logo)?;
    }
    if logs.iter().all(Vec::is_empty) && id == DEFAULT_SKIN {
        return Err("Nothing to change: every chosen hero already uses its default skin".to_string());
    }

    convert_json_to_uassets(&tool, &usmap, &s(&edited), &s(&rt), &sink).await?;
    // the game's own header (names, imports, sizes unchanged) with the rebuilt export data, checked byte by byte
    for (i, rel) in tables.iter().enumerate() {
        let dst = staged.join(rel);
        std::fs::create_dir_all(dst.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::copy(legacy.join(format!("{rel}.uasset")), dst.with_extension("uasset")).map_err(|e| format!("{rel}.uasset: {e}"))?;
        std::fs::copy(rt.join(format!("{rel}.uexp")), dst.with_extension("uexp")).map_err(|e| format!("{rel}.uexp: {e}"))?;
        let (a, b) = (std::fs::read(legacy.join(format!("{rel}.uexp"))).map_err(|e| e.to_string())?, std::fs::read(dst.with_extension("uexp")).map_err(|e| e.to_string())?);
        let name = rel.rsplit('/').next().unwrap_or(rel);
        let checked = if id == DEFAULT_SKIN {
            let names: Vec<String> = read_json(&json.join(format!("{rel}.json")))?["NameMap"].as_array()
                .ok_or("the table has no name map")?.iter().filter_map(|n| n.as_str().map(str::to_string)).collect();
            check_paths(&a, &b, &names, &logs[i])
        } else {
            check_flags(&a, &b, flipped)
        };
        checked.map_err(|e| format!("{name} did not rebuild cleanly ({e}), so nothing was installed"))?;
    }
    pack_to_iostore(&tool, &usmap, &s(&staged), &s(out_base), None, &sink).await?;
    heroes_seen.sort();
    Ok((summary, heroes_seen))
}

/// Builds `id` into the built-in folder, replacing the old files only once the new ones exist.
async fn build(app: &tauri::AppHandle, id: &str, dir: &Path, paks: &Path) -> Result<(), String> {
    let _one = BUILDING.lock().await;
    *IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()) = Some(id.to_string());
    STOP.store(false, std::sync::atomic::Ordering::Relaxed);
    let _flight = Flight;
    let all = load();
    let excluded = all.get(id).map(|s| s.excluded.clone()).unwrap_or_default();
    let quake = all.get(id).and_then(|s| s.quake.clone()).unwrap_or_default();
    let work = std::env::temp_dir().join("repak-x").join("xbuiltin").join(id);
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(work.join("out")).map_err(|e| e.to_string())?;
    let out_base = work.join("out").join(stem(id));
    let known = all.get(id).map(|s| s.heroes.clone()).unwrap_or_default();
    // every hero excluded: nothing to build. Only with this game build's hero list, a new hero after an update is not
    // in the old one
    let known_now = all.get(id).and_then(|s| s.built_for.as_deref()) == Some(game_build(paks).as_str());
    if id == DEFAULT_SKIN && known_now && !known.is_empty() && known.iter().all(|h| excluded.contains(h)) {
        remove(dir, id)?;
        return update(|all| {
            let s = all.entry(id.to_string()).or_default();
            s.built_for = Some(game_build(paks));
            s.built_excluded = excluded;
            s.nothing = true;
            s.summary = Some("Every hero keeps their own skins, so nothing is changed".to_string());
            s.error = None;
        });
    }
    // a finished build the game kept out last time (it opened while it built): made for this game and these options
    let pending = std::env::temp_dir().join("repak-x").join("xbuiltin-pending").join(id);
    let made_for = format!("{}|{:?}|{:?}", game_build(paks), { let mut e = excluded.clone(); e.sort(); e }, quake);
    let kept = std::fs::read_to_string(pending.join("made-for")).ok().filter(|k| *k == made_for).and_then(|_| std::fs::read_to_string(pending.join("summary")).ok());
    let (made, from) = match kept {
        Some(summary) => (Ok((summary, Vec::new())), pending.join(stem(id))),
        None => (async { make(&get_uasset_tool_path(app)?, id, &excluded, &quake, paks, &work, &out_base).await }.await, out_base.clone()),
    };
    let _moving = INSTALL.lock().unwrap_or_else(|e| e.into_inner());
    // turned off while it built (the switch saves first, then waits for this build): nothing goes into the game
    if !load().get(id).is_some_and(|s| s.on) {
        clean(&work);
        return park(dir, id);
    }
    // the game or Repak X may have opened while it built (CustomQuake takes minutes): checked again before any file moves
    use tauri::Manager;
    let blocked = app.try_state::<Arc<Mutex<AppState>>>().map_or(Ok(()), |st| game_guard(st.inner())).and_then(|_| crate::xtra_identity::upstream_guard()).err();
    let result = match (made, &blocked) {
        (Ok((summary, _)), Some(_)) => Err(match keep(&from, &pending, id, &made_for, &summary) {
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
    // the other quake mods that are on, read before the saved state is locked (a walk of ~mods)
    let overlaps = if id == CUSTOM_QUAKE && result.is_ok() { dir.parent().map(crate::xtra_quake::overlapping).unwrap_or_default() } else { Vec::new() };
    // the state as it is now: the other built-in may have changed while this one built
    update(|all| {
        let s = all.entry(id.to_string()).or_default();
        match &result {
            Ok((summary, heroes)) => {
                s.built_for = Some(game_build(paks));
                s.built_excluded = excluded.clone();
                s.built_quake = (id == CUSTOM_QUAKE).then(|| quake.clone());
                s.nothing = false;
                s.built_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs());
                s.summary = Some(summary.clone());
                if !heroes.is_empty() {
                    s.heroes = heroes.clone();
                }
                s.error = None;
                if id == CUSTOM_QUAKE {
                    s.overlaps = overlaps.clone();
                }
            }
            Err(e) => {
                log::warn!("[builtins] {id}: {e}");
                s.error = Some(e.clone());
                // files made for an older game build come out: an old table on a new patch can crash the game
                if blocked.is_none() && s.built_for.as_deref() != Some(game_build(paks).as_str()) && remove(dir, id).is_ok() {
                    s.built_for = None;
                    s.nothing = false;
                }
            }
        }
    })?;
    result.map(|_| ())
}

/// Keeps a finished build (its .pak, .utoc and .ucas) for the next try, with what it was made for.
fn keep(from: &Path, pending: &Path, id: &str, made_for: &str, summary: &str) -> Result<(), String> {
    if from.starts_with(pending) {
        return Ok(()); // already the kept one
    }
    clean(pending);
    std::fs::create_dir_all(pending).map_err(|e| e.to_string())?;
    for ext in ["pak", "utoc", "ucas"] {
        std::fs::copy(from.with_extension(ext), pending.join(format!("{}.{ext}", stem(id)))).map_err(|e| e.to_string())?;
    }
    std::fs::write(pending.join("summary"), summary).map_err(|e| e.to_string())?;
    std::fs::write(pending.join("made-for"), made_for).map_err(|e| e.to_string())
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

#[tauri::command]
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

/// Turns a built-in on or off and/or sets its excluded heroes, building or removing its files to match.
#[tauri::command]
pub async fn xtra_builtins_set(app: tauri::AppHandle, id: String, on: Option<bool>, excluded: Option<Vec<String>>, quake: Option<crate::xtra_quake::Options>, state: State<'_, Arc<Mutex<AppState>>>) -> Result<Vec<BuiltinView>, String> {
    if !IDS.contains(&id.as_str()) {
        return Err(format!("No built-in mod called {id}"));
    }
    if let Some(q) = &quake {
        q.look()?; // a color that is not one is refused before anything is saved
    }
    crate::xtra_identity::upstream_guard()?;
    game_guard(state.inner())?;
    let (dir, paks) = dirs_of(&state)?;
    let (changed, now_on) = update(|all| {
        let s = all.entry(id.clone()).or_default();
        let changed = excluded.as_ref().is_some_and(|x| *x != s.excluded) || quake.as_ref().is_some_and(|q| *q != s.quake.clone().unwrap_or_default());
        if let Some(x) = excluded {
            s.excluded = x;
        }
        if let Some(q) = quake {
            s.quake = Some(q);
        }
        if let Some(on) = on {
            s.on = on;
        }
        s.error = None;
        (changed, s.on)
    })?;
    if !now_on {
        // after its own build in flight: it sees the saved Off and places nothing, then its files (if any) go
        wait_for_build(&id, true).await;
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
        // back on with the same heroes and game build: the set-aside files go back in, no rebuild
        if fits(&load()[&id], &build_now) {
            wait_for_build(&id, false).await;
            let _moving = INSTALL.lock().unwrap_or_else(|e| e.into_inner());
            unpark(&dir, &id)?;
        }
        if changed || !view(&id, &load()[&id], &dir, &build_now).current {
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
    for v in views(&state) {
        if v.on && !v.current {
            let _ = build(&app, &v.id, &dir, &paks).await; // the error is saved on the built-in and shown on its card
        }
    }
    // the quake mods that are on now, read off the main thread (they may have changed since the last build)
    if load().get(CUSTOM_QUAKE).is_some_and(|s| s.on) {
        let root = dir.parent().map(Path::to_path_buf).unwrap_or_default();
        let found = tauri::async_runtime::spawn_blocking(move || crate::xtra_quake::overlapping(&root)).await.unwrap_or_default();
        update(|all| all.entry(CUSTOM_QUAKE.to_string()).or_default().overlaps = found)?;
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
    fn force_default_repoints_other_skins_and_skips_excluded_heroes() {
        let mut d = json!({ "Exports": [{ "Table": { "Data": [skin_row("1011"), skin_row("1026")] } }] });
        assert_eq!(hero_ids(&d), vec!["1011", "1026"]);
        let mut log = Vec::new();
        let n = edit_skin_table(&mut d, &HashSet::from(["1011".to_string()]), &mut log).unwrap();
        assert_eq!((n, log.len()), (1, 2));
        let rows = &d["Exports"][0]["Table"]["Data"];
        let child = |r: usize| path_of(prop(&prop(&prop(&rows[r], "SkinSpecs").unwrap()["Value"][1], "SculptSpecs").unwrap()["Value"][0], "ChildActor").unwrap()).1;
        assert_eq!(child(0), "Default");
        assert_eq!(child(1), "Fancy");
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
        files_of(&dir, DEFAULT_SKIN).iter().for_each(|f| std::fs::write(f, b"x").unwrap());
        let mut s = Saved { on: false, built_for: Some("b1".into()), built_excluded: vec!["1026".into()], excluded: vec!["1026".into()], ..Default::default() };
        park(&dir, DEFAULT_SKIN).unwrap();
        assert!(!files_of(&dir, DEFAULT_SKIN)[0].exists() && parked(&dir, DEFAULT_SKIN).exists(), "off: the game no longer loads it");
        assert!(!view(DEFAULT_SKIN, &s, &dir, "b1").active);
        s.on = true;
        assert!(fits(&s, "b1"));
        unpark(&dir, DEFAULT_SKIN).unwrap();
        assert!(view(DEFAULT_SKIN, &s, &dir, "b1").current, "on again: current with no build");
        // a hero change or a game update means a rebuild
        assert!(!fits(&Saved { excluded: vec!["1011".into()], ..s.clone() }, "b1") && !fits(&s, "b2"));
        // a new build replaces the set-aside one, and removing takes every file
        park(&dir, DEFAULT_SKIN).unwrap();
        remove(&dir, DEFAULT_SKIN).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_new_hero_choice_is_not_current_until_built() {
        let dir = std::env::temp_dir().join("repak-x").join("xbuiltin-view-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        files_of(&dir, DEFAULT_SKIN).iter().for_each(|f| std::fs::write(f, b"x").unwrap());
        let mut s = Saved { on: true, built_for: Some("b1".into()), built_excluded: vec!["1026".into()], excluded: vec!["1026".into()], ..Default::default() };
        assert!(view(DEFAULT_SKIN, &s, &dir, "b1").current);
        s.excluded.push("1011".into()); // saved, but the failed rebuild left the old files
        let v = view(DEFAULT_SKIN, &s, &dir, "b1");
        assert!(!v.current && v.active);
        assert!(!view(DEFAULT_SKIN, &s, &dir, "b2").active); // a game update makes the files stale
        let _ = std::fs::remove_dir_all(&dir);
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
        let names: Vec<String> = ["/Game/A", "A", "/Game/B", "B"].map(String::from).to_vec();
        let pair = |p: u32, a: u32| [p, 0, a, 0].iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>();
        let a = [vec![9u8; 4], pair(0, 1), vec![7; 4]].concat();
        let b = [vec![9u8; 4], pair(2, 3), vec![7; 4]].concat();
        let edit = (("/Game/A".to_string(), "A".to_string()), ("/Game/B".to_string(), "B".to_string()));
        assert!(check_paths(&a, &b, &names, &[edit.clone()]).is_ok());
        let mut stray = b.clone();
        stray[0] = 1;
        assert!(check_paths(&a, &stray, &names, &[edit]).is_err());
        assert!(check_flags(&[1, 1, 5], &[0, 1, 5], 1).is_ok());
        assert!(check_flags(&[1, 1, 5], &[0, 1, 6], 1).is_err());
    }

    #[test]
    fn a_kept_build_waits_for_the_next_try() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("out").join(stem(CUSTOM_QUAKE));
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        for ext in ["pak", "utoc", "ucas"] {
            std::fs::write(out.with_extension(ext), ext).unwrap();
        }
        let pending = d.path().join("pending").join(CUSTOM_QUAKE);
        keep(&out, &pending, CUSTOM_QUAKE, "build|[]|opts", "31,011 textures set").unwrap();
        assert_eq!(std::fs::read_to_string(pending.join("made-for")).unwrap(), "build|[]|opts");
        assert_eq!(std::fs::read_to_string(pending.join(format!("{}.utoc", stem(CUSTOM_QUAKE)))).unwrap(), "utoc");
        keep(&pending.join(stem(CUSTOM_QUAKE)), &pending, CUSTOM_QUAKE, "build|[]|opts", "x").unwrap();
        assert_eq!(std::fs::read_to_string(pending.join("summary")).unwrap(), "31,011 textures set", "the kept one is left as it is");
        assert!(keep(&d.path().join("missing").join("x"), &d.path().join("p2"), CUSTOM_QUAKE, "k", "s").is_err(), "nothing to keep");
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
        for (id, excluded) in [(DEFAULT_SKIN, vec!["1026".to_string()]), (SKIP_INTRO, vec![]), (CUSTOM_QUAKE, vec![])].into_iter().filter(|(id, _)| only.as_deref().is_none_or(|o| o == *id)) {
            let work = std::env::temp_dir().join("repak-x").join("xbuiltin-test").join(id);
            let _ = std::fs::remove_dir_all(&work);
            std::fs::create_dir_all(work.join("out")).unwrap();
            let out = work.join("out").join(stem(id));
            let started = std::time::Instant::now();
            let made = rt.block_on(make(Path::new("."), id, &excluded, &crate::xtra_quake::Options::default(), &paks, &work, &out));
            println!("{id}: {made:?} in {:.1}s -> {}", started.elapsed().as_secs_f32(), out.display());
            assert!(made.is_ok() && out.with_extension("utoc").exists());
        }
    }
}
