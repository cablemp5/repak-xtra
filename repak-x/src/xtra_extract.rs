//! repakxtra: the native asset tool (X-zant's UAssetToolRivals, left unchanged) joins each archive path to the output
//! folder as it is, so a mod listing "../../x" could write outside it. Every unpack and install conversion here lists
//! the archive first and refuses it when any path would leave the folder (a ".." part, a drive, a stream colon, a
//! reserved Windows name) or would go through a folder link already in the output folder.

use std::path::Path;

/// Whether one archive path stays inside the output folder (PAK entries are relative to the mount point, IoStore
/// paths start with "/Game/" or a mount; a leading "/" is fine, a ".." part anywhere is not).
pub fn safe_entry(path: &str) -> bool {
    const RESERVED: [&str; 22] = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
        "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    let p = path.replace('\\', "/");
    let rel = p.trim_start_matches('/');
    !rel.is_empty()
        && rel.split('/').all(|seg| {
            let stem = seg.split('.').next().unwrap_or("").to_ascii_lowercase();
            !seg.is_empty()
                && seg != "."
                && seg != ".."
                && !seg.ends_with('.')
                && !seg.ends_with(' ')
                && !seg.chars().any(|c| c.is_control() || ":*?\"<>|".contains(c))
                && !RESERVED.contains(&stem.as_str())
        })
}

/// The first path that is not safe, as an error a person can act on.
fn check(entries: impl IntoIterator<Item = String>, archive: &str, out: Option<&Path>) -> Result<(), String> {
    for e in entries {
        if !safe_entry(&e) {
            return Err(format!(
                "{} lists a file outside its own folders ({e}), so it was not unpacked. Only use this mod if you trust where it came from.",
                Path::new(archive).file_name().map_or(archive.into(), |n| n.to_string_lossy())
            ));
        }
        if let Some(out) = out {
            through_link(out, &e)?;
        }
    }
    Ok(())
}

/// A folder (or the file) that already exists under `out` on the way to `entry` must not be a link (junction or
/// symlink), which could point anywhere.
fn through_link(out: &Path, entry: &str) -> Result<(), String> {
    let mut at = out.to_path_buf();
    for seg in entry.replace('\\', "/").trim_start_matches('/').split('/') {
        at.push(seg);
        match std::fs::symlink_metadata(&at) {
            Ok(m) if is_link(&m) => return Err(format!("{} is a link, so nothing was unpacked through it", at.display())),
            Ok(_) => {}
            Err(_) => return Ok(()), // nothing deeper exists yet
        }
    }
    Ok(())
}

fn is_link(m: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        m.file_type().is_symlink() || m.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    {
        m.file_type().is_symlink()
    }
}

/// Refuses a PAK whose file list would leave any output folder (for conversions that unpack inside the tool).
pub fn check_pak(file_path: &str, aes_key: Option<&str>) -> Result<(), String> {
    let files = uasset_toolkit::list_pak_files(file_path, aes_key).map_err(|e| format!("Could not read {file_path}: {e}"))?;
    check(files, file_path, None)
}

/// uasset_toolkit::extract_pak_all after checking every path the PAK lists.
pub fn extract_pak_all(file_path: &str, output_path: &str, aes_key: Option<&str>) -> Result<usize, String> {
    let files = uasset_toolkit::list_pak_files(file_path, aes_key).map_err(|e| e.to_string())?;
    check(files, file_path, Some(Path::new(output_path)))?;
    uasset_toolkit::extract_pak_all(file_path, output_path, aes_key).map_err(|e| e.to_string())
}

/// uasset_toolkit::extract_iostore after checking every package path the .utoc lists.
pub fn extract_iostore(file_path: &str, output_path: &str, aes_key: Option<&str>) -> Result<usize, String> {
    let files = crate::utoc_utils::read_utoc(Path::new(file_path)).into_iter().map(|e| e.file_path);
    check(files, file_path, Some(Path::new(output_path)))?;
    uasset_toolkit::extract_iostore(file_path, output_path, aes_key).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_paths_inside_the_folder_pass() {
        for ok in ["Marvel/Content/Marvel/X.uasset", "/Game/Marvel/X.uasset", "a\\b\\c.uexp", "Engine/Content/x.v2.uasset"] {
            assert!(safe_entry(ok), "refused {ok}");
        }
        for bad in ["../outside.txt", "Marvel/../../x", "..\\x", "C:/x", "a/C:x", "a/b.txt:stream", "a/CON.txt", "a/nul", "a/b./c", "a/b /c", "a//b", "", "/", "a/./b"] {
            assert!(!safe_entry(bad), "accepted {bad:?}");
        }
    }

    #[test]
    fn a_link_in_the_output_folder_is_refused() {
        let d = std::env::temp_dir().join(format!("repakxtra-extract-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("out").join("Marvel")).unwrap();
        std::fs::create_dir_all(d.join("elsewhere")).unwrap();
        assert!(check(["Marvel/Content/X.uasset".to_string()], "m.pak", Some(&d.join("out"))).is_ok());
        #[cfg(windows)]
        {
            let made = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(d.join("out").join("Link"))
                .arg(d.join("elsewhere"))
                .output()
                .unwrap();
            assert!(made.status.success());
            assert!(check(["Link/x.uasset".to_string()], "m.pak", Some(&d.join("out"))).is_err());
        }
        assert!(check(["../x".to_string()], "m.pak", Some(&d.join("out"))).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// REPAKXTRA_MODS=<mods folder> cargo test -p repak-x --bin REPAK-X real_library -- --ignored --nocapture
    /// (read-only: lists every mod, never unpacks; needs UAssetTool.dll beside the test exe)
    #[test]
    #[ignore]
    fn a_real_library_has_no_refused_mods() {
        let root = std::env::var("REPAKXTRA_MODS").expect("set REPAKXTRA_MODS");
        let (mut paks, mut utocs, mut refused) = (0, 0, Vec::new());
        for e in walkdir::WalkDir::new(&root).into_iter().flatten().filter(|e| e.file_type().is_file()) {
            let p = e.path().to_string_lossy().to_string();
            let lower = p.to_lowercase();
            let r = if lower.ends_with(".utoc") {
                utocs += 1;
                let files = crate::utoc_utils::read_utoc(e.path()).into_iter().map(|x| x.file_path);
                check(files, &p, None)
            } else if lower.ends_with(".pak") || lower.ends_with(".bak_repak") {
                paks += 1;
                check_pak(&p, Some(crate::install_mod::AES_KEY_HEX))
            } else {
                continue;
            };
            if let Err(err) = r {
                refused.push(format!("{p}: {err}"));
            }
        }
        println!("{paks} paks, {utocs} utocs checked, {} refused", refused.len());
        for r in &refused {
            println!("  {r}");
        }
        assert!(refused.is_empty());
    }

    /// A made-up V11 PAK (uncompressed, unencrypted, mount ../../../) holding b"fixture" under each name.
    fn fixture_pak(path: &Path, name: &str) {
        let sha = |_: &[u8]| vec![0u8; 20]; // the tool does not check these hashes
        let u32b = |n: u32| n.to_le_bytes().to_vec();
        let u64b = |n: u64| n.to_le_bytes().to_vec();
        let string = |s: &str| [u32b(s.len() as u32 + 1), s.as_bytes().to_vec(), vec![0]].concat();
        let payload = b"fixture";
        let header = [u64b(0), u64b(7), u64b(7), u32b(0), sha(payload), vec![0], u32b(0)].concat();
        let data = [header, payload.to_vec()].concat();
        let (dir, leaf) = name.rsplit_once('/').map_or(("".to_string(), name), |(d, l)| (format!("{d}/"), l));
        let fdi = [u32b(1), string(&dir), u32b(1), string(leaf), u32b(0)].concat();
        let encoded = [u32b(0xc000_0000), u32b(0), u32b(7)].concat();
        let index = [string("../../../"), u32b(1), u64b(0), u32b(0), u32b(1), u64b(data.len() as u64), u64b(fdi.len() as u64),
            sha(&fdi), u32b(encoded.len() as u32), encoded, u32b(0)].concat();
        let footer = [vec![0u8; 17], u32b(0x5a6f_12e1), u32b(11), u64b((data.len() + fdi.len()) as u64), u64b(index.len() as u64),
            sha(&index), vec![0u8; 160]].concat();
        std::fs::write(path, [data, fdi, index, footer].concat()).unwrap();
    }

    /// cargo test -p repak-x --bin REPAK-X traversal_pak -- --ignored (needs UAssetTool.dll beside the test exe)
    #[test]
    #[ignore]
    fn a_traversal_pak_writes_nothing_outside() {
        let d = std::env::temp_dir().join(format!("repakxtra-traversal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("out")).unwrap();
        std::fs::write(d.join("outside.txt"), b"sentinel").unwrap();
        let pak = d.join("evil.pak");
        let (pak_s, out_s) = (pak.to_string_lossy().to_string(), d.join("out").to_string_lossy().to_string());
        fixture_pak(&pak, "../outside.txt");
        assert!(extract_pak_all(&pak_s, &out_s, None).is_err(), "refused");
        assert_eq!(std::fs::read(d.join("outside.txt")).unwrap(), b"sentinel", "the file outside is untouched");
        assert!(check_pak(&pak_s, None).is_err(), "install conversions refuse it too");
        fixture_pak(&pak, "Marvel/Content/A.uasset");
        assert_eq!(extract_pak_all(&pak_s, &out_s, None), Ok(1), "a normal PAK still unpacks");
        assert_eq!(std::fs::read(d.join("out/Marvel/Content/A.uasset")).unwrap(), b"fixture");
        let _ = std::fs::remove_dir_all(&d);
    }
}
