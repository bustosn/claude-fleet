[Fleet QA run {{runId}} · dedupe]

Several reviewers reported bugs in the same change, each looking through a different lens, so some reports describe the same bug. Below are the reports, already grouped by code location (numbered groups). Your one job: find groups that describe **the same root cause** and merge them.

- Merge only when fixing one would fix the other. Two different bugs in the same function stay apart. A bug and a broader one it is a symptom of may be merged, with the root cause named.
- Do not judge whether the reports are true; a verifier does that next.
- You may open files in the context pack (`{{packDir}}`) to understand a report, but you rarely need to.

Call `fleet_qa_group` once with every merge, each as the list of group numbers plus a one-sentence root cause and a short title for the merged group. Groups you leave out stay as they are. If nothing should be merged, call it with an empty list. Then end your turn with one line.

## Reports

{{groups}}
