//! repakxtra: a desktop shortcut to the running repakxtra (the first-launch setup and Settings > General). Made with
//! Windows' own WScript.Shell through PowerShell, so no new crates. The paths reach the fixed script as environment
//! variables, never as script text (an apostrophe in a folder name cannot break or change it). The shortcut is written
//! to a temp file first and then put on the desktop only under a name nobody holds: an existing repakxtra.lnk (one that
//! points somewhere on purpose, like a build folder's junction) is never replaced, even by a racing writer.

use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;

fn shortcut_name() -> &'static str {
    if option_env!("REPAKXTRA_BUILD") == Some("test") { "repakxtratest.lnk" } else { "repakxtra.lnk" }
}
const SCRIPT: &str = "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:RX_LNK); $s.TargetPath = $env:RX_EXE; \
    $s.WorkingDirectory = $env:RX_DIR; $s.IconLocation = $env:RX_EXE + ',0'; $s.Description = $env:RX_NAME; $s.Save()";

/// The desktop (Windows' known folder, so a desktop moved to OneDrive is found too) and the shortcut on it.
fn shortcut() -> Option<PathBuf> {
    dirs::desktop_dir().map(|d| d.join(shortcut_name()))
}

#[derive(Serialize)]
pub struct ShortcutStatus {
    exists: bool,
}

#[tauri::command(async)]
pub fn shortcut_status() -> ShortcutStatus {
    ShortcutStatus { exists: shortcut().is_some_and(|p| p.exists()) }
}

/// Puts repakxtra.lnk on the desktop, pointing at this repakxtra.exe (its icon, its folder as the start folder).
#[tauri::command]
pub async fn shortcut_create() -> Result<(), String> {
    let lnk = shortcut().ok_or("Windows did not say where the desktop is.")?;
    if lnk.exists() {
        return Err("A desktop shortcut for this copy already exists.".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("repakxtra's folder is unknown.")?.to_path_buf();
    let temp = std::env::temp_dir().join(format!("repakxtra-{}.lnk", std::process::id()));
    let made = temp.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT])
            .env("RX_LNK", &made)
            .env("RX_EXE", &exe)
            .env("RX_DIR", &dir)
            .env("RX_NAME", crate::xtra_edition::APP_NAME);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        cmd.output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("PowerShell did not start: {e}"))?;
    let bytes = std::fs::read(&temp).map_err(|_| {
        let said = String::from_utf8_lossy(&out.stderr);
        format!("The shortcut was not made. {}", said.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim())
    });
    let _ = std::fs::remove_file(&temp);
    publish(&lnk, &bytes?)?;
    crate::ui_log::success("Shortcut", format!("Made {}", lnk.display()));
    Ok(())
}

/// Writes the shortcut under its name only if nothing holds that name yet (create_new fails on an existing file).
fn publish(lnk: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(lnk).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists { "A desktop shortcut for this copy already exists.".to_string() } else { e.to_string() }
    })?;
    f.write_all(bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn never_replaces_an_existing_shortcut() {
        let dir = tempfile::tempdir().unwrap();
        let lnk = dir.path().join("repakxtra.lnk");
        super::publish(&lnk, b"first").unwrap();
        assert!(super::publish(&lnk, b"second").is_err());
        assert_eq!(std::fs::read(&lnk).unwrap(), b"first");
    }

    #[test]
    fn the_script_reads_paths_only_from_the_environment() {
        assert!(!super::SCRIPT.contains('\''.to_string().repeat(2).as_str()) && super::SCRIPT.contains("$env:RX_LNK"));
    }
}
