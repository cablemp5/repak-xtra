//! repakxtra: generated mod previews. The generator (`mod_previews.py`, with Cue4Export and Blender) comes from the
//! preview kit (xtra_kit.rs), on every PC, and writes one image per mod to
//! %APPDATA%\Repak-X\previews\<mod key>.png (an animated <mod key>.webp for animation mods). This module serves those
//! files and runs the generator for the mods you pick (details panel button, the selection bar's Previews button, a
//! loadout's Generate previews).

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
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
        _ => "This PC is being checked for previews. Try again in a moment.",
    }
    .into()
}

fn previews_dir() -> PathBuf {
    crate::app_dir().join("previews")
}

/// (kit folder to run in, python, script): the installed preview kit. Without one a PC makes no previews; the
/// developer's PC too, so Setup always says where its kit came from (a file or GitHub).
fn generator() -> Option<(PathBuf, PathBuf, PathBuf)> {
    let kit = crate::xtra_kit::installed_kit()?;
    Some((kit.clone(), kit.join(r"python\python.exe"), kit.join(r"previews\mod_previews.py")))
}


/// Whether previews can be generated here; without it the app hides its Generate buttons and keeps showing previews it has.
#[tauri::command]
pub fn previews_available() -> bool {
    generator().is_some()
}

/// A mod key is a bare file stem from the frontend: never let it leave the previews folder.
fn valid_key(key: &str) -> bool {
    !key.is_empty() && !key.contains(['/', '\\', ':']) && !key.contains("..")
}

/// A preview is a PNG, or an animated WebP for animation mods (a clip on a gray model).
const PREVIEW_EXTS: [&str; 2] = [".png", ".webp"];

#[tauri::command]
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

#[tauri::command]
pub fn get_mod_preview(key: String) -> Result<tauri::ipc::Response, String> {
    if !valid_key(&key) {
        return Err(format!("Invalid preview key: {key}"));
    }
    let file = preview_file(&previews_dir(), &key).ok_or_else(|| format!("No preview for {key}"))?;
    std::fs::read(file).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
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
pub fn generate_mod_previews(app: AppHandle, jobs: Vec<(String, String)>, set: Option<String>, force: Option<bool>, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<bool, String> {
    if let Some(bad) = jobs.iter().map(|(_, k)| k).chain(set.iter()).find(|k| !valid_key(k)) {
        return Err(format!("Invalid preview key: {bad}"));
    }
    let hold = match reserve("previews") {
        Ok(h) => h,
        Err("previews") => return Ok(false),
        Err(other) => return Err(busy_text(other)),
    };
    let paks = state.lock().unwrap().game_path.parent().map(|p| p.to_path_buf());
    let mut cmd = generator_command(paks, true)?;
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
        match cmd.spawn() {
            Err(e) => {
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

/// Copies the generator's stderr to generator.log and the app's Logs: lines that report a failure (an error, a Python
/// traceback) as errors, the rest (what it rendered, optional assets not in the game) as notes.
fn log_generator(err: std::process::ChildStderr, mut file: Option<std::fs::File>) {
    use std::io::Write;
    let mut traceback = false;
    for line in BufReader::new(err).lines().map_while(Result::ok) {
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

/// A generator line that reports a failure ("<key>: error: ...", "spec: export failed: ..."), not a note: a count like
/// "0 failed" stays a note.
fn generator_error(text: &str) -> bool {
    let t = text.to_lowercase();
    let exit = t.find(" exit ").map(|i| &t[i + 6..]).is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit() && c != '0'));
    t.contains(": error") || t.contains("export failed") || t.starts_with("error") || t.contains("exception") || exit
}

/// The generator's command so far (the kit's python and script, run in its folder, with the kit's variables). The error
/// says what to install.
fn generator_command(paks: Option<PathBuf>, need_blender: bool) -> Result<Command, String> {
    let Some((root, python, script)) = generator() else {
        return Err("Previews need the preview kit: install it in Setup.".into());
    };
    if need_blender && crate::xtra_kit::blender().is_none() {
        return Err("Previews need Blender: install it in Setup (or from blender.org), or pick blender.exe there.".into());
    }
    let mut cmd = Command::new(&python);
    cmd.arg(&script).current_dir(&root).env("PYTHONUTF8", "1");
    // The kit's contract (tools\previews\build_kit.py): where the kit is, the game's Paks folder, a writable work folder
    // for exports, caches and the lock, and Blender
    cmd.env("REPAKXTRA_KIT", &root).env("REPAKXTRA_WORK", previews_dir().join("work"));
    if let Some(p) = &paks {
        cmd.env("REPAKXTRA_PAKS", p);
    }
    if let Some(b) = crate::xtra_kit::blender() {
        cmd.env("REPAKXTRA_BLENDER", b);
    }
    // The game's key comes from the app (the same one it installs mods with), so the kit carries none
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
    // The hold lives in the worker: it outlasts this future if the app stops waiting
    let out = tauri::async_runtime::spawn_blocking(move || { let _hold = hold; cmd.output() }).await.map_err(|e| e.to_string())?
        .map_err(|e| format!("The preview generator did not start: {e}"))?;
    doctor_line(&String::from_utf8_lossy(&out.stdout))
        .ok_or_else(|| format!("The preview check gave no answer (exit {}).", out.status.code().unwrap_or(-1)))
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
        assert_eq!(parse_line("PREVIEW_IN A"), Some(("mod-preview-in", k("A"))));
        assert_eq!(parse_line("PREVIEW A_v2\r"), Some(("mod-preview-ready", k("A_v2"))));
        assert_eq!(parse_line("# A: character (12 s)"), None);
    }
}
