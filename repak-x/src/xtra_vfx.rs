//! repakxtra: Fix VFX mods (custom/vfx/), on top of the upstream VFX Updater's UAssetTool steps (vfx_updater/).
//! Adds what the frontend's pipeline needs beyond them: a fresh temp folder per run, a cache of the game's own assets per
//! game build (every mod of a batch reuses one extraction), type detection that names what it could not read, placing the
//! fixed mod beside the original (on or off like it, the original turned off, an older fixed copy to Recently deleted),
//! and the installed game's build.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{State, Window};

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

fn make_dirs(game_paks: &str, run_id: &str) -> Result<VfxDirs, String> {
    if !valid_run_id(run_id) {
        return Err(format!("Invalid run id: {run_id}"));
    }
    let base = base_dir();
    let run = base.join(format!("run-{run_id}"));
    let vanilla = base.join(format!("vanilla-{}", build_hash(Path::new(game_paks))));
    // Earlier runs and other game builds go: one run at a time (the window waits out a cancelled one), and a cache
    // from another build would hand out old game files
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
pub fn xtra_vfx_dirs(game_paks: String, run_id: String) -> Result<VfxDirs, String> {
    make_dirs(&game_paks, &run_id)
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

/// `<name>_UPDATED_9999999_P` for a mod's file stem: the name without its priority suffix (and without an earlier
/// _UPDATED, so fixing a fixed mod keeps its name), spaces as underscores.
pub(crate) fn fixed_stem(stem: &str) -> String {
    let mut b = stem.trim().to_string();
    // "_<digits>_P" or "_P" at the end
    let cut = b.rfind('_').filter(|&i| b[i + 1..].eq_ignore_ascii_case("P")).map(|i| {
        let head = &b[..i];
        head.rfind('_').filter(|&j| j + 1 < i && head[j + 1..].bytes().all(|c| c.is_ascii_digit())).unwrap_or(i)
    });
    if let Some(cut) = cut {
        b.truncate(cut);
    }
    if b.len() > 8 && b.is_char_boundary(b.len() - 8) && b[b.len() - 8..].eq_ignore_ascii_case("_UPDATED") {
        b.truncate(b.len() - 8);
    }
    let b = b.trim().split_whitespace().collect::<Vec<_>>().join("_");
    format!("{b}_UPDATED_9999999_P")
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
}

/// Puts a packed fix (`staged_base` + .utoc/.ucas/.pak) beside the mod it was made from (`source`, its .utoc), named
/// fixed_stem, on or off like the source. With `turn_off_original` an original that was on goes off (its .pak becomes
/// .bak_repak). A file already holding that name goes to Recently deleted first. Tags carry over.
fn place(source: &Path, staged_base: &Path, turn_off_original: bool, trash_root: &Path) -> Result<(Placed, String, String), String> {
    let dir = source.parent().ok_or("The mod has no folder")?;
    let stem = source.file_stem().ok_or("The mod has no name")?.to_string_lossy().to_string();
    let on = dir.join(format!("{stem}.pak"));
    let off = dir.join(format!("{stem}.bak_repak"));
    let was_on = on.exists();
    let target = fixed_stem(&stem);
    let same = target.eq_ignore_ascii_case(&stem);
    let turn_off = turn_off_original && was_on && !same;
    if turn_off && off.exists() {
        return Err(format!("Both an on and an off copy of {stem} are in the mods folder. Delete one of them, then fix it again."));
    }
    let staged = |x: &str| PathBuf::from(format!("{}.{x}", staged_base.to_string_lossy()));
    for x in ["utoc", "ucas", "pak"] {
        if !staged(x).exists() {
            return Err(format!("The fixed mod's .{x} is missing"));
        }
    }

    let existing: Vec<PathBuf> = MOD_EXTS.iter().map(|x| dir.join(format!("{target}.{x}"))).filter(|p| p.exists()).collect();
    let trash = if existing.is_empty() { None } else { Some(crate::xtra_trash::reserve_in(trash_root, None)?) };
    let mut trashed = Vec::new();
    let undo = |trashed: &[PathBuf]| {
        if let Some(t) = &trash {
            for p in trashed {
                let _ = crate::xtra_trash::put_back(t, p);
            }
            crate::xtra_trash::release_if_empty(t);
        }
    };
    for p in &existing {
        if let Err(e) = crate::xtra_trash::discard(trash.as_ref().unwrap(), p) {
            undo(&trashed);
            return Err(format!("Could not move {} to Recently deleted: {e}", p.display()));
        }
        trashed.push(p.clone());
    }

    let main = dir.join(format!("{target}.{}", if was_on { "pak" } else { "bak_repak" }));
    let moves = [(staged("utoc"), dir.join(format!("{target}.utoc"))), (staged("ucas"), dir.join(format!("{target}.ucas"))), (staged("pak"), main.clone())];
    for (i, (from, to)) in moves.iter().enumerate() {
        if let Err(e) = std::fs::rename(from, to).or_else(|_| std::fs::copy(from, to).map(|_| ())) {
            for (_, done) in &moves[..i] {
                let _ = std::fs::remove_file(done);
            }
            undo(&trashed);
            return Err(format!("Could not put the fixed mod in place: {e}"));
        }
    }

    let original = if turn_off {
        std::fs::rename(&on, &off).map_err(|e| format!("The fixed mod is in place, but the original could not be turned off: {e}"))?;
        off
    } else if was_on {
        on
    } else {
        off
    };
    let p = |p: &Path| p.to_string_lossy().to_string();
    Ok((Placed { fixed: p(&main), original: p(&original), turned_off: turn_off, replaced: !existing.is_empty() }, stem, target))
}

#[tauri::command]
pub fn xtra_vfx_place(source: String, staged_base: String, turn_off_original: bool, state: State<'_, Arc<Mutex<AppState>>>) -> Result<Placed, String> {
    crate::xtra_identity::upstream_guard()?;
    let (placed, from, to) = place(Path::new(&source), Path::new(&staged_base), turn_off_original, &crate::xtra_trash::trash_dir())?;
    let mut s = state.lock().unwrap();
    let key = |stem: &str| crate::get_mod_key(Path::new(&format!("{stem}.pak")));
    if let Some(tags) = s.mod_tags.get(&key(&from)).cloned() {
        s.mod_tags.entry(key(&to)).or_insert(tags);
        let _ = crate::save_state(&s);
    }
    Ok(placed)
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

/// The installed game's last update and build, for the Fix VFX mods notice and the USMAP check.
#[tauri::command]
pub fn xtra_game_build(state: State<'_, Arc<Mutex<AppState>>>) -> GameBuild {
    let mods = state.lock().unwrap().game_path.clone();
    mods.ancestors().find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Paks"))).map(game_build).unwrap_or_default()
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
        let (placed, from, to) = place(&mods.join("A_9999999_P.utoc"), &root.join("stage/out"), true, &root.join("trash")).unwrap();
        assert_eq!((from.as_str(), to.as_str()), ("A_9999999_P", "A_UPDATED_9999999_P"));
        assert!(placed.turned_off && !placed.replaced);
        assert!(mods.join("A_UPDATED_9999999_P.pak").exists(), "on, like the original was");
        assert!(mods.join("A_9999999_P.bak_repak").exists() && !mods.join("A_9999999_P.pak").exists(), "the original is off");
        assert_eq!(std::fs::read_to_string(mods.join("A_UPDATED_9999999_P.ucas")).unwrap(), "new");

        // an off original makes an off fix, and is left alone
        for x in ["utoc", "ucas", "pak"] {
            touch(&root.join(format!("stage/out.{x}")), "newer");
        }
        let (placed, ..) = place(&mods.join("A_9999999_P.utoc"), &root.join("stage/out"), true, &root.join("trash")).unwrap();
        assert!(!placed.turned_off && placed.replaced, "the previous fix went to Recently deleted");
        assert!(mods.join("A_UPDATED_9999999_P.bak_repak").exists() && !mods.join("A_UPDATED_9999999_P.pak").exists());
        assert_eq!(std::fs::read_to_string(mods.join("A_UPDATED_9999999_P.ucas")).unwrap(), "newer");
        assert_eq!(std::fs::read_dir(root.join("trash")).unwrap().count(), 1, "the old fix is in the trash given, never the app's");
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
            "xtra_vfx_dirs" => json!(make_dirs(&s(a, "gamePaks"), &s(a, "runId"))?),
            "xtra_vfx_detect" => json!(detect(&s(a, "usmapPath"), &list(a, "paths"), p).await?),
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
