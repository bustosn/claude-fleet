# 02 — Chats and fleet tools

## Chat runtime

`server/chat.ts`. One `Chat` is one `query()` call from `@anthropic-ai/claude-agent-sdk` in streaming-input mode: the prompt is an async queue (`Inbox`) the server pushes user turns into, so the subprocess lives as long as the chat does. Options worth knowing:

- `systemPrompt: { type: 'preset', preset: 'claude_code' }` and default `settingSources`, so a dashboard chat behaves like a terminal session: same CLAUDE.md, skills, MCP servers, memory.
- `resume: <sessionId>` continues a saved conversation. If that session is open in a terminal, `forkSession: true` is passed, because the CLI treats a resume of a running session as a copy.
- `canUseTool` turns permission prompts into `permission` events the web app answers with Allow / Deny.
- `includePartialMessages` streams text deltas; the complete `assistant` message then replaces the streamed entry, so nothing renders twice.

Events are a small union (`ChatEvent` in `shared/types.ts`) buffered per chat (last 800) and replayed to any client that connects. Live chats are persisted to `state/chats-<port>.json` and reopened after a restart.

## Fleet tools

`server/fleetTools.ts` mounts an in-process MCP server named `fleet` into every chat:

| Tool | Behavior |
|---|---|
| `fleet_list_chats` | Other live chats: id, title, repo, branch, cwd, status, model. |
| `fleet_send` | Deliver a message as a user turn labelled with the sender. Fire-and-forget. |
| `fleet_ask` | Deliver a question with an ask id and block until `fleet_reply`, or until the target's next turn ends if it was idle when asked. Default 300s timeout. |
| `fleet_reply` | Resolve an ask by id. |
| `fleet_read` | Last N user/assistant messages of another chat. |

Guards: an ask is refused if the target is already waiting on the asker; asks time out; ending a chat rejects anything waiting on it. The tools are auto-approved through `allowedTools`, which is why the SDK's "canUseTool shadowed" warning is filtered in `server/index.ts`.

Verified 2026-10-09: two Haiku chats, one in ETL and one in COR3; the first found the second, asked which branch it was on, the second ran git and replied through the tool, round trip about 18 seconds.

## What is deliberately not here

- Claude Code's own `SendMessage` / `ListAgents` still work inside every session for talking to terminal sessions, but that traffic does not show in the dashboard.
- No automatic approval of SSO consent screens. The AWS hub opens the approval page in the user's own browser.
