//! repakxtra: snapshots of the mods folder (Setup > Snapshots, custom/SnapshotCard.tsx). A snapshot is a full copy of
//! ~mods and the Setup files in Binaries\Win64 (dsound.dll and plugins\) in %APPDATA%\Repak-X\snapshots\<unix secs>.
//! A game update, a reinstall, or Steam's Verify integrity of game files can leave mods or the bypass missing. Restore
//! puts back only what is gone and never overwrites or deletes a file that is there, so it cannot undo later changes.
//! A mod counts as there under another priority (a rename) or switched off (.bak_repak), so restore never doubles one.

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::State;
use walkdir::WalkDir;

/// The newest snapshots kept: making a fourth deletes the oldest.
const KEEP: usize = 3;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Snapshot {
    id: String,
    created: u64,
    files: usize,
    bytes: u64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Restored {
    mods: usize,
    setup: usize,
}

fn root() -> PathBuf {
    crate::app_dir().join("snapshots")
}

/// repakxtra: staging folders a closed run left (each can hold a whole copy of ~mods), last changed before `before`.
pub fn sweep_staging(before: std::time::SystemTime) {
    sweep_staging_in(&root(), before)
}
fn sweep_staging_in(root: &Path, before: std::time::SystemTime) {
    for e in fs::read_dir(root).into_iter().flatten().flatten() {
        let old = e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < before);
        if old && e.file_type().is_ok_and(|t| t.is_dir()) && e.file_name().to_string_lossy().starts_with(".staging-") {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

/// Every file under `dir` as (path relative to `dir`, size).
fn files(dir: &Path) -> Vec<(PathBuf, u64)> {
    WalkDir::new(dir).into_iter().filter_map(Result::ok).filter(|e| e.file_type().is_file())
        .filter_map(|e| Some((e.path().strip_prefix(dir).ok()?.to_path_buf(), e.metadata().ok()?.len())))
        .collect()
}

/// Like `files`, but any folder or file that cannot be read is an error: a snapshot never leaves one out quietly.
fn try_files(dir: &Path) -> Result<Vec<(PathBuf, u64)>, String> {
    let mut out = Vec::new();
    for e in WalkDir::new(dir) {
        let e = e.map_err(|e| e.to_string())?;
        if e.file_type().is_file() {
            let len = e.metadata().map_err(|e| e.to_string())?.len();
            out.push((e.path().strip_prefix(dir).map_err(|e| e.to_string())?.to_path_buf(), len));
        }
    }
    Ok(out)
}

/// `setup_files` for a snapshot: a loader or plugins folder that is not there is fine, one that cannot be read is not.
fn try_setup_files(win64: &Path) -> Result<Vec<(PathBuf, u64)>, String> {
    let mut out = Vec::new();
    for name in ["dsound.dll", "dsound.dll.disabled"] {
        match fs::metadata(win64.join(name)) {
            Ok(m) => out.push((PathBuf::from(name), m.len())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{name}: {e}")),
        }
    }
    match fs::metadata(win64.join("plugins")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("plugins: {e}")),
        Ok(_) => out.extend(try_files(&win64.join("plugins"))?.into_iter().map(|(p, n)| (Path::new("plugins").join(p), n))),
    }
    Ok(out)
}

/// The Setup files beside the game exe: the loader (on or off) and every plugin, as paths relative to Win64.
fn setup_files(win64: &Path) -> Vec<(PathBuf, u64)> {
    let mut out: Vec<_> = ["dsound.dll", "dsound.dll.disabled"].iter().map(PathBuf::from)
        .filter_map(|p| Some((p.clone(), fs::metadata(win64.join(&p)).ok()?.len()))).collect();
    out.extend(files(&win64.join("plugins")).into_iter().map(|(p, n)| (Path::new("plugins").join(p), n)));
    out
}

/// One mod file's identity whatever its folder, priority, or on/off state: "X_9999999_P.bak_repak" -> "x.pak".
fn mod_key(rel: &Path) -> String {
    let name = rel.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let (stem, ext) = name.rsplit_once('.').unwrap_or((&name, ""));
    let ext = if ext == "bak_repak" { "pak" } else { ext };
    static PRIORITY: OnceLock<regex_lite::Regex> = OnceLock::new();
    let re = PRIORITY.get_or_init(|| regex_lite::Regex::new(r"^!?(.*?)(_9+)?(_p)?$").unwrap());
    let base = re.captures(stem).and_then(|c| c.get(1)).map_or(stem, |m| m.as_str());
    format!("{base}.{ext}")
}

/// A Setup file's identity: the loader on or off is the same file.
fn setup_key(rel: &Path) -> String {
    rel.to_string_lossy().to_lowercase().trim_end_matches(".disabled").to_string()
}

fn same_bytes(a: &Path, b: &Path) -> bool {
    use std::io::Read;
    let (Ok(mut x), Ok(mut y)) = (fs::File::open(a), fs::File::open(b)) else { return false };
    let (mut p, mut q) = (vec![0u8; 1 << 20], vec![0u8; 1 << 20]);
    loop {
        let n = match x.read(&mut p) { Ok(n) => n, Err(_) => return false };
        if n == 0 { return y.read(&mut q).is_ok_and(|m| m == 0); }
        if y.read_exact(&mut q[..n]).is_err() || p[..n] != q[..n] { return false; }
    }
}

/// `prev`: the same folder in the newest snapshot. A file it holds unchanged (same bytes, checked after size and time)
/// becomes a hard link to that copy instead of a second copy, so snapshots of a library that barely changed take the
/// space of one. Snapshot files are only ever read (restore copies them out) or deleted, so a link is never written
/// through. A link that cannot be made (another drive, FAT) is a plain copy.
/// shortcut: list sizes still count a linked file in every snapshot, upgrade if Storage must show the real disk use.
fn copy_all(list: &[(PathBuf, u64)], from: &Path, to: &Path, prev: Option<&Path>) -> std::io::Result<()> {
    // size and time only rule a file out quickly: installs keep a download's time, so a replaced mod of the same size
    // can carry the old one's time. A link needs the same bytes
    let same = |a: &Path, b: &Path| match (fs::metadata(a), fs::metadata(b)) {
        (Ok(x), Ok(y)) => x.len() == y.len() && x.modified().ok().is_some_and(|t| y.modified().ok() == Some(t)) && same_bytes(a, b),
        _ => false,
    };
    for (rel, _) in list {
        let dest = to.join(rel);
        fs::create_dir_all(dest.parent().unwrap_or(to))?;
        let old = prev.map(|p| p.join(rel));
        if !old.as_deref().is_some_and(|old| same(&from.join(rel), old) && fs::hard_link(old, &dest).is_ok()) {
            fs::copy(from.join(rel), dest)?;
        }
    }
    Ok(())
}

fn create_at(root: &Path, id: &str, mods: &Path, win64: &Path) -> Result<Snapshot, String> {
    // a folder that cannot be read would leave a partial copy that looks whole: refuse before copying or pruning
    let unread = |e: String| format!("Could not read every file, so no snapshot was made: {e}");
    let (m, s) = (try_files(mods).map_err(unread)?, try_setup_files(win64).map_err(unread)?);
    if m.is_empty() && s.is_empty() {
        return Err("The mods folder is empty: there is nothing to snapshot.".into());
    }
    // copied under a name the list skips, then renamed in: a copy cut short (a full disk, a crash) is never listed
    let staging = root.join(format!(".staging-{id}"));
    let _ = fs::remove_dir_all(&staging);
    let prev = list_at(root).first().map(|x| root.join(&x.id));
    let made = copy_all(&m, mods, &staging.join("mods"), prev.as_ref().map(|p| p.join("mods")).as_deref())
        .and_then(|_| copy_all(&s, win64, &staging.join("win64"), prev.as_ref().map(|p| p.join("win64")).as_deref()));
    if let Err(e) = made {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("Could not make the snapshot: {e}"));
    }
    // two made in the same second: the second takes the next free id, never the first one's folder
    let mut n: u64 = id.parse().map_err(|_| "Unknown snapshot".to_string())?;
    while root.join(n.to_string()).exists() {
        n += 1;
    }
    let id = n.to_string();
    if let Err(e) = fs::rename(&staging, root.join(&id)) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("Could not make the snapshot: {e}"));
    }
    let mut all = list_at(root);
    for old in all.split_off(KEEP.min(all.len())) {
        let _ = fs::remove_dir_all(root.join(&old.id));
    }
    all.into_iter().find(|x| x.id == id).ok_or_else(|| "The snapshot was not saved.".into())
}

/// The mod files an imported zip may bring: never a loader or plugin (a .dll or .asi from a file of unknown origin
/// would run inside the game), only what goes in ~mods.
fn importable(rel: &Path) -> bool {
    rel.extension().and_then(|e| e.to_str()).is_some_and(|e| ["pak", "utoc", "ucas", "bak_repak"].contains(&e.to_ascii_lowercase().as_str()))
}

/// A snapshot from a .zip: either a snapshot's own layout (mods\ at the top, or inside one folder) or a zip of mod
/// files. Unzipped under a name the list skips (entries that would leave it are skipped), only importable files kept
/// under mods\, then renamed in as the newest snapshot. Nothing is pruned: making the next one does that as usual.
fn import_at(root: &Path, id: &str, zip: &Path) -> Result<Snapshot, String> {
    let staging = root.join(format!(".staging-import-{id}"));
    let raw = staging.join("raw");
    let _ = fs::remove_dir_all(&staging);
    let out = (|| -> Result<Snapshot, String> {
        fs::create_dir_all(&raw).map_err(|e| e.to_string())?;
        crate::install_mod::install_mod_logic::archives::extract_zip(&zip.to_string_lossy(), &raw.to_string_lossy())
            .map_err(|e| format!("Could not read the zip: {e}"))?;
        // its mods: raw\mods, raw\<one folder>\mods, or everything in it
        let one = fs::read_dir(&raw).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).collect::<Vec<_>>();
        let from = if raw.join("mods").is_dir() { raw.join("mods") }
            else if one.len() == 1 && one[0].join("mods").is_dir() { one[0].join("mods") }
            else { raw.clone() };
        let keep: Vec<_> = files(&from).into_iter().filter(|(rel, _)| importable(rel)).collect();
        if keep.is_empty() {
            return Err("The zip has no mod files (.pak, .utoc, or .ucas), so nothing was imported.".into());
        }
        let snap = staging.join("snap");
        for (rel, _) in &keep {
            let dest = snap.join("mods").join(rel);
            fs::create_dir_all(dest.parent().unwrap_or(&snap)).map_err(|e| e.to_string())?;
            fs::rename(from.join(rel), &dest).map_err(|e| e.to_string())?;
        }
        let mut n: u64 = id.parse().map_err(|_| "Unknown snapshot".to_string())?;
        while root.join(n.to_string()).exists() { n += 1; }
        let id = n.to_string();
        fs::rename(&snap, root.join(&id)).map_err(|e| format!("Could not import the snapshot: {e}"))?;
        list_at(root).into_iter().find(|x| x.id == id).ok_or_else(|| "The snapshot was not saved.".into())
    })();
    let _ = fs::remove_dir_all(&staging);
    out
}

/// A snapshot's mod files as a .zip at `to`, laid out as import_at reads it (mods\...). Stored, not compressed: paks
/// barely shrink and stay fast to write. Written under a temporary name, then renamed, so a cut-short zip never looks done.
/// The loader and plugins stay out: import never takes them either.
fn export_at(snap: &Path, to: &Path) -> Result<u64, String> {
    use std::io::Write;
    let list = files(&snap.join("mods"));
    if list.is_empty() { return Err("This snapshot has no mod files to export.".into()) }
    let tmp = to.with_extension("zip.repakxtra-part");
    let write = || -> Result<(), String> {
        let mut z = zip::ZipWriter::new(std::io::BufWriter::new(fs::File::create(&tmp).map_err(|e| e.to_string())?));
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).large_file(true);
        for (rel, _) in &list {
            let name = format!("mods/{}", rel.to_string_lossy().replace('\\', "/"));
            z.start_file(name, opts).map_err(|e| e.to_string())?;
            let mut f = fs::File::open(snap.join("mods").join(rel)).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut z).map_err(|e| e.to_string())?;
        }
        z.finish().map_err(|e| e.to_string())?.flush().map_err(|e| e.to_string())
    };
    if let Err(e) = write() { let _ = fs::remove_file(&tmp); return Err(format!("Could not export the snapshot: {e}")) }
    // rename replaces an existing file in one step (MoveFileEx on Windows): the old one stays if it fails
    fs::rename(&tmp, to).map_err(|e| { let _ = fs::remove_file(&tmp); format!("Could not export the snapshot: {e}") })?;
    Ok(list.len() as u64)
}

fn list_at(root: &Path) -> Vec<Snapshot> {
    let mut out: Vec<_> = fs::read_dir(root).into_iter().flatten().flatten().filter_map(|e| {
        let id = e.file_name().to_string_lossy().to_string();
        let created = id.parse().ok()?;
        let all = files(&e.path());
        Some(Snapshot { id, created, files: all.len(), bytes: all.iter().map(|f| f.1).sum() })
    }).collect();
    out.sort_by(|a, b| b.created.cmp(&a.created));
    out
}

/// What the snapshot has that is gone now, as (path in the snapshot, where it goes back), for mod files and Setup files.
/// A mod file whose bundle is still there under another priority or folder goes back beside it, under its name, so a
/// restored .utoc or .ucas always matches the .pak that stayed.
fn missing_at(snap: &Path, mods: &Path, win64: &Path) -> (Vec<(PathBuf, PathBuf)>, Vec<(PathBuf, PathBuf)>) {
    let now = files(mods);
    let have: HashSet<_> = now.iter().map(|f| mod_key(&f.0)).collect();
    let base = |key: &str| key.rsplit_once('.').map_or(key, |(b, _)| b).to_string();
    // each bundle still there: its folder and file name without the extension ("Sub/Cool_99_P")
    let bundles: std::collections::HashMap<String, PathBuf> = now.iter().filter_map(|f| {
        let stem = f.0.file_stem()?;
        Some((base(&mod_key(&f.0)), f.0.with_file_name(stem)))
    }).collect();
    let have_setup: HashSet<_> = setup_files(win64).iter().map(|f| setup_key(&f.0)).collect();
    // each file still there stands for one snapshot file of its name: one in the same folder first (a new priority, or
    // switched off), then one of the same size in another folder (moved). Two mods that share a name are two mods.
    let folder = |p: &Path| p.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut left: std::collections::HashMap<String, Vec<(PathBuf, u64)>> = std::collections::HashMap::new();
    for (p, n) in &now {
        left.entry(mod_key(p)).or_default().push((folder(p), *n));
    }
    let mut take = |p: &Path, n: u64, same_folder: bool| {
        let Some(v) = left.get_mut(&mod_key(p)) else { return false };
        let i = v.iter().position(|(f, m)| if same_folder { *f == folder(p) } else { *m == n });
        i.map(|i| v.swap_remove(i)).is_some()
    };
    let unmatched: Vec<_> = files(&snap.join("mods")).into_iter().filter(|(p, n)| !take(p, *n, true)).collect();
    let gone_mods = unmatched.into_iter().filter(|(p, n)| !take(p, *n, false)).map(|(p, _)| {
        let ext = p.extension().map(|e| e.to_string_lossy().to_string());
        let to = match (bundles.get(&base(&mod_key(&p))), ext) {
            // a companion whose name is gone everywhere goes back beside its renamed pak
            (Some(stay), Some(ext)) if !have.contains(&mod_key(&p)) => stay.with_extension(ext),
            _ => p.clone(),
        };
        (p, to)
    }).collect();
    let gone_setup = files(&snap.join("win64")).into_iter().map(|f| f.0).filter(|p| !have_setup.contains(&setup_key(p))).map(|p| (p.clone(), p)).collect();
    (gone_mods, gone_setup)
}

fn restore_at(snap: &Path, mods: &Path, win64: &Path) -> Result<Restored, String> {
    let (gone_mods, gone_setup) = missing_at(snap, mods, win64);
    let put = |list: &[(PathBuf, PathBuf)], from: &Path, to: &Path| -> Result<usize, String> {
        let mut n = 0;
        for (rel, back) in list.iter().filter(|(_, back)| !to.join(back).exists()) {
            let dest = to.join(back);
            // a temporary name first: a copy cut short (a full disk) never counts as put back on the next restore
            let tmp = dest.with_file_name(format!("{}.repakxtra-restoring", dest.file_name().unwrap_or_default().to_string_lossy()));
            let done = fs::create_dir_all(dest.parent().unwrap_or(to)).and_then(|_| fs::copy(from.join(rel), &tmp)).and_then(|_| fs::rename(&tmp, &dest));
            if let Err(e) = done {
                let _ = fs::remove_file(&tmp);
                return Err(format!("Could not put back {}: {e}", rel.display()));
            }
            n += 1;
        }
        Ok(n)
    };
    Ok(Restored { mods: put(&gone_mods, &snap.join("mods"), mods)?, setup: put(&gone_setup, &snap.join("win64"), win64)? })
}

/// Snapshot ids are folder names: digits only, so an id never reaches outside the snapshots folder.
fn snap_dir(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.bytes().all(|c| c.is_ascii_digit()) {
        return Err("Unknown snapshot".into());
    }
    Ok(root().join(id))
}

fn dirs_of(state: &State<'_, Arc<Mutex<crate::AppState>>>) -> Result<(PathBuf, PathBuf), String> {
    let mods = state.lock().unwrap().game_path.clone();
    let win64 = crate::xtra_setup::win64_dir(&mods).ok_or("Set the game mods path in Settings first")?;
    Ok((mods, win64))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn snapshot_list() -> Result<Vec<Snapshot>, String> {
    blocking(|| Ok(list_at(&root()))).await
}

/// The size a snapshot would be now: (files, bytes).
#[tauri::command]
pub async fn snapshot_estimate(state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<(usize, u64), String> {
    let (mods, win64) = dirs_of(&state)?;
    blocking(move || {
        let all: Vec<_> = files(&mods).into_iter().chain(setup_files(&win64)).collect();
        Ok((all.len(), all.iter().map(|f| f.1).sum()))
    }).await
}

/// Setup > Snapshots > Export: snapshot `id`'s mod files as a .zip where the person chose (export_at). Returns the file count.
#[tauri::command]
pub async fn snapshot_export(id: String, path: String) -> Result<u64, String> {
    let _alone = crate::xtra_mutation::alone("a snapshot export")?; // no Delete, cleanup, or pruning takes its source meanwhile
    let snap = snap_dir(&id)?;
    let to = PathBuf::from(path);
    if !to.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")) { return Err("Save it as a .zip file.".into()) }
    blocking(move || export_at(&snap, &to)).await
}

/// Setup > Snapshots > Import: a .zip the person picked becomes the newest snapshot (import_at).
#[tauri::command]
pub async fn snapshot_import(path: String) -> Result<Snapshot, String> {
    let _alone = crate::xtra_mutation::alone("a snapshot")?;
    let zip = PathBuf::from(path);
    if !zip.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")) || !zip.is_file() {
        return Err("Pick a .zip file.".into());
    }
    let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs().to_string();
    blocking(move || { fs::create_dir_all(root()).map_err(|e| e.to_string())?; import_at(&root(), &id, &zip) }).await
}

#[tauri::command]
pub async fn snapshot_create(state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<Snapshot, String> {
    let _alone = crate::xtra_mutation::alone("a snapshot")?; // no mod change mixes file versions into the copy
    let (mods, win64) = dirs_of(&state)?;
    let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs().to_string();
    blocking(move || create_at(&root(), &id, &mods, &win64)).await
}

/// How much of the newest snapshot is gone: (snapshot, mod files gone, Setup files gone). The startup check reads it.
#[tauri::command]
pub async fn snapshot_missing(state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<Option<(Snapshot, usize, usize)>, String> {
    let (mods, win64) = dirs_of(&state)?;
    blocking(move || {
        let Some(newest) = list_at(&root()).into_iter().next() else { return Ok(None) };
        let (m, s) = missing_at(&root().join(&newest.id), &mods, &win64);
        Ok(Some((newest, m.len(), s.len())))
    }).await
}

#[tauri::command]
pub async fn snapshot_restore(id: String, state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<Restored, String> {
    let _alone = crate::xtra_mutation::alone("a restore")?;
    crate::xtra_identity::upstream_guard()?;
    if crate::is_game_process_running() {
        return Err("Marvel Rivals is running. Close it first.".into());
    }
    let (mods, win64) = dirs_of(&state)?;
    let snap = snap_dir(&id)?;
    blocking(move || restore_at(&snap, &mods, &win64)).await
}

#[tauri::command]
pub async fn snapshot_delete(id: String) -> Result<(), String> {
    let _mutation = crate::xtra_mutation::edit()?; // never the snapshot a restore is reading
    let dir = snap_dir(&id)?;
    blocking(move || fs::remove_dir_all(&dir).map_err(|e| format!("Could not delete the snapshot: {e}"))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(p: &Path, body: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    #[test]
    fn keys_ignore_priority_folder_and_off_state() {
        assert_eq!(mod_key(Path::new("A/Cool_9999999_P.pak")), "cool.pak");
        assert_eq!(mod_key(Path::new("Cool_P.bak_repak")), "cool.pak");
        assert_eq!(mod_key(Path::new("!Cool_99_P.utoc")), "cool.utoc");
        assert_eq!(setup_key(Path::new("dsound.dll.disabled")), "dsound.dll");
    }

    #[test]
    fn restore_puts_back_only_what_is_gone() {
        let t = tempfile::tempdir().unwrap();
        let (root, mods, win64) = (t.path().join("snaps"), t.path().join("mods"), t.path().join("win64"));
        put(&mods.join("Sub/Skin_P.pak"), "skin");
        put(&mods.join("Gone_P.pak"), "gone");
        put(&mods.join("Off_P.pak"), "off");
        put(&mods.join("Edited_P.pak"), "old");
        put(&win64.join("dsound.dll"), "loader");
        put(&win64.join("plugins/Bypass.asi"), "asi");
        let s = create_at(&root, "100", &mods, &win64).unwrap();
        assert_eq!((s.files, s.bytes), (6, 4 + 4 + 3 + 3 + 6 + 3));

        // a game update: one mod and the bypass gone; others renamed, switched off, or changed by the user since
        fs::remove_file(mods.join("Gone_P.pak")).unwrap();
        fs::remove_file(win64.join("plugins/Bypass.asi")).unwrap();
        fs::rename(mods.join("Sub/Skin_P.pak"), mods.join("Sub/Skin_9999999_P.pak")).unwrap();
        fs::rename(mods.join("Off_P.pak"), mods.join("Off_P.bak_repak")).unwrap();
        fs::write(mods.join("Edited_P.pak"), "new").unwrap();
        fs::rename(win64.join("dsound.dll"), win64.join("dsound.dll.disabled")).unwrap();

        assert_eq!(restore_at(&root.join("100"), &mods, &win64).unwrap(), Restored { mods: 1, setup: 1 });
        assert_eq!(fs::read_to_string(mods.join("Gone_P.pak")).unwrap(), "gone");
        assert_eq!(fs::read_to_string(win64.join("plugins/Bypass.asi")).unwrap(), "asi");
        assert!(!mods.join("Sub/Skin_P.pak").exists() && !mods.join("Off_P.pak").exists(), "renamed and off mods are not doubled");
        assert!(!win64.join("dsound.dll").exists(), "the loader stays off");
        assert_eq!(fs::read_to_string(mods.join("Edited_P.pak")).unwrap(), "new", "a changed file is never overwritten");
        assert_eq!(restore_at(&root.join("100"), &mods, &win64).unwrap(), Restored { mods: 0, setup: 0 }, "a second restore changes nothing");
    }

    #[test]
    fn an_unchanged_file_is_linked_to_the_last_snapshot_a_changed_one_copied() {
        let t = tempfile::tempdir().unwrap();
        let (root, mods, win64) = (t.path().join("snaps"), t.path().join("mods"), t.path().join("win64"));
        put(&mods.join("Same_P.pak"), "same");
        put(&mods.join("Changed_P.pak"), "old");
        create_at(&root, "1", &mods, &win64).unwrap();
        fs::write(mods.join("Changed_P.pak"), "new!").unwrap();
        create_at(&root, "2", &mods, &win64).unwrap();
        assert_eq!(fs::read_to_string(root.join("2/mods/Changed_P.pak")).unwrap(), "new!");
        assert_eq!(fs::read_to_string(root.join("1/mods/Changed_P.pak")).unwrap(), "old", "the old snapshot keeps its copy");
        // one file on disk (a write through one name shows in the other), and deleting the first leaves the second's whole
        fs::write(root.join("1/mods/Same_P.pak"), "link").unwrap();
        assert_eq!(fs::read_to_string(root.join("2/mods/Same_P.pak")).unwrap(), "link");
        fs::remove_dir_all(root.join("1")).unwrap();
        assert_eq!(fs::read_to_string(root.join("2/mods/Same_P.pak")).unwrap(), "link");
        fs::write(root.join("2/mods/Same_P.pak"), "x").unwrap();
        create_at(&root, "3", &mods, &win64).unwrap();
        assert_eq!(fs::read_to_string(root.join("3/mods/Same_P.pak")).unwrap(), "same", "a snapshot copy that no longer matches is not linked");
        // a replaced mod with the same size and the old one's time (an install keeps a download's time): copied
        let t0 = std::time::SystemTime::now() - std::time::Duration::from_secs(86_400);
        let stamp = |p: &Path| fs::File::options().write(true).open(p).unwrap().set_modified(t0).unwrap();
        fs::write(mods.join("Twin_P.pak"), "aaaa").unwrap();
        stamp(&mods.join("Twin_P.pak"));
        create_at(&root, "4", &mods, &win64).unwrap();
        fs::write(mods.join("Twin_P.pak"), "bbbb").unwrap();
        stamp(&mods.join("Twin_P.pak"));
        create_at(&root, "5", &mods, &win64).unwrap();
        assert_eq!(fs::read_to_string(root.join("5/mods/Twin_P.pak")).unwrap(), "bbbb");
        assert_eq!(fs::read_to_string(root.join("4/mods/Twin_P.pak")).unwrap(), "aaaa");
    }

    #[test]
    fn an_imported_zip_keeps_only_mod_files_and_restores_like_a_snapshot() {
        use std::io::Write;
        let t = tempfile::tempdir().unwrap();
        let (root, mods, win64) = (t.path().join("snaps"), t.path().join("mods"), t.path().join("win64"));
        fs::create_dir_all(&root).unwrap();
        let zip_at = |name: &str, entries: &[(&str, &str)]| {
            let path = t.path().join(name);
            let mut z = zip::ZipWriter::new(fs::File::create(&path).unwrap());
            for (n, body) in entries {
                z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
                z.write_all(body.as_bytes()).unwrap();
            }
            z.finish().unwrap();
            path
        };
        // a snapshot's own layout inside one folder, with a loader and a readme that must not come in
        let a = zip_at("a.zip", &[("1700/mods/Sub/Skin_P.pak", "skin"), ("1700/mods/Skin_P.utoc", "toc"), ("1700/win64/dsound.dll", "x"), ("1700/readme.txt", "hi")]);
        let s = import_at(&root, "10", &a).unwrap();
        assert_eq!(s.files, 2);
        assert!(!root.join("10/win64").exists(), "no loader or plugin from a zip");
        assert_eq!(restore_at(&root.join("10"), &mods, &win64).unwrap(), Restored { mods: 2, setup: 0 });
        assert_eq!(fs::read_to_string(mods.join("Sub/Skin_P.pak")).unwrap(), "skin");
        // a plain zip of mods, and one with nothing to import
        let b = zip_at("b.zip", &[("Cool_P.pak", "c")]);
        assert_eq!(import_at(&root, "10", &b).unwrap().id, "11", "the next free id");
        let c = zip_at("c.zip", &[("notes.txt", "n")]);
        assert!(import_at(&root, "12", &c).is_err());
        assert!(fs::read_dir(&root).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with(".staging")), "no staging left");
        // an export imports back as the same mod files
        let out = t.path().join("out.zip");
        assert_eq!(export_at(&root.join("10"), &out).unwrap(), 2);
        let back = import_at(&root, "20", &out).unwrap();
        assert_eq!(back.files, 2);
        assert_eq!(fs::read_to_string(root.join(&back.id).join("mods/Sub/Skin_P.pak")).unwrap(), "skin");
        assert!(!t.path().join("out.zip.repakxtra-part").exists());
        assert_eq!(export_at(&root.join("10"), &out).unwrap(), 2, "an export over an existing file replaces it");
        assert_eq!(import_at(&root, "30", &out).unwrap().files, 2);
    }

    #[test]
    fn a_name_kept_in_another_folder_does_not_hide_a_deleted_mod() {
        let t = tempfile::tempdir().unwrap();
        let (root, mods, win64) = (t.path().join("snaps"), t.path().join("mods"), t.path().join("win64"));
        fs::create_dir_all(&win64).unwrap();
        // the audit's case: the same three names in two folders, one folder deleted
        for name in ["Skin_P.pak", "Skin_P.utoc", "Skin_P.ucas"] {
            put(&mods.join("Hero A").join(name), "a");
            put(&mods.join("Hero B").join(name), "bb");
        }
        put(&mods.join("Moved_P.pak"), "moved");
        create_at(&root, "100", &mods, &win64).unwrap();
        fs::remove_dir_all(mods.join("Hero B")).unwrap();
        // a mod moved to another folder with the same size still counts as there
        fs::create_dir_all(mods.join("Hero A/Sub")).unwrap();
        fs::rename(mods.join("Moved_P.pak"), mods.join("Hero A/Sub/Moved_P.pak")).unwrap();

        let (mut gone, _) = missing_at(&root.join("100"), &mods, &win64);
        gone.sort();
        let want: Vec<_> = ["Skin_P.pak", "Skin_P.ucas", "Skin_P.utoc"].iter().map(|n| Path::new("Hero B").join(n)).map(|p| (p.clone(), p)).collect();
        assert_eq!(gone, want);
        assert_eq!(restore_at(&root.join("100"), &mods, &win64).unwrap(), Restored { mods: 3, setup: 0 });
        assert_eq!(fs::read_to_string(mods.join("Hero B/Skin_P.pak")).unwrap(), "bb");
        assert_eq!(fs::read_to_string(mods.join("Hero A/Skin_P.pak")).unwrap(), "a");
    }

    #[test]
    fn the_start_sweep_takes_only_staging_folders() {
        let t = tempfile::tempdir().unwrap();
        for d in [".staging-5/mods", ".staging-import-6/raw", "100/mods", ".stagingnot/x"] {
            put(&t.path().join(d).join("a.pak"), "x");
        }
        put(&t.path().join(".staging-file"), "x");
        sweep_staging_in(t.path(), std::time::SystemTime::UNIX_EPOCH);
        assert!(t.path().join(".staging-5").exists(), "newer than the run: kept");
        sweep_staging_in(t.path(), std::time::SystemTime::now() + std::time::Duration::from_secs(60));
        let mut left: Vec<_> = fs::read_dir(t.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, [".staging-file", ".stagingnot", "100"]);
    }

    #[test]
    fn keeps_the_newest_three() {
        let t = tempfile::tempdir().unwrap();
        let (root, mods, win64) = (t.path().join("snaps"), t.path().join("mods"), t.path().join("win64"));
        assert!(create_at(&root, "1", &mods, &win64).is_err(), "nothing to copy");
        put(&mods.join("A_P.pak"), "a");
        for id in ["1", "2", "3", "4"] {
            create_at(&root, id, &mods, &win64).unwrap();
        }
        assert_eq!(list_at(&root).iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["4", "3", "2"]);
        assert!(snap_dir("..\\x").is_err() && snap_dir("").is_err());
    }

    #[test]
    fn same_second_and_cut_short_copies() {
        let t = tempfile::tempdir().unwrap();
        let (root, mods, win64) = (t.path().join("snaps"), t.path().join("mods"), t.path().join("win64"));
        put(&mods.join("A_P.pak"), "a");
        let (a, b) = (create_at(&root, "50", &mods, &win64).unwrap(), create_at(&root, "50", &mods, &win64).unwrap());
        assert_eq!((a.id.as_str(), b.id.as_str()), ("50", "51"), "the second in one second gets its own folder");
        fs::create_dir_all(root.join(".staging-60/mods")).unwrap();
        assert_eq!(list_at(&root).len(), 2, "a copy cut short is never listed");
    }

    #[test]
    fn a_companion_goes_back_beside_its_pak() {
        let t = tempfile::tempdir().unwrap();
        let (root, mods, win64) = (t.path().join("snaps"), t.path().join("mods"), t.path().join("win64"));
        for ext in ["pak", "utoc", "ucas"] {
            put(&mods.join(format!("Cool_9_P.{ext}")), ext);
        }
        create_at(&root, "1", &mods, &win64).unwrap();
        // the priority went up (all three renamed into a folder), then the .utoc went missing
        fs::create_dir_all(mods.join("Sub")).unwrap();
        for ext in ["pak", "ucas"] {
            fs::rename(mods.join(format!("Cool_9_P.{ext}")), mods.join(format!("Sub/Cool_999_P.{ext}"))).unwrap();
        }
        fs::remove_file(mods.join("Cool_9_P.utoc")).unwrap();
        assert_eq!(restore_at(&root.join("1"), &mods, &win64).unwrap(), Restored { mods: 1, setup: 0 });
        assert_eq!(fs::read_to_string(mods.join("Sub/Cool_999_P.utoc")).unwrap(), "utoc", "under the surviving pak's name");
        assert!(!mods.join("Cool_9_P.utoc").exists());
    }
}
