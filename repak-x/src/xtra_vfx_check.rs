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
    /// "outdated" (one or more built for an older game version), "current" (all built for this one), "unknown" (none
    /// outdated, some cooked elsewhere), "none" (no material instance of the game's)
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

/// Each material instance's verdict: `versions[0]` holds the game's current shader data, the rest older copies found.
fn verdicts(of_mod: &HashMap<String, String>, versions: &[HashMap<String, String>]) -> HashMap<String, Built> {
    of_mod
        .iter()
        .filter(|(k, _)| versions.first().is_some_and(|cur| cur.contains_key(*k)))
        .map(|(k, mine)| {
            let b = if mine.len() < MIN_SHADER_DATA {
                Built::Empty
            } else if versions[0].get(k) == Some(mine) {
                Built::Current
            } else if versions[1..].iter().any(|v| v.get(k) == Some(mine)) {
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

/// The shader data of each material instance among `names` whose JSON is under `dir`, by its path there (lowercase, no
/// extension).
fn shader_data(dir: &Path, names: &HashSet<String>) -> HashMap<String, String> {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .flatten()
        .filter(|e| wanted(e, names, "json"))
        .filter_map(|e| {
            let text = std::fs::read_to_string(e.path()).ok()?;
            let json: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
            let extras: String = json["Exports"].as_array()?.iter().filter_map(|x| x["Extras"].as_str()).collect();
            let key = e.path().strip_prefix(dir).ok()?.with_extension("").to_string_lossy().replace('\\', "/").to_lowercase();
            Some((key, extras))
        })
        .collect()
}

/// Extracts the packages named in `names` (bare names) from `paks` (a Paks folder: every container in it), or from the
/// mod at `mod_utoc`, into `out`, then writes their JSON to `json`.
async fn read(paks: &Path, mod_utoc: Option<&Path>, names: &[String], usmap: &str, out: &Path, json: &Path) -> Result<HashMap<String, String>, String> {
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
    let lower: HashSet<String> = names.iter().map(|n| n.to_lowercase()).collect();
    let rels = packages(out, &lower);
    if rels.is_empty() {
        return Ok(HashMap::new());
    }
    std::fs::write(out.join("uasset_list.txt"), rels.join("\n")).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(json);
    crate::vfx_updater::pipeline::step_convert_mod_to_json(&PathBuf::new(), usmap, &out.to_string_lossy(), &json.to_string_lossy(), &NoOpProgressSink).await?;
    Ok(shader_data(json, &lower))
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

/// `deep`: also walk the game's older containers for the build the shader data matches (the slow part). The background
/// scan does not: it looks for what crashes, the layout, and leaves looks to Check for update and the Mod Updater's Scan.
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

async fn check_in(mod_path: &Path, usmap: &str, mods_dir: &Path, paks: &Path, work: &Path, bases: &[PathBuf], state: &Arc<Mutex<AppState>>, deep: bool) -> Result<VfxCheck, String> {
    let details = crate::compute_mod_details(&mod_path.to_path_buf(), state)?;
    let utoc = mod_path.with_extension("utoc");
    // by class where the name does not tell (a UI material named M_..._Inst), bare names for the extract's filter. The
    // listing runs a process and may read the game's asset list first: off the async workers
    let (p, u, f) = (paks.to_path_buf(), utoc.clone(), details.files.clone());
    let (mics, all_known) = tauri::async_runtime::spawn_blocking(move || crate::xtra_broken::material_instances(&p, &u, &f)).await.map_err(|e| e.to_string())?;
    let names: Vec<String> = mics
        .iter()
        .map(|k| k.rsplit('/').next().unwrap_or(k).to_string())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let none = || VfxCheck { verdict: "none", outdated: vec![], current: vec![], unknown: vec![], old_layout: vec![], why: None };
    if names.is_empty() {
        return Ok(if all_known { none() } else { VfxCheck { verdict: "unknown", why: Some("classes"), ..none() } });
    }
    let mine = read(paks, Some(&utoc), &names, usmap, &work.join("mod"), &work.join("mod_json")).await?;
    let mut versions = vec![read(paks, None, &names, usmap, &work.join("game"), &work.join("game_json")).await?];
    let mut unreadable = false;
    // the older copies: each game container alone, newest first, until every one of the mod's is placed (or none is left)
    let mut containers: Vec<_> = crate::xtra_broken::game_containers(paks).into_iter().filter(|c| !c.0.file_stem().is_some_and(|s| s.eq_ignore_ascii_case("global"))).collect();
    containers.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(&b.0)));
    for (i, (container, _, _)) in containers.iter().enumerate().filter(|_| deep) {
        let open: Vec<String> = verdicts(&mine, &versions).into_iter().filter(|(_, b)| *b == Built::Unknown).map(|(k, _)| k).collect();
        if open.is_empty() {
            break;
        }
        let Some(dir) = alone(container, bases, &format!("alone{i}")) else {
            unreadable = true; // no folder could link it: the rest stays not known, and the toast says why
            break;
        };
        let wanted: Vec<String> = open.iter().map(|k| k.rsplit('/').next().unwrap_or(k).to_string()).collect::<HashSet<_>>().into_iter().collect();
        let found = read(&dir, None, &wanted, usmap, &work.join(format!("alone{i}_out")), &work.join(format!("alone{i}_json"))).await;
        let _ = std::fs::remove_dir_all(&dir);
        match found {
            Ok(v) => versions.push(v),
            Err(_) => unreadable = true,
        }
    }
    let mut out = none();
    let mut all: Vec<_> = verdicts(&mine, &versions).into_iter().collect();
    all.sort_by(|a, b| a.0.cmp(&b.0));
    for (k, b) in all {
        let name = k.rsplit('/').next().unwrap_or(&k).to_string();
        match b {
            Built::Current => out.current.push(name),
            Built::Older => out.outdated.push(name),
            Built::Unknown | Built::Empty => out.unknown.push(name),
        }
    }
    // the layout, read as the VFX Updater reads it before an update (the date only settles a file both layouts read whole)
    let lower: HashSet<String> = names.iter().map(|n| n.to_lowercase()).collect();
    let written = std::fs::metadata(&utoc).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    let older = written < crate::xtra_broken::game_updated(mods_dir);
    let layout = crate::xtra_mi_layout::relayout(usmap, &work.join("mod"), &packages(&work.join("mod"), &lower), older, crate::xtra_mi_layout::Game::Json(&work.join("game_json")), &work.join("relayout"), &NoOpProgressSink).await;
    let layout_ok = layout.as_ref().is_ok_and(|r| r.complete);
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
    let found = verdicts(&mine, &versions);
    out.why = (!out.unknown.is_empty()).then(|| {
        if !found.values().any(|b| *b == Built::Unknown) {
            "empty"
        } else if unreadable {
            "unreadable"
        } else {
            "elsewhere"
        }
    });
    out.verdict = if !out.outdated.is_empty() {
        "outdated"
    } else if !out.unknown.is_empty() {
        "unknown"
    } else if !out.current.is_empty() {
        "current"
    } else {
        "none"
    };
    // up to date only when every material was found and its layout told: else not known, and the next scan looks again
    if out.verdict == "current" && (!layout_ok || !all_known) {
        out.verdict = "unknown";
        out.unknown.append(&mut out.current);
        out.why = Some(if all_known { "layout" } else { "classes" });
    }
    // the Needs VFX update flag follows it: outdated flags it whatever its date, current clears it (only for a mod without
    // Niagara files, which this does not look at)
    let niagara = details.files.iter().any(|f| {
        let n = f.replace('\\', "/").rsplit('/').next().unwrap_or_default().to_ascii_lowercase();
        (n.starts_with("ns_") || n.starts_with("ne_")) && n.ends_with(".uasset")
    });
    // current only when the layout was read too: a "nothing" also stops the date's layout flag (xtra_broken.rs)
    if out.verdict == "outdated" || (out.verdict == "current" && !niagara) {
        crate::xtra_broken::record_check(mods_dir, &utoc, out.verdict == "outdated", !out.old_layout.is_empty())?;
    }
    Ok(out)
}

/// Check for VFX update: whether the mod at `mod_path` (its .pak or .bak_repak) was built for this game version.
#[tauri::command]
pub async fn xtra_vfx_check(mod_path: String, usmap_path: String, state: State<'_, Arc<Mutex<AppState>>>) -> Result<VfxCheck, String> {
    let state = state.inner().clone();
    check(Path::new(&mod_path), &usmap_path, &state, true).await
}

// ---- the same check in the background, for the date check's blind spot ----
// A mod made before a game update but installed after it (or installed before xtra_made.rs kept made dates) reads as
// current by date. After each game update the Library has these checked once each, in the background: one found built
// for an older version gets its Needs VFX update flag, so the VFX Updater's one Update covers it too.

fn scan_store() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X").join("repakxtra-vfx-check-scan-v2.json") // v2: reads the layout too, so every mod is looked at again once
}

/// Mods the background check has looked at: their .utoc (checked_key) -> (size, time written, game's last update then).
type Scanned = HashMap<String, (u64, u64, u64)>;

fn load_scanned(store: &Path) -> Scanned {
    std::fs::read_to_string(store).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Whether the mod at `utoc` still needs a look: never checked as this file, or checked before the game's last update.
fn needs_scan(done: &Scanned, utoc: &Path, game: u64) -> bool {
    match crate::xtra_broken::file_stamp(utoc) {
        Some((size, at)) => done.get(&crate::xtra_broken::checked_key(utoc)) != Some(&(size, at, game)),
        None => false,
    }
}

static SCAN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Checks the mods among `mod_paths` (the Library passes those the date check calls current) that have material
/// instances, each once per file and game update, and returns how many were found outdated (their flag is set). Stops
/// while an update runs (the next scan goes on from there), skipped while another runs or the USMAP is not the game's.
#[tauri::command]
pub async fn xtra_vfx_check_scan(mod_paths: Vec<String>, state: State<'_, Arc<Mutex<AppState>>>) -> Result<usize, String> {
    let Ok(_one) = SCAN.try_lock() else { return Ok(0) };
    let state = state.inner().clone();
    let mods_dir = state.lock().unwrap().game_path.clone();
    let Some(paks) = mods_dir.ancestors().find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Paks"))).map(Path::to_path_buf) else { return Ok(0) };
    let Some(usmap) = crate::vfx_updater::commands::saved_usmap_path().filter(|u| Path::new(u).is_file() && crate::xtra_niagara::usmap_matches(u, &paks)) else { return Ok(0) };
    let game = crate::xtra_broken::game_updated(&mods_dir);
    let store = scan_store();
    let mut done = load_scanned(&store);
    let mut found = 0;
    for p in mod_paths {
        // an update runs, or the game: the next scan goes on from here
        if crate::xtra_vfx::xtra_vfx_lock().is_some() || crate::is_game_process_running() {
            break;
        }
        let path = PathBuf::from(&p);
        let utoc = path.with_extension("utoc");
        if !needs_scan(&done, &utoc, game) {
            continue;
        }
        let (st, pc) = (state.clone(), path.clone());
        let details = tauri::async_runtime::spawn_blocking(move || crate::compute_mod_details(&pc, &st).ok()).await.ok().flatten();
        let (pk, u) = (paks.clone(), utoc.clone());
        let mics = tauri::async_runtime::spawn_blocking(move || details.map(|d| crate::xtra_broken::material_instances(&pk, &u, &d.files))).await.ok().flatten();
        if mics.as_ref().is_some_and(|(m, all)| !m.is_empty() || !all) {
            match check(&path, &usmap, &state, false).await {
                Ok(c) if c.verdict == "outdated" => found += 1,
                Ok(c) if matches!(c.why, Some("layout" | "classes")) => continue, // not settled: looked at again next scan
                Ok(_) => {}
                Err(e) => {
                    log::warn!("[vfx check] {p}: {e}"); // tried again by the next scan
                    continue;
                }
            }
        }
        if let Some((size, at)) = crate::xtra_broken::file_stamp(&utoc) {
            done.insert(crate::xtra_broken::checked_key(&utoc), (size, at, game));
            let _ = std::fs::write(&store, serde_json::to_string(&done).unwrap_or_default()); // each mod: a closed app keeps its progress
        }
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
        done.insert(crate::xtra_broken::checked_key(&utoc), (size, at, 200));
        assert!(!needs_scan(&done, &utoc, 200), "looked at, same file, same game");
        assert!(needs_scan(&done, &utoc, 300), "the game updated since");
        std::fs::write(&utoc, b"toc v2").unwrap();
        assert!(needs_scan(&done, &utoc, 200), "the mod changed");
        assert!(!needs_scan(&done, &dir.path().join("gone.utoc"), 200), "no file, nothing to look at");
    }

    #[test]
    fn a_material_is_judged_by_which_game_copy_its_shader_data_matches() {
        let long = |s: &str| s.repeat(MIN_SHADER_DATA);
        let (s1, s1b, s2, s3, s3b, x) = (long("1"), long("2"), long("3"), long("4"), long("5"), long("6"));
        let mine = map(&[("a/mi_old", &s1), ("a/mi_new", &s2), ("a/mi_cooked", &x), ("a/mi_own", &x), ("a/mi_eyes", "AAAA")]);
        let current = map(&[("a/mi_old", &s1b), ("a/mi_new", &s2), ("a/mi_cooked", &s3b), ("a/mi_eyes", "AAAA")]);
        let previous = map(&[("a/mi_old", &s1), ("a/mi_cooked", &s3)]);
        let v = verdicts(&mine, &[current.clone(), previous]);
        assert_eq!(v.get("a/mi_old"), Some(&Built::Older), "an older game copy's shader data");
        assert_eq!(v.get("a/mi_new"), Some(&Built::Current));
        assert_eq!(v.get("a/mi_cooked"), Some(&Built::Unknown), "cooked by the modder: like none of them");
        assert_eq!(v.get("a/mi_own"), None, "the mod's own, not in the game");
        assert_eq!(v.get("a/mi_eyes"), Some(&Built::Empty), "no shader data of its own: the same everywhere, so no evidence");
        assert_eq!(verdicts(&mine, &[current]).get("a/mi_old"), Some(&Built::Unknown), "no older copy found yet");
    }
}
