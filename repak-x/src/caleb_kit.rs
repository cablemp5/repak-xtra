//! caleb fork: the preview kit, what another PC needs to generate mod previews (Python, the generator, Cue4Export,
//! UAssetTool, repak, mappings; built by Caleb's tools\previews\build_kit.py). It lives in %APPDATA%\Repak-X\preview-kit,
//! comes from a GitHub release (tag preview-kit-v<N>, a repakxtra-preview-kit*.zip asset) or a zip picked by hand, and
//! needs Blender, which the user installs (found in Program Files or picked once).

use serde::Serialize;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

const RELEASES: &str = "https://api.github.com/repos/cablemp5/repak-xtra/releases";

pub fn kit_dir() -> PathBuf {
    crate::app_dir().join("preview-kit")
}

fn blender_setting() -> PathBuf {
    crate::app_dir().join("blender.json")
}

/// The kit's version from its kit.json, when a complete kit is installed.
fn installed(dir: &Path) -> Option<String> {
    if !dir.join(r"python\python.exe").exists() || !dir.join(r"previews\mod_previews.py").exists() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.join("kit.json")).ok()?).ok()?;
    Some(v["version"].as_str().map(str::to_string).unwrap_or_else(|| v["version"].to_string()))
}

pub fn installed_kit() -> Option<PathBuf> {
    installed(&kit_dir()).map(|_| kit_dir())
}

/// blender.exe: the one picked in Setup, else the newest under Program Files\Blender Foundation.
pub fn blender() -> Option<PathBuf> {
    let picked = fs::read_to_string(blender_setting()).ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["path"].as_str().map(PathBuf::from))
        .filter(|p| p.is_file());
    picked.or_else(|| {
        let root = PathBuf::from(std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into())).join("Blender Foundation");
        let mut found: Vec<PathBuf> = fs::read_dir(root).ok()?.flatten().map(|e| e.path().join("blender.exe")).filter(|p| p.is_file()).collect();
        found.sort_by_key(|p| version_of(p));
        found.pop()
    })
}

/// "Blender 5.2" folder -> [5, 2], for picking the newest.
fn version_of(exe: &Path) -> Vec<u32> {
    exe.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().split(|c: char| !c.is_ascii_digit()).filter_map(|x| x.parse().ok()).collect()).unwrap_or_default()
}

#[derive(Serialize)]
pub struct KitStatus {
    /// Installed kit version
    version: Option<String>,
    /// Caleb's own generator is on this PC (no kit needed)
    dev: bool,
    blender: Option<String>,
}

#[tauri::command]
pub fn preview_kit_status() -> KitStatus {
    KitStatus {
        version: installed(&kit_dir()),
        dev: crate::caleb_previews::dev_generator().is_some(),
        blender: blender().map(|p| p.display().to_string()),
    }
}

#[derive(Serialize)]
pub struct KitRelease {
    version: String,
    published: String,
    notes: String,
    url: String,
    asset: String,
    size: u64,
}

/// tag preview-kit-v3 -> "3"
fn release_version(tag: &str) -> Option<String> {
    tag.strip_prefix("preview-kit-v").filter(|v| !v.is_empty()).map(str::to_string)
}

/// The newest published preview kit release (drafts and other releases skipped).
fn pick_release(list: &serde_json::Value) -> Option<KitRelease> {
    list.as_array()?.iter().filter(|r| !r["draft"].as_bool().unwrap_or(false)).find_map(|r| {
        let version = release_version(r["tag_name"].as_str()?)?;
        let asset = r["assets"].as_array()?.iter().find(|a| a["name"].as_str().is_some_and(|n| n.starts_with("repakxtra-preview-kit") && n.ends_with(".zip")))?;
        Some(KitRelease {
            version,
            published: r["published_at"].as_str().unwrap_or("").into(),
            notes: r["body"].as_str().unwrap_or("").into(),
            url: r["html_url"].as_str().unwrap_or("").into(),
            asset: asset["browser_download_url"].as_str()?.into(),
            size: asset["size"].as_u64().unwrap_or(0),
        })
    })
}

#[tauri::command]
pub async fn preview_kit_latest() -> Result<Option<KitRelease>, String> {
    let list: serde_json::Value = reqwest::Client::new().get(RELEASES).header("User-Agent", "repakxtra").send().await
        .and_then(|r| r.error_for_status()).map_err(|e| format!("Could not reach GitHub: {e}"))?
        .json().await.map_err(|e| e.to_string())?;
    Ok(pick_release(&list))
}

/// Unpacks a kit zip into `dir` (replacing what is there) through a side folder, so a bad zip leaves the old kit.
fn unpack(zip: &[u8], dir: &Path) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip)).map_err(|e| format!("Not a zip: {e}"))?;
    let side = dir.with_extension("new");
    let _ = fs::remove_dir_all(&side);
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = f.enclosed_name() else { continue }; // never outside the kit folder
        let to = side.join(&rel);
        if f.is_dir() {
            fs::create_dir_all(&to).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut bytes = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        fs::write(&to, bytes).map_err(|e| format!("Could not write {}: {e}", rel.display()))?;
    }
    let Some(version) = installed(&side) else {
        let _ = fs::remove_dir_all(&side);
        return Err("That zip is not a repakxtra preview kit (no kit.json, python or generator in it).".into());
    };
    let _ = fs::remove_dir_all(dir);
    fs::rename(&side, dir).map_err(|e| format!("Could not put the kit in place: {e}"))?;
    Ok(version)
}

/// Installs the kit from `file` (a zip picked by hand) or, without one, from the newest GitHub release.
#[tauri::command]
pub async fn preview_kit_install(file: Option<String>) -> Result<String, String> {
    if crate::caleb_previews::is_running() {
        return Err("Previews are generating. Stop them or wait, then install the kit.".into());
    }
    let zip = match file {
        Some(f) => fs::read(&f).map_err(|e| format!("Could not read {f}: {e}"))?,
        None => {
            let release = preview_kit_latest().await?.ok_or("No preview kit has been published yet.")?;
            reqwest::Client::new().get(&release.asset).header("User-Agent", "repakxtra").send().await
                .and_then(|r| r.error_for_status()).map_err(|e| format!("Download failed: {e}"))?
                .bytes().await.map_err(|e| format!("Download failed: {e}"))?.to_vec()
        }
    };
    fs::create_dir_all(crate::app_dir()).map_err(|e| e.to_string())?;
    unpack(&zip, &kit_dir())
}

#[tauri::command]
pub fn preview_kit_remove() -> Result<(), String> {
    if crate::caleb_previews::is_running() {
        return Err("Previews are generating. Stop them or wait first.".into());
    }
    fs::remove_dir_all(kit_dir()).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e.to_string()) })
}

/// Picks blender.exe by hand (None goes back to finding it in Program Files).
#[tauri::command]
pub fn preview_kit_set_blender(path: Option<String>) -> Result<Option<String>, String> {
    match path.filter(|p| !p.trim().is_empty()) {
        Some(p) => {
            if !Path::new(&p).is_file() || !p.to_lowercase().ends_with("blender.exe") {
                return Err(format!("{p} is not blender.exe"));
            }
            fs::create_dir_all(crate::app_dir()).map_err(|e| e.to_string())?;
            fs::write(blender_setting(), serde_json::json!({ "path": p }).to_string()).map_err(|e| e.to_string())?;
        }
        None => { let _ = fs::remove_file(blender_setting()); }
    }
    Ok(blender().map(|p| p.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn kit_zip(extra: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let o = zip::write::SimpleFileOptions::default();
        for (n, b) in [("kit.json", &br#"{"version": "2"}"#[..]), ("python/python.exe", b"py"), ("previews/mod_previews.py", b"#")].iter().chain(extra) {
            w.start_file(*n, o).unwrap();
            w.write_all(b).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn kits_unpack_in_place_and_bad_zips_keep_the_old_one() {
        let dir = std::env::temp_dir().join(format!("kit-test-{}", std::process::id())).join("preview-kit");
        let _ = fs::remove_dir_all(dir.parent().unwrap());
        assert_eq!(unpack(&kit_zip(&[]), &dir).unwrap(), "2");
        assert!(dir.join(r"python\python.exe").exists());
        assert!(unpack(b"not a zip", &dir).is_err());
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        w.start_file("readme.txt", zip::write::SimpleFileOptions::default()).unwrap();
        assert!(unpack(&w.finish().unwrap().into_inner(), &dir).is_err(), "a zip without a kit is refused");
        assert_eq!(installed(&dir).as_deref(), Some("2"), "the old kit stays after a refused zip");
        assert!(!dir.parent().unwrap().join("evil.txt").exists());
        let _ = unpack(&kit_zip(&[("../evil.txt", b"x")]), &dir);
        assert!(!dir.parent().unwrap().join("evil.txt").exists(), "nothing lands outside the kit folder");
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn picks_the_newest_kit_release() {
        let list = serde_json::json!([
            { "tag_name": "v2.1.0", "assets": [] },
            { "tag_name": "preview-kit-v3", "draft": true, "assets": [{ "name": "repakxtra-preview-kit-v3.zip", "browser_download_url": "u3" }] },
            { "tag_name": "preview-kit-v2", "body": "notes", "assets": [{ "name": "other.zip", "browser_download_url": "x" },
                { "name": "repakxtra-preview-kit-v2.zip", "browser_download_url": "u2", "size": 5 }] },
        ]);
        let r = pick_release(&list).unwrap();
        assert_eq!((r.version.as_str(), r.asset.as_str(), r.size), ("2", "u2", 5));
        assert!(pick_release(&serde_json::json!([])).is_none());
    }
}
