//! repakxtra: the ban risk check (custom/safetyScan.ts). Marvel Rivals' anti-cheat notice names memory-injecting .asi
//! files (pystubber.asi, MarvelRivalsUnmountBlocker.asi) and mods that give an edge: camera shake and recoil removed,
//! hit and tracer effects removed, footstep sounds changed, maps or environment changed so players see differently,
//! enlarged enemy models. Two checks, from file names alone:
//! - plugins: every .asi and proxy DLL beside the game exe. The two named files are "banned" (Remove moves them out),
//!   other ones "unknown", the bypass Setup installs "bundled" (it patches memory too, but the notice does not name it).
//! - mods: asset paths that match what the notice describes. "ban" for paths that only exist to change those things,
//!   "check" for ones a plain recolor also touches. Nothing is turned off: the badge says why and the player decides.
//! shortcut: names stand in for content, so a mod that removes recoil through a renamed Blueprint, removes hit or tracer
//! effects (a name looks the same as a recolor's), or enlarges models through a mesh swap is missed. Compare a mod's
//! VFX and mesh sizes with the game's if those ever need flagging.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

/// The files Marvel Rivals' notice names as anti-cheat triggers.
const BANNED: &[&str] = &["pystubber.asi", "marvelrivalsunmountblocker.asi"];

#[derive(Serialize, Debug, PartialEq)]
pub struct Plugin {
    name: String,
    /// relative to Binaries\Win64
    place: String,
    /// "banned", "unknown" or "bundled"
    kind: &'static str,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Risk {
    path: String,
    /// "ban" or "check"
    level: &'static str,
    reason: String,
}

fn plugins_in(win64: &Path) -> Vec<Plugin> {
    let mut out = Vec::new();
    for sub in ["", "plugins", "scripts"] {
        for e in fs::read_dir(win64.join(sub)).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let lower = name.to_ascii_lowercase();
            let proxy = sub.is_empty() && lower.strip_suffix(".dll").is_some_and(|s| crate::xtra_crash::PROXY_DLLS.contains(&s));
            if !e.path().is_file() || !(lower.ends_with(".asi") || proxy) {
                continue;
            }
            let kind = if BANNED.contains(&lower.as_str()) { "banned" }
                else if crate::xtra_setup::is_bundled_bypass(&e.path()) { "bundled" }
                else { "unknown" };
            out.push(Plugin { name, place: sub.to_string(), kind });
        }
    }
    out
}

/// A mod named for what the notice bans ("NoRecoil", "no-screen-shake", "No Impact"): its name says what it removes,
/// whatever its files are called.
fn by_name(path: &Path) -> Option<String> {
    let stem: String = path.file_stem()?.to_string_lossy().to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    const REMOVES: &[(&str, &str)] = &[
        ("noscreenshake", "screen shake"), ("nocamerashake", "screen shake"), ("noshake", "screen shake"), ("norecoil", "weapon recoil"),
        ("noimpact", "impact effects"), ("nobullet", "bullet effects"), ("notracer", "bullet tracers"),
        ("nomuzzle", "muzzle flashes"), ("nofootstep", "footstep sounds"),
    ];
    REMOVES.iter().find(|(word, _)| stem.contains(word)).map(|(_, what)| format!("Its name says it removes {what}."))
}

/// What a mod's files say about it, the strongest finding first. `files` as the mod lists them, any mount root.
fn judge(files: &[String]) -> Option<(&'static str, String)> {
    // "Marvel/Content/Marvel/X.uasset" (PAK) and "/Game/Marvel/X.uasset" (IoStore) both become "marvel/x.uasset"
    let keys: Vec<String> = files.iter().map(|f| {
        let k = f.replace('\\', "/").to_lowercase();
        k.split_once("/content/").map(|(_, r)| r.to_string()).or_else(|| k.strip_prefix("/game/").map(str::to_string)).unwrap_or(k)
    }).collect();
    let name = |k: &str| k.rsplit('/').next().unwrap_or(k).to_string();
    let find = |test: &dyn Fn(&str) -> bool| keys.iter().find(|k| test(k)).map(|k| name(k));
    let has = |k: &str, words: &[&str]| words.iter().any(|w| name(k).contains(w));
    let audio = |k: &str| k.contains("wwiseaudio/");
    let rules: [(&str, &str, &dyn Fn(&str) -> bool); 4] = [
        ("ban", "Changes camera shake or weapon recoil", &|k| ["camerashake", "camera_shake", "recoil"].iter().any(|w| k.contains(w))),
        ("ban", "Changes footstep or movement sounds, which can make enemies easier to hear", &|k| audio(k) && has(k, &["footstep", "foot_step", "foley"])),
        ("ban", "Changes maps or their models and textures, which can change what players see", &|k| {
            k.starts_with("marvel/environment/") || k.starts_with("marvel/maps/") || k.starts_with("marvel/levels/") || k.ends_with(".umap")
        }),
        // a hero's own banks carry a 7-digit skin id (bnk_sfx_1026001): the rest are shared, where footsteps and cues live
        ("check", "Changes shared game sounds. Footsteps and other cues players listen for can be in them", &|k| {
            audio(k) && k.ends_with(".bnk") && !name(k).split(|c: char| !c.is_ascii_digit()).any(|d| d.len() == 7)
        }),
    ];
    rules.iter().find_map(|(level, why, test)| find(*test).map(|file| (*level, format!("{why} ({file})."))))
}

fn mods_dir(state: &State<'_, Arc<Mutex<crate::AppState>>>) -> PathBuf {
    state.lock().unwrap().game_path.clone()
}

#[tauri::command]
pub async fn xtra_safety_plugins(state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<Vec<Plugin>, String> {
    let Some(win64) = crate::xtra_setup::win64_dir(&mods_dir(&state)) else { return Ok(Vec::new()) };
    tauri::async_runtime::spawn_blocking(move || plugins_in(&win64)).await.map_err(|e| e.to_string())
}

/// Moves a plugin the scan lists (never the bundled bypass) to %APPDATA%\Repak-X\removed-plugins\<unix secs>, so it
/// can be put back by hand.
#[tauri::command]
pub async fn xtra_safety_remove_plugin(name: String, place: String, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<Vec<Plugin>, String> {
    let _mutation = crate::xtra_mutation::edit()?;
    crate::xtra_identity::upstream_guard()?;
    if crate::is_game_process_running() {
        return Err("Marvel Rivals is running. Close it first.".into());
    }
    let win64 = crate::xtra_setup::win64_dir(&mods_dir(&state)).ok_or("Set the game mods path in Settings first")?;
    // only a file the scan lists right now: the name and place never reach outside Win64
    if !plugins_in(&win64).iter().any(|p| p.name == name && p.place == place && p.kind != "bundled") {
        return Err(format!("{name} is not there any more."));
    }
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
    let to = crate::app_dir().join("removed-plugins").join(secs.to_string()).join(&place);
    fs::create_dir_all(&to).map_err(|e| e.to_string())?;
    let from = win64.join(&place).join(&name);
    // a rename across drives fails: copy, then remove
    if fs::rename(&from, to.join(&name)).is_err() {
        fs::copy(&from, to.join(&name)).and_then(|_| fs::remove_file(&from)).map_err(|e| format!("Could not remove {name}: {e}"))?;
    }
    Ok(plugins_in(&win64))
}

#[tauri::command]
pub async fn xtra_safety_mods(mod_paths: Vec<String>, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<Vec<Risk>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        mod_paths.into_iter().filter_map(|p| {
            let path = PathBuf::from(&p);
            // built-ins too: No Screen Shake, No Bullet Holes, and No Impact are what the notice bans
            if crate::xtra_setup::is_managed_loader(&path) {
                return None;
            }
            // a built-in says so: the player did not install it by hand, so the reason says where it came from and what to do
            let made_here = |reason: String| if crate::xtra_builtins::is_own(&path) {
                format!("{reason} repakxtra made it as a built-in, and the notice still counts it. Turn it off before you play online.")
            } else if crate::xtra_builtins::in_folder(&path) {
                format!("{reason} Another app made it as a built-in, and the notice still counts it. Turn it off before you play online.")
            } else { reason };
            if let Some(reason) = by_name(&path) {
                return Some(Risk { path: p, level: "ban", reason: made_here(reason) });
            }
            let details = crate::compute_mod_details(&path, &state).ok()?;
            judge(&details.files).map(|(level, reason)| Risk { path: p.clone(), level, reason: made_here(reason) })
        }).collect()
    }).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn j(files: &[&str]) -> Option<&'static str> {
        judge(&files.iter().map(|s| s.to_string()).collect::<Vec<_>>()).map(|r| r.0)
    }

    #[test]
    fn the_rules() {
        assert_eq!(j(&["Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset"]), None, "a skin is fine");
        assert_eq!(j(&["Marvel/Content/WwiseAudio/bnk_sfx_1026001.bnk"]), None, "a hero's own sound bank is fine");
        assert_eq!(j(&["/Game/Marvel/Camera/CameraShake/CS_Fire.uasset"]), Some("ban"));
        assert_eq!(j(&["Marvel/Content/Marvel/Environment/Tokyo/T_Wall.uasset"]), Some("ban"));
        assert_eq!(j(&["Marvel/Content/WwiseAudio/bnk_footstep_common.bnk"]), Some("ban"));
        assert_eq!(j(&["Marvel/Content/WwiseAudio/bnk_sfx_common.bnk"]), Some("check"));
        assert_eq!(j(&["/Game/Marvel/VFX/Particles/Hero/1026/NS_1026_Hit.uasset", "/Game/Marvel/VFX/Trail/NS_Bullet_Trail.uasset"]), None, "a VFX recolor is fine");
        assert_eq!(j(&["/Game/Marvel/Data/Skin/DT_SkinTable.uasset"]), None, "cosmetic data is fine");
        assert_eq!(j(&["Marvel/Content/WwiseAudio/bnk_sfx_common.bnk", "/Game/Marvel/Camera/Recoil_Rifle.uasset"]), Some("ban"), "the strongest wins");
    }

    #[test]
    fn names_that_say_what_they_remove() {
        assert!(by_name(Path::new("repakxtra-no-screen-shake_9999999_P.pak")).is_some());
        assert!(by_name(Path::new("NoRecoil_P.bak_repak")).is_some());
        assert!(by_name(Path::new("No Impact_P.pak")).is_some());
        assert!(by_name(Path::new("NorthStar_Skin_P.pak")).is_none());
    }

    #[test]
    fn plugins_are_sorted_into_kinds() {
        let t = tempfile::tempdir().unwrap();
        let w = t.path();
        fs::create_dir_all(w.join("plugins")).unwrap();
        fs::write(w.join("plugins/PyStubber.asi"), "x").unwrap();
        fs::write(w.join("plugins/Other.asi"), "x").unwrap();
        fs::write(w.join("winmm.dll"), "x").unwrap();
        fs::write(w.join("Marvel-Win64-Shipping.exe"), "x").unwrap();
        fs::write(w.join("steam_api64.dll"), "x").unwrap();
        let mut got: Vec<_> = plugins_in(w).into_iter().map(|p| (p.name, p.place, p.kind)).collect();
        got.sort();
        assert_eq!(got, [("Other.asi".into(), "plugins".into(), "unknown"), ("PyStubber.asi".into(), "plugins".into(), "banned"), ("winmm.dll".into(), "".into(), "unknown")]);
    }
}
