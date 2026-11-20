import type { SqlRunRequest } from '../lib/api';
import { download } from './xlsx';

/** Runs the read again on the server, up to sql.exportMaxRows, and writes the CSV it streams back to a file. Where the browser can
 *  (Chrome), the file is picked first and written as the rows arrive, so a big export never sits in memory; elsewhere it is downloaded at the end.
 *  Must start from a click: the file picker needs one. `abort` stops the query on the server too (closing the stream cancels it). */
export function exportOnServer(req: SqlRunRequest, name: string, onProgress: (bytes: number) => void): { done: Promise<{ bytes: number; saved: boolean }>; abort: () => void } {
  const ctrl = new AbortController();
  const picker = (window as any).showSaveFilePicker as undefined | ((o: unknown) => Promise<any>);
  const done = (async () => {
    // Asked before the query runs, so a cancelled picker costs nothing.
    const handle = picker ? await picker({ suggestedName: `${name}.csv`, types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }] }).catch((e: any) => { if (e?.name === 'AbortError') return null; throw e; }) : undefined;
    if (handle === null) return { bytes: 0, saved: false };
    const res = await fetch('/api/sql/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ req, name }), signal: ctrl.signal });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => null);
      throw new Error(j?.error || `${res.status} ${res.statusText}`);
    }
    let bytes = 0;
    const count = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, c) { bytes += chunk.length; onProgress(bytes); c.enqueue(chunk); } });
    if (handle) {
      const file = await handle.createWritable();
      await res.body.pipeThrough(count).pipeTo(file, { signal: ctrl.signal });
    } else {
      const blob = await new Response(res.body.pipeThrough(count)).blob();
      download(blob, `${name}.csv`);
    }
    return { bytes, saved: true };
  })();
  return { done, abort: () => ctrl.abort() };
}
