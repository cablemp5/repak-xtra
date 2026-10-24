# Release build, same steps as .github/workflows/release.yml.
#   .\build.ps1        the stable app: only from a clean main. Output: dist\Repak-X-Stable (or -next), opened as dist\repakxtra\repakxtra.exe
#   .\build.ps1 -Test  whatever is in the folder now, even uncommitted edits. Output: dist\Repak-X-Test
#   .\build.ps1 -Release  main, as repakxtra v<REPAKXTRA_VERSION> (custom/version.ts): builds dist\Repak-X-Release, zips it as
#                      dist\repak-xtra-v<ver>-windows.zip and copies the gh command that publishes it. Once published, running
#                      copies offer it in Settings > Updates. Bump the version in the PR before releasing.
# The two never overwrite each other. The app runs one copy at a time (single-instance) and both share %APPDATA%\Repak-X.
# Neither touches the desktop: point a shortcut at dist\repakxtra\repakxtra.exe once and it always opens the newest stable build.
param([switch]$Test, [switch]$Release)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not $Test) {
    $branch = (git rev-parse --abbrev-ref HEAD)
    $dirty = @(git status --porcelain --untracked-files=no -- . ':!repak-x/gen/schemas')
    if ($branch -ne 'main' -or $dirty) { throw "The stable build comes from a clean main (this is '$branch'). Use .\build.ps1 -Test to try anything else." }
}
if ($Release) {
    git fetch -q origin main
    if ((git rev-parse HEAD) -ne (git rev-parse origin/main)) { throw 'Release what GitHub has: run git pull on main first.' }
    $ver = [regex]::Match((Get-Content -Raw repak-x\src\custom\version.ts), "REPAKXTRA_VERSION = '([^']+)'").Groups[1].Value
    if (-not $ver) { throw 'No REPAKXTRA_VERSION in repak-x\src\custom\version.ts.' }
    # cmd swallows gh's "release not found" (the answer wanted here): PowerShell 5.1 would make that stderr line a fatal error
    cmd /c "gh release view v$ver -R cablemp5/repak-xtra >nul 2>&1"
    if ($LASTEXITCODE -eq 0) { throw "v$ver is already released: bump REPAKXTRA_VERSION in custom/version.ts (in a PR) first." }
}
# vswhere: the .NET NativeAOT linker step calls it to find MSVC
$env:PATH = "$env:USERPROFILE\.cargo\bin;${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer;$env:PATH"

function Run([scriptblock]$cmd) { & $cmd; if ($LASTEXITCODE -ne 0) { throw "Failed: $cmd" } }

# A running copy locks its exe; package into whichever of the two folders is not in use.
# dist\repakxtra links to the newest stable folder, and a copy opened through it reports the link's path: map that to the real folder
$link = 'dist\repakxtra'
$linked = if (Test-Path $link) { "$((Get-Item $link).Target)" }
# REPAK-X: the exe's name in builds made before it shipped as repakxtra.exe
$running = @(Get-Process repakxtra, REPAK-X -ErrorAction SilentlyContinue | ForEach-Object {
    if ($linked) { $_.Path -replace [regex]::Escape("$PSScriptRoot\$link"), $linked } else { $_.Path } })
if ($Release) {
    $out = 'dist\Repak-X-Release'   # never run from, so a fresh folder holds exactly what ships
    if (Test-Path $out) { Remove-Item $out -Recurse -Force }
} elseif ($Test) {
    $out = 'dist\Repak-X-Test'
    if ($running -match [regex]::Escape("\$out\")) { throw 'Close the test copy of repakxtra first.' }
} else {
    $out = 'dist\Repak-X-Stable'
    if ($running -match [regex]::Escape('\dist\Repak-X-Stable\')) { $out = 'dist\Repak-X-Stable-next' }
    if ($running -match [regex]::Escape("\$out\")) { throw 'Close repakxtra first: both output folders are in use.' }
}

Run { dotnet publish UAssetToolRivals/src/UAssetTool/UAssetToolNative.csproj -c Release -r win-x64 -p:DebugType=none -p:DebugSymbols=false -o target/uassettool }
# UAssetTool's command line from the same source, native (no .NET install needed): the app runs it for IoStore extracts,
# which it does in parallel where the library's JSON request goes one package at a time (xtra_uat_cli.rs, 2.8x faster).
# The native link step looks for vswhere, which lives in the Visual Studio Installer folder
$vsInstaller = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer'
if ((Test-Path $vsInstaller) -and ($env:PATH -notlike "*$vsInstaller*")) { $env:PATH = "$vsInstaller;$env:PATH" }
Run { dotnet publish UAssetToolRivals/src/UAssetTool/UAssetTool.csproj -c Release -r win-x64 -p:PublishAot=true -p:PublishSingleFile=false -p:IlcOptimizationPreference=Speed -p:DebugType=none -p:DebugSymbols=false -o target/uassettool-cli }
Push-Location repak-x
Run { npm install }
# Test copies mark themselves (green "xtra", "test build" in the version line, a green taskbar icon from
# xtra_buildmark.rs); stable and release builds never do
$env:VITE_REPAKXTRA_TEST = if ($Test) { '1' } else { '' }
$env:REPAKXTRA_BUILD = if ($Test) { 'test' } else { '' }
Run { npm run build }
Pop-Location
$env:SKIP_UASSET_TOOL_BUILD = '1'
Run { cargo build --release --target x86_64-pc-windows-msvc --features custom-protocol }

New-Item -ItemType Directory -Force "$out\data" | Out-Null
# cargo names the exe after upstream's bin (REPAK-X); it ships as repakxtra.exe. An older build's REPAK-X.exe goes, so a
# shortcut still pointing at it fails instead of opening a stale copy.
Copy-Item target\x86_64-pc-windows-msvc\release\REPAK-X.exe "$out\repakxtra.exe" -Force
Copy-Item target\uassettool\* $out -Recurse -Force
Remove-Item "$out\*.pdb", "$out\UAssetTool.exe", "$out\REPAK-X.exe" -ErrorAction SilentlyContinue
Copy-Item target\uassettool-cli\UAssetTool.exe "$out\uassettool-cli.exe" -Force
Copy-Item repak-x\src\data\character_data.json "$out\data" -Force
if (-not $Test -and -not $Release) {
    # repoint dist\repakxtra at the build just made (rmdir removes only the link, never the folder it points to)
    if (Test-Path $link) { Run { cmd /c rmdir $link } }
    New-Item -ItemType Junction -Path $link -Target (Resolve-Path $out).Path | Out-Null
}
Write-Host "Built: $out\repakxtra.exe" -ForegroundColor Green
if ($Release) {
    # Windows' own tar (bsdtar, Windows 10+) writes a zip with forward-slash entries; the in-app updater unzips it over
    # the app folder. By full path: from Git Bash, PATH finds GNU tar first, which ignores -a and writes a tar named .zip
    $zip = "dist\repak-xtra-v$ver-windows.zip"
    Remove-Item $zip -ErrorAction SilentlyContinue
    Run { & "$env:SystemRoot\System32\tar.exe" -a -cf $zip -C $out repakxtra.exe UAssetTool.dll uassettool-cli.exe data }
    # Unpacked the way the in-app updater does (Windows PowerShell's Expand-Archive): the zip must give back the same app
    $check = Join-Path $env:TEMP "repakxtra-release-check-$PID"
    Remove-Item $check -Recurse -Force -ErrorAction SilentlyContinue
    try {
        & powershell -NoProfile -Command "`$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath '$((Resolve-Path $zip).Path)' -DestinationPath '$check' -Force"
        $same = $LASTEXITCODE -eq 0 -and (Test-Path "$check\repakxtra.exe") -and
            (Get-FileHash "$check\repakxtra.exe").Hash -eq (Get-FileHash "$out\repakxtra.exe").Hash
        if (-not $same) { throw "$zip does not unpack to this build: the in-app updater could not install it. Nothing to publish." }
    } finally { Remove-Item $check -Recurse -Force -ErrorAction SilentlyContinue }
    $hash = (Get-FileHash $zip).Hash.ToLower()
    Write-Host "Packed: $zip (SHA-256 $hash)" -ForegroundColor Green
    # Release notes (cable's format, 2026-10-17): a Downloads table (the zip and its checksum) and a Changelog of short
    # lines from release-notes\v<ver>.md. No version bump line, generated "What's changed", PR or author lines
    $name = Split-Path $zip -Leaf
    $sum = "$zip.sha256"
    [IO.File]::WriteAllText((Join-Path $PWD $sum), "$hash  $name`n")
    $changes = "release-notes\v$ver.md"
    if (-not (Test-Path $changes)) { throw "Write $changes first: one '- ' line per change, like '- Add card zoom to the Loadouts screen'." }
    $lines = @(Get-Content $changes | Where-Object { $_ -match '^\s*[-*]\s+\S' } | ForEach-Object { '- ' + ($_ -replace '^\s*[-*]\s+', '') })
    if (-not $lines.Count) { throw "$changes has no '- ' lines." }
    $url = "https://github.com/cablemp5/repak-xtra/releases/download/v$ver"
    $notes = "dist\release-notes-v$ver.md"
    $body = @('## Downloads', '', '| File | |', '| :---: | :---: |', "| [$name]($url/$name) | [checksum]($url/$name.sha256) |", '',
        '## Changelog', '') + $lines
    [IO.File]::WriteAllText((Join-Path $PWD $notes), ($body -join "`n") + "`n")
    Write-Host "Notes: $notes" -ForegroundColor Green
    # On the clipboard as one line: a wrapped terminal line copied by hand can pick up a line break and fail to parse
    $publish = "gh release create v$ver $zip $sum -R cablemp5/repak-xtra --target main --latest --title `"repak-xtra $ver`" --notes-file $notes"
    Set-Clipboard -Value $publish
    Write-Host 'The publish command is on the clipboard: paste it and press Enter:'
    Write-Host "  $publish"
}
if ($Test) { Write-Host 'The app runs one copy at a time: close the stable repakxtra before opening the test one, or you will just get the stable window.' -ForegroundColor Yellow }
