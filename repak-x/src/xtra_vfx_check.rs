//! repakxtra: Check for VFX update, a manual look at whether a mod's material instances were built for this game
//! version, whatever its file's date says (the Needs VFX update check goes by dates only, xtra_broken.rs).
//! A material instance carries its cooked shader data (the export's Extras), which a recolor never touches and every game
//! update that recompiles the material rewrites. So each of the mod's is compared with the game's current copy and the
//! older copies still in the game's older containers (each read on its own, newest first):
//! - the same as the current copy: built for this version
//! - the same as an older copy: built for that one, so it needs an update
//! - like none of them (the modder cooked it themselves): not known, and not flagged
//! Then their property layout, whatever the shader data says: one stored in an older game build's layout (3984769 moved
//! the material overrides) crashes the game, and its date does not tell when it was installed or packed again later.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

use crate::vfx_updater::progress::NoOpProgressSink;
use crate::vfx_updater::uasset_tool::{run_vfx_uat_request, VfxUatRequest};
use crate::AppState;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VfxCheck {
    /// "outdated" (one or more built for an older game version), "current" (all built for this one), "custom" (none
    /// outdated, some built by the modder: they match no game version, their layout read whole, no badge), "unknown" (the
    /// check could not finish: a layout, the file list or the game's older files not read), "none" (no material instance
    /// of the game's, or only ones with no shader data of their own)
    verdict: &'static str,
    outdated: Vec<String>,
    current: Vec<String>,
    unknown: Vec<String>,
    /// Stored in an older game build's property layout (xtra_mi_layout.rs), so outdated whatever their shader data says
    old_layout: Vec<String>,
    /// Why some are not known: "empty" (no shader data of their own to compare), "unreadable" (the game's older copies
    /// could not be read), "layout" (their layout could not be told), "classes" (the mod's file list with classes could
    /// not be read, so materials not named MI_ may be missing), else "elsewhere" (they match no game version: built by
    /// the modder). "layout" and "classes" are looked at again by the next scan
    why: Option<&'static str>,
}

#[derive(Debug, PartialEq, Clone, Copy)]
enum Built {
    Current,
    Older,
    Unknown,
    /// no shader data of its own (the eyes: 20 characters), the same in every game version, so it tells nothing
    Empty,
}

/// Shader data shorter than this is no evidence either way (a material instance without its own, 2026-10-24: 20 characters).
const MIN_SHADER_DATA: usize = 64;

/// Each material instance's verdict: `current` holds the game's current shader data, `older` the fingerprints
/// (xtra_broken fingerprint) of older copies found.
fn verdicts(of_mod: &HashMap<String, String>, current: &HashMap<String, String>, older: &[HashMap<String, u64>]) -> HashMap<String, Built> {
    of_mod
        .iter()
        .filter(|(k, _)| current.contains_key(*k))
        .map(|(k, mine)| {
            let b = if mine.len() < MIN_SHADER_DATA {
                Built::Empty
            } else if current.get(k) == Some(mine) {
                Built::Current
            } else if older.iter().any(|v| v.get(k) == Some(&crate::xtra_broken::fingerprint(mine))) {
                Built::Older
            } else {
                Built::Unknown
            };
            (k.clone(), b)
        })
        .collect()
}

/// Whether a file under a work folder is one of the material instances `names` (bare names, lowercase).
fn wanted(e: &walkdir::DirEntry, names: &HashSet<String>, ext: &str) -> bool {
    e.path().extension().is_some_and(|x| x == ext) && e.path().file_stem().is_some_and(|s| names.contains(&s.to_string_lossy().to_lowercase()))
}

/// The packages among `names` under `dir`: their paths there, without the extension.
fn packages(dir: &Path, names: &HashSet<String>) -> Vec<String> {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .flatten()
        .filter(|e| wanted(e, names, "uasset"))
        .filter_map(|e| Some(e.path().strip_prefix(dir).ok()?.with_extension("").to_string_lossy().replace('\\', "/")))
        .collect()
}

/// The shader data of each of `rels` (package paths) whose JSON is under `dir`, by its path (lowercase, no extension).
fn shader_of(dir: &Path, rels: &[String]) -> HashMap<String, String> {
    rels.iter()
        .filter_map(|r| {
            let text = std::fs::read_to_string(dir.join(format!("{r}.json"))).ok()?;
            let json: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
            let extras: String = json["Exports"].as_array()?.iter().filter_map(|x| x["Extras"].as_str()).collect();
            Some((r.replace('\\', "/").to_lowercase(), extras))
        })
        .collect()
}

/// Extracts the packages `names` picks (bare names, or full paths the tool finds by lookup) from `paks` (a Paks folder:
/// every container in it), or from the mod at `mod_utoc`, into `out`: their paths there. The tool's command line runs it as a process of its own when it
/// ships (xtra_uat_cli.rs), so the background scan extracts the next mod while this one decodes.
async fn extract(paks: &Path, mod_utoc: Option<&Path>, names: &[String], out: &Path) -> Result<Vec<String>, String> {
    let _ = std::fs::remove_dir_all(out);
    let req = VfxUatRequest {
        action: "extract_iostore_legacy",
        game_paks: Some(paks.to_string_lossy().to_string()),
        mod_path: mod_utoc.map(|m| m.to_string_lossy().to_string()),
        output_path: Some(out.to_string_lossy().to_string()),
        filter_patterns: Some(names.to_vec()),
        with_deps: Some(false),
        ..Default::default()
    };
    let r = run_vfx_uat_request(&PathBuf::new(), &req).await?;
    if !r.success {
        return Err(r.message);
    }
    Ok(packages(out, &names.iter().map(|n| bare(n)).collect()))
}

/// "Marvel/Content/X/MI_A.uasset" or "MI_A" is "mi_a": what packages() matches extracted files by.
fn bare(name: &str) -> String {
    let n = name.rsplit(['/', '\\']).next().unwrap_or(name).to_lowercase();
    n.strip_suffix(".uasset").map(str::to_string).unwrap_or(n)
}

/// The extract's filter for the material instances `mics` (match_key): each one's own path in the mod's file list,
/// which the tool finds by lookup. A bare name makes it test every game package against every pattern (541 patterns
/// took 34 s, a full path list well under a second). A name with no path in the list goes as it is.
fn filters_of(mics: &[String], files: &[String]) -> Vec<String> {
    let mut by_key: HashMap<String, &String> = files.iter().filter(|f| crate::xtra_broken::is_package(f)).map(|f| (crate::xtra_broken::match_key(f), f)).collect();
    // only a path the tool indexes as written (under Marvel/, after any ../): another spelling (a plugin's mount alias,
    // MarvelGAS/Marvel/...) goes as its bare name, which the tool's slower search finds whatever the spelling
    let indexed = |f: &&String| f.replace('\\', "/").trim_start_matches("../").starts_with("Marvel/");
    let mut out: Vec<String> = mics.iter().map(|k| by_key.remove(k).filter(indexed).cloned().unwrap_or_else(|| k.rsplit('/').next().unwrap_or(k).to_string())).collect();
    out.sort();
    out.dedup();
    out
}

/// The packages `rels` extracted under `out`, decoded into `json`: their shader data.
async fn decode(out: &Path, rels: &[String], usmap: &str, json: &Path) -> Result<HashMap<String, String>, String> {
    if rels.is_empty() {
        return Ok(HashMap::new());
    }
    std::fs::write(out.join("uasset_list.txt"), rels.join("\n")).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(json);
    crate::vfx_updater::pipeline::step_convert_mod_to_json(&PathBuf::new(), usmap, &out.to_string_lossy(), &json.to_string_lossy(), &NoOpProgressSink).await?;
    Ok(shader_of(json, rels))
}

/// extract, then decode into `json`.
async fn read(paks: &Path, mod_utoc: Option<&Path>, names: &[String], usmap: &str, out: &Path, json: &Path) -> Result<HashMap<String, String>, String> {
    let rels = extract(paks, mod_utoc, names, out).await?;
    decode(out, &rels, usmap, json).await
}

/// A folder holding only the game's global container (its script objects) and `container`, linked, not copied: under
/// the first of `bases` where that works (hard links stay on one drive: the temp folder, else one beside the game's Paks).
/// The tool cannot be pointed at one container (an empty folder with --global and --container extracts nothing, 2026-10-24).
fn alone(container: &Path, bases: &[PathBuf], name: &str) -> Option<PathBuf> {
    let paks = container.parent()?;
    bases.iter().map(|b| b.join(name)).find(|dir| {
        let _ = std::fs::remove_dir_all(dir);
        let linked = std::fs::create_dir_all(dir).is_ok()
            && [paks.join("global.utoc"), paks.join("global.ucas"), container.to_path_buf(), container.with_extension("ucas")]
                .iter()
                .all(|f| std::fs::hard_link(f, dir.join(f.file_name().unwrap_or_default())).is_ok());
        if !linked {
            let _ = std::fs::remove_dir_all(dir);
        }
        linked
    })
}

/// One check at a time: they share the command line's cached game and their work folders.
static CHECKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// `deep`: also walk the game's older containers for the build the shader data matches (the slow part, only for
/// materials that match no current copy). The background scan does too, so "custom" is never said without the search.
async fn check(mod_path: &Path, usmap: &str, state: &Arc<Mutex<AppState>>, deep: bool) -> Result<VfxCheck, String> {
    let _one = CHECKING.lock().await;
    let mods_dir = state.lock().unwrap().game_path.clone();
    let paks = mods_dir
        .ancestors()
        .find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Paks")))
        .map(Path::to_path_buf)
        .ok_or("Set the game folder in Setup first")?;
    let work = std::env::temp_dir().join("repak-x").join("xcheck").join(std::process::id().to_string());
    // beside the game's Paks (never in it: the game reads only Paks), for a game on another drive than the temp folder
    let beside = paks.parent().map(|c| c.join(".repakxtra-check"));
    let bases: Vec<PathBuf> = [Some(work.clone()), beside.clone()].into_iter().flatten().collect();
    let r = check_in(mod_path, usmap, &mods_dir, &paks, &work, &bases, state, deep).await;
    // every exit, the early ones too
    let _ = std::fs::remove_dir_all(&work);
    if let Some(b) = beside {
        let _ = std::fs::remove_dir_all(b);
    }
    r
}

fn none() -> VfxCheck {
    VfxCheck { verdict: "none", outdated: vec![], current: vec![], unknown: vec![], old_layout: vec![], why: None }
}

/// A mod with no material instance found: none, or not known when its file list with classes could not be read.
fn no_materials(mods_dir: &Path, utoc: &Path, all_known: bool) -> VfxCheck {
    if all_known {
        return none();
    }
    crate::xtra_broken::record_uncertain(mods_dir, utoc, "The asset list could not be fully read. Compatibility could not be verified. This is a precaution, not a confirmed fault.".into());
    VfxCheck { verdict: "unknown", why: Some("classes"), ..none() }
}

async fn check_in(mod_path: &Path, usmap: &str, mods_dir: &Path, paks: &Path, work: &Path, bases: &[PathBuf], state: &Arc<Mutex<AppState>>, deep: bool) -> Result<VfxCheck, String> {
    let details = crate::compute_mod_details(&mod_path.to_path_buf(), state)?;
    let utoc = mod_path.with_extension("utoc");
    // by class where the name does not tell (a UI material named M_..._Inst), the extract's filter from them (filters_of). The
    // listing runs a process and may read the game's asset list first: off the async workers
    let (p, u, f) = (paks.to_path_buf(), utoc.clone(), details.files.clone());
    let (mics, all_known) = tauri::async_runtime::spawn_blocking(move || crate::xtra_broken::material_instances(&p, &u, &f)).await.map_err(|e| e.to_string())?;
    if mics.is_empty() {
        return Ok(no_materials(mods_dir, &utoc, all_known));
    }
    let rels = extract(paks, Some(&utoc), &filters_of(&mics, &details.files), &work.join("mod")).await?;
    Ok(finish(mod_path, usmap, mods_dir, paks, work, bases, &details.files, all_known, &rels, deep, false).await?.expect("never deferred"))
}

// ---- what the deep search found, kept: an older container's copy of a game material never changes ----
// Per container file (its size and time), decoder and USMAP: each material's shader data as a fingerprint, or None
// when the container does not hold it. Many mods replace the same game materials, so each container is read once per
// material, not once per mod. Entries for containers that changed (a game update) are dropped when it loads.

type Found = HashMap<String, HashMap<String, Option<u64>>>;
static FOUND: Mutex<Option<Found>> = Mutex::new(None);

fn found_store() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X").join("repakxtra-deep-found.json")
}

/// This container as the decoder reads it with this USMAP: its file, size and time, the decoder and the USMAP.
fn found_key(container: &Path, usmap: &str) -> Option<String> {
    let (size, at) = crate::xtra_broken::file_stamp(container)?;
    Some(format!("{}|{size}|{at}|{}|{}", crate::xtra_broken::checked_key(container), crate::xtra_vfx::parser_id(), crate::xtra_vfx::usmap_hash(usmap)))
}

/// Runs `f` on the kept answers, loaded once (only the ones whose container is still that file).
fn with_found<T>(f: impl FnOnce(&mut Found) -> T) -> T {
    let mut slot = FOUND.lock().unwrap_or_else(|e| e.into_inner());
    let all = slot.get_or_insert_with(|| {
        let mut all: Found = std::fs::read_to_string(found_store()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        all.retain(|k, _| {
            let mut p = k.split('|');
            let (Some(path), Some(size), Some(at)) = (p.next(), p.next(), p.next()) else { return false };
            crate::xtra_broken::file_stamp(Path::new(path)).is_some_and(|(s, t)| s.to_string() == size && t.to_string() == at)
        });
        all
    });
    f(all)
}

fn save_found() {
    let text = with_found(|all| serde_json::to_string(&*all).unwrap_or_default());
    let store = found_store();
    let tmp = store.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(&tmp, store);
    }
}

/// The rest of a check once the mod's material instances (`rels`) are extracted under `work`/mod. `defer`: when a
/// material matches no current copy, stop before the deep search and say so (None): the scan's second pass does it, so
/// every other mod gets its badges first.
#[allow(clippy::too_many_arguments)]
async fn finish(mod_path: &Path, usmap: &str, mods_dir: &Path, paks: &Path, work: &Path, bases: &[PathBuf], files: &[String], all_known: bool, rels: &[String], deep: bool, defer: bool) -> Result<Option<VfxCheck>, String> {
    let utoc = mod_path.with_extension("utoc");
    // each step's seconds, logged once per mod: what a slow check spent its time on
    let t = std::time::Instant::now();
    let mine = decode(&work.join("mod"), rels, usmap, &work.join("mod_json")).await?;
    let t_decode = t.elapsed().as_secs_f64();
    // the game's current copies of the same packages: extracted and decoded once per game build and USMAP, kept for
    // every mod that replaces them (xtra_niagara game_copies)
    let vanilla = crate::xtra_vfx::vanilla_dir(&paks.to_string_lossy(), usmap);
    let (_, game_json) = crate::xtra_niagara::game_copies(&paks.to_string_lossy(), usmap, rels, work, &vanilla, &NoOpProgressSink).await?;
    let current = shader_of(&game_json, rels);
    let t_game = t.elapsed().as_secs_f64();
    if defer && verdicts(&mine, &current, &[]).values().any(|b| *b == Built::Unknown) {
        return Ok(None);
    }
    let mut older: Vec<HashMap<String, u64>> = Vec::new();
    let mut unreadable = false;
    // the older copies: each game container alone, newest first, until every one of the mod's is placed (or none is left)
    let mut containers: Vec<_> = crate::xtra_broken::game_containers(paks).into_iter().filter(|c| !c.0.file_stem().is_some_and(|s| s.eq_ignore_ascii_case("global"))).collect();
    containers.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(&b.0)));
    for (i, (container, _, _)) in containers.iter().enumerate().filter(|_| deep) {
        let open: Vec<String> = verdicts(&mine, &current, &older).into_iter().filter(|(_, b)| *b == Built::Unknown).map(|(k, _)| k).collect();
        if open.is_empty() {
            break;
        }
        // what an earlier mod's search already read from this container
        let key = found_key(container, usmap);
        let mut here: HashMap<String, u64> = HashMap::new();
        let mut ask = Vec::new();
        with_found(|all| {
            let known = key.as_ref().and_then(|k| all.get(k));
            for k in &open {
                match known.and_then(|m| m.get(k)) {
                    Some(Some(fp)) => {
                        here.insert(k.clone(), *fp);
                    }
                    Some(None) => {} // not in this container
                    None => ask.push(k.clone()),
                }
            }
        });
        if !ask.is_empty() {
            let Some(dir) = alone(container, bases, &format!("alone{i}")) else {
                unreadable = true; // no folder could link it: the rest stays not known, and the toast says why
                break;
            };
            let wanted: Vec<String> = ask.iter().map(|k| k.rsplit('/').next().unwrap_or(k).to_string()).collect::<HashSet<_>>().into_iter().collect();
            let found = read(&dir, None, &wanted, usmap, &work.join(format!("alone{i}_out")), &work.join(format!("alone{i}_json"))).await;
            let _ = std::fs::remove_dir_all(&dir);
            match found {
                Ok(v) => {
                    // an extract of a bare name brings every package of that name, so one asked for and missing is not
                    // in this container
                    let got: HashMap<String, Option<u64>> = ask.iter().map(|k| (k.clone(), v.get(k).map(|s| crate::xtra_broken::fingerprint(s)))).collect();
                    for (k, fp) in &got {
                        if let Some(fp) = fp {
                            here.insert(k.clone(), *fp);
                        }
                    }
                    if let Some(key) = &key {
                        with_found(|all| all.entry(key.clone()).or_default().extend(got));
                    }
                }
                Err(_) => unreadable = true, // not kept: the next check tries again
            }
        }
        older.push(here);
    }
    if deep {
        save_found();
    }
    let t_deep = t.elapsed().as_secs_f64();
    let mut out = none();
    let mut all: Vec<_> = verdicts(&mine, &current, &older).into_iter().collect();
    all.sort_by(|a, b| a.0.cmp(&b.0));
    for (k, b) in all {
        let name = k.rsplit('/').next().unwrap_or(&k).to_string();
        match b {
            Built::Current => out.current.push(name),
            Built::Older => out.outdated.push(name),
            Built::Unknown => out.unknown.push(name),
            // no shader data of its own: the same in every version, so no evidence either way (its layout is still read)
            Built::Empty => {}
        }
    }
    // the layout, read as the VFX Updater reads it before an update (the date only settles a file both layouts read whole)
    let written = std::fs::metadata(&utoc).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    let written = crate::xtra_stamp::made(&utoc, written);
    let older = written < crate::xtra_broken::game_updated(mods_dir);
    // today's decode is the one just made (mod_json): the relayout reads it rather than decoding the same files again
    let layout = crate::xtra_mi_layout::relayout(usmap, &work.join("mod"), rels, older, written, crate::xtra_mi_layout::Game::Json(&game_json), Some(&work.join("mod_json")), &work.join("relayout"), &NoOpProgressSink).await;
    let layout_ok = layout.as_ref().is_ok_and(|r| r.complete);
    let t_all = t.elapsed().as_secs_f64();
    log::info!("[vfx check] {}: {} materials, decode {t_decode:.1}s, game copies {:.1}s, deep {:.1}s, relayout {:.1}s", mod_path.display(), rels.len(), t_game - t_decode, t_deep - t_game, t_all - t_deep);
    if let Ok(r) = &layout {
        // lowercase, as the shader data's names are
        let mut old: Vec<String> = r.files.iter().chain(&r.failed).map(|k| k.rsplit('/').next().unwrap_or(k).to_lowercase()).collect();
        old.sort();
        old.dedup();
        for n in &old {
            out.current.retain(|c| c != n);
            out.unknown.retain(|c| c != n);
            if !out.outdated.contains(n) {
                out.outdated.push(n.clone());
            }
        }
        out.old_layout = old;
    }
    out.why = (!out.unknown.is_empty()).then_some(if unreadable { "unreadable" } else { "elsewhere" });
    let complete = layout_ok && all_known;
    out.verdict = if !out.outdated.is_empty() {
        "outdated"
    } else if !out.unknown.is_empty() {
        // built by the modder: every older build was searched and the layout read whole. That proves only where they
        // were not built, never a fault, so no badge (the Mod Updater's Check says it)
        if complete && !unreadable && deep { "custom" } else { "unknown" }
    } else if !out.current.is_empty() {
        "current"
    } else {
        "none"
    };
    // up to date (or only shader-less ones) only when every material was found and its layout told: else not known, and
    // the next scan looks again
    if matches!(out.verdict, "current" | "none") && !complete {
        out.verdict = "unknown";
        out.unknown.append(&mut out.current);
        out.why = Some(if all_known { "layout" } else { "classes" });
    }
    // the Needs VFX update flag follows it: outdated flags it whatever its date, current clears it (only for a mod without
    // Niagara files, which this does not look at)
    let niagara = files.iter().any(|f| {
        let n = f.replace('\\', "/").rsplit('/').next().unwrap_or_default().to_ascii_lowercase();
        (n.starts_with("ns_") || n.starts_with("ne_")) && n.ends_with(".uasset")
    });
    // current only when the layout was read too: a "nothing" also stops the date's layout flag (xtra_broken.rs)
    // custom too: its layout read whole and nothing was built for an older game, so the date rule must not flag its
    // materials again (a clearance covers materials only, never meshes or animations: xtra_broken Facts.cleared)
    if out.verdict == "outdated" || (matches!(out.verdict, "current" | "custom") && !niagara) {
        crate::xtra_broken::record_check(mods_dir, &utoc, out.verdict == "outdated", !out.old_layout.is_empty())?;
    }
    if out.verdict == "unknown" {
        let reason = if !complete {
            "The material check could not fully establish the layout or asset list. Compatibility could not be verified. This is a precaution, not a confirmed fault or a required repair."
        } else {
            "The game's older files could not be read to compare its materials with. Compatibility could not be verified. This is a precaution, not a confirmed fault or a required repair."
        };
        crate::xtra_broken::record_uncertain(mods_dir, &utoc, reason.into());
    } else if out.verdict != "outdated" && !(matches!(out.verdict, "current" | "custom") && !niagara) {
        // custom, none, or current with Niagara files (which this check never clears): an earlier "not known" goes, so
        // the date check and the Niagara checks judge it again, as for a mod never checked
        crate::xtra_broken::forget_uncertain(&utoc);
    }
    Ok(Some(out))
}

static USER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Whether a Check for update the user started is running (background scans step aside).
pub(crate) fn user_checking() -> bool {
    USER.load(std::sync::atomic::Ordering::Relaxed) > 0
}

/// Check for VFX update: whether the mod at `mod_path` (its .pak or .bak_repak) was built for this game version.
#[tauri::command]
pub async fn xtra_vfx_check(mod_path: String, usmap_path: String, state: State<'_, Arc<Mutex<AppState>>>) -> Result<VfxCheck, String> {
    let state = state.inner().clone();
    USER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let r = check(Path::new(&mod_path), &usmap_path, &state, true).await;
    USER.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    r
}

// ---- the same check in the background, for the date check's blind spot ----
// A mod made before a game update but installed after it (or installed before xtra_made.rs kept made dates) reads as
// current by date. After each game update the Library has these checked once each, in the background: one found built
// for an older version gets its Needs VFX update flag, so the VFX Updater's one Update covers it too.

pub(crate) fn scan_store() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X").join("repakxtra-vfx-check-scan-v2.json") // v2: reads the layout too, so every mod is looked at again once
}

/// Mods the background check has looked at: their .utoc (checked_key) -> (size, time written, game's last update then).
type Scanned = HashMap<String, (u64, u64, u64, String)>;

fn load_scanned(store: &Path) -> Scanned {
    std::fs::read_to_string(store).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Whether the mod at `utoc` still needs a look: never checked as this file, or checked before the game's last update.
/// Kept per decoder (xtra_broken decoder_key), so the stable, test and dev copies keep each other's answers.
fn needs_scan(done: &Scanned, utoc: &Path, game: u64) -> bool {
    let parser = crate::xtra_vfx::parser_id();
    match crate::xtra_broken::file_stamp(utoc) {
        Some((size, at)) => crate::xtra_broken::record_of(done, utoc, parser) != Some(&(size, at, game, parser.to_string())),
        None => false,
    }
}

/// The game update this decoder last looked at the mod at `utoc` in, as the file it is now (an earlier one than now).
fn earlier(done: &Scanned, utoc: &Path) -> Option<u64> {
    let (key, stamp, parser) = (crate::xtra_broken::checked_key(utoc), crate::xtra_broken::file_stamp(utoc)?, crate::xtra_vfx::parser_id());
    done.iter()
        .filter(|(k, _)| k.strip_prefix(key.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with('|')))
        .filter(|(_, v)| (v.0, v.1) == stamp && v.3 == parser)
        .map(|(_, v)| v.2)
        .max()
}

static SCAN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A mod the scan reads with the tools: its material instances by bare name, and its file list.
struct Job {
    p: String,
    path: PathBuf,
    utoc: PathBuf,
    /// its .utoc's size and time when listed: a file replaced before its turn is left to the next scan, never given the
    /// answer of the extract made from the old one
    stamp: Option<(u64, u64)>,
    files: Vec<String>,
    names: Vec<String>,
    all_known: bool,
}

/// Checks the mods among `mod_paths` (the Library passes those the date check calls current) that have material
/// instances, each once per file and game update (outdated ones get their flag), and returns how many it looked at. Stops
/// while an update runs (the next scan goes on from there), skipped while another runs or the USMAP is not the game's.
/// `defer` (the Library's first pass): a mod whose materials need the deep search is left for the pass without it.
#[tauri::command]
pub async fn xtra_vfx_check_scan(app: tauri::AppHandle, mod_paths: Vec<String>, defer: Option<bool>, state: State<'_, Arc<Mutex<AppState>>>) -> Result<usize, String> {
    let defer = defer.unwrap_or(false);
    let Ok(_one) = SCAN.try_lock() else {
        crate::xtra_vfx::note_stopped();
        return Ok(0);
    };
    let state = state.inner().clone();
    let mods_dir = state.lock().unwrap().game_path.clone();
    let Some(paks) = mods_dir.ancestors().find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Paks"))).map(Path::to_path_buf) else { return Ok(0) };
    // the USMAP is needed only to read mods: answers for mods the update did not touch carry over without it (a game update
    // with its USMAP not out yet would otherwise expire every finding until it is)
    let usmap = crate::vfx_updater::commands::saved_usmap_path().filter(|u| Path::new(u).is_file() && crate::xtra_niagara::usmap_matches(u, &paks));
    let game = crate::xtra_broken::game_updated(&mods_dir);
    let parser = crate::xtra_vfx::parser_id();
    let store = scan_store();
    let mut done = load_scanned(&store);
    let legacy = crate::xtra_broken::legacy_uncertain();
    let mut found = 0;
    // "layout" or "classes" (not told) is kept like any answer: the same file, game and parser give the same one, so
    // asking again each launch only burned a minute of CPU per mod. A change to any of them asks again
    let remember = |done: &mut Scanned, utoc: &Path| {
        if let Some((size, at)) = crate::xtra_broken::file_stamp(utoc) {
            done.insert(crate::xtra_broken::decoder_key(utoc, parser), (size, at, game, parser.to_string()));
            let _ = std::fs::write(&store, serde_json::to_string(&*done).unwrap_or_default()); // each mod: a closed app keeps its progress
        }
    };
    // First the mods with work left (cheap: file dates, cached details, the game's asset list), so the progress counts
    // those and not the list
    let mut todo = Vec::new();
    for p in mod_paths {
        let path = PathBuf::from(&p);
        if crate::xtra_builtins::in_folder(&path) {
            continue; // built-ins: xtra_builtins judges them by the game build they were made for, never these checks
        }
        let utoc = path.with_extension("utoc");
        // an answer the 0.59 check reads differently (shader-less materials, the modder's own): looked at once more
        let again = legacy.contains(&crate::xtra_broken::checked_key(&utoc));
        if !needs_scan(&done, &utoc, game) && !again {
            continue;
        }
        let (st, pc, pk, u, before) = (state.clone(), path.clone(), paks.clone(), utoc.clone(), earlier(&done, &utoc).filter(|_| !again));
        let read = tauri::async_runtime::spawn_blocking(move || {
            let d = crate::compute_mod_details(&pc, &st).ok()?;
            // looked at in an earlier game update that rewrote none of its packages: the same files give the same answer
            let kept = before.filter(|g| crate::xtra_broken::untouched_since(&pk, &d.files, *g));
            let (mics, all) = if kept.is_some() { (Vec::new(), true) } else { crate::xtra_broken::material_instances(&pk, &u, &d.files) };
            Some((d.files, mics, all, kept))
        })
        .await
        .ok()
        .flatten();
        let Some((files, mics, all_known, kept)) = read else {
            continue; // its details could not be read this time: looked at again by the next scan
        };
        if let Some(from) = kept {
            crate::xtra_broken::carry_checked(&utoc, from, game); // its verdict too
            remember(&mut done, &utoc);
            found += 1; // the Library reads the verdicts again
            continue;
        }
        let names = filters_of(&mics, &files);
        if names.is_empty() {
            no_materials(&mods_dir, &utoc, all_known); // no tool to run
            remember(&mut done, &utoc);
            found += 1;
            continue;
        }
        let stamp = crate::xtra_broken::file_stamp(&utoc);
        todo.push(Job { p, path, utoc, stamp, files, names, all_known });
    }
    let Some(usmap) = usmap else { return Ok(found) }; // the rest is read once the USMAP matches the game
    // Two lanes: the next mod's extract (the tool's command line, a process of its own) runs while this one decodes (the
    // tool's library, one call at a time). Each lane has its own folder. Where no command line ships, both run in the
    // library one after the other, as before
    let work = std::env::temp_dir().join("repak-x").join("xscan").join(std::process::id().to_string());
    let lane = |i: usize| work.join(format!("lane{}", i % 2));
    // where the game's older containers are linked for a mod whose materials match no current copy (as check() does)
    let beside = paks.parent().map(|c| c.join(".repakxtra-check"));
    let bases: Vec<PathBuf> = [Some(work.join("older")), beside.clone()].into_iter().flatten().collect();
    let start = |j: &Job, dir: PathBuf| {
        let (pk, u, names) = (paks.clone(), j.utoc.clone(), j.names.clone());
        tauri::async_runtime::spawn(async move { extract(&pk, Some(&u), &names, &dir.join("mod")).await })
    };
    let total = todo.len();
    let mut next = todo.first().map(|j| start(j, lane(0)));
    for (i, j) in todo.iter().enumerate() {
        let this = next.take();
        // an update runs, or the game: the next scan goes on from here
        if !crate::xtra_vfx::background_may_run() {
            if let Some(h) = this {
                let _ = h.await; // its process ends before the folder goes
            }
            break;
        }
        crate::xtra_broken::scan_progress(&app, "materials", i, total, &j.path);
        next = todo.get(i + 1).map(|n| start(n, lane(i + 1)));
        let te = std::time::Instant::now();
        let rels = match this {
            Some(h) => h.await.unwrap_or_else(|e| Err(e.to_string())),
            None => extract(&paks, Some(&j.utoc), &j.names, &lane(i).join("mod")).await,
        };
        log::info!("[vfx check] {}: extract waited {:.1}s", j.p, te.elapsed().as_secs_f64());
        let r = match rels {
            Ok(rels) => {
                let _one = CHECKING.lock().await; // a Check for update the user started waits for this mod
                if crate::xtra_broken::file_stamp(&j.utoc) != j.stamp {
                    continue; // replaced since its extract (also while waiting for the lock): its own scan follows
                }
                // deep: older builds are read only for materials that match no current copy, so most mods cost nothing more
                finish(&j.path, &usmap, &mods_dir, &paks, &lane(i), &bases, &j.files, j.all_known, &rels, true, defer).await
            }
            Err(e) => Err(e),
        };
        match r {
            Ok(None) => {} // left for the deep pass: not remembered, so it is still to do
            Ok(Some(_)) => {
                remember(&mut done, &j.utoc);
                found += 1;
            }
            Err(e) => log::warn!("[vfx check] {}: {e}", j.p), // tried again by the next scan
        }
    }
    if let Some(h) = next {
        let _ = h.await;
    }
    let _ = std::fs::remove_dir_all(&work);
    if let Some(b) = beside {
        let _ = std::fs::remove_dir_all(b);
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(xs: &[(&str, &str)]) -> HashMap<String, String> {
        xs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn the_background_check_looks_once_per_file_and_game_update() {
        let dir = tempfile::tempdir().unwrap();
        let utoc = dir.path().join("Aqua_9999999_P.utoc");
        std::fs::write(&utoc, b"toc").unwrap();
        let (size, at) = crate::xtra_broken::file_stamp(&utoc).unwrap();
        let mut done = Scanned::new();
        assert!(needs_scan(&done, &utoc, 200), "never looked at");
        done.insert(crate::xtra_broken::checked_key(&utoc), (size, at, 200, crate::xtra_vfx::parser_id().to_string()));
        assert!(!needs_scan(&done, &utoc, 200), "looked at, same file, same game");
        assert!(needs_scan(&done, &utoc, 300), "the game updated since");
        done.get_mut(&crate::xtra_broken::checked_key(&utoc)).unwrap().3 = "old-parser".into();
        assert!(needs_scan(&done, &utoc, 200), "the parser changed without a game update");
        std::fs::write(&utoc, b"toc v2").unwrap();
        assert!(needs_scan(&done, &utoc, 200), "the mod changed");
        assert!(!needs_scan(&done, &dir.path().join("gone.utoc"), 200), "no file, nothing to look at");
    }

    #[test]
    fn the_extract_gets_each_material_by_its_own_path() {
        let files = vec!["Marvel/Content/Marvel/VFX/MI_Glow.uasset".to_string(), "Marvel/Content/Marvel/VFX/MI_Glow.uexp".to_string(), "Marvel/Content/Marvel/VFX/T_Glow.uasset".to_string()];
        let mics = vec![crate::xtra_broken::match_key(&files[0]), "content/marvel/other/mi_listed".to_string()];
        assert_eq!(filters_of(&mics, &files), vec!["Marvel/Content/Marvel/VFX/MI_Glow.uasset".to_string(), "mi_listed".to_string()], "a path when the list has it, else the bare name");
        let alias = vec!["MarvelGAS/Marvel/VFX/MI_Hit.uasset".to_string()];
        assert_eq!(filters_of(&[crate::xtra_broken::match_key(&alias[0])], &alias), vec!["mi_hit".to_string()], "a mount alias goes as its bare name");
        assert_eq!((bare("Marvel/Content/Marvel/VFX/MI_Glow.uasset"), bare("MI_Glow")), ("mi_glow".to_string(), "mi_glow".to_string()));
    }

    #[test]
    fn a_material_is_judged_by_which_game_copy_its_shader_data_matches() {
        let long = |s: &str| s.repeat(MIN_SHADER_DATA);
        let (s1, s1b, s2, s3, s3b, x) = (long("1"), long("2"), long("3"), long("4"), long("5"), long("6"));
        let mine = map(&[("a/mi_old", &s1), ("a/mi_new", &s2), ("a/mi_cooked", &x), ("a/mi_own", &x), ("a/mi_eyes", "AAAA")]);
        let current = map(&[("a/mi_old", &s1b), ("a/mi_new", &s2), ("a/mi_cooked", &s3b), ("a/mi_eyes", "AAAA")]);
        let previous = map(&[("a/mi_old", &s1), ("a/mi_cooked", &s3)]);
        let previous: HashMap<String, u64> = previous.iter().map(|(k, s)| (k.clone(), crate::xtra_broken::fingerprint(s))).collect();
        let v = verdicts(&mine, &current, &[previous]);
        assert_eq!(v.get("a/mi_old"), Some(&Built::Older), "an older game copy's shader data");
        assert_eq!(v.get("a/mi_new"), Some(&Built::Current));
        assert_eq!(v.get("a/mi_cooked"), Some(&Built::Unknown), "cooked by the modder: like none of them");
        assert_eq!(v.get("a/mi_own"), None, "the mod's own, not in the game");
        assert_eq!(v.get("a/mi_eyes"), Some(&Built::Empty), "no shader data of its own: the same everywhere, so no evidence");
        assert_eq!(verdicts(&mine, &current, &[]).get("a/mi_old"), Some(&Built::Unknown), "no older copy found yet");
    }
}
