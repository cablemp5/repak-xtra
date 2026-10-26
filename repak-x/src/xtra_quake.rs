//! repakxtra: CustomQuake, a built-in (xtra_builtins.rs) that flattens every map texture to one chosen color, the "Quake"
//! look. Everything comes from the installed game at build time, no mod's files or package lists ship with the app:
//! 1. list the game's Environment textures (the command line's list_iostore --type Texture2D),
//! 2. read each one's settings in batches (extract without its pixel data, the library's to_json), deleting each batch,
//! 3. classify each (classify: the game's compression, then the name) and give it a pixel (pixel, from the options),
//! 4. write a 1x1 package per texture from one of two templates (resources/quake/), put right the two fields UAssetTool
//!    writes differently from the cooker (fix_skip_offset, fix_names_referenced), check every package, then pack.
//! The rules were measured against quakeV6 on 2026-10-26 (ignored tests below, docs kept outside the repo): normal maps
//! 99.89%, channel-packed 99.91% and color 99.31% of its textures get the same pixel.

use std::collections::HashMap;
use std::path::Path;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest;

/// The saved options (Settings of the built-in's card). A change rebuilds.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// hex RGB, "5d7a80"
    pub base: String,
    pub sky: String,
    pub hide_plants: bool,
    /// the lobby, MVP and showcase scenes too
    pub lobby: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { base: "5d7a80".into(), sky: "82c6ed".into(), hide_plants: false, lobby: true }
    }
}

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
    /// /Game/Marvel/Environment/.../T_Name (or Marvel/Content/...)
    pub path: String,
    /// CompressionSettings, empty when the game leaves it at the default
    pub compression: String,
    pub lod_group: String,
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

/// One package to write: where (as the game lists it), which shape, which pixel (RGBA).
#[derive(Debug, Clone, PartialEq)]
pub struct Planned {
    pub vfs: String,
    pub normal_shape: bool,
    pub pixel: [u8; 4],
}

/// Every texture that changes, with its pixel. The shape follows the game's own compression setting.
pub fn plan(textures: &[Vanilla], look: &Look) -> Vec<Planned> {
    textures
        .iter()
        .filter_map(|t| {
            let px = pixel(classify(t, look.lobby), look)?;
            Some(Planned { vfs: t.path.clone(), normal_shape: t.compression.eq_ignore_ascii_case("TC_Normalmap"), pixel: px })
        })
        .collect()
}

/// Writes the JSON of each planned package under `dir` (its game path), ready for UAssetTool's batch_from_json.
fn write_jsons(planned: &[Planned], dir: &std::path::Path) -> Result<Vec<String>, String> {
    let (plain, normal) = templates()?;
    let none = HashMap::new();
    planned
        .iter()
        .map(|p| {
            let path = game_path(&p.vfs).ok_or_else(|| format!("{} is not under a Content folder", p.vfs))?;
            let [r, g, b, a] = p.pixel;
            let v = package_json(if p.normal_shape { &normal } else { &plain }, &path, &guid_for(&path), [b, g, r, a], &none)?;
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
    for p in planned {
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
        std::fs::write(&uasset, b).map_err(|e| e.to_string())?;
    }
    Ok(())
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

/// Batches of settings read at a time: a batch of 500 textures takes about 90 MB on disk once its pixel data is gone.
const BATCH: usize = 500;

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

/// The game's settings for one texture from its JSON (to_json of the game's package). None when it is not a texture.
fn vanilla_of(vfs: &str, json: &Value) -> Option<Vanilla> {
    let ex = json["Exports"].as_array()?.iter().find(|e| e["$type"].as_str().is_some_and(|t| t.contains("TextureExport")))?;
    let prop = |name: &str| {
        // an enum property keeps its value in Value, a byte property naming an enum in EnumValue
        ex["Data"].as_array().and_then(|d| d.iter().find(|p| p["Name"] == name)).and_then(|p| p["EnumValue"].as_str().or(p["Value"].as_str())).unwrap_or_default().to_string()
    };
    Some(Vanilla { path: vfs.to_string(), compression: prop("CompressionSettings"), lod_group: prop("LODGroup") })
}

/// Reads the settings of every listed texture, `BATCH` at a time, each batch deleted before the next.
async fn read_settings(tool: &Path, usmap: &str, paks: &Path, listed: &[String], work: &Path) -> Result<Vec<Vanilla>, String> {
    let sink = crate::vfx_updater::progress::NoOpProgressSink;
    let mut all = Vec::with_capacity(listed.len());
    for batch in listed.chunks(BATCH) {
        let (legacy, json) = (work.join("legacy"), work.join("json"));
        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&json);
        // without their dependencies: a texture imports only engine classes
        crate::vfx_updater::uasset_tool::extract_vanilla_assets_split(tool, &paks.to_string_lossy(), &legacy.to_string_lossy(), batch, batch, &sink).await?;
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
        for e in walkdir::WalkDir::new(&json).into_iter().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "json")) {
            let rel = e.path().strip_prefix(&json).map_err(|e| e.to_string())?.with_extension("").to_string_lossy().replace('\\', "/");
            let text = std::fs::read_to_string(e.path()).map_err(|e| e.to_string())?;
            let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("{rel}: {e}"))?;
            all.extend(vanilla_of(&rel, &v));
        }
    }
    let _ = std::fs::remove_dir_all(work.join("legacy"));
    let _ = std::fs::remove_dir_all(work.join("json"));
    Ok(all)
}

/// The pixel a written package holds (RGBA), from its .uexp: a 1x1 BGRA8 mip, its four bytes before the 1x1x1 size.
fn pixel_in(uexp: &[u8]) -> Option<[u8; 4]> {
    const ONE: [u8; 12] = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    let tag = b"PF_B8G8R8A8\0";
    uexp.windows(tag.len()).position(|w| w == tag)?;
    let at = uexp.windows(16).rposition(|w| w[4..] == ONE)?;
    let [b, g, r, a] = uexp[at..at + 4].try_into().ok()?;
    Some([r, g, b, a])
}

/// Every planned package is under `dir` with its planned pixel and a SkipOffset as the cooker writes it.
fn check_all(planned: &[Planned], dir: &Path) -> Result<(), String> {
    let written = walkdir::WalkDir::new(dir).into_iter().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "uasset")).count();
    if written != planned.len() {
        return Err(format!("{written} packages were written for {} planned", planned.len()));
    }
    for p in planned {
        let rel = p.vfs.trim_end_matches(".uasset");
        let b = std::fs::read(dir.join(format!("{rel}.uexp"))).map_err(|e| format!("{rel}: {e}"))?;
        if pixel_in(&b) != Some(p.pixel) {
            return Err(format!("{rel} does not hold its planned color"));
        }
        let mut c = b.clone();
        if fix_skip_offset(&mut c).is_err() || c != b {
            return Err(format!("{rel} would point the game at the wrong place"));
        }
    }
    Ok(())
}

/// Builds CustomQuake into `out_base` (.pak, .utoc, .ucas). Every package is checked before packing and again after it
/// is read back out of the container, so nothing reaches the game unless all of it is right. Returns the summary.
pub async fn make(tool: &Path, usmap: &str, paks: &Path, work: &Path, out_base: &Path, options: &Options) -> Result<String, String> {
    let look = options.look()?;
    let started = std::time::Instant::now();
    let listed = tokio::task::spawn_blocking({
        let paks = paks.to_path_buf();
        move || list_textures(&paks)
    })
    .await
    .map_err(|e| e.to_string())??;
    let textures = read_settings(tool, usmap, paks, &listed, &work.join("read")).await?;
    let planned = plan(&textures, &look);
    if planned.is_empty() {
        return Err("No map texture to change".into());
    }
    let (json, legacy) = (work.join("json"), work.join("mod"));
    let files = write_jsons(&planned, &json)?;
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
    fix_written(&planned, &legacy, &json)?;
    check_all(&planned, &legacy).map_err(|e| format!("{e}, so nothing was installed"))?;
    let _ = std::fs::remove_dir_all(&json);
    let sink = crate::vfx_updater::progress::NoOpProgressSink;
    crate::vfx_updater::uasset_tool::pack_to_iostore(tool, usmap, &legacy.to_string_lossy(), &out_base.to_string_lossy(), None, &sink).await?;
    // read back out of the container, as the game will see it
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
    check_all(&planned, &back).map_err(|e| format!("{e} in the packed container, so nothing was installed"))?;
    let mins = started.elapsed().as_secs_f64() / 60.0;
    Ok(format!("{} textures set in {}", group_digits(planned.len()), if mins < 1.5 { "about a minute".to_string() } else { format!("{} minutes", mins.round()) }))
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

/// Mods that are on and change at least 1,000 map files (another quake mod): the game shows only one of them where they
/// overlap. Their file lists come from the conflict check's cache.
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
            out.push(crate::xtra_bundle::stem(&p.file_name().unwrap_or_default().to_string_lossy()).to_string());
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(name: &str, compression: &str) -> Vanilla {
        Vanilla { path: format!("Marvel/Content/Marvel/Environment/Tokyo/TokyoE01/Tex/{name}"), compression: compression.into(), lod_group: String::new() }
    }
    const V6: Look = Look { base: [0x5d, 0x7a, 0x80], sky: [0x82, 0xc6, 0xed], hide_plants: false, lobby: true };
    fn px(name: &str, compression: &str) -> Option<String> {
        pixel(classify(&t(name, compression), true), &V6).map(|p| p.iter().map(|b| format!("{b:02x}")).collect())
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
        assert_eq!(plan(&[t("T_Rock_N", "")], &V6)[0].normal_shape, false, "named a normal map, stored as color: its own settings");
        assert_eq!(plan(&[t("T_Rock_N", "TC_Normalmap")], &V6)[0].normal_shape, true);
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
    fn dir_size(d: &std::path::Path) -> u64 {
        walkdir::WalkDir::new(d).into_iter().flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()
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
            let t = Vanilla { path: f[0].to_string(), compression: f[1].to_string(), lod_group: f[2].to_string() };
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

    /// S4: REPAKXTRA_PAKS=<Paks> REPAKXTRA_USMAP=<usmap> REPAKXTRA_QUAKE_GAME=<S1 props TSV> cargo test -p repak-x --bin
    /// REPAK-X s4_pack -- --ignored --nocapture. Writes 1,000 packages from the plan, packs them into IoStore, lists the
    /// container, extracts it again and checks each package's pixel.
    #[test]
    #[ignore]
    fn s4_pack() {
        let paks = std::env::var("REPAKXTRA_PAKS").unwrap();
        let usmap = std::env::var("REPAKXTRA_USMAP").unwrap();
        let game: Vec<Vanilla> = std::fs::read_to_string(std::env::var("REPAKXTRA_QUAKE_GAME").unwrap()).unwrap().lines().map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            Vanilla { path: f[0].to_string(), compression: f[1].to_string(), lod_group: f[2].to_string() }
        }).collect();
        let look = Look { base: parse_hex("5d7a80").unwrap(), sky: parse_hex("82c6ed").unwrap(), hide_plants: true, lobby: true };
        let all = plan(&game, &look);
        let planned: Vec<Planned> = all.iter().step_by(all.len() / 1000).take(1000).cloned().collect();
        let work = std::env::temp_dir().join("quake-s4");
        let _ = std::fs::remove_dir_all(&work);
        let t = std::time::Instant::now();
        uasset_toolkit::init_global_toolkit().unwrap();
        let files = write_jsons(&planned, &work.join("json")).unwrap();
        let req = serde_json::json!({ "action": "batch_from_json", "file_paths": files, "usmap_path": usmap, "output_path": work.join("legacy").to_string_lossy(), "base_path": work.join("json").to_string_lossy() });
        let r = uasset_toolkit::invoke_json(&req.to_string()).unwrap();
        assert!(r.contains("\"success\":true"), "{r}");
        fix_written(&planned, &work.join("legacy"), &work.join("json")).unwrap();
        let written = t.elapsed();
        let tool = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/uassettool/UAssetTool.dll");
        let base = work.join("io").join("repakxtra-custom-quake_9999999_P");
        std::fs::create_dir_all(work.join("io")).unwrap();
        let t = std::time::Instant::now();
        tauri::async_runtime::block_on(crate::vfx_updater::uasset_tool::pack_to_iostore(&tool, &usmap, &work.join("legacy").to_string_lossy(), &base.to_string_lossy(), None, &crate::vfx_updater::progress::NoOpProgressSink)).unwrap();
        let packed = t.elapsed();
        let size: u64 = ["pak", "utoc", "ucas"].iter().filter_map(|e| std::fs::metadata(base.with_extension(e)).ok()).map(|m| m.len()).sum();
        let listed: Vec<String> = crate::utoc_utils::try_read_utoc(&base.with_extension("utoc")).unwrap().into_iter().map(|e| e.file_path).filter(|f| f.ends_with(".uasset")).collect();
        let cli = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/uassettool-cli/UAssetTool.exe");
        let o = std::process::Command::new(&cli).args(["extract_iostore_legacy", &paks, work.join("back").to_str().unwrap(), "--mod", base.with_extension("utoc").to_str().unwrap()]).output().unwrap();
        assert!(o.status.success());
        let mut ok = 0;
        for p in &planned {
            let b = std::fs::read(work.join("back").join(format!("{}.uexp", p.vfs))).unwrap_or_default();
            let tag = b"PF_B8G8R8A8\0";
            let at = b.windows(tag.len()).position(|w| w == tag);
            // a 1x1 BGRA8 texture, its SkipOffset as the cooker writes it, and the planned pixel before the 1x1x1 size
            let mut c = b.clone();
            let found = fix_skip_offset(&mut c).is_ok() && c == b;
            let [r, g, bl, a] = p.pixel;
            let bgra = [bl, g, r, a];
            if found && at.is_some() && b.windows(16).any(|w| w[..4] == bgra && w[4..] == [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]) {
                ok += 1;
            }
        }
        println!("S4: {} planned of {} in the plan, written in {written:?}, packed in {packed:?}, {} bytes, utoc lists {} packages, {ok} read back with their pixel", planned.len(), all.len(), size, listed.len());
    }

    /// S1 full run: REPAKXTRA_PAKS=<Paks> REPAKXTRA_USMAP=<usmap> REPAKXTRA_QUAKE_LIST=<txt of package paths> cargo test -p
    /// repak-x --bin REPAK-X s1_full -- --ignored --nocapture. Extracts in batches (the CLI, a fresh game load each time),
    /// reads each texture's properties in process, deletes the batch, and writes a TSV beside the list.
    #[test]
    #[ignore]
    fn s1_full() {
        let paks = std::env::var("REPAKXTRA_PAKS").expect("REPAKXTRA_PAKS");
        let usmap = std::env::var("REPAKXTRA_USMAP").expect("REPAKXTRA_USMAP");
        let list = std::path::PathBuf::from(std::env::var("REPAKXTRA_QUAKE_LIST").expect("REPAKXTRA_QUAKE_LIST"));
        let batch: usize = std::env::var("REPAKXTRA_QUAKE_BATCH").ok().and_then(|b| b.parse().ok()).unwrap_or(1000);
        let cli = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/uassettool-cli/UAssetTool.exe");
        let paths: Vec<String> = std::fs::read_to_string(&list).unwrap().lines().map(str::to_string).filter(|l| !l.is_empty()).collect();
        let work = std::env::temp_dir().join("quake-s1-full");
        uasset_toolkit::init_global_toolkit().expect("toolkit");
        let mut out = String::new();
        let (mut peak, mut t_extract, mut t_json, mut t_parse) = (0u64, 0f64, 0f64, 0f64);
        let all = std::time::Instant::now();
        for (n, chunk) in paths.chunks(batch).enumerate() {
            let _ = std::fs::remove_dir_all(&work);
            std::fs::create_dir_all(&work).unwrap();
            let filter = work.join("filter.txt");
            std::fs::write(&filter, chunk.join("\n")).unwrap();
            let (legacy, json) = (work.join("legacy"), work.join("json"));
            let t = std::time::Instant::now();
            let o = std::process::Command::new(&cli).args(["extract_iostore_legacy", &paks, legacy.to_str().unwrap(), "--filter", filter.to_str().unwrap()]).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            t_extract += t.elapsed().as_secs_f64();
            let files: Vec<String> = walkdir::WalkDir::new(&legacy).into_iter().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "uasset")).map(|e| e.path().to_string_lossy().replace('\\', "/")).collect();
            let t = std::time::Instant::now();
            let req = serde_json::json!({ "action": "batch_to_json", "file_paths": files, "usmap_path": usmap, "output_path": json.to_string_lossy(), "base_path": legacy.to_string_lossy() });
            uasset_toolkit::invoke_json(&req.to_string()).expect("to json");
            t_json += t.elapsed().as_secs_f64();
            peak = peak.max(dir_size(&work));
            let t = std::time::Instant::now();
            for e in walkdir::WalkDir::new(&json).into_iter().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "json")) {
                let text = std::fs::read_to_string(e.path()).unwrap();
                let v: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap();
                let ex = &v["Exports"][0];
                let prop = |name: &str| ex["Data"].as_array().and_then(|d| d.iter().find(|p| p["Name"] == name)).map(|p| {
                    let x = if p["EnumValue"].is_null() { &p["Value"] } else { &p["EnumValue"] };
                    x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string())
                }).unwrap_or_default();
                let others: Vec<String> = ex["Data"].as_array().map(|d| d.iter().filter_map(|p| p["Name"].as_str()).filter(|n| !["ImportedSize", "LightingGuid", "CompressionSettings", "LODGroup", "SRGB"].contains(n)).map(str::to_string).collect()).unwrap_or_default();
                let rel = e.path().strip_prefix(&json).unwrap().to_string_lossy().replace('\\', "/");
                out += &format!("{}\t{}\t{}\t{}\t{}\t{}\t{}x{}\n", rel.trim_end_matches(".json"), prop("CompressionSettings"), prop("LODGroup"), prop("SRGB"), others.join(","), ex["PixelFormat"].as_str().unwrap_or(""), ex["PlatformData"]["SizeX"], ex["PlatformData"]["SizeY"]);
            }
            t_parse += t.elapsed().as_secs_f64();
            println!("batch {n}: {} done, {:.0}s so far, peak disk {:.2} GB", (n + 1) * batch, all.elapsed().as_secs_f64(), peak as f64 / 1e9);
        }
        let _ = std::fs::remove_dir_all(&work);
        std::fs::write(list.with_extension("props.tsv"), out).unwrap();
        println!("S1: {} textures in {:.0}s (extract {t_extract:.0}s, json {t_json:.0}s, parse {t_parse:.0}s), peak temp disk {:.2} GB", paths.len(), all.elapsed().as_secs_f64(), peak as f64 / 1e9);
    }

    /// S1 spike: REPAKXTRA_QUAKE_SAMPLE=<folder of extracted legacy packages> REPAKXTRA_USMAP=<usmap> cargo test -p repak-x
    /// --bin REPAK-X s1_property_read -- --ignored --nocapture. Times the in-process batch_to_json (the app's path).
    #[test]
    #[ignore]
    fn s1_property_read() {
        let src = std::env::var("REPAKXTRA_QUAKE_SAMPLE").expect("REPAKXTRA_QUAKE_SAMPLE");
        let usmap = std::env::var("REPAKXTRA_USMAP").expect("REPAKXTRA_USMAP");
        let out = std::env::var("REPAKXTRA_QUAKE_OUT").map(std::path::PathBuf::from).unwrap_or_else(|_| std::env::temp_dir().join("quake-spike-s1-json"));
        let _ = std::fs::remove_dir_all(&out);
        let files: Vec<String> = walkdir::WalkDir::new(&src)
            .into_iter()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "uasset"))
            .map(|e| e.path().to_string_lossy().replace('\\', "/"))
            .collect();
        let t = std::time::Instant::now();
        uasset_toolkit::init_global_toolkit().expect("toolkit");
        println!("toolkit loaded in {:?}", t.elapsed());
        let req = serde_json::json!({
            "action": "batch_to_json", "file_paths": files, "usmap_path": usmap,
            "output_path": out.to_string_lossy(), "base_path": src,
        });
        let t = std::time::Instant::now();
        let r = uasset_toolkit::invoke_json(&req.to_string()).expect("invoke");
        let took = t.elapsed();
        let jsons = walkdir::WalkDir::new(&out).into_iter().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "json")).count();
        println!("{} files -> {jsons} json in {took:?} ({:.1} ms each). Response head: {}", files.len(), took.as_secs_f64() * 1000.0 / files.len() as f64, &r[..r.len().min(200)]);
    }
}
