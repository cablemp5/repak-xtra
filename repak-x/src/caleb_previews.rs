//! caleb fork: generated mod previews. The generator lives in Caleb's modding tools
//! (`tools\previews\mod_previews.py`, it needs Cue4Export and Blender from there) and writes one PNG per
//! mod to %APPDATA%\Repak-X\previews\<mod key>.png. This module serves those files and runs the generator
//! for one mod at a time (the Generate preview button); a finished preview is announced as `mod-preview-ready`.

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

/// Renders the preview of one mod (`key`, in `mods_dir`) in the background, replacing an existing one.
/// Ok(false) = a render is already running.
#[tauri::command]
pub fn generate_mod_preview(app: AppHandle, mods_dir: String, key: String) -> Result<bool, String> {
    if !valid_key(&key) {
        return Err(format!("Invalid preview key: {key}"));
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
    let mut cmd = Command::new(python);
    cmd.arg(&script).arg("--mods").arg(mods_dir).arg("--out").arg(previews_dir())
        .arg("--key").arg(&key).arg("--force");
    cmd.current_dir(&root).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            RUNNING.store(false, Ordering::SeqCst);
            return Err(e.to_string());
        }
    };
    std::thread::spawn(move || {
        if let Some(out) = child.stdout.take() {
            // The generator prints "PREVIEW <key>" after writing each PNG
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Some(key) = line.strip_prefix("PREVIEW ") {
                    let _ = app.emit("mod-preview-ready", key.trim().to_string());
                }
            }
        }
        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        RUNNING.store(false, Ordering::SeqCst);
        let _ = app.emit("mod-previews-done", (key, ok));
    });
    Ok(true)
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
