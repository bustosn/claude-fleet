# Fleet

A local control room for running many Claude Code sessions at once across git worktrees. One window shows every session on the machine, where it is working, and what it is waiting on. Chats are hosted through the Claude Agent SDK, can talk to each other, and daily chores like AWS credential refresh live in a hub.

Node + TypeScript server, React + TypeScript + Vite + Tailwind web app. No framework beyond that, no build step for the server.

## Run

```
cp fleet.config.example.json fleet.config.json   # once, then set reposRoot and claudeHome
npm install
npm run build      # once, builds the web app into dist/web
npm start          # daily instance: http://127.0.0.1:7777
```

Development happens in a second checkout so the daily instance never restarts mid-chat:

```
git worktree add ../claude-fleet-dev dev     # once
cd ../claude-fleet-dev && npm install
npm run dev        # API on 7778 with restart-on-change, Vite on http://localhost:5178 with HMR
npm run check      # typecheck both sides and build
```

`FLEET_PORT` and `FLEET_CONFIG` override the port and config path. Live chats are saved to `state/chats-<port>.json` and reopened after a restart.

## Keep it running

```
powershell -ExecutionPolicy Bypass -File .\scripts\autostart.ps1            # once: logon task "ClaudeFleet" runs npm start hidden, logs to state\fleet.log
powershell -ExecutionPolicy Bypass -File .\scripts\autostart.ps1 -Restart   # after shipping a change: stop + start the daily instance
```

Shipping a change, once it is committed on `dev`:

```
npm run ship       # from either checkout: merge dev into main, install if the lockfile changed, build, smoke-test, restart the daily instance, push main
```

The smoke test loads the fresh build in headless Chrome on a spare port and fails the ship if the app does not render or throws, so a bad build never reaches the daily instance. Run it by hand against anything: `node scripts/smoke.mjs http://127.0.0.1:7777`. It leaves a screenshot in `state/smoke.png`.

To have any `git merge` or `git pull` on main build and restart by itself, point git at the tracked hooks once:

```
cd ~/claude-fleet && git config core.hooksPath scripts/hooks
```

`ship` turns hooks off for its own merge, so enabling them does not make it build and restart twice.

A restart ends the daily instance's live chat processes; they reopen from their saved sessions on the next start.

## What it reads and drives

| | How |
|---|---|
| Sessions | `claude agents --json --all` (terminal, background, and the dashboard's own chats) |
| Background job detail | `~/.claude/jobs/<id>/` (best effort; not a stable contract) |
| Worktrees | `git worktree list`, `git status`, `git log` for every repo under `reposRoot` |
| Saved conversations | the Agent SDK's `listSessions`, `getSessionMessages`, `renameSession` |
| Chats | the Agent SDK's `query()` in streaming-input mode, one subprocess per chat |
| Agent-to-agent | an in-process MCP server (`fleet_list_chats`, `fleet_send`, `fleet_ask`, `fleet_reply`, `fleet_read`) mounted into every chat |
| AWS credentials | `~/bin/awsreset` for the silent path; `aws sso login --use-device-code` with the approval page opened in your browser as the fallback |
| Terminals | `node-pty` shells in the server, `xterm.js` in a tab, a WebSocket between them. Closing the tab keeps the shell; Kill ends it. A `claude` started in one shows up as a session like any other |

Design and roadmap: [`docs/plans/`](docs/plans/). If you are an agent working on this repo, start at [`docs/agents/`](docs/agents/).

## Config

`fleet.config.json`: `reposRoot`, `claudeHome`, `port`, poll intervals, `dispatch` defaults, the `roles` model map (director, manager, coder, reviewer, searcher), the `aws` section, and `terminal.shell` (null picks PowerShell on Windows, `$SHELL` elsewhere).

It is not tracked: each machine (and each worktree) keeps its own copy, made from `fleet.config.example.json`. `reposRoot` and `claudeHome` are the only values that have to change. Leave `aws.profile` empty and the credential hub turns itself off — no AWS CLI or SSO profile needed.
