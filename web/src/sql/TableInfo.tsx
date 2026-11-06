import { useEffect, useState } from 'react';
import { KeyRound, Link2 } from 'lucide-react';
import type { SqlTableMeta } from '../lib/api';
import { bytes, tableMeta } from './meta';

/** The schema tree's hover card: what information_schema.TABLES knows about one table, its primary key and where its keys point. */
export function TableInfo({ alias, db, table, rect }: { alias: string; db: string; table: string; rect: DOMRect }) {
  const [meta, setMeta] = useState<SqlTableMeta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setMeta(null); setErr(null);
    tableMeta(alias, db, table).then(m => { if (live) setMeta(m); }, e => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [alias, db, table]);
  // Beside the row, kept on screen.
  const top = Math.max(8, Math.min(rect.top - 6, innerHeight - 260));
  return (
    <div className="sql-info" style={{ left: rect.right + 8, top }} role="tooltip">
      <div className="sql-info-title mono">{db}.{table}</div>
      {err && <div className="text-crit">{err}</div>}
      {!meta && !err && <div className="text-fg-faint">Reading…</div>}
      {meta && <>
        <dl className="sql-info-grid">
          <dt>Rows</dt><dd className="num">{meta.rows == null ? '–' : `≈ ${meta.rows.toLocaleString()}`}</dd>
          <dt>Data</dt><dd className="num">{bytes(meta.dataBytes)}</dd>
          <dt>Indexes</dt><dd className="num">{bytes(meta.indexBytes)}</dd>
          <dt>Updated</dt><dd className="num">{meta.updated || '–'}</dd>
          <dt>Created</dt><dd className="num">{meta.created || '–'}</dd>
          <dt>Engine</dt><dd>{meta.type === 'view' ? 'view' : meta.engine || '–'}</dd>
          <dt><KeyRound size={10} aria-hidden="true" /> Key</dt><dd className="mono">{meta.pk.length ? meta.pk.join(', ') : <span className="text-warn">no primary key</span>}</dd>
        </dl>
        {meta.fks.length > 0 && <div className="sql-info-fks">
          {meta.fks.map(f => <div key={f.column} className="flex items-start gap-1.5">
            <Link2 size={10} className="mt-[3px] flex-none" aria-hidden="true" />
            <span className="mono min-w-0 [overflow-wrap:anywhere]">{f.column} → {f.refDb}.{f.refTable}{f.refColumn !== 'id' ? `.${f.refColumn}` : ''}<span className="text-fg-faint"> · {f.source === 'guess' ? 'guess' : 'FK'}</span></span>
          </div>)}
        </div>}
        {meta.comment && <div className="mt-1 text-fg-muted">{meta.comment}</div>}
        <div className="mt-1 text-[10.5px] text-fg-faint">Row count and sizes are InnoDB estimates.</div>
      </>}
    </div>
  );
}
