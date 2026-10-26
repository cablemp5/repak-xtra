//! repakxtra: the preview kit, what another PC needs to generate mod previews (Python, the generator, Cue4Export,
//! UAssetTool, repak, mappings; built by the modding tools' previews\build_kit.py). It lives in %APPDATA%\Repak-X\preview-kit,
//! comes from a GitHub release (tag preview-kit-v<N>, a repakxtra-preview-kit*.zip asset) or a zip picked by hand (its
//! source.json says which), and needs Blender (installed from Setup with winget, found in Program Files, or picked once).

use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

const RELEASES: &str = "https://api.github.com/repos/cablemp5/repak-xtra/releases?per_page=100"; // GitHub lists 30 by default: app releases would push the kit off the page

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
    // A non-empty string or a number; anything else is not a kit
    match &v["version"] {
        serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

pub fn installed_kit() -> Option<PathBuf> {
    installed(&kit_dir()).map(|_| kit_dir())
}

/// blender.exe: the one picked in Setup, else the newest Blender already on this PC (installed_blenders).
pub fn blender() -> Option<PathBuf> {
    let picked = fs::read_to_string(blender_setting()).ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["path"].as_str().map(PathBuf::from))
        .filter(|p| p.is_file());
    picked.or_else(|| newest(installed_blenders()))
}

/// The newest by version (version_of); the first found wins a tie.
fn newest(found: Vec<PathBuf>) -> Option<PathBuf> {
    found.into_iter().rev().max_by_key(|p| version_of(p))
}

/// Every blender.exe this PC has, wherever it was installed: Program Files (both), a per-user install, what the
/// registry knows (installers, the .blend file type), Steam's libraries and PATH.
fn installed_blenders() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|v| std::env::var_os(v).map(|d| PathBuf::from(d).join("Blender Foundation")))
        .collect();
    if let Some(local) = dirs::data_local_dir() {
        roots.push(local.join("Programs").join("Blender Foundation"));
    }
    let mut exes: Vec<PathBuf> = roots.iter().flat_map(|r| fs::read_dir(r).into_iter().flatten().flatten().map(|e| e.path().join("blender.exe"))).collect();
    exes.extend(registry_blenders());
    exes.extend(crate::utils::get_steam_library_paths().into_iter().map(|l| l.join("steamapps").join("common").join("Blender").join("blender.exe")));
    exes.extend(std::env::var_os("PATH").into_iter().flat_map(|p| std::env::split_paths(&p).map(|d| d.join("blender.exe")).collect::<Vec<_>>()));
    let mut seen = std::collections::HashSet::new();
    exes.into_iter().filter(|p| p.is_file() && seen.insert(p.to_string_lossy().to_lowercase())).collect()
}

/// Blenders the registry names: installers' uninstall entries (InstallLocation) and what opens a .blend file.
#[cfg(windows)]
fn registry_blenders() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};
    use winreg::RegKey;
    let mut out = Vec::new();
    let uninstall = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
    for (hive, flags) in [(HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY), (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY), (HKEY_CURRENT_USER, 0)] {
        let Ok(list) = RegKey::predef(hive).open_subkey_with_flags(uninstall, KEY_READ | flags) else { continue };
        for name in list.enum_keys().flatten() {
            let Ok(app) = list.open_subkey(&name) else { continue };
            let shown: String = app.get_value("DisplayName").unwrap_or_default();
            let at: String = app.get_value("InstallLocation").unwrap_or_default();
            if shown.to_ascii_lowercase().starts_with("blender") && !at.trim().is_empty() {
                out.push(PathBuf::from(at.trim().trim_matches('"')).join("blender.exe"));
            }
        }
    }
    // the .blend type's open command: "C:\...\blender-launcher.exe" "%1", whose folder holds blender.exe
    if let Ok(cmd) = RegKey::predef(HKEY_CLASSES_ROOT).open_subkey(r"blendfile\shell\open\command").and_then(|k| k.get_value::<String, _>("")) {
        if let Some(exe) = launch_exe(&cmd) {
            out.push(exe.with_file_name("blender.exe"));
        }
    }
    out
}

#[cfg(not(windows))]
fn registry_blenders() -> Vec<PathBuf> {
    Vec::new()
}

/// The program a registry open command runs: its first quoted part, or what comes before the first space.
fn launch_exe(cmd: &str) -> Option<PathBuf> {
    let c = cmd.trim();
    let exe = match c.strip_prefix('"') {
        Some(rest) => rest.split('"').next()?,
        None => c.split(' ').next()?,
    };
    (!exe.is_empty()).then(|| PathBuf::from(exe))
}

/// "Blender 5.2" folder -> [5, 2], for picking the newest.
/// A Blender's version: the version folder every install keeps beside blender.exe ("5.2", its scripts and data), else
/// the digits in its folder's name ("Blender 5.2"). Steam's folder is just "Blender", so the version folder is what
/// ranks it.
fn version_of(exe: &Path) -> Vec<u32> {
    let digits = |n: &str| n.split(|c: char| !c.is_ascii_digit()).filter_map(|x| x.parse().ok()).collect::<Vec<u32>>();
    let Some(dir) = exe.parent() else { return Vec::new() };
    let inside = fs::read_dir(dir).into_iter().flatten().flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.split('.').count() == 2 && n.split('.').all(|x| !x.is_empty() && x.chars().all(|c| c.is_ascii_digit())))
        .map(|n| digits(&n))
        .max();
    inside.unwrap_or_else(|| dir.file_name().map(|n| digits(&n.to_string_lossy())).unwrap_or_default())
}

/// Where the installed kit came from: "github" or "file" (None for a kit installed before this was recorded).
fn source(dir: &Path) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.join("source.json")).ok()?).ok()?;
    v["from"].as_str().filter(|s| matches!(*s, "github" | "file")).map(str::to_string)
}

/// Records where a kit came from ("github" or "file") in its folder.
fn record_source(dir: &Path, from: &str) -> Result<(), String> {
    fs::write(dir.join("source.json"), serde_json::json!({ "from": from }).to_string()).map_err(|e| format!("Could not record where the kit came from: {e}"))
}

#[derive(Serialize)]
pub struct KitStatus {
    /// Installed kit version
    version: Option<String>,
    /// Where it came from: "github" or "file"
    source: Option<String>,
    blender: Option<String>,
}

#[tauri::command]
pub fn preview_kit_status() -> KitStatus {
    let version = installed(&kit_dir());
    KitStatus {
        source: version.as_ref().and_then(|_| source(&kit_dir())),
        version,
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

/// Kit size limits, about 8x the v9 kit (117 MB zip, 1,408 files, 263 MB unpacked, largest file 69 MB). The sizes a
/// zip declares are not trusted: bytes are counted as they are written.
const MAX_DOWNLOAD: u64 = 1 << 30;
const MAX_ENTRIES: usize = 20_000;
const MAX_ENTRY_BYTES: u64 = 512 << 20;
const MAX_TOTAL_BYTES: u64 = 2 << 30;

#[cfg(test)]
fn unpack(zip: &[u8], dir: &Path, from: &str) -> Result<String, String> {
    unpack_from(std::io::Cursor::new(zip), dir, from)
}

/// Unpacks a kit zip into `dir` (replacing what is there) through a side folder, so a bad zip leaves the old kit, and
/// records where it came from (`from`) in the side folder first: a kit in place always says its source. repakxtra:
/// each file streams to disk (never a whole file in memory), within the limits above.
fn unpack_from(zip: impl Read + Seek, dir: &Path, from: &str) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(zip).map_err(|e| format!("Not a zip: {e}"))?;
    if archive.len() > MAX_ENTRIES {
        return Err(format!("That zip holds {} files, more than a preview kit can ({MAX_ENTRIES}).", archive.len()));
    }
    let side = dir.with_extension("new");
    let _ = fs::remove_dir_all(&side);
    let written = (|| -> Result<(), String> {
        let mut total = 0u64;
        for i in 0..archive.len() {
            let f = archive.by_index(i).map_err(|e| e.to_string())?;
            let Some(rel) = f.enclosed_name() else { continue }; // never outside the kit folder
            let to = side.join(&rel);
            if f.is_dir() {
                fs::create_dir_all(&to).map_err(|e| e.to_string())?;
                continue;
            }
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = fs::File::create(&to).map_err(|e| format!("Could not write {}: {e}", rel.display()))?;
            let n = std::io::copy(&mut f.take(MAX_ENTRY_BYTES + 1), &mut out)
                .map_err(|e| format!("Could not write {}: {e}", rel.display()))?;
            total += n;
            if n > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES {
                return Err(format!("That zip unpacks to more than a preview kit can ({} stopped it).", rel.display()));
            }
        }
        Ok(())
    })();
    if let Err(e) = written {
        let _ = fs::remove_dir_all(&side);
        return Err(e);
    }
    let Some(version) = installed(&side) else {
        let _ = fs::remove_dir_all(&side);
        return Err("That zip is not a repakxtra preview kit (no kit.json, python or generator in it).".into());
    };
    if let Err(e) = record_source(&side, from) {
        let _ = fs::remove_dir_all(&side);
        return Err(e);
    }
    let _ = fs::remove_dir_all(dir);
    fs::rename(&side, dir).map_err(|e| format!("Could not put the kit in place: {e}"))?;
    Ok(version)
}

/// Install progress for Setup (`preview-kit-progress`): the stage, and the bytes so far of `total` (0 when unknown).
/// Blender's stage also says what winget is doing ("Downloading", "Starting package install...").
#[derive(Clone, Serialize)]
struct Progress {
    stage: &'static str,
    done: u64,
    total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

/// Downloads the kit zip to `to` (an app-owned file, not memory), reporting about every megabyte.
async fn download(app: &AppHandle, url: &str, to: &Path) -> Result<(), String> {
    let mut resp = reqwest::Client::new().get(url).header("User-Agent", "repakxtra").send().await
        .and_then(|r| r.error_for_status()).map_err(|e| format!("Download failed: {e}"))?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = fs::File::create(to).map_err(|e| format!("Could not save the download: {e}"))?;
    let (mut done, mut told) = (0u64, 0u64);
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Download failed: {e}"))? {
        done += chunk.len() as u64;
        if done > MAX_DOWNLOAD {
            return Err("The download is larger than a preview kit can be.".into());
        }
        file.write_all(&chunk).map_err(|e| format!("Could not save the download: {e}"))?;
        if done - told >= 1 << 20 || done == total {
            told = done;
            let _ = app.emit("preview-kit-progress", Progress { stage: "download", done, total, text: None });
        }
    }
    Ok(())
}

/// Installs the kit from `file` (a zip picked or dropped by hand) or, without one, from the newest GitHub release.
#[tauri::command]
pub async fn preview_kit_install(app: AppHandle, file: Option<String>) -> Result<String, String> {
    // Owned from before the download until the kit is in place: no render, check or second install meanwhile
    let hold = crate::xtra_previews::reserve("kit").map_err(crate::xtra_previews::busy_text)?;
    let from = if file.is_some() { "file" } else { "github" };
    fs::create_dir_all(crate::app_dir()).map_err(|e| e.to_string())?;
    let downloaded = crate::app_dir().join("preview-kit-download.zip");
    let zip = match file {
        Some(f) => PathBuf::from(f),
        None => {
            let release = preview_kit_latest().await?.ok_or("No preview kit has been published yet.")?;
            let got = download(&app, &release.asset, &downloaded).await;
            if let Err(e) = got {
                let _ = fs::remove_file(&downloaded);
                return Err(e);
            }
            downloaded.clone()
        }
    };
    let _ = app.emit("preview-kit-progress", Progress { stage: "unpack", done: 0, total: 0, text: None });
    // Thousands of files: off the async runtime
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _hold = hold;
        let file = fs::File::open(&zip).map_err(|e| format!("Could not read {}: {e}", zip.display()))?;
        unpack_from(std::io::BufReader::new(file), &kit_dir(), from)
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&downloaded);
    result
}

/// Installs Blender with winget (Windows' package manager: the official BlenderFoundation.Blender package; Blender's own
/// installer asks for admin rights once), then finds it. Already installed: just finds it. Setup shows winget's progress
/// as it goes, and every message lands in the app's Logs (scope Blender).
#[tauri::command]
pub async fn preview_kit_install_blender(app: AppHandle) -> Result<String, String> {
    if let Some(b) = blender() {
        return Ok(b.display().to_string());
    }
    crate::ui_log::info("Blender", "Installing Blender (winget package BlenderFoundation.Blender, from blender.org)");
    let (code, last) = tauri::async_runtime::spawn_blocking(move || run_winget(&app)).await.map_err(|e| e.to_string())??;
    if let Some(b) = blender() {
        crate::ui_log::success("Blender", format!("Installed: {}", b.display()));
        return Ok(b.display().to_string());
    }
    let error = format!("Blender did not install (winget exit {}). {last}", code.unwrap_or(-1));
    crate::ui_log::error("Blender", &error);
    Err(error)
}

/// "12.0 MB / 345 MB" (winget's download bar) as bytes done and total, or "45%" as 45 of 100.
fn winget_progress(line: &str) -> Option<(u64, u64)> {
    let size = regex_lite::Regex::new(r"(\d+(?:\.\d+)?)\s*(KB|MB|GB)\s*/\s*(\d+(?:\.\d+)?)\s*(KB|MB|GB)").ok()?;
    let bytes = |n: &str, unit: &str| n.parse::<f64>().ok().map(|v| (v * match unit { "KB" => 1024.0, "MB" => 1048576.0, _ => 1073741824.0 }) as u64);
    if let Some(c) = size.captures(line) {
        return Some((bytes(&c[1], &c[2])?, bytes(&c[3], &c[4])?));
    }
    let pct = regex_lite::Regex::new(r"(?:^|\s)(\d{1,3})\s*%").ok()?;
    pct.captures(line).and_then(|c| c[1].parse::<u64>().ok()).filter(|p| *p <= 100).map(|p| (p, 100))
}

/// Runs winget, passing its download progress and messages to Setup (`preview-kit-progress`, stage "blender") and its
/// messages to the Logs. winget redraws its bar with carriage returns, so its output is split on those too. Returns the
/// exit code and its last message.
fn run_winget(app: &AppHandle) -> Result<(Option<i32>, String), String> {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new("winget");
    cmd.args(["install", "--id", "BlenderFoundation.Blender", "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|_| "winget is not on this PC. Download Blender from blender.org, then pick blender.exe in Setup.".to_string())?;
    let mut out = child.stdout.take().ok_or("winget gave no output")?;
    // A Windows permission prompt left unanswered would keep Setup busy forever: after 30 minutes winget is ended (the
    // reads below then end too). The process handle stays open until wait(), so the PID cannot belong to anyone else
    let (done, timer) = std::sync::mpsc::channel::<()>();
    let pid = child.id();
    std::thread::spawn(move || {
        if timer.recv_timeout(std::time::Duration::from_secs(30 * 60)).is_err() {
            let mut kill = std::process::Command::new("taskkill");
            kill.args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                kill.creation_flags(0x08000000);
            }
            let _ = kill.status();
        }
    });
    let mut last = String::new();
    let mut sent = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let mut handle = |raw: &[u8]| {
        let line = String::from_utf8_lossy(raw);
        let line = line.trim();
        if let Some((done, total)) = winget_progress(line) {
            if sent.elapsed().as_millis() >= 150 || done >= total {
                sent = std::time::Instant::now();
                let _ = app.emit("preview-kit-progress", Progress { stage: "blender", done, total, text: Some(last.clone()) });
            }
        } else if line.chars().filter(|c| c.is_alphabetic()).count() >= 3 && line != last {
            // A message, not the spinner winget draws while it waits
            crate::ui_log::info("Blender", line);
            last = line.to_string();
            let _ = app.emit("preview-kit-progress", Progress { stage: "blender", done: 0, total: 0, text: Some(last.clone()) });
        }
    };
    let (mut buf, mut line) = ([0u8; 4096], Vec::new());
    loop {
        let n = out.read(&mut buf).unwrap_or(0);
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            if b == b'\r' || b == b'\n' {
                handle(&line);
                line.clear();
            } else {
                line.push(b);
            }
        }
    }
    handle(&line);
    drop(handle);
    let code = child.wait().ok().and_then(|s| s.code());
    let _ = done.send(());
    Ok((code, last))
}

#[tauri::command]
pub fn preview_kit_remove() -> Result<(), String> {
    let _hold = crate::xtra_previews::reserve("kit").map_err(crate::xtra_previews::busy_text)?;
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
    use std::io::Cursor;

    #[test]
    fn the_newest_blender_found_is_used() {
        let p = |s: &str| PathBuf::from(s);
        let found = vec![p(r"D:\Steam\steamapps\common\Blender\blender.exe"), p(r"C:\Program Files\Blender Foundation\Blender 4.2\blender.exe"), p(r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe")];
        assert_eq!(newest(found), Some(p(r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe")));
        assert_eq!(newest(vec![p(r"D:\Steam\steamapps\common\Blender\blender.exe"), p(r"E:\Tools\Blender\blender.exe")]), Some(p(r"D:\Steam\steamapps\common\Blender\blender.exe")), "no versions: the first found");
        // a Steam install ("Blender", no digits) ranks by the version folder beside its exe
        let root = std::env::temp_dir().join(format!("blender-ver-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let steam = root.join("steamapps").join("common").join("Blender");
        let old = root.join("Blender Foundation").join("Blender 4.2");
        for (d, v) in [(&steam, "5.2"), (&old, "4.2")] {
            fs::create_dir_all(d.join(v)).unwrap();
            fs::write(d.join("blender.exe"), b"").unwrap();
        }
        assert_eq!(newest(vec![old.join("blender.exe"), steam.join("blender.exe")]), Some(steam.join("blender.exe")), "Steam's 5.2 beats a named 4.2");
        let _ = fs::remove_dir_all(&root);
        assert_eq!(launch_exe(r#""C:\Program Files\Blender Foundation\Blender 5.2\blender-launcher.exe" "%1""#), Some(p(r"C:\Program Files\Blender Foundation\Blender 5.2\blender-launcher.exe")));
        assert_eq!(launch_exe(r"C:\Blender\blender.exe %1"), Some(p(r"C:\Blender\blender.exe")));
    }

    #[test]
    fn a_zip_that_unpacks_past_the_limit_is_refused_and_the_old_kit_stays() {
        let dir = std::env::temp_dir().join(format!("kit-limit-{}", std::process::id())).join("preview-kit");
        let _ = fs::remove_dir_all(dir.parent().unwrap());
        unpack(&kit_zip(&[]), &dir, "github").unwrap();
        // 600 MB of zeros compresses to well under a megabyte
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (n, b) in [("kit.json", &br#"{"version": "9"}"#[..]), ("python/python.exe", b"py"), ("previews/mod_previews.py", b"#")] {
            w.start_file(n, o).unwrap();
            w.write_all(b).unwrap();
        }
        w.start_file("big.bin", o).unwrap();
        let block = vec![0u8; 1 << 20];
        for _ in 0..600 {
            w.write_all(&block).unwrap();
        }
        let bomb = w.finish().unwrap().into_inner();
        assert!(bomb.len() < 2 << 20, "the fixture stays small: {} bytes", bomb.len());
        assert!(unpack(&bomb, &dir, "file").is_err());
        assert_eq!(installed(&dir).as_deref(), Some("2"), "the old kit stays");
        assert!(!dir.with_extension("new").exists(), "no side folder is left behind");
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    /// REPAKXTRA_KIT_ZIP=<path of a kit zip> cargo test -p repak-x --bin REPAK-X a_real_kit -- --ignored
    #[test]
    #[ignore]
    fn a_real_kit_unpacks_within_the_limits() {
        let zip = std::env::var("REPAKXTRA_KIT_ZIP").expect("set REPAKXTRA_KIT_ZIP");
        let dir = std::env::temp_dir().join(format!("kit-real-{}", std::process::id())).join("preview-kit");
        let _ = fs::remove_dir_all(dir.parent().unwrap());
        let file = std::io::BufReader::new(fs::File::open(zip).unwrap());
        assert!(unpack_from(file, &dir, "file").is_ok());
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn reads_wingets_download_bar_and_percent() {
        assert_eq!(winget_progress("  ██████▒▒▒▒  12.0 MB /  345 MB"), Some((12 * 1048576, 345 * 1048576)));
        assert_eq!(winget_progress("1.5 GB / 2 GB"), Some(((1.5 * 1073741824.0) as u64, 2 * 1073741824)));
        assert_eq!(winget_progress("  ████  45%"), Some((45, 100)));
        assert_eq!(winget_progress("Starting package install..."), None);
        assert_eq!(winget_progress("Found Blender [BlenderFoundation.Blender] Version 5.2"), None);
    }

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
        assert_eq!(unpack(&kit_zip(&[]), &dir, "github").unwrap(), "2");
        assert_eq!(source(&dir).as_deref(), Some("github"), "an install records its source");
        assert!(dir.join(r"python\python.exe").exists());
        assert!(unpack(b"not a zip", &dir, "file").is_err());
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        w.start_file("readme.txt", zip::write::SimpleFileOptions::default()).unwrap();
        assert!(unpack(&w.finish().unwrap().into_inner(), &dir, "file").is_err(), "a zip without a kit is refused");
        assert_eq!(installed(&dir).as_deref(), Some("2"), "the old kit stays after a refused zip");
        assert_eq!(source(&dir).as_deref(), Some("github"), "and keeps its source");
        // A source that cannot be written (a folder named source.json in the zip) fails the install and keeps the old kit
        assert!(unpack(&kit_zip(&[("source.json/x", b"x")]), &dir, "file").is_err());
        assert_eq!(source(&dir).as_deref(), Some("github"), "the old kit stays when its source cannot be recorded");
        assert!(!dir.with_extension("new").exists(), "no side folder is left behind");
        record_source(&dir, "file").unwrap();
        assert_eq!(source(&dir).as_deref(), Some("file"));
        fs::write(dir.join("source.json"), r#"{"from": "elsewhere"}"#).unwrap();
        assert_eq!(source(&dir), None, "only github or file");
        assert!(!dir.parent().unwrap().join("evil.txt").exists());
        let _ = unpack(&kit_zip(&[("../evil.txt", b"x")]), &dir, "file");
        assert!(!dir.parent().unwrap().join("evil.txt").exists(), "nothing lands outside the kit folder");
        for (json, want) in [(&br#"{"version": 3}"#[..], Some("3")), (br#"{"version": " 4 "}"#, Some("4")), (br#"{"version": null}"#, None),
                             (br#"{"version": ""}"#, None), (br#"{"version": [1]}"#, None), (br#"{}"#, None)] {
            fs::write(dir.join("kit.json"), json).unwrap();
            assert_eq!(installed(&dir).as_deref(), want, "kit.json {}", String::from_utf8_lossy(json));
        }
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
