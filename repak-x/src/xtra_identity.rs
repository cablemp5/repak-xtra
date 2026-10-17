//! repakxtra: its own app identifier (tauri.conf.json, com.cablemp5.repakxtra; Repak X keeps com.xzantgaming.repakx),
//! so the two can both be open: Tauri's one-copy-at-a-time lock is per identifier, and with a shared one, opening Repak X
//! while repakxtra ran only brought repakxtra to the front. What the two share stays safe:
//! - Browser storage: WebView2 keeps each identifier's in %LOCALAPPDATA%\<identifier>\EBWebView, so the first start
//!   under the new one copies the saved settings, loadouts (Local Storage) and loadout pictures (IndexedDB) over from the
//!   old folder before the window opens: staged, then moved into place whole, and only while nothing has the old folder
//!   open (a copy of a live database could come out torn).
//! - The mods folder: while Repak X is open, repakxtra changes no mods (upstream_guard), so the two never write the same
//!   files at once.
//! - repakx:// links: repakxtra does not take them from an open Repak X, and takes them back once it closes.
//! - Settings: repakxtra keeps its own repakxtra-state.json (main_tauri.rs save_state), first copied from state.json.

use std::path::Path;

pub const IDENTIFIER: &str = "com.cablemp5.repakxtra";
const OLD: &str = "com.xzantgaming.repakx";
const PARTS: [&str; 2] = ["Local Storage", "IndexedDB"];
const DONE: &str = "repakxtra-carried-over";

#[cfg(windows)]
mod sys {
    #[link(name = "kernel32")]
    extern "system" {
        pub fn OpenMutexW(access: u32, inherit: i32, name: *const u16) -> isize;
        pub fn CloseHandle(handle: isize) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        pub fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }
    pub fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

/// Whether Repak X is open: its single-instance plugin holds the mutex "<identifier>-sim" while it runs.
pub fn upstream_running() -> bool {
    #[cfg(windows)]
    unsafe {
        const SYNCHRONIZE: u32 = 0x0010_0000;
        let h = sys::OpenMutexW(SYNCHRONIZE, 0, sys::wide(&format!("{OLD}-sim")).as_ptr());
        if h != 0 {
            sys::CloseHandle(h);
            return true;
        }
    }
    false
}

/// Refuses a change to the mods folder while Repak X is open.
pub fn upstream_guard() -> Result<(), String> {
    if upstream_running() {
        return Err("Repak X is open too. Close it to change mods in repakxtra: both apps change the same files.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn xtra_upstream_running() -> bool {
    upstream_running()
}

/// Points repakx:// links back at repakxtra once Repak X has closed (it takes them over when it starts).
#[tauri::command]
pub fn xtra_protocol_reclaim() -> Result<(), String> {
    if upstream_running() {
        return Ok(());
    }
    crate::register_protocol_handler().map_err(|e| e.to_string())
}

/// What carrying the old storage over says when it cannot finish now. Yes: start without it this time; No: quit.
/// Either way the next start tries again.
#[cfg(windows)]
fn ask_continue(text: &str) -> bool {
    const MB_YESNO: u32 = 0x4;
    const MB_ICONWARNING: u32 = 0x30;
    const IDYES: i32 = 6;
    unsafe { sys::MessageBoxW(0, sys::wide(text).as_ptr(), sys::wide("repakxtra").as_ptr(), MB_YESNO | MB_ICONWARNING) == IDYES }
}

/// Once, before the window opens: the old identifier's Local Storage and IndexedDB into the new profile.
pub fn carry_over_webview_storage() {
    let Some(local) = dirs::data_local_dir() else { return };
    let (old_root, new_root) = (local.join(OLD), local.join(IDENTIFIER));
    let marker = new_root.join(DONE);
    if marker.exists() {
        return;
    }
    let old = old_root.join(r"EBWebView\Default");
    let mut finish = || {
        let _ = std::fs::create_dir_all(&new_root);
        let _ = std::fs::write(&marker, b"");
    };
    if !old.exists() {
        return finish(); // nothing to bring: a new user
    }
    #[cfg(windows)]
    if in_use(&old) {
        if !ask_continue("Repak X (or an older repakxtra) is open. Close it, then open repakxtra again: this first start \
                          brings your loadouts, settings and loadout pictures over from it.\n\nStart now without them? \
                          They come over at a later start, once it is closed.") {
            std::process::exit(0);
        }
        return; // no marker: the next start tries again
    }
    match carry_over(&old, &new_root.join(r"EBWebView\Default")) {
        Ok(n) => {
            log::info!("repakxtra: carried {n} browser storage files over from {}", old.display());
            finish()
        }
        Err(e) => {
            // No marker either: a copy that failed (a file held for a moment) is tried again at the next start
            log::warn!("repakxtra: browser storage not carried over: {e}");
            #[cfg(windows)]
            if !ask_continue(&format!("repakxtra could not bring your loadouts and settings over from Repak X's folder:\n{e}\n\nStart now without them? It tries again at the next start.")) {
                std::process::exit(0);
            }
        }
    }
}

/// The old browser still has its storage open: Chromium holds Local Storage's LOCK file exclusively while it runs.
#[cfg(windows)]
fn in_use(old: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    let lock = old.join(r"Local Storage\leveldb\LOCK");
    lock.exists() && std::fs::OpenOptions::new().read(true).write(true).share_mode(0).open(&lock).is_err()
}

/// Copies every part into a staging folder first (any failure stops it and removes the staging), then moves each part
/// into the new profile, replacing what a session that could not carry over made there. Returns the files copied.
fn carry_over(old: &Path, new: &Path) -> std::io::Result<usize> {
    let stage = new.with_extension("carry");
    let _ = std::fs::remove_dir_all(&stage);
    let copied = PARTS.iter().try_fold(0, |n, part| {
        let from = old.join(part);
        Ok::<_, std::io::Error>(n + if from.exists() { copy_dir(&from, &stage.join(part))? } else { 0 })
    });
    let copied = match copied {
        Ok(n) => n,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&stage);
            return Err(e);
        }
    };
    std::fs::create_dir_all(new)?;
    for part in PARTS {
        if stage.join(part).exists() {
            let _ = std::fs::remove_dir_all(new.join(part));
            std::fs::rename(stage.join(part), new.join(part))?;
        }
    }
    let _ = std::fs::remove_dir_all(&stage);
    Ok(copied)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<usize> {
    std::fs::create_dir_all(to)?;
    let mut n = 0;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let (src, dst) = (e.path(), to.join(e.file_name()));
        n += if src.is_dir() { copy_dir(&src, &dst)? } else { std::fs::copy(&src, &dst).map(|_| 1)? };
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_config_uses_this_identifier() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], IDENTIFIER);
    }

    #[test]
    fn storage_is_staged_then_moved_in_whole() {
        let dir = tempfile::tempdir().unwrap();
        let (old, new) = (dir.path().join("old"), dir.path().join("new"));
        std::fs::create_dir_all(old.join(r"Local Storage\leveldb")).unwrap();
        std::fs::create_dir_all(old.join("IndexedDB")).unwrap();
        std::fs::create_dir_all(old.join("Cache")).unwrap();
        std::fs::write(old.join(r"Local Storage\leveldb\000003.log"), "loadouts").unwrap();
        std::fs::write(old.join(r"IndexedDB\media.blob"), "picture").unwrap();
        std::fs::write(old.join(r"Cache\big"), "not needed").unwrap();
        // a session that could not carry over left a fresh, empty profile behind: replaced
        std::fs::create_dir_all(new.join("IndexedDB")).unwrap();
        std::fs::write(new.join(r"IndexedDB\fresh.blob"), "empty session").unwrap();
        assert_eq!(carry_over(&old, &new).unwrap(), 2);
        assert_eq!(std::fs::read_to_string(new.join(r"Local Storage\leveldb\000003.log")).unwrap(), "loadouts");
        assert!(new.join(r"IndexedDB\media.blob").exists() && !new.join(r"IndexedDB\fresh.blob").exists());
        assert!(!new.join("Cache").exists() && !new.with_extension("carry").exists());
    }

    #[test]
    fn a_failed_copy_leaves_the_new_profile_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let (old, new) = (dir.path().join("old"), dir.path().join("new"));
        std::fs::create_dir_all(old.join("IndexedDB")).unwrap();
        std::fs::write(old.join(r"IndexedDB\media.blob"), "picture").unwrap();
        // "Local Storage" is a file, not a folder: reading it as a folder fails
        std::fs::write(old.join("Local Storage"), "not a folder").unwrap();
        std::fs::create_dir_all(new.join("IndexedDB")).unwrap();
        std::fs::write(new.join(r"IndexedDB\kept.blob"), "kept").unwrap();
        assert!(carry_over(&old, &new).is_err());
        assert!(new.join(r"IndexedDB\kept.blob").exists() && !new.join(r"IndexedDB\media.blob").exists());
        assert!(!new.with_extension("carry").exists());
    }
}
