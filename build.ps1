# Release build, same steps as .github/workflows/release.yml. Output: dist\Repak-X-Caleb\REPAK-X.exe
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
# vswhere: the .NET NativeAOT linker step calls it to find MSVC
$env:PATH = "$env:USERPROFILE\.cargo\bin;${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer;$env:PATH"

function Run([scriptblock]$cmd) { & $cmd; if ($LASTEXITCODE -ne 0) { throw "Failed: $cmd" } }

# A running copy locks its REPAK-X.exe; package into whichever of the two folders is not in use
$running = @(Get-Process REPAK-X -ErrorAction SilentlyContinue | ForEach-Object { $_.Path })
$out = 'dist\Repak-X-Caleb'
if ($running -match [regex]::Escape('\dist\Repak-X-Caleb\')) { $out = 'dist\Repak-X-Caleb-next' }
if ($running -match [regex]::Escape("\$out\")) { throw 'Close repakxtra first: both output folders are in use.' }

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
# Desktop shortcut always opens the build just made (builds alternate between the two folders)
$exe = (Resolve-Path "$out\REPAK-X.exe").Path
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'repakxtra.lnk'))
$lnk.TargetPath = $exe
$lnk.WorkingDirectory = Split-Path $exe
$lnk.IconLocation = "$exe,0"
$lnk.Save()
Write-Host "Built: $out\REPAK-X.exe (desktop shortcut updated)" -ForegroundColor Green
