import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { shortPath, stateLabel } from '../lib/format';
import { actions, useStore } from '../lib/store';

/** Status dot with its label beside it, so state is never color alone. */
export function Status({ state, label, className = '' }: { state: string; label?: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] text-fg-muted ${className}`}>
      <span className="dot" data-s={state} aria-hidden="true" />
      <span>{label ?? stateLabel[state] ?? state}</span>
    </span>
  );
}

/** Moves a session under a repo when the automatic placement is wrong. Pins persist on the server. */
export function WorktreePicker({ sessionId, worktree, locatedBy }: { sessionId: string; worktree: string | null; locatedBy: string | null }) {
  const snap = useStore(s => s.snapshot);
  const options = (snap?.repos || []).flatMap(r => r.worktrees.map(w => ({ path: w.path, label: w.isMain ? r.name : `${r.name} / ${w.branch || shortPath(w.path)}` })));
  const current = options.find(o => o.path.toLowerCase() === (worktree || '').toLowerCase())?.path || '';
  const change = async (next: string) => {
    try { await api.setHome(sessionId, next || null); actions.toast(next ? 'Moved' : 'Pin cleared'); } catch (err: any) { actions.toast(err.message, 'error'); }
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <select className="input h-6 py-0 text-[11px]" value={current} onChange={e => change(e.target.value)} aria-label="Project for this session">
        <option value="">Not in a repo</option>
        {options.map(o => <option key={o.path} value={o.path}>{o.label}</option>)}
      </select>
      {locatedBy && locatedBy !== 'cwd' && <span className="text-[11px] text-fg-faint" title={locatedBy === 'pinned' ? 'You placed it here' : `Guessed from its ${locatedBy === 'ticket' ? 'ticket key' : locatedBy === 'title' ? 'title' : 'transcript'}; pick another to pin it`}>{locatedBy === 'pinned' ? 'pinned' : `guessed from ${locatedBy}`}</span>}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) { return <span className="kbd">{children}</span>; }

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="m-auto max-w-sm p-8 text-center">
      <div className="text-[13px] font-semibold">{title}</div>
      {children && <div className="mt-1 text-[12px] text-fg-muted">{children}</div>}
    </div>
  );
}

export function Toast() {
  const toast = useStore(s => s.toast);
  if (!toast) return null;
  return (
    <div role="status" className={`fixed bottom-10 left-1/2 z-50 -translate-x-1/2 rounded-md border px-3 py-2 text-[12px] shadow-[var(--shadow)] ${toast.level === 'error' ? 'border-crit bg-crit-soft text-fg' : 'border-line bg-surface text-fg'}`}>
      {toast.text}
    </div>
  );
}
