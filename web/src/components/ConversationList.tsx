import { useState } from 'react';
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Copy, Download, FolderInput, MessageSquare, Pencil, Pin, PinOff, Send, SquareTerminal, Trash2 } from 'lucide-react';
import { api, type Conversation } from '../lib/api';
import { age, shortPath } from '../lib/format';
import { actions, useStore } from '../lib/store';
import { openTerminal } from '../lib/terminal';
import { useContextMenu, type MenuItem } from './ContextMenu';
import { exportConversation, forwardLastReply, openMove } from './SidebarDialogs';

/** Saved conversations, pinned first then newest, that are not currently running anywhere. Running ones live under their worktree in the tree.
 *  Archived ones (by hand, or idle for two weeks) sit in a collapsed group at the bottom. Right-click a row for everything else. */
export function ConversationList() {
  const snap = useStore(s => s.snapshot);
  const filter = useStore(s => s.convoFilter);
  const view = useStore(s => s.view);
  const open = useStore(s => s.convosOpen);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [menu, openMenu] = useContextMenu();
  if (!snap) return null;
  const q = filter.toLowerCase();
  const all = snap.conversations.filter(c => !c.running && !c.chat).filter(c => !q || `${c.title} ${c.repo || ''} ${c.branch || ''} ${c.cwd}`.toLowerCase().includes(q));
  const saved = all.filter(c => !c.archived).sort((a, b) => Number(b.pinned) - Number(a.pinned)), archived = all.filter(c => c.archived);

  const rename = async (sessionId: string, current: string) => {
    const next = window.prompt('Rename conversation', current);
    if (!next?.trim() || next.trim() === current) return;
    try { await api.rename(sessionId, next.trim()); actions.toast('Renamed'); } catch (err: any) { actions.toast(err.message, 'error'); }
  };
  const pin = (c: Conversation, on: boolean) => api.pin(c.sessionId, on).catch(err => actions.toast(err.message, 'error'));
  const archive = (c: Conversation, on: boolean) => api.archive(c.sessionId, on).then(() => actions.toast(on ? `Archived "${c.title}"` : `Restored "${c.title}"`)).catch(err => actions.toast(err.message, 'error'));
  const remove = async (c: Conversation) => {
    if (!window.confirm(`Delete "${c.title}"?\n\nThe transcript is removed from disk, so it can no longer be resumed here or in Claude Code. Archive it instead to keep it out of the way.`)) return;
    try { await api.deleteConversation(c.sessionId); actions.closeTab(`resume:${c.sessionId}`); actions.toast(`Deleted "${c.title}"`); }
    catch (err: any) { actions.toast(err.message, 'error'); }
  };
  const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => actions.toast(`Copied ${what}`), () => actions.toast('The browser blocked clipboard access', 'error'));
  const resume = (c: Conversation) => actions.go({ kind: 'resume', sessionId: c.sessionId, cwd: c.cwd, title: c.title });
  const items = (c: Conversation): MenuItem[] => [
    { label: 'Open', icon: MessageSquare, onSelect: () => resume(c) },
    { label: 'Rename…', icon: Pencil, onSelect: () => rename(c.sessionId, c.title) },
    c.pinned ? { label: 'Unpin', icon: PinOff, onSelect: () => pin(c, false) } : { label: 'Pin to top', icon: Pin, onSelect: () => pin(c, true) },
    c.archived ? { label: 'Restore from archive', icon: ArchiveRestore, onSelect: () => archive(c, false) } : { label: 'Archive', icon: Archive, onSelect: () => archive(c, true) },
    { label: 'Move to project…', icon: FolderInput, onSelect: () => openMove(c.sessionId, c.title, c.locatedBy === 'pinned' ? c.worktree : null) },
    'separator',
    { label: 'Send last reply to a chat…', icon: Send, onSelect: () => forwardLastReply(c.sessionId, { title: c.title }) },
    { label: 'Export as markdown', icon: Download, onSelect: () => exportConversation(c.sessionId) },
    { label: 'Open a terminal here', icon: SquareTerminal, onSelect: () => openTerminal(c.cwd), disabled: !c.cwd },
    { label: 'Copy resume command', icon: Copy, onSelect: () => copy(`cd "${c.cwd}"; claude --resume ${c.sessionId}`, 'the resume command') },
    'separator',
    { label: 'Delete…', icon: Trash2, danger: true, onSelect: () => remove(c) },
  ];

  const row = (c: Conversation) => {
    const selected = view.kind === 'resume' && view.sessionId === c.sessionId;
    return (
      <div key={c.sessionId} className="flex items-center" onContextMenu={e => openMenu(e, items(c))}>
        <button className="row" aria-current={selected ? 'true' : undefined} title={`${c.firstPrompt}
${c.repo ? `${c.repo}${c.branch ? ' / ' + c.branch : ''}` : shortPath(c.cwd)}${c.locatedBy && c.locatedBy !== 'cwd' ? `\n(placed by ${c.locatedBy})` : ''}${c.autoArchived ? '\n(archived after two weeks idle)' : ''}`} onClick={() => resume(c)}>
          {c.pinned && <Pin size={11} className="shrink-0 text-fg-faint" aria-label="Pinned" />}
          <span className={`grow ${c.archived ? 'text-fg-muted' : ''}`}>{c.title}</span>
          <span className="num text-[10px] text-fg-faint">{age(c.lastModified)}</span>
        </button>
      </div>
    );
  };

  return (
    <div className="mb-3">
      <div className="section-title">
        <button className="flex items-center gap-1" onClick={actions.toggleConvos} aria-expanded={open}>
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          Recent conversations
        </button>
        <span className="count num">{saved.length}</span>
      </div>
      {open && (
        <>
          <input className="input mb-1 w-full" type="search" placeholder="Filter by title, repo, or branch" value={filter} onChange={e => actions.setConvoFilter(e.target.value)} />
          {saved.slice(0, 80).map(row)}
          {saved.length > 80 && <div className="px-2 py-1 text-[11px] text-fg-faint">{saved.length - 80} more. Narrow the filter to see them.</div>}
          {archived.length > 0 && (
            <>
              <button className="section-title mt-1 w-full" onClick={() => setArchivedOpen(o => !o)} aria-expanded={archivedOpen}>
                {archivedOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                <Archive size={13} aria-hidden="true" /> Archived
                <span className="count num">{archived.length}</span>
              </button>
              {archivedOpen && archived.slice(0, 80).map(row)}
            </>
          )}
        </>
      )}
      {menu}
    </div>
  );
}
