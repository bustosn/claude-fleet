#!/bin/bash
# Sets Fleet up on a Mac in one go, from a fresh clone (the macOS twin of scripts/install.ps1):
#
#   ./scripts/install.sh
#
#   1. installs what is missing: Xcode command line tools, Homebrew, Git and Node.js through Homebrew, Claude Code through its official installer
#   2. writes fleet.config.json (asks where your git repos live; defaults to the folder this clone sits in)
#   3. npm install and build
#   4. checks Claude Code is signed in, and offers to sign in if not
#   5. registers the com.fleet launch agent, stops a Fleet already running by hand on the port, starts Fleet, and opens it in the browser
#
# Safe to run again: it skips what is already done and keeps an existing fleet.config.json. To update: git pull, then run it again.
#
#   --repos-root <dir>   the folder your git repos live in (each repo is a folder directly inside it)
#   --port <n>           default 7777
#   --yes                no questions: take the defaults (for running it from Claude Code or a script)
#   --no-autostart       do not register the launch agent; start Fleet yourself with `npm start`
#   --no-browser         do not open the browser at the end

set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
cd "$root"

repos_root=''; port=7777; port_given=0; yes=0; autostart=1; browser=1
while [ $# -gt 0 ]; do
  case "$1" in
    --repos-root) repos_root="${2:?--repos-root needs a folder}"; shift 2 ;;
    --port) port="${2:?--port needs a number}"; port_given=1; shift 2 ;;
    --yes|-y) yes=1; shift ;;
    --no-autostart) autostart=0; shift ;;
    --no-browser) browser=0; shift ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok() { printf '    \033[32m%s\033[0m\n' "$1"; }
warn() { printf '    \033[33m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[31mSetup stopped: %s\033[0m\n' "$1"; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = Darwin ] || fail 'this installer is for macOS. On Windows run: powershell -ExecutionPolicy Bypass -File scripts\install.ps1'

# Homebrew lives outside the default PATH until its shellenv line runs; pick it up in this shell.
load_brew() {
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then eval "$("$b" shellenv)"; return 0; fi
  done
  return 1
}
node_major() { if has node; then node --version | sed -E 's/^v([0-9]+).*/\1/'; else echo 0; fi; }

# 1. Prerequisites
step 'Checking prerequisites'

# git, Homebrew and node-pty all need the command line tools. /usr/bin/git without them is only a stub that offers to install them.
if ! xcode-select -p >/dev/null 2>&1; then
  echo '    installing the Xcode command line tools: click Install in the dialog that opens'
  xcode-select --install >/dev/null 2>&1 || true
  for _ in $(seq 1 360); do xcode-select -p >/dev/null 2>&1 && break; sleep 5; done
  xcode-select -p >/dev/null 2>&1 || fail 'the Xcode command line tools are still missing. Finish their install, then run this again.'
fi
ok "command line tools: $(xcode-select -p)"

load_brew || true
need_brew=0
has git || need_brew=1
[ "$(node_major)" -ge 20 ] || need_brew=1
if [ "$need_brew" = 1 ] && ! has brew; then
  [ "$yes" = 1 ] && fail 'Homebrew is needed to install Git or Node.js, and its installer asks for your password. Install it from https://brew.sh, then run this again.'
  echo '    installing Homebrew (it asks for your Mac password)'
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || fail 'the Homebrew install failed; the output above says why.'
  load_brew || fail 'Homebrew installed but brew is not where expected. Open a new Terminal window and run this again.'
  # New login shells (and Fleet's terminal tabs, which are login shells) find brew through ~/.zprofile.
  if ! grep -qs 'brew shellenv' "$HOME/.zprofile"; then
    printf '\neval "$(%s shellenv)"\n' "$(command -v brew)" >> "$HOME/.zprofile"
    ok 'added Homebrew to ~/.zprofile'
  fi
fi

if has git; then ok "git: $(git --version)"; else
  echo '    installing Git with Homebrew'; brew install git || fail 'brew could not install Git.'; hash -r
  ok "git: $(git --version)"
fi

if [ "$(node_major)" -lt 20 ]; then
  has node && warn "Node $(node --version) is too old; Fleet needs 20 or newer"
  echo '    installing Node.js with Homebrew'
  if brew list node >/dev/null 2>&1; then brew upgrade node || true; else brew install node || fail 'brew could not install Node.js.'; fi
  hash -r
  # An older Node from nvm or the nodejs.org installer can sit ahead of Homebrew's on PATH.
  [ "$(node_major)" -ge 20 ] || fail "node on PATH is still $(node --version 2>/dev/null) at $(command -v node). Switch it to 20 or newer (nvm: nvm install 20 && nvm alias default 20), then run this again."
fi
ok "node: $(node --version)"

export PATH="$HOME/.local/bin:$PATH"
if ! has claude; then
  echo '    installing Claude Code with its official installer'
  curl -fsSL https://claude.ai/install.sh | bash || fail 'the Claude Code install failed; the output above says why.'
  hash -r
  has claude || fail 'Claude Code installed but is not on PATH yet. Open a new Terminal window and run this again.'
fi
ok "claude: $(claude --version)"

# 2. Config
step 'Writing fleet.config.json'
config="$root/fleet.config.json"
existing_root=''; existing_port=''
if [ -f "$config" ]; then
  existing_root="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).reposRoot||""))}catch{}' "$config")"
  existing_port="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port||""))}catch{}' "$config")"
fi
if [ -n "$existing_root" ] && [ -d "$existing_root" ] && [ -z "$repos_root" ]; then
  ok "keeping the existing config (repos in $existing_root)"
  if [ "$port_given" = 1 ]; then
    node -e 'const fs=require("fs");const [f,port]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(f,"utf8"));c.port=Number(port);fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' "$config" "$port" || fail 'could not write fleet.config.json'
    ok "port set to $port"
  elif [ -n "$existing_port" ]; then port="$existing_port"; fi
else
  [ -f "$config" ] && [ -z "$existing_root" ] && warn 'fleet.config.json has no usable reposRoot; writing a fresh one'
  if [ -z "$repos_root" ]; then
    default="$(dirname "$root")"
    if [ "$yes" = 1 ]; then repos_root="$default"
    else
      echo '    Fleet shows every git repo directly inside one folder, plus their worktrees.'
      read -r -p "    Where do your git repos live? [$default] " answer
      repos_root="${answer:-$default}"
    fi
  fi
  repos_root="${repos_root/#\~/$HOME}"
  [ -d "$repos_root" ] || fail "$repos_root is not a folder."
  repos_root="$(cd "$repos_root" && pwd)"
  node -e 'const fs=require("fs");const [ex,out,repos,home,port]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(ex,"utf8"));c.reposRoot=repos;c.claudeHome=home;c.port=Number(port);fs.writeFileSync(out,JSON.stringify(c,null,2)+"\n")' \
    "$root/fleet.config.example.json" "$config" "$repos_root" "$HOME/.claude" "$port" || fail 'could not write fleet.config.json'
  ok "repos in $repos_root, port $port"
fi

# 3. Install and build
# npm ci replaces node_modules, which pulls the files out from under a running Fleet: stop it first,
# whether it is the launch agent or an `npm start` left running in a Terminal window.
if [ "$autostart" = 1 ]; then step 'Stopping a running Fleet, if any'; "$here/autostart.sh" stop; fi
step 'Installing packages (a minute or two the first time)'
npm ci --no-audit --no-fund --loglevel=error || fail 'npm install failed; the output above says why.'
step 'Building the web app'
npm run build --silent || fail 'the build failed; the output above says why.'
ok 'built into dist/web'

# 4. Claude sign-in: Fleet's chats run on this machine's Claude Code login.
step 'Checking Claude Code is signed in'
signed_in() { claude auth status 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).loggedIn?0:1)}catch{process.exit(1)}})'; }
if signed_in; then ok 'signed in'
elif [ "$yes" = 1 ]; then warn 'not signed in. Run `claude auth login` once; Fleet shows your sessions without it, but chats will not start.'
else
  echo '    not signed in; opening the sign-in flow'
  claude auth login || true
  if signed_in; then ok 'signed in'; else warn 'still not signed in. Run `claude auth login` later; chats will not start until you do.'; fi
fi

# 5. Start
url="http://127.0.0.1:$port"
if [ "$autostart" = 0 ]; then
  step 'Done'
  echo "    Start Fleet with:  npm start   then open $url"
  exit 0
fi
step 'Starting Fleet (and at every login from now on)'
"$here/autostart.sh" install
up=0
for _ in $(seq 1 60); do
  if curl -fs --max-time 2 "$url/api/config" >/dev/null 2>&1; then up=1; break; fi
  sleep 0.5
done
[ "$up" = 1 ] || fail "Fleet did not come up on $url. The log is state/fleet.log."
ok "running at $url"
[ "$browser" = 1 ] && open "$url"

step 'Done'
echo "    Fleet: $url"
echo '    It starts by itself at login and comes back if it crashes. Stop it: scripts/autostart.sh stop. Remove it: scripts/autostart.sh remove'
echo '    Update later: git pull, then run this script again.'
