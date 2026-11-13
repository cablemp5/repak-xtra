//! repakxtra: Season 11's file check reads every mod container's file list, reports an encrypted one (it cannot read
//! it), and Project Galacta skips it. The Mod Updater decrypts such a mod (`decrypt_iostore`, uassettool-patches 0020:
//! the same chunks, the file list in plain text), staged beside it, verified with no key, then swapped in with the old
//! .utoc and .ucas going to Recently deleted (journaled, xtra_journal.rs). Its .pak is left as it is. With Keep mods
//! encrypted on (the Mod Updater's Advanced), an update of an encrypted mod is encrypted again before it goes in.
use std::path::{Path, PathBuf};

use crate::xtra_bundle::companion;

/// Whether the container at `utoc` is encrypted: its header's Encrypted flag (the game's check fails on these).
pub(crate) fn encrypted(utoc: &Path) -> bool {
    let mut head = [0u8; 81];
    std::fs::File::open(utoc).and_then(|mut f| std::io::Read::read_exact(&mut f, &mut head)).is_ok() && head.starts_with(b"-==--==--==--==-") && head[80] & 2 != 0
}

/// One UAssetTool request (`decrypt_iostore` or `encrypt_iostore`): it writes `from` into `to`, then reads it back and
/// compares every chunk, so a success means the payloads are unchanged.
fn tool(action: &str, from: &Path, to: &Path) -> Result<(), String> {
    let mut request = serde_json::json!({ "action": action, "file_path": from, "output_path": to });
    if action == "decrypt_iostore" {
        request["aes_key"] = crate::install_mod::AES_KEY_HEX.into();
    }
    let answer = uasset_toolkit::invoke_json(&request.to_string()).map_err(|e| e.to_string())?;
    let answer: serde_json::Value = serde_json::from_str(&answer).map_err(|e| e.to_string())?;
    if answer["success"] != true {
        return Err(answer["message"].as_str().unwrap_or("The tool could not do it").into());
    }
    Ok(())
}

/// Decrypts the mod at `mod_path` (its .pak, .bak_repak or .utoc) in place. Its file time stays (an install's, so the
/// date checks still know when it was made). Returns its .utoc.
fn decrypt(mod_path: &Path) -> Result<PathBuf, String> {
    crate::xtra_identity::upstream_guard()?;
    let (toc, cas) = (companion(mod_path, "utoc"), companion(mod_path, "ucas"));
    if !toc.is_file() || !cas.is_file() {
        return Err("This mod has no .utoc and .ucas to decrypt.".into());
    }
    if !encrypted(&toc) {
        return Ok(toc);
    }
    if crate::is_game_process_running() {
        return Err("Close Marvel Rivals before updating mods.".into());
    }
    let _mutation = crate::xtra_mutation::edit()?;
    let parent = toc.parent().ok_or("The mod has no folder")?;
    // a staging folder the start-up sweep removes if this is cut short (xtra_bundle::sweep_staging)
    let work = tempfile::Builder::new().prefix(".repakxtra-encrypt-").tempdir_in(parent).map_err(|e| e.to_string())?;
    let out = work.path().join(toc.file_name().ok_or("Invalid mod filename")?);
    tool("decrypt_iostore", &toc, &out)?;
    let out_cas = companion(&out, "ucas");
    if !out_cas.is_file() || encrypted(&out) {
        return Err("The decrypted copy is incomplete. The mod was not changed.".into());
    }
    crate::xtra_made::stamp(&[&out, &out_cas], crate::xtra_made::made_at(&toc));
    if crate::is_game_process_running() {
        return Err("Marvel Rivals started while the mod was decrypted. The mod was not changed.".into());
    }
    crate::xtra_bundle::replace_all(&[(out, toc.clone()), (out_cas, cas)])?;
    Ok(toc)
}

/// pipeline.ts: whether the mod at `mod_path` is an encrypted container.
#[tauri::command]
pub fn xtra_mod_encrypted(mod_path: String) -> bool {
    encrypted(&companion(Path::new(&mod_path), "utoc"))
}

/// pipeline.ts: decrypts the mod at `mod_path` in place (a decrypt-only update). Returns its .utoc.
#[tauri::command]
pub async fn xtra_decrypt_mod(mod_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || decrypt(Path::new(&mod_path)).map(|p| p.to_string_lossy().into_owned())).await.map_err(|e| e.to_string())?
}

/// pipeline.ts, Keep mods encrypted: the packed update at `utoc` (in the run's own folder, not the mods folder)
/// encrypted again before it goes in, replacing the plain copy there.
#[tauri::command]
pub async fn xtra_encrypt_staged(utoc: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let toc = PathBuf::from(utoc);
        let dir = tempfile::Builder::new().prefix("encrypt-").tempdir_in(toc.parent().ok_or("No folder")?).map_err(|e| e.to_string())?;
        let out = dir.path().join(toc.file_name().ok_or("No file name")?);
        tool("encrypt_iostore", &toc, &out)?;
        for x in ["utoc", "ucas"] {
            std::fs::rename(companion(&out, x), companion(&toc, x)).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_header_flag_says_encrypted() {
        let d = tempfile::tempdir().unwrap();
        let toc = |flags: u8| {
            let mut b = b"-==--==--==--==-".to_vec();
            b.resize(144, 0);
            b[80] = flags;
            let p = d.path().join(format!("{flags}.utoc"));
            std::fs::write(&p, b).unwrap();
            p
        };
        assert!(encrypted(&toc(11)) && encrypted(&toc(10)), "Compressed, Encrypted, Indexed and the obfuscated kind without Indexed");
        assert!(!encrypted(&toc(9)), "Compressed and Indexed");
        std::fs::write(d.path().join("short.utoc"), b"-==-").unwrap();
        assert!(!encrypted(&d.path().join("short.utoc")) && !encrypted(&d.path().join("missing.utoc")));
    }
}
