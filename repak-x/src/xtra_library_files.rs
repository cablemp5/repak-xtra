// repakxtra: what the Library gets of a mod's file list. A mod can list 30,000 files and a library 200,000, which every
// launch sent to the window and kept there (about 55 MB for 246 mods) only to learn a handful of facts. Of the list,
// this keeps the first file that tells each frontend rule something new:
//   utils/heroes.ts detectHeroes (a hero id from the folder, else from the file name, and WBP_Galacta),
//   custom/loadoutSkins.ts skinLooks (a skin folder), custom/vfx/quick.ts canUpdateVfx (MI_ or WBP_Battle_Kill_ assets),
//   ModDetailsPanel's Raw Assets badge (any .uasset) and App's Project Galacta check.
// Every rule reads each file alone and unions the results, so the kept files give each rule exactly the full list's
// answer. The details panel asks for the full list (get_mod_details fullFiles). A change to one of those rules needs
// its regex here too.
use regex_lite::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).unwrap())
}

/// Everything the frontend rules can learn from one file, as keys ("p:1026" a hero folder, "s:1026300" a skin...).
fn facts(file: &str) -> Vec<String> {
    static PATH: OnceLock<Regex> = OnceLock::new();
    static NAME: OnceLock<Regex> = OnceLock::new();
    static SKIN: OnceLock<Regex> = OnceLock::new();
    static VFX: OnceLock<Regex> = OnceLock::new();
    let lower = file.to_lowercase();
    let mut keys = Vec::new();
    // detectHeroes: WBP_Galacta, else the hero folder (case as written), else the file name (split on '/' only)
    if lower.contains("wbp_galacta") {
        keys.push("g".to_string());
    } else if let Some(c) = re(&PATH, r"(?:Characters|Hero_ST|Hero)/(\d{4})").captures(file) {
        keys.push(format!("p:{}", &c[1]));
    } else {
        let name = file.rsplit('/').next().unwrap_or(file);
        if !name.to_lowercase().starts_with("mi_") {
            if let Some(c) = re(&NAME, r"[_/](10[1-6]\d)(\d{3})").captures(name) {
                keys.push(format!("f:{}", &c[1]));
            }
        }
    }
    let slashed = file.replace('\\', "/");
    // skinLooks: a skin folder inside its own hero's folder
    if let Some(c) = re(&SKIN, r"(?i)(?:^|/)(?:characters|hero_st|hero)/(\d{4})/(\d{7})/").captures(&slashed) {
        if c[2].starts_with(&c[1]) {
            keys.push(format!("s:{}", &c[2]));
        }
    }
    // canUpdateVfx: a material instance or a KO prompt
    if re(&VFX, r"(?i)^(mi_|wbp_battle_kill_).*\.uasset$").is_match(slashed.rsplit('/').next().unwrap_or(&slashed)) {
        keys.push("v".to_string());
    }
    if lower.ends_with(".uasset") {
        keys.push("u".to_string()); // the Raw Assets badge
    }
    keys
}

/// The files of `files` that tell the Library something new, in their order.
pub fn library_files(files: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    files
        .iter()
        .filter(|f| facts(f).into_iter().fold(false, |new, k| seen.insert(k) | new))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(files: &[&str]) -> Vec<String> {
        files.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn one_file_per_fact_in_list_order() {
        let files = v(&[
            "Marvel/Content/Marvel/Characters/1026/1026300/Meshes/SK_panther.uasset",
            "Marvel/Content/Marvel/Characters/1026/1026300/Meshes/SK_panther.uexp",
            "Marvel/Content/Marvel/Characters/1026/1026300/Textures/T_suit.uasset",
            "Marvel/Content/Marvel/Characters/1026/1026001/Textures/T_suit.uasset",
            "Marvel/Content/Marvel/VFX/Materials/MI_Glow.uasset",
            "Marvel/Content/Marvel/UI/WBP_Galacta.uasset",
        ]);
        assert_eq!(library_files(&files), v(&[files[0].as_str(), files[3].as_str(), files[4].as_str(), files[5].as_str()]));
    }

    #[test]
    fn the_rules_read_like_the_frontend() {
        // the hero folder is case-sensitive in detectHeroes, the skin folder is not (and takes backslashes)
        assert_eq!(facts("marvel/characters/1026/x.uexp"), Vec::<String>::new());
        assert_eq!(facts(r"Marvel\Characters\1026\1026001\Textures\T_suit.uasset"), v(&["s:1026001", "u"]));
        // a file name gives a hero only without a folder match and not for MI_ files
        assert_eq!(facts("Marvel/Shared/T_1026300_D.uasset"), v(&["f:1026", "u"]));
        assert_eq!(facts("Marvel/Shared/MI_1026300.uasset"), v(&["v", "u"]));
        // a skin folder of another hero is no skin
        assert_eq!(facts("Marvel/Characters/1026/1011300/a.uexp"), v(&["p:1026"]));
        assert_eq!(facts("Marvel/UI/Battle/WBP_Battle_Kill_1026_V3.uasset"), v(&["v", "u"]), "no 7-digit id, so no hero");
        assert!(library_files(&v(&["a/T_Body.uexp", "a/b.bnk"])).is_empty(), "raw files that tell nothing are left out");
    }
}
