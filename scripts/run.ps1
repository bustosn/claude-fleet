# Started hidden by the ClaudeFleet logon task (see autostart.ps1). Runs the daily instance, appends its output to state\fleet.log,
# and starts it again if it exits: a crash costs a few seconds, not the rest of the session. autostart.ps1 -Stop and -Restart
# leave state\fleet.stop behind first, so a deliberate stop ends this loop instead of being undone by it.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force (Join-Path $root 'state') | Out-Null
$log = Join-Path $root 'state\fleet.log'
$stopFlag = Join-Path $root 'state\fleet.stop'
Remove-Item $stopFlag -ErrorAction SilentlyContinue
# Which process is this loop, so a stop can end it outright rather than race it.
Set-Content (Join-Path $root 'state\fleet.runner') $PID

$delay = 2
while ($true) {
  Add-Content $log "`n=== fleet start $(Get-Date -Format s) ==="
  $started = Get-Date
  & npm start 2>&1 | ForEach-Object { Add-Content $log $_ }
  if (Test-Path $stopFlag) { Add-Content $log "=== fleet stopped $(Get-Date -Format s) ==="; break }
  # A run that lasted a while was a crash: come back quickly. One that died at once (bad config, port taken) backs off to a minute.
  $delay = if (((Get-Date) - $started).TotalSeconds -gt 60) { 2 } else { [Math]::Min($delay * 2, 60) }
  Add-Content $log "=== fleet exited (code $LASTEXITCODE); restarting in ${delay}s ==="
  Start-Sleep -Seconds $delay
  if (Test-Path $stopFlag) { Add-Content $log "=== fleet stopped $(Get-Date -Format s) ==="; break }
}
