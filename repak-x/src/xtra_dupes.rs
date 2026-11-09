//! repakxtra: mods with the same content. An install from the Library that matches a mod already installed, under any
//! name or folder, says "Already installed" and changes nothing (`check`), and Check Conflicts lists installed mods that
//! are the same mod twice (`xtra_find_duplicates`). Most installs convert the download, so installed files never equal
//! it: each install records a hash of its source (installed_sources.json, by the mod's loadout key, `key`) for
//! later downloads to compare with. Ready IoStore mods install as plain copies, so their installed files also compare
//! directly, which catches mods installed before the records existed. Only same-size candidates are ever hashed.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The file name without on/off extension, priority suffix, or the "!" priority-zero mark (loadoutIdentity.ts bare).
pub fn bare_name(path: &Path) -> String {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let lower = name.to_ascii_lowercase(); // same byte offsets as `name`
    let mut end = name.len();
    for ext in [".bak_repak", ".pak_disabled"] {
        if lower[..end].ends_with(ext) {
            end -= ext.len();
        }
    }
    if lower[..end].ends_with(".pak") {
        end -= 4;
    }
    if lower[..end].ends_with("_disabled") {
        end -= 9;
    }
    let mut stem = &name[..end];
    // (_\d+_P)+$
    loop {
        let Some(rest) = stem.strip_suffix("_P").or_else(|| stem.strip_suffix("_p")) else { break };
        let digits = rest.len() - rest.trim_end_matches(|c: char| c.is_ascii_digit()).len();
        if digits == 0 || !rest[..rest.len() - digits].ends_with('_') {
            break;
        }
        stem = &rest[..rest.len() - digits - 1];
    }
    stem.trim_start_matches('!').to_string()
}

/// The mod's loadout key, lowercase: "<folder in the mods folder>|<bare name>".
pub fn key(root: &Path, path: &Path) -> String {
    let parent = path.parent().unwrap_or(Path::new(""));
    let folder = parent.strip_prefix(root).unwrap_or(parent).to_string_lossy().replace('\\', "/");
    format!("{}|{}", folder.trim_matches('/'), bare_name(path)).to_lowercase()
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Source {
    size: u64,
    /// The source's files plus the install options (a different option builds a different mod)
    hash: String,
    /// The installed files' total size and newest modified time when recorded: a record whose mod changed since (an
    /// update, a VFX update, another file copied in under the name) no longer counts
    #[serde(default)]
    installed: u64,
    #[serde(default)]
    at: u64,
}

/// The newest modified time of `files`, in ms.
fn stamp(files: &[PathBuf]) -> u64 {
    let mtime = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
    files.iter().map(|f| mtime(f)).max().unwrap_or(0)
}

/// A record still describes the installed mod it is keyed by.
fn fresh(s: &Source, m: &Installed) -> bool {
    s.installed == m.size && s.at == stamp(&m.files)
}

static SOURCES: Mutex<Option<BTreeMap<String, Source>>> = Mutex::new(None);

fn sources_file() -> PathBuf {
    if cfg!(test) {
        return std::env::temp_dir().join("repakxtra-test-sources.json"); // tests never touch the real records
    }
    crate::app_dir().join("installed_sources.json")
}

fn with_sources<R>(f: impl FnOnce(&mut BTreeMap<String, Source>) -> R) -> R {
    let mut guard = SOURCES.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(|| std::fs::read_to_string(sources_file()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default());
    f(map)
}

fn save_sources(map: &BTreeMap<String, Source>) {
    let path = sources_file();
    let tmp = path.with_extension("json.tmp");
    let ok = path.parent().map_or(Ok(()), std::fs::create_dir_all).is_ok()
        && serde_json::to_string(map).ok().is_some_and(|s| std::fs::write(&tmp, s).is_ok());
    if ok {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// One hash over the files in order, each with its length (and, under `base`, its path), so no two different file sets
/// hash the same by shifting bytes between files.
fn hash_files(files: &[PathBuf], base: Option<&Path>) -> std::io::Result<String> {
    let mut h = Sha256::new();
    for f in files {
        if let Some(rel) = base.and_then(|b| f.strip_prefix(b).ok()) {
            h.update(rel.to_string_lossy().replace('\\', "/").to_lowercase().as_bytes());
            h.update([0]);
        }
        h.update(std::fs::metadata(f)?.len().to_le_bytes());
        std::io::copy(&mut std::fs::File::open(f)?, &mut h)?;
    }
    Ok(format!("{:x}", h.finalize()))
}

/// An installed mod's files hashed once per path, size, and modified time: a second scan of an unchanged library reads
/// nothing again.
fn installed_hash(m: &Installed) -> Option<String> {
    static CACHE: Mutex<Option<HashMap<PathBuf, (u64, u64, String)>>> = Mutex::new(None);
    let stamp = stamp(&m.files);
    if let Some((size, at, hash)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).get(&m.pak) {
        if *size == m.size && *at == stamp {
            return Some(hash.clone());
        }
    }
    let hash = hash_files(&m.files, None).ok()?;
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(m.pak.clone(), (m.size, stamp, hash.clone()));
    Some(hash)
}

/// An installed mod: its main file (on or off) and its .utoc and .ucas, in that order.
#[derive(Debug)]
pub struct Installed {
    pub pak: PathBuf,
    files: Vec<PathBuf>,
    size: u64,
}

fn installed(root: &Path) -> Vec<Installed> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(crate::xtra_bundle::library_walk)
        .flatten()
        .filter(|e| e.file_type().is_file() && !crate::xtra_builtins::is_own(e.path()))
        .filter(|e| matches!(e.path().extension().and_then(|x| x.to_str()), Some("pak" | "bak_repak" | "pak_disabled")))
        .map(|e| {
            let pak = e.path().to_path_buf();
            let mut files = vec![pak.clone()];
            files.extend(crate::xtra_bundle::existing_companions(&pak));
            let size = files.iter().map(|f| std::fs::metadata(f).map_or(0, |m| m.len())).sum();
            Installed { pak, files, size }
        })
        .collect()
}

/// The files a mod being installed is read from, and the folder their paths count from (a loose folder mod only).
fn source_files(m: &crate::install_mod::InstallableMod) -> (Vec<PathBuf>, Option<PathBuf>) {
    if m.is_dir {
        let mut files = Vec::new();
        let _ = crate::utils::collect_files(&mut files, &m.mod_path);
        files.sort_by_key(|f| f.to_string_lossy().to_lowercase());
        (files, Some(m.mod_path.clone()))
    } else if m.iostore {
        (["pak", "utoc", "ucas"].iter().map(|x| m.mod_path.with_extension(x)).collect(), None)
    } else {
        (vec![m.mod_path.clone()], None)
    }
}

pub struct Check {
    /// The installed mod with this content, if one is.
    pub same: Option<PathBuf>,
    /// The source's hash, recorded once the install worked.
    pub source: Option<Source>,
}

/// Whether the mod about to install is one already installed anywhere under `root`.
pub fn check(root: &Path, m: &crate::install_mod::InstallableMod) -> Check {
    let (files, base) = source_files(m);
    let size: u64 = files.iter().map(|f| std::fs::metadata(f).map_or(0, |m| m.len())).sum();
    let Ok(plain) = hash_files(&files, base.as_deref()) else { return Check { same: None, source: None } };
    let opts = [m.repak, m.force_legacy_pak, m.obfuscate, m.hybrid].map(|b| if b { '1' } else { '0' }).iter().collect::<String>();
    let source = Source { size, hash: format!("{plain}|{opts}"), installed: 0, at: 0 };
    let mods = installed(root);
    let by_key: HashMap<String, &Installed> = mods.iter().map(|i| (key(root, &i.pak), i)).collect();
    let recorded = with_sources(|map| {
        map.iter().find(|(k, s)| s.size == source.size && s.hash == source.hash && by_key.get(*k).is_some_and(|i| fresh(s, i))).map(|(k, _)| by_key[k].pak.clone())
    });
    // a ready IoStore mod installs as a copy: its installed files are the download byte for byte
    let copied = || m.iostore.then(|| mods.iter().find(|i| i.size == size && i.files.len() == 3 && installed_hash(i).as_deref() == Some(plain.as_str())).map(|i| i.pak.clone())).flatten();
    let same = recorded.or_else(copied);
    Check { same, source: Some(source) }
}

/// After an install worked: the mod at `pak` came from `source`.
pub fn record(root: &Path, pak: &Path, mut source: Source) {
    let mut files = vec![pak.to_path_buf()];
    files.extend(crate::xtra_bundle::existing_companions(pak));
    source.installed = files.iter().map(|f| std::fs::metadata(f).map_or(0, |m| m.len())).sum();
    source.at = stamp(&files);
    with_sources(|map| {
        map.insert(key(root, pak), source);
        save_sources(map);
    })
}

/// Sets of installed mods that are the same mod: byte-identical files, or installed from the same download. The last
/// answer is kept by the library's fingerprint (every mod's path, size, and modified time), so opening Check Conflicts
/// again on an unchanged library is instant.
fn find(root: &Path) -> Vec<Vec<PathBuf>> {
    static LAST: Mutex<Option<(String, Vec<Vec<PathBuf>>)>> = Mutex::new(None);
    let mods = installed(root);
    let mut print = Sha256::new();
    for m in &mods {
        let at = std::fs::metadata(&m.pak).and_then(|x| x.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis());
        print.update(format!("{}|{}|{}\n", m.pak.to_string_lossy().to_lowercase(), m.size, at).as_bytes());
    }
    let print = format!("{:x}", print.finalize());
    if let Some((p, sets)) = LAST.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if *p == print {
            return sets.clone();
        }
    }

    // union-find over the mods: two mods are one set when either rule says so
    let mut parent: Vec<usize> = (0..mods.len()).collect();
    fn top(p: &mut Vec<usize>, i: usize) -> usize {
        let mut i = i;
        while p[i] != i {
            p[i] = p[p[i]];
            i = p[i];
        }
        i
    }
    fn join(p: &mut Vec<usize>, a: usize, b: usize) {
        let (a, b) = (top(p, a), top(p, b));
        p[a] = b;
    }

    let mut first: HashMap<String, usize> = HashMap::new();
    let mut by_size: HashMap<(u64, usize), Vec<usize>> = HashMap::new();
    for (i, m) in mods.iter().enumerate() {
        if m.size > 0 {
            by_size.entry((m.size, m.files.len())).or_default().push(i);
        }
    }
    for idx in by_size.values().filter(|v| v.len() > 1) {
        for &i in idx {
            if let Some(h) = installed_hash(&mods[i]) {
                match first.get(&h) {
                    Some(&j) => join(&mut parent, i, j),
                    None => {
                        first.insert(h, i);
                    }
                }
            }
        }
    }
    with_sources(|map| {
        let mut seen: HashMap<&str, usize> = HashMap::new();
        for (i, m) in mods.iter().enumerate() {
            if let Some(s) = map.get(&key(root, &m.pak)).filter(|s| fresh(s, m)) {
                match seen.get(s.hash.as_str()) {
                    Some(&j) => join(&mut parent, i, j),
                    None => {
                        seen.insert(s.hash.as_str(), i);
                    }
                }
            }
        }
    });

    let mut sets: BTreeMap<usize, Vec<PathBuf>> = BTreeMap::new();
    for i in 0..mods.len() {
        let t = top(&mut parent, i);
        sets.entry(t).or_default().push(mods[i].pak.clone());
    }
    let sets: Vec<Vec<PathBuf>> = sets.into_values().filter(|s| s.len() > 1).collect();
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some((print, sets.clone()));
    sets
}

/// Check Conflicts' Duplicates: each set's mod paths. Which one stays is the frontend's pick (it knows loadouts).
#[tauri::command]
pub async fn xtra_find_duplicates(state: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::AppState>>>) -> Result<Vec<Vec<String>>, String> {
    let root = state.lock().map_err(|e| e.to_string())?.game_path.clone();
    if root.as_os_str().is_empty() || !root.is_dir() {
        return Ok(Vec::new());
    }
    let sets = tauri::async_runtime::spawn_blocking(move || find(&root)).await.map_err(|e| e.to_string())?;
    Ok(sets.into_iter().map(|s| s.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_name_drops_state_priority_and_bang() {
        for f in ["Skin_9999999_P.pak", "!Skin.pak", "Skin_9999999_P.bak_repak", "Skin_99999999_P.pak_disabled", "Skin.pak.bak_repak"] {
            assert_eq!(bare_name(Path::new(f)), "Skin", "{f}");
        }
        assert_eq!(bare_name(Path::new("Spider-Man 2099_9999999_P.pak")), "Spider-Man 2099");
        assert_eq!(bare_name(Path::new("Mod_1_P_9999999_P.pak")), "Mod");
    }

    #[test]
    fn key_matches_loadout_member_keys() {
        let root = Path::new("C:/Game/Paks/~mods");
        assert_eq!(key(root, Path::new("C:/Game/Paks/~mods/Skin_9999999_P.pak")), "|skin");
        assert_eq!(key(root, Path::new("C:/Game/Paks/~mods/A/Sub/!Skin.bak_repak")), "a/sub|skin");
    }

    fn put(p: &Path, data: &[u8]) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, data).unwrap();
    }

    #[test]
    fn identical_mods_are_one_set_and_same_size_others_are_not() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for (name, data) in [("A_9999999_P", b"one"), ("Sub/B_9999999_P", b"one"), ("C_9999999_P", b"two")] {
            put(&root.join(format!("{name}.pak")), b"pak");
            put(&root.join(format!("{name}.utoc")), b"toc");
            put(&root.join(format!("{name}.ucas")), data);
        }
        put(&root.join("Off_9999999_P.bak_repak"), b"pak"); // an off copy, with no IoStore files: another shape
        let sets = find(root);
        assert_eq!(sets.len(), 1, "{sets:?}");
        let mut names: Vec<String> = sets[0].iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["A_9999999_P.pak", "B_9999999_P.pak"]);
    }

    #[test]
    fn a_record_counts_only_while_its_mod_is_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let (src, root) = (dir.path().join("dl"), dir.path().join("mods"));
        put(&src.join("Skin.pak"), b"source");
        let m = crate::install_mod::InstallableMod { mod_path: src.join("Skin.pak"), repak: true, ..Default::default() };
        let pak = root.join("Skin_9999999_P.pak");
        for (x, d) in [("pak", &b"built"[..]), ("utoc", b"t"), ("ucas", b"c")] { put(&pak.with_extension(x), d); }
        let c = check(&root, &m);
        assert_eq!(c.same, None);
        record(&root, &pak, c.source.unwrap());
        assert_eq!(check(&root, &m).same, Some(pak.clone()), "the same download again");
        let other = crate::install_mod::InstallableMod { obfuscate: true, ..m.clone() };
        assert_eq!(check(&root, &other).same, None, "other install options build another mod");
        put(&pak.with_extension("ucas"), b"updated"); // an update changed the installed mod
        assert_eq!(check(&root, &m).same, None, "a stale record no longer counts");
    }

    #[test]
    fn a_file_shifted_between_parts_hashes_differently() {
        let dir = tempfile::tempdir().unwrap();
        let p = |n: &str| dir.path().join(n);
        put(&p("a1"), b"ab");
        put(&p("a2"), b"c");
        put(&p("b1"), b"a");
        put(&p("b2"), b"bc");
        assert_ne!(hash_files(&[p("a1"), p("a2")], None).unwrap(), hash_files(&[p("b1"), p("b2")], None).unwrap());
    }

    #[test]
    fn a_ready_iostore_mod_matches_its_installed_copy() {
        let dir = tempfile::tempdir().unwrap();
        let (src, root) = (dir.path().join("dl"), dir.path().join("mods"));
        for (x, d) in [("pak", &b"p"[..]), ("utoc", b"t"), ("ucas", b"c")] {
            put(&src.join(format!("Skin.{x}")), d);
            put(&root.join(format!("Skin_9999999_P.{x}")), d);
        }
        let m = crate::install_mod::InstallableMod { mod_path: src.join("Skin.pak"), iostore: true, ..Default::default() };
        assert_eq!(check(&root, &m).same, Some(root.join("Skin_9999999_P.pak")));
        put(&root.join("Skin_9999999_P.ucas"), b"xx");
        assert_eq!(check(&root, &m).same, None, "a changed file is another mod");
    }
}

/// The install from the Library: mods already installed (same content, any name or folder) are taken out before
/// anything is written, and the window hears which (`xtra_install_same`: the name it came as, and the installed mod's
/// path). `sources` lines up with the mods left, for `record_installed`.
pub struct LeftOut {
    pub same: usize,
    sources: Vec<Option<Source>>,
}

pub fn leave_out_installed(root: &Path, mods: &mut Vec<crate::install_mod::InstallableMod>, window: &tauri::Window) -> LeftOut {
    use tauri::Emitter;
    let (mut sources, mut same) = (Vec::new(), Vec::new());
    mods.retain(|m| {
        if !m.enabled {
            sources.push(None);
            return true;
        }
        let c = check(root, m);
        match c.same {
            Some(p) => {
                same.push(serde_json::json!({ "name": m.mod_name, "path": p }));
                false
            }
            None => {
                sources.push(c.source);
                true
            }
        }
    });
    if !same.is_empty() {
        let _ = window.emit("xtra_install_same", &same);
    }
    LeftOut { same: same.len(), sources }
}

/// After the install: each mod that went in records the source it came from (its name is final by now).
pub fn record_installed(root: &Path, left: LeftOut, mods: &[crate::install_mod::InstallableMod], results: &[crate::install_mod::install_mod_logic::ModInstallResult]) {
    for (m, s) in mods.iter().zip(left.sources) {
        let Some(s) = s else { continue };
        if results.iter().any(|r| r.success && r.mod_name == m.mod_name) {
            let dir = if m.install_subfolder.is_empty() { root.to_path_buf() } else { root.join(&m.install_subfolder) };
            record(root, &dir.join(format!("{}.pak", m.mod_name)), s);
        }
    }
}
