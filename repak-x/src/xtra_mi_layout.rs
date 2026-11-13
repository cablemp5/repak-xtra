//! repakxtra: packages cooked in an older game build's property layout, rewritten in today's. Cooked assets store
//! properties by their index in the class, so a patch that inserts properties moves every later one, and the game
//! crashes loading an older file (3984769 moved the material overrides, 4042190 moved MaterialInstance and
//! AnimSequenceBase, so every older material and emote animation). Today's USMAP cannot read such a file either.
//! Each file is read with an older USMAP, the newest first that reads it whole, and written again with today's: the
//! structs that moved between the two get new headers from the tool, each export's own header is carried over to the
//! new indices (xtra_usmap_diff remap_headers), and only a file that reads back with the same values goes in
//! (pipeline.ts runs it right after extracting the mod, so every later step sees the new layout).

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use tauri::Window;

use crate::vfx_updater::progress::{NoOpProgressSink, TauriVfxProgressSink, VfxProgressSink};
use crate::xtra_niagara::{older_usmaps, read_json, stage, stage_links, to_json, usmap_build};

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Relaid {
    /// Rewritten in today's layout (package paths without extension, as given), each read back with the same values
    pub(crate) files: Vec<String>,
    /// In no layout a USMAP here reads, so kept as they were
    unread: Vec<String>,
    /// In an older layout but not rewritten safely (staging, writing or the read-back failed): the update stops on them
    pub(crate) failed: Vec<String>,
    /// The build whose USMAP read the newest of them
    old_build: Option<u64>,
    /// Every file's layout was told (none left unread, or unsettled for want of an older USMAP)
    pub(crate) complete: bool,
    /// Read whole today, but no older USMAP read them to tell whether they are in its layout
    untold: Vec<String>,
    /// No older USMAP could be had to read them with (offline, or GitHub out of lookups): unread and untold ones may
    /// be told on a later try
    no_usmap: bool,
}

/// Where relayout finds the game's current copies, for files both layouts read whole.
pub(crate) enum Game<'a> {
    None,
    /// already decoded with today's USMAP, under this folder
    Json(&'a Path),
    /// extracted from this Paks folder when needed: only the material instances today's USMAP reads whole
    Fetch(&'a str),
}

/// The class an export is of, by name, when it is an import (a native class); None for a class the package defines.
fn class_of<'a>(json: &'a Value, e: &Value) -> Option<&'a str> {
    let i = e.get("ClassIndex")?.as_i64().filter(|i| *i < 0)?;
    json.get("Imports")?.get((-i - 1) as usize)?.get("ObjectName")?.as_str()
}

/// Each export's values (its properties and its trailing native data), or None when the tool could not read one of a
/// class whose layout moved (`moved`): it keeps such an export as raw bytes. A raw export of a class that did not move
/// reads the same in both layouts, its bytes compared as they are (a montage's notify the tool has no schema for).
fn decoded<'a>(json: &'a Value, moved: &HashSet<String>) -> Option<Vec<(&'a Value, &'a Value)>> {
    json.get("Exports")?
        .as_array()?
        .iter()
        .map(|e| {
            let raw = e.get("$type").and_then(Value::as_str).unwrap_or_default().contains("RawExport");
            (!raw || class_of(json, e).is_some_and(|c| !moved.contains(c))).then(|| (e.get("Data").unwrap_or(&Value::Null), e.get("Extras").unwrap_or(&Value::Null)))
        })
        .collect()
}

/// Without every header the tool keeps from the file it read: decodes are compared by their values alone, since a
/// rewrite gives the moved structs new headers.
fn bare(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.remove("OriginalStructHeader");
            m.values_mut().for_each(bare);
        }
        Value::Array(a) => a.iter_mut().for_each(bare),
        _ => {}
    }
}

/// For a rewrite: without the header the tool keeps for each struct in `moved` (it holds the old layout's indices, so
/// the tool writes a new one from the USMAP). The other headers stay: the tool's own new ones are wrong for some
/// structs, ScalarParameterValue among them.
fn bare_moved(v: &mut Value, moved: &HashSet<String>) {
    match v {
        Value::Object(m) => {
            if m.get("StructType").and_then(Value::as_str).is_some_and(|t| moved.contains(t)) {
                m.remove("OriginalStructHeader");
            }
            m.values_mut().for_each(|v| bare_moved(v, moved));
        }
        Value::Array(a) => a.iter_mut().for_each(|v| bare_moved(v, moved)),
        _ => {}
    }
}

/// The JSON with every name's base in its NameMap: the tool reads "/Game/.../M_StandardBasic_1026" as the name
/// "/Game/.../M_StandardBasic" numbered 1026, as Unreal does, and cannot write it when only the whole string is listed
/// (a mod's NameMap often is: "Attempt to serialize dummy FName").
pub(crate) fn to_tool_json(j: &mut Value) -> Vec<u8> {
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

/// The material overrides a decode read, by property name: what tells two layouts' readings apart, since a mod
/// recolors parameters and keeps the game's overrides.
fn overrides(j: &Value) -> Option<Vec<(&str, &Value)>> {
    fn find(v: &Value) -> Option<&Value> {
        match v {
            Value::Object(m) if m.get("StructType").and_then(Value::as_str) == Some("MaterialInstanceBasePropertyOverrides") => Some(v),
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
/// current copies, where the reading whose overrides match the game's tells the layout. Without one, or when neither
/// matches, `older` decides (the mod was written before the game's last update: the old one). `made`: when the mod was
/// written (Unix seconds, 0 when not known), so only USMAPs from before it are asked (xtra_niagara.rs older_usmaps).
/// `today`: `rels` already decoded with `usmap` under this folder (the material check's own decode), else decoded here.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn relayout(usmap: &str, mod_extract: &Path, rels: &[String], older: bool, made: u64, game: Game<'_>, today: Option<&Path>, work: &Path, progress: &dyn VfxProgressSink) -> Result<Relaid, String> {
    let mut out = Relaid::default();
    let Some(build) = usmap_build(usmap) else { return Ok(out) };
    // what each part took, in the app's log and (REPAKXTRA_TIMING set) on the console: .agent/vfx/bench.mjs reads it
    let mut clock = std::time::Instant::now();
    let mut lap = |what: &str| {
        let line = format!("[relayout timing] {what}: {:.2} s", clock.elapsed().as_secs_f32());
        log::info!("{line}");
        if std::env::var_os("REPAKXTRA_TIMING").is_some() {
            eprintln!("{line}");
        }
        clock = std::time::Instant::now();
    };
    // the layouts the last game updates moved (and below, the ones between each older USMAP and today's): a raw export
    // of any other class reads the same in both
    let mut moved = crate::xtra_usmap_diff::moved_lately();
    let new_layout = crate::xtra_usmap_diff::layout(Path::new(usmap));
    let now_json = match today {
        Some(d) => d.to_path_buf(),
        None => {
            let (now, json) = (work.join("now"), work.join("now_json"));
            stage_links(mod_extract, &now, rels)?;
            to_json(usmap, &now, &json, progress).await?;
            json
        }
    };
    lap("decode with today's mappings");
    // today's reading of each file, where it read whole: parsed once (a mod's 400 materials are 100 MB of JSON, and
    // each was read from disk for the question below, and again for the list after it)
    // (several files at a time: reading 400 of them one after the other took over a second)
    use rayon::prelude::*;
    let mut whole: std::collections::HashMap<&String, Value> = rels.par_iter().filter_map(|r| Some((r, decode(&now_json, r).filter(|j| decoded(j, &moved).is_some())?))).collect();
    let fetched = match game {
        Game::Fetch(paks) => {
            // only what the copies could settle: material instances today's USMAP reads whole
            let ask: Vec<String> = rels.iter().filter(|r| whole.get(r).is_some_and(|j| overrides(j).is_some())).cloned().collect();
            if ask.is_empty() { None } else { game_copies(paks, usmap, &ask, work, true).await }
        }
        _ => None,
    };
    let game_dir = match game {
        Game::Json(d) => Some(d),
        _ => fetched.as_deref(),
    };
    let game: std::collections::HashMap<&String, Value> = game_dir.map_or_else(Default::default, |g| rels.par_iter().filter_map(|r| Some((r, decode(g, r)?))).collect());
    // (package, today's decode when it read whole)
    let mut pending: Vec<(String, Option<Value>)> = rels
        .iter()
        .filter_map(|r| {
            // (a path listed twice finds the map empty the second time and is read again, as each one used to be)
            let today = whole.remove(r).or_else(|| decode(&now_json, r).filter(|j| decoded(j, &moved).is_some()));
            // Read whole today with the game's own overrides: today's layout is the right one whatever an older USMAP
            // reads (old_reading_right's first case), so no older USMAP is asked about it. For a mod already in
            // today's layout that is every file, and the older decode (5 s for 400 materials) does not run at all
            if today.as_ref().is_some_and(|t| game.get(r).and_then(overrides).is_some_and(|g| overrides(t).as_ref() == Some(&g))) {
                return None;
            }
            (today.is_none() || older || game.contains_key(r)).then(|| (r.clone(), today))
        })
        .collect();
    lap(&format!("game copies and reading {} decodes", rels.len()));
    if pending.is_empty() {
        out.complete = true;
        return Ok(out);
    }
    let fixed_json = work.join("fixed_json");
    let _ = std::fs::remove_dir_all(&fixed_json);
    let mut read_any = false;
    for candidate in older_usmaps(build, (made > 0).then_some(made)).await {
        if pending.is_empty() {
            break;
        }
        let Some(old) = candidate.fetch().await else { continue };
        lap("older mappings fetched");
        read_any = true;
        // what moved between this USMAP and today's: those structs get new headers, the exports' own are remapped
        let (pair, old_layout) = match (crate::xtra_usmap_diff::moved_between(Path::new(&old), Path::new(usmap)), crate::xtra_usmap_diff::layout(Path::new(&old)), &new_layout) {
            (Ok(m), Ok(l), Ok(_)) => (m, l),
            (a, b, c) => {
                log::warn!("[vfx relayout] {old}: {:?} {:?} {:?}", a.err(), b.err(), c.as_ref().err());
                continue;
            }
        };
        moved.extend(pair.iter().cloned());
        let (input, json) = (work.join("old"), work.join("old_json"));
        let names: Vec<String> = pending.iter().map(|(r, _)| r.clone()).collect();
        stage_links(mod_extract, &input, &names)?;
        if to_json(&old, &input, &json, progress).await.is_err() {
            continue;
        }
        pending.retain(|(r, today)| {
            let Some(j) = decode(&json, r) else { return true };
            let Some(then) = decoded(&j, &moved) else { return today.is_none() }; // read whole today: today's layout is right
            if today.as_ref().and_then(|t| decoded(t, &moved)).is_some_and(|t| t == then) {
                return false; // the same in both layouts: nothing to rewrite
            }
            if today.as_ref().is_some_and(|t| !old_reading_right(t, &j, game.get(r), older)) {
                return false; // both read whole and today's reading is the right one
            }
            // the file as the tool read it, headers and all: the moved structs' headers go, the exports' are remapped
            let rewritten = read_json(&json.join(format!("{r}.json"))).and_then(|mut raw| {
                bare_moved(&mut raw, &pair);
                crate::xtra_usmap_diff::remap_headers(&mut raw, &old_layout, new_layout.as_ref().map_err(String::clone)?)?;
                let to = fixed_json.join(format!("{r}.json"));
                std::fs::create_dir_all(to.parent().unwrap_or(&fixed_json)).and_then(|_| std::fs::write(&to, to_tool_json(&mut raw))).map_err(|e| e.to_string())
            });
            match rewritten {
                Ok(()) => {
                    out.files.push(r.clone());
                    out.old_build = out.old_build.or(usmap_build(&old));
                }
                Err(e) => {
                    log::warn!("[vfx relayout] {r}: {e}");
                    if std::env::var_os("REPAKXTRA_TIMING").is_some() {
                        eprintln!("[relayout] {r}: {e}");
                    }
                    out.failed.push(r.clone());
                }
            }
            false
        });
        lap("decode with older mappings and compare");
    }
    out.complete = pending.is_empty();
    out.no_usmap = !out.complete && !read_any;
    out.untold = pending.iter().filter(|(_, today)| today.is_some()).map(|(r, _)| r.clone()).collect();
    out.unread = pending.into_iter().filter(|(_, today)| today.is_none()).map(|(r, _)| r).collect();
    if out.files.is_empty() {
        return Ok(out);
    }
    // written with today's USMAP, then read back with it: only a file that reads whole with the same values (every
    // export's properties and trailing native data) goes into the mod
    let (fixed, check) = (work.join("fixed"), work.join("check_json"));
    let _ = std::fs::remove_dir_all(&fixed);
    // one that cannot be written fails the batch but not the others: the check below keeps only what reads back right
    if let Err(e) = crate::vfx_updater::pipeline::step_convert_json_to_uassets(Path::new(""), usmap, &fixed_json.to_string_lossy(), &fixed.to_string_lossy(), progress).await {
        log::warn!("[vfx relayout] {e}");
    }
    lap(&format!("write {} files in today's layout", out.files.len()));
    let written: Vec<&str> = out.files.iter().filter(|r| fixed.join(format!("{r}.uasset")).is_file()).map(String::as_str).collect();
    std::fs::create_dir_all(&fixed).map_err(|e| e.to_string())?;
    std::fs::write(fixed.join("uasset_list.txt"), written.join("\n")).map_err(|e| e.to_string())?;
    to_json(usmap, &fixed, &check, progress).await?;
    lap("read back");
    let mut kept = Vec::new();
    for r in std::mem::take(&mut out.files) {
        let why = match (decode(&check, &r), decode(&fixed_json, &r)) {
            (Some(a), Some(b)) => match (decoded(&a, &moved), decoded(&b, &moved)) {
                (Some(x), Some(y)) if x == y => None,
                (None, _) => Some("does not read back whole"),
                _ => Some("reads back with other values"),
            },
            (None, _) => Some("was not written"),
            _ => Some("its rewrite could not be read"),
        };
        if let Some(why) = why {
            log::warn!("[vfx relayout] {r}: {why}");
            if std::env::var_os("REPAKXTRA_TIMING").is_some() {
                eprintln!("[relayout] {r}: {why}");
            }
        }
        let same = why.is_none();
        let copied = same
            && ["uasset", "uexp"].iter().all(|x| {
                let (from, to) = (fixed.join(format!("{r}.{x}")), mod_extract.join(format!("{r}.{x}")));
                from.is_file() && std::fs::copy(&from, &to).is_ok()
            });
        if copied { kept.push(r) } else { out.failed.push(r) }
    }
    out.files = kept;
    lap("compare and copy into the mod");
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
    let written = crate::xtra_stamp::made(Path::new(mod_path), written);
    let updated = crate::xtra_broken::game_containers(Path::new(game_paks)).iter().map(|c| c.2).max().unwrap_or(0);
    let work = Path::new(stage_dir).join("relayout");
    // newer than the update, its date cannot say a file both layouts read whole is old: the game's copies tell (an
    // extract of only those, no dependencies, so only then)
    let game = if written < updated { Game::None } else { Game::Fetch(game_paks) };
    let r = relayout(usmap_path, Path::new(mod_extract), files, written < updated, written, game, None, &work, progress).await;
    let _ = std::fs::remove_dir_all(&work);
    r
}

/// How many of a decode's exports the tool kept as raw bytes (it could not read them).
fn raw_exports(j: &Value) -> usize {
    j.get("Exports").and_then(Value::as_array).map_or(0, |a| a.iter().filter(|e| e.get("$type").and_then(Value::as_str).unwrap_or_default().contains("RawExport")).count())
}

/// raw_exports of the JSON file at `p`, None when it cannot be read. Only the exports' types are kept while parsing (a
/// material's JSON is 250 KB of which this reads one string per export), and a document that is not shaped as the
/// tool writes them is read whole, as before.
fn raw_count(p: &Path) -> Option<usize> {
    #[derive(serde::Deserialize)]
    struct Export {
        #[serde(rename = "$type", default)]
        kind: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct Doc {
        #[serde(rename = "Exports", default)]
        exports: Option<Vec<Export>>,
    }
    let b = std::fs::read(p).ok()?;
    let b = b.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&b);
    match serde_json::from_slice::<Doc>(b) {
        Ok(d) => Some(d.exports.map_or(0, |e| e.iter().filter(|e| e.kind.as_deref().is_some_and(|t| t.contains("RawExport"))).count())),
        Err(_) => serde_json::from_slice::<Value>(b).ok().map(|j| raw_exports(&j)),
    }
}

/// pipeline.ts, before packing: of `rels` (rebuilt packages under `dir`, no extension), those that do not read back
/// with `usmap` as well as the JSON they were written from (under `json_dir`): no decode at all, or more exports the
/// tool cannot read than that JSON had. The game's own files keep a few such exports (a KO prompt's widget: 6 of 562,
/// 2026-10-31), so a rebuild is held to its source, not to none. A rebuild that reads worse would crash the game.
#[tauri::command]
pub async fn xtra_vfx_verify(window: Window, usmap_path: String, dir: String, rels: Vec<String>, json_dir: String, stage_dir: String) -> Result<Vec<String>, String> {
    verify(&usmap_path, &dir, &rels, &json_dir, &stage_dir, &TauriVfxProgressSink::new(&window)).await
}

/// xtra_vfx_verify without a window (xtra_vfx.rs vfx_rpc runs the pipeline headless).
pub(crate) async fn verify(usmap_path: &str, dir: &str, rels: &[String], json_dir: &str, stage_dir: &str, _progress: &dyn VfxProgressSink) -> Result<Vec<String>, String> {
    if rels.is_empty() {
        return Ok(Vec::new());
    }
    let work = Path::new(&stage_dir).join("verify");
    let input = work.join("in");
    let r = async {
        stage_links(Path::new(dir), &input, rels)?;
        // the tool loads each file as a decode to JSON does and answers with the counts alone (UAssetTool patch 0019):
        // the JSON of 400 materials was 100 MB written and read back for one number each
        // named as stage_links wrote them (the extension added, never swapped in: a name may hold a dot)
        let path = |r: &str| input.join(format!("{r}.uasset")).to_string_lossy().to_string();
        let req = crate::vfx_updater::uasset_tool::VfxUatRequest { action: "batch_raw_export_counts", file_paths: Some(rels.iter().map(|r| path(r)).collect()), usmap_path: Some(usmap_path), ..Default::default() };
        let answer = crate::vfx_updater::uasset_tool::run_vfx_uat_request(Path::new(""), &req).await?;
        if !answer.success {
            return Err(format!("The rebuilt files could not be read back: {}", answer.message));
        }
        let back: std::collections::HashMap<&str, usize> = answer.message.lines().filter_map(|l| l.split_once('\t')).filter_map(|(n, p)| Some((p, n.parse().ok()?))).collect();
        use rayon::prelude::*;
        let source = |r: &str| raw_count(&Path::new(json_dir).join(format!("{r}.json")));
        Ok::<_, String>(
            rels.par_iter()
                .filter(|r| match (back.get(path(r).as_str()).copied(), source(r)) {
                    (Some(back), Some(src)) => back > src,
                    (Some(back), None) => back > 0, // no source JSON (a merged table): whole, or not
                    (None, _) => true,
                })
                .cloned()
                .collect(),
        )
    }
    .await;
    let _ = std::fs::remove_dir_all(&work);
    r
}

/// The game's current copies of `rels` decoded with `usmap`, under `work`/game_json. None when they could not be read.
/// `keep`: the copies are kept for this game build, USMAP and parser (inside vanilla_dir, which goes when any of them
/// changes) and only the ones not yet there are fetched: the game's copy of a material is the same for every mod and
/// every run, and fetching 400 of them took each run about 5 s. Only for the layout check, which reads nothing of a
/// copy but its material overrides (a native struct, read by the USMAP alone). The table merger takes the whole
/// document of a table, whose structs can be read from the files beside it, so it fetches its copies fresh (`keep`
/// false), each run in its own folder as before. A file the extract did not give is never remembered: it is asked for
/// again on the next run, since an extract can miss a file once.
pub(crate) async fn game_copies(game_paks: &str, usmap: &str, rels: &[String], work: &Path, keep: bool) -> Option<std::path::PathBuf> {
    let cache = crate::xtra_vfx::vanilla_dir(game_paks, usmap).join("layout_json");
    let ask: Vec<String> = rels.iter().filter(|r| !keep || !cache.join(format!("{r}.json")).is_file()).cloned().collect();
    if ask.is_empty() {
        return Some(cache);
    }
    let (out, json) = (work.join("game"), work.join("game_json"));
    let _ = std::fs::remove_dir_all(&out);
    let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
        action: "extract_iostore_legacy",
        game_paks: Some(game_paks.to_string()),
        output_path: Some(out.to_string_lossy().to_string()),
        filter_patterns: Some(ask.clone()),
        with_deps: Some(false),
        ..Default::default()
    };
    crate::vfx_updater::uasset_tool::run_vfx_uat_request(Path::new(""), &req).await.ok().filter(|r| r.success)?;
    let have: Vec<String> = ask.iter().filter(|r| out.join(format!("{r}.uasset")).is_file()).cloned().collect();
    stage(&out, &work.join("game_in"), &have, true).ok()?;
    to_json(usmap, &work.join("game_in"), &json, &NoOpProgressSink).await.ok()?;
    if !keep {
        return Some(json);
    }
    // into the cache whole or not at all: written beside its place, then renamed (two runs may fill it at once)
    for (n, r) in have.iter().enumerate() {
        let (from, to) = (json.join(format!("{r}.json")), cache.join(format!("{r}.json")));
        if !from.is_file() {
            continue; // the tool wrote none for it: not known, asked again next run
        }
        let tmp = to.with_extension(format!("tmp{}-{n}", std::process::id()));
        std::fs::create_dir_all(to.parent()?).ok()?;
        if std::fs::copy(&from, &tmp).and_then(|_| std::fs::rename(&tmp, &to)).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return None; // no game copies this run, as when the decode fails
        }
    }
    Some(cache)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_raw_export_reads_whole_only_when_its_class_did_not_move() {
        let doc = |second: &str| json!({ "Imports": [{ "ObjectName": "AnimMontage" }, { "ObjectName": "AnimNotifyState_X" }],
            "Exports": [{ "$type": "UAssetAPI.ExportTypes.NormalExport, UAssetAPI", "ClassIndex": -1, "Data": [1], "Extras": "AA==" },
                        { "$type": second, "ClassIndex": -2, "Data": "Ag==" }] });
        let raw = doc("UAssetAPI.ExportTypes.RawExport, UAssetAPI");
        let moved: HashSet<String> = ["AnimMontage".to_string()].into();
        assert_eq!(decoded(&raw, &moved), Some(vec![(&json!([1]), &json!("AA==")), (&json!("Ag=="), &Value::Null)]), "an unmoved class's raw bytes are compared as they are");
        let notify_moved: HashSet<String> = ["AnimNotifyState_X".to_string()].into();
        assert_eq!(decoded(&raw, &notify_moved), None, "a moved class's raw export is not read");
        let mut h = json!({ "Data": [{ "StructType": "MaterialInstanceBasePropertyOverrides", "OriginalStructHeader": {} }, { "StructType": "Guid", "OriginalStructHeader": {} }] });
        bare_moved(&mut h, &["MaterialInstanceBasePropertyOverrides".to_string()].into());
        assert_eq!(h, json!({ "Data": [{ "StructType": "MaterialInstanceBasePropertyOverrides" }, { "StructType": "Guid", "OriginalStructHeader": {} }] }), "for a rewrite only a moved struct's header goes");
        bare(&mut h);
        assert_eq!(h, json!({ "Data": [{ "StructType": "MaterialInstanceBasePropertyOverrides" }, { "StructType": "Guid" }] }), "for a comparison every header goes");
        let mut j = json!({ "NameMap": ["/Game/M_Basic_1026", "MI_A_0", "T_01", "Plain"] });
        let out: Value = serde_json::from_slice(&to_tool_json(&mut j)).unwrap();
        assert_eq!(out["NameMap"], json!(["/Game/M_Basic_1026", "MI_A_0", "T_01", "Plain", "/Game/M_Basic", "MI_A"]), "bases of numbered names, not of _01");
    }

    #[test]
    fn exports_the_tool_cannot_read_are_counted() {
        // a KO prompt's widget keeps some in the game's own copy: a rebuild is held to its source's count
        let j = json!({ "Exports": [{ "$type": "UAssetAPI.ExportTypes.RawExport, UAssetAPI" }, { "$type": "UAssetAPI.ExportTypes.NormalExport, UAssetAPI" }, { "$type": "UAssetAPI.ExportTypes.RawExport, UAssetAPI" }] });
        assert_eq!(raw_exports(&j), 2);
        assert_eq!(raw_exports(&json!({})), 0);
        // the file reader counts the same, whatever the document's shape
        let d = tempfile::tempdir().unwrap();
        for (n, doc) in [j, json!({}), json!({ "Exports": null }), json!({ "Exports": [{ "$type": 3 }, { "x": 1 }, 7] }), json!({ "Exports": "RawExport" })].iter().enumerate() {
            let p = d.path().join(format!("{n}.json"));
            std::fs::write(&p, [&[0xEF, 0xBB, 0xBF], doc.to_string().as_bytes()].concat()).unwrap();
            assert_eq!(raw_count(&p), Some(raw_exports(doc)), "{doc}");
        }
        std::fs::write(d.path().join("bad.json"), "{").unwrap();
        assert_eq!(raw_count(&d.path().join("bad.json")), None);
        assert_eq!(raw_count(&d.path().join("none.json")), None);
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

    /// The catboy eyes material (CatboyPantherBodyLights, cooked before 3984769): rewritten, it reads whole with today's
    /// USMAP. The installed copy was rewritten on 2026-10-30, so this reads a copy made before the update (the mods
    /// project's 2026-10-22 build, or REPAKXTRA_OLD_LAYOUT_MOD). Run with --ignored on a PC with the game and that copy.
    #[tokio::test]
    #[ignore]
    async fn the_catboy_eyes_material_moves_to_the_new_layout() {
        let paks = r"C:\Program Files (x86)\Steam\steamapps\common\MarvelRivals\MarvelGame\Marvel\Content\Paks";
        let utoc = std::env::var("REPAKXTRA_OLD_LAYOUT_MOD").unwrap_or_else(|_| {
            let home = std::env::var("USERPROFILE").unwrap_or_default();
            format!(r"{home}\Programming\Modding\Claude Assisted Mods\Misc\vfxupdate_20261022\iostore\CatboyPantherBodyLights_9999999_P.utoc")
        });
        let usmap = crate::vfx_updater::commands::saved_usmap_path().expect("a saved USMAP");
        let work = std::env::temp_dir().join("repakxtra-relayout-test");
        let _ = std::fs::remove_dir_all(&work);
        let x = work.join("extract");
        let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
            action: "extract_iostore_legacy",
            game_paks: Some(paks.into()),
            mod_path: Some(utoc.clone()),
            output_path: Some(x.to_string_lossy().into()),
            filter_patterns: Some(vec!["Lobby/MI_1026001_Eyes".into()]),
            with_deps: Some(false),
            ..Default::default()
        };
        assert!(crate::vfx_updater::uasset_tool::run_vfx_uat_request(Path::new(""), &req).await.unwrap().success);
        let rel = "Marvel/Content/Marvel/Characters/1026/1026001/Materials/Lobby/MI_1026001_Eyes".to_string();
        // as a run asks it: only USMAPs from before the mod was written
        let made = std::fs::metadata(&utoc).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let made = crate::xtra_stamp::made(Path::new(&utoc), made);
        let r = relayout(&usmap, &x, std::slice::from_ref(&rel), true, made, Game::None, None, &work.join("w"), &NoOpProgressSink).await.unwrap();
        assert_eq!(r.files, vec![rel.clone()], "rewritten: {r:?}");
        // again, as the update (written after the game update): in today's layout, nothing left to rewrite
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let again = relayout(&usmap, &x, std::slice::from_ref(&rel), false, now, Game::None, None, &work.join("w2"), &NoOpProgressSink).await.unwrap();
        assert!(again.files.is_empty() && again.unread.is_empty() && again.failed.is_empty(), "{again:?}");
        let _ = std::fs::remove_dir_all(&work);
    }
}
