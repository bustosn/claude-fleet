import { useEffect, useMemo, useRef, useState } from 'react';
import { Filter, Server } from 'lucide-react';
import type { SqlColumn, SqlRunRequest, SqlValue } from '../lib/api';
import { startRun, type SqlResult } from './run';

/** One column's values: distinct values with counts, nulls, min and max, from the rows loaded (after the filter).
 *  "Count on the server" runs a GROUP BY around the statement that produced the result, for the rows the grid did not load. */
export function ColumnStats({ column, values, loaded, total, statement, req, prod, onFilter, onClose }: {
  column: SqlColumn; values: SqlValue[]; loaded: number; total: number; statement: string; req: SqlRunRequest | undefined; prod: boolean;
  onFilter: (v: SqlValue) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const stats = useMemo(() => {
    const counts = new Map<string, { v: SqlValue; n: number }>();
    let nulls = 0, min: SqlValue = null, max: SqlValue = null;
    const num = column.kind === 'number';
    const less = (a: SqlValue, b: SqlValue) => num ? Number(a) < Number(b) : String(a) < String(b);
    for (const v of values) {
      if (v == null) { nulls++; continue; }
      const k = String(v), e = counts.get(k);
      if (e) e.n++; else counts.set(k, { v, n: 1 });
      if (min == null || less(v, min)) min = v;
      if (max == null || less(max, v)) max = v;
    }
    const list = [...counts.values()].sort((a, b) => b.n - a.n || String(a.v).localeCompare(String(b.v), undefined, { numeric: true }));
    return { list, nulls, min, max, distinct: counts.size };
  }, [values, column]);
  const [server, setServer] = useState<SqlResult | null>(null);
  const abort = useRef<(() => void) | null>(null);
  useEffect(() => () => abort.current?.(), []);
  const countOnServer = () => {
    if (!req) return;
    const name = `\`${column.name.replace(/`/g, '``')}\``;
    const text = `SELECT q.${name} AS value, COUNT(*) AS n\nFROM (\n${statement}\n) q\nGROUP BY q.${name}\nORDER BY n DESC\nLIMIT 50`;
    abort.current?.();
    abort.current = startRun({ alias: req.alias, db: req.db, text, cursor: 0, limit: 'auto' }, setServer).abort;
  };
  const showMinMax = column.kind === 'number' || column.kind === 'date';
  const top = stats.list.slice(0, 200), peak = top[0]?.n || 1;
  return (
    <dialog ref={ref} className="w-[min(560px,94vw)]" onClose={onClose}>
      <h2 className="mono">{column.name} <span className="text-[12px] font-normal text-fg-faint">{column.type}{column.table ? ` · ${column.table}` : ''}</span></h2>
      <dl className="sql-info-grid mb-3 text-[12px]" style={{ gridTemplateColumns: 'auto 1fr auto 1fr' }}>
        <dt>Rows</dt><dd className="num">{values.length.toLocaleString()}{loaded < total ? ` of ${total.toLocaleString()} loaded` : ''}</dd>
        <dt>Distinct</dt><dd className="num">{stats.distinct.toLocaleString()}</dd>
        <dt>NULL</dt><dd className="num">{stats.nulls.toLocaleString()}</dd>
        {showMinMax ? <><dt>Min</dt><dd className="num">{stats.min == null ? '–' : String(stats.min)}</dd><dt>Max</dt><dd className="num">{stats.max == null ? '–' : String(stats.max)}</dd></> : null}
      </dl>
      <div className="sql-refs mb-3" style={{ maxHeight: '42vh' }}>
        {top.map(e => (
          <button key={String(e.v)} className="sql-ref sql-stat" onClick={() => { onFilter(e.v); ref.current?.close(); }} title="Filter the grid to this value">
            <span className="sql-stat-bar" style={{ width: `${(e.n / peak) * 100}%` }} aria-hidden="true" />
            <span className="relative grow truncate">{String(e.v)}</span><span className="num relative flex-none">{e.n.toLocaleString()}</span>
          </button>
        ))}
        {!top.length && <div className="p-3 text-[12px] text-fg-faint">Every value is NULL.</div>}
      </div>
      {stats.list.length > 200 && <p className="mb-2 text-[11px] text-fg-faint">The 200 most common of {stats.list.length.toLocaleString()}.</p>}
      {server && <div className="mb-3">
        <div className="mb-1 text-[11.5px] text-fg-muted">On the server, every row the statement returns{server.status === 'running' ? ' · counting…' : ''}:</div>
        {server.error ? <div className="rounded-md border border-crit bg-crit-soft p-2 text-[11.5px]">{server.error.message}</div>
          : <div className="sql-refs" style={{ maxHeight: '26vh' }}>{server.rows.map((r, i) => <div key={i} className="sql-ref"><span className="grow truncate">{r[0] == null ? <span className="sql-null">NULL</span> : String(r[0])}</span><span className="num">{Number(r[1]).toLocaleString()}</span></div>)}</div>}
      </div>}
      <div className="flex items-center gap-2">
        <button className={`btn sm ${prod ? 'danger' : ''}`} onClick={countOnServer} disabled={!req || server?.status === 'running'} title={`SELECT ${column.name}, COUNT(*) … GROUP BY around the statement, on ${req?.alias || 'its connection'}, top 50`}>
          <Server size={12} aria-hidden="true" /> Count on {req?.alias || 'the server'}</button>
        <span className="grow text-[11px] text-fg-faint"><Filter size={10} className="inline" aria-hidden="true" /> Click a value to filter the grid to it.</span>
        <button className="btn" onClick={() => ref.current?.close()}>Close</button>
      </div>
    </dialog>
  );
}
