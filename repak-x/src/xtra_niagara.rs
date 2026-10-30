//! repakxtra: the VFX Updater's Niagara step (custom/vfx/pipeline.ts step 7). A game update that renumbers Niagara
//! properties (3962284) leaves a mod's Niagara files cooked in the old layout, and the game can crash on them.
//! UAssetTool reads both builds, each with its own USMAP, but cannot write a Niagara file back faithfully (a round trip
//! drops 3 to 5% of it), so nothing is rebuilt from JSON. The decoded files only show which value tables the mod changed
//! (color curves, float arrays, script parameter bytes), and those exact bytes go into the game's own new file. All else
//! stays byte for byte the game's. A file is carried only when every value the mod changed is found that way: any other
//! stays left out, as before this step existed. On LimeColoredVFX this rebuilt 88 of its 89 Niagara files and curve atlases
//! byte for byte as the hand port made with the modding tools (the other has a GPU script that differs).
//! The mod's files are read with the USMAP of an older build: the newest older one that decodes them in the same shape
//! as the game's file (rivals-depot keeps every build's).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::Window;

use crate::vfx_updater::models::VfxPipelineProgress;
use crate::vfx_updater::progress::{TauriVfxProgressSink, VfxProgressSink};

// ---- carrying one file ----

/// A primitive array property's elements as the bytes the file holds, or None for anything else (NaN keeps no bit
/// pattern, enum bytes are names).
fn primitive_bytes(v: &Value) -> Option<Vec<u8>> {
    let o = v.as_object()?;
    let items = o.get("Value")?.as_array()?;
    let vals: Vec<&Value> = items.iter().map(|e| e.as_object().and_then(|e| e.get("Value"))).collect::<Option<_>>()?;
    match o.get("ArrayType")?.as_str()? {
        "FloatProperty" => vals
            .iter()
            .map(|x| {
                let f = match x {
                    Value::Number(n) => n.as_f64()? as f32,
                    // UAssetTool writes some as text: "+0", "-0", "Infinity"
                    Value::String(s) => s.parse::<f32>().ok().filter(|f| !f.is_nan())?,
                    _ => return None,
                };
                Some(f.to_le_bytes())
            })
            .collect::<Option<Vec<_>>>()
            .map(|v| v.concat()),
        "ByteProperty" => vals.iter().map(|x| x.as_u64().filter(|n| *n < 256).map(|n| n as u8)).collect(),
        "IntProperty" => vals.iter().map(|x| x.as_i64().and_then(|n| i32::try_from(n).ok()).map(i32::to_le_bytes)).collect::<Option<Vec<_>>>().map(|v| v.concat()),
        _ => None,
    }
}

fn find_all(hay: &[u8], needle: &[u8]) -> Vec<usize> {
    // the starts of `needle` in `hay`, overlapping ones too, at most two (enough to tell "once" from "more"). Scans for
    // the first byte, then compares: the same answers as a window-by-window scan, far fewer comparisons
    let Some((&first, rest)) = needle.split_first() else { return Vec::new() };
    if needle.len() > hay.len() {
        return Vec::new();
    }
    let last = hay.len() - needle.len();
    let mut found = Vec::new();
    let mut at = 0;
    while at <= last && found.len() < 2 {
        match hay[at..=last].iter().position(|&b| b == first) {
            Some(k) => {
                let i = at + k;
                if &hay[i + 1..i + needle.len()] == rest {
                    found.push(i);
                }
                at = i + 1;
            }
            None => break,
        }
    }
    found
}

/// Why a file is not carried. `shape`: the two files decode differently (the wrong USMAP, or a layout change), not
/// just a value that cannot be placed.
#[derive(Debug)]
struct Reject {
    shape: bool,
    why: String,
}

fn shape(why: String) -> Reject {
    Reject { shape: true, why }
}

struct Ctx<'a> {
    mod_raw: &'a [u8],
    game_raw: &'a [u8],
    game_at: usize,
    out: &'a mut [u8],
    edits: usize,
    /// byte ranges already written in the game's file: two tables never land on the same bytes
    written: &'a mut Vec<std::ops::Range<usize>>,
}

/// The same property in both builds: name, type and element type (a table moved between properties never matches).
fn same_property(m: &Value, g: &Value) -> bool {
    ["Name", "$type", "ArrayType"].iter().all(|k| m.get(*k) == g.get(*k))
}

/// Walks the mod's and the game's decoded data side by side. A value table that differs is copied, as bytes, from the
/// mod's export into the game's; a property only the game has (new in its build) is the game's. Anything else that
/// differs rejects the file.
fn walk(m: &Value, g: &Value, path: &str, c: &mut Ctx) -> Result<(), Reject> {
    if let Some(gb) = primitive_bytes(g) {
        let Some(mb) = primitive_bytes(m).filter(|_| same_property(m, g)) else { return Err(shape(format!("{path} is another property in the mod"))) };
        if mb == gb {
            return Ok(());
        }
        if mb.len() != gb.len() {
            return Err(Reject { shape: false, why: format!("{path} has a different length in the game's file") });
        }
        let (at_mod, at_game) = (find_all(c.mod_raw, &mb), find_all(c.game_raw, &gb));
        if at_mod.len() != 1 || at_game.len() != 1 {
            return Err(Reject { shape: false, why: format!("{path} could not be found once in both files") });
        }
        let at = c.game_at + at_game[0];
        if c.written.iter().any(|r| r.start < at + gb.len() && at < r.end) {
            return Err(Reject { shape: false, why: format!("{path} overlaps another table") });
        }
        c.written.push(at..at + gb.len());
        c.out[at..at + gb.len()].copy_from_slice(&mb);
        c.edits += 1;
        return Ok(());
    }
    match (m, g) {
        (Value::Object(mo), Value::Object(go)) => {
            if mo.get("$type") != go.get("$type") {
                return Err(shape(format!("{path} has another type")));
            }
            for (k, gv) in go {
                if k == "OriginalUnversionedHeader" {
                    continue;
                }
                if let Some(mv) = mo.get(k) {
                    walk(mv, gv, &format!("{path}.{k}"), c)?;
                }
            }
            match mo.keys().find(|k| *k != "OriginalUnversionedHeader" && !go.contains_key(*k)) {
                Some(k) => Err(shape(format!("{path}.{k} is gone from the game's file"))),
                None => Ok(()),
            }
        }
        (Value::Array(ma), Value::Array(ga)) => {
            if ma.len() != ga.len() {
                return Err(shape(format!("{path} has {} entries in the mod and {} in the game's file", ma.len(), ga.len())));
            }
            ma.iter().zip(ga).enumerate().try_for_each(|(i, (a, b))| walk(a, b, &format!("{path}[{i}]"), c))
        }
        _ if m == g => Ok(()),
        // a property that is not a list of numbers: its old value cannot be found in the file to carry it
        _ => Err(Reject { shape: false, why: format!("{path} changed outside a value table") }),
    }
}

fn num(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.parse().ok(),
        Value::Object(o) => num(o.get("Index")),
        _ => None,
    }
}

/// Each export's outer path ("NS_A/Emitter/SpawnScript/NiagaraDataInterfaceColorCurve_0"): names repeat across emitters.
fn export_paths(j: &Value) -> Vec<String> {
    let ex: &[Value] = j.get("Exports").and_then(Value::as_array).map_or(&[], |v| v.as_slice());
    let mut memo: Vec<Option<String>> = vec![None; ex.len()];
    fn path(i: usize, ex: &[Value], memo: &mut Vec<Option<String>>, depth: usize) -> String {
        if let Some(p) = &memo[i] {
            return p.clone();
        }
        let name = ex[i].get("ObjectName").map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).unwrap_or_default();
        let outer = num(ex[i].get("OuterIndex")).unwrap_or(0);
        let p = if outer > 0 && (outer as usize) <= ex.len() && depth < 64 { format!("{}/{name}", path(outer as usize - 1, ex, memo, depth + 1)) } else { name };
        memo[i] = Some(p.clone());
        p
    }
    (0..ex.len()).map(|i| path(i, ex, &mut memo, 0)).collect()
}

fn is_raw(e: &Value) -> bool {
    e.get("$type").and_then(Value::as_str).is_some_and(|t| t.contains("RawExport"))
}

/// Bytes a base64 text decodes to.
fn b64_len(s: &str) -> usize {
    let s = s.trim();
    (s.len() / 4) * 3 - s.bytes().rev().take_while(|b| *b == b'=').count()
}

/// The game's file (`game_bytes`, its .uasset then .uexp) with the mod's changed value tables in it, and how many.
/// `pixels`: a curve atlas, a color texture whose pixels (the data after its properties) are the mod's colors and hold
/// no property layout, so they are carried whole when the same size.
fn carry(mod_json: &Value, game_json: &Value, mod_bytes: &[u8], game_bytes: &[u8], pixels: bool) -> Result<(Vec<u8>, usize), Reject> {
    let (mp, gp) = (export_paths(mod_json), export_paths(game_json));
    let mex = mod_json.get("Exports").and_then(Value::as_array).ok_or_else(|| shape("the mod's file has no exports".into()))?;
    let gex = game_json.get("Exports").and_then(Value::as_array).ok_or_else(|| shape("the game's file has no exports".into()))?;
    let mine: HashMap<&str, usize> = mp.iter().enumerate().map(|(i, p)| (p.as_str(), i)).collect();
    if let Some(p) = mp.iter().find(|p| !gp.contains(p)) {
        return Err(shape(format!("{p} is gone from the game's file")));
    }
    let range = |e: &Value, len: usize| -> Option<std::ops::Range<usize>> {
        let (at, size) = (usize::try_from(num(e.get("SerialOffset"))?).ok()?, usize::try_from(num(e.get("SerialSize"))?).ok()?);
        (at + size <= len).then_some(at..at + size)
    };
    let mut out = game_bytes.to_vec();
    let mut edits = 0;
    let mut written = Vec::new();
    for (i, ge) in gex.iter().enumerate() {
        let Some(&mi) = mine.get(gp[i].as_str()) else { continue }; // new in the game's build
        let me = &mex[mi];
        let (Some(mr), Some(gr)) = (range(me, mod_bytes.len()), range(ge, game_bytes.len())) else {
            return Err(shape(format!("{} has no place in the file", gp[i])));
        };
        let (mod_raw, game_raw) = (&mod_bytes[mr], &game_bytes[gr.clone()]);
        if is_raw(me) || is_raw(ge) {
            // UAssetTool decodes neither build's GPU scripts: whether the mod or the game changed one cannot be told, so
            // a file where one differs is not carried
            if mod_raw != game_raw {
                return Err(if is_raw(me) && is_raw(ge) {
                    Reject { shape: false, why: format!("{} differs in a part UAssetTool could not decode", gp[i]) }
                } else {
                    shape(format!("{} could not be read", gp[i]))
                });
            }
            continue;
        }
        let (mx, gx) = (me.get("Extras").and_then(Value::as_str).unwrap_or(""), ge.get("Extras").and_then(Value::as_str).unwrap_or(""));
        if mx != gx {
            let n = b64_len(gx);
            if !pixels || b64_len(mx) != n || n > mod_raw.len() || n > game_raw.len() {
                return Err(Reject { shape: false, why: format!("{} has data UAssetTool does not read", gp[i]) });
            }
            out[gr.end - n..gr.end].copy_from_slice(&mod_raw[mod_raw.len() - n..]);
            edits += 1;
        }
        let mut c = Ctx { mod_raw, game_raw, game_at: gr.start, out: &mut out, edits: 0, written: &mut written };
        walk(me.get("Data").unwrap_or(&Value::Null), ge.get("Data").unwrap_or(&Value::Null), &gp[i], &mut c)?;
        edits += c.edits;
    }
    Ok((out, edits))
}

/// Whether two decodings of a package differ in structure anywhere, every export checked (a carry stops at its first
/// problem, so it cannot tell): a part only one side decodes, another type, a property only the mod has, a list of
/// another length. Values are not compared.
fn shape_differs(mod_json: &Value, game_json: &Value, mod_bytes: &[u8], game_bytes: &[u8]) -> bool {
    fn shape(m: &Value, g: &Value) -> bool {
        if primitive_bytes(g).is_some() {
            return primitive_bytes(m).is_none() || !same_property(m, g);
        }
        match (m, g) {
            (Value::Object(mo), Value::Object(go)) => {
                mo.get("$type") != go.get("$type")
                    || mo.keys().any(|k| k != "OriginalUnversionedHeader" && !go.contains_key(k))
                    || go.iter().any(|(k, gv)| k != "OriginalUnversionedHeader" && mo.get(k).is_some_and(|mv| shape(mv, gv)))
            }
            (Value::Array(ma), Value::Array(ga)) => ma.len() != ga.len() || ma.iter().zip(ga).any(|(a, b)| shape(a, b)),
            (Value::Object(_), _) | (_, Value::Object(_)) | (Value::Array(_), _) | (_, Value::Array(_)) => true,
            _ => false,
        }
    }
    let (mp, gp) = (export_paths(mod_json), export_paths(game_json));
    let (Some(mex), Some(gex)) = (mod_json.get("Exports").and_then(Value::as_array), game_json.get("Exports").and_then(Value::as_array)) else { return true };
    if mp.iter().any(|p| !gp.contains(p)) {
        return true;
    }
    let mine: HashMap<&str, usize> = mp.iter().enumerate().map(|(i, p)| (p.as_str(), i)).collect();
    let bytes = |e: &Value, all: &[u8]| -> Option<Vec<u8>> {
        let (at, size) = (usize::try_from(num(e.get("SerialOffset"))?).ok()?, usize::try_from(num(e.get("SerialSize"))?).ok()?);
        all.get(at..at + size).map(<[u8]>::to_vec)
    };
    gex.iter().enumerate().any(|(i, ge)| {
        let Some(me) = mine.get(gp[i].as_str()).map(|&j| &mex[j]) else { return false }; // new in the game's build
        match (is_raw(me), is_raw(ge)) {
            (false, false) => shape(me.get("Data").unwrap_or(&Value::Null), ge.get("Data").unwrap_or(&Value::Null)),
            (true, true) => false, // neither side decodes it: no sign of a layout either way
            _ => bytes(me, mod_bytes) != bytes(ge, game_bytes), // only one side decodes it: the other is in another layout
        }
    })
}

// ---- the files around it ----

pub(crate) fn read_json(p: &Path) -> Result<Value, String> {
    // bytes, not a String: serde checks the UTF-8 as it parses, so the text is walked once
    let b = std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
    serde_json::from_slice(b.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&b)).map_err(|e| format!("{}: {e}", p.display()))
}

/// A legacy package as one stream: .uasset then .uexp (export offsets count from the .uasset's start).
fn read_package(uasset: &Path) -> Result<(Vec<u8>, usize), String> {
    let head = std::fs::read(uasset).map_err(|e| format!("{}: {e}", uasset.display()))?;
    let body = std::fs::read(uasset.with_extension("uexp")).map_err(|e| format!("{}: {e}", uasset.display()))?;
    let n = head.len();
    Ok(([head, body].concat(), n))
}

fn is_atlas(rel: &str) -> bool {
    rel.rsplit('/').next().is_some_and(|n| n.to_ascii_lowercase().starts_with("curveatlas_"))
}

fn rel_no_ext(rel: &str) -> String {
    rel.replace('\\', "/").trim_start_matches('/').trim_end_matches(".uasset").to_string()
}

/// Copies these packages (with their .uexp and .ubulk) from `from` to `to`, and lists them for the JSON step. `fresh`
/// empties `to` first (a run's own folder). The game's cache is added to, never emptied.
pub(crate) fn stage(from: &Path, to: &Path, rels: &[String], fresh: bool) -> Result<(), String> {
    if fresh {
        let _ = std::fs::remove_dir_all(to);
    }
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for r in rels {
        for x in ["uasset", "uexp", "ubulk"] {
            let src = from.join(format!("{r}.{x}"));
            if src.exists() {
                let dst = to.join(format!("{r}.{x}"));
                std::fs::create_dir_all(dst.parent().unwrap_or(to)).map_err(|e| e.to_string())?;
                std::fs::copy(&src, &dst).map_err(|e| format!("{}: {e}", src.display()))?;
            }
        }
    }
    std::fs::write(to.join("uasset_list.txt"), rels.join("\n")).map_err(|e| e.to_string())
}

pub(crate) async fn to_json(usmap: &str, input: &Path, output: &Path, progress: &dyn VfxProgressSink) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(output);
    crate::vfx_updater::pipeline::step_convert_mod_to_json(&PathBuf::new(), usmap, &input.to_string_lossy(), &output.to_string_lossy(), progress).await.map(|_| ())
}

/// The build in a depot USMAP's file name (`5.3.2-3962284+++depot_marvel+...usmap`).
pub(crate) fn usmap_build(path: &str) -> Option<u64> {
    crate::vfx_updater::commands::extract_usmap_build_number(&Path::new(path).file_name()?.to_string_lossy())
}

/// Whether the VFX Updater's USMAP is for the installed game's build (or newer): only then are the game's Niagara files
/// read right. Unknown game builds count as matching (the shape check still rejects a wrong read).
pub(crate) fn usmap_matches(usmap: &str, paks: &Path) -> bool {
    match (usmap_build(usmap), crate::xtra_vfx::game_cl(paks)) {
        (Some(u), Some(g)) => u >= g,
        (None, _) => false,
        (Some(_), None) => true,
    }
}

/// The USMAP's build and the game's, when both are known and the USMAP is the older one. A patch can insert properties
/// into classes (NiagaraSystem in 3962284), and an older USMAP then reads every later property under the wrong name
/// without any error, so whatever decodes a file such a patch rewrote waits for the new one (xtra_broken.rs
/// changed_since_usmap).
pub(crate) fn usmap_behind(usmap: &str, paks: &Path) -> Option<(u64, u64)> {
    let (u, g) = (usmap_build(usmap)?, crate::xtra_vfx::game_cl(paks)?);
    (u < g).then_some((u, g))
}

/// usmapWatch.ts: whether the saved USMAP is still older than the installed game, and whether this call saved a newer one.
#[derive(Serialize)]
pub struct UsmapWaiting {
    waiting: bool,
    fetched: bool,
}

/// Fetches a newer USMAP when there is one (an ETag check, so cheap) and says whether the saved one is still older than
/// the installed game. Once it is not, built-ins that waited for it may build again (usmapWatch.ts).
#[tauri::command]
pub async fn xtra_usmap_waiting(state: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::AppState>>>) -> Result<UsmapWaiting, String> {
    let mods = state.lock().unwrap_or_else(|e| e.into_inner()).game_path.clone();
    let Some(paks) = mods.ancestors().find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Paks"))).map(Path::to_path_buf) else {
        return Ok(UsmapWaiting { waiting: false, fetched: false });
    };
    let fetched = crate::vfx_updater::commands::vfx_check_usmap_update(false).await.is_ok_and(|r| r.updated);
    Ok(UsmapWaiting { waiting: !crate::xtra_builtins::usmap_arrived(&paks), fetched })
}

/// The saved USMAP matches the game: mods made partial for want of one can now update fully (xtra_broken).
pub(crate) fn saved_usmap_matches(paks: &Path) -> bool {
    crate::vfx_updater::commands::saved_usmap_path().is_some_and(|u| Path::new(&u).is_file() && usmap_matches(&u, paks))
}

use crate::vfx_updater::commands::USMAP_REPO_API as DEPOT;

fn http(secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(secs)).user_agent("RepakX-VFX-Updater").build().map_err(|e| e.to_string())
}

/// Every depot USMAP: (build, file name, download URL).
async fn depot_usmaps() -> Result<Vec<(u64, String, String)>, String> {
    let json: Value = http(20)?.get(DEPOT).header("Accept", "application/vnd.github+json").send().await.map_err(|e| e.to_string())?
        .error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    Ok(json.as_array().into_iter().flatten().filter_map(|e| {
        let name = e.get("name")?.as_str()?;
        let url = e.get("download_url")?.as_str()?;
        Some((usmap_build(name).filter(|_| name.ends_with(".usmap"))?, name.to_string(), url.to_string()))
    }).collect())
}

async fn download_usmap(url: &str, to: &Path) -> Result<(), String> {
    let bytes = http(60)?.get(url).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?.bytes().await.map_err(|e| e.to_string())?;
    std::fs::create_dir_all(to.parent().unwrap_or(to)).map_err(|e| e.to_string())?;
    let tmp = to.with_extension("usmap.part");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, to).map_err(|e| e.to_string())
}

/// Older depot USMAPs than `build`, newest first, downloaded into the managed folder when missing. Without a connection,
/// the ones already there.
pub(crate) async fn older_usmaps(build: u64) -> Vec<String> {
    let dir = crate::vfx_updater::commands::managed_usmap_dir();
    let mut have: Vec<(u64, PathBuf)> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter_map(|p| Some((usmap_build(&p.to_string_lossy()).filter(|b| *b < build)?, p)))
        .collect();
    if let Ok(listing) = depot_usmaps().await {
        let mut older: Vec<_> = listing.into_iter().filter(|(b, ..)| *b < build).collect();
        older.sort_by(|a, b| b.0.cmp(&a.0));
        for (b, name, url) in older.into_iter().take(3) {
            let to = dir.join(&name);
            if !have.iter().any(|(_, p)| *p == to) && download_usmap(&url, &to).await.is_ok() {
                have.push((b, to));
            }
        }
    }
    have.sort_by(|a, b| b.0.cmp(&a.0));
    have.dedup_by(|a, b| a.0 == b.0);
    have.into_iter().take(3).map(|(_, p)| p.to_string_lossy().to_string()).collect()
}

/// An extract filter for a package (a path without extension): its folder and name. The tool matches filters as part of
/// the path it writes, so a full path misses plugin content, which it writes under Marvel/Plugins/<name>/Content
/// (2026-10-26: "/Marvel/Plugins/MarvelGAS/Content/.../NS_102698_Light_01" extracted nothing, "102698/NS_102698_Light_01"
/// extracted it).
pub(crate) fn tail_filter(rel: &str) -> String {
    let mut parts = rel.rsplit('/').take(2).collect::<Vec<_>>();
    parts.reverse();
    parts.join("/")
}

/// The game's copies of `rels`, extracted and decoded with `usmap` into the cache under `vanilla` (kept for the next
/// mod): (packages, JSON) folders. xtra_layout.rs reads the game's Blueprints through it too.
pub(crate) async fn game_copies(game_paks: &str, usmap: &str, rels: &[String], work: &Path, vanilla: &Path, progress: &dyn VfxProgressSink) -> Result<(PathBuf, PathBuf), String> {
    let (gx, gj) = (vanilla.join("niagara_extract"), vanilla.join("niagara_json"));
    // cached only when both the JSON and the package are there
    let missing: Vec<String> = rels.iter().filter(|r| !gj.join(format!("{r}.json")).exists() || !gx.join(format!("{r}.uasset")).exists()).cloned().collect();
    if !missing.is_empty() {
        let fresh = work.join("game_extract");
        let _ = std::fs::remove_dir_all(&fresh);
        // without dependencies: the decode below runs on a folder holding only these, so the dependency packages a
        // usual extract adds were written and never read (the same JSON, a fraction of the extract)
        let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
            action: "extract_iostore_legacy",
            game_paks: Some(game_paks.to_string()),
            output_path: Some(fresh.to_string_lossy().to_string()),
            filter_patterns: Some(missing.iter().map(|r| tail_filter(r)).collect()),
            with_deps: Some(false),
            ..Default::default()
        };
        let r = crate::vfx_updater::uasset_tool::run_vfx_uat_request(&PathBuf::new(), &req).await?;
        if !r.success {
            return Err(format!("The game's files could not be read: {}", r.message));
        }
        // only these, not the dependencies the extract adds: a run folder for the JSON step, then into the cache
        let only = work.join("game_only");
        stage(&fresh, &only, &missing, true)?;
        stage(&fresh, &gx, &missing, false)?;
        let tmp = work.join("game_json");
        to_json(usmap, &only, &tmp, progress).await?;
        for r in &missing {
            let (from, to) = (tmp.join(format!("{r}.json")), gj.join(format!("{r}.json")));
            if from.exists() {
                std::fs::create_dir_all(to.parent().unwrap_or(&gj)).map_err(|e| e.to_string())?;
                std::fs::rename(&from, &to).or_else(|_| std::fs::copy(&from, &to).map(|_| ())).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok((gx, gj))
}

// ---- Niagara files in an older layout than their date says ----
// A mod written after a game update can still carry Niagara files in the old layout: an update made by repakxtra
// 0.17.0 with the old USMAP, or an old mod installed again. Its date says current, so the date check misses it and the
// game crashes on it (FlamingBPVFX, 2026-10-23). One of its Niagara systems is decoded with today's USMAP: a part the
// game's own copy decodes that the mod's does not (or another shape) means the old layout. Each answer is kept per mod
// file and USMAP, so a mod is decoded once.

fn layout_store() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X").join("repakxtra-vfx-layout.json")
}

/// The cache key of a mod file under a USMAP: its path, size and time written.
fn layout_key(mod_path: &Path, usmap: &str) -> Option<String> {
    let m = std::fs::metadata(mod_path).ok()?;
    let at = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    let u = Path::new(usmap).file_name()?.to_string_lossy().to_string();
    Some(format!("{}|{}|{at}|{u}", mod_path.to_string_lossy().to_lowercase().replace('\\', "/"), m.len()))
}

fn load_layouts() -> HashMap<String, bool> {
    std::fs::read_to_string(layout_store()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_layouts(cache: &HashMap<String, bool>) {
    let _ = std::fs::write(layout_store(), serde_json::to_string(cache).unwrap_or_default());
}

/// Whether a mod (its .pak, .bak_repak or .utoc) was found to carry Niagara files in an older layout, under the saved
/// USMAP (xtra_broken).
pub(crate) fn known_old_layout(mod_path: &Path) -> bool {
    let Some(usmap) = crate::vfx_updater::commands::saved_usmap_path() else { return false };
    layout_key(&mod_path.with_extension("utoc"), &usmap).is_some_and(|k| load_layouts().get(&k) == Some(&true))
}

/// Whether any of `rels` (up to three of the mod's Niagara systems, package paths without extension) is in an older
/// layout than the game's. One that cannot be read makes the answer unknown (an error), never "current". `extracted`:
/// the run's own extract of the mod, else each probe is extracted from the mod's container.
async fn old_layout_of(game_paks: &str, usmap: &str, mod_utoc: &Path, rels: &[String], extracted: Option<&Path>, work: &Path, vanilla: &Path) -> Result<bool, String> {
    let progress = &crate::vfx_updater::progress::NoOpProgressSink;
    let t = std::time::Instant::now();
    let rels: Vec<String> = rels.iter().take(3).cloned().collect();
    let (gx, gj) = game_copies(game_paks, usmap, &rels, work, vanilla, progress).await?;
    let x = match extracted {
        Some(dir) if rels.iter().all(|r| dir.join(format!("{r}.uasset")).exists()) => dir.to_path_buf(),
        _ => {
            // with no container to read, the extract hands back the game's own copies, which always look current
            if !mod_utoc.is_file() {
                return Err(format!("{} is not there", mod_utoc.display()));
            }
            let x = work.join("layout_extract");
            let _ = std::fs::remove_dir_all(&x);
            let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
                action: "extract_iostore_legacy",
                game_paks: Some(game_paks.to_string()),
                mod_path: Some(mod_utoc.to_string_lossy().to_string()),
                output_path: Some(x.to_string_lossy().to_string()),
                filter_patterns: Some(rels.iter().map(|r| r.rsplit('/').next().unwrap_or(r).to_string()).collect()),
                with_deps: Some(false),
                ..Default::default()
            };
            let r = crate::vfx_updater::uasset_tool::run_vfx_uat_request(&PathBuf::new(), &req).await?;
            if !r.success {
                return Err(format!("the mod's copy could not be read: {}", r.message));
            }
            x
        }
    };
    // each probe alone in its own folder (its own Content tree): it decodes seeing only itself, as before
    let (only, json) = (work.join("layout_only"), work.join("layout_json"));
    let _ = std::fs::remove_dir_all(&only);
    let mut listed = Vec::new();
    for (i, r) in rels.iter().enumerate() {
        if x.join(format!("{r}.uasset")).exists() {
            stage(&x, &only.join(i.to_string()), std::slice::from_ref(r), true)?;
            listed.push(format!("{i}/{r}"));
        }
    }
    std::fs::write(only.join("uasset_list.txt"), listed.join("\n")).map_err(|e| e.to_string())?;
    to_json(usmap, &only, &json, progress).await?;
    let mut unknown = None;
    for (i, r) in rels.iter().enumerate() {
        let verdict = (|| -> Result<bool, String> {
            if !gj.join(format!("{r}.json")).exists() {
                return Err("the game's copy could not be read".into());
            }
            let m = read_json(&json.join(i.to_string()).join(format!("{r}.json"))).map_err(|_| "the mod's copy could not be read".to_string())?;
            let g = read_json(&gj.join(format!("{r}.json")))?;
            let (mb, _) = read_package(&x.join(format!("{r}.uasset")))?;
            let (gb, _) = read_package(&gx.join(format!("{r}.uasset")))?;
            Ok(shape_differs(&m, &g, &mb, &gb))
        })();
        match verdict {
            Ok(true) => {
                eprintln!("[niagara timing] old-layout check {:.1}s (old)", t.elapsed().as_secs_f64());
                return Ok(true);
            }
            Ok(false) => {}
            Err(e) => unknown = Some(e),
        }
    }
    eprintln!("[niagara timing] old-layout check {:.1}s", t.elapsed().as_secs_f64());
    unknown.map_or(Ok(false), Err)
}

/// A mod file's path as a package path without extension, from "Marvel/Content/" on.
pub(crate) fn package_rel(file: &str) -> String {
    let f = file.replace('\\', "/");
    let f = f.find("Marvel/Content/").map_or(f.as_str(), |i| &f[i..]).to_string();
    rel_no_ext(&f)
}

/// The Niagara systems (NS_) among a mod's files that the game also has.
fn probe_files(paks: &Path, files: &[String]) -> Vec<String> {
    let ns: Vec<String> = files
        .iter()
        .filter(|f| {
            let n = f.replace('\\', "/").rsplit('/').next().unwrap_or_default().to_ascii_lowercase();
            n.starts_with("ns_") && n.ends_with(".uasset")
        })
        .cloned()
        .collect();
    crate::xtra_broken::rewritten_since(paks, &ns, 0).unwrap_or_default()
}

static SCANNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Checks the VFX mods among `mod_paths` not checked yet (under the saved USMAP, when it matches the game) and returns
/// how many were found in an older layout. Skipped while the VFX Updater runs or another scan does.
#[tauri::command]
pub async fn xtra_vfx_layout_scan(mod_paths: Vec<String>, state: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::AppState>>>) -> Result<usize, String> {
    let Ok(_one) = SCANNING.try_lock() else { return Ok(0) };
    if crate::xtra_vfx::xtra_vfx_lock().is_some() {
        return Ok(0);
    }
    let state = state.inner().clone();
    let mods_dir = state.lock().unwrap().game_path.clone();
    let Some(paks) = mods_dir.ancestors().find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Paks"))).map(Path::to_path_buf) else { return Ok(0) };
    let Some(usmap) = crate::vfx_updater::commands::saved_usmap_path().filter(|u| Path::new(u).is_file() && usmap_matches(u, &paks)) else { return Ok(0) };
    let game_paks = paks.to_string_lossy().to_string();
    let vanilla = crate::xtra_vfx::vanilla_dir(&game_paks, &usmap);
    let work = std::env::temp_dir().join("repak-x").join("xlayout");
    let mut cache = load_layouts();
    let mut found = 0;
    for p in mod_paths {
        let path = PathBuf::from(&p);
        let utoc = path.with_extension("utoc");
        let Some(key) = layout_key(&utoc, &usmap) else { continue };
        if cache.contains_key(&key) {
            continue;
        }
        let st = state.clone();
        let details = tauri::async_runtime::spawn_blocking(move || crate::compute_mod_details(&path, &st).ok()).await.ok().flatten();
        let Some(d) = details.filter(|d| d.category == "VFX") else { continue };
        let probes: Vec<String> = probe_files(&paks, &d.files).iter().map(|f| package_rel(f)).collect();
        if probes.is_empty() {
            cache.insert(key, false);
            continue;
        }
        match old_layout_of(&game_paks, &usmap, &utoc, &probes, None, &work, &vanilla).await {
            Ok(old) => {
                found += usize::from(old);
                cache.insert(key, old);
            }
            Err(e) => log::warn!("[vfx layout] {}: {e}", utoc.display()),
        }
        save_layouts(&cache);
        if crate::xtra_vfx::xtra_vfx_lock().is_some() {
            break; // an update started: it uses the same tool, the rest waits for the next scan
        }
    }
    let _ = std::fs::remove_dir_all(&work);
    Ok(found)
}

/// For a run: the mod's Niagara files (paths inside the mod, as `files` gives them) to rebuild although its date says
/// current, because they are in an older layout (pipeline.ts). Cached like the scan.
#[tauri::command]
pub async fn xtra_vfx_old_layout(mod_path: String, game_paks: String, usmap_path: String, files: Vec<String>, mod_extract: Option<String>) -> Result<Vec<String>, String> {
    // the background scan writes the same game cache (game_copies): its probe in flight finishes first, then it stops
    // (it sees the run's lock) and waits for the next scan
    let _scan = SCANNING.lock().await;
    let utoc = PathBuf::from(&mod_path);
    if !usmap_matches(&usmap_path, Path::new(&game_paks)) {
        return Ok(Vec::new());
    }
    // the game set in Setup, never one guessed from the mod's folder: a mod chosen from Downloads is checked too
    let paks = Path::new(&game_paks);
    let have = crate::xtra_broken::rewritten_since(paks, &files, 0).unwrap_or_default();
    let probes: Vec<String> = probe_files(paks, &have).iter().map(|f| package_rel(f)).collect();
    if probes.is_empty() {
        return Ok(Vec::new());
    }
    let key = layout_key(&utoc, &usmap_path);
    let mut cache = load_layouts();
    let old = match key.as_ref().and_then(|k| cache.get(k)) {
        Some(v) => *v,
        None => {
            let work = std::env::temp_dir().join("repak-x").join("xlayout-run");
            let vanilla = crate::xtra_vfx::vanilla_dir(&game_paks, &usmap_path);
            let v = old_layout_of(&game_paks, &usmap_path, &utoc, &probes, mod_extract.as_deref().map(Path::new), &work, &vanilla).await;
            let _ = std::fs::remove_dir_all(&work);
            match v {
                Ok(v) => {
                    if let Some(k) = key {
                        cache.insert(k, v);
                        save_layouts(&cache);
                    }
                    v
                }
                // could not tell: rebuilt to be safe (the Niagara step leaves out what it cannot carry), not cached
                Err(e) => {
                    log::warn!("[vfx layout] {}: {e}", utoc.display());
                    true
                }
            }
        }
    };
    Ok(if old { have } else { Vec::new() })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NiagaraFile {
    /// Its path inside the mod, as given
    file: String,
    /// Value tables carried (0 when it was not carried)
    edits: usize,
    /// Why it stays left out
    error: Option<String>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NiagaraRun {
    /// False when the USMAP is older than the game: the game's new Niagara files cannot be read yet
    ready: bool,
    why: Option<String>,
    /// The build whose USMAP read the mod's files
    old_build: Option<u64>,
    files: Vec<NiagaraFile>,
}

/// Carries the mod's edits of `files` (Niagara packages inside `mod_extract`, cooked for an older game build) onto the
/// game's new copies, and writes each carried one into `out`. `vanilla` caches the game's copies per build and USMAP.
pub(crate) async fn run(game_paks: &str, usmap: &str, mod_extract: &Path, files: &[String], out: &Path, work: &Path, vanilla: &Path, progress: &dyn VfxProgressSink) -> Result<NiagaraRun, String> {
    let Some(build) = usmap_build(usmap) else {
        return Ok(NiagaraRun { why: Some("The USMAP's game build is not in its name".into()), ..Default::default() });
    };
    // a USMAP behind the game still reads the files no newer patch rewrote (xtra_broken.rs changed_since_usmap)
    let changed = crate::xtra_broken::changed_since_usmap(Path::new(game_paks), usmap, files).map_or(files.len().max(1), |c| c.len());
    if changed > 0 {
        let game = crate::xtra_vfx::game_cl(Path::new(game_paks)).unwrap_or(0);
        return Ok(NiagaraRun { why: Some(format!("The USMAP is for build {build} and the game is on {game}, whose update changed {changed} of these Niagara files")), ..Default::default() });
    }
    let rels: Vec<String> = files.iter().map(|f| rel_no_ext(f)).collect();
    let emit = |n: usize, msg: String| progress.emit(VfxPipelineProgress { stage: "Rebuilding Niagara effects".into(), step: 7, current: n, total: rels.len(), message: msg });

    let t = std::time::Instant::now();
    let lap = |what: &str, since: &mut std::time::Instant| { eprintln!("[niagara timing] {what} {:.1}s", since.elapsed().as_secs_f64()); *since = std::time::Instant::now(); };
    let mut since = std::time::Instant::now();
    // the game's copies, read with today's USMAP (kept for the next mod)
    emit(0, "Reading the game's Niagara files".into());
    let (gx, gj) = game_copies(game_paks, usmap, &rels, work, vanilla, progress).await?;
    lap("game copies", &mut since);
    let have: Vec<&String> = rels.iter().filter(|r| gj.join(format!("{r}.json")).exists() && gx.join(format!("{r}.uasset")).exists()).collect();

    // the mod's copies, read with an older USMAP: the first, newest first, under which one of them decodes in the
    // game's shape. A wrong one reads garbage, which never matches
    let candidates = older_usmaps(build).await;
    lap("older USMAPs", &mut since);
    let probe = have.first().copied();
    let mut chosen = None;
    if let Some(p) = probe {
        let (input, json) = (work.join("probe"), work.join("probe_json"));
        stage(mod_extract, &input, std::slice::from_ref(p), true)?;
        let game = read_json(&gj.join(format!("{p}.json")))?;
        let (gb, _) = read_package(&gx.join(format!("{p}.uasset")))?;
        let (mb, _) = read_package(&mod_extract.join(format!("{p}.uasset")))?;
        for (n, u) in candidates.iter().enumerate() {
            emit(0, format!("Finding the build the mod was made for ({} of {})", n + 1, candidates.len()));
            if to_json(u, &input, &json, progress).await.is_err() {
                continue;
            }
            let Ok(m) = read_json(&json.join(format!("{p}.json"))) else { continue };
            match carry(&m, &game, &mb, &gb, is_atlas(p)) {
                Err(r) if r.shape => continue,
                _ => {
                    chosen = Some(u.clone());
                    break;
                }
            }
        }
    }
    let Some(old) = chosen else {
        let why = if candidates.is_empty() { "No USMAP for an older game build could be downloaded" } else { "No older USMAP reads the mod's Niagara files" };
        return Ok(NiagaraRun { ready: true, why: Some(why.into()), files: files.iter().map(|f| NiagaraFile { file: f.clone(), edits: 0, error: Some(why.into()) }).collect(), ..Default::default() });
    };
    lap("finding the old build", &mut since);
    emit(0, format!("Reading the mod's {} Niagara files", rels.len()));
    let (input, json) = (work.join("mod"), work.join("mod_json"));
    stage(mod_extract, &input, &rels, true)?;
    to_json(&old, &input, &json, progress).await?;
    lap("mod decode", &mut since);

    emit(0, format!("Rebuilding {} Niagara files", rels.len()));
    let have: std::collections::HashSet<String> = have.into_iter().cloned().collect();
    let jobs: Vec<(String, String)> = files.iter().cloned().zip(rels.iter().cloned()).collect();
    let (mod_extract, out, json, gx, gj) = (mod_extract.to_path_buf(), out.to_path_buf(), json.clone(), gx.clone(), gj.clone());
    // each file reads its own JSON and packages and writes only its own package: independent, so they run in parallel,
    // and the results come back in the files' order
    let done: Vec<NiagaraFile> = tauri::async_runtime::spawn_blocking(move || {
        use rayon::prelude::*;
        jobs.par_iter()
            .map(|(f, r)| {
                let res = (|| -> Result<usize, String> {
                    if !have.contains(r) {
                        return Err("The game's copy could not be read".into());
                    }
                    let m = read_json(&json.join(format!("{r}.json"))).map_err(|_| "The mod's copy could not be read".to_string())?;
                    let g = read_json(&gj.join(format!("{r}.json")))?;
                    let (mb, _) = read_package(&mod_extract.join(format!("{r}.uasset")))?;
                    let (gb, head) = read_package(&gx.join(format!("{r}.uasset")))?;
                    let (bytes, edits) = carry(&m, &g, &mb, &gb, is_atlas(r)).map_err(|e| e.why)?;
                    let to = out.join(r);
                    std::fs::create_dir_all(to.parent().unwrap_or(&out)).map_err(|e| e.to_string())?;
                    let bulk = gx.join(format!("{r}.ubulk"));
                    let written = std::fs::write(to.with_extension("uasset"), &bytes[..head])
                        .and_then(|_| std::fs::write(to.with_extension("uexp"), &bytes[head..]))
                        .and_then(|_| if bulk.exists() { std::fs::copy(&bulk, to.with_extension("ubulk")).map(|_| ()) } else { Ok(()) });
                    if let Err(e) = written {
                        // a package with only some of its files would be packed: none of it stays
                        ["uasset", "uexp", "ubulk"].iter().for_each(|x| { let _ = std::fs::remove_file(to.with_extension(x)); });
                        return Err(format!("Could not be written ({e})"));
                    }
                    Ok(edits)
                })();
                match res {
                    Ok(edits) => NiagaraFile { file: f.clone(), edits, error: None },
                    Err(e) => NiagaraFile { file: f.clone(), edits: 0, error: Some(e) },
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?;
    emit(rels.len(), format!("Rebuilt {} of {}", rels.len(), rels.len()));
    lap("carry", &mut since);
    eprintln!("[niagara timing] step 7 total {:.1}s", t.elapsed().as_secs_f64());
    Ok(NiagaraRun { ready: true, why: None, old_build: usmap_build(&old), files: done })
}

#[tauri::command]
pub async fn xtra_vfx_niagara(window: Window, game_paks: String, usmap_path: String, mod_extract: String, files: Vec<String>, final_uassets: String, stage_dir: String, vanilla_extract: String) -> Result<NiagaraRun, String> {
    let vanilla = Path::new(&vanilla_extract).parent().map(Path::to_path_buf).ok_or("No cache folder")?;
    let work = Path::new(&stage_dir).join("niagara");
    let _scan = SCANNING.lock().await; // as xtra_vfx_old_layout: never beside the background scan on the game cache
    run(&game_paks, &usmap_path, Path::new(&mod_extract), &files, Path::new(&final_uassets), &work, &vanilla, &TauriVfxProgressSink::new(&window)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_older_usmap_makes_updates_wait() {
        let paks = tempfile::tempdir().unwrap();
        for f in ["pakchunk0-Windows.utoc", "Patch_-Windows_1.1.3962284_P.utoc", "Patch_-Windows_1.1.3984769_P.utoc"] {
            std::fs::write(paks.path().join(f), b"").unwrap();
        }
        let usmap = |cl: u64| format!("C:/x/5.3.2-{cl}+++depot_marvel+S10.5_release-Marvel.usmap");
        assert_eq!(usmap_behind(&usmap(3962284), paks.path()), Some((3962284, 3984769)), "the patch from today is ahead");
        assert_eq!(usmap_behind(&usmap(3984769), paks.path()), None, "the same build");
        assert_eq!(usmap_behind(&usmap(3990000), paks.path()), None, "a newer USMAP");
        assert_eq!(usmap_behind("C:/x/custom.usmap", paks.path()), None, "a chosen file without a build is not judged");
    }

    fn floats(name: &str, v: &[f32]) -> Value {
        json!({ "$type": "UAssetAPI.PropertyTypes.Objects.ArrayPropertyData, UAssetAPI", "ArrayType": "FloatProperty", "Name": name,
            "Value": v.iter().map(|x| json!({ "$type": "UAssetAPI.PropertyTypes.Objects.FloatPropertyData, UAssetAPI", "Value": x })).collect::<Vec<_>>() })
    }
    fn export(at: usize, size: usize, data: Vec<Value>) -> Value {
        json!({ "$type": "UAssetAPI.ExportTypes.NormalExport, UAssetAPI", "ObjectName": "Curve", "OuterIndex": 0, "SerialOffset": at, "SerialSize": size, "Data": data, "Extras": "" })
    }
    fn bytes(v: &[f32]) -> Vec<u8> {
        v.iter().flat_map(|f| f.to_le_bytes()).collect()
    }

    #[test]
    fn a_changed_value_table_moves_into_the_game_file_and_nothing_else_does() {
        let (old, new) = ([0.1f32, 0.2, 0.3], [0.9f32, 0.8, 0.7]);
        // the mod: header 4 bytes, then the table. The game's build moved the table 2 bytes on (a renumbered header)
        let mod_bytes = [vec![1, 2, 3, 4], bytes(&new)].concat();
        let game_bytes = [vec![9, 9, 9, 9, 7, 7], bytes(&old), vec![5]].concat();
        let m = json!({ "Exports": [export(4, 12, vec![floats("ShaderLUT", &new)])] });
        let g = json!({ "Exports": [export(4, 15, vec![floats("ShaderLUT", &old)])] });
        let (out, edits) = carry(&m, &g, &mod_bytes, &game_bytes, false).unwrap();
        assert_eq!(edits, 1);
        assert_eq!(out, [vec![9, 9, 9, 9, 7, 7], bytes(&new), vec![5]].concat(), "the game's bytes, with only the mod's table in them");
        assert_eq!(carry(&g, &g, &game_bytes, &game_bytes, false).unwrap(), (game_bytes.clone(), 0), "nothing changed, nothing carried");
    }

    #[test]
    fn a_file_whose_changes_cannot_all_be_placed_is_not_carried() {
        let m = json!({ "Exports": [export(0, 4, vec![json!({ "$type": "F", "Name": "Scale", "Value": 2.0 })])] });
        let g = json!({ "Exports": [export(0, 4, vec![json!({ "$type": "F", "Name": "Scale", "Value": 1.0 })])] });
        let e = carry(&m, &g, &2f32.to_le_bytes(), &1f32.to_le_bytes(), false).unwrap_err();
        assert!(!e.shape, "a lone value is not a sign of the wrong USMAP");
        let other = json!({ "Exports": [export(0, 4, vec![json!({ "$type": "G", "Name": "Scale", "Value": 1.0 })])] });
        assert!(carry(&other, &g, &[0; 4], &[0; 4], false).unwrap_err().shape, "decoded in another shape: the wrong USMAP");
        // the same table twice in the game's export: which one is the mod's cannot be told
        let twice = [bytes(&[0.1]), bytes(&[0.1])].concat();
        let m = json!({ "Exports": [export(0, 4, vec![floats("A", &[0.5])])] });
        let g = json!({ "Exports": [export(0, 8, vec![floats("A", &[0.1])])] });
        assert!(carry(&m, &g, &bytes(&[0.5]), &twice, false).is_err());
        // a table in another property's place (the properties moved between builds) is never carried into it
        let m = json!({ "Exports": [export(0, 4, vec![floats("A", &[0.5])])] });
        let g = json!({ "Exports": [export(0, 4, vec![floats("B", &[0.1])])] });
        assert!(carry(&m, &g, &bytes(&[0.5]), &bytes(&[0.1]), false).unwrap_err().shape);
        // a GPU script neither build's can be decoded: a difference may be the mod's, so the file is not carried
        let raw = |at: usize| json!({ "Exports": [{ "$type": "UAssetAPI.ExportTypes.RawExport, UAssetAPI", "ObjectName": "GPUComputeScript", "OuterIndex": 0, "SerialOffset": at, "SerialSize": 4 }] });
        assert!(!carry(&raw(0), &raw(0), &[1, 2, 3, 4], &[1, 2, 3, 5], false).unwrap_err().shape);
        assert!(carry(&raw(0), &raw(0), &[1, 2, 3, 4], &[1, 2, 3, 4], false).is_ok(), "the same bytes: nothing to carry");
    }

    #[test]
    fn a_layout_difference_is_found_past_a_value_difference() {
        // export 1 differs only in a lone value (a carry stops there), export 2 decodes only on the game's side
        let g = json!({ "Exports": [
            { "$type": "UAssetAPI.ExportTypes.NormalExport, UAssetAPI", "ObjectName": "A", "OuterIndex": 0, "SerialOffset": 0, "SerialSize": 4, "Data": [{ "$type": "F", "Name": "S", "Value": 1.0 }] },
            { "$type": "UAssetAPI.ExportTypes.NormalExport, UAssetAPI", "ObjectName": "B", "OuterIndex": 0, "SerialOffset": 4, "SerialSize": 4, "Data": [] } ] });
        let mut m = g.clone();
        m["Exports"][0]["Data"][0]["Value"] = json!(2.0);
        assert!(!shape_differs(&m, &g, &[0; 8], &[0; 8]), "values alone are no layout change");
        m["Exports"][1]["$type"] = json!("UAssetAPI.ExportTypes.RawExport, UAssetAPI");
        assert!(carry(&m, &g, &[1; 8], &[0; 8], false).is_err());
        assert!(shape_differs(&m, &g, &[1; 8], &[0; 8]), "the second export, only the game's side decodes");
        assert!(!shape_differs(&g, &g, &[0; 8], &[0; 8]));
    }

    #[test]
    fn exports_are_matched_by_their_outer_path_not_their_name() {
        let j = json!({ "Exports": [
            { "ObjectName": "NS_A", "OuterIndex": 0 }, { "ObjectName": "Emitter1", "OuterIndex": 1 }, { "ObjectName": "Curve_0", "OuterIndex": 2 },
            { "ObjectName": "Emitter2", "OuterIndex": 1 }, { "ObjectName": "Curve_0", "OuterIndex": 4 } ] });
        assert_eq!(export_paths(&j), ["NS_A", "NS_A/Emitter1", "NS_A/Emitter1/Curve_0", "NS_A/Emitter2", "NS_A/Emitter2/Curve_0"]);
        assert_eq!(usmap_build("C:/u/5.3.2-3962284+++depot_marvel+S10.5_release-Marvel.usmap"), Some(3962284));
    }

    /// Real data: carries a mod's Niagara files onto the installed game's and compares with a reference port.
    ///   NIAGARA_SPIKE=<folder with mod_json, game_json, mod, game, ref> cargo test -p repak-x --bin REPAK-X niagara_real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn niagara_real() {
        let base = PathBuf::from(std::env::var("NIAGARA_SPIKE").expect("NIAGARA_SPIKE"));
        let mut walk = vec![base.join("game_json")];
        let (mut same, mut total, mut carried) = (0, 0, 0);
        while let Some(d) = walk.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk.push(p);
                    continue;
                }
                if p.extension().is_none_or(|x| x != "json") {
                    continue;
                }
                let rel = p.strip_prefix(base.join("game_json")).unwrap().with_extension("");
                let r = |root: &str, x: &str| base.join(root).join(&rel).with_extension(x);
                if !r("mod_json", "json").exists() || !r("ref", "uasset").exists() {
                    continue;
                }
                total += 1;
                let (mb, _) = read_package(&r("mod", "uasset")).unwrap();
                let (gb, head) = read_package(&r("game", "uasset")).unwrap();
                match carry(&read_json(&r("mod_json", "json")).unwrap(), &read_json(&p).unwrap(), &mb, &gb, is_atlas(&rel.to_string_lossy().replace('\\', "/"))) {
                    Ok((out, edits)) => {
                        carried += 1;
                        let reference = std::fs::read(r("ref", "uexp")).unwrap();
                        if out[head..] == reference[..] {
                            same += 1;
                        } else {
                            println!("differs: {} ({edits} tables)", rel.display());
                        }
                    }
                    Err(e) => println!("not carried: {} ({})", rel.display(), e.why),
                }
            }
        }
        println!("{carried} of {total} carried, {same} identical to the reference");
        assert!(total > 0 && same == carried);
    }
}
