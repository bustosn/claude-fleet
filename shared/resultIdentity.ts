import { tableRefs, tokenize } from './sqlClassify.js';

export interface IdentityColumn { name: string; table: string; db?: string; orgName?: string }
/** Where a result's rows came from, when each row is exactly one row of one table: which table, which result columns hold its primary key,
 *  and which columns can be edited (plain columns of that table, not the key). */
export interface EditTarget { db: string; table: string; pk: number[]; editable: boolean[] }

const AGGREGATES = new Set(['COUNT', 'SUM', 'MIN', 'MAX', 'AVG', 'GROUP_CONCAT', 'STD', 'STDDEV', 'VARIANCE', 'JSON_ARRAYAGG', 'JSON_OBJECTAGG', 'BIT_AND', 'BIT_OR', 'BIT_XOR']);
const BREAKS = new Set(['JOIN', 'GROUP', 'DISTINCT', 'UNION', 'HAVING', 'WITH', 'INTERSECT', 'EXCEPT', 'WINDOW', 'OVER']);

/** Whether a result can be edited in place, and how. It must read one table (no joins, grouping, DISTINCT, UNION, aggregates, subqueries or
 *  a derived table), and the primary key, every part of it, must be among the result's columns, so each row names the one row it came from.
 *  Returns why not (for a tooltip) when it cannot. `pk` is the table's primary key columns, from information_schema. */
export function editTarget(statement: string, columns: IdentityColumn[], pk: string[] | null): { target: EditTarget | null; why: string | null } {
  const no = (why: string) => ({ target: null, why });
  const toks = tokenize(statement);
  const head = toks.find(t => !(t.type === 'punct' && t.value === '('));
  if (!head || head.type !== 'word' || head.value !== 'SELECT') return no('Only a SELECT can be edited in place.');
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== 'word') continue;
    if (BREAKS.has(t.value)) return no(`A result with ${t.value} is not one row per table row.`);
    if (AGGREGATES.has(t.value) && toks[i + 1]?.value === '(') return no('A result with aggregates is not one row per table row.');
    // A subquery anywhere: SELECT after the first one.
    if (t.value === 'SELECT' && t !== head) return no('A result with a subquery is not one row per table row.');
  }
  const refs = tableRefs(statement);
  if (refs.length !== 1) return no(refs.length ? 'Edits need a result from one table.' : 'No table to edit.');
  if (!pk || !pk.length) return no(`${refs[0].table} has no primary key, so a row cannot be identified.`);
  const tbl = refs[0].table.toLowerCase();
  const from = (c: IdentityColumn) => !!c.table && c.table.toLowerCase() === tbl;
  const idx = pk.map(p => columns.findIndex(c => from(c) && (c.orgName || c.name).toLowerCase() === p.toLowerCase()));
  if (idx.some(i => i < 0)) return no(`The primary key (${pk.join(', ')}) must be among the selected columns.`);
  const db = columns[idx[0]].db || refs[0].db;
  if (!db) return no('The database of the table is not known.');
  const isKey = new Set(idx);
  // The same column twice (SELECT id, id) would be ambiguous to write back.
  const seen = new Map<string, number>();
  columns.forEach((c, i) => { if (from(c)) { const k = (c.orgName || c.name).toLowerCase(); seen.set(k, (seen.get(k) || 0) + 1); } });
  const editable = columns.map((c, i) => from(c) && !isKey.has(i) && seen.get((c.orgName || c.name).toLowerCase()) === 1);
  return { target: { db, table: columns[idx[0]].table, pk: idx, editable }, why: null };
}
