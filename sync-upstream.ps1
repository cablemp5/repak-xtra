# Merge the latest (or a given) official Repak-X release into the main branch, through a pull request.
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
# main is protected (changes land through a pull request with green checks): the merge happens on sync/<tag> and
# goes up as a PR. Running the script again after fixing conflicts picks up the same branch and finishes.
$branch = "sync/$Tag"
Write-Host "Merging upstream release $Tag on $branch"

Run { git checkout main }
Run { git pull --ff-only origin main }
git rev-parse --verify --quiet "refs/heads/$branch" | Out-Null
if ($LASTEXITCODE -eq 0) { Run { git checkout $branch } } else { Run { git checkout -b $branch } }
git merge --no-edit $Tag
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Conflicts in:' -ForegroundColor Yellow
    git diff --name-only --diff-filter=U
    Write-Host 'Fix them, then: git add <files>; git commit; .\sync-upstream.ps1 again to finish.'
    exit 1
}

git submodule update --init --recursive
Run { git push -u origin $branch }
$pr = gh pr list -R cablemp5/repak-xtra --head $branch --json url -q '.[0].url'
if (-not $pr) {
    $pr = gh pr create -R cablemp5/repak-xtra --base main --head $branch --title "Sync upstream Repak-X $Tag" --body "Merges the official Repak-X release $Tag into main (made by sync-upstream.ps1). Merge it with **Create a merge commit**, not squash, so git keeps $Tag's history and the next sync only brings what is new."
    if ($LASTEXITCODE -ne 0) { throw 'Could not open the pull request' }
}
Run { git push origin "refs/remotes/upstream/main:refs/heads/upstream" }   # keep the fork's upstream branch an exact mirror of Repak-X's main
Run { git checkout main }
Write-Host "Pull request: $pr" -ForegroundColor Green
Write-Host 'When its checks pass, merge it with "Create a merge commit" (not squash), then: git pull; .\build.ps1' -ForegroundColor Green
