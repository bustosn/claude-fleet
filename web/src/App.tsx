import { useEffect } from 'react';
import { subscribe } from './lib/api';
import { actions, useStore } from './lib/store';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { Main } from './components/Main';
import { StatusStrip } from './components/StatusStrip';
import { CommandPalette } from './components/CommandPalette';
import { Toast } from './components/ui';

export function App() {
  const collapsed = useStore(s => s.sidebarCollapsed);

  useEffect(() => subscribe('/api/events', actions.setSnapshot, actions.setLive), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); actions.setPalette(true); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); actions.toggleSidebar(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="grid h-full grid-rows-[44px_1fr_28px] bg-bg text-fg">
      <TitleBar />
      <div className="grid min-h-0" style={{ gridTemplateColumns: collapsed ? '1fr' : 'auto 1fr' }}>
        {!collapsed && <Sidebar />}
        <Main />
      </div>
      <StatusStrip />
      <CommandPalette />
      <Toast />
    </div>
  );
}
