# lifecycle

Hunts for entities that get stranded, double-counted or stuck.

## Checklist

- Write down the states yourself, since there is no signed matrix: for every entity the diff moves (a case row, a new tracking row, a rule), the combinations of its columns and flags that matter (status_id, verdict, is_* flags, resolved_at, matured), including combinations nobody intends but the system allows.
- For every state: which surface shows it (page, tab, menu count, export, job select). Each state must appear on at least one surface or be deliberately hidden. A state that every surface's WHERE clause excludes is a stranded entity: report it.
- For every flag the diff sets (resent, do-not-work, matured, resolved): which queries filter on it, and where does an entity with the flag set go if its main status comes back (bounce back to the same status, a resend, a manual status change, a transport bounce)?
- How each state is left: which job or user action, under which exact condition in code. Compare every exit and release condition with what the PR description and ticket say releases or moves it; a promised release the code never checks is a bug (quote the sentence and the condition).
- Non-terminal values: when a release checks for one value (verdict = 2), list the other values the column can hold and what happens to each.
- Terminal states really terminal: can a resolved or closed row be reopened or picked up again by the next sweep?
- Jobs idempotent on re-run; cron order between repos (a nightly ETL job vs the jobs in the other repo that read its table).
