//! repakxtra: generated mod previews. The generator (`mod_previews.py`, with Cue4Export and Blender) comes from the
//! preview kit (xtra_kit.rs), on every PC, and writes one image per mod to
//! %APPDATA%\Repak-X\previews\<mod key>.png (an animated <mod key>.webp for animation mods). This module serves those
//! files and runs the generator for the mods you pick (details panel button, the selection bar's Previews button, a
//! loadout's Generate previews).

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

/// Who works in the preview kit's folders right now: a preview run, a kit install or removal, or the PC check. One at a
/// time, so an install never replaces files a render or the check is using, and two installs never share a side folder.
static OWNER: Mutex<Option<&'static str>> = Mutex::new(None);

/// The reservation: whoever holds it owns the kit's folders until it is dropped (on every path, panics included).
pub struct Hold(());
impl Drop for Hold {
    fn drop(&mut self) {
        *OWNER.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// Reserves the kit's folders for `who` ("previews", "kit" or "doctor"); Err names who has them.
pub fn reserve(who: &'static str) -> Result<Hold, &'static str> {
    let mut owner = OWNER.lock().unwrap_or_else(|e| e.into_inner());
    match *owner {
        Some(other) => Err(other),
        None => {
            *owner = Some(who);
            Ok(Hold(()))
        }
    }
}

/// Why the kit's folders are busy, for whoever asked.
pub fn busy_text(who: &str) -> String {
    match who {
        "previews" => "Previews are generating. Stop them or wait, then try again.",
        "kit" => "The preview kit is installing or being removed. Wait for it to finish.",
        "cleanup" => "Settings > Storage is deleting previews or the preview kit. Try again when it is done.", // repakxtra
        "texcheck" => "The preview kit is checking textures. Try again in a moment.", // repakxtra
        "viewer" => "The 3D model is being prepared. Try again in a moment.", // repakxtra
        _ => "This PC is being checked for previews. Try again in a moment.",
    }
    .into()
}

pub(crate) fn previews_dir() -> PathBuf {
    crate::app_dir().join("previews")
}

/// (kit folder to run in, python, script): the installed preview kit. Without one a PC makes no previews; the
/// developer's PC too, so Setup always says where its kit came from (a file or GitHub).
fn generator() -> Option<(PathBuf, PathBuf, PathBuf)> {
    let kit = crate::xtra_kit::installed_kit()?;
    Some((kit.clone(), kit.join(r"python\python.exe"), kit.join(r"previews\mod_previews.py")))
}


/// Whether previews can be generated here; without it the app hides its Generate buttons and keeps showing previews it has.
#[tauri::command(async)]
pub fn previews_available() -> bool {
    generator().is_some()
}

/// A mod key is a bare file stem from the frontend: never let it leave the previews folder.
pub(crate) fn valid_key(key: &str) -> bool {
    !key.is_empty() && !key.contains(['/', '\\', ':']) && !key.contains("..")
}

/// A preview is a PNG, an animated WebP for animation mods (a clip on a gray model), or a WebM for KO prompt mods
/// (xtra_ko.rs: the app records those, so they play on one clock).
const PREVIEW_EXTS: [&str; 3] = [".png", ".webp", ".webm"];

#[tauri::command(async)]
pub fn list_mod_previews() -> Vec<String> {
    let mut keys: Vec<String> = std::fs::read_dir(previews_dir())
        .map(|it| {
            it.filter_map(|e| {
                let name = e.ok()?.file_name().to_str()?.to_string();
                PREVIEW_EXTS.iter().find_map(|x| name.strip_suffix(x).map(str::to_string))
            })
            .collect()
        })
        .unwrap_or_default();
    keys.sort();
    keys.dedup();
    keys
}

/// The preview file of a key: the newer of its PNG and WebP (the generator removes the other one, but a run that was
/// stopped mid-way may leave both).
fn preview_file(dir: &std::path::Path, key: &str) -> Option<PathBuf> {
    PREVIEW_EXTS
        .iter()
        .map(|x| dir.join(format!("{key}{x}")))
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .max_by_key(|(t, _)| *t)
        .map(|(_, p)| p)
}

/// Deletes the combined renders of loadouts that are gone for good (each key's image, before picture, animation, other
/// forms and member list). Only loadout keys: a mod's preview is never removed here. Returns how many files went.
#[tauri::command(async)]
pub fn delete_loadout_previews(keys: Vec<String>) -> usize {
    let dir = previews_dir();
    let keys: Vec<&String> = keys.iter().filter(|k| valid_key(k) && k.starts_with("loadout-") && !k.contains(['.', '@'])).collect();
    let Ok(entries) = std::fs::read_dir(&dir) else { return 0 };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter(|e| e.file_name().to_str().is_some_and(|n| keys.iter().any(|k| n.starts_with(&format!("{k}.")) || n.starts_with(&format!("{k}@")))))
        .filter(|e| std::fs::remove_file(e.path()).is_ok())
        .count()
}

/// Every preview's file name and change time (ms) by key, and the folder they are in, read in one call: the window loads
/// the pictures as files (Tauri's asset protocol, scoped to this folder in tauri.conf.json), not as bytes through the
/// command bridge. The time goes into the picture's address, so a re-rendered preview is never served from cache.
#[tauri::command(async)]
pub fn list_preview_files() -> serde_json::Value {
    let dir = previews_dir();
    let files: serde_json::Map<String, serde_json::Value> = list_mod_previews()
        .into_iter()
        .filter_map(|key| {
            let file = preview_file(&dir, &key)?;
            let ms = std::fs::metadata(&file).ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
            let name = file.file_name()?.to_string_lossy().to_string();
            Some((key, serde_json::json!([name, ms])))
        })
        .collect();
    // each loadout render's covers and members (get_preview_covers), so the cards need no call each
    let covers: serde_json::Map<String, serde_json::Value> = files.keys()
        .filter(|k| k.starts_with("loadout-") && !k.contains(['.', '@']))
        .map(|k| (k.clone(), get_preview_covers(k.clone())))
        .collect();
    serde_json::json!({ "dir": dir.to_string_lossy(), "files": files, "covers": covers })
}

/// A loadout's combined render (`set`), from the generator's <set>.json: `covers`, the mods it shows (empty when there
/// is none), and `members`, the installed mods it was rendered for (null for renders older than that record).
#[tauri::command(async)]
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

/// Which previews belong to emotes, from the generator's index.json: `anim` {mod key: [emote]} for animation previews
/// and `audio` {mod key: [emote]} for sound mods whose emote sounds it saved (custom/emoteSound.ts pairs them on hover).
/// An emote is "<hero>-<item index>", like "1026-205".
#[tauri::command(async)]
pub fn get_preview_emotes() -> serde_json::Value {
    let index: serde_json::Value = std::fs::read_to_string(previews_dir().join("index.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let pick = |field: &str| -> serde_json::Map<String, serde_json::Value> {
        index.as_object().into_iter().flatten()
            .filter_map(|(k, v)| v.get(field).filter(|e| e.as_array().is_some_and(|a| !a.is_empty())).map(|e| (k.clone(), e.clone())))
            .collect()
    };
    // A mod with several emotes: each other emote's preview (<key>@2 and on) with its own emotes
    let mut anim = pick("emotes");
    for forms in index.as_object().into_iter().flatten().filter_map(|(_, v)| v.get("form_emotes")?.as_object()) {
        anim.extend(forms.iter().filter(|(_, e)| e.as_array().is_some_and(|a| !a.is_empty())).map(|(k, e)| (k.clone(), e.clone())));
    }
    serde_json::json!({ "anim": anim, "audio": pick("emote_sounds") })
}

/// "1026-205": four digits, a dash, three digits (an emote id never leaves the mod's audio folder).
fn valid_emote(emote: &str) -> bool {
    let b = emote.as_bytes();
    b.len() == 8 && b[4] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit())
}

/// A sound mod's emote sound (WAV), saved by the generator as <key>.audio/<emote>.wav.
#[tauri::command(async)]
pub fn get_preview_audio(key: String, emote: String) -> Result<tauri::ipc::Response, String> {
    if !valid_key(&key) || !valid_emote(&emote) {
        return Err(format!("Invalid emote sound: {key} {emote}"));
    }
    std::fs::read(previews_dir().join(format!("{key}.audio")).join(format!("{emote}.wav")))
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

/// One line of the generator's output as (event, key): "PREVIEW <key>" after writing a PNG, "PREVIEW_NONE <key>" when
/// there is nothing to show, "PREVIEW_IN <key>" for a mod the loadout's combined render shows, "PREVIEW_FAIL <key>" when
/// it failed (its last good preview stays), "PREVIEW_WARN <key>" when a mod could not be read (encrypted with a key
/// other than the game's, so a render would not show it), "PREVIEW_STAGE <step>" for what it is doing now (kit v8: read,
/// mount, unpack, export, materials, pose, render, finish, ui, vfx, anim, sound; kit v9 adds skins, table, blender,
/// shading, glow, clips, rig and webp, with Blender's own steps passed on as it renders; custom/previewStages.ts has the
/// words), and "PREVIEW_BUSY" (no key) when another generator holds the lock.
fn parse_line(line: &str) -> Option<(&'static str, Option<String>)> {
    if line.trim() == "PREVIEW_BUSY" {
        return Some(("mod-previews-busy", None));
    }
    [
        ("PREVIEW_NONE ", "mod-preview-none"),
        ("PREVIEW_IN ", "mod-preview-in"),
        ("PREVIEW_FAIL ", "mod-preview-failed"),
        ("PREVIEW_WARN ", "mod-preview-warn"),
        ("PREVIEW_STAGE ", "mod-preview-stage"),
        ("PREVIEW ", "mod-preview-ready"),
    ]
    .into_iter()
    .find_map(|(prefix, event)| line.strip_prefix(prefix).map(|k| (event, Some(k.trim().to_string()))))
}

/// Renders previews for the given mods (`jobs` = [folder, mod key] pairs) one after another in the background,
/// replacing existing ones. With `set` (a loadout), its character mods render once together as <set>.png.
/// Progress: `mod-preview-ready` / `mod-preview-none` / `mod-preview-in` (shown in the set's render) /
/// `mod-preview-failed` per mod or set, `mod-preview-stage` (what it is doing now), `mod-previews-busy` when another generator (a manual run, or one an earlier
/// app session left going) holds its lock, `mod-previews-done` (ok) at the end. Ok(false) = this app runs one already.
/// Unchanged mods and sets report their existing result without rendering; `force` (Regenerate) renders them anyway.
/// The generator alone owns its lock and the cancel file (it clears a stale Stop once it holds the lock).
#[tauri::command(async)]
pub fn generate_mod_previews(app: AppHandle, jobs: Vec<(String, String)>, set: Option<String>, force: Option<bool>, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<bool, String> {
    if let Some(bad) = jobs.iter().map(|(_, k)| k).chain(set.iter()).find(|k| !valid_key(k)) {
        return Err(format!("Invalid preview key: {bad}"));
    }
    let hold = match crate::xtra_viewer::reserve_waiting("previews") { // repakxtra: waits out a background texture check
        Ok(h) => h,
        Err("previews") => return Ok(false),
        Err(other) => return Err(busy_text(other)),
    };
    let paks = state.lock().unwrap().game_path.parent().map(|p| p.to_path_buf());
    let mut cmd = generator_command(paks, true)?;
    STOPPED.store(false, std::sync::atomic::Ordering::SeqCst); // a Stop from before this run does not count
    // One generator run over every folder the mods sit in (a loadout's combined render needs all of them at once)
    cmd.arg("--out").arg(previews_dir());
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
    // The generator's own notes and errors go to the app's Logs (scope Previews) and to previews\generator.log; UTF-8
    // keeps a mod name like "Pokémon" from breaking the result lines
    let mut log = std::fs::create_dir_all(previews_dir()).and_then(|_| std::fs::File::create(previews_dir().join("generator.log"))).ok();
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    std::thread::spawn(move || {
        let hold = hold; // the run owns the kit until its generator exits
        let mut ok = false;
        // The game's newest mappings, fetched like the VFX updater's (at most hourly): the kit's own go stale with each game
        // update and then misread changed tables, so a skin table mod showed nothing (preview_fixes/app_usmap.py)
        let _ = tauri::async_runtime::block_on(crate::vfx_updater::commands::vfx_check_usmap_update(false));
        if let Some(usmap) = app_usmap() {
            cmd.env("REPAKXTRA_USMAP", usmap);
        }
        clear_stale_work(&previews_dir().join("work"));
        // A Stop while the check above waited: there is no process to kill yet, so it must not start
        let started = if STOPPED.load(std::sync::atomic::Ordering::SeqCst) { Err(None) } else { cmd.spawn().map_err(Some) };
        match started {
            Err(None) => {}
            Err(Some(e)) => {
                // Python blocked or missing: the failure toast points at Logs, so the reason must be there
                let text = format!("The preview generator did not start: {e}");
                if let Some(f) = log.as_mut() {
                    use std::io::Write;
                    let _ = writeln!(f, "{text}");
                }
                crate::ui_log::error("Previews", text);
            }
            Ok(mut child) => {
                *RUNNING.lock().unwrap() = Some(child.id());
                // Drained on its own thread (both pipes are read at once); joined below so every line is in the Logs and
                // generator.log is closed before "done" lets the next run truncate it
                let logger = child.stderr.take().map(|err| std::thread::spawn(move || log_generator(err, log)));
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
                if let Some(l) = logger {
                    let _ = l.join();
                }
                *RUNNING.lock().unwrap() = None;
            }
        }
        drop(hold); // free before "done": the app starts the next queued run on it
        let _ = app.emit("mod-previews-done", ok);
    });
    Ok(true)
}

/// The per-mod work folders (scratch\work\<key>) a generator that was stopped or crashed left, about 50 MB a mod and
/// 1.1 GB here on 2026-11-06. Only while no generator holds scratch\generator.lock (it locks its first byte, msvcrt),
/// so a manual run's folders stay. scratch\cache (repacked mods, game renders) stays: it makes the next run fast.
/// At start too: a run that stopped early leaves its folders until the next Generate otherwise.
pub(crate) fn sweep_stale_work() {
    clear_stale_work(&previews_dir().join("work"));
}

/// The generator's own lock (scratch\generator.lock, it locks its first byte, msvcrt), taken by us: Ok(None) when it was
/// never made, Err when a generator holds it (this app's, another copy's, or a manual run) or it cannot be opened.
/// Dropping the file releases it.
fn lock_generator_in(scratch: &Path) -> Result<Option<std::fs::File>, ()> {
    match std::fs::OpenOptions::new().read(true).write(true).open(scratch.join("generator.lock")) {
        Ok(f) => f.try_lock().map(|_| Some(f)).map_err(|_| ()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None), // never made: nothing ran here
        Err(_) => Err(()),
    }
}

/// Settings > Storage: held while it deletes previews or their work files, so no generator anywhere runs on them.
pub(crate) fn lock_generator() -> Result<Option<std::fs::File>, String> {
    lock_generator_in(&previews_dir().join("work")).map_err(|_| "Previews are being made (here, in another copy of the app, or by hand). Try again when that is done.".into())
}

/// Blender and the exporter a preview run leaves open for the next one (preview_fixes/keeper.py, about 3 GB of memory
/// and the kit's and the game's files held open) end when their state file goes: when the app closes, the game starts,
/// and before the kit is replaced or removed. `wait`: until they are gone (each keeps an .alive file while it runs), 8 s
/// at most, for a caller that needs the kit's files free.
pub(crate) fn stop_kept(wait: bool) {
    let dir = previews_dir().join("work").join("keep");
    let with = |ext: &str| -> Vec<PathBuf> {
        std::fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == ext)).collect()
    };
    for f in with("json") {
        let _ = std::fs::remove_file(f);
    }
    if wait {
        let end = std::time::Instant::now() + std::time::Duration::from_secs(8);
        while !with("alive").is_empty() && std::time::Instant::now() < end {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        for f in with("alive") { // a keeper that was killed left its file: never waited on twice
            let _ = std::fs::remove_file(f);
        }
    }
}

fn clear_stale_work(scratch: &Path) {
    // held until the folders are gone, so no generator starts on them meanwhile (ours starts after this returns)
    let Ok(_held) = lock_generator_in(scratch) else { return };
    for e in std::fs::read_dir(scratch.join("work")).into_iter().flatten().flatten() {
        let _ = if e.path().is_dir() { std::fs::remove_dir_all(e.path()) } else { std::fs::remove_file(e.path()) };
    }
}

/// Copies the generator's stderr to generator.log and the app's Logs: lines that report a failure (an error, a Python
/// traceback) as errors, the rest (what it rendered, optional assets not in the game) as notes.
pub(crate) fn log_generator(err: std::process::ChildStderr, mut file: Option<std::fs::File>) {
    use std::io::Write;
    let mut traceback = false;
    for line in BufReader::new(err).lines().map_while(Result::ok) {
        let line = hide_key(&line);
        if let Some(f) = file.as_mut() {
            let _ = writeln!(f, "{line}");
        }
        // A tool's output tails come wrapped as "# stdout: ..." / "# stderr: ..." (mod_previews.py run)
        let text = line.trim_start_matches('#').trim();
        let text = text.strip_prefix("stderr:").or_else(|| text.strip_prefix("stdout:")).unwrap_or(text).trim();
        if text.is_empty() {
            continue;
        }
        // A Python traceback: its header and indented frames go to the log's details (debug), and the one unindented line
        // naming the exception, which ends it, is the error. A failed run showed 27 red lines for one error
        let starts = text.starts_with("Traceback");
        let in_traceback = traceback || starts;
        traceback = in_traceback && (starts || line.starts_with(char::is_whitespace));
        if traceback {
            crate::ui_log::debug("Previews", text);
        } else if in_traceback || generator_error(text) {
            crate::ui_log::error("Previews", text);
        } else {
            crate::ui_log::info("Previews", text);
        }
    }
}

/// `text` with the game's key replaced: a tool's command line the kit logged can carry it, and the Logs and
/// generator.log go into bug reports.
fn hide_key(text: &str) -> String {
    let key = crate::install_mod::AES_KEY_HEX.trim_start_matches("0x").to_ascii_lowercase();
    let mut out = text.to_string();
    while let Some(i) = out.to_ascii_lowercase().find(&key) {
        out.replace_range(i..i + key.len(), "<key>");
    }
    out
}

/// A generator line that reports a failure ("<key>: error: ...", "spec: export failed: ..."), not a note: a count like
/// "0 failed" stays a note.
fn generator_error(text: &str) -> bool {
    let t = text.to_lowercase();
    let exit = t.find(" exit ").map(|i| &t[i + 6..]).is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit() && c != '0'));
    t.contains(": error") || t.contains("export failed") || t.starts_with("error") || t.contains("exception") || exit
}

/// Settings > General > Previews: whether new previews get the rim light (preview-rim.json, off until switched on). The
/// generator reads it as REPAKXTRA_RIM. It is not part of the preview fingerprint: existing previews are never rendered
/// again for it, the person regenerates the ones they want to see change.
fn rim_setting() -> PathBuf {
    crate::app_dir().join("preview-rim.json")
}

fn rim_on() -> bool {
    std::fs::read_to_string(rim_setting()).ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["on"].as_bool())
        .unwrap_or(false)
}

#[tauri::command]
pub fn preview_rim_get() -> bool {
    rim_on()
}

#[tauri::command]
pub fn preview_rim_set(on: bool) -> Result<(), String> {
    std::fs::write(rim_setting(), serde_json::json!({ "on": on }).to_string()).map_err(|e| format!("Could not save the setting: {e}"))
}

/// Set by Stop; a run that has not started its generator yet checks it before starting.
static STOPPED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The newest USMAP the app has downloaded that is not newer than the installed game (the newest of all while the game's
/// build is unknown). None leaves the kit's own, also when the game is older than every download (newer mappings would
/// misread its structs).
pub(crate) fn app_usmap() -> Option<PathBuf> {
    use crate::vfx_updater::commands::{extract_usmap_build_number, managed_usmap_dir};
    let game = crate::xtra_vfx::LAST_GAME_CL.load(std::sync::atomic::Ordering::Relaxed);
    let all: Vec<(u64, PathBuf)> = std::fs::read_dir(managed_usmap_dir()).ok()?
        .filter_map(|e| {
            let p = e.ok()?.path();
            let name = p.file_name()?.to_str()?;
            if !name.ends_with(".usmap") {
                return None;
            }
            Some((extract_usmap_build_number(name)?, p.clone()))
        })
        .collect();
    let fits = |b: u64| game == 0 || b <= game;
    all.iter().filter(|(b, _)| fits(*b)).max_by_key(|(b, _)| *b).map(|(_, p)| p.clone())
}

/// The generator's command so far (the kit's python and script, run in its folder, with the kit's variables). The error
/// says what to install.
pub(crate) fn generator_command(paks: Option<PathBuf>, need_blender: bool) -> Result<Command, String> {
    let Some((root, python, _script)) = generator() else {
        return Err("Previews need the preview kit: install it in Setup.".into());
    };
    // The app's preview fixes need a kit at least this new: one clear sentence here (renders, the doctor, Rotate in 3D,
    // and the texture check all start the kit through this), not a fix that cannot find its line
    if let Some(v) = crate::xtra_kit::installed_version().filter(|v| *v < crate::xtra_kit::MIN_KIT) {
        return Err(format!("This version needs preview kit {} or newer. Yours is {v}.", crate::xtra_kit::MIN_KIT));
    }
    if need_blender && crate::xtra_kit::blender().is_none() {
        return Err("Previews need Blender: install it in Setup (or from blender.org), or pick blender.exe there.".into());
    }
    let runtime = previews_dir().join("runtime");
    std::fs::create_dir_all(&runtime).map_err(|e| format!("Could not prepare preview fixes: {e}"))?;
    for (name, contents) in [
        ("runtime.py", include_str!("preview_fixes/runtime.py")),
        ("galactic_mane.py", include_str!("preview_fixes/galactic_mane.py")),
        ("material_rim.py", include_str!("preview_fixes/material_rim.py")),
        ("translucent_layers.py", include_str!("preview_fixes/translucent_layers.py")),
        ("screen_rim.py", include_str!("preview_fixes/screen_rim.py")),
        ("studio_lights.py", include_str!("preview_fixes/studio_lights.py")),
        ("cosmic_tuning.py", include_str!("preview_fixes/cosmic_tuning.py")),
        ("flow_anim.py", include_str!("preview_fixes/flow_anim.py")),
        ("flow_compose.py", include_str!("preview_fixes/flow_compose.py")),
        ("sound_pak.py", include_str!("preview_fixes/sound_pak.py")),
        ("emote_split.py", include_str!("preview_fixes/emote_split.py")),
        ("skin_blueprint.py", include_str!("preview_fixes/skin_blueprint.py")),
        ("borrowed_pose.py", include_str!("preview_fixes/borrowed_pose.py")),
        ("app_usmap.py", include_str!("preview_fixes/app_usmap.py")),
        ("speed.py", include_str!("preview_fixes/speed.py")),
        ("keeper.py", include_str!("preview_fixes/keeper.py")),
        ("viewer_lobby.py", include_str!("preview_fixes/viewer_lobby.py")),
    ] {
        let path = runtime.join(name);
        if std::fs::read_to_string(&path).ok().as_deref() != Some(contents) {
            std::fs::write(path, contents).map_err(|e| format!("Could not write preview fixes: {e}"))?;
        }
    }
    let mut cmd = Command::new(&python);
    cmd.arg(runtime.join("runtime.py")).current_dir(&root).env("PYTHONUTF8", "1");
    // The kit's contract (tools\previews\build_kit.py): where the kit is, the game's Paks folder, a writable work folder
    // for exports, caches and the lock, and Blender
    cmd.env("REPAKXTRA_KIT", &root).env("REPAKXTRA_WORK", previews_dir().join("work"));
    if let Some(tool) = crate::xtra_uat_cli::cli() {
        cmd.env("REPAKXTRA_UAT", tool);
    }
    if let Some(p) = &paks {
        cmd.env("REPAKXTRA_PAKS", p);
    }
    if let Some(b) = crate::xtra_kit::blender() {
        cmd.env("REPAKXTRA_BLENDER", b);
    }
    // The game's key comes from the app (the same one it installs mods with), so the kit carries none
    cmd.env("REPAKXTRA_RIM", if rim_on() { "1" } else { "0" });
    cmd.env("REPAKXTRA_AES", format!("0x{}", crate::install_mod::AES_KEY_HEX.trim_start_matches("0x")));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    Ok(cmd)
}

/// The generator's own check of this PC (`--doctor`): `{ ok, problems: [sentences], blender, ... }`. Setup runs it after
/// the kit or Blender is installed, so a missing piece is named before the first render fails on it.
#[tauri::command]
pub async fn previews_doctor(state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<serde_json::Value, String> {
    let hold = reserve("doctor").map_err(busy_text)?;
    let paks = state.lock().unwrap().game_path.parent().map(|p| p.to_path_buf());
    let mut cmd = generator_command(paks, false)?; // without Blender the check itself says it is missing
    cmd.arg("--doctor");
    // The hold lives in the worker: it outlasts this future if the app stops waiting. A run with no DOCTOR line is tried
    // once more: right after a fresh kit or Blender install the first run can exit early (a fresh PC showed exit 1 while
    // the kit was fine), and its stderr goes to the Logs so a lasting failure is still explained there
    tauri::async_runtime::spawn_blocking(move || {
        let _hold = hold;
        let mut last = String::new();
        for _ in 0..2 {
            let out = cmd.output().map_err(|e| format!("The preview generator did not start: {e}"))?;
            if let Some(v) = doctor_line(&String::from_utf8_lossy(&out.stdout)) {
                return Ok(v);
            }
            last = format!("The preview check gave no answer (exit {}).", out.status.code().unwrap_or(-1));
            let err = hide_key(&String::from_utf8_lossy(&out.stderr));
            let tail: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).rev().take(3).collect(); // a traceback's last lines name the error
            crate::ui_log::error("Previews", format!("{last} {}", tail.into_iter().rev().collect::<Vec<_>>().join(" | ")));
        }
        Err(last)
    }).await.map_err(|e| e.to_string())?
}

/// The generator's `DOCTOR {json}` line.
fn doctor_line(stdout: &str) -> Option<serde_json::Value> {
    stdout.lines().find_map(|l| serde_json::from_str(l.trim().strip_prefix("DOCTOR ")?).ok())
}

/// The running generator's process id, so Stop can end it (and the Blender it started) at once.
static RUNNING: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(None);

/// Stops a run now: ends the generator's whole process tree. Safe mid-render: the generator writes every preview to a
/// temp file and renames it, and Windows frees its lock when it dies. The cancel file stays as a fallback (the generator
/// checks it between mods) in case the kill fails.
#[tauri::command]
pub fn cancel_mod_previews() -> Result<(), String> {
    STOPPED.store(true, std::sync::atomic::Ordering::SeqCst);
    std::fs::create_dir_all(previews_dir()).map_err(|e| e.to_string())?;
    std::fs::write(previews_dir().join("cancel"), b"").map_err(|e| e.to_string())?;
    if let Some(pid) = *RUNNING.lock().unwrap() {
        let mut kill = Command::new("taskkill");
        kill.args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            kill.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let _ = kill.status();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn generator_errors_are_told_from_notes() {
        assert!(super::generator_error("A_Magik_II_DiscoDazzlerHair: error: the character render failed (1.5 s)"));
        assert!(super::generator_error("loadout-3a8c: error: Blender not found"));
        assert!(!super::generator_error("spec: not in the game (optional): ['/Game/Marvel/x']"));
        assert!(!super::generator_error("loadout-3a8c: 3 mods on SK_1026_1026001 (12.4 s)"));
        assert!(super::generator_error("spec: export failed: package not found"));
        assert!(!super::generator_error("done: 4 made, 0 failed"));
        assert!(super::generator_error("blender.exe exit 1") && !super::generator_error("blender.exe exit 0"));
    }

    #[test]
    fn logged_command_lines_lose_the_key() {
        let key = crate::install_mod::AES_KEY_HEX;
        let line = format!("# uassettool.exe exit 1: ['x.exe', 'list_pak', 'a.pak', '--aes', '0x{}'] and {key}", key.to_ascii_lowercase());
        let hidden = super::hide_key(&line);
        assert!(!hidden.to_ascii_lowercase().contains(&key.to_ascii_lowercase()), "{hidden}");
        assert_eq!(hidden, "# uassettool.exe exit 1: ['x.exe', 'list_pak', 'a.pak', '--aes', '0x<key>'] and <key>");
    }

    use super::*;

    #[test]
    fn stale_work_goes_only_while_no_generator_holds_the_lock() {
        let d = tempfile::tempdir().unwrap();
        let (work, cache) = (d.path().join("work").join("mod-a"), d.path().join("cache").join("repacked"));
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(&cache).unwrap();
        let held = std::fs::File::create(d.path().join("generator.lock")).unwrap();
        held.lock().unwrap();
        clear_stale_work(d.path());
        assert!(work.exists(), "a running generator's folder stays");
        drop(held);
        clear_stale_work(d.path());
        assert!(!work.exists() && cache.exists(), "a stale one goes, the cache stays");
    }

    #[test]
    fn keys_stay_inside_the_folder() {
        assert!(valid_key("bp-8bit_bp+matSwap_outline_noPG_v3"));
        assert!(!valid_key("..\\state"));
        assert!(!valid_key("C:evil"));
        assert!(!valid_key("a/b"));
        assert!(!valid_key(""));
    }

    #[test]
    fn the_newer_of_png_and_webp_is_the_preview() {
        let dir = std::env::temp_dir().join(format!("previews-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(preview_file(&dir, "A").is_none());
        std::fs::write(dir.join("A.png"), b"png").unwrap();
        assert_eq!(preview_file(&dir, "A").unwrap().extension().unwrap(), "png");
        let webp = dir.join("A.webp");
        std::fs::write(&webp, b"webp").unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        std::fs::File::options().write(true).open(&webp).unwrap().set_modified(later).unwrap();
        assert_eq!(preview_file(&dir, "A").unwrap().extension().unwrap(), "webp");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_kit_has_one_owner_at_a_time() {
        let hold = reserve("kit").unwrap();
        assert_eq!(reserve("previews").err(), Some("kit"));
        assert_eq!(reserve("doctor").err(), Some("kit"));
        drop(hold);
        let hold = reserve("previews").unwrap();
        assert_eq!(reserve("previews").err(), Some("previews"));
        drop(hold);
        // A panic while holding it still frees it
        let r = std::panic::catch_unwind(|| { let _h = reserve("doctor").unwrap(); panic!("boom") });
        assert!(r.is_err());
        drop(reserve("kit").expect("free again after the panic"));
        // A worker that fails to start (the hold moves into it and drops with it)
        let hold = reserve("previews").unwrap();
        std::thread::spawn(move || { let _hold = hold; }).join().unwrap();
        drop(reserve("previews").expect("free once the worker ended"));
    }

    #[test]
    fn doctor_answers_are_read() {
        let v = doctor_line("# a note\nDOCTOR {\"ok\": false, \"problems\": [\"Blender was not found.\"]}\r\n").unwrap();
        assert_eq!((v["ok"].as_bool(), v["problems"][0].as_str()), (Some(false), Some("Blender was not found.")));
        assert!(doctor_line("PREVIEW_BUSY").is_none());
    }

    #[test]
    fn generator_lines_become_events() {
        let k = |s: &str| Some(s.to_string());
        assert_eq!(parse_line("PREVIEW_BUSY"), Some(("mod-previews-busy", None)));
        assert_eq!(parse_line("PREVIEW_BUSY\r"), Some(("mod-previews-busy", None)));
        assert_eq!(parse_line("PREVIEW_FAIL loadout-1"), Some(("mod-preview-failed", k("loadout-1"))));
        assert_eq!(parse_line("PREVIEW_NONE A"), Some(("mod-preview-none", k("A"))));
        assert_eq!(parse_line("PREVIEW_WARN loadout-1"), Some(("mod-preview-warn", k("loadout-1"))));
        assert_eq!(parse_line("PREVIEW_IN A"), Some(("mod-preview-in", k("A"))));
        assert_eq!(parse_line("PREVIEW_STAGE render"), Some(("mod-preview-stage", k("render"))));
        assert_eq!(parse_line("PREVIEW A_v2\r"), Some(("mod-preview-ready", k("A_v2"))));
        assert_eq!(parse_line("# A: character (12 s)"), None);
    }

    #[test]
    fn emote_ids_stay_in_their_folder() {
        assert!(valid_emote("1026-205") && valid_emote("9999-297"));
        assert!(!valid_emote("../x-205") && !valid_emote("1026205") && !valid_emote("1026-20a") && !valid_emote("1026-2050"));
    }
}
