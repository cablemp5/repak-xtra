//! repakxtra: the KO Editor's game files (custom/ko/). Every hero's KO prompt is a widget the game ships at
//! UI/Blueprints/Battle/Custom/<hero>/WBP_Battle_Kill_<hero>_V<n>, with its flipbook materials and textures beside it.
//! They are read from the installed game each time, cached per game build and USMAP, so a patch that changes a prompt
//! changes the editor (and every mod it makes) too. Nothing here is a stored copy of a game file.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Emitter, State, Window};

use crate::vfx_updater::uasset_tool::{run_vfx_uat_request, VfxUatRequest};
use crate::AppState;

const WIDGETS: &str = "Marvel/Content/Marvel/UI/Blueprints/Battle/Custom/";
/// One extraction at a time: they share the cache folders, and a second one would delete what the first is reading.
static ONE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn root() -> PathBuf {
    std::env::temp_dir().join("repak-x").join("ko")
}

pub(crate) fn paks(state: &State<'_, Arc<Mutex<AppState>>>) -> Result<PathBuf, String> {
    let mods = state.lock().unwrap().game_path.clone();
    crate::xtra_broken::paks_dir(&mods).ok_or_else(|| "Set the game folder in Setup first.".to_string())
}

/// This game build's and USMAP's folder. Folders of other builds go: they would hand out old or wrongly read files.
fn build_dir(paks: &Path, usmap: &str) -> PathBuf {
    let dir = root().join(format!("{}-{}", crate::xtra_vfx::build_hash(paks), crate::xtra_vfx::usmap_hash(usmap)));
    if let Ok(entries) = std::fs::read_dir(root()) {
        for e in entries.flatten().filter(|e| e.path() != dir) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
    dir
}

pub(crate) async fn uat(request: VfxUatRequest<'_>, what: &str) -> Result<serde_json::Value, String> {
    let r = run_vfx_uat_request(Path::new(""), &request).await?;
    if !r.success {
        return Err(format!("{what} failed: {}", r.message));
    }
    Ok(r.data.unwrap_or_default())
}

pub(crate) async fn extract(paks: &Path, out: &Path, patterns: Vec<String>, with_deps: bool) -> Result<(), String> {
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    let request = VfxUatRequest {
        action: "extract_iostore_legacy",
        game_paks: Some(paks.to_string_lossy().to_string()),
        output_path: Some(out.to_string_lossy().to_string()),
        filter_patterns: Some(patterns),
        with_deps: Some(with_deps),
        ..Default::default()
    };
    uat(request, "Reading the game's files").await.map(|_| ())
}

pub(crate) fn uassets(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            uassets(&p, out)
        } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("uasset")) {
            out.push(p)
        }
    }
}

/// `dir`-relative path with forward slashes and no extension: Marvel/Content/Marvel/UI/...
pub(crate) fn rel(dir: &Path, p: &Path) -> String {
    p.strip_prefix(dir).unwrap_or(p).with_extension("").to_string_lossy().replace('\\', "/")
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct KoHero {
    id: String,
    name: String,
    /// Its widget, extract-relative without extension
    widget: String,
}

/// One widget per hero folder: the newest version when a hero has more than one (V3, then V4 after a patch).
fn heroes_in(dir: &Path) -> Vec<KoHero> {
    let mut files = Vec::new();
    uassets(dir, &mut files);
    let mut by_id = std::collections::BTreeMap::<String, String>::new();
    for f in &files {
        let r = rel(dir, f);
        let stem = r.rsplit('/').next().unwrap_or("");
        let Some(id) = r.split('/').rev().nth(1) else { continue };
        if !stem.to_ascii_lowercase().starts_with("wbp_battle_kill_") || !id.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let e = by_id.entry(id.to_string()).or_default();
        if version(&r) >= version(e) {
            *e = r;
        }
    }
    by_id
        .into_iter()
        .map(|(id, widget)| KoHero { name: crate::character_data::get_character_name_from_id(&id).unwrap_or_else(|| format!("Hero {id}")), id, widget })
        .collect()
}

fn version(widget: &str) -> u32 {
    widget.rsplit("_V").next().and_then(|v| v.parse().ok()).unwrap_or(0)
}

/// Every hero with a KO prompt in the installed game, by name.
#[tauri::command]
pub async fn xtra_ko_heroes(usmap_path: String, state: State<'_, Arc<Mutex<AppState>>>) -> Result<Vec<KoHero>, String> {
    let paks = paks(&state)?;
    let dir = build_dir(&paks, &usmap_path).join("widgets");
    let done = dir.join(".done");
    if !done.exists() {
        let _ = std::fs::remove_dir_all(&dir);
        extract(&paks, &dir, vec![WIDGETS.to_string()], false).await?;
        let _ = std::fs::write(&done, "");
    }
    let mut list = heroes_in(&dir);
    if list.is_empty() {
        return Err("The installed game has no KO prompts where they used to be. A patch may have moved them.".into());
    }
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(list)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KoLoaded {
    /// The extract: the widget and everything it uses, in the game's folder layout (the export rebuilds from it)
    extract: String,
    /// The widget's JSON (UAssetTool's full form, the one that converts back)
    widget_json: String,
    /// Each material instance's JSON, by its package path (/Game/...)
    materials: Vec<(String, String)>,
    /// Each texture's PNG, by its package path
    textures: Vec<(String, String)>,
}

/// Every `ext` file under `dir`, as (package path, file path).
fn listed(dir: &Path, ext: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut walk = vec![dir.to_path_buf()];
    while let Some(d) = walk.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() { walk.push(p) } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case(ext)) {
                out.push((game_path(&rel(dir, &p)), p.to_string_lossy().replace('\\', "/")))
            }
        }
    }
    out
}

pub(crate) fn game_path(r: &str) -> String {
    format!("/Game/{}", r.trim_start_matches("Marvel/Content/"))
}

/// The hero's widget with its materials and textures: JSON and PNGs, made once per game build (about 20 s).
#[tauri::command]
pub async fn xtra_ko_load(window: Window, usmap_path: String, widget: String, state: State<'_, Arc<Mutex<AppState>>>) -> Result<KoLoaded, String> {
    let _one = ONE.lock().await;
    // the editor's loading bar: which of the three slow steps runs now (custom/ko/KoEditor.tsx)
    let step = |n: u8| { let _ = window.emit("ko-progress", n); };
    if widget.contains("..") || !widget.starts_with(WIDGETS) {
        return Err("Not a KO prompt".into());
    }
    let paks = paks(&state)?;
    let stem = widget.rsplit('/').next().unwrap_or("widget").to_string();
    let base = build_dir(&paks, &usmap_path).join("hero").join(&stem);
    let (ex, json, png) = (base.join("extract"), base.join("json"), base.join("png"));
    let done = base.join(".done");
    if !done.exists() {
        let _ = std::fs::remove_dir_all(&base);
        step(1);
        // with its dependencies: the materials and textures it draws, and the schemas its JSON needs to convert back
        extract(&paks, &ex, vec![widget.clone()], true).await?;
        let mut files = Vec::new();
        uassets(&ex, &mut files);
        let ui = |p: &PathBuf, dir: &str| rel(&ex, p).starts_with(&format!("Marvel/Content/Marvel/UI/{dir}/"));
        let name = |p: &PathBuf| p.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        let to_json: Vec<String> = files.iter().filter(|p| rel(&ex, p) == widget || (ui(p, "Materials") && name(p).starts_with("mi_")))
            .map(|p| p.to_string_lossy().to_string()).collect();
        let pngs: Vec<String> = files.iter().filter(|p| ui(p, "Textures")).map(|p| p.to_string_lossy().to_string()).collect();
        let base_path = Some(ex.to_string_lossy().to_string());
        step(2);
        uat(VfxUatRequest { action: "batch_to_json", file_paths: Some(to_json), usmap_path: Some(&usmap_path), output_path: Some(json.to_string_lossy().to_string()), base_path: base_path.clone(), ..Default::default() }, "Reading the KO prompt").await?;
        if !pngs.is_empty() {
            step(3);
            uat(VfxUatRequest { action: "batch_extract_texture_png", file_paths: Some(pngs), usmap_path: Some(&usmap_path), output_path: Some(png.to_string_lossy().to_string()), base_path, parallel: Some(true), ..Default::default() }, "Reading its textures").await?;
        }
        let _ = std::fs::write(&done, "");
    }
    let widget_json = json.join(format!("{widget}.json"));
    if !widget_json.exists() {
        let _ = std::fs::remove_file(&done);
        return Err("The KO prompt could not be read. Check the USMAP in Setup, then try again.".into());
    }
    let s = |p: &Path| p.to_string_lossy().replace('\\', "/");
    Ok(KoLoaded {
        extract: s(&ex),
        widget_json: s(&widget_json),
        materials: listed(&json, "json").into_iter().filter(|(k, _)| !k.ends_with(&stem)).collect(),
        textures: listed(&png, "png"),
    })
}

/// A file the editor made (a texture's PNG), as bytes. Only from its own folder.
#[tauri::command]
pub async fn xtra_ko_file(path: String) -> Result<tauri::ipc::Response, String> {
    let p = PathBuf::from(&path);
    let inside = p.canonicalize().ok().zip(root().canonicalize().ok()).is_some_and(|(p, r)| p.starts_with(r));
    if !inside {
        return Err("Not a KO Editor file".into());
    }
    crate::blocking(move || std::fs::read(&p).map_err(|e| e.to_string())).await.map(tauri::ipc::Response::new)
}

/// A folder for one export: the edited JSON, the rebuilt widget and the pack, apart from the cache.
#[tauri::command(async)]
pub fn xtra_ko_stage() -> Result<String, String> {
    let dir = std::env::temp_dir().join("repak-x").join("ko-out").join(format!("{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("pack")).map_err(|e| e.to_string())?; // the packer writes into it, never makes it
    Ok(dir.to_string_lossy().replace('\\', "/"))
}

/// An IoStore entry's path, forward slashes, lowercase.
fn norm(entry: &str) -> String {
    entry.replace('\\', "/").to_ascii_lowercase()
}

/// Whether an IoStore entry is a hero's KO prompt widget (its hero folder and name, any version).
fn is_ko_widget(entry: &str) -> bool {
    let e = norm(entry);
    e.ends_with(".uasset") && e.contains("/ui/blueprints/battle/custom/") && e.rsplit('/').next().is_some_and(|n| n.starts_with("wbp_battle_kill_"))
}

/// What a KO prompt mod may hold besides its widget: the prompt's textures and UI material instances.
fn is_ko_part(entry: &str) -> bool {
    let e = norm(entry);
    e.contains("/ui/textures/battle/kill/") || (e.contains("/ui/materials/") && e.rsplit('/').next().is_some_and(|n| n.starts_with("mi_")))
}

/// The mod's assets, or None when its file list cannot be read (the preview kit gets it then).
async fn mod_assets(mod_path: &str) -> Option<(PathBuf, Vec<String>)> {
    let utoc = Path::new(mod_path).with_extension("utoc");
    if !utoc.exists() {
        return None;
    }
    let list = utoc.clone();
    let entries = crate::blocking(move || crate::utoc_utils::try_read_utoc(&list)).await.ok()?;
    let assets = entries.into_iter().map(|e| e.file_path).filter(|p| norm(p).ends_with(".uasset")).collect();
    Some((utoc, assets))
}

/// A KO prompt mod: one KO widget, maybe with the prompt's textures and materials, nothing else.
fn is_ko_only(assets: &[String]) -> bool {
    assets.iter().filter(|a| is_ko_widget(a)).count() == 1 && assets.iter().all(|a| is_ko_widget(a) || is_ko_part(a))
}

/// Whether the mod is a KO prompt mod, from its file list alone (no USMAP needed to tell).
#[tauri::command]
pub async fn xtra_ko_is_mod(mod_path: String) -> bool {
    mod_assets(&mod_path).await.is_some_and(|(_, assets)| is_ko_only(&assets))
}

fn portrait_hero(assets: &[String]) -> Option<String> {
    if !is_ko_only(assets) { return None; }
    let widget = norm(assets.iter().find(|a| is_ko_widget(a))?);
    let id = widget.split('/').rev().nth(1)?;
    let name = widget.rsplit('/').next()?;
    (id.len() == 4 && id.bytes().all(|c| c.is_ascii_digit()) && name.starts_with(&format!("wbp_battle_kill_{id}_"))).then(|| id.to_string())
}

#[derive(Serialize)]
pub struct KoPortrait {
    hero: String,
    logo: String,
}

/// The game's hero logo for a KO-only mod, cached beside the editor's textures.
#[tauri::command]
pub async fn xtra_ko_portrait(mod_path: String, state: State<'_, Arc<Mutex<AppState>>>) -> Result<Option<KoPortrait>, String> {
    let Some((_, assets)) = mod_assets(&mod_path).await else { return Ok(None) };
    let Some(hero) = portrait_hero(&assets) else { return Ok(None) };
    let usmap = crate::vfx_updater::commands::saved_usmap_path().ok_or("No USMAP is available to read the hero logo.")?;
    let _one = ONE.lock().await;
    let paks = paks(&state)?;
    let base = build_dir(&paks, &usmap).join("logos").join(&hero);
    let rel = format!("Marvel/Content/Marvel/UI/Textures/HeroLogo/HeroLogo_Little/img_herologo_{hero}_logo");
    let png = base.join("png").join(format!("{rel}.png"));
    if !png.exists() {
        let ex = base.join("extract");
        extract(&paks, &ex, vec![rel.clone()], false).await?;
        let texture = ex.join(format!("{rel}.uasset"));
        uat(VfxUatRequest {
            action: "batch_extract_texture_png", file_paths: Some(vec![texture.to_string_lossy().to_string()]),
            usmap_path: Some(&usmap), output_path: Some(base.join("png").to_string_lossy().to_string()),
            base_path: Some(ex.to_string_lossy().to_string()), ..Default::default()
        }, "Reading the hero logo").await?;
    }
    if !png.exists() { return Err(format!("The game has no readable logo for hero {hero}.")); }
    Ok(Some(KoPortrait { hero, logo: png.to_string_lossy().replace('\\', "/") }))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KoMod {
    /// The hero's id, from the widget's folder
    hero: String,
    /// The mod's widget as JSON
    widget_json: String,
    /// The mod's own material instances (JSON) and textures (PNG), by package path: they replace the game's
    materials: Vec<(String, String)>,
    textures: Vec<(String, String)>,
}

/// A KO prompt mod (one KO widget, maybe with the prompt's textures and materials, nothing else) read for a preview the
/// KO Editor's renderer draws (custom/ko/koPreview.ts). None for any other mod, which the preview kit renders.
#[tauri::command]
pub async fn xtra_ko_mod(usmap_path: String, mod_path: String, state: State<'_, Arc<Mutex<AppState>>>) -> Result<Option<KoMod>, String> {
    let _one = ONE.lock().await;
    let Some((utoc, assets)) = mod_assets(&mod_path).await else { return Ok(None) };
    if !is_ko_only(&assets) {
        return Ok(None);
    }
    let paks = paks(&state)?;
    // inside this build's folder: xtra_ko_file reads only from there, and an older build's copy goes with it
    let base = build_dir(&paks, &usmap_path).join("mod");
    let _ = std::fs::remove_dir_all(&base);
    let (ex, json, png) = (base.join("extract"), base.join("json"), base.join("png"));
    std::fs::create_dir_all(&ex).map_err(|e| e.to_string())?;
    uat(VfxUatRequest { action: "extract_iostore_legacy", game_paks: Some(paks.to_string_lossy().to_string()), mod_path: Some(utoc.to_string_lossy().to_string()), output_path: Some(ex.to_string_lossy().to_string()), with_deps: Some(false), ..Default::default() }, "Reading the mod").await?;
    let mut files = Vec::new();
    uassets(&ex, &mut files);
    let text = |p: &PathBuf| p.to_string_lossy().to_string();
    let Some(widget) = files.iter().find(|p| is_ko_widget(&text(p))).cloned() else { return Ok(None) };
    let r = rel(&ex, &widget);
    let Some(hero) = r.split('/').rev().nth(1).filter(|id| id.chars().all(|c| c.is_ascii_digit())).map(str::to_string) else { return Ok(None) };
    let to_json: Vec<String> = files.iter().filter(|p| **p == widget || norm(&text(p)).contains("/ui/materials/")).map(text).collect();
    let pngs: Vec<String> = files.iter().filter(|p| norm(&text(p)).contains("/ui/textures/")).map(text).collect();
    let base_path = Some(ex.to_string_lossy().to_string());
    uat(VfxUatRequest { action: "batch_to_json", file_paths: Some(to_json), usmap_path: Some(&usmap_path), output_path: Some(json.to_string_lossy().to_string()), base_path: base_path.clone(), ..Default::default() }, "Reading the mod's KO prompt").await?;
    if !pngs.is_empty() {
        uat(VfxUatRequest { action: "batch_extract_texture_png", file_paths: Some(pngs), usmap_path: Some(&usmap_path), output_path: Some(png.to_string_lossy().to_string()), base_path, parallel: Some(true), ..Default::default() }, "Reading the mod's textures").await?;
    }
    let out = json.join(format!("{r}.json"));
    if !out.exists() {
        return Ok(None);
    }
    let stem = r.rsplit('/').next().unwrap_or_default().to_string();
    Ok(Some(KoMod {
        hero,
        widget_json: out.to_string_lossy().replace('\\', "/"),
        materials: listed(&json, "json").into_iter().filter(|(k, _)| !k.ends_with(&stem)).collect(),
        textures: listed(&png, "png"),
    }))
}

/// Saves a KO prompt mod's preview (a WebM the KO renderer recorded) as the mod's own, then tells every window.
/// The WebM comes as the raw body (no JSON array of a million numbers), its mod key in the `key` header.
#[tauri::command]
pub fn xtra_ko_save_preview(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Not a preview".into()) };
    let key = request.headers().get("key").and_then(|k| k.to_str().ok()).and_then(|k| urlencoding::decode(k).ok()).map(|k| k.into_owned()).unwrap_or_default();
    if key.is_empty() || key.contains(['/', '\\', ':']) || key.contains("..") || bytes.get(0..4) != Some(&[0x1A, 0x45, 0xDF, 0xA3][..]) {
        return Err("Not a preview".into());
    }
    let dir = crate::app_dir().join("previews");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for x in ["png", "webp"] {
        let _ = std::fs::remove_file(dir.join(format!("{key}.{x}"))); // the newer file wins anyway, an old one only confuses
    }
    std::fs::write(dir.join(format!("{key}.webm")), bytes).map_err(|e| e.to_string())?;
    let _ = app.emit("mod-preview-ready", key);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portrait_matches_the_ko_hero_only() {
        let widget = "Marvel/Content/Marvel/UI/Blueprints/Battle/Custom/1026/WBP_Battle_Kill_1026_V3.uasset".to_string();
        assert_eq!(portrait_hero(&[widget.clone()]).as_deref(), Some("1026"));
        assert_eq!(portrait_hero(&[widget.to_uppercase().replace('/', "\\")]).as_deref(), Some("1026"));
        assert_eq!(portrait_hero(&[widget.replace("Custom/1026", "Custom/1022")]), None);
        assert_eq!(portrait_hero(&[widget.clone(), widget.replace("1026", "1022")]), None);
        assert_eq!(portrait_hero(&[widget, "Marvel/Content/Marvel/Characters/1026/Meshes/SK_1026.uasset".into()]), None);
        assert_eq!(portrait_hero(&[]), None);
    }

    #[test]
    fn widget_paths_and_versions() {
        assert_eq!(version("a/WBP_Battle_Kill_1026_V3"), 3);
        assert_eq!(game_path("Marvel/Content/Marvel/UI/X"), "/Game/Marvel/UI/X");
        assert!(is_ko_widget("Marvel/Content/Marvel/UI/Blueprints/Battle/Custom/1064/WBP_Battle_Kill_1064_V3.uasset"));
        assert!(is_ko_part("Marvel/Content/Marvel/UI/Textures/Battle/Kill/Custom_Kill/1064/fb_battlekill_1064_vx02loop.uasset"));
        assert!(!is_ko_part("Marvel/Content/Marvel/Characters/1026/Meshes/SK_1026.uasset"));
        let w = "Marvel/Content/Marvel/UI/Blueprints/Battle/Custom/1064/WBP_Battle_Kill_1064_V3.uasset".to_string();
        let t = "Marvel/Content/Marvel/UI/Textures/Battle/Kill/Custom_Kill/1064/fb.uasset".to_string();
        assert!(is_ko_only(&[w.clone(), t.clone()]));
        assert!(!is_ko_only(&[t.clone()]));
        assert!(!is_ko_only(&[w, t, "Marvel/Content/Marvel/Characters/1026/Meshes/SK_1026.uasset".into()]));
    }

    #[test]
    fn newest_widget_per_hero() {
        let dir = std::env::temp_dir().join(format!("ko-test-{}", std::process::id()));
        for f in ["1026/WBP_Battle_Kill_1026_V3", "1026/WBP_Battle_Kill_1026_V4", "1011/WBP_Battle_Kill_1011_V3", "Common/WBP_Other"] {
            let p = dir.join(WIDGETS).join(format!("{f}.uasset"));
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"").unwrap();
        }
        let list = heroes_in(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|h| h.id == "1026" && h.widget.ends_with("_V4")));
    }
}
