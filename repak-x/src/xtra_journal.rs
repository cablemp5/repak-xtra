//! repakxtra: a swap of a mod's files (an update put in its place, an install over an older copy) takes several renames
//! and moves to Recently deleted. Each one already undoes itself on an error, but a crash or a closed app in between left
//! the mod half moved. Before the first change the whole plan is written here, and removed once the swap is done or
//! undone. One still here at the next start was cut short: `recover` puts every file back where it was, so the mod is
//! as it was before (the update is made again).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Default)]
pub struct Plan {
    /// the Recently deleted entry the replaced files go to
    pub trash: Option<PathBuf>,
    /// the files that go there, by where they were
    pub trashed: Vec<PathBuf>,
    /// each rename, in order (from, to)
    pub renames: Vec<(PathBuf, PathBuf)>,
    /// each rename's file (its volume and file number, which a rename keeps), set by begin: a rename is undone only
    /// for that same file, so a swap that undid itself before the note went never moves a restored original again
    #[serde(default)]
    pub ids: Vec<Option<(u64, u64)>>,
}

/// A file's volume and file number: kept by a rename in one volume and never shared by two files, so it names the
/// file wherever it moved (size and time do not: an install copies the source's time, and every empty companion .pak
/// is 416 bytes).
#[cfg(windows)]
fn id(p: &Path) -> Option<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    #[derive(Default)]
    struct Info {
        attributes: u32,
        times: [u32; 6],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(file: *mut std::ffi::c_void, info: *mut Info) -> i32;
    }
    let f = std::fs::File::open(p).ok()?;
    let mut info = Info::default();
    // SAFETY: a handle this File owns for the call, and a struct laid out as BY_HANDLE_FILE_INFORMATION
    (unsafe { GetFileInformationByHandle(f.as_raw_handle(), &mut info) } != 0).then(|| (info.volume as u64, (info.index_high as u64) << 32 | info.index_low as u64))
}

#[cfg(not(windows))]
fn id(p: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(p).ok().map(|m| (m.dev(), m.ino()))
}

fn dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Repak-X").join("swap-journal")
}

/// The plan on disk while a swap runs: dropped (the file removed) when the swap finished or undid itself.
pub struct Open(PathBuf);

impl Drop for Open {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Writes `plan` before a swap starts. Err: it could not be written, and the swap must not start.
pub fn begin(plan: &Plan) -> Result<Open, String> {
    begin_in(&dir(), plan)
}

fn begin_in(dir: &Path, plan: &Plan) -> Result<Open, String> {
    use std::io::Write;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", uuid::Uuid::new_v4()));
    let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let ids = plan.renames.iter().map(|(from, _)| id(from)).collect();
    let noted = Plan { trash: plan.trash.clone(), trashed: plan.trashed.clone(), renames: plan.renames.clone(), ids };
    f.write_all(&serde_json::to_vec(&noted).map_err(|e| e.to_string())?).and_then(|_| f.sync_all()).map_err(|e| format!("Could not note the swap before it starts: {e}"))?;
    Ok(Open(path))
}

/// Puts back every swap a closed or crashed run cut short: each rename undone, newest first, where its new name holds
/// the file it moved and its old one is free, then each file it sent to Recently deleted back where it was. Run at start, before the
/// staging folders are swept (an update's files may still sit in one). Returns what could not be put back.
pub fn recover() -> Vec<String> {
    recover_in(&dir())
}

fn recover_in(dir: &Path) -> Vec<String> {
    let mut stuck = Vec::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = e.path();
        let Some(plan) = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Plan>(&b).ok()) else {
            let _ = std::fs::remove_file(&path); // cut short while it was written: the swap never started
            continue;
        };
        for (i, (from, to)) in plan.renames.iter().enumerate().rev() {
            // only the file that rename moved (its file number): never one put back there since
            let moved = plan.ids.get(i).copied().flatten().is_some_and(|was| id(to) == Some(was));
            if moved && !from.exists() {
                if let Err(e) = std::fs::rename(to, from) {
                    stuck.push(format!("{} could not go back to {} ({e})", to.display(), from.display()));
                }
            }
        }
        if let Some(t) = &plan.trash {
            for p in plan.trashed.iter().filter(|p| !p.exists()) {
                if t.join(p.file_name().unwrap_or_default()).exists() {
                    if let Err(e) = crate::xtra_trash::put_back(t, p) {
                        stuck.push(format!("{} is in Settings > Recently deleted ({e})", p.display()));
                    }
                }
            }
            crate::xtra_trash::release_if_empty(t);
        }
        log::warn!("[swap journal] put back a swap that was cut short: {}", path.display());
        let _ = std::fs::remove_file(&path);
    }
    stuck
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_swap_cut_short_is_put_back_and_a_finished_one_leaves_nothing() {
        let d = tempfile::tempdir().unwrap();
        let (j, mods, trash) = (d.path().join("journal"), d.path().join("mods"), d.path().join("trash"));
        std::fs::create_dir_all(&mods).unwrap();
        std::fs::create_dir_all(&trash).unwrap();
        let (orig, broken, tmp) = (mods.join("A.utoc"), mods.join("A_BROKEN.utoc"), mods.join("A.utoc.repakxtra-tmp"));
        let old_other = mods.join("A_BROKEN.ucas");
        std::fs::write(&orig, b"original").unwrap();
        std::fs::write(&tmp, b"update").unwrap();
        std::fs::write(&old_other, b"older broken copy").unwrap();
        let plan = Plan { trash: Some(trash.clone()), trashed: vec![old_other.clone()], renames: vec![(orig.clone(), broken.clone()), (tmp.clone(), orig.clone())], ..Default::default() };
        // finished: the journal goes with the handle
        drop(begin_in(&j, &plan).unwrap());
        assert_eq!(std::fs::read_dir(&j).unwrap().count(), 0);
        // cut short after every step: the older copy in the trash, the original renamed, the update in its place
        std::mem::forget(begin_in(&j, &plan).unwrap());
        crate::xtra_trash::discard(&trash, &old_other).unwrap();
        std::fs::rename(&orig, &broken).unwrap();
        std::fs::rename(&tmp, &orig).unwrap();
        assert!(recover_in(&j).is_empty());
        assert_eq!(std::fs::read(&orig).unwrap(), b"original", "the original is back under its name");
        assert_eq!(std::fs::read(&tmp).unwrap(), b"update", "the update back to its temporary name (swept later)");
        assert_eq!(std::fs::read(&old_other).unwrap(), b"older broken copy", "the replaced file is back");
        assert!(!broken.exists() && std::fs::read_dir(&j).unwrap().count() == 0);
        // cut short after the swap undid itself (its temporary files deleted, the original back): nothing moves, even
        // when the original matches the update's size and time
        std::fs::write(&orig, b"original").unwrap();
        let t = std::fs::metadata(&orig).unwrap().modified().unwrap();
        std::fs::write(&tmp, b"updated!").unwrap();
        std::fs::File::options().write(true).open(&tmp).unwrap().set_modified(t).unwrap();
        std::mem::forget(begin_in(&j, &plan).unwrap());
        std::fs::remove_file(&tmp).unwrap();
        assert!(recover_in(&j).is_empty());
        assert_eq!(std::fs::read(&orig).unwrap(), b"original", "a restored original is not taken for the update");
        assert!(!tmp.exists());
        std::fs::write(&tmp, b"update").unwrap();
        // cut short before anything moved: nothing changes
        std::mem::forget(begin_in(&j, &plan).unwrap());
        assert!(recover_in(&j).is_empty());
        assert_eq!(std::fs::read(&orig).unwrap(), b"original");
        assert_eq!(std::fs::read(&tmp).unwrap(), b"update");
    }
}
