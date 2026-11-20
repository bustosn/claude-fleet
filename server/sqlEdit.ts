import mysql from 'mysql2';

/** Edits to one row of one table, built here from the table's own primary key and the values to change. The browser never sends SQL for an
 *  edit: it names the table, the key and the new values, and the statement is made (and shown in the preview) from those alone. */
export interface EditSpec { op: 'update' | 'delete'; db: string; table: string; pk: Record<string, string | number | null>; set?: Record<string, string | number | null> }

const NAME = /^[\w$]+$/;
export const quoteName = (n: string) => `\`${n}\``;

/** `UPDATE db.table SET a = ?, b = ? WHERE pk = ? LIMIT 1`, escaped through mysql2. Every primary-key column must be given (NULL is refused:
 *  `= NULL` matches nothing, and a key that is NULL does not identify a row), and every changed column must be one of the table's columns. */
export function buildEdit(e: EditSpec, columns: string[], pkCols: string[]): { sql: string; countSql: string } {
  if (!NAME.test(e.db) || !NAME.test(e.table)) throw new Error('Not a table name.');
  if (!pkCols.length) throw new Error(`${e.db}.${e.table} has no primary key, so a single row cannot be identified. Edit it with a statement instead.`);
  const have = new Set(columns.map(c => c.toLowerCase()));
  const given = Object.keys(e.pk || {});
  if (given.length !== pkCols.length || !pkCols.every(c => given.some(g => g.toLowerCase() === c.toLowerCase()))) throw new Error(`The primary key is (${pkCols.join(', ')}); every part of it must be given.`);
  const keyOf = (c: string) => Object.entries(e.pk).find(([k]) => k.toLowerCase() === c.toLowerCase())![1];
  const where = pkCols.map(c => { const v = keyOf(c); if (v == null) throw new Error(`${c} is NULL; a row cannot be identified by it.`); return `${quoteName(c)} = ${mysql.escape(v)}`; }).join(' AND ');
  const target = `${quoteName(e.db)}.${quoteName(e.table)}`;
  const countSql = `SELECT COUNT(*) AS n FROM ${target} WHERE ${where}`;
  if (e.op === 'delete') return { sql: `DELETE FROM ${target} WHERE ${where} LIMIT 1`, countSql };
  const set = Object.entries(e.set || {});
  if (!set.length) throw new Error('Nothing to change.');
  const parts = set.map(([c, v]) => {
    if (!NAME.test(c) || !have.has(c.toLowerCase())) throw new Error(`${e.table} has no column ${c}.`);
    if (pkCols.some(p => p.toLowerCase() === c.toLowerCase())) throw new Error(`${c} is part of the primary key; changing it is not an edit.`);
    return `${quoteName(c)} = ${v == null ? 'NULL' : mysql.escape(v)}`;
  });
  return { sql: `UPDATE ${target} SET ${parts.join(', ')} WHERE ${where} LIMIT 1`, countSql };
}
