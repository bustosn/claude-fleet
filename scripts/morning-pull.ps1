# Daily fast-forward pull of the fleet repo. Registered by scripts/install-morning-pull.ps1.
# Never merges, rebases or touches local changes: skips when the tree is dirty or the pull isn't a fast-forward.
$repo = Split-Path -Parent $PSScriptRoot
$log = Join-Path $repo 'state\morning-pull.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null

function Log($m) { Add-Content $log "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" }

Set-Location $repo
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ((git status --porcelain --untracked-files=no) -ne $null) { Log "skip: uncommitted changes on $branch"; exit 0 }

$out = git pull --ff-only origin $branch 2>&1 | Out-String
Log "pull $branch (exit $LASTEXITCODE): $($out.Trim() -replace '\s*\r?\n\s*', ' | ')"
exit $LASTEXITCODE
