//! repakxtra: the self-updater checks repakxtra's own releases (cablemp5/repak-xtra), not upstream Repak X's.
//! App releases are published as GitHub's "Latest" now (older ones were pre-releases). The list is still read rather
//! than releases/latest: preview kit releases share the repo, and newest() skips their tags.

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

/// The public key release zips are signed with (scripts/release-signing.ps1 -NewKey writes it). Empty until the key
/// is made: the build that first ships a key is the bridge, and every update after it must carry a valid signature.
const RELEASE_KEY: &str = include_str!("release-key.xml");

/// Whether this build checks update signatures (it does once a release key is built in).
pub fn signing_required() -> bool {
    !RELEASE_KEY.trim().is_empty()
}

/// Checks the downloaded `zip` against its `<zip>.sig.json`: the signature must verify with the built-in key, and the
/// signed manifest must name repakxtra for Windows, this file name, a newer version than `current`, and this exact
/// size and SHA-256. Without a built-in key (before the first signed release) every zip passes, as before.
pub fn verify_release(zip: &std::path::Path, sig_json: &str, current: &str) -> Result<(), String> {
    verify_with(RELEASE_KEY, zip, sig_json, current)
}

fn verify_with(key: &str, zip: &std::path::Path, sig_json: &str, current: &str) -> Result<(), String> {
    use base64::Engine;
    use sha2::Digest;
    const HELP: &str = "Nothing was changed: download the release from github.com/cablemp5/repak-xtra/releases instead.";
    if key.trim().is_empty() {
        crate::ui_log::warn("Update", "This build has no release key yet, so the update's signature is not checked");
        return Ok(());
    }
    let b64 = base64::engine::general_purpose::STANDARD;
    let sig: serde_json::Value = serde_json::from_str(sig_json).map_err(|_| format!("The update's signature file is unreadable. {HELP}"))?;
    let (Some(manifest), Some(signature)) = (sig["manifest"].as_str(), sig["signature"].as_str()) else {
        return Err(format!("The update's signature file is incomplete. {HELP}"));
    };
    let manifest_bytes = b64.decode(manifest).map_err(|_| format!("The update's signature file is unreadable. {HELP}"))?;
    if !rsa_verifies(key, &manifest_bytes, signature)? {
        return Err(format!("The update is not signed by repakxtra's release key. {HELP}"));
    }
    let m: serde_json::Value = serde_json::from_slice(&manifest_bytes).map_err(|_| format!("The signed manifest is unreadable. {HELP}"))?;
    let name = zip.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let version = m["version"].as_str().and_then(|v| semver::Version::parse(v).ok());
    let newer = version.as_ref().zip(semver::Version::parse(current).ok()).is_some_and(|(v, c)| *v > c);
    if m["format"] != 1 || m["product"] != "repakxtra" || m["platform"] != "windows-x64" || m["artifact"] != name {
        return Err(format!("The signed manifest is for a different download than {name}. {HELP}"));
    }
    if !newer || !version.is_some_and(|v| name.contains(&format!("v{v}"))) {
        return Err(format!("The signed update is not newer than this version ({current}). {HELP}"));
    }
    let bytes = std::fs::read(zip).map_err(|e| format!("Could not read the downloaded update: {e}"))?;
    if m["size"].as_u64() != Some(bytes.len() as u64) || m["sha256"].as_str() != Some(hex::encode(sha2::Sha256::digest(&bytes)).as_str()) {
        return Err(format!("The downloaded update does not match its signature (changed or incomplete). {HELP}"));
    }
    Ok(())
}

/// RSA PKCS#1 v1.5 SHA-256 through .NET (the same implementation release-signing.ps1 signs with). The key, data and
/// signature reach the fixed script through environment variables and a temp file, never through the command text.
fn rsa_verifies(public_key_xml: &str, data: &[u8], signature_b64: &str) -> Result<bool, String> {
    const SCRIPT: &str = "$rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider; \
        $rsa.FromXmlString($env:RX_KEY); \
        $ok = $rsa.VerifyData([IO.File]::ReadAllBytes($env:RX_DATA), [Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'), [Convert]::FromBase64String($env:RX_SIG)); \
        if ($ok) { exit 0 } else { exit 3 }";
    let data_path = std::env::temp_dir().join(format!("repakxtra-manifest-{}-{}.json", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos())));
    std::fs::write(&data_path, data).map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT])
        .env("RX_KEY", public_key_xml)
        .env("RX_DATA", &data_path)
        .env("RX_SIG", signature_b64);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let status = cmd.status().map_err(|e| format!("Could not check the update's signature: {e}"));
    let _ = std::fs::remove_file(&data_path);
    match status?.code() {
        Some(0) => Ok(true),
        Some(3) => Ok(false),
        _ => Err("Could not check the update's signature (the check itself failed). Nothing was changed.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Runs the real release-signing.ps1 (test keys in a temp folder, never the release key).
    fn signing(args: &[&str]) {
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts").join("release-signing.ps1");
        let ok = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(script)
            .args(args)
            .output()
            .unwrap();
        assert!(ok.status.success(), "{}", String::from_utf8_lossy(&ok.stderr));
    }

    #[test]
    fn only_a_signed_matching_newer_update_verifies() {
        let dir = std::env::temp_dir().join(format!("update-sign-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = |n: &str| dir.join(n).to_string_lossy().to_string();
        signing(&["-NewKey", "-KeyPath", &p("key.xml"), "-PublicOut", &p("pub.xml")]);
        signing(&["-NewKey", "-KeyPath", &p("other.xml"), "-PublicOut", &p("other-pub.xml")]);
        let key = std::fs::read_to_string(dir.join("pub.xml")).unwrap();
        let zip = dir.join("repak-xtra-v0.20.0-windows.zip");
        std::fs::write(&zip, b"the release").unwrap();
        signing(&["-Sign", "-Zip", &p("repak-xtra-v0.20.0-windows.zip"), "-Version", "0.20.0", "-KeyPath", &p("key.xml")]);
        let sig = std::fs::read_to_string(dir.join("repak-xtra-v0.20.0-windows.zip.sig.json")).unwrap();

        assert_eq!(verify_with(&key, &zip, &sig, "0.14.0"), Ok(()));
        assert!(verify_with(&key, &zip, &sig, "0.20.0").is_err(), "a replayed (not newer) version");
        let other = std::fs::read_to_string(dir.join("other-pub.xml")).unwrap();
        assert!(verify_with(&other, &zip, &sig, "0.14.0").is_err(), "an unknown key");
        std::fs::write(&zip, b"the releasf").unwrap();
        assert!(verify_with(&key, &zip, &sig, "0.14.0").is_err(), "changed bytes");
        std::fs::write(&zip, b"the release").unwrap();
        let renamed = dir.join("repak-xtra-v0.21.0-windows.zip");
        std::fs::copy(&zip, &renamed).unwrap();
        assert!(verify_with(&key, &renamed, &sig, "0.14.0").is_err(), "a manifest for another file");
        // a manifest edited to say another platform no longer matches its signature
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;
        let v: serde_json::Value = serde_json::from_str(&sig).unwrap();
        let m = String::from_utf8(b64.decode(v["manifest"].as_str().unwrap()).unwrap()).unwrap().replace("windows-x64", "linux-x64");
        let forged = serde_json::json!({ "manifest": b64.encode(m), "signature": v["signature"] }).to_string();
        assert!(verify_with(&key, &zip, &forged, "0.14.0").is_err(), "an edited manifest");
        assert!(verify_with(&key, &zip, "{}", "0.14.0").is_err(), "no signature");
        assert_eq!(verify_with("", &zip, "{}", "0.14.0"), Ok(()), "no built-in key yet: the bridge build");
        let _ = std::fs::remove_dir_all(&dir);
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
