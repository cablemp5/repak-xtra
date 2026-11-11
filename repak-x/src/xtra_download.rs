//! repakxtra: the file a `repakx://install?file=` link names comes from a web page, so it is checked before the disk is
//! touched: a mod file or archive, in this user's Downloads folder or a folder a browser on this PC is set to save to
//! (read from the browser's own settings, which a web page cannot change), never a network path.
//! `delete_source_archive` uses the same check, so the delete after install can only reach such a file.

use std::path::{Component, Path, PathBuf, Prefix};

/// What the extension flow handles (and may delete afterwards).
pub const EXTENSIONS: [&str; 6] = ["zip", "rar", "7z", "pak", "utoc", "ucas"];

/// `raw` as a path the extension flow may open and delete, or the reason it may not.
pub fn checked(raw: &str) -> Result<PathBuf, String> {
    let mut roots: Vec<PathBuf> = dirs::download_dir().into_iter().collect();
    if let (Some(local), Some(roaming)) = (dirs::data_local_dir(), dirs::data_dir()) {
        roots.extend(browser_folders(&local, &roaming));
    }
    checked_in(raw, &roots)
}

/// The download folders the common browsers are set to: Chromium ones (Chrome, Edge, Brave, Vivaldi, Opera, Chromium)
/// in each profile's Preferences, Firefox ones (Firefox, Zen, LibreWolf, Waterfox, Floorp) in each profile's prefs.js.
/// A drive root is left out: it would let a link reach every file on that drive.
fn browser_folders(local: &Path, roaming: &Path) -> Vec<PathBuf> {
    let subdirs = |root: PathBuf| -> Vec<PathBuf> {
        std::fs::read_dir(root).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()
    };
    let chromium = [r"Google\Chrome\User Data", r"Google\Chrome Beta\User Data", r"Microsoft\Edge\User Data", r"BraveSoftware\Brave-Browser\User Data", r"Vivaldi\User Data", r"Chromium\User Data"];
    let profiles = chromium.iter().flat_map(|r| subdirs(local.join(r))).chain(subdirs(roaming.join("Opera Software")));
    let mut found = Vec::new();
    for profile in profiles {
        for prefs in [profile.join("Preferences"), profile.join("Default").join("Preferences")] {
            let Ok(text) = std::fs::read_to_string(&prefs) else { continue };
            let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            found.extend(["download", "savefile"].iter().filter_map(|k| v[k]["default_directory"].as_str()).map(PathBuf::from));
        }
    }
    let gecko = [r"Mozilla\Firefox\Profiles", r"zen\Profiles", r"librewolf\Profiles", r"Waterfox\Profiles", r"Floorp\Profiles"];
    for profile in gecko.iter().flat_map(|r| subdirs(roaming.join(r))) {
        let text = std::fs::read_to_string(profile.join("prefs.js")).unwrap_or_default();
        found.extend(text.lines().filter_map(firefox_download_dir));
    }
    found.retain(|p| p.is_absolute() && p.parent().is_some());
    found
}

/// `user_pref("browser.download.dir", "C:\\Mods");` gives C:\Mods.
fn firefox_download_dir(line: &str) -> Option<PathBuf> {
    let rest = line.trim().strip_prefix(r#"user_pref("browser.download.dir", ""#)?.strip_suffix(r#"");"#)?;
    Some(PathBuf::from(rest.replace(r"\\", r"\")))
}

fn checked_in(raw: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let refuse = || format!("Only a mod file or archive in your Downloads folder, or the folder your browser saves to, can come from a link: {raw}");
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
        || !roots.iter().any(|r| low(p).starts_with(low(r)))
    {
        return Err(refuse());
    }
    // a junction inside the folder could still lead elsewhere: the real paths must agree too
    let real = p.canonicalize().map_err(|_| format!("File not found: {raw}"))?;
    if !real.is_file() || !roots.iter().filter_map(|r| r.canonicalize().ok()).any(|r| real.starts_with(r)) {
        return Err(refuse());
    }
    Ok(p.to_path_buf())
}

/// Sends `path` to the Recycle Bin (never deleted for good: a drive without one asks first).
#[cfg(windows)]
pub fn recycle(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[repr(C)]
    struct FileOp {
        hwnd: isize,
        func: u32,
        from: *const u16,
        to: *const u16,
        flags: u16,
        aborted: i32,
        mappings: *mut std::ffi::c_void,
        title: *const u16,
    }
    #[link(name = "shell32")]
    extern "system" {
        fn SHFileOperationW(op: *mut FileOp) -> i32;
    }
    let from: Vec<u16> = path.as_os_str().encode_wide().chain([0, 0]).collect(); // a double-null-ended list
    let mut op = FileOp {
        hwnd: 0,
        func: 3, // FO_DELETE
        from: from.as_ptr(),
        to: std::ptr::null(),
        flags: 0x40 | 0x10 | 0x4 | 0x400 | 0x4000, // ALLOWUNDO, NOCONFIRMATION, SILENT, NOERRORUI, WANTNUKEWARNING
        aborted: 0,
        mappings: std::ptr::null_mut(),
        title: std::ptr::null(),
    };
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 || op.aborted != 0 || path.exists() {
        return Err(format!("Could not move {} to the Recycle Bin (code {code})", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    #[ignore = "puts a small file in this PC's Recycle Bin: run by hand with --ignored"]
    fn recycle_moves_the_file_away() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("repakxtra-recycle-test.zip");
        std::fs::write(&f, b"x").unwrap();
        super::recycle(&f).unwrap();
        assert!(!f.exists());
    }

    use super::*;

    #[test]
    fn only_a_mod_file_inside_downloads_passes() {
        let d = tempfile::tempdir().unwrap();
        let dl = d.path().join("Downloads");
        let roots = vec![dl.clone()];
        std::fs::create_dir_all(dl.join("sub")).unwrap();
        std::fs::create_dir_all(d.path().join("Paks")).unwrap();
        for f in [dl.join("Mod.ZIP"), dl.join("sub").join("a.pak"), dl.join("notes.txt"), d.path().join("Paks").join("game.pak")] {
            std::fs::write(f, b"x").unwrap();
        }
        let s = |p: PathBuf| p.to_string_lossy().into_owned();
        assert!(checked_in(&s(dl.join("Mod.ZIP")), &roots).is_ok());
        assert!(checked_in(&s(dl.join("sub").join("a.pak")), &roots).is_ok());
        assert!(checked_in(&s(dl.join("notes.txt")), &roots).is_err());
        assert!(checked_in(&s(d.path().join("Paks").join("game.pak")), &roots).is_err());
        assert!(checked_in(&s(dl.join("..").join("Paks").join("game.pak")), &roots).is_err());
        assert!(checked_in(&s(dl.join("missing.zip")), &roots).is_err());
        assert!(checked_in(&s(dl.clone()), &roots).is_err());
        for raw in [r"\\attacker\share\x.zip", r"\\?\C:\x.zip", "//attacker/share/x.zip", r"C:\", "x.zip", r"\x.zip"] {
            assert!(checked_in(raw, &roots).is_err(), "{raw}");
        }
        // a Downloads named like a prefix of another folder does not cover it
        std::fs::create_dir_all(d.path().join("Downloads2")).unwrap();
        std::fs::write(d.path().join("Downloads2").join("b.zip"), b"x").unwrap();
        assert!(checked_in(&s(d.path().join("Downloads2").join("b.zip")), &roots).is_err());
    }

    #[test]
    fn browser_download_folders_are_read_from_each_browsers_settings() {
        let d = tempfile::tempdir().unwrap();
        let (local, roaming) = (d.path().join("Local"), d.path().join("Roaming"));
        let (chrome_dir, opera_dir, fox_dir) = (d.path().join("chrome dl"), d.path().join("opera dl"), d.path().join("fox dl"));
        let write = |p: PathBuf, text: String| {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        let json = |dir: &Path| serde_json::json!({ "download": { "default_directory": dir } }).to_string();
        write(local.join(r"Google\Chrome\User Data\Profile 1\Preferences"), json(&chrome_dir));
        write(local.join(r"Microsoft\Edge\User Data\Default\Preferences"), json(Path::new(r"C:\")));
        write(roaming.join(r"Opera Software\Opera GX Stable\Preferences"), json(&opera_dir));
        let fox = fox_dir.to_string_lossy().replace('\\', r"\\");
        write(roaming.join(r"Mozilla\Firefox\Profiles\abc.default\prefs.js"), format!("user_pref(\"browser.download.dir\", \"{fox}\");\nuser_pref(\"other\", 1);\n"));
        let mut found = browser_folders(&local, &roaming);
        found.sort();
        let mut want = vec![chrome_dir.clone(), opera_dir, fox_dir];
        want.sort();
        assert_eq!(found, want, "the drive root Edge points at is left out");

        std::fs::create_dir_all(&chrome_dir).unwrap();
        std::fs::write(chrome_dir.join("Mod.zip"), b"x").unwrap();
        assert!(checked_in(&chrome_dir.join("Mod.zip").to_string_lossy(), &found).is_ok());
    }
}
