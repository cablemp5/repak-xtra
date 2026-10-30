//! repakxtra switches no project loader: Project Sigeon lists in the Library as an ordinary mod, and the Project Galacta
//! loader is Setup's. Another app sharing ~mods may switch them itself. The launch, start and focus hooks still call in,
//! only so a loader an older switch hid (`<name>.pak.repakxtra-project-off`, a name no list shows) becomes an ordinary
//! off mod (`.bak_repak`) the Library lists. Nothing is turned on or off.
use std::path::{Path, PathBuf};

const HIDDEN: &str = ".pak.repakxtra-project-off";

/// The renames from a hidden loader to an ordinary off mod. A `.bak_repak` already there is never replaced.
fn plan(mods: &Path) -> Vec<(PathBuf, PathBuf)> {
    let mods = mods.ancestors().find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("~mods"))).unwrap_or(mods);
    walkdir::WalkDir::new(mods)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| crate::xtra_bundle::not_staging(e) && e.file_name() != ".deleted")
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let cut = name.len().checked_sub(HIDDEN.len()).filter(|_| name.to_ascii_lowercase().ends_with(HIDDEN))?;
            let to = e.path().with_file_name(format!("{}.bak_repak", &name[..cut]));
            (!to.exists()).then(|| (e.path().to_path_buf(), to))
        })
        .collect()
}

/// Ok(true) when a hidden loader now lists as an off mod. Never a reason to refuse Play.
pub fn select(mods: &Path) -> Result<bool, String> {
    let changes = plan(mods);
    if changes.is_empty() {
        return Ok(false);
    }
    let _edit = crate::xtra_mutation::edit()?;
    for (from, to) in &changes {
        std::fs::rename(from, to).map_err(|e| format!("{}: {e}", from.display()))?;
    }
    Ok(true)
}

pub fn on_open(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let mods = app.state::<std::sync::Arc<std::sync::Mutex<crate::AppState>>>().lock().unwrap().game_path.clone();
    match select(&mods) {
        Ok(true) => {
            let _ = app.emit("mods_dir_changed", ());
        }
        Ok(false) => {}
        Err(error) => log::warn!("Listing a hidden loader: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hidden_loader_becomes_an_off_mod_and_nothing_else_changes() {
        let temp = tempfile::tempdir().unwrap();
        let mods = temp.path().join("~mods");
        std::fs::create_dir_all(mods.join("sub")).unwrap();
        let hidden = mods.join("!ProjectSigeon_9999999_P.pak.repakxtra-project-off");
        let on = mods.join("!ProjectGalacta_9999999_P.pak");
        let taken = mods.join("sub/Other_P.pak.repakxtra-project-off");
        for f in [&hidden, &on, &taken] {
            std::fs::write(f, b"x").unwrap();
        }
        std::fs::write(mods.join("sub/Other_P.bak_repak"), b"kept").unwrap();
        assert!(select(&mods).unwrap());
        assert!(mods.join("!ProjectSigeon_9999999_P.bak_repak").exists() && !hidden.exists());
        assert!(on.exists(), "a loader that is on stays on");
        assert!(taken.exists() && std::fs::read(mods.join("sub/Other_P.bak_repak")).unwrap() == b"kept", "an existing off copy is never replaced");
        assert!(!select(&mods).unwrap(), "nothing left to do");
    }
}
