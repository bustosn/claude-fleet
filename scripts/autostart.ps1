<#
Keeps the daily Fleet instance running without a terminal.

  .\scripts\autostart.ps1            register a logon task "ClaudeFleet" for this checkout and start it now
  .\scripts\autostart.ps1 -Restart   stop the running instance and start it again (after a merge + build)
  .\scripts\autostart.ps1 -Stop      stop it
  .\scripts\autostart.ps1 -Remove    delete the logon task

The task runs scripts\run.ps1 hidden, which starts `npm start` in this folder and logs to state\fleet.log.
No admin rights needed. If your shell refuses to run scripts: powershell -ExecutionPolicy Bypass -File .\scripts\autostart.ps1
#>
param([switch]$Restart, [switch]$Stop, [switch]$Remove)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$task = 'ClaudeFleet'
$log = Join-Path $root 'state\fleet.log'
$port = (Get-Content (Join-Path $root 'fleet.config.json') | ConvertFrom-Json).port
if (-not $port) { $port = 7777 }

function Stop-Fleet {
  $pids = netstat -ano | Select-String ":$port\s+.*LISTENING\s+(\d+)" | ForEach-Object { $_.Matches[0].Groups[1].Value } | Sort-Object -Unique
  foreach ($p in $pids) { if ($p -ne '0') { Stop-Process -Id ([int]$p) -Force -ErrorAction SilentlyContinue; Write-Host "stopped pid $p on :$port" } }
}
function Start-Fleet {
  Start-ScheduledTask -TaskName $task
  Write-Host "started: http://127.0.0.1:$port (log: $log)"
}

if ($Remove) { Stop-Fleet; Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue; Write-Host "removed task $task"; return }
if ($Stop) { Stop-Fleet; return }
if ($Restart) { Stop-Fleet; Start-Sleep -Seconds 1; Start-Fleet; return }

New-Item -ItemType Directory -Force (Join-Path $root 'state') | Out-Null
$runner = Join-Path $PSScriptRoot 'run.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Zero time limit: the default would kill the server after 72 hours.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "registered task $task (runs at logon)"
Stop-Fleet
Start-Fleet
