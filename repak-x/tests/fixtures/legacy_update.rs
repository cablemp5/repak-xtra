// Frozen updater selection and ZIP validation from commit 7b5e23945f277f4f4c9c6e7057c27afa92db0f4d.
// Keep this independent of edition-aware code: it represents already installed apps.

pub(super) fn newest(list: &[serde_json::Value]) -> Option<(semver::Version, &serde_json::Value)> {
    list.iter()
        .filter(|r| !r["draft"].as_bool().unwrap_or(false))
        .filter_map(|r| Some((semver::Version::parse(r["tag_name"].as_str()?.strip_prefix('v')?).ok()?, r)))
        .max_by(|a, b| a.0.cmp(&b.0))
}


pub(super) fn asset(r: &serde_json::Value) -> Option<&serde_json::Value> {
    r["assets"].as_array().and_then(|a| {
        a.iter().find(|x| x["name"].as_str().is_some_and(|n| n.ends_with(".zip") && !n.contains("preview-kit")))
    })
}

pub fn check_update_zip(path: &std::path::Path) -> Result<(), String> {
    const HELP: &str = "Nothing was changed: download the release from github.com/cablemp5/repak-xtra/releases instead.";
    let file = std::fs::File::open(path).map_err(|e| format!("Could not open the downloaded update: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("The downloaded update is not a zip ({e}). {HELP}"))?;
    let has_app = (0..zip.len()).filter_map(|i| zip.by_index(i).ok().map(|f| f.name().trim_end_matches('/').to_lowercase()))
        .any(|n| n.ends_with(".exe") && n.matches('/').count() <= 1);
    if has_app { Ok(()) } else { Err(format!("The downloaded update holds no app (.exe). {HELP}")) }
}
