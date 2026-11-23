//! repakxtra: a dropped archive is unpacked once. The drop's look unpacks it into temp/repak-x/archives/<pid>-* and keeps
//! the folder, and Install takes that folder instead of unpacking it again (0.4 s at 192 MB, 1.7 s at 714 MB). Cancel and
//! the end of an install delete what is still kept, and the next start sweeps the rest (xtra_vfx::sweep_work_dirs).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// (the archive's stamp when it was unpacked, its folder)
static KEPT: Mutex<Vec<(String, PathBuf)>> = Mutex::new(Vec::new());

/// The archive as it is now: its path and a SHA-256 of its bytes, so any change to it (also one that keeps its size and
/// times) unpacks it again. About 0.15 s for 162 MB, against the 1.8 to 2 s unpack it saves.
fn stamp(archive: &Path) -> Option<String> {
    Some(format!("{}|{}", archive.display(), crate::xtra_update::sha256_file(archive).ok()?))
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

/// The drop's unpacked folder. It is kept for Install only when this is dropped, once the drop has finished reading it, so
/// Cancel, an install, or another drop never deletes it mid-read. `keep` false (nothing in it to install) deletes it.
pub struct Unpacked {
    pub dir: PathBuf,
    stamp: Option<String>,
    pub keep: std::cell::Cell<bool>,
}

impl Drop for Unpacked {
    fn drop(&mut self) {
        let Some(s) = self.stamp.take().filter(|_| self.keep.get()) else {
            let _ = std::fs::remove_dir_all(&self.dir);
            return;
        };
        let older = {
            let mut kept = KEPT.lock().unwrap_or_else(|e| e.into_inner());
            let older = kept.iter().position(|(k, _)| *k == s).map(|i| kept.swap_remove(i).1); // the same archive dropped again
            kept.push((s, self.dir.clone()));
            older
        };
        if let Some(d) = older {
            let _ = std::fs::remove_dir_all(d);
        }
    }
}

/// The drop's unpack (see Unpacked).
pub fn unpack_for_drop(archive: &Path) -> Result<Unpacked, String> {
    let stamp = stamp(archive);
    Ok(Unpacked { dir: unpack(archive)?, stamp, keep: std::cell::Cell::new(true) })
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

        let u = super::unpack_for_drop(&zip_path).unwrap();
        let kept = u.dir.clone();
        assert!(kept.join("a/x.pak").is_file());
        drop(u); // kept only once the drop has read it
        assert_eq!(super::take_or_unpack(&zip_path).unwrap(), kept, "Install reuses the drop's folder");
        let again = super::take_or_unpack(&zip_path).unwrap();
        assert_ne!(again, kept, "taken once: a second install unpacks fresh");

        let u = super::unpack_for_drop(&zip_path).unwrap();
        let dropped = u.dir.clone();
        drop(u);
        let skipped = super::unpack_for_drop(&zip_path).unwrap();
        skipped.keep.set(false); // nothing in it to install: deleted, and the kept one stays
        let gone = skipped.dir.clone();
        drop(skipped);
        assert!(!gone.exists() && dropped.exists());
        let mut bytes = std::fs::read(&zip_path).unwrap();
        let at = std::fs::metadata(&zip_path).unwrap().modified().unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        std::fs::write(&zip_path, bytes).unwrap();
        std::fs::File::options().write(true).open(&zip_path).unwrap().set_modified(at).unwrap();
        // the same size and change time with other bytes never reuses the old folder
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
        let t = std::time::Instant::now();
        super::stamp(std::path::Path::new(&a)).unwrap();
        println!("[unpack timing] stamp: {:.3} s", t.elapsed().as_secs_f32());
    }
}
