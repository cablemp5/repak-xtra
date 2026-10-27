//! repakxtra: the self-updater checks repakxtra's own releases (cablemp5/repak-xtra), not upstream Repak X's.
//! App releases are published as GitHub's "Latest" now (older ones were pre-releases). The list is still read rather
//! than releases/latest: preview kit releases share the repo, and newest() skips their tags.

const RELEASES: &str = "https://api.github.com/repos/cablemp5/repak-xtra/releases?per_page=30";

/// repakxtra's version, read from the frontend's custom/version.ts so it is bumped in one place.
pub fn version() -> &'static str {
    const SRC: &str = include_str!("custom/version.ts");
    SRC.split("REPAKXTRA_VERSION = '").nth(1).and_then(|s| s.split('\'').next()).unwrap_or("0.0.0")
}

fn asset<'a>(release: &'a serde_json::Value, version: &semver::Version) -> Option<&'a serde_json::Value> {
    let name = crate::xtra_edition::asset_name(version);
    release["assets"].as_array()?.iter().find(|a| a["name"].as_str() == Some(name.as_str()) && a["browser_download_url"].as_str().is_some())
}

/// Only this edition's tags and exact Windows asset names qualify. A partly uploaded release is skipped.
fn newest(list: &[serde_json::Value]) -> Option<(semver::Version, &serde_json::Value)> {
    list.iter()
        .filter(|r| !r["draft"].as_bool().unwrap_or(false))
        .filter_map(|r| {
            let version = semver::Version::parse(r["tag_name"].as_str()?.strip_prefix(crate::xtra_edition::TAG_PREFIX)?).ok()?;
            asset(r, &version)?;
            Some((version, r))
        })
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
    let zip = asset(r, &latest);
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
    if !has_app { return Err(format!("The downloaded update holds no app (.exe). {HELP}")); }
    let mut markers = Vec::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_string();
        if name == "edition.json" || (name.ends_with("/edition.json") && name.matches('/').count() == 1) {
            use std::io::Read;
            let mut text = String::new();
            f.by_ref().take(4096).read_to_string(&mut text).map_err(|e| e.to_string())?;
            markers.push(serde_json::from_str::<serde_json::Value>(&text).map_err(|e| format!("Invalid update edition: {e}"))?);
        }
    }
    if markers.len() != 1 || markers[0]["edition"].as_str() != Some(crate::xtra_edition::NAME) {
        return Err(format!("This update is not for the {} edition. Nothing was changed.", crate::xtra_edition::NAME));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    mod legacy {
        include!("../tests/fixtures/legacy_update.rs");
    }

    #[test]
    fn existing_users_update_to_standard_and_never_extended() {
        let list = serde_json::json!([
            {"tag_name": "extended-v99.0.0", "prerelease": true, "assets": [
                {"name": "repak-xtra-extended-v99.0.0-windows.zip", "browser_download_url": "https://example.com/extended.zip"}
            ]},
            {"tag_name": "v0.26.0", "assets": [
                {"name": "repak-xtra-standard-v0.26.0-windows.zip.sha256"},
                {"name": "repak-xtra-standard-v0.26.0-windows.zip", "browser_download_url": "https://example.com/standard.zip"}
            ]},
            {"tag_name": "preview-kit-v100", "assets": [{"name": "preview-kit.zip"}]}
        ]);
        let list = list.as_array().unwrap();
        let (version, release) = legacy::newest(list).unwrap();
        assert!(version > semver::Version::parse("0.25.0").unwrap());
        assert_eq!(release["tag_name"], "v0.26.0");
        assert_eq!(legacy::asset(release).unwrap()["browser_download_url"], "https://example.com/standard.zip");
        if !crate::xtra_edition::EXTENDED {
            assert_eq!(newest(list).unwrap().0, version, "after migration, Standard stays on the same channel");
        }
    }

    #[test]
    fn standard_zip_is_accepted_by_the_old_updater() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repak-xtra-standard-v0.26.0-windows.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        for (name, bytes) in [
            ("repakxtra.exe", &b"standard app"[..]),
            ("UAssetTool.dll", &b"tool"[..]),
            ("uassettool-cli.exe", &b"cli"[..]),
            ("data/character_data.json", &b"{}"[..]),
            ("edition.json", &b"{\"edition\":\"standard\"}"[..]),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        legacy::check_update_zip(&path).unwrap();
        if !crate::xtra_edition::EXTENDED {
            check_update_zip(&path).unwrap();
        }
    }

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
            w.start_file("edition.json", zip::write::SimpleFileOptions::default()).unwrap();
            write!(w, "{{\"edition\":\"{}\"}}", crate::xtra_edition::NAME).unwrap();
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
        let release = |prefix: &str, version: &str, edition: &str| serde_json::json!({
            "tag_name": format!("{prefix}{version}"),
            "assets": [{"name": format!("repak-xtra-{edition}-v{version}-windows.zip"), "browser_download_url": "https://example.com/app.zip"}]
        });
        let mut draft = release(crate::xtra_edition::TAG_PREFIX, "0.10.0", crate::xtra_edition::NAME);
        draft["draft"] = true.into();
        let list = vec![
            release(crate::xtra_edition::TAG_PREFIX, "0.2.0", crate::xtra_edition::NAME),
            release(crate::xtra_edition::TAG_PREFIX, "0.3.1", crate::xtra_edition::NAME),
            draft,
            release(if crate::xtra_edition::EXTENDED { "v" } else { "extended-v" }, "99.0.0", if crate::xtra_edition::EXTENDED { "standard" } else { "extended" }),
            release(crate::xtra_edition::TAG_PREFIX, "88.0.0", "wrong-edition"),
            serde_json::json!({"tag_name": format!("{}77.0.0", crate::xtra_edition::TAG_PREFIX)}),
        ];
        assert_eq!(newest(&list).unwrap().0.to_string(), "0.3.1");
        assert!(newest(&[]).is_none());
    }

    #[test]
    fn wrong_edition_zip_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        for edition in ["wrong", ""] {
            let path = dir.path().join("update.zip");
            let mut w = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            w.start_file("repakxtra.exe", zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(b"app").unwrap();
            if !edition.is_empty() {
                w.start_file("edition.json", zip::write::SimpleFileOptions::default()).unwrap();
                write!(w, "{{\"edition\":\"{edition}\"}}").unwrap();
            }
            w.finish().unwrap();
            assert!(check_update_zip(&path).unwrap_err().contains("edition"));
        }
    }
}
