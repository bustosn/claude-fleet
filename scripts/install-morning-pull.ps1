# Registers a daily Task Scheduler job that runs morning-pull.ps1. Usage: install-morning-pull.ps1 [-At 07:30]
param([string]$At = '07:30')

$script = Join-Path $PSScriptRoot 'morning-pull.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
# StartWhenAvailable: if the laptop was off/asleep at $At, run as soon as it's back.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName 'FleetMorningPull' -Action $action -Trigger $trigger -Settings $settings -Description 'git pull --ff-only claude-fleet' -Force | Out-Null
Write-Host "Registered FleetMorningPull daily at $At"
