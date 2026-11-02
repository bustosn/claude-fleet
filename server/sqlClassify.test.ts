import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, classifyWrite, split, statementAt, hasTopLevelLimit, limitable, withLimit, errorOffset } from '../shared/sqlClassify.js';

const reads = [
  'SELECT * FROM cb911.cb_chargebacks WHERE id = 1',
  'select id from t',
  '(SELECT 1) UNION (SELECT 2)',
  'WITH x AS (SELECT 1 AS a) SELECT a FROM x',
  'SHOW CREATE TABLE cb911.cb_chargebacks',
  'SHOW CHARACTER SET',
  'SHOW INDEX FROM cb911.cb_chargebacks',
  'DESCRIBE cb911.cb_chargebacks',
  'DESC cb911.cb_chargebacks',
  'EXPLAIN SELECT * FROM t WHERE case_no = 1',
  "SELECT REPLACE(name, 'a', 'b'), INSERT(name, 1, 2, 'x'), TRUNCATE(amount, 2) FROM t",
  'SELECT `update`, `delete` FROM t',
  "SELECT 'DELETE FROM t; DROP TABLE t' AS s",
  'SELECT update_date, delete_flag FROM t',
  "SELECT CAST(x AS CHAR CHARACTER SET utf8mb4) FROM t",
  'SELECT 1 -- DELETE FROM t',
  'SELECT 1 /* DROP TABLE t */',
  'SELECT /*+ MAX_EXECUTION_TIME(1000) */ id FROM t',
];
const writes = [
  'UPDATE t SET a = 1',
  'DELETE FROM t',
  'INSERT INTO t VALUES (1)',
  'REPLACE INTO t VALUES (1)',
  'WITH x AS (SELECT 1) UPDATE t JOIN x SET t.a = 1',
  'WITH x AS (SELECT 1) DELETE FROM t',
  "SELECT * FROM t INTO OUTFILE '/tmp/x'",
  'SELECT * FROM t INTO @v',
  'SELECT * FROM t FOR UPDATE',
  'SELECT * FROM t FOR SHARE',
  'SELECT * FROM t LOCK IN SHARE MODE',
  'SET @x := 1',
  'SET SESSION sql_mode = ""',
  'SELECT 1 /*!50000 , (SELECT 1 FROM t) INTO OUTFILE "/tmp/x" */',
  '/*!DELETE FROM t*/',
  'SELECT 1; DELETE FROM t',
  'EXPLAIN ANALYZE DELETE FROM t',
  'CALL proc()',
  'DROP TABLE t',
  'USE cb911',
  'TRUNCATE TABLE t',
  "SELECT LOAD_FILE('/etc/passwd')",
  'BEGIN',
];

test('reads pass', () => { for (const s of reads) assert.equal(classify(s).ok, true, s); });
test('writes and locks are refused', () => { for (const s of writes) assert.equal(classify(s).ok, false, s); });

test('split ignores semicolons in strings, identifiers and comments', () => {
  const sql = "SELECT ';' AS a;\nSELECT `x;y` FROM t; -- ; trailing\n/* ; */ SELECT 3";
  assert.deepEqual(split(sql).map(s => s.text), ["SELECT ';' AS a", 'SELECT `x;y` FROM t', 'SELECT 3']);
});

test('statement under the cursor, or the one before it', () => {
  const sql = 'SELECT 1;\n\nSELECT 2;\n\n\nSELECT 3';
  assert.equal(statementAt(sql, 3)?.text, 'SELECT 1');
  assert.equal(statementAt(sql, sql.indexOf('2'))?.text, 'SELECT 2');
  assert.equal(statementAt(sql, sql.indexOf('2') + 3)?.text, 'SELECT 2');
  assert.equal(statementAt(sql, sql.length)?.text, 'SELECT 3');
  assert.equal(statementAt('', 0), null);
});

test('a blank line ends a statement, as in DBeaver', () => {
  const sql = 'SELECT *\nFROM a\nWHERE x = 1\n\nSELECT * FROM b\n   \t\nSELECT 3';
  assert.deepEqual(split(sql).map(s => s.text), ['SELECT *\nFROM a\nWHERE x = 1', 'SELECT * FROM b', 'SELECT 3']);
  assert.equal(statementAt(sql, sql.indexOf('FROM a'))?.text, 'SELECT *\nFROM a\nWHERE x = 1');
  assert.equal(statementAt(sql, sql.indexOf('FROM b'))?.text, 'SELECT * FROM b');
  // Inside parentheses, strings and comments a blank line is just a blank line.
  const sub = 'SELECT * FROM t WHERE id IN (\n\n  SELECT id FROM u\n\n)';
  assert.deepEqual(split(sub).map(s => s.text), [sub]);
  const str = "SELECT 'a\n\nb' AS s";
  assert.deepEqual(split(str).map(s => s.text), [str]);
  const cmt = 'SELECT 1 /* note\n\nmore */ FROM t';
  assert.deepEqual(split(cmt).map(s => s.text), [cmt]);
  // A comment line above a query stays out of it but does not glue two queries together.
  assert.deepEqual(split('SELECT 1\n\n-- next\nSELECT 2').map(s => s.text), ['SELECT 1', 'SELECT 2']);
  // A selection runs as one query, blank lines and all.
  assert.equal(split('SELECT *\n\nFROM t', { blankLines: false }).length, 1);
  // A write hiding after a blank line is its own statement, and refused when run.
  const two = split('SELECT 1\n\nDELETE FROM t');
  assert.equal(two.length, 2);
  assert.equal(classify(two[1].text).ok, false);
});

test('top-level LIMIT only', () => {
  assert.equal(hasTopLevelLimit('SELECT * FROM t LIMIT 5'), true);
  assert.equal(hasTopLevelLimit('SELECT * FROM (SELECT * FROM t LIMIT 5) x'), false);
  assert.equal(hasTopLevelLimit("SELECT 'LIMIT 5' FROM t"), false);
  assert.equal(limitable('SELECT * FROM t'), true);
  assert.equal(limitable('SHOW TABLES'), false);
  assert.equal(limitable('SELECT * FROM t limit 10'), false);
  assert.equal(withLimit('SELECT 1 -- note', 500), 'SELECT 1 -- note\nLIMIT 500');
});

test('error position from the MySQL message', () => {
  const stmt = 'SELECT id\nFROM t\nWHER id = 1';
  const e = errorOffset(stmt, "You have an error in your SQL syntax; check the manual ... near 'WHER id = 1' at line 3");
  assert.equal(e.line, 3);
  assert.equal(e.offset, stmt.indexOf('WHER'));
  assert.equal(e.length, 4);
  assert.deepEqual(errorOffset(stmt, 'Unknown column x'), { line: null, offset: null, length: 0 });
});

test('dev connections: any one statement, transactions refused, risky writes flagged', () => {
  for (const r of ['SELECT 1', 'SHOW TABLES']) assert.deepEqual([classifyWrite(r).ok, classifyWrite(r).write], [true, false], r);
  const fine = ["UPDATE cb911.t SET a = 1 WHERE id = 5", 'DELETE FROM t WHERE id IN (1, 2)', "INSERT INTO t (a) VALUES (1)", 'CREATE TABLE x (id INT)', 'ALTER TABLE x ADD COLUMN b INT', 'INSERT INTO t SELECT * FROM u'];
  for (const w of fine) { const c = classifyWrite(w); assert.equal(c.ok, true, w); assert.equal(c.write, true, w); assert.equal(c.danger, null, w); }
  const risky = ['UPDATE t SET a = 1', 'DELETE FROM t', 'UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)', 'TRUNCATE TABLE t', 'DROP TABLE t', 'WITH x AS (SELECT 1) DELETE FROM t'];
  for (const w of risky) { const c = classifyWrite(w); assert.equal(c.ok, true, w); assert.ok(c.danger, w); }
  for (const t of ['BEGIN', 'START TRANSACTION', 'COMMIT', 'ROLLBACK', 'SET autocommit = 0', 'LOCK TABLES t WRITE', 'UPDATE t SET a = 1 WHERE id = 1; DELETE FROM t'])
    assert.equal(classifyWrite(t).ok, false, t);
  // Prod keeps the read-only check.
  assert.equal(classify('UPDATE t SET a = 1 WHERE id = 5').ok, false);
});
