//! repakxtra: where a mod came from, read off the archive's name when it is a Nexus Mods download
//! (see parse for its two name formats). Nothing is fetched; other names give nothing. Also lists the paks an install
//! source holds (install_paks).

use regex_lite::Regex;
use serde::Serialize;
use std::sync::OnceLock;

#[derive(Serialize, Debug, PartialEq)]
pub struct NexusSource {
    /// The Nexus mod id (the number in nexusmods.com/marvelrivals/mods/<id>)
    id: u64,
    /// The file's version, dashes read as dots ("1-0-2" is 1.0.2)
    version: String,
    /// Upload time, Unix seconds (UTC)
    uploaded: i64,
    /// The names of the paks inside (without .pak): the install names a lone pak after itself, not the archive
    paks: Vec<String>,
}

/// Both of Nexus's download names. The current one, matched from the timestamp backwards (the name part may hold digits
/// and underscores of its own, "BP_9999999_P"), with underscores or spaces between the parts:
///   "<name>_<id>_<version>_<YYYY-MM-DDTHH-MMZ>_<random>.zip"  and  "<name> <id> <version> <YYYY-MM-DDTHH-MMZ> <random>.zip"
/// and the older one, with dashes and Unix seconds: "<name>-<id>-<version>-<seconds>.zip" (version "2-5" is 2.5).
fn parse(file_name: &str) -> Option<NexusSource> {
    static NOW: OnceLock<Regex> = OnceLock::new();
    static OLD: OnceLock<Regex> = OnceLock::new();
    let now = NOW.get_or_init(|| {
        Regex::new(r"(?i)^(.+)[_ ](\d+)[_ ]([0-9A-Za-z.\-]+)[_ ](\d{4}-\d{2}-\d{2}T\d{2}-\d{2}Z)[_ ][0-9A-Za-z]+\.(zip|rar|7z)$").unwrap()
    });
    // shortcut: the name is matched up to the first "-<digits>-" that fits, so a name ending in "-<number>" reads wrong
    // (rare in practice); the newer format has no such ambiguity
    let old = OLD.get_or_init(|| Regex::new(r"(?i)^(.+?)-(\d+)-([0-9A-Za-z]+(?:-[0-9A-Za-z]+)*)-(\d{9,11})\.(zip|rar|7z)$").unwrap());
    let name = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    let (caps, uploaded) = if let Some(c) = now.captures(name) {
        let t = chrono::NaiveDateTime::parse_from_str(&c[4].to_uppercase(), "%Y-%m-%dT%H-%MZ").ok()?.and_utc().timestamp();
        (c, t)
    } else {
        let c = old.captures(name)?;
        let t = c[4].parse().ok()?;
        (c, t)
    };
    Some(NexusSource { id: caps[2].parse().ok()?, version: caps[3].replace('-', "."), uploaded, paks: Vec::new() })
}

/// Every file name in a zip, rar or 7z, read from its index (nothing is extracted).
fn archive_entries(path: &str) -> Vec<String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".zip") {
        return std::fs::File::open(path).ok().and_then(|f| zip::ZipArchive::new(f).ok())
            .map(|a| a.file_names().map(str::to_string).collect()).unwrap_or_default();
    }
    if lower.ends_with(".rar") {
        return unrar::Archive::new(path).open_for_listing().map(|list| {
            list.filter_map(Result::ok).map(|h| h.filename.to_string_lossy().into_owned()).collect()
        }).unwrap_or_default();
    }
    if lower.ends_with(".7z") {
        return sevenz_rust2::Archive::open(path).map(|a| a.files.into_iter().map(|f| f.name).collect()).unwrap_or_default();
    }
    Vec::new()
}

/// The pak names in an archive listing, each once, without folders or extension.
fn pak_stems(entries: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in entries {
        let name = e.rsplit(['/', '\\']).next().unwrap_or(e);
        let path = std::path::Path::new(crate::xtra_offfiles::strip_off(name).unwrap_or(name)); // a .pak.off installs as its .pak
        let is_pak = path.extension().is_some_and(|x| x.eq_ignore_ascii_case("pak"));
        if let (true, Some(stem)) = (is_pak, path.file_stem().and_then(|s| s.to_str())) {
            if !stem.is_empty() && !out.iter().any(|o| o == stem) {
                out.push(stem.to_string());
            }
        }
    }
    out
}

/// The Nexus source of each archive path, in order (None for names that are not Nexus downloads).
#[tauri::command]
pub async fn xtra_nexus_sources(paths: Vec<String>) -> Result<Vec<Option<NexusSource>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths.iter().map(|p| parse(p).map(|s| NexusSource { paks: pak_stems(&archive_entries(p)), ..s })).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// The pak names each install source puts in place (without .pak): an archive or folder installs every pak inside under
/// the pak's own name, not the source's, so a loadout made at install looks the mods up by these (installLoadout.tsx).
/// A lone .pak gives its own name.
fn install_paks(path: &str) -> Vec<String> {
    let entries = if std::path::Path::new(path).is_dir() {
        walkdir::WalkDir::new(path).into_iter().filter_map(Result::ok).map(|e| e.path().to_string_lossy().into_owned()).collect()
    } else {
        let listed = archive_entries(path);
        if listed.is_empty() { vec![path.to_string()] } else { listed }
    };
    pak_stems(&entries)
}

/// install_paks for each install source, in order.
#[tauri::command]
pub async fn xtra_install_paks(paths: Vec<String>) -> Result<Vec<Vec<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|p| install_paks(p)).collect())
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(id: u64, version: &str, ts: &str) -> Option<NexusSource> {
        let uploaded = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%d %H:%M").unwrap().and_utc().timestamp();
        Some(NexusSource { id, version: version.into(), uploaded, paks: Vec::new() })
    }

    #[test]
    fn reads_nexus_download_names() {
        assert_eq!(parse("MadeInHeavenBPULT_9999999_P_12890_1_2026-09-13T23-01Z_qaKPUQuo2.zip"), src(12890, "1", "2026-09-13 23:01"));
        assert_eq!(parse("Pucci_Icon_11083_1_2026-07-22T21-07Z_Qb2JNEtBG.zip"), src(11083, "1", "2026-07-22 21:07"));
        assert_eq!(parse("Pucci_Skin_11083_1_2026-07-19T16-10Z_CNMGVqLMR.zip"), src(11083, "1", "2026-07-19 16:10"));
        assert_eq!(parse(r"C:\Users\x\Downloads\Cool Mod_2940_1-0-2_2026-01-02T03-04Z_abc.rar"), src(2940, "1.0.2", "2026-01-02 03:04"));
        // the same format with spaces, as some downloads arrive
        assert_eq!(parse("Mialygosa Magik 1.3.1 12984 5 2026-09-21T17-38Z YLrVJSM1X.zip"), src(12984, "5", "2026-09-21 17:38"));
    }

    #[test]
    fn reads_the_older_nexus_names() {
        let at = |id: u64, version: &str, uploaded: i64| Some(NexusSource { id, version: version.into(), uploaded, paks: Vec::new() });
        assert_eq!(parse("MAGIK DISCO REVIVIAMP-7488-2-1774550074.zip"), at(7488, "2", 1774550074));
        assert_eq!(parse("MAGIK GALA JUMPSUIT WITH CHIN-8170-1-1777240756.zip"), at(8170, "1", 1777240756));
        assert_eq!(parse("Radiant Knight Magik-3485-2-5-1750665034.rar"), at(3485, "2.5", 1750665034));
        assert_eq!(parse("Some-Mod-v2.zip"), None);
        assert_eq!(parse("Mod-12-3-1750665034.pak"), None, "not an archive");
    }

    #[test]
    fn lists_each_pak_once() {
        let entries = ["Mod/A_9999999_P.pak", "Mod/A_9999999_P.utoc", "Mod/A_9999999_P.ucas", r"Other\B.PAK", "readme.txt", "C.pak.txt", "Mod/A_9999999_P.pak", "D.pak.off"];
        assert_eq!(pak_stems(&entries.map(String::from)), vec!["A_9999999_P".to_string(), "B".to_string(), "D".to_string()]);
    }

    #[test]
    fn reads_a_zip_index() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Mod_1_1_2026-01-01T00-00Z_x.zip");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        for name in ["Mod/A_9999999_P.pak", "Mod/A_9999999_P.utoc"] {
            w.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(b"x").unwrap();
        }
        w.finish().unwrap();
        assert_eq!(pak_stems(&archive_entries(path.to_str().unwrap())), vec!["A_9999999_P".to_string()]);
    }

    #[test]
    fn lists_the_paks_an_install_puts_in_place() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("Mod")).unwrap();
        for name in ["Mod/A_9999999_P.pak", "Mod/A_9999999_P.utoc", "B.pak", "readme.txt"] {
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }
        let mut found = install_paks(dir.path().to_str().unwrap());
        found.sort();
        assert_eq!(found, vec!["A_9999999_P".to_string(), "B".to_string()]);
        assert_eq!(install_paks(dir.path().join("B.pak").to_str().unwrap()), vec!["B".to_string()]);
    }

    #[test]
    fn other_names_give_nothing() {
        assert_eq!(parse("MadeInHeavenBPULT_9999999_P.pak"), None);
        assert_eq!(parse("Pucci Skin.zip"), None, "Google Drive or Discord download");
        assert_eq!(parse("Mod_12890_1_2026-09-13_qaKPUQuo2.zip"), None, "no time");
        assert_eq!(parse("Mod_12890_1_2026-13-40T23-01Z_qaKPUQuo2.zip"), None, "no such date");
        assert_eq!(parse("Mod_12890_1_2026-09-13T23-01Z_qaKPUQuo2.pak"), None, "not an archive");
    }
}
