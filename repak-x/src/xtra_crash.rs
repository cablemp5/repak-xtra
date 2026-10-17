//! repakxtra: crash facts for the setup report (the newest crash, without its folder path), and which mods hold the
//! asset a crash names (crash suspects, custom/CrashSuspects.tsx).

use crate::crash_monitor;
use serde::Serialize;

#[derive(Serialize)]
pub struct NewestCrash {
    /// Unix seconds when the crash folder was made
    time: u64,
    crash_type: Option<String>,
    asset_path: Option<String>,
}

/// The newest crash the game left, if any. Reads only; the startup crash check keeps its own bookkeeping.
#[tauri::command]
pub fn xtra_newest_crash() -> Option<NewestCrash> {
    let (_, folder) = crash_monitor::get_newest_crash_folder()?;
    let info = crash_monitor::parse_crash_info(&folder, Vec::new())?;
    let (asset_path, error_type, _) = crash_monitor::parse_error_details(info.error_message.as_deref().unwrap_or(""));
    let time = info.timestamp.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    Some(NewestCrash { time, crash_type: error_type.or(info.crash_type), asset_path })
}

/// One spelling per game asset: the UE path (`Game/...`) without its extension or object name, lower case.
/// "/Game/Marvel/X/SK_A.SK_A", "Marvel/Content/Marvel/X/SK_A.uasset" and "../../../Marvel/Content/Marvel/X/SK_A.uexp"
/// all become "game/marvel/x/sk_a".
fn asset_key(raw: &str) -> String {
    let path = crate::asset_explorer::normalize_asset_path(raw.trim());
    let (dir, name) = path.rsplit_once('/').map(|(d, n)| (Some(d), n)).unwrap_or((None, path.as_str()));
    let name = name.split('.').next().unwrap_or(name);
    match dir {
        Some(d) => format!("{d}/{name}").to_lowercase(),
        None => name.to_lowercase(),
    }
}

/// Whether a mod's file list holds the crashed asset.
fn holds_asset(files: &[String], asset: &str) -> bool {
    let want = asset_key(asset);
    !want.is_empty() && files.iter().any(|f| asset_key(f) == want)
}

/// A mod's file list, on or off: the .utoc next to it (IoStore) or the .pak itself.
fn mod_files(path: &std::path::Path) -> Vec<String> {
    let utoc = path.with_extension("utoc");
    if utoc.exists() {
        return crate::utoc_utils::read_utoc(&utoc).into_iter().map(|e| e.file_path).collect();
    }
    uasset_toolkit::list_pak_files(path.to_str().unwrap_or_default(), Some(crate::install_mod::AES_KEY_HEX)).unwrap_or_default()
}

/// The mods (of `mod_paths`) that contain the asset a crash names.
#[tauri::command]
pub async fn xtra_crash_suspects(asset_path: String, mod_paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        mod_paths.into_iter().filter(|p| holds_asset(&mod_files(std::path::Path::new(p)), &asset_path)).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn crash_asset_matches_pak_and_iostore_spellings() {
        let crash = "/Game/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.SK_1026_1026001";
        assert!(holds_asset(&v(&["Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset"]), crash));
        assert!(holds_asset(&v(&["../../../Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uexp"]), crash));
        assert!(holds_asset(&v(&["marvel/content/marvel/characters/1026/1026001/meshes/sk_1026_1026001.ubulk"]), crash), "case differs");
        assert!(holds_asset(&v(&[r"Marvel\Content\Marvel\Characters\1026\1026001\Meshes\SK_1026_1026001.uasset"]), crash), "backslashes");
    }

    #[test]
    fn other_assets_do_not_match() {
        let crash = "/Game/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001";
        assert!(!holds_asset(&v(&["Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001_Lobby.uasset"]), crash), "longer name");
        assert!(!holds_asset(&v(&["Marvel/Content/Marvel/Characters/1026/1026002/Meshes/SK_1026_1026001.uasset"]), crash), "other skin folder");
        assert!(!holds_asset(&[], crash));
        assert!(!holds_asset(&v(&["Marvel/Content/Marvel/A.uasset"]), "  "), "no asset named");
    }
}
