import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEdit } from './sqlEdit.js';
import { classifyWrite } from '../shared/sqlClassify.js';

const cols = ['id', 'case_no', 'note', 'amount'];

test('an update is one statement keyed on the whole primary key, with LIMIT 1', () => {
  const r = buildEdit({ op: 'update', db: 'cb911', table: 't', pk: { id: 5 }, set: { note: 'x', amount: null } }, cols, ['id']);
  assert.equal(r.sql, "UPDATE `cb911`.`t` SET `note` = 'x', `amount` = NULL WHERE `id` = 5 LIMIT 1");
  assert.equal(r.countSql, 'SELECT COUNT(*) AS n FROM `cb911`.`t` WHERE `id` = 5');
});

test('a delete is keyed and limited the same way', () => {
  assert.equal(buildEdit({ op: 'delete', db: 'cb911', table: 't', pk: { id: '7' } }, cols, ['id']).sql, "DELETE FROM `cb911`.`t` WHERE `id` = '7' LIMIT 1");
});

test('composite keys need every part, case-insensitively', () => {
  const r = buildEdit({ op: 'update', db: 'd', table: 't', pk: { A: 1, b: 'z' }, set: { note: 'n' } }, ['a', 'b', 'note'], ['a', 'b']);
  assert.match(r.sql, /WHERE `a` = 1 AND `b` = 'z' LIMIT 1$/);
  assert.throws(() => buildEdit({ op: 'update', db: 'd', table: 't', pk: { a: 1 }, set: { note: 'n' } }, ['a', 'b', 'note'], ['a', 'b']), /every part/);
});

test('refused: no primary key, NULL key, key column changes, unknown column, empty set, odd names', () => {
  assert.throws(() => buildEdit({ op: 'delete', db: 'd', table: 't', pk: {} }, cols, []), /no primary key/);
  assert.throws(() => buildEdit({ op: 'delete', db: 'd', table: 't', pk: { id: null } }, cols, ['id']), /NULL/);
  assert.throws(() => buildEdit({ op: 'update', db: 'd', table: 't', pk: { id: 1 }, set: { id: 2 } }, cols, ['id']), /primary key/);
  assert.throws(() => buildEdit({ op: 'update', db: 'd', table: 't', pk: { id: 1 }, set: { nope: 2 } }, cols, ['id']), /no column/);
  assert.throws(() => buildEdit({ op: 'update', db: 'd', table: 't', pk: { id: 1 }, set: {} }, cols, ['id']), /Nothing to change/);
  assert.throws(() => buildEdit({ op: 'delete', db: 'd', table: 't`; DROP TABLE x; --', pk: { id: 1 } }, cols, ['id']), /Not a table name/);
  assert.throws(() => buildEdit({ op: 'update', db: 'd', table: 't', pk: { id: 1 }, set: { 'note` = 1, `id': 2 } }, cols, ['id']), /no column/);
});

test('values are escaped, never pasted, and the result is one statement the dev classifier takes without a danger flag', () => {
  const r = buildEdit({ op: 'update', db: 'd', table: 't', pk: { id: "1' OR '1'='1" }, set: { note: "x'; DROP TABLE t; --" } }, cols, ['id']);
  const c = classifyWrite(r.sql);
  assert.equal(c.ok, true); assert.equal(c.write, true); assert.equal(c.danger, null);
  assert.equal(classifyWrite(buildEdit({ op: 'delete', db: 'd', table: 't', pk: { id: 1 } }, cols, ['id']).sql).danger, null);
});

import { editTarget } from '../shared/resultIdentity.js';
const col = (name: string, table = 't', db = 'cb911') => ({ name, table, db, orgName: name });

test('a plain read of one table with its key is editable, except the key itself', () => {
  const r = editTarget('SELECT id, case_no, note FROM cb911.t WHERE id < 5', [col('id'), col('case_no'), col('note')], ['id']);
  assert.deepEqual(r.target, { db: 'cb911', table: 't', pk: [0], editable: [false, true, true] });
  // Under an alias, and with the columns in another order.
  assert.deepEqual(editTarget('SELECT x.note, x.id FROM cb911.t x', [col('note'), col('id')], ['id']).target?.pk, [1]);
});

test('not editable: joins, grouping, aggregates, subqueries, unions, missing or absent keys, expressions', () => {
  const c = [col('id'), col('note')];
  for (const sql of ['SELECT t.id, t.note FROM cb911.t JOIN cb911.u ON u.id = t.id', 'SELECT id, note FROM t GROUP BY id, note', 'SELECT DISTINCT id, note FROM t',
    'SELECT id, note FROM t UNION SELECT id, note FROM u', 'SELECT id, MAX(note) FROM t', 'SELECT id, note FROM t WHERE id IN (SELECT id FROM u)',
    'WITH x AS (SELECT 1) SELECT id, note FROM t', 'SELECT id, note FROM t, u', 'SHOW TABLES', 'SELECT id, note FROM (SELECT id, note FROM t) d'])
    assert.equal(editTarget(sql, c, ['id']).target, null, sql);
  assert.match(editTarget('SELECT note FROM t', [col('note')], ['id']).why || '', /primary key/);
  assert.match(editTarget('SELECT id FROM t', [col('id')], null).why || '', /no primary key/);
  // An expression column is read-only; the key not selected means no edits at all.
  assert.deepEqual(editTarget('SELECT id, note, id + 1 AS nxt FROM t', [col('id'), col('note'), { name: 'nxt', table: '' }], ['id']).target?.editable, [false, true, false]);
  // The same column twice is ambiguous.
  assert.deepEqual(editTarget('SELECT id, note, note AS n2 FROM t', [col('id'), col('note'), { ...col('note'), name: 'n2' }], ['id']).target?.editable, [false, false, false]);
});
