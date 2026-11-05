# performance

Hunts for queries and pages that will not hold at prod size.

## Checklist

- EXPLAIN every new or changed query on the prod reader with fleet_sql (EXPLAIN is read-only): full scans on large tables, joins without an index on the join column, filesort on big sets. Fill in realistic literals.
- Correlated subqueries and NOT EXISTS / LEFT JOIN ... IS NULL on large tables inside page queries.
- N+1: queries inside row formatters, loops or DataTables render paths.
- Unbounded result sets: no LIMIT or paging; server-side DataTables paging really applied to the query, not to an array after loading everything.
- Count queries that repeat the whole page query.
- Size the tables you touch with `SELECT COUNT(*)` or information_schema TABLE_ROWS on the prod reader before calling something slow.
