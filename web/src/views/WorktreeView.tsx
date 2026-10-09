import { GitBranch, Plus } from 'lucide-react';
import { age, shortPath, ticketKey } from '../lib/format';
import { actions, useStore } from '../lib/store';
import { SessionRow } from '../components/ProjectTree';
import { Empty } from '../components/ui';

export function WorktreeView({ path }: { path: string }) {
  const snap = useStore(s => s.snapshot);
  const found = snap?.repos.flatMap(r => r.worktrees.map(w => ({ repo: r, wt: w }))).find(x => x.wt.path.toLowerCase() === path.toLowerCase());
  if (!snap) return null;
  if (!found) return <Empty title="Worktree not found">It may have been removed. The tree refreshes every ten seconds.</Empty>;
  const { repo, wt } = found;
  const sessions = snap.sessions.filter(s => s.worktree && s.worktree.toLowerCase() === wt.path.toLowerCase());
  const lower = wt.path.toLowerCase();
  const saved = snap.conversations.filter(c => !c.running && !c.chat && (c.cwd.toLowerCase() === lower || c.cwd.toLowerCase().startsWith(lower + '/')));
  const key = ticketKey(wt.branch) || ticketKey(wt.path);

  return (
    <div className="grid min-h-0 flex-1 auto-rows-max content-start gap-4 overflow-y-auto p-5">
      <header className="flex items-start gap-3">
        <GitBranch size={20} className="mt-0.5 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-[16px] font-semibold">{repo.name} <span className="mono font-normal text-fg-muted">{wt.branch || `detached ${wt.head}`}</span></h1>
          <div className="mono text-[12px] text-fg-faint">{wt.path}</div>
        </div>
        {key && <span className="chip ticket">{key}</span>}
        <button className="btn primary" onClick={() => actions.go({ kind: 'new-chat', cwd: wt.path })}><Plus size={13} aria-hidden="true" /> New chat here</button>
      </header>

      <dl className="kv panel p-4">
        <dt>Changes</dt><dd>{wt.dirty + wt.untracked ? <span className="text-warn">{wt.dirty} modified, {wt.untracked} untracked</span> : 'clean'}</dd>
        <dt>Upstream</dt><dd>{wt.upstream ? <>{wt.upstream} <span className="num text-fg-muted">+{wt.ahead} / −{wt.behind}</span></> : <span className="text-fg-faint">no upstream</span>}</dd>
        <dt>Last commit</dt><dd>{wt.lastCommit ? <><span className="mono text-fg-muted">{wt.lastCommit.hash}</span> {wt.lastCommit.subject} <span className="text-fg-faint">{age(wt.lastCommit.at)} ago</span></> : <span className="text-crit">{wt.error}</span>}</dd>
        <dt>Kind</dt><dd>{wt.isMain ? 'main checkout' : wt.managed ? 'Claude-managed worktree' : 'worktree'}{wt.locked ? ', locked' : ''}</dd>
      </dl>

      <section>
        <div className="section-title">Sessions here <span className="count num">{sessions.length}</span></div>
        {sessions.length === 0 ? <div className="px-2 text-[12px] text-fg-faint">No session is running in this checkout.</div> : sessions.map(s => <SessionRow key={s.id} session={s} indent={6} />)}
      </section>

      <section>
        <div className="section-title">Saved conversations here <span className="count num">{saved.length}</span></div>
        {saved.length === 0 && <div className="px-2 text-[12px] text-fg-faint">None yet. Conversations started from this folder will show up here.</div>}
        {saved.map(c => (
          <button key={c.sessionId} className="row" onClick={() => actions.go({ kind: 'resume', sessionId: c.sessionId, cwd: c.cwd, title: c.title })} title={c.firstPrompt}>
            <span className="grow">{c.title}</span><span className="num text-[10px] text-fg-faint">{age(c.lastModified)}</span>
          </button>
        ))}
      </section>
    </div>
  );
}
