//! repakxtra: a dropped archive is unpacked once. The drop's look unpacks it into temp/repak-x/archives/<pid>-* and keeps
//! the folder, and Install takes that folder instead of unpacking it again (0.4 s at 192 MB, 1.7 s at 714 MB). Cancel and
//! the end of an install delete what is still kept, and the next start sweeps the rest (xtra_vfx::sweep_work_dirs).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// (the archive's stamp when it was unpacked, its folder)
static KEPT: Mutex<Vec<(String, PathBuf)>> = Mutex::new(Vec::new());

/// The archive as it is now: path, size, and change time, so a changed or replaced archive is unpacked again.
fn stamp(archive: &Path) -> Option<String> {
    let m = std::fs::metadata(archive).ok()?;
    let ns = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    Some(format!("{}|{}|{ns}", archive.display(), m.len()))
}

/// Unpacks into a fresh run folder. A failed unpack leaves no folder behind.
pub fn unpack(archive: &Path) -> Result<PathBuf, String> {
    use crate::install_mod::install_mod_logic::archives::{extract_7z, extract_rar, extract_zip};
    let dir = crate::xtra_vfx::run_work_dir("archives")?;
    let (src, out) = (archive.to_string_lossy(), dir.to_string_lossy());
    let done = match archive.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
        "zip" => extract_zip(&src, &out).map_err(|e| e.to_string()),
        "rar" => extract_rar(&src, &out).map_err(|e| e.to_string()),
        _ => extract_7z(&src, &out).map_err(|e| e.to_string()),
    };
    match done {
        Ok(()) => Ok(dir),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            Err(e)
        }
    }
}

/// The drop's unpack, kept for Install. The same archive dropped again replaces its older folder.
pub fn unpack_and_keep(archive: &Path) -> Result<PathBuf, String> {
    let before = stamp(archive);
    let dir = unpack(archive)?;
    if let Some(s) = before {
        let mut kept = KEPT.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(i) = kept.iter().position(|(k, _)| *k == s) {
            let _ = std::fs::remove_dir_all(kept.swap_remove(i).1);
        }
        kept.push((s, dir.clone()));
    }
    Ok(dir)
}

/// Install's folder for this archive: the kept one when the archive is unchanged since the drop, else a fresh unpack.
pub fn take_or_unpack(archive: &Path) -> Result<PathBuf, String> {
    let kept = stamp(archive).and_then(|s| {
        let mut kept = KEPT.lock().unwrap_or_else(|e| e.into_inner());
        let i = kept.iter().position(|(k, d)| *k == s && d.is_dir())?;
        Some(kept.swap_remove(i).1)
    });
    kept.map_or_else(|| unpack(archive), Ok)
}

/// Every kept folder deleted (Cancel, and the end of an install for rows that were left out).
pub fn forget() {
    let gone: Vec<_> = std::mem::take(&mut *KEPT.lock().unwrap_or_else(|e| e.into_inner()));
    for (_, d) in gone {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[tauri::command]
pub fn forget_unpacked_archives() {
    forget();
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    #[test]
    fn kept_until_taken_and_fresh_after_a_change() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("m.zip");
        let mut z = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
        z.start_file("a/x.pak", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(b"pak").unwrap();
        z.finish().unwrap();

        let kept = super::unpack_and_keep(&zip_path).unwrap();
        assert!(kept.join("a/x.pak").is_file());
        assert_eq!(super::take_or_unpack(&zip_path).unwrap(), kept, "Install reuses the drop's folder");
        let again = super::take_or_unpack(&zip_path).unwrap();
        assert_ne!(again, kept, "taken once: a second install unpacks fresh");

        let dropped = super::unpack_and_keep(&zip_path).unwrap();
        std::fs::OpenOptions::new().append(true).open(&zip_path).unwrap().write_all(b" ").unwrap();
        // a changed archive (size differs) never reuses the old folder
        let after = super::take_or_unpack(&zip_path);
        assert!(after.map_or(true, |d| d != dropped));
        super::forget();
        assert!(!dropped.exists(), "forget deletes what is still kept");
        for d in [kept, again] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    /// Times one unpack, the one Install no longer repeats: REPAKXTRA_BENCH_MOD=<an archive> cargo test -p repak-x --bin REPAK-X unpack_bench -- --ignored --nocapture
    #[test]
    #[ignore]
    fn unpack_bench() {
        let Some(a) = std::env::var_os("REPAKXTRA_BENCH_MOD") else { return };
        for i in 0..3 {
            let t = std::time::Instant::now();
            let d = super::unpack(std::path::Path::new(&a)).unwrap();
            println!("[unpack timing] {i}: {:.3} s", t.elapsed().as_secs_f32());
            let _ = std::fs::remove_dir_all(d);
        }
    }
}
