import { useEffect, useState } from 'react';
import { Anchor, KeyRound, LayoutGrid, Moon, PanelLeft, PanelLeftClose, Search, Sun, SunMoon } from 'lucide-react';
import { actions, useStore } from '../lib/store';
import { Kbd } from './ui';

export function TitleBar() {
  const collapsed = useStore(s => s.sidebarCollapsed);
  const theme = useStore(s => s.theme);
  const view = useStore(s => s.view);
  const live = useStore(s => s.live);
  // Which instance this page talks to. The daily one is 7777; anything else is a dev copy and says so.
  const [port, setPort] = useState<number | null>(null);
  useEffect(() => { fetch('/api/config').then(r => r.json()).then(c => { setPort(c.port); if (c.port !== 7777) document.title = `Fleet dev ${c.port}`; }).catch(() => {}); }, []);
  const SidebarIcon = collapsed ? PanelLeft : PanelLeftClose;
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : SunMoon;
  const nextTheme = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';

  return (
    <header className="flex items-center gap-2 border-b border-line bg-surface px-3">
      <button className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-hover" onClick={() => actions.go({ kind: 'overview' })} title="Overview">
        <Anchor size={16} className="text-accent" aria-hidden="true" />
        <span className="text-[14px] font-semibold tracking-tight">Fleet</span>
        <span className={`dot ${live ? '' : ''}`} data-s={live ? 'done' : 'failed'} title={live ? 'connected' : 'reconnecting'} />
      </button>
      {port != null && port !== 7777 && <span className="chip warn num" title={`This page talks to the dev API on port ${port}, not the daily instance on 7777`}>dev {port}</span>}
      <button className="iconbtn" aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'} title="Ctrl+B" onClick={actions.toggleSidebar}>
        <SidebarIcon size={16} aria-hidden="true" />
      </button>

      <button className="mx-auto flex h-7 w-full max-w-md items-center gap-2 rounded-full border border-line bg-bg px-3 text-[12px] text-fg-muted hover:border-line-strong" onClick={() => actions.setPalette(true)}>
        <Search size={13} aria-hidden="true" />
        <span className="flex-1 truncate text-left">Jump to a conversation, worktree, or action</span>
        <Kbd>Ctrl</Kbd><Kbd>K</Kbd>
      </button>

      <nav className="flex items-center gap-1">
        <button className={`btn sm ghost ${view.kind === 'overview' ? 'text-fg' : ''}`} onClick={() => actions.go({ kind: 'overview' })}><LayoutGrid size={14} aria-hidden="true" /> Overview</button>
        <button className={`btn sm ghost ${view.kind === 'hub' ? 'text-fg' : ''}`} onClick={() => actions.go({ kind: 'hub' })}><KeyRound size={14} aria-hidden="true" /> Hub</button>
        <button className="iconbtn" aria-label={`Theme: ${theme}. Switch to ${nextTheme}`} title={`Theme: ${theme}`} onClick={() => actions.setTheme(nextTheme)}>
          <ThemeIcon size={16} aria-hidden="true" />
        </button>
      </nav>
    </header>
  );
}
