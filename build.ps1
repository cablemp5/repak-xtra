# Release build, same steps as .github/workflows/release.yml.
#   .\build.ps1        the stable app: only from a clean main. Output: dist\Repak-X-Caleb (or -next), opened as dist\repakxtra\REPAK-X.exe
#   .\build.ps1 -Test  whatever is in the folder now, even uncommitted edits. Output: dist\Repak-X-Test
# The two never overwrite each other. The app runs one copy at a time (single-instance) and both share %APPDATA%\Repak-X.
# Neither touches the desktop: point a shortcut at dist\repakxtra\REPAK-X.exe once and it always opens the newest stable build.
param([switch]$Test)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not $Test) {
    $branch = (git rev-parse --abbrev-ref HEAD)
    $dirty = @(git status --porcelain --untracked-files=no -- . ':!repak-x/gen/schemas')
    if ($branch -ne 'main' -or $dirty) { throw "The stable build comes from a clean main (this is '$branch'). Use .\build.ps1 -Test to try anything else." }
}
# vswhere: the .NET NativeAOT linker step calls it to find MSVC
$env:PATH = "$env:USERPROFILE\.cargo\bin;${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer;$env:PATH"

function Run([scriptblock]$cmd) { & $cmd; if ($LASTEXITCODE -ne 0) { throw "Failed: $cmd" } }

# A running copy locks its REPAK-X.exe; package into whichever of the two folders is not in use.
# dist\repakxtra links to the newest stable folder, and a copy opened through it reports the link's path: map that to the real folder
$link = 'dist\repakxtra'
$linked = if (Test-Path $link) { "$((Get-Item $link).Target)" }
$running = @(Get-Process REPAK-X -ErrorAction SilentlyContinue | ForEach-Object {
    if ($linked) { $_.Path -replace [regex]::Escape("$PSScriptRoot\$link"), $linked } else { $_.Path } })
if ($Test) {
    $out = 'dist\Repak-X-Test'
    if ($running -match [regex]::Escape("\$out\")) { throw 'Close the test copy of repakxtra first.' }
} else {
    $out = 'dist\Repak-X-Caleb'
    if ($running -match [regex]::Escape('\dist\Repak-X-Caleb\')) { $out = 'dist\Repak-X-Caleb-next' }
    if ($running -match [regex]::Escape("\$out\")) { throw 'Close repakxtra first: both output folders are in use.' }
}

Run { dotnet publish UAssetToolRivals/src/UAssetTool/UAssetToolNative.csproj -c Release -r win-x64 -p:DebugType=none -p:DebugSymbols=false -o target/uassettool }
Push-Location repak-x
Run { npm install }
Run { npm run build }
Pop-Location
$env:SKIP_UASSET_TOOL_BUILD = '1'
Run { cargo build --release --target x86_64-pc-windows-msvc --features custom-protocol }

New-Item -ItemType Directory -Force "$out\data" | Out-Null
Copy-Item target\x86_64-pc-windows-msvc\release\REPAK-X.exe $out -Force
Copy-Item target\uassettool\* $out -Recurse -Force
Remove-Item "$out\*.pdb", "$out\UAssetTool.exe" -ErrorAction SilentlyContinue
Copy-Item repak-x\src\data\character_data.json "$out\data" -Force
if (-not $Test) {
    # repoint dist\repakxtra at the build just made (rmdir removes only the link, never the folder it points to)
    if (Test-Path $link) { Run { cmd /c rmdir $link } }
    New-Item -ItemType Junction -Path $link -Target (Resolve-Path $out).Path | Out-Null
}
Write-Host "Built: $out\REPAK-X.exe" -ForegroundColor Green
if ($Test) { Write-Host 'The app runs one copy at a time: close the stable repakxtra before opening the test one, or you will just get the stable window.' -ForegroundColor Yellow }
