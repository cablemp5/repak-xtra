//! repakxtra: Rotate in 3D (custom/viewer3d) and the texture check, both made by the preview kit (kit 19 and newer):
//! `--viewer` writes %APPDATA%\Repak-X\previews\<key>.3d\ (model.glb, Materials, tex, textures.json, idle.json and
//! idle.bin, props.json), `--texcheck` writes previews\texcheck.json and prints a TEXCHECK line per mod. Both runs hold
//! the same reservation as previews (xtra_previews.rs), so they never run beside a preview run or a kit install.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use crate::xtra_previews::{app_usmap, busy_text, generator_command, log_generator, previews_dir, reserve, valid_key};

/// A file of a viewer export, <key>.3d\<file>: `file` is a relative path of plain names (model.glb, tex/T_a.png,
/// Materials/MI_a.json, props/SK_x/idle.bin), so it never leaves that folder.
fn viewer_path(key: &str, file: &str) -> Option<PathBuf> {
    let plain = |p: &str| !p.is_empty() && p != "." && p != ".." && p.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c));
    (valid_key(key) && file.split('/').all(plain)).then(|| previews_dir().join(format!("{key}.3d")).join(file.replace('/', "\\")))
}

/// One file of a mod's (or loadout's) 3D export, as bytes (the viewer makes blob: URLs of them, so the CSP is unchanged).
#[tauri::command(async)]
pub fn get_viewer_file(key: String, file: String) -> Result<tauri::ipc::Response, String> {
    let path = viewer_path(&key, &file).ok_or_else(|| format!("Invalid viewer file: {key} {file}"))?;
    std::fs::read(path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// What Rotate in 3D finds for a key: "ready" (an export newer than every one of `paths`, the mod files it shows),
/// "stale" (one changed since), "overridden" (the last preview found the game's own mesh winning: the kit's index.json
/// for a mod, a loadout's <key>.json), "none" (its last preview found no character: a VFX, UI, sound or animation mod),
/// or "missing".
#[tauri::command(async)]
pub fn viewer_state(key: String, paths: Vec<String>) -> &'static str {
    if !valid_key(&key) {
        return "missing";
    }
    let dir = previews_dir();
    let read = |p: PathBuf| std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).unwrap_or_default();
    if let Ok(made) = std::fs::metadata(dir.join(format!("{key}.3d")).join("model.json")).and_then(|m| m.modified()) {
        let newer = paths.iter().any(|p| std::fs::metadata(p).and_then(|m| m.modified()).is_ok_and(|t| t > made));
        return if newer { "stale" } else { "ready" };
    }
    let kind = read(dir.join("index.json"))[&key]["kind"].as_str().map(str::to_string).unwrap_or_default();
    if kind == "overridden" || read(dir.join(format!("{key}.json")))["overridden"] == true {
        return "overridden";
    }
    // the kit already found this mod is no character (or has nothing to show): no 3D either
    if matches!(kind.as_str(), "none" | "vfx" | "ui" | "sound" | "anim") {
        return "none";
    }
    "missing"
}

/// The kit run with `extra` (--viewer or --texcheck) for these mods (`jobs` = [folder, mod key] pairs) and loadout
/// (`set`): its stdout lines go to `line` as they come, its notes and errors to the app's Logs. Err: the reservation
/// is taken (busy_text), the kit is missing, or it did not start.
fn run_kit(who: &'static str, extra: &str, jobs: &[(String, String)], set: Option<&str>, paks: Option<PathBuf>, mut line: impl FnMut(&str)) -> Result<bool, String> {
    if let Some(bad) = jobs.iter().map(|(_, k)| k.as_str()).chain(set).find(|k| !valid_key(k)) {
        return Err(format!("Invalid preview key: {bad}"));
    }
    let _hold = reserve_waiting(who).map_err(busy_text)?;
    let mut cmd = generator_command(paks, false)?;
    cmd.arg("--out").arg(previews_dir()).arg(extra);
    let mut dirs: Vec<&String> = jobs.iter().map(|(d, _)| d).collect();
    dirs.sort();
    dirs.dedup();
    for d in dirs {
        cmd.arg("--mods").arg(d);
    }
    for (_, k) in jobs {
        cmd.arg("--key").arg(k);
    }
    if let Some(s) = set {
        cmd.arg("--set").arg(s);
    }
    if let Some(usmap) = app_usmap() {
        cmd.env("REPAKXTRA_USMAP", usmap);
    }
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("The preview kit did not start: {e}"))?;
    let logger = child.stderr.take().map(|err| std::thread::spawn(move || log_generator(err, None)));
    if let Some(out) = child.stdout.take() {
        for l in BufReader::new(out).lines().map_while(Result::ok) {
            line(l.trim_end());
        }
    }
    let ok = child.wait().map(|s| s.success()).unwrap_or(false);
    if let Some(l) = logger {
        let _ = l.join();
    }
    Ok(ok)
}

/// The kit's reservation (xtra_previews.rs reserve), waiting out a background texture check: it runs 5 mods at a time
/// (seconds), so a click on Rotate in 3D or Generate preview meanwhile starts right after it instead of failing.
/// Anything else holding it (a preview run, a kit install) is answered at once.
pub(crate) fn reserve_waiting(who: &'static str) -> Result<crate::xtra_previews::Hold, &'static str> {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(90);
    loop {
        match reserve(who) {
            Err("texcheck") if who != "texcheck" && std::time::Instant::now() < until => std::thread::sleep(std::time::Duration::from_millis(200)),
            other => return other,
        }
    }
}

fn paks_of(state: &State<'_, Arc<Mutex<crate::AppState>>>) -> Option<PathBuf> {
    state.lock().unwrap().game_path.parent().map(Path::to_path_buf)
}

/// Makes the 3D export for one mod (or a loadout's mods with `set`): "ready", "none" (nothing to show in 3D),
/// "overridden" (the game's own mesh wins) or "failed" (the error is in Logs). The kit's steps come as
/// `mod-viewer-stage` events (custom/previewStages.ts words) while it works. Err: busy or no kit, said plainly.
#[tauri::command]
pub async fn generate_mod_viewer(app: AppHandle, jobs: Vec<(String, String)>, set: Option<String>, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<String, String> {
    let paks = paks_of(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = "failed";
        run_kit("previews", "--viewer", &jobs, set.as_deref(), paks, |l| {
            if let Some(step) = l.strip_prefix("PREVIEW_STAGE ") {
                let _ = app.emit("mod-viewer-stage", step.trim().to_string());
            } else if l.starts_with("VIEWER_OVERRIDDEN ") {
                result = "overridden";
            } else if l.starts_with("VIEWER_NONE ") {
                result = if result == "overridden" { result } else { "none" };
            } else if l.starts_with("VIEWER_FAIL ") {
                result = "failed";
            } else if l.starts_with("VIEWER ") {
                result = "ready";
            }
        })?;
        Ok(result.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Checks these mods' textures with the kit (`--texcheck`, cached by the mod's files in texcheck.json, so an
/// unchanged mod costs nothing). Returns how many have textures the game cannot read. The Library calls it a few mods
/// at a time, so the reservation is free again within seconds when Generate preview is clicked meanwhile.
#[tauri::command]
pub async fn run_texcheck(jobs: Vec<(String, String)>, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<usize, String> {
    let paks = paks_of(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let mut found = 0;
        let ok = run_kit("texcheck", "--texcheck", &jobs, None, paks, |l| {
            let bad = l.strip_prefix("TEXCHECK ").and_then(|rest| rest.split_once(' '))
                .and_then(|(_, json)| serde_json::from_str::<serde_json::Value>(json).ok())
                .is_some_and(|v| v["unreadable"].as_array().is_some_and(|a| !a.is_empty()));
            found += usize::from(bad);
        })?;
        if !ok {
            return Err("The texture check did not finish (a preview kit older than 19 has none). The details are in Logs.".to_string());
        }
        Ok(found)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The kit's mod key for a mod file (mod_previews.py mod_key): the stem without _disabled and the _<n>_P priority.
fn kit_key(path: &Path) -> String {
    let mut s = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    if s.to_lowercase().ends_with("_disabled") {
        s.truncate(s.len() - "_disabled".len());
    }
    loop {   // (_<digits>_P)+ at the end
        let Some(rest) = s.strip_suffix("_P").or_else(|| s.strip_suffix("_p")) else { break };
        let Some(i) = rest.rfind('_') else { break };
        if i + 1 == rest.len() || !rest[i + 1..].bytes().all(|b| b.is_ascii_digit()) {
            break;
        }
        s.truncate(i);
    }
    s
}

/// Broken reasons from the kit's texture check (texcheck.json) for these mods: (mod path, reason). Only a result whose
/// .utoc size and time still match the mod (the kit's signature fields 2 and 3), so an edited mod is never judged by
/// its older files.
pub(crate) fn texcheck_reasons(mod_paths: &[String]) -> Vec<(String, String)> {
    let Some(store) = std::fs::read_to_string(previews_dir().join("texcheck.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else {
        return Vec::new();
    };
    mod_paths.iter().filter_map(|p| {
        let path = Path::new(p);
        let entry = &store[kit_key(path)];
        let bad = entry["result"]["unreadable"].as_array().filter(|a| !a.is_empty())?;
        let meta = std::fs::metadata(path.with_extension("utoc")).ok()?;
        let ns = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
        let sig: Vec<&str> = entry["sig"].as_str()?.split(':').collect();
        (sig.get(1) == Some(&meta.len().to_string().as_str()) && sig.get(2) == Some(&ns.to_string().as_str())).then_some(())?;
        let names: Vec<&str> = bad.iter().filter_map(|t| t["path"].as_str()?.rsplit('/').next()).collect();
        let shown = names.iter().take(5).copied().collect::<Vec<_>>().join(", ");
        let more = if names.len() > 5 { format!(" and {} more", names.len() - 5) } else { String::new() };
        let checked = entry["result"]["checked"].as_u64().unwrap_or(names.len() as u64);
        Some((p.clone(), format!(
            "{} of its {checked} textures cannot be read by this game version (no mip levels, an unknown pixel format, or they do not load): {shown}{more}. The game draws them blank or may crash. The mod needs a rebuild from its maker.",
            names.len())))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewer_files_stay_inside() {
        assert!(viewer_path("Mod", "model.glb").is_some() && viewer_path("Mod", "tex/T_a.png").is_some() && viewer_path("Mod", "props/SK_x/idle.bin").is_some());
        for bad in ["../x", "tex/../../a", "/abs", "a\\b", "C:/x", "", "tex//a", "a b"] {
            assert!(viewer_path("Mod", bad).is_none(), "{bad}");
        }
        assert!(viewer_path("../Mod", "model.glb").is_none());
    }

    #[test]
    fn kit_keys_match_the_kit() {
        assert_eq!(kit_key(Path::new(r"C:\m\bp-lime-vfx_vfx_noPG_v2_9999999_P.pak")), "bp-lime-vfx_vfx_noPG_v2");
        assert_eq!(kit_key(Path::new(r"C:\m\Foo_disabled.pak")), "Foo");
        assert_eq!(kit_key(Path::new(r"C:\m\B_P.pak")), "B_P");
        assert_eq!(kit_key(Path::new(r"C:\m\A_1_P_2_P.bak_repak")), "A");
    }
}
