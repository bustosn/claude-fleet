# consistency

Hunts for one concept defined in several places, where the definitions drift.

## Checklist

- List every place the diff defines or filters the same concept: a status, "open", "active", "pending", "resolved", a permission, a constant. Put the definitions side by side (quote each WHERE clause or condition with its file and line) and say exactly where they differ and which state falls between them.
- Every query that decides membership in a set (a page, a tab, a job's select, a hold/release check) against every other query over the same entity: is there a state that is in one set and missing from its complement, or in both?
- The same literal (a status id like 146, a verdict id like 3, a flag value) hardcoded in several classes instead of one constant: report it as a minor finding listing each occurrence, even when they all agree today. A constant defined and then not used next to a literal is the same finding.
- Two copies of the same logic: UI builders, modal fillers, formatters, query fragments. Report them (minor at least). Say whether both run on the same path and whether they disagree.
- A filter added to a table's query but not to its count, menu, dropdown or export query (the menu then offers rows the table hides, or the other way round).
- Constants or helpers introduced in one file but the old literal left in another.
