import { useSyncExternalStore } from 'react';
import type { Snapshot } from './api';
import { POPOUT, poppedWindow, post } from './popout';

export type View =
  | { kind: 'overview' }
  | { kind: 'chat'; chatId: string; title?: string }
  | { kind: 'resume'; sessionId: string; cwd: string; title: string }
  | { kind: 'new-chat'; cwd?: string }
  | { kind: 'worktree'; path: string }
  | { kind: 'session'; id: string }
  | { kind: 'terminal'; id: string }
  | { kind: 'dialogue'; id: string }
  | { kind: 'new-dialogue' }
  | { kind: 'new-task'; cwd?: string; ticket?: string }
  | { kind: 'jira'; create?: boolean }
  /** The SQL workbench. `lookup` opens a new query tab already run, like "cb 123456" from the palette; `at` makes each one distinct. */
  | { kind: 'sql'; lookup?: { name: string; value: string; at: number } }
  | { kind: 'hub' }
  | { kind: 'usage' };

/** Open views, like editor tabs. Overview and the pages (see `isPage`) are never tabs. */
export interface Tab { key: string; view: View }

/** The views behind the title bar buttons. They open in place of the current view without adding a tab. */
const PAGES = ['jira', 'sql', 'hub', 'usage'] as const;
export const isPage = (v: View) => (PAGES as readonly string[]).includes(v.kind);

export type Theme = 'system' | 'light' | 'dark';

interface State {
  snapshot: Snapshot | null; live: boolean; view: View; tabs: Tab[]; theme: Theme;
  sidebarWidth: number; sidebarCollapsed: boolean; paletteOpen: boolean;
  openRepos: Record<string, boolean>; openSections: Record<string, boolean>; convoFilter: string; toast: { id: number; text: string; level: 'info' | 'error' } | null;
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
    case 'terminal': return `terminal:${v.id}`;
    case 'dialogue': return `dialogue:${v.id}`;
    case 'new-dialogue': return 'new-dialogue';
    case 'new-task': return 'new-task';
    case 'hub': return 'hub';
    case 'jira': return 'jira';
    case 'sql': return 'sql';
    case 'usage': return 'usage';
  }
}

// A popped-out window holds its one view and leaves the main window's saved tabs alone.
// Pages that older versions saved as tabs are dropped.
const savedTabs = POPOUT ? [{ key: tabKey(POPOUT), view: POPOUT }] : read<Tab[]>('fleet.tabs', []).filter(t => t && t.view && t.key === tabKey(t.view) && !isPage(t.view));
const savedActive = read<string | null>('fleet.tabs.active', null);
const savedPage = (PAGES as readonly string[]).includes(savedActive || '') ? { kind: savedActive } as View : null;

let state: State = {
  snapshot: null, live: false,
  tabs: savedTabs, view: POPOUT || savedPage || savedTabs.find(t => t.key === savedActive)?.view || { kind: 'overview' },
  theme: read<Theme>('fleet.theme.mode', 'system'),
  sidebarWidth: read('fleet.sidebar.width', 300), sidebarCollapsed: read('fleet.sidebar.collapsed', false), paletteOpen: false,
  // Repos and sidebar sections start collapsed; only what you open stays open.
  openRepos: read('fleet.repos.open', {}), openSections: read('fleet.sections.open', {}), convoFilter: '', toast: null,
};
const listeners = new Set<() => void>();
function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  for (const l of listeners) l();
}
export const useStore = <T,>(sel: (s: State) => T): T => useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l); }, () => sel(state), () => sel(state));
export const getState = () => state;

function persistTabs(tabs: Tab[], view: View) { if (POPOUT) return; write('fleet.tabs', tabs); write('fleet.tabs.active', view.kind === 'overview' ? null : tabKey(view)); }

export const actions = {
  setSnapshot: (snapshot: Snapshot) => set({ snapshot }),
  setLive: (live: boolean) => set({ live }),
  /** Opens a view in its tab, creating the tab if needed. `replace` swaps an existing tab in place (resume → chat). */
  go: (view: View, opts: { replace?: string } = {}) => set(s => {
    // In a popped-out window, any other view opens in the main window.
    if (POPOUT && (view.kind === 'overview' || tabKey(view) !== tabKey(POPOUT))) { post({ t: 'go', view }); return { paletteOpen: false }; }
    if (view.kind === 'overview' || isPage(view)) { persistTabs(s.tabs, view); return { view, paletteOpen: false }; }
    const key = tabKey(view);
    // A view that lives in a popped-out window goes there (a SQL lookup runs in the popped-out SQL view), and that window comes to the front.
    const popped = POPOUT ? null : poppedWindow(key);
    if (popped) { post({ t: 'go', view, to: key }); popped.focus(); return { paletteOpen: false }; }
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
  /** Drags a tab to just before or after another. */
  moveTab: (key: string, target: string, after: boolean) => set(s => {
    const from = s.tabs.findIndex(t => t.key === key);
    if (from < 0 || key === target) return {};
    const moving = s.tabs[from], rest = s.tabs.filter(t => t.key !== key);
    const at = rest.findIndex(t => t.key === target);
    if (at < 0) return {};
    const tabs = [...rest.slice(0, at + (after ? 1 : 0)), moving, ...rest.slice(at + (after ? 1 : 0))];
    if (tabs.every((t, i) => t === s.tabs[i])) return {};
    persistTabs(tabs, s.view);
    return { tabs };
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
  toggleRepo: (name: string) => set(s => { const openRepos = { ...s.openRepos, [name]: !s.openRepos[name] }; write('fleet.repos.open', openRepos); return { openRepos }; }),
  toggleSection: (name: string) => set(s => { const openSections = { ...s.openSections, [name]: !s.openSections[name] }; write('fleet.sections.open', openSections); return { openSections }; }),
  setConvoFilter: (convoFilter: string) => set({ convoFilter }),
  toast: (text: string, level: 'info' | 'error' = 'info') => {
    const id = Date.now();
    set({ toast: { id, text, level } });
    setTimeout(() => set(s => (s.toast?.id === id ? { toast: null } : {})), level === 'error' ? 8000 : 4000);
  },
};
