//! repakxtra: the file comparison behind check_mod_clashes. A PAK lists "Marvel/Content/Marvel/X.uasset" where an
//! IoStore container says "/Game/Marvel/X.uasset", and casing differs between mods, so every path is compared by the
//! Asset Explorer's normalized form, lowercased. Each priority builds one map from asset to owning mods instead of
//! rebuilding two sets for every pair, and container file lists are cached by size and date, so toggling a mod or
//! changing its priority (a rename) does not read every container again.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

pub struct Container {
    pub path: PathBuf,
    pub priority: Rank,
    pub files: Arc<Vec<String>>,
}

/// A mod's load priority, read from its file stem: a leading ! (Special) and the priority of its `_9999999_P` suffix
/// (0 is unranked). Two mods tie only when both parts match, so a ! mod and an unranked one are never counted as tied.
/// Only mods with the same Special state and both numbered have an order the app sets (`ordered`).
pub type Rank = (bool, usize);

pub fn rank(stem: &str) -> Rank {
    (stem.starts_with('!'), crate::asset_explorer::mod_priority(stem))
}

/// The rank of a mod file, on or off: its name without the .pak, .bak_repak, .pak_disabled, .utoc, or .ucas.
pub fn rank_of(path: &Path) -> Rank {
    rank(crate::xtra_bundle::stem(path.file_name().and_then(|n| n.to_str()).unwrap_or("")))
}

/// How `a` loads against `b` when the app sets that order: both numbered with the same Special (!) state, more nines
/// win. None otherwise: a ! mod against one without it, or an unranked one, loads in an order the app does not set.
pub fn ordered(a: Rank, b: Rank) -> Option<std::cmp::Ordering> {
    (a.0 == b.0 && a.1 > 0 && b.1 > 0).then(|| a.1.cmp(&b.1))
}

/// A rank in words for logs and the Why dialog: "!1", "1", "!", or "unranked".
pub fn rank_label((special, priority): Rank) -> String {
    match (special, priority) {
        (false, 0) => "unranked".into(),
        (true, 0) => "!".into(),
        (s, n) => format!("{}{n}", if s { "!" } else { "" }),
    }
}

/// `body` without one priority suffix (`_` then nines then `_P`), or None when it has none.
fn strip_rank_suffix(body: &str) -> Option<&str> {
    let (base, n) = body.strip_suffix("_P")?.rsplit_once('_')?;
    (!n.is_empty() && n.bytes().all(|c| c == b'9')).then_some(base)
}

/// The stem set_mod_priority renames a mod to. The number and Special (!) are independent: `special` Some sets or
/// clears only the leading !, None keeps it, and a number change never adds or removes one. Priority N is N + 6
/// nines, 0 is Unranked (no suffix). The same number keeps the rest of the name exactly as it was, so a Special
/// toggle is a pure prefix change. A new number takes off every priority suffix (a name with two still ends up with
/// one) and a bare `_P`, as an install does, and nothing else: `Skin_9` stays `Skin_9`.
pub fn priority_stem(stem: &str, priority: usize, special: Option<bool>) -> String {
    let bare = stem.strip_prefix('!').unwrap_or(stem);
    let bang = if special.unwrap_or(stem.starts_with('!')) { "!" } else { "" };
    if priority == crate::asset_explorer::mod_priority(bare) {
        return format!("{bang}{bare}");
    }
    let mut base = bare;
    while let Some(b) = strip_rank_suffix(base) {
        base = b;
    }
    match priority {
        0 => format!("{bang}{base}"),
        n => {
            loop {
                if let Some(b) = strip_rank_suffix(base) { base = b; continue; }
                if let Some(b) = base.strip_suffix("_P") { base = b; continue; }
                break;
            }
            format!("{bang}{base}_{}_P", "9".repeat(n + crate::install_mod::install_mod_logic::BASE_MOD_NINES - 1))
        }
    }
}

/// The comparison key for an asset path from either reader.
pub fn asset_key(raw: &str) -> String {
    crate::asset_explorer::normalize_asset_path(raw).to_lowercase()
}

fn is_metadata(path: &str) -> bool {
    path.ends_with("patched_files") || path.contains("/patched_files")
}

/// Every pair of containers at the same priority that share an asset, as (first index, second index, shared files in
/// the first container's spelling), in the same order the old pairwise loop produced (by first, then second index).
pub fn find(mods: &[Container]) -> Vec<(usize, usize, Vec<String>)> {
    let mut by_priority: BTreeMap<Rank, Vec<usize>> = BTreeMap::new();
    for (i, m) in mods.iter().enumerate() {
        by_priority.entry(m.priority).or_default().push(i);
    }
    let mut pairs: BTreeMap<(usize, usize), Vec<String>> = BTreeMap::new();
    for members in by_priority.values().filter(|m| m.len() > 1) {
        // asset key -> (owner, that owner's spelling), one entry per owner
        let mut owners: HashMap<String, Vec<(usize, &str)>> = HashMap::new();
        for &i in members {
            for f in mods[i].files.iter().filter(|f| !is_metadata(f)) {
                let list = owners.entry(asset_key(f)).or_default();
                if list.last().map(|(o, _)| *o) != Some(i) {
                    list.push((i, f.as_str()));
                }
            }
        }
        for list in owners.values().filter(|l| l.len() > 1) {
            for (a, &(i, spelling)) in list.iter().enumerate() {
                for &(j, _) in &list[a + 1..] {
                    pairs.entry((i.min(j), i.max(j))).or_default().push(spelling.to_string());
                }
            }
        }
    }
    pairs
        .into_iter()
        .map(|((i, j), mut files)| {
            files.sort();
            (i, j, files)
        })
        .collect()
}

type Fingerprint = (String, u64, Option<SystemTime>, u64, Option<SystemTime>);

fn fingerprint(pak: &Path, utoc: Option<&Path>) -> Option<Fingerprint> {
    let meta = |p: &Path| std::fs::metadata(p).ok().map(|m| (m.len(), m.modified().ok()));
    let (len, mtime) = meta(pak)?;
    let (ulen, umtime) = utoc.and_then(meta).unwrap_or((0, None));
    // the name without its priority suffix, so a priority change (a rename) still finds the entry
    let name = pak.file_name()?.to_string_lossy().to_lowercase();
    let stem = crate::xtra_bundle::stem(&name);
    static PRIORITY: OnceLock<regex_lite::Regex> = OnceLock::new();
    let re = PRIORITY.get_or_init(|| regex_lite::Regex::new(r"^!?(.*?)(_9+)?(_p)?$").unwrap());
    let base = re.captures(stem)?.get(1)?.as_str().to_string();
    Some((base, len, mtime, ulen, umtime))
}

/// The container's file list, read with `read` only when the PAK or its .utoc changed since the last read. Failed
/// reads are not kept, so a file that was busy is read again next time.
pub fn files_cached(
    pak: &Path,
    utoc: Option<&Path>,
    read: impl FnOnce() -> Result<Vec<String>, String>,
) -> Result<Arc<Vec<String>>, String> {
    static CACHE: OnceLock<Mutex<HashMap<Fingerprint, Arc<Vec<String>>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let key = fingerprint(pak, utoc);
    if let Some(hit) = key.as_ref().and_then(|k| cache.lock().unwrap().get(k).cloned()) {
        return Ok(hit);
    }
    let files = Arc::new(read()?);
    if let Some(k) = key {
        let mut c = cache.lock().unwrap();
        if c.len() > 5000 {
            c.clear(); // shortcut: whole-cache reset on overflow, fine for libraries under a few thousand mods
        }
        c.insert(k, files.clone());
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(name: &str, priority: usize, files: &[&str]) -> Container {
        Container { path: PathBuf::from(name), priority: (false, priority), files: Arc::new(files.iter().map(|s| s.to_string()).collect()) }
    }

    #[test]
    fn ranks_keep_special_apart_from_the_number() {
        assert_eq!(rank("Skin_9999999_P"), (false, 1));
        assert_eq!(rank("Skin_99999999_P"), (false, 2));
        assert_eq!(rank("!Skin_9999999_P"), (true, 1));
        assert_eq!(rank("Skin"), (false, 0), "unranked");
        assert_eq!(rank("Skin_1234567_P"), (false, 0), "digits that are not all nines are no rank");
        assert_ne!(rank("!Skin_9999999_P"), rank("Other"), "! and unranked never tie");
        assert_ne!(rank("!Skin"), rank("Skin"), "! and no ! never tie");
        assert_eq!(rank_of(Path::new("m/Skin_9999999_P.pak.bak_repak")), (false, 1), "an off mod keeps its rank");
        assert_eq!(rank_of(Path::new("m/!Skin_99999999_P.bak_repak")), (true, 2));
        assert_eq!(ordered((false, 2), (false, 1)), Some(std::cmp::Ordering::Greater));
        assert_eq!(ordered((true, 1), (true, 1)), Some(std::cmp::Ordering::Equal));
        assert_eq!(ordered((true, 1), (false, 7)), None, "a ! mod against a numbered one: the app does not set it");
        assert_eq!(ordered((false, 0), (false, 1)), None, "unranked has no set order");
        assert_eq!([rank_label((false, 0)), rank_label((false, 3)), rank_label((true, 1)), rank_label((true, 0))], ["unranked", "3", "!1", "!"]);
    }

    #[test]
    fn priority_stem_steps_unranked_to_seven_and_back() {
        let mut stem = "My.Skin v2".to_string();
        for n in 1..=7 {
            stem = priority_stem(&stem, n, None);
            assert_eq!(stem, format!("My.Skin v2_{}_P", "9".repeat(n + 6)));
            assert_eq!(rank(&stem), (false, n));
        }
        for n in (0..7).rev() {
            stem = priority_stem(&stem, n, None);
        }
        assert_eq!(stem, "My.Skin v2", "stepping below 1 is unranked, never !");
        assert_eq!(priority_stem("Skin_P", 1, None), "Skin_9999999_P", "a bare _P takes the suffix, as an install does");
        assert_eq!(priority_stem("Skin_P", 0, None), "Skin_P", "already unranked: no change");
    }

    #[test]
    fn special_is_a_pure_prefix_toggle() {
        assert_eq!(priority_stem("Skin", 0, Some(true)), "!Skin", "Special on an unranked mod adds only the !");
        assert_eq!(priority_stem("!Skin", 0, Some(false)), "Skin");
        assert_eq!(priority_stem("Skin_9999999_P", 1, Some(true)), "!Skin_9999999_P");
        assert_eq!(priority_stem("!Skin_9999999_P", 1, Some(false)), "Skin_9999999_P");
        assert_eq!(priority_stem("Skin_9999999_P_9999999_P", 1, Some(true)), "!Skin_9999999_P_9999999_P", "the rest of the name stays");
        assert_eq!(priority_stem("!Skin_9999999_P", 3, None), "!Skin_999999999_P", "a number change keeps !");
        assert_eq!(priority_stem("!Skin_9999999_P", 0, None), "!Skin", "Unranked keeps ! too");
        assert_eq!(priority_stem("Skin_9999999_P", 0, None), "Skin", "stepping 1 down to Unranked never adds !");
    }

    #[test]
    fn only_priority_suffixes_come_off() {
        assert_eq!(priority_stem("Skin_9", 1, None), "Skin_9_9999999_P", "no _P: not a priority suffix");
        assert_eq!(priority_stem("Skin_9_9999999_P", 0, None), "Skin_9", "and back");
        assert_eq!(priority_stem("Skin_9999999_P_9999999_P", 0, None), "Skin", "stacked suffixes all come off");
        assert_eq!(rank(&priority_stem("Skin_9999999_P_9999999_P", 0, None)), (false, 0));
        assert_eq!(priority_stem("Skin_9999999_P_9999999_P", 2, None), "Skin_99999999_P");
        assert_eq!(priority_stem("Skin_9999999_P_P", 1, None), "Skin_9999999_P", "trailing _P over a rank suffix does not stack another suffix");
        assert_eq!(priority_stem("Skin_1234_P", 2, None), "Skin_1234_99999999_P", "digits that are not nines stay in the name");
    }

    #[test]
    fn pak_and_iostore_spellings_of_one_asset_clash() {
        let mods = [
            c("A.pak", 1, &["Marvel/Content/Marvel/Characters/1026/X.uasset", "patched_files"]),
            c("B.pak", 1, &["/Game/Marvel/Characters/1026/X.uasset", "patched_files"]),
            c("C.pak", 1, &["../../../marvel/content/MARVEL/characters/1026/x.uasset"]),
            c("D.pak", 1, &["Marvel\\Content\\Marvel\\Characters\\1026\\Y.uasset"]),
            c("E.pak", 2, &["/Game/Marvel/Characters/1026/X.uasset"]),
        ];
        let found = find(&mods);
        let pairs: Vec<(usize, usize)> = found.iter().map(|(i, j, _)| (*i, *j)).collect();
        assert_eq!(pairs, [(0, 1), (0, 2), (1, 2)], "X is one asset in A, B and C; D differs; E is another priority");
        assert_eq!(found[0].2, ["Marvel/Content/Marvel/Characters/1026/X.uasset"], "first mod's spelling, patched_files excluded");
    }

    #[test]
    fn different_assets_do_not_clash() {
        let mods = [c("A.pak", 1, &["/Game/A.uasset"]), c("B.pak", 1, &["/Game/B.uasset"])];
        assert!(find(&mods).is_empty());
    }

    /// The old pairwise loop, kept here only to compare results and time on a synthetic library.
    fn old_pairwise(mods: &[Container]) -> Vec<(usize, usize, Vec<String>)> {
        use std::collections::HashSet;
        let mut out = Vec::new();
        for i in 0..mods.len() {
            for j in i + 1..mods.len() {
                if mods[i].priority != mods[j].priority {
                    continue;
                }
                let a: HashSet<String> = mods[i].files.iter().map(|f| asset_key(f)).collect();
                let b: HashSet<String> = mods[j].files.iter().map(|f| asset_key(f)).collect();
                if a.intersection(&b).next().is_some() {
                    let mut shared: Vec<String> =
                        mods[i].files.iter().filter(|f| b.contains(&asset_key(f))).cloned().collect();
                    shared.sort();
                    out.push((i, j, shared));
                }
            }
        }
        out
    }

    fn library(n: usize) -> Vec<Container> {
        // n mods at one priority, 60 files each, and each run of 25 mods shares one texture
        (0..n)
            .map(|i| {
                let mut files: Vec<String> = (0..60).map(|f| format!("/Game/Mods/M{i}/F{f}.uasset")).collect();
                files.push(format!("Marvel/Content/Shared/T{}.uasset", i / 25));
                Container { path: PathBuf::from(format!("M{i}.pak")), priority: (false, 1), files: Arc::new(files) }
            })
            .collect()
    }

    #[test]
    fn the_owner_map_matches_the_pairwise_result() {
        let mods = library(125);
        assert_eq!(find(&mods), old_pairwise(&mods));
        assert_eq!(find(&mods).len(), 5 * (25 * 24 / 2));
    }

    /// cargo test -p repak-x --bin REPAK-X five_hundred -- --ignored --nocapture
    #[test]
    #[ignore]
    fn five_hundred_mods_timing() {
        let mods = library(500);
        let t = std::time::Instant::now();
        let new = find(&mods);
        let new_ms = t.elapsed().as_millis();
        let t = std::time::Instant::now();
        let old = old_pairwise(&mods);
        let old_ms = t.elapsed().as_millis();
        println!("500 mods: owner map {new_ms} ms, pairwise sets {old_ms} ms, {} clashing pairs", new.len());
        assert_eq!(new, old);
    }

    #[test]
    fn a_priority_rename_reuses_the_cached_list() {
        let d = std::env::temp_dir().join(format!("repakxtra-conflicts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let a = d.join("Skin_9999999_P.pak");
        std::fs::write(&a, b"pak").unwrap();
        let reads = std::cell::Cell::new(0);
        let read = || { reads.set(reads.get() + 1); Ok(vec!["/Game/X.uasset".to_string()]) };
        files_cached(&a, None, read).unwrap();
        let b = d.join("Skin_99999999_P.pak");
        std::fs::rename(&a, &b).unwrap();
        files_cached(&b, None, read).unwrap();
        assert_eq!(reads.get(), 1, "renamed to another priority: no second read");
        std::fs::write(&b, b"changed pak").unwrap();
        files_cached(&b, None, read).unwrap();
        assert_eq!(reads.get(), 2, "new contents: read again");
        let _ = std::fs::remove_dir_all(&d);
    }
}
