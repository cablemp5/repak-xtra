# Live dev copy: the real app (your library, the real backend) from the folder as it is, uncommitted edits included.
#   .\dev.ps1    starts it; interface edits show about a second after a save, Rust edits rebuild and reopen the app.
#                Stop it with Ctrl+C in this window (or close the app window).
# The first start compiles a debug build (several minutes); later starts reuse it. It marks itself (amber "xtra", "dev
# build" in the version line). It is the real app: mods, Setup and %APPDATA%\Repak-X are the stable copy's, and loadouts
# and settings are shared both ways with it, the newest save winning (custom/devStorage.ts). The app runs one copy at a
# time: close the stable repakxtra first. Before a PR, a real .\build.ps1 -Test is still the final check.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
# vswhere: the .NET NativeAOT linker step calls it to find MSVC
$env:PATH = "$env:USERPROFILE\.cargo\bin;${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer;$env:PATH"

if (Get-Process repakxtra, REPAK-X -ErrorAction SilentlyContinue) { throw 'Close repakxtra first (stable or test): the app runs one copy at a time.' }
# The backend copies UAssetTool from here into the debug folder (repak-x\build.rs); publish it once if it is missing
if (-not (Test-Path target\uassettool\UAssetTool.dll)) {
    dotnet publish UAssetToolRivals/src/UAssetTool/UAssetToolNative.csproj -c Release -r win-x64 -p:DebugType=none -p:DebugSymbols=false -o target/uassettool
    if ($LASTEXITCODE -ne 0) { throw 'UAssetTool did not build.' }
}
# repak-x\build.rs copies these only when it reruns, which an incremental dev build skips: put them beside the debug exe
New-Item -ItemType Directory -Force target\debug\data | Out-Null
Copy-Item target\uassettool\UAssetTool.dll target\debug\ -Force
Copy-Item repak-x\src\data\character_data.json target\debug\data\ -Force
$env:SKIP_UASSET_TOOL_BUILD = '1'
# WebView2's debugging port, on this PC only, so tools can screenshot and click through the dev copy; the stable and test
# copies never open it
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
Set-Location repak-x
# Its own port (5180), so it never collides with the browser preview (npm run dev, 5173)
npx tauri dev --config tauri.dev.conf.json
