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

/// Where a file of an export lives: its own folder, else (kit 20) the skin's shared part, previews\3d-base\<base>\, that
/// texture and material mods on one mesh share (model.glb, idle.json, idle.bin), named by model.json's "base".
fn viewer_file(key: &str, file: &str) -> Option<PathBuf> {
    let own = viewer_path(key, file)?;
    if own.is_file() || file == "model.json" {
        return Some(own);
    }
    let model: serde_json::Value = serde_json::from_slice(&std::fs::read(viewer_path(key, "model.json")?).ok()?).ok()?;
    Some(previews_dir().join("3d-base").join(base_of(&model)?).join(file.replace('/', "\\")))
}

/// model.json's "base" when it is a kit base key (16 hex digits), so it never names a path outside 3d-base.
fn base_of(model: &serde_json::Value) -> Option<&str> {
    model["base"].as_str().filter(|b| b.len() == 16 && b.bytes().all(|c| c.is_ascii_hexdigit()))
}

/// One file of a mod's (or loadout's) 3D export, as bytes (parsed in memory and decoded as ImageBitmaps, so no new CSP source).
#[tauri::command(async)]
pub fn get_viewer_file(key: String, file: String) -> Result<tauri::ipc::Response, String> {
    let path = viewer_file(&key, &file).ok_or_else(|| format!("Invalid viewer file: {key} {file}"))?;
    std::fs::read(path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// The mod files an export was made from, as the app sees them: each path (lowercase), size and modified time. Written
/// beside the export (stamp.json) when it is made, so a renamed mod (its priority changes with its name), an edited one,
/// or a loadout that gained or lost a mod reads as stale and is made again.
fn stamp_of(paths: &[String]) -> serde_json::Value {
    let mut rows: Vec<serde_json::Value> = paths.iter().map(|p| {
        let m = std::fs::metadata(p).ok();
        let t = m.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64);
        let k = p.to_lowercase().replace('/', "\\");
        let k = [".pak_disabled", ".bak_repak", ".pak"].iter().find_map(|x| k.strip_suffix(x)).unwrap_or(&k).to_string();
        serde_json::json!([k, m.map(|m| m.len()), t])
    }).collect();
    rows.sort_by_key(|r| r[0].as_str().unwrap_or_default().to_string());
    serde_json::Value::Array(rows)
}

/// What Rotate in 3D finds for a key: "ready" (an export made from exactly these `paths`, the mod files it shows, as
/// they are now; with no paths, any export), "stale" (they changed since), "overridden" (the last preview found the game's own mesh winning: the kit's index.json
/// for a mod, a loadout's <key>.json), "none" (its last preview found no character: a VFX, UI, sound or animation mod),
/// or "missing".
#[tauri::command(async)]
pub fn viewer_state(key: String, paths: Vec<String>) -> &'static str {
    if !valid_key(&key) {
        return "missing";
    }
    let dir = previews_dir();
    let read = |p: PathBuf| std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).unwrap_or_default();
    let export = dir.join(format!("{key}.3d"));
    if export.join("model.json").is_file() {
        // kit 20: the skin's shared part it reads can be gone (the kit removes bases from an older game build): made again
        let base_gone = base_of(&read(export.join("model.json"))).is_some_and(|b| !dir.join("3d-base").join(b).join("model.glb").is_file());
        return if !base_gone && (paths.is_empty() || read(export.join("stamp.json")) == stamp_of(&paths)) { "ready" } else { "stale" };
    }
    let none = dir.join(format!("{key}.3d-none.json"));
    if none.is_file() && (paths.is_empty() || read(none) == stamp_of(&paths)) {
        return "none";
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
    if crate::xtra_kit::installed_version().is_some_and(|v| v < 19) {
        return Err("Rotate in 3D and the texture check need preview kit 19 or newer. Update it in Setup.".into());
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
    use std::sync::atomic::Ordering;
    // someone else (a click) is waiting: the texture check steps aside instead of taking its next batch first
    if who == "texcheck" && WAITERS.load(Ordering::SeqCst) > 0 {
        return Err("texcheck");
    }
    WAITERS.fetch_add(usize::from(who != "texcheck"), Ordering::SeqCst);
    struct Done(bool);
    impl Drop for Done {
        fn drop(&mut self) {
            if self.0 {
                WAITERS.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }
    let _done = Done(who != "texcheck");
    let until = std::time::Instant::now() + std::time::Duration::from_secs(90);
    let stop = previews_dir().join("cancel");
    let mut stopped = false;
    loop {
        match reserve(who) {
            Err("texcheck") if who != "texcheck" && std::time::Instant::now() < until => {
                if !stopped {
                    stopped = std::fs::write(&stop, b"").is_ok();
                }
                std::thread::sleep(std::time::Duration::from_millis(200))
            }
            other => {
                if stopped {
                    let _ = std::fs::remove_file(&stop); // only the Stop this click wrote, before its own run starts
                }
                return other;
            }
        }
    }
}

/// Clicks (Rotate in 3D, Generate preview) waiting for the reservation right now (reserve_waiting).
static WAITERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn paks_of(state: &State<'_, Arc<Mutex<crate::AppState>>>) -> Option<PathBuf> {
    state.lock().unwrap().game_path.parent().map(Path::to_path_buf)
}

/// Makes the 3D export for one mod (or a loadout's mods with `set`): "ready", "none" (nothing to show in 3D),
/// "overridden" (the game's own mesh wins) or "failed" (the error is in Logs). The kit's steps come as
/// `mod-viewer-stage` events (custom/previewStages.ts words) while it works. Err: busy or no kit, said plainly.
#[tauri::command]
pub async fn generate_mod_viewer(app: AppHandle, paths: Vec<String>, set: Option<String>, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<String, String> {
    let jobs = jobs_of(&paths);
    let paks = paks_of(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = "failed";
        let key = set.clone().or_else(|| jobs.first().map(|(_, k)| k.clone())).unwrap_or_default();
        run_kit("viewer", "--viewer", &jobs, set.as_deref(), paks, |l| {
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
        let none = previews_dir().join(format!("{key}.3d-none.json"));
        if result == "ready" {
            let _ = std::fs::write(previews_dir().join(format!("{key}.3d")).join("stamp.json"), stamp_of(&paths).to_string());
            let _ = std::fs::remove_file(none);
        } else if result == "none" {
            let _ = std::fs::write(none, stamp_of(&paths).to_string());
        }
        Ok(result.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Checks these mods' textures with the kit (`--texcheck`, cached by the mod's files in texcheck.json, so an
/// unchanged mod costs nothing). Returns how many have textures the game cannot read. The Library calls it a few mods
/// at a time, so the reservation is free again within seconds when Generate preview is clicked meanwhile.
#[tauri::command]
pub async fn run_texcheck(paths: Vec<String>, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<usize, String> {
    let paks = paks_of(&state);
    tauri::async_runtime::spawn_blocking(move || {
        // mods the kit already answered (or could not check) for these files and this game build: no kit start for
        // them, so most Library scans start none, and a game update asks again
        let game = paks.as_deref().map(|p| crate::xtra_broken::build_key(&crate::xtra_broken::game_containers(p))).unwrap_or_default();
        let seen_path = previews_dir().join("texcheck-seen.json");
        let mut seen: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(&seen_path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let sig = |p: &Path| -> Option<String> {
            let m = std::fs::metadata(utoc_of(p)).ok()?;
            let ns = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
            Some(format!("{}:{ns}:{game}", m.len()))
        };
        let todo: Vec<String> = paths.into_iter().filter(|p| sig(Path::new(p)).is_some_and(|s| seen.get(&kit_key(&utoc_of(Path::new(p)))).and_then(|v| v.as_str()) != Some(s.as_str()))).collect();
        if todo.is_empty() {
            return Ok(0);
        }
        let jobs = jobs_of(&todo);
        let mut found = 0;
        let mut answered: Vec<String> = Vec::new();
        let ok = run_kit("texcheck", "--texcheck", &jobs, None, paks, |l| {
            // TEXCHECK <key> {json} or TEXCHECK_FAIL <key>: either way the kit has had its say on this mod
            if let Some(key) = l.strip_prefix("TEXCHECK_FAIL ").or_else(|| l.strip_prefix("TEXCHECK ").and_then(|r| r.split(' ').next())) {
                answered.push(key.trim().to_string());
            }
            let bad = l.strip_prefix("TEXCHECK ").and_then(|rest| rest.split_once(' '))
                .and_then(|(_, json)| serde_json::from_str::<serde_json::Value>(json).ok())
                .is_some_and(|v| v["unreadable"].as_array().is_some_and(|a| !a.is_empty()));
            found += usize::from(bad);
        })?;
        for p in &todo {
            let key = kit_key(&utoc_of(Path::new(p)));
            if let (true, Some(s)) = (answered.contains(&key), sig(Path::new(p))) {
                seen.insert(key, serde_json::Value::String(s));
            }
        }
        let _ = std::fs::write(&seen_path, serde_json::Value::Object(seen).to_string());
        if !ok {
            return Err("The texture check did not finish (a preview kit older than 19 has none). The details are in Logs.".to_string());
        }
        Ok(found)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// [folder, kit key] per mod file, what the kit's --mods and --key take.
fn jobs_of(paths: &[String]) -> Vec<(String, String)> {
    paths.iter().map(|p| {
        let path = Path::new(p);
        (path.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default(), kit_key(path))
    }).collect()
}

/// A mod's .utoc, as the kit pairs them (mod_previews.py installed): X.pak, X.bak_repak, X.pak_disabled and an older
/// Repak's X.pak.bak_repak all belong with X.utoc.
fn utoc_of(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let lower = name.to_lowercase();
    let stem = [".pak.bak_repak", ".pak_disabled", ".bak_repak", ".pak", ".utoc", ".ucas"].iter()
        .find(|x| lower.ends_with(*x)).map(|x| &name[..name.len() - x.len()]).unwrap_or(&name);
    path.with_file_name(format!("{stem}.utoc"))
}

fn texcheck_store() -> serde_json::Value {
    std::fs::read_to_string(previews_dir().join("texcheck.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// The kit's texture check entry for a mod, when its .utoc size and time still match (the kit's signature fields 2 and
/// 3), so an edited mod is never judged by its older files.
fn texcheck_entry<'a>(store: &'a serde_json::Value, path: &Path) -> Option<&'a serde_json::Value> {
    let entry = store.get(kit_key(&utoc_of(path)))?;
    let meta = std::fs::metadata(utoc_of(path)).ok()?;
    let ns = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    let sig: Vec<&str> = entry["sig"].as_str()?.split(':').collect();
    (sig.get(1) == Some(&meta.len().to_string().as_str()) && sig.get(2) == Some(&ns.to_string().as_str())).then_some(entry)
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
    let store = texcheck_store();
    mod_paths.iter().filter_map(|p| {
        let entry = texcheck_entry(&store, Path::new(p))?;
        let bad = entry["result"]["unreadable"].as_array().filter(|a| !a.is_empty())?;
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
        assert_eq!(base_of(&serde_json::json!({"base": "936e846268379a8f"})), Some("936e846268379a8f"));
        for bad in ["..", "936e846268379a8", "936e846268379a8f0", "936e846268379a8g", "../../../../../x"] {
            assert_eq!(base_of(&serde_json::json!({ "base": bad })), None, "{bad}");
        }
        assert_eq!(base_of(&serde_json::json!({})), None);
    }

    #[test]
    fn kit_keys_match_the_kit() {
        assert_eq!(kit_key(Path::new(r"C:\m\bp-lime-vfx_vfx_noPG_v2_9999999_P.pak")), "bp-lime-vfx_vfx_noPG_v2");
        assert_eq!(kit_key(Path::new(r"C:\m\Foo_disabled.pak")), "Foo");
        assert_eq!(kit_key(Path::new(r"C:\m\B_P.pak")), "B_P");
        assert_eq!(kit_key(Path::new(r"C:\m\A_1_P_2_P.bak_repak")), "A");
        assert_eq!(utoc_of(Path::new(r"C:\m\X_P.pak.bak_repak")), Path::new(r"C:\m\X_P.utoc"));
        assert_eq!(utoc_of(Path::new(r"C:\m\X_9_P.bak_repak")), Path::new(r"C:\m\X_9_P.utoc"));
        assert_eq!(utoc_of(Path::new(r"C:\m\X.pak")), Path::new(r"C:\m\X.utoc"));
    }
}
