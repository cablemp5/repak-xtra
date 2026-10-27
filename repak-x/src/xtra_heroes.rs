//! repakxtra: one strict reader for the hero and skin an asset path belongs to. Only directory segments count, never
//! the file name, so a texture called T_1024301_X in a Mantis folder is Mantis, not Hela. The hero is the 4 digits
//! right after a Characters folder (any case), and the skin is the next folder when it is 7 digits starting with
//! the hero's 4. Every spelling works: /Game/Marvel/..., Marvel/Content/Marvel/..., ../../../, backslashes, any case.

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HeroSkin {
    pub hero: String,
    pub skin: Option<String>,
}

fn digits(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit())
}

/// The hero (and skin) folder `path` sits in, or None.
pub fn hero_skin(path: &str) -> Option<HeroSkin> {
    let norm = path.replace('\\', "/");
    let mut dirs: Vec<&str> = norm.split('/').filter(|s| !s.is_empty()).collect();
    dirs.pop(); // the file or object name never counts
    // VFX/Materials/Characters/1026/... is fine, Characters/Common is not: keep looking past a Characters folder without a hero
    let at = (0..dirs.len().saturating_sub(1)).find(|&i| dirs[i].eq_ignore_ascii_case("characters") && digits(dirs[i + 1], 4))?;
    let hero = dirs[at + 1];
    let skin = dirs.get(at + 2).filter(|s| digits(s, 7) && s.starts_with(hero)).map(|s| s.to_string());
    Some(HeroSkin { hero: hero.to_string(), skin })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hs(hero: &str, skin: Option<&str>) -> Option<HeroSkin> {
        Some(HeroSkin { hero: hero.into(), skin: skin.map(Into::into) })
    }

    #[test]
    fn every_spelling_reads_the_same() {
        let want = hs("1026", Some("1026001"));
        for p in [
            "/Game/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset",
            "Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset",
            "../../../Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uexp",
            "Marvel\\Content\\Marvel\\CHARACTERS\\1026\\1026001\\Meshes\\SK_1026_1026001.uasset",
            "marvel/characters/1026/1026001/meshes/sk_1026_1026001",
        ] {
            assert_eq!(hero_skin(p), want, "{p}");
        }
    }

    #[test]
    fn the_file_name_never_counts() {
        assert_eq!(hero_skin("/Game/Marvel/Characters/1048/Textures/T_1024301_X.uasset"), hs("1048", None));
        assert_eq!(hero_skin("/Game/Marvel/UI/Textures/T_1024301_X.uasset"), None);
        assert_eq!(hero_skin("/Game/Marvel/Characters/1026"), None, "1026 is the last segment, a name");
    }

    #[test]
    fn a_characters_folder_without_a_hero_keeps_looking() {
        assert_eq!(hero_skin("/Game/Marvel/Characters/Common/VFX/Characters/1026/1026001/NS_A.uasset"), hs("1026", Some("1026001")));
        assert_eq!(hero_skin("/Game/Marvel/VFX/Materials/Characters/1026/MI_A.uasset"), hs("1026", None));
        assert_eq!(hero_skin("/Game/Marvel/Characters/Common/Textures/T_A.uasset"), None);
    }

    #[test]
    fn a_skin_must_start_with_its_hero() {
        assert_eq!(hero_skin("/Game/Marvel/Characters/1026/1033001/X.uasset"), hs("1026", None));
        assert_eq!(hero_skin("/Game/Marvel/Characters/1026/102600/X.uasset"), hs("1026", None), "6 digits");
        assert_eq!(hero_skin("/Game/Marvel/Characters/1026/Weapons/X.uasset"), hs("1026", None));
        assert_eq!(hero_skin("/Game/Marvel/Characters/10261/1026001/X.uasset"), None, "5 digits is no hero");
    }

    /// Spike: REPAKXTRA_PAKS=<...\Content\Paks> cargo test -p repak-x --bin REPAK-X real_library -- --ignored --nocapture
    /// Every file of every mod in ~mods (on or off) and every game package, read by hero_skin and by the old rules.
    #[test]
    #[ignore]
    fn real_library() {
        use std::collections::BTreeMap;
        let paks = std::path::PathBuf::from(std::env::var("REPAKXTRA_PAKS").expect("REPAKXTRA_PAKS"));
        let char_id = regex_lite::Regex::new(r"(?:Characters|Hero_ST|Hero)[/\\](\d{4})").unwrap();
        let skin_re = regex_lite::Regex::new(r"([0-9]{4})[/\\]([0-9]{7})").unwrap();
        let old_rules: [(&str, Box<dyn Fn(&str) -> Option<(String, Option<String>)>>); 4] = [
            ("CHAR_ID_REGEX", Box::new(move |p: &str| char_id.captures(p).map(|c| (c[1].to_string(), None)))),
            ("SKIN_REGEX", Box::new(move |p: &str| skin_re.captures(p).map(|c| (c[1].to_string(), Some(c[2].to_string()))))),
            ("extract_character_id", Box::new(|p: &str| crate::crash_monitor::extract_character_id(p).map(|h| (h, None)))),
            ("only_hero_folder", Box::new(|p: &str| {
                let mut parts = p.split(['/', '\\']);
                parts.find(|s| s.eq_ignore_ascii_case("Characters"))?;
                parts.next().filter(|id| digits(id, 4)).map(|h| (h.to_string(), None))
            })),
        ];
        let mut mods: Vec<String> = Vec::new();
        for e in walkdir::WalkDir::new(paks.join("~mods")).into_iter().filter_entry(crate::xtra_bundle::not_staging).flatten() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            if name.ends_with(".pak") || name.ends_with(".bak_repak") || name.ends_with(".pak_disabled") {
                mods.extend(crate::xtra_crash::mod_files(e.path()));
            }
        }
        let game = crate::xtra_broken::game_assets(&paks).expect("game assets");
        let corpora: [(&str, Vec<String>); 2] = [("mods", mods), ("game", game.keys().cloned().collect())];
        for (corpus, paths) in &corpora {
            println!("\n===== corpus {corpus}: {} paths", paths.len());
            // roots that are followed by a 4 digit folder
            let mut roots: BTreeMap<String, usize> = BTreeMap::new();
            let (mut skins, mut skin_mismatch, mut mismatch_examples) = (0, 0, Vec::new());
            for p in paths {
                let norm = p.replace('\\', "/");
                let segs: Vec<&str> = norm.split('/').collect();
                for w in segs.windows(2) {
                    if digits(w[1], 4) && ["characters", "hero", "hero_st"].contains(&w[0].to_lowercase().as_str()) {
                        *roots.entry(w[0].to_string()).or_default() += 1;
                        if !w[0].eq_ignore_ascii_case("characters") && roots[w[0]] <= 5 {
                            println!("   {} root: {p}", w[0]);
                        }
                    }
                }
                for w in segs.windows(3) {
                    if w[0].eq_ignore_ascii_case("characters") && digits(w[1], 4) && digits(w[2], 7) {
                        skins += 1;
                        if !w[2].starts_with(w[1]) {
                            skin_mismatch += 1;
                            if mismatch_examples.len() < 20 {
                                mismatch_examples.push(p.clone());
                            }
                        }
                    }
                }
            }
            println!("roots followed by 4 digits: {roots:?}");
            println!("Characters/<4>/<7> paths: {skins}, 7 digits NOT starting with the hero: {skin_mismatch}");
            for e in &mismatch_examples {
                println!("   mismatch: {e}");
            }
            for (rule, old) in &old_rules {
                let (mut agree, mut strict_only, mut old_only, mut different) = (0, Vec::new(), Vec::new(), Vec::new());
                let mut n = [0usize; 3];
                let mut old_only_by: BTreeMap<String, usize> = BTreeMap::new();
                for p in paths {
                    let s = hero_skin(p).map(|h| (h.hero, h.skin));
                    let o = old(p);
                    // compare the skin only for the rule that reads one
                    let same = |s: &(String, Option<String>), o: &(String, Option<String>)| s.0 == o.0 && (*rule != "SKIN_REGEX" || s.1 == o.1);
                    match (&s, &o) {
                        (None, None) => {}
                        (Some(a), Some(b)) if same(a, b) => agree += 1,
                        (Some(_), None) => { n[0] += 1; if strict_only.len() < 20 { strict_only.push(format!("{p} -> {s:?}")); } }
                        (None, Some(b)) => { n[1] += 1; *old_only_by.entry(format!("{} {}", b.0, p.replace('\\', "/").split('/').skip_while(|x| !x.to_lowercase().starts_with(&b.0[..])).next().unwrap_or("?"))).or_default() += 1; if old_only.len() < 20 { old_only.push(format!("{p} -> old {o:?}")); } }
                        _ => { n[2] += 1; if different.len() < 20 { different.push(format!("{p} -> strict {s:?} old {o:?}")); } }
                    }
                }
                println!("\n--- {rule}: agree {agree}, strict-only {}, old-only {}, different {}", n[0], n[1], n[2]);
                if *rule != "SKIN_REGEX" {
                    println!("   old-only by folder: {old_only_by:?}");
                }
                for (label, list) in [("strict-only", &strict_only), ("old-only", &old_only), ("different", &different)] {
                    for e in list {
                        println!("   {label}: {e}");
                    }
                }
            }
        }
    }
}
