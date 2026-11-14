# repakxtra: Use-UatPatches { ... } runs the block with every uassettool-patches\*.patch applied to the UAssetToolRivals
# submodule, and takes them out again afterwards, even when the block fails. Patches left in by a build stopped halfway
# come out first. A patch that no longer applies (the submodule moved on) stops the build: refresh it from the new code.
function Use-UatPatches([scriptblock]$block) {
    $sub = Join-Path $PSScriptRoot '..\UAssetToolRivals'
    $patches = @(Get-ChildItem (Join-Path $PSScriptRoot '*.patch') | Sort-Object Name)
    if (git -C $sub status --porcelain --untracked-files=no) {
        # newest first: later patches edit lines of earlier ones, so an earlier one only comes out after them
        foreach ($p in ($patches | Sort-Object Name -Descending)) {
            # cmd keeps git's expected "does not apply" stderr from becoming a PowerShell 5.1 error
            cmd /c "git -C `"$sub`" apply --reverse --check `"$($p.FullName)`" >nul 2>&1"
            if ($LASTEXITCODE -eq 0) { cmd /c "git -C `"$sub`" apply --reverse --whitespace=nowarn `"$($p.FullName)`"" }
        }
        if (git -C $sub status --porcelain --untracked-files=no) { throw 'UAssetToolRivals has changes that are not repakxtra''s patches: commit or undo them there first.' }
    }
    $applied = @()
    try {
        foreach ($p in $patches) {
            cmd /c "git -C `"$sub`" apply --whitespace=nowarn `"$($p.FullName)`""
            if ($LASTEXITCODE -ne 0) { throw "$($p.Name) no longer applies to UAssetToolRivals: refresh it (uassettool-patches\README.md)." }
            $applied += $p
        }
        & $block
    } finally {
        [array]::Reverse($applied)
        foreach ($p in $applied) { cmd /c "git -C `"$sub`" apply --reverse --whitespace=nowarn `"$($p.FullName)`"" }
    }
}

# What the tools were built from: the submodule's commit and every patch, written as UAssetTool.source beside both
# builds once they are published (dev.ps1, build.ps1). The app keys its saved mod checks on it (xtra_vfx.rs tools_id):
# two builds of the same source differ byte for byte, so keying on the bytes checked every mod again after each rebuild.
function Get-UatSourceId {
    $sub = Join-Path $PSScriptRoot '..\UAssetToolRivals'
    $parts = @(git -C $sub rev-parse HEAD) + @(Get-ChildItem (Join-Path $PSScriptRoot '*.patch') | Sort-Object Name | ForEach-Object { "$($_.Name) $((Get-FileHash $_.FullName).Hash)" })
    $bytes = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($parts -join "`n"))
    -join ($bytes | ForEach-Object { $_.ToString('x2') })
}
# Its second line: the same without the patches that only change how a mod is packed (*-packaging.patch). The app keys
# its mod checks on that line (xtra_vfx.rs tools_id), so builds that read files the same way (the two editions of one
# version) share them. build.ps1 -SkipTools compares the first line, which still tells the editions apart.
function Get-UatReadId {
    $sub = Join-Path $PSScriptRoot '..\UAssetToolRivals'
    $parts = @(git -C $sub rev-parse HEAD) + @(Get-ChildItem (Join-Path $PSScriptRoot '*.patch') | Where-Object Name -notlike '*-packaging.patch' | Sort-Object Name | ForEach-Object { "$($_.Name) $((Get-FileHash $_.FullName).Hash)" })
    $bytes = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($parts -join "`n"))
    -join ($bytes | ForEach-Object { $_.ToString('x2') })
}
function Write-UatSource {
    $id = "$(Get-UatSourceId)`n$(Get-UatReadId)"
    foreach ($dir in @('target\uassettool', 'target\uassettool-cli')) { [IO.File]::WriteAllText((Join-Path (Join-Path $PSScriptRoot '..') "$dir\UAssetTool.source"), $id) }
}
