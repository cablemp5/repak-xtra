//! repakxtra: the file a `repakx://install?file=` link names comes from a web page, so it is checked before the disk is
//! touched: a mod file or archive, in this user's Downloads folder (where the browser extension saves), never a network
//! path. `delete_source_archive` uses the same check, so the delete after install can only reach such a file.

use std::path::{Component, Path, PathBuf, Prefix};

/// What the extension flow handles (and may delete afterwards).
pub const EXTENSIONS: [&str; 6] = ["zip", "rar", "7z", "pak", "utoc", "ucas"];

/// `raw` as a path the extension flow may open and delete, or the reason it may not.
pub fn checked(raw: &str) -> Result<PathBuf, String> {
    let downloads = dirs::download_dir().ok_or("This PC has no Downloads folder")?;
    checked_in(raw, &downloads)
}

fn checked_in(raw: &str, downloads: &Path) -> Result<PathBuf, String> {
    let refuse = || format!("Only a mod file or archive in your Downloads folder can come from a link: {raw}");
    // a network path would make Windows contact that server on the first look, so it is refused before any
    if raw.starts_with(r"\\") || raw.starts_with("//") || raw.contains('\0') {
        return Err(refuse());
    }
    let p = Path::new(raw);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    let on_drive = matches!(p.components().next(), Some(Component::Prefix(x)) if matches!(x.kind(), Prefix::Disk(_)));
    let low = |p: &Path| PathBuf::from(p.to_string_lossy().to_lowercase());
    if !EXTENSIONS.contains(&ext.as_str())
        || !on_drive
        || p.components().any(|c| c == Component::ParentDir)
        || !low(p).starts_with(low(downloads))
    {
        return Err(refuse());
    }
    // a junction inside Downloads could still lead elsewhere: the real paths must agree too
    let real = p.canonicalize().map_err(|_| format!("File not found: {raw}"))?;
    let real_downloads = downloads.canonicalize().map_err(|e| e.to_string())?;
    if !real.is_file() || !real.starts_with(&real_downloads) {
        return Err(refuse());
    }
    Ok(p.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_mod_file_inside_downloads_passes() {
        let d = tempfile::tempdir().unwrap();
        let dl = d.path().join("Downloads");
        std::fs::create_dir_all(dl.join("sub")).unwrap();
        std::fs::create_dir_all(d.path().join("Paks")).unwrap();
        for f in [dl.join("Mod.ZIP"), dl.join("sub").join("a.pak"), dl.join("notes.txt"), d.path().join("Paks").join("game.pak")] {
            std::fs::write(f, b"x").unwrap();
        }
        let s = |p: PathBuf| p.to_string_lossy().into_owned();
        assert!(checked_in(&s(dl.join("Mod.ZIP")), &dl).is_ok());
        assert!(checked_in(&s(dl.join("sub").join("a.pak")), &dl).is_ok());
        assert!(checked_in(&s(dl.join("notes.txt")), &dl).is_err());
        assert!(checked_in(&s(d.path().join("Paks").join("game.pak")), &dl).is_err());
        assert!(checked_in(&s(dl.join("..").join("Paks").join("game.pak")), &dl).is_err());
        assert!(checked_in(&s(dl.join("missing.zip")), &dl).is_err());
        assert!(checked_in(&s(dl.clone()), &dl).is_err());
        for raw in [r"\\attacker\share\x.zip", r"\\?\C:\x.zip", "//attacker/share/x.zip", r"C:\", "x.zip", r"\x.zip"] {
            assert!(checked_in(raw, &dl).is_err(), "{raw}");
        }
        // a Downloads named like a prefix of another folder does not cover it
        std::fs::create_dir_all(d.path().join("Downloads2")).unwrap();
        std::fs::write(d.path().join("Downloads2").join("b.zip"), b"x").unwrap();
        assert!(checked_in(&s(d.path().join("Downloads2").join("b.zip")), &dl).is_err());
    }
}
