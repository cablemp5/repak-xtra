//! caleb fork: Setup panel backend. Puts in place what Marvel Rivals needs to load mods:
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
use tauri::State;

const LOADER: &str = "dsound.dll";
const BYPASS: &str = "MarvelRivalsUTOCSignatureBypass.asi";
const LOADER_BYTES: &[u8] = include_bytes!("../resources/utoc-bypass/dsound.dll");
const BYPASS_BYTES: &[u8] = include_bytes!("../resources/utoc-bypass/MarvelRivalsUTOCSignatureBypass.asi");
const LICENSE_TEXT: &str = include_str!("../resources/utoc-bypass/Ultimate ASI Loader License.txt");
const GALACTA_API: &str = "https://api.github.com/repos/0xSaturno/ProjectGalacta/releases/latest";
const GALACTA_STEM: &str = "!ProjectGalacta_9999999_P";

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// ...\Content\Paks\~mods -> ...\Marvel\Binaries\Win64
fn win64_dir(mods_dir: &Path) -> Option<PathBuf> {
    Some(mods_dir.parent()?.parent()?.parent()?.join("Binaries").join("Win64"))
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
    let mut stack = vec![mods.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(&dir).ok()?.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(&format!("{GALACTA_STEM}.utoc"))) {
                return Some(dir);
            }
        }
    }
    None
}

/// The release zip's entries: (file name, bytes), only Galacta's own container files.
fn zip_files(zip: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip)).map_err(|e| format!("The download is not a zip: {e}"))?;
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(name) = f.enclosed_name().and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string())) else { continue };
        if f.is_file() && name.starts_with(GALACTA_STEM) && [".pak", ".ucas", ".utoc"].iter().any(|x| name.ends_with(x)) {
            let mut bytes = Vec::new();
            f.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            out.push((name, bytes));
        }
    }
    if out.len() != 3 {
        return Err("The release zip does not hold Galacta's .pak, .ucas and .utoc".into());
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
        return Err("Galacta goes inside the mods folder".into());
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

async fn latest_release() -> Result<(String, String, String, String, Vec<u8>), String> {
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
    let zip = match fs::read(&cache) {
        Ok(b) => b,
        Err(_) => {
            let b = client.get(&url).header("User-Agent", "repakxtra").send().await
                .and_then(|r| r.error_for_status()).map_err(|e| format!("Download failed: {e}"))?
                .bytes().await.map_err(|e| format!("Download failed: {e}"))?.to_vec();
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
    let mods = state.lock().unwrap().game_path.clone();
    let (dir, disabled) = galacta_local(&mods);
    let mut s = GalactaStatus { installed: dir.as_ref().map(|d| d.display().to_string()), disabled, latest: None, published: None, notes: None, url: None, up_to_date: None };
    if online {
        let (tag, published, notes, url, zip) = latest_release().await?;
        let files = zip_files(&zip)?;
        s.up_to_date = dir.as_ref().map(|d| matches(d, &files));
        (s.latest, s.published, s.notes, s.url) = (Some(tag), Some(published), Some(notes), Some(url));
    }
    Ok(s)
}

/// Installs the latest release into `folder` (a ~mods subfolder; empty = ~mods itself, or where it already is).
#[tauri::command]
pub async fn setup_galacta_install(folder: Option<String>, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<GalactaStatus, String> {
    if crate::is_game_process_running() {
        return Err("Marvel Rivals is running. Close it first.".into());
    }
    let mods = state.lock().unwrap().game_path.clone();
    if !mods.is_dir() {
        return Err("Set the game mods path in Settings first".into());
    }
    let (_, _, _, _, zip) = latest_release().await?;
    let files = zip_files(&zip)?;
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
            w.start_file(format!("{GALACTA_STEM}{n}"), opts).unwrap();
            w.write_all(b).unwrap();
        }
        w.start_file("readme.txt", opts).unwrap();
        w.finish().unwrap().into_inner()
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
