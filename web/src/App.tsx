import { useEffect } from 'react';
import { subscribe } from './lib/api';
import { actions, tabKey, useStore } from './lib/store';
import { POPOUT, forget, listen } from './lib/popout';
import { PopoutHeader } from './components/PopoutHeader';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { Main } from './components/Main';
import { StatusStrip } from './components/StatusStrip';
import { CommandPalette } from './components/CommandPalette';
import { Toast } from './components/ui';
import { Notifier } from './components/Notifier';
import { modKey, MOD } from './lib/platform';
import { ChevronRight } from 'lucide-react';

export function App() {
  const collapsed = useStore(s => s.sidebarCollapsed);

  useEffect(() => subscribe('/api/events', actions.setSnapshot, actions.setLive), []);

  // Popped-out windows: views they hand to the main window, views the main window sends to them, and tabs popped back in.
  useEffect(() => listen(m => {
    if (POPOUT) { if (m.t === 'go' && m.to === tabKey(POPOUT)) { actions.go(m.view); window.focus(); } return; }
    if (m.t === 'popin') forget(tabKey(m.view));
    if (m.t === 'popin' || (m.t === 'go' && !m.to)) { actions.go(m.view); window.focus(); }
  }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Cmd on a Mac, where Ctrl+K and Ctrl+B are the shell's. A key a terminal already handled (Cmd+K clears it) is left alone.
      if (e.defaultPrevented || !modKey(e)) return;
      if (e.key.toLowerCase() === 'k') { e.preventDefault(); actions.setPalette(true); }
      if (e.key.toLowerCase() === 'b') { e.preventDefault(); actions.toggleSidebar(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A popped-out window: the one view under a slim header, no sidebar, tab strip or status strip.
  if (POPOUT) return (
    <div className="grid h-full grid-rows-[36px_1fr] bg-bg text-fg">
      <PopoutHeader view={POPOUT} />
      <div className="grid min-h-0"><Main /></div>
      <CommandPalette />
      <Toast />
    </div>
  );

  return (
    <div className="grid h-full grid-rows-[44px_1fr_28px] bg-bg text-fg">
      <TitleBar />
      <div className="grid min-h-0" style={{ gridTemplateColumns: collapsed ? '1fr' : 'auto 1fr' }}>
        {!collapsed && <Sidebar />}
        <div className="relative grid min-h-0 min-w-0">
          <Main />
          {collapsed && <button className="sidebar-edge collapsed" style={{ left: 0, right: 'auto', borderRadius: '0 8px 8px 0' }} aria-label="Show sidebar" title={`Show sidebar (${MOD}B)`} onClick={actions.toggleSidebar}><ChevronRight size={14} aria-hidden="true" /></button>}
        </div>
      </div>
      <StatusStrip />
      <CommandPalette />
      <Toast />
      <Notifier />
    </div>
  );
}
