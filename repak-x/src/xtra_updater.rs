//! repakxtra: applies a downloaded update zip after the app closes. The script is fixed text and every path reaches it
//! through an environment variable (as xtra_shortcut.rs does), so an apostrophe, percent sign, dollar sign or bracket
//! in a Windows user name or install folder can no longer change what runs. Files the update replaces are copied to
//! a backup first and put back if copying fails, so a failed update keeps the old version working.

use std::path::{Path, PathBuf};

/// Where downloads land. apply_update only accepts a file directly inside it.
pub fn update_dir() -> PathBuf {
    std::env::temp_dir().join("repakxtra_update")
}

/// One plain file name Windows accepts (no folders, drive, stream, device name or trailing dot or space), so joining
/// it to update_dir can only name a file directly inside it.
pub fn safe_file_name(name: &str) -> bool {
    const RESERVED: [&str; 22] = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
        "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    !name.is_empty()
        && name.len() <= 200
        && name != "."
        && name != ".."
        && !name.ends_with('.')
        && !name.ends_with(' ')
        && !name.chars().any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
        && !RESERVED.contains(&stem.as_str())
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

# What the app started from its own folder (UAssetTool's command line, mid-extract) can outlive it and keeps its files in
# use: it gets a moment to finish, then it is stopped. Only programs the app ships (an .exe name in the update, or the
# app's own), so another program run from the same folder (a flat zip unpacked into Downloads) is never stopped. The
# folder by both names: the dist\repakxtra link and its target. Every path through Get-Item, which spells it out in full
# (a short 8.3 RUNNER~1 and its long name compare equal). Never what stops an update: a failure here leaves the copy
# below to try
try {
    $shipped = @(Get-ChildItem -LiteralPath $src -Recurse -File -Filter '*.exe' | ForEach-Object { $_.Name }) + @(Split-Path $exe -Leaf)
    $long = { param($p) try { (Get-Item -LiteralPath $p -ErrorAction Stop).FullName } catch { $p } }
    $roots = @((& $long $app).TrimEnd('\') + '\')
    $linked = (Get-Item -LiteralPath $app).Target
    if ($linked) { $roots += @($linked | ForEach-Object { (& $long $_).TrimEnd('\') + '\' }) }
    function Left {
        @(Get-Process | Where-Object {
            $p = try { $_.Path } catch { $null }
            if ($p) { $p = & $long $p }
            $p -and $shipped -contains (Split-Path $p -Leaf) -and @($roots | Where-Object { $p.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count
        })
    }
    $deadline = (Get-Date).AddSeconds($(if ($env:RX_WAIT) { [int]$env:RX_WAIT } else { 30 }))
    while (@(Left).Count -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
    $stop = @(Left)
    $stop | Stop-Process -Force -ErrorAction SilentlyContinue
    $stop | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
} catch { }

# Copy every file (a repair: only the ones RX_ONLY lists), keeping a backup of each one it replaces
$backup = Join-Path $temp 'previous'
$copied = New-Object System.Collections.Generic.List[string]
$only = @($env:RX_ONLY -split "`n" | Where-Object { $_ })
# Puts every backed up file back and removes the ones the update added. Returns how many could not be
function Restore {
    $failed = 0
    foreach ($rel in $copied) {
        $b = Join-Path $backup $rel
        $dest = Join-Path $app $rel
        $part = "$dest.repakxtra-part"
        Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
        try {
            # staged and swapped in whole, as the update's copies are: a kill mid-restore never leaves half a file
            if (Test-Path -LiteralPath $b) {
                Copy-Item -LiteralPath $b -Destination $part -Force -ErrorAction Stop
                if (Test-Path -LiteralPath $dest) { [IO.File]::Replace($part, $dest, [NullString]::Value) } else { [IO.File]::Move($part, $dest) }
            }
            elseif (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force -ErrorAction Stop }
        } catch { $failed++ }
    }
    $failed
}
$broken = 'Download repakxtra again from github.com/cablemp5/repak-xtra/releases'
# What a killed update (power cut, Task Manager) leaves for the app's next start (xtra_updater.rs recover_killed_update):
# this script's process and when it started (a reused process id is not it), the folders, the files it began copying,
# and its phase: copying, copied (every file in), or restoring (putting the previous version back). Written whole to a
# side file and swapped in, so a kill mid-write never leaves a cut-off record
$state = Join-Path $temp 'state.json'
$me = Get-Process -Id $PID
$since = [DateTimeOffset]::new($me.StartTime).ToUnixTimeSeconds()
function Save-State([string]$phase) {
    $next = "$state.next"
    [IO.File]::WriteAllText($next, (@{ pid = $PID; started = $since; phase = $phase; app = $app; src = $src; files = @($copied) } | ConvertTo-Json -Compress))
    if (Test-Path -LiteralPath $state) { [IO.File]::Replace($next, $state, [NullString]::Value) } else { [IO.File]::Move($next, $state) }
}
$exeName = Split-Path $exe -Leaf
try {
    # The app's exe last: a kill part way leaves the previous exe in place, and it puts the rest back at its next start
    foreach ($f in @(Get-ChildItem -LiteralPath $src -Recurse -File | Sort-Object { $_.Name -ieq $exeName })) {
        $rel = $f.FullName.Substring($src.Length).TrimStart('\')
        if ($only.Count -and $only -notcontains $rel) { continue }
        $dest = Join-Path $app $rel
        if (Test-Path -LiteralPath $dest) {
            $b = Join-Path $backup $rel
            [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($b))
            Copy-Item -LiteralPath $dest -Destination $b -Force
        }
        # Listed before the copy: one that fails part way (disk full, a lock) is put back too
        $copied.Add($rel)
        Save-State 'copying'
        [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($dest))
        # Copied beside it, then swapped in: a kill mid-copy never leaves half a file (half an exe would not start)
        $part = "$dest.repakxtra-part"
        Copy-Item -LiteralPath $f.FullName -Destination $part -Force
        if (Test-Path -LiteralPath $dest) { [IO.File]::Replace($part, $dest, [NullString]::Value) } else { [IO.File]::Move($part, $dest) }
    }
    Save-State 'copied'
} catch {
    $err = $_.Exception.Message
    try { Save-State 'restoring' } catch { } # never what stops the rollback (a full disk can refuse it too)
    $bad = Restore
    # a file that could not go back: 'retry' has the next start (the one Fail opens) put it back, never wait for this script
    # (no record at all rather than 'restoring' with this script still alive: that would make the start below wait for it)
    if (-not $bad) { Remove-Item -LiteralPath $state -Force -ErrorAction SilentlyContinue } else { try { Save-State 'retry' } catch { Remove-Item -LiteralPath $state -Force -ErrorAction SilentlyContinue } }
    if ($bad) { Fail "The update could not be copied ($err), and $bad files could not be put back. $broken" }
    Fail "The update could not be copied ($err). The previous version was kept."
}

# The backups stay until the new version's window has loaded: it writes 'started' (xtra_started_ok). If that never comes
# within 60 s, the new process cannot start, or it exits with an error first, the previous version goes back and starts.
# A clean exit (code 0) before any window is a hand-off to a copy that is already open (one instance at a time): kept
if ($env:RX_TEST -ne '1') {
    $marker = Join-Path $temp 'started'
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    $new = $null
    try { $new = Start-Process -FilePath $exe -PassThru; $null = $new.Handle } catch { } # the handle keeps its exit code readable
    if ($env:RX_CHECK -eq '1') {
        if ($new) {
            $deadline = (Get-Date).AddSeconds($(if ($env:RX_HEALTH) { [int]$env:RX_HEALTH } else { 60 }))
            while (-not (Test-Path -LiteralPath $marker) -and -not $new.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
        }
        $handedOff = $new -and $new.HasExited -and $new.ExitCode -eq 0
        if (-not (Test-Path -LiteralPath $marker) -and -not $handedOff) {
            if ($new) {
                Stop-Process -Id $new.Id -Force -ErrorAction SilentlyContinue
                $null = $new.WaitForExit(10000) # its files stay locked until it is gone
            }
            try { $left = @(Left); $left | Stop-Process -Force -ErrorAction SilentlyContinue; $left | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue } catch { }
            try { Save-State 'restoring' } catch { }
            $bad = Restore
            # the backups stay when a file could not be put back: the next start (opened below) tries again
            if (-not $bad) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue } else { try { Save-State 'retry' } catch { Remove-Item -LiteralPath $state -Force -ErrorAction SilentlyContinue } }
            try { Start-Process -FilePath $exe } catch { }
            if ($bad) { Say "The new version did not start, and $bad files of the previous one could not be put back. $broken" }
            else { Say 'The new version did not start, so repakxtra went back to the previous one.' }
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
/// keeps the replaced files until the new version reports a loaded window. `only`: just these zip files (a repair).
pub fn launch_zip(zip: &Path, app_dir: &Path, exe: &Path, only: &[String]) -> Result<(), String> {
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
        .env("RX_CHECK", "1")
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
        let _ = std::fs::write(dir.join("started"), b"ok");
    }
}

/// What recover_killed_update found.
#[derive(Debug, PartialEq)]
pub enum Recovery {
    /// No update was cut off.
    Nothing,
    /// An update is copying or putting the previous version back right now: this start must not use the app's files
    /// (the update starts the app itself once it is done).
    Busy,
    /// A cut-off update was finished or undone: what was done, for the log.
    Done(String),
    /// Undone while this start runs the update's exe: the previous exe is back in place, so this start opens it and ends.
    Restart(String),
}

/// At start: an update whose script was killed part way (power cut, Task Manager) left its state file and backups in the
/// update folder, with nothing to finish or undo it. While it was copying, the previous exe was still in place (the
/// script copies it last), so the files it began copying are put back from the backup and the ones it added go. Once
/// every file was in, or the new exe already is, the update is kept. One killed while putting the previous version back
/// (restoring) is always put back. Either way the update folder goes, unless a file could not be put back (the next
/// start tries again).
pub fn recover_killed_update() -> Recovery {
    let Some(exe) = std::env::current_exe().ok() else { return Recovery::Nothing };
    let (Some(dir), Some(name)) = (exe.parent(), exe.file_name().and_then(|n| n.to_str())) else { return Recovery::Nothing };
    recover_in(&update_dir(), dir, name, |pid, started| {
        use sysinfo::{ProcessRefreshKind, RefreshKind, System};
        let s = System::new_with_specifics(RefreshKind::new().with_processes(ProcessRefreshKind::new()));
        // the same process, not another one that got its id after a restart
        s.process(sysinfo::Pid::from_u32(pid)).is_some_and(|p| p.start_time().abs_diff(started) <= 2)
    })
}

fn recover_in(dir: &Path, app: &Path, exe_name: &str, alive: impl Fn(u32, u64) -> bool) -> Recovery {
    recover_state(dir, app, exe_name, alive).unwrap_or(Recovery::Nothing)
}

fn recover_state(dir: &Path, app: &Path, exe_name: &str, alive: impl Fn(u32, u64) -> bool) -> Option<Recovery> {
    // the exe a recovery moved aside while it ran (below) can go once that start has ended
    let mut aside = app.join(exe_name).into_os_string();
    aside.push(".repakxtra-old");
    let _ = std::fs::remove_file(PathBuf::from(aside));
    let text = std::fs::read_to_string(dir.join("state.json")).ok()?;
    let state: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let same = |a: &Path, b: &Path| matches!((std::fs::canonicalize(a), std::fs::canonicalize(b)), (Ok(a), Ok(b)) if a == b);
    if !same(Path::new(state["app"].as_str()?), app) { return None } // another install's update
    let phase = state["phase"].as_str()?;
    // 'retry': the script is done, and it opened this start to put back what it could not
    if phase != "retry" && alive(u32::try_from(state["pid"].as_u64()?).ok()?, state["started"].as_u64().unwrap_or_default()) {
        // still at work: after "copied" it is the new version's start check, which this start is
        return Some(if phase == "copied" { Recovery::Nothing } else { Recovery::Busy });
    }
    // only plain relative names, so nothing outside the app folder or the backup is ever touched
    let files: Vec<PathBuf> = state["files"].as_array()?.iter().filter_map(|f| f.as_str()).map(PathBuf::from)
        .filter(|p| p.components().all(|c| matches!(c, std::path::Component::Normal(_)))).collect();
    let src = Path::new(state["src"].as_str().unwrap_or_default());
    let hash = |p: &Path| crate::xtra_update::sha256_file(p).ok();
    let exe_in = files.iter().any(|f| f.as_os_str().eq_ignore_ascii_case(exe_name))
        && hash(&app.join(exe_name)).is_some_and(|h| Some(h) == hash(&src.join(exe_name)));
    if phase == "copied" || (phase == "copying" && exe_in) {
        let _ = std::fs::remove_dir_all(dir);
        return Some(Recovery::Done(format!("A cut-off update had copied every file: kept it ({} files)", files.len())));
    }
    let mut failed = 0;
    let mut restart = false;
    for rel in &files {
        let (b, d) = (dir.join("previous").join(rel), app.join(rel));
        let with = |ext: &str| { let mut p = d.as_os_str().to_owned(); p.push(ext); PathBuf::from(p) };
        let part = with(".repakxtra-part");
        let _ = std::fs::remove_file(&part); // a copy staged when the update was cut off
        let done = if !b.is_file() {
            !d.exists() || std::fs::remove_file(&d).is_ok()
        } else if hash(&d).is_some() && hash(&d) == hash(&b) {
            true // already the previous file (the exe the script had not reached yet)
        } else {
            // the running exe cannot be overwritten, but it can be renamed: moved aside, the previous one goes in, and this
            // start reopens as the previous version
            let running = rel.as_os_str().eq_ignore_ascii_case(exe_name);
            // staged first, so the only gap with no exe under its name is between two renames, and a failed second rename
            // puts the running one back
            let staged = std::fs::copy(&b, &part).is_ok();
            let aside = with(".repakxtra-old");
            let moved = staged && (!running || std::fs::rename(&d, &aside).is_ok());
            let ok = moved && std::fs::rename(&part, &d).is_ok(); // whole, never half a file
            if moved && !ok && running { let _ = std::fs::rename(&aside, &d); }
            if !ok { let _ = std::fs::remove_file(&part); }
            restart |= ok && running;
            ok
        };
        if !done { failed += 1 }
    }
    let said = if failed == 0 {
        let _ = std::fs::remove_dir_all(dir);
        format!("A cut-off update was undone: {} files put back", files.len())
    } else {
        format!("A cut-off update was undone, but {failed} files could not be put back (tried again at the next start)")
    };
    Some(if restart { Recovery::Restart(said) } else { Recovery::Done(said) })
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

    #[test]
    fn update_file_names_stay_in_the_update_folder() {
        assert!(safe_file_name("repak-xtra-v0.46.0-windows.zip"));
        for bad in ["", "..", "../a.zip", "a\\b.zip", "C:a.zip", "a.zip:x", "con.zip", "a.zip.", "a.zip "] {
            assert!(!safe_file_name(bad), "{bad}");
        }
    }

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
    const STARTS: &[u8] = b"@echo ok> \"%RX_TEMP%\\started\"\r\n";
    const EXITS: &[u8] = b"@exit /b 1\r\n";
    const HANDS_OFF: &[u8] = b"@exit /b 0\r\n"; // what a second copy does while one is already open
    const HANGS: &[u8] = b"@ping -n 30 127.0.0.1 >nul\r\n"; // runs but never loads a window

    /// A folder without shell characters: cmd.exe cannot start a .cmd under one with "&" (a real exe can, the copy tests
    /// above cover those names).
    fn plain_root(tag: &str) -> PathBuf {
        let r = std::env::temp_dir().join(format!("repakxtra-updater-{tag}-{}", std::process::id())).join("install");
        let _ = fs::remove_dir_all(r.parent().unwrap());
        fs::create_dir_all(&r).unwrap();
        r
    }

    fn started_app(r: &Path, new_app: &[u8]) -> (Option<i32>, PathBuf) {
        started_app_with(r, new_app, &[])
    }

    fn started_app_with(r: &Path, new_app: &[u8], env: &[(&str, &str)]) -> (Option<i32>, PathBuf) {
        let app = r.join("app");
        fs::create_dir_all(&app).unwrap();
        fs::write(app.join("run.cmd"), OLD_APP).unwrap();
        run(r, &[("repakxtra.exe", b"new exe"), ("run.cmd", new_app), ("added.dll", b"new only")], "run.cmd",
            &[&[("RX_TEST", "2"), ("RX_CHECK", "1")], env].concat())
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
    fn a_new_version_that_never_loads_is_rolled_back_when_the_wait_ends() {
        let r = plain_root("hangs");
        let (code, app) = started_app_with(&r, HANGS, &[("RX_HEALTH", "3")]);
        assert_eq!(code, Some(2));
        assert_eq!(fs::read(app.join("repakxtra.exe")).unwrap(), b"old exe");
        assert_eq!(fs::read(app.join("run.cmd")).unwrap(), OLD_APP);
        assert!(!app.join("added.dll").exists());
        let _ = fs::remove_dir_all(r.parent().unwrap());
    }

    #[test]
    fn a_hand_off_to_an_open_copy_keeps_the_update() {
        let r = plain_root("handoff");
        let (code, app) = started_app(&r, HANDS_OFF);
        assert_eq!(code, Some(0));
        assert_eq!(fs::read(app.join("repakxtra.exe")).unwrap(), b"new exe");
        assert!(!r.join("update").exists());
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
        // a_first.dat is replaced, then an open handle without sharing makes z_locked.dat fail: a_first.dat goes back
        let app = r.join("app");
        fs::create_dir_all(&app).unwrap();
        fs::write(app.join("a_first.dat"), b"old a").unwrap();
        fs::write(app.join("z_locked.dat"), b"old").unwrap();
        use std::os::windows::fs::OpenOptionsExt;
        let lock = fs::OpenOptions::new().read(true).share_mode(0).open(app.join("z_locked.dat")).unwrap();
        let (ok, app) = apply(&r, &[("repakxtra.exe", b"new exe"), ("a_first.dat", b"new a"), ("b_added.dat", b"new only"), ("z_locked.dat", b"new")]);
        drop(lock);
        assert!(!ok);
        assert_eq!(fs::read(app.join("a_first.dat")).unwrap(), b"old a", "a file copied before the failure is put back");
        assert!(!app.join("b_added.dat").exists(), "a file it added goes");
        assert_eq!(fs::read(app.join("z_locked.dat")).unwrap(), b"old");
        assert_eq!(fs::read(app.join("repakxtra.exe")).unwrap(), b"old exe");
        assert!(!r.join("update").join("state.json").exists(), "everything went back: nothing left for the next start");
        let _ = fs::remove_dir_all(r.parent().unwrap());
    }

    #[test]
    fn a_program_the_app_does_not_ship_survives_the_update() {
        let r = root("foreign");
        let other = r.join("app").join("tools");
        fs::create_dir_all(&other).unwrap();
        // another program started from under the app's folder (a flat zip unpacked into Downloads): never stopped
        let stub = other.join("other-tool.exe");
        fs::copy(r"C:\Windows\System32\PING.EXE", &stub).unwrap();
        let mut foreign = std::process::Command::new(&stub).args(["-n", "60", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
        let (ok, _) = apply(&r, &[("repakxtra.exe", b"new exe")]);
        let survived = foreign.try_wait().unwrap().is_none();
        let _ = foreign.kill();
        let _ = foreign.wait();
        assert!(ok, "the update went in");
        assert!(survived, "the foreign program kept running");
        let _ = fs::remove_dir_all(r.parent().unwrap());
    }

    /// A made-up killed update: `app` holds what was copied, `previous` the backups, `src` the unpacked update.
    fn killed(tag: &str, phase: &str, files: &[&str]) -> (PathBuf, PathBuf, PathBuf) {
        let r = plain_root(tag);
        let (dir, app) = (r.join("update"), r.join("app"));
        for d in [dir.join("previous"), dir.join("extracted"), app.clone()] { fs::create_dir_all(d).unwrap() }
        fs::write(dir.join("previous").join("a.dll"), b"old a").unwrap();
        fs::write(dir.join("previous").join("repakxtra.exe"), b"old exe").unwrap();
        fs::write(dir.join("extracted").join("repakxtra.exe"), b"new exe").unwrap();
        fs::write(app.join("a.dll"), b"new a").unwrap();
        fs::write(app.join("added.dll"), b"new only").unwrap();
        fs::write(app.join("repakxtra.exe"), b"old exe").unwrap();
        fs::write(app.join("keep.txt"), b"untouched").unwrap();
        let state = serde_json::json!({ "pid": 1, "phase": phase, "app": app, "src": dir.join("extracted"), "files": files });
        fs::write(dir.join("state.json"), state.to_string()).unwrap();
        (r, dir, app)
    }

    #[test]
    fn a_killed_update_is_undone_at_the_next_start() {
        let (r, dir, app) = killed("undo", "copying", &["a.dll", "added.dll", "..\\..\\outside.txt"]);
        let Recovery::Done(said) = recover_in(&dir, &app, "repakxtra.exe", |_, _| false) else { panic!("nothing done") };
        assert!(said.contains("undone"), "{said}");
        assert_eq!(fs::read(app.join("a.dll")).unwrap(), b"old a");
        assert!(!app.join("added.dll").exists(), "a file the update added goes");
        assert_eq!(fs::read(app.join("keep.txt")).unwrap(), b"untouched");
        assert!(!dir.exists(), "the update folder goes");
        let _ = fs::remove_dir_all(r.parent().unwrap());
    }

    #[test]
    fn a_killed_update_with_every_file_in_is_kept() {
        for (tag, phase, files) in [("copied", "copied", &["a.dll", "added.dll"][..]), ("exe-in", "copying", &["a.dll", "added.dll", "repakxtra.exe"][..])] {
            let (r, dir, app) = killed(tag, phase, files);
            if tag == "exe-in" { fs::write(app.join("repakxtra.exe"), b"new exe").unwrap() } // the exe, copied last, is in
            let Recovery::Done(said) = recover_in(&dir, &app, "repakxtra.exe", |_, _| false) else { panic!("{tag}: nothing done") };
            assert!(said.contains("kept"), "{tag}: {said}");
            assert_eq!(fs::read(app.join("a.dll")).unwrap(), b"new a", "{tag}");
            assert!(app.join("added.dll").exists(), "{tag}");
            assert!(!dir.exists(), "{tag}");
            let _ = fs::remove_dir_all(r.parent().unwrap());
        }
    }

    #[test]
    fn a_rollback_cut_off_is_always_finished() {
        // killed while putting the previous version back, with the new exe already in: never kept as an update
        let (r, dir, app) = killed("restoring", "restoring", &["a.dll", "added.dll", "repakxtra.exe"]);
        fs::write(app.join("repakxtra.exe"), b"new exe").unwrap();
        fs::write(app.join("a.dll.repakxtra-part"), b"half").unwrap();
        let Recovery::Restart(said) = recover_in(&dir, &app, "repakxtra.exe", |_, _| false) else { panic!("nothing done") };
        assert!(said.contains("undone"), "{said}");
        assert_eq!(fs::read(app.join("repakxtra.exe")).unwrap(), b"old exe");
        assert_eq!(fs::read(app.join("a.dll")).unwrap(), b"old a");
        assert!(!app.join("added.dll").exists() && !app.join("a.dll.repakxtra-part").exists());
        assert!(!dir.exists());
        let _ = fs::remove_dir_all(r.parent().unwrap());
    }

    #[test]
    fn a_rollback_that_finds_the_new_exe_puts_the_old_one_back_and_reopens() {
        let (r, dir, app) = killed("reopen", "restoring", &["a.dll", "repakxtra.exe"]);
        fs::write(app.join("repakxtra.exe"), b"new exe").unwrap(); // the exe this start runs
        let Recovery::Restart(said) = recover_in(&dir, &app, "repakxtra.exe", |_, _| false) else { panic!("no reopen") };
        assert!(said.contains("undone"), "{said}");
        assert_eq!(fs::read(app.join("repakxtra.exe")).unwrap(), b"old exe");
        assert_eq!(fs::read(app.join("repakxtra.exe.repakxtra-old")).unwrap(), b"new exe", "the running one, moved aside");
        assert_eq!(fs::read(app.join("a.dll")).unwrap(), b"old a");
        assert!(!dir.exists());
        // the reopened start clears the moved-aside exe
        assert_eq!(recover_in(&dir, &app, "repakxtra.exe", |_, _| false), Recovery::Nothing);
        assert!(!app.join("repakxtra.exe.repakxtra-old").exists());
        let _ = fs::remove_dir_all(r.parent().unwrap());
    }

    #[test]
    fn a_retry_is_put_back_even_while_the_script_ends() {
        let (r, dir, app) = killed("retry", "retry", &["a.dll"]);
        let Recovery::Done(said) = recover_in(&dir, &app, "repakxtra.exe", |_, _| true) else { panic!("not put back") };
        assert!(said.contains("undone"), "{said}");
        assert_eq!(fs::read(app.join("a.dll")).unwrap(), b"old a");
        let _ = fs::remove_dir_all(r.parent().unwrap());
    }

    #[test]
    fn the_new_versions_start_during_the_check_is_left_alone() {
        let (r, dir, app) = killed("check", "copied", &["a.dll"]);
        assert_eq!(recover_in(&dir, &app, "repakxtra.exe", |_, _| true), Recovery::Nothing, "the script waits on this start");
        assert!(dir.join("state.json").exists());
        let _ = fs::remove_dir_all(r.parent().unwrap());
    }

    #[test]
    fn an_update_still_running_or_for_another_install_is_left_alone() {
        let (r, dir, app) = killed("alive", "copying", &["a.dll"]);
        assert_eq!(recover_in(&dir, &app, "repakxtra.exe", |_, _| true), Recovery::Busy, "its script is still copying: this start waits");
        assert_eq!(recover_in(&dir, &r.join("elsewhere"), "repakxtra.exe", |_, _| false), Recovery::Nothing, "another folder's update");
        assert_eq!(fs::read(app.join("a.dll")).unwrap(), b"new a");
        assert!(dir.join("state.json").exists());
        let _ = fs::remove_dir_all(r.parent().unwrap());
    }

    #[test]
    fn the_real_script_killed_mid_copy_is_undone_at_the_next_start() {
        let r = plain_root("kill");
        let (temp, app) = (r.join("update"), r.join("app"));
        fs::create_dir_all(app.join("data")).unwrap();
        fs::create_dir_all(&temp).unwrap();
        fs::write(app.join("repakxtra.exe"), b"old exe").unwrap();
        // many files, so the copy is still under way when it is killed
        let names: Vec<String> = (0..2000).map(|i| format!("data/f{i:04}.json")).collect();
        for n in names.iter().step_by(2) { fs::write(app.join(n), b"old").unwrap() }
        let mut files: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), &b"new"[..])).collect();
        files.push(("repakxtra.exe", b"new exe"));
        zip_with(&temp.join("u.zip"), &files);
        let mut gone = std::process::Command::new("cmd").args(["/c", "exit"]).spawn().unwrap();
        gone.wait().unwrap();
        let mut script = powershell(APPLY_ZIP).env("RX_PID", gone.id().to_string()).env("RX_ZIP", temp.join("u.zip")).env("RX_TEMP", &temp)
            .env("RX_APP", &app).env("RX_EXE", app.join("repakxtra.exe")).env("RX_TEST", "1").spawn().unwrap();
        // the signal: the state file says at least 20 files are under way
        let state = temp.join("state.json");
        let copying = || fs::read_to_string(&state).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(t.trim_start_matches('\u{feff}')).ok())
            .is_some_and(|v| v["phase"] == "copying" && v["files"].as_array().is_some_and(|f| f.len() >= 20));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while !copying() && std::time::Instant::now() < deadline { std::thread::sleep(std::time::Duration::from_millis(20)) }
        let _ = script.kill();
        let _ = script.wait();
        assert!(fs::read_to_string(&state).is_ok_and(|t| t.contains("copying")), "killed while copying");
        assert_eq!(fs::read(app.join("repakxtra.exe")).unwrap(), b"old exe", "the exe goes last");
        let Recovery::Done(said) = recover_in(&temp, &app, "repakxtra.exe", |_, _| false) else { panic!("nothing done") };
        assert!(said.contains("undone"), "{said}");
        for (i, n) in names.iter().enumerate() {
            let now = fs::read(app.join(n)).ok();
            assert_eq!(now.as_deref(), if i % 2 == 0 { Some(&b"old"[..]) } else { None }, "{n}");
        }
        assert!(!temp.exists());
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
