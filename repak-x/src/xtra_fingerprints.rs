//! repakxtra: finds mods renamed or moved outside the app (Explorer, another mod manager), the idea of Repak X v2.4.0's
//! mod_db/reconcile.rs without its database. Every full scan records each mod's stamp (size and modified time of its
//! .pak, .utoc and .ucas, which a rename or move keeps) and, off the scan, a hash of its file list, by its key
//! (xtra_dupes::key, folder + name) and per mods folder, in repakxtra-state.json. A key that went and one that came
//! with the same stamp, one each, and the same file list, are one mod: xtra_respace.rs moves its tags, previews, and
//! install records, loadoutStore.ts its loadout memberships, and nexusSource.tsx its source. Two identical copies share
//! a stamp, so they never relink (nor swap). A record no scan finds is kept 7 days, then forgotten (its tags stay).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// A record no scan finds is kept this long (seconds), so a mod moved while the app was closed is still found
pub const ORPHAN_SECS: u64 = 7 * 24 * 3600;

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct Print {
    /// Where it is, relative to the mods folder with "/", as on disk
    pub path: String,
    pub stamp: String,
    /// Its file list's hash, filled in off the scan (`fill`); None until then, or after its files changed
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    /// Since when (Unix seconds) no scan found it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_since: Option<u64>,
    /// The path it had before its last relink and when (Unix seconds): every scan for 7 days reports it, so a mod list
    /// the frontend skipped (a newer one came) cannot lose a loadout's move
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<(String, u64)>,
}

/// The records of one mods folder, by key.
pub type Prints = BTreeMap<String, Print>;

/// One mod a scan found: its key, path relative to the mods folder, and stamp.
pub struct Found {
    pub key: String,
    pub path: String,
    pub stamp: String,
}

/// The mod's .utoc or .ucas, also in its off forms (".utoc.bak_repak", install_mod_logic.rs).
fn part(pak: &Path, ext: &str) -> Option<PathBuf> {
    let on = crate::xtra_bundle::companion(pak, ext);
    let named = |tail: &str| on.with_file_name(format!("{}{tail}", on.file_name().unwrap_or_default().to_string_lossy()));
    [on.clone(), named(".bak_repak"), named(".pak_disabled")].into_iter().find(|p| p.is_file())
}

/// `len:nanos` of the .pak, .utoc and .ucas, path-free (a rename or move keeps it). Empty when the .pak cannot be read.
pub fn stamp(path: &Path) -> String {
    let stat = |p: Option<PathBuf>| {
        p.and_then(|p| std::fs::metadata(p).ok())
            .and_then(|m| Some(format!("{}:{}", m.len(), m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos())))
    };
    match stat(Some(path.to_path_buf())) {
        Some(pak) => [pak, stat(part(path, "utoc")).unwrap_or("-".into()), stat(part(path, "ucas")).unwrap_or("-".into())].join("|"),
        None => String::new(),
    }
}

/// A hash of the mod's file list (IoStore: the .utoc's paths and the .ucas size, else the .pak's paths and sizes), as
/// Repak X's content_id. A relink check, not an integrity check. None when it cannot be read.
pub fn hash(path: &Path) -> Option<String> {
    let _reading = crate::xtra_parse_guard::reading(path, &format!("{:?}", crate::mod_fingerprint(path))).ok()?;
    let mut lines: Vec<String> = if let Some(utoc) = part(path, "utoc") {
        let ucas = part(path, "ucas").and_then(|u| std::fs::metadata(u).ok()).map_or(0, |m| m.len());
        let mut l: Vec<String> = crate::utoc_utils::try_read_utoc(&utoc).ok()?.into_iter().map(|f| f.file_path.to_lowercase()).collect();
        l.push(format!("\0ucas\0{ucas}"));
        l
    } else {
        let listing = uasset_toolkit::list_pak(path.to_str()?, Some(crate::install_mod::AES_KEY_HEX), None).ok()?;
        listing.files.into_iter().map(|e| format!("{}\0{}", e.path.to_lowercase(), e.size)).collect()
    };
    lines.sort();
    Some(format!("{:x}", Sha256::digest(lines.join("\n").as_bytes())))
}

/// The records after a scan that found `found`, and the relinks: (old key, new key, old path). A record found by its
/// key is refreshed (a new stamp drops its hash). A key no record has and a record no scan found pair up when theirs is
/// the only such stamp on both sides and the file lists match (`hash` reads the new file; a record without a hash yet
/// relinks on the stamp alone). The rest are new records, or missing ones (kept `ORPHAN_SECS`). Pure, apart from `hash`.
pub fn reconcile(prints: &Prints, found: &[Found], now: u64, hash: &mut dyn FnMut(&str) -> Option<String>) -> (Prints, Vec<(String, String, String)>) {
    let mut next = Prints::new();
    let mut came = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for f in found {
        if !seen.insert(f.key.as_str()) {
            continue; // one key twice (an on and an off copy side by side): the first is the record
        }
        // a record the last scan found; a gone one's key (a file there again) is settled below
        match prints.get(&f.key).filter(|p| p.missing_since.is_none()) {
            Some(p) => {
                // new files under the key (an update, another mod copied over it): no hash yet, and no rename history
                let same = p.stamp == f.stamp;
                let (hash, from) = if same { (p.hash.clone(), p.from.clone()) } else { (None, None) };
                next.insert(f.key.clone(), Print { path: f.path.clone(), stamp: f.stamp.clone(), hash, missing_since: None, from });
            }
            None => came.push(f),
        }
    }
    // gone this scan (the last one found them) and gone before (kept 7 days)
    let gone: Vec<(&String, &Print)> = prints.iter().filter(|(k, p)| !next.contains_key(*k) && p.missing_since.is_none()).collect();
    let orphans: Vec<(&String, &Print)> = prints.iter().filter(|(_, p)| p.missing_since.is_some()).collect();
    let count = |stamps: &mut dyn Iterator<Item = &str>| {
        let mut n: HashMap<String, usize> = HashMap::new();
        stamps.for_each(|s| *n.entry(s.to_string()).or_default() += 1);
        n
    };
    let came_n = count(&mut came.iter().map(|f| f.stamp.as_str()));
    let (gone_n, orphan_n) = (count(&mut gone.iter().map(|(_, p)| p.stamp.as_str())), count(&mut orphans.iter().map(|(_, p)| p.stamp.as_str())));
    let mut relinks = Vec::new();
    let mut taken = std::collections::HashSet::new();
    for f in &came {
        let one = |n: &HashMap<String, usize>| n.get(&f.stamp) == Some(&1);
        let own = prints.get(&f.key).filter(|p| p.missing_since.is_some() && p.stamp == f.stamp);
        // a gone mod back at its own key with its own files is a restore (a relink leaves no record at its old key, so a
        // gone record sharing a stamp with another mod means there were copies: never guessed between); else the one mod
        // that left this scan with its stamp; else the one mod gone before with it (moved while the app was closed)
        let old = if f.stamp.is_empty() || !one(&came_n) || own.is_some() {
            None
        } else if one(&gone_n) {
            pick(&gone, &f.stamp)
        } else if gone_n.contains_key(&f.stamp) {
            None
        } else if one(&orphan_n) {
            pick(&orphans, &f.stamp)
        } else {
            None
        };
        // shortcut: a record renamed before `fill` hashed it, or a new file whose list cannot be read (an off IoStore
        // form the reader does not take), relinks on its unique stamp alone (nanosecond times); upgrade to refusing it if
        // a wrong relink is ever reported
        let same = old.filter(|(_, p)| p.hash.is_none() || hash(&f.path).map_or(true, |h| p.hash.as_deref() == Some(h.as_str())));
        match (same, own) {
            (Some((k, p)), _) => {
                taken.insert(k.as_str());
                relinks.push(((*k).clone(), f.key.clone(), p.path.clone()));
                next.insert(f.key.clone(), Print { path: f.path.clone(), stamp: f.stamp.clone(), hash: p.hash.clone(), missing_since: None, from: Some((p.path.clone(), now)) });
            }
            (None, Some(p)) => {
                next.insert(f.key.clone(), Print { path: f.path.clone(), missing_since: None, ..p.clone() });
            }
            (None, None) => {
                next.insert(f.key.clone(), Print { path: f.path.clone(), stamp: f.stamp.clone(), ..Default::default() });
            }
        }
    }
    for (k, p) in gone.into_iter().chain(orphans) {
        if taken.contains(k.as_str()) || next.contains_key(k) {
            continue; // relinked, or its key holds a file again
        }
        let since = p.missing_since.unwrap_or(now);
        if now.saturating_sub(since) <= ORPHAN_SECS {
            next.insert(k.clone(), Print { missing_since: Some(since), ..p.clone() });
        }
    }
    for p in next.values_mut() {
        if p.from.as_ref().is_some_and(|(_, at)| now.saturating_sub(*at) > ORPHAN_SECS) {
            p.from = None;
        }
    }
    (next, relinks)
}

/// The record in `list` with `stamp`.
fn pick<'a>(list: &[(&'a String, &'a Print)], stamp: &str) -> Option<(&'a String, &'a Print)> {
    list.iter().copied().find(|(_, p)| p.stamp == stamp)
}

/// The records' key for a mods folder: its path, lowercase with "/".
fn root_key(root: &Path) -> String {
    root.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// A record's path (with "/") under `root`, in the OS's separators, so it names the file as the scan does (the crash
/// guard keys files by their path text, xtra_parse_guard.rs).
fn at(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(root.to_path_buf(), |p, part| p.join(part))
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// After a full scan of `root` found `paths`: records every mod (the first scan of a build records them all, before any
/// later rename) and returns the mods renamed or moved since, (old path, new path). Nothing when the scan found nothing,
/// the mods folder is gone, or the game path changed since the scan started (no record is orphaned then). The caller
/// holds the mutation gate (xtra_respace::relink).
pub fn scan(root: &Path, paths: &[PathBuf], state: &Arc<Mutex<crate::AppState>>) -> Vec<(PathBuf, PathBuf)> {
    if paths.is_empty() || !root.is_dir() {
        return Vec::new();
    }
    let rk = root_key(root);
    let found: Vec<Found> = paths
        .iter()
        .map(|p| Found {
            key: crate::xtra_dupes::key(root, p),
            path: p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/"),
            stamp: stamp(p),
        })
        .collect();
    let before = {
        let s = state.lock().unwrap_or_else(|e| e.into_inner());
        if s.game_path != root {
            return Vec::new();
        }
        s.mod_fingerprints.get(&rk).cloned().unwrap_or_default()
    };
    // file lists read without the state locked (only for a possible relink, which is rare)
    let (next, relinks) = reconcile(&before, &found, now(), &mut |rel| hash(&at(root, rel)));
    let mut next = next;
    {
        let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
        // a scan beside this one got there first: its answer stands, this one relinks nothing. Hashes `fill` added
        // meanwhile are no such change: they are kept.
        let now_held = s.mod_fingerprints.get(&rk).cloned().unwrap_or_default();
        let unhashed = |m: &Prints| m.iter().map(|(k, p)| (k.clone(), Print { hash: None, ..p.clone() })).collect::<Prints>();
        if s.game_path != root || unhashed(&now_held) != unhashed(&before) {
            return Vec::new();
        }
        for (k, p) in next.iter_mut() {
            if p.hash.is_none() {
                p.hash = now_held.get(k).filter(|o| o.stamp == p.stamp && o.path == p.path).and_then(|o| o.hash.clone());
            }
        }
        if next != now_held {
            s.mod_fingerprints.insert(rk, next.clone());
            let _ = crate::save_state(&s);
        }
    }
    if next.values().any(|p| p.hash.is_none() && p.missing_since.is_none()) {
        fill(root.to_path_buf(), state.clone());
    }
    relinks.into_iter().map(|(_, new, old)| (at(root, &old), at(root, &next[&new].path))).collect()
}

/// The path each mod at `paths` had before a relink in the last 7 days, by index (for the scan's mod list).
pub fn relinked_from(root: &Path, paths: &[PathBuf], state: &Mutex<crate::AppState>) -> Vec<Option<PathBuf>> {
    let s = state.lock().unwrap_or_else(|e| e.into_inner());
    let prints = s.mod_fingerprints.get(&root_key(root));
    paths
        .iter()
        .map(|p| prints?.get(&crate::xtra_dupes::key(root, p))?.from.as_ref().map(|(old, _)| at(root, old)))
        .collect()
}

static FILLING: AtomicBool = AtomicBool::new(false);
/// (path, stamp) of files `fill` could not hash this launch: never tried again until they change
static UNREADABLE: Mutex<Option<std::collections::HashSet<(String, String)>>> = Mutex::new(None);

/// Lets the next `fill` start when this one ends, also when it panics.
struct Filling;
impl Drop for Filling {
    fn drop(&mut self) {
        FILLING.store(false, Ordering::SeqCst);
    }
}

/// Hashes the file lists of the records that have none, one mod at a time, off the scan. One at once.
fn fill(root: PathBuf, state: Arc<Mutex<crate::AppState>>) {
    if FILLING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let _filling = Filling;
        let tried = |p: &Print| UNREADABLE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(Default::default).contains(&(p.path.clone(), p.stamp.clone()));
        let rk = root_key(&root);
        let todo: Vec<(String, Print)> = {
            let s = state.lock().unwrap_or_else(|e| e.into_inner());
            s.mod_fingerprints.get(&rk).map(|m| m.iter().filter(|(_, p)| p.hash.is_none() && p.missing_since.is_none() && !tried(p)).map(|(k, p)| (k.clone(), p.clone())).collect()).unwrap_or_default()
        };
        let mut done = 0;
        for (k, p) in todo {
            let file = at(&root, &p.path);
            let Some(h) = hash(&file).filter(|_| stamp(&file) == p.stamp) else {
                UNREADABLE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(Default::default).insert((p.path.clone(), p.stamp.clone()));
                continue;
            };
            let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
            // only while the record still describes that file
            if let Some(r) = s.mod_fingerprints.get_mut(&rk).and_then(|m| m.get_mut(&k)).filter(|r| r.stamp == p.stamp && r.path == p.path) {
                r.hash = Some(h);
                done += 1;
                if done % 50 == 0 {
                    let _ = crate::save_state(&s);
                }
            }
        }
        if done > 0 {
            let s = state.lock().unwrap_or_else(|e| e.into_inner());
            let _ = crate::save_state(&s);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(key: &str, stamp: &str) -> Found {
        Found { key: key.into(), path: format!("{key}.pak"), stamp: stamp.into() }
    }
    fn p(key: &str, stamp: &str, hash: Option<&str>) -> (String, Print) {
        (key.into(), Print { path: format!("{key}.pak"), stamp: stamp.into(), hash: hash.map(Into::into), ..Default::default() })
    }
    fn prints(v: &[(String, Print)]) -> Prints {
        v.iter().cloned().collect()
    }
    fn no_read(_: &str) -> Option<String> {
        panic!("a file list read with nothing to relink")
    }

    #[test]
    fn the_first_scan_records_every_mod_and_an_unchanged_one_changes_nothing() {
        let (next, r) = reconcile(&Prints::new(), &[f("|a", "1"), f("x|b", "2")], 0, &mut no_read);
        assert!(r.is_empty() && next.len() == 2 && next.values().all(|p| p.hash.is_none() && p.missing_since.is_none()));
        let before = prints(&[p("|a", "1", Some("h"))]);
        assert_eq!(reconcile(&before, &[f("|a", "1")], 0, &mut no_read).0, before);
    }

    #[test]
    fn a_unique_match_with_the_same_file_list_relinks() {
        let before = prints(&[p("|old", "s", Some("h")), p("|kept", "k", None)]);
        let (next, r) = reconcile(&before, &[f("x|new", "s"), f("|kept", "k")], 5, &mut |rel| (rel == "x|new.pak").then(|| "h".into()));
        assert_eq!(r, [("|old".to_string(), "x|new".to_string(), "|old.pak".to_string())]);
        assert!(!next.contains_key("|old") && next["x|new"].hash.as_deref() == Some("h") && next["x|new"].from == Some(("|old.pak".into(), 5)));
    }

    #[test]
    fn a_file_renamed_onto_a_gone_mods_name_still_relinks() {
        let mut dead = p("|hat", "d", Some("x"));
        dead.1.missing_since = Some(0);
        let before = prints(&[p("|skin", "s", Some("h")), dead]);
        let (next, r) = reconcile(&before, &[f("|hat", "s")], 10, &mut |_| Some("h".into()));
        assert_eq!(r, [("|skin".to_string(), "|hat".to_string(), "|skin.pak".to_string())]);
        assert_eq!(next["|hat"].stamp, "s");
        assert_eq!(next["|hat"].missing_since, None);
        // the gone mod itself back (same files): found at its key
        let mut back = p("|hat", "d", Some("x"));
        back.1.missing_since = Some(0);
        assert!(reconcile(&prints(&[back]), &[f("|hat", "d")], 10, &mut no_read).1.is_empty());
    }

    #[test]
    fn renamed_back_and_forth_within_the_7_days_each_rename_relinks() {
        let h = &mut |_: &str| Some("h".to_string());
        let one = prints(&[p("|a", "s", Some("h"))]);
        let (two, r) = reconcile(&one, &[f("|b", "s")], 10, h);
        assert_eq!(r[0].0, "|a");
        assert!(!two.contains_key("|a"), "a relink leaves no record behind");
        let (three, r) = reconcile(&two, &[f("|a", "s")], 20, h);
        assert_eq!(r[0].0, "|b");
        let (_, r) = reconcile(&three, &[f("|b", "s")], 30, h);
        assert_eq!(r[0].0, "|a");
    }

    #[test]
    fn an_identical_copy_back_at_its_key_while_the_other_goes_is_a_restore() {
        // copies A and B: A gone earlier, now A is back and B is gone in one scan: no guess between them
        let mut a = p("|a", "s", Some("h"));
        a.1.missing_since = Some(0);
        let (next, r) = reconcile(&prints(&[a, p("|b", "s", Some("h"))]), &[f("|a", "s")], 10, &mut no_read);
        assert!(r.is_empty() && next["|a"].missing_since.is_none() && next["|b"].missing_since == Some(10));
    }

    #[test]
    fn identical_copies_restored_at_their_own_keys_are_found_there() {
        let gone = |k: &str| {
            let mut x = p(k, "s", Some("h"));
            x.1.missing_since = Some(0);
            x
        };
        let (next, r) = reconcile(&prints(&[gone("a|skin"), gone("b|skin")]), &[f("a|skin", "s"), f("b|skin", "s")], 10, &mut no_read);
        assert!(r.is_empty() && next.values().all(|p| p.missing_since.is_none() && p.hash.is_some()));
    }

    #[test]
    fn a_new_file_whose_list_cannot_be_read_relinks_on_its_stamp() {
        let before = prints(&[p("|old", "s", Some("h"))]);
        assert_eq!(reconcile(&before, &[f("|new", "s")], 0, &mut |_| None).1.len(), 1);
    }

    #[test]
    fn another_file_list_or_a_changed_stamp_is_another_mod() {
        let before = prints(&[p("|old", "s", Some("h"))]);
        let (next, r) = reconcile(&before, &[f("|new", "s")], 0, &mut |_| Some("other".into()));
        assert!(r.is_empty() && next["|old"].missing_since == Some(0) && next["|new"].hash.is_none());
        assert!(reconcile(&before, &[f("|new", "t")], 0, &mut no_read).1.is_empty());
    }

    #[test]
    fn identical_copies_never_relink_or_swap() {
        // two copies (one stamp) renamed at once
        let before = prints(&[p("a|skin", "s", Some("h")), p("b|skin", "s", Some("h"))]);
        let (next, r) = reconcile(&before, &[f("a|skin2", "s"), f("b|skin2", "s")], 0, &mut |_| Some("h".into()));
        assert!(r.is_empty() && next["a|skin"].missing_since.is_some() && next["b|skin"].missing_since.is_some());
        // one renamed, and a copy of it made: two new keys for one record
        let one = prints(&[p("|skin", "s", Some("h"))]);
        assert!(reconcile(&one, &[f("|skin2", "s"), f("|skin3", "s")], 0, &mut |_| Some("h".into())).1.is_empty());
        // one of two copies renamed: the other is still found by its key, so this one is unique
        let (_, r) = reconcile(&before, &[f("a|skin2", "s"), f("b|skin", "s")], 0, &mut |_| Some("h".into()));
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].0, "a|skin");
    }

    #[test]
    fn a_missing_record_is_kept_7_days_and_found_again() {
        let before = prints(&[p("|gone", "s", None)]);
        let (kept, _) = reconcile(&before, &[f("|other", "o")], 100, &mut no_read);
        assert_eq!(kept["|gone"].missing_since, Some(100));
        let (still, _) = reconcile(&kept, &[f("|other", "o")], 100 + ORPHAN_SECS, &mut no_read);
        assert_eq!(still["|gone"].missing_since, Some(100), "the first day it went missing counts");
        assert!(!reconcile(&still, &[f("|other", "o")], 101 + ORPHAN_SECS, &mut no_read).0.contains_key("|gone"));
        // back at its key: found, no longer missing
        assert_eq!(reconcile(&kept, &[f("|gone", "s")], 200, &mut no_read).0["|gone"].missing_since, None);
        // moved while the app was closed, days later: still relinks
        assert_eq!(reconcile(&kept, &[f("x|gone", "s")], 100 + 3 * 86400, &mut no_read).1.len(), 1);
    }

    #[test]
    fn a_new_stamp_drops_the_hash_and_the_rename_history_and_an_unreadable_stamp_never_matches() {
        let mut a = p("|a", "s", Some("h"));
        a.1.from = Some(("|old.pak".into(), 0));
        let before = prints(&[a, p("|gone", "", Some("h"))]);
        let (next, r) = reconcile(&before, &[f("|a", "t"), f("|new", "")], 0, &mut no_read);
        assert!(r.is_empty() && next["|a"].hash.is_none() && next["|a"].from.is_none());
    }

    #[test]
    fn an_off_iostore_mod_stamps_and_finds_its_off_companions() {
        let dir = tempfile::tempdir().unwrap();
        let pak = dir.path().join("Skin_9999999_P.bak_repak");
        for f in ["Skin_9999999_P.bak_repak", "Skin_9999999_P.utoc.bak_repak", "Skin_9999999_P.ucas.bak_repak"] {
            std::fs::write(dir.path().join(f), b"x").unwrap();
        }
        assert_eq!(part(&pak, "utoc"), Some(dir.path().join("Skin_9999999_P.utoc.bak_repak")));
        assert!(!stamp(&pak).contains('-'), "every part stamped: {}", stamp(&pak));
        assert_eq!(stamp(&dir.path().join("Gone.pak")), "");
    }

    #[test]
    fn an_empty_scan_a_missing_mods_folder_or_another_game_path_orphans_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(Mutex::new(crate::AppState { game_path: dir.path().to_path_buf(), ..Default::default() }));
        let rk = root_key(dir.path());
        state.lock().unwrap().mod_fingerprints.insert(rk.clone(), prints(&[p("|a", "s", Some("h"))]));
        let kept = |s: &Arc<Mutex<crate::AppState>>| s.lock().unwrap().mod_fingerprints[&rk]["|a"].missing_since.is_none();
        assert!(scan(dir.path(), &[], &state).is_empty() && kept(&state));
        let gone = dir.path().join("missing");
        assert!(scan(&gone, &[gone.join("b.pak")], &state).is_empty());
        state.lock().unwrap().game_path = dir.path().join("elsewhere");
        let other = dir.path().join("b.pak");
        std::fs::write(&other, b"x").unwrap();
        assert!(scan(dir.path(), &[other], &state).is_empty() && kept(&state));
    }
}
