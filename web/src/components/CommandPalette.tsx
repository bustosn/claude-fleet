import { useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, KeyRound, LayoutGrid, MessageSquare, Plus, Search, Terminal } from 'lucide-react';
import { shortPath } from '../lib/format';
import { actions, useStore, type View } from '../lib/store';

interface Item { id: string; label: string; hint: string; icon: typeof Search; view: View }

export function CommandPalette() {
  const open = useStore(s => s.paletteOpen);
  const snap = useStore(s => s.snapshot);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setQ(''); setCursor(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);

  const items = useMemo<Item[]>(() => {
    if (!snap) return [];
    const out: Item[] = [
      { id: 'overview', label: 'Overview', hint: 'fleet board', icon: LayoutGrid, view: { kind: 'overview' } },
      { id: 'hub', label: 'Hub', hint: 'AWS credentials and chores', icon: KeyRound, view: { kind: 'hub' } },
      { id: 'new', label: 'New chat', hint: 'start a chat in a worktree', icon: Plus, view: { kind: 'new-chat' } },
    ];
    for (const s of snap.sessions) out.push({ id: `s:${s.id}`, label: s.title || s.name, hint: `${s.kind === 'dashboard' ? 'chat' : s.kind} · ${s.repo ? `${s.repo} / ${s.branch || ''}` : shortPath(s.cwd)} · ${s.state}`, icon: s.kind === 'dashboard' ? MessageSquare : Terminal,
      view: s.kind === 'dashboard' && s.chatId ? { kind: 'chat', chatId: s.chatId, title: s.title } : { kind: 'session', id: s.id } });
    for (const r of snap.repos) for (const w of r.worktrees) out.push({ id: `w:${w.path}`, label: `${r.name} / ${w.branch || shortPath(w.path)}`, hint: shortPath(w.path), icon: GitBranch, view: { kind: 'worktree', path: w.path } });
    for (const c of snap.conversations) if (!c.running && !c.chat) out.push({ id: `c:${c.sessionId}`, label: c.title, hint: `saved · ${c.repo || shortPath(c.cwd)}`, icon: MessageSquare, view: { kind: 'resume', sessionId: c.sessionId, cwd: c.cwd, title: c.title } });
    return out;
  }, [snap]);

  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items.slice(0, 14);
    return items.filter(i => `${i.label} ${i.hint}`.toLowerCase().includes(t)).slice(0, 14);
  }, [items, q]);

  if (!open) return null;
  const pick = (i: Item) => actions.go(i.view);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]" onPointerDown={e => { if (e.target === e.currentTarget) actions.setPalette(false); }}>
      <div className="panel w-[560px] max-w-[94vw] overflow-hidden shadow-[var(--shadow)]" role="dialog" aria-label="Jump to">
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search size={14} className="text-fg-faint" aria-hidden="true" />
          <input ref={input} className="h-10 w-full bg-transparent text-[13px] outline-none" placeholder="Jump to a conversation, worktree, or action" value={q}
            onChange={e => { setQ(e.target.value); setCursor(0); }}
            onKeyDown={e => {
              if (e.key === 'Escape') actions.setPalette(false);
              if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(hits.length - 1, c + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(0, c - 1)); }
              if (e.key === 'Enter' && hits[cursor]) pick(hits[cursor]);
            }} />
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-1">
          {hits.length === 0 && <div className="px-3 py-4 text-[12px] text-fg-faint">Nothing matches. Try a ticket key, a branch, or a repo name.</div>}
          {hits.map((i, idx) => (
            <button key={i.id} className="row h-9" aria-current={idx === cursor ? 'true' : undefined} onMouseEnter={() => setCursor(idx)} onClick={() => pick(i)}>
              <i.icon size={14} className="text-fg-faint" aria-hidden="true" />
              <span className="grow">{i.label}</span>
              <span className="truncate text-[11px] text-fg-faint max-w-[50%]">{i.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
