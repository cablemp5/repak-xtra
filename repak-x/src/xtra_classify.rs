//! repakxtra: extra mod type rules for content upstream reports as "Unknown", plus the
//! Project Galacta compatibility check. Called from utils::get_pak_characteristics_detailed.

fn rel_lower(file: &str) -> String {
    file.trim_start_matches("../")
        .trim_start_matches("Marvel/Content/Marvel/")
        .trim_start_matches("/Game/Marvel/")
        .to_lowercase()
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Category for mods the upstream rules leave as "Unknown", decided by what most of the files are.
pub fn fallback_category(files: &[String]) -> Option<&'static str> {
    let paths: Vec<String> = files.iter().map(|f| rel_lower(f)).collect();
    let any = |pred: &dyn Fn(&str) -> bool| paths.iter().any(|p| pred(p));

    // Emotes and other character animations: Characters/<id>/.../Animations/...
    if any(&|p| p.starts_with("characters/") && p.contains("/animations/")) {
        return Some("Animation");
    }
    // Character material instances (recolors, material swaps, body lights)
    if any(&|p| p.starts_with("characters/") && file_name(p).starts_with("mi_")) {
        return Some("Material");
    }
    // Hero voice data and other Wwise-free audio assets
    if any(&|p| p.starts_with("audio/")) {
        return Some("Audio");
    }
    // Data tables (skin tables, hero data)
    if any(&|p| p.starts_with("data/")) {
        return Some("Data");
    }
    None
}

/// A Project Galacta entry ships its own skeletal mesh and GAL_ModSkinConfig data asset under
/// /Game/Marvel/ProjectGalacta/Meshes/<HeroID>/<SkinID>/<ModFolder>/. Both must be present.
pub fn is_galacta_compatible(files: &[String]) -> bool {
    let galacta: Vec<String> = files
        .iter()
        .map(|f| rel_lower(f))
        .filter(|p| p.starts_with("projectgalacta/meshes/"))
        .collect();
    let has = |prefix: &str| galacta.iter().any(|p| file_name(p).starts_with(prefix));
    has("sk_") && has("da_")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn classifies_former_unknowns() {
        assert_eq!(fallback_category(&v(&["Marvel/Content/Marvel/Characters/1026/1026001/Animations/Emotes/Emote_10265022080.uasset"])), Some("Animation"));
        assert_eq!(fallback_category(&v(&["Marvel/Content/Marvel/Characters/1026/1026001/Materials/Lobby/MI_1026001_Body.uasset"])), Some("Material"));
        assert_eq!(fallback_category(&v(&["Marvel/Content/Marvel/Audio/Voice/MarvelHeroVoiceData.uasset"])), Some("Audio"));
        assert_eq!(fallback_category(&v(&["Marvel/Content/Marvel/Data/DataTable/MarvelHeroSkinTable.uasset"])), Some("Data"));
        assert_eq!(fallback_category(&v(&["Marvel/Content/Marvel/Something/Else.uasset"])), None);
    }

    #[test]
    fn galacta_needs_mesh_and_config_in_the_galacta_folder() {
        let entry = v(&[
            "../../../Marvel/Content/Marvel/ProjectGalacta/Meshes/1026/1026001/BuckySwap/DA_BuckySwap.uasset",
            "../../../Marvel/Content/Marvel/ProjectGalacta/Meshes/1026/1026001/BuckySwap/SK_1026_BuckySwap.uasset",
        ]);
        assert!(is_galacta_compatible(&entry));
        assert!(!is_galacta_compatible(&entry[..1].to_vec()));
        assert!(!is_galacta_compatible(&v(&["Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset"])));
    }
}
