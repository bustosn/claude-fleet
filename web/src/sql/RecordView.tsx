import { useMemo, useState } from 'react';
import { Braces, ChevronLeft, ChevronRight, ClipboardCopy, Maximize2, Search } from 'lucide-react';
import type { SqlColumn, SqlValue } from '../lib/api';
import { actions } from '../lib/store';
import { copy, csv, rowJson } from './copy';
import { looksJson } from './ResultGrid';

/** One row turned on its side: field and value, searchable, with the NULL fields folded away. The usual way to read a single case. */
export function RecordView({ columns, row, position, count, onMove, onOpenCell }: {
  columns: SqlColumn[]; row: SqlValue[] | null; position: number; count: number; onMove: (to: number) => void; onOpenCell: (col: number) => void;
}) {
  const [q, setQ] = useState('');
  const [showNulls, setShowNulls] = useState(false);
  const fields = useMemo(() => {
    const t = q.trim().toLowerCase();
    return columns.map((c, i) => ({ c, i, v: row?.[i] ?? null }))
      .filter(f => !t || f.c.name.toLowerCase().includes(t) || (f.v != null && String(f.v).toLowerCase().includes(t)));
  }, [columns, row, q]);
  if (!row) return <div className="m-auto p-6 text-[12px] text-fg-faint">No row to show.</div>;
  const nulls = fields.filter(f => f.v == null), shown = showNulls || q ? fields : fields.filter(f => f.v != null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="sql-subbar">
        <div className="sql-search">
          <Search size={12} aria-hidden="true" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a field or value" aria-label="Find a field or value" />
        </div>
        {nulls.length > 0 && !q && <button className="btn sm ghost" onClick={() => setShowNulls(s => !s)}>{showNulls ? 'Hide' : 'Show'} {nulls.length} null field{nulls.length === 1 ? '' : 's'}</button>}
        <span className="grow" />
        <button className="btn sm ghost" onClick={async () => { const ok = await copy(csv(columns, [row])); actions.toast(ok ? 'Copied the row as CSV' : 'The clipboard is not available here', ok ? 'info' : 'error'); }}><ClipboardCopy size={13} aria-hidden="true" /> Copy CSV</button>
        <button className="btn sm ghost" onClick={async () => { const ok = await copy(rowJson(columns, row)); actions.toast(ok ? 'Copied the row as JSON' : 'The clipboard is not available here', ok ? 'info' : 'error'); }}><Braces size={13} aria-hidden="true" /> Copy JSON</button>
        {count > 1 && <>
          <button className="iconbtn h-6 w-6" aria-label="Previous row" disabled={position <= 0} onClick={() => onMove(position - 1)}><ChevronLeft size={14} /></button>
          <span className="num text-[11px] text-fg-muted">row {position + 1} of {count}</span>
          <button className="iconbtn h-6 w-6" aria-label="Next row" disabled={position >= count - 1} onClick={() => onMove(position + 1)}><ChevronRight size={14} /></button>
        </>}
      </div>
      <div className="sql-record">
        {shown.map(({ c, i, v }) => (
          <div key={i} className="sql-field">
            <div className="sql-fname" title={`${c.name} · ${c.type}`}>{c.name}<span className="sql-ftype">{c.type}</span></div>
            <div className={`sql-fval ${c.kind === 'number' ? 'num' : ''}`}>
              {v == null ? <span className="sql-null">NULL</span> : <span className="sql-fval-text">{String(v).length > 600 ? `${String(v).slice(0, 600)}…` : String(v)}</span>}
              <span className="sql-factions">
                {v != null && (looksJson(v) || String(v).length > 120) && <button className="iconbtn h-6 w-6" aria-label={`Open ${c.name}`} onClick={() => onOpenCell(i)}>{looksJson(v) ? <Braces size={12} /> : <Maximize2 size={12} />}</button>}
                <button className="iconbtn h-6 w-6" aria-label={`Copy ${c.name}`} onClick={async () => { const ok = await copy(v == null ? 'NULL' : String(v)); actions.toast(ok ? `Copied ${c.name}` : 'The clipboard is not available here', ok ? 'info' : 'error'); }}><ClipboardCopy size={12} /></button>
              </span>
            </div>
          </div>
        ))}
        {!shown.length && <div className="p-6 text-[12px] text-fg-faint">{q ? 'No field or value matches.' : 'Every field is NULL.'}</div>}
      </div>
    </div>
  );
}
