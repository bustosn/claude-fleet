import { useEffect, useRef } from 'react';
import { Pencil, Save, Undo2 } from 'lucide-react';

/** One statement the server built from an edit: what it runs, how many rows the key matched (the server insists on exactly one), and how it went. */
export interface EditItem { sql: string; matches: number | null; status: 'preview' | 'running' | 'done' | 'failed'; error?: string }

/** Shown above an editable result on dev: how many changes are waiting, and the buttons that act on them. */
export function EditBar({ count, table, onSave, onDiscard }: { count: number; table: string; onSave: () => void; onDiscard: () => void }) {
  if (!count) return <span className="chip" title={`Double-click a cell, or F2, to edit it. Changes are previewed before they are saved.`}><Pencil size={10} aria-hidden="true" /> editable · {table}</span>;
  return (
    <>
      <span className="chip warn">{count} unsaved change{count === 1 ? '' : 's'}</span>
      <button className="btn sm primary" onClick={onSave} title="Show the UPDATE statements, then save (Alt+S)"><Save size={12} aria-hidden="true" /> Preview and save</button>
      <button className="btn sm ghost" onClick={onDiscard}><Undo2 size={12} aria-hidden="true" /> Discard</button>
    </>
  );
}

/** The statements an edit or a delete will run, built by the server from the table's key, before anything is written.
 *  Cancel is the default; running takes a click or Ctrl+Enter. Each statement is one row, committed as it runs. */
export function EditPreview({ alias, title, verb, items, loading, error, onConfirm, onClose }: {
  alias: string; title: string; verb: string; items: EditItem[]; loading: boolean; error: string | null; onConfirm: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const running = items.some(i => i.status === 'running'), done = items.length > 0 && items.every(i => i.status === 'done');
  const odd = items.some(i => i.matches !== 1);
  const can = !loading && !running && !done && !odd && !!items.length;
  return (
    <dialog ref={ref} className="w-[min(680px,94vw)]" onClose={onClose}
      onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && can) { e.preventDefault(); onConfirm(); } }}>
      <h2>{title}</h2>
      <p className="mb-3 text-[12.5px] text-fg">{done ? 'Saved.' : <>Run on <b>{alias}</b>. Each statement changes one row and commits as soon as it runs; there is no undo.</>}</p>
      {loading && <div className="mb-3 text-[12px] text-fg-faint">Asking the server to build the statements…</div>}
      <div className="mb-3 grid max-h-[300px] gap-2 overflow-auto">
        {items.map((it, i) => (
          <div key={i} className="rounded-lg border border-line bg-raised">
            <pre className="sql-pre !py-2 text-[11.5px]">{it.sql}</pre>
            <div className="flex items-center gap-2 border-t border-line px-3 py-1 text-[11px]">
              {it.matches === 1 ? <span className="text-fg-muted">the key matches 1 row</span> : <span className="text-crit">the key matches {it.matches ?? '?'} rows; nothing will run</span>}
              <span className="grow" />
              {it.status === 'running' && <span className="text-fg-muted">running…</span>}
              {it.status === 'done' && <span className="text-good">saved</span>}
              {it.status === 'failed' && <span className="text-crit">{it.error}</span>}
            </div>
          </div>
        ))}
      </div>
      {error && <div className="mb-3 rounded-md border border-crit bg-crit-soft p-2 text-[12px]">{error}</div>}
      <div className="flex justify-end gap-2">
        <button className="btn" autoFocus onClick={() => ref.current?.close()}>{done ? 'Close' : 'Cancel'}</button>
        {!done && <button className="btn danger" disabled={!can} onClick={onConfirm}>{running ? 'Saving…' : verb}</button>}
      </div>
    </dialog>
  );
}
