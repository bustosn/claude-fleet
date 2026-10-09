<#
Ships the dev branch to the daily instance: merge dev into main in the main checkout, install if the
lockfile changed, build the web app, restart the ClaudeFleet task.

  npm run ship               from either checkout
  .\scripts\ship.ps1 -BuildOnly   skip the merge (what the post-merge hook calls after a merge or pull)

Nothing is committed. Main is pushed after a successful restart. The merge fails loudly on conflicts and leaves main untouched.
#>
param([switch]$BuildOnly, [string]$Branch = 'dev')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot
# First line of `git worktree list` is always the main checkout, whichever checkout we run from.
$main = ((git -C $here worktree list) | Select-Object -First 1) -replace '\s+\S+\s+\[.*$', ''
Set-Location $main

$before = git rev-parse HEAD
if (-not $BuildOnly) {
  $current = git rev-parse --abbrev-ref HEAD
  if ($current -ne 'main') { throw "main checkout is on '$current', expected main" }
  if (git status --porcelain) { throw "main checkout has uncommitted changes; commit or discard them first" }
  Write-Host "merging $Branch into main"
  git merge --no-edit $Branch
  if ($LASTEXITCODE -ne 0) { throw "merge failed; resolve it in $main" }
}
$after = git rev-parse HEAD

$lockChanged = ($before -ne $after) -and ((git diff --name-only $before $after -- package-lock.json) -ne $null)
if ($lockChanged -or -not (Test-Path (Join-Path $main 'node_modules'))) { Write-Host 'installing'; npm install --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm install failed' } }

Write-Host 'building'
npm run build --silent
if ($LASTEXITCODE -ne 0) { throw 'build failed; the daily instance keeps serving the old build' }

& (Join-Path $PSScriptRoot 'autostart.ps1') -Restart
Write-Host "shipped $(git log --oneline -1)"

# Mirror what is running to GitHub. A failed push (offline, auth) is a warning, not a failed ship.
git push --quiet 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Host 'pushed main' } else { Write-Warning 'push failed; run `git push` in the main checkout when you are online' }
