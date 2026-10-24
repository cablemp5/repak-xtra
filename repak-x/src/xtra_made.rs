//! repakxtra: an installed mod's file keeps when the mod was made, so a mod made before a game update and installed
//! after it still reads as made for the old game (xtra_broken.rs, the Needs VFX update check, reads the modified time).
//! Installs set the files' modified time to the source's (an archive entry's packed time, a .pak's own time, a loose
//! folder's newest file) and their created time to now: the Library's Newest sorts by the later of the two, so by
//! install date (main_tauri.rs get_pak_files).
use std::fs::{File, FileTimes};
use std::path::Path;
use std::time::{Duration, SystemTime};

/// Marvel Rivals came out on 2024-12-06: an earlier time is an archive that stored none (or a wrong clock), never a
/// mod's real date.
const RELEASE: Duration = Duration::from_secs(1_733_011_200); // 2024-12-01

fn plausible(t: SystemTime) -> Option<SystemTime> {
    (t >= SystemTime::UNIX_EPOCH + RELEASE && t <= SystemTime::now()).then_some(t)
}

/// A zip entry's time (local time, as zip stores it).
pub fn zip_time(d: Option<zip::DateTime>) -> Option<SystemTime> {
    use chrono::TimeZone;
    let d = d?;
    let at = chrono::Local
        .with_ymd_and_hms(d.year().into(), d.month().into(), d.day().into(), d.hour().into(), d.minute().into(), d.second().into())
        .earliest()?;
    plausible(at.into())
}

/// Sets an extracted file's modified time to its archive entry's.
pub fn keep_time(file: &File, at: Option<SystemTime>) {
    if let Some(at) = at {
        let _ = file.set_modified(at);
    }
}

/// When the mod at `source` was made: a file's (the newest of its .pak, .utoc and .ucas), or a folder's newest file.
pub fn made_at(source: &Path) -> Option<SystemTime> {
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let newest = if source.is_dir() {
        walkdir::WalkDir::new(source).into_iter().flatten().filter(|e| e.file_type().is_file()).filter_map(|e| modified(e.path())).max()
    } else {
        ["pak", "utoc", "ucas"].iter().filter_map(|x| modified(&source.with_extension(x))).chain(modified(source)).max()
    };
    newest.and_then(plausible)
}

/// Stamps freshly installed files: created now (the install), modified when the mod was made, the same on every file of
/// the bundle (a copy keeps each source file's own time, and the check reads the .pak's).
pub fn stamp(files: &[&Path], made: Option<SystemTime>) {
    let now = SystemTime::now();
    for p in files {
        let Ok(f) = File::options().write(true).open(p) else { continue };
        let written = f.metadata().and_then(|m| m.modified()).unwrap_or(now);
        let times = FileTimes::new().set_modified(made.unwrap_or(written));
        #[cfg(windows)]
        let times = std::os::windows::fs::FileTimesExt::set_created(times, now);
        let _ = f.set_times(times);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn times(p: &Path) -> (SystemTime, SystemTime) {
        let m = std::fs::metadata(p).unwrap();
        (m.created().unwrap(), m.modified().unwrap())
    }

    #[test]
    fn an_installed_mod_keeps_when_it_was_made_and_sorts_by_its_install() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("Aqua_P.pak");
        std::fs::write(&src, b"mod").unwrap();
        let made = SystemTime::UNIX_EPOCH + RELEASE + Duration::from_secs(300 * 86_400);
        File::options().write(true).open(&src).unwrap().set_modified(made).unwrap();
        assert_eq!(made_at(&src), Some(made));

        let out = dir.path().join("Aqua_9999999_P.pak");
        std::fs::write(&out, b"mod").unwrap();
        let before = SystemTime::now() - Duration::from_secs(5);
        stamp(&[&out], made_at(&src));
        let (created, modified) = times(&out);
        assert_eq!(modified, made, "modified: when it was made");
        assert!(created >= before, "created: the install, so Newest sorts by it");

        // a bundle copied as it is: a reused .pak older than its .utoc and .ucas all take the bundle's newest time
        let utoc = src.with_extension("utoc");
        std::fs::write(&utoc, b"toc").unwrap();
        let newer = made + Duration::from_secs(22 * 86_400);
        File::options().write(true).open(&utoc).unwrap().set_modified(newer).unwrap();
        assert_eq!(made_at(&src), Some(newer));
        let (pak, toc) = (dir.path().join("B_9999999_P.pak"), dir.path().join("B_9999999_P.utoc"));
        std::fs::copy(&src, &pak).unwrap();
        std::fs::copy(&utoc, &toc).unwrap();
        stamp(&[&pak, &toc], made_at(&src));
        assert_eq!((times(&pak).1, times(&toc).1), (newer, newer), "one time for the whole bundle");
    }

    #[test]
    fn a_mod_from_a_zip_is_made_when_it_was_packed() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("Aqua.zip");
        let packed = zip::DateTime::from_date_and_time(2025, 6, 1, 12, 0, 0).unwrap();
        let mut w = zip::ZipWriter::new(File::create(&zip_path).unwrap());
        w.start_file("Aqua_P.pak", zip::write::SimpleFileOptions::default().last_modified_time(packed)).unwrap();
        w.write_all(b"mod").unwrap();
        w.finish().unwrap();

        let out = dir.path().join("out");
        crate::install_mod::install_mod_logic::archives::extract_zip(zip_path.to_str().unwrap(), out.to_str().unwrap()).unwrap();
        assert_eq!(made_at(&out.join("Aqua_P.pak")), zip_time(Some(packed)), "the entry's time, not the extraction's");
    }

    #[test]
    fn times_before_the_game_existed_are_ignored() {
        assert_eq!(plausible(SystemTime::UNIX_EPOCH), None);
        assert_eq!(zip_time(zip::DateTime::from_date_and_time(1980, 1, 1, 0, 0, 0).ok()), None, "zip's empty date");
        assert!(zip_time(zip::DateTime::from_date_and_time(2025, 6, 1, 12, 0, 0).ok()).is_some());
    }
}
