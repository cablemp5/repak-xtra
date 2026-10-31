//! repakxtra: materials and blueprints cooked in an older game build's property layout, rewritten in today's. Cooked
//! assets store properties by their index in the class, so a patch that inserts properties moves every later one. Game
//! build 3984769 (2026-10-29) put bOverride_RenderExtraDepthWithoutMasked and bRenderExtraDepthWithoutMasked at index
//! 40 of MaterialInstanceBasePropertyOverrides: an older material instance that overrides TwoSided, BlendMode,
//! ShadingModel or OpacityMaskClipValue is then read wrong and the game crashes loading it ("Bad name index", seen on
//! MI_1026001_Eyes). Today's USMAP cannot read such a file either, so the VFX Updater found nothing to change.
//! Each file is read with an older USMAP, the newest first that reads it whole, and written again with today's
//! (pipeline.ts runs it right after extracting the mod, so every later step sees the new layout).

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use tauri::Window;

use crate::vfx_updater::progress::{NoOpProgressSink, TauriVfxProgressSink, VfxProgressSink};
use crate::xtra_niagara::{older_usmaps, read_json, stage, to_json, usmap_build};

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Relaid {
    /// Rewritten in today's layout (package paths without extension, as given)
    pub(crate) files: Vec<String>,
    /// In no layout a USMAP here reads, so kept as they were
    unread: Vec<String>,
    /// In an older layout but not rewritten safely (staging, writing or the read-back failed): the update stops on them
    pub(crate) failed: Vec<String>,
    /// The build whose USMAP read the newest of them
    old_build: Option<u64>,
}

/// Each export's properties, or None when the tool could not read one (it keeps such an export as raw bytes).
fn decoded(json: &Value) -> Option<Vec<&Value>> {
    json.get("Exports")?
        .as_array()?
        .iter()
        .map(|e| (!e.get("$type").and_then(Value::as_str).unwrap_or_default().contains("RawExport")).then(|| e.get("Data").unwrap_or(&Value::Null)))
        .collect()
}

/// Structs a patch inserted properties into. shortcut: listed by hand from the USMAPs (3984769, as
/// mrm.dafyddjon.es found), add a struct when a patch moves another one's properties.
const MOVED: &[&str] = &["MaterialInstanceBasePropertyOverrides"];

/// Without the unversioned header the tool keeps from the file it read for each struct in MOVED: it holds the old
/// layout's property indices and is written back as it is, so without it the tool writes a new one from the USMAP. The
/// other headers stay (the tool's own new ones are wrong for some structs, ScalarParameterValue among them).
fn bare(v: &mut Value) {
    match v {
        Value::Object(m) => {
            if m.get("StructType").and_then(Value::as_str).is_some_and(|t| MOVED.contains(&t)) {
                m.remove("OriginalStructHeader");
            }
            m.values_mut().for_each(bare);
        }
        Value::Array(a) => a.iter_mut().for_each(bare),
        _ => {}
    }
}

/// The JSON with every name's base in its NameMap: the tool reads "/Game/.../M_StandardBasic_1026" as the name
/// "/Game/.../M_StandardBasic" numbered 1026, as Unreal does, and cannot write it when only the whole string is listed
/// (a mod's NameMap often is: "Attempt to serialize dummy FName").
fn to_tool_json(j: &mut Value) -> Vec<u8> {
    if let Some(names) = j.get_mut("NameMap").and_then(Value::as_array_mut) {
        let have: HashSet<String> = names.iter().filter_map(Value::as_str).map(String::from).collect();
        let mut bases: Vec<String> = have
            .iter()
            .filter_map(|n| n.rsplit_once('_').filter(|(_, d)| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()) && (d == &"0" || !d.starts_with('0'))).map(|(b, _)| b.to_string()))
            .filter(|b| !have.contains(b))
            .collect();
        bases.sort();
        bases.dedup();
        names.extend(bases.into_iter().map(Value::from));
    }
    serde_json::to_vec(j).unwrap_or_default()
}

/// The material overrides (MOVED) a decode read, by property name: what tells two layouts' readings apart, since a mod
/// recolors parameters and keeps the game's overrides.
fn overrides(j: &Value) -> Option<Vec<(&str, &Value)>> {
    fn find(v: &Value) -> Option<&Value> {
        match v {
            Value::Object(m) if m.get("StructType").and_then(Value::as_str).is_some_and(|t| MOVED.contains(&t)) => Some(v),
            Value::Object(m) => m.values().find_map(find),
            Value::Array(a) => a.iter().find_map(find),
            _ => None,
        }
    }
    let props = find(j.get("Exports")?)?.get("Value")?.as_array()?;
    Some(props.iter().map(|p| (p.get("Name").and_then(Value::as_str).unwrap_or_default(), p.get("Value").or_else(|| p.get("EnumValue")).unwrap_or(&Value::Null))).collect())
}

/// For a file both layouts read whole: whether the older layout's reading (`then`) is the right one. The one whose
/// overrides match the game's copy is, else the date (`older`).
fn old_reading_right(today: &Value, then: &Value, game: Option<&Value>, older: bool) -> bool {
    match game.and_then(overrides) {
        Some(g) if overrides(today).as_ref() == Some(&g) => false,
        Some(g) if overrides(then).as_ref() == Some(&g) => true,
        _ => older,
    }
}

fn decode(dir: &Path, rel: &str) -> Option<Value> {
    let mut j = read_json(&dir.join(format!("{rel}.json"))).ok()?;
    bare(&mut j);
    Some(j)
}

/// `rels` (packages inside `mod_extract`) in an older layout, rewritten there in the layout of `usmap`'s build. A file
/// cooked from the game's files (unversioned) mostly reads whole in both layouts, just with other values (2026-10-31:
/// MI_1026300_LobbyTrail_13_309 reads TwoSided true with today's USMAP, false with 3962284's). `game_json`: the game's
/// current copies decoded with `usmap`, where the reading whose overrides match the game's tells the layout. Without
/// one, or when neither matches, `older` decides (the mod was written before the game's last update: the old one).
pub(crate) async fn relayout(usmap: &str, mod_extract: &Path, rels: &[String], older: bool, game_json: Option<&Path>, work: &Path, progress: &dyn VfxProgressSink) -> Result<Relaid, String> {
    let mut out = Relaid::default();
    let Some(build) = usmap_build(usmap) else { return Ok(out) };
    let (now, now_json) = (work.join("now"), work.join("now_json"));
    stage(mod_extract, &now, rels, true)?;
    to_json(usmap, &now, &now_json, progress).await?;
    let game: std::collections::HashMap<&String, Value> = game_json.map_or_else(Default::default, |g| rels.iter().filter_map(|r| Some((r, decode(g, r)?))).collect());
    // (package, today's decode when it read whole)
    let mut pending: Vec<(String, Option<Value>)> = rels
        .iter()
        .filter_map(|r| {
            let today = decode(&now_json, r).filter(|j| decoded(j).is_some());
            (today.is_none() || older || game.contains_key(r)).then(|| (r.clone(), today))
        })
        .collect();
    if pending.is_empty() {
        return Ok(out);
    }
    let fixed_json = work.join("fixed_json");
    let _ = std::fs::remove_dir_all(&fixed_json);
    for old in older_usmaps(build).await {
        if pending.is_empty() {
            break;
        }
        let (input, json) = (work.join("old"), work.join("old_json"));
        let names: Vec<String> = pending.iter().map(|(r, _)| r.clone()).collect();
        stage(mod_extract, &input, &names, true)?;
        if to_json(&old, &input, &json, progress).await.is_err() {
            continue;
        }
        pending.retain(|(r, today)| {
            let Some(j) = decode(&json, r) else { return true };
            let Some(then) = decoded(&j) else { return today.is_none() }; // read whole today: today's layout is right
            if today.as_ref().and_then(decoded).is_some_and(|t| t == then) {
                return false; // the same in both layouts: nothing to rewrite
            }
            if today.as_ref().is_some_and(|t| !old_reading_right(t, &j, game.get(r), older)) {
                return false; // both read whole and today's reading is the right one
            }
            let to = fixed_json.join(format!("{r}.json"));
            let moved = std::fs::create_dir_all(to.parent().unwrap_or(&fixed_json)).and_then(|_| std::fs::write(&to, to_tool_json(&mut j.clone())));
            if moved.is_ok() {
                out.files.push(r.clone());
                out.old_build = out.old_build.or(usmap_build(&old));
            } else {
                out.failed.push(r.clone());
            }
            false
        });
    }
    out.unread = pending.into_iter().filter(|(_, today)| today.is_none()).map(|(r, _)| r).collect();
    if out.files.is_empty() {
        return Ok(out);
    }
    // written with today's USMAP, then read back with it: only a file that reads whole and the same goes into the mod
    let (fixed, check) = (work.join("fixed"), work.join("check_json"));
    let _ = std::fs::remove_dir_all(&fixed);
    // one that cannot be written fails the batch but not the others: the check below keeps only what reads back right
    if let Err(e) = crate::vfx_updater::pipeline::step_convert_json_to_uassets(Path::new(""), usmap, &fixed_json.to_string_lossy(), &fixed.to_string_lossy(), progress).await {
        log::warn!("[vfx relayout] {e}");
    }
    let written: Vec<&str> = out.files.iter().filter(|r| fixed.join(format!("{r}.uasset")).is_file()).map(String::as_str).collect();
    std::fs::create_dir_all(&fixed).map_err(|e| e.to_string())?;
    std::fs::write(fixed.join("uasset_list.txt"), written.join("\n")).map_err(|e| e.to_string())?;
    to_json(usmap, &fixed, &check, progress).await?;
    let mut kept = Vec::new();
    for r in std::mem::take(&mut out.files) {
        let same = match (decode(&check, &r), decode(&fixed_json, &r)) {
            (Some(a), Some(b)) => decoded(&a).is_some() && decoded(&a) == decoded(&b),
            _ => false,
        };
        let copied = same
            && ["uasset", "uexp"].iter().all(|x| {
                let (from, to) = (fixed.join(format!("{r}.{x}")), mod_extract.join(format!("{r}.{x}")));
                from.is_file() && std::fs::copy(&from, &to).is_ok()
            });
        if copied { kept.push(r) } else { out.failed.push(r) }
    }
    out.files = kept;
    Ok(out)
}

/// pipeline.ts: `files` (package paths inside the run's mod extract) rewritten in today's layout where they are in an
/// older one. `mod_path`: the mod's .utoc, whose date says whether it predates the game's last update.
#[tauri::command]
pub async fn xtra_vfx_relayout(window: Window, mod_path: String, game_paks: String, usmap_path: String, mod_extract: String, files: Vec<String>, stage_dir: String) -> Result<Relaid, String> {
    run(&mod_path, &game_paks, &usmap_path, &mod_extract, &files, &stage_dir, &TauriVfxProgressSink::new(&window)).await
}

/// xtra_vfx_relayout without a window (xtra_vfx.rs vfx_rpc runs the pipeline headless).
pub(crate) async fn run(mod_path: &str, game_paks: &str, usmap_path: &str, mod_extract: &str, files: &[String], stage_dir: &str, progress: &dyn VfxProgressSink) -> Result<Relaid, String> {
    let written = std::fs::metadata(mod_path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    let updated = crate::xtra_broken::game_containers(Path::new(game_paks)).iter().map(|c| c.2).max().unwrap_or(0);
    let work = Path::new(stage_dir).join("relayout");
    // newer than the update, its date cannot say a file both layouts read whole is old: the game's copies tell (one
    // extract, no dependencies, so only then)
    let game = if written < updated { None } else { game_copies(game_paks, usmap_path, files, &work).await };
    let r = relayout(usmap_path, Path::new(mod_extract), files, written < updated, game.as_deref(), &work, progress).await;
    let _ = std::fs::remove_dir_all(&work);
    r
}

/// The game's current copies of `rels` decoded with `usmap`, under `work`/game_json. None when they could not be read.
pub(crate) async fn game_copies(game_paks: &str, usmap: &str, rels: &[String], work: &Path) -> Option<std::path::PathBuf> {
    let (out, json) = (work.join("game"), work.join("game_json"));
    let _ = std::fs::remove_dir_all(&out);
    let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
        action: "extract_iostore_legacy",
        game_paks: Some(game_paks.to_string()),
        output_path: Some(out.to_string_lossy().to_string()),
        filter_patterns: Some(rels.to_vec()),
        with_deps: Some(false),
        ..Default::default()
    };
    crate::vfx_updater::uasset_tool::run_vfx_uat_request(Path::new(""), &req).await.ok().filter(|r| r.success)?;
    let have: Vec<String> = rels.iter().filter(|r| out.join(format!("{r}.uasset")).is_file()).cloned().collect();
    stage(&out, &work.join("game_in"), &have, true).ok()?;
    to_json(usmap, &work.join("game_in"), &json, &NoOpProgressSink).await.ok()?;
    Some(json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_raw_export_is_not_decoded() {
        let ok = json!({ "Exports": [{ "$type": "UAssetAPI.ExportTypes.NormalExport, UAssetAPI", "Data": [1] }] });
        let raw = json!({ "Exports": [{ "$type": "UAssetAPI.ExportTypes.NormalExport, UAssetAPI", "Data": [] }, { "$type": "UAssetAPI.ExportTypes.RawExport, UAssetAPI" }] });
        assert_eq!(decoded(&ok), Some(vec![&json!([1])]));
        assert_eq!(decoded(&raw), None);
        let mut h = json!({ "Data": [{ "StructType": "MaterialInstanceBasePropertyOverrides", "OriginalStructHeader": {} }, { "StructType": "Guid", "OriginalStructHeader": {} }] });
        bare(&mut h);
        assert_eq!(h, json!({ "Data": [{ "StructType": "MaterialInstanceBasePropertyOverrides" }, { "StructType": "Guid", "OriginalStructHeader": {} }] }), "only a moved struct's header goes");
        let mut j = json!({ "NameMap": ["/Game/M_Basic_1026", "MI_A_0", "T_01", "Plain"] });
        let out: Value = serde_json::from_slice(&to_tool_json(&mut j)).unwrap();
        assert_eq!(out["NameMap"], json!(["/Game/M_Basic_1026", "MI_A_0", "T_01", "Plain", "/Game/M_Basic", "MI_A"]), "bases of numbered names, not of _01");
    }

    #[test]
    fn the_reading_that_matches_the_games_overrides_tells_the_layout() {
        // MI_1026300_LobbyTrail_13_309 (2026-10-31): today's USMAP reads TwoSided true, 3962284's false
        let mi = |two_sided: bool| json!({ "Exports": [{ "Data": [{ "Name": "BasePropertyOverrides", "StructType": "MaterialInstanceBasePropertyOverrides",
            "Value": [{ "Name": "bOverride_TwoSided", "Value": true }, { "Name": "TwoSided", "Value": two_sided }] }] }] });
        let (new, old) = (mi(true), mi(false));
        assert!(!old_reading_right(&new, &old, Some(&new), true), "matches the game's today: new layout, whatever the date");
        assert!(old_reading_right(&old, &new, Some(&new), false), "the old reading matches the game's: old layout, whatever the date");
        assert!(old_reading_right(&new, &old, None, true) && !old_reading_right(&new, &old, None, false), "no game copy: the date");
        let other = mi(true);
        assert!(!old_reading_right(&old, &old, Some(&other), false), "neither matches: the date");
    }

    /// The catboy eyes material (CatboyPantherBodyLights, cooked before 3984769) from the installed mods: rewritten, it
    /// reads whole with today's USMAP. Run with --ignored on a PC with the game, the mod and both USMAPs.
    #[tokio::test]
    #[ignore]
    async fn the_catboy_eyes_material_moves_to_the_new_layout() {
        let paks = r"C:\Program Files (x86)\Steam\steamapps\common\MarvelRivals\MarvelGame\Marvel\Content\Paks";
        let usmap = crate::vfx_updater::commands::saved_usmap_path().expect("a saved USMAP");
        let work = std::env::temp_dir().join("repakxtra-relayout-test");
        let _ = std::fs::remove_dir_all(&work);
        let x = work.join("extract");
        let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
            action: "extract_iostore_legacy",
            game_paks: Some(paks.into()),
            mod_path: Some(format!(r"{paks}\~mods\CatboyPantherBodyLights_9999999_P.utoc")),
            output_path: Some(x.to_string_lossy().into()),
            filter_patterns: Some(vec!["Lobby/MI_1026001_Eyes".into()]),
            with_deps: Some(false),
            ..Default::default()
        };
        assert!(crate::vfx_updater::uasset_tool::run_vfx_uat_request(Path::new(""), &req).await.unwrap().success);
        let rel = "Marvel/Content/Marvel/Characters/1026/1026001/Materials/Lobby/MI_1026001_Eyes".to_string();
        let r = relayout(&usmap, &x, std::slice::from_ref(&rel), true, None, &work.join("w"), &NoOpProgressSink).await.unwrap();
        assert_eq!(r.files, vec![rel.clone()], "rewritten: {r:?}");
        // again, as the update (written after the game update): in today's layout, nothing left to rewrite
        let again = relayout(&usmap, &x, std::slice::from_ref(&rel), false, None, &work.join("w2"), &NoOpProgressSink).await.unwrap();
        assert!(again.files.is_empty() && again.unread.is_empty() && again.failed.is_empty(), "{again:?}");
        let _ = std::fs::remove_dir_all(&work);
    }
}
