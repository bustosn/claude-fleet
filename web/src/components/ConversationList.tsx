import { useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { age, shortPath } from '../lib/format';
import { actions, useStore } from '../lib/store';

/** Saved conversations, newest first, that are not currently running anywhere. Running ones live under their worktree in the tree. */
export function ConversationList() {
  const snap = useStore(s => s.snapshot);
  const filter = useStore(s => s.convoFilter);
  const view = useStore(s => s.view);
  const [open, setOpen] = useState(true);
  if (!snap) return null;
  const q = filter.toLowerCase();
  const saved = snap.conversations.filter(c => !c.running && !c.chat).filter(c => !q || `${c.title} ${c.repo || ''} ${c.branch || ''} ${c.cwd}`.toLowerCase().includes(q));
  const rename = async (sessionId: string, current: string) => {
    const next = window.prompt('Rename conversation', current);
    if (!next?.trim() || next.trim() === current) return;
    try { await api.rename(sessionId, next.trim()); actions.toast('Renamed'); } catch (err: any) { actions.toast(err.message, 'error'); }
  };

  return (
    <div className="mb-3">
      <div className="section-title">
        <button className="flex items-center gap-1" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          Recent conversations
        </button>
        <span className="count num">{saved.length}</span>
        <button className="iconbtn" style={{ width: 22, height: 22 }} title="New chat" aria-label="New chat" onClick={() => actions.go({ kind: 'new-chat' })}><Plus size={14} aria-hidden="true" /></button>
      </div>
      {open && (
        <>
          <input className="input mb-1 w-full" type="search" placeholder="Filter by title, repo, or branch" value={filter} onChange={e => actions.setConvoFilter(e.target.value)} />
          {saved.slice(0, 80).map(c => {
            const selected = view.kind === 'resume' && view.sessionId === c.sessionId;
            return (
              <div key={c.sessionId} className="group flex items-center">
                <button className="row" aria-current={selected ? 'true' : undefined} title={`${c.firstPrompt}${c.locatedBy && c.locatedBy !== 'cwd' ? `\n(placed by ${c.locatedBy})` : ''}`} onClick={() => actions.go({ kind: 'resume', sessionId: c.sessionId, cwd: c.cwd, title: c.title })}>
                  <span className="grow">{c.title}</span>
                  <span className="text-[10px] text-fg-faint truncate max-w-[35%] mono">{c.repo ? `${c.repo}${c.branch ? ' / ' + c.branch : ''}` : shortPath(c.cwd)}</span>
                  <span className="num text-[10px] text-fg-faint">{age(c.lastModified)}</span>
                </button>
                <button className="iconbtn shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100" style={{ width: 22, height: 22 }} title="Rename" aria-label={`Rename ${c.title}`} onClick={() => rename(c.sessionId, c.title)}><Pencil size={12} aria-hidden="true" /></button>
              </div>
            );
          })}
          {saved.length > 80 && <div className="px-2 py-1 text-[11px] text-fg-faint">{saved.length - 80} more. Narrow the filter to see them.</div>}
        </>
      )}
    </div>
  );
}
