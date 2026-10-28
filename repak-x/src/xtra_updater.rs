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
# RX_TEST: '1' starts nothing and shows nothing, '2' starts the app but shows no message (the tests' stub app)
function Say([string]$msg) {
    if (-not $env:RX_TEST) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show($msg, 'repakxtra update') | Out-Null
    }
}
function Fail([string]$msg) {
    if ($env:RX_TEST -ne '1') { Start-Process -FilePath $exe }
    Say $msg
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

# Copy every file (a repair: only the ones RX_ONLY lists), keeping a backup of each one it replaces
$backup = Join-Path $temp 'previous'
$copied = New-Object System.Collections.Generic.List[string]
$only = @($env:RX_ONLY -split "`n" | Where-Object { $_ })
function Restore {
    foreach ($rel in $copied) {
        $b = Join-Path $backup $rel
        $dest = Join-Path $app $rel
        if (Test-Path -LiteralPath $b) { Copy-Item -LiteralPath $b -Destination $dest -Force -ErrorAction SilentlyContinue }
        else { Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue }
    }
}
try {
    foreach ($f in Get-ChildItem -LiteralPath $src -Recurse -File) {
        $rel = $f.FullName.Substring($src.Length).TrimStart('\')
        if ($only.Count -and $only -notcontains $rel) { continue }
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
    Restore
    Fail "The update could not be copied ($err). The previous version was kept."
}

# The backups stay until the new version's window has loaded: it writes started-<RX_VERSION> (xtra_started_ok). If that
# never comes within 60 s, or the new process exits first, the previous version goes back and starts
if ($env:RX_TEST -ne '1') {
    $marker = Join-Path $temp "started-$($env:RX_VERSION)"
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    $new = Start-Process -FilePath $exe -PassThru
    if ($env:RX_VERSION) {
        $deadline = (Get-Date).AddSeconds($(if ($env:RX_HEALTH) { [int]$env:RX_HEALTH } else { 60 }))
        while (-not (Test-Path -LiteralPath $marker) -and -not $new.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
        if (-not (Test-Path -LiteralPath $marker)) {
            Stop-Process -Id $new.Id -Force -ErrorAction SilentlyContinue
            try { $left = @(Left); $left | Stop-Process -Force -ErrorAction SilentlyContinue; $left | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue } catch { }
            Restore
            Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
            Start-Process -FilePath $exe
            Say 'The new version did not start, so repakxtra went back to the previous one.'
            exit 2
        }
    }
}

# Leftovers older releases shipped (legacy dds tools, debug symbols, misplaced tool copies). Never on a repair, which
# leaves every file the zip lacks alone
if (-not $only.Count) {
    $tool = Join-Path $app 'uassettool'
    Remove-Item -LiteralPath (Join-Path $tool 'ue4-dds-tools') -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath $tool -Filter '*.pdb' -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    if ((Test-Path -LiteralPath (Join-Path $src 'UAssetTool.dll')) -and -not (Test-Path -LiteralPath (Join-Path $src 'uassettool'))) {
        Remove-Item -LiteralPath $tool -Recurse -Force -ErrorAction SilentlyContinue
    }
    foreach ($stale in @('UAssetTool.exe', 'tools\UAssetTool.exe', 'tools\uassettool\UAssetTool.exe')) {
        Remove-Item -LiteralPath (Join-Path $app $stale) -Force -ErrorAction SilentlyContinue
    }
}

Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
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

/// Starts the hidden helper that waits for this process to exit, then applies `zip` to `app_dir` and starts `exe`. It
/// keeps the replaced files until `version` reports a loaded window (None: no check). `only`: just these zip files.
pub fn launch_zip(zip: &Path, app_dir: &Path, exe: &Path, version: Option<&str>, only: &[String]) -> Result<(), String> {
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
        .env("RX_VERSION", version.unwrap_or_default())
        .env("RX_ONLY", only.iter().map(|f| f.replace('/', "\\")).collect::<Vec<_>>().join("\n"))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to launch updater: {e}"))
}

/// The new version's window has loaded (main.tsx, once after the first render): the update script, waiting in the
/// update folder, may now drop the backup of the previous version. Nothing is written when no update is under way.
#[tauri::command]
pub fn xtra_started_ok() {
    let dir = update_dir();
    if dir.is_dir() {
        let _ = std::fs::write(dir.join(format!("started-{}", crate::xtra_update::version())), b"ok");
    }
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
        let (code, app) = run(root, files, "repakxtra.exe", &[("RX_TEST", "1")]);
        (code == Some(0), app)
    }

    /// The same, with the app started from `exe` (a .cmd stub the test writes) and extra environment.
    fn run(root: &Path, files: &[(&str, &[u8])], exe: &str, env: &[(&str, &str)]) -> (Option<i32>, PathBuf) {
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
        let code = powershell(APPLY_ZIP)
            .env("RX_PID", gone.id().to_string())
            .env("RX_ZIP", alias.join("repak-xtra-v9.9.9-windows.zip"))
            .env("RX_TEMP", &alias)
            .env("RX_APP", &app)
            .env("RX_EXE", app.join(exe))
            .env("RX_WAIT", "2") // a process from the app's folder still running after 2 s is stopped (30 s in the app)
            .envs(env.iter().copied())
            .status()
            .unwrap()
            .code();
        (code, app)
    }

    /// A stand-in app: run.cmd. The old one leaves old-started.txt, a new one reports a loaded window or exits at once.
    const OLD_APP: &[u8] = b"@echo started> \"%~dp0old-started.txt\"\r\n";
    const STARTS: &[u8] = b"@echo ok> \"%RX_TEMP%\\started-%RX_VERSION%\"\r\n";
    const EXITS: &[u8] = b"@exit /b 1\r\n";

    /// A folder without shell characters: cmd.exe cannot start a .cmd under one with "&" (a real exe can, the copy tests
    /// above cover those names).
    fn plain_root(tag: &str) -> PathBuf {
        let r = std::env::temp_dir().join(format!("repakxtra-updater-{tag}-{}", std::process::id())).join("install");
        let _ = fs::remove_dir_all(r.parent().unwrap());
        fs::create_dir_all(&r).unwrap();
        r
    }

    fn started_app(r: &Path, new_app: &[u8]) -> (Option<i32>, PathBuf) {
        let app = r.join("app");
        fs::create_dir_all(&app).unwrap();
        fs::write(app.join("run.cmd"), OLD_APP).unwrap();
        run(r, &[("repakxtra.exe", b"new exe"), ("run.cmd", new_app), ("added.dll", b"new only")], "run.cmd",
            &[("RX_TEST", "2"), ("RX_VERSION", "9.9.9")])
    }

    #[test]
    fn a_new_version_that_loads_keeps_its_files_and_drops_the_backup() {
        let r = plain_root("starts");
        let (code, app) = started_app(&r, STARTS);
        assert_eq!(code, Some(0));
        assert_eq!(fs::read(app.join("repakxtra.exe")).unwrap(), b"new exe");
        assert_eq!(fs::read(app.join("added.dll")).unwrap(), b"new only");
        assert!(!r.join("update").exists(), "previous and the marker go with the update folder");
        assert!(!app.join("old-started.txt").exists());
        let _ = fs::remove_dir_all(r.parent().unwrap());
    }

    #[test]
    fn a_new_version_that_exits_at_once_is_rolled_back() {
        let r = plain_root("exits");
        let (code, app) = started_app(&r, EXITS);
        assert_eq!(code, Some(2));
        assert_eq!(fs::read(app.join("repakxtra.exe")).unwrap(), b"old exe");
        assert_eq!(fs::read(app.join("run.cmd")).unwrap(), OLD_APP);
        assert_eq!(fs::read(app.join("keep.txt")).unwrap(), b"untouched");
        assert!(!app.join("added.dll").exists(), "a file the update added is removed");
        assert!(!r.join("update").exists());
        // the old app was started: wait for the file it writes (the real signal), at most 10 s
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !app.join("old-started.txt").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(app.join("old-started.txt").exists(), "the previous version was started");
        let _ = fs::remove_dir_all(r.parent().unwrap());
    }

    #[test]
    fn a_repair_copies_only_the_listed_files() {
        let r = root("repair");
        let app = r.join("app");
        fs::create_dir_all(app.join("uassettool")).unwrap();
        fs::write(app.join("uassettool").join("old.pdb"), b"left alone").unwrap();
        let (code, app) = run(&r, &[("repakxtra.exe", b"new exe"), ("UAssetTool.dll", b"fixed"), ("data/x.json", b"{}")],
            "repakxtra.exe", &[("RX_TEST", "1"), ("RX_ONLY", "UAssetTool.dll\ndata\\x.json")]);
        assert_eq!(code, Some(0));
        assert_eq!(fs::read(app.join("repakxtra.exe")).unwrap(), b"old exe", "not listed, not copied");
        assert_eq!(fs::read(app.join("UAssetTool.dll")).unwrap(), b"fixed");
        assert_eq!(fs::read(app.join("data").join("x.json")).unwrap(), b"{}");
        assert!(app.join("uassettool").join("old.pdb").exists(), "a repair cleans up nothing");
        let _ = fs::remove_dir_all(r.parent().unwrap());
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
