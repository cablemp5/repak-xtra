//! Select the installed project loader for this edition, without downloading or replacing either bundle.
use std::{
    fs,
    path::{Path, PathBuf},
};

fn project(path: &Path) -> Option<(bool, bool)> {
    let name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    let sigeon = if name.contains("projectsigeon") {
        true
    } else if name.contains("projectgalacta") {
        false
    } else {
        return None;
    };
    let active = name.ends_with(".pak");
    (active
        || name.ends_with(".bak_repak")
        || name.ends_with(".pak_disabled")
        || name.ends_with(".pak.off")
        || name.contains(".pak.repakxtra-disabled-"))
    .then_some((sigeon, active))
}

fn switch(mods: &Path, extended: bool) -> Result<bool, String> {
    let mods = mods
        .ancestors()
        .find(|p| {
            p.file_name()
                .is_some_and(|n| n.eq_ignore_ascii_case("~mods"))
        })
        .unwrap_or(mods);
    if !mods.is_dir() {
        return Ok(false);
    }
    let mut files: Vec<PathBuf> = Vec::new();
    for entry in walkdir::WalkDir::new(mods)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| crate::xtra_bundle::not_staging(e) && e.file_name() != ".deleted")
    {
        let entry = entry.map_err(|e| format!("Could not inspect project loaders: {e}"))?;
        if entry.file_type().is_file() && project(entry.path()).is_some() {
            files.push(entry.into_path());
        }
    }
    // Older installs also keep renamed project bundles directly beside ~mods.
    if let Some(paks) = mods.parent().filter(|p| {
        p.file_name()
            .is_some_and(|n| n.eq_ignore_ascii_case("Paks"))
    }) {
        for entry in fs::read_dir(paks).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().map_err(|e| e.to_string())?.is_file()
                && project(&entry.path()).is_some()
            {
                files.push(entry.path());
            }
        }
    }
    files.sort();
    let chosen = files
        .iter()
        .filter(|p| project(p).unwrap().0 == extended)
        .min_by_key(|p| !project(p).unwrap().1)
        .cloned();
    let mut changes = Vec::new();
    // Disable every opposing/duplicate loader before enabling the selected one.
    for path in &files {
        if project(path).unwrap().1 && Some(path) != chosen.as_ref() {
            let mut off = path.with_extension("bak_repak");
            if off.exists() {
                off = path.with_file_name(format!(
                    "{}.repakxtra-disabled-{}",
                    path.file_name().unwrap().to_string_lossy(),
                    uuid::Uuid::new_v4()
                ));
            }
            changes.push((path.clone(), off));
        }
    }
    if let Some(path) = &chosen {
        if !project(path).unwrap().1 {
            let name = path.file_name().unwrap().to_string_lossy();
            let lower = name.to_ascii_lowercase();
            let stem_end = lower
                .find(".pak.")
                .unwrap_or_else(|| lower.rfind('.').unwrap());
            changes.push((
                path.clone(),
                path.with_file_name(format!("{}.pak", &name[..stem_end])),
            ));
        }
    }
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (from, to) in changes {
        let result = if to.exists() {
            Err(format!("{} already exists", to.display()))
        } else {
            fs::rename(&from, &to).map_err(|e| format!("{}: {e}", from.display()))
        };
        if let Err(error) = result {
            let mut rollback_failed = false;
            for (original, destination) in moved.iter().rev() {
                if original.exists() || fs::rename(destination, original).is_err() {
                    rollback_failed = true;
                }
            }
            return Err(format!(
                "Could not select the project loader: {error}{}",
                if rollback_failed {
                    ". Some files remain disabled; no backup was deleted."
                } else {
                    ""
                }
            ));
        }
        moved.push((from, to));
    }
    if chosen.is_none() && !files.is_empty() {
        return Err(format!(
            "The other project was disabled, but {} is not installed. Install it in Setup first.",
            if extended {
                "Project Sigeon"
            } else {
                "Project Galacta"
            }
        ));
    }
    Ok(!moved.is_empty())
}

pub fn select(mods: &Path) -> Result<bool, String> {
    if !mods.is_dir() {
        return Ok(false);
    }
    let _exclusive = crate::xtra_mutation::encrypt()?;
    crate::xtra_identity::upstream_guard()?;
    if crate::is_game_process_running() {
        return Err("Close Marvel Rivals before switching project loaders.".into());
    }
    #[cfg(feature = "extended")]
    crate::xtra_activation::require()?;
    switch(mods, crate::xtra_edition::EXTENDED)
}

pub fn on_open(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let mods = app
        .state::<std::sync::Arc<std::sync::Mutex<crate::AppState>>>()
        .lock()
        .unwrap()
        .game_path
        .clone();
    match select(&mods) {
        Ok(true) => {
            let _ = app.emit("mods_dir_changed", ());
        }
        Ok(false) => {}
        Err(error) => {
            log::warn!("Automatic project selection: {error}");
            crate::ui_log::warn("Startup", error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn failed_enable_restores_the_previous_project() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        let galacta = temp.path().join("ProjectGalacta.pak");
        let sigeon = temp.path().join("ProjectSigeon.bak_repak");
        fs::write(&galacta, b"galacta").unwrap();
        fs::write(&sigeon, b"sigeon").unwrap();
        let _locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&sigeon)
            .unwrap();
        assert!(switch(temp.path(), true)
            .unwrap_err()
            .contains("Could not select"));
        assert_eq!(fs::read(&galacta).unwrap(), b"galacta");
        assert!(!galacta.with_extension("bak_repak").exists());
        assert!(sigeon.exists());
    }

    #[test]
    fn editions_switch_both_directions_and_preserve_bundles() {
        let temp = tempfile::tempdir().unwrap();
        let mods = temp.path().join("Paks/~mods");
        fs::create_dir_all(mods.join("nested")).unwrap();
        let galacta = mods.parent().unwrap().join("ProjectGalacta-repacked.PAK");
        let sigeon = mods.join("nested/!ProjectSigeon_9999999_P.bak_repak");
        fs::write(&galacta, b"galacta").unwrap();
        fs::write(&sigeon, b"sigeon").unwrap();
        fs::write(mods.join("skin.pak"), b"skin").unwrap();
        assert!(switch(&mods, true).unwrap());
        assert!(!galacta.exists());
        assert_eq!(fs::read(sigeon.with_extension("pak")).unwrap(), b"sigeon");
        assert!(!switch(&mods, true).unwrap());
        assert!(switch(&mods, false).unwrap());
        assert_eq!(fs::read(galacta.with_extension("pak")).unwrap(), b"galacta");
        assert_eq!(fs::read(&sigeon).unwrap(), b"sigeon");
        assert_eq!(fs::read(mods.join("skin.pak")).unwrap(), b"skin");
    }

    #[test]
    fn legacy_disabled_copies_restore_and_existing_backups_survive() {
        let temp = tempfile::tempdir().unwrap();
        let mods = temp.path();
        let old = mods.join("!ProjectSigeon_9999999_P.pak.repakxtra-disabled-old");
        fs::write(old, b"sigeon").unwrap();
        let active = mods.join("!ProjectGalacta_9999999_P.pak");
        fs::write(&active, b"galacta").unwrap();
        fs::write(active.with_extension("bak_repak"), b"older").unwrap();
        switch(mods, true).unwrap();
        assert_eq!(
            fs::read(mods.join("!ProjectSigeon_9999999_P.pak")).unwrap(),
            b"sigeon"
        );
        assert_eq!(
            fs::read(active.with_extension("bak_repak")).unwrap(),
            b"older"
        );
        assert!(!active.exists());
        fs::rename(
            mods.join("!ProjectSigeon_9999999_P.pak"),
            mods.join("!ProjectSigeon_9999999_P.pak_disabled"),
        )
        .unwrap();
        switch(mods, true).unwrap();
        assert_eq!(
            fs::read(mods.join("!ProjectSigeon_9999999_P.pak")).unwrap(),
            b"sigeon"
        );
    }

    #[test]
    fn missing_project_disables_opponent_and_staging_is_ignored() {
        let temp = tempfile::tempdir().unwrap();
        let stage = temp.path().join(".repakxtra-encrypt-test");
        fs::create_dir(&stage).unwrap();
        fs::write(stage.join("ProjectSigeon.pak"), b"staged").unwrap();
        assert!(!switch(temp.path(), true).unwrap());
        let active = temp.path().join("ProjectGalacta.pak");
        fs::write(&active, b"galacta").unwrap();
        assert!(switch(temp.path(), true)
            .unwrap_err()
            .contains("not installed"));
        assert!(!active.exists());
        assert_eq!(
            fs::read(active.with_extension("bak_repak")).unwrap(),
            b"galacta"
        );
    }
}
