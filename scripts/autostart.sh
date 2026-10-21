#!/bin/bash
# Keeps the daily Fleet instance running on a Mac without a Terminal window (the macOS twin of scripts/autostart.ps1).
#
#   scripts/autostart.sh            write the com.fleet launch agent for this checkout and start it now (same as install)
#   scripts/autostart.sh restart    stop the running instance and start it again (after a pull + build)
#   scripts/autostart.sh stop       stop it until the next login (or the next restart)
#   scripts/autostart.sh remove     stop it and delete the launch agent
#
# launchd runs server/index.ts with this checkout's node and tsx, logs to state/fleet.log, starts it at every login,
# and starts it again if it crashes. The agent's PATH is the one this script ran with, so Fleet finds the same
# git, node and claude you have in Terminal. Rerun it (or restart) after changing those.
# A Fleet started by hand with `npm start` on the same port is stopped first, so the two never fight over it.
# The label matches the plist INSTALL-MAC.md used to have you write by hand, so this replaces that one.

set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
label='com.fleet'
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"
log="$root/state/fleet.log"
port="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port||""))}catch{}' "$root/fleet.config.json" 2>/dev/null || true)"
port="${port:-7777}"

[ "$(uname -s)" = Darwin ] || { echo 'autostart.sh is for macOS; on Windows use scripts\autostart.ps1' >&2; exit 1; }

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

write_plist() {
  local node tsx
  node="$(command -v node)" || { echo 'node is not on PATH' >&2; exit 1; }
  tsx="$root/node_modules/tsx/dist/cli.mjs"
  [ -f "$tsx" ] || { echo "no $tsx: run npm install first" >&2; exit 1; }
  mkdir -p "$(dirname "$plist")" "$root/state"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>WorkingDirectory</key><string>$(xml "$root")</string>
  <key>ProgramArguments</key><array>
    <string>$(xml "$node")</string><string>$(xml "$tsx")</string><string>$(xml "$root/server/index.ts")</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(xml "$PATH")</string>
    <key>LANG</key><string>${LANG:-en_US.UTF-8}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml "$log")</string>
  <key>StandardErrorPath</key><string>$(xml "$log")</string>
</dict>
</plist>
EOF
}

# A Fleet listening on the port, launched any way: answers /api/config with its reposRoot.
is_fleet() { curl -fs --max-time 2 "http://127.0.0.1:$port/api/config" 2>/dev/null | grep -q '"reposRoot"'; }
listeners() { lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u || true; }

stop_fleet() {
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl bootout "$domain/$label" 2>/dev/null || true
    echo "stopped launch agent $label"
  fi
  # Whatever still holds the port: a Fleet from `npm start` is ended; anything else is left alone and reported.
  local pids
  for _ in $(seq 1 20); do pids="$(listeners)"; [ -z "$pids" ] && return 0; is_fleet && break; sleep 0.5; done
  pids="$(listeners)"
  [ -z "$pids" ] && return 0
  if ! is_fleet; then
    echo "port $port is in use by something that is not Fleet (pid $(echo $pids)). Stop it, or set another port in fleet.config.json." >&2
    exit 1
  fi
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 20); do [ -z "$(listeners)" ] && break; sleep 0.5; done
  [ -n "$(listeners)" ] && kill -9 $(listeners) 2>/dev/null || true
  echo "stopped the Fleet running on :$port (pid $(echo $pids))"
}

start_fleet() {
  launchctl bootstrap "$domain" "$plist"
  echo "started: http://127.0.0.1:$port (log: $log)"
}

case "${1:-install}" in
  install|restart) write_plist; stop_fleet; start_fleet ;;
  stop) stop_fleet ;;
  remove) stop_fleet; rm -f "$plist"; echo "removed $plist" ;;
  *) echo "usage: $0 [install|restart|stop|remove]" >&2; exit 2 ;;
esac
