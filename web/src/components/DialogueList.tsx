import { Plus, Users, X } from 'lucide-react';
import { api } from '../lib/api';
import { actions, tabKey, useStore } from '../lib/store';
import { Status } from './ui';
import { dialogueDot } from '../views/DialogueView';

/** Sidebar section: every dialogue Fleet knows about, live ones first. Finished ones can be removed here. */
export function DialogueList() {
  // The fallback stays outside the selector: a fresh [] on every read looks like a store change and loops the render.
  const list = useStore(s => s.snapshot?.dialogues) || [];
  const view = useStore(s => s.view);
  const active = view.kind === 'dialogue' ? view.id : null;
  const remove = (id: string) => api.removeDialogue(id).then(() => actions.closeTab(tabKey({ kind: 'dialogue', id }))).catch(e => actions.toast(e.message, 'error'));
  return (
    <section className="mt-3">
      <div className="section-title">Dialogues <span className="count num">{list.length}</span>
        <button className="iconbtn" style={{ width: 20, height: 20 }} title="New dialogue" aria-label="New dialogue" onClick={() => actions.go({ kind: 'new-dialogue' })}><Plus size={12} aria-hidden="true" /></button>
      </div>
      {list.length === 0 && <div className="px-2 pb-1 text-[11px] text-fg-faint">No dialogues. Start one to have two chats talk a topic through while you moderate.</div>}
      {list.map(d => {
        const live = d.status === 'running' || d.status === 'paused';
        return (
          <div key={d.id} className={`row group ${active === d.id ? 'bg-selected' : ''}`} role="button" tabIndex={0}
            onClick={() => actions.go({ kind: 'dialogue', id: d.id })} onKeyDown={e => { if (e.key === 'Enter') actions.go({ kind: 'dialogue', id: d.id }); }}>
            <Users size={13} className="shrink-0 text-fg-faint" aria-hidden="true" />
            <span className="min-w-0 grow">
              <span className="block truncate text-fg" title={d.topic}>{d.topic}</span>
              <span className="block truncate text-[11px] text-fg-faint">{d.participants.map(p => p.name).join(' · ')} · <span className="num">{d.turns}/{d.rounds * 2}</span></span>
            </span>
            <Status state={dialogueDot[d.status]} label={d.status} className="shrink-0" />
            {!live && <button className="iconbtn shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100" style={{ width: 20, height: 20 }} aria-label={`Remove ${d.topic}`} title="Remove" onClick={e => { e.stopPropagation(); remove(d.id); }}><X size={12} aria-hidden="true" /></button>}
          </div>
        );
      })}
    </section>
  );
}
