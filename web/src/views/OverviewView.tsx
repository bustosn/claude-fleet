import type { Column, Session } from '../lib/api';
import { age, shortPath } from '../lib/format';
import { actions, useStore } from '../lib/store';
import { Status, Empty } from '../components/ui';

const COLS: { id: Column; title: string; blurb: string }[] = [
  { id: 'needs-you', title: 'Needs you', blurb: 'blocked on a question or a permission' },
  { id: 'working', title: 'Working', blurb: 'a turn is in progress' },
  { id: 'idle', title: 'Idle', blurb: 'waiting at the prompt' },
  { id: 'done', title: 'Done', blurb: 'finished, stopped, or stale' },
];

export function OverviewView() {
  const snap = useStore(s => s.snapshot);
  if (!snap) return <Empty title="Connecting">Reading sessions, worktrees, and saved conversations.</Empty>;
  const open = (s: Session) => s.kind === 'dashboard' && s.chatId ? actions.go({ kind: 'chat', chatId: s.chatId, title: s.title }) : actions.go({ kind: 'session', id: s.id });

  return (
    <div className="grid min-h-0 flex-1 auto-rows-max content-start gap-3 overflow-y-auto p-4">
      <div className="grid grid-cols-4 gap-3 max-[1100px]:grid-cols-2">
        {COLS.map(col => {
          const list = snap.sessions.filter(s => s.column === col.id);
          return (
            <section key={col.id} className="panel min-h-40 p-2">
              <div className="section-title" title={col.blurb}><span className="dot" data-s={col.id === 'done' ? 'done' : col.id} aria-hidden="true" />{col.title}<span className="count num">{list.length}</span></div>
              <div className="grid gap-1.5">
                {list.length === 0 && <div className="px-2 py-3 text-[11px] text-fg-faint">{col.blurb}</div>}
                {list.map(s => (
                  <button key={s.id} className="rounded-md border border-line bg-raised p-2 text-left hover:border-line-strong" onClick={() => open(s)}>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide text-fg-faint">{s.kind === 'dashboard' ? 'chat' : s.kind === 'background' ? 'bg' : 'tty'}</span>
                      <span className="truncate font-medium">{s.title || s.name || s.id}</span>
                    </div>
                    <div className="truncate text-[11px] text-fg-muted mono">{s.repo ? `${s.repo} / ${s.branch || ''}` : shortPath(s.cwd)}</div>
                    {s.job?.needs && s.state === 'blocked' && <div className="mt-1 line-clamp-2 text-[11px] text-fg-muted">{s.job.needs}</div>}
                    <div className="mt-1 flex items-center justify-between"><Status state={s.state} /><span className="num text-[10px] text-fg-faint">{age(s.job?.updatedAt || s.startedAt)}</span></div>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
