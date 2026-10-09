# Started hidden by the ClaudeFleet logon task (see autostart.ps1). Runs the daily instance and appends its output to state\fleet.log.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force (Join-Path $root 'state') | Out-Null
$log = Join-Path $root 'state\fleet.log'
Add-Content $log "`n=== fleet start $(Get-Date -Format s) ==="
& npm start 2>&1 | ForEach-Object { Add-Content $log $_ }
