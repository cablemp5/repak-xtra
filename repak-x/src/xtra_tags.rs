//! repakxtra: tags by mod, keyed by xtra_dupes::key (folder + name) in `mod_tags_by_key`, so same-named mods in two
//! folders keep their own tags. The old `mod_tags` (by bare name, main_tauri.rs get_mod_key) stays for older builds:
//! each change here writes that name's tags into it (all of them, `mirror`), and its names are copied into the new map
//! once, on a full scan that finds them (`migrate`): a name in two folders gives both its tags, and a name no mod has
//! stays until one does. Until then a mod shows its name's old tags (`of`), and a change keeps them. An older build
//! saving the state drops the new fields, and the next scan migrates again from the old one.

use std::path::Path;

/// The tags key of a mod path: xtra_dupes::key under the mods folder.
pub fn key(s: &crate::AppState, path: &Path) -> String {
    crate::xtra_dupes::key(&s.game_path, path)
}

/// An old-map name not copied into the new map yet.
fn unmigrated(s: &crate::AppState, legacy: &str) -> bool {
    s.mod_tags.contains_key(legacy) && !s.mod_tags_migrated.contains(legacy)
}

/// A mod's tags: by its key, else (its name not migrated yet) its name's old tags.
pub fn of(s: &crate::AppState, path: &Path) -> Vec<String> {
    if let Some(t) = s.mod_tags_by_key.get(&key(s, path)) {
        return t.clone();
    }
    let legacy = crate::get_mod_key(path);
    if unmigrated(s, &legacy) { s.mod_tags[&legacy].clone() } else { Vec::new() }
}

/// Sets a mod's tags (none removes the entry) and mirrors its name into the old map.
pub fn set(s: &mut crate::AppState, path: &Path, tags: Vec<String>) {
    let k = key(s, path);
    if tags.is_empty() {
        s.mod_tags_by_key.remove(&k);
    } else {
        s.mod_tags_by_key.insert(k, tags);
    }
    mirror(s, path);
}

/// The old map's entry for `path`'s name becomes every tag of the mods with that name (case and "!" aside), and the name
/// counts as migrated (so a new tag never reaches a namesake in another folder through it). A name whose old tags are
/// not migrated yet is left alone: the migration still has to give them to every mod of that name.
pub fn mirror(s: &mut crate::AppState, path: &Path) {
    let legacy = crate::get_mod_key(path);
    if unmigrated(s, &legacy) {
        return;
    }
    let k = key(s, path);
    let name = &k[k.rfind('|').map_or(0, |i| i + 1)..];
    let mut all: Vec<String> = s.mod_tags_by_key.iter().filter(|(o, _)| o.rsplit('|').next() == Some(name)).flat_map(|(_, t)| t.clone()).collect();
    all.sort();
    all.dedup();
    if all.is_empty() {
        s.mod_tags.remove(&legacy);
    } else {
        s.mod_tags.insert(legacy.clone(), all);
    }
    s.mod_tags_migrated.insert(legacy);
}

/// A mod's tags follow it to `new` (an in-app rename or move). `copy` keeps them at `old` too. False when nothing moved
/// (none there, or `new` has its own).
pub fn moved(s: &mut crate::AppState, old: &Path, new: &Path, copy: bool) -> bool {
    let (from, to) = (key(s, old), key(s, new));
    if from == to || s.mod_tags_by_key.contains_key(&to) {
        return false;
    }
    let t = if copy { s.mod_tags_by_key.get(&from).cloned() } else { s.mod_tags_by_key.remove(&from) };
    t.map(|t| s.mod_tags_by_key.insert(to, t)).is_some()
}

/// An in-app rename or update put the mod at `old` at `new`: its tags follow (`moved`), and the old map's names are
/// mirrored. A name whose old tags are not migrated yet moves in the old map as before (unless `new`'s name has its
/// own). True when anything changed.
pub fn renamed(s: &mut crate::AppState, old: &Path, new: &Path) -> bool {
    let mut changed = moved(s, old, new, false);
    let (from, to) = (crate::get_mod_key(old), crate::get_mod_key(new));
    if from != to && unmigrated(s, &from) {
        if !s.mod_tags.contains_key(&to) {
            let t = s.mod_tags.remove(&from).unwrap_or_default();
            s.mod_tags.insert(to, t);
            changed = true;
        }
    } else if changed {
        mirror(s, old);
        mirror(s, new);
    }
    changed
}

/// The tags of every mod in folder `old` (relative to the mods folder, "/" between parts) and below follow it to `new`.
pub fn folder_moved(s: &mut crate::AppState, old: &str, new: &str) {
    let (old, new) = (old.trim_matches('/').to_lowercase(), new.trim_matches('/').to_lowercase());
    let under = |k: &str| k.strip_prefix(old.as_str()).filter(|r| r.starts_with('|') || r.starts_with('/')).map(str::to_string);
    let keys: Vec<(String, String)> = s.mod_tags_by_key.keys().filter_map(|k| under(k).map(|r| (k.clone(), format!("{new}{r}")))).collect();
    for (from, to) in keys {
        if !s.mod_tags_by_key.contains_key(&to) {
            if let Some(t) = s.mod_tags_by_key.remove(&from) {
                s.mod_tags_by_key.insert(to, t);
            }
        }
    }
}

/// Copies the old map's names into the new map for the installed mods at `paths` (a whole scan of `root`, never one
/// that missed a folder), each once. A key that already has tags keeps them. Nothing when the game path is no longer
/// `root`. True when anything changed.
pub fn migrate(s: &mut crate::AppState, root: &Path, paths: &[std::path::PathBuf]) -> bool {
    if s.game_path != root {
        return false;
    }
    let mut changed = false;
    for p in paths {
        let legacy = crate::get_mod_key(p);
        if s.mod_tags_migrated.contains(&legacy) {
            continue;
        }
        if let Some(t) = s.mod_tags.get(&legacy).cloned() {
            let k = key(s, p);
            s.mod_tags_by_key.entry(k).or_insert(t);
            changed = true;
        }
    }
    // marked after every path, so a name in two folders gives both its tags
    for p in paths {
        let legacy = crate::get_mod_key(p);
        if s.mod_tags.contains_key(&legacy) {
            changed |= s.mod_tags_migrated.insert(legacy);
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn st() -> crate::AppState {
        crate::AppState { game_path: PathBuf::from("C:/G/~mods"), ..Default::default() }
    }
    fn root() -> PathBuf {
        PathBuf::from("C:/G/~mods")
    }
    fn p(rel: &str) -> PathBuf {
        PathBuf::from("C:/G/~mods").join(rel)
    }
    fn tags(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn migration_gives_a_name_in_two_folders_to_both_and_keeps_unmatched_names() {
        let mut s = st();
        s.mod_tags.insert("Skin".into(), tags(&["red"]));
        s.mod_tags.insert("Gone".into(), tags(&["old"]));
        let paths = [p("A/Skin_9999999_P.pak"), p("B/Skin.bak_repak"), p("Other.pak")];
        assert!(migrate(&mut s, &root(), &paths));
        assert_eq!(of(&s, &paths[0]), tags(&["red"]));
        assert_eq!(of(&s, &paths[1]), tags(&["red"]));
        assert!(of(&s, &paths[2]).is_empty());
        assert_eq!(s.mod_tags["Gone"], tags(&["old"]), "the old map is never changed by a migration");
        assert!(!s.mod_tags_migrated.contains("Gone"), "a name no mod has waits for one");
        // once: removing one folder's tags never brings them back from the old map
        set(&mut s, &paths[0], vec![]);
        assert!(!migrate(&mut s, &root(), &paths) && of(&s, &paths[0]).is_empty());
        // the gone name's mod comes back
        assert!(migrate(&mut s, &root(), &[p("C/Gone.pak")]));
        assert_eq!(of(&s, &p("C/Gone.pak")), tags(&["old"]));
    }

    #[test]
    fn before_the_migration_a_mod_shows_and_keeps_its_old_tags() {
        let mut s = st();
        s.mod_tags.insert("Skin".into(), tags(&["red"]));
        assert_eq!(of(&s, &p("A/Skin.pak")), tags(&["red"]), "a scan that missed a folder never migrated it");
        set(&mut s, &p("A/Skin.pak"), tags(&["red", "new"]));
        assert_eq!(s.mod_tags["Skin"], tags(&["red"]), "the old map keeps the name's tags for the migration");
        assert!(migrate(&mut s, &root(), &[p("A/Skin.pak"), p("B/Skin.pak")]));
        assert_eq!(of(&s, &p("A/Skin.pak")), tags(&["red", "new"]));
        assert_eq!(of(&s, &p("B/Skin.pak")), tags(&["red"]));
        // a scan of another mods folder (the game path changed meanwhile) migrates nothing
        let mut other = st();
        other.mod_tags.insert("Skin".into(), tags(&["red"]));
        assert!(!migrate(&mut other, &PathBuf::from("D:/old"), &[PathBuf::from("D:/old/Skin.pak")]) && other.mod_tags_migrated.is_empty());
    }

    #[test]
    fn a_rename_mirrors_both_names_into_the_old_map() {
        let mut s = st();
        set(&mut s, &p("A/Skin.pak"), tags(&["a"]));
        set(&mut s, &p("B/Skin.pak"), tags(&["b"]));
        assert!(moved(&mut s, &p("A/Skin.pak"), &p("A/Hat.pak"), false));
        mirror(&mut s, &p("A/Skin.pak"));
        mirror(&mut s, &p("A/Hat.pak"));
        assert_eq!(s.mod_tags["Skin"], tags(&["b"]));
        assert_eq!(s.mod_tags["Hat"], tags(&["a"]));
        // so an untagged B/Hat gets nothing from it after an older build's save
        s.mod_tags_by_key.clear();
        s.mod_tags_migrated.clear();
        migrate(&mut s, &root(), &[p("A/Hat.pak"), p("B/Skin.pak")]);
        assert_eq!(of(&s, &p("B/Skin.pak")), tags(&["b"]));
    }

    #[test]
    fn same_names_in_two_folders_hold_their_own_tags_and_the_old_map_gets_both() {
        let mut s = st();
        set(&mut s, &p("A/Skin.pak"), tags(&["a"]));
        set(&mut s, &p("B/Skin.pak"), tags(&["b"]));
        assert_eq!(of(&s, &p("A/Skin.pak")), tags(&["a"]));
        assert_eq!(of(&s, &p("B/Skin.pak")), tags(&["b"]));
        assert_eq!(s.mod_tags["Skin"], tags(&["a", "b"]));
        // a new name tagged in one folder never reaches its namesake through the old map
        assert!(!migrate(&mut s, &root(), &[p("A/Skin.pak"), p("C/Skin.pak")]));
        assert!(of(&s, &p("C/Skin.pak")).is_empty());
        set(&mut s, &p("A/Skin.pak"), vec![]);
        set(&mut s, &p("B/Skin.pak"), vec![]);
        assert!(!s.mod_tags.contains_key("Skin"));
    }

    #[test]
    fn tags_follow_in_app_moves_and_folder_moves() {
        let mut s = st();
        set(&mut s, &p("A/Skin.pak"), tags(&["a"]));
        set(&mut s, &p("A/Sub/Hat.pak"), tags(&["h"]));
        set(&mut s, &p("AB/Skin.pak"), tags(&["ab"]));
        assert!(moved(&mut s, &p("A/Skin.pak"), &p("Skin.pak"), false));
        assert_eq!(of(&s, &p("Skin.pak")), tags(&["a"]));
        assert!(!moved(&mut s, &p("AB/Skin.pak"), &p("Skin.pak"), false), "never over another mod's tags");
        folder_moved(&mut s, "A", "Z/A");
        assert_eq!(of(&s, &p("Z/A/Sub/Hat.pak")), tags(&["h"]));
        assert_eq!(of(&s, &p("AB/Skin.pak")), tags(&["ab"]), "a folder that only starts with the name stays");
    }
}
