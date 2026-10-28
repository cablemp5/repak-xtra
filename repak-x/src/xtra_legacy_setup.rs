//! Standard can disable a previous extended setup, but cannot enable or generate its features.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

struct Item { path: PathBuf, label: &'static str }

fn discover(selected: &Path) -> Vec<Item> {
    let root = selected.ancestors().find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("~mods"))).unwrap_or(selected);
    if !root.is_dir() { return Vec::new(); }
    let mut items = Vec::new();
    for entry in walkdir::WalkDir::new(root).follow_links(false).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() { continue; }
        let name = entry.file_name().to_string_lossy();
        let label = if name.eq_ignore_ascii_case("!ProjectSigeon_9999999_P.pak") { "Project Sigeon" }
            else if name.eq_ignore_ascii_case("repakxtra-custom-quake_9999999_P.pak") { "Custom Quake" }
            else if name.eq_ignore_ascii_case("repakxtra-force-default-skin_9999999_P.pak") { "Force default skin" }
            else { continue };
        items.push(Item { path: entry.into_path(), label });
    }
    if let Some(game) = root.parent().and_then(Path::parent).and_then(Path::parent) {
        let path = game.join("Binaries/Win64/plugins/SigeonLoader.asi");
        if path.is_file() { items.push(Item { path, label: "Sigeon V2 loader" }); }
    }
    items
}

fn disable(items: &[Item], save_choice: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let result = (|| {
        for item in items {
            let name = item.path.file_name().ok_or("Missing file name")?.to_string_lossy();
            let backup = item.path.with_file_name(format!("{name}.repakxtra-disabled-{}", uuid::Uuid::new_v4()));
            std::fs::rename(&item.path, &backup).map_err(|e| format!("Could not disable {}: {e}", item.label))?;
            moved.push((item.path.clone(), backup));
        }
        save_choice()
    })();
    if let Err(error) = result {
        let mut incomplete = false;
        for (original, backup) in moved.iter().rev() {
            if original.exists() || std::fs::rename(backup, original).is_err() { incomplete = true; }
        }
        return Err(if incomplete { format!("{error}. Some files remain in their .repakxtra-disabled backups; no backup was deleted.") } else { error });
    }
    Ok(())
}

#[tauri::command(async)]
pub fn legacy_setup_status(state: State<'_, Arc<Mutex<crate::AppState>>>) -> Vec<String> {
    let path = state.lock().unwrap().game_path.clone();
    let mut labels: Vec<String> = discover(&path).into_iter().map(|i| i.label.to_string()).collect();
    labels.sort(); labels.dedup(); labels
}

#[tauri::command(async)]
pub fn legacy_setup_disable(state: State<'_, Arc<Mutex<crate::AppState>>>) -> Result<(), String> {
    let _mutation = crate::xtra_mutation::edit()?;
    crate::xtra_identity::upstream_guard()?;
    if crate::is_game_process_running() { return Err("Close Marvel Rivals before disabling the older setup.".into()); }
    let path = state.lock().unwrap().game_path.clone();
    disable(&discover(&path), crate::xtra_builtins::disable_legacy_choices)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_known_active_files_are_disabled_and_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let mods = temp.path().join("Marvel/Content/Paks/~mods");
        std::fs::create_dir_all(mods.join("nested")).unwrap();
        let active = mods.join("nested/!ProjectSigeon_9999999_P.pak");
        let other = mods.join("my-skin.pak");
        std::fs::write(&active, b"loader").unwrap();
        std::fs::write(&other, b"skin").unwrap();
        std::fs::write(mods.join("!ProjectSigeon_9999999_P.bak_repak"), b"old backup").unwrap();
        let items = discover(&mods);
        assert_eq!(items.len(), 1);
        disable(&items, || Ok(())).unwrap();
        assert!(!active.exists());
        assert_eq!(std::fs::read(&other).unwrap(), b"skin");
        let kept = std::fs::read_dir(mods.join("nested")).unwrap().next().unwrap().unwrap().path();
        assert_eq!(std::fs::read(kept).unwrap(), b"loader");
        assert!(discover(&mods).is_empty());
    }
    #[test]
    fn a_failed_save_restores_the_original_files() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("known.pak");
        std::fs::write(&path, b"original").unwrap();
        assert!(disable(&[Item { path: path.clone(), label: "fixture" }], || Err("save failed".into())).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn cleanup_detects_quake_and_asi_but_preserves_configs() {
        let temp = tempfile::tempdir().unwrap();
        let mods = temp.path().join("Marvel/Content/Paks/~mods");
        let builtins = mods.join(".repakxtra-builtin");
        let plugins = temp.path().join("Marvel/Binaries/Win64/plugins");
        std::fs::create_dir_all(&builtins).unwrap();
        std::fs::create_dir_all(&plugins).unwrap();
        let quake = builtins.join("repakxtra-custom-quake_9999999_P.pak");
        let skins = builtins.join("repakxtra-force-default-skin_9999999_P.pak");
        let asi = plugins.join("SigeonLoader.asi");
        let ini = plugins.join("SigeonLoader.ini");
        std::fs::write(&quake, b"quake").unwrap();
        std::fs::write(&skins, b"skins").unwrap();
        std::fs::write(&asi, b"asi").unwrap();
        std::fs::write(&ini, b"unchanged config").unwrap();
        let items = discover(&mods);
        assert_eq!(items.len(), 3);
        disable(&items, || Ok(())).unwrap();
        assert!(!quake.exists() && !skins.exists() && !asi.exists());
        assert_eq!(std::fs::read(ini).unwrap(), b"unchanged config");
    }
}
