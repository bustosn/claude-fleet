import { api, type SqlColumn, type SqlFk, type SqlTableMeta, type SqlValue } from '../lib/api';
import { literal } from './copy';

// Table facts (primary key, foreign keys, size) per connection, fetched once and kept ten minutes, like the server's copy.
const TTL = 10 * 60 * 1000;
const cache = new Map<string, { at: number; p: Promise<SqlTableMeta>; v?: SqlTableMeta }>();
const key = (alias: string, db: string, table: string) => `${alias}/${db}.${table}`.toLowerCase();

export function tableMeta(alias: string, db: string, table: string): Promise<SqlTableMeta> {
  const k = key(alias, db, table), hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const e: { at: number; p: Promise<SqlTableMeta>; v?: SqlTableMeta } = { at: Date.now(), p: api.sqlTableMeta(alias, db, table) };
  e.p.then(v => { e.v = v; }, () => cache.delete(k));
  cache.set(k, e);
  return e.p;
}
/** What is already here, without asking. */
export function peekMeta(alias: string, db: string, table: string): SqlTableMeta | undefined { return cache.get(key(alias, db, table))?.v; }
export function forgetMeta(alias: string) { for (const k of [...cache.keys()]) if (k.startsWith(`${alias}/`.toLowerCase())) cache.delete(k); }

/** The tables a result's columns came from, to fetch their facts once the result is in. */
export function resultTables(columns: SqlColumn[]): { db: string; table: string }[] {
  const seen = new Map<string, { db: string; table: string }>();
  for (const c of columns) if (c.db && c.table) seen.set(`${c.db}.${c.table}`.toLowerCase(), { db: c.db, table: c.table });
  return [...seen.values()];
}

/** Where a result column's value points: a declared or guessed foreign key of its table, else a guess from the column's name alone
 *  (an expression or a table whose facts are not here yet). Never the table's own id. */
export function fkOf(alias: string, col: SqlColumn, guesses: Record<string, string>): SqlFk | null {
  const name = col.orgName || col.name;
  const meta = col.db && col.table ? peekMeta(alias, col.db, col.table) : undefined;
  const real = meta?.fks.find(f => f.column.toLowerCase() === name.toLowerCase());
  if (real) return real;
  if (meta) return null;
  const target = guesses[name.toLowerCase()] || guesses[col.name.toLowerCase()];
  if (!target) return null;
  const [refDb, refTable] = target.split('.');
  if (col.db && col.table && `${col.db}.${col.table}`.toLowerCase() === target.toLowerCase()) return null;
  return { column: name, refDb, refTable, refColumn: 'id', source: 'guess' };
}

/** The table a column is the single-column primary key of, for "Referenced by…". Without facts, a column named id counts. */
export function pkOf(alias: string, col: SqlColumn): { db: string; table: string; column: string } | null {
  if (!col.db || !col.table) return null;
  const name = col.orgName || col.name;
  const meta = peekMeta(alias, col.db, col.table);
  if (meta ? meta.pk.length === 1 && meta.pk[0].toLowerCase() === name.toLowerCase() : name.toLowerCase() === 'id') return { db: col.db, table: col.table, column: name };
  return null;
}

/** A value as a literal for a WHERE: numbers bare, so an integer key uses its index; anything else quoted. */
export function keyLiteral(v: SqlValue): string { return v != null && /^-?\d+$/.test(String(v)) ? String(v) : literal(v); }

export function bytes(n: number | null): string {
  if (n == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)} ${u[i]}`;
}
