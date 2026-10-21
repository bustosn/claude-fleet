import { useState, type ReactNode } from 'react';
import { ListPlus } from 'lucide-react';
import { api, type Session, type TaskSummary } from '../lib/api';
import { age, shortPath } from '../lib/format';
import { md } from '../lib/markdown';
import { MOD } from '../lib/platform';
import { actions, useStore } from '../lib/store';
import { Status, Empty } from '../components/ui';

type ColId = 'queued' | 'working' | 'needs-you' | 'done';
const COLS: { id: ColId; title: string; blurb: string; dot: string }[] = [
  { id: 'queued', title: 'Queued', blurb: 'waiting for a free slot', dot: 'idle' },
  { id: 'working', title: 'Working', blurb: 'a chat is on it', dot: 'working' },
  { id: 'needs-you', title: 'Needs you', blurb: 'ready for review, blocked, or failed', dot: 'needs-you' },
  { id: 'done', title: 'Done', blurb: 'approved', dot: 'done' },
];
const colOf = (t: TaskSummary): ColId => t.status === 'queued' ? 'queued' : t.status === 'working' ? 'working' : t.status === 'done' ? 'done' : 'needs-you';
// Within Needs you: what is stuck before what is ready, then oldest first so nothing waits forever.
const urgency: Record<string, number> = { failed: 0, blocked: 1, review: 2 };

const run = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) actions.toast(ok); } catch (err: any) { actions.toast(err.message, 'error'); } };

export function OverviewView() {
  const snap = useStore(s => s.snapshot);
  if (!snap) return <Empty title="Connecting">Reading sessions, worktrees, and saved conversations.</Empty>;
  const tasks = snap.tasks;
  const working = tasks.filter(t => t.status === 'working').length;
  const taskChats = new Set(tasks.map(t => t.chatId).filter(Boolean));
  const others = snap.sessions.filter(s => !(s.chatId && taskChats.has(s.chatId)) && s.column !== 'done');

  return (
    <div className="grid min-h-0 flex-1 auto-rows-max content-start gap-3 overflow-y-auto p-4">
      <div className="flex items-center gap-3">
        <h2 className="text-[14px] font-semibold">Board</h2>
        <span className="num text-[11px] text-fg-muted">{working} of {snap.dispatch.maxConcurrent} slots working</span>
        {snap.jira?.jql && <JiraLine />}
        <button className="btn primary sm ml-auto" onClick={() => actions.go({ kind: 'new-task' })}><ListPlus size={13} aria-hidden="true" /> New task</button>
      </div>
      <div className="grid grid-cols-4 gap-3 max-[1100px]:grid-cols-2">
        {COLS.map(col => {
          let list = tasks.filter(t => colOf(t) === col.id);
          if (col.id === 'queued') list = list.sort((a, b) => a.createdAt - b.createdAt);
          if (col.id === 'needs-you') list = list.sort((a, b) => (urgency[a.status] - urgency[b.status]) || a.updatedAt - b.updatedAt);
          return (
            <section key={col.id} className="panel min-h-40 min-w-0 p-2">
              <div className="section-title" title={col.blurb}>
                <span className="dot" data-s={col.dot} aria-hidden="true" />{col.title}
                {col.id === 'done' && list.length > 0 && <button className="ml-2 text-fg-faint hover:text-fg" title="Remove every done task from the board" onClick={() => run(() => api.clearDoneTasks())}>clear</button>}
                <span className="count num">{list.length}</span>
              </div>
              <div className="grid gap-1.5">
                {list.length === 0 && <div className="px-2 py-3 text-[11px] text-fg-faint">{col.blurb}</div>}
                {list.map(t => <TaskCard key={t.id} t={t} />)}
              </div>
            </section>
          );
        })}
      </div>
      {tasks.length === 0 && <div className="px-1 text-[12px] text-fg-muted">The board tracks tasks: work you queue for a chat to pick up. When a task's chat is done or stuck it lands in Needs you with a summary; Approve moves it to Done.</div>}
      <OtherSessions sessions={others} />
    </div>
  );
}

function TaskCard({ t }: { t: TaskSummary }) {
  const snap = useStore(s => s.snapshot);
  const chat = t.chatId ? snap?.chats.find(c => c.id === t.chatId) : undefined;
  const live = !!chat && chat.status !== 'ended';
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState('');
  const [open, setOpen] = useState(false);
  const openChat = () => {
    if (live) actions.go({ kind: 'chat', chatId: chat!.id, title: t.title });
    else if (chat?.sessionId) actions.go({ kind: 'resume', sessionId: chat.sessionId, cwd: chat.cwd, title: t.title });
  };
  const canOpen = live || !!chat?.sessionId;
  const sendBack = () => run(async () => { await api.sendBackTask(t.id, reply); setReply(''); setReplying(false); }, 'Sent back');
  const remove = () => { if (t.status === 'done' || confirm(`Remove "${t.title}"?${live ? ' Its chat will end.' : ''}`)) run(() => api.removeTask(t.id)); };

  const badge = { queued: null, working: null, review: 'Ready for review', blocked: 'Blocked', failed: 'Failed', done: null }[t.status];
  const when = t.status === 'done' ? t.finishedAt : t.status === 'queued' ? t.createdAt : t.updatedAt;
  const text = t.status === 'failed' ? t.error : t.summary;

  return (
    <div className="min-w-0 rounded-xl border border-line bg-raised p-2.5 shadow-[var(--shadow-sm)]">
      <button className="block w-full text-left disabled:cursor-default" disabled={!canOpen} onClick={openChat} title={canOpen ? 'Open the chat' : undefined}>
        <div className="flex items-center gap-2">
          {badge && <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide ${t.status === 'review' ? 'text-good' : t.status === 'failed' ? 'text-crit' : 'text-warn'}`}>{badge}</span>}
          <span className="truncate font-medium">{t.title}</span>
        </div>
        <div className="truncate text-[11px] text-fg-muted mono" title={t.worktree || t.cwd}>
          {t.branch ? `${chat?.repo || t.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop()} / ${t.branch}` : chat?.repo ? `${chat.repo} / ${chat.branch || ''}` : shortPath(t.cwd)}
        </div>
        {t.diff && <div className="num truncate text-[11px] text-fg-faint" title={`against ${t.base}${t.status === 'done' && t.worktree ? '; worktree kept because it has uncommitted changes' : ''}`}>{t.diff}{t.status === 'done' && t.worktree ? ' · worktree kept' : ''}</div>}
      </button>
      {text && (t.status !== 'done' || open) && (
        <div className={`task-summary mt-1.5 ${open ? '' : 'clamped'}`} onClick={() => setOpen(o => !o)} title={open ? 'Collapse' : 'Show all'}
          dangerouslySetInnerHTML={{ __html: md(text) }} />
      )}
      {replying && (
        <textarea className="input mt-1.5 w-full text-[12px]" rows={3} autoFocus value={reply} onChange={e => setReply(e.target.value)}
          placeholder={t.status === 'blocked' ? `Your answer. ${MOD}Enter sends.` : `What to change. ${MOD}Enter sends.`}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && reply.trim()) { e.preventDefault(); sendBack(); } if (e.key === 'Escape') setReplying(false); }} />
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {t.status === 'working' && chat && <Status state={chat.status} />}
        {t.status === 'queued' && <Action onClick={() => run(() => api.taskAction(t.id, 'start'))}>Start now</Action>}
        {(t.status === 'review' || t.status === 'blocked') && !replying && <>
          <Action primary onClick={() => run(() => api.taskAction(t.id, 'approve'), 'Done')}>{t.status === 'review' ? 'Approve' : 'Mark done'}</Action>
          {live && <Action onClick={() => setReplying(true)}>{t.status === 'blocked' ? 'Answer' : 'Send back'}</Action>}
        </>}
        {replying && <>
          <Action primary disabled={!reply.trim()} onClick={sendBack}>Send</Action>
          <Action onClick={() => setReplying(false)}>Cancel</Action>
        </>}
        {(t.status === 'failed' || t.status === 'blocked') && !replying && <Action onClick={() => run(() => api.taskAction(t.id, 'retry'))}>Retry</Action>}
        {t.worktree && !replying && t.status !== 'queued' && <Action onClick={() => run(() => api.openWorktree(t.worktree!, 'editor'))}>VS Code</Action>}
        {t.ticketUrl && !replying && <a className="btn sm ghost mono" style={{ height: 22, padding: '0 8px' }} href={t.ticketUrl} target="_blank" rel="noreferrer" title="Open the ticket in Jira">{t.ticket} ↗</a>}
        {t.status === 'done' && t.summary && <Action onClick={() => setOpen(o => !o)}>{open ? 'Hide summary' : 'Summary'}</Action>}
        {(t.status === 'queued' || t.status === 'failed' || t.status === 'done') && <Action onClick={remove}>Remove</Action>}
        <span className="num ml-auto text-[10px] text-fg-faint">{t.rounds > 0 && `round ${t.rounds + 1} · `}{age(when)}</span>
      </div>
    </div>
  );
}

/** The Jira watcher in one line: when it last looked, what went wrong, and tickets it found but has no folder for. */
function JiraLine() {
  const j = useStore(s => s.snapshot?.jira);
  const [busy, setBusy] = useState(false);
  if (!j?.jql) return null;
  const check = async () => { setBusy(true); await run(() => api.jiraPoll()); setBusy(false); };
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-fg-muted" title={`Every ${j.everyMinutes} min: ${j.jql}`}>
      <span className="dot" data-s={j.error ? 'failed' : 'idle'} aria-hidden="true" />
      <span className="truncate">Jira{j.lastPoll ? `: checked ${age(j.lastPoll)} ago` : ': first check soon'}</span>
      {j.error && <span className="truncate text-crit" title={j.error}>{j.error}</span>}
      {j.unmapped.length > 0 && <span className="truncate text-warn" title={`${j.unmapped.join('\n')}\n\nMap their project under jira.repos in fleet.config.json, or add a label naming the repo.`}>{j.unmapped.length} ticket{j.unmapped.length === 1 ? '' : 's'} without a folder</span>}
      <button className="text-fg-faint hover:text-fg disabled:opacity-50" disabled={busy} onClick={check}>{busy ? 'checking…' : 'check now'}</button>
    </span>
  );
}

function Action({ children, onClick, primary, disabled }: { children: ReactNode; onClick: () => void; primary?: boolean; disabled?: boolean }) {
  return <button className={`btn sm ${primary ? 'primary' : 'ghost'}`} style={{ height: 22, padding: '0 8px' }} disabled={disabled} onClick={onClick}>{children}</button>;
}

/** Chats and terminal sessions that are not board tasks. Kept below the board and collapsed unless one of them is waiting on you. */
function OtherSessions({ sessions }: { sessions: Session[] }) {
  const waiting = sessions.filter(s => s.column === 'needs-you').length;
  const [open, setOpen] = useState<boolean | null>(null);
  if (!sessions.length) return null;
  const shown = open ?? waiting > 0;
  const rank: Record<string, number> = { 'needs-you': 0, working: 1, idle: 2 };
  const list = [...sessions].sort((a, b) => (rank[a.column] ?? 3) - (rank[b.column] ?? 3));
  const go = (s: Session) => s.kind === 'dashboard' && s.chatId ? actions.go({ kind: 'chat', chatId: s.chatId, title: s.title }) : actions.go({ kind: 'session', id: s.id });
  return (
    <section className="panel p-2">
      <button className="section-title w-full" onClick={() => setOpen(!shown)} aria-expanded={shown}>
        {shown ? '▾' : '▸'} Other sessions
        {waiting > 0 && <span className="ml-1 normal-case tracking-normal text-warn">{waiting} need{waiting === 1 ? 's' : ''} you</span>}
        <span className="count num">{sessions.length}</span>
      </button>
      {shown && (
        <div className="grid grid-cols-4 gap-1.5 max-[1100px]:grid-cols-2">
          {list.map(s => (
            <button key={s.id} className="min-w-0 rounded-xl border border-line bg-raised p-2 text-left shadow-[var(--shadow-sm)] transition hover:border-line-strong" onClick={() => go(s)}>
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wide text-fg-faint">{s.kind === 'dashboard' ? 'chat' : s.kind === 'background' ? 'bg' : 'tty'}</span>
                <span className="truncate font-medium">{s.title || s.name || s.id}</span>
              </div>
              <div className="truncate text-[11px] text-fg-muted mono">{s.repo ? `${s.repo} / ${s.branch || ''}` : shortPath(s.cwd)}</div>
              <div className="mt-1 flex items-center justify-between"><Status state={s.state} /><span className="num text-[10px] text-fg-faint">{age(s.job?.updatedAt || s.startedAt)}</span></div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
