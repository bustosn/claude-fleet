import { Plus, Terminal, X } from 'lucide-react';
import { api } from '../lib/api';
import { shortPath } from '../lib/format';
import { actions, tabKey, useStore } from '../lib/store';
import { openTerminal } from '../lib/terminal';

/** Sidebar section: every shell Fleet is running, including ones whose tab was closed. */
export function TerminalList() {
  const terms = useStore(s => s.snapshot?.terminals || []);
  const view = useStore(s => s.view);
  const active = view.kind === 'terminal' ? view.id : null;
  const kill = (id: string) => api.closeTerminal(id).then(() => actions.closeTab(tabKey({ kind: 'terminal', id }))).catch(e => actions.toast(e.message, 'error'));
  return (
    <section className="mt-3">
      <div className="section-title">Terminals <span className="count num">{terms.length}</span>
        <button className="iconbtn" style={{ width: 20, height: 20 }} title="New terminal" aria-label="New terminal" onClick={() => openTerminal()}><Plus size={12} aria-hidden="true" /></button>
      </div>
      {terms.length === 0 && <div className="px-2 pb-1 text-[11px] text-fg-faint">No shells open. The terminal button on the tab strip starts one in the folder you are looking at.</div>}
      {terms.map(t => (
        <div key={t.id} className={`row group ${active === t.id ? 'bg-selected' : ''}`} role="button" tabIndex={0}
          onClick={() => actions.go({ kind: 'terminal', id: t.id })} onKeyDown={e => { if (e.key === 'Enter') actions.go({ kind: 'terminal', id: t.id }); }}>
          {t.exitCode == null ? <Terminal size={13} className="shrink-0 text-fg-faint" aria-hidden="true" /> : <span className="dot shrink-0" data-s="ended" aria-hidden="true" />}
          <span className="min-w-0 grow">
            <span className="block truncate text-fg">{t.title}</span>
            <span className="block truncate text-[11px] text-fg-faint">{shortPath(t.cwd)}{t.exitCode != null ? ` · exited ${t.exitCode}` : ''}</span>
          </span>
          <button className="iconbtn shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100" style={{ width: 20, height: 20 }} aria-label={`Kill ${t.title}`} title="Kill" onClick={e => { e.stopPropagation(); kill(t.id); }}><X size={12} aria-hidden="true" /></button>
        </div>
      ))}
    </section>
  );
}
