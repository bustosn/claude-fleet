import { useSyncExternalStore } from 'react';
import type { Snapshot } from './api';

export type View =
  | { kind: 'overview' }
  | { kind: 'chat'; chatId: string; title?: string }
  | { kind: 'resume'; sessionId: string; cwd: string; title: string }
  | { kind: 'new-chat'; cwd?: string }
  | { kind: 'worktree'; path: string }
  | { kind: 'session'; id: string }
  | { kind: 'hub' };

/** Open views, like editor tabs. Overview is the home screen and never a tab. */
export interface Tab { key: string; view: View }

export type Theme = 'system' | 'light' | 'dark';

interface State {
  snapshot: Snapshot | null; live: boolean; view: View; tabs: Tab[]; theme: Theme;
  sidebarWidth: number; sidebarCollapsed: boolean; paletteOpen: boolean;
  collapsedRepos: Record<string, boolean>; convoFilter: string; toast: { id: number; text: string; level: 'info' | 'error' } | null;
}

const read = <T,>(k: string, fallback: T): T => { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export function tabKey(v: View): string {
  switch (v.kind) {
    case 'overview': return 'overview';
    case 'chat': return `chat:${v.chatId}`;
    case 'resume': return `resume:${v.sessionId}`;
    case 'new-chat': return 'new-chat';
    case 'worktree': return `wt:${v.path.toLowerCase()}`;
    case 'session': return `session:${v.id}`;
    case 'hub': return 'hub';
  }
}

const savedTabs = read<Tab[]>('fleet.tabs', []).filter(t => t && t.view && t.key === tabKey(t.view));
const savedActive = read<string | null>('fleet.tabs.active', null);

let state: State = {
  snapshot: null, live: false,
  tabs: savedTabs, view: savedTabs.find(t => t.key === savedActive)?.view || { kind: 'overview' },
  theme: read<Theme>('fleet.theme.mode', 'system'),
  sidebarWidth: read('fleet.sidebar.width', 300), sidebarCollapsed: read('fleet.sidebar.collapsed', false), paletteOpen: false,
  collapsedRepos: read('fleet.repos.collapsed', {}), convoFilter: '', toast: null,
};
const listeners = new Set<() => void>();
function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  for (const l of listeners) l();
}
export const useStore = <T,>(sel: (s: State) => T): T => useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l); }, () => sel(state), () => sel(state));
export const getState = () => state;

function persistTabs(tabs: Tab[], view: View) { write('fleet.tabs', tabs); write('fleet.tabs.active', view.kind === 'overview' ? null : tabKey(view)); }

export const actions = {
  setSnapshot: (snapshot: Snapshot) => set({ snapshot }),
  setLive: (live: boolean) => set({ live }),
  /** Opens a view in its tab, creating the tab if needed. `replace` swaps an existing tab in place (resume → chat). */
  go: (view: View, opts: { replace?: string } = {}) => set(s => {
    if (view.kind === 'overview') { persistTabs(s.tabs, view); return { view, paletteOpen: false }; }
    const key = tabKey(view);
    let tabs = s.tabs;
    const at = tabs.findIndex(t => t.key === key);
    const replaceAt = opts.replace ? tabs.findIndex(t => t.key === opts.replace) : -1;
    if (at >= 0) { tabs = tabs.map((t, i) => i === at ? { key, view } : t); if (replaceAt >= 0 && replaceAt !== at) tabs = tabs.filter((_, i) => i !== replaceAt); }
    else if (replaceAt >= 0) tabs = tabs.map((t, i) => i === replaceAt ? { key, view } : t);
    else tabs = [...tabs, { key, view }];
    persistTabs(tabs, view);
    return { view, tabs, paletteOpen: false };
  }),
  closeTab: (key: string) => set(s => {
    const i = s.tabs.findIndex(t => t.key === key);
    if (i < 0) return {};
    const tabs = s.tabs.filter(t => t.key !== key);
    let view = s.view;
    if (s.view.kind !== 'overview' && tabKey(s.view) === key) view = (tabs[i] || tabs[i - 1])?.view || { kind: 'overview' };
    persistTabs(tabs, view);
    return { tabs, view };
  }),
  closeOtherTabs: (key: string) => set(s => { const tabs = s.tabs.filter(t => t.key === key); const view = tabs[0]?.view || { kind: 'overview' as const }; persistTabs(tabs, view); return { tabs, view }; }),
  setTheme: (theme: Theme) => {
    write('fleet.theme.mode', theme);
    if (theme === 'system') { delete document.documentElement.dataset.theme; try { localStorage.removeItem('fleet.theme'); } catch {} }
    else { document.documentElement.dataset.theme = theme; try { localStorage.setItem('fleet.theme', theme); } catch {} }
    set({ theme });
  },
  setSidebarWidth: (w: number) => { const width = Math.min(480, Math.max(220, Math.round(w))); write('fleet.sidebar.width', width); set({ sidebarWidth: width }); },
  toggleSidebar: () => set(s => { write('fleet.sidebar.collapsed', !s.sidebarCollapsed); return { sidebarCollapsed: !s.sidebarCollapsed }; }),
  setPalette: (paletteOpen: boolean) => set({ paletteOpen }),
  toggleRepo: (name: string) => set(s => { const collapsedRepos = { ...s.collapsedRepos, [name]: !s.collapsedRepos[name] }; write('fleet.repos.collapsed', collapsedRepos); return { collapsedRepos }; }),
  setConvoFilter: (convoFilter: string) => set({ convoFilter }),
  toast: (text: string, level: 'info' | 'error' = 'info') => {
    const id = Date.now();
    set({ toast: { id, text, level } });
    setTimeout(() => set(s => (s.toast?.id === id ? { toast: null } : {})), level === 'error' ? 8000 : 4000);
  },
};
