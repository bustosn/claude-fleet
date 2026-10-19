import { useState } from 'react';
import { ChevronDown, ChevronRight, FolderGit2, GitBranch, House, MessageSquare, Terminal, Bot, SquareTerminal, X, Code2, FolderOpen, Copy, Plus, Send, Download, FolderInput } from 'lucide-react';
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
  const openRepos = useStore(s => s.openRepos);
  if (!snap) return <div className="section-title">Projects <span className="count">loading</span></div>;

  const repos = [...snap.repos].sort((a, b) => (b.worktrees.length - a.worktrees.length) || a.name.localeCompare(b.name));
  // Sessions with no repo are one-offs; they are listed under Recent conversations, not here.
  // A repo with one checkout and no sessions has nothing to show; those fold into a single "N more" row.
  const busy = (r: Repo) => r.worktrees.length > 1 || snap.sessions.some(s => s.worktree && r.worktrees.some(w => w.path.toLowerCase() === s.worktree!.toLowerCase()));
  const active = repos.filter(busy), idle = repos.filter(r => !busy(r));

  return (
    <div className="mb-3">
      <div className="section-title">Projects <span className="count num">{repos.length}</span></div>
      {active.map(r => <RepoNode key={r.name} repo={r} open={!!openRepos[r.name]} />)}
      {idle.length > 0 && <IdleRepos repos={idle} />}
    </div>
  );
}

function RepoNode({ repo, open }: { repo: Repo; open: boolean }) {
  const view = useStore(s => s.view);
  const [menu, openMenu] = useContextMenu();
  const snap = useStore(s => s.snapshot)!;
  const attention = repo.worktrees.reduce((n, w) => n + w.sessions.filter(s => s.column === 'needs-you').length, 0);
  const main = repo.worktrees[0];
  const chevron = (
    <button className="iconbtn shrink-0" style={{ width: 16, height: 16 }} onClick={e => { e.stopPropagation(); actions.toggleRepo(repo.name); }} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${repo.name}`}>
      {open ? <ChevronDown size={13} className="text-fg-faint" aria-hidden="true" /> : <ChevronRight size={13} className="text-fg-faint" aria-hidden="true" />}
    </button>
  );
  // A repo with only its main checkout is one row: the name opens the checkout, the chevron shows its sessions.
  if (repo.worktrees.length === 1 && main) {
    const selected = view.kind === 'worktree' && view.path === main.path;
    const sessions = snap.sessions.filter(s => s.worktree && s.worktree.toLowerCase() === main.path.toLowerCase());
    return (
      <div>
        {menu}
        <div className="row" aria-current={selected ? 'true' : undefined} onContextMenu={e => openMenu(e, worktreeItems(main))} title={`${main.path}\n${main.branch || ''}`}>
          {sessions.length ? chevron : <span className="w-[16px] shrink-0" />}
          <button className="flex min-w-0 grow items-center gap-2 text-left" onClick={() => actions.go({ kind: 'worktree', path: main.path })}>
            <FolderGit2 size={14} className="shrink-0 text-fg-muted" aria-hidden="true" />
            <span className="grow font-medium">{repo.name}</span>
            {attention > 0 && <span className="chip warn num">{attention}</span>}
            {main.branch && !/^(main|master)$/.test(main.branch) && <span className="mono truncate max-w-[40%] text-fg-faint">{main.branch}</span>}
            {!open && sessions.length > 0 && <span className="num text-[11px] text-fg-faint">{sessions.length}</span>}
          </button>
        </div>
        {open && <SessionList sessions={sessions} indent={INDENT.wt} />}
      </div>
    );
  }
  return (
    <div>
      {menu}
      <button className="row" onClick={() => actions.toggleRepo(repo.name)} aria-expanded={open} onContextMenu={e => main && openMenu(e, worktreeItems(main))}>
        <span className="flex w-[16px] shrink-0 justify-center">{open ? <ChevronDown size={13} className="text-fg-faint" aria-hidden="true" /> : <ChevronRight size={13} className="text-fg-faint" aria-hidden="true" />}</span>
        <FolderGit2 size={14} className="shrink-0 text-fg-muted" aria-hidden="true" />
        <span className="grow font-medium">{repo.name}</span>
        {attention > 0 && <span className="chip warn num">{attention}</span>}
        {!open && <span className="num text-[11px] text-fg-faint">{repo.worktrees.length}</span>}
      </button>
      {open && repo.worktrees.map(w => <WorktreeNode key={w.path} repo={repo} wt={w} />)}
      {open && repo.error && <div className="text-[11px] text-crit" style={{ paddingLeft: INDENT.wt }}>{repo.error}</div>}
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
      {/* Indents are inline: .row's own padding beats Tailwind's pl-* utilities. */}
      <button className="row" style={{ paddingLeft: INDENT.wt }} aria-current={selected ? 'true' : undefined} onClick={() => actions.go({ kind: 'worktree', path: wt.path })} onContextMenu={e => openMenu(e, worktreeItems(wt))}
        title={wt.isMain ? `${wt.path}\nThe repo's own folder (not a worktree), currently on ${wt.branch || 'a detached HEAD'}` : `${wt.path}\n${wt.branch || ''}`}>
        {/* The main checkout is the repo folder itself. Labelled by its branch it reads like a worktree, so it gets a house and "Main folder" instead. */}
        {wt.isMain ? <>
          <House size={12} className="shrink-0 text-fg-faint" aria-hidden="true" />
          <span className="shrink-0 text-fg-muted">Main folder</span>
          <span className="grow mono text-[11px] text-fg-faint">{wt.branch && !/^(main|master)$/.test(wt.branch) ? wt.branch : ''}</span>
        </> : <>
          <GitBranch size={12} className="shrink-0 text-accent" aria-hidden="true" />
          {key && <span className="mono shrink-0 text-[11px] text-accent">{key}</span>}
          <span className="grow text-fg-muted">{branchLabel(wt, key)}</span>
        </>}
      </button>
      <SessionList sessions={sessions} indent={INDENT.session} />
    </div>
  );
}

const INDENT = { wt: 28, session: 46 };
const SHOWN = 3;

/** The branch with its ticket key taken off the front and dashes read as spaces: "JL-7488-dlocal-webhook" shows as "dlocal webhook" after the key. */
function branchLabel(wt: Worktree, key: string | null): string {
  if (!wt.branch) return wt.detached ? `detached ${wt.head}` : shortPath(wt.path);
  if (!key) return wt.branch;
  return wt.branch.replace(/^.*\//, '').replace(new RegExp(`^${key}`, 'i'), '').replace(/^[-_]+/, '').replace(/[-_]+/g, ' ');
}

const quiet = (state: string) => state === 'idle' || state === 'stopped' || state === 'ended';

/** A worktree's sessions: anything working or waiting on you first, then idle ones, with all but the first few behind a "N more" row. */
function SessionList({ sessions, indent }: { sessions: Session[]; indent: number }) {
  const [all, setAll] = useState(false);
  if (!sessions.length) return null;
  const sorted = [...sessions].sort((a, b) => Number(quiet(a.state)) - Number(quiet(b.state)));
  const cut = Math.max(SHOWN, sorted.filter(s => !quiet(s.state)).length);
  const shown = all ? sorted : sorted.slice(0, cut);
  return (
    <>
      {shown.map(s => <SessionRow key={s.id} session={s} indent={indent} />)}
      {sorted.length > cut && (
        <button className="row text-[11px] text-fg-faint" style={{ paddingLeft: indent + 14 }} onClick={() => setAll(a => !a)}>
          {all ? 'Show fewer' : `${sorted.length - cut} more`}
        </button>
      )}
    </>
  );
}

function IdleRepos({ repos }: { repos: Repo[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="row text-[11px] text-fg-faint" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {open ? <ChevronDown size={13} className="shrink-0" aria-hidden="true" /> : <ChevronRight size={13} className="shrink-0" aria-hidden="true" />}
        {repos.length} repos with nothing open
      </button>
      {open && repos.map(r => <RepoNode key={r.name} repo={r} open />)}
    </>
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
      <button className="row" style={{ paddingLeft: indent }} aria-current={selected ? 'true' : undefined} onClick={open} onContextMenu={e => openMenu(e, items)} title={`${s.title}\n${s.kind === 'dashboard' ? 'chat' : s.kind === 'background' ? 'background' : 'terminal'} · ${s.state}${s.locatedBy && s.locatedBy !== 'cwd' ? `\nplaced here by ${s.locatedBy}` : ''}`}>
        <span className="dot" data-s={s.state} aria-hidden="true" />
        <span className={`grow ${quiet(s.state) ? 'text-fg-muted' : 'text-fg'}`}>{s.title || s.name || s.id}</span>
      </button>
      {menu}
    </>
  );
}
