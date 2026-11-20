import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { api, type SqlReference, type SqlValue } from '../lib/api';

/** Rows elsewhere that point at this one: a table and column to pick, opened as its own query. Columns with no index are marked,
 *  since looking a value up in them reads the whole table. Arrows move, Enter opens, Esc closes. */
export function ReferencedBy({ alias, prod, target, value, onOpen, onClose }: {
  alias: string; prod: boolean; target: { db: string; table: string; column: string }; value: SqlValue;
  onOpen: (r: SqlReference) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [all, setAll] = useState(false);
  const [refs, setRefs] = useState<SqlReference[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => {
    let live = true;
    setRefs(null); setErr(null);
    api.sqlReferencedBy(alias, target.db, target.table, all).then(r => { if (live) setRefs(r); }, e => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [alias, target.db, target.table, all]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (refs || []).filter(r => !t || `${r.db}.${r.table}.${r.column}`.toLowerCase().includes(t));
  }, [refs, q]);
  useEffect(() => { setAt(0); }, [q, refs]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' }); }, [at]);
  const pick = (r: SqlReference | undefined) => { if (r) { onOpen(r); ref.current?.close(); } };

  return (
    <dialog ref={ref} className="w-[min(640px,94vw)]" onClose={onClose}>
      <h2>Referenced by {target.table}.{target.column} = {String(value)}</h2>
      <p className="mb-2 text-[12px] text-fg-muted">Columns that point at {target.db}.{target.table}: declared foreign keys, and columns named like a guess for it (sql.fkGuesses). Pick one to open its rows in a new tab.</p>
      <div className="mb-2 flex items-center gap-2">
        <div className="sql-search flex-1">
          <Search size={12} aria-hidden="true" />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Filter tables" aria-label="Filter tables"
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setAt(i => Math.min(shown.length - 1, i + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(i => Math.max(0, i - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); pick(shown[at]); }
            }} />
        </div>
        <label className="flex flex-none items-center gap-1.5 whitespace-nowrap text-[12px] text-fg-muted"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> every database</label>
      </div>
      {err && <div className="mb-2 rounded-md border border-crit bg-crit-soft p-2 text-[11.5px]">{err}</div>}
      {!refs && !err && <div className="p-4 text-[12px] text-fg-faint">Reading information_schema…</div>}
      {refs && !shown.length && <div className="p-4 text-[12px] text-fg-faint">{refs.length ? 'Nothing matches.' : `Nothing declares or is named like a key to ${target.table}${all ? '' : ` in ${target.db}. Try every database`}.`}</div>}
      {shown.length > 0 && <div ref={list} className="sql-refs" role="listbox" aria-label="Referencing columns">
        {shown.map((r, i) => (
          <button key={`${r.db}.${r.table}.${r.column}`} role="option" aria-selected={i === at} className={`sql-ref ${i === at ? 'is-sel' : ''}`} onMouseEnter={() => setAt(i)} onClick={() => pick(r)}
            title={r.indexed ? 'The column leads an index: a cheap lookup' : `No index starts with ${r.column}: this reads the whole table${prod ? ', on prod' : ''}`}>
            <span className="grow truncate">{r.db === target.db ? '' : `${r.db}.`}{r.table}<span className="text-fg-faint">.{r.column}</span></span>
            {r.source === 'fk' ? <span className="chip">FK</span> : <span className="text-[10.5px] text-fg-faint">guess</span>}
            {!r.indexed && <span className={`chip ${prod ? 'crit' : 'warn'}`}>no index · full scan</span>}
          </button>
        ))}
      </div>}
      <div className="mt-3 flex items-center justify-between text-[11px] text-fg-faint">
        <span>{refs ? `${shown.length} of ${refs.length}` : ''}</span>
        <button className="btn" onClick={() => ref.current?.close()}>Close</button>
      </div>
    </dialog>
  );
}
