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
const LAYOUT: &str =
    "Marvel/Content/Marvel/Data/DataTable/UI/Setting/SettingPageLayout/SettingPageLayoutTable";
const WIDGET: &str =
    "Marvel/Content/Marvel/UI/Blueprints/SelectHero/Corona/WBP_SelectHero_HeroCorona";

fn effect_paths(id: &str) -> Option<&'static str> {
    match id {
        NO_IMPACT => Some(include_str!("../resources/visual-builtins/impact.txt")),
        NO_TRACERS => Some(include_str!("../resources/visual-builtins/tracers.txt")),
        _ => None,
    }
}
pub(crate) fn effect_heroes(id: &str) -> Option<Vec<String>> {
    let paths = effect_paths(id)?;
    let mut heroes: Vec<_> = paths
        .lines()
        .filter_map(crate::xtra_heroes::hero_skin)
        .map(|h| h.hero)
        .collect();
    heroes.sort();
    heroes.dedup();
    Some(heroes)
}
pub(crate) fn all_excluded(id: &str, excluded: &[String]) -> bool {
    effect_paths(id).is_some_and(|paths| {
        paths
            .lines()
            .all(|p| crate::xtra_heroes::hero_skin(p).is_some_and(|h| excluded.contains(&h.hero)))
    })
}
pub(crate) fn overlapping(root: &Path, id: &str) -> Vec<String> {
    let prefix = match id {
        NO_IMPACT => "znoimpact_",
        NO_TRACERS => "znotracersall_",
        FOV => "!fovslider_",
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
            let mut bytes = Vec::new();
            let h = &v["OriginalStructHeader"];
            for f in items(h, "Fragments")? {
                let skip = f["SkipNum"]
                    .as_u64()
                    .filter(|n| *n <= 127)
                    .ok_or("Invalid platform header")? as u16;
                let count = f["ValueNum"]
                    .as_u64()
                    .filter(|n| *n <= 127)
                    .ok_or("Invalid platform header")? as u16;
                let packed = skip
                    | (if f["bHasAnyZeroes"] == true { 0x80 } else { 0 })
                    | (count << 9)
                    | (if f["bIsLast"] == true { 0x100 } else { 0 });
                bytes.extend(packed.to_le_bytes());
            }
            let zeros = items(h, "ZeroMask")?;
            if !zeros.is_empty() {
                if zeros.len() > 8 {
                    return Err("Emitter platform zero mask changed".into());
                }
                bytes.push(
                    zeros
                        .iter()
                        .enumerate()
                        .fold(0, |b, (i, v)| b | if v == true { 1 << i } else { 0 }),
                );
            }
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
        let is_renderer = class
            .and_then(|c| c["ObjectName"].as_str())
            .is_some_and(|n| n.starts_with("Niagara") && n.ends_with("RendererProperties"));
        if is_emitter || is_renderer {
            if export["$type"]
                .as_str()
                .is_some_and(|t| t.contains("RawExport"))
                || !export["Data"].is_array()
            {
                return Err(crate::xtra_builtins::MAPPINGS_BEHIND.into());
            }
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

pub async fn make(
    tool: &Path,
    usmap: &str,
    id: &str,
    excluded: &[String],
    paks: &Path,
    work: &Path,
    out: &Path,
    cancelled: fn() -> bool,
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
    let list = effect_paths(id).ok_or("Unknown visual built-in")?;
    let mut heroes = HashSet::new();
    let all_paths: Vec<_> = list.lines().collect();
    for p in &all_paths {
        if let Some(h) = crate::xtra_heroes::hero_skin(p) {
            heroes.insert(h.hero);
        }
    }
    let paths: Vec<String> = all_paths
        .into_iter()
        .filter(|p| {
            let hero = crate::xtra_heroes::hero_skin(p).map(|h| h.hero);
            !hero.as_ref().is_some_and(|h| excluded.contains(h))
        })
        .map(str::to_string)
        .collect();
    if paths.is_empty() {
        return Err("Every effect hero is excluded".into());
    }
    extract_vanilla_assets(tool, &s(paks), &s(&legacy), &paths, &sink).await?;
    let mut count = 0;
    // Niagara JSON contains large script arrays. Decode bounded batches and discard them immediately.
    for batch in paths.chunks(8) {
        if cancelled() {
            return Err("Build stopped".into());
        }
        use crate::vfx_updater::uasset_tool::{run_vfx_uat_request, VfxUatRequest};
        let request = VfxUatRequest {
            action: "batch_to_json",
            file_paths: Some(
                batch
                    .iter()
                    .map(|rel| s(&legacy.join(format!("{rel}.uasset"))))
                    .collect(),
            ),
            usmap_path: Some(usmap),
            output_path: Some(s(&json_dir)),
            base_path: Some(s(&legacy)),
            ..Default::default()
        };
        let response = run_vfx_uat_request(tool, &request).await?;
        if !response.success {
            return Err(format!(
                "Effect assets could not be decoded: {}",
                response.message
            ));
        }
        for rel in batch {
            let doc = read(&json_dir.join(format!("{rel}.json")))?;
            let header = std::fs::read(legacy.join(format!("{rel}.uasset")))
                .map_err(|e| format!("{rel}: {e}"))?;
            let mut raw =
                std::fs::read(legacy.join(format!("{rel}.uexp"))).map_err(|e| e.to_string())?;
            count += disable_emitters(&doc, &mut raw, header.len())
                .map_err(|e| format!("{rel}: {e}"))?;
            let dest = staged.join(rel);
            std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::write(dest.with_extension("uasset"), header).map_err(|e| e.to_string())?;
            std::fs::write(dest.with_extension("uexp"), raw).map_err(|e| e.to_string())?;
        }
        std::fs::remove_dir_all(&json_dir).map_err(|e| e.to_string())?;
    }
    if cancelled() {
        return Err("Build stopped".into());
    }
    pack_to_iostore(tool, usmap, &s(&staged), &s(out), None, &sink).await?;
    let mut heroes: Vec<_> = heroes.into_iter().collect();
    heroes.sort();
    Ok((
        format!(
            "{} effect assets, {count} emitter masks disabled",
            paths.len()
        ),
        heroes,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn effect_hero_choices_cover_the_reference_paths() {
        for id in [NO_IMPACT, NO_TRACERS] {
            let heroes = effect_heroes(id).unwrap();
            assert!(!heroes.is_empty());
            assert!(all_excluded(id, &heroes));
            assert!(!all_excluded(id, &[]));
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
        for (id, kind) in [(NO_IMPACT, "impact"), (NO_TRACERS, "tracers")] {
            let paths: Vec<_> = effect_paths(id).unwrap().lines().collect();
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
                            disable_emitters(&doc, &mut raw, header.len())?;
                            let reference =
                                std::fs::read(root.join(format!("{kind}-all/{rel}.uexp")))
                                    .map_err(|e| e.to_string())?;
                            if raw != reference {
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
        println!("{checked} effect exports match their supplied mods byte for byte");
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
            let excluded = effect_heroes(id)
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
