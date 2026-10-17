//! repakxtra: the self-updater checks repakxtra's own releases (cablemp5/repak-xtra), not upstream Repak X's.
//! Every repakxtra release so far is a pre-release, which GitHub's releases/latest skips, so the list is read instead.

const RELEASES: &str = "https://api.github.com/repos/cablemp5/repak-xtra/releases?per_page=30";

/// repakxtra's version, read from the frontend's custom/version.ts so it is bumped in one place.
pub fn version() -> &'static str {
    const SRC: &str = include_str!("custom/version.ts");
    SRC.split("REPAKXTRA_VERSION = '").nth(1).and_then(|s| s.split('\'').next()).unwrap_or("0.0.0")
}

/// The newest app release: tag v<semver>, not a draft. Preview kit releases (preview-kit-v<N>) never parse.
fn newest(list: &[serde_json::Value]) -> Option<(semver::Version, &serde_json::Value)> {
    list.iter()
        .filter(|r| !r["draft"].as_bool().unwrap_or(false))
        .filter_map(|r| Some((semver::Version::parse(r["tag_name"].as_str()?.strip_prefix('v')?).ok()?, r)))
        .max_by(|a, b| a.0.cmp(&b.0))
}

/// The newest release when it is newer than this build, with its app zip (never the preview kit's).
pub async fn check() -> Result<Option<crate::UpdateInfo>, String> {
    crate::ui_log::info("Update", "Checking for a newer repakxtra release...");
    let res = reqwest::Client::new()
        .get(RELEASES)
        .header("User-Agent", "repakxtra")
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("GitHub returned {}", res.status()));
    }
    let list: Vec<serde_json::Value> = res.json().await.map_err(|e| e.to_string())?;
    let current = semver::Version::parse(version()).map_err(|e| e.to_string())?;
    let Some((latest, r)) = newest(&list).filter(|(v, _)| *v > current) else {
        crate::ui_log::success("Update", format!("repakxtra v{current} is up to date"));
        return Ok(None);
    };
    let zip = r["assets"].as_array().and_then(|a| {
        a.iter().find(|x| x["name"].as_str().is_some_and(|n| n.ends_with(".zip") && !n.contains("preview-kit")))
    });
    let text = |v: &serde_json::Value| v.as_str().map(str::to_string);
    crate::ui_log::warn("Update", format!("Update available: v{latest} (running v{current})"));
    Ok(Some(crate::UpdateInfo {
        latest: latest.to_string(),
        url: text(&r["html_url"]).unwrap_or_default(),
        asset_url: zip.and_then(|x| text(&x["browser_download_url"])),
        asset_name: zip.and_then(|x| text(&x["name"])),
        changelog: text(&r["body"]),
    }))
}

/// A downloaded update must be a zip holding the app (an .exe at its root or in one top folder). Anything else would
/// unpack to nothing, and the updater would only restart the old version (v0.5.0 first shipped a tar named .zip).
pub fn check_update_zip(path: &std::path::Path) -> Result<(), String> {
    const HELP: &str = "Nothing was changed: download the release from github.com/cablemp5/repak-xtra/releases instead.";
    let file = std::fs::File::open(path).map_err(|e| format!("Could not open the downloaded update: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("The downloaded update is not a zip ({e}). {HELP}"))?;
    let has_app = (0..zip.len()).filter_map(|i| zip.by_index(i).ok().map(|f| f.name().trim_end_matches('/').to_lowercase()))
        .any(|n| n.ends_with(".exe") && n.matches('/').count() <= 1);
    if has_app { Ok(()) } else { Err(format!("The downloaded update holds no app (.exe). {HELP}")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn only_a_zip_with_the_app_is_applied() {
        let dir = std::env::temp_dir().join(format!("update-zip-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let zip_of = |name: &str, entries: &[&str]| {
            let p = dir.join(name);
            let mut w = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
            for e in entries {
                w.start_file(*e, zip::write::SimpleFileOptions::default()).unwrap();
                w.write_all(b"x").unwrap();
            }
            w.finish().unwrap();
            p
        };
        assert!(check_update_zip(&zip_of("ok.zip", &["repakxtra.exe", "UAssetTool.dll", "data/character_data.json"])).is_ok());
        assert!(check_update_zip(&zip_of("nested.zip", &["repakxtra/repakxtra.exe"])).is_ok(), "one top folder is fine");
        assert!(check_update_zip(&zip_of("noapp.zip", &["data/character_data.json"])).is_err(), "no exe");
        assert!(check_update_zip(&zip_of("deep.zip", &["a/b/repakxtra.exe"])).is_err(), "too deep to be copied over the app");
        let tar = dir.join("tar.zip"); // what GNU tar wrote: a tar archive named .zip
        std::fs::write(&tar, [b"repakxtra.exe".as_slice(), &[0u8; 244], b"ustar  \0"].concat()).unwrap();
        assert!(check_update_zip(&tar).unwrap_err().contains("not a zip"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn version_comes_from_version_ts() {
        assert!(semver::Version::parse(version()).is_ok(), "{}", version());
    }

    #[test]
    fn newest_app_release_wins() {
        let list: Vec<serde_json::Value> = serde_json::from_str(
            r#"[{"tag_name":"preview-kit-v9"},{"tag_name":"v0.2.0"},{"tag_name":"v0.10.0","draft":true},{"tag_name":"v0.3.1"},{"tag_name":"v0.1.0"}]"#,
        )
        .unwrap();
        assert_eq!(newest(&list).unwrap().0.to_string(), "0.3.1");
        assert!(newest(&[]).is_none());
    }
}
