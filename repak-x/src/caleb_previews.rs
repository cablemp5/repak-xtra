//! caleb fork: generated mod previews. The generator lives in Caleb's modding tools
//! (`tools\previews\mod_previews.py`, it needs Cue4Export and Blender from there) and writes one PNG per
//! mod to %APPDATA%\Repak-X\previews\<mod key>.png. This module serves those files and runs the generator
//! for the mods you pick (details panel button, or the selection bar's Previews button).

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

static RUNNING: AtomicBool = AtomicBool::new(false);

fn previews_dir() -> PathBuf {
    crate::app_dir().join("previews")
}

/// Caleb's modding folder (the generator, its python and its tools live there).
fn modding_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(r"Programming\Modding\Claude Assisted Mods")
}

/// A mod key is a bare file stem from the frontend: never let it leave the previews folder.
fn valid_key(key: &str) -> bool {
    !key.is_empty() && !key.contains(['/', '\\', ':']) && !key.contains("..")
}

#[tauri::command]
pub fn list_mod_previews() -> Vec<String> {
    std::fs::read_dir(previews_dir())
        .map(|it| {
            it.filter_map(|e| e.ok()?.file_name().to_str()?.strip_suffix(".png").map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_mod_preview(key: String) -> Result<tauri::ipc::Response, String> {
    if !valid_key(&key) {
        return Err(format!("Invalid preview key: {key}"));
    }
    std::fs::read(previews_dir().join(format!("{key}.png")))
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

/// Renders previews for the given mods (`jobs` = [folder, mod key] pairs) one after another in the background,
/// replacing existing ones. Progress: `mod-preview-ready` / `mod-preview-none` per mod, `mod-previews-done` (ok) at
/// the end. Ok(false) = a run is already going.
#[tauri::command]
pub fn generate_mod_previews(app: AppHandle, jobs: Vec<(String, String)>) -> Result<bool, String> {
    if let Some((_, bad)) = jobs.iter().find(|(_, k)| !valid_key(k)) {
        return Err(format!("Invalid preview key: {bad}"));
    }
    let root = modding_dir();
    let python = root.join(r".venv\Scripts\python.exe");
    let script = root.join(r"tools\previews\mod_previews.py");
    if !python.exists() || !script.exists() {
        return Err(format!("Preview generator not found at {}", script.display()));
    }
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(false);
    }
    let _ = std::fs::remove_file(previews_dir().join("cancel"));
    // One generator run per mods folder (it scans one folder), in the order the folders first appear
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for (dir, key) in jobs {
        match groups.iter_mut().find(|(d, _)| *d == dir) {
            Some((_, keys)) => keys.push(key),
            None => groups.push((dir, vec![key])),
        }
    }
    std::thread::spawn(move || {
        let mut ok = true;
        for (dir, keys) in groups {
            let mut cmd = Command::new(&python);
            cmd.arg(&script).arg("--mods").arg(&dir).arg("--out").arg(previews_dir()).arg("--force");
            for k in &keys {
                cmd.arg("--key").arg(k);
            }
            cmd.current_dir(&root).stdout(Stdio::piped()).stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            let Ok(mut child) = cmd.spawn() else {
                ok = false;
                continue;
            };
            if let Some(out) = child.stdout.take() {
                // The generator prints "PREVIEW <key>" after writing a PNG, "PREVIEW_NONE <key>" when there is nothing to show
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    if let Some(key) = line.strip_prefix("PREVIEW_NONE ") {
                        let _ = app.emit("mod-preview-none", key.trim().to_string());
                    } else if let Some(key) = line.strip_prefix("PREVIEW ") {
                        let _ = app.emit("mod-preview-ready", key.trim().to_string());
                    }
                }
            }
            ok &= child.wait().map(|s| s.success()).unwrap_or(false);
            if previews_dir().join("cancel").exists() {
                break;
            }
        }
        let _ = std::fs::remove_file(previews_dir().join("cancel"));
        RUNNING.store(false, Ordering::SeqCst);
        let _ = app.emit("mod-previews-done", ok);
    });
    Ok(true)
}

/// Stops a run after the mod it is rendering now (the generator checks for this file between mods).
#[tauri::command]
pub fn cancel_mod_previews() -> Result<(), String> {
    std::fs::create_dir_all(previews_dir()).map_err(|e| e.to_string())?;
    std::fs::write(previews_dir().join("cancel"), b"").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_stay_inside_the_folder() {
        assert!(valid_key("bp-8bit_bp+matSwap_outline_noPG_v3"));
        assert!(!valid_key("..\\state"));
        assert!(!valid_key("C:evil"));
        assert!(!valid_key("a/b"));
        assert!(!valid_key(""));
    }
}
