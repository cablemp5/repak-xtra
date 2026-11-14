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

/// The skeletal mesh of a mod that names several heroes, when every one sits in one hero's folder: a skin often
/// borrows another hero's textures under that hero's path (a Black Cat skin with White Fox textures listed as
/// "Multiple Heroes (3)", 2026-11-14), and the mesh says whose skin it is. The path of the first such mesh.
pub fn mesh_of_one_hero(files: &[String]) -> Option<&String> {
    let hero = |f: &str| {
        let p = rel_lower(f);
        let id = p.strip_prefix("characters/")?.split('/').next()?.to_string();
        (id.len() == 4 && id.bytes().all(|b| b.is_ascii_digit())).then_some(id)
    };
    let meshes: Vec<&String> = files.iter().filter(|f| { let p = rel_lower(f); file_name(&p).starts_with("sk_") && (p.ends_with(".uasset") || !file_name(&p).contains('.')) }).collect();
    let first = hero(meshes.first()?)?;
    meshes.iter().all(|m| hero(m).as_deref() == Some(&first)).then(|| meshes[0])
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
    fn recovered_sound_bank_gets_the_audio_tag() {
        let details = crate::utils::get_pak_characteristics_detailed(v(&[
            "Marvel/Content/WwiseAudio/bnk_display_1036802.bnk",
        ]));
        assert_eq!(details.category, "Audio");
        assert!(details.mod_type.contains("Audio"));
    }

    #[test]
    fn a_skin_with_borrowed_textures_is_its_meshs_hero() {
        let cat = v(&[
            "Marvel/Content/Marvel/Characters/1036/1036001/Textures/T_1036001_Equip_02_M.uasset",
            "Marvel/Content/Marvel/Characters/1011/1011001/Texture/T_1011001_Equip_02_S.uasset",
            "Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001_Lobby.uasset",
            "Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset",
        ]);
        assert_eq!(mesh_of_one_hero(&cat), Some(&cat[2]));
        let details = crate::utils::get_pak_characteristics_detailed(cat.clone());
        assert_eq!((details.heroes.len(), details.character_id.as_str()), (1, "1026"), "{}", details.mod_type);
        let two = v(&[&cat[2], "Marvel/Content/Marvel/Characters/1036/1036001/Meshes/SK_1036_1036001.uasset"]);
        assert_eq!(mesh_of_one_hero(&two), None, "meshes of two heroes: several heroes still");
        assert_eq!(mesh_of_one_hero(&cat[..2].to_vec()), None, "no mesh says nothing");
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
