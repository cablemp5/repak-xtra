//! repakxtra: a loadout's mods as one zip (Loadout page > More > Export as zip). Each mod's .pak goes in with its .utoc
//! and .ucas; a mod that is off goes in under its enabled name, so the zip installs like any mod download. Each entry
//! keeps its file's date, so a mod installed from the zip keeps when it was made (xtra_made.rs), and with it the
//! Needs update and May crash checks that go by that date (it was the export's time before). The zip is
//! written to its own temp file beside the target and moved into place only when complete, so a failed or concurrent
//! export never leaves half a zip. Also the rename guard: a mod's new name must not be any other mod's file.
use std::collections::HashMap;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

/// The files of one installed mod and their names in the zip: the pak (enabled name), then its .utoc and .ucas if present.
fn files_of(pak: &Path) -> Vec<(PathBuf, String)> {
    let name = pak.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let stem = ["_disabled", ".bak_repak", ".pak_disabled", ".pak"]
        .iter()
        .fold(name.as_str(), |s, ext| s.strip_suffix(ext).unwrap_or(s))
        .to_string();
    let dir = pak.parent().unwrap_or(Path::new(""));
    let mut out = vec![(pak.to_path_buf(), format!("{stem}.pak"))];
    for ext in ["utoc", "ucas"] {
        let side = dir.join(format!("{stem}.{ext}"));
        if side.is_file() {
            out.push((side, format!("{stem}.{ext}")));
        }
    }
    out
}

/// Why a mod (its files named `old_stem` in `parent`) cannot take `new_stem`: another mod has a file of that name, on or
/// off, or its .utoc/.ucas. A case-only rename of the same mod is fine. rename_mod checked the new name only with the
/// mod's current extension, so an off mod renamed to an on mod's name took over that mod's .utoc and .ucas.
pub fn name_taken(parent: &Path, old_stem: &str, new_stem: &str) -> Option<String> {
    if old_stem.eq_ignore_ascii_case(new_stem) {
        return None;
    }
    ["pak", "bak_repak", "pak_disabled", "utoc", "ucas"]
        .iter()
        .map(|ext| format!("{new_stem}.{ext}"))
        .find(|name| parent.join(name).exists())
        .map(|name| format!("Another mod already uses the name '{name}'"))
}

fn write_zip(paths: &[String], dest: &Path) -> io::Result<usize> {
    let mut zip = zip::ZipWriter::new(File::create(dest)?);
    // Paks and .ucas are already compressed: a fast deflate keeps big loadouts quick to export
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(1))
        .large_file(true);
    // A zip name holds one file: the same file asked for twice goes in once, two different files under one name stop
    // the export (a mod would otherwise be left out without a word)
    let mut seen: HashMap<String, PathBuf> = HashMap::new();
    let mut count = 0;
    for path in paths {
        for (src, name) in files_of(Path::new(path)) {
            let same = |a: &Path, b: &Path| a == b || a.canonicalize().ok().zip(b.canonicalize().ok()).is_some_and(|(x, y)| x == y);
            match seen.get(&name.to_lowercase()) {
                Some(had) if same(had, &src) => continue,
                Some(_) => return Err(io::Error::other(format!("Two mods would both be '{name}' in the zip. Rename one, then export again."))),
                None => { seen.insert(name.to_lowercase(), src.clone()); }
            }
            let made = std::fs::metadata(&src).and_then(|m| m.modified()).ok().and_then(crate::xtra_made::to_zip_time);
            zip.start_file(name.as_str(), made.map_or(opts, |t| opts.last_modified_time(t)))?;
            io::copy(&mut File::open(&src)?, &mut zip)?;
            count += 1;
        }
    }
    zip.finish()?;
    Ok(count)
}

/// Writes the mods at `paths` into the zip at `dest`; returns how many files went in.
#[tauri::command]
pub async fn export_loadout_zip(paths: Vec<String>, dest: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest = PathBuf::from(dest);
        let part = dest.with_extension(format!("zip.{}.part", uuid::Uuid::new_v4().simple()));
        let result = write_zip(&paths, &part).and_then(|n| std::fs::rename(&part, &dest).map(|_| n));
        if result.is_err() {
            let _ = std::fs::remove_file(&part);
        }
        crate::ui_log::info("Export", match &result {
            Ok(n) => format!("Exported {n} files to {}", dest.display()),
            Err(e) => format!("Export to {} failed: {e}", dest.display()),
        });
        result.map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zips_paks_with_their_iostore_files_under_enabled_names() {
        let dir = tempfile::tempdir().unwrap();
        for f in ["A_9999999_P.bak_repak", "A_9999999_P.utoc", "A_9999999_P.ucas", "B.pak"] {
            std::fs::write(dir.path().join(f), f).unwrap();
        }
        let paths = ["A_9999999_P.bak_repak", "B.pak", "B.pak"].map(|f| dir.path().join(f).to_string_lossy().to_string());
        let dest = dir.path().join("out.zip");
        assert_eq!(write_zip(&paths, &dest).unwrap(), 4);
        let mut names: Vec<String> = zip::ZipArchive::new(File::open(&dest).unwrap()).unwrap().file_names().map(String::from).collect();
        names.sort();
        assert_eq!(names, ["A_9999999_P.pak", "A_9999999_P.ucas", "A_9999999_P.utoc", "B.pak"]);
        // each entry keeps its file's date (to zip's 2 seconds), not the export's
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(40 * 86_400);
        File::options().write(true).open(dir.path().join("B.pak")).unwrap().set_modified(old).unwrap();
        write_zip(&paths, &dest).unwrap();
        let mut z = zip::ZipArchive::new(File::open(&dest).unwrap()).unwrap();
        let at = crate::xtra_made::zip_time(z.by_name("B.pak").unwrap().last_modified()).unwrap();
        assert!(at.duration_since(old).unwrap_or_default().as_secs() <= 2 && old.duration_since(at).unwrap_or_default().as_secs() <= 2);
    }

    #[test]
    fn two_different_mods_under_one_zip_name_stop_the_export() {
        let dir = tempfile::tempdir().unwrap();
        for sub in ["x", "y"] {
            std::fs::create_dir(dir.path().join(sub)).unwrap();
            std::fs::write(dir.path().join(sub).join("Foo.pak"), sub).unwrap();
        }
        let paths = ["x", "y"].map(|s| dir.path().join(s).join("Foo.pak").to_string_lossy().to_string());
        assert!(write_zip(&paths, &dir.path().join("out.zip")).is_err());
    }

    #[test]
    fn a_new_name_another_mod_uses_on_or_off_is_taken() {
        let dir = tempfile::tempdir().unwrap();
        for f in ["A.bak_repak", "B.pak", "B.utoc", "C.ucas"] {
            std::fs::write(dir.path().join(f), f).unwrap();
        }
        assert!(name_taken(dir.path(), "A", "B").is_some());   // B is on: its .pak, not a .bak_repak
        assert!(name_taken(dir.path(), "A", "C").is_some());   // a leftover .ucas alone
        assert!(name_taken(dir.path(), "A", "D").is_none());
        assert!(name_taken(dir.path(), "A", "a").is_none());   // case-only rename of itself
    }
}
