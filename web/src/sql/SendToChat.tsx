import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, X } from 'lucide-react';
import { api, type SqlColumn, type SqlValue } from '../lib/api';
import { actions, useStore } from '../lib/store';
import { csv, markdown } from './copy';

export type Intent = 'result' | 'write' | 'explain' | 'fix';
const INTENTS: { id: Intent; label: string; lead: string }[] = [
  { id: 'result', label: 'Share the result', lead: 'Here is a query I ran and what it returned.' },
  { id: 'write', label: 'Write a query for…', lead: 'Write a MySQL query for what I describe below. Use the statement and result as context for the schema. Fully qualify tables.' },
  { id: 'explain', label: 'Explain this query', lead: 'Explain what this query does, whether it will use an index on these tables, and anything in the result that looks off.' },
  { id: 'fix', label: 'Fix this error', lead: 'This query failed. Tell me why and give me a corrected version.' },
];
const PREVIEW_ROWS = 20, CSV_ROWS = 1000, CSV_BYTES = 2 * 1024 * 1024;

export interface ShareData {
  alias: string; prod: boolean; db: string | null; statement: string;
  columns: SqlColumn[]; rows: SqlValue[][]; rowCount: number; ms: number | null; truncated: boolean; autoLimited: boolean;
  error: string | null; record: SqlValue[] | null;
}

/** The statement, a preview of the visible columns (all-NULL ones dropped), and the result as a CSV attachment, sent to a chat with a prefilled ask. */
export function SendToChat({ data, intent: first, onClose }: { data: ShareData; intent: Intent; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const snap = useStore(s => s.snapshot);
  const chats = (snap?.chats || []).filter(c => c.status !== 'ended' && !c.dialogueId);
  const repos = (snap?.repos || []).map(r => ({ name: r.name, path: r.worktrees.find(w => w.isMain)?.path || r.worktrees[0]?.path })).filter((r): r is { name: string; path: string } => !!r.path);
  const [intent, setIntent] = useState<Intent>(data.error && first === 'result' ? 'fix' : first);
  const [target, setTarget] = useState<string>(() => { const cor3 = repos.find(r => /^cor3$/i.test(r.name)); return cor3 ? `new:${cor3.path}` : chats[0] ? `chat:${chats[0].id}` : repos[0] ? `new:${repos[0].path}` : ''; });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const { text, attachment, sample } = useMemo(() => build(data, INTENTS.find(i => i.id === intent)!.lead, note), [data, intent, note]);

  const send = async () => {
    if (!target) return;
    if (intent === 'write' && !note.trim()) { actions.toast('Say what the query should find', 'error'); return; }
    setBusy(true);
    try {
      let chatId = target.slice(5);
      if (target.startsWith('new:')) chatId = (await api.openChat({ cwd: target.slice(4) })).id;
      await api.send(chatId, text, undefined, attachment ? [attachment] : undefined);
      actions.go({ kind: 'chat', chatId });
    } catch (err: any) { actions.toast(err.message, 'error'); setBusy(false); }
  };

  return (
    <dialog ref={ref} className="w-[min(640px,94vw)]" onClose={onClose}>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="!m-0">Send to a chat</h2>
        <span className="grow" />
        <button className="iconbtn" aria-label="Close" onClick={() => ref.current?.close()}><X size={15} /></button>
      </div>
      <div className="sql-seg mb-3 !flex w-full" role="tablist" aria-label="What to ask">
        {INTENTS.map(i => <button key={i.id} role="tab" aria-selected={intent === i.id} onClick={() => setIntent(i.id)}>{i.label}</button>)}
      </div>
      <label>To
        <select className="input" value={target} onChange={e => setTarget(e.target.value)}>
          {chats.length > 0 && <optgroup label="Open chats">{chats.map(c => <option key={c.id} value={`chat:${c.id}`}>{c.title || 'Untitled'}{c.repo ? ` · ${c.repo}` : ''}</option>)}</optgroup>}
          <optgroup label="New chat in">{repos.map(r => <option key={r.path} value={`new:${r.path}`}>{r.name}</option>)}</optgroup>
        </select>
      </label>
      <label>{intent === 'write' ? 'What should the query find?' : 'Note (optional)'}
        <textarea className="input mono" rows={3} value={note} onChange={e => setNote(e.target.value)} autoFocus={intent === 'write'}
          placeholder={intent === 'write' ? 'e.g. cases for client 43761 stuck in Transport Issues for more than a day' : 'Anything the chat should know'} />
      </label>
      <div className="mb-3 rounded-lg border border-line bg-raised p-2.5 text-[11.5px] text-fg-muted">
        <div><b className="text-fg">{data.alias}</b> {data.prod ? '(PRD reader)' : '(dev)'} · {data.error ? 'the error' : data.record ? 'the record as field/value pairs' : `${Math.min(PREVIEW_ROWS, data.rows.length)} preview rows`}
          {attachment ? ` · CSV of ${sample.rows.toLocaleString()} row${sample.rows === 1 ? '' : 's'}${sample.cut ? ' (a sample)' : ''}` : ''}</div>
        <div className="mt-1 truncate mono">{data.statement.replace(/\s+/g, ' ')}</div>
      </div>
      <div className="flex justify-end gap-2">
        <button className="btn" onClick={() => ref.current?.close()}>Cancel</button>
        <button className="btn primary" onClick={send} disabled={busy || !target}><Send size={13} aria-hidden="true" /> {busy ? 'Sending…' : 'Send'}</button>
      </div>
    </dialog>
  );
}

function build(d: ShareData, lead: string, note: string) {
  const parts = [`${lead}${note.trim() ? `\n\n${note.trim()}` : ''}`, '',
    `**Connection:** ${d.alias} (${d.prod ? 'PRD reader, read-only' : 'dev'})${d.db ? ` · default database ${d.db}` : ''}`, '', '```sql', d.statement, '```'];
  let attachment: { name: string; mediaType: string; data: string } | null = null;
  const sample = { rows: 0, cut: false };
  if (d.error) parts.push('', `**Error:** ${d.error}`);
  else {
    const flags = [d.truncated ? `capped at ${d.rowCount.toLocaleString()} rows` : '', d.autoLimited ? 'auto-limited, there are more rows' : ''].filter(Boolean).join(', ');
    parts.push('', `**Result:** ${d.rowCount.toLocaleString()} row${d.rowCount === 1 ? '' : 's'}${d.ms != null ? `, ${d.ms} ms` : ''}${flags ? ` (${flags})` : ''}`);
    if (d.record) {
      const nulls = d.columns.filter((_, i) => d.record![i] == null).map(c => c.name);
      parts.push('', ...d.columns.map((c, i) => ({ c, v: d.record![i] })).filter(x => x.v != null).map(x => `- \`${x.c.name}\`: ${String(x.v).replace(/\r?\n/g, ' ').slice(0, 300)}`));
      if (nulls.length) parts.push(`- NULL: ${nulls.join(', ')}`);
    } else if (d.rows.length) {
      // Columns that are NULL in every row say nothing in a preview.
      const keep = d.columns.map((_, i) => i).filter(i => d.rows.some(r => r[i] != null));
      const dropped = d.columns.length - keep.length;
      parts.push('', markdown(keep.map(i => d.columns[i]), d.rows.slice(0, PREVIEW_ROWS).map(r => keep.map(i => r[i]))));
      if (d.rows.length > PREVIEW_ROWS || dropped) parts.push('', `_Preview: ${Math.min(PREVIEW_ROWS, d.rows.length)} of ${d.rows.length.toLocaleString()} rows${dropped ? `; ${dropped} all-NULL column${dropped === 1 ? '' : 's'} left out` : ''}._`);
    }
    if (d.rows.length && !d.record) {
      let rows = d.rows.slice(0, CSV_ROWS), body = csv(d.columns, rows);
      while (body.length > CSV_BYTES && rows.length > 10) { rows = rows.slice(0, Math.floor(rows.length * 0.7)); body = csv(d.columns, rows); }
      sample.rows = rows.length; sample.cut = rows.length < d.rows.length;
      attachment = { name: `${d.alias}-result.csv`, mediaType: 'text/csv', data: b64(body) };
      parts.push('', `The full result${sample.cut ? ` (a sample of ${rows.length.toLocaleString()} rows)` : ''} is attached as CSV.`);
    }
  }
  return { text: parts.join('\n'), attachment, sample };
}

const b64 = (s: string) => { const bytes = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); };
