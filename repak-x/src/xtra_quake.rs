//! repakxtra: CustomQuake, a built-in (xtra_builtins.rs) that flattens every map texture to one chosen color, the "Quake"
//! look. Everything comes from the installed game at build time, no mod's files or package lists ship with the app:
//! 1. list the game's Environment textures (the command line's list_iostore --type Texture2D),
//! 2. read each one's settings in batches (extract without its pixel data, the library's to_json), deleting each batch,
//! 3. classify each (classify: the game's compression, then the name) and give it a pixel (pixel, from the options),
//! 4. write a 1x1 package per texture from one of two templates (resources/quake/), put right the two fields UAssetTool
//!    writes differently from the cooker (fix_skip_offset, fix_names_referenced), check every package, then pack.
//! The game's settings (step 2) and the written packages (step 4) are kept for the game build: a rebuild for new options
//! reads nothing from the game and only puts the new pixel into each kept package (reuse_kept).
//! The rules were measured against quakeV6 on 2026-10-26 (ignored tests below, docs kept outside the repo): normal maps
//! 99.89%, channel-packed 99.91% and color 99.31% of its textures get the same pixel.

use std::collections::HashMap;
use std::path::Path;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest;

pub use crate::xtra_quake_options::Options;

impl Options {
    /// The options as a build uses them, or what is wrong with them.
    pub fn look(&self) -> Result<Look, String> {
        let base = parse_hex(&self.base).ok_or_else(|| format!("{} is not a color (6 hex digits, like 5d7a80)", self.base))?;
        let sky = parse_hex(&self.sky).ok_or_else(|| format!("{} is not a color (6 hex digits, like 82c6ed)", self.sky))?;
        Ok(Look { base, sky, hide_plants: self.hide_plants, lobby: self.lobby })
    }
}

/// What the game says about one of its Environment textures (read from the installed game at build time).
#[derive(Debug, Clone, Default)]
pub struct Vanilla {
    /// as the game lists it: Marvel/Content/Marvel/Environment/.../T_Name
    pub path: String,
    /// CompressionSettings, empty when the game leaves it at the default
    pub compression: String,
    pub lod_group: String,
    /// SRGB set off (data textures: masks, roughness): the GPU reads the pixel as it is, not as a color
    pub srgb_off: bool,
}

/// The settings a written package carries: the game's own for that texture, so the GPU reads the new pixel the way the
/// material expects (a normal map always as TC_Normalmap, WorldNormalMap, sRGB off, as the game's normal maps are).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Settings {
    pub compression: String,
    pub lod_group: String,
    pub srgb_off: bool,
}

impl Settings {
    fn normal() -> Self {
        Settings { compression: "TC_Normalmap".into(), lod_group: "TEXTUREGROUP_WorldNormalMap".into(), srgb_off: true }
    }
}

/// What a texture becomes. Mro carries its own pixel: each letter of a channel-packed name picks its channel's value.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Normal,
    Mro([u8; 4]),
    Color,
    Sky,
    Emissive,
    Plant,
    Decal,
    Skip,
}

/// The name's last word (T_Rock_MRO_02 -> "MRO"), as written.
fn suffix(name: &str) -> String {
    name.split('_')
        .rev()
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_alphabetic()))
        .map(|w| w.trim_end_matches(|c: char| c.is_ascii_digit()).to_string())
        .unwrap_or_default()
}

/// A channel-packed data texture: its pixel (RGBA), from the letters of its suffix. M(etal) and S(pecular) are 0, R(ough),
/// O and A (occlusion), E and H are full. A single letter fills every channel, two letters leave blue full.
fn packed(suffix: &str) -> Option<[u8; 4]> {
    let word = match suffix {
        "roughness" | "ao" | "occlusion" | "ambientocclusion" => "r",
        "metallic" | "metalness" | "specular" | "thickness" => "m",
        s => s,
    };
    if word.is_empty() || word.len() > 4 || !word.chars().all(|c| "mrosaeh".contains(c)) || word == "a" || word == "e" || word == "h" || word == "o" {
        return None;
    }
    let value = |c: char| if c == 'm' || c == 's' { 0x00 } else { 0xff };
    let v: Vec<u8> = word.chars().map(value).collect();
    Some(match v.as_slice() {
        [a] => [*a, *a, *a, 0xff],
        [a, b] => [*a, *b, 0xff, 0xff],
        [a, b, c] => [*a, *b, *c, 0xff],
        [a, b, c, _] => [*a, *b, *c, 0xff],
        _ => return None,
    })
}

/// Whether a word of the name (split at _ and at a lower-to-upper case step, as in StreetLamp) starts with one of `words`:
/// Street is not a tree, Seaweed is not a weed.
fn has_word(name: &str, words: &[&str]) -> bool {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut prev: Option<char> = None;
    for c in name.chars() {
        // a new word at _, at StreetLamp's L, and where digits meet letters (50070010Decal016)
        let step = prev.is_some_and(|p| (c.is_ascii_uppercase() && p.is_ascii_lowercase()) || (c.is_ascii_digit() != p.is_ascii_digit() && p != '_'));
        if c == '_' || step {
            tokens.push(std::mem::take(&mut cur));
        }
        if c != '_' {
            cur.push(c.to_ascii_lowercase());
        }
        prev = Some(c);
    }
    tokens.push(cur);
    tokens.iter().any(|t| words.iter().any(|w| t.starts_with(w)))
}

const PLANT: [&str; 24] = ["tree", "grass", "leaf", "leaves", "plant", "bush", "flower", "vine", "foliage", "weed", "shrub", "moss", "branch", "petal", "bamboo", "fern", "reed", "ivy", "palm", "sakura", "cherry", "sprout", "crop", "hedge"];
const DECAL: [&str; 3] = ["decal", "strokes", "graffiti"];
const LOBBY: [&str; 4] = ["/environment/lobby/", "/environment/multilobby/", "/environment/mvp/", "/environment/showitem/"];

/// What a game texture becomes. Pure: the game's own settings for it come in, the kind goes out.
pub fn classify(t: &Vanilla, lobby: bool) -> Kind {
    let path = t.path.replace('\\', "/").to_ascii_lowercase();
    if !lobby && LOBBY.iter().any(|f| path.contains(f)) {
        return Kind::Skip;
    }
    let cased = t.path.rsplit(['/', '\\']).next().unwrap_or(&t.path);
    // float data (HDR, color lookup tables): a color pixel in its place could break the screen's color grading
    if t.compression.to_ascii_uppercase().starts_with("TC_HDR") || t.compression.eq_ignore_ascii_case("TC_HalfFloat") {
        return Kind::Skip;
    }
    // the game's compression decides what a normal map is, never the name
    if t.compression.eq_ignore_ascii_case("TC_Normalmap") {
        return Kind::Normal;
    }
    // "PBR" tags a channel-packed texture (T_X_ORM_PBR): the word before it says the channels
    let trimmed = cased.trim_end_matches(|c: char| c.is_ascii_digit());
    let word = suffix(trimmed.strip_suffix("_PBR").or_else(|| trimmed.strip_suffix("_pbr")).unwrap_or(trimmed));
    let s = word.to_ascii_lowercase();
    if s == "e" || s == "emissive" {
        return Kind::Emissive;
    }
    // named a normal map but not stored as one: still a flat normal, written with the game's own settings for it
    if ["n", "nr", "nrm", "nm", "normal"].contains(&s.as_str()) {
        return Kind::Normal;
    }
    // channel letters are written in capitals (T_Rock_MRO), a word like Mars is not
    let capitals = word == word.to_ascii_uppercase();
    if let Some(px) = packed(&s).filter(|_| capitals || s.len() > 4) {
        return Kind::Mro(px);
    }
    if ["bg", "sky", "skybox", "background"].contains(&s.as_str()) || t.lod_group.eq_ignore_ascii_case("TEXTUREGROUP_Skybox") {
        return Kind::Sky;
    }
    // a moss decal is a decal first
    if has_word(cased, &DECAL) {
        return Kind::Decal;
    }
    if has_word(cased, &PLANT) {
        return Kind::Plant;
    }
    Kind::Color
}

/// The options a build is made with.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Look {
    pub base: [u8; 3],
    pub sky: [u8; 3],
    pub hide_plants: bool,
    pub lobby: bool,
}

/// The pixel (RGBA) a kind gets, or None when the texture stays as the game has it.
pub fn pixel(kind: Kind, look: &Look) -> Option<[u8; 4]> {
    let [r, g, b] = look.base;
    Some(match kind {
        Kind::Normal => [0x80, 0x80, 0xff, 0xff],
        Kind::Mro(px) => px,
        Kind::Color => [r, g, b, 0xff],
        Kind::Sky => [look.sky[0], look.sky[1], look.sky[2], 0xff],
        Kind::Plant => [r, g, b, if look.hide_plants { 0x00 } else { 0x80 }],
        Kind::Decal => [r, g, b, 0x00],
        Kind::Emissive | Kind::Skip => return None,
    })
}

/// "5d7a80" or "#5D7A80" as RGB. None for anything else.
pub fn parse_hex(s: &str) -> Option<[u8; 3]> {
    let h = s.trim().trim_start_matches('#');
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let b = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some([b(0)?, b(2)?, b(4)?])
}

/// The two package shapes, made from a cooked 1x1 texture's structure (a placeholder path, no pixel, no GUID): a plain
/// texture with default settings, and a normal map (TC_Normalmap, WorldNormalMap, sRGB off, as the game's normal maps).
const PLAIN: &str = include_str!("../resources/quake/plain.json");
const NORMAL: &str = include_str!("../resources/quake/normal.json");

fn templates() -> Result<(Value, Value), String> {
    let read = |t: &str| serde_json::from_str::<Value>(t).map_err(|e| format!("CustomQuake template: {e}"));
    Ok((read(PLAIN)?, read(NORMAL)?))
}

/// "Marvel/Content/Marvel/Environment/X" (as the game lists it) to "/Game/Marvel/Environment/X".
fn game_path(vfs: &str) -> Option<String> {
    let v = vfs.replace('\\', "/");
    let i = v.to_ascii_lowercase().find("/content/")?;
    Some(format!("/Game/{}", v[i + "/content/".len()..].trim_end_matches(".uasset")))
}

/// One package to write: where (as the game lists it), which pixel (RGBA), with which settings.
#[derive(Debug, Clone, PartialEq)]
pub struct Planned {
    pub vfs: String,
    pub pixel: [u8; 4],
    pub settings: Settings,
}

/// Every texture that changes, with its pixel. The shape follows the game's own compression setting.
pub fn plan(textures: &[Vanilla], look: &Look) -> Vec<Planned> {
    textures
        .iter()
        .filter_map(|t| {
            let px = pixel(classify(t, look.lobby), look)?;
            let settings = if t.compression.eq_ignore_ascii_case("TC_Normalmap") { Settings::normal() } else { Settings { compression: t.compression.clone(), lod_group: t.lod_group.clone(), srgb_off: t.srgb_off } };
            Some(Planned { vfs: t.path.clone(), pixel: px, settings })
        })
        .collect()
}

/// Writes the JSON of each planned package under `dir` (its game path), ready for UAssetTool's batch_from_json.
/// The template for a package with these settings: the plain one for default settings, else the normal map's with only
/// the settings that differ from the default left in, carrying the game's values.
fn template_for(s: &Settings, plain: &Value, normal: &Value) -> (Value, HashMap<String, String>) {
    if *s == Settings::default() {
        return (plain.clone(), HashMap::new());
    }
    let mut v = normal.clone();
    if let Some(data) = v["Exports"][0]["Data"].as_array_mut() {
        data.retain(|p| match p["Name"].as_str() {
            Some("CompressionSettings") => !s.compression.is_empty(),
            Some("LODGroup") => !s.lod_group.is_empty(),
            Some("SRGB") => s.srgb_off,
            _ => true,
        });
    }
    let mut map = HashMap::new();
    if !s.compression.is_empty() {
        map.insert("TC_Normalmap".to_string(), s.compression.clone());
    }
    if !s.lod_group.is_empty() {
        map.insert("TEXTUREGROUP_WorldNormalMap".to_string(), s.lod_group.clone());
    }
    (v, map)
}

fn write_jsons(planned: &[Planned], dir: &std::path::Path) -> Result<Vec<String>, String> {
    use rayon::prelude::*;
    let (plain, normal) = templates()?;
    planned
        .par_iter()
        .map(|p| {
            let path = game_path(&p.vfs).ok_or_else(|| format!("{} is not under a Content folder", p.vfs))?;
            let [r, g, b, a] = p.pixel;
            let (template, more) = template_for(&p.settings, &plain, &normal);
            let v = package_json(&template, &path, &guid_for(&path), [b, g, r, a], &more)?;
            let out = dir.join(format!("{}.json", p.vfs.trim_end_matches(".uasset")));
            std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::write(&out, serde_json::to_string(&v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            Ok(out.to_string_lossy().replace('\\', "/"))
        })
        .collect()
}

/// Puts the two fields UAssetTool writes differently from the cooker right, in every package under `dir` (see
/// fix_skip_offset and fix_names_referenced). Names come from each package's JSON under `json`.
fn fix_written(planned: &[Planned], dir: &std::path::Path, json: &std::path::Path) -> Result<(), String> {
    use rayon::prelude::*;
    planned.par_iter().try_for_each(|p| -> Result<(), String> {
        let rel = p.vfs.trim_end_matches(".uasset");
        let uexp = dir.join(format!("{rel}.uexp"));
        let mut b = std::fs::read(&uexp).map_err(|e| format!("{rel}.uexp: {e}"))?;
        fix_skip_offset(&mut b).map_err(|e| format!("{rel}: {e}"))?;
        std::fs::write(&uexp, b).map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_str(&std::fs::read_to_string(json.join(format!("{rel}.json"))).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let names: Vec<String> = v["NameMap"].as_array().ok_or("no name map")?.iter().filter_map(|n| n.as_str().map(str::to_string)).collect();
        let uasset = dir.join(format!("{rel}.uasset"));
        let mut b = std::fs::read(&uasset).map_err(|e| format!("{rel}.uasset: {e}"))?;
        fix_names_referenced(&mut b, &names).map_err(|e| format!("{rel}: {e}"))?;
        std::fs::write(&uasset, b).map_err(|e| e.to_string())
    })
}

/// Every string in `v` equal to a key of `map` becomes its value (names, the package path, enum values).
fn substitute(v: &mut Value, map: &HashMap<String, String>) {
    match v {
        Value::String(s) => {
            if let Some(n) = map.get(s.as_str()) {
                *s = n.clone();
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| substitute(x, map)),
        Value::Object(o) => o.values_mut().for_each(|x| substitute(x, map)),
        _ => {}
    }
}

/// A name without its number, as an FName stores it: "T_X_10" is "T_X" with number 10. A number with a leading zero
/// ("T_X_02") stays part of the name, as the engine splits it.
fn fname_base(name: &str) -> &str {
    match name.rsplit_once('_') {
        Some((base, n)) if !base.is_empty() && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && (n == "0" || !n.starts_with('0')) && n.parse::<i32>().is_ok() => base,
        _ => name,
    }
}

/// A stable LightingGuid for a package path: the same build makes the same files.
fn guid_for(path: &str) -> String {
    let h = sha2::Sha256::digest(path.to_ascii_lowercase().as_bytes());
    let x: String = h[..16].iter().map(|b| format!("{b:02X}")).collect();
    format!("{{{}-{}-{}-{}-{}}}", &x[..8], &x[8..12], &x[12..16], &x[16..20], &x[20..32])
}

/// The JSON of a 1x1 package at `path` (/Game/...), made from a template package's JSON: its path, name, LightingGuid and
/// pixel (BGRA) replaced, plus any other whole strings in `more` (a normal map's LODGroup).
fn package_json(template: &Value, path: &str, guid: &str, bgra: [u8; 4], more: &HashMap<String, String>) -> Result<Value, String> {
    let old_path = template["FolderName"].as_str().ok_or("template has no FolderName")?.to_string();
    let old_name = old_path.rsplit('/').next().unwrap_or_default().to_string();
    let mut map = more.clone();
    map.insert(old_path, path.to_string());
    map.insert(old_name, path.rsplit('/').next().unwrap_or_default().to_string());
    let mut v = template.clone();
    substitute(&mut v, &map);
    // the name map holds names without their number (T_X_10 is T_X with number 10), as the engine stores them
    let (new_path, new_name) = (path.to_string(), path.rsplit('/').next().unwrap_or_default().to_string());
    if let Some(names) = v["NameMap"].as_array_mut() {
        for n in names.iter_mut().filter(|n| n.as_str() == Some(&new_path) || n.as_str() == Some(&new_name)) {
            let full = n.as_str().unwrap_or_default().to_string();
            *n = Value::String(fname_base(&full).to_string());
        }
    }
    let ex = &mut v["Exports"][0];
    let guid_prop = ex["Data"].as_array_mut().and_then(|d| d.iter_mut().find(|p| p["Name"] == "LightingGuid")).ok_or("template has no LightingGuid")?;
    guid_prop["Value"][0]["Value"] = Value::String(guid.to_string());
    let mip = &mut ex["PlatformData"]["Mips"][0]["BulkData"]["Data"];
    if !mip.is_string() {
        return Err("template has no inline mip".into());
    }
    *mip = Value::String(base64::engine::general_purpose::STANDARD.encode(bgra));
    Ok(v)
}

/// UAssetTool's writer stores a texture's SkipOffset 8 short of what the cooker writes (measured from after the field
/// instead of from its start: 76 where every cooked 1x1 texture has 84). The game seeks by it, so it is put right here. The
/// field is the only int64 whose value points at the trailing None name (8 bytes) before the package tag (4 bytes).
fn fix_skip_offset(uexp: &mut [u8]) -> Result<(), String> {
    let end = uexp.len().checked_sub(12).ok_or("too short for a texture")?;
    let at = |p: usize| i64::from_le_bytes(uexp[p..p + 8].try_into().unwrap());
    let short: Vec<usize> = (0..end.saturating_sub(8)).filter(|&p| at(p) == (end - p - 8) as i64).collect();
    let right: Vec<usize> = (0..end.saturating_sub(8)).filter(|&p| at(p) == (end - p) as i64).collect();
    match (short.as_slice(), right.as_slice()) {
        ([p], []) => {
            uexp[*p..*p + 8].copy_from_slice(&((end - p) as i64).to_le_bytes());
            Ok(())
        }
        ([], [_]) => Ok(()),
        _ => Err(format!("no single SkipOffset found ({} short, {} right)", short.len(), right.len())),
    }
}

/// UAssetTool writes NamesReferencedFromExportDataCount as the whole name map (15). The cooker counts only the names the
/// export data uses, which come first, before the import names that start at /Script/CoreUObject (9 in a plain 1x1
/// texture). The field is the int32 right before PayloadTocOffset (-1, eight 0xff bytes) in the summary.
fn fix_names_referenced(uasset: &mut [u8], names: &[String]) -> Result<(), String> {
    let used = names.iter().position(|n| n == "/Script/CoreUObject").ok_or("no /Script/CoreUObject name")? as i32;
    let mut pat = (names.len() as i32).to_le_bytes().to_vec();
    pat.extend([0xff; 8]);
    let hits: Vec<usize> = uasset.windows(pat.len()).enumerate().filter(|(_, w)| *w == pat.as_slice()).map(|(i, _)| i).collect();
    match hits.as_slice() {
        [at] => {
            uasset[*at..*at + 4].copy_from_slice(&used.to_le_bytes());
            Ok(())
        }
        _ => Err(format!("NamesReferencedFromExportDataCount found {} times", hits.len())),
    }
}

// ---- the build ----

/// Batches of settings read at a time. Each call to UAssetTool costs about a second whatever its size (66 calls at 500, 9
/// at 4,000), and with the pixel data left out a batch of 4,000 takes about 600 MB of temporary disk (1,000 real
/// textures: 151 MB) and the same again in memory while its JSON is read.
const BATCH: usize = 4000;
/// Packages written per call to UAssetTool: the card's bar moves between calls and a stop is heard between them. A call costs
/// about a second whatever its size (measured: 1,148 packages took 3.1 s in one call and 11.5 s in twelve), so not smaller.
const WRITE_CHUNK: usize = 8000;

/// What a build is doing now, for the card's bar (it asks once a second while a build runs).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Progress {
    pub stage: String,
    /// "12,000 of 32,855" where a stage counts
    pub detail: Option<String>,
    /// how far the whole build has come, 0 to 1
    pub fraction: f32,
}

static PROGRESS: std::sync::Mutex<Option<Progress>> = std::sync::Mutex::new(None);

/// The stages and the share of a whole build each takes. A guess from the first real build (about 9 minutes, two thirds of
/// it reading the game): every stage's time goes to the log, so the shares can be set from measured ones.
const STAGES: [(&str, f32); 5] = [
    ("Listing the game's textures", 0.04),
    ("Reading the game's texture settings", 0.60),
    ("Writing the packages", 0.16),
    ("Packing", 0.06),
    ("Checking the new container", 0.14),
];
const READING: usize = 1;

/// How far the whole build has come at `within` (0 to 1) of stage `i`. With the game's settings saved by an earlier build
/// the first two stages are skipped and the others share the bar. Pure.
fn fraction(i: usize, within: f32, saved: bool) -> f32 {
    let first = if saved { 2 } else { 0 };
    if i < first {
        return 0.0;
    }
    let total: f32 = STAGES[first..].iter().map(|s| s.1).sum();
    let before: f32 = STAGES[first..i].iter().map(|s| s.1).sum();
    ((before + STAGES[i].1 * within.clamp(0.0, 1.0)) / total).clamp(0.0, 1.0)
}

fn report(stage: usize, within: f32, saved: bool, detail: Option<String>) {
    *PROGRESS.lock().unwrap_or_else(|e| e.into_inner()) = Some(Progress { stage: STAGES[stage].0.to_string(), detail, fraction: fraction(stage, within, saved) });
}

/// Clears the progress when a build ends, whichever way.
struct Finished;
impl Drop for Finished {
    fn drop(&mut self) {
        *PROGRESS.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// The build in flight, if any (the card's bar).
#[tauri::command]
pub fn xtra_quake_progress() -> Result<Option<Progress>, String> {
    crate::xtra_activation::require()?;
    Ok(PROGRESS.lock().unwrap_or_else(|e| e.into_inner()).clone())
}

fn cache_path() -> std::path::PathBuf {
    dirs::config_dir().unwrap_or_else(|| ".".into()).join("Repak-X").join("repakxtra-quake-settings.json")
}

/// The game's settings for its map textures, kept for the game build they were read from. Reading them is two thirds of a
/// first build and they change only when the game does, so a rebuild for new options skips it. Pure.
fn cache_text(build: &str, textures: &[Vanilla]) -> String {
    serde_json::json!({ "v": 1, "build": build, "textures": textures.iter().map(|t| (&t.path, &t.compression, &t.lod_group, t.srgb_off)).collect::<Vec<_>>() }).to_string()
}

/// The saved settings, when they were read from this game build. None for anything else. Pure.
fn cache_from(text: &str, build: &str) -> Option<Vec<Vanilla>> {
    let v: Value = serde_json::from_str(text).ok()?;
    if v["v"] != 1 || v["build"] != build {
        return None;
    }
    let rows: Vec<(String, String, String, bool)> = serde_json::from_value(v["textures"].clone()).ok()?;
    (!rows.is_empty()).then(|| rows.into_iter().map(|(path, compression, lod_group, srgb_off)| Vanilla { path, compression, lod_group, srgb_off }).collect())
}

fn save_cache(build: &str, textures: &[Vanilla]) -> Result<(), String> {
    let path = cache_path();
    std::fs::create_dir_all(path.parent().ok_or("no folder")?).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, cache_text(build, textures)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn uat_request<'a>(action: &'a str) -> crate::vfx_updater::uasset_tool::VfxUatRequest<'a> {
    crate::vfx_updater::uasset_tool::VfxUatRequest { action, ..Default::default() }
}

/// Every Environment texture of the installed game (the containers directly in Paks, never ~mods), as the game lists
/// them ("Marvel/Content/Marvel/Environment/.../T_X"). Needs the command line, which ships beside the app.
fn list_textures(paks: &Path) -> Result<Vec<String>, String> {
    let exe = crate::xtra_uat_cli::cli().ok_or("CustomQuake needs uassettool-cli.exe beside repakxtra. Reinstall repakxtra")?;
    let mut out = std::collections::BTreeSet::new();
    for (utoc, _, _) in crate::xtra_broken::game_containers(paks) {
        let mut cmd = std::process::Command::new(&exe);
        cmd.arg("list_iostore").arg(&utoc).args(["--filter", "Marvel/Environment/", "--type", "Texture2D", "--game-paks"]).arg(paks);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let o = cmd.output().map_err(|e| format!("Could not list the game's textures: {e}"))?;
        if !o.status.success() {
            return Err(format!("Could not list the textures in {}", utoc.file_name().unwrap_or_default().to_string_lossy()));
        }
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            let Some(p) = line.trim().split(" [").next().filter(|p| p.ends_with(".uasset")) else { continue };
            let p = p.trim_start_matches("../../../").trim_end_matches(".uasset");
            if p.contains("/Content/Marvel/Environment/") {
                out.insert(p.to_string());
            }
        }
    }
    if out.is_empty() {
        return Err("The game lists no map textures. The game files may be from a newer version than this repakxtra".into());
    }
    Ok(out.into_iter().collect())
}

/// The built-ins' one message for mappings that are behind the game (xtra_builtins.rs): nothing to retry by hand.
use crate::xtra_builtins::MAPPINGS_BEHIND;

/// The game's settings for one texture from its JSON (to_json of the game's package). None when it is not a texture.
fn vanilla_of(vfs: &str, json: &Value) -> Option<Vanilla> {
    let ex = json["Exports"].as_array()?.iter().find(|e| e["$type"].as_str().is_some_and(|t| t.contains("TextureExport")))?;
    let srgb_off = ex["Data"].as_array().and_then(|d| d.iter().find(|p| p["Name"] == "SRGB")).is_some_and(|p| p["Value"] == false);
    let prop = |name: &str| {
        // an enum property keeps its value in Value, a byte property naming an enum in EnumValue
        ex["Data"].as_array().and_then(|d| d.iter().find(|p| p["Name"] == name)).and_then(|p| p["EnumValue"].as_str().or(p["Value"].as_str())).unwrap_or_default().to_string()
    };
    Some(Vanilla { path: vfs.to_string(), compression: prop("CompressionSettings"), lod_group: prop("LODGroup"), srgb_off })
}

const STOPPED: &str = "Stopped: switched off while it built";

/// Reads the settings of every listed texture, `BATCH` at a time, each batch deleted before the next.
async fn read_settings(tool: &Path, usmap: &str, paks: &Path, listed: &[String], work: &Path, stop: fn() -> bool) -> Result<Vec<Vanilla>, String> {
    let mut all = Vec::with_capacity(listed.len());
    let mut done = 0;
    for batch in listed.chunks(BATCH) {
        if stop() {
            return Err(STOPPED.into());
        }
        if done == 0 {
            report(READING, 0.0, false, Some(format!("0 of {}", group_digits(listed.len()))));
        }
        let (legacy, json) = (work.join("legacy"), work.join("json"));
        remove_dirs(vec![legacy.clone(), json.clone()]).await;
        let began = std::time::Instant::now();
        // without their dependencies (a texture imports only engine classes) and without their pixel data, which is 32 GB
        // of the game and none of the settings (uassettool-patches 0008: the same .uasset and .uexp, checked byte for byte
        // on 1,000 real textures). An older command line ignores the flag and extracts everything.
        std::fs::create_dir_all(&legacy).map_err(|e| e.to_string())?;
        let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
            game_paks: Some(paks.to_string_lossy().to_string()),
            output_path: Some(legacy.to_string_lossy().to_string()),
            filter_patterns: Some(batch.iter().map(|p| crate::vfx_updater::uasset_tool::to_package_path(p.trim_end_matches(".uasset"))).collect()),
            with_deps: Some(false),
            no_bulk: true,
            ..uat_request("extract_iostore_legacy")
        };
        let r = crate::vfx_updater::uasset_tool::run_vfx_uat_request(tool, &req).await?;
        if !r.success {
            return Err(format!("Could not read the game's textures: {}", r.message));
        }
        let extracted = began.elapsed();
        let files = {
            let legacy = legacy.clone();
            blocking(move || {
                let mut files = Vec::new();
                for e in walkdir::WalkDir::new(&legacy).into_iter().flatten().filter(|e| e.file_type().is_file()) {
                    let ext = e.path().extension().map(|x| x.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
                    match ext.as_str() {
                        // the pixels are not needed for the settings: gone at once, they are most of the disk space
                        "ubulk" | "uptnl" => { let _ = std::fs::remove_file(e.path()); }
                        "uasset" => files.push(e.path().to_string_lossy().replace('\\', "/")),
                        _ => {}
                    }
                }
                Ok(files)
            })
            .await?
        };
        let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
            file_paths: Some(files),
            usmap_path: Some(usmap),
            output_path: Some(json.to_string_lossy().to_string()),
            base_path: Some(legacy.to_string_lossy().to_string()),
            ..uat_request("batch_to_json")
        };
        let r = crate::vfx_updater::uasset_tool::run_vfx_uat_request(tool, &req).await?;
        if !r.success {
            return Err(format!("Could not read the game's texture settings: {}", r.message));
        }
        let converted = began.elapsed();
        let found = {
            let json = json.clone();
            blocking(move || read_batch(&json)).await?
        };
        log::info!("[quake] {} textures read: extract {:.1} s, to JSON {:.1} s, parse {:.1} s", batch.len(), extracted.as_secs_f32(), (converted - extracted).as_secs_f32(), (began.elapsed() - converted).as_secs_f32());
        all.extend(found);
        done += batch.len();
        report(READING, done as f32 / listed.len() as f32, false, Some(format!("{} of {}", group_digits(done), group_digits(listed.len()))));
    }
    all_read(listed, &all)?;
    remove_dirs(vec![work.join("legacy"), work.join("json")]).await;
    Ok(all)
}

/// Removes folders off the async threads (a batch's folders hold thousands of files). Best effort, as before.
async fn remove_dirs(dirs: Vec<std::path::PathBuf>) {
    let _ = blocking(move || {
        dirs.iter().for_each(|d| { let _ = std::fs::remove_dir_all(d); });
        Ok(())
    })
    .await;
}

/// The settings in each JSON of one batch, parsed side by side (the files are independent).
fn read_batch(json: &Path) -> Result<Vec<Vanilla>, String> {
    use rayon::prelude::*;
    let files: Vec<_> = walkdir::WalkDir::new(json).into_iter().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "json")).map(|e| e.into_path()).collect();
    let read: Vec<Option<Vanilla>> = files
        .par_iter()
        .map(|path| {
            let rel = path.strip_prefix(json).map_err(|e| e.to_string())?.with_extension("").to_string_lossy().replace('\\', "/");
            let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("{rel}: {e}"))?;
            // an export UAssetTool could not decode is kept as raw bytes: the mappings are behind the game
            if v["Exports"].as_array().is_some_and(|e| e.iter().any(|x| x["$type"].as_str().is_some_and(|t| t.contains("RawExport")))) {
                return Err(MAPPINGS_BEHIND.to_string());
            }
            Ok(vanilla_of(&rel, &v))
        })
        .collect::<Result<_, String>>()?;
    Ok(read.into_iter().flatten().collect())
}

/// Runs heavy file work off the async threads.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

/// Every listed texture was read, once: one missing would leave a map texture out of the build without a word.
fn all_read(listed: &[String], read: &[Vanilla]) -> Result<(), String> {
    let got: std::collections::HashSet<String> = read.iter().map(|t| t.path.to_ascii_lowercase()).collect();
    let missing: Vec<&String> = listed.iter().filter(|p| !got.contains(&p.to_ascii_lowercase())).collect();
    if missing.is_empty() && got.len() == read.len() {
        return Ok(());
    }
    let first = missing.first().map_or("none", |p| p.rsplit('/').next().unwrap_or(p));
    Err(format!("{MAPPINGS_BEHIND} ({} of the game's {} map textures could not be read, first: {first})", missing.len(), listed.len()))
}

/// Every package read back out of the container carries the settings it was planned with.
fn check_settings(planned: &[Planned], json: &Path) -> Result<(), String> {
    use rayon::prelude::*;
    planned.par_iter().try_for_each(|p| -> Result<(), String> {
        let rel = p.vfs.trim_end_matches(".uasset");
        let text = std::fs::read_to_string(json.join(format!("{rel}.json"))).map_err(|e| format!("{rel}: {e}"))?;
        let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("{rel}: {e}"))?;
        let got = vanilla_of(rel, &v).ok_or_else(|| format!("{rel} is not a texture"))?;
        if (got.compression.as_str(), got.lod_group.as_str(), got.srgb_off) != (p.settings.compression.as_str(), p.settings.lod_group.as_str(), p.settings.srgb_off) {
            return Err(format!("{rel} lost the game's settings for it"));
        }
        Ok(())
    })
}

/// Where a written package's pixel sits in its .uexp: a 1x1 BGRA8 mip, its four bytes before the 1x1x1 size.
fn pixel_at(uexp: &[u8]) -> Option<usize> {
    const ONE: [u8; 12] = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    let tag = b"PF_B8G8R8A8\0";
    uexp.windows(tag.len()).position(|w| w == tag)?;
    uexp.windows(16).rposition(|w| w[4..] == ONE)
}

/// The pixel a written package holds (RGBA), from its .uexp.
fn pixel_in(uexp: &[u8]) -> Option<[u8; 4]> {
    let at = pixel_at(uexp)?;
    let [b, g, r, a] = uexp[at..at + 4].try_into().ok()?;
    Some([r, g, b, a])
}

/// Puts another pixel (RGBA) into a written package's .uexp: nothing else in the package depends on it.
fn set_pixel(uexp: &mut [u8], rgba: [u8; 4]) -> Result<(), String> {
    let at = pixel_at(uexp).ok_or("no pixel found in the package")?;
    let [r, g, b, a] = rgba;
    uexp[at..at + 4].copy_from_slice(&[b, g, r, a]);
    Ok(())
}

/// The packages of the last build, kept for the next one: a rebuild for new options only puts new pixels in them instead
/// of writing 31,000 packages again. Valid for one game build (index.json, written last).
fn store_dir() -> std::path::PathBuf {
    dirs::cache_dir().unwrap_or_else(|| ".".into()).join("Repak-X").join("repakxtra-quake-packages")
}

/// For each kept package (its path without .uasset), the settings it was written with.
type Kept = HashMap<String, (String, String, bool)>;

fn settings_row(s: &Settings) -> (String, String, bool) {
    (s.compression.clone(), s.lod_group.clone(), s.srgb_off)
}

/// The packages kept for this game build and the format of this version of repakxtra. Empty for anything else.
fn load_kept(dir: &Path, build: &str) -> Kept {
    let Ok(text) = std::fs::read_to_string(dir.join("index.json")) else { return Kept::new() };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return Kept::new() };
    if v["v"] != STORE_FORMAT || v["build"] != build {
        return Kept::new();
    }
    serde_json::from_value(v["packages"].clone()).unwrap_or_default()
}

fn save_kept(dir: &Path, build: &str, kept: &Kept) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("index.json.tmp");
    std::fs::write(&tmp, serde_json::json!({ "v": STORE_FORMAT, "build": build, "packages": kept }).to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("index.json")).map_err(|e| e.to_string())
}

/// Bump when the templates or the two writer fixes change: packages kept by an older version are written again.
const STORE_FORMAT: u32 = 1;

/// Copies one package between two roots (its .uasset as it is, its .uexp with `rgba` put in when given).
fn copy_package(from: &Path, to: &Path, rel: &str, rgba: Option<[u8; 4]>) -> Result<(), String> {
    let mut uexp = std::fs::read(from.join(format!("{rel}.uexp"))).map_err(|e| format!("{rel}.uexp: {e}"))?;
    if let Some(px) = rgba {
        set_pixel(&mut uexp, px).map_err(|e| format!("{rel}: {e}"))?;
    }
    let target = to.join(format!("{rel}.uexp"));
    std::fs::create_dir_all(target.parent().ok_or("no folder")?).map_err(|e| e.to_string())?;
    write_whole(&target, |tmp| std::fs::write(tmp, &uexp)).map_err(|e| format!("{rel}.uexp: {e}"))?;
    write_whole(&to.join(format!("{rel}.uasset")), |tmp| std::fs::copy(from.join(format!("{rel}.uasset")), tmp).map(|_| ())).map_err(|e| format!("{rel}.uasset: {e}"))
}

/// Writes `target` through a temp file beside it, then renames it in: a write cut short never stands as the file (a kept
/// package that looks whole), and its temp file does not stay behind to be packed.
fn write_whole(target: &Path, write: impl FnOnce(&Path) -> std::io::Result<()>) -> std::io::Result<()> {
    let mut tmp = target.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    let r = write(&tmp).and_then(|_| std::fs::rename(&tmp, target));
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r
}

/// Copies every planned package the store holds with the same settings into `legacy`, the new pixel put in, side by side.
/// Returns the ones still to be written (not kept, written for other settings, or not readable).
fn reuse_kept(planned: &[Planned], kept: &Kept, store: &Path, legacy: &Path) -> Vec<usize> {
    use rayon::prelude::*;
    planned
        .par_iter()
        .enumerate()
        .filter_map(|(i, p)| {
            let rel = p.vfs.trim_end_matches(".uasset");
            let same = kept.get(rel).is_some_and(|row| *row == settings_row(&p.settings));
            if same && copy_package(store, legacy, rel, Some(p.pixel)).is_ok() { None } else { Some(i) }
        })
        .collect()
}

/// Keeps the checked packages for the next build: all of them when none were reused (the store was empty or for another
/// game build), else the ones written now. The index goes last, so a store cut short counts as empty.
fn keep_written(written: &[Planned], legacy: &Path, store: &Path, build: &str, fresh: bool, mut kept: Kept) -> Result<(), String> {
    use rayon::prelude::*;
    if fresh {
        let _ = std::fs::remove_dir_all(store);
        kept.clear();
    }
    written.par_iter().try_for_each(|p| copy_package(legacy, store, p.vfs.trim_end_matches(".uasset"), None))?;
    kept.extend(written.iter().map(|p| (p.vfs.trim_end_matches(".uasset").to_string(), settings_row(&p.settings))));
    save_kept(store, build, &kept)
}

/// Every planned package is under `dir` with its planned pixel and a SkipOffset as the cooker writes it.
fn check_all(planned: &[Planned], dir: &Path) -> Result<(), String> {
    use rayon::prelude::*;
    let written = walkdir::WalkDir::new(dir).into_iter().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "uasset")).count();
    if written != planned.len() {
        return Err(format!("{written} packages were written for {} planned", planned.len()));
    }
    planned.par_iter().try_for_each(|p| -> Result<(), String> {
        let rel = p.vfs.trim_end_matches(".uasset");
        let b = std::fs::read(dir.join(format!("{rel}.uexp"))).map_err(|e| format!("{rel}: {e}"))?;
        if pixel_in(&b) != Some(p.pixel) {
            return Err(format!("{rel} does not hold its planned color"));
        }
        let mut c = b.clone();
        if fix_skip_offset(&mut c).is_err() || c != b {
            return Err(format!("{rel} would point the game at the wrong place"));
        }
        Ok(())
    })
}

/// Writes every planned package under `legacy`, `chunk` at a time: each chunk's JSON in parallel, then UAssetTool's
/// batch_from_json. The card's bar moves and a stop is heard between chunks.
async fn write_packages(tool: &Path, usmap: &str, planned: &std::sync::Arc<Vec<Planned>>, json: &Path, legacy: &Path, chunk: usize, saved: bool, stop: fn() -> bool) -> Result<(), String> {
    let total = planned.len();
    for from in (0..total).step_by(chunk) {
        if stop() {
            return Err(STOPPED.into());
        }
        report(2, from as f32 / total as f32, saved, Some(format!("{} of {}", group_digits(from), group_digits(total))));
        let to = (from + chunk).min(total);
        let files = {
            let (planned, json) = (planned.clone(), json.to_path_buf());
            blocking(move || write_jsons(&planned[from..to], &json)).await?
        };
        let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
            file_paths: Some(files),
            usmap_path: Some(usmap),
            output_path: Some(legacy.to_string_lossy().to_string()),
            base_path: Some(json.to_string_lossy().to_string()),
            ..uat_request("batch_from_json")
        };
        let r = crate::vfx_updater::uasset_tool::run_vfx_uat_request(tool, &req).await?;
        if !r.success {
            return Err(format!("Could not write the packages: {}", r.message));
        }
    }
    Ok(())
}

/// Builds CustomQuake into `out_base` (.pak, .utoc, .ucas). Every package is checked before packing and again after it
/// is read back out of the container, so nothing reaches the game unless all of it is right. Returns the summary.
/// `build` names the game build: the game's settings are kept for it, so a rebuild for new options skips reading them.
/// `stop` says when it was switched off: it gives up at the next batch or step.
pub async fn make(tool: &Path, usmap: &str, paks: &Path, work: &Path, out_base: &Path, options: &Options, build: &str, stop: fn() -> bool) -> Result<String, String> {
    let look = options.look()?;
    let _finished = Finished;
    let started = std::time::Instant::now();
    let mut since = started;
    let mut lap = |what: &str| {
        log::info!("[quake] {what}: {:.1} s", since.elapsed().as_secs_f32());
        since = std::time::Instant::now();
    };
    let kept = std::fs::read_to_string(cache_path()).ok().and_then(|t| cache_from(&t, build));
    let saved = kept.is_some();
    let textures = match kept {
        Some(t) => t,
        None => {
            report(0, 0.0, false, None);
            let listed = tokio::task::spawn_blocking({
                let paks = paks.to_path_buf();
                move || list_textures(&paks)
            })
            .await
            .map_err(|e| e.to_string())??;
            lap("listing the textures");
            let t = read_settings(tool, usmap, paks, &listed, &work.join("read"), stop).await?;
            lap("reading their settings");
            if let Err(e) = save_cache(build, &t) {
                log::warn!("[quake] the game's settings were not kept for the next build: {e}");
            }
            t
        }
    };
    let planned = std::sync::Arc::new(plan(&textures, &look));
    if planned.is_empty() {
        return Err("No map texture to change".into());
    }
    let total = planned.len();
    let (json, legacy, store) = (work.join("json"), work.join("mod"), store_dir());
    // the last build's packages with the new pixels put in, and only the rest written
    report(2, 0.0, saved, Some("Reusing the last build's packages".into()));
    let kept = load_kept(&store, build);
    let todo: Vec<Planned> = {
        let (all, kept, store, legacy) = (planned.clone(), kept.clone(), store.clone(), legacy.clone());
        let left = blocking(move || Ok::<_, String>(reuse_kept(&all, &kept, &store, &legacy))).await?;
        left.into_iter().map(|i| planned[i].clone()).collect()
    };
    let todo = std::sync::Arc::new(todo);
    let reused = total - todo.len();
    lap(&format!("reusing {reused} kept packages"));
    write_packages(tool, usmap, &todo, &json, &legacy, WRITE_CHUNK, saved, stop).await?;
    lap(&format!("writing {} packages", todo.len()));
    report(3, 0.0, saved, None);
    {
        let (todo, legacy, json) = (todo.clone(), legacy.clone(), json.clone());
        blocking(move || fix_written(&todo, &legacy, &json)).await?;
    }
    report(3, 0.3, saved, None);
    {
        let (planned, legacy) = (planned.clone(), legacy.clone());
        // a kept package that fails its check is not kept: the next build writes them all again
        if let Err(e) = blocking(move || check_all(&planned, &legacy)).await {
            if reused > 0 {
                remove_dirs(vec![store.clone()]).await;
            }
            return Err(format!("{e}, so nothing was installed"));
        }
    }
    {
        let (todo, legacy, store, build) = (todo.clone(), legacy.clone(), store.clone(), build.to_string());
        let (fresh, kept) = (reused == 0, kept.clone());
        if let Err(e) = blocking(move || keep_written(&todo, &legacy, &store, &build, fresh, kept)).await {
            log::warn!("[quake] the packages were not kept for the next build: {e}");
        }
    }
    remove_dirs(vec![json.clone()]).await;
    // a later failure may come from a kept package check_all cannot see (its .uasset): the store goes, so the next build
    // writes every package again instead of failing the same way until the game updates
    let packed = pack_and_check(tool, usmap, paks, work, out_base, &legacy, &planned, saved, stop, &mut lap).await;
    if let Err(e) = &packed {
        if e.as_str() != STOPPED {
            remove_dirs(vec![store]).await;
        }
    }
    packed?;
    let mins = started.elapsed().as_secs_f64() / 60.0;
    Ok(format!("{} textures set in {}", group_digits(total), if mins < 1.5 { "about a minute".to_string() } else { format!("{} minutes", mins.round()) }))
}

/// Packs the checked packages into `out_base`, then reads the container back the way the game will and checks every
/// package and its settings again.
#[allow(clippy::too_many_arguments)]
async fn pack_and_check(tool: &Path, usmap: &str, paks: &Path, work: &Path, out_base: &Path, legacy: &Path, planned: &std::sync::Arc<Vec<Planned>>, saved: bool, stop: fn() -> bool, lap: &mut impl FnMut(&str)) -> Result<(), String> {
    if stop() {
        return Err(STOPPED.into());
    }
    report(3, 0.5, saved, None);
    let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
        input_dir: Some(legacy.to_string_lossy().into_owned()),
        output_path: Some(out_base.to_string_lossy().into_owned()),
        compress: Some(true),
        parallel: Some(true),
        quake_packaging: Some(true),
        ..uat_request("create_mod_iostore")
    };
    let r = crate::vfx_updater::uasset_tool::run_vfx_uat_request(tool, &req).await?;
    if !r.success {
        return Err(format!("Could not pack CustomQuake: {}", r.message));
    }
    if r.data.as_ref().and_then(|d| d["quake_packaging"].as_bool()) != Some(true) {
        return Err("CustomQuake needs the updated UAssetTool library for V6 packaging; nothing was installed".into());
    }
    lap("fixing, checking and packing");
    // read back out of the container, as the game will see it
    report(4, 0.0, saved, None);
    let back = work.join("back");
    let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
        game_paks: Some(paks.to_string_lossy().to_string()),
        output_path: Some(back.to_string_lossy().to_string()),
        mod_path: Some(out_base.with_extension("utoc").to_string_lossy().to_string()),
        ..uat_request("extract_iostore_legacy")
    };
    let r = crate::vfx_updater::uasset_tool::run_vfx_uat_request(tool, &req).await?;
    if !r.success {
        return Err(format!("Could not read the new container back ({}), so nothing was installed", r.message));
    }
    // Extraction follows the directory index; verification uses the original game paths.
    if back.join("quakeV6").is_dir() {
        std::fs::rename(back.join("quakeV6"), back.join("Marvel")).map_err(|e| format!("Could not check the V6 container paths: {e}"))?;
    }
    report(4, 0.35, saved, None);
    {
        let (planned, back) = (planned.clone(), back.clone());
        blocking(move || check_all(&planned, &back)).await.map_err(|e| format!("{e} in the packed container, so nothing was installed"))?;
    }
    // and their settings, read the way the game's own were
    report(4, 0.55, saved, None);
    let back_json = work.join("back-json");
    let files: Vec<String> = {
        let back = back.clone();
        blocking(move || Ok(walkdir::WalkDir::new(&back).into_iter().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "uasset")).map(|e| e.path().to_string_lossy().replace('\\', "/")).collect())).await?
    };
    let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
        file_paths: Some(files),
        usmap_path: Some(usmap),
        output_path: Some(back_json.to_string_lossy().to_string()),
        base_path: Some(back.to_string_lossy().to_string()),
        ..uat_request("batch_to_json")
    };
    let r = crate::vfx_updater::uasset_tool::run_vfx_uat_request(tool, &req).await?;
    if !r.success {
        return Err(format!("Could not read the new packages' settings back ({}), so nothing was installed", r.message));
    }
    report(4, 0.85, saved, None);
    {
        let (planned, back_json) = (planned.clone(), back_json.clone());
        blocking(move || check_settings(&planned, &back_json)).await.map_err(|e| format!("{e} in the packed container, so nothing was installed"))?;
    }
    lap("reading the container back and checking it");
    Ok(())
}

/// 27181 as "27,181".
fn group_digits(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Mods that are on and change at least 1,000 map files (another quake mod), by path: the game shows only one of them
/// where they overlap. Their file lists come from the conflict check's cache.
pub fn overlapping(mods_root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for e in walkdir::WalkDir::new(mods_root).into_iter().filter_entry(crate::xtra_bundle::not_staging).flatten() {
        let p = e.path();
        if !p.extension().is_some_and(|x| x.eq_ignore_ascii_case("pak")) {
            continue;
        }
        let utoc = crate::xtra_bundle::companion(p, "utoc");
        if !utoc.exists() {
            continue;
        }
        let Ok(files) = crate::xtra_conflicts::files_cached(p, Some(&utoc), || crate::utoc_utils::try_read_utoc(&utoc).map(|v| v.into_iter().map(|e| e.file_path).collect())) else { continue };
        if files.iter().filter(|f| f.contains("/Environment/")).count() >= 1000 {
            out.push(p.to_string_lossy().to_string());
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(name: &str, compression: &str) -> Vanilla {
        Vanilla { path: format!("Marvel/Content/Marvel/Environment/Tokyo/TokyoE01/Tex/{name}"), compression: compression.into(), lod_group: String::new(), srgb_off: false }
    }
    const V6: Look = Look { base: [0x5d, 0x7a, 0x80], sky: [0x82, 0xc6, 0xed], hide_plants: false, lobby: true };
    fn px(name: &str, compression: &str) -> Option<String> {
        pixel(classify(&t(name, compression), true), &V6).map(|p| p.iter().map(|b| format!("{b:02x}")).collect())
    }

    #[test]
    fn the_bar_only_moves_forward_and_ends_full() {
        for saved in [false, true] {
            let first = if saved { 2 } else { 0 };
            let mut last = 0.0;
            for stage in first..STAGES.len() {
                for step in 0..=4 {
                    let f = fraction(stage, step as f32 / 4.0, saved);
                    assert!(f >= last && (0.0..=1.0).contains(&f), "stage {stage} step {step}: {f} after {last}");
                    last = f;
                }
            }
            assert!((last - 1.0).abs() < 1e-5, "ends full, saved {saved}: {last}");
            assert_eq!(fraction(first, 0.0, saved), 0.0, "starts empty");
        }
        assert_eq!(fraction(0, 0.5, true), 0.0, "a skipped stage counts as the start");
    }

    /// A stand-in .uexp: the pixel (BGRA) before the 1x1x1 size, after the pixel format's name.
    fn fake_uexp(rgba: [u8; 4]) -> Vec<u8> {
        let [r, g, b, a] = rgba;
        let mut v = vec![7u8; 20];
        v.extend_from_slice(b"PF_B8G8R8A8\0");
        v.extend_from_slice(&[0; 8]);
        v.extend_from_slice(&[b, g, r, a, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
        v.extend_from_slice(&[3; 14]);
        v
    }

    fn planned_at(name: &str, settings: Settings, pixel: [u8; 4]) -> Planned {
        Planned { vfs: format!("Marvel/Content/Marvel/Environment/A/{name}"), pixel, settings }
    }

    #[test]
    fn a_write_cut_short_leaves_the_old_file_and_no_temp() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("T.uasset");
        std::fs::write(&target, "old").unwrap();
        let cut = write_whole(&target, |tmp| { std::fs::write(tmp, "ha")?; Err(std::io::Error::other("cut")) });
        assert!(cut.is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "old");
        assert!(!d.path().join("T.uasset.tmp").exists(), "no temp file left to be packed");
        write_whole(&target, |tmp| std::fs::write(tmp, "new")).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
    }

    #[test]
    fn a_kept_package_takes_a_new_pixel_and_nothing_else() {
        let before = fake_uexp([1, 2, 3, 4]);
        let mut after = before.clone();
        set_pixel(&mut after, [9, 8, 7, 6]).unwrap();
        assert_eq!(pixel_in(&before), Some([1, 2, 3, 4]));
        assert_eq!(pixel_in(&after), Some([9, 8, 7, 6]));
        assert_eq!(after.iter().zip(&before).filter(|(a, b)| a != b).count(), 4, "four bytes changed");
        assert_eq!(after, fake_uexp([9, 8, 7, 6]), "the same as a package written with that pixel");
        assert!(set_pixel(&mut [1, 2, 3], [0; 4]).is_err(), "no pixel, no change");
    }

    #[test]
    fn kept_packages_come_back_with_the_new_pixel_and_the_rest_is_left_to_write() {
        let root = std::env::temp_dir().join(format!("quake-store-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (legacy, store) = (root.join("legacy"), root.join("store"));
        let (plain, normal) = (Settings::default(), Settings::normal());
        // the first build: three packages written, kept
        let first = vec![planned_at("T_One", plain.clone(), [1, 2, 3, 4]), planned_at("T_Two", plain.clone(), [1, 2, 3, 4]), planned_at("T_Three", normal.clone(), [128, 128, 255, 255])];
        for p in &first {
            let rel = p.vfs.trim_end_matches(".uasset");
            std::fs::create_dir_all(legacy.join(rel).parent().unwrap()).unwrap();
            std::fs::write(legacy.join(format!("{rel}.uexp")), fake_uexp(p.pixel)).unwrap();
            std::fs::write(legacy.join(format!("{rel}.uasset")), b"header").unwrap();
        }
        keep_written(&first, &legacy, &store, "build-1", true, Kept::new()).unwrap();
        assert_eq!(load_kept(&store, "build-1").len(), 3);
        assert!(load_kept(&store, "build-2").is_empty(), "another game build keeps nothing");
        // the next build: other colors, T_Two now with other settings, T_Four new, T_Three's kept file gone
        std::fs::remove_file(store.join("Marvel/Content/Marvel/Environment/A/T_Three.uexp")).unwrap();
        let next = vec![
            planned_at("T_One", plain.clone(), [9, 8, 7, 6]),
            planned_at("T_Two", normal.clone(), [128, 128, 255, 255]),
            planned_at("T_Three", normal, [128, 128, 255, 255]),
            planned_at("T_Four", plain, [5, 5, 5, 5]),
        ];
        let again = root.join("again");
        let left = reuse_kept(&next, &load_kept(&store, "build-1"), &store, &again);
        assert_eq!(left, vec![1, 2, 3], "only T_One is reused: the others changed, are gone or are new");
        let one = std::fs::read(again.join("Marvel/Content/Marvel/Environment/A/T_One.uexp")).unwrap();
        assert_eq!(pixel_in(&one), Some([9, 8, 7, 6]));
        assert_eq!(std::fs::read(again.join("Marvel/Content/Marvel/Environment/A/T_One.uasset")).unwrap(), b"header");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_games_settings_are_kept_for_one_game_build() {
        let textures = vec![
            Vanilla { path: "Marvel/Content/Marvel/Environment/A/T_A_N".into(), compression: "TC_Normalmap".into(), lod_group: "TEXTUREGROUP_WorldNormalMap".into(), srgb_off: true },
            Vanilla { path: "Marvel/Content/Marvel/Environment/A/T_B".into(), ..Default::default() },
        ];
        let text = cache_text("build-1", &textures);
        let back = cache_from(&text, "build-1").expect("the same build reads it back");
        assert_eq!(back.len(), 2);
        assert_eq!((back[0].path.as_str(), back[0].compression.as_str(), back[0].lod_group.as_str(), back[0].srgb_off), (textures[0].path.as_str(), "TC_Normalmap", "TEXTUREGROUP_WorldNormalMap", true));
        assert_eq!((back[1].compression.as_str(), back[1].srgb_off), ("", false));
        assert!(cache_from(&text, "build-2").is_none(), "another game build reads nothing");
        assert!(cache_from("not json", "build-1").is_none());
        assert!(cache_from(&cache_text("build-1", &[]), "build-1").is_none(), "an empty list is not a cache");
    }

    /// Rows of quakeV6 (2026-10-26): the game's name and compression, and the pixel V6 gave it.
    #[test]
    fn oracle_rows() {
        let rows = [
            ("T_TokyoE01Building007A_16_N", "TC_Normalmap", "8080ffff"),
            ("T_50070010Component042A_02_MRO", "", "00ffffff"),
            ("T_50070010Component062A_IP_05_ORM_PBR", "", "ffff00ff"),
            ("T_X_ORM", "", "ffff00ff"),
            ("T_X_MRS", "", "00ff00ff"),
            ("T_X_RMA", "", "ff00ffff"),
            ("T_X_Roughness", "", "ffffffff"),
            ("T_X_AO", "", "ffffffff"),
            ("T_50070010Component016A_D_02", "", "5d7a80ff"),
            ("T_ML_Concrete036_New_Basecolor", "", "5d7a80ff"),
            ("T_50080010Modules006A_01_NR", "", "8080ffff"),
            ("T_50160010Grass001A_D", "", "5d7a8080"),
            ("T_ML_Decal_Moss_001_Basecolor", "", "5d7a8000"),
            ("T_50070010Decal016_D", "", "5d7a8000"),
        ];
        for (name, compression, want) in rows {
            assert_eq!(px(name, compression).as_deref(), Some(want), "{name}");
        }
    }

    #[test]
    fn the_game_decides_normal_maps_never_the_name() {
        assert_eq!(classify(&t("T_Rock_MRO", "TC_Normalmap"), true), Kind::Normal, "121 _MRO textures are stored as normal maps");
        assert_eq!(plan(&[t("T_Rock_N", "")], &V6)[0].settings, Settings::default(), "named a normal map, stored as color: its own settings");
        assert_eq!(plan(&[t("T_Rock_N", "TC_Normalmap")], &V6)[0].settings, Settings::normal());
    }

    #[test]
    fn plant_words_start_a_word() {
        for plant in ["T_50160010Grass001A_D", "T_CommonTree015CN_D", "T_Bush_D", "T_sakura_petal_D", "T_ML_Moss002_BaseColor"] {
            assert_eq!(classify(&t(plant, ""), true), Kind::Plant, "{plant}");
        }
        for not in ["T_50180010Seaweed001A_D", "T_TokyoH01StreetLamp01A_D", "T_Treasure_Chest_D"] {
            assert_ne!(classify(&t(not, ""), true), Kind::Plant, "{not}");
        }
        assert_eq!(pixel(Kind::Plant, &Look { hide_plants: true, ..V6 }), Some([0x5d, 0x7a, 0x80, 0x00]), "Hide plants");
    }

    #[test]
    fn channel_codes_are_capitals() {
        assert_eq!(classify(&t("T_Skybox22_Mars", ""), true), Kind::Color, "Mars is a word");
        assert_eq!(classify(&t("T_Rock_mro", ""), true), Kind::Color, "lower case is a word too");
        assert!(matches!(classify(&t("T_Rock_MRO", ""), true), Kind::Mro(_)));
    }

    #[test]
    fn sky_emissive_and_the_lobby() {
        assert_eq!(px("T_KL_S2_BG_02_1", "").as_deref(), Some("82c6edff"), "a background takes the sky color");
        assert_eq!(classify(&Vanilla { lod_group: "TEXTUREGROUP_Skybox".into(), ..t("T_Clouds_A", "") }, true), Kind::Sky);
        assert_eq!(px("T_Neon_E", ""), None, "emissive stays as the game has it");
        let lobby = Vanilla { path: "Marvel/Content/Marvel/Environment/Lobby/2010/2010001402/Texture/T_Wall_D".into(), ..Default::default() };
        assert_eq!(classify(&lobby, false), Kind::Skip, "lobby off");
        assert_eq!(classify(&lobby, true), Kind::Color);
        let common = Vanilla { path: "Marvel/Content/Marvel/Environment/Common/Texture/T_Wall_D".into(), ..Default::default() };
        assert_eq!(classify(&common, false), Kind::Color, "shared textures still change with the lobby off");
    }

    #[test]
    fn colors_parse_and_refuse() {
        assert_eq!(parse_hex("5d7a80"), Some([0x5d, 0x7a, 0x80]));
        assert_eq!(parse_hex(" #82C6ED "), Some([0x82, 0xc6, 0xed]));
        for bad in ["", "5d7a8", "5d7a800", "gg0000", "#5d7a8z"] {
            assert_eq!(parse_hex(bad), None, "{bad}");
        }
        assert!(Options { base: "nope".into(), ..Default::default() }.look().is_err());
        assert_eq!(Options::default().look().unwrap(), Look { base: [0x5d, 0x7a, 0x80], sky: [0x82, 0xc6, 0xed], hide_plants: false, lobby: true });
    }

    #[test]
    fn templates_take_the_path_name_guid_and_pixel() {
        let (plain, normal) = templates().unwrap();
        let v = package_json(&plain, "/Game/Marvel/Environment/A/T_Wall_24", &guid_for("x"), [1, 2, 3, 4], &HashMap::new()).unwrap();
        let text = v.to_string();
        assert!(!text.contains("T_Template"), "no placeholder left");
        assert_eq!(v["FolderName"], "/Game/Marvel/Environment/A/T_Wall_24");
        let names: Vec<&str> = v["NameMap"].as_array().unwrap().iter().filter_map(|n| n.as_str()).collect();
        assert!(names.contains(&"/Game/Marvel/Environment/A/T_Wall") && names.contains(&"T_Wall"), "the name map without the number: {names:?}");
        assert_eq!(v["Exports"][0]["PlatformData"]["Mips"][0]["BulkData"]["Data"], "AQIDBA==");
        assert!(normal.to_string().contains("TC_Normalmap") && !plain.to_string().contains("TC_Normalmap"));
        assert_eq!(guid_for("/Game/A"), guid_for("/game/a"), "the same package, the same GUID");
        assert_eq!(game_path("Marvel/Content/Marvel/Environment/A/T_X"), Some("/Game/Marvel/Environment/A/T_X".into()));
    }

    #[test]
    fn float_textures_stay_as_the_game_has_them() {
        for c in ["TC_HDR", "TC_HDR_Compressed", "TC_HDR_F32", "TC_HalfFloat"] {
            assert_eq!(classify(&t("T_LUT_D", c), true), Kind::Skip, "{c}");
        }
        assert_eq!(classify(&t("T_Wall_Mask", "TC_Masks"), true), Kind::Color, "masks are not float data");
    }

    #[test]
    fn packages_keep_the_games_settings() {
        let (plain, normal) = templates().unwrap();
        let data = |v: &Value| v["Exports"][0]["Data"].as_array().unwrap().iter().map(|p| p["Name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let (v, map) = template_for(&Settings::default(), &plain, &normal);
        assert_eq!(v, plain, "default settings: the plain template");
        assert!(map.is_empty());
        let mro = Settings { compression: String::new(), lod_group: "TEXTUREGROUP_Project04".into(), srgb_off: true };
        let (v, map) = template_for(&mro, &plain, &normal);
        assert_eq!(data(&v), ["ImportedSize", "LightingGuid", "LODGroup", "SRGB"], "no compression setting: not written");
        assert_eq!(map["TEXTUREGROUP_WorldNormalMap"], "TEXTUREGROUP_Project04");
        let masks = Settings { compression: "TC_Masks".into(), lod_group: String::new(), srgb_off: false };
        let (v, map) = template_for(&masks, &plain, &normal);
        assert_eq!(data(&v), ["ImportedSize", "LightingGuid", "CompressionSettings"]);
        let json = package_json(&v, "/Game/Marvel/Environment/A/T_Wall_Mask", &guid_for("x"), [0; 4], &map).unwrap();
        assert!(json.to_string().contains("TC_Masks") && !json.to_string().contains("\"TC_Normalmap\""), "the game's value replaces the template's");
        let planned = plan(&[Vanilla { srgb_off: true, lod_group: "TEXTUREGROUP_Project04".into(), ..t("T_Rock_MRO", "") }, t("T_Rock_N", "TC_Normalmap")], &V6);
        assert_eq!(planned[0].settings, mro);
        assert_eq!(planned[1].settings, Settings::normal(), "normal maps as the game's normal maps");
    }

    #[test]
    fn a_texture_that_was_not_read_stops_the_build() {
        let listed = vec!["Marvel/Content/Marvel/Environment/A/T_X".to_string(), "Marvel/Content/Marvel/Environment/A/T_Y".to_string()];
        let read = |p: &str| Vanilla { path: p.into(), ..Default::default() };
        assert!(all_read(&listed, &[read(&listed[0]), read(&listed[1])]).is_ok());
        let e = all_read(&listed, &[read(&listed[0])]).unwrap_err();
        assert!(e.starts_with(MAPPINGS_BEHIND) && e.ends_with("(1 of the game's 2 map textures could not be read, first: T_Y)"), "{e}");
        assert!(all_read(&listed, &[read(&listed[0]), read(&listed[0]), read(&listed[1])]).is_err(), "read twice");
    }

    #[test]
    fn settings_read_from_either_enum_form() {
        let game = serde_json::json!({ "Exports": [{ "$type": "UAssetAPI.ExportTypes.Texture.TextureExport, UAssetAPI", "Data": [
            { "Name": "CompressionSettings", "EnumType": "TextureCompressionSettings", "Value": "TC_Normalmap" },
            { "Name": "LODGroup", "EnumType": "TextureGroup", "Value": "TEXTUREGROUP_WorldNormalMap" } ] }] });
        let byte = serde_json::json!({ "Exports": [{ "$type": "UAssetAPI.ExportTypes.Texture.TextureExport, UAssetAPI", "Data": [
            { "Name": "CompressionSettings", "EnumValue": "TC_Normalmap" } ] }] });
        assert_eq!(vanilla_of("A", &game).unwrap().compression, "TC_Normalmap", "the game's own textures (EnumPropertyData)");
        assert_eq!(vanilla_of("A", &game).unwrap().lod_group, "TEXTUREGROUP_WorldNormalMap");
        assert_eq!(vanilla_of("A", &byte).unwrap().compression, "TC_Normalmap", "a byte property naming the enum");
        assert!(vanilla_of("A", &serde_json::json!({ "Exports": [{ "$type": "UAssetAPI.ExportTypes.NormalExport" }] })).is_none(), "not a texture");
    }

    #[test]
    fn names_split_their_numbers_as_the_engine_does() {
        assert_eq!(fname_base("T_X_10"), "T_X");
        assert_eq!(fname_base("T_X_02"), "T_X_02", "a leading zero stays");
        assert_eq!(fname_base("T_X_0"), "T_X");
        assert_eq!(fname_base("T_X"), "T_X");
        assert_eq!(fname_base("T_X_99999999999"), "T_X_99999999999", "too big for a number");
    }

    #[test]
    fn the_two_writer_fixes() {
        // a 30-byte tail: SkipOffset at 2 (8 bytes), 8 bytes of data, the None name (8), the tag (4)
        let mut b = vec![0u8; 30];
        let end = b.len() - 12;
        b[2..10].copy_from_slice(&((end - 2 - 8) as i64).to_le_bytes());
        fix_skip_offset(&mut b).unwrap();
        assert_eq!(i64::from_le_bytes(b[2..10].try_into().unwrap()), (end - 2) as i64, "measured from the field's start");
        let again = b.clone();
        fix_skip_offset(&mut b).unwrap();
        assert_eq!(b, again, "already right: left alone");
        let names: Vec<String> = ["Guid", "None", "/Game/X", "X", "/Script/CoreUObject", "Package"].map(String::from).to_vec();
        let mut h = vec![9u8, 9, 6, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 7];
        fix_names_referenced(&mut h, &names).unwrap();
        assert_eq!(&h[2..6], &4i32.to_le_bytes(), "the names before /Script/CoreUObject");
        assert_eq!(group_digits(27181), "27,181");
        assert_eq!(group_digits(999), "999");
    }
    fn read_json(p: &std::path::Path) -> Value {
        serde_json::from_str(std::fs::read_to_string(p).unwrap().trim_start_matches('\u{feff}')).unwrap()
    }

    /// Byte ranges where a and b differ, as "start..end", plus a length note.
    fn diff_ranges(a: &[u8], b: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        let mut i = 0;
        let n = a.len().min(b.len());
        while i < n {
            if a[i] != b[i] {
                let s = i;
                while i < n && a[i] != b[i] {
                    i += 1;
                }
                out.push(format!("{s}..{i}"));
            } else {
                i += 1;
            }
        }
        if a.len() != b.len() {
            out.push(format!("length {} vs {}", a.len(), b.len()));
        }
        out
    }

    /// S2: REPAKXTRA_QUAKE_ORACLE=<legacy extract of a quake mod> REPAKXTRA_QUAKE_ORACLE_JSON=<its JSON> REPAKXTRA_USMAP=<usmap>
    /// cargo test -p repak-x --bin REPAK-X s2_write -- --ignored --nocapture. For each package shape (uexp size), one
    /// template writes ten other packages of that shape, which are compared byte for byte with the mod's own.
    #[test]
    #[ignore]
    fn s2_write() {
        let oracle = std::path::PathBuf::from(std::env::var("REPAKXTRA_QUAKE_ORACLE").unwrap());
        let ojson = std::path::PathBuf::from(std::env::var("REPAKXTRA_QUAKE_ORACLE_JSON").unwrap());
        let usmap = std::env::var("REPAKXTRA_USMAP").unwrap();
        let work = std::env::temp_dir().join("quake-s2");
        let _ = std::fs::remove_dir_all(&work);
        let mut by_shape: std::collections::BTreeMap<u64, Vec<std::path::PathBuf>> = Default::default();
        for e in walkdir::WalkDir::new(&oracle).into_iter().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "uexp")) {
            by_shape.entry(e.metadata().unwrap().len()).or_default().push(e.path().to_path_buf());
        }
        uasset_toolkit::init_global_toolkit().expect("toolkit");
        let mut cases = Vec::new();
        for (size, list) in &by_shape {
            let rel = |p: &std::path::Path| p.strip_prefix(&oracle).unwrap().with_extension("");
            // the mod's mount folder (quakeV6/Content/...) as the game's (Marvel/Content/...)
            let mounted = |r: &std::path::Path| std::path::PathBuf::from("Marvel").join(r.components().skip(1).collect::<std::path::PathBuf>());
            let (plain, normal) = templates().unwrap();
            let template = if *size > 300 { normal } else { plain };
            // ten others spread over the list
            for p in list.iter().step_by((list.len() / 10).max(1)).take(10) {
                let own = read_json(&ojson.join(rel(p)).with_extension("json"));
                let path = own["FolderName"].as_str().unwrap().to_string();
                let data = &own["Exports"][0]["Data"];
                let guid = data.as_array().unwrap().iter().find(|x| x["Name"] == "LightingGuid").unwrap()["Value"][0]["Value"].as_str().unwrap().to_string();
                let px = base64::engine::general_purpose::STANDARD.decode(own["Exports"][0]["PlatformData"]["Mips"][0]["BulkData"]["Data"].as_str().unwrap()).unwrap();
                let mut more = HashMap::new();
                let lod = |v: &Value| v["Exports"][0]["Data"].as_array().unwrap().iter().find(|x| x["Name"] == "LODGroup").and_then(|x| x["EnumValue"].as_str()).map(str::to_string);
                if let (Some(a), Some(b)) = (lod(&template), lod(&own)) {
                    more.insert(a, b);
                }
                let v = package_json(&template, &path, &guid, [px[0], px[1], px[2], px[3]], &more).unwrap();
                let out = work.join("json").join(mounted(&rel(p))).with_extension("json");
                std::fs::create_dir_all(out.parent().unwrap()).unwrap();
                std::fs::write(&out, serde_json::to_string(&v).unwrap()).unwrap();
                cases.push((*size, rel(p)));
            }
        }
        let files: Vec<String> = walkdir::WalkDir::new(work.join("json")).into_iter().flatten().filter(|e| e.path().is_file()).map(|e| e.path().to_string_lossy().replace('\\', "/")).collect();
        let req = serde_json::json!({ "action": "batch_from_json", "file_paths": files, "usmap_path": usmap, "output_path": work.join("legacy").to_string_lossy(), "base_path": work.join("json").to_string_lossy() });
        let r = uasset_toolkit::invoke_json(&req.to_string()).expect("from json");
        println!("from_json: {}", &r[..r.len().min(200)]);
        let mounted = |r: &std::path::Path| std::path::PathBuf::from("Marvel").join(r.components().skip(1).collect::<std::path::PathBuf>());
        for (_, rel) in &cases {
            let p = work.join("legacy").join(mounted(rel)).with_extension("uexp");
            let mut b = std::fs::read(&p).unwrap();
            fix_skip_offset(&mut b).unwrap();
            std::fs::write(&p, b).unwrap();
            let names: Vec<String> = read_json(&work.join("json").join(mounted(rel)).with_extension("json"))["NameMap"].as_array().unwrap().iter().map(|n| n.as_str().unwrap().to_string()).collect();
            let p = p.with_extension("uasset");
            let mut b = std::fs::read(&p).unwrap();
            fix_names_referenced(&mut b, &names).unwrap();
            std::fs::write(&p, b).unwrap();
        }
        // packed into IoStore (what the game reads) and extracted again by the same converter that read the mod
        let tool = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/uassettool/UAssetTool.dll");
        let base = work.join("io").join("gen_9999999_P");
        std::fs::create_dir_all(work.join("io")).unwrap();
        tauri::async_runtime::block_on(crate::vfx_updater::uasset_tool::pack_to_iostore(&tool, &usmap, &work.join("legacy").to_string_lossy(), &base.to_string_lossy(), None, &crate::vfx_updater::progress::NoOpProgressSink)).expect("pack");
        let paks = std::env::var("REPAKXTRA_PAKS").expect("REPAKXTRA_PAKS");
        let cli = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/uassettool-cli/UAssetTool.exe");
        let o = std::process::Command::new(&cli).args(["extract_iostore_legacy", &paks, work.join("back").to_str().unwrap(), "--mod", base.with_extension("utoc").to_str().unwrap()]).output().unwrap();
        println!("read back: {}", String::from_utf8_lossy(&o.stdout).lines().last().unwrap_or(""));
        let (mut same, mut total) = (0, 0);
        for (size, rel) in cases {
            for ext in ["uasset", "uexp"] {
                let a = std::fs::read(oracle.join(&rel).with_extension(ext)).unwrap();
                let b = std::fs::read(work.join("back").join(mounted(&rel)).with_extension(ext)).unwrap_or_default();
                let d = diff_ranges(&a, &b);
                total += 1;
                if d.is_empty() {
                    same += 1;
                }
                println!("{size} {ext:6} {} {}", if d.is_empty() { "SAME".to_string() } else { format!("DIFF {d:?}") }, rel.display());
            }
        }
        println!("S2: {same} of {total} files byte for byte the same after packing and reading back");
    }

    /// read_settings on real game textures (a spread of 2,000 rows of the S1 props TSV, which was read with their pixel data):
    /// REPAKXTRA_QUAKE_GAME=<props TSV> REPAKXTRA_USMAP=<usmap> REPAKXTRA_PAKS=<Paks folder> cargo test -p repak-x --bin REPAK-X
    /// real_read -- --ignored --nocapture. The settings must be the TSV's, whatever the extract leaves out.
    #[test]
    #[ignore]
    fn real_read() {
        let tsv = std::fs::read_to_string(std::env::var("REPAKXTRA_QUAKE_GAME").unwrap()).unwrap();
        let (usmap, paks) = (std::env::var("REPAKXTRA_USMAP").unwrap(), std::env::var("REPAKXTRA_PAKS").unwrap());
        let mut want: Vec<Vanilla> = tsv
            .lines()
            .step_by(std::env::var("REPAKXTRA_READ_STEP").ok().and_then(|v| v.parse().ok()).unwrap_or(16))
            .take(std::env::var("REPAKXTRA_READ_N").ok().and_then(|v| v.parse().ok()).unwrap_or(2000))
            .map(|l| {
                let f: Vec<&str> = l.split('\t').collect();
                Vanilla { path: f[0].to_string(), compression: f[1].to_string(), lod_group: f[2].to_string(), srgb_off: f[3] == "false" }
            })
            .collect();
        let listed: Vec<String> = want.iter().map(|t| t.path.clone()).collect();
        let work = std::env::temp_dir().join("quake-real-read");
        let _ = std::fs::remove_dir_all(&work);
        struct Say;
        impl log::Log for Say {
            fn enabled(&self, _: &log::Metadata) -> bool {
                true
            }
            fn log(&self, r: &log::Record) {
                if r.target().contains("xtra_quake") {
                    println!("{}", r.args());
                }
            }
            fn flush(&self) {}
        }
        let _ = log::set_logger(&Say).map(|()| log::set_max_level(log::LevelFilter::Info));
        uasset_toolkit::init_global_toolkit().expect("toolkit");
        let rt = tokio::runtime::Runtime::new().unwrap();
        let t = std::time::Instant::now();
        let mut got = rt.block_on(read_settings(Path::new("."), &usmap, Path::new(&paks), &listed, &work, || false)).unwrap();
        println!("{} textures read in {:.1} s", got.len(), t.elapsed().as_secs_f32());
        want.sort_by(|a, b| a.path.cmp(&b.path));
        got.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(got.len(), want.len());
        let wrong: Vec<&str> = got.iter().zip(&want).filter(|(g, w)| (&g.path, &g.compression, &g.lod_group, g.srgb_off) != (&w.path, &w.compression, &w.lod_group, w.srgb_off)).map(|(g, _)| g.path.as_str()).collect();
        assert!(wrong.is_empty(), "{} differ from the TSV, first {:?}", wrong.len(), wrong.first());
        let _ = std::fs::remove_dir_all(&work);
    }

    /// The build's write, fix and check steps on real texture settings (every 27th row of the S1 props TSV), in chunks:
    /// REPAKXTRA_QUAKE_GAME=<props TSV> REPAKXTRA_USMAP=<usmap> cargo test -p repak-x --bin REPAK-X real_write -- --ignored --nocapture.
    /// Prints the time per step, to set the stage shares and to see what a whole game would take.
    #[test]
    #[ignore]
    fn real_write() {
        let tsv = std::fs::read_to_string(std::env::var("REPAKXTRA_QUAKE_GAME").unwrap()).unwrap();
        let usmap = std::env::var("REPAKXTRA_USMAP").unwrap();
        let textures: Vec<Vanilla> = tsv
            .lines()
            .step_by(27)
            .map(|l| {
                let f: Vec<&str> = l.split('\t').collect();
                Vanilla { path: f[0].to_string(), compression: f[1].to_string(), lod_group: f[2].to_string(), srgb_off: f[3] == "false" }
            })
            .collect();
        let planned = std::sync::Arc::new(plan(&textures, &Look { base: [0x5d, 0x7a, 0x80], sky: [0x82, 0xc6, 0xed], hide_plants: false, lobby: true }));
        let work = std::env::temp_dir().join("quake-real-write");
        let _ = std::fs::remove_dir_all(&work);
        let (json, legacy) = (work.join("json"), work.join("mod"));
        uasset_toolkit::init_global_toolkit().expect("toolkit");
        let rt = tokio::runtime::Runtime::new().unwrap();
        let t = std::time::Instant::now();
        rt.block_on(write_packages(Path::new("."), &usmap, &planned, &json, &legacy, std::env::var("REPAKXTRA_CHUNK").ok().and_then(|c| c.parse().ok()).unwrap_or(400), false, || false)).unwrap();
        let wrote = t.elapsed();
        fix_written(&planned, &legacy, &json).unwrap();
        let fixed = t.elapsed();
        check_all(&planned, &legacy).unwrap();
        println!("{} packages: write {:.1} s, fix {:.1} s, check {:.1} s", planned.len(), wrote.as_secs_f32(), (fixed - wrote).as_secs_f32(), (t.elapsed() - fixed).as_secs_f32());
        // a rebuild for other colors from the kept packages must equal packages written again with those colors
        let store = work.join("store");
        keep_written(&planned, &legacy, &store, "real", true, Kept::new()).unwrap();
        let other = std::sync::Arc::new(plan(&textures, &Look { base: [0x33, 0x66, 0x99], sky: [0xff, 0x00, 0xff], hide_plants: true, lobby: true }));
        let reused = work.join("reused");
        let t = std::time::Instant::now();
        let left = reuse_kept(&other, &load_kept(&store, "real"), &store, &reused);
        println!("reused {} of {} in {:.1} s", other.len() - left.len(), other.len(), t.elapsed().as_secs_f32());
        assert!(left.is_empty(), "every package is kept");
        check_all(&other, &reused).unwrap();
        let (json2, fresh) = (work.join("json2"), work.join("fresh"));
        rt.block_on(write_packages(Path::new("."), &usmap, &other, &json2, &fresh, 2000, false, || false)).unwrap();
        fix_written(&other, &fresh, &json2).unwrap();
        let mut different = 0;
        for p in other.iter() {
            let rel = p.vfs.trim_end_matches(".uasset");
            for ext in ["uasset", "uexp"] {
                if std::fs::read(reused.join(format!("{rel}.{ext}"))).unwrap() != std::fs::read(fresh.join(format!("{rel}.{ext}"))).unwrap() {
                    different += 1;
                }
            }
        }
        assert_eq!(different, 0, "reused files are byte for byte the files written again");
        println!("{} packages reused with new colors, all byte for byte the same as written again", other.len());
        let _ = std::fs::remove_dir_all(&work);
    }

    /// S3: REPAKXTRA_QUAKE_GAME=<S1 props TSV> REPAKXTRA_QUAKE_PIXELS=<oracle pixels TSV> cargo test -p repak-x --bin REPAK-X
    /// s3_rules -- --ignored --nocapture. Classifies every game texture and compares the pixel with the oracle's.
    #[test]
    #[ignore]
    fn s3_rules() {
        let game_tsv = std::fs::read_to_string(std::env::var("REPAKXTRA_QUAKE_GAME").unwrap()).unwrap();
        let px_tsv = std::fs::read_to_string(std::env::var("REPAKXTRA_QUAKE_PIXELS").unwrap()).unwrap();
        let key = |p: &str| p.split_once('/').map_or(p, |x| x.1).to_ascii_lowercase();
        let oracle: HashMap<String, String> = px_tsv.lines().filter_map(|l| { let f: Vec<&str> = l.split('\t').collect(); Some((key(f.first()?), f.get(2)?.to_string())) }).collect();
        let base = parse_hex(&std::env::var("REPAKXTRA_QUAKE_BASE").unwrap_or("5d7a80".into())).unwrap();
        let sky = parse_hex(&std::env::var("REPAKXTRA_QUAKE_SKY").unwrap_or("5d7a80".into())).unwrap();
        let look = Look { base, sky, hide_plants: false, lobby: true };
        let name = |k: Kind| match k { Kind::Mro(_) => "Mro".to_string(), k => format!("{k:?}") };
        // by predicted kind: count, agree, disagree samples; by the oracle's pixel: how many we match
        let mut by_kind: std::collections::BTreeMap<String, (usize, usize, Vec<String>)> = Default::default();
        let mut by_oracle: std::collections::BTreeMap<String, (usize, usize)> = Default::default();
        let (mut ours_only, mut oracle_only) = (0, 0);
        let mut seen = std::collections::HashSet::new();
        let mut all_kinds: std::collections::BTreeMap<String, usize> = Default::default();
        let mut kinds_out = String::new();
        for line in game_tsv.lines() {
            let f: Vec<&str> = line.split('\t').collect();
            let t = Vanilla { path: f[0].to_string(), compression: f[1].to_string(), lod_group: f[2].to_string(), srgb_off: f[3] == "false" };
            let kind = classify(&t, true);
            *all_kinds.entry(name(kind)).or_insert(0usize) += 1;
            kinds_out += &format!("{}	{}
", f[0], name(kind));
            let ours = pixel(kind, &look).map(|p| p.iter().map(|b| format!("{b:02x}")).collect::<String>());
            let k = key(f[0]);
            seen.insert(k.clone());
            match (ours, oracle.get(&k)) {
                (Some(o), Some(theirs)) => {
                    let e = by_kind.entry(name(kind)).or_default();
                    e.0 += 1;
                    if &o == theirs { e.1 += 1 } else if e.2.len() < 10 { e.2.push(format!("{} ours {o} oracle {theirs} ({} {})", f[0].rsplit('/').next().unwrap(), f[1], f[5])); }
                    let r = by_oracle.entry(theirs.clone()).or_default();
                    r.0 += 1;
                    if &o == theirs { r.1 += 1 }
                }
                (Some(_), None) => ours_only += 1,
                (None, Some(theirs)) => { oracle_only += 1; by_oracle.entry(theirs.clone()).or_default().0 += 1; by_kind.entry(format!("{} (left out)", name(kind))).or_default().0 += 1; }
                (None, None) => {}
            }
        }
        println!("by our kind: count both cover, agree, disagree");
        for (k, (n, ok, bad)) in &by_kind {
            println!("{k:16} {n:6} {ok:6} {:6}  {:.2}%", n - ok, if *n > 0 { *ok as f64 * 100.0 / *n as f64 } else { 0.0 });
            for b in bad { println!("      {b}"); }
        }
        println!("by the oracle's pixel: count, we match");
        for (px, (n, ok)) in &by_oracle { println!("  {px} {n:6} {ok:6}"); }
        println!("every game texture by our kind: {all_kinds:?}");
        if let Ok(p) = std::env::var("REPAKXTRA_QUAKE_KINDS_OUT") {
            std::fs::write(p, &kinds_out).unwrap();
        }
        println!("we write but the oracle leaves alone: {ours_only}. The oracle covers but we leave alone: {oracle_only}. Oracle packages not in this game: {}", oracle.keys().filter(|k| !seen.contains(*k)).count());
    }
}
