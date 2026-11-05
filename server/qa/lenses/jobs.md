# jobs

Hunts for cron and batch behaviour that fails under real conditions.

## Checklist

- Overlapping runs: withoutOverlapping or a lock, and what two concurrent runs would do to the same rows.
- Partial failure halfway through a batch: transactions, what is left half-written, whether the next run repairs it.
- Re-run safety: running twice gives the same result; dry-run flags really write nothing.
- Run time at prod size: unbounded selects, per-row queries inside loops, chunking.
- The source table empty, or the DB connection dropping mid-run.
- Schedule order against jobs in other repos that read or write the same tables (the schedule is in surfaces.md when the diff touches a job).
- Logging enough to debug a bad night: counts, ids, errors with context.
