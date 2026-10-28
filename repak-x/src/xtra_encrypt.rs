//! Encrypt in staging, verify, then replace a complete bundle; keep disabled originals outside the library.
use std::{collections::HashSet, fs, path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use crate::xtra_bundle::{companion, stem};

static RUNNING: AtomicBool = AtomicBool::new(false);
struct Hold;
impl Drop for Hold { fn drop(&mut self) { RUNNING.store(false, Ordering::SeqCst); } }

#[derive(Serialize)]
pub struct Encrypted { path: String, backup: String }

fn digest(path: &Path) -> Result<[u8; 32], String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hash.update(&buffer[..n]);
    }
    Ok(hash.finalize().into())
}

type Snapshot = Vec<(PathBuf, [u8; 32])>;
fn snapshot(source: &Path) -> Result<Snapshot, String> {
    if !source.is_file() { return Err("The mod moved or was toggled during encryption. Nothing was replaced.".into()); }
    let mut paths = ["pak", "bak_repak", "pak.bak_repak", "pak_disabled", "utoc", "ucas"].iter()
        .map(|ext| companion(source, ext)).filter(|p| p.is_file())
        .chain(std::iter::once(source.to_path_buf()))
        .map(|p| fs::canonicalize(p).map_err(|e| e.to_string())).collect::<Result<Vec<_>, _>>()?;
    paths.sort();
    paths.dedup();
    paths.into_iter().map(|p| digest(&p).map(|hash| (p, hash))).collect()
}

fn verify_backup(before: &Snapshot, original: &Path, backup: &Path) -> Result<(), String> {
    let identity = fs::canonicalize(original).map_err(|e| e.to_string())?;
    if before.iter().find(|(p, _)| p == &identity).map(|(_, hash)| *hash) != Some(digest(backup)?) {
        return Err("The mod changed while it was being backed up. Nothing was replaced.".into());
    }
    Ok(())
}

fn unchanged(source: &Path, before: &Snapshot) -> Result<(), String> {
    if snapshot(source)? != *before { return Err("The mod changed during encryption. Nothing was replaced; try again.".into()); }
    Ok(())
}

fn primary(path: &Path) -> Result<PathBuf, String> {
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or_default().to_ascii_lowercase();
    if !["pak", "bak_repak", "pak_disabled", "utoc", "ucas"].contains(&ext.as_str()) {
        return Err("Choose a .pak or IoStore mod file.".into());
    }
    let variants: Vec<_> = ["pak", "bak_repak", "pak.bak_repak", "pak_disabled"].iter().map(|x| companion(path, x)).filter(|p| p.is_file()).collect();
    if variants.len() > 1 { return Err("Both enabled and disabled copies share this bundle. Keep one copy before encrypting.".into()); }
    if ["pak", "bak_repak", "pak_disabled"].contains(&ext.as_str()) { return Ok(path.to_path_buf()); }
    variants.into_iter().next()
        .ok_or_else(|| "The IoStore companion PAK is missing. Select a complete mod bundle.".into())
}

/// One UAssetTool encryption (`encrypt_iostore` or `encrypt_pak`): it rewrites `from` encrypted into `to`, then reads it
/// back and compares every entry, so a success means the payloads are unchanged.
fn tool(action: &str, from: &Path, to: &Path) -> Result<(), String> {
    let request = serde_json::json!({ "action": action, "file_path": from, "output_path": to });
    let answer = uasset_toolkit::invoke_json(&request.to_string()).map_err(|e| e.to_string())?;
    let answer: serde_json::Value = serde_json::from_str(&answer).map_err(|e| e.to_string())?;
    if answer["success"] != true { return Err(answer["message"].as_str().unwrap_or("Encryption failed").into()); }
    Ok(())
}

/// Encrypts a fresh build outside the library (`base` + .pak, .utoc and .ucas, as xtra_builtins makes them) in place:
/// CustomQuake after every build. All three are written beside it first, so a failure leaves the build as it was.
pub fn encrypt_built(base: &Path) -> Result<(), String> {
    let name = base.file_name().ok_or("The build has no file name")?;
    let work = tempfile::Builder::new().prefix(".repakxtra-encrypt-").tempdir_in(base.parent().ok_or("The build has no folder")?).map_err(|e| e.to_string())?;
    let out = work.path().join(name);
    tool("encrypt_iostore", &base.with_extension("utoc"), &out.with_extension("utoc"))?;
    tool("encrypt_pak", &base.with_extension("pak"), &out.with_extension("pak"))?;
    let exts = ["ucas", "utoc", "pak"];
    if let Some(x) = exts.iter().find(|x| !out.with_extension(x).is_file()) { return Err(format!("Encryption made no .{x}")); }
    // shortcut: a rename failing after the first leaves a mixed set in the temp build, which the caller then drops (it
    // fails the build), so nothing mixed reaches the game
    for x in exts { fs::rename(out.with_extension(x), base.with_extension(x)).map_err(|e| e.to_string())?; }
    Ok(())
}

fn encrypt(path: &Path) -> Result<Encrypted, String> {
    crate::xtra_identity::upstream_guard()?;
    if crate::is_game_process_running() { return Err("Close Marvel Rivals before encrypting mods.".into()); }
    let source = fs::canonicalize(primary(path)?).map_err(|e| e.to_string())?;
    if source.components().any(|c| c.as_os_str().to_string_lossy().starts_with(".repakxtra-")) {
        return Err("Built-in or staged mods cannot be encrypted.".into());
    }
    let parent = source.parent().ok_or("The mod has no parent folder")?;
    let filename = source.file_name().and_then(|n| n.to_str()).ok_or("Invalid mod filename")?;
    let name = stem(filename);
    let toc = companion(&source, "utoc");
    let cas = companion(&source, "ucas");
    if toc.exists() != cas.exists() { return Err("This IoStore bundle is incomplete; both .utoc and .ucas are required.".into()); }
    let before = snapshot(&source)?;
    let work = tempfile::Builder::new().prefix(".repakxtra-encrypt-").tempdir_in(parent).map_err(|e| e.to_string())?;
    let output = work.path().join(format!("{name}.bak_repak")); // never mountable, even if the app crashes
    if toc.is_file() { tool("encrypt_iostore", &toc, &companion(&output, "utoc"))?; }
    // Repack the PAK separately, including loose hybrid files; never drop its entries.
    tool("encrypt_pak", &source, &output)?;
    let mut moves = vec![(output, source.clone())];
    if toc.is_file() {
        for x in ["utoc", "ucas"] {
            let staged = work.path().join(format!("{name}.{x}"));
            if !staged.is_file() { return Err(format!("Missing encrypted .{x}; originals were kept.")); }
            moves.push((staged, companion(&source, x)));
        }
    }
    let backup = crate::app_dir().join("encryption-backups").join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&backup).map_err(|e| e.to_string())?;
    for (_, old) in &moves {
        let to = if old == &source { backup.join(format!("{name}.bak_repak")) } else { backup.join(old.file_name().ok_or("Invalid companion filename")?) };
        fs::copy(old, &to).map_err(|e| format!("Backup failed; originals were kept: {e}"))?;
        verify_backup(&before, old, &to)?;
    }
    fs::write(backup.join("original.json"), serde_json::json!({"path": source, "enabled": filename.to_ascii_lowercase().ends_with(".pak")}).to_string()).map_err(|e| e.to_string())?;
    if crate::is_game_process_running() { return Err("Marvel Rivals started during encryption; originals were kept.".into()); }
    crate::xtra_identity::upstream_guard()?;
    crate::xtra_made::stamp(&moves.iter().map(|(s, _)| s.as_path()).collect::<Vec<_>>(), crate::xtra_made::made_at(&source));
    unchanged(&source, &before)?;
    crate::xtra_bundle::replace_all(&moves)?;
    Ok(Encrypted { path: source.to_string_lossy().into_owned(), backup: backup.to_string_lossy().into_owned() })
}

/// One mod for the Encrypt window's list (EncryptWindow.tsx).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed { path: String, custom_name: Option<String>, enabled: bool, hero: Option<String>, modified: u64, encrypted: bool }

/// The Library's mods with their heroes and whether each is encrypted, for the Encrypt window: the mod list leaves the hero
/// empty for most mods, so it comes from their details, as the VFX Updater's list does (cached after the Library's first look).
#[tauri::command]
pub async fn xtra_encrypt_list(window: tauri::Window, state: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::AppState>>>) -> Result<Vec<Listed>, String> {
    use tauri::Emitter;
    let mods = crate::get_pak_files(state.clone()).await?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let total = mods.len();
        mods.into_iter().enumerate().map(|(i, m)| {
            if i % 8 == 0 || i + 1 == total { let _ = window.emit("encrypt_list_progress", serde_json::json!({ "done": i + 1, "total": total })); }
            let named = |c: Option<String>| c.filter(|c| !c.is_empty());
            // the details also say whether it is encrypted (the PAK index or the .utoc header), for the window's two groups
            let details = crate::compute_mod_details(&m.path, &state).ok();
            let encrypted = details.as_ref().is_some_and(|d| d.is_encrypted);
            let hero = named(m.character_name.clone()).or_else(|| details.and_then(|d| named(Some(d.character_name))));
            Listed { path: m.path.to_string_lossy().into_owned(), custom_name: named(m.custom_name), enabled: m.enabled, hero, modified: m.modified_date, encrypted }
        }).collect()
    }).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn xtra_encrypt_mods(window: tauri::Window, paths: Vec<String>) -> Result<Vec<Result<Encrypted, String>>, String> {
    if paths.is_empty() { return Err("Select at least one mod.".into()); }
    if RUNNING.swap(true, Ordering::SeqCst) { return Err("Encryption is already running.".into()); }
    let hold = Hold;
    let token = uuid::Uuid::new_v4().to_string();
    if !crate::xtra_vfx::xtra_vfx_claim(window.clone(), token.clone(), Some("Encrypting mods".into())) { return Err("Wait for the VFX Updater before encrypting mods.".into()); }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _hold = hold;
        let _mutation = crate::xtra_mutation::encrypt()?;
        let mut seen = HashSet::new();
        Ok(paths.iter().filter_map(|p| {
            let id = primary(Path::new(p)).and_then(|p| fs::canonicalize(p).map_err(|e| e.to_string()));
            match id {
                Ok(id) if seen.insert(id.clone()) => Some(encrypt(&id)),
                Ok(_) => None,
                Err(e) => Some(Err(format!("{p}: {e}"))),
            }
        }).collect())
    }).await.map_err(|e| e.to_string()).and_then(|r| r);
    crate::xtra_vfx::xtra_vfx_release(window, token);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn uppercase_enabled_and_disabled_extensions_reach_backup_validation() {
        for ext in ["PAK", "BAK_REPAK"] {
            let d = tempfile::tempdir().unwrap();
            let source = d.path().join(format!("Skin.{ext}"));
            fs::write(&source, b"original").unwrap();
            let source = fs::canonicalize(primary(&source).unwrap()).unwrap();
            let before = snapshot(&source).unwrap();
            let backup = d.path().join("original.disabled");
            fs::copy(&source, &backup).unwrap();
            verify_backup(&before, &source, &backup).unwrap();
            unchanged(&source, &before).unwrap();
        }
    }
    #[test]
    fn disabled_and_dotted_companions_resolve_without_enabling() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("Skin.v2.bak_repak"), b"pak").unwrap();
        assert_eq!(primary(&d.path().join("Skin.v2.utoc")).unwrap(), d.path().join("Skin.v2.bak_repak"));
        assert!(primary(&d.path().join("unknown.utoc")).is_err());
        assert!(primary(&d.path().join("anything.exe")).is_err());
        fs::write(d.path().join("Skin.v2.pak"), b"another").unwrap();
        assert!(primary(&d.path().join("Skin.v2.bak_repak")).is_err(), "ambiguous bundles are not touched");
    }

    #[test]
    fn vfx_updated_bundles_resolve_on_and_off() {
        // the VFX Updater's names, and a turned-off update (the case repak-rivals' encrypter cannot find a .pak for)
        let d = tempfile::tempdir().unwrap();
        let name = "ElectricBluePantherDarkerShinierSuit_UPDATED_9999999_P";
        for x in ["utoc", "ucas"] { fs::write(d.path().join(format!("{name}.{x}")), b"c").unwrap(); }
        fs::write(d.path().join(format!("{name}.bak_repak")), b"pak").unwrap();
        let off = primary(&d.path().join(format!("{name}.utoc"))).unwrap();
        assert_eq!(off, d.path().join(format!("{name}.bak_repak")), "off: the .bak_repak is the bundle, nothing is turned on");
        assert_eq!(companion(&off, "utoc"), d.path().join(format!("{name}.utoc")));
        fs::rename(&off, d.path().join(format!("{name}.pak"))).unwrap();
        assert_eq!(primary(&d.path().join(format!("{name}.ucas"))).unwrap(), d.path().join(format!("{name}.pak")));
    }

    #[test]
    fn changed_or_toggled_sources_are_never_published_over() {
        let d = tempfile::tempdir().unwrap();
        let off = d.path().join("Skin.bak_repak");
        let on = d.path().join("Skin.pak");
        fs::write(&off, b"original").unwrap();
        let before = snapshot(&off).unwrap();
        fs::rename(&off, &on).unwrap(); // a toggle between backup and publication
        assert!(unchanged(&off, &before).is_err());
        assert!(!off.exists() && fs::read(&on).unwrap() == b"original");
        fs::rename(&on, &off).unwrap();
        fs::write(&off, b"new replacement").unwrap();
        assert!(unchanged(&off, &before).is_err());
        assert_eq!(fs::read(&off).unwrap(), b"new replacement");
    }
}
