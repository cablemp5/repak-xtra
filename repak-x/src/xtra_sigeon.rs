//! repakxtra: Sigeon V2 switch, the same logic as the `toggle-sigeon.ps1` desktop script.
//! Source files live in `%USERPROFILE%\Desktop\Sigeon V2` (SigeonLoader.asi plus one
//! `SigeonLoader.<preset>.ini` per preset). On = copy the .asi and the chosen ini (as
//! SigeonLoader.ini) into the game's Binaries\Win64\plugins folder; off = remove both.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

const ASI: &str = "SigeonLoader.asi";
const LIVE_INI: &str = "SigeonLoader.ini";

#[derive(Serialize)]
pub struct SigeonStatus {
    /// "off", a preset name, or "custom" when the live ini matches no preset
    state: String,
    /// SigeonLoader.asi is in the Sigeon folder; false until Sigeon is set up
    configured: bool,
    presets: Vec<String>,
    storage: String,
    plugins: String,
    game_running: bool,
    /// Why switching is unavailable, if it is
    problem: Option<String>,
}

fn default_storage() -> PathBuf {
    dirs::desktop_dir().unwrap_or_default().join("Sigeon V2")
}

fn storage_setting() -> PathBuf {
    crate::app_dir().join("sigeon.json")
}

/// Where SigeonLoader.asi and the SigeonLoader.<preset>.ini files live: the folder picked in the editor, else
/// Desktop\Sigeon V2.
fn storage_dir() -> PathBuf {
    fs::read_to_string(storage_setting())
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["storage"].as_str().map(PathBuf::from))
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(default_storage)
}

/// ...\Content\Paks\~mods -> ...\Marvel\Binaries\Win64\plugins
fn plugins_dir(mods_dir: &Path) -> Option<PathBuf> {
    Some(mods_dir.parent()?.parent()?.parent()?.join("Binaries").join("Win64").join("plugins"))
}

fn presets(storage: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(storage)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_prefix("SigeonLoader.")?.strip_suffix(".ini").map(str::to_string)
        })
        .collect();
    names.sort();
    names
}

fn current_state(storage: &Path, plugins: &Path) -> String {
    let live = match (plugins.join(ASI).exists(), fs::read(plugins.join(LIVE_INI))) {
        (true, Ok(bytes)) => bytes,
        _ => return "off".into(),
    };
    presets(storage)
        .into_iter()
        .find(|p| fs::read(storage.join(format!("SigeonLoader.{p}.ini"))).ok().as_deref() == Some(&live[..]))
        .unwrap_or_else(|| "custom".into())
}

/// Same marker the Desktop script leaves, so both show the same state.
fn write_marker(storage: &Path, state: &str) {
    if let Ok(entries) = fs::read_dir(storage) {
        for e in entries.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with("SIGEON V2 ") && n.ends_with(".txt") {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    let _ = fs::write(storage.join(format!("SIGEON V2 {}.txt", state.to_uppercase())), b"");
}

fn apply(storage: &Path, plugins: &Path, preset: Option<&str>) -> Result<String, String> {
    // A hand-edited live ini (it matches no preset) is copied to Sigeon V2\.deleted before Off or a preset replaces it
    if current_state(storage, plugins) == "custom" {
        let bin = storage.join(".deleted");
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        fs::create_dir_all(&bin)
            .and_then(|_| fs::copy(plugins.join(LIVE_INI), bin.join(format!("SigeonLoader.edited-{secs}.ini"))))
            .map_err(|e| format!("Could not keep a copy of the edited SigeonLoader.ini first: {e}"))?;
    }
    match preset {
        None => {
            for f in [ASI, LIVE_INI] {
                let p = plugins.join(f);
                if p.exists() {
                    fs::remove_file(&p).map_err(|e| format!("Could not remove {}: {e}", p.display()))?;
                }
            }
        }
        Some(name) => {
            let asi = storage.join(ASI);
            let ini = storage.join(format!("SigeonLoader.{name}.ini"));
            for f in [&asi, &ini] {
                if !f.exists() {
                    return Err(format!("Missing {}", f.display()));
                }
            }
            fs::create_dir_all(plugins).map_err(|e| e.to_string())?;
            fs::copy(&asi, plugins.join(ASI)).map_err(|e| format!("Could not copy the loader: {e}"))?;
            fs::copy(&ini, plugins.join(LIVE_INI)).map_err(|e| format!("Could not copy the ini: {e}"))?;
        }
    }
    let state = current_state(storage, plugins);
    write_marker(storage, &state);
    Ok(state)
}

fn paths(state: &State<'_, Arc<Mutex<crate::AppState>>>) -> (PathBuf, Option<PathBuf>) {
    let mods = state.lock().unwrap().game_path.clone();
    (storage_dir(), plugins_dir(&mods))
}

#[tauri::command]
pub async fn sigeon_status(state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<SigeonStatus, String> {
    let (storage, plugins) = paths(&state);
    let configured = storage.join(ASI).exists();
    let problem = if !configured {
        Some(format!("{} not found", storage.join(ASI).display()))
    } else if plugins.is_none() {
        Some("Set the game mods path in Settings first".into())
    } else {
        None
    };
    let plugins = plugins.unwrap_or_default();
    Ok(SigeonStatus {
        state: current_state(&storage, &plugins),
        configured,
        presets: presets(&storage),
        storage: storage.display().to_string(),
        plugins: plugins.display().to_string(),
        game_running: crate::is_game_process_running(),
        problem,
    })
}

/// `preset` = None turns Sigeon off.
#[tauri::command]
pub async fn sigeon_set(preset: Option<String>, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<String, String> {
    if crate::is_game_process_running() {
        return Err("Marvel Rivals is running. Close the game before switching Sigeon.".into());
    }
    let (storage, plugins) = paths(&state);
    let plugins = plugins.ok_or("Set the game mods path in Settings first")?;
    apply(&storage, &plugins, preset.as_deref())
}

// ---------- Editor: presets as lines, so comments, order and the license line survive every save ----------

/// One line of a SigeonLoader ini. The license line never leaves Rust: the frontend sees only `License`, and a save
/// puts back the exact line that is on disk.
#[derive(Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Line {
    Blank,
    Comment { text: String },
    Section { name: String },
    /// `on: false` is a commented-out setting (`;gamma=0`): kept, but not in force
    Entry { key: String, value: String, on: bool },
    /// `set`: a key is filled in (its value never leaves Rust). Ignored on save: the line on disk is written back.
    License {
        #[serde(default)]
        set: bool,
    },
    /// Anything else, written back as it was
    Raw { text: String },
}

/// A setting name, with UE's array prefixes: `+TextureLODGroups` adds a line, `-Key` removes one, `!Key` clears.
fn is_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 128 && k.chars().all(|c| c.is_ascii_alphanumeric() || "!._-/:+".contains(c))
}

fn is_license(line: &str) -> bool {
    line.trim_start_matches(';').trim_start().to_ascii_lowercase().starts_with("licensekey")
}

fn parse(text: &str) -> Vec<Line> {
    text.lines()
        .map(|raw| {
            let t = raw.trim();
            if is_license(t) {
                let set = !t.starts_with(';') && t.split_once('=').is_some_and(|(_, v)| !v.trim().is_empty());
                return Line::License { set };
            }
            if t.is_empty() {
                return Line::Blank;
            }
            if t.starts_with('[') && t.ends_with(']') {
                return Line::Section { name: t[1..t.len() - 1].to_string() };
            }
            // ";gamma=0" is a switched-off setting; ";   r.Fog=0" (spaced, the file's own examples) stays a comment
            let (body, on) = match t.strip_prefix(';') {
                Some(rest) if rest.starts_with(|c: char| c.is_ascii_alphanumeric() || "!+-".contains(c)) => (rest, false),
                Some(rest) => return Line::Comment { text: rest.to_string() },
                None => (t, true),
            };
            match body.split_once('=') {
                Some((k, v)) if is_key(k.trim()) => Line::Entry { key: k.trim().to_string(), value: v.trim().to_string(), on },
                _ if on => Line::Raw { text: raw.to_string() },
                _ => Line::Comment { text: body.to_string() },
            }
        })
        .collect()
}

/// Lines back to text. `license` holds the file's own license lines, in order; a new preset copies another's.
fn render(lines: &[Line], license: &[String], crlf: bool) -> Result<String, String> {
    let clean = |s: &str, what: &str| {
        if s.contains(['\r', '\n']) { Err(format!("{what} can't contain a line break")) } else { Ok(()) }
    };
    let wanted = lines.iter().filter(|l| matches!(l, Line::License { .. })).count();
    if wanted != license.len() {
        return Err("The license line went missing; nothing was saved.".into());
    }
    let mut lic = license.iter();
    let mut out = Vec::with_capacity(lines.len());
    for l in lines {
        out.push(match l {
            Line::Blank => String::new(),
            Line::Comment { text } => { clean(text, "A note")?; format!(";{text}") }
            Line::Section { name } => {
                clean(name, "A section name")?;
                if name.contains([']', '[']) || name.trim().is_empty() { return Err(format!("\"{name}\" is not a section name")); }
                format!("[{name}]")
            }
            Line::Entry { key, value, on } => {
                if !is_key(key) || is_license(key) { return Err(format!("\"{key}\" is not a setting name")); }
                clean(value, "A value")?;
                format!("{}{key}={value}", if *on { "" } else { ";" })
            }
            Line::License { .. } => lic.next().cloned().unwrap_or_default(),
            Line::Raw { text } => { clean(text, "A line")?; text.clone() }
        });
    }
    let nl = if crlf { "\r\n" } else { "\n" };
    Ok(out.join(nl) + nl)
}

fn license_lines(text: &str) -> Vec<String> {
    text.lines().filter(|l| is_license(l.trim())).map(str::to_string).collect()
}

/// A config name is the middle of its file name (SigeonLoader.<name>.ini): anything Windows allows there, so a file
/// made by hand ("base + clarity") opens too. Not empty, no spaces or dots at either end, no path or reserved
/// characters, up to 48 characters, and not Off or Custom (the header's own states).
fn valid_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.chars().count() <= 48
        && name.trim() == name
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.contains("..")
        && !name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c));
    if !ok || ["off", "custom"].contains(&name.to_ascii_lowercase().as_str()) {
        return Err(format!("\"{name}\" can't be a config name: no / \\ : * ? \" < > |, up to 48 characters"));
    }
    Ok(())
}

fn preset_file(storage: &Path, name: &str) -> Result<PathBuf, String> {
    valid_name(name)?;
    Ok(storage.join(format!("SigeonLoader.{name}.ini")))
}

fn read_preset(storage: &Path, name: &str) -> Result<Vec<Line>, String> {
    let text = fs::read_to_string(preset_file(storage, name)?).map_err(|e| format!("Could not read the {name} config: {e}"))?;
    Ok(parse(&text))
}

/// Writes through a temporary file and keeps the previous version as SigeonLoader.<name>.ini.bak.
fn save_preset(storage: &Path, name: &str, lines: &[Line]) -> Result<(), String> {
    let file = preset_file(storage, name)?;
    let old = fs::read_to_string(&file).map_err(|e| format!("Could not read the {name} config: {e}"))?;
    let text = render(lines, &license_lines(&old), old.contains("\r\n"))?;
    let tmp = file.with_extension("ini.tmp");
    fs::write(&tmp, &text).map_err(|e| format!("Could not save: {e}"))?;
    let _ = fs::copy(&file, file.with_extension("ini.bak"));
    fs::rename(&tmp, &file).map_err(|e| format!("Could not save: {e}"))
}

/// A new config: SigeonLoader.ini as Sigeon ships it (the format with hideUID, 2026-10): base, every switch off,
/// stretched 1.0, gamma and sharpening left to the config, no overrides, and an empty licenseKey line, which the user
/// fills in the file itself. Written with CRLF line ends, like the shipped file.
const NEW_CONFIG: &str = r#"; SigeonLoader configuration.
; Place this file next to the DLL (the game's ...\Binaries\Win64 folder).
;
; Paste your license key below, pick a config, save, then launch the game.
; Lines starting with ';' are comments.

licenseKey=

; Which config to load (base = default). This sets the quality baseline:
;   base   - the standard Sigeon V2 config
;   n64    - pixelated, N64-style textures
;   low    - lowest quality for max FPS (gray heros, only for lowest end systems)
;   mid    - a balance of quality (visuals) and high performance
;   high   - highest quality while maintaining a performance boost
variant=base

; Optional switches (0 = off, 1 = on unless noted), mix and match with any config above:
;   lowLatency   - lower input latency, costs some FPS
;   stretched    - app scale for stretched res, no black bars. 1.0 = off, 1.1 to 2.0 = more stretch
;   darkHair     - slightly darker hair, small FPS gain
;   fontAA       - smoother text (off = sharper text)
;   fixDarkMaps  - removes the light distance culling that makes maps look too dark
;   hideUID      - hides the UID / version / time overlay
;   gamma        - remove the ';' to override the config's gamma: 0 = game default, up to 5.0,
;                  higher = darker (2.2 suits most screens)
;   enableCAS    - remove the ';' to override sharpening: 1 = on, 0 = off (only "low" ships it off)
lowLatency=0
stretched=1.0
darkHair=0
fontAA=0
fixDarkMaps=0
hideUID=0
;gamma=2.2
;enableCAS=1

; ---------------------------------------------------------------------------
; ADVANCED. Everything in this box is an EXAMPLE: the ';' at the start
; of a line makes it a comment, so none of it does anything. To use a line, copy
; it WITHOUT the ';' to below the real [Overrides] line at the very bottom of this
; file. Section headers like [Windows DeviceProfile] go down there too, after
; your cvar lines, e.g.:
;
;   [Overrides]
;   r.ScreenPercentage=80
;
;   [Windows DeviceProfile]
;   +TextureLODGroups=(Group=TEXTUREGROUP_Character,LODBias=0,MaxLODSize=4096)
;
; Lines under [Overrides] merge on top of the config and win over everything,
; switches included.
;
; A [Section] header reaches non-cvar settings:
;   [/Script/Engine.UserInterfaceSettings]
;   ApplicationScale=1.4
;
; A '!' in front drops the config's value so the game's own applies. Keep the
; '=' at the end, or the line is ignored:
;   !r.BloomQuality=
;
; [Windows DeviceProfile] reaches texture detail. Each line replaces one texture
; group and leaves the rest alone, e.g. sharp characters on any config:
;   [Windows DeviceProfile]
;   +TextureLODGroups=(Group=TEXTUREGROUP_Character,LODBias=0,MaxLODSize=4096)
;   +TextureLODGroups=(Group=TEXTUREGROUP_CharacterNormalMap,LODBias=0,MaxLODSize=4096)
;
; Settings that can remove smoke or other effects are ignored.
; ---------------------------------------------------------------------------

; Your own override lines go BELOW this line, with no ';' in front:
[Overrides]
"#;

/// `from`: a copy of that config (its key included); None: a new one from the defaults above.
fn create_preset(storage: &Path, name: &str, from: Option<&str>) -> Result<(), String> {
    let dst = preset_file(storage, name)?;
    if dst.exists() {
        return Err(format!("A config named {name} already exists"));
    }
    fs::create_dir_all(storage).map_err(|e| format!("Could not make the folder: {e}"))?;
    match from {
        Some(from) => fs::copy(preset_file(storage, from)?, &dst).map(|_| ()).map_err(|e| format!("Could not copy {from}: {e}")),
        None => fs::write(&dst, NEW_CONFIG.replace('\n', "\r\n")).map_err(|e| format!("Could not create it: {e}")),
    }
}

fn rename_preset(storage: &Path, from: &str, to: &str) -> Result<(), String> {
    let (src, dst) = (preset_file(storage, from)?, preset_file(storage, to)?);
    if dst.exists() && !from.eq_ignore_ascii_case(to) {
        return Err(format!("A config named {to} already exists"));
    }
    fs::rename(&src, &dst).map_err(|e| format!("Could not rename: {e}"))
}

/// Whether the game runs this preset now. By content, not by state name: a fresh copy matches its source byte for
/// byte, and the state names only the first of them.
fn in_use(storage: &Path, plugins: Option<&Path>, name: &str) -> bool {
    let live = plugins.filter(|p| p.join(ASI).exists()).and_then(|p| fs::read(p.join(LIVE_INI)).ok());
    live.is_some() && preset_file(storage, name).ok().and_then(|f| fs::read(f).ok()) == live
}

/// Deleted configs wait in Sigeon V2\.deleted for Undo.
fn delete_preset(storage: &Path, plugins: Option<&Path>, name: &str) -> Result<(), String> {
    if in_use(storage, plugins, name) {
        return Err(format!("{name} is the config in use. Switch to another or turn Sigeon off first."));
    }
    let src = preset_file(storage, name)?;
    let bin = storage.join(".deleted");
    fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    fs::rename(&src, bin.join(src.file_name().unwrap())).map_err(|e| format!("Could not delete: {e}"))
}

fn restore_preset(storage: &Path, name: &str) -> Result<(), String> {
    let dst = preset_file(storage, name)?;
    if dst.exists() {
        return Err(format!("A config named {name} already exists"));
    }
    fs::rename(storage.join(".deleted").join(dst.file_name().unwrap()), &dst).map_err(|e| format!("Could not restore: {e}"))
}

#[tauri::command]
pub async fn sigeon_read(preset: String) -> Result<Vec<Line>, String> {
    read_preset(&storage_dir(), &preset)
}

#[derive(Serialize)]
pub struct Saved {
    state: String,
    /// The saved config is the one in use and was copied into the game again
    applied: bool,
}

/// Saves a preset. When it is the one in use and the game is closed, the game's copy is refreshed too.
#[tauri::command]
pub async fn sigeon_save(preset: String, lines: Vec<Line>, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<Saved, String> {
    let (storage, plugins) = paths(&state);
    let was_live = in_use(&storage, plugins.as_deref(), &preset);
    save_preset(&storage, &preset, &lines)?;
    let applied = was_live && !crate::is_game_process_running();
    if applied {
        apply(&storage, plugins.as_deref().unwrap(), Some(&preset))?;
    }
    let state = plugins.as_deref().map(|p| current_state(&storage, p)).unwrap_or_else(|| "off".into());
    Ok(Saved { state, applied })
}

#[tauri::command]
pub async fn sigeon_create(name: String, from: Option<String>) -> Result<(), String> {
    create_preset(&storage_dir(), &name, from.as_deref())
}

#[derive(Serialize)]
pub struct Storage {
    path: String,
    default: bool,
    /// SigeonLoader.asi is in the folder
    loader: bool,
}

#[tauri::command]
pub async fn sigeon_storage() -> Result<Storage, String> {
    let path = storage_dir();
    Ok(Storage { loader: path.join(ASI).exists(), default: path == default_storage(), path: path.display().to_string() })
}

/// Picks the folder holding SigeonLoader.asi and the configs; None goes back to Desktop\Sigeon V2.
#[tauri::command]
pub async fn sigeon_set_storage(path: Option<String>) -> Result<Storage, String> {
    let _ = fs::create_dir_all(crate::app_dir());
    match path.filter(|p| !p.trim().is_empty()) {
        Some(p) => {
            if !Path::new(&p).is_dir() {
                return Err(format!("{p} is not a folder"));
            }
            fs::write(storage_setting(), serde_json::json!({ "storage": p }).to_string()).map_err(|e| e.to_string())?;
        }
        None => { let _ = fs::remove_file(storage_setting()); }
    }
    sigeon_storage().await
}

/// Opens a config in Notepad, where the license key is pasted (the app never handles the key).
#[tauri::command]
pub async fn sigeon_open(preset: String) -> Result<(), String> {
    let file = preset_file(&storage_dir(), &preset)?;
    if !file.exists() {
        return Err(format!("{} not found", file.display()));
    }
    std::process::Command::new("notepad.exe").arg(&file).spawn().map(|_| ()).map_err(|e| format!("Could not open Notepad: {e}"))
}

#[tauri::command]
pub async fn sigeon_rename(from: String, to: String) -> Result<(), String> {
    rename_preset(&storage_dir(), &from, &to)
}

#[tauri::command]
pub async fn sigeon_delete(name: String, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<(), String> {
    let (storage, plugins) = paths(&state);
    delete_preset(&storage, plugins.as_deref(), &name)
}

#[tauri::command]
pub async fn sigeon_restore(name: String) -> Result<(), String> {
    restore_preset(&storage_dir(), &name)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "; SigeonLoader configuration.\r\n\r\nlicenseKey=TEST-KEY-123\r\n\r\n; Which config\r\nvariant=high\r\nlowLatency=0\r\n;gamma=0\r\n;   [Overrides]\r\n;   r.Fog=0\r\n\r\n[Overrides]\r\n; ---- my notes ----\r\nr.DetailMode=1\r\n!r.Fog=\r\n[/Script/Engine.UserInterfaceSettings]\r\nApplicationScale=1.4\r\n";

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sigeon-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn parses_settings_comments_and_hides_the_license() {
        let lines = parse(SAMPLE);
        assert!(!format!("{lines:?}").contains("TEST-KEY"), "the key must not reach the frontend");
        assert_eq!(lines[2], Line::License { set: true });
        assert_eq!(lines[5], Line::Entry { key: "variant".into(), value: "high".into(), on: true });
        assert_eq!(lines[7], Line::Entry { key: "gamma".into(), value: "0".into(), on: false });
        assert!(matches!(&lines[8], Line::Comment { text } if text == "   [Overrides]"), "the file's own examples stay comments");
        assert!(matches!(&lines[9], Line::Comment { .. }));
        assert_eq!(lines[11], Line::Section { name: "Overrides".into() });
        assert_eq!(lines[14], Line::Entry { key: "!r.Fog".into(), value: "".into(), on: true });
        assert_eq!(render(&lines, &license_lines(SAMPLE), true).unwrap(), SAMPLE, "an unedited save is byte for byte");
    }

    #[test]
    fn saves_keep_the_license_and_refuse_bad_lines() {
        let storage = temp("save");
        fs::write(storage.join("SigeonLoader.high.ini"), SAMPLE).unwrap();
        let mut lines = read_preset(&storage, "high").unwrap();
        lines[6] = Line::Entry { key: "lowLatency".into(), value: "1".into(), on: true };
        lines.push(Line::Entry { key: "r.Fog".into(), value: "0".into(), on: true });
        save_preset(&storage, "high", &lines).unwrap();
        let text = fs::read_to_string(storage.join("SigeonLoader.high.ini")).unwrap();
        assert!(text.contains("licenseKey=TEST-KEY-123\r\n") && text.contains("lowLatency=1\r\n") && text.ends_with("r.Fog=0\r\n"));
        assert!(storage.join("SigeonLoader.high.ini.bak").exists());
        let no_license: Vec<Line> = lines.iter().filter(|l| !matches!(l, Line::License { .. })).cloned().collect();
        assert!(save_preset(&storage, "high", &no_license).is_err(), "dropping the license line is refused");
        let mut bad = lines.clone();
        bad.push(Line::Entry { key: "r.Fog".into(), value: "0\nlicenseKey=x".into(), on: true });
        assert!(save_preset(&storage, "high", &bad).is_err());
        bad.pop();
        bad.push(Line::Entry { key: "licenseKey".into(), value: "x".into(), on: true });
        assert!(save_preset(&storage, "high", &bad).is_err(), "a second license line can't be smuggled in");
        assert!(fs::read_to_string(storage.join("SigeonLoader.high.ini")).unwrap().contains("TEST-KEY-123"));
        let _ = fs::remove_dir_all(&storage);
    }

    #[test]
    fn a_config_made_by_hand_with_spaces_opens() {
        let storage = temp("handmade");
        fs::write(storage.join("SigeonLoader.base + clarity.ini"), SAMPLE).unwrap();
        assert_eq!(presets(&storage), ["base + clarity"]);
        assert!(read_preset(&storage, "base + clarity").is_ok(), "every listed config opens");
        for bad in ["", " x", "x ", ".x", "x.", "a..b", "a/b", "a\\b", "a:b", "a*b", "a?b", "a|b", "off", "Custom"] {
            assert!(valid_name(bad).is_err(), "{bad:?}");
        }
        assert!(valid_name("high-v2 (comp)").is_ok());
    }

    #[test]
    fn presets_are_created_renamed_deleted_and_restored() {
        let storage = temp("presets");
        let plugins = storage.join("plugins");
        fs::write(storage.join(ASI), b"asi").unwrap();
        fs::write(storage.join("SigeonLoader.high.ini"), SAMPLE).unwrap();
        create_preset(&storage, "comp", Some("high")).unwrap();
        assert!(fs::read_to_string(storage.join("SigeonLoader.comp.ini")).unwrap().contains("TEST-KEY-123"), "a copy carries the license");
        assert!(create_preset(&storage, "comp", Some("high")).is_err());
        assert!(create_preset(&storage, "../x", Some("high")).is_err() && create_preset(&storage, "off", Some("high")).is_err());
        create_preset(&storage, "fresh", None).unwrap();
        let fresh = read_preset(&storage, "fresh").unwrap();
        assert!(fresh.contains(&Line::License { set: false }), "a new config waits for its key");
        assert!(fresh.contains(&Line::Entry { key: "variant".into(), value: "base".into(), on: true }));
        assert!(fresh.contains(&Line::Entry { key: "gamma".into(), value: "2.2".into(), on: false }));
        assert!(fresh.contains(&Line::Entry { key: "hideUID".into(), value: "0".into(), on: true }));
        assert!(fresh.contains(&Line::Entry { key: "enableCAS".into(), value: "1".into(), on: false }));
        let raw = fs::read_to_string(storage.join("SigeonLoader.fresh.ini")).unwrap();
        assert!(raw.contains("licenseKey=\r\n") && !raw.replace("\r\n", "").contains('\n'), "CRLF, like the shipped file");
        assert!(!fresh.iter().any(|l| matches!(l, Line::Entry { key, .. } if key.contains("ScreenPercentage") || key.contains("TextureLODGroups"))),
            "the ADVANCED examples stay comments");
        assert_eq!(render(&fresh, &license_lines(&raw), true).unwrap(), raw, "an unedited save of the new format is byte for byte");
        assert!(fresh.contains(&Line::Entry { key: "fontAA".into(), value: "0".into(), on: true }));
        assert_eq!(fresh.last(), Some(&Line::Section { name: "Overrides".into() }), "no overrides");
        fs::remove_file(storage.join("SigeonLoader.fresh.ini")).unwrap();
        rename_preset(&storage, "comp", "ranked").unwrap();
        assert_eq!(presets(&storage), vec!["high", "ranked"]);
        apply(&storage, &plugins, Some("ranked")).unwrap();
        assert!(delete_preset(&storage, Some(&plugins), "ranked").is_err(), "the config in use can't be deleted");
        apply(&storage, &plugins, None).unwrap();
        delete_preset(&storage, Some(&plugins), "ranked").unwrap();
        assert_eq!(presets(&storage), vec!["high"]);
        restore_preset(&storage, "ranked").unwrap();
        assert_eq!(presets(&storage), vec!["high", "ranked"]);
        let _ = fs::remove_dir_all(&storage);
    }

    #[test]
    fn switches_between_off_and_presets() {
        let base = std::env::temp_dir().join(format!("sigeon-test-{}", std::process::id()));
        let storage = base.join("storage");
        let plugins = base.join("plugins");
        fs::create_dir_all(&storage).unwrap();
        fs::write(storage.join(ASI), b"asi").unwrap();
        fs::write(storage.join("SigeonLoader.base.ini"), b"variant=base").unwrap();
        fs::write(storage.join("SigeonLoader.high.ini"), b"variant=high").unwrap();

        assert_eq!(presets(&storage), vec!["base", "high"]);
        assert_eq!(current_state(&storage, &plugins), "off");
        assert_eq!(apply(&storage, &plugins, Some("high")).unwrap(), "high");
        assert!(storage.join("SIGEON V2 HIGH.txt").exists());
        assert_eq!(apply(&storage, &plugins, Some("base")).unwrap(), "base");
        assert!(!storage.join("SIGEON V2 HIGH.txt").exists());
        fs::write(plugins.join(LIVE_INI), b"edited").unwrap();
        assert_eq!(current_state(&storage, &plugins), "custom");
        assert_eq!(apply(&storage, &plugins, None).unwrap(), "off");
        assert!(!plugins.join(ASI).exists());
        let kept: Vec<_> = fs::read_dir(storage.join(".deleted")).unwrap().flatten().collect();
        assert_eq!(kept.len(), 1, "the edited ini is kept before Off removes it");
        assert_eq!(fs::read(kept[0].path()).unwrap(), b"edited");
        assert!(apply(&storage, &plugins, Some("missing")).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn device_profile_texture_lines_are_settings() {
        let text = "[Overrides]\r\nr.Fog=0\r\n\r\n[Windows DeviceProfile]\r\n+TextureLODGroups=(Group=TEXTUREGROUP_Character,LODBias=0,MaxLODSize=4096)\r\n;+TextureLODGroups=(Group=TEXTUREGROUP_CharacterNormalMap,LODBias=0,MaxLODSize=4096)\r\n;   +TextureLODGroups=(an example)\r\n";
        let lines = parse(text);
        assert_eq!(lines[4], Line::Entry {
            key: "+TextureLODGroups".into(), value: "(Group=TEXTUREGROUP_Character,LODBias=0,MaxLODSize=4096)".into(), on: true });
        assert!(matches!(&lines[5], Line::Entry { key, on: false, .. } if key == "+TextureLODGroups"), "a switched-off texture line stays a setting");
        assert!(matches!(&lines[6], Line::Comment { .. }), "spaced examples stay comments");
        assert_eq!(render(&lines, &[], true).unwrap(), text, "byte for byte");
    }

    #[test]
    fn plugins_dir_from_mods_path() {
        let mods = Path::new(r"C:\Steam\MarvelRivals\MarvelGame\Marvel\Content\Paks\~mods");
        assert_eq!(plugins_dir(mods).unwrap(), Path::new(r"C:\Steam\MarvelRivals\MarvelGame\Marvel\Binaries\Win64\plugins"));
    }
}
