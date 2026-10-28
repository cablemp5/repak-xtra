//! repakxtra: Setup panel backend. Puts in place what Marvel Rivals needs to load mods:
//! - the UTOC signature bypass, bundled in the exe (resources/utoc-bypass, provenance in its SOURCE.md): dsound.dll (the
//!   Ultimate ASI Loader) in Binaries\Win64 and MarvelRivalsUTOCSignatureBypass.asi in Binaries\Win64\plugins;
//! - Project Galacta from its GitHub releases (0xSaturno/ProjectGalacta), checked and updated in one click.
//! Sigeon's SigeonLoader.asi loads through the same dsound.dll, so turning the loader off turns Sigeon off too.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

const LOADER: &str = "dsound.dll";
const BYPASS: &str = "MarvelRivalsUTOCSignatureBypass.asi";
const LOADER_BYTES: &[u8] = include_bytes!("../resources/utoc-bypass/dsound.dll");
const BYPASS_BYTES: &[u8] = include_bytes!("../resources/utoc-bypass/MarvelRivalsUTOCSignatureBypass.asi");
const LICENSE_TEXT: &str = include_str!("../resources/utoc-bypass/Ultimate ASI Loader License.txt");
#[cfg(not(feature = "extended"))]
const GALACTA_API: &str = "https://api.github.com/repos/0xSaturno/ProjectGalacta/releases/latest";
#[cfg(not(feature = "extended"))]
const GALACTA_STEM: &str = "!ProjectGalacta_9999999_P";
#[cfg(feature = "extended")]
const GALACTA_STEM: &str = "!ProjectSigeon_9999999_P";

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// ...\Content\Paks\~mods -> ...\Marvel\Binaries\Win64
fn win64_dir(mods_dir: &Path) -> Option<PathBuf> {
    Some(mods_dir.parent()?.parent()?.parent()?.join("Binaries").join("Win64"))
}

/// The mods folder for a folder picked by hand: the game's install folder (or any level down to Paks) becomes its
/// Paks\~mods, created when missing, as auto-detect does; anything else (a ~mods folder, or a custom mods folder)
/// stays as picked. Err when that ~mods cannot be created (the path stays as it was).
pub fn mods_folder_for(picked: &Path) -> Result<PathBuf, String> {
    let named = |p: &Path, n: &str| p.file_name().is_some_and(|f| f.eq_ignore_ascii_case(n));
    let paks = [r"MarvelGame\Marvel\Content\Paks", r"Marvel\Content\Paks", r"Content\Paks", "Paks"]
        .iter()
        .map(|rel| picked.join(rel))
        .chain(named(picked, "Paks").then(|| picked.to_path_buf()))
        .find(|p| p.is_dir());
    match paks {
        Some(paks) => {
            let mods = paks.join("~mods");
            fs::create_dir_all(&mods).map_err(|e| format!("Could not create the mods folder {}: {e}", mods.display()))?;
            Ok(mods)
        }
        None => Ok(picked.to_path_buf()),
    }
}

fn setup_dir() -> PathBuf {
    crate::app_dir().join("setup")
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FileCheck {
    name: String,
    place: String,
    size: usize,
    sha256: String,
    /// "missing", "same" (byte for byte the bundled file) or "other" (a different file under that name)
    found: String,
}

#[derive(Serialize)]
pub struct BypassStatus {
    /// "installed", "disabled" (dsound.dll renamed to .disabled), "partial", "other" (a different loader or bypass) or "missing"
    state: String,
    files: Vec<FileCheck>,
    license: String,
    sigeon_on: bool,
}

fn check(path: &Path, name: &str, place: &str, bundled: &[u8]) -> FileCheck {
    let found = match fs::read(path) {
        Ok(b) if b == bundled => "same",
        Ok(_) => "other",
        Err(_) => "missing",
    };
    FileCheck { name: name.into(), place: place.into(), size: bundled.len(), sha256: sha256(bundled), found: found.into() }
}

fn bypass_status(win64: &Path) -> BypassStatus {
    let loader = check(&win64.join(LOADER), LOADER, "Binaries\\Win64", LOADER_BYTES);
    let asi = check(&win64.join("plugins").join(BYPASS), BYPASS, "Binaries\\Win64\\plugins", BYPASS_BYTES);
    let disabled = win64.join(format!("{LOADER}.disabled")).exists();
    let state = match (loader.found.as_str(), asi.found.as_str()) {
        ("same", "same") => "installed",
        ("missing", "same") if disabled => "disabled",
        ("missing", "missing") if !disabled => "missing",
        (a, b) if a == "other" || b == "other" => "other",
        _ => "partial",
    };
    BypassStatus {
        state: state.into(),
        files: vec![loader, asi],
        license: LICENSE_TEXT.into(),
        sigeon_on: win64.join("plugins").join("SigeonLoader.asi").exists(),
    }
}

/// Whether the file is byte for byte the bundled loader or bypass (the setup report leaves those out of a crash's
/// third-party modules: the Signature bypass line already names them).
pub(crate) fn is_bundled_bypass(path: &Path) -> bool {
    // the size first, so an overlay DLL of another size is never read whole
    let len = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    [LOADER_BYTES, BYPASS_BYTES].iter().any(|bytes| len == bytes.len() as u64 && fs::read(path).is_ok_and(|b| b == *bytes))
}

/// install: writes both files (a different dsound.dll or .asi already there is kept as <name>.repakxtra-backup);
/// disable / enable: renames dsound.dll like the Tools panel does; remove: deletes the two bundled files only.
fn bypass_action(win64: &Path, action: &str) -> Result<(), String> {
    let loader = win64.join(LOADER);
    let off = win64.join(format!("{LOADER}.disabled"));
    let plugins = win64.join("plugins");
    let asi = plugins.join(BYPASS);
    let io = |what: &str, e: std::io::Error| format!("Could not {what}: {e}");
    match action {
        "install" => {
            if !win64.is_dir() {
                return Err(format!("{} not found. Check the game path in Settings.", win64.display()));
            }
            fs::create_dir_all(&plugins).map_err(|e| io("make the plugins folder", e))?;
            for (path, bytes) in [(&loader, LOADER_BYTES), (&asi, BYPASS_BYTES)] {
                if fs::read(path).is_ok_and(|b| b != bytes) {
                    let keep = path.with_file_name(format!("{}.repakxtra-backup", path.file_name().unwrap().to_string_lossy()));
                    fs::rename(path, &keep).map_err(|e| io("back up the file that was there", e))?;
                }
                fs::write(path, bytes).map_err(|e| io("write the bypass", e))?;
            }
            if off.exists() && fs::read(&off).is_ok_and(|b| b == LOADER_BYTES) {
                let _ = fs::remove_file(&off);
            }
        }
        "disable" => fs::rename(&loader, &off).map_err(|e| io("turn the loader off", e))?,
        "enable" => fs::rename(&off, &loader).map_err(|e| io("turn the loader on", e))?,
        "remove" => {
            for path in [&loader, &off, &asi] {
                if fs::read(path).is_ok_and(|b| b == LOADER_BYTES || b == BYPASS_BYTES) {
                    fs::remove_file(path).map_err(|e| io("remove the bypass", e))?;
                }
            }
        }
        _ => return Err(format!("Unknown action {action}")),
    }
    Ok(())
}

fn win64(state: &State<'_, Arc<Mutex<crate::AppState>>>) -> Result<PathBuf, String> {
    let mods = state.lock().unwrap().game_path.clone();
    win64_dir(&mods).ok_or_else(|| "Set the game mods path in Settings first".into())
}

#[tauri::command]
pub async fn setup_bypass_status(state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<BypassStatus, String> {
    Ok(bypass_status(&win64(&state)?))
}

#[tauri::command]
pub async fn setup_bypass(action: String, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<BypassStatus, String> {
    let _mutation = crate::xtra_mutation::edit()?;
    crate::xtra_identity::upstream_guard()?; // both apps change the game's files: not while Repak X is open
    if crate::is_game_process_running() {
        return Err("Marvel Rivals is running. Close it first.".into());
    }
    let dir = win64(&state)?;
    bypass_action(&dir, &action)?;
    Ok(bypass_status(&dir))
}

// ---------- Project Galacta ----------

#[derive(Serialize, Clone)]
pub struct GalactaStatus {
    /// Folder the installed copy sits in, if any
    installed: Option<String>,
    /// Whether the installed copy is switched off in the app (its .pak renamed)
    disabled: bool,
    latest: Option<String>,
    published: Option<String>,
    notes: Option<String>,
    url: Option<String>,
    /// Some(true) when the installed files match the latest release byte for byte
    up_to_date: Option<bool>,
}

/// Where Galacta's three files are now: the folder holding !ProjectGalacta_9999999_P.utoc (any ~mods subfolder).
fn find_galacta(mods: &Path) -> Option<PathBuf> {
    find_loader(mods, GALACTA_STEM)
}

fn find_loader(mods: &Path, stem: &str) -> Option<PathBuf> {
    find_loader_matching(mods, stem, false)
}

fn find_enabled_loader(mods: &Path, stem: &str) -> Option<PathBuf> {
    find_loader_matching(mods, stem, true).or_else(|| {
        // Older installs can keep a renamed/repacked loader directly in Content/Paks.
        let paks = mods.parent()?;
        let name = stem.trim_start_matches('!').split('_').next()?.to_ascii_lowercase();
        fs::read_dir(paks).ok()?.flatten().find(|entry| {
            let path = entry.path();
            path.is_file()
                && path.extension().is_some_and(|ext| ext.to_string_lossy().eq_ignore_ascii_case("pak"))
                && path.file_stem().is_some_and(|s| s.to_string_lossy().to_ascii_lowercase().contains(&name))
        }).map(|_| paks.to_path_buf())
    })
}

fn find_loader_matching(mods: &Path, stem: &str, enabled_only: bool) -> Option<PathBuf> {
    let mut stack = vec![mods.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if e.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()) {
                stack.push(p);
            } else if p.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(&format!("{stem}.utoc")))
                && (!enabled_only || dir.join(format!("{stem}.pak")).is_file()) {
                return Some(dir);
            }
        }
    }
    None
}

/// The release zip's entries: (file name, bytes), only Galacta's own container files.
#[cfg(feature = "extended")]
async fn latest_release(app: Option<&AppHandle>) -> Result<(String, String, String, String, Vec<u8>), String> {
    tell(app, "check", 0, 0);
        include_bytes!("../resources/extended/ProjectSigeon.zip").to_vec()))
}

fn zip_files(zip: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip)).map_err(|e| format!("The download is not a zip: {e}"))?;
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        #[cfg(feature = "extended")]
        if !f.name().starts_with("Minimal/") { continue; }
        let Some(name) = f.enclosed_name().and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string())) else { continue };
        if f.is_file() && name.starts_with(GALACTA_STEM) && [".pak", ".ucas", ".utoc"].iter().any(|x| name.ends_with(x)) {
            let mut bytes = Vec::new();
            f.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            out.push((name, bytes));
        }
    }
    if out.len() != 3 {
        return Err("The loader zip must hold exactly one .pak, .ucas and .utoc set".into());
    }
    Ok(out)
}

/// The installed copy matches the release when its .ucas and .utoc are byte for byte the same (the .pak may be renamed
/// to .bak_repak when switched off in the app).
fn matches(dir: &Path, files: &[(String, Vec<u8>)]) -> bool {
    files.iter().filter(|(n, _)| !n.ends_with(".pak")).all(|(n, b)| fs::read(dir.join(n)).is_ok_and(|x| &x == b))
}

/// Writes the release into `target`, moving any older copy (from any folder) to <backups>\<time> first.
fn install_galacta(mods: &Path, target: &Path, files: &[(String, Vec<u8>)], backups: &Path) -> Result<(), String> {
    if !target.starts_with(mods) {
        return Err("The loader goes inside the mods folder".into());
    }
    let other = if crate::xtra_edition::EXTENDED { "!ProjectGalacta_9999999_P" } else { "!ProjectSigeon_9999999_P" };
    if find_enabled_loader(mods, other).is_some() {
        return Err("Turn off the other Project Galacta / Project Sigeon loader in the Library before installing this one.".into());
    }
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    if let Some(old) = find_galacta(mods) {
        let backup = backups.join(chrono_stamp());
        fs::create_dir_all(&backup).map_err(|e| e.to_string())?;
        for e in fs::read_dir(&old).map_err(|e| e.to_string())?.flatten() {
            if e.file_name().to_string_lossy().starts_with(GALACTA_STEM) {
                let to = backup.join(e.file_name());
                fs::copy(e.path(), &to).and_then(|_| fs::remove_file(e.path())).map_err(|e| format!("Could not move the old copy: {e}"))?;
            }
        }
    }
    for (name, bytes) in files {
        let tmp = target.join(format!("{name}.part"));
        fs::write(&tmp, bytes).map_err(|e| format!("Could not write {name}: {e}"))?;
        fs::rename(&tmp, target.join(name)).map_err(|e| format!("Could not write {name}: {e}"))?;
    }
    Ok(())
}

fn chrono_stamp() -> String {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs().to_string()).unwrap_or_default()
}

/// Galacta's install progress for Setup and the guided setup (`galacta-progress`): "check" (asking GitHub), "download"
/// (bytes so far of `total`, 0 when unknown), "install" (writing the files).
#[derive(Clone, Serialize)]
struct GalactaProgress {
    stage: &'static str,
    done: u64,
    total: u64,
}

fn tell(app: Option<&AppHandle>, stage: &'static str, done: u64, total: u64) {
    if let Some(app) = app {
        let _ = app.emit("galacta-progress", GalactaProgress { stage, done, total });
    }
}

/// The newest release and its mod zip (downloaded once per tag). With `app`, says how the download goes.
#[cfg(not(feature = "extended"))]
async fn latest_release(app: Option<&AppHandle>) -> Result<(String, String, String, String, Vec<u8>), String> {
    tell(app, "check", 0, 0);
    let client = reqwest::Client::new();
    let json: serde_json::Value = client
        .get(GALACTA_API)
        .header("User-Agent", "repakxtra")
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub: {e}"))?
        .error_for_status()
        .map_err(|e| format!("GitHub said: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let tag = json["tag_name"].as_str().unwrap_or("").to_string();
    let asset = json["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| a["name"].as_str().is_some_and(|n| n.starts_with("ProjectGalacta") && !n.contains("Companion") && n.ends_with(".zip")))
        .ok_or("The latest release has no Galacta mod zip")?;
    let url = asset["browser_download_url"].as_str().unwrap_or("").to_string();
    // Cached per tag: checking again or installing after a check downloads nothing new
    let cache = setup_dir().join(format!("galacta-{}.zip", tag.replace(|c: char| !c.is_ascii_alphanumeric() && c != '.', "_")));
    // a cached file that is not a whole zip (the app closed mid-write) is downloaded again
    let zip = match fs::read(&cache).ok().filter(|b| zip_files(b).is_ok()) {
        Some(b) => b,
        None => {
            let mut resp = client.get(&url).header("User-Agent", "repakxtra").send().await
                .and_then(|r| r.error_for_status()).map_err(|e| format!("Download failed: {e}"))?;
            let total = resp.content_length().unwrap_or(0);
            let mut b = Vec::with_capacity(total.min(1 << 28) as usize);
            let mut told = 0u64;
            tell(app, "download", 0, total);
            while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Download failed: {e}"))? {
                b.extend_from_slice(&chunk);
                let done = b.len() as u64;
                if done - told >= 1 << 18 || done == total {
                    told = done;
                    tell(app, "download", done, total);
                }
            }
            zip_files(&b)?;
            let _ = fs::create_dir_all(setup_dir());
            let _ = fs::write(&cache, &b);
            b
        }
    };
    Ok((tag, json["published_at"].as_str().unwrap_or("").to_string(), json["body"].as_str().unwrap_or("").to_string(),
        json["html_url"].as_str().unwrap_or("").to_string(), zip))
}

fn galacta_local(mods: &Path) -> (Option<PathBuf>, bool) {
    let dir = find_galacta(mods);
    let disabled = dir.as_ref().is_some_and(|d| !d.join(format!("{GALACTA_STEM}.pak")).exists());
    (dir, disabled)
}

/// What is installed; with `online`, also the latest release, its notes and whether the installed copy matches it.
#[tauri::command]
pub async fn setup_galacta_status(online: bool, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<GalactaStatus, String> {
    #[cfg(feature = "extended")]
    crate::xtra_activation::require()?;
    let mods = state.lock().unwrap().game_path.clone();
    let (dir, disabled) = galacta_local(&mods);
    let mut s = GalactaStatus { installed: dir.as_ref().map(|d| d.display().to_string()), disabled, latest: None, published: None, notes: None, url: None, up_to_date: None };
    if online {
        let (tag, published, notes, url, zip) = latest_release(None).await?;
        let files = zip_files(&zip)?;
        s.up_to_date = dir.as_ref().map(|d| matches(d, &files));
        (s.latest, s.published, s.notes, s.url) = (Some(tag), Some(published), Some(notes), Some(url));
    }
    Ok(s)
}

/// Installs the latest release into `folder` (a ~mods subfolder; empty = ~mods itself, or where it already is).
#[tauri::command]
pub async fn setup_galacta_install(app: AppHandle, folder: Option<String>, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<GalactaStatus, String> {
    #[cfg(feature = "extended")]
    crate::xtra_activation::require()?;
    let _mutation = crate::xtra_mutation::edit()?;
    crate::xtra_identity::upstream_guard()?; // both apps change the game's files: not while Repak X is open
    if crate::is_game_process_running() {
        return Err("Marvel Rivals is running. Close it first.".into());
    }
    let mods = state.lock().unwrap().game_path.clone();
    if !mods.is_dir() {
        return Err("Set the game mods path in Settings first".into());
    }
    let (_, _, _, _, zip) = latest_release(Some(&app)).await?;
    let files = zip_files(&zip)?;
    tell(Some(&app), "install", 0, 0);
    let target = match folder.filter(|f| !f.trim().is_empty()) {
        // a subfolder by its relative path ("A/B"), never "..", a drive or an absolute path
        Some(f) if Path::new(&f).components().all(|c| matches!(c, std::path::Component::Normal(_))) => mods.join(f),
        Some(f) => return Err(format!("\"{f}\" is not a folder inside the mods folder")),
        None => find_galacta(&mods).unwrap_or_else(|| mods.clone()),
    };
    install_galacta(&mods, &target, &files, &setup_dir().join("backup"))?;
    setup_galacta_status(true, state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_picked_game_folder_becomes_its_mods_folder() {
        let root = std::env::temp_dir().join(format!("mods-folder-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let game = root.join("MarvelRivals");
        let paks = game.join(r"MarvelGame\Marvel\Content\Paks");
        fs::create_dir_all(&paks).unwrap();
        let mods = paks.join("~mods");
        for pick in [game.clone(), game.join("MarvelGame"), game.join(r"MarvelGame\Marvel"), game.join(r"MarvelGame\Marvel\Content"), paks.clone()] {
            assert_eq!(mods_folder_for(&pick).unwrap(), mods, "picked {}", pick.display());
        }
        assert!(mods.is_dir(), "~mods is created");
        assert_eq!(mods_folder_for(&mods).unwrap(), mods, "the mods folder itself stays");
        let custom = root.join("My mods");
        fs::create_dir_all(&custom).unwrap();
        assert_eq!(mods_folder_for(&custom).unwrap(), custom, "a custom folder stays as picked");
        // A file where ~mods should be: an error, not a folder that cannot hold mods
        let other = root.join(r"Other\Content\Paks");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("~mods"), b"").unwrap();
        assert!(mods_folder_for(&root.join("Other")).is_err());
        let _ = fs::remove_dir_all(&root);
    }
    use std::io::Write;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("setup-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn bundled_files_are_the_checked_release() {
        assert_eq!(sha256(LOADER_BYTES), "bb8767f918c52a2ad055d2de9baffd2478598643b9894f09abd20d1f1ffd170c");
        assert_eq!(sha256(BYPASS_BYTES), "2f8b183149f30c94319a5f6636491ff39aa22afbbf3f5cbc5fb8f7ecc287a62d");
        assert!(LICENSE_TEXT.contains("MIT License"));
    }

    #[test]
    fn bypass_installs_disables_and_removes_only_its_files() {
        let win = temp("bypass");
        assert_eq!(bypass_status(&win).state, "missing");
        fs::create_dir_all(win.join("plugins")).unwrap();
        fs::write(win.join("plugins").join("SigeonLoader.asi"), b"sigeon").unwrap();
        fs::write(win.join(LOADER), b"an older loader").unwrap();
        assert_eq!(bypass_status(&win).state, "other");
        bypass_action(&win, "install").unwrap();
        let s = bypass_status(&win);
        assert_eq!(s.state, "installed");
        assert!(s.sigeon_on);
        assert_eq!(fs::read(win.join("dsound.dll.repakxtra-backup")).unwrap(), b"an older loader", "a different loader is kept");
        assert!(is_bundled_bypass(&win.join(LOADER)) && is_bundled_bypass(&win.join("plugins").join(BYPASS)));
        assert!(!is_bundled_bypass(&win.join("dsound.dll.repakxtra-backup")) && !is_bundled_bypass(&win.join("plugins").join("SigeonLoader.asi")));
        bypass_action(&win, "disable").unwrap();
        assert_eq!(bypass_status(&win).state, "disabled");
        bypass_action(&win, "enable").unwrap();
        assert_eq!(bypass_status(&win).state, "installed");
        bypass_action(&win, "remove").unwrap();
        assert_eq!(bypass_status(&win).state, "missing");
        assert!(win.join("plugins").join("SigeonLoader.asi").exists(), "Sigeon's own files stay");
        assert!(bypass_action(&win, "explode").is_err());
        let _ = fs::remove_dir_all(&win);
    }

    fn release_zip(ucas: &[u8]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        for (n, b) in [(".pak", &b"pak"[..]), (".ucas", ucas), (".utoc", &b"utoc"[..])] {
            w.start_file(format!("{}{GALACTA_STEM}{n}", if crate::xtra_edition::EXTENDED { "Minimal/" } else { "" }), opts).unwrap();
            w.write_all(b).unwrap();
        }
        w.start_file("readme.txt", opts).unwrap();
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn loaders_cannot_be_installed_together() {
        let root = tempfile::tempdir().unwrap();
        let other = if crate::xtra_edition::EXTENDED { "!ProjectGalacta_9999999_P" } else { "!ProjectSigeon_9999999_P" };
        for extension in ["pak", "utoc"] {
            fs::write(root.path().join(format!("{other}.{extension}")), b"other loader").unwrap();
        }
        let files = zip_files(&release_zip(b"new loader")).unwrap();
        let result = install_galacta(root.path(), root.path(), &files, &root.path().join("backups"));
        assert!(result.unwrap_err().contains("Turn off the other"));
        assert!(!root.path().join(format!("{GALACTA_STEM}.pak")).exists());
    }

    #[test]
    fn a_disabled_copy_does_not_hide_an_enabled_loader() {
        let root = tempfile::tempdir().unwrap();
        let other = if crate::xtra_edition::EXTENDED { "!ProjectGalacta_9999999_P" } else { "!ProjectSigeon_9999999_P" };
        // The root is visited first and contains a disabled copy.
        fs::write(root.path().join(format!("{other}.utoc")), b"disabled").unwrap();
        fs::write(root.path().join(format!("{other}.bak_repak")), b"disabled").unwrap();
        let enabled = root.path().join("another-copy");
        fs::create_dir(&enabled).unwrap();
        for extension in ["pak", "utoc"] {
            fs::write(enabled.join(format!("{other}.{extension}")), b"enabled").unwrap();
        }
        assert_eq!(find_enabled_loader(root.path(), other), Some(enabled.clone()));
        let files = zip_files(&release_zip(b"new loader")).unwrap();
        assert!(install_galacta(root.path(), root.path(), &files, &root.path().join("backups")).unwrap_err().contains("Turn off the other"));
        fs::rename(enabled.join(format!("{other}.pak")), enabled.join(format!("{other}.bak_repak"))).unwrap();
        assert!(find_enabled_loader(root.path(), other).is_none());
    }

    #[cfg(feature = "extended")]
    #[test]
    fn bundled_sigeon_selects_only_minimal() {
        let bytes = include_bytes!("../resources/extended/ProjectSigeon.zip");
        let files = zip_files(bytes).unwrap();
        assert_eq!(files.len(), 3);
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes.as_slice())).unwrap();
        for (name, contents) in files {
            assert!(name.starts_with("!ProjectSigeon_"));
            let mut expected = Vec::new();
            archive.by_name(&format!("Minimal/{name}")).unwrap().read_to_end(&mut expected).unwrap();
            assert_eq!(contents, expected);
        }
    }

    #[test]
    fn loaders_in_parent_paks_block_installation_without_writing_files() {
        let root = tempfile::tempdir().unwrap();
        let paks = root.path().join("Content").join("Paks");
        let mods = paks.join("~mods");
        fs::create_dir_all(&mods).unwrap();
        let other = if crate::xtra_edition::EXTENDED { "ProjectGalacta" } else { "ProjectSigeon" };
        let files = zip_files(&release_zip(b"new loader")).unwrap();
        let target = mods.join("new-loader");
        let backups = root.path().join("backups");
        for filename in [format!("!{other}_9999999_P.pak"), format!("{other}-repacked.PAK")] {
            let active = paks.join(filename);
            fs::write(&active, b"existing loader").unwrap();
            assert!(install_galacta(&mods, &target, &files, &backups).unwrap_err().contains("Turn off the other"));
            assert_eq!(fs::read(&active).unwrap(), b"existing loader");
            assert!(!target.exists() && !backups.exists(), "refusal must not write anything");
            fs::rename(&active, active.with_extension("bak_repak")).unwrap();
        }
        // Disabled parent copies and unrelated retail files must not block installation.
        fs::write(paks.join("pakchunk0-Windows.pak"), b"retail").unwrap();
        install_galacta(&mods, &target, &files, &backups).unwrap();
        assert!(target.join(format!("{GALACTA_STEM}.pak")).exists());
    }

    #[test]
    fn galacta_installs_over_an_old_copy_and_compares() {
        let mods = temp("galacta");
        let sub = mods.join("Galacta");
        fs::create_dir_all(&sub).unwrap();
        for (n, b) in [(".bak_repak", &b"old"[..]), (".ucas", &b"old"[..]), (".utoc", &b"old"[..])] {
            fs::write(sub.join(format!("{GALACTA_STEM}{n}")), b).unwrap();
        }
        let files = zip_files(&release_zip(b"v2")).unwrap();
        assert_eq!(files.len(), 3, "only Galacta's own files");
        assert_eq!(find_galacta(&mods), Some(sub.clone()));
        assert_eq!(galacta_local(&mods).1, true, "a renamed .pak reads as switched off");
        assert!(!matches(&sub, &files));
        install_galacta(&mods, &mods, &files, &mods.join("backups")).unwrap();
        assert!(fs::read_dir(mods.join("backups")).unwrap().next().is_some(), "the old copy is kept");
        assert_eq!(find_galacta(&mods), Some(mods.clone()), "moved to the folder asked for");
        assert!(!sub.join(format!("{GALACTA_STEM}.bak_repak")).exists(), "the old copy left its folder");
        assert!(matches(&mods, &files));
        assert!(install_galacta(&mods, &std::env::temp_dir(), &files, &mods.join("backups")).is_err(), "never outside the mods folder");
        assert!(zip_files(b"not a zip").is_err());
        let _ = fs::remove_dir_all(&mods);
    }
}
