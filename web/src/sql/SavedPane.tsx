import { useMemo, useState, type MouseEvent as RMouseEvent } from 'react';
import { ChevronRight, ClipboardCopy, Folder, Pencil, Play, Plus, Save, Search, Trash2 } from 'lucide-react';
import type { SqlSaved, SqlSnippet } from '../lib/api';
import { actions } from '../lib/store';
import { useContextMenu } from '../components/ContextMenu';
import { copy } from './copy';

/** The left pane's Saved mode: saved queries by folder, searchable by name, folder, ticket or SQL; and the snippets Tab expands. */
export function SavedPane({ saved, snippets, onOpen, onEdit, onDelete, onSaveCurrent, onEditSnippet, onDeleteSnippet, onInsertSnippet }: {
  saved: SqlSaved[]; snippets: SqlSnippet[];
  onOpen: (s: SqlSaved, run: boolean) => void; onEdit: (s: SqlSaved) => void; onDelete: (s: SqlSaved) => void; onSaveCurrent: () => void;
  onEditSnippet: (s: Partial<SqlSnippet> & { editing?: string }) => void; onDeleteSnippet: (name: string) => void; onInsertSnippet: (s: SqlSnippet) => void;
}) {
  const [part, setPart] = useState<'queries' | 'snippets'>('queries');
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [menu, openMenu] = useContextMenu();
  const folders = useMemo(() => {
    const t = q.trim().toLowerCase();
    const hits = saved.filter(s => !t || [s.name, s.folder, s.jira || '', s.sql].some(x => x.toLowerCase().includes(t)));
    const by = new Map<string, SqlSaved[]>();
    for (const s of hits.sort((a, b) => a.name.localeCompare(b.name))) by.set(s.folder, [...(by.get(s.folder) || []), s]);
    return [...by.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  }, [saved, q]);
  const snips = useMemo(() => { const t = q.trim().toLowerCase(); return snippets.filter(s => !t || s.name.includes(t) || s.label.toLowerCase().includes(t) || s.body.toLowerCase().includes(t)); }, [snippets, q]);

  const itemMenu = (e: RMouseEvent, s: SqlSaved) => openMenu(e, [
    { label: 'Open in a new tab', onSelect: () => onOpen(s, false) },
    { label: 'Open and run', icon: Play, onSelect: () => onOpen(s, true) },
    'separator',
    { label: 'Edit name, folder, ticket…', icon: Pencil, onSelect: () => onEdit(s) },
    { label: 'Copy SQL', icon: ClipboardCopy, onSelect: async () => { await copy(s.sql); actions.toast('Copied'); } },
    'separator',
    { label: 'Delete', icon: Trash2, danger: true, onSelect: () => { if (confirm(`Delete the saved query "${s.name}"?`)) onDelete(s); } },
  ]);
  const snipMenu = (e: RMouseEvent, s: SqlSnippet) => openMenu(e, [
    { label: 'Insert', onSelect: () => onInsertSnippet(s) },
    { label: s.source === 'user' ? 'Edit' : 'Customize (saves your own copy)', icon: Pencil, onSelect: () => onEditSnippet(s.source === 'user' ? { ...s, editing: s.name } : { ...s }) },
    ...(s.source === 'user' ? ['separator' as const, { label: 'Delete', icon: Trash2, danger: true, onSelect: () => { if (confirm(`Delete the snippet "${s.name}"?`)) onDeleteSnippet(s.name); } }] : []),
  ]);

  return (
    <>
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <div className="sql-seg flex-none" role="tablist" aria-label="Saved">
          <button role="tab" aria-selected={part === 'queries'} onClick={() => setPart('queries')}>Queries</button>
          <button role="tab" aria-selected={part === 'snippets'} onClick={() => setPart('snippets')}>Snippets</button>
        </div>
        <div className="sql-search min-w-0 flex-1">
          <Search size={12} aria-hidden="true" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={part === 'queries' ? 'Name, folder, ticket, SQL' : 'Find a snippet'} aria-label="Search saved" />
        </div>
      </div>
      {part === 'queries' && <div className="sql-tree">
        <div className="px-2 pb-2"><button className="btn sm w-full" onClick={onSaveCurrent} title="Save this tab's SQL (Ctrl+S)"><Save size={12} aria-hidden="true" /> Save this tab · Ctrl+S</button></div>
        {!saved.length && <div className="p-3 text-[12px] text-fg-faint">Queries you save show up here, by folder. Give one a Jira key and it shows on that ticket's card.</div>}
        {saved.length > 0 && !folders.length && <div className="p-3 text-[12px] text-fg-faint">Nothing matches.</div>}
        {folders.map(([folder, items]) => {
          const shut = closed[folder] && !q.trim();
          return (
            <div key={folder || '-'}>
              <button className="sql-node" style={{ paddingLeft: 6 }} onClick={() => setClosed(c => ({ ...c, [folder]: !c[folder] }))} aria-expanded={!shut}>
                <ChevronRight size={12} className={`sql-chev ${shut ? '' : 'open'}`} aria-hidden="true" />
                <Folder size={13} className="text-fg-faint" aria-hidden="true" />
                <span className="grow truncate">{folder || 'No folder'}</span><span className="sql-count">{items.length}</span>
              </button>
              {!shut && items.map(s => (
                <button key={s.id} className="sql-hit" style={{ paddingLeft: 26 }} onClick={() => onOpen(s, false)} onContextMenu={e => itemMenu(e, s)}
                  title={`${s.sql.slice(0, 600)}\n\nClick to open; right-click for more`}>
                  <span className="flex min-w-0 items-center gap-1.5 font-sans text-[12px]"><span className="grow truncate">{s.name}</span>{s.jira && <span className="chip ticket flex-none" style={{ height: 16, fontSize: 10 }}>{s.jira}</span>}</span>
                  <span className="truncate text-fg-faint">{s.alias ? `${s.alias} · ` : ''}{s.sql.replace(/\s+/g, ' ').slice(0, 80)}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>}
      {part === 'snippets' && <div className="sql-tree">
        <div className="px-2 pb-2"><button className="btn sm w-full" onClick={() => onEditSnippet({})}><Plus size={12} aria-hidden="true" /> New snippet</button></div>
        <p className="mb-2 px-3 text-[11.5px] text-fg-faint">Type the name in the editor and press Tab. Tab moves through the ${'{'}fields{'}'}; Esc leaves them.</p>
        {snips.map(s => (
          <button key={s.name} className="sql-hit" onClick={e => snipMenu(e, s)} onContextMenu={e => snipMenu(e, s)} onDoubleClick={() => onInsertSnippet(s)} title={s.body}>
            <span className="flex min-w-0 items-center gap-1.5"><span className="flex-none font-semibold">{s.name}</span><span className="truncate font-sans text-[11.5px] text-fg-muted">{s.label}</span>
              {s.source === 'user' && <span className="ml-auto flex-none text-[10px] text-fg-faint">yours</span>}</span>
          </button>
        ))}
      </div>}
      {menu}
    </>
  );
}
