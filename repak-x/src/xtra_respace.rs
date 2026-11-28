//! repakxtra: Repak X 2.4.0 renames every mod with a space in its name, each space (any whitespace) becoming "_", at its
//! start and after a Quick Organize install (v2.4.0 main_tauri.rs replace_spaces_in_mod_names), so whatever this app
//! keeps by name loses its mod. On each scan, data saved under a name no installed mod has follows the one installed mod
//! whose name is that name with its spaces as "_": tags, previews, and install records here, loadout members in
//! loadoutIdentity.ts (resolveKeys). Nexus sources need nothing: nexusSource.tsx norm reads a space and "_" as one.
//! Only a single exact match relinks, and the files keep their new names (Repak X would rename them again). Mods renamed
//! or moved outside the app any other way (xtra_fingerprints.rs) follow the same path, as `moved` pairs.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Every whitespace as "_", as Repak X does. In a "<folder>|<name>" key only the name: Repak X renames files, not folders.
fn respaced(key: &str) -> String {
    let at = key.rfind('|').map_or(0, |i| i + 1);
    format!("{}{}", &key[..at], key[at..].replace(char::is_whitespace, "_"))
}

/// (old, new) for each stored key that no installed mod has and whose respaced form, or its new key in `moved`, is
/// exactly one installed mod's key with nothing stored under it yet. `installed` holds one key per installed mod, so a
/// key there twice is two mods. Two stored keys with one new key relink neither, nor does one stored key with two. Pure.
pub fn pairs<'a>(stored: impl IntoIterator<Item = &'a String>, installed: &[String], moved: &[(String, String)]) -> Vec<(String, String)> {
    let stored: HashSet<&str> = stored.into_iter().map(String::as_str).collect();
    let mut mods: HashMap<&str, usize> = HashMap::new();
    for k in installed {
        *mods.entry(k).or_default() += 1;
    }
    let mut by_new: HashMap<String, HashSet<&str>> = HashMap::new();
    let from_moves = moved.iter().filter_map(|(o, n)| stored.get(o.as_str()).map(|&old| (old, n.clone())));
    for (old, new) in stored.iter().map(|&old| (old, respaced(old))).chain(from_moves) {
        if new != old && !mods.contains_key(old) && mods.get(new.as_str()) == Some(&1) && !stored.contains(new.as_str()) {
            by_new.entry(new).or_default().insert(old);
        }
    }
    let mut out: Vec<(String, String)> = by_new.into_iter().filter_map(|(new, olds)| (olds.len() == 1).then(|| (olds.into_iter().next().unwrap_or_default().to_string(), new))).collect();
    let mut olds: HashMap<String, usize> = HashMap::new();
    out.iter().for_each(|(o, _)| *olds.entry(o.clone()).or_default() += 1);
    out.retain(|(o, _)| olds[o] == 1);
    out.sort();
    out
}

/// After a full scan of `root` found `paths` (`era`: xtra_mutation::era before the walk): tags, previews, and install records follow mods renamed this way. The
/// mods whose tags or previews followed go in the activity log (install records are not shown anywhere). False when it
/// could not look (then loadouts wait too).
pub fn relink(root: &Path, paths: &[PathBuf], state: &Arc<Mutex<crate::AppState>>, era: Option<u64>) -> bool {
    // a mod change (a restore, a VFX update moving a file aside, a toggle) that ran during the walk (`era` is from before
    // it) or runs now may have left the walk a half-done folder: the next scan relinks. Holding the gate
    // keeps restores and cleanups out until it is done, without counting as one (scans beside it stay quiet).
    let Some(_reading) = crate::xtra_mutation::reading() else { return false };
    if era.is_none() || crate::xtra_mutation::era() != era {
        return false;
    }
    let keys = |key: &dyn Fn(&Path) -> String| paths.iter().map(|p| key(p)).collect::<Vec<String>>();
    // mods renamed or moved outside the app (xtra_fingerprints.rs), (old path, new path): those found now and, again,
    // those found in the last 7 days, so a store that had to wait (a preview run holding the folder) follows on a later
    // scan. Each store keys them its own way, and `pairs` never moves anything twice (the old key must still hold data).
    let mut found = crate::xtra_fingerprints::scan(root, paths, state);
    let fresh = found.len(); // found by this scan; the rest are replays
    for (p, from) in paths.iter().zip(crate::xtra_fingerprints::relinked_from(root, paths, state)) {
        if let Some(from) = from.filter(|_| !found.iter().any(|(_, n)| n == p)) {
            found.push((from, p.clone()));
        }
    }
    let moved = |key: &dyn Fn(&Path) -> String| found.iter().map(|(o, n)| (key(o), key(n))).collect::<Vec<_>>();

    let tag_key = |p: &Path| crate::xtra_dupes::key(root, p);
    let tag_keys = keys(&tag_key);
    let legacy_keys = keys(&crate::get_mod_key);
    let tags = {
        let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
        // a mod found renamed onto a gone mod's key by this scan (deleted, its tags kept) takes the key, those tags were
        // not this file's (a replay keeps the guard: by then the key's tags are the moved mod's own); and an empty list only
        // holds a key's place while its old tags wait: neither refuses a move there
        let tag_moves = moved(&tag_key);
        let taken: HashSet<&String> = tag_moves[..fresh].iter().filter(|(o, _)| s.mod_tags_by_key.get(o).is_some_and(|t| !t.is_empty())).map(|(_, n)| n).collect();
        let held: Vec<String> = s.mod_tags_by_key.iter().filter(|(k, t)| !t.is_empty() && !taken.contains(k)).map(|(k, _)| k.clone()).collect();
        // and an untagged mod found renamed onto such a key (this scan) brings no tags: the gone mod's leave the key
        let installed: HashSet<&String> = tag_keys.iter().collect();
        let untagged: Vec<String> = tag_moves[..fresh]
            .iter()
            .filter(|(o, n)| !installed.contains(o) && s.mod_tags_by_key.get(o).map_or(true, |t| t.is_empty()) && s.mod_tags_by_key.get(n).is_some_and(|t| !t.is_empty()))
            .map(|(_, n)| n.clone())
            .collect();
        let mut moved = pairs(&held, &tag_keys, &tag_moves);
        for (old, new) in &moved {
            if let Some(t) = s.mod_tags_by_key.remove(old) {
                s.mod_tags_by_key.insert(new.clone(), t);
            }
        }
        for n in untagged {
            s.mod_tags_by_key.remove(&n);
            moved.push((String::new(), n)); // mirrored below like a move
        }
        // the old map's names Repak X respaced, not migrated yet, follow too (their tags wait there for the migration). A
        // migrated name's tags already followed above, by key: moving its old entry too would give them to a namesake.
        // Never onto a mod found renamed or moved: that file is another mod, not the respaced one.
        let arrived: HashSet<String> = found.iter().map(|(_, n)| crate::get_mod_key(n)).collect();
        let mut legacy = pairs(s.mod_tags.keys(), &legacy_keys, &[]);
        legacy.retain(|(old, new)| !s.mod_tags_migrated.contains(old) && !arrived.contains(new));
        for (old, new) in &legacy {
            if let Some(t) = s.mod_tags.remove(old) {
                s.mod_tags.insert(new.clone(), t);
            }
        }
        // a mod found renamed or moved is not a new mod named like old tags still waiting: they are never its own
        for (_, n) in &found {
            if crate::xtra_tags::unmigrated(&s, &crate::get_mod_key(n)) {
                s.mod_tags_by_key.entry(tag_key(n)).or_default();
            }
        }
        let migrated = crate::xtra_tags::migrate(&mut s, root, paths); // older saves' name-only tags, once
        // and it mirrors both names of each mod whose tags moved
        for (o, n) in &found {
            if moved.iter().any(|(_, new)| *new == tag_key(n)) {
                crate::xtra_tags::mirror(&mut s, o);
            }
        }
        for (i, p) in paths.iter().enumerate() {
            if moved.iter().any(|(_, new)| *new == tag_keys[i]) {
                crate::xtra_tags::mirror(&mut s, p);
            }
        }
        if migrated || !moved.is_empty() || !legacy.is_empty() {
            let _ = crate::save_state(&s);
        }
        moved
    };

    let preview_keys = keys(&crate::xtra_previews::mod_key);
    let preview_moved = moved(&crate::xtra_previews::mod_key);
    // a key's other forms ("<key>@2") move with it: never while a mod named like one of the old or new forms is installed
    let form = |k: &str| k.rsplit_once('@').is_some_and(|(_, n)| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()));
    let wanted = || -> Vec<(String, String)> {
        let stored: Vec<String> = crate::xtra_previews::list_mod_previews().into_iter().filter(|k| !form(k)).collect();
        pairs(&stored, &preview_keys, &preview_moved)
            .into_iter()
            .filter(|(old, new)| !preview_keys.iter().any(|k| [old, new].iter().any(|o| k.strip_prefix(o.as_str()).is_some_and(|r| r.starts_with('@') && form(r)))))
            .collect()
    };
    let mut previews = Vec::new();
    // looked at again under the hold, so a scan beside this one never moves the same previews twice; a preview run
    // holds the folder, and these wait for the next scan
    let hold = if wanted().is_empty() { None } else { crate::xtra_previews::reserve_rename().ok() };
    if let Some(hold) = hold {
        for (old, new) in wanted() {
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

    let sources = crate::xtra_dupes::relink(root, paths, &moved(&tag_key)).len();
    crate::details_after_scan(state, &found);

    let (tags_to, previews_to): (HashSet<&str>, HashSet<&str>) =
        (tags.iter().map(|p| p.1.as_str()).collect(), previews.iter().map(|p| p.1.as_str()).collect());
    let mut names: Vec<String> = paths
        .iter()
        .enumerate()
        .filter(|(i, _)| tags_to.contains(tag_keys[*i].as_str()) || previews_to.contains(preview_keys[*i].as_str()))
        .map(|(_, p)| crate::xtra_dupes::bare_name(p))
        .collect();
    names.sort();
    names.dedup();
    if !names.is_empty() || sources > 0 {
        let shown = names.iter().take(20).cloned().collect::<Vec<_>>().join(", ");
        let more = if names.len() > 20 { format!(" and {} more", names.len() - 20) } else { String::new() };
        crate::ui_log::info("Mods", format!("Relinked {} mod(s) and {sources} install record(s) renamed or moved since the last scan: {shown}{more}", names.len()));
    }
    if !names.is_empty() {
        crate::xtra_activity::record("relink", &names, &[], "");
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs2<'a>(stored: impl IntoIterator<Item = &'a String>, installed: &[String]) -> Vec<(String, String)> {
        pairs(stored, installed, &[])
    }

    #[test]
    fn a_moved_key_relinks_like_a_respaced_one() {
        let mv = |o: &str, n: &str| vec![(o.to_string(), n.to_string())];
        assert_eq!(pairs(&s(&["a|skin"]), &s(&["b|hat"]), &mv("a|skin", "b|hat")), [("a|skin".into(), "b|hat".into())]);
        // nothing stored, the new key has its own, or the old one is still installed: no relink
        assert!(pairs(&s(&["x"]), &s(&["b|hat"]), &mv("a|skin", "b|hat")).is_empty());
        assert!(pairs(&s(&["a|skin", "b|hat"]), &s(&["b|hat"]), &mv("a|skin", "b|hat")).is_empty());
        assert!(pairs(&s(&["a|skin"]), &s(&["a|skin", "b|hat"]), &mv("a|skin", "b|hat")).is_empty());
        // one stored key told two ways (respaced and moved): neither
        assert!(pairs(&s(&["a|my mod"]), &s(&["a|my_mod", "b|x"]), &mv("a|my mod", "b|x")).is_empty());
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn a_unique_match_relinks() {
        assert_eq!(pairs2(&s(&["My Mod", "Other"]), &s(&["My_Mod", "Other"])), [("My Mod".into(), "My_Mod".into())]);
        // folder keys: the name changes, the folder (spaces and all) stays
        assert_eq!(pairs2(&s(&["skins x|my mod"]), &s(&["skins x|my_mod"])), [("skins x|my mod".into(), "skins x|my_mod".into())]);
        // a tab is whitespace too, as in Repak X
        assert_eq!(pairs2(&s(&["a\tb"]), &s(&["a_b"])).len(), 1);
    }

    #[test]
    fn two_candidates_relink_nothing() {
        // two installed mods with the new name (name-only keys from two folders)
        assert!(pairs2(&s(&["My Mod"]), &s(&["My_Mod", "My_Mod"])).is_empty());
        // two stored names that both turn into it
        assert!(pairs2(&s(&["My Mod", "My\tMod"]), &s(&["My_Mod"])).is_empty());
    }

    #[test]
    fn a_different_folder_is_not_a_match() {
        assert!(pairs2(&s(&["a|my mod"]), &s(&["b|my_mod"])).is_empty());
    }

    #[test]
    fn nothing_is_overwritten_or_taken_from_an_installed_mod() {
        // the new name already has its own data
        assert!(pairs2(&s(&["My Mod", "My_Mod"]), &s(&["My_Mod"])).is_empty());
        // the old name is still installed (Repak X skipped it: the new name was taken)
        assert!(pairs2(&s(&["My Mod"]), &s(&["My Mod", "My_Mod"])).is_empty());
        // no space, nothing to follow
        assert!(pairs2(&s(&["Gone"]), &s(&["Gone_"])).is_empty());
    }
}
