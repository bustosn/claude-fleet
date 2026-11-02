import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardCopy, X } from 'lucide-react';
import type { SqlColumn, SqlValue } from '../lib/api';
import { actions } from '../lib/store';
import { highlight } from '../lib/highlight';
import { copy } from './copy';

/** A long value or a JSON payload, in full. JSON is pretty-printed and highlighted; the copy button copies what was stored, not the pretty form. */
export function CellModal({ column, value, onClose }: { column: SqlColumn; value: SqlValue; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const raw = value == null ? 'NULL' : String(value);
  const pretty = useMemo(() => { try { const j = JSON.parse(raw); return typeof j === 'object' && j ? JSON.stringify(j, null, 2) : null; } catch { return null; } }, [raw]);
  const [asJson, setAsJson] = useState(!!pretty);
  const html = useMemo(() => asJson && pretty ? highlight(pretty, 'json') : null, [asJson, pretty]);
  return (
    <dialog ref={ref} className="file-viewer" onClose={onClose} onClick={e => { if (e.target === ref.current) ref.current?.close(); }}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="mono font-semibold">{column.name}</span>
        <span className="text-[11px] text-fg-faint">{column.type}{column.table ? ` · ${column.table}` : ''} · {raw.length.toLocaleString()} chars</span>
        <span className="grow" />
        {pretty && <div className="sql-seg" role="tablist">
          <button role="tab" aria-selected={asJson} onClick={() => setAsJson(true)}>JSON</button>
          <button role="tab" aria-selected={!asJson} onClick={() => setAsJson(false)}>Raw</button>
        </div>}
        <button className="btn sm" onClick={async () => { const ok = await copy(raw); actions.toast(ok ? 'Copied' : 'The clipboard is not available here', ok ? 'info' : 'error'); }}><ClipboardCopy size={13} aria-hidden="true" /> Copy</button>
        <button className="iconbtn" aria-label="Close" onClick={() => ref.current?.close()}><X size={15} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {html ? <pre className="sql-pre hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="sql-pre">{asJson && pretty ? pretty : raw}</pre>}
      </div>
    </dialog>
  );
}
