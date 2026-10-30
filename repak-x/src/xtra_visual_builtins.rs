//! Private-server visual mods: rebuild game assets, retain only FOV's mod-owned logic.
use crate::vfx_updater::{
    progress::NoOpProgressSink,
    uasset_tool::{
        convert_json_to_uassets, convert_uassets_to_json, extract_vanilla_assets, pack_to_iostore,
    },
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

pub const NO_IMPACT: &str = "no-impact";
pub const NO_TRACERS: &str = "no-tracers";
pub const FOV: &str = "fov-slider";
pub const NO_SHAKE: &str = "no-screen-shake";
const LAYOUT: &str =
    "Marvel/Content/Marvel/Data/DataTable/UI/Setting/SettingPageLayout/SettingPageLayoutTable";
const WIDGET: &str =
    "Marvel/Content/Marvel/UI/Blueprints/SelectHero/Corona/WBP_SelectHero_HeroCorona";

fn effect_paths(id: &str) -> Option<&'static str> {
    match id {
        NO_IMPACT => Some(include_str!("../resources/visual-builtins/impact.txt")),
        NO_TRACERS => Some(include_str!("../resources/visual-builtins/tracers.txt")),
        NO_SHAKE => Some(include_str!(
            "../resources/visual-builtins/screen-shake.txt"
        )),
        _ => None,
    }
}
/// The hero an asset belongs to: Characters/10xx, or AbilitySystem/10xx where camera shakes live.
fn hero(path: &str) -> Option<String> {
    crate::xtra_heroes::hero_skin(path)
        .map(|h| h.hero)
        .or_else(|| {
            let mut dirs = path.split('/');
            dirs.find(|d| d.eq_ignore_ascii_case("AbilitySystem"))?;
            dirs.next()
                .filter(|h| {
                    h.len() == 4 && h.starts_with("10") && h.bytes().all(|b| b.is_ascii_digit())
                })
                .map(str::to_string)
        })
}
/// The game packages a build of `id` reads (Marvel/Content/... paths), for xtra_builtins.rs usmap_ready. FOV Slider also
/// lists the game packages its own Blueprints import: a patch that changed the classes they use recooks those.
pub(crate) fn inputs(id: &str, excluded: &[String], paks: &Path) -> Option<Vec<String>> {
    if id == FOV {
        let mut out = vec![LAYOUT.to_string(), WIDGET.to_string()];
        let recipe: Value = serde_json::from_str(include_str!("../resources/visual-builtins/fov-widget.json")).ok()?;
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(include_bytes!("../resources/visual-builtins/fov-logic.zip"))).ok()?;
        let mut docs = vec![recipe];
        for i in 0..zip.len() {
            let mut text = String::new();
            std::io::Read::read_to_string(&mut zip.by_index(i).ok()?, &mut text).ok()?;
            docs.extend(serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).ok());
        }
        for doc in &docs {
            for import in doc["Imports"].as_array().into_iter().flatten() {
                if let Some(game) = import["ObjectName"].as_str().and_then(|n| n.strip_prefix("/Game/")).filter(|n| !n.starts_with("FOV/")) {
                    out.push(format!("Marvel/Content/{game}"));
                }
            }
        }
        out.sort();
        out.dedup();
        return Some(out);
    }
    Some(effects(id, paks)?.into_iter().filter(|p| !hero(p).is_some_and(|h| excluded.contains(&h))).collect())
}

/// Effects named like the supplied list's own, for the heroes and skins it never covered: the ones newer than the mod
/// it came from. The list's choices for the heroes and skins it covers stay as they are.
/// shortcut: by name, like the lists themselves (Hit, Trajectory, CameraShake, never a lobby, MVP or emote one), so a
/// new hero's effect with another name (a Blast, a LaserEnd) is not found. Montages are not, their camera curves would
/// need every montage decoded.
fn newer(id: &str, paks: &Path) -> Vec<String> {
    let Some(listed) = effect_paths(id) else { return Vec::new() };
    let rule: fn(&str) -> bool = match id {
        NO_IMPACT => |n| n.starts_with("ns_") && n.contains("hit"),
        NO_TRACERS => |n| n.starts_with("ns_") && n.contains("trajectory"),
        NO_SHAKE => |n| n.starts_with("camerashake"),
        _ => return Vec::new(),
    };
    const COSMETIC: [&str; 13] = ["mvp", "lobby", "show", "select", "victory", "emote", "/ui/", "_ui_", "intro", "outro", "gallery", "pose", "idle"];
    let skin = |p: &str| crate::xtra_heroes::hero_skin(p).and_then(|h| h.skin);
    let listed: HashSet<String> = listed.lines().map(str::to_ascii_lowercase).collect();
    let heroes: HashSet<String> = listed.iter().filter_map(|p| hero(p)).collect();
    let skins: HashSet<String> = listed.iter().filter_map(|p| skin(p)).collect();
    crate::xtra_broken::game_effects(paks)
        .iter()
        .filter(|p| {
            let low = p.to_ascii_lowercase();
            let name = low.rsplit('/').next().unwrap_or(&low);
            let Some(h) = hero(p) else { return false };
            rule(name)
                && !COSMETIC.iter().any(|c| low.contains(c))
                && !listed.contains(&low)
                && (!heroes.contains(&h) || skin(p).is_some_and(|s| !skins.contains(&s)))
        })
        .cloned()
        .collect()
}

/// The supplied list and the newer heroes' and skins' effects (`newer`) in the installed game.
fn effects(id: &str, paks: &Path) -> Option<Vec<String>> {
    let mut all: Vec<String> = effect_paths(id)?.lines().map(str::to_string).collect();
    all.extend(newer(id, paks));
    Some(all)
}

/// The heroes the effect built-in `id` has effects for: the supplied list's, and with `paks` the newer ones too.
pub(crate) fn effect_heroes(id: &str, paks: Option<&Path>) -> Option<Vec<String>> {
    let mut heroes: Vec<_> = effect_paths(id)?.lines().filter_map(hero).collect();
    heroes.extend(paks.into_iter().flat_map(|p| newer(id, p)).filter_map(|p| hero(&p)));
    heroes.sort();
    heroes.dedup();
    Some(heroes)
}
pub(crate) fn all_excluded(id: &str, excluded: &[String], paks: &Path) -> bool {
    effects(id, paks).is_some_and(|all| all.iter().all(|p| hero(p).is_some_and(|h| excluded.contains(&h))))
}
pub(crate) fn overlapping(root: &Path, id: &str) -> Vec<String> {
    let prefix = match id {
        NO_IMPACT => "znoimpact_",
        NO_TRACERS => "znotracersall_",
        FOV => "!fovslider_",
        NO_SHAKE => "noss_",
        _ => return Vec::new(),
    };
    let mut paths: Vec<_> = walkdir::WalkDir::new(root)
        .into_iter()
        .flatten()
        .filter(|e| {
            e.file_type().is_file()
                && e.file_name().to_str().is_some_and(|n| {
                    let n = n.to_ascii_lowercase();
                    n.starts_with(prefix) && n.ends_with(".pak")
                })
        })
        .map(|e| e.path().to_string_lossy().to_string())
        .collect();
    paths.sort();
    paths
}

fn read(path: &Path) -> Result<Value, String> {
    let s = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(s.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())
}
fn write(path: &Path, value: &Value) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().ok_or("Missing output folder")?)
        .map_err(|e| e.to_string())?;
    std::fs::write(
        path,
        format!(
            "\u{feff}{}",
            serde_json::to_string(value).map_err(|e| e.to_string())?
        ),
    )
    .map_err(|e| e.to_string())
}
fn items<'a>(v: &'a Value, field: &str) -> Result<&'a Vec<Value>, String> {
    v[field]
        .as_array()
        .ok_or_else(|| format!("Missing {field}: game asset layout changed"))
}

fn semantic(value: &Value) -> Value {
    match value {
        Value::Object(o) => Value::Object(
            o.iter()
                .filter(|(k, _)| {
                    ![
                        "OriginalStructHeader",
                        "OriginalUnversionedHeader",
                        "IsZero",
                    ]
                    .contains(&k.as_str())
                })
                .map(|(k, v)| (k.clone(), semantic(v)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(semantic).collect()),
        _ => value.clone(),
    }
}

fn check_fov_rebuild(expected: &Value, actual: &Value) -> Result<(), String> {
    if expected["Imports"] != actual["Imports"] {
        return Err("FOV imports did not rebuild faithfully".into());
    }
    let a = items(expected, "Exports")?;
    let b = items(actual, "Exports")?;
    if a.len() != b.len() {
        return Err("FOV export count changed during rebuilding".into());
    }
    for (a, b) in a.iter().zip(b) {
        for key in [
            "ObjectName",
            "OuterIndex",
            "ClassIndex",
            "SuperIndex",
            "TemplateIndex",
            "Data",
            "Table",
            "Extras",
            "ScriptBytecode",
        ] {
            if semantic(&a[key]) != semantic(&b[key]) {
                return Err(format!(
                    "FOV {}: {key} did not rebuild faithfully",
                    a["ObjectName"]
                ));
            }
        }
    }
    Ok(())
}

/// Patch only decoded NiagaraEmitter platform masks, leaving headers and all other bytes intact.
pub(crate) fn disable_emitters(
    doc: &Value,
    raw: &mut [u8],
    header_size: usize,
) -> Result<usize, String> {
    fn collect(v: &Value, masks: &mut Vec<(Vec<u8>, usize, i32)>) -> Result<(), String> {
        if v["Name"] == "Platforms" && v["StructType"] == "NiagaraPlatformSet" {
            let mut bytes = header(&v["OriginalStructHeader"])?;
            let mut target = None;
            for p in items(v, "Value")? {
                if p["IsZero"] == true {
                    continue;
                }
                match p["Name"].as_str() {
                    Some("DeviceProfileStates" | "CVarConditions") if p["Value"] == json!([]) => {
                        bytes.extend(0_i32.to_le_bytes())
                    }
                    Some("QualityLevelMask") => {
                        let n = p["Value"]
                            .as_i64()
                            .and_then(|n| i32::try_from(n).ok())
                            .ok_or("Invalid quality mask")?;
                        target = Some((bytes.len(), n));
                        bytes.extend(n.to_le_bytes());
                    }
                    Some("bInitLowestMask") if p["Value"].is_boolean() => {
                        bytes.push(u8::from(p["Value"] == true))
                    }
                    _ => {
                        return Err(
                            "Emitter platform rules changed; refusing an unchecked edit".into()
                        )
                    }
                }
            }
            if let Some((at, n)) = target {
                masks.push((bytes, at, n));
            }
            return Ok(());
        }
        match v {
            Value::Object(o) => {
                // Platform sets occur in struct properties and arrays of structs, never script byte arrays.
                if (o.contains_key("StructType")
                    || o.get("ArrayType").is_some_and(|v| v == "StructProperty"))
                    && o.contains_key("Value")
                {
                    collect(&o["Value"], masks)?;
                }
            }
            Value::Array(a) => {
                for x in a {
                    collect(x, masks)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut edits = 0;
    let mut emitters = 0;
    for export in items(doc, "Exports")? {
        let class = export["ClassIndex"]
            .as_i64()
            .filter(|n| *n < 0)
            .and_then(|n| doc["Imports"].get((-n - 1) as usize));
        let is_emitter = class.is_some_and(|c| c["ObjectName"] == "NiagaraEmitter");
        // Emitters hold the masks and must decode. A renderer the mappings cannot read (ribbon renderers on
        // this game version) is left as it is: the supplied mods match byte for byte without renderer edits.
        if is_emitter
            && (export["$type"]
                .as_str()
                .is_some_and(|t| t.contains("RawExport"))
                || !export["Data"].is_array())
        {
            return Err(crate::xtra_builtins::MAPPINGS_BEHIND.into());
        }
        if is_emitter {
            if !items(export, "Data")?
                .iter()
                .any(|p| p["Name"] == "VersionData")
            {
                return Err("Emitter version layout changed".into());
            }
            emitters += 1;
        }
        let mut masks = Vec::new();
        collect(&export["Data"], &mut masks)?;
        if masks.is_empty() {
            continue;
        }
        let start = export["SerialOffset"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .and_then(|n| n.checked_sub(header_size))
            .ok_or("Invalid emitter export offset")?;
        let len = export["SerialSize"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or("Invalid emitter export size")?;
        let end = start
            .checked_add(len)
            .filter(|n| *n <= raw.len())
            .ok_or("Emitter export exceeds file")?;
        let data = &mut raw[start..end];
        let mut writes = Vec::new();
        for (needle, at, mask) in &masks {
            if *mask == 0 {
                continue;
            }
            let hits: Vec<_> = data
                .windows(needle.len())
                .enumerate()
                .filter(|(_, w)| *w == needle.as_slice())
                .map(|(i, _)| i)
                .collect();
            let expected = masks.iter().filter(|(n, _, _)| n == needle).count();
            if hits.len() != expected {
                return Err(
                    "Emitter mask could not be located unambiguously; nothing was installed".into(),
                );
            }
            writes.extend(hits.into_iter().map(|i| i + at));
        }
        writes.sort();
        writes.dedup();
        for at in writes {
            data[at..at + 4].fill(0);
            edits += 1;
        }
    }
    if emitters == 0 {
        return Err("No Niagara emitters found: the game layout may have changed".into());
    }
    Ok(edits)
}

/// Unversioned property header bytes: its fragments, then the zero mask when a property is zero.
fn header(h: &Value) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    for f in items(h, "Fragments")? {
        let num = |k: &str| {
            f[k].as_u64()
                .filter(|n| *n <= 127)
                .map(|n| n as u16)
                .ok_or("Invalid property header")
        };
        let packed = num("SkipNum")?
            | (if f["bHasAnyZeroes"] == true { 0x80 } else { 0 })
            | (num("ValueNum")? << 9)
            | (if f["bIsLast"] == true { 0x100 } else { 0 });
        bytes.extend(packed.to_le_bytes());
    }
    let zeros = items(h, "ZeroMask")?;
    if !zeros.is_empty() {
        if zeros.len() > 8 {
            return Err("Property zero mask changed".into());
        }
        bytes.push(
            zeros
                .iter()
                .enumerate()
                .fold(0, |b, (i, v)| b | if v == true { 1 << i } else { 0 }),
        );
    }
    Ok(bytes)
}

/// A float as written in the JSON. NaN has more than one bit pattern, so it is left unchecked.
fn float(v: &Value) -> Result<f32, String> {
    match v {
        Value::Number(n) => n.as_f64().map(|f| f as f32),
        Value::String(s) if s == "+0" => Some(0.0),
        Value::String(s) if s == "-0" => Some(-0.0),
        Value::String(s) if s == "NaN" => Some(f32::NAN),
        Value::String(s) if s == "Infinity" => Some(f32::INFINITY),
        Value::String(s) if s == "-Infinity" => Some(f32::NEG_INFINITY),
        _ => None,
    }
    .ok_or_else(|| format!("Unexpected float {v}"))
}

/// Bytes of a serialized struct (`None`: an enum byte not checked), the offsets of floats to zero, and whether any of
/// them is not zero yet. Like the supplied mod, a struct whose values are all zero already (+0 or -0) stays as it is.
type Pattern = (Vec<Option<u8>>, Vec<usize>, bool);

fn encode(v: &Value, zero: fn(&str) -> bool, out: &mut Pattern) -> Result<(), String> {
    const CHANGED: &str = "Screen shake layout changed; refusing an unchecked edit";
    let put = |out: &mut Pattern, name: &str, f: f32| {
        if zero(name) {
            out.1.push(out.0.len());
            out.2 |= f != 0.0;
        }
        if f.is_nan() {
            out.0.extend([None; 4]);
        } else {
            out.0.extend(f.to_le_bytes().map(Some));
        }
    };
    out.0
        .extend(header(&v["OriginalStructHeader"])?.into_iter().map(Some));
    for p in items(v, "Value")? {
        if p["IsZero"] == true {
            continue;
        }
        let kind = p["$type"].as_str().unwrap_or_default();
        let name = p["Name"].as_str().unwrap_or_default();
        if kind.contains(".FloatPropertyData") {
            put(out, name, float(&p["Value"])?);
        } else if kind.contains(".BytePropertyData") || kind.contains(".EnumPropertyData") {
            out.0.push(None);
        } else if kind.contains(".NamePropertyData") {
            out.0.extend([None; 8]); // a name table index and number
        } else if kind.contains(".IntPropertyData") {
            let n = p["Value"]
                .as_i64()
                .and_then(|n| i32::try_from(n).ok())
                .ok_or(CHANGED)?;
            out.0.extend(n.to_le_bytes().map(Some));
        } else if kind.contains(".StructPropertyData") {
            encode(p, zero, out)?;
        } else if name == "Keys" && p["ArrayType"] == "StructProperty" {
            // FRichCurveKey is native: three mode bytes, then six floats
            let keys = items(p, "Value")?;
            out.0.extend((keys.len() as i32).to_le_bytes().map(Some));
            for k in keys {
                let k = &k["Value"][0]["Value"];
                if !k.is_object() {
                    return Err(CHANGED.into());
                }
                out.0.extend([None; 3]);
                for f in [
                    "Time",
                    "Value",
                    "ArriveTangent",
                    "ArriveTangentWeight",
                    "LeaveTangent",
                    "LeaveTangentWeight",
                ] {
                    put(out, f, float(&k[f])?);
                }
            }
        } else {
            return Err(CHANGED.into());
        }
    }
    Ok(())
}

fn shake_patterns(v: &Value, out: &mut Vec<Pattern>) -> Result<(), String> {
    match v {
        Value::Object(o) => {
            if v["StructType"] == "FOscillator" {
                let mut p = Pattern::default();
                encode(
                    v,
                    |n| matches!(n, "Amplitude" | "AmplitudeEnhanced" | "Frequency"),
                    &mut p,
                )?;
                out.push(p);
                return Ok(());
            }
            // a weapon's crosshair kick
            if v["StructType"].is_string()
                && v["Name"]
                    .as_str()
                    .is_some_and(|n| n.starts_with("CrosshairShake"))
            {
                let mut p = Pattern::default();
                encode(
                    v,
                    |n| {
                        matches!(n, "ShakePitch" | "ShakePitchMax")
                            || n.starts_with("ShakeAmplitude")
                    },
                    &mut p,
                )?;
                out.push(p);
                return Ok(());
            }
            if v["Name"] == "FloatCurves" {
                // the whole array as one pattern (count, then every curve in order), so a short camera curve
                // with no keys cannot match a lookalike elsewhere; only camera curves get targets
                let curves = items(v, "Value")?;
                let mut all = Pattern::default();
                all.0.extend((curves.len() as i32).to_le_bytes().map(Some));
                for c in curves {
                    let name = items(c, "Value")?
                        .iter()
                        .find_map(|p| {
                            (p["Name"] == "CurveName")
                                .then(|| p["Value"].as_str())
                                .flatten()
                        })
                        .unwrap_or_default();
                    let camera = ["CameraLocationOffset", "CameraRotationOffset"]
                        .iter()
                        .any(|s| {
                            name.strip_suffix(['X', 'Y', 'Z'])
                                .is_some_and(|n| n.ends_with(s))
                        });
                    let mut one = Pattern::default();
                    if camera {
                        encode(
                            c,
                            |n| {
                                matches!(
                                    n,
                                    "DefaultValue" | "Value" | "ArriveTangent" | "LeaveTangent"
                                )
                            },
                            &mut one,
                        )?;
                    } else {
                        encode(c, |_| false, &mut one)?;
                    }
                    let at = all.0.len();
                    if one.2 {
                        all.1.extend(one.1.iter().map(|t| t + at));
                        all.2 = true;
                    }
                    all.0.extend(one.0);
                }
                out.push(all);
                return Ok(());
            }
            for x in o.values() {
                shake_patterns(x, out)?;
            }
        }
        Value::Array(a) => {
            for x in a {
                shake_patterns(x, out)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Zero camera shake oscillation and montage camera curves in place, leaving headers and other bytes intact.
pub(crate) fn disable_shake(
    doc: &Value,
    raw: &mut [u8],
    header_size: usize,
) -> Result<usize, String> {
    let mut edits = 0;
    for export in items(doc, "Exports")? {
        let class = export["ClassIndex"]
            .as_i64()
            .filter(|n| *n < 0)
            .and_then(|n| doc["Imports"].get((-n - 1) as usize))
            .and_then(|c| c["ObjectName"].as_str());
        let shake = export["ObjectName"]
            .as_str()
            .is_some_and(|n| n.starts_with("Default__"));
        if (shake || class == Some("AnimMontage")) && !export["Data"].is_array() {
            return Err(crate::xtra_builtins::MAPPINGS_BEHIND.into());
        }
        let mut patterns = Vec::new();
        if class == Some("CurveFloat") {
            // a standalone shake curve: its key values go
            for rich in items(export, "Data")?
                .iter()
                .filter(|p| p["StructType"] == "RichCurve")
            {
                let mut p = Pattern::default();
                encode(rich, |n| n == "Value", &mut p)?;
                patterns.push(p);
            }
        } else {
            shake_patterns(&export["Data"], &mut patterns)?;
        }
        // already zero: nothing to change, and nothing to look for
        patterns.retain(|p| p.2);
        if patterns.is_empty() {
            continue;
        }
        let start = export["SerialOffset"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .and_then(|n| n.checked_sub(header_size))
            .ok_or("Invalid export offset")?;
        let len = export["SerialSize"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or("Invalid export size")?;
        let end = start
            .checked_add(len)
            .filter(|n| *n <= raw.len())
            .ok_or("Export exceeds file")?;
        let data = &mut raw[start..end];
        let mut writes = Vec::new();
        for (bytes, targets, _) in &patterns {
            let hits: Vec<_> = (0..(data.len() + 1).saturating_sub(bytes.len()))
                .filter(|&i| {
                    bytes
                        .iter()
                        .zip(&data[i..])
                        .all(|(b, d)| b.is_none_or(|b| b == *d))
                })
                .collect();
            let expected = patterns.iter().filter(|(b, _, _)| b == bytes).count();
            if hits.len() != expected {
                return Err(
                    "Shake values could not be located unambiguously; nothing was installed".into(),
                );
            }
            writes.extend(hits.iter().flat_map(|i| targets.iter().map(move |t| i + t)));
        }
        writes.sort();
        writes.dedup();
        for at in writes {
            data[at..at + 4].fill(0);
            edits += 1;
        }
    }
    Ok(edits)
}

fn import_key(imports: &[Value], index: i64) -> Result<String, String> {
    fn inner(imports: &[Value], index: i64, depth: usize) -> Result<String, String> {
        if index == 0 {
            return Ok(String::new());
        }
        if depth > imports.len() || index >= 0 {
            return Err("Invalid import hierarchy".into());
        }
        let v = imports
            .get((-index - 1) as usize)
            .ok_or("Invalid import index")?;
        Ok(format!(
            "{}/{}/{}/{}",
            inner(
                imports,
                v["OuterIndex"].as_i64().ok_or("Invalid import outer")?,
                depth + 1
            )?,
            v["ClassPackage"],
            v["ClassName"],
            v["ObjectName"]
        ))
    }
    inner(imports, index, 0)
}

fn export_key(exports: &[Value], index: usize, depth: usize) -> Result<String, String> {
    if depth > exports.len() {
        return Err("Invalid export hierarchy".into());
    }
    let e = exports.get(index).ok_or("Invalid export index")?;
    let outer = e["OuterIndex"].as_u64().ok_or("Unsupported export outer")? as usize;
    let parent = if outer == 0 {
        String::new()
    } else {
        export_key(exports, outer - 1, depth + 1)?
    };
    Ok(format!(
        "{parent}/{}",
        e["ObjectName"].as_str().ok_or("Export has no name")?
    ))
}

fn add_import(
    doc: &mut Value,
    source: &[Value],
    index: i64,
    mapped: &mut HashMap<i64, i64>,
) -> Result<i64, String> {
    if index == 0 {
        return Ok(0);
    }
    if let Some(n) = mapped.get(&index) {
        return Ok(*n);
    }
    let key = import_key(source, index)?;
    for (i, _) in items(doc, "Imports")?.iter().enumerate() {
        if import_key(items(doc, "Imports")?, -(i as i64) - 1)? == key {
            mapped.insert(index, -(i as i64) - 1);
            return Ok(-(i as i64) - 1);
        }
    }
    let mut v = source
        .get((-index - 1) as usize)
        .ok_or("Missing reference import")?
        .clone();
    if !v["ObjectName"]
        .as_str()
        .is_some_and(|n| n.contains("FOV") || n.contains("Fov"))
    {
        return Err(format!(
            "FOV needs a game import that changed: {}",
            v["ObjectName"]
        ));
    }
    v["OuterIndex"] = json!(add_import(
        doc,
        source,
        v["OuterIndex"].as_i64().ok_or("Invalid FOV import")?,
        mapped
    )?);
    let imports = doc["Imports"].as_array_mut().ok_or("Missing imports")?;
    imports.push(v);
    let n = -(imports.len() as i64);
    mapped.insert(index, n);
    Ok(n)
}

fn remap(v: &mut Value, map: &HashMap<i64, i64>) -> Result<(), String> {
    let translate = |n: &Value| {
        n.as_i64()
            .and_then(|n| {
                if n == 0 {
                    Some(0)
                } else {
                    map.get(&n).copied()
                }
            })
            .map(|n| json!(n))
            .ok_or("FOV reference could not be mapped to the current game".to_string())
    };
    if let Value::Object(o) = v {
        if o.get("$type")
            .and_then(Value::as_str)
            .is_some_and(|t| t.contains("ObjectPropertyData"))
        {
            let n = translate(o.get("Value").ok_or("Missing object reference")?)?;
            o.insert("Value".into(), n);
        }
        for (k, x) in o.iter_mut() {
            if ["OuterIndex", "ClassIndex", "SuperIndex", "TemplateIndex"].contains(&k.as_str()) {
                *x = translate(x)?;
            } else if k.ends_with("Dependencies") {
                for n in x.as_array_mut().ok_or("Invalid export dependencies")? {
                    *n = translate(n)?;
                }
            } else if k != "Value" || !x.is_number() {
                remap(x, map)?;
            }
        }
    } else if let Value::Array(a) = v {
        for x in a {
            remap(x, map)?;
        }
    }
    Ok(())
}

pub(crate) fn inject_fov(layout: &mut Value, widget: &mut Value) -> Result<(), String> {
    let recipe: Value =
        serde_json::from_str(include_str!("../resources/visual-builtins/fov-widget.json"))
            .map_err(|e| e.to_string())?;
    let source = items(&recipe, "Imports")?;
    let mut mapped = HashMap::new();
    let existing = items(widget, "Exports")?.len();
    for (i, _) in items(&recipe, "Exports")?.iter().enumerate() {
        let n = if i >= items(&recipe, "Exports")?.len() - 2 {
            Some(existing + i - (items(&recipe, "Exports")?.len() - 2) + 1)
        } else {
            let key = export_key(items(&recipe, "Exports")?, i, 0)?;
            let mut found = None;
            for j in 0..existing {
                if export_key(items(widget, "Exports")?, j, 0)? == key {
                    if found.is_some() {
                        return Err("FOV: ambiguous widget export".into());
                    }
                    found = Some(j + 1);
                }
            }
            found
        };
        if let Some(n) = n {
            mapped.insert(i as i64 + 1, n as i64);
        }
    }
    // Resolve only references actually used by the two added exports.
    for e in items(&recipe, "additions")? {
        fn refs(v: &Value, out: &mut HashSet<i64>) {
            if let Value::Object(o) = v {
                if o.get("$type")
                    .and_then(Value::as_str)
                    .is_some_and(|t| t.contains("ObjectPropertyData"))
                {
                    if let Some(n) = o.get("Value").and_then(Value::as_i64).filter(|n| *n < 0) {
                        out.insert(n);
                    }
                }
                for (k, x) in o {
                    if ["OuterIndex", "ClassIndex", "SuperIndex", "TemplateIndex"]
                        .contains(&k.as_str())
                    {
                        if let Some(n) = x.as_i64().filter(|n| *n < 0) {
                            out.insert(n);
                        }
                    } else if k.ends_with("Dependencies") {
                        for n in x
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_i64)
                            .filter(|n| *n < 0)
                        {
                            out.insert(n);
                        }
                    } else {
                        refs(x, out);
                    }
                }
            } else if let Value::Array(a) = v {
                for x in a {
                    refs(x, out);
                }
            }
        }
        let mut needed = HashSet::new();
        refs(e, &mut needed);
        let mut needed: Vec<_> = needed.into_iter().collect();
        needed.sort();
        for n in needed {
            add_import(widget, source, n, &mut mapped)?;
        }
    }
    for n in items(&recipe, "NameMap")? {
        if !items(widget, "NameMap")?.contains(n) {
            widget["NameMap"].as_array_mut().unwrap().push(n.clone());
        }
    }
    let mut additions = items(&recipe, "additions")?.clone();
    for e in &mut additions {
        remap(e, &mapped)?;
    }
    let slot_index = existing as i64 + 2;
    let canvas = items(&recipe, "Exports")?
        .iter()
        .position(|e| e["ObjectName"] == "CanvasPanel_0")
        .and_then(|n| mapped.get(&(n as i64 + 1)))
        .copied()
        .ok_or("FOV: hero-select canvas changed")? as usize
        - 1;
    let slots = widget["Exports"][canvas]["Data"]
        .as_array_mut()
        .and_then(|a| a.iter_mut().find(|p| p["Name"] == "Slots"))
        .and_then(|p| p["Value"].as_array_mut())
        .ok_or("FOV: hero-select slots changed")?;
    let mut slot = slots.first().cloned().ok_or("FOV: canvas has no slots")?;
    slot["Name"] = json!(slots.len().to_string());
    slot["Value"] = json!(slot_index);
    slots.push(slot);
    widget["Exports"][canvas]["CreateBeforeSerializationDependencies"]
        .as_array_mut()
        .ok_or("FOV: canvas dependencies changed")?
        .push(json!(slot_index));
    widget["Exports"].as_array_mut().unwrap().extend(additions);
    widget["DependsMap"]
        .as_array_mut()
        .ok_or("FOV: dependency map changed")?
        .extend([json!([]), json!([])]);
    let names = items(widget, "NameMap")?.len();
    widget["NamesReferencedFromExportDataCount"] = json!(names);

    // Add the custom collection without renumbering any existing game imports.
    let package = json!({"$type":"UAssetAPI.Import, UAssetAPI","ObjectName":"/Game/FOV/Settings/FOV_SettingsCollection","OuterIndex":0,"ClassPackage":"/Script/CoreUObject","ClassName":"Package","PackageName":null,"bImportOptional":false});
    let imports = layout["Imports"]
        .as_array_mut()
        .ok_or("FOV: setting imports changed")?;
    imports.push(package);
    let pkg = -(imports.len() as i64);
    imports.push(json!({"$type":"UAssetAPI.Import, UAssetAPI","ObjectName":"FOV_SettingsCollection","OuterIndex":pkg,"ClassPackage":"/Script/Engine","ClassName":"CompositeDataTable","PackageName":null,"bImportOptional":false}));
    let collection = -(imports.len() as i64);
    for n in [
        "/Game/FOV/Settings/FOV_SettingsCollection",
        "FOV_SettingsCollection",
        "CompositeDataTable",
    ] {
        if !items(layout, "NameMap")?.contains(&json!(n)) {
            layout["NameMap"].as_array_mut().unwrap().push(json!(n));
        }
    }
    let mut changed = 0;
    let imports = items(layout, "Imports")?.clone();
    for row in layout["Exports"][0]["Table"]["Data"]
        .as_array_mut()
        .ok_or("FOV: setting rows changed")?
    {
        for p in row["Value"]
            .as_array_mut()
            .ok_or("FOV: setting row layout changed")?
        {
            if p["Name"] == "OtherSettingTable" {
                let old = p["Value"]
                    .as_i64()
                    .ok_or("FOV: invalid settings reference")?;
                let old = old
                    .checked_neg()
                    .and_then(|n| n.checked_sub(1))
                    .and_then(|n| usize::try_from(n).ok())
                    .and_then(|n| imports.get(n))
                    .ok_or("FOV: invalid Other settings import")?;
                if old["ObjectName"] != "Other_PageLayoutTable" {
                    return Err(
                        "FOV: Other settings collection changed; nothing was installed".into(),
                    );
                }
                p["Value"] = json!(collection);
                changed += 1;
            }
        }
    }
    if changed == 0 {
        return Err("FOV: no Other settings page found".into());
    }
    Ok(())
}

/// One file's edit for the cache: the hash of its game bytes (.uasset then .uexp), how many values it changed, and the
/// changed byte runs in its .uexp (offset, hex). Same bytes in, same edit out: the patches read nothing else.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
struct Edits {
    hash: String,
    count: usize,
    runs: Vec<(usize, String)>,
}

impl Edits {
    /// The edit that turns `before` into `after` (same length: the patches overwrite, never insert).
    fn between(hash: String, count: usize, before: &[u8], after: &[u8]) -> Self {
        let mut runs = Vec::new();
        let mut i = 0;
        while i < before.len() {
            if before[i] == after[i] {
                i += 1;
                continue;
            }
            let at = i;
            while i < before.len() && before[i] != after[i] {
                i += 1;
            }
            runs.push((at, after[at..i].iter().map(|b| format!("{b:02x}")).collect()));
        }
        Self { hash, count, runs }
    }

    /// Writes the runs into `raw`. false when one does not fit (then the file is decoded instead).
    fn apply(&self, raw: &mut [u8]) -> bool {
        for (at, hex) in &self.runs {
            let bytes: Option<Vec<u8>> = (0..hex.len()).step_by(2).map(|i| hex.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok())).collect();
            match bytes {
                Some(b) if at + b.len() <= raw.len() => raw[*at..at + b.len()].copy_from_slice(&b),
                _ => return false,
            }
        }
        true
    }
}

/// Bumped when a patch, or the decoder (UAssetToolRivals or a uassettool-patches change to what it reads), changes what
/// an edit comes out as, so the cache's old edits are not used again.
const EDIT_RECIPE: u32 = 1;

fn edit_cache_path(id: &str) -> std::path::PathBuf {
    dirs::config_dir().unwrap_or_else(|| ".".into()).join("Repak-X").join("builtin-cache").join(format!("{id}.json"))
}

fn bytes_hash(header: &[u8], raw: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update((header.len() as u64).to_le_bytes());
    h.update(header);
    h.update(raw);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The same file decodes the same only with the same USMAP: its hash is part of the cache's identity.
fn usmap_hash(usmap: &str) -> String {
    std::fs::read(usmap).map(|b| bytes_hash(&[], &b)).unwrap_or_default()
}

fn load_edit_cache(path: &Path, usmap: &str) -> HashMap<String, Edits> {
    #[derive(serde::Deserialize)]
    struct File { recipe: u32, usmap: String, files: HashMap<String, Edits> }
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<File>(&b).ok()).filter(|f| f.recipe == EDIT_RECIPE && f.usmap == usmap).map(|f| f.files).unwrap_or_default()
}

/// Written whole beside it, then swapped in, so a build stopped mid-write never leaves half a cache. A cache that
/// cannot be written only means the next build decodes again.
fn save_edit_cache(path: &Path, usmap: &str, files: &HashMap<String, Edits>) {
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")));
    let Ok(text) = serde_json::to_vec(&json!({ "recipe": EDIT_RECIPE, "usmap": usmap, "files": files })) else { return };
    let part = path.with_extension(format!("{}.part", std::process::id()));
    if std::fs::write(&part, text).is_ok() && std::fs::rename(&part, path).is_err() {
        let _ = std::fs::remove_file(&part);
    }
}

/// One decode through the command line, stopped (and the process ended) when the build is. Err carries its stderr.
fn decode_with_cli(cli: &Path, uasset: &Path, usmap: &str, out: &Path, cancelled: fn() -> bool) -> Result<(), String> {
    let mut cmd = std::process::Command::new(cli);
    cmd.arg("to_json").arg(uasset).arg(usmap).arg(out).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: hundreds of decodes, no console flashing up
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    // stderr is read on its own thread, so a chatty decode never blocks on a full pipe
    let err = child.stderr.take().map(|mut e| std::thread::spawn(move || { let mut s = String::new(); let _ = std::io::Read::read_to_string(&mut e, &mut s); s }));
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Build stopped".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    let err = err.and_then(|h| h.join().ok()).unwrap_or_default();
    if status.success() { Ok(()) } else { Err(err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no message").trim().to_string()) }
}

pub async fn make(
    tool: &Path,
    usmap: &str,
    id: &str,
    excluded: &[String],
    paks: &Path,
    work: &Path,
    out: &Path,
    cancelled: fn() -> bool,
    waiting: &[String],
) -> Result<(String, Vec<String>), String> {
    let s = |p: &Path| p.to_string_lossy().to_string();
    let legacy = work.join("legacy");
    let json_dir = work.join("json");
    let staged = work.join("mod");
    let sink = NoOpProgressSink;
    if id == FOV {
        extract_vanilla_assets(
            tool,
            &s(paks),
            &s(&legacy),
            &[LAYOUT.into(), WIDGET.into()],
            &sink,
        )
        .await?;
        convert_uassets_to_json(tool, usmap, &s(&legacy), &s(&json_dir), &sink).await?;
        let mut layout = read(&json_dir.join(format!("{LAYOUT}.json")))?;
        let mut widget = read(&json_dir.join(format!("{WIDGET}.json")))?;
        inject_fov(&mut layout, &mut widget)?;
        let edited = work.join("edited");
        write(&edited.join(format!("{LAYOUT}.json")), &layout)?;
        write(&edited.join(format!("{WIDGET}.json")), &widget)?;
        let zip =
            std::io::Cursor::new(include_bytes!("../resources/visual-builtins/fov-logic.zip"));
        zip::ZipArchive::new(zip)
            .map_err(|e| e.to_string())?
            .extract(&edited)
            .map_err(|e| e.to_string())?;
        convert_json_to_uassets(tool, usmap, &s(&edited), &s(&staged), &sink).await?;
        let checked = work.join("checked-json");
        convert_uassets_to_json(tool, usmap, &s(&staged), &s(&checked), &sink).await?;
        check_fov_rebuild(&layout, &read(&checked.join(format!("{LAYOUT}.json")))?)?;
        check_fov_rebuild(&widget, &read(&checked.join(format!("{WIDGET}.json")))?)?;
        for entry in walkdir::WalkDir::new(edited.join("Marvel/Content/FOV")).into_iter() {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(&edited)
                .map_err(|e| e.to_string())?;
            check_fov_rebuild(&read(entry.path())?, &read(&checked.join(rel))?)?;
        }
        pack_to_iostore(tool, usmap, &s(&staged), &s(out), None, &sink).await?;
        return Ok((
            "In-game FOV slider, with the original save and match controls".into(),
            Vec::new(),
        ));
    }
    let all_paths = effects(id, paks).ok_or("Unknown visual built-in")?;
    let mut heroes = HashSet::new();
    heroes.extend(all_paths.iter().filter_map(|p| hero(p)));
    // files a patch newer than the USMAP rewrote: left out now, put in once that patch's USMAP is out (xtra_builtins.rs)
    let waiting: HashSet<String> = waiting.iter().map(|p| p.trim_end_matches(".uasset").to_ascii_lowercase()).collect();
    let newer: HashSet<String> = newer(id, paks).into_iter().collect();
    let paths: Vec<String> = all_paths
        .into_iter()
        .filter(|p| !hero(p).is_some_and(|h| excluded.contains(&h)))
        .collect();
    let paths: Vec<String> = paths.into_iter().filter(|p| !waiting.contains(&p.to_ascii_lowercase())).collect();
    if paths.is_empty() {
        return Err("Every effect hero is excluded".into());
    }
    // the card's bar: reading takes about a third, the batches most of the rest
    let _finished = crate::xtra_quake::Finished;
    let bar = |stage: &str, f: f32, detail: Option<String>| crate::xtra_quake::report_other(stage, f, detail);
    bar("Reading the game's effect files", 0.0, None);
    let began = std::time::Instant::now();
    // without their dependencies (the split extract still adds them for one that uses another package's class or
    // struct): No impact pulled 7,028 packages, 1.2 GB, for its 817 files, and the edits come out byte for byte the same
    crate::vfx_updater::uasset_tool::extract_vanilla_assets_split(tool, &s(paks), &s(&legacy), &paths, &paths, &sink).await?;
    let extracted = began.elapsed();
    // A game update can drop or rename a listed asset: build the rest instead of nothing.
    let listed = paths.len();
    let paths: Vec<String> = paths
        .into_iter()
        .filter(|rel| legacy.join(format!("{rel}.uexp")).is_file())
        .collect();
    if paths.is_empty() {
        return Err("None of the listed effect assets exist in this game version".into());
    }
    let changing = if id == NO_SHAKE { "Changing the camera shakes" } else { "Changing the effects" };
    let patch = if id == NO_SHAKE { disable_shake } else { disable_emitters };
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(2, 8);
    let pool = rayon::ThreadPoolBuilder::new().num_threads(workers).build().map_err(|e| e.to_string())?;
    use rayon::prelude::*;
    // The files the game did not change since an earlier build are patched from the cache (their edits, keyed by the
    // hash of their bytes), without decoding: decoding was about 90% of a build
    let cache_path = edit_cache_path(id);
    let usmap_id = usmap_hash(usmap);
    let cache = load_edit_cache(&cache_path, &usmap_id);
    let write_out = |rel: &str, header: &[u8], raw: &[u8]| -> Result<(), String> {
        let dest = staged.join(rel);
        std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(dest.with_extension("uasset"), header).map_err(|e| e.to_string())?;
        std::fs::write(dest.with_extension("uexp"), raw).map_err(|e| e.to_string())
    };
    // A file that reads a class or struct from another package decodes by that package too: those packages (the
    // dependencies the split extract added, a few dozen) are part of its key, so a change in any decodes it again
    let deps_id = {
        let listed: HashSet<String> = paths.iter().map(|p| p.to_ascii_lowercase()).collect();
        let mut deps: Vec<(String, Vec<u8>)> = walkdir::WalkDir::new(&legacy).into_iter().flatten()
            .filter(|e| e.file_type().is_file())
            .filter_map(|e| {
                let rel = e.path().strip_prefix(&legacy).ok()?.to_string_lossy().replace('\\', "/");
                let stem = rel.rsplit_once('.').map_or(rel.as_str(), |(a, _)| a).to_ascii_lowercase();
                (!listed.contains(&stem)).then(|| std::fs::read(e.path()).ok().map(|b| (rel, b))).flatten()
            })
            .collect();
        deps.sort();
        let names: Vec<u8> = deps.iter().flat_map(|(n, b)| [n.as_bytes(), &(b.len() as u64).to_le_bytes()[..]].concat()).collect();
        bytes_hash(&names, &deps.iter().flat_map(|(_, b)| b.iter().copied()).collect::<Vec<u8>>())
    };
    let load = |rel: &str| -> Result<(Vec<u8>, Vec<u8>, String), String> {
        let header = std::fs::read(legacy.join(format!("{rel}.uasset"))).map_err(|e| format!("{rel}: {e}"))?;
        let raw = std::fs::read(legacy.join(format!("{rel}.uexp"))).map_err(|e| format!("{rel}: {e}"))?;
        let mut hash = bytes_hash(&header, &raw);
        if crate::vfx_updater::uasset_tool::uses_outside_schemas(&legacy.join(format!("{rel}.uasset"))) {
            hash = bytes_hash(hash.as_bytes(), deps_id.as_bytes());
        }
        Ok((header, raw, hash))
    };
    let known = pool.install(|| {
        paths.par_iter().map(|rel| -> Result<Option<(String, Edits)>, String> {
            if cancelled() {
                return Err("Build stopped".into());
            }
            let Some(done) = cache.get(rel) else { return Ok(None) };
            let (header, mut raw, hash) = load(rel)?;
            if done.hash != hash || !done.apply(&mut raw) {
                return Ok(None);
            }
            if done.count > 0 {
                write_out(rel, &header, &raw)?;
            }
            Ok(Some((rel.clone(), done.clone())))
        }).collect::<Result<Vec<_>, _>>()
    })?;
    let mut edits: HashMap<String, Edits> = known.into_iter().flatten().collect();
    let todo: Vec<&String> = paths.iter().filter(|rel| !edits.contains_key(*rel)).collect();
    log::info!("[built-in] {id}: {} of {} files from the cache, {} to decode", edits.len(), paths.len(), todo.len());
    // one file's edit from its decoded JSON: the changed bytes go to the mod (and the cache), an unchanged file stays the game's
    let apply = |rel: &str, doc: &Value| -> Result<Edits, String> {
        let (header, mut raw, hash) = load(rel)?;
        let before = raw.clone();
        let count = patch(doc, &mut raw, header.len()).map_err(|e| format!("{rel}: {e}"))?;
        if count > 0 {
            write_out(rel, &header, &raw)?;
        }
        Ok(Edits::between(hash, count, &before, &raw))
    };
    let total = todo.len();
    let reused = edits.len();
    // the card says how many came from the last build, or that the next one is quicker: a first build takes minutes
    let note = if reused > 0 { format!(", {reused} reused from the last build") } else { ". Rebuilds reuse these and take about a minute".to_string() };
    // workers finish out of order: the bar only moves forward
    let shown = std::sync::Mutex::new(0usize);
    let step = |n: usize| {
        let mut last = shown.lock().unwrap_or_else(|e| e.into_inner());
        if n % 8 == 0 && (n > *last || n == 0) {
            *last = n;
            bar(changing, 0.3 + 0.6 * n as f32 / total.max(1) as f32, Some(format!("{n} of {total} to read{note}")));
        }
    };
    if total == 0 {
        bar(changing, 0.85, Some(format!("All {reused} reused from the last build")));
    } else {
        step(0);
    }
    // decodes the command line could not do go to the library below (blocked, damaged, or a file it fails on)
    let mut library: Vec<&String> = Vec::new();
    if let Some(cli) = crate::xtra_uat_cli::cli() {
        // The command line decodes a file in about the time the library does, so one process per file, a few at once
        // (each writes a JSON of up to 30 MB, so 8 at once is about 2.3 times faster, not 8)
        let done = std::sync::atomic::AtomicUsize::new(0);
        let one = |rel: &&String| -> Result<Option<(String, Edits)>, String> {
            if cancelled() {
                return Err("Build stopped".into());
            }
            // each file its own folder: the command line names the JSON after the file, and names repeat across heroes
            let out = json_dir.join(rel.as_str()).with_extension("");
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            let name = Path::new(rel.as_str()).file_name().unwrap_or_default().to_string_lossy().to_string();
            let json = out.join(format!("{name}.json"));
            match decode_with_cli(&cli, &legacy.join(format!("{rel}.uasset")), usmap, &out, cancelled) {
                Err(e) if e == "Build stopped" => return Err(e),
                Err(e) => { log::warn!("[built-in] {rel}: the command line could not decode it ({e}), using the library"); return Ok(None) }
                Ok(()) if !json.is_file() => return Ok(None),
                Ok(()) => {}
            }
            let made = apply(rel, &read(&json)?)?;
            let _ = std::fs::remove_dir_all(&out); // the JSON is large: gone as soon as it is used
            step(done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1);
            Ok(Some(((*rel).clone(), made)))
        };
        let made = pool.install(|| todo.par_iter().map(|rel| one(rel).map(|m| (rel, m))).collect::<Result<Vec<_>, _>>())?;
        for (rel, m) in made {
            match m { Some((k, e)) => { edits.insert(k, e); } None => library.push(rel) }
        }
    } else {
        library = todo.clone();
    }
    {
        // the in-process library, in bounded batches (Niagara JSON holds large script arrays, discarded at once)
        for (n, batch) in library.chunks(8).enumerate() {
            step(n * 8);
            if cancelled() {
                return Err("Build stopped".into());
            }
            use crate::vfx_updater::uasset_tool::{run_vfx_uat_request, VfxUatRequest};
            let request = VfxUatRequest {
                action: "batch_to_json",
                file_paths: Some(batch.iter().map(|rel| s(&legacy.join(format!("{rel}.uasset")))).collect()),
                usmap_path: Some(usmap),
                output_path: Some(s(&json_dir)),
                base_path: Some(s(&legacy)),
                ..Default::default()
            };
            let response = run_vfx_uat_request(tool, &request).await?;
            if !response.success {
                return Err(format!("Effect assets could not be decoded: {}", response.message));
            }
            for rel in batch {
                edits.insert((*rel).clone(), apply(rel, &read(&json_dir.join(format!("{rel}.json")))?)?);
            }
            std::fs::remove_dir_all(&json_dir).map_err(|e| e.to_string())?;
        }
    }
    let count: usize = edits.values().map(|e| e.count).sum();
    // this game's files only: a file a patch removed or rewrote leaves the cache with its old bytes
    save_edit_cache(&cache_path, &usmap_id, &edits);
    if cancelled() {
        return Err("Build stopped".into());
    }
    if count == 0 {
        return Err(
            "Nothing to change in these game files: the game layout may have changed".into(),
        );
    }
    let decoded = began.elapsed();
    bar("Packing", 0.9, None);
    pack_to_iostore(tool, usmap, &s(&staged), &s(out), None, &sink).await?;
    log::info!("[built-in] {id}: {} files, extract {:.1} s, decode and patch {:.1} s, pack {:.1} s", paths.len(), extracted.as_secs_f32(), (decoded - extracted).as_secs_f32(), (began.elapsed() - decoded).as_secs_f32());
    let mut heroes: Vec<_> = heroes.into_iter().collect();
    heroes.sort();
    let missing = listed - paths.len();
    let added = paths.iter().filter(|p| newer.contains(*p)).count();
    let mut summary = format!(
        "{} {} assets{}, {count} {}",
        paths.len(),
        if id == NO_SHAKE { "camera" } else { "effect" },
        if added > 0 { format!(" ({added} for heroes and skins newer than the supplied mod)") } else { String::new() },
        if id == NO_SHAKE { "shake values zeroed" } else { "emitter masks disabled" },
    );
    if missing > 0 {
        summary += &format!(". {missing} listed assets are not in this game version");
    }
    Ok((summary, heroes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_edits_rebuild_the_same_bytes() {
        let before = vec![1u8, 2, 3, 63, 0, 0, 0, 9, 9, 63, 0];
        let mut after = before.clone();
        after[3] = 0;
        after[9] = 0;
        after[10] = 7;
        let e = Edits::between("h".into(), 2, &before, &after);
        assert_eq!(e.runs, vec![(3, "00".to_string()), (9, "0007".to_string())]);
        let mut again = before.clone();
        assert!(e.apply(&mut again) && again == after, "the cache writes what the patch wrote");
        assert!(!e.apply(&mut [0u8; 4]), "a run past the end means decode instead");
        assert_ne!(bytes_hash(b"ab", b"c"), bytes_hash(b"a", b"bc"), "the header and body boundary is part of the hash");
    }

    #[test]
    fn emitter_patch_changes_only_a_uniquely_located_mask() {
        let platform = json!({"Name":"Platforms","StructType":"NiagaraPlatformSet","OriginalStructHeader":{"Fragments":[{"SkipNum":2,"ValueNum":1,"bIsLast":true,"bHasAnyZeroes":false}],"ZeroMask":[]},"Value":[{"Name":"QualityLevelMask","IsZero":false,"Value":63}]});
        let make_doc = |len| json!({"Imports":[{"ObjectName":"NiagaraEmitter"}],"Exports":[{"ClassIndex":-1,"SerialOffset":100,"SerialSize":len,"Data":[{"Name":"VersionData","ArrayType":"StructProperty","Value":[platform.clone()]}]}]});
        let mut bytes = vec![0xaa, 0x02, 0x03, 63, 0, 0, 0, 0xbb];
        assert_eq!(
            disable_emitters(&make_doc(bytes.len()), &mut bytes, 100).unwrap(),
            1
        );
        assert_eq!(bytes, [0xaa, 0x02, 0x03, 0, 0, 0, 0, 0xbb]);
        let mut ambiguous = vec![0x02, 0x03, 63, 0, 0, 0, 0x02, 0x03, 63, 0, 0, 0];
        assert!(disable_emitters(&make_doc(ambiguous.len()), &mut ambiguous, 100).is_err());
        assert!(disable_emitters(&make_doc(100), &mut bytes, 100).is_err());
    }

    #[test]
    fn shake_patch_zeroes_only_the_oscillator() {
        let f = |name: &str, v: f64| json!({"$type":"UAssetAPI.PropertyTypes.Objects.FloatPropertyData, UAssetAPI","Name":name,"IsZero":false,"Value":v});
        let frag = |skip: u64, n: u64, last: bool| json!({"SkipNum":skip,"ValueNum":n,"bIsLast":last,"bHasAnyZeroes":false});
        let pitch = json!({"$type":"UAssetAPI.PropertyTypes.Structs.StructPropertyData, UAssetAPI","StructType":"FOscillator","Name":"Pitch","IsZero":false,
            "OriginalStructHeader":{"Fragments":[frag(0, 1, false), frag(1, 1, true)],"ZeroMask":[]},"Value":[f("Amplitude", 0.3), f("Frequency", 5.0)]});
        let doc = json!({"Imports":[],"Exports":[{"ObjectName":"Default__Shake_C","SerialOffset":10,"SerialSize":16,"Data":[f("OscillationDuration", 0.3), pitch]}]});
        let mut raw = [
            0.3_f32.to_le_bytes().as_slice(),
            &[0, 2, 1, 3],
            &0.3_f32.to_le_bytes(),
            &5.0_f32.to_le_bytes(),
        ]
        .concat();
        assert_eq!(disable_shake(&doc, &mut raw, 10).unwrap(), 2);
        assert_eq!(
            raw,
            [0.3_f32.to_le_bytes().as_slice(), &[0, 2, 1, 3], &[0; 8]].concat()
        );
        assert!(
            disable_shake(&doc, &mut [0; 16], 10).is_err(),
            "a moved oscillator stops the build"
        );
        assert_eq!(
            hero("Marvel/Content/Marvel/AbilitySystem/1039/103912/CameraShake_103912_Hit03")
                .as_deref(),
            Some("1039")
        );
        assert_eq!(
            hero("Marvel/Content/Marvel/AbilitySystem/Level/GameMode/2206/CameraShake_403721_Hit"),
            None
        );
    }

    #[test]
    fn effect_hero_choices_cover_the_reference_paths() {
        for id in [NO_IMPACT, NO_TRACERS, NO_SHAKE] {
            let heroes = effect_heroes(id, None).unwrap();
            assert!(!heroes.is_empty());
            // game-mode camera shakes belong to no hero, so excluding every hero still builds them
            assert_eq!(all_excluded(id, &heroes, Path::new("no-game")), id != NO_SHAKE);
            assert!(!all_excluded(id, &[], Path::new("no-game")));
        }
        assert!(inject_fov(&mut json!({}), &mut json!({})).is_err());
        assert!(disable_emitters(&json!({"Exports":[]}), &mut [], 0).is_err());
    }

    /// Uses the supplied mods and installed game extracts; never installs into the game.
    #[test]
    #[ignore]
    fn visual_reference_assets() {
        use rayon::prelude::*;
        let root = std::path::PathBuf::from(
            std::env::var("REPAKXTRA_REFERENCES").expect("REPAKXTRA_REFERENCES"),
        );
        let mut failures = Vec::new();
        let mut checked = 0;
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(4)
            .build()
            .unwrap();
        let stale = std::sync::atomic::AtomicUsize::new(0);
        let extra = std::sync::atomic::AtomicUsize::new(0);
        for (id, kind) in [
            (NO_IMPACT, "impact"),
            (NO_TRACERS, "tracers"),
            (NO_SHAKE, "shake"),
        ] {
            let paths: Vec<_> = effect_paths(id).unwrap().lines().collect();
            let patch = if id == NO_SHAKE {
                disable_shake
            } else {
                disable_emitters
            };
            let results = pool.install(|| {
                paths
                    .par_iter()
                    .map(|rel| {
                        let result = (|| -> Result<(), String> {
                            let doc =
                                read(&root.join(format!("{kind}-all-vanilla-json/{rel}.json")))?;
                            let header = std::fs::read(
                                root.join(format!("{kind}-all-vanilla/{rel}.uasset")),
                            )
                            .map_err(|e| e.to_string())?;
                            let mut raw =
                                std::fs::read(root.join(format!("{kind}-all-vanilla/{rel}.uexp")))
                                    .map_err(|e| e.to_string())?;
                            let reference =
                                std::fs::read(root.join(format!("{kind}-all/{rel}.uexp")))
                                    .map_err(|e| e.to_string())?;
                            // the supplied mod was made for an older game version: nothing to compare
                            if reference.len() != raw.len() {
                                stale.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                return Ok(());
                            }
                            let game = raw.clone();
                            patch(&doc, &mut raw, header.len())?;
                            let reference_header =
                                std::fs::read(root.join(format!("{kind}-all/{rel}.uasset")))
                                    .map_err(|e| e.to_string())?;
                            if reference_header != header {
                                return Err("Rebuilt header differs from the supplied mod".into());
                            }
                            if raw == reference {
                                return Ok(());
                            }
                            // No Screen Shake also zeroes the ~2% of camera curves the supplied mod skipped. The mod
                            // additionally zeroes the duration of four shakes that have no amplitude left either way.
                            const DURATION_ONLY: [&str; 4] = [
                                "CameraShake_2212_103322_RedRoom",
                                "CameraShake_106602_01",
                                "CameraShake_106603_01",
                                "CameraShake_106605_01",
                            ];
                            let duration_only = DURATION_ONLY.iter().any(|n| rel.ends_with(n));
                            for i in 0..raw.len() {
                                let ours = raw[i] != reference[i]
                                    && reference[i] == game[i]
                                    && raw[i] == 0;
                                let theirs =
                                    duration_only && raw[i] == game[i] && reference[i] == 0;
                                if raw[i] != reference[i] && !ours && !theirs {
                                    return Err(format!(
                                        "Rebuilt export differs from the supplied mod at byte {i}"
                                    ));
                                }
                                if ours {
                                    extra.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                }
                            }
                            if kind != "shake" {
                                return Err("Rebuilt export differs from the supplied mod".into());
                            }
                            Ok(())
                        })();
                        result.map_err(|e| format!("{rel}: {e}"))
                    })
                    .collect::<Vec<_>>()
            });
            for result in results {
                match result {
                    Ok(()) => checked += 1,
                    Err(e) => failures.push(e),
                }
            }
            println!("{kind}: checked {} assets", paths.len());
        }
        println!(
            "{checked} exports match their supplied mods, {} older-game references skipped, {} more camera curve bytes zeroed",
            stale.into_inner(),
            extra.into_inner()
        );
        assert!(
            failures.is_empty(),
            "{} failures:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    #[test]
    #[ignore]
    fn fov_real() {
        let root = std::path::PathBuf::from(
            std::env::var("REPAKXTRA_REFERENCES").expect("REPAKXTRA_REFERENCES"),
        );
        let c = read(&root.join("context.json")).unwrap();
        let work = tempfile::tempdir().unwrap();
        let out = work.path().join("out/fov");
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let made = rt.block_on(make(
            Path::new("."),
            c["usmap"].as_str().unwrap(),
            FOV,
            &[],
            Path::new(c["paks"].as_str().unwrap()),
            work.path(),
            &out,
            || false,
            &[],
        ));
        assert!(made.is_ok(), "{made:?}");
        crate::xtra_encrypt::encrypt_built(&out).unwrap();
        assert!(uasset_toolkit::is_iostore_encrypted(
            &out.with_extension("utoc").to_string_lossy()
        )
        .unwrap());
        let check = work.path().join("checked");
        let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
            action: "extract_iostore_legacy",
            game_paks: Some(c["paks"].as_str().unwrap().into()),
            mod_path: Some(out.with_extension("utoc").to_string_lossy().into()),
            output_path: Some(check.to_string_lossy().into()),
            ..Default::default()
        };
        let r = rt
            .block_on(crate::vfx_updater::uasset_tool::run_vfx_uat_request(
                Path::new("."),
                &req,
            ))
            .unwrap();
        assert!(r.success, "{}", r.message);
        let decoded = work.path().join("decoded");
        rt.block_on(convert_uassets_to_json(
            Path::new("."),
            c["usmap"].as_str().unwrap(),
            &check.to_string_lossy(),
            &decoded.to_string_lossy(),
            &NoOpProgressSink,
        ))
        .unwrap();
        let widget = read(&decoded.join(format!("{WIDGET}.json"))).unwrap();
        assert!(items(&widget, "Exports")
            .unwrap()
            .iter()
            .any(|e| e["ObjectName"] == "FOV_BootstrapInjection"));
        let layout = read(&decoded.join(format!("{LAYOUT}.json"))).unwrap();
        assert!(items(&layout, "Imports")
            .unwrap()
            .iter()
            .any(|i| i["ObjectName"] == "FOV_SettingsCollection"));
        assert_eq!(
            walkdir::WalkDir::new(&check)
                .into_iter()
                .flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "uasset"))
                .count(),
            9
        );
        println!("FOV rebuilt, encrypted, extracted and decoded successfully (9 packages)");
    }

    /// A listed asset the game no longer has must not fail extraction, so the rest still builds.
    #[test]
    #[ignore]
    fn missing_listed_asset_is_skipped() {
        let root = std::path::PathBuf::from(
            std::env::var("REPAKXTRA_REFERENCES").expect("REPAKXTRA_REFERENCES"),
        );
        let c = read(&root.join("context.json")).unwrap();
        let work = tempfile::tempdir().unwrap();
        let legacy = work.path().join("legacy");
        let real = effect_paths(NO_IMPACT).unwrap().lines().next().unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(extract_vanilla_assets(
            Path::new("."),
            c["paks"].as_str().unwrap(),
            &legacy.to_string_lossy(),
            &[
                real.to_string(),
                "Marvel/Content/Marvel/Characters/1011/Gone/NS_Gone_Hit_01".to_string(),
            ],
            &NoOpProgressSink,
        ))
        .unwrap();
        assert!(legacy.join(format!("{real}.uexp")).is_file());
        println!("extraction tolerates a missing listed asset");
    }

    /// The USMAP gate on the installed game: with the saved USMAP one build behind (3962284 for 3984769, 2026-10-29),
    /// only built-ins whose game files the patch rewrote wait. Expected from the patch's own package list.
    #[test]
    #[ignore]
    fn usmap_gate_real() {
        let root = std::path::PathBuf::from(std::env::var("REPAKXTRA_REFERENCES").expect("REPAKXTRA_REFERENCES"));
        let c = read(&root.join("context.json")).unwrap();
        let (paks, usmap) = (Path::new(c["paks"].as_str().unwrap()), c["usmap"].as_str().unwrap());
        let gate = |inputs: Vec<String>| crate::xtra_builtins::usmap_ready(paks, usmap, &inputs);
        let waits = |r: Result<(), String>| r.err().map(|e| e.split(" of the ").next().unwrap_or_default().rsplit(' ').next().unwrap_or_default().to_string());
        // the effect ones: only newer heroes' files, and the 23 montages the patch rewrote, may wait
        for id in [NO_IMPACT, NO_TRACERS, NO_SHAKE] {
            let files: Vec<String> = inputs(id, &[], paks).unwrap().iter().map(|p| format!("{p}.uasset")).collect();
            let changed = crate::xtra_broken::changed_since_usmap(paks, usmap, &files).unwrap();
            let listed: HashSet<String> = effect_paths(id).unwrap().lines().map(|l| format!("{l}.uasset")).collect();
            let listed_changed = changed.iter().filter(|c| listed.contains(*c)).count();
            println!("{id}: {} newer effects found, {} files changed by the patch ({listed_changed} of the supplied list)", newer(id, paks).len(), changed.len());
            assert_eq!(listed_changed, if id == NO_SHAKE { 23 } else { 0 }, "{id}");
        }
        assert_eq!(waits(gate(inputs(FOV, &[], paks).unwrap())).as_deref(), Some("1"), "one material its Blueprints import");
        assert_eq!(waits(gate(vec!["Marvel/Content/Marvel/Data/DataTable/UI/Login/MarvelLogoVideoTable".into()])), None);
        assert_eq!(waits(gate(vec!["Marvel/Content/Marvel/Data/DataTable/MarvelHeroSkinTable".into(), "Marvel/Content/Marvel/Data/DataTable/HeroGallery/UISkinTable".into()])).as_deref(), Some("2"));
        println!("USMAP gate matches the patch: effects build without what changed, FOV and default skin wait, logos build");
    }

    /// Builds No Screen Shake from the installed game (no hero excluded) and reads the encrypted package back.
    #[test]
    #[ignore]
    fn shake_real() {
        let root = std::path::PathBuf::from(
            std::env::var("REPAKXTRA_REFERENCES").expect("REPAKXTRA_REFERENCES"),
        );
        let c = read(&root.join("context.json")).unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let work = tempfile::tempdir().unwrap();
        let out = work.path().join("out/shake");
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        let excluded: Vec<String> = Vec::new();
        let made = rt
            .block_on(make(
                Path::new("."),
                c["usmap"].as_str().unwrap(),
                NO_SHAKE,
                &excluded,
                Path::new(c["paks"].as_str().unwrap()),
                work.path(),
                &out,
                || false,
                &[],
            ))
            .unwrap();
        crate::xtra_encrypt::encrypt_built(&out).unwrap();
        assert!(uasset_toolkit::is_iostore_encrypted(
            &out.with_extension("utoc").to_string_lossy()
        )
        .unwrap());
        let extracted = work.path().join("extracted");
        let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
            action: "extract_iostore_legacy",
            game_paks: Some(c["paks"].as_str().unwrap().into()),
            mod_path: Some(out.with_extension("utoc").to_string_lossy().into()),
            output_path: Some(extracted.to_string_lossy().into()),
            ..Default::default()
        };
        let result = rt
            .block_on(crate::vfx_updater::uasset_tool::run_vfx_uat_request(
                Path::new("."),
                &req,
            ))
            .unwrap();
        assert!(result.success, "{}", result.message);
        // every packed asset is the game's own file with only the shake values zeroed
        let mut packed = 0;
        let mut headers = Vec::new();
        for rel in effect_paths(NO_SHAKE).unwrap().lines() {
            let got = extracted.join(format!("{rel}.uexp"));
            if !got.exists() {
                continue;
            }
            let header =
                std::fs::read(root.join(format!("shake-all-vanilla/{rel}.uasset"))).unwrap();
            let mut want =
                std::fs::read(root.join(format!("shake-all-vanilla/{rel}.uexp"))).unwrap();
            let doc = read(&root.join(format!("shake-all-vanilla-json/{rel}.json"))).unwrap();
            assert!(disable_shake(&doc, &mut want, header.len()).unwrap() > 0);
            assert_eq!(std::fs::read(got).unwrap(), want, "{rel}");
            // UAssetTool's packer lists a class dependency twice, and names a package after its file when the
            // game's own name differs (Camerashake_102761). Both only add to the header. Export bytes stay exact.
            let back = std::fs::read(extracted.join(format!("{rel}.uasset"))).unwrap();
            if back != header {
                assert!(back.len() > header.len(), "{rel}: header changed");
                headers.push(rel);
            }
            packed += 1;
        }
        assert!(packed > 0);
        println!(
            "no-screen-shake: {}, {packed} packages built, encrypted and read back, {} headers with the packer's additions",
            made.0,
            headers.len()
        );
    }

    #[test]
    #[ignore]
    fn effects_real() {
        let root = std::path::PathBuf::from(
            std::env::var("REPAKXTRA_REFERENCES").expect("REPAKXTRA_REFERENCES"),
        );
        let c = read(&root.join("context.json")).unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        for (id, kind) in [(NO_IMPACT, "impact"), (NO_TRACERS, "tracers")] {
            let work = tempfile::tempdir().unwrap();
            let out = work.path().join("out/effects");
            std::fs::create_dir_all(out.parent().unwrap()).unwrap();
            let excluded = effect_heroes(id, None)
                .unwrap()
                .into_iter()
                .filter(|h| h != "1017")
                .collect::<Vec<_>>();
            rt.block_on(make(
                Path::new("."),
                c["usmap"].as_str().unwrap(),
                id,
                &excluded,
                Path::new(c["paks"].as_str().unwrap()),
                work.path(),
                &out,
                || false,
                &[],
            ))
            .unwrap();
            crate::xtra_encrypt::encrypt_built(&out).unwrap();
            assert!(uasset_toolkit::is_iostore_encrypted(
                &out.with_extension("utoc").to_string_lossy()
            )
            .unwrap());
            let extracted = work.path().join("extracted");
            let req = crate::vfx_updater::uasset_tool::VfxUatRequest {
                action: "extract_iostore_legacy",
                game_paks: Some(c["paks"].as_str().unwrap().into()),
                mod_path: Some(out.with_extension("utoc").to_string_lossy().into()),
                output_path: Some(extracted.to_string_lossy().into()),
                ..Default::default()
            };
            let result = rt
                .block_on(crate::vfx_updater::uasset_tool::run_vfx_uat_request(
                    Path::new("."),
                    &req,
                ))
                .unwrap();
            assert!(result.success, "{}", result.message);
            let expected = effect_paths(id)
                .unwrap()
                .lines()
                .filter(|rel| crate::xtra_heroes::hero_skin(rel).is_some_and(|h| h.hero == "1017"))
                .collect::<Vec<_>>();
            assert!(!expected.is_empty());
            assert_eq!(
                walkdir::WalkDir::new(&extracted)
                    .into_iter()
                    .flatten()
                    .filter(|e| e.path().extension().is_some_and(|x| x == "uasset"))
                    .count(),
                expected.len()
            );
            for rel in expected {
                assert_eq!(
                    std::fs::read(extracted.join(format!("{rel}.uexp"))).unwrap(),
                    std::fs::read(root.join(format!("{kind}-all/{rel}.uexp"))).unwrap(),
                    "{rel}"
                );
            }
            println!("{id}: built, encrypted and read back with only the chosen hero's effects");
        }
    }
}
