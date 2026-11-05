# data

Hunts for schema, migration and deploy-order problems.

## Checklist

- Every table and column the code uses exists in a migration or a DDL file (ddl.md) and on both dev and prod (schema.md). A table that exists on neither and in no committed file is a deploy risk: say what breaks and when.
- Deploy order between repos (DDL, then one repo, then the other): what breaks if they merge or deploy out of order, and which page or job fails first. Is the order written down anywhere a deployer will see it?
- Upsert keys match a unique index; ON DUPLICATE KEY / updateOrInsert on columns that are not unique.
- Index names follow the repo convention (`ix_` for indexes, `ux_` for unique ones); indexes exist for the new WHERE and JOIN columns.
- Backfills or cleanups the change needs (bad values already stored that the new code assumes are clean).
- Null handling on new columns; defaults that hide missing data; types that truncate (TINYINT for an id, VARCHAR shorter than the source).
- Collation or charset mismatches on new join columns.
