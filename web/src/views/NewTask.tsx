import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { shortPath } from '../lib/format';
import { actions, useStore } from '../lib/store';
import { CodeTextarea } from '../components/CodeTextarea';

/** Queues a task for the board. Fleet starts a chat on it when a slot is free; the chat reports back for review. */
export function NewTaskView({ cwd }: { cwd?: string }) {
  const snap = useStore(s => s.snapshot);
  const dirs = [...new Set([...(snap?.repos || []).flatMap(r => r.worktrees.map(w => w.path)), ...(snap?.sessions.map(s => s.cwd) || [])].filter(Boolean))];
  const [dir, setDir] = useState(cwd || dirs[0] || '');
  const [model, setModel] = useState(snap?.dispatch.defaultModel || 'fable');
  const [perm, setPerm] = useState(snap?.dispatch.permissionMode || 'auto');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [isolate, setIsolate] = useState(true);
  const [busy, setBusy] = useState(false);
  const working = snap?.tasks.filter(t => t.status === 'working').length || 0;
  const max = snap?.dispatch.maxConcurrent || 1;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || !dir) return;
    setBusy(true);
    try {
      const t = await api.addTask({ title: title.trim() || undefined, prompt: prompt.trim(), cwd: dir, model, permissionMode: perm, isolate });
      actions.toast(t.status === 'queued' ? `Queued: ${working} of ${max} slots are busy` : 'Started');
      actions.closeTab('new-task');
      actions.go({ kind: 'overview' });
    } catch (err: any) { actions.toast(err.message, 'error'); setBusy(false); }
  };

  return (
    <form className="m-auto w-[620px] max-w-[94%] panel p-5" onSubmit={submit}>
      <h2 className="mb-1 text-[14px] font-semibold">New task</h2>
      <p className="mb-4 text-[12px] text-fg-muted">A chat picks this up when one of {max} slots is free, works on it on its own, and puts it in Needs you with a summary when it is ready or stuck.</p>
      <label className="mb-3 grid gap-1 text-[12px] text-fg-muted">Title <span className="text-fg-faint">(optional; defaults to the first line)</span>
        <input className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. PROJ-123 fix the export timeout" />
      </label>
      <label className="mb-3 grid gap-1 text-[12px] text-fg-muted">What should be done
        <CodeTextarea className="input" wrapClass="rich-boxed" rows={8} value={prompt} onChange={setPrompt}
          placeholder="Describe the task and what done looks like: the change, how to check it, anything off limits. Ctrl+Enter queues it."
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!busy) e.currentTarget.form?.requestSubmit(); } }} />
      </label>
      <label className="mb-3 grid gap-1 text-[12px] text-fg-muted">Working directory
        <select className="input" value={dir} onChange={e => setDir(e.target.value)}>{dirs.map(d => <option key={d} value={d}>{shortPath(d)}</option>)}</select>
      </label>
      <label className="mb-3 flex items-start gap-2 text-[12px] text-fg-muted">
        <input type="checkbox" className="mt-0.5" checked={isolate} onChange={e => setIsolate(e.target.checked)} />
        <span>Own branch and worktree <span className="text-fg-faint">— a new <span className="mono">fleet/…</span> branch from this folder's current commit, so tasks in the same repo don't collide. Approve keeps the branch and removes the worktree. Folders outside git run in place.</span></span>
      </label>
      <div className="mb-4 grid grid-cols-2 gap-3">
        <label className="grid gap-1 text-[12px] text-fg-muted">Model
          <select className="input" value={model} onChange={e => setModel(e.target.value)}>{['fable', 'opus', 'sonnet', 'haiku'].map(m => <option key={m}>{m}</option>)}</select>
        </label>
        <label className="grid gap-1 text-[12px] text-fg-muted">Permissions
          <select className="input" value={perm} onChange={e => setPerm(e.target.value)}>
            <option value="auto">auto</option><option value="default">ask</option><option value="acceptEdits">acceptEdits</option><option value="plan">plan</option>
          </select>
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={() => { actions.closeTab('new-task'); actions.go({ kind: 'overview' }); }}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || !dir || !prompt.trim()}>{busy ? 'Queuing' : working < max ? 'Start task' : 'Queue task'}</button>
      </div>
    </form>
  );
}
