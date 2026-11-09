//! repakxtra: Why isn't this mod working? (custom/WhyNotWorking.tsx). Everything, from files alone, that keeps one mod
//! from showing in game: switched off, a missing .utoc or .ucas, a name without the _P the game needs, a mods folder
//! outside the game, the bypass or Project Galacta missing, and other enabled mods that replace the same files at a
//! higher priority (the conflict check compares only mods at the same priority, so an overridden mod never shows there).
//! The frontend adds what it already knows: Broken, May crash, and Ban risk badges.
//! Two passes: xtra_why_mod reads only this mod and the game folder (instant), xtra_why_overrides reads every enabled
//! mod's file list (slow on a big library), so the dialog shows the first answers while the second pass runs.
//! xtra_hidden_mods gives Check Conflicts every enabled mod a higher priority one covers.

use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;
use walkdir::WalkDir;

#[derive(Serialize, Debug, PartialEq)]
pub struct Finding {
    /// "problem" (keeps it from loading or showing), "info" (worth knowing), "ok"
    level: &'static str,
    title: String,
    detail: String,
    /// the one-click fix the dialog offers: "turn_on" (the Library's switch), "setup" (opens Setup) or "load_on_top"
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<&'static str>,
    /// load_on_top: the priority that puts it above every mod that wins over it or ties with it
    #[serde(skip_serializing_if = "Option::is_none")]
    priority: Option<usize>,
}

fn f(level: &'static str, title: impl Into<String>, detail: impl Into<String>) -> Finding {
    Finding { level, title: title.into(), detail: detail.into(), action: None, priority: None }
}

impl Finding {
    fn act(mut self, action: &'static str) -> Self {
        self.action = Some(action);
        self
    }
}

/// Load order rank: the nines run (more nines load later and win). None for a "!" name or one without a nines run (the
/// Library's priority 0 for both), whose order against the others the app does not know.
fn rank(path: &Path) -> Option<usize> {
    let stem = path.file_stem()?.to_string_lossy().to_string();
    (!stem.starts_with('!')).then(|| crate::asset_explorer::mod_priority(&stem)).filter(|r| *r > 0)
}

fn name(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
}

/// The checks that need only this mod's own files. `on`: not switched off (.bak_repak).
fn own_checks(path: &Path, mods_dir: &Path) -> Vec<Finding> {
    let mut out = Vec::new();
    let pak = path.with_extension("pak");
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("bak_repak")) {
        out.push(f("problem", "It is switched off", "The game loads it from the next launch once it is on.").act("turn_on"));
    }
    let (utoc, ucas) = (pak.with_extension("utoc").is_file(), pak.with_extension("ucas").is_file());
    if utoc != ucas {
        let (has, lacks) = if utoc { (".utoc", ".ucas") } else { (".ucas", ".utoc") };
        out.push(f("problem", format!("Its {lacks} file is missing"), format!("It has a {has} but no {lacks} beside it, so the game skips it. Install it again from the original download.")));
    }
    let stem = name(&pak);
    if !stem.to_ascii_lowercase().ends_with("_p") {
        out.push(f("problem", "Its name does not end in _P", "The game only lets mods replace its files when the name ends in _P. Rename it (or change its priority, which adds one), then restart the game."));
    }
    let in_game = crate::xtra_broken::paks_dir(mods_dir).is_some_and(|paks| path.starts_with(&paks));
    if !in_game {
        out.push(f("problem", "Your mods folder is outside the game", format!("The game loads mods from Marvel Rivals\\MarvelGame\\Marvel\\Content\\Paks\\~mods. Yours is {}. Change it in Settings.", mods_dir.display())));
    }
    out
}

/// Enabled mods that replace files this one has, at a higher priority (they win) or one the app cannot order ("!").
/// `others`: (path, file keys) of every other enabled mod. Each problem carries Load on top: one priority above the
/// highest mod that wins or ties, so one click fixes them all.
fn overrides(path: &Path, mine: &HashSet<String>, others: &[(PathBuf, HashSet<String>)]) -> Vec<Finding> {
    let my_rank = rank(path);
    let mut out = Vec::new();
    let mut top = None;
    for (other, keys) in others {
        let shared = mine.intersection(keys).count();
        if shared == 0 {
            continue;
        }
        let what = format!("{shared} of its {} files", mine.len());
        if let (Some(a), Some(b)) = (my_rank, rank(other)) {
            if b >= a {
                top = top.max(Some(b));
            }
        }
        match (my_rank, rank(other)) {
            (Some(a), Some(b)) if b > a => out.push(f("problem", format!("{} wins over it", name(other)),
                format!("{} replaces {what} at a higher priority ({b} against {a}), so the game shows that mod's versions. Turn one off or give this one a higher priority.", name(other)))),
            (Some(a), Some(b)) if a == b => out.push(f("problem", format!("It clashes with {}", name(other)),
                format!("Both replace {what} at the same priority, so only one of them shows. Turn one off or give the one you want a higher priority."))),
            (Some(_), Some(_)) => {} // this one wins
            _ => out.push(f("info", format!("It shares files with {}", name(other)),
                format!("Both replace {what}. A name starting with ! loads in its own order, so the one you want may lose. Give it a higher priority to be sure."))),
        }
    }
    if let Some(top) = top {
        for x in out.iter_mut().filter(|x| x.level == "problem") {
            x.action = Some("load_on_top");
            x.priority = Some(top + 1);
        }
    }
    out
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Hidden {
    hidden: String,
    winner: String,
    /// the shared files, in the hidden mod's own spelling
    files: Vec<String>,
}

/// Every pair where an enabled mod replaces files of another at a higher priority, so the lower one is hidden there.
/// Mods whose order the app cannot know ("!") are left out, as in `overrides`.
fn hidden_pairs(mods: &[(PathBuf, Arc<Vec<String>>)]) -> Vec<Hidden> {
    let ranks: Vec<_> = mods.iter().map(|(p, _)| rank(p)).collect();
    let mut owners: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, (_, files)) in mods.iter().enumerate() {
        if ranks[i].is_some() {
            for k in keys(files) {
                owners.entry(k).or_default().push(i);
            }
        }
    }
    let mut pairs: BTreeMap<(usize, usize), HashSet<&str>> = BTreeMap::new(); // (hidden, winner) -> shared keys
    for (k, list) in owners.iter().filter(|(_, l)| l.len() > 1) {
        for &a in list {
            for &b in list {
                if ranks[b] > ranks[a] {
                    pairs.entry((a, b)).or_default().insert(k.as_str());
                }
            }
        }
    }
    pairs.into_iter().map(|((a, b), shared)| {
        let mut files: Vec<String> = mods[a].1.iter().filter(|f| shared.contains(crate::xtra_conflicts::asset_key(f).as_str())).cloned().collect();
        files.sort();
        files.dedup();
        Hidden { hidden: mods[a].0.to_string_lossy().into(), winner: mods[b].0.to_string_lossy().into(), files }
    }).collect()
}

/// Every enabled mod's file list (cached by size and date, as the conflict check does).
fn enabled(mods_dir: &Path) -> Vec<(PathBuf, Arc<Vec<String>>)> {
    WalkDir::new(mods_dir).into_iter().filter_entry(crate::xtra_bundle::library_walk).filter_map(Result::ok)
        .map(|e| e.into_path())
        .filter(|p| p.extension().is_some_and(|e| e == "pak") && !crate::xtra_builtins::is_own(p) && !crate::xtra_setup::is_managed_loader(p))
        // a .utoc without its .ucas (or the reverse) is skipped by the game, so it wins over nothing
        .filter(|p| p.with_extension("utoc").is_file() == p.with_extension("ucas").is_file())
        .filter_map(|p| Some((p.clone(), files_of(&p)?)))
        .collect()
}

fn files_of(pak: &Path) -> Option<Arc<Vec<String>>> {
    let utoc = pak.with_extension("utoc");
    crate::xtra_conflicts::files_cached(pak, utoc.exists().then_some(utoc.as_path()), || Ok(crate::xtra_crash::mod_files(pak))).ok()
}

fn keys(files: &[String]) -> HashSet<String> {
    files.iter().map(|f| crate::xtra_conflicts::asset_key(f)).filter(|k| !k.ends_with("patched_files") && !k.is_empty()).collect()
}

#[tauri::command]
pub async fn xtra_why_mod(mod_path: String, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<Vec<Finding>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&mod_path);
        let mods_dir = state.lock().unwrap().game_path.clone();
        let mut out = own_checks(&path, &mods_dir);
        if let Some(win64) = crate::xtra_setup::win64_dir(&mods_dir) {
            match crate::xtra_setup::bypass_state(&win64).as_str() {
                "installed" | "other" => {}
                "disabled" => out.push(f("problem", "The signature bypass is off", "No mod loads without it. Turn it on in Setup.").act("setup")),
                _ => out.push(f("problem", "The signature bypass is not installed", "No mod loads without it. Install it in Setup.").act("setup")),
            }
        }
        let details = crate::compute_mod_details(&path, &state).ok();
        if let Some(d) = &details {
            if d.mod_type.contains("Project Galacta") && !crate::xtra_setup::is_managed_loader(&path) && !crate::xtra_setup::galacta_on(&mods_dir) {
                out.push(f("problem", "It needs Project Galacta", "This is a Galacta version of a mod. Install Project Galacta or turn it on in Setup.").act("setup"));
            }
            if d.category == "Unknown" {
                let top: Vec<String> = d.files.iter().filter_map(|x| {
                    let k = crate::xtra_conflicts::asset_key(x);
                    let parts: Vec<&str> = k.split('/').filter(|s| !s.is_empty()).collect();
                    (parts.len() > 2).then(|| parts[..parts.len().min(3)].join("/"))
                }).collect::<std::collections::BTreeSet<_>>().into_iter().take(3).collect();
                out.push(f("info", "Its type is Unknown",
                    format!("Unknown only means repakxtra could not tell what kind of mod it is from its files{}. It does not stop the mod from loading.",
                        if top.is_empty() { String::new() } else { format!(" (they are in {})", top.join(", ")) })));
            }
        }
        if crate::is_game_process_running() {
            out.push(f("info", "The game is running", "Changes to mods load from the next game launch."));
        }
        Ok(out)
    }).await.map_err(|e| e.to_string())?
}

/// The second pass: other enabled mods that replace this one's files at a higher or the same priority.
#[tauri::command]
pub async fn xtra_why_overrides(mod_path: String, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<Vec<Finding>, String> {
    let mods_dir = state.lock().unwrap().game_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&mod_path);
        // only an enabled mod is overridden: one that is off loses to nothing, it simply does not load
        if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("bak_repak")) {
            return Vec::new();
        }
        let me = path.with_extension("pak");
        let Some(mine) = files_of(&me) else { return Vec::new() };
        let others: Vec<_> = enabled(&mods_dir).into_iter().filter(|(p, _)| *p != me).map(|(p, f)| (p, keys(&f))).collect();
        let mut out = overrides(&path, &keys(&mine), &others);
        // a built-in keeps its name, and set_mod_priority only rewrites a name ending in exactly _P (another would get a
        // second suffix), so neither gets Load on top
        if crate::xtra_builtins::in_folder(&path) || !path.file_stem().is_some_and(|s| s.to_string_lossy().ends_with("_P")) {
            out.iter_mut().for_each(|x| { x.action = None; x.priority = None });
        }
        out
    }).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn xtra_hidden_mods(state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<Vec<Hidden>, String> {
    let mods_dir = state.lock().unwrap().game_path.clone();
    tauri::async_runtime::spawn_blocking(move || hidden_pairs(&enabled(&mods_dir))).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(keys: &[&str]) -> HashSet<String> {
        keys.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn own_problems() {
        let t = tempfile::tempdir().unwrap();
        let mods = t.path().join("Content").join("Paks").join("~mods");
        std::fs::create_dir_all(&mods).unwrap();
        let ok = mods.join("Good_9999999_P.pak");
        for ext in ["pak", "utoc", "ucas"] {
            std::fs::write(ok.with_extension(ext), "x").unwrap();
        }
        assert!(own_checks(&ok, &mods).is_empty(), "a complete mod in the game folder is fine");
        let bad = mods.join("Bad.bak_repak");
        std::fs::write(&bad, "x").unwrap();
        std::fs::write(bad.with_extension("utoc"), "x").unwrap();
        let titles: Vec<_> = own_checks(&bad, &mods).into_iter().map(|x| x.title).collect();
        assert_eq!(titles, ["It is switched off", "Its .ucas file is missing", "Its name does not end in _P"]);
        let outside = t.path().join("Elsewhere").join("A_P.pak");
        assert_eq!(own_checks(&outside, &t.path().join("Elsewhere")).len(), 1, "a custom folder outside the game");
    }

    #[test]
    fn higher_priority_wins() {
        let mine = set(&["a", "b"]);
        let others = vec![
            (PathBuf::from("High_99999999_P.pak"), set(&["a"])),
            (PathBuf::from("Low_P.pak"), set(&["b"])),
            (PathBuf::from("Same_9999999_P.pak"), set(&["b"])),
            (PathBuf::from("Apart_99999999_P.pak"), set(&["z"])),
            (PathBuf::from("!Bang_P.pak"), set(&["a"])),
        ];
        let got: Vec<_> = overrides(Path::new("Me_9999999_P.pak"), &mine, &others).into_iter().map(|x| (x.level, x.title, x.priority)).collect();
        assert_eq!(got, [
            ("problem", "High_99999999_P wins over it".to_string(), Some(3)),
            ("info", "It shares files with Low_P".to_string(), None),
            ("problem", "It clashes with Same_9999999_P".to_string(), Some(3)),
            ("info", "It shares files with !Bang_P".to_string(), None),
        ], "Load on top goes one above the highest mod that wins");
    }

    #[test]
    fn hidden_by_higher_priority() {
        let m = |name: &str, files: &[&str]| (PathBuf::from(name), Arc::new(files.iter().map(|s| s.to_string()).collect::<Vec<_>>()));
        let mods = [
            m("Addon_9999999_P.pak", &["/Game/Marvel/Characters/1026/MI_A.uasset", "/Game/Marvel/Characters/1026/MI_B.uasset"]),
            m("Base_999999999_P.pak", &["Marvel/Content/Marvel/Characters/1026/MI_A.uasset"]),
            m("Peer_9999999_P.pak", &["/Game/Marvel/Characters/1026/MI_B.uasset"]),
            m("!Bang_P.pak", &["/Game/Marvel/Characters/1026/MI_A.uasset"]),
        ];
        let got = hidden_pairs(&mods);
        assert_eq!(got, [Hidden { hidden: "Addon_9999999_P.pak".into(), winner: "Base_999999999_P.pak".into(), files: vec!["/Game/Marvel/Characters/1026/MI_A.uasset".into()] }],
            "a higher priority hides, the same priority is a conflict, a ! mod is left out");
    }
}
