import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { shortPath } from '../lib/format';
import { actions, useStore } from '../lib/store';
import { Empty } from '../components/ui';

/** Opens (or reuses) a live chat for a saved session, then hands off to the chat view. */
export function ResumeView({ sessionId, cwd, title }: { sessionId: string; cwd: string; title: string }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.openChat({ sessionId, cwd }).then(c => { if (!cancelled) actions.go({ kind: 'chat', chatId: c.id, title }, { replace: `resume:${sessionId}` }); }).catch(e => setError(e.message));
    return () => { cancelled = true; };
  }, [sessionId, cwd, title]);
  return <Empty title={error ? 'Could not open this conversation' : `Opening ${title}`}>{error || 'Starting a Claude process and loading the saved history.'}</Empty>;
}

export function NewChatView({ cwd }: { cwd?: string }) {
  const snap = useStore(s => s.snapshot);
  const dirs = [...new Set([...(snap?.repos || []).flatMap(r => r.worktrees.map(w => w.path)), ...(snap?.sessions.map(s => s.cwd) || [])].filter(Boolean))];
  const [dir, setDir] = useState(cwd || dirs[0] || '');
  const [model, setModel] = useState(snap?.dispatch.defaultModel || 'fable');
  const [perm, setPerm] = useState(snap?.dispatch.permissionMode || 'auto');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const c = await api.openChat({ cwd: dir, model, permissionMode: perm });
      if (text.trim()) await api.send(c.id, text.trim());
      actions.go({ kind: 'chat', chatId: c.id, title: text.trim().slice(0, 60) || 'New chat' }, { replace: 'new-chat' });
    } catch (err: any) { actions.toast(err.message, 'error'); setBusy(false); }
  };

  return (
    <form className="m-auto w-[560px] max-w-[94%] panel p-5" onSubmit={submit}>
      <h2 className="mb-3 text-[14px] font-semibold">New chat</h2>
      <label className="mb-3 grid gap-1 text-[12px] text-fg-muted">Working directory
        <select className="input" value={dir} onChange={e => setDir(e.target.value)}>{dirs.map(d => <option key={d} value={d}>{shortPath(d)}</option>)}</select>
      </label>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <label className="grid gap-1 text-[12px] text-fg-muted">Model
          <select className="input" value={model} onChange={e => setModel(e.target.value)}>{['fable', 'opus', 'sonnet', 'haiku'].map(m => <option key={m}>{m}</option>)}</select>
        </label>
        <label className="grid gap-1 text-[12px] text-fg-muted">Permissions
          <select className="input" value={perm} onChange={e => setPerm(e.target.value)}>
            <option value="auto">auto</option><option value="default">ask</option><option value="acceptEdits">acceptEdits</option><option value="plan">plan</option>
          </select>
        </label>
      </div>
      <label className="mb-4 grid gap-1 text-[12px] text-fg-muted">First message
        <textarea className="input" rows={5} value={text} onChange={e => setText(e.target.value)} placeholder="What should this chat work on?" />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={() => actions.go({ kind: 'overview' })}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || !dir}>{busy ? 'Starting' : 'Start chat'}</button>
      </div>
    </form>
  );
}
