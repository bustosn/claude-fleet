import { useState } from 'react';
import { api } from '../lib/api';
import { age } from '../lib/format';
import { actions, useStore } from '../lib/store';
import { Status, Empty, WorktreePicker } from '../components/ui';

/** A terminal or background session the dashboard did not start: what it is doing and how to pick it up. */
export function SessionView({ id }: { id: string }) {
  const snap = useStore(s => s.snapshot);
  const s = snap?.sessions.find(x => x.id === id);
  const [logs, setLogs] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  if (!snap) return null;
  if (!s) return <Empty title="Session is gone">It is no longer listed. Terminal sessions disappear when their window closes.</Empty>;
  const j = s.job;
  const cmd = s.kind === 'background' ? `claude attach ${s.bgId}` : `claude --resume ${s.sessionId}`;

  const rename = async () => {
    const next = window.prompt('Rename conversation', s.title || s.name);
    if (!next?.trim() || !s.sessionId) return;
    try { await api.rename(s.sessionId, next.trim()); actions.toast('Renamed'); } catch (e: any) { actions.toast(e.message, 'error'); }
  };
  const remove = async () => {
    if (!armed) { setArmed(true); return; }
    try { await api.removeSession(s.bgId!); actions.toast('Removed from the list'); actions.go({ kind: 'overview' }); }
    catch (e: any) { actions.toast(e.message, 'error'); setArmed(false); }
  };

  return (
    <div className="grid min-h-0 flex-1 auto-rows-max content-start gap-4 overflow-y-auto p-5">
      <header className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 truncate text-[16px] font-semibold">{s.title || s.name || s.id}</h1>
          <div className="text-[12px] text-fg-faint">{s.kind === 'background' ? `background session ${s.bgId}` : `terminal session, pid ${s.pid}, ${s.name}`}</div>
        </div>
        <Status state={s.state} />
      </header>

      <div className="flex flex-wrap gap-2">
        {s.sessionId && !s.stale && <button className="btn primary" onClick={() => actions.go({ kind: 'resume', sessionId: s.sessionId!, cwd: s.cwd, title: s.title || s.name })}>{s.kind === 'interactive' ? 'Chat here (forks)' : 'Chat here'}</button>}
        {s.sessionId && !s.stale && <button className="btn" onClick={rename}>Rename</button>}
        <button className="btn" onClick={() => navigator.clipboard.writeText(cmd).then(() => actions.toast('Copied'))}>Copy: <span className="mono">{cmd}</span></button>
        {s.kind === 'background' && !s.stale && <button className="btn" onClick={() => api.logs(s.bgId!).then(setLogs).catch(e => setLogs(e.message))}>Load recent logs</button>}
        {s.kind === 'background' && <button className={`btn ${armed ? 'danger' : ''}`} onClick={remove}>{armed ? 'Click again to remove' : 'Remove from list'}</button>}
      </div>
      {s.stale && <p className="m-0 text-[12px] text-warn">Stale: this background job's transcript was cleaned up, so it can no longer be resumed, attached, or chatted with. Only its record remains.</p>}
      {s.kind === 'interactive' && <p className="m-0 text-[12px] text-fg-muted">This session is open in a terminal. Chatting here resumes it as a forked copy so the terminal keeps the original. Close the terminal first to continue the same session.</p>}

      <dl className="kv panel p-4">
        <dt>Where</dt><dd>{s.sessionId ? <WorktreePicker sessionId={s.sessionId} worktree={s.worktree} locatedBy={s.locatedBy} /> : s.repo ? <>{s.repo} <span className="mono">{s.branch}</span></> : <span className="text-fg-faint">not inside a tracked repo</span>}</dd>
        <dt>Cwd</dt><dd className="mono">{s.cwd}</dd>
        <dt>Started</dt><dd>{s.startedAt ? `${new Date(s.startedAt).toLocaleString()} (${age(s.startedAt)} ago)` : ''}</dd>
        {j?.updatedAt && <><dt>Updated</dt><dd>{new Date(j.updatedAt).toLocaleString()} ({age(j.updatedAt)} ago)</dd></>}
        {j?.model && <><dt>Model</dt><dd>{j.model} <span className="text-fg-faint">{j.permissionMode}</span></dd></>}
        {j?.tokens != null && <><dt>Tokens</dt><dd className="num">{j.tokens.toLocaleString()}</dd></>}
        <dt>Session id</dt><dd className="mono">{s.sessionId}</dd>
      </dl>

      {j?.intent && <Block title="Intent">{j.intent}</Block>}
      {j?.detail && <Block title="Current">{j.detail}</Block>}
      {j?.needs && <Block title="Needs from you" warn>{j.needs}</Block>}
      {j?.result && <Block title="Result">{j.result}</Block>}
      {j?.suggestedReply && <Block title="Suggested reply">{j.suggestedReply}</Block>}
      {j?.timeline && j.timeline.length > 0 && (
        <section>
          <div className="section-title">Timeline <span className="count">last {j.timeline.length}</span></div>
          <div className="grid gap-1 text-[12px]">
            {[...j.timeline].reverse().map((t, i) => (
              <div key={i} className="grid grid-cols-[56px_80px_1fr] gap-2" title={t.text}>
                <span className="num text-fg-faint">{new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <Status state={t.state} /><span className="truncate">{t.detail}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {logs != null && <section><div className="section-title">Recent output</div><pre className="logs">{logs || '(empty)'}</pre></section>}
    </div>
  );
}

function Block({ title, warn, children }: { title: string; warn?: boolean; children: string }) {
  return <section><div className="section-title">{title}</div><div className={`panel whitespace-pre-wrap p-3 text-[12px] ${warn ? 'border-warn' : ''}`}>{children}</div></section>;
}
