//! repakxtra: Settings > Check app files. Downloads the release zip of the version that is installed, checks it against
//! its published checksum (xtra_update.rs) and compares every file in it with the installed one by SHA-256, changing
//! nothing. Repair then copies only the missing or different files through the update script (xtra_updater.rs), so its
//! rollback covers a repair too. User data is never in the zip, and files the zip lacks are left alone.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

#[derive(serde::Serialize, Debug, Default, PartialEq)]
pub struct Diff {
    pub missing: Vec<String>,
    pub different: Vec<String>,
}

/// Which of the zip's files (relative path to SHA-256) are missing from the install or differ from it. `installed` holds
/// the hash of each of those paths that exists on disk.
pub fn diff_files(zip: &BTreeMap<String, String>, installed: &HashMap<String, String>) -> Diff {
    let mut diff = Diff::default();
    for (rel, hash) in zip {
        match installed.get(rel) {
            None => diff.missing.push(rel.clone()),
            Some(h) if !h.eq_ignore_ascii_case(hash) => diff.different.push(rel.clone()),
            _ => {}
        }
    }
    diff
}

#[derive(serde::Serialize)]
pub struct Report {
    #[serde(flatten)]
    diff: Diff,
    total: usize,
}

fn release_build() -> Result<(), String> {
    if cfg!(debug_assertions) || option_env!("REPAKXTRA_BUILD") == Some("test") {
        return Err("This is a dev or test build, not a release, so there is nothing to compare it with.".into());
    }
    Ok(())
}

fn installed_zip() -> Result<PathBuf, String> {
    let version = semver::Version::parse(crate::xtra_update::version()).map_err(|e| e.to_string())?;
    Ok(crate::xtra_updater::update_dir().join(crate::xtra_edition::asset_name(&version)))
}

fn app_dir() -> Result<(PathBuf, PathBuf), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("The app has no folder")?.to_path_buf();
    Ok((exe, dir))
}

/// Every file in the zip by its path inside the app folder (one top folder is dropped, as the update script does).
fn zip_hashes(path: &Path) -> Result<BTreeMap<String, String>, String> {
    use sha2::{Digest, Sha256};
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let names: Vec<String> = (0..zip.len()).filter_map(|i| zip.by_index(i).ok().filter(|f| f.is_file()).map(|f| f.name().to_string())).collect();
    let top = names.first().and_then(|n| n.split_once('/')).map(|(t, _)| format!("{t}/"))
        .filter(|t| names.iter().all(|n| n.starts_with(t.as_str())));
    let mut out = BTreeMap::new();
    for name in names {
        let mut f = zip.by_name(&name).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        std::io::copy(&mut f, &mut hasher).map_err(|e| e.to_string())?;
        let rel = top.as_deref().and_then(|t| name.strip_prefix(t)).unwrap_or(&name).to_string();
        out.insert(rel, format!("{:x}", hasher.finalize()));
    }
    Ok(out)
}

fn compare(zip: &Path, app: &Path) -> Result<(Diff, usize), String> {
    let files = zip_hashes(zip)?;
    let installed = files.keys()
        .filter_map(|rel| crate::xtra_update::sha256_file(&app.join(rel)).ok().map(|h| (rel.clone(), h)))
        .collect();
    Ok((diff_files(&files, &installed), files.len()))
}

/// Downloads this version's release zip into the update folder, checked against its published checksum.
async fn download(zip: &Path) -> Result<(), String> {
    let client = reqwest::Client::new();
    let tag = format!("{}{}", crate::xtra_edition::TAG_PREFIX, crate::xtra_update::version());
    let offline = |e: reqwest::Error| format!("Could not reach GitHub ({e}). Check your connection and try again.");
    let res = client.get(format!("https://api.github.com/repos/cablemp5/repak-xtra/releases/tags/{tag}"))
        .header("User-Agent", "repakxtra").send().await.map_err(offline)?;
    if !res.status().is_success() {
        return Err(format!("No release {tag} was found on GitHub ({}).", res.status()));
    }
    let release: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let name = zip.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let url = release["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"].as_str() == Some(name)))
        .and_then(|x| x["browser_download_url"].as_str()).ok_or(format!("Release {tag} has no {name}."))?.to_string();
    let res = client.get(&url).header("User-Agent", "repakxtra").send().await.map_err(offline)?;
    if !res.status().is_success() {
        return Err(format!("The download failed: GitHub returned {}", res.status()));
    }
    let bytes = res.bytes().await.map_err(offline)?;
    let dir = crate::xtra_updater::update_dir();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(zip, &bytes).map_err(|e| e.to_string())?;
    if let Err(e) = crate::xtra_update::verify_checksum(&client, &url, zip).await {
        let _ = std::fs::remove_file(zip);
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
pub async fn xtra_check_app_files() -> Result<Report, String> {
    release_build()?;
    let zip = installed_zip()?;
    crate::ui_log::info("Repair", format!("Checking the app files against release v{}", crate::xtra_update::version()));
    download(&zip).await?;
    let (_, app) = app_dir()?;
    let (diff, total) = tokio::task::spawn_blocking(move || compare(&zip, &app)).await.map_err(|e| e.to_string())??;
    let off = diff.missing.len() + diff.different.len();
    crate::ui_log::info("Repair", if off == 0 { format!("All {total} app files match") } else { format!("{off} of {total} app files are missing or differ") });
    Ok(Report { diff, total })
}

/// Copies the missing or different files from the zip Check app files downloaded, then restarts the app.
#[tauri::command]
pub async fn xtra_repair_app_files(app: tauri::AppHandle) -> Result<(), String> {
    release_build()?;
    let zip = installed_zip()?;
    if !zip.is_file() {
        return Err("Run Check app files first.".into());
    }
    let (exe, dir) = app_dir()?;
    let (zip2, dir2) = (zip.clone(), dir.clone());
    let (diff, _) = tokio::task::spawn_blocking(move || compare(&zip2, &dir2)).await.map_err(|e| e.to_string())??;
    let files: Vec<String> = diff.missing.into_iter().chain(diff.different).collect();
    if files.is_empty() {
        return Err("All app files match. Nothing to repair.".into());
    }
    crate::ui_log::info("Repair", format!("Repairing {} app files and restarting", files.len()));
    crate::xtra_updater::launch_zip(&zip, &dir, &exe, Some(crate::xtra_update::version()), &files)?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map<const N: usize>(pairs: [(&str, &str); N]) -> BTreeMap<String, String> {
        pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn missing_and_different_files_are_named_and_extra_files_ignored() {
        let zip = map([("repakxtra.exe", "aa"), ("UAssetTool.dll", "bb"), ("data/x.json", "cc"), ("uassettool-cli.exe", "dd")]);
        let installed: HashMap<_, _> = map([("repakxtra.exe", "AA"), ("UAssetTool.dll", "00"), ("data/x.json", "cc"), ("Logs/a.log", "ee")]).into_iter().collect();
        let diff = diff_files(&zip, &installed);
        assert_eq!(diff.missing, ["uassettool-cli.exe"]);
        assert_eq!(diff.different, ["UAssetTool.dll"], "hash case does not matter, extra installed files are not reported");
        assert_eq!(diff_files(&zip, &zip.clone().into_iter().collect()), Diff::default(), "all match");
        assert_eq!(diff_files(&BTreeMap::new(), &installed), Diff::default(), "an empty zip changes nothing");
        assert_eq!(diff_files(&zip, &HashMap::new()).missing.len(), 4);
    }

    #[test]
    fn zip_paths_drop_one_top_folder_and_compare_with_the_install() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("app");
        std::fs::create_dir_all(app.join("data")).unwrap();
        std::fs::write(app.join("repakxtra.exe"), b"exe").unwrap();
        std::fs::write(app.join("data").join("x.json"), b"changed").unwrap();
        for (name, top) in [("flat.zip", ""), ("nested.zip", "repakxtra/")] {
            let path = dir.path().join(name);
            let mut z = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            for (f, data) in [("repakxtra.exe", &b"exe"[..]), ("data/x.json", b"{}"), ("UAssetTool.dll", b"dll")] {
                z.start_file(format!("{top}{f}"), zip::write::SimpleFileOptions::default()).unwrap();
                z.write_all(data).unwrap();
            }
            z.finish().unwrap();
            let (diff, total) = compare(&path, &app).unwrap();
            assert_eq!(total, 3);
            assert_eq!(diff.missing, ["UAssetTool.dll"], "{name}");
            assert_eq!(diff.different, ["data/x.json"], "{name}");
        }
    }
}
