import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Search, X } from 'lucide-react';
import type { SQLNamespace } from '@codemirror/lang-sql';
import { api, type SqlAlias, type SqlLookup } from '../lib/api';
import { actions } from '../lib/store';
import { SqlEditor, type EditorHandle } from './SqlEditor';
import { columnCompletion } from './columnCompletion';
import type { SqlColumnInfo } from '../lib/api';

/** Makes or edits a lookup: the palette word, the SQL with ? where the value goes (joins welcome, completion included), where it runs, and how it shows. */
export function LookupEditor({ initial, aliases, schema, columnsFor, onClose, onSaved }: {
  initial: Partial<SqlLookup> & { editing?: string }; aliases: SqlAlias[]; schema: SQLNamespace;
  columnsFor: (alias: string, db: string, table: string) => Promise<SqlColumnInfo[]>;
  onClose: () => void; onSaved: (lookups: SqlLookup[]) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const editor = useRef<EditorHandle>(null);
  const [name, setName] = useState(initial.name || '');
  const [label, setLabel] = useState(initial.label || '');
  const [alias, setAlias] = useState(initial.alias || aliases[0]?.alias || '');
  const [type, setType] = useState<'text' | 'number'>(initial.type || (initial.pattern?.includes('\\d') ? 'number' : 'text'));
  const [view, setView] = useState<'record' | 'grid'>(initial.view || 'grid');
  const [sql, setSql] = useState(initial.sql || '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { ref.current?.showModal(); }, []);
  const params = (sql.match(/\?/g) || []).length;

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const all = await api.sqlSaveLookup(name.trim().toLowerCase(), { label, alias, type, view, sql, rename: initial.editing && initial.editing !== name.trim().toLowerCase() ? initial.editing : undefined });
      actions.toast(`Saved. Ctrl+K, then "${name.trim().toLowerCase()} <value>"`);
      onSaved(all);
      ref.current?.close();
    } catch (err: any) { actions.toast(err.message, 'error'); setBusy(false); }
  };

  return (
    <dialog ref={ref} className="w-[min(860px,96vw)]" onClose={onClose}>
      <form onSubmit={save}>
        <div className="mb-3 flex items-center gap-2">
          <Search size={15} className="text-accent" aria-hidden="true" />
          <h2 className="!m-0">{initial.editing ? `Edit lookup ${initial.editing}` : 'New lookup'}</h2>
          <span className="grow" />
          <button type="button" className="iconbtn" aria-label="Close" onClick={() => ref.current?.close()}><X size={15} /></button>
        </div>
        <div className="grid grid-cols-[140px_1fr] gap-x-3">
          <label>Name (what you type)
            <input className="input mono" value={name} onChange={e => setName(e.target.value.replace(/\s/g, ''))} placeholder="client" autoFocus={!initial.editing} spellCheck={false} />
          </label>
          <label>Label
            <input className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder="Client by id, with its MIDs and parsers" />
          </label>
        </div>
        <div className="grid grid-cols-3 gap-x-3">
          <label>Connection
            <select className="input" value={alias} onChange={e => setAlias(e.target.value)}>
              {aliases.map(a => <option key={a.alias} value={a.alias}>{a.alias}{a.prod ? ' (PRD)' : ''}</option>)}
            </select>
          </label>
          <label>The value is
            <select className="input" value={type} onChange={e => setType(e.target.value as 'text' | 'number')}>
              <option value="text">text (case_no, ARN)</option>
              <option value="number">number (ids)</option>
            </select>
          </label>
          <label>Show as
            <select className="input" value={view} onChange={e => setView(e.target.value as 'record' | 'grid')}>
              <option value="record">record (field by field)</option>
              <option value="grid">grid</option>
            </select>
          </label>
        </div>
        <div className="mb-1 flex items-baseline gap-2 text-[12px] text-fg-muted">
          <span>SQL</span>
          <span className="text-[11px] text-fg-faint">Put <b className="mono text-fg">?</b> where the value goes; every ? gets it, so a join can use it twice. Read-only, one statement.</span>
          <span className="grow" />
          <span className={`flex-none whitespace-nowrap text-[11px] ${params ? 'text-good' : 'text-warn'}`}>{params ? `${params} × ?` : 'no ? yet'}</span>
        </div>
        <div className="mb-4 h-[300px] overflow-hidden rounded-lg border border-line-strong">
          <SqlEditor ref={editor} value={sql} onChange={setSql} schema={schema} defaultSchema={undefined}
            onRun={() => save()} onFormat={async () => { const { format } = await import('sql-formatter'); try { editor.current?.replaceAll(format(sql.replace(/\?/g, '__P__'), { language: 'mysql', keywordCase: 'upper', tabWidth: 2 }).replace(/__P__/g, '?')); } catch {} }} onExplain={() => {}}
            columns={columnCompletion((db, table) => columnsFor(alias, db, table), () => null)} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-fg-faint">Ctrl+Shift+F formats. Ctrl+Enter saves.</span>
          <span className="grow" />
          <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim() || !sql.trim()}>{busy ? 'Saving…' : 'Save lookup'}</button>
        </div>
      </form>
    </dialog>
  );
}
