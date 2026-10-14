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

/// A loadout's combined render (`set`), from the generator's <set>.json: `covers`, the mods it shows (empty when there
/// is none), and `members`, the installed mods it was rendered for (null for renders older than that record).
#[tauri::command]
pub fn get_preview_covers(key: String) -> serde_json::Value {
    let v = if valid_key(&key) {
        std::fs::read_to_string(previews_dir().join(format!("{key}.json")))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .unwrap_or_default()
    } else {
        serde_json::Value::Null
    };
    let list = |name: &str| serde_json::from_value::<Vec<String>>(v[name].clone()).ok();
    serde_json::json!({ "covers": list("covers").unwrap_or_default(), "members": list("members") })
}

/// One line of the generator's output as (event, key): "PREVIEW <key>" after writing a PNG, "PREVIEW_NONE <key>" when
/// there is nothing to show, "PREVIEW_IN <key>" for a mod the loadout's combined render shows, "PREVIEW_FAIL <key>" when
/// it failed (its last good preview stays), and "PREVIEW_BUSY" (no key) when another generator holds the lock.
fn parse_line(line: &str) -> Option<(&'static str, Option<String>)> {
    if line.trim() == "PREVIEW_BUSY" {
        return Some(("mod-previews-busy", None));
    }
    [
        ("PREVIEW_NONE ", "mod-preview-none"),
        ("PREVIEW_IN ", "mod-preview-in"),
        ("PREVIEW_FAIL ", "mod-preview-failed"),
        ("PREVIEW ", "mod-preview-ready"),
    ]
    .into_iter()
    .find_map(|(prefix, event)| line.strip_prefix(prefix).map(|k| (event, Some(k.trim().to_string()))))
}

/// Renders previews for the given mods (`jobs` = [folder, mod key] pairs) one after another in the background,
/// replacing existing ones. With `set` (a loadout), its character mods render once together as <set>.png.
/// Progress: `mod-preview-ready` / `mod-preview-none` / `mod-preview-in` (shown in the set's render) /
/// `mod-preview-failed` per mod or set, `mod-previews-busy` when another generator (a manual run, or one an earlier
/// app session left going) holds its lock, `mod-previews-done` (ok) at the end. Ok(false) = this app runs one already.
/// Unchanged mods and sets report their existing result without rendering; `force` (Regenerate) renders them anyway.
/// The generator alone owns its lock and the cancel file (it clears a stale Stop once it holds the lock).
#[tauri::command]
pub fn generate_mod_previews(app: AppHandle, jobs: Vec<(String, String)>, set: Option<String>, force: Option<bool>) -> Result<bool, String> {
    if let Some(bad) = jobs.iter().map(|(_, k)| k).chain(set.iter()).find(|k| !valid_key(k)) {
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
    // One generator run over every folder the mods sit in (a loadout's combined render needs all of them at once)
    let mut cmd = Command::new(&python);
    cmd.arg(&script).arg("--out").arg(previews_dir());
    if force == Some(true) {
        cmd.arg("--force");
    }
    let mut dirs: Vec<&String> = jobs.iter().map(|(d, _)| d).collect();
    dirs.sort();
    dirs.dedup();
    for d in dirs {
        cmd.arg("--mods").arg(d);
    }
    for (_, k) in &jobs {
        cmd.arg("--key").arg(k);
    }
    if let Some(s) = &set {
        cmd.arg("--set").arg(s);
    }
    // Errors go to previews\generator.log, which the app names when a render fails; UTF-8 keeps a mod name like
    // "Pokémon" from breaking the result lines
    let log = std::fs::create_dir_all(previews_dir())
        .and_then(|_| std::fs::File::create(previews_dir().join("generator.log")))
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    cmd.current_dir(&root).env("PYTHONUTF8", "1").stdout(Stdio::piped()).stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    std::thread::spawn(move || {
        let mut ok = false;
        if let Ok(mut child) = cmd.spawn() {
            if let Some(out) = child.stdout.take() {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    match parse_line(&line) {
                        Some((event, Some(key))) => {
                            let _ = app.emit(event, key);
                        }
                        Some((event, None)) => {
                            let _ = app.emit(event, ());
                        }
                        None => {}
                    }
                }
            }
            ok = child.wait().map(|s| s.success()).unwrap_or(false);
        }
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

    #[test]
    fn generator_lines_become_events() {
        let k = |s: &str| Some(s.to_string());
        assert_eq!(parse_line("PREVIEW_BUSY"), Some(("mod-previews-busy", None)));
        assert_eq!(parse_line("PREVIEW_BUSY\r"), Some(("mod-previews-busy", None)));
        assert_eq!(parse_line("PREVIEW_FAIL loadout-1"), Some(("mod-preview-failed", k("loadout-1"))));
        assert_eq!(parse_line("PREVIEW_NONE A"), Some(("mod-preview-none", k("A"))));
        assert_eq!(parse_line("PREVIEW_IN A"), Some(("mod-preview-in", k("A"))));
        assert_eq!(parse_line("PREVIEW A_v2\r"), Some(("mod-preview-ready", k("A_v2"))));
        assert_eq!(parse_line("# A: character (12 s)"), None);
    }
}
