<#
Sets Fleet up on a Windows machine in one go, from a fresh clone:

  powershell -ExecutionPolicy Bypass -File scripts\install.ps1

  1. installs what is missing: Git and Node.js LTS through winget, Claude Code through its official installer
  2. writes fleet.config.json (asks where your git repos live; defaults to the folder this clone sits in)
  3. npm install and build
  4. checks Claude Code is signed in, and offers to sign in if not
  5. registers the "ClaudeFleet" logon task, starts Fleet, and opens it in the browser

Safe to run again: it skips what is already done and keeps an existing fleet.config.json.

  -ReposRoot <dir>   the folder your git repos live in (each repo is a folder directly inside it)
  -Port <n>          default 7777
  -Yes               no questions: take the defaults (for running it from Claude Code or a script)
  -NoAutostart       do not register the logon task; start Fleet yourself with `npm start`
  -NoBrowser         do not open the browser at the end
#>
param([string]$ReposRoot, [int]$Port = 7777, [switch]$Yes, [switch]$NoAutostart, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "`nSetup stopped: $msg" -ForegroundColor Red; exit 1 }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
# winget and the Claude installer change PATH for new shells only; pick the change up in this one.
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + (Join-Path $HOME '.local\bin')
}
function Winget-Install($id, $what) {
  if (-not (Has 'winget')) { Fail "$what is missing and winget is not available to install it. Install $what by hand, then run this again." }
  Write-Host "    installing $what with winget (Windows may ask for permission)"
  winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { Fail "winget could not install $what (exit $LASTEXITCODE). Install it by hand, then run this again." }
  Refresh-Path
}

# 1. Prerequisites
Step 'Checking prerequisites'
if (Has 'git') { Ok "git: $(git --version)" } else { Winget-Install 'Git.Git' 'Git'; if (-not (Has 'git')) { Fail 'Git installed but is not on PATH yet. Open a new terminal and run this again.' }; Ok 'git installed' }

$nodeMajor = 0
if (Has 'node') { $nodeMajor = [int]((node --version) -replace '^v(\d+).*', '$1') }
if ($nodeMajor -lt 20) {
  if ($nodeMajor) { Warn "Node $(node --version) is too old; Fleet needs 20 or newer" }
  Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js LTS'
  if (-not (Has 'node')) { Fail 'Node.js installed but is not on PATH yet. Open a new terminal and run this again.' }
  $nodeMajor = [int]((node --version) -replace '^v(\d+).*', '$1')
  if ($nodeMajor -lt 20) { Fail "Node is still $(node --version). Uninstall the old Node.js from Settings > Apps, then run this again." }
}
Ok "node: $(node --version)"

if (-not (Has 'claude')) {
  Write-Host '    installing Claude Code with its official installer'
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  Refresh-Path
  if (-not (Has 'claude')) { Fail 'Claude Code installed but is not on PATH yet. Open a new terminal and run this again.' }
}
Ok "claude: $(claude --version)"

# 2. Config
Step 'Writing fleet.config.json'
$configFile = Join-Path $root 'fleet.config.json'
$existing = $null
if (Test-Path $configFile) { try { $existing = Get-Content $configFile -Raw | ConvertFrom-Json } catch { Warn 'fleet.config.json is not valid JSON; writing a fresh one' } }
if ($existing -and $existing.reposRoot -and (Test-Path $existing.reposRoot) -and -not $ReposRoot) {
  Ok "keeping the existing config (repos in $($existing.reposRoot))"
  if ($existing.port) { $Port = [int]$existing.port }
} else {
  if (-not $ReposRoot) {
    $default = Split-Path -Parent $root
    if ($Yes) { $ReposRoot = $default }
    else {
      Write-Host "    Fleet shows every git repo directly inside one folder, plus their worktrees."
      $answer = Read-Host "    Where do your git repos live? [$default]"
      $ReposRoot = if ($answer.Trim()) { $answer.Trim().Trim('"') } else { $default }
    }
  }
  if (-not (Test-Path $ReposRoot -PathType Container)) { Fail "$ReposRoot is not a folder." }
  $ReposRoot = (Resolve-Path $ReposRoot).Path -replace '\\', '/'
  $claudeHome = (Join-Path $HOME '.claude') -replace '\\', '/'
  # Node writes it: PowerShell 5's ConvertTo-Json mangles nested objects and indents oddly.
  node -e "const fs=require('fs');const [ex,out,repos,home,port]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(ex,'utf8'));c.reposRoot=repos;c.claudeHome=home;c.port=Number(port);fs.writeFileSync(out,JSON.stringify(c,null,2)+'\n')" `
    (Join-Path $root 'fleet.config.example.json') $configFile $ReposRoot $claudeHome $Port
  if ($LASTEXITCODE -ne 0) { Fail 'could not write fleet.config.json' }
  Ok "repos in $ReposRoot, port $Port"
}

# 3. Install and build
Step 'Installing packages (a minute or two the first time)'
npm ci --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { Fail 'npm install failed; the output above says why.' }
Step 'Building the web app'
npm run build --silent
if ($LASTEXITCODE -ne 0) { Fail 'the build failed; the output above says why.' }
Ok 'built into dist\web'

# 4. Claude sign-in: Fleet's chats run on this machine's Claude Code login.
Step 'Checking Claude Code is signed in'
$signedIn = $false
try { $signedIn = [bool]((claude auth status | Out-String | ConvertFrom-Json).loggedIn) } catch {}
if ($signedIn) { Ok 'signed in' }
elseif ($Yes) { Warn 'not signed in. Run `claude auth login` once; Fleet shows your sessions without it, but chats will not start.' }
else {
  Write-Host '    not signed in; opening the sign-in flow'
  claude auth login
  try { $signedIn = [bool]((claude auth status | Out-String | ConvertFrom-Json).loggedIn) } catch {}
  if ($signedIn) { Ok 'signed in' } else { Warn 'still not signed in. Run `claude auth login` later; chats will not start until you do.' }
}

# 5. Start
$url = "http://127.0.0.1:$Port"
if ($NoAutostart) {
  Step 'Done'
  Write-Host "    Start Fleet with:  npm start   then open $url"
  exit 0
}
Step 'Starting Fleet (and at every logon from now on)'
& (Join-Path $PSScriptRoot 'autostart.ps1')
$up = $false
for ($i = 0; $i -lt 60 -and -not $up; $i++) { Start-Sleep -Milliseconds 500; try { Invoke-WebRequest -UseBasicParsing "$url/api/config" -TimeoutSec 2 | Out-Null; $up = $true } catch {} }
if (-not $up) { Fail "Fleet did not come up on $url. The log is state\fleet.log." }
Ok "running at $url"
if (-not $NoBrowser) { Start-Process $url }

Step 'Done'
Write-Host "    Fleet: $url"
Write-Host '    It starts by itself at logon. Stop it: scripts\autostart.ps1 -Stop. Remove the logon task: scripts\autostart.ps1 -Remove'
Write-Host '    Update later: git pull, then run this script again.'
