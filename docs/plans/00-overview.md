# 00 — Overview

## What Fleet is

Fleet is a local control room for one developer running many Claude Code sessions at once across git worktrees. It shows every session on the machine (terminal, background, and the chats it hosts itself), where each one is working, and what it is waiting on. It hosts chats through the Claude Agent SDK, lets those chats talk to each other with a small set of tools, and collects daily chores like AWS credential refresh into a hub.

The main feature is the **project tree**: repos, their worktrees, and the sessions living in each, with live status. Everything else hangs off that spine.

## Principles

1. **Piggyback on Claude Code.** Sessions, transcripts, resume, rename, worktrees, and cross-session messaging already exist in the CLI and SDK. Fleet reads and drives them; it does not reimplement them.
2. **One accent, status with labels.** Interactive and selected states use the accent. Status is a dot plus a word, never color alone. Dense, quiet, precise.
3. **Loud failures, one-click fixes.** A dead daemon, a stale job record, an expired credential: say what it is and offer the fix next to it.
4. **Nothing auto-submits on the user's behalf.** Agents coordinate with each other freely; anything that touches a human-facing system (Jira, GitHub, AWS consent) stays a visible action.
5. **Two instances.** The daily instance on 7777 never restarts mid-work; development happens in a worktree on 7778.

## Architecture in one paragraph

A Node + TypeScript server (`server/`) polls `claude agents --json`, the jobs folder, `git` for every repo under `reposRoot`, and the SDK's session list; it merges them into one snapshot pushed over server-sent events. Chats are SDK `query()` sessions in streaming-input mode, one subprocess each, with an in-process MCP server (`fleet_*` tools) for agent-to-agent messaging. The web app (`web/`, React + TypeScript + Vite + Tailwind) renders the snapshot and the chat event streams. Shared types live in `shared/types.ts`.

## Roadmap

| Milestone | Scope | State |
|---|---|---|
| M0 | Collector, snapshot, board, worktree table (vanilla JS) | done |
| M1 | SDK chats: resume, new chat, streaming, permissions, rename | done |
| M2 | Fleet tools: list, send, ask, reply, read; manual forward | done |
| M3 | Hub: AWS credential refresh with silent path and device-code fallback | done |
| M4 | TypeScript + React rebuild around the project tree shell | in progress |
| M5 | Dispatch: start sessions in new worktrees from a ticket, stop/respawn/remove | planned |
| M6 | Queue and roles: director, manager, coder, reviewer, searcher with a concurrency cap | planned |
| M7 | Fleet as an MCP server so a director session can drive it | planned |

Related docs: [`01-layout.md`](01-layout.md) for the shell, [`02-chats-and-fleet-tools.md`](02-chats-and-fleet-tools.md) for the chat runtime.
