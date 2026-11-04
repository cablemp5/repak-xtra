pub fn extract_zip(zip_path: &str, output_dir: &str) -> io::Result<()> {
    let file = File::open(zip_path)?;
    let mut archive = ZipArchive::new(file)?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        // repakxtra: skip links and names that would leave output_dir, like extract_rar does
        if file.is_symlink() || !entry_ok(Path::new(output_dir), file.name()) {
            log::warn!("Skipped unsafe zip entry {:?}", file.name());
            continue;
        }
        let outpath = Path::new(output_dir).join(file.mangled_name());

        if file.name().ends_with('/') {
            std::fs::create_dir_all(&outpath)?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    std::fs::create_dir_all(p)?;
                }
            }
            let mut outfile = File::create(&outpath)?;
            io::copy(&mut file, &mut outfile)?;
            crate::xtra_made::keep_time(&outfile, crate::xtra_made::zip_time(file.last_modified())); // repakxtra: when it was packed
        }
    }

    crate::xtra_offfiles::strip_off_names(Path::new(output_dir)); // repakxtra: .pak.off sets install like .pak
    Ok(())
}

use std::fs::File;
use std::io;
use std::path::Path;
use unrar::Archive;
use zip::ZipArchive;

pub fn extract_rar(rar_path: &str, output_dir: &str) -> Result<(), unrar::error::UnrarError> {
    let output_dir = Path::new(output_dir);
    let mut archive = Archive::new(rar_path).open_for_processing()?;
    while let Some(header) = archive.read_header()? {
        let filename = header.entry().filename.clone();
        // Entry names come from the archive - skip any that would leave output_dir
        archive = if header.entry().is_file() && entry_ok(output_dir, &filename.to_string_lossy()) { // repakxtra: reserved names and links too
            header.extract_to(output_dir.join(filename))?
        } else {
            header.skip()?
        };
    }
    crate::xtra_offfiles::strip_off_names(output_dir); // repakxtra: .pak.off sets install like .pak
    Ok(())
}

/// repakxtra: an archive entry name that stays inside `out` once joined (no "..", root, drive, reserved Windows
/// name or stream colon) and does not go through a link already under `out`.
fn entry_ok(out: &Path, name: &str) -> bool {
    let name = name.replace('\\', "/");
    let name = name.trim_end_matches('/');
    is_safe_entry_path(Path::new(name)) && crate::xtra_extract::safe_entry(name) && crate::xtra_extract::through_link(out, name).is_ok()
}

/// True when `path` stays inside the folder it is joined to: no "..", root or drive.
fn is_safe_entry_path(path: &Path) -> bool {
    path.components()
        .all(|c| matches!(c, std::path::Component::Normal(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_entries_that_escape() {
        assert!(is_safe_entry_path(Path::new("Mods/a.pak")));
        for bad in ["../a.pak", "Mods/../../a.pak", "/a.pak"] {
            assert!(!is_safe_entry_path(Path::new(bad)), "{bad}");
        }
        #[cfg(windows)]
        assert!(!is_safe_entry_path(Path::new("C:\\a.pak")));
    }

    #[test]
    fn zip_skips_escaping_and_reserved_entries() {
        use std::io::Write;
        let d = tempfile::tempdir().unwrap();
        let zip_path = d.path().join("m.zip");
        let mut w = zip::ZipWriter::new(File::create(&zip_path).unwrap());
        for name in ["Mods/", "Mods/a.pak", "../escape.txt", "Mods/NUL.txt", "/rooted.txt"] {
            if name.ends_with('/') {
                w.add_directory(name, zip::write::SimpleFileOptions::default()).unwrap();
            } else {
                w.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
                w.write_all(b"x").unwrap();
            }
        }
        w.finish().unwrap();
        let out = d.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        extract_zip(zip_path.to_str().unwrap(), out.to_str().unwrap()).unwrap();
        assert!(out.join("Mods/a.pak").is_file());
        assert!(!d.path().join("escape.txt").exists() && !out.join("escape.txt").exists());
        assert!(!out.join("rooted.txt").exists());
        assert_eq!(std::fs::read_dir(out.join("Mods")).unwrap().count(), 1);
    }
}

pub fn extract_7z(archive_path: &str, output_dir: &str) -> io::Result<()> {
    let output_path = Path::new(output_dir);
    std::fs::create_dir_all(output_path)?;

    // repakxtra: check each entry name first, skipping (and draining) unsafe ones, like extract_rar does
    sevenz_rust2::decompress_file_with_extract_fn(archive_path, output_path, |entry, reader, dest| {
        if entry_ok(output_path, entry.name()) {
            return sevenz_rust2::default_entry_extract_fn(entry, reader, dest);
        }
        log::warn!("Skipped unsafe 7z entry {:?}", entry.name());
        io::copy(reader, &mut io::sink())?;
        Ok(true)
    })
    .map_err(|e| {
        io::Error::new(
            io::ErrorKind::Other,
            format!("Failed to extract 7z archive: {}", e),
        )
    })?;

    crate::xtra_offfiles::strip_off_names(output_path); // repakxtra: .pak.off sets install like .pak
    Ok(())
}
