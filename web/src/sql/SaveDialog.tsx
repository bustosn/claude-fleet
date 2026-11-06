import { useEffect, useRef, useState } from 'react';
import { api, type SqlAlias, type SqlSaved, type SqlSnippet } from '../lib/api';

/** Saves a tab's SQL, or edits a saved query's name, folder, ticket and connection. Enter saves. */
export function SaveDialog({ initial, folders, aliases, onClose, onSaved }: {
  initial: Partial<SqlSaved> & { sql: string }; folders: string[]; aliases: SqlAlias[];
  onClose: () => void; onSaved: (all: SqlSaved[], id: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [v, setV] = useState({ name: initial.name || '', folder: initial.folder || '', jira: initial.jira || '', alias: initial.alias || '', sql: initial.sql });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { ref.current?.showModal(); }, []);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const all = await api.sqlSaveQuery(initial.id || 'new', { ...v, db: initial.db ?? null, alias: v.alias || null });
      const id = initial.id || all.reduce((a, b) => (b.created > a.created ? b : a)).id;
      onSaved(all, id); ref.current?.close();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <dialog ref={ref} className="w-[min(600px,94vw)]" onClose={onClose}>
      <h2>{initial.id ? 'Saved query' : 'Save this query'}</h2>
      <form className="sql-params" onSubmit={e => { e.preventDefault(); save(); }}>
        <label htmlFor="sv-name" className="text-[12px]">Name</label>
        <input id="sv-name" className="input h-8" autoFocus value={v.name} onChange={e => setV({ ...v, name: e.target.value })} placeholder="Transport issues for a client" />
        <label htmlFor="sv-folder" className="text-[12px]">Folder</label>
        <input id="sv-folder" className="input h-8" list="sv-folders" value={v.folder} onChange={e => setV({ ...v, folder: e.target.value })} placeholder="none" />
        <datalist id="sv-folders">{folders.filter(Boolean).map(f => <option key={f} value={f} />)}</datalist>
        <label htmlFor="sv-jira" className="text-[12px]">Jira key</label>
        <input id="sv-jira" className="input mono h-8" value={v.jira} onChange={e => setV({ ...v, jira: e.target.value.toUpperCase() })} placeholder="JL-7705 (shows on the ticket's card)" />
        <label htmlFor="sv-alias" className="text-[12px]">Connection</label>
        <select id="sv-alias" className="input h-8" value={v.alias} onChange={e => setV({ ...v, alias: e.target.value })}>
          <option value="">the tab's, when opened</option>
          {aliases.map(a => <option key={a.alias} value={a.alias}>{a.alias}{a.prod ? ' (PRD)' : ''}</option>)}
        </select>
        <pre className="sql-pre col-span-2 max-h-[160px] overflow-auto rounded-lg border border-line bg-raised !py-2 text-[11.5px]">{v.sql}</pre>
        {err && <div className="col-span-2 rounded-md border border-crit bg-crit-soft p-2 text-[12px]">{err}</div>}
        <div className="col-span-2 flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </dialog>
  );
}

/** A snippet: the word that expands it, a label, and the body with ${field} placeholders. */
export function SnippetEditor({ initial, onClose, onSaved }: { initial: Partial<SqlSnippet> & { editing?: string }; onClose: () => void; onSaved: (all: SqlSnippet[]) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [v, setV] = useState({ name: initial.name || '', label: initial.label || '', body: initial.body || '' });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const save = async () => {
    try { onSaved(await api.sqlSaveSnippet(v.name, { ...v, rename: initial.editing && initial.editing !== v.name ? initial.editing : undefined })); ref.current?.close(); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <dialog ref={ref} className="w-[min(680px,94vw)]" onClose={onClose}>
      <h2>{initial.editing ? `Snippet ${initial.editing}` : initial.name ? `Your copy of ${initial.name}` : 'New snippet'}</h2>
      <form className="sql-params" onSubmit={e => { e.preventDefault(); save(); }}>
        <label htmlFor="sn-name" className="text-[12px]">Name</label>
        <input id="sn-name" className="input mono h-8" autoFocus value={v.name} onChange={e => setV({ ...v, name: e.target.value.toLowerCase() })} placeholder="cbj (type it, then Tab)" />
        <label htmlFor="sn-label" className="text-[12px]">Label</label>
        <input id="sn-label" className="input h-8" value={v.label} onChange={e => setV({ ...v, label: e.target.value })} placeholder="What it is, in the completion list" />
        <label htmlFor="sn-body" className="self-start pt-1 text-[12px]">Body</label>
        <textarea id="sn-body" className="input mono min-h-[220px] py-1.5 text-[12px]" value={v.body} onChange={e => setV({ ...v, body: e.target.value })}
          onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); } }} placeholder={'SELECT *\nFROM ${table}\nWHERE ${condition}'} />
        <div className="col-span-2 text-[11px] text-fg-faint">{'${name}'} marks a field to fill; fields with the same name are filled together. Ctrl+Enter saves.</div>
        {err && <div className="col-span-2 rounded-md border border-crit bg-crit-soft p-2 text-[12px]">{err}</div>}
        <div className="col-span-2 flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
          <button type="submit" className="btn primary">Save</button>
        </div>
      </form>
    </dialog>
  );
}
