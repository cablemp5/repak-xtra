//! The supplied SkipLoginVideo replaces loose seasonal movies, not Unreal packages.
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

pub const ID: &str = "skip-login-video";
const PLACEHOLDER: &[u8] = b"yakuzadeso";
pub fn receipt(dir: &Path) -> PathBuf {
    dir.join("skip-login-video.json")
}
fn root(paks: &Path) -> Result<PathBuf, String> {
    Ok(paks
        .parent()
        .ok_or("Missing Content folder")?
        .join("Marvel/MoviesBink/Movies/LoginAndLobby"))
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn movies(paks: &Path, records: &BTreeMap<String, String>) -> Result<Vec<PathBuf>, String> {
    let root = root(paks)?;
    let mut files = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| format!("Login movies not found: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        // Restrict writes to real, direct season folders, never junctions or symlinks.
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let path = entry.path().join("Transition.bk2");
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_file() => files.push(path),
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound
                    && records.contains_key(entry.file_name().to_string_lossy().as_ref()) =>
            {
                files.push(path)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => return Err(format!("{} is not a regular movie file", path.display())),
            Err(e) => return Err(e.to_string()),
        }
    }
    files.sort();
    if files.is_empty() {
        return Err("No seasonal Transition.bk2 login movies found".into());
    }
    Ok(files)
}
fn records(dir: &Path) -> Result<BTreeMap<String, String>, String> {
    match fs::read(receipt(dir)) {
        Ok(b) => serde_json::from_slice(&b)
            .map_err(|e| format!("Login video backup record is damaged: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e.to_string()),
    }
}
fn backup(dir: &Path, digest: &str) -> Result<PathBuf, String> {
    if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid movie backup digest".into());
    }
    Ok(dir
        .join("login-video-backups")
        .join(format!("{digest}.bak_repak")))
}
pub fn status(paks: &Path, dir: &Path) -> (bool, bool, u64) {
    let records = records(dir).unwrap_or_default();
    let Ok(paths) = movies(paks, &records) else {
        return (false, false, 0);
    };
    let mut active = 0;
    let mut restorable = 0;
    for path in &paths {
        if fs::metadata(path).is_ok_and(|m| m.len() == PLACEHOLDER.len() as u64)
            && fs::read(path).is_ok_and(|b| b == PLACEHOLDER)
        {
            active += 1;
            let season = path
                .parent()
                .and_then(Path::file_name)
                .unwrap()
                .to_string_lossy();
            if records
                .get(season.as_ref())
                .and_then(|h| backup(dir, h).ok())
                .is_some_and(|p| p.is_file())
            {
                restorable += 1;
            }
        }
    }
    (
        active == paths.len() && restorable == active,
        active > 0,
        (active * PLACEHOLDER.len()) as u64,
    )
}

pub fn apply(paks: &Path, dir: &Path, on: bool) -> Result<String, String> {
    apply_with(paks, dir, on, |moves| {
        crate::xtra_identity::upstream_guard()?;
        if crate::is_game_process_running() {
            return Err("Close Marvel Rivals before changing login movies".into());
        }
        publish_movies(moves)
    })
}

fn apply_with(
    paks: &Path,
    dir: &Path,
    on: bool,
    publish: impl FnOnce(&[(PathBuf, PathBuf)]) -> Result<(), String>,
) -> Result<String, String> {
    fs::create_dir_all(dir.join("login-video-backups")).map_err(|e| e.to_string())?;
    let mut records = records(dir)?;
    // A crash mid-publication leaves the staging folder in the game's movie folder: sweep it first.
    for entry in fs::read_dir(root(paks)?)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(".repakxtra-login-")
        {
            fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
        }
    }
    let stage = tempfile::Builder::new()
        .prefix(".repakxtra-login-")
        .tempdir_in(root(paks)?)
        .map_err(|e| e.to_string())?;
    let mut moves = Vec::new();
    let mut originals = Vec::new();
    for (i, path) in movies(paks, &records)?.into_iter().enumerate() {
        let season = path
            .parent()
            .and_then(Path::file_name)
            .ok_or("Invalid movie folder")?
            .to_string_lossy()
            .to_string();
        let bytes = read_movie(&path)?;
        let replacement = if on {
            if bytes.as_deref() == Some(PLACEHOLDER) || bytes.is_none() {
                let digest=records.get(&season).ok_or("A login movie is already replaced without a backup. Verify game files before enabling Skip login video")?;
                if hash(&fs::read(backup(dir, digest)?).map_err(|e| e.to_string())?) != *digest {
                    return Err("Login movie backup failed verification".into());
                }
                if bytes.is_some() {
                    continue;
                }
                PLACEHOLDER.to_vec()
            } else {
                let bytes = bytes.as_ref().unwrap();
                let digest = hash(bytes);
                let dest = backup(dir, &digest)?;
                if !dest.exists() {
                    fs::write(&dest, bytes).map_err(|e| e.to_string())?;
                }
                if hash(&fs::read(&dest).map_err(|e| e.to_string())?) != digest {
                    return Err("Login movie backup failed verification".into());
                }
                records.insert(season, digest);
                PLACEHOLDER.to_vec()
            }
        } else {
            // A game update or another mod replaced it: preserve that new file.
            if bytes.as_deref().is_some_and(|b| b != PLACEHOLDER) {
                continue;
            }
            let digest = records
                .get(&season)
                .ok_or("No backup for the replaced login movie. Verify game files to restore it")?;
            let saved = fs::read(backup(dir, digest)?).map_err(|e| e.to_string())?;
            if hash(&saved) != *digest {
                return Err("Login movie backup failed verification".into());
            }
            saved
        };
        let temp = stage.path().join(i.to_string());
        fs::write(&temp, replacement).map_err(|e| e.to_string())?;
        originals.push((path.clone(), bytes.as_deref().map(hash)));
        moves.push((temp, path));
    }
    // Persist recovery information before touching the originals, including across a crash.
    let temp = dir.join("skip-login-video.json.tmp");
    fs::write(
        &temp,
        serde_json::to_vec(&records).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(&temp, receipt(dir)).map_err(|e| e.to_string())?;
    for (path, digest) in originals {
        if read_movie(&path)?.as_deref().map(hash) != digest {
            return Err("A login movie changed during preparation; try again".into());
        }
    }
    // Each replacement is an atomic rename on the movie drive. No movie is removed first.
    publish(&moves)?;
    Ok(if on {
        "Seasonal login transitions skipped. Original movies are backed up".into()
    } else {
        "Original login movies restored".into()
    })
}

fn read_movie(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Per-file atomic replacement avoids a crash window with a missing destination.
/// Unique rollback names also cover different seasons sharing Transition.bk2.
fn publish_movies(moves: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    let Some((first, _)) = moves.first() else {
        return Ok(());
    };
    let rollback = tempfile::Builder::new()
        .prefix("rollback-")
        .tempdir_in(first.parent().ok_or("Missing movie staging folder")?)
        .map_err(|e| e.to_string())?;
    let mut previous = Vec::new();
    for (i, (_, dest)) in moves.iter().enumerate() {
        let old = rollback.path().join(i.to_string());
        match fs::copy(dest, &old) {
            Ok(_) => previous.push(Some(old)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => previous.push(None),
            Err(e) => return Err(format!("Could not prepare movie rollback: {e}")),
        }
    }
    for (i, (source, dest)) in moves.iter().enumerate() {
        if let Err(e) = fs::rename(source, dest) {
            let mut failed = Vec::new();
            for j in (0..i).rev() {
                let dest = &moves[j].1;
                let result = match &previous[j] {
                    Some(old) => fs::rename(old, dest),
                    None => fs::remove_file(dest),
                };
                if let Err(e) = result {
                    failed.push(format!("{}: {e}", dest.display()));
                }
            }
            return Err(format!(
                "Could not replace {}: {e}{}",
                dest.display(),
                if failed.is_empty() {
                    String::new()
                } else {
                    format!(
                        ". Rollback needs recovery from the saved movie backups: {}",
                        failed.join(", ")
                    )
                }
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backup_paths_reject_traversal() {
        assert!(backup(Path::new("x"), "../movie").is_err());
        assert!(backup(Path::new("x"), &"a".repeat(64)).is_ok());
    }
    #[test]
    fn restores_originals_and_keeps_new_game_updates() {
        let work = tempfile::tempdir().unwrap();
        let paks = work.path().join("Content/Paks");
        let dir = paks.join("~mods/.repakxtra-builtin");
        let season = root(&paks).unwrap().join("S10");
        fs::create_dir_all(&season).unwrap();
        let movie = season.join("Transition.bk2");
        fs::write(&movie, b"original movie").unwrap();
        let stale = root(&paks).unwrap().join(".repakxtra-login-stale");
        fs::create_dir(&stale).unwrap();
        apply_with(&paks, &dir, true, publish_movies).unwrap();
        assert!(!stale.exists(), "a crashed run's staging folder is swept");
        assert_eq!(fs::read(&movie).unwrap(), PLACEHOLDER);
        assert_eq!(status(&paks, &dir), (true, true, 10));
        apply_with(&paks, &dir, false, publish_movies).unwrap();
        assert_eq!(fs::read(&movie).unwrap(), b"original movie");
        apply_with(&paks, &dir, true, publish_movies).unwrap();
        fs::write(&movie, b"new game update").unwrap();
        apply_with(&paks, &dir, false, publish_movies).unwrap();
        assert_eq!(fs::read(&movie).unwrap(), b"new game update");
        apply_with(&paks, &dir, true, publish_movies).unwrap();
        apply_with(&paks, &dir, false, publish_movies).unwrap();
        assert_eq!(fs::read(&movie).unwrap(), b"new game update");
        let new_season = root(&paks).unwrap().join("S11");
        fs::create_dir_all(&new_season).unwrap();
        fs::write(new_season.join("Transition.bk2"), b"next season").unwrap();
        assert!(!status(&paks, &dir).0);
        apply_with(&paks, &dir, true, publish_movies).unwrap();
        assert!(status(&paks, &dir).0);
    }
    #[test]
    fn failed_publication_and_damaged_backup_preserve_movies() {
        let work = tempfile::tempdir().unwrap();
        let paks = work.path().join("Content/Paks");
        let dir = paks.join("~mods/.repakxtra-builtin");
        let season = root(&paks).unwrap().join("S10");
        fs::create_dir_all(&season).unwrap();
        let movie = season.join("Transition.bk2");
        fs::write(&movie, b"original").unwrap();
        assert!(apply_with(&paks, &dir, true, |_| Err("locked".into())).is_err());
        assert_eq!(fs::read(&movie).unwrap(), b"original");
        apply_with(&paks, &dir, true, publish_movies).unwrap();
        let rec = records(&dir).unwrap();
        fs::write(backup(&dir, &rec["S10"]).unwrap(), b"corrupt").unwrap();
        assert!(apply_with(&paks, &dir, false, publish_movies).is_err());
        assert_eq!(fs::read(&movie).unwrap(), PLACEHOLDER);
    }

    fn seasons(paks: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        (0..12)
            .map(|n| {
                let folder = root(paks).unwrap().join(format!("S{n}"));
                fs::create_dir_all(&folder).unwrap();
                let path = folder.join("Transition.bk2");
                let bytes = format!("original season {n}").into_bytes();
                fs::write(&path, &bytes).unwrap();
                (path, bytes)
            })
            .collect()
    }

    #[test]
    fn production_publisher_handles_twelve_seasons_and_recovers_missing_movies() {
        let work = tempfile::tempdir().unwrap();
        let paks = work.path().join("Content/Paks");
        let dir = paks.join("~mods/.repakxtra-builtin");
        let originals = seasons(&paks);
        apply_with(&paks, &dir, true, publish_movies).unwrap();
        assert_eq!(status(&paks, &dir), (true, true, 120));
        apply_with(&paks, &dir, true, publish_movies).unwrap();
        // Recover the gap an older publication could leave between removal and replacement.
        for (path, _) in originals.iter().take(2) {
            fs::remove_file(path).unwrap();
        }
        assert!(!status(&paks, &dir).0);
        apply_with(&paks, &dir, false, publish_movies).unwrap();
        for (path, bytes) in &originals {
            assert_eq!(&fs::read(path).unwrap(), bytes);
        }
        apply_with(&paks, &dir, true, publish_movies).unwrap();
        for (path, _) in &originals {
            fs::remove_file(path).unwrap();
        }
        apply_with(&paks, &dir, true, publish_movies).unwrap();
        assert_eq!(status(&paks, &dir), (true, true, 120));
        apply_with(&paks, &dir, false, publish_movies).unwrap();
        for (path, bytes) in originals {
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
    }

    #[test]
    fn interrupted_publication_between_seasons_converges_on_retry() {
        let work = tempfile::tempdir().unwrap();
        let paks = work.path().join("Content/Paks");
        let dir = paks.join("~mods/.repakxtra-builtin");
        let originals = seasons(&paks);
        assert!(apply_with(&paks, &dir, true, |moves| {
            publish_movies(&moves[..1])?;
            Err("Simulated process exit after one season was published".into())
        })
        .is_err());
        assert!(!status(&paks, &dir).0);
        apply_with(&paks, &dir, true, publish_movies).unwrap();
        assert!(status(&paks, &dir).0);
        apply_with(&paks, &dir, false, publish_movies).unwrap();
        for (path, bytes) in originals {
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
    }

    #[test]
    fn production_publisher_rolls_back_completed_replacements_on_error() {
        let work = tempfile::tempdir().unwrap();
        let stage = work.path().join("stage");
        fs::create_dir(&stage).unwrap();
        let a = work.path().join("a");
        let b = work.path().join("b");
        fs::write(&a, b"old a").unwrap();
        fs::write(&b, b"old b").unwrap();
        let new_a = stage.join("0");
        fs::write(&new_a, b"new a").unwrap();
        // A late source failure forces rollback after the first real atomic replacement.
        assert!(publish_movies(&[(new_a, a.clone()), (stage.join("missing"), b.clone())]).is_err());
        assert_eq!(fs::read(a).unwrap(), b"old a");
        assert_eq!(fs::read(b).unwrap(), b"old b");
    }
}
