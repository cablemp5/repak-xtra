//! repakxtra: the Project Galacta maker (custom/GalactaWindow.tsx). It makes a second copy of a mesh or texture mod that
//! Project Galacta can swap in per skin instead of replacing the skin. Galacta picks up a mesh under
//! /Game/Marvel/ProjectGalacta/Meshes/<hero>/<skin>/<folder>/ named by a GAL_ModSkinConfig beside it, and the copy must
//! not hold anything at a game path, or it would replace the skin for everyone.
//! For each skin the mod changes: its gameplay mesh (the mod's own, or the game's for a texture mod), every mod file
//! that mesh reaches through its imports, and the game's own material instances of that mesh that use a mod file, all
//! under new names in that folder. Only package headers change. Each export keeps its original bytes, because the
//! library re-encodes textures and mesh material slots a few bytes differently (measured 2026-11-01), and every .uexp
//! is compared byte for byte with its source before packing. Lobby meshes, VFX, sounds and UI are left out: Galacta
//! swaps one gameplay mesh per entry.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::vfx_updater::uasset_tool::VfxUatRequest;
use crate::xtra_ko::{extract, game_path, rel, uassets, uat};
use crate::AppState;

/// A GAL_ModSkinConfig data asset from a working Galacta mod, its names made neutral (SkinName and Author empty)
const TEMPLATE: &str = include_str!("../resources/galacta/config-template.json");
const TEMPLATE_DA: &str = "/Game/Marvel/ProjectGalacta/Meshes/1026/1026001/Template/DA_Template";
const TEMPLATE_SK: &str = "/Game/Marvel/ProjectGalacta/Meshes/1026/1026001/Template/SK_Template";
const AUTHOR: &str = "repakxtra";
/// The fields every UAssetAPI export has. A plain `Export` writes nothing itself, then its Extras: the original bytes.
const EXPORT_FIELDS: [&str; 23] = [
    "ObjectName", "OuterIndex", "ClassIndex", "SuperIndex", "TemplateIndex", "ObjectFlags", "SerialSize", "SerialOffset",
    "ScriptSerializationStartOffset", "ScriptSerializationEndOffset", "bForcedExport", "bNotForClient", "bNotForServer",
    "PackageGuid", "IsInheritedInstance", "PackageFlags", "bNotAlwaysLoadedForEditorGame", "bIsAsset", "GeneratePublicHash",
    "SerializationBeforeSerializationDependencies", "CreateBeforeSerializationDependencies",
    "SerializationBeforeCreateDependencies", "CreateBeforeCreateDependencies",
];
/// One run at a time: they share UAssetTool and the work folder.
static ONE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn short(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// "/Game/X" as an extract-relative path, "Marvel/Content/X" (game_path's other way).
fn rel_path(game: &str) -> String {
    format!("Marvel/Content/{}", game.trim_start_matches("/Game/"))
}

/// (hero, skin) of a path in a skin folder, /Game/Marvel/Characters/1026/1026001/...
fn skin_of(path: &str) -> Option<(String, String)> {
    let mut parts = path.strip_prefix("/Game/Marvel/Characters/")?.split('/');
    let (hero, skin) = (parts.next()?, parts.next()?);
    let digits = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_digit());
    (digits(hero, 4) && digits(skin, 7) && skin.starts_with(hero) && parts.next().is_some()).then(|| (hero.to_string(), skin.to_string()))
}

fn mesh_of(hero: &str, skin: &str) -> String {
    format!("/Game/Marvel/Characters/{hero}/{skin}/Meshes/SK_{hero}_{skin}")
}

/// What a Galacta copy can be made from: "mesh" (a gameplay mesh), "texture" (textures or materials of a skin), or None.
fn kind_of(files: &[String]) -> Option<&'static str> {
    let mut kind = None;
    for f in files {
        let f = f.replace('\\', "/");
        if f.contains("/ProjectGalacta/") {
            return None; // already a Galacta mod (or a copy this made)
        }
        let Some(at) = f.find("Marvel/Content/") else { continue };
        let path = game_path(f[at..].trim_end_matches(".uasset"));
        let Some((hero, skin)) = skin_of(&path) else { continue };
        if f.ends_with(".uasset") && path == mesh_of(&hero, &skin) {
            kind = Some("mesh");
        } else if kind.is_none() && ["Textures/", "Materials/"].iter().any(|d| path.contains(&format!("/{skin}/{d}"))) {
            kind = Some("texture");
        }
    }
    kind
}

/// A name with only what a Windows file name can hold, for "<name> (Galacta)".
fn file_safe(name: &str) -> String {
    let s: String = name.chars().filter(|c| !c.is_control() && !r#"<>:"/\|?*"#.contains(*c)).collect();
    s.trim().trim_end_matches(['.', ' ']).chars().take(80).collect()
}

/// The copy's file stem: "<name> (Galacta)_9999999_P".
fn copy_stem(name: &str) -> String {
    format!("{} (Galacta)_9999999_P", file_safe(name))
}

/// The copy's folder and name suffix: letters and digits only, never all digits (a trailing _<digits> would read as an
/// FName number).
fn folder_of(name: &str) -> String {
    let s: String = name.chars().filter(char::is_ascii_alphanumeric).take(32).collect();
    if s.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) { s } else { format!("Mod{s}") }
}

/// A Library name without its load order suffix: "Skin_9999999_P" -> "Skin".
fn bare(stem: &str) -> &str {
    let s = stem.strip_suffix("_P").unwrap_or(stem);
    match s.rfind('_') {
        Some(i) if i + 1 < s.len() && s[i + 1..].bytes().all(|b| b.is_ascii_digit()) => &s[..i],
        _ => s,
    }
}

/// The packages an asset imports (UAssetAPI JSON).
fn imports(asset: &Value) -> Vec<String> {
    asset["Imports"].as_array().into_iter().flatten()
        .filter(|i| i["ClassName"] == "Package")
        .filter_map(|i| i["ObjectName"].as_str().map(str::to_string))
        .collect()
}

/// Gives the asset (UAssetAPI JSON) and the packages it imports new paths: `map` is old package path -> new. Names
/// are only added to the name map, so every name index in the export bytes still reads the same.
fn rename(asset: &mut Value, map: &HashMap<String, String>) {
    let mut renamed = HashMap::new();
    if let Some(list) = asset["Imports"].as_array_mut() {
        for (i, imp) in list.iter_mut().enumerate() {
            let old = imp["ObjectName"].as_str().unwrap_or_default().to_string();
            if imp["ClassName"] == "Package" && map.contains_key(&old) {
                imp["ObjectName"] = map[&old].clone().into();
                renamed.insert(i, old);
            }
        }
        // the objects inside a renamed package carry its short name
        for imp in list.iter_mut() {
            let outer = imp["OuterIndex"].as_i64().unwrap_or(0);
            let Some(old) = (outer < 0).then(|| renamed.get(&((-outer - 1) as usize))).flatten() else { continue };
            if imp["ObjectName"] == short(old) {
                imp["ObjectName"] = short(&map[old]).into();
            }
        }
    }
    let own = asset["FolderName"].as_str().unwrap_or_default().to_string();
    if let Some(new) = map.get(&own) {
        asset["FolderName"] = new.clone().into();
        for e in asset["Exports"].as_array_mut().into_iter().flatten() {
            if e["OuterIndex"] == 0 && e["ObjectName"] == short(&own) {
                e["ObjectName"] = short(new).into();
            }
        }
    }
    if let Some(names) = asset["NameMap"].as_array_mut() {
        for n in map.values().flat_map(|p| [p.as_str(), short(p)]) {
            if !names.iter().any(|x| x == n) {
                names.push(n.into());
            }
        }
    }
}

/// Every export becomes a plain export holding its bytes from `uasset`'s .uexp, so writing the asset back changes
/// only its header.
fn keep_bytes(asset: &mut Value, uasset: &Path) -> Result<(), String> {
    use base64::Engine;
    let head = std::fs::metadata(uasset).map_err(|e| e.to_string())?.len();
    let body = std::fs::read(uasset.with_extension("uexp")).map_err(|e| e.to_string())?;
    for e in asset["Exports"].as_array_mut().into_iter().flatten() {
        let start = e["SerialOffset"].as_u64().unwrap_or(0).checked_sub(head).ok_or("An export starts inside the header")? as usize;
        let bytes = body.get(start..start + e["SerialSize"].as_u64().unwrap_or(0) as usize).ok_or("An export runs past its .uexp")?;
        let mut plain = serde_json::Map::new();
        plain.insert("$type".into(), "UAssetAPI.ExportTypes.Export, UAssetAPI".into());
        plain.insert("Extras".into(), base64::engine::general_purpose::STANDARD.encode(bytes).into());
        for k in EXPORT_FIELDS {
            plain.insert(k.into(), e[k].clone());
        }
        *e = Value::Object(plain);
    }
    Ok(())
}

/// Sets an int or string property of the config's export.
fn set_prop(asset: &mut Value, name: &str, value: Value) {
    for p in asset["Exports"][0]["Data"].as_array_mut().into_iter().flatten() {
        if p["Name"] == name {
            p["Value"] = value.clone();
        }
    }
}

/// Assets read for one run, by lowercase package path: (package path, .uasset file, JSON).
type Assets = HashMap<String, (String, PathBuf, Value)>;

/// Reads `files` (under `dir`) to JSON into `json` and adds them to `out`.
async fn read(dir: &Path, files: Vec<PathBuf>, json: &Path, usmap: &str, out: &mut Assets) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    let paths = files.iter().map(|p| p.to_string_lossy().to_string()).collect();
    uat(VfxUatRequest { action: "batch_to_json", file_paths: Some(paths), usmap_path: Some(usmap), output_path: Some(json.to_string_lossy().to_string()), base_path: Some(dir.to_string_lossy().to_string()), ..Default::default() }, "Reading the files").await?;
    for f in files {
        let r = rel(dir, &f);
        // a file UAssetTool cannot read is left out (a mesh that is missing stops the run later)
        let Ok(text) = std::fs::read_to_string(json.join(format!("{r}.json"))) else { continue };
        let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
        let path = game_path(&r);
        out.insert(path.to_lowercase(), (path, f, value));
    }
    Ok(())
}

/// UAssetTool's command line (xtra_uat_cli.rs) run once, without a console window: its standard output, or None.
fn cli(args: &[&std::ffi::OsStr]) -> Option<String> {
    let mut cmd = std::process::Command::new(crate::xtra_uat_cli::cli()?);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000 | 0x0000_4000); // CREATE_NO_WINDOW, BELOW_NORMAL_PRIORITY_CLASS
    }
    let out = cmd.output().ok().filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// A game package's streamed data (.ubulk) written to `to`. A game patch can ship a mesh's new header without its bulk
/// data, which the game then keeps reading from the older container, so the extract has none: Black Panther's default
/// mesh, measured 2026-11-01, has its 3.4 MB of LODs only in pakchunkCharacter. A renamed copy gets no such fallback,
/// so it carries the bulk itself. Found by chunk id (the package's CityHash64, chunk type 2), newest container first,
/// the way the game looks. Only meshes need it: material instances have no bulk data, the mod brings its textures.
fn game_bulk(paks: &Path, package: &str, to: &Path) -> Result<(), String> {
    let missing = || format!("The game's mesh data for {} could not be read, so nothing was made.", short(package));
    let hash = cli(&["cityhash".as_ref(), package.as_ref()]).and_then(|o| u64::from_str_radix(o.trim().lines().last()?.trim(), 16).ok()).ok_or_else(missing)?;
    let id: String = hash.to_le_bytes().iter().chain(&[0, 0, 0, 2]).map(|b| format!("{b:02x}")).collect();
    let mut containers: Vec<PathBuf> = crate::xtra_broken::game_containers(paks).into_iter().map(|c| c.0).collect();
    // patches, newest first, then the character containers, then the rest
    let rank = |p: &PathBuf| { let n = p.file_name().unwrap_or_default().to_string_lossy().to_ascii_lowercase(); (!n.starts_with("patch_"), !n.contains("character"), std::cmp::Reverse(n)) };
    containers.sort_by_key(rank);
    let out = tempfile::tempdir().map_err(|e| e.to_string())?;
    for c in containers {
        cli(&["extract_iostore".as_ref(), c.as_os_str(), out.path().as_os_str(), "--chunk-id".as_ref(), id.as_ref()]);
        if let Some(found) = std::fs::read_dir(out.path()).into_iter().flatten().flatten().map(|e| e.path()).find(|p| p.is_file()) {
            return std::fs::rename(&found, to).or_else(|_| std::fs::copy(&found, to).map(|_| ())).map_err(|e| e.to_string());
        }
    }
    Ok(()) // in no container: a mesh without streamed data, nothing to carry
}

/// Adds `from` to `set` with every mod file it reaches through its imports (the mod's version of a file wins).
fn reach(from: String, set: &mut Vec<String>, theirs: &Assets, mine: &Assets) {
    let mut queue = vec![from];
    while let Some(k) = queue.pop() {
        if set.contains(&k) { continue }
        if let Some((_, _, a)) = mine.get(&k).or_else(|| theirs.get(&k)) {
            queue.extend(imports(a).into_iter().map(|p| p.to_lowercase()).filter(|p| mine.contains_key(p)));
        }
        set.push(k);
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Made {
    /// The copy's .pak or .bak_repak, the file the Library lists it by
    path: String,
    /// The skins it has a Galacta entry for
    skins: Vec<String>,
    /// How many of the mod's files are not in the copy (lobby meshes, VFX, sounds, UI)
    left_out: usize,
}

/// Builds the copy into `work`: a packed <stem>.pak/.utoc/.ucas under work/out. Returns its base path, its lines for
/// Galacta's manifest (one per skin) and the number of mod files left out.
async fn build(utoc: &Path, name: &str, paks: &Path, usmap: &str, work: &Path) -> Result<(PathBuf, Vec<String>, usize), String> {
    let (ex, game, json, pack) = (work.join("mod"), work.join("game"), work.join("json"), work.join("pack"));
    std::fs::create_dir_all(&ex).map_err(|e| e.to_string())?;
    uat(VfxUatRequest { action: "extract_iostore_legacy", game_paks: Some(paks.to_string_lossy().to_string()), mod_path: Some(utoc.to_string_lossy().to_string()), output_path: Some(ex.to_string_lossy().to_string()), with_deps: Some(false), ..Default::default() }, "Reading the mod").await?;
    let mut files = Vec::new();
    uassets(&ex, &mut files);
    let mut mine = Assets::new();
    read(&ex, files, &json.join("mod"), usmap, &mut mine).await?;

    // the skins it changes, and whether it brings their gameplay mesh
    let mut skins: BTreeMap<(String, String), bool> = BTreeMap::new();
    for (path, _, _) in mine.values() {
        let Some((hero, skin)) = skin_of(path) else { continue };
        let own = path.eq_ignore_ascii_case(&mesh_of(&hero, &skin));
        if own || ["Textures/", "Materials/"].iter().any(|d| path.contains(&format!("/{skin}/{d}"))) {
            *skins.entry((hero, skin)).or_default() |= own;
        }
    }
    if skins.is_empty() {
        return Err("This mod changes no hero's mesh, textures or materials, so Project Galacta has nothing to swap.".into());
    }
    let mut theirs = Assets::new();
    let need: Vec<String> = skins.iter().filter(|(_, own)| !**own).map(|((h, s), _)| rel_path(&mesh_of(h, s))).collect();
    if !need.is_empty() {
        let dir = game.join("1");
        extract(paks, &dir, need, false).await?;
        let mut found = Vec::new();
        uassets(&dir, &mut found);
        read(&dir, found, &json.join("game1"), usmap, &mut theirs).await?;
        // a game mesh whose streamed data stayed in an older container: the copy needs it under its own name
        for (path, file, _) in theirs.values().filter(|(p, _, _)| skin_of(p).is_some_and(|(h, s)| p.eq_ignore_ascii_case(&mesh_of(&h, &s)))) {
            let (paks, path, bulk) = (paks.to_path_buf(), path.clone(), file.with_extension("ubulk"));
            if !bulk.exists() {
                crate::blocking(move || game_bulk(&paks, &path, &bulk)).await?;
            }
        }
    }

    let folder = folder_of(name);
    let (mut used, mut made, mut out_json, mut checks, mut kept) = (HashSet::new(), Vec::new(), Vec::new(), Vec::new(), HashSet::new());
    for (round, ((hero, skin), _)) in skins.iter().enumerate() {
        let mesh = mesh_of(hero, skin).to_lowercase();
        if !mine.contains_key(&mesh) && !theirs.contains_key(&mesh) {
            continue; // not in the game (a removed skin): nothing to swap
        }
        let mut set = Vec::new();
        reach(mesh.clone(), &mut set, &theirs, &mine);
        // a texture mod changes files the game's own material instances use: those come along, with new names
        let folder_files = |set: &Vec<String>| mine.keys().any(|k| k.starts_with(&format!("/game/marvel/characters/{hero}/{skin}/")) && !set.contains(k) && !k.contains("/lobby/") && !k.ends_with("_lobby"));
        if folder_files(&set) {
            let mesh_json = &theirs.get(&mesh).or_else(|| mine.get(&mesh)).ok_or("The mesh could not be read")?.2;
            let wanted: Vec<String> = imports(mesh_json).into_iter()
                .filter(|p| p.starts_with("/Game/Marvel/Characters/") && !mine.contains_key(&p.to_lowercase()) && short(p).to_ascii_lowercase().starts_with("mi_"))
                .collect();
            if !wanted.is_empty() {
                let dir = game.join(format!("mi{round}"));
                extract(paks, &dir, wanted.iter().map(|p| rel_path(p)).collect(), false).await?;
                let mut found = Vec::new();
                uassets(&dir, &mut found);
                read(&dir, found, &json.join(format!("mi{round}")), usmap, &mut theirs).await?;
                // shortcut: one level, the mesh's own material instances. A mod file used only by a parent of those stays out
                for p in wanted {
                    let k = p.to_lowercase();
                    if theirs.get(&k).is_some_and(|(_, _, a)| imports(a).iter().any(|i| mine.contains_key(&i.to_lowercase()))) {
                        reach(k, &mut set, &theirs, &mine);
                    }
                }
            }
        }
        if !set.iter().any(|k| mine.contains_key(k)) {
            continue; // the mod's files of this skin are not on its gameplay mesh (lobby only, for one)
        }
        kept.extend(set.iter().filter(|k| mine.contains_key(*k)).cloned());
        let dir = format!("/Game/Marvel/ProjectGalacta/Meshes/{hero}/{skin}/{folder}");
        let mut map = HashMap::new();
        for k in &set {
            let (path, _, _) = mine.get(k).or_else(|| theirs.get(k)).ok_or("A file went missing")?;
            let mut new = format!("{dir}/{}_{folder}", short(path));
            for n in 2.. {
                if used.insert(new.to_lowercase()) { break }
                new = format!("{dir}/{}_{folder}{n}", short(path));
            }
            map.insert(path.clone(), new);
        }
        for k in &set {
            let (path, file, asset) = mine.get(k).or_else(|| theirs.get(k)).ok_or("A file went missing")?;
            let mut asset = asset.clone();
            keep_bytes(&mut asset, file)?;
            rename(&mut asset, &map);
            let new = &map[path];
            out_json.push((rel_path(new), asset));
            checks.push((file.with_extension("uexp"), pack.join(format!("{}.uexp", rel_path(new)))));
            for x in ["ubulk", "uptnl"] {
                let side = file.with_extension(x);
                if side.is_file() {
                    let to = pack.join(format!("{}.{x}", rel_path(new)));
                    std::fs::create_dir_all(to.parent().unwrap()).map_err(|e| e.to_string())?;
                    std::fs::copy(&side, &to).map_err(|e| e.to_string())?;
                }
            }
        }
        let mut config: Value = serde_json::from_str(TEMPLATE).map_err(|e| e.to_string())?;
        let mesh_path = mine.get(&mesh).or_else(|| theirs.get(&mesh)).map(|a| a.0.clone()).ok_or("The mesh could not be read")?;
        let da = format!("{dir}/DA_{folder}");
        rename(&mut config, &HashMap::from([(TEMPLATE_DA.to_string(), da.clone()), (TEMPLATE_SK.to_string(), map[&mesh_path].clone())]));
        set_prop(&mut config, "TargetHeroID", hero.parse::<i64>().unwrap_or_default().into());
        set_prop(&mut config, "TargetSkinID", skin.parse::<i64>().unwrap_or_default().into());
        set_prop(&mut config, "SkinName", name.into());
        set_prop(&mut config, "Author", AUTHOR.into());
        out_json.push((rel_path(&da), config));
        // its line in Galacta's manifest (skins.txt): hero|skin|mesh object|name|author|form (0: the hero's only form)
        let new_mesh = &map[&mesh_path];
        made.push(format!("{hero}|{skin}|{new_mesh}.{}|{}|{AUTHOR}|0", short(new_mesh), name.replace('|', " ")));
    }
    if made.is_empty() {
        return Err("None of this mod's files are on a hero's gameplay mesh, so Project Galacta has nothing to swap.".into());
    }

    // write the renamed JSON back to assets, check every body is still the source's, then pack
    let jdir = json.join("out");
    let mut paths = Vec::new();
    for (r, asset) in &out_json {
        let p = jdir.join(format!("{r}.json"));
        std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&p, serde_json::to_vec(asset).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        paths.push(p.to_string_lossy().to_string());
    }
    uat(VfxUatRequest { action: "batch_from_json", file_paths: Some(paths), usmap_path: Some(usmap), output_path: Some(pack.to_string_lossy().to_string()), base_path: Some(jdir.to_string_lossy().to_string()), ..Default::default() }, "Writing the Galacta files").await?;
    for (from, to) in &checks {
        if std::fs::read(from).ok() != std::fs::read(to).ok() {
            return Err(format!("{} changed while it was renamed, so nothing was made.", to.file_stem().unwrap_or_default().to_string_lossy()));
        }
    }
    let base = work.join("out").join(copy_stem(name));
    std::fs::create_dir_all(work.join("out")).map_err(|e| e.to_string())?;
    uat(VfxUatRequest { action: "create_mod_iostore", output_path: Some(base.to_string_lossy().to_string()), input_dir: Some(pack.to_string_lossy().to_string()), compress: Some(true), ..Default::default() }, "Packing the copy").await?;
    Ok((base, made, mine.len() - kept.len()))
}

/// Puts the packed copy beside the mod, on when `on` says so or an earlier copy there is on, else off (.bak_repak).
/// All or nothing. An earlier copy in the other state goes, so there is never an on and an off copy at once.
fn install(base: &Path, dir: &Path, stem: &str, on: bool) -> Result<PathBuf, String> {
    let on = on || dir.join(format!("{stem}.pak")).is_file();
    let (ext, other) = if on { ("pak", "bak_repak") } else { ("bak_repak", "pak") };
    let pak = dir.join(format!("{stem}.{ext}"));
    let parts = [("utoc", dir.join(format!("{stem}.utoc"))), ("ucas", dir.join(format!("{stem}.ucas"))), ("pak", pak.clone())];
    let tmp = |to: &Path| to.with_file_name(format!("{}.galacta-new", to.file_name().unwrap_or_default().to_string_lossy()));
    for (x, to) in &parts {
        if let Err(e) = std::fs::copy(format!("{}.{x}", base.display()), tmp(to)) {
            parts.iter().for_each(|(_, t)| { let _ = std::fs::remove_file(tmp(t)); });
            return Err(format!("Could not copy the Galacta version into the mods folder: {e}"));
        }
    }
    for (_, to) in &parts {
        std::fs::rename(tmp(to), to).map_err(|e| format!("Could not put the Galacta version in place: {e}"))?;
    }
    let _ = std::fs::remove_file(dir.join(format!("{stem}.{other}")));
    Ok(pak)
}

/// Galacta's manifest, Content/Marvel/ProjectGalacta/skins.txt: one line per mod skin,
/// hero|skin|mesh object|name|author|form, CRLF, as its Companion App writes it (compared with the app's own file,
/// 2026-11-01, the format is not documented). Galacta skips a line without the form number (TargetSculptID, 0 for a hero
/// with one form), which older app versions left out, so a kept line without it gets "|0". Lines for these meshes replace
/// any earlier ones, the rest stay, and the old file is kept as skins.txt.bak like the app does.
/// shortcut: a copy turned off or deleted later keeps its line until the Companion App rescans.
fn add_to_manifest(content: &Path, lines: &[String]) -> Result<(), String> {
    let dir = content.join("Marvel").join("ProjectGalacta");
    let file = dir.join("skins.txt");
    let old = std::fs::read_to_string(&file).unwrap_or_default();
    let mesh = |l: &str| l.split('|').nth(2).map(str::to_ascii_lowercase);
    let ours: HashSet<_> = lines.iter().filter_map(|l| mesh(l)).collect();
    let mut all: Vec<String> = old.lines().map(str::trim_end)
        .filter(|l| !l.is_empty() && !mesh(l).is_some_and(|m| ours.contains(&m)))
        .map(|l| if l.split('|').count() == 5 { format!("{l}|0") } else { l.to_string() })
        .collect();
    all.extend(lines.iter().cloned());
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not write Galacta's skin list: {e}"))?;
    if file.is_file() {
        let _ = std::fs::copy(&file, dir.join("skins.txt.bak"));
    }
    std::fs::write(&file, all.iter().map(|l| format!("{l}\r\n")).collect::<String>()).map_err(|e| format!("Could not write Galacta's skin list: {e}"))
}

/// Makes the Galacta copy of one mod (its .pak, .bak_repak or .utoc) and puts it beside the mod, on when `on` says so
/// (the window then turns the original off with toggle_mod), else off. `name` is the mod's name in the Library: the
/// copy is "<name> (Galacta)", and Galacta's Companion App shows `name`.
#[tauri::command]
pub async fn xtra_galacta_make(window: tauri::Window, path: String, name: String, usmap_path: String, on: bool, state: State<'_, Arc<Mutex<AppState>>>) -> Result<Made, String> {
    let _one = ONE.try_lock().map_err(|_| "A Galacta version is already being made.")?;
    let name = file_safe(&name);
    if name.is_empty() {
        return Err("The mod needs a name.".into());
    }
    let utoc = crate::xtra_bundle::companion(Path::new(&path), "utoc");
    if !utoc.is_file() {
        return Err("Only IoStore mods (.utoc and .ucas) can be made Galacta compatible. Install it through repakxtra first.".into());
    }
    let paks = crate::xtra_ko::paks(&state)?;
    let token = uuid::Uuid::new_v4().to_string();
    if !crate::xtra_vfx::xtra_vfx_claim(window.clone(), token.clone(), Some("Making a Galacta version".into())) {
        return Err("Wait for the Mod Updater to finish first.".into());
    }
    let work = std::env::temp_dir().join("repak-x").join("galacta").join(&token);
    let built = build(&utoc, &name, &paks, &usmap_path, &work).await;
    crate::xtra_vfx::xtra_vfx_release(window, token);
    let result = match built {
        Ok((base, lines, left_out)) => {
            let skins = lines.iter().filter_map(|l| l.split('|').nth(1)).map(str::to_string).collect();
            let content = paks.parent().ok_or("The game folder has no Content folder")?.to_path_buf();
            let dir = utoc.parent().ok_or("The mod has no folder")?.to_path_buf();
            let bypass = state.lock().unwrap().bypass_game_running_lock;
            crate::blocking(move || {
                let _mutation = crate::xtra_mutation::edit()?;
                crate::xtra_identity::upstream_guard()?;
                if !bypass && crate::is_game_process_running() {
                    return Err("Marvel Rivals is running. Close it, then try again.".into());
                }
                let pak = install(&base, &dir, &copy_stem(&name), on)?;
                if on {
                    // listed in the Skin Swapper without a Companion App scan (it reads the manifest at every hero select)
                    add_to_manifest(&content, &lines)?;
                }
                Ok(Made { path: pak.to_string_lossy().into_owned(), skins, left_out })
            }).await
        }
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_dir_all(&work);
    result
}

/// One mod for the Galacta window's list.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    path: String,
    name: String,
    enabled: bool,
    hero: Option<String>,
    modified: u64,
    /// "mesh" or "texture"
    kind: &'static str,
    /// Its Galacta version is already beside it
    made: bool,
}

/// The Library's mods a Galacta version can be made from (a hero's gameplay mesh, or a skin's textures or materials),
/// read from their .utoc. Galacta mods themselves, and copies made here, are left out.
#[tauri::command]
pub async fn xtra_galacta_list(state: State<'_, Arc<Mutex<AppState>>>) -> Result<Vec<Listed>, String> {
    let mods = crate::get_pak_files(state.clone()).await?;
    let state = state.inner().clone();
    crate::blocking(move || {
        Ok(mods.into_iter().filter_map(|m| {
            let utoc = m.utoc_path.clone().filter(|u| u.is_file())?;
            let files: Vec<String> = crate::utoc_utils::try_read_utoc(&utoc).ok()?.into_iter().map(|e| e.file_path).collect();
            let kind = kind_of(&files)?;
            let file = m.path.file_name()?.to_string_lossy().to_string();
            let name = m.custom_name.clone().filter(|c| !c.is_empty()).unwrap_or_else(|| bare(crate::xtra_bundle::stem(&file)).to_string());
            let stem = copy_stem(&name);
            let made = ["pak", "bak_repak"].iter().any(|x| m.path.with_file_name(format!("{stem}.{x}")).is_file());
            // the mod list leaves the hero empty for most mods: it comes from their details, as in the Encrypt window
            let hero = m.character_name.clone().filter(|c| !c.is_empty())
                .or_else(|| crate::compute_mod_details(&m.path, &state).ok().map(|d| d.character_name).filter(|c| !c.is_empty()));
            Some(Listed { path: m.path.to_string_lossy().into_owned(), name, enabled: m.enabled, hero, modified: m.modified_date, kind, made })
        }).collect())
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_and_skins() {
        assert_eq!(skin_of("/Game/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001"), Some(("1026".into(), "1026001".into())));
        assert_eq!(skin_of("/Game/Marvel/Characters/1026/1011001/Meshes/X"), None, "another hero's skin id");
        assert_eq!(skin_of("/Game/Marvel/Characters/1026/1026001"), None, "the folder itself");
        assert_eq!(bare("Black Skin_9999999_P"), "Black Skin");
        assert_eq!(bare("Skin_v2"), "Skin_v2");
        assert_eq!(copy_stem("Gold: Suit?"), "Gold Suit (Galacta)_9999999_P");
        assert_eq!(folder_of("bp-tung swap v1"), "bptungswapv1");
        assert_eq!(folder_of("2099"), "Mod2099", "never all digits");
        assert_eq!(rel_path(&game_path("Marvel/Content/Marvel/X/Y")), "Marvel/Content/Marvel/X/Y");
    }

    #[test]
    fn mesh_and_texture_mods_are_told_apart() {
        let v = |f: &[&str]| f.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let c = "../../../Marvel/Content/Marvel/Characters/1026/1026001";
        assert_eq!(kind_of(&v(&[&format!("{c}/Textures/T_Body_D.uasset"), &format!("{c}/Meshes/SK_1026_1026001.uasset")])), Some("mesh"));
        assert_eq!(kind_of(&v(&[&format!("{c}/Textures/T_Body_D.uasset")])), Some("texture"));
        assert_eq!(kind_of(&v(&[&format!("{c}/Meshes/SK_1026_1026001_Lobby.uasset")])), None, "a lobby mesh alone");
        assert_eq!(kind_of(&v(&["../../../Marvel/Content/Marvel/VFX/T_Glow.uasset"])), None);
        assert_eq!(kind_of(&v(&[&format!("{c}/Meshes/SK_1026_1026001.uasset"), "../../../Marvel/Content/Marvel/ProjectGalacta/Meshes/1026/1026001/X/SK.uasset"])), None);
    }

    #[test]
    fn rename_moves_the_package_and_its_imports_only() {
        let mut a = json!({
            "FolderName": "/Game/C/SK_1",
            "NameMap": ["/Game/C/SK_1", "/Game/C/MI_A"],
            "Imports": [
                {"ObjectName": "/Game/C/MI_A", "ClassName": "Package", "OuterIndex": 0},
                {"ObjectName": "MI_A", "ClassName": "MaterialInstanceConstant", "OuterIndex": -1},
                {"ObjectName": "/Game/C/SK_1_Skeleton", "ClassName": "Package", "OuterIndex": 0},
                {"ObjectName": "SK_1_Skeleton", "ClassName": "Skeleton", "OuterIndex": -3}
            ],
            "Exports": [{"ObjectName": "SK_1", "OuterIndex": 0}, {"ObjectName": "MorphA", "OuterIndex": 1}]
        });
        let map = HashMap::from([("/Game/C/SK_1".to_string(), "/Game/G/SK_1_F".to_string()), ("/Game/C/MI_A".to_string(), "/Game/G/MI_A_F".to_string())]);
        rename(&mut a, &map);
        assert_eq!(a["FolderName"], "/Game/G/SK_1_F");
        assert_eq!(a["Exports"][0]["ObjectName"], "SK_1_F");
        assert_eq!(a["Exports"][1]["ObjectName"], "MorphA");
        assert_eq!(a["Imports"][0]["ObjectName"], "/Game/G/MI_A_F");
        assert_eq!(a["Imports"][1]["ObjectName"], "MI_A_F");
        assert_eq!(a["Imports"][3]["ObjectName"], "SK_1_Skeleton", "the game's skeleton stays");
        let names: Vec<&str> = a["NameMap"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert_eq!(&names[..2], ["/Game/C/SK_1", "/Game/C/MI_A"], "old names keep their indexes");
        assert!(names.contains(&"SK_1_F") && names.contains(&"/Game/G/MI_A_F"));
    }

    #[test]
    fn the_manifest_keeps_other_lines_and_replaces_ours() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("Marvel/ProjectGalacta");
        std::fs::create_dir_all(&dir).unwrap();
        // an old app's line (no form number), one of ours to replace, and another app's line with form 2
        std::fs::write(dir.join("skins.txt"), "1026|1026001|/Game/A/SK_A.SK_A|A|x\r\n1026|1026001|/Game/B/SK_B.SK_B|Old B|repakxtra|0\r\n1026|1026001|/Game/C/SK_C.SK_C|C|y|2\r\n").unwrap();
        add_to_manifest(d.path(), &["1026|1026001|/Game/B/SK_B.SK_B|New B|repakxtra|0".into()]).unwrap();
        assert_eq!(std::fs::read(dir.join("skins.txt")).unwrap(),
            b"1026|1026001|/Game/A/SK_A.SK_A|A|x|0\r\n1026|1026001|/Game/C/SK_C.SK_C|C|y|2\r\n1026|1026001|/Game/B/SK_B.SK_B|New B|repakxtra|0\r\n",
            "CRLF, a 5-field line gets its form number, a form already there stays");
        assert!(std::fs::read_to_string(dir.join("skins.txt.bak")).unwrap().contains("Old B"));
        let fresh = tempfile::tempdir().unwrap();
        add_to_manifest(fresh.path(), &["1|2|/Game/C.C|C|repakxtra".into()]).unwrap();
        assert!(fresh.path().join("Marvel/ProjectGalacta/skins.txt").is_file(), "made when Galacta has none yet");
    }

    #[test]
    fn install_is_on_or_off_never_both() {
        let d = tempfile::tempdir().unwrap();
        let base = d.path().join("built");
        for x in ["pak", "utoc", "ucas"] { std::fs::write(format!("{}.{x}", base.display()), x).unwrap(); }
        let mods = d.path().join("mods");
        std::fs::create_dir(&mods).unwrap();
        assert_eq!(install(&base, &mods, "S", false).unwrap(), mods.join("S.bak_repak"));
        assert_eq!(install(&base, &mods, "S", true).unwrap(), mods.join("S.pak"));
        assert!(!mods.join("S.bak_repak").exists(), "the old off copy goes");
        assert_eq!(install(&base, &mods, "S", false).unwrap(), mods.join("S.pak"), "a copy that is on stays on");
        assert_eq!(std::fs::read(mods.join("S.ucas")).unwrap(), b"ucas");
    }

    #[test]
    fn the_config_template_points_at_the_new_mesh() {
        let mut c: Value = serde_json::from_str(TEMPLATE).unwrap();
        rename(&mut c, &HashMap::from([(TEMPLATE_DA.to_string(), "/Game/Marvel/ProjectGalacta/Meshes/1011/1011001/F/DA_F".to_string()), (TEMPLATE_SK.to_string(), "/Game/Marvel/ProjectGalacta/Meshes/1011/1011001/F/SK_1011_1011001_F".to_string())]));
        set_prop(&mut c, "TargetSkinID", 1011001.into());
        set_prop(&mut c, "Author", AUTHOR.into());
        assert_eq!(c["FolderName"], "/Game/Marvel/ProjectGalacta/Meshes/1011/1011001/F/DA_F");
        assert_eq!(c["Exports"][0]["ObjectName"], "DA_F");
        assert_eq!(imports(&c), ["/Game/Marvel/ProjectGalacta/Blueprints/GAL_ModSkinConfig", "/Game/Marvel/ProjectGalacta/Meshes/1011/1011001/F/SK_1011_1011001_F"]);
        let data = c["Exports"][0]["Data"].as_array().unwrap();
        assert!(data.iter().any(|p| p["Name"] == "TargetSkinID" && p["Value"] == 1011001));
        assert!(data.iter().any(|p| p["Name"] == "Author" && p["Value"] == AUTHOR));
    }
}

