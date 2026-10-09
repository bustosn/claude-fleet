import { useEffect, useRef, type MouseEvent } from 'react';
import { Bot, FolderGit2, GitBranch, KeyRound, MessageSquare, Plus, Terminal, X } from 'lucide-react';
import type { Snapshot } from '../lib/api';
import { shortPath } from '../lib/format';
import { actions, tabKey, useStore, type Tab, type View } from '../lib/store';
import { openTerminal } from '../lib/terminal';

/** Open views as editor-style tabs. Middle-click closes; the active tab carries the accent line. */
export function TabStrip() {
  const tabs = useStore(s => s.tabs);
  const view = useStore(s => s.view);
  const snap = useStore(s => s.snapshot);
  const active = view.kind === 'overview' ? null : tabKey(view);
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => { strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [active]);

  if (tabs.length === 0) return null;
  return (
    <div ref={strip} role="tablist" aria-label="Open views" className="flex h-[34px] shrink-0 items-stretch overflow-x-auto border-b border-line bg-surface [scrollbar-width:thin]">
      {tabs.map(t => <TabButton key={t.key} tab={t} active={t.key === active} label={tabLabel(t.view, snap)} />)}
      <button className="iconbtn my-auto ml-1 shrink-0" style={{ width: 26, height: 26 }} title="New chat" aria-label="New chat" onClick={() => actions.go({ kind: 'new-chat' })}><Plus size={14} aria-hidden="true" /></button>
      <button className="iconbtn my-auto shrink-0" style={{ width: 26, height: 26 }} title="New terminal (in the current worktree or chat's folder)" aria-label="New terminal" onClick={() => openTerminal()}><Terminal size={14} aria-hidden="true" /></button>
    </div>
  );
}

function TabButton({ tab, active, label }: { tab: Tab; active: boolean; label: { text: string; hint: string; state?: string } }) {
  const Icon = iconFor(tab.view, label.state);
  const close = (e: MouseEvent) => { e.stopPropagation(); actions.closeTab(tab.key); };
  const onAux = (e: MouseEvent) => { if (e.button === 1) { e.preventDefault(); actions.closeTab(tab.key); } };
  return (
    <div
      role="tab" aria-selected={active} tabIndex={0} title={label.hint}
      className={`group relative flex max-w-[220px] min-w-[120px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-line pl-3 pr-1 text-[12px] select-none ${active ? 'bg-bg text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg'}`}
      onClick={() => actions.go(tab.view)} onAuxClick={onAux}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); actions.go(tab.view); } if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); actions.closeTab(tab.key); } }}
    >
      {active && <span className="absolute inset-x-0 top-0 h-[2px] bg-accent" aria-hidden="true" />}
      {label.state ? <span className="dot shrink-0" data-s={label.state} aria-hidden="true" /> : <Icon size={13} className="shrink-0 text-fg-faint" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{label.text}</span>
      <button className={`iconbtn shrink-0 ${active ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`} style={{ width: 20, height: 20 }} aria-label={`Close ${label.text}`} title="Close" onClick={close}>
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

function iconFor(v: View, state?: string) {
  if (v.kind === 'worktree') return GitBranch;
  if (v.kind === 'hub') return KeyRound;
  if (v.kind === 'session') return state ? Terminal : Bot;
  if (v.kind === 'terminal') return Terminal;
  if (v.kind === 'overview') return FolderGit2;
  return MessageSquare;
}

/** Live titles: a renamed chat or a session's current state show up in its tab without reopening it. */
export function tabLabel(v: View, snap: Snapshot | null): { text: string; hint: string; state?: string } {
  switch (v.kind) {
    case 'overview': return { text: 'Overview', hint: 'Overview' };
    case 'hub': return { text: 'Hub', hint: 'AWS credentials and other chores' };
    case 'new-chat': return { text: 'New chat', hint: v.cwd ? `New chat in ${shortPath(v.cwd)}` : 'New chat' };
    case 'resume': return { text: v.title, hint: `Opening ${v.title}` };
    case 'chat': {
      const s = snap?.sessions.find(x => x.chatId === v.chatId);
      const c = snap?.chats.find(x => x.id === v.chatId);
      const text = s?.title || c?.title || v.title || 'Chat';
      return { text, hint: `${text}${c?.repo ? `\n${c.repo} / ${c.branch || ''}` : ''}`, state: s?.state || c?.status };
    }
    case 'session': {
      const s = snap?.sessions.find(x => x.id === v.id);
      const text = s?.title || s?.name || v.id;
      return { text, hint: `${text}\n${s?.kind === 'background' ? 'background session' : 'terminal session'}`, state: s?.state };
    }
    case 'worktree': {
      for (const r of snap?.repos || []) for (const w of r.worktrees) if (w.path.toLowerCase() === v.path.toLowerCase()) return { text: w.isMain ? r.name : `${r.name} / ${w.branch || shortPath(w.path)}`, hint: `${w.path}\n${w.branch || ''}` };
      return { text: shortPath(v.path).split('/').pop() || v.path, hint: v.path };
    }
    case 'terminal': {
      const t = snap?.terminals.find(x => x.id === v.id);
      if (!t) return { text: 'Terminal', hint: 'Terminal (no longer running)', state: 'ended' };
      return { text: t.title, hint: `${t.shell}\n${t.cwd}`, state: t.exitCode == null ? undefined : 'ended' };
    }
  }
}
