# Editions: .\build.ps1 -Test -Edition Standard | .\build.ps1 -Test -Edition Extended
# Release tags: v<version> for Standard; extended-v<version> for Extended, in the SAME repository.
# Extended's first build: add -SigeonArchive <path>. The staged ZIP is ignored by Git.
# Local builds are TEST ONLY. Stable applications update through the in-app updater.
# .\build.ps1 -Test -Edition Standard
# -Release prepares a separate update ZIP; it never replaces an installed stable app.
param(
    [switch]$Test,
    [switch]$Release,
    [switch]$SkipTools,
    [string]$SigeonArchive
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$isExtended = $Edition -ne 'Standard'
$editionName = if ($isExtended) { 'extended' } else { 'standard' }
$editionSuffix = if ($isExtended) { '-Extended' } else { '' }
$tagPrefix = if ($isExtended) { 'extended-v' } else { 'v' }
if (-not $Test -and -not $Release) { throw 'Stable apps update only through the app. Use -Test for local builds, or -Release to prepare separate update artifacts.' }
if ($Test -and $Release) { throw 'Choose -Test or -Release, not both.' }
if ($Release -and $SkipTools) { throw 'Release builds require clean main and freshly built tools.' }
if ($isExtended) {
    $unlockHash = Join-Path $PSScriptRoot 'repak-x\resources\extended\activation.sha256'
    if (-not (Test-Path -LiteralPath $unlockHash) -or (Get-Content -Raw -LiteralPath $unlockHash).Trim() -cnotmatch '^[0-9a-f]{64}$') {
        throw 'Configure the shared code first: powershell -File scripts/Set-ExtendedUnlockCode.ps1'
    }
    $staged = Join-Path $PSScriptRoot 'repak-x\resources\extended\ProjectSigeon.zip'
    if ($SigeonArchive) {
        $source = (Resolve-Path -LiteralPath $SigeonArchive).Path
        New-Item -ItemType Directory -Force (Split-Path $staged) | Out-Null
        if ($source -ne $staged) { Copy-Item -LiteralPath $source -Destination $staged -Force }
    }
    if (-not (Test-Path -LiteralPath $staged)) { throw 'Extended needs -SigeonArchive <path-to-ProjectSigeon-V2.0.0.zip> on its first build.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($staged)
    try {
        foreach ($extension in @('pak', 'utoc', 'ucas')) {
            if (-not $archive.GetEntry("Minimal/!ProjectSigeon_9999999_P.$extension")) { throw "Sigeon archive is missing the Minimal .$extension file." }
        }
    } finally { $archive.Dispose() }
}

if ($Release) {
    $branch = (git rev-parse --abbrev-ref HEAD)
    $dirty = @(git status --porcelain --untracked-files=no -- . ':!repak-x/gen/schemas')
    if ($branch -ne 'main' -or $dirty) { throw "The stable build comes from a clean main (this is '$branch'$(if ($dirty) { ", with changes in: $(($dirty | ForEach-Object { $_.Substring(3) }) -join ', ')" })). Use .\build.ps1 -Test to try anything else." }
}
if ($Release) {
    git fetch -q origin main
    if ((git rev-parse HEAD) -ne (git rev-parse origin/main)) { throw 'Release what GitHub has: run git pull on main first.' }
    $ver = [regex]::Match((Get-Content -Raw repak-x\src\custom\version.ts), "REPAKXTRA_VERSION = '([^']+)'").Groups[1].Value
    if (-not $ver) { throw 'No REPAKXTRA_VERSION in repak-x\src\custom\version.ts.' }
    # cmd swallows gh's "release not found" (the answer wanted here): PowerShell 5.1 would make that stderr line a fatal error
    cmd /c "gh release view $tagPrefix$ver -R cablemp5/repak-xtra >nul 2>&1"
    if ($LASTEXITCODE -eq 0) { throw "$tagPrefix$ver is already released: bump REPAKXTRA_VERSION in custom/version.ts (in a PR) first." }
}
# vswhere: the .NET NativeAOT linker step calls it to find MSVC
$env:PATH = "$env:USERPROFILE\.cargo\bin;${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer;$env:PATH"

function Run([scriptblock]$cmd) { & $cmd; if ($LASTEXITCODE -ne 0) { throw "Failed: $cmd" } }

# A junction can move while a process keeps running from its original target. Probe the files, not process paths.
. .\scripts\build-output.ps1
$link = "dist\repakxtra-Test$editionSuffix"
if ($Release) {
    $out = "dist\Repak-X-Release$editionSuffix"   # never run from, so a fresh folder holds exactly what ships
    if (-not (Test-BuildOutputAvailable $out)) { throw 'Close the release copy before rebuilding it.' }
    $releasePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $out))
    if (-not $releasePath.StartsWith((Join-Path $PSScriptRoot 'dist') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Release output escaped dist.' }
    if (Test-Path -LiteralPath $releasePath) { Remove-Item -LiteralPath $releasePath -Recurse -Force }
} elseif ($Test) {
    $out = Get-FreeBuildOutput "dist\Repak-X-Test$editionSuffix" "dist\Repak-X-Test-next$editionSuffix"
}

# repakxtra's fixes to UAssetToolRivals (uassettool-patches\, see its README): applied for the publish and taken out again,
# so the submodule stays upstream's and this script's clean-main check still passes
. .\uassettool-patches\apply.ps1
if ($SkipTools) {
    foreach ($tool in @('target\uassettool\UAssetTool.dll', 'target\uassettool-cli\UAssetTool.exe')) {
        if (-not (Test-Path -LiteralPath $tool)) { throw "Cannot reuse missing tool: $tool. Build once without -SkipTools." }
    }
} else {
Use-UatPatches {
    Remove-Item UAssetToolRivals\src\UAssetTool\obj, UAssetToolRivals\src\UAssetTool\bin -Recurse -Force -ErrorAction SilentlyContinue
    Run { dotnet publish UAssetToolRivals/src/UAssetTool/UAssetToolNative.csproj -c Release -r win-x64 -p:DebugType=none -p:DebugSymbols=false -o target/uassettool }
    # UAssetTool's command line from the same source, native (no .NET install needed): the app runs it for IoStore extracts,
    # which it does in parallel where the library's JSON request goes one package at a time (xtra_uat_cli.rs, 2.8x faster).
    # The native link step looks for vswhere, which lives in the Visual Studio Installer folder
    $vsInstaller = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer'
    if ((Test-Path $vsInstaller) -and ($env:PATH -notlike "*$vsInstaller*")) { $env:PATH = "$vsInstaller;$env:PATH" }
    # TrimMode=partial, as the library's project sets it: a full trim strips the field metadata UAssetAPI copies by
    # reflection (Export.ConvertToChildExport), and packing (create_mod_iostore) then failed on every asset
    Run { dotnet publish UAssetToolRivals/src/UAssetTool/UAssetTool.csproj -c Release -r win-x64 -p:PublishAot=true -p:TrimMode=partial -p:PublishSingleFile=false -p:IlcOptimizationPreference=Speed -p:DebugType=none -p:DebugSymbols=false -o target/uassettool-cli }
}
}
Push-Location repak-x
Run { npm install }
$env:VITE_REPAKXTRA_EDITION = $editionName
$env:VITE_REPAKXTRA_TEST = if ($Test) { '1' } else { '' }
$env:REPAKXTRA_BUILD = if ($Test) { 'test' } else { '' }
Run { npm run build }
Run { node scripts/check-edition.mjs }
Pop-Location
$env:SKIP_UASSET_TOOL_BUILD = '1'
$features = if ($isExtended) { 'custom-protocol,extended' } else { 'custom-protocol' }
Run { cargo build --release --target x86_64-pc-windows-msvc --features $features }

if (-not (Test-BuildOutputAvailable $out)) { throw 'The selected copy was opened during the build. Close it and run the build again.' }
New-Item -ItemType Directory -Force "$out\data" | Out-Null
[IO.File]::WriteAllText((Join-Path $PSScriptRoot "$out\edition.json"), "{`"edition`":`"$editionName`"}")
# cargo names the exe after upstream's bin (REPAK-X); it ships as repakxtra.exe. An older build's REPAK-X.exe goes, so a
# shortcut still pointing at it fails instead of opening a stale copy.
Copy-Item target\x86_64-pc-windows-msvc\release\REPAK-X.exe "$out\repakxtra.exe" -Force
Copy-Item target\uassettool\* $out -Recurse -Force
Remove-Item "$out\*.pdb", "$out\UAssetTool.exe", "$out\REPAK-X.exe" -ErrorAction SilentlyContinue
Copy-Item target\uassettool-cli\UAssetTool.exe "$out\uassettool-cli.exe" -Force
Copy-Item repak-x\src\data\character_data.json "$out\data" -Force
if ($Test) {
    # Remove only the known junction, never its target or an ordinary folder.
    if (Test-Path $link) {
        $junction = Get-Item -LiteralPath $link
        if (-not ($junction.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$link must be a junction; refusing to replace a folder." }
        [IO.Directory]::Delete($junction.FullName)
    }
    New-Item -ItemType Junction -Path $link -Target (Resolve-Path $out).Path | Out-Null
}
Write-Host "Built: $out\repakxtra.exe" -ForegroundColor Green
if ($Release) {
    # Windows' own tar (bsdtar, Windows 10+) writes a zip with forward-slash entries; the in-app updater unzips it over
    # the app folder. By full path: from Git Bash, PATH finds GNU tar first, which ignores -a and writes a tar named .zip
    $zip = "dist\repak-xtra-$editionName-v$ver-windows.zip"
    Remove-Item $zip -ErrorAction SilentlyContinue
    Run { & "$env:SystemRoot\System32\tar.exe" -a -cf $zip -C $out repakxtra.exe UAssetTool.dll uassettool-cli.exe data edition.json }
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
    $url = "https://github.com/cablemp5/repak-xtra/releases/download/$tagPrefix$ver"
    $notes = "dist\release-notes-$editionName-v$ver.md"
    $body = @('## Downloads', '', '| File | |', '| :---: | :---: |', "| [$name]($url/$name) | [checksum]($url/$name.sha256) |", '',
        '## Changelog', '') + $lines
    [IO.File]::WriteAllText((Join-Path $PWD $notes), ($body -join "`n") + "`n")
    Write-Host "Notes: $notes" -ForegroundColor Green
    # On the clipboard as one line: a wrapped terminal line copied by hand can pick up a line break and fail to parse
    $releaseFlags = if ($isExtended) { '--prerelease --latest=false' } else { '--latest' }
    $publish = "gh release create $tagPrefix$ver $zip $sum -R cablemp5/repak-xtra --target main $releaseFlags --title `"$appName $ver`" --notes-file $notes"
    Set-Clipboard -Value $publish
    Write-Host 'The publish command is on the clipboard: paste it and press Enter:'
    Write-Host "  $publish"
}
if ($Test) { Write-Host 'The app runs one copy at a time: close the stable repakxtra before opening the test one, or you will just get the stable window.' -ForegroundColor Yellow }
