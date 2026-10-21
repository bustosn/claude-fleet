# Fleet

A local control room for running many Claude Code sessions at once across git worktrees. One window shows every session on the machine, where it is working, and what it is waiting on. Chats are hosted through the Claude Agent SDK, can talk to each other, and daily chores like AWS credential refresh live in a hub.

Node + TypeScript server, React + TypeScript + Vite + Tailwind web app. No framework beyond that, no build step for the server.

## Install

On Windows, from a clone: `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`. It installs Git, Node.js and Claude Code if missing, writes the config, builds, and starts Fleet at logon. Step by step, including a version to hand to Claude Code: [INSTALL.md](INSTALL.md).

On a Mac, from a clone: `./scripts/install.sh`. It does the same, with Homebrew for Git and Node.js and a launch agent for starting at login. Step by step: [INSTALL-MAC.md](INSTALL-MAC.md). The repo is private, so your GitHub account needs access first. (Untested on a Mac so far.)

By hand, on any OS (Node 20+, git, and a signed-in Claude Code):

```
cp fleet.config.example.json fleet.config.json   # once, then set reposRoot (the folder holding your git repos) and claudeHome to real paths
npm install
npm run build      # once, builds the web app into dist/web
npm start          # daily instance: http://127.0.0.1:7777
```

## Working on Fleet

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
npm run restart                                                             # stop + start the daily instance (runs autostart.ps1 -Restart)
```

If the daily instance drops or hangs, `npm run restart` (same as the `-Restart` line above) stops it and starts it again without a rebuild.

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
| Board | tasks you queue (New task). Fleet starts a chat on each while `dispatch.maxConcurrent` slots are free; the chat calls `fleet_report` (or just ends its turn) and the card moves to Needs you with its summary. Approve ends the chat and moves the card to Done; Send back sends your feedback as its next message. By default each task gets its own `fleet/<ticket-or-title>` branch and a worktree under `<repo>/.claude/worktrees/`, so tasks in one repo don't collide; Approve removes the worktree (unless it has uncommitted changes) and keeps the branch. Other chats sit in a collapsed strip below |
| Jira | paste a ticket key or link into New task and the agent works from the ticket (description, latest comments). With `jira.jql` set, Fleet polls that query every `everyMinutes` and starts a task for each new match, once per ticket. Tickets go to the folder in `jira.repos` for their project, or to a repo named by one of their labels. Read-only: Fleet never writes to Jira. Setup: [JIRA-SETUP.md](JIRA-SETUP.md) |
| Dialogues | two chats talk a topic through: the server relays each message, counts rounds, and you steer, pause, extend, or stop. Transcript as markdown |
| AWS credentials | `~/bin/awsreset` for the silent path; `aws sso login --use-device-code` with the approval page opened in your browser as the fallback |
| Terminals | `node-pty` shells in the server, `xterm.js` in a tab, a WebSocket between them. Closing the tab keeps the shell; Kill ends it. A `claude` started in one shows up as a session like any other |

## What a chat does like Claude Code

- **Questions:** Claude's `AskUserQuestion` shows as a checklist card (radio or checkbox options plus an Other box); Skip tells Claude to carry on.
- **Plans:** `ExitPlanMode` shows the plan as markdown with Approve (auto-accept edits / ask per edit) or Keep planning.
- **Permissions:** edits show a diff before you allow them; Always allow applies the SDK's suggested rule for the session.
- **Modes and effort:** the header switches permission mode (Shift+Tab in the composer cycles it) and thinking effort.
- **Tasks:** the model's task list pins above the composer; subagents and background tasks get live rows with Stop.
- **Composer:** `/` commands, `@` file completion, `!` shell, pasted or dropped files.
- **Context:** click the context figure for the `/context` breakdown. "Restore files" on a message puts files back to before it (this run only; the conversation is kept).
- **Away from the tab:** a count in the tab title, plus a desktop notification when a chat needs you (the browser asks once).

Task-list tools are only offered to the model families Claude Code offers them to, so the panel appears when the model uses them.

Design and roadmap: [`docs/plans/`](docs/plans/). If you are an agent working on this repo, start at [`docs/agents/`](docs/agents/).

## Config

`fleet.config.json`: `reposRoot`, `claudeHome`, `port`, poll intervals, `dispatch` defaults, the `roles` model map (director, manager, coder, reviewer, searcher), the `aws` section, and `terminal.shell` (null picks PowerShell on Windows, `$SHELL` elsewhere).

It is not tracked: each machine (and each worktree) keeps its own copy, made from `fleet.config.example.json`. `reposRoot` is the only value that has to change; `claudeHome` defaults to `~/.claude`. Leave `aws.profile` empty and the credential hub turns itself off — no AWS CLI or SSO profile needed.
