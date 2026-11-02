import type { SqlColumn, SqlValue } from '../lib/api';

const text = (v: SqlValue) => v == null ? '' : String(v);

export function tsv(cols: SqlColumn[], rows: SqlValue[][], header = true): string {
  const clean = (v: SqlValue) => text(v).replace(/[\t\r\n]+/g, ' ');
  return [...(header ? [cols.map(c => c.name).join('\t')] : []), ...rows.map(r => r.map(clean).join('\t'))].join('\n');
}

export function csv(cols: SqlColumn[], rows: SqlValue[][]): string {
  const q = (v: SqlValue) => { const s = text(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map(c => q(c.name)).join(','), ...rows.map(r => r.map(q).join(','))].join('\r\n');
}

/** A SQL literal: numbers bare when the column is numeric, strings quoted with quotes doubled. */
export function literal(v: SqlValue, col?: SqlColumn): string {
  if (v == null) return 'NULL';
  if (col?.kind === 'number' && /^-?\d+(\.\d+)?$/.test(String(v))) return String(v);
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** Distinct non-null values as an IN list, in the order they first appear. */
export function inList(values: SqlValue[], col?: SqlColumn): string {
  const seen = new Set<string>(), out: string[] = [];
  for (const v of values) { if (v == null) continue; const k = String(v); if (seen.has(k)) continue; seen.add(k); out.push(literal(v, col)); }
  return `(${out.join(', ')})`;
}

export function whereEq(col: SqlColumn, v: SqlValue): string {
  return v == null ? `\`${col.name}\` IS NULL` : `\`${col.name}\` = ${literal(v, col)}`;
}

export function rowJson(cols: SqlColumn[], row: SqlValue[]): string {
  return JSON.stringify(Object.fromEntries(cols.map((c, i) => [c.name, row[i]])), null, 2);
}

/** Markdown table for a chat: escapes pipes, flattens newlines, trims long cells. */
export function markdown(cols: SqlColumn[], rows: SqlValue[][], maxCell = 120): string {
  const esc = (v: SqlValue) => v == null ? 'NULL' : String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, maxCell);
  return [`| ${cols.map(c => c.name).join(' | ')} |`, `| ${cols.map(c => c.kind === 'number' ? '---:' : '---').join(' | ')} |`, ...rows.map(r => `| ${r.map(esc).join(' | ')} |`)].join('\n');
}

export async function copy(s: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(s); return true; } catch { return false; }
}
