import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type { SqlColumnInfo } from '../lib/api';
import { statementAt, tableRefs, type TableRef } from '../../../shared/sqlClassify';

export type ColumnsFor = (db: string) => Promise<Record<string, SqlColumnInfo[]>>;

// After these a table name comes, not a column.
const TABLE_POSITION = /\b(from|join|update|into|table|describe|desc)\s+[\w$`.]*$/i;
const keyMark = (k: string) => k === 'PRI' ? '🔑 ' : k ? '⚡ ' : '';

/** Column completion the way DBeaver does it, from the tables in the statement under the cursor:
 *  `f.` lists the columns of the table aliased f (or named f), and a bare word lists matching columns of every table the statement uses,
 *  each labeled with its alias or table. Columns load on demand per database, so any database works, not only the tab's default one.
 *  Table and database names stay with the SQL language's own completion. */
export function columnCompletion(columnsFor: ColumnsFor, defaultDb: () => string | null): CompletionSource {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const doc = ctx.state.doc.toString(), pos = ctx.pos;
    const stmt = statementAt(doc, pos);
    const refs = stmt ? tableRefs(doc.slice(stmt.start, Math.max(stmt.end, pos))) : [];
    const before = doc.slice(Math.max(0, pos - 300), pos);

    // Qualified: alias. or table. or db.table.
    const q = /(?:`?([\w$]+)`?\.)?`?([\w$]+)`?\.([\w$]*)$/.exec(before);
    if (q) {
      const [, first, second, partial] = q;
      let target: TableRef | undefined;
      if (first) target = { db: first, table: second, alias: null };
      else {
        const n = second.toLowerCase();
        target = refs.find(r => r.alias?.toLowerCase() === n) || refs.find(r => r.table.toLowerCase() === n && !r.alias);
        if (!target) return null;   // db. : the language's own completion lists that database's tables
      }
      const options = await optionsFor([target], columnsFor, defaultDb, false);
      if (!options.length) return null;
      return { from: pos - partial.length, options, validFor: /^[\w$]*$/ };
    }

    // A bare word: columns of every table in the statement, beside the keywords.
    const word = ctx.matchBefore(/[\w$]+/);
    if ((!word && !ctx.explicit) || !refs.length || TABLE_POSITION.test(before)) return null;
    const options = await optionsFor(refs, columnsFor, defaultDb, refs.length > 1);
    if (!options.length) return null;
    return { from: word ? word.from : pos, options, validFor: /^[\w$]*$/ };
  };
}

async function optionsFor(refs: TableRef[], columnsFor: ColumnsFor, defaultDb: () => string | null, label: boolean): Promise<Completion[]> {
  const out: Completion[] = [];
  for (const r of refs) {
    const db = r.db || defaultDb();
    if (!db) continue;
    let all: Record<string, SqlColumnInfo[]>;
    try { all = await columnsFor(db); } catch { continue; }
    const key = Object.keys(all).find(k => k.toLowerCase() === r.table.toLowerCase());
    if (!key) continue;
    for (const c of all[key]) out.push({
      label: c.name, type: 'property',
      detail: `${label ? `${r.alias || r.table} · ` : ''}${keyMark(c.key)}${c.type}`,
      info: c.comment ? `${key}.${c.name}: ${c.comment}` : undefined,
      // Above keywords, and keys above other columns.
      boost: c.key ? 3 : 2,
    });
  }
  return out;
}
