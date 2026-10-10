# 03 — Dialogues

Two chats talk a topic through while Fleet relays every message and the person moderates. The orchestrator is server code, not a third model: it owns the turn order, the round count, and the framing each side reads, so a dialogue always runs to the length asked for and costs exactly two sessions.

## Runtime

`server/dialogue.ts`. A `Dialogue` holds two `Participant`s (side A speaks first), the topic, a round count (one round is a message from each side), and a word budget. Each participant is a `Chat` from `server/chat.ts`: either a new one the dialogue starts (`owned`) in the folder given, or a live chat the person attached, which keeps its context and is left running afterwards.

The loop in `Dialogue.run()`:

1. Wait for the speaker's chat to be idle, in case the person typed into it.
2. Send the composed message with a `dialogue` origin. The first message each side receives is the brief (topic, its role and persona, the other side's name, the length rules, and an instruction not to use the fleet tools). Every later message is the other side's last reply under a `message N of M` header, plus any queued moderator notes, plus a closing cue on the side's last message.
3. Wait for the chat's `result` event and take the turn's text. An empty turn gets one nudge, then the dialogue fails.
4. Record a `turn` event; the reply becomes the next speaker's prompt.

New participant chats start in `state/scratch/` unless a worktree is chosen, so no project `CLAUDE.md` pulls them toward repo work. They still carry the user-level `~/.claude` settings and the `claude_code` preset system prompt like every other chat.

## Moderation

| Action | Effect |
|---|---|
| Steer | Queue a note; the next speaker reads it under its message as a note from the person running the dialogue. |
| Pause | Takes effect after the current message finishes; `pausePending` in the summary while waiting. |
| Resume | Continue with the next speaker. Also how a dialogue continues after a server restart. |
| Extend | Add rounds. A `done` dialogue picks up where it stopped: both chats are still open and hold the conversation. |
| Stop | End the dialogue and the chats it started. On a finished dialogue it only ends the chats. |
| Remove | Stop, then forget the dialogue. |

The transcript is available as markdown at `GET /api/dialogues/:id/transcript.md`.

## Lifecycle and persistence

`running → paused → running → done`, or `ended` (stopped) or `failed` (a chat ended mid-turn, or two empty turns). Done keeps the owned chats alive so Extend works; failed and ended close them. While a dialogue is live, each participant chat carries `dialogueId` in its summary, the chat view shows a banner, and the new-dialogue form refuses to attach it elsewhere.

Every dialogue with its events is written to `state/dialogues-<port>.json` on each change. On start, finished ones come back as records; live ones come back `paused` with a note, because their chats were reopened by the chat manager from the saved sessions and the loop can continue when the person presses Resume.

## Web

`web/src/views/DialogueView.tsx` streams `/api/dialogues/:id/events` (a `dialogue` SSE event carries the summary after every change). Side A renders on the left, side B on the right, moderator notes in the middle, and the composer sends notes rather than messages. `NewDialogue.tsx` is the form; `DialogueList.tsx` the sidebar section; the tab strip, palette, and terminal folder lookup know the `dialogue` view kind.

Verified 2026-10-09 on a throwaway instance: two Haiku chats, two rounds with a steer and a pause before the first reply, resume, extend by one round after done, stop. About 5 seconds a message.

## Not here yet

- A model as moderator. The person is the moderator; a third chat that reads the transcript and steers could be added as a participant-like role later.
- More than two sides. The relay is written for A and B; a round-robin over N would need a different turn rule and a different brief.
