# Merge the latest (or a given) official Repak-X release into the caleb branch.
# Usage: .\sync-upstream.ps1            -> newest X-zant release
#        .\sync-upstream.ps1 v2.0.2     -> a specific tag
param([string]$Tag)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
# PowerShell 5.1 does not stop on a failed git or gh: check their exit codes
function Run([scriptblock]$cmd) { & $cmd; if ($LASTEXITCODE -ne 0) { throw "Failed: $cmd" } }

$dirty = @(Run { git status --porcelain --untracked-files=no -- . ':!repak-x/gen/schemas' })
if ($dirty) { throw "Uncommitted changes (commit or discard them first):`n$($dirty -join "`n")" }
# every build rewrites the generated schemas; the lockfile is not touched: a dirty package-lock.json is a real change and stops the sync
Run { git checkout -- repak-x/gen/schemas }

Run { git fetch upstream --tags --quiet }
if (-not $Tag) { $Tag = gh release view -R X-zant/Repak-X --json tagName -q .tagName }
if (-not $Tag) { throw 'No release tag: is gh logged in and online? Or pass one: .\sync-upstream.ps1 v2.0.2' }
Write-Host "Merging upstream release $Tag into caleb"

Run { git checkout caleb }
git merge --no-edit $Tag
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Conflicts in:' -ForegroundColor Yellow
    git diff --name-only --diff-filter=U
    Write-Host 'Fix them, then: git add <files>; git commit; .\sync-upstream.ps1 again to finish.'
    exit 1
}

git submodule update --init --recursive
git push origin caleb
git push origin "refs/remotes/upstream/main:refs/heads/main"   # keep the fork's main an exact mirror
Write-Host "Done: caleb now includes $Tag. Rebuild with .\build.ps1" -ForegroundColor Green
