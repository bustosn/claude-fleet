# To fix

Known bugs to come back to. Add new ones at the top; delete an entry once it's fixed.

## Dialogues treat a usage-limit notice as a participant's reply

**Found:** 2026-10-11, dialogue `e64296c8` (both participants on fable after the Fable quota ran out).

**What happens:** The dialogue reports `done` after all 12 turns, but every turn in the transcript is the CLI notice "You've reached your Fable limit. Switch to another model, or manage usage credits at …". The run burns through every round with no conversation, and nothing in the UI marks it as failed.

**Why:** `Dialogue.awaitReply()` in `server/dialogue.ts` resolves on any `result` event and returns `chat.turnText`. When the model can't run, the CLI prints the limit notice as the turn's text and sends a `result`, so the notice looks like a normal reply. The `result` event built in `server/chat.ts` (around line 338) forwards `subtype` and `errors`, but not the SDK message's `is_error` flag, so the dialogue has no way to tell the two apart.

**Fix:**
- Forward `is_error` on the `result` chat event (`shared/types.ts` + `server/chat.ts`).
- In `awaitReply()`, when the result is an error (or `subtype !== 'success'`), throw with the turn text, e.g. "Rex's model could not answer: You've reached your Fable limit…". `run()` already turns a throw into a `failed` dialogue with the message shown as a system note.
- Optional: say in that note that the dialogue can be restarted with a different model per participant.

**Check:** Start a dialogue on a model that's out of quota. It should stop as `failed` after the first turn, with the limit message shown, and not record it as Rex's reply.
