//! repakxtra: Repak X 2.4.0 renames every mod with a space in its name, each space (any whitespace) becoming "_", at its
//! start and after a Quick Organize install (v2.4.0 main_tauri.rs replace_spaces_in_mod_names), so whatever this app
//! keeps by name loses its mod. On each scan, data saved under a name no installed mod has follows the one installed mod
//! whose name is that name with its spaces as "_": tags, previews, and install records here, loadout members in
//! loadoutIdentity.ts (resolveKeys). Nexus sources need nothing: nexusSource.tsx norm reads a space and "_" as one.
//! Only a single exact match relinks, and the files keep their new names (Repak X would rename them again).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Every whitespace as "_", as Repak X does. In a "<folder>|<name>" key only the name: Repak X renames files, not folders.
fn respaced(key: &str) -> String {
    let at = key.rfind('|').map_or(0, |i| i + 1);
    format!("{}{}", &key[..at], key[at..].replace(char::is_whitespace, "_"))
}

/// (old, new) for each stored key that no installed mod has and whose respaced form is exactly one installed mod's key
/// with nothing stored under it yet. `installed` holds one key per installed mod, so a key there twice is two mods. Two
/// stored keys with one respaced form relink neither. Pure.
pub fn pairs<'a>(stored: impl IntoIterator<Item = &'a String>, installed: &[String]) -> Vec<(String, String)> {
    let stored: HashSet<&str> = stored.into_iter().map(String::as_str).collect();
    let mut mods: HashMap<&str, usize> = HashMap::new();
    for k in installed {
        *mods.entry(k).or_default() += 1;
    }
    let mut by_new: HashMap<String, Vec<&str>> = HashMap::new();
    for &old in &stored {
        let new = respaced(old);
        if new != old && !mods.contains_key(old) && mods.get(new.as_str()) == Some(&1) && !stored.contains(new.as_str()) {
            by_new.entry(new).or_default().push(old);
        }
    }
    let mut out: Vec<(String, String)> = by_new.into_iter().filter(|(_, olds)| olds.len() == 1).map(|(new, olds)| (olds[0].to_string(), new)).collect();
    out.sort();
    out
}

/// After a scan of `root` found `paths`: tags, previews, and install records follow mods renamed this way. Returns
/// whether tags moved (the scan's rows then read them again). Records each relinked mod in the activity log.
pub fn relink(root: &Path, paths: &[PathBuf], state: &Mutex<crate::AppState>) -> bool {
    let keys = |key: fn(&Path) -> String| paths.iter().map(|p| key(p)).collect::<Vec<String>>();

    let tag_keys = keys(crate::get_mod_key);
    let tags = {
        let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
        let moved = pairs(s.mod_tags.keys(), &tag_keys);
        for (old, new) in &moved {
            if let Some(t) = s.mod_tags.remove(old) {
                s.mod_tags.insert(new.clone(), t);
            }
        }
        if !moved.is_empty() {
            let _ = crate::save_state(&s);
        }
        moved
    };

    let preview_keys = keys(crate::xtra_previews::mod_key);
    let stored: Vec<String> = crate::xtra_previews::list_mod_previews().into_iter().filter(|k| !k.contains('@')).collect();
    let mut previews = Vec::new();
    let wanted = pairs(&stored, &preview_keys);
    // a preview run holds the folder: these wait for the next scan
    if let (false, Ok(hold)) = (wanted.is_empty(), crate::xtra_previews::reserve_rename()) {
        for (old, new) in wanted {
            match crate::xtra_previews::migrate_key_with_hold(&hold, &old, &new, false) {
                Ok(Some(_)) => previews.push((old, new)),
                Ok(None) => {}
                Err(e) => log::warn!("[relink] previews of {old} stayed: {e}"),
            }
        }
    }
    if !previews.is_empty() {
        crate::ui_log::send("repakxtra-previews-relinked", &previews); // previews.tsx reloads those keys
    }

    let sources: HashSet<String> = crate::xtra_dupes::relink(root, paths).into_iter().collect();

    let (tags_to, previews_to): (HashSet<&str>, HashSet<&str>) =
        (tags.iter().map(|p| p.1.as_str()).collect(), previews.iter().map(|p| p.1.as_str()).collect());
    let mut names: Vec<String> = paths
        .iter()
        .enumerate()
        .filter(|(i, p)| tags_to.contains(tag_keys[*i].as_str()) || previews_to.contains(preview_keys[*i].as_str()) || sources.contains(&crate::xtra_dupes::key(root, p)))
        .map(|(_, p)| crate::xtra_dupes::bare_name(p))
        .collect();
    names.sort();
    names.dedup();
    if !names.is_empty() {
        crate::ui_log::info("Mods", format!("Relinked {} mod(s) whose spaces became \"_\" outside the app: {}", names.len(), names.join(", ")));
        crate::xtra_activity::record("relink", &names, &[], "");
    }
    !tags.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn a_unique_match_relinks() {
        assert_eq!(pairs(&s(&["My Mod", "Other"]), &s(&["My_Mod", "Other"])), [("My Mod".into(), "My_Mod".into())]);
        // folder keys: the name changes, the folder (spaces and all) stays
        assert_eq!(pairs(&s(&["skins x|my mod"]), &s(&["skins x|my_mod"])), [("skins x|my mod".into(), "skins x|my_mod".into())]);
        // a tab is whitespace too, as in Repak X
        assert_eq!(pairs(&s(&["a\tb"]), &s(&["a_b"])).len(), 1);
    }

    #[test]
    fn two_candidates_relink_nothing() {
        // two installed mods with the new name (name-only keys from two folders)
        assert!(pairs(&s(&["My Mod"]), &s(&["My_Mod", "My_Mod"])).is_empty());
        // two stored names that both turn into it
        assert!(pairs(&s(&["My Mod", "My\tMod"]), &s(&["My_Mod"])).is_empty());
    }

    #[test]
    fn a_different_folder_is_not_a_match() {
        assert!(pairs(&s(&["a|my mod"]), &s(&["b|my_mod"])).is_empty());
    }

    #[test]
    fn nothing_is_overwritten_or_taken_from_an_installed_mod() {
        // the new name already has its own data
        assert!(pairs(&s(&["My Mod", "My_Mod"]), &s(&["My_Mod"])).is_empty());
        // the old name is still installed (Repak X skipped it: the new name was taken)
        assert!(pairs(&s(&["My Mod"]), &s(&["My Mod", "My_Mod"])).is_empty());
        // no space, nothing to follow
        assert!(pairs(&s(&["Gone"]), &s(&["Gone_"])).is_empty());
    }
}
