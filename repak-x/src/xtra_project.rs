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
        || name.ends_with(".pak.repakxtra-project-off")
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
    let candidates: Vec<_> = files
        .iter()
        .filter(|p| project(p).unwrap().0 == extended)
        .collect();
    let rank = |p: &Path| {
        if project(p).unwrap().1 {
            0
        } else if p
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_ascii_lowercase()
            .ends_with(".pak.repakxtra-project-off")
        {
            1
        } else {
            2
        }
    };
    if candidates.len() > 1 && candidates.iter().all(|p| rank(p) == 2) {
        return Err("Multiple disabled copies of the selected project were found. Enable the current copy in the Library or reinstall it in Setup before switching; no files were changed.".into());
    }
    let chosen = candidates.into_iter().min_by_key(|p| rank(p)).cloned();
    let mut changes = Vec::new();
    // Disable every opposing/duplicate loader before enabling the selected one.
    for path in &files {
        if project(path).unwrap().1 && Some(path) != chosen.as_ref() {
            let off = parked_path(path);
            if off.exists() {
                let backup = path.with_file_name(format!(
                    "{}.repakxtra-disabled-{}",
                    path.file_name().unwrap().to_string_lossy(),
                    uuid::Uuid::new_v4()
                ));
                changes.push((off.clone(), backup));
            }
            changes.push((path.clone(), off));
        }
    }
    if let Some(path) = &chosen {
        let name = path.file_name().unwrap().to_string_lossy();
        let lower = name.to_ascii_lowercase();
        let pak = if project(path).unwrap().1 {
            path.clone()
        } else {
            let stem_end = lower
                .find(".pak.")
                .unwrap_or_else(|| lower.rfind('.').unwrap());
            path.with_file_name(format!("{}.pak", &name[..stem_end]))
        };
        // Legacy .off bundles keep all three files disabled. Restore companions before publishing the PAK.
        for ext in ["utoc", "ucas"] {
            let to = pak.with_extension(ext);
            let expected = format!("{}.off", to.file_name().unwrap().to_string_lossy());
            let from = fs::read_dir(path.parent().unwrap())
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&expected)
                });
            if let Some(from) = from {
                if !from.file_type().map_err(|e| e.to_string())?.is_file() {
                    return Err(format!(
                        "{} is not a regular companion file",
                        from.path().display()
                    ));
                }
                changes.push((from.path(), to));
            }
        }
        if !project(path).unwrap().1 {
            changes.push((path.clone(), pak));
        }
    }
    // A collision in a later companion must leave even the opposing project untouched.
    let mut vacated = std::collections::HashSet::new();
    for (from, to) in &changes {
        if to.exists() && !vacated.contains(to) {
            return Err(format!(
                "Could not select the project loader: {} already exists; no files were changed",
                to.display()
            ));
        }
        vacated.insert(from.clone());
        vacated.remove(to);
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

fn parked_path(pak: &Path) -> PathBuf {
    pak.with_file_name(format!(
        "{}.repakxtra-project-off",
        pak.file_name().unwrap().to_string_lossy()
    ))
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
        fs::write(parked_path(&galacta), b"earlier park").unwrap();
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
        assert_eq!(
            fs::read(parked_path(&galacta)).unwrap(),
            b"earlier park",
            "rollback restores the previous parked copy too"
        );
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
        assert_eq!(
            fs::read(parked_path(&sigeon.with_extension("pak"))).unwrap(),
            b"sigeon"
        );
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
        fs::write(parked_path(&active), b"previous park").unwrap();
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
        assert!(
            fs::read_dir(mods).unwrap().flatten().any(|e| e
                .file_name()
                .to_string_lossy()
                .contains(".pak.repakxtra-disabled-")
                && fs::read(e.path()).ok().as_deref() == Some(b"previous park")),
            "replacing a stale parked marker preserves its bytes"
        );
        switch(mods, false).unwrap();
        assert_eq!(
            fs::read(&active).unwrap(),
            b"galacta",
            "the current copy wins over the older .bak_repak"
        );
        assert_eq!(
            fs::read(active.with_extension("bak_repak")).unwrap(),
            b"older"
        );
        switch(mods, true).unwrap();
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
        assert_eq!(fs::read(parked_path(&active)).unwrap(), b"galacta");
    }

    #[test]
    fn ambiguous_legacy_backups_are_not_guessed_or_mutated() {
        let temp = tempfile::tempdir().unwrap();
        let mods = temp.path();
        for name in [
            "ProjectGalacta.bak_repak",
            "ProjectGalacta.pak.repakxtra-disabled-old",
            "ProjectSigeon.pak",
        ] {
            fs::write(mods.join(name), name).unwrap();
        }
        assert!(switch(mods, false)
            .unwrap_err()
            .contains("Multiple disabled copies"));
        assert!(mods.join("ProjectSigeon.pak").exists());
        assert!(!mods.join("ProjectGalacta.pak").exists());
    }

    fn off_fixture() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        for ext in ["pak", "utoc", "ucas"] {
            fs::write(temp.path().join(format!("ProjectGalacta.{ext}.off")), ext).unwrap();
        }
        fs::write(temp.path().join("ProjectSigeon.pak"), b"sigeon").unwrap();
        temp
    }

    #[test]
    fn legacy_off_restores_the_complete_bundle() {
        let temp = off_fixture();
        switch(temp.path(), false).unwrap();
        for ext in ["pak", "utoc", "ucas"] {
            assert_eq!(
                fs::read(temp.path().join(format!("ProjectGalacta.{ext}"))).unwrap(),
                ext.as_bytes()
            );
            assert!(!temp
                .path()
                .join(format!("ProjectGalacta.{ext}.off"))
                .exists());
        }
        assert!(!temp.path().join("ProjectSigeon.pak").exists());
    }

    #[test]
    fn legacy_off_collision_leaves_every_original_in_place() {
        let temp = off_fixture();
        fs::write(temp.path().join("ProjectGalacta.ucas"), b"do not overwrite").unwrap();
        assert!(switch(temp.path(), false)
            .unwrap_err()
            .contains("already exists"));
        for ext in ["pak", "utoc", "ucas"] {
            assert_eq!(
                fs::read(temp.path().join(format!("ProjectGalacta.{ext}.off"))).unwrap(),
                ext.as_bytes()
            );
        }
        assert!(temp.path().join("ProjectSigeon.pak").exists());
        assert!(!temp.path().join("ProjectGalacta.utoc").exists());
        assert_eq!(
            fs::read(temp.path().join("ProjectGalacta.ucas")).unwrap(),
            b"do not overwrite"
        );
    }

    #[cfg(windows)]
    #[test]
    fn locked_off_companion_rolls_back_the_entire_switch() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = off_fixture();
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(temp.path().join("ProjectGalacta.ucas.off"))
            .unwrap();
        assert!(switch(temp.path(), false).is_err());
        drop(locked);
        for ext in ["pak", "utoc", "ucas"] {
            assert_eq!(
                fs::read(temp.path().join(format!("ProjectGalacta.{ext}.off"))).unwrap(),
                ext.as_bytes()
            );
            assert!(!temp.path().join(format!("ProjectGalacta.{ext}")).exists());
        }
        assert!(temp.path().join("ProjectSigeon.pak").exists());
    }

    #[cfg(feature = "extended")]
    #[test]
    fn first_successful_unlock_switches_projects_after_saving_the_receipt() {
        use sha2::{Digest, Sha256};
        let temp = tempfile::tempdir().unwrap();
        let mods = temp.path().join("mods");
        fs::create_dir(&mods).unwrap();
        fs::write(mods.join("ProjectGalacta.pak"), b"galacta").unwrap();
        fs::write(mods.join("ProjectSigeon.bak_repak"), b"sigeon").unwrap();
        let receipt = temp.path().join("settings/receipt");
        let hash = format!("{:x}", Sha256::digest(b"fixture-only"));
        assert!(
            crate::xtra_activation::unlock_then("wrong", &hash, &receipt, || panic!(
                "invalid unlock must never switch"
            ))
            .is_err()
        );
        assert!(!receipt.exists());
        assert!(mods.join("ProjectGalacta.pak").exists());
        assert!(!mods.join("ProjectSigeon.pak").exists());
        crate::xtra_activation::unlock_then("fixture-only", &hash, &receipt, || {
            assert_eq!(fs::read_to_string(&receipt).unwrap(), hash);
            switch(&mods, true).unwrap();
        })
        .unwrap();
        assert_eq!(fs::read(mods.join("ProjectSigeon.pak")).unwrap(), b"sigeon");
        assert!(!mods.join("ProjectGalacta.pak").exists());
    }
}
