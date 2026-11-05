import { useEffect, useRef, useState } from 'react';
import type { Param } from '../../../shared/sqlClassify';

const KEY = 'fleet.sql.params';
/** Values last used, by parameter name, so :case_no comes back filled in. Positional ? are not remembered: their meaning changes per statement. */
export function rememberedParams(): Record<string, string> { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } }
function remember(values: Record<string, string>) {
  try {
    const all = { ...rememberedParams() };
    for (const [k, v] of Object.entries(values)) if (!k.startsWith('?')) all[k] = v;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {}
}

/** Asks for the statement's :name and ? values before it runs. Enter runs (Ctrl+Enter in a list box); every value goes to the server
 *  separately and is escaped there, never pasted into the SQL. */
export function ParamsDialog({ params, statement, onRun, onClose }: { params: Param[]; statement: string; onRun: (values: Record<string, string>) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const names = [...new Map(params.map(p => [p.name, p])).values()];
  const [vals, setVals] = useState<Record<string, string>>(() => { const r = rememberedParams(); return Object.fromEntries(names.map(p => [p.name, p.name.startsWith('?') ? '' : r[p.name] ?? ''])); });
  useEffect(() => { ref.current?.showModal(); }, []);
  const submit = () => { remember(vals); onRun(vals); ref.current?.close(); };
  const label = (n: string) => n.startsWith('?') ? `? ${n.slice(1)}` : `:${n}`;
  return (
    <dialog ref={ref} className="w-[min(560px,94vw)]" onClose={onClose}>
      <h2>Values for this query</h2>
      <pre className="sql-pre mb-3 max-h-[120px] overflow-auto rounded-lg border border-line bg-raised !py-2 text-[11.5px]">{statement}</pre>
      <form className="sql-params" onSubmit={e => { e.preventDefault(); submit(); }}>
        {names.map((p, i) => (
          <div key={p.name} className="contents">
            <label className="mono text-[12px]" htmlFor={`param-${i}`}>{label(p.name)}</label>
            {p.list
              ? <textarea id={`param-${i}`} className="input mono min-h-[60px] py-1" autoFocus={i === 0} value={vals[p.name]} placeholder="one per line, or comma separated"
                  onChange={e => setVals(v => ({ ...v, [p.name]: e.target.value }))} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); } }} />
              : <input id={`param-${i}`} className="input mono h-8" autoFocus={i === 0} value={vals[p.name]} onChange={e => setVals(v => ({ ...v, [p.name]: e.target.value }))} />}
          </div>
        ))}
        <div className="col-span-2 text-[11px] text-fg-faint">Each value is sent as a quoted string (a list as one per item), escaped on the server. A whole number after LIMIT goes in bare.</div>
        <div className="col-span-2 flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
          <button type="submit" className="btn primary">Run</button>
        </div>
      </form>
    </dialog>
  );
}
