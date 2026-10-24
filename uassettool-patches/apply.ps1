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
