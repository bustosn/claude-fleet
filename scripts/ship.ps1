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
  # Hooks off for this merge: core.hooksPath would fire post-merge, which calls this script again (-BuildOnly).
  # The build and restart below cover it once. The path only has to not exist.
  git -c core.hooksPath=scripts/hooks-off merge --no-edit $Branch
  if ($LASTEXITCODE -ne 0) { throw "merge failed; resolve it in $main" }
}
$after = git rev-parse HEAD

$lockChanged = ($before -ne $after) -and ((git diff --name-only $before $after -- package-lock.json) -ne $null)
if ($lockChanged -or -not (Test-Path (Join-Path $main 'node_modules'))) { Write-Host 'installing'; npm install --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm install failed' } }

Write-Host 'building'
npm run build --silent
if ($LASTEXITCODE -ne 0) { throw 'build failed; the daily instance keeps serving the old build' }

# Smoke test: serve the fresh build from a throwaway instance on a spare port and load it in headless Chrome.
# Typecheck cannot see a render loop or a runtime throw; this can. The daily instance is not touched until it passes.
Write-Host 'smoke-testing the build'
$smokePort = 7779
New-Item -ItemType Directory -Force (Join-Path $main 'state') | Out-Null
$env:FLEET_PORT = "$smokePort"
$probe = Start-Process -FilePath 'node' -ArgumentList @((Join-Path $main 'node_modules\tsx\dist\cli.mjs'), (Join-Path $main 'server\index.ts')) -WorkingDirectory $main -NoNewWindow -PassThru `
  -RedirectStandardOutput (Join-Path $main 'state\smoke-server.log') -RedirectStandardError (Join-Path $main 'state\smoke-server.err.log')
Remove-Item Env:FLEET_PORT
try {
  $up = $false
  for ($i = 0; $i -lt 60 -and -not $up; $i++) { Start-Sleep -Milliseconds 500; try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$smokePort/api/config" -TimeoutSec 2 | Out-Null; $up = $true } catch {} }
  if (-not $up) { throw "smoke: the fresh build did not come up on :$smokePort (see state\smoke-server.err.log); the daily instance keeps serving the old build" }
  node (Join-Path $PSScriptRoot 'smoke.mjs') "http://127.0.0.1:$smokePort/"
  if ($LASTEXITCODE -ne 0) { throw "smoke test failed; the daily instance keeps serving the old build. main holds the merge but nothing was pushed: fix on $Branch and ship again, or 'git reset --hard $before' in $main" }
} finally {
  if ($probe -and -not $probe.HasExited) { Stop-Process -Id $probe.Id -Force -ErrorAction SilentlyContinue }
  # tsx runs the server in a child process; end whatever still listens on the spare port.
  $leftover = netstat -ano | Select-String ":$smokePort\s+.*LISTENING\s+(\d+)" | ForEach-Object { $_.Matches[0].Groups[1].Value } | Sort-Object -Unique
  foreach ($p in $leftover) { if ($p -ne '0') { Stop-Process -Id ([int]$p) -Force -ErrorAction SilentlyContinue } }
}

& (Join-Path $PSScriptRoot 'autostart.ps1') -Restart
Write-Host "shipped $(git log --oneline -1)"

# Mirror what is running to GitHub. A failed push (offline, auth) is a warning, not a failed ship.
git push --quiet 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Host 'pushed main' } else { Write-Warning 'push failed; run `git push` in the main checkout when you are online' }
