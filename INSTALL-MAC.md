# Installing Fleet on a Mac

Fleet runs on your own machine and shows every Claude Code session you have, across your git repos, in one browser window.
You need a Mac, access to this GitHub repo, and a Claude account. Everything else is installed below.

Fleet's one-command installer is Windows-only, so on a Mac you run a few commands by hand, or hand this file to Claude Code and let it do them.
This route has not been tested on a Mac yet. If a step fails, the table at the bottom lists the likely causes.

## The short way

Open Terminal and run these one at a time.

```
# 1. Tools (skip any you have). Homebrew first, if you do not have it: https://brew.sh
xcode-select --install          # compiler tools; needed to build the terminal tab's native module
brew install git node           # Node must be 20 or newer: node -v
npm install -g @anthropic-ai/claude-code
claude auth login               # sign in to Claude Code, once

# 2. Fleet. Clone it next to your other repos, for example into ~/code
cd ~/code
git clone https://github.com/bustosn/claude-fleet.git
cd claude-fleet

# 3. Config: tell Fleet where your git repos live
cp fleet.config.example.json fleet.config.json
```

Open `fleet.config.json` and set two values (the example has Windows paths):

```
"reposRoot": "/Users/you/code",     # the folder that holds your git repos
"claudeHome": "/Users/you/.claude"
```

Then build and start:

```
npm install
npm run build
npm start                         # http://127.0.0.1:7777
```

Open http://127.0.0.1:7777. Leave the Terminal window open while you use Fleet; `npm start` stops when it closes.

To update later: `git pull`, `npm install`, `npm run build`, then stop (Ctrl+C) and start Fleet again.

## Starting it at login (optional)

Without this, you run `npm start` yourself each time. To have macOS start Fleet at login and restart it if it crashes, save the following as `~/Library/LaunchAgents/com.fleet.plist`, replacing `/Users/you` with your home folder and the `npm` path with the output of `which npm`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.fleet</string>
  <key>WorkingDirectory</key><string>/Users/you/code/claude-fleet</string>
  <key>ProgramArguments</key><array><string>/opt/homebrew/bin/npm</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/code/claude-fleet/state/fleet.log</string>
  <key>StandardErrorPath</key><string>/Users/you/code/claude-fleet/state/fleet.log</string>
</dict>
</plist>
```

Then:

```
mkdir -p ~/code/claude-fleet/state
launchctl load ~/Library/LaunchAgents/com.fleet.plist       # start now and at every login
launchctl unload ~/Library/LaunchAgents/com.fleet.plist     # stop
```

To restart after an update, unload then load. `npm run restart` and `npm run ship` are Windows-only; they do not work on a Mac.

## Handing this to Claude Code

You can paste this file into Claude Code and ask it to set Fleet up. The section below is written for it.

### Instructions for Claude Code

You are installing Fleet on a Mac for the person you are talking to. Follow these steps in order and stop to report if one fails. Do not use `scripts/install.ps1` or any `.ps1` file; they are Windows-only.

1. **Ask one question first:** which folder their git repos live in. Fleet lists every repo that is a folder directly inside it. Offer their likely code folder (look under their home folder for one containing several folders with a `.git` inside) and let them confirm. Also ask whether they want Fleet to start at login.
2. **Check the tools.** Run `git --version`, `node -v` (must be v20 or newer), `npm -v`, `claude --version`, and `xcode-select -p`. Install what is missing:
   - Xcode command line tools: `xcode-select --install` (opens a dialog the person must click through; wait for it to finish).
   - Homebrew, if `brew` is missing: tell the person to install it from https://brew.sh, since its installer needs their password. Then `brew install git node`.
   - Claude Code: `npm install -g @anthropic-ai/claude-code`.
3. **Sign in to Claude Code** if `claude auth status` says they are not. Tell the person a browser window will open and let them finish. Fleet's chats will not start without it.
4. **Clone, if not already cloned.** Into the repos folder from step 1: `git clone https://github.com/bustosn/claude-fleet.git`. The repo is private; if git asks to sign in to GitHub, tell the person a browser window will open and let them finish. If the clone fails with "repository not found", their GitHub account has not been given access yet; stop and tell them.
5. **Write the config.** In the clone, `cp fleet.config.example.json fleet.config.json`, then set `reposRoot` to the folder from step 1 and `claudeHome` to `~/.claude` written out as an absolute path (for example `/Users/jane/.claude`). Leave everything else alone, especially `aws.profile`, which should stay empty. `fleet.config.json` is specific to this machine and is not committed.
6. **Build:** `npm install`, then `npm run build`. If `npm install` fails on `node-pty`, the Xcode command line tools are missing or incomplete (step 2).
7. **Start it.**
   - If they want it at login: create `~/Library/LaunchAgents/com.fleet.plist` from the template in "Starting it at login" above, filling in their home folder, the clone's path and the output of `which npm`; run `mkdir -p state` in the clone; then `launchctl load` it.
   - Otherwise: run `npm start` in the background and tell the person it stops when that session ends.
8. **Confirm it is up:** `curl -s http://127.0.0.1:7777/api/config` returns JSON.
9. **Tell the person** Fleet is at http://127.0.0.1:7777, whether it starts at login, and how to update (`git pull`, `npm install`, `npm run build`, then restart it).

If something fails:

| Message | What to do |
|---|---|
| `node: command not found` or Node older than v20 | `brew install node` (or `brew upgrade node`), then open a new Terminal window. |
| `gyp` or `node-pty` errors during `npm install` | Run `xcode-select --install`, wait for it to finish, rerun `npm install`. |
| `reposRoot ... does not exist` | The path in `fleet.config.json` is wrong. Use an absolute path, not `~`. |
| `No config at ...` | Step 5 was skipped: copy `fleet.config.example.json` to `fleet.config.json`. |
| Chats do not start | Run `claude auth login` in Terminal. |
| A terminal tab fails with `posix_spawnp failed` | Fleet fixes this itself when it starts; on an older checkout run `chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper` and restart Fleet. |
| A terminal tab cannot find `brew`, `node` or `claude` | Terminals open as a login shell and read `~/.zprofile`; make sure Homebrew's and nvm's setup lines are there, not only in `~/.zshrc`. |
| `EADDRINUSE` / port 7777 in use | Start with `FLEET_PORT=7787 npm start` (any free port) and use that address. |
| Blank page | The web app was not built: run `npm run build`, then reload. |
| Does not start at login | `tail state/fleet.log`; the usual cause is a wrong `npm` path in the plist. |

## Not available on a Mac

- The one-command installer, `npm run restart` and `npm run ship` (PowerShell scripts).
- The AWS credential hub: it is off unless `aws.profile` is set in the config, and its defaults assume Windows. Leave it empty.

## Uninstalling

```
launchctl unload ~/Library/LaunchAgents/com.fleet.plist    # only if you set up login start
rm ~/Library/LaunchAgents/com.fleet.plist
```

Then delete the `claude-fleet` folder. Your Claude Code sessions are untouched; Fleet only reads them.
