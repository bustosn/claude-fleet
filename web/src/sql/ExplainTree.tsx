import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, Table2 } from 'lucide-react';
import { api, type SqlIndexInfo } from '../lib/api';
import { tableRefs } from '../../../shared/sqlClassify';

/** One step of MySQL's EXPLAIN FORMAT=JSON plan, flattened to what is worth reading: an operation (nested loop, ordering, grouping,
 *  a subquery) or a table access with its type, key, row estimate and condition. */
interface Node { id: string; label: string; kind: 'op' | 'table'; t?: any; flags: Flag[]; children: Node[] }
interface Flag { level: 'crit' | 'warn'; text: string }

const BIG = 10000;
// Plan keys that hold more plan, with how they read.
const OPS: Record<string, string> = {
  nested_loop: 'Nested loop join', ordering_operation: 'ORDER BY', grouping_operation: 'GROUP BY', duplicates_removal: 'DISTINCT',
  windowing: 'Window functions', union_result: 'UNION', materialized_from_subquery: 'Derived table', attached_subqueries: 'Subqueries',
  optimized_away_subqueries: 'Subqueries (optimized away)', order_by_subqueries: 'Subqueries in ORDER BY', group_by_subqueries: 'Subqueries in GROUP BY',
  having_subqueries: 'Subqueries in HAVING', select_list_subqueries: 'Subqueries in the select list', query_specifications: 'Parts', buffer_result: 'Buffered result',
};

function build(v: any, path: string, label: string): Node {
  const node: Node = { id: path, label, kind: 'op', flags: [], children: [] };
  if (!v || typeof v !== 'object') return node;
  if (Array.isArray(v)) { v.forEach((x, i) => node.children.push(build(x, `${path}.${i}`, x?.table ? '' : x?.query_block ? `Select #${x.query_block.select_id ?? i + 1}` : `#${i + 1}`))); return flatten(node); }
  if (v.using_filesort) node.flags.push({ level: 'warn', text: 'Using filesort' });
  if (v.using_temporary_table) node.flags.push({ level: 'warn', text: 'Using temporary table' });
  for (const [k, x] of Object.entries(v)) {
    if (k === 'table') node.children.push(tableNode(x, `${path}.t`));
    else if (k === 'query_block') node.children.push(build(x, `${path}.q`, `Select #${(x as any)?.select_id ?? 1}`));
    else if (OPS[k]) node.children.push(build(x, `${path}.${k}`, OPS[k]));
  }
  return flatten(node);
}
// A list wrapper whose items are the real steps: show the items.
function flatten(n: Node): Node {
  n.children = n.children.flatMap(c => !c.label && c.kind === 'op' && !c.flags.length ? c.children : [c]);
  return !n.label && n.children.length === 1 && !n.flags.length ? n.children[0] : n;
}

function tableNode(t: any, path: string): Node {
  const flags: Flag[] = [];
  const rows = Number(t.rows_examined_per_scan ?? 0);
  if (t.access_type === 'ALL') flags.push({ level: rows >= BIG ? 'crit' : 'warn', text: `Full table scan${rows ? ` of ~${rows.toLocaleString()} rows` : ''}` });
  else if (t.access_type === 'index') flags.push({ level: rows >= BIG ? 'crit' : 'warn', text: 'Full index scan' });
  if (!t.key && t.attached_condition) flags.push({ level: 'warn', text: 'No index for its condition' });
  if (t.using_temporary_table) flags.push({ level: 'warn', text: 'Using temporary table' });
  const n: Node = { id: path, label: t.table_name || '?', kind: 'table', t, flags, children: [] };
  for (const [k, x] of Object.entries(t)) if (OPS[k]) n.children.push(build(x, `${path}.${k}`, OPS[k]));
  if (t.materialized_from_subquery?.query_block) n.children = [build(t.materialized_from_subquery, `${path}.m`, 'Derived table')];
  return n;
}

function walk(n: Node, f: (n: Node) => void) { f(n); n.children.forEach(c => walk(c, f)); }

/** The plan as a tree, worst news first in a summary. A table's condition is checked against its indexes: a column it filters or joins on
 *  that does not lead any index is named. Indexes come from the schema cache, per table, by the statement's own aliases. */
export function ExplainTree({ json, statement, alias, db, onTabular }: { json: string; statement: string; alias: string; db: string | null; onTabular: () => void }) {
  const plan = useMemo(() => { try { return JSON.parse(json); } catch { return null; } }, [json]);
  const root = useMemo(() => plan ? build(plan, 'p', 'Plan') : null, [plan]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // Aliases in the statement to their tables, for the index check.
  const tables = useMemo(() => {
    const m = new Map<string, { db: string; table: string }>();
    for (const r of tableRefs(statement.replace(/^\s*EXPLAIN\s+(FORMAT\s*=\s*\w+\s+)?/i, ''))) { const d = r.db || db; if (d) m.set((r.alias || r.table).toLowerCase(), { db: d, table: r.table }); }
    return m;
  }, [statement, db]);
  const [indexes, setIndexes] = useState<Record<string, SqlIndexInfo[]>>({});
  useEffect(() => {
    let live = true;
    for (const [k, t] of tables) api.sqlIndexes(alias, t.db, t.table).then(ix => { if (live) setIndexes(x => ({ ...x, [k]: ix })); }, () => {});
    return () => { live = false; };
  }, [tables, alias]);
  // Columns a table's condition or join reads that start no index.
  const unindexed = (t: any): string[] => {
    const ix = indexes[String(t.table_name || '').toLowerCase()];
    if (!ix) return [];
    const lead = new Set(ix.map(i => i.columns[0]?.toLowerCase()));
    const own = String(t.table_name).toLowerCase(), cols = new Set<string>();
    const text = `${t.attached_condition || ''} ${(t.ref || []).join(' ')}`;
    for (const m of text.matchAll(/`([^`]+)`\.`([^`]+)`(?:\.`([^`]+)`)?/g)) {
      const [tbl, col] = m[3] ? [m[2], m[3]] : [m[1], m[2]];
      if (tbl.toLowerCase() === own) cols.add(col);
    }
    return t.key ? [] : [...cols].filter(c => !lead.has(c.toLowerCase()));
  };

  if (!root) return <div className="m-auto p-6 text-[12px] text-fg-faint">This is not a JSON plan. <button className="btn sm ml-2" onClick={onTabular}>Tabular EXPLAIN</button></div>;
  const all: { n: Node; f: Flag }[] = [];
  walk(root, n => { for (const f of n.flags) all.push({ n, f }); if (n.kind === 'table') for (const c of unindexed(n.t)) all.push({ n, f: { level: 'warn', text: `${c} has no index` } }); });
  all.sort((a, b) => (a.f.level === b.f.level ? 0 : a.f.level === 'crit' ? -1 : 1));
  const cost = plan?.query_block?.cost_info?.query_cost;

  const row = (n: Node, depth: number): React.ReactNode => {
    const shut = open[n.id] === false;
    const t = n.t, extra = n.kind === 'table' ? unindexed(t) : [];
    return (
      <div key={n.id}>
        <div className={`sql-plan-row ${n.flags.some(f => f.level === 'crit') ? 'crit' : n.flags.length || extra.length ? 'warn' : ''}`} style={{ paddingLeft: 8 + depth * 16 }}>
          {n.children.length ? <button className="iconbtn h-5 w-5" aria-label={shut ? 'Expand' : 'Collapse'} onClick={() => setOpen(o => ({ ...o, [n.id]: shut }))}><ChevronRight size={12} className={`sql-chev ${shut ? '' : 'open'}`} /></button> : <span className="w-5 flex-none" />}
          {n.kind === 'table' ? <Table2 size={13} className="flex-none text-fg-faint" aria-hidden="true" /> : null}
          <span className={n.kind === 'table' ? 'mono font-semibold' : 'text-fg-muted'}>{n.label}</span>
          {n.kind === 'table' && <>
            <span className={`chip ${t.access_type === 'ALL' ? 'crit' : t.access_type === 'index' ? 'warn' : ''}`} title="Access type: const/eq_ref/ref/range are index lookups; index reads the whole index; ALL reads the whole table">{t.access_type}</span>
            <span className="mono text-[11.5px] text-fg-muted" title={t.possible_keys ? `Possible keys: ${t.possible_keys.join(', ')}` : 'No possible keys'}>{t.key ? `key ${t.key}${t.used_key_parts ? ` (${t.used_key_parts.join(', ')})` : ''}` : 'no key'}</span>
            <span className="num text-[11.5px]" title="Rows examined per scan (estimate)">~{Number(t.rows_examined_per_scan ?? 0).toLocaleString()} rows</span>
            {t.filtered != null && <span className="num text-[11px] text-fg-faint" title="Share of rows left after the condition (estimate)">{t.filtered}%</span>}
            {t.using_index && <span className="chip good" title="Answered from the index alone">covering</span>}
          </>}
          {[...n.flags, ...extra.map(c => ({ level: 'warn' as const, text: `${c} has no index` }))].map(f => <span key={f.text} className={`chip ${f.level}`}>{f.text}</span>)}
        </div>
        {n.kind === 'table' && t.attached_condition && !shut && <div className="sql-plan-cond mono" style={{ paddingLeft: 8 + depth * 16 + 40 }} title={t.attached_condition}>WHERE {t.attached_condition}</div>}
        {!shut && n.children.map(c => row(c, depth + 1))}
      </div>
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="sql-subbar text-[12px]">
        {all.length ? <span className="flex min-w-0 items-center gap-1.5"><AlertTriangle size={13} className={all[0].f.level === 'crit' ? 'text-crit' : 'text-warn'} aria-hidden="true" />
          <span className="truncate">{all.slice(0, 4).map(a => `${a.n.label}: ${a.f.text}`).join(' · ')}{all.length > 4 ? ` · ${all.length - 4} more` : ''}</span></span>
          : <span className="text-good">No full scans, filesorts or temporary tables.</span>}
        <span className="grow" />
        {cost != null && <span className="num text-fg-muted" title="The optimizer's cost estimate">cost {cost}</span>}
        <button className="btn sm ghost" onClick={onTabular} title="Run the classic EXPLAIN and show it as a grid">Tabular EXPLAIN</button>
      </div>
      <div className="sql-record">{row(root, 0)}</div>
    </div>
  );
}
