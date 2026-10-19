import { ChevronDown, ChevronRight, FolderGit2, GitBranch, MessageSquare, Terminal, Bot, SquareTerminal, X, Code2, FolderOpen, Copy, Plus, Send, Download, FolderInput } from 'lucide-react';
import { api } from '../lib/api';
import type { Repo, Session, Worktree } from '../lib/api';
import { shortPath, ticketKey } from '../lib/format';
import { actions, useStore } from '../lib/store';
import { openTerminal } from '../lib/terminal';
import { useContextMenu, type MenuItem } from './ContextMenu';
import { exportConversation, forwardLastReply, openMove } from './SidebarDialogs';

/** Repos → worktrees → the sessions living in each. The spine of the app. */
export function ProjectTree() {
  const snap = useStore(s => s.snapshot);
  const collapsed = useStore(s => s.collapsedRepos);
  if (!snap) return <div className="section-title">Projects <span className="count">loading</span></div>;

  const repos = [...snap.repos].sort((a, b) => (b.worktrees.length - a.worktrees.length) || a.name.localeCompare(b.name));
  const inRepo = new Set(snap.sessions.filter(s => s.worktree).map(s => s.id));
  const loose = snap.sessions.filter(s => !inRepo.has(s.id));

  return (
    <div className="mb-3">
      <div className="section-title">Projects <span className="count num">{repos.length}</span></div>
      {repos.map(r => <RepoNode key={r.name} repo={r} open={!collapsed[r.name]} />)}
      {loose.length > 0 && (
        <div className="mt-3">
          <div className="section-title">Sessions outside a repo <span className="count num">{loose.length}</span></div>
          {loose.map(s => <SessionRow key={s.id} session={s} indent={6} />)}
        </div>
      )}
    </div>
  );
}

function RepoNode({ repo, open }: { repo: Repo; open: boolean }) {
  const view = useStore(s => s.view);
  const [menu, openMenu] = useContextMenu();
  const snap = useStore(s => s.snapshot)!;
  const attention = repo.worktrees.reduce((n, w) => n + w.sessions.filter(s => s.column === 'needs-you').length, 0);
  const main = repo.worktrees[0];
  // A repo with only its main checkout is one row: the repo opens the checkout directly.
  if (repo.worktrees.length === 1 && main) {
    const selected = view.kind === 'worktree' && view.path === main.path;
    const sessions = snap.sessions.filter(s => s.worktree && s.worktree.toLowerCase() === main.path.toLowerCase());
    return (
      <div>
        {menu}
        <button className="row" aria-current={selected ? 'true' : undefined} onClick={() => actions.go({ kind: 'worktree', path: main.path })} onContextMenu={e => openMenu(e, worktreeItems(main))} title={`${main.path}\n${main.branch || ''}`}>
          <span className="w-[14px]" />
          <FolderGit2 size={14} className="text-fg-muted" aria-hidden="true" />
          <span className="grow font-medium">{repo.name}</span>
          {attention > 0 && <span className="chip warn num">{attention}</span>}
          {main.branch && !/^(main|master)$/.test(main.branch) && <span className="mono truncate max-w-[40%] text-fg-faint">{main.branch}</span>}
        </button>
        {sessions.map(s => <SessionRow key={s.id} session={s} indent={34} />)}
      </div>
    );
  }
  return (
    <div>
      {menu}
      <button className="row" onClick={() => actions.toggleRepo(repo.name)} aria-expanded={open} onContextMenu={e => main && openMenu(e, worktreeItems(main))}>
        {open ? <ChevronDown size={14} className="text-fg-faint" aria-hidden="true" /> : <ChevronRight size={14} className="text-fg-faint" aria-hidden="true" />}
        <FolderGit2 size={14} className="text-fg-muted" aria-hidden="true" />
        <span className="grow font-medium">{repo.name}</span>
        {attention > 0 && <span className="chip warn num">{attention}</span>}
        {!open && <span className="num text-[11px] text-fg-faint">{repo.worktrees.length} worktrees</span>}
      </button>
      {open && repo.worktrees.map(w => <WorktreeNode key={w.path} repo={repo} wt={w} />)}
      {open && repo.error && <div className="px-7 text-[11px] text-crit">{repo.error}</div>}
    </div>
  );
}

function WorktreeNode({ repo, wt }: { repo: Repo; wt: Worktree }) {
  const view = useStore(s => s.view);
  const [menu, openMenu] = useContextMenu();
  const snap = useStore(s => s.snapshot)!;
  const selected = view.kind === 'worktree' && view.path === wt.path;
  const key = ticketKey(wt.branch) || ticketKey(wt.path);
  const sessions = snap.sessions.filter(s => s.worktree && s.worktree.toLowerCase() === wt.path.toLowerCase());
  return (
    <div>
      {menu}
      <button className="row pl-6" aria-current={selected ? 'true' : undefined} onClick={() => actions.go({ kind: 'worktree', path: wt.path })} onContextMenu={e => openMenu(e, worktreeItems(wt))} title={`${wt.path}\n${wt.branch || ''}`}>
        <GitBranch size={13} className={wt.isMain ? 'text-fg-faint' : 'text-accent'} aria-hidden="true" />
        <span className="grow mono">{wt.branch || (wt.detached ? `detached ${wt.head}` : shortPath(wt.path))}</span>
        {key && !wt.isMain && <span className="chip ticket">{key}</span>}      </button>
      {sessions.map(s => <SessionRow key={s.id} session={s} indent={34} />)}
    </div>
  );
}

const copyText = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => actions.toast(`Copied ${what}`), () => actions.toast('The browser blocked clipboard access', 'error'));
const openWt = (path: string, how: 'editor' | 'folder') => api.openWorktree(path, how).catch(e => actions.toast(e.message, 'error'));

/** Right-click on a worktree (or a repo that is only its main checkout). */
function worktreeItems(wt: Worktree): MenuItem[] {
  return [
    { label: 'New chat here', icon: Plus, onSelect: () => actions.go({ kind: 'new-chat', cwd: wt.path }) },
    { label: 'Open a terminal here', icon: SquareTerminal, onSelect: () => openTerminal(wt.path) },
    { label: 'Open in VS Code', icon: Code2, onSelect: () => openWt(wt.path, 'editor') },
    { label: 'Show in folder', icon: FolderOpen, onSelect: () => openWt(wt.path, 'folder') },
    'separator',
    { label: 'Copy branch name', icon: Copy, onSelect: () => copyText(wt.branch!, 'the branch name'), disabled: !wt.branch },
    { label: 'Copy path', icon: Copy, onSelect: () => copyText(wt.path, 'the path') },
  ];
}

export function SessionRow({ session: s, indent }: { session: Session; indent: number }) {
  const view = useStore(s => s.view);
  const selected = (view.kind === 'chat' && s.chatId === view.chatId) || (view.kind === 'session' && view.id === s.id);
  const Icon = s.kind === 'dashboard' ? MessageSquare : s.kind === 'background' ? Bot : Terminal;
  const open = () => s.kind === 'dashboard' && s.chatId ? actions.go({ kind: 'chat', chatId: s.chatId, title: s.title }) : actions.go({ kind: 'session', id: s.id });
  const [menu, openMenu] = useContextMenu();
  const items: MenuItem[] = [
    { label: 'Open', icon: Icon, onSelect: open },
    { label: 'Open a terminal here', icon: SquareTerminal, onSelect: () => openTerminal(s.cwd), disabled: !s.cwd },
    ...(s.sessionId ? [
      { label: 'Move to project…', icon: FolderInput, onSelect: () => openMove(s.sessionId!, s.title || s.name, s.locatedBy === 'pinned' ? s.worktree : null) },
      { label: 'Send last reply to a chat…', icon: Send, onSelect: () => forwardLastReply(s.sessionId!, { chatId: s.chatId, title: s.title || s.name }) },
      { label: 'Export as markdown', icon: Download, onSelect: () => exportConversation(s.sessionId!) },
    ] : []),
    ...(s.chatId ? ['separator' as const, { label: 'End chat', icon: X, danger: true, onSelect: () => api.endChat(s.chatId!).then(() => actions.toast('Chat ended')).catch(e => actions.toast(e.message, 'error')) }] : []),
  ];
  return (
    <>
      <button className="row" style={{ paddingLeft: indent }} aria-current={selected ? 'true' : undefined} onClick={open} onContextMenu={e => openMenu(e, items)} title={`${s.title}\n${s.state}${s.locatedBy && s.locatedBy !== 'cwd' ? `\nplaced here by ${s.locatedBy}` : ''}`}>
        <span className="dot" data-s={s.state} aria-hidden="true" />
        <Icon size={13} className="text-fg-faint" aria-hidden="true" />
        <span className="grow">{s.title || s.name || s.id}</span>
      </button>
      {menu}
    </>
  );
}
