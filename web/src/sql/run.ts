import type { SqlColumn, SqlEvent, SqlRunRequest, SqlValue } from '../lib/api';

/** One run's result as it streams in. `rows` grows in place; `version` changes on every flush so React sees a new value. */
export interface SqlResult {
  status: 'running' | 'done' | 'error';
  runId: string | null; statement: string; offset: number; startedAt: number;
  columns: SqlColumn[]; rows: SqlValue[][];
  ms: number | null; truncated: boolean; autoLimited: boolean;
  error: { message: string; code: string | null; offset: number | null; length: number; line: number | null } | null;
  notice: string | null; version: number;
}

export const emptyResult = (): SqlResult => ({ status: 'running', runId: null, statement: '', offset: 0, startedAt: Date.now(), columns: [], rows: [], ms: null, truncated: false, autoLimited: false, error: null, notice: null, version: 0 });

/** POSTs a run and reads its event stream (EventSource cannot POST). Rows are pushed into the result as they come;
 *  `onChange` fires at most once per frame, so a 5,000-row result re-renders a handful of times, not once per batch. */
export function startRun(req: SqlRunRequest, onChange: (r: SqlResult) => void): { result: SqlResult; abort: () => void } {
  const ctrl = new AbortController();
  const r = emptyResult();
  let frame = 0;
  const changed = (now = false) => {
    if (now) { cancelAnimationFrame(frame); frame = 0; r.version++; onChange({ ...r }); return; }
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; r.version++; onChange({ ...r }); });
  };
  const apply = (ev: SqlEvent) => {
    switch (ev.t) {
      case 'start': r.runId = ev.id; r.statement = ev.statement; r.offset = ev.offset; break;
      case 'notice': r.notice = ev.text; break;
      // Columns again means the tunnel was restarted and the statement re-run: start the rows over.
      case 'columns': r.columns = ev.columns; r.rows = []; break;
      case 'rows': for (const row of ev.rows) r.rows.push(row); break;
      case 'done': r.status = 'done'; r.ms = ev.ms; r.truncated = ev.truncated; r.autoLimited = ev.autoLimited; break;
      case 'error': r.status = 'error'; r.ms = Date.now() - r.startedAt; r.error = { message: ev.message, code: ev.code, offset: ev.offset, length: ev.length, line: ev.line }; break;
    }
    changed(ev.t !== 'rows');
  };
  (async () => {
    try {
      const res = await fetch('/api/sql/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req), signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, cut); buf = buf.slice(cut + 2);
          const data = chunk.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
          if (data) apply(JSON.parse(data));
        }
      }
      if (r.status === 'running') apply({ t: 'error', message: 'The connection to Fleet closed before the query finished.', code: null, offset: null, length: 0, line: null });
    } catch (err: any) {
      if (r.status === 'running') apply({ t: 'error', message: ctrl.signal.aborted ? 'Cancelled.' : `Could not reach Fleet: ${err.message || err}`, code: null, offset: null, length: 0, line: null });
    }
  })();
  return { result: r, abort: () => ctrl.abort() };
}
