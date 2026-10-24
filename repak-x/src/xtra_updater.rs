//! repakxtra: applies a downloaded update zip after the app closes. The script is fixed text and every path reaches it
//! through an environment variable (as xtra_shortcut.rs does), so an apostrophe, percent sign, dollar sign or bracket
//! in a Windows user name or install folder can no longer change what runs. Files the update replaces are copied to
//! a backup first and put back if copying fails, so a failed update keeps the old version working.

use std::path::{Path, PathBuf};

/// Where downloads land. apply_update only accepts a file directly inside it.
pub fn update_dir() -> PathBuf {
    std::env::temp_dir().join("repakxtra_update")
}

/// The downloaded update `path`, if it is a file the app downloaded itself (directly inside update_dir).
pub fn owned_download(path: &Path) -> Result<PathBuf, String> {
    let file = std::fs::canonicalize(path).map_err(|e| format!("Downloaded update file not found: {e}"))?;
    let dir = std::fs::canonicalize(update_dir()).map_err(|e| format!("Downloaded update file not found: {e}"))?;
    if file.parent() == Some(dir.as_path()) && file.is_file() {
        Ok(update_dir().join(file.file_name().unwrap_or_default())) // the plain path, not canonicalize's extended-length form
    } else {
        Err("Only an update repakxtra downloaded itself can be applied".to_string())
    }
}

const APPLY_ZIP: &str = r#"
$ErrorActionPreference = 'Stop'
$zip = $env:RX_ZIP; $temp = $env:RX_TEMP; $app = $env:RX_APP; $exe = $env:RX_EXE
function Fail([string]$msg) {
    if ($env:RX_TEST -ne '1') {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show($msg, 'repakxtra update') | Out-Null
        Start-Process -FilePath $exe
    }
    exit 1
}
$waitFor = [int]$env:RX_PID
while (Get-Process -Id $waitFor -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 300 }

# What the app started from its own folder (UAssetTool's command line, mid-extract) can outlive it and keeps its files in
# use: it gets a moment to finish, then it is stopped. The folder by both names: the dist\repakxtra link and its target.
# Every path through Get-Item, which spells it out in full (a short 8.3 RUNNER~1 and its long name compare equal). Never
# what stops an update: a failure here leaves the copy below to try
try {
    $long = { param($p) try { (Get-Item -LiteralPath $p -ErrorAction Stop).FullName } catch { $p } }
    $roots = @((& $long $app).TrimEnd('\') + '\')
    $linked = (Get-Item -LiteralPath $app).Target
    if ($linked) { $roots += @($linked | ForEach-Object { (& $long $_).TrimEnd('\') + '\' }) }
    function Left {
        @(Get-Process | Where-Object {
            $p = try { $_.Path } catch { $null }
            if ($p) { $p = & $long $p }
            $p -and @($roots | Where-Object { $p.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count
        })
    }
    $deadline = (Get-Date).AddSeconds($(if ($env:RX_WAIT) { [int]$env:RX_WAIT } else { 30 }))
    while (@(Left).Count -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
    $stop = @(Left)
    $stop | Stop-Process -Force -ErrorAction SilentlyContinue
    $stop | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
} catch { }

$extracted = Join-Path $temp 'extracted'
try { Expand-Archive -LiteralPath $zip -DestinationPath $extracted -Force }
catch { Fail "The update could not be unpacked, so nothing was changed. Download it from github.com/cablemp5/repak-xtra/releases" }

# A zip with one top folder holding the app is used from inside that folder
# Its long path, as Get-ChildItem reports files: a short (8.3) temp path like RUNNER~1 would cut the wrong length below
$src = (Get-Item -LiteralPath $extracted).FullName
$dirs = @(Get-ChildItem -LiteralPath $extracted -Directory)
if ($dirs.Count -eq 1 -and @(Get-ChildItem -LiteralPath $dirs[0].FullName -File | Where-Object { $_.Extension -in '.exe', '.dll' }).Count -gt 0) {
    $src = $dirs[0].FullName
}
if (@(Get-ChildItem -LiteralPath $src -File -Filter '*.exe').Count -eq 0) {
    Fail "The update holds no app, so nothing was changed. Download it from github.com/cablemp5/repak-xtra/releases"
}

# Copy every file, keeping a backup of each one it replaces
$backup = Join-Path $temp 'previous'
$copied = New-Object System.Collections.Generic.List[string]
try {
    foreach ($f in Get-ChildItem -LiteralPath $src -Recurse -File) {
        $rel = $f.FullName.Substring($src.Length).TrimStart('\')
        $dest = Join-Path $app $rel
        if (Test-Path -LiteralPath $dest) {
            $b = Join-Path $backup $rel
            [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($b))
            Copy-Item -LiteralPath $dest -Destination $b -Force
        }
        [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($dest))
        Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
        $copied.Add($rel)
    }
} catch {
    $err = $_.Exception.Message
    foreach ($rel in $copied) {
        $b = Join-Path $backup $rel
        $dest = Join-Path $app $rel
        if (Test-Path -LiteralPath $b) { Copy-Item -LiteralPath $b -Destination $dest -Force -ErrorAction SilentlyContinue }
        else { Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue }
    }
    Fail "The update could not be copied ($err). The previous version was kept."
}

# Leftovers older releases shipped (legacy dds tools, debug symbols, misplaced tool copies)
$tool = Join-Path $app 'uassettool'
Remove-Item -LiteralPath (Join-Path $tool 'ue4-dds-tools') -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath $tool -Filter '*.pdb' -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
if ((Test-Path -LiteralPath (Join-Path $src 'UAssetTool.dll')) -and -not (Test-Path -LiteralPath (Join-Path $src 'uassettool'))) {
    Remove-Item -LiteralPath $tool -Recurse -Force -ErrorAction SilentlyContinue
}
foreach ($stale in @('UAssetTool.exe', 'tools\UAssetTool.exe', 'tools\uassettool\UAssetTool.exe')) {
    Remove-Item -LiteralPath (Join-Path $app $stale) -Force -ErrorAction SilentlyContinue
}

Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
if ($env:RX_TEST -ne '1') { Start-Process -FilePath $exe }
"#;

const RUN_INSTALLER: &str = r#"
$waitFor = [int]$env:RX_PID
while (Get-Process -Id $waitFor -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 300 }
Start-Process -FilePath $env:RX_INSTALLER -Wait
Remove-Item -LiteralPath $env:RX_INSTALLER -Force -ErrorAction SilentlyContinue
"#;

fn powershell(script: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Starts the hidden helper that waits for this process to exit, then applies `zip` to `app_dir` and starts `exe`.
pub fn launch_zip(zip: &Path, app_dir: &Path, exe: &Path) -> Result<(), String> {
    let temp = zip.parent().ok_or("The update has no folder")?;
    // the command line kept running between extracts holds uassettool-cli.exe, which the update replaces (0.20.0 to 0.21.0
    // failed on it): stopped now, and the helper waits for anything else still running from the app's folder
    crate::xtra_uat_cli::reset();
    powershell(APPLY_ZIP)
        .env("RX_PID", std::process::id().to_string())
        .env("RX_ZIP", zip)
        .env("RX_TEMP", temp)
        .env("RX_APP", app_dir)
        .env("RX_EXE", exe)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to launch updater: {e}"))
}

/// Starts the hidden helper that waits for this process to exit, then runs `installer` and deletes it.
pub fn launch_installer(installer: &Path) -> Result<(), String> {
    powershell(RUN_INSTALLER)
        .env("RX_PID", std::process::id().to_string())
        .env("RX_INSTALLER", installer)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to launch updater: {e}"))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn zip_with(path: &Path, files: &[(&str, &[u8])]) {
        let mut z = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, data) in files {
            z.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(data).unwrap();
        }
        z.finish().unwrap();
    }

    /// Runs the real script against a made-up install under a folder name full of shell characters.
    fn apply(root: &Path, files: &[(&str, &[u8])]) -> (bool, PathBuf) {
        let temp = root.join("update");
        let app = root.join("app");
        fs::create_dir_all(&temp).unwrap();
        fs::create_dir_all(&app).unwrap();
        for (name, data) in [("repakxtra.exe", &b"old exe"[..]), ("keep.txt", b"untouched")] {
            if !app.join(name).exists() {
                fs::write(app.join(name), data).unwrap();
            }
        }
        let zip = temp.join("repak-xtra-v9.9.9-windows.zip");
        zip_with(&zip, files);
        // a process that already exited, so the wait ends at once (PID 0 is Windows' Idle process, which never does)
        let mut gone = std::process::Command::new("cmd").args(["/c", "exit"]).spawn().unwrap();
        gone.wait().unwrap();
        // the update folder by another spelling than Windows lists it (CI's temp is a short 8.3 path, RUNNER~1): the script
        // must still copy each file to its own place
        let alias = temp.join("..").join("update");
        let ok = powershell(APPLY_ZIP)
            .env("RX_PID", gone.id().to_string())
            .env("RX_ZIP", alias.join("repak-xtra-v9.9.9-windows.zip"))
            .env("RX_TEMP", &alias)
            .env("RX_APP", &app)
            .env("RX_EXE", app.join("repakxtra.exe"))
            .env("RX_TEST", "1")
            .env("RX_WAIT", "2") // a process from the app's folder still running after 2 s is stopped (30 s in the app)
            .status()
            .unwrap()
            .success();
        (ok, app)
    }

    fn root(tag: &str) -> PathBuf {
        let r = std::env::temp_dir().join(format!("repakxtra-updater-{tag}-{}", std::process::id())).join("O'Brien %USERNAME% (x86) $HOME ü & [1]");
        let _ = fs::remove_dir_all(r.parent().unwrap());
        fs::create_dir_all(&r).unwrap();
        r
    }

    #[test]
    fn applies_an_update_under_a_path_with_shell_characters() {
        let r = root("ok");
        let (ok, app) = apply(&r, &[("repakxtra.exe", b"new exe"), ("data/x.json", b"{}")]);
        assert!(ok);
        assert_eq!(fs::read(app.join("repakxtra.exe")).unwrap(), b"new exe");
        assert_eq!(fs::read(app.join("data").join("x.json")).unwrap(), b"{}");
        assert_eq!(fs::read(app.join("keep.txt")).unwrap(), b"untouched");
        assert!(!r.join("update").exists(), "the update folder is cleaned up");
        let _ = fs::remove_dir_all(r.parent().unwrap());
    }

    #[test]
    fn a_tool_still_running_from_the_app_folder_is_stopped_before_the_copy() {
        let r = root("busy");
        let app = r.join("app");
        fs::create_dir_all(&app).unwrap();
        // a running exe cannot be overwritten: ping stands in for the command line mid-extract (60 s, longer than the wait)
        let cli = app.join("uassettool-cli.exe");
        fs::copy(r"C:\Windows\System32\PING.EXE", &cli).unwrap();
        let mut busy = std::process::Command::new(&cli).args(["-n", "60", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
        let (ok, app) = apply(&r, &[("repakxtra.exe", b"new exe"), ("uassettool-cli.exe", b"new cli")]);
        let stopped = busy.try_wait().unwrap().is_some();
        let _ = busy.kill();
        assert!(ok, "the update went in");
        assert!(stopped, "the tool was stopped");
        assert_eq!(fs::read(app.join("uassettool-cli.exe")).unwrap(), b"new cli");
        let _ = fs::remove_dir_all(r.parent().unwrap());
    }

    #[test]
    fn an_update_without_an_app_changes_nothing() {
        let r = root("noapp");
        let (ok, app) = apply(&r, &[("readme.txt", b"hi")]);
        assert!(!ok);
        assert_eq!(fs::read(app.join("repakxtra.exe")).unwrap(), b"old exe");
        assert!(!app.join("readme.txt").exists());
        let _ = fs::remove_dir_all(r.parent().unwrap());
    }

    #[test]
    fn a_failed_copy_puts_the_old_files_back() {
        let r = root("locked");
        // an open handle without sharing makes the second file fail after repakxtra.exe was already copied
        let app = r.join("app");
        fs::create_dir_all(&app).unwrap();
        fs::write(app.join("z_locked.dat"), b"old").unwrap();
        use std::os::windows::fs::OpenOptionsExt;
        let lock = fs::OpenOptions::new().read(true).share_mode(0).open(app.join("z_locked.dat")).unwrap();
        let (ok, app) = apply(&r, &[("repakxtra.exe", b"new exe"), ("z_locked.dat", b"new")]);
        drop(lock);
        assert!(!ok);
        assert_eq!(fs::read(app.join("repakxtra.exe")).unwrap(), b"old exe");
        let _ = fs::remove_dir_all(r.parent().unwrap());
    }

    #[test]
    fn only_files_in_the_update_folder_are_accepted() {
        let inside = update_dir().join(format!("test-{}.zip", std::process::id()));
        fs::create_dir_all(update_dir()).unwrap();
        fs::write(&inside, b"x").unwrap();
        assert_eq!(owned_download(&inside).unwrap(), inside);
        let _ = fs::remove_file(&inside);
        let outside = std::env::temp_dir().join(format!("repakxtra-not-an-update-{}.zip", std::process::id()));
        fs::write(&outside, b"x").unwrap();
        assert!(owned_download(&outside).is_err());
        let _ = fs::remove_file(&outside);
    }
}
