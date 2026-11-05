import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SqlSaved, SqlSnippet } from '../shared/types.js';

/** Saved queries: a name, a folder, an optional Jira key and connection, and the SQL. Kept in state/sql-saved.json and shared by every
 *  Fleet instance, like lookups. Saving never runs anything; opening one puts it in a tab, and running it goes through the classifier like any text. */
export class SavedQueries {
  constructor(private stateDir: string, private aliasOk: (alias: string) => boolean) {}
  private file() { return path.join(this.stateDir, 'sql-saved.json'); }
  list(): SqlSaved[] {
    try { const j = JSON.parse(fs.readFileSync(this.file(), 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
  }
  save(id: string, v: Partial<SqlSaved>): SqlSaved[] {
    const name = String(v.name || '').trim().slice(0, 120);
    if (!name) throw new Error('Give the query a name.');
    const sql = String(v.sql || '').replace(/\s+$/, '');
    if (!sql.trim()) throw new Error('There is no SQL to save.');
    if (sql.length > 200000) throw new Error('That is more SQL than a saved query holds (200,000 characters).');
    const jira = String(v.jira || '').trim().toUpperCase();
    if (jira && !/^[A-Z][A-Z0-9]+-\d+$/.test(jira)) throw new Error(`${jira} is not a Jira key (like JL-7705).`);
    const alias = v.alias ? String(v.alias) : null;
    if (alias && !this.aliasOk(alias)) throw new Error(`${alias} is not a connection the SQL view offers.`);
    const all = this.list(), now = Date.now();
    const old = all.find(x => x.id === id);
    const item: SqlSaved = { id: old ? old.id : randomUUID().slice(0, 8), name, folder: String(v.folder || '').trim().slice(0, 80), jira: jira || null, alias,
      db: v.db && /^[\w$]+$/.test(String(v.db)) ? String(v.db) : null, sql, created: old?.created || now, updated: now };
    const next = old ? all.map(x => x.id === id ? item : x) : [...all, item];
    fs.writeFileSync(this.file(), JSON.stringify(next, null, 2));
    return next;
  }
  remove(id: string): SqlSaved[] {
    const next = this.list().filter(x => x.id !== id);
    fs.writeFileSync(this.file(), JSON.stringify(next, null, 2));
    return next;
  }
}

// The case joined to what is usually looked up next, and the canonical skeleton from the db-query skill. ${name} is a placeholder Tab moves through.
const CASE_SKELETON = `SELECT c.id, c.case_no, c.ordinal, s.name AS status, m.client_id, cl.business_name AS client, m.mid, p.name AS parser, \${columns}
FROM cb911.cb_chargebacks c
JOIN cb911.cb_client_mids m        ON m.id = c.mid_id
JOIN cb911.cb_clients cl           ON cl.id = m.client_id
LEFT JOIN cb911.cb_status s        ON s.id = c.status_id
LEFT JOIN cb911.cb_chargebacks_meta meta ON meta.cb_id = c.id
LEFT JOIN cb911.cb_parsers p       ON p.id = meta.import_parser_id
WHERE \${where}`;

/** Built-in snippets; one you make with the same name replaces it. */
export function defaultSnippets(caseJoins: string): SqlSnippet[] {
  return [
    { name: 'cbj', label: 'Case with status, client, MID and parser (the cb lookup)', body: `${caseJoins}\nWHERE c.id = \${cb_id}` },
    { name: 'case', label: 'Case skeleton: chargebacks, MIDs, clients, status, meta, parser', body: CASE_SKELETON },
    { name: 'temp', label: 'Temp rows for a case', body: "SELECT *\nFROM cb911.cb_chargebacks_temp\nWHERE case_no = '${case_no}'\nORDER BY ordinal" },
    { name: 'hist', label: 'Status history of a case', body: 'SELECT h.id, h.step, h.status_id, s.name AS status, h.user_id, h.note, h.date_created\nFROM cb911.cb_status_history h\nLEFT JOIN cb911.cb_status s ON s.id = h.status_id\nWHERE h.cb_id = ${cb_id}\nORDER BY h.id' },
    { name: 'sel', label: 'SELECT * … WHERE … LIMIT 100', body: 'SELECT *\nFROM ${table}\nWHERE ${condition}\nLIMIT 100' },
    { name: 'cnt', label: 'Count by a column', body: 'SELECT ${column}, COUNT(*) AS n\nFROM ${table}\nGROUP BY ${column}\nORDER BY n DESC' },
  ].map(s => ({ ...s, source: 'config' as const }));
}

/** Snippets: the built-ins plus the ones made in the SQL view, kept in state/sql-snippets.json and shared by every instance. */
export class Snippets {
  constructor(private stateDir: string, private builtIn: SqlSnippet[]) {}
  private file() { return path.join(this.stateDir, 'sql-snippets.json'); }
  private mine(): SqlSnippet[] {
    try { const j = JSON.parse(fs.readFileSync(this.file(), 'utf8')); return Array.isArray(j) ? j.map((s: SqlSnippet) => ({ ...s, source: 'user' as const })) : []; } catch { return []; }
  }
  list(): SqlSnippet[] {
    const mine = this.mine(), names = new Set(mine.map(s => s.name));
    return [...this.builtIn.filter(s => !names.has(s.name)), ...mine];
  }
  save(name: string, v: Partial<SqlSnippet>, rename?: string): SqlSnippet[] {
    const n = String(name || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(n)) throw new Error('The name is the word you type before Tab: letters, digits or _, starting with a letter (like cbj).');
    const body = String(v.body || '').replace(/\s+$/, '');
    if (!body.trim()) throw new Error('The snippet needs a body.');
    if (body.length > 20000) throw new Error('A snippet holds up to 20,000 characters.');
    const all = this.mine().filter(s => s.name !== n && s.name !== rename).map(({ source: _, ...s }) => s);
    all.push({ name: n, label: String(v.label || '').trim().slice(0, 120) || n, body });
    fs.writeFileSync(this.file(), JSON.stringify(all, null, 2));
    return this.list();
  }
  remove(name: string): SqlSnippet[] {
    const all = this.mine().filter(s => s.name !== name.toLowerCase()).map(({ source: _, ...s }) => s);
    fs.writeFileSync(this.file(), JSON.stringify(all, null, 2));
    return this.list();
  }
}
