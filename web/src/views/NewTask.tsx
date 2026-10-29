import { useEffect, useState, type FormEvent } from 'react';
import { api, type JiraIssuePreview } from '../lib/api';
import { shortPath } from '../lib/format';
import { actions, useStore } from '../lib/store';
import { CodeTextarea } from '../components/CodeTextarea';
import { MOD } from '../lib/platform';

const keyOf = (s: string) => /\b([A-Z][A-Z0-9_]{1,19}-\d{1,7})\b/.exec(s.toUpperCase())?.[1] || null;

/** Queues a task for the board. Fleet starts a chat on it when a slot is free; the chat reports back for review.
 *  With a Jira ticket the task is built from the ticket, and the text box is only extra notes. */
export function NewTaskView({ cwd, ticket: initialTicket }: { cwd?: string; ticket?: string }) {
  const snap = useStore(s => s.snapshot);
  const jira = snap?.jira;
  const [ticket, setTicket] = useState(initialTicket || '');
  const [issue, setIssue] = useState<JiraIssuePreview | null>(null);
  const [issueError, setIssueError] = useState<string | null>(null);
  const baseDirs = [...new Set([...(snap?.repos || []).flatMap(r => r.worktrees.filter(w => !w.managed).map(w => w.path)), ...(snap?.sessions.map(s => s.cwd) || [])].filter(Boolean))];
  const [dir, setDir] = useState(cwd || baseDirs[0] || '');
  const [dirTouched, setDirTouched] = useState(!!cwd);
  const dirs = issue?.cwd && !baseDirs.some(d => d.toLowerCase() === issue.cwd!.toLowerCase()) ? [issue.cwd, ...baseDirs] : baseDirs;
  const [model, setModel] = useState(snap?.dispatch.defaultModel || 'fable');
  const [perm, setPerm] = useState(snap?.dispatch.permissionMode || 'auto');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [isolate, setIsolate] = useState(true);
  const [busy, setBusy] = useState(false);
  const working = snap?.tasks.filter(t => t.status === 'working').length || 0;
  const max = snap?.dispatch.maxConcurrent || 1;
  const key = keyOf(ticket);
  const already = key ? snap?.tasks.find(t => t.ticket === key && t.status !== 'done') : undefined;

  // Look the ticket up as it is typed or pasted, and take its folder unless one was picked by hand.
  useEffect(() => {
    setIssue(null); setIssueError(null);
    if (!key || !jira?.enabled) return;
    let live = true;
    const t = setTimeout(() => api.jiraIssue(key).then(i => {
      if (!live) return;
      setIssue(i);
      if (i.cwd && !dirTouched) setDir(i.cwd);
    }).catch(e => live && setIssueError(e.message)), 350);
    return () => { live = false; clearTimeout(t); };
  }, [key, jira?.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if ((!key && !prompt.trim()) || !dir) return;
    setBusy(true);
    try {
      const t = await api.addTask(key ? { ticket: key, prompt: prompt.trim(), cwd: dir, model, permissionMode: perm, isolate }
        : { title: title.trim() || undefined, prompt: prompt.trim(), cwd: dir, model, permissionMode: perm, isolate });
      actions.toast(t.status === 'queued' ? `Queued: ${working} of ${max} slots are busy` : `Started${t.ticket ? ` on ${t.ticket}` : ''}`);
      actions.closeTab('new-task');
      actions.go({ kind: 'overview' });
    } catch (err: any) { actions.toast(err.message, 'error'); setBusy(false); }
  };

  return (
    <form className="m-auto w-[620px] max-w-[94%] panel p-5" onSubmit={submit}>
      <h2 className="mb-1 text-[14px] font-semibold">New task</h2>
      <p className="mb-4 text-[12px] text-fg-muted">A chat picks this up when one of {max} slots is free, works on it on its own, and puts it in Needs you with a summary when it is ready or stuck.</p>
      {jira?.enabled ? (
        <label className="mb-3 grid gap-1 text-[12px] text-fg-muted">Jira ticket <span className="text-fg-faint">(optional; a key or a link)</span>
          <input className="input mono" value={ticket} onChange={e => setTicket(e.target.value)} placeholder="PROJ-123" autoFocus />
          {key && !issue && !issueError && <span className="text-[11px] text-fg-faint">Looking up {key}…</span>}
          {issueError && <span className="text-[11px] text-crit">{issueError}</span>}
          {issue && <span className="text-[11px] text-fg"><a className="text-accent" href={issue.url} target="_blank" rel="noreferrer">{issue.key}</a> {issue.summary} <span className="text-fg-faint">· {issue.type} · {issue.status}{issue.cwd ? '' : ' · no folder mapped for this project; pick one below'}</span></span>}
          {already && <span className="text-[11px] text-warn">{key} is already on the board ({already.status}).</span>}
        </label>
      ) : <p className="mb-3 text-[11px] text-fg-faint">To start tasks from Jira tickets, add a <span className="mono">jira</span> section to fleet.config.json (see fleet.config.example.json).</p>}
      {!key && (
        <label className="mb-3 grid gap-1 text-[12px] text-fg-muted">Title <span className="text-fg-faint">(optional; defaults to the first line)</span>
          <input className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. fix the export timeout" />
        </label>
      )}
      <label className="mb-3 grid gap-1 text-[12px] text-fg-muted">{key ? <>Extra notes <span className="text-fg-faint">(optional; the agent reads the ticket)</span></> : 'What should be done'}
        <CodeTextarea className="input" wrapClass="rich-boxed" rows={key ? 4 : 8} value={prompt} onChange={setPrompt}
          placeholder={key ? `Anything the ticket does not say: where to look, what to avoid. ${MOD}Enter starts it.` : `Describe the task and what done looks like: the change, how to check it, anything off limits. ${MOD}Enter queues it.`}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!busy) e.currentTarget.form?.requestSubmit(); } }} />
      </label>
      <label className="mb-3 grid gap-1 text-[12px] text-fg-muted">Working directory
        <select className="input" value={dir} onChange={e => { setDir(e.target.value); setDirTouched(true); }}>{dirs.map(d => <option key={d} value={d}>{shortPath(d)}</option>)}</select>
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
        <button type="submit" className="btn primary" disabled={busy || !dir || (key ? !!issueError : !prompt.trim())}>{busy ? 'Starting' : working < max ? 'Start task' : 'Queue task'}</button>
      </div>
    </form>
  );
}
