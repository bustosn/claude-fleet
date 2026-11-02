import { useMemo, useState, type MouseEvent as RMouseEvent } from 'react';
import { ChevronRight, Clock, Copy, Database, Eye, FilePlus2, KeyRound, Pencil, Play, Plus, RefreshCw, Search, Table2, Trash2, Zap } from 'lucide-react';
import { api, type SqlColumnInfo, type SqlHistoryEntry, type SqlIndexInfo, type SqlLookup, type SqlSchema } from '../lib/api';
import { age } from '../lib/format';
import { actions } from '../lib/store';
import { useContextMenu } from '../components/ContextMenu';
import { copy } from './copy';

export type PaneMode = 'schema' | 'history' | 'lookups';

interface Props {
  mode: PaneMode; onMode: (m: PaneMode) => void;
  alias: string; schema: SqlSchema | null; schemaError: string | null; loading: boolean; onRefresh: () => void;
  columns: Record<string, Record<string, SqlColumnInfo[]>>; loadColumns: (db: string) => void;
  history: SqlHistoryEntry[]; lookups: SqlLookup[];
  onInsert: (text: string) => void; onQuery: (sql: string, opts?: { run?: boolean; title?: string; alias?: string; db?: string | null }) => void;
  onLookup: (name: string, value: string) => void;
  /** Opens the lookup editor: a lookup to edit, a copy to start from, or the current query as the SQL. */
  onEditLookup: (l: Partial<SqlLookup> & { editing?: string }) => void; onDeleteLookup: (name: string) => void; currentSql: () => string;
}

export function LeftPane(p: Props) {
  return (
    <div className="sql-left">
      <div className="sql-seg m-2" role="tablist" aria-label="Left pane">
        {(['schema', 'history', 'lookups'] as const).map(m => (
          <button key={m} role="tab" aria-selected={p.mode === m} onClick={() => p.onMode(m)}>{m === 'schema' ? 'Schema' : m === 'history' ? 'History' : 'Lookups'}</button>
        ))}
      </div>
      {p.mode === 'schema' && <SchemaTree {...p} />}
      {p.mode === 'history' && <History history={p.history} alias={p.alias} onQuery={p.onQuery} />}
      {p.mode === 'lookups' && <Lookups lookups={p.lookups} onLookup={p.onLookup} onEdit={p.onEditLookup} onDelete={p.onDeleteLookup} currentSql={p.currentSql} alias={p.alias} />}
    </div>
  );
}

const keyGlyph = (key: string) => key === 'PRI' ? 'primary key' : key === 'UNI' ? 'unique index' : key === 'MUL' ? 'indexed' : '';

function SchemaTree({ alias, schema, schemaError, loading, onRefresh, columns, loadColumns, onInsert, onQuery }: Props) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({ cb911: true }));
  const [indexes, setIndexes] = useState<Record<string, SqlIndexInfo[] | 'loading' | string>>({});
  const [menu, openMenu] = useContextMenu();
  const toggle = (k: string) => setOpen(o => ({ ...o, [k]: !o[k] }));

  const dbs = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (schema?.databases || []).map(d => ({ ...d, tables: t ? d.tables.filter(x => x.name.toLowerCase().includes(t)) : d.tables })).filter(d => !t || d.tables.length || d.name.toLowerCase().includes(t));
  }, [schema, q]);

  const openDb = (db: string) => { if (!open[db]) loadColumns(db); toggle(db); };
  const openTable = async (db: string, table: string) => {
    const k = `${db}.${table}`;
    toggle(k);
    if (!columns[db]) loadColumns(db);
    if (indexes[k]) return;
    setIndexes(x => ({ ...x, [k]: 'loading' }));
    try { const ix = await api.sqlIndexes(alias, db, table); setIndexes(x => ({ ...x, [k]: ix })); }
    catch (err: any) { setIndexes(x => ({ ...x, [k]: err.message })); }
  };
  const tableMenu = (e: RMouseEvent, db: string, table: string) => openMenu(e, [
    { label: 'SELECT * … LIMIT 100', icon: Play, onSelect: () => onQuery(`SELECT *\nFROM ${db}.${table}\nLIMIT 100`, { run: true, title: table }) },
    { label: 'Count rows', onSelect: () => onQuery(`SELECT COUNT(*) AS n\nFROM ${db}.${table}`, { run: true, title: `count ${table}` }) },
    { label: 'SHOW CREATE TABLE', onSelect: () => onQuery(`SHOW CREATE TABLE ${db}.${table}`, { run: true, title: table }) },
    'separator',
    { label: 'Insert name', onSelect: () => onInsert(`${db}.${table}`) },
    { label: 'Copy name', onSelect: async () => { await copy(`${db}.${table}`); actions.toast('Copied'); } },
  ]);

  // Big databases open with hundreds of tables; the list shows the first 400 until the search narrows it.
  const LIMIT = 400;
  return (
    <>
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <div className="sql-search flex-1">
          <Search size={12} aria-hidden="true" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a table" aria-label="Find a table" />
        </div>
        <button className="iconbtn h-7 w-7" title={schema ? `Schema read ${age(schema.at)} ago. Refresh` : 'Refresh'} aria-label="Refresh schema" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="sql-tree" role="tree" aria-label="Schema">
        {schemaError && <div className="m-2 rounded-md border border-crit bg-crit-soft p-2 text-[11.5px]">{schemaError}</div>}
        {!schema && !schemaError && <div className="p-3 text-[12px] text-fg-faint">{loading ? 'Reading the schema…' : 'No schema yet.'}</div>}
        {dbs.map(d => {
          const dbOpen = open[d.name] || (!!q.trim() && d.tables.length > 0 && d.tables.length < 60);
          return (
            <div key={d.name} role="treeitem" aria-expanded={dbOpen}>
              <button className="sql-node" onClick={() => openDb(d.name)} style={{ paddingLeft: 6 }}>
                <ChevronRight size={12} className={`sql-chev ${dbOpen ? 'open' : ''}`} aria-hidden="true" />
                <Database size={13} className="text-fg-faint" aria-hidden="true" />
                <span className="grow truncate">{d.name}</span>
                <span className="sql-count">{d.tables.length}</span>
              </button>
              {dbOpen && d.tables.slice(0, q ? 2000 : LIMIT).map(t => {
                const k = `${d.name}.${t.name}`, tOpen = open[k];
                const cols = columns[d.name]?.[t.name], ix = indexes[k];
                return (
                  <div key={t.name} role="treeitem" aria-expanded={!!tOpen}>
                    <button className="sql-node" style={{ paddingLeft: 20 }} onClick={() => openTable(d.name, t.name)} onDoubleClick={() => onInsert(k)} onContextMenu={e => tableMenu(e, d.name, t.name)} title={`${k}${t.rows != null ? ` · about ${t.rows.toLocaleString()} rows` : ''}\nDouble-click to insert; right-click for queries`}>
                      <ChevronRight size={12} className={`sql-chev ${tOpen ? 'open' : ''}`} aria-hidden="true" />
                      {t.type === 'view' ? <Eye size={13} className="text-fg-faint" aria-hidden="true" /> : <Table2 size={13} className="text-fg-faint" aria-hidden="true" />}
                      <span className="grow truncate">{t.name}</span>
                      {t.rows != null && t.rows > 0 && <span className="sql-count">{t.rows >= 1e6 ? `${(t.rows / 1e6).toFixed(1)}M` : t.rows >= 1e3 ? `${Math.round(t.rows / 1e3)}k` : t.rows}</span>}
                    </button>
                    {tOpen && <div className="sql-cols">
                      {!cols && <div className="sql-leaf text-fg-faint" style={{ paddingLeft: 40 }}>Reading columns…</div>}
                      {cols?.map(c => (
                        <button key={c.name} className="sql-leaf" style={{ paddingLeft: 40 }} onDoubleClick={() => onInsert(c.name)} title={`${c.name} ${c.type}${c.nullable ? ' NULL' : ' NOT NULL'}${c.key ? ` · ${keyGlyph(c.key)}` : ''}${c.comment ? `\n${c.comment}` : ''}\nDouble-click to insert`}>
                          {c.key ? <KeyRound size={11} className={c.key === 'PRI' ? 'text-warn' : 'text-accent'} aria-label={keyGlyph(c.key)} /> : <span className="w-[11px]" />}
                          <span className="grow truncate">{c.name}</span>
                          <span className="sql-ctype">{c.type}</span>
                        </button>
                      ))}
                      {ix === 'loading' && <div className="sql-leaf text-fg-faint" style={{ paddingLeft: 40 }}>Reading indexes…</div>}
                      {Array.isArray(ix) && ix.length > 0 && <>
                        <div className="sql-leaf sql-group" style={{ paddingLeft: 40 }}>Indexes</div>
                        {ix.map(i => (
                          <div key={i.name} className="sql-leaf" style={{ paddingLeft: 48 }} title={`${i.name}${i.unique ? ' (unique)' : ''}: ${i.columns.join(', ')}`}>
                            <Zap size={11} className={i.unique ? 'text-warn' : 'text-fg-faint'} aria-hidden="true" />
                            <span className="truncate">{i.name}</span>
                            <span className="sql-ctype grow truncate">{i.columns.join(', ')}</span>
                          </div>
                        ))}
                      </>}
                      {typeof ix === 'string' && ix !== 'loading' && <div className="sql-leaf text-crit" style={{ paddingLeft: 40 }}>{ix}</div>}
                    </div>}
                  </div>
                );
              })}
              {dbOpen && !q && d.tables.length > LIMIT && <div className="sql-leaf text-fg-faint" style={{ paddingLeft: 24 }}>{(d.tables.length - LIMIT).toLocaleString()} more. Search to narrow.</div>}
            </div>
          );
        })}
      </div>
      {menu}
    </>
  );
}

function History({ history, alias, onQuery }: { history: SqlHistoryEntry[]; alias: string; onQuery: Props['onQuery'] }) {
  const [q, setQ] = useState('');
  const [here, setHere] = useState(false);
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    return history.filter(h => (!here || h.alias === alias) && (!t || h.sql.toLowerCase().includes(t))).slice(0, 300);
  }, [history, q, here, alias]);
  return (
    <>
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <div className="sql-search flex-1">
          <Search size={12} aria-hidden="true" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search history" aria-label="Search history" />
        </div>
        <button className={`chip ${here ? 'ticket' : ''}`} onClick={() => setHere(h => !h)} title="Only runs on this tab's connection">{alias || 'this'}</button>
      </div>
      <div className="sql-tree">
        {!hits.length && <div className="p-3 text-[12px] text-fg-faint">{history.length ? 'Nothing matches.' : 'Queries you run show up here.'}</div>}
        {hits.map((h, i) => (
          <button key={`${h.at}-${i}`} className="sql-hist" onClick={() => onQuery(h.sql, { alias: h.alias, db: h.db, title: h.sql.replace(/\s+/g, ' ').slice(0, 24) })} title={`${h.sql}\n\nClick to open in a new tab`}>
            <div className="flex items-center gap-1.5 text-[10.5px] text-fg-faint">
              <Clock size={10} aria-hidden="true" /><span>{age(h.at)} ago</span><span>·</span><span>{h.alias}</span>
              <span className="grow" />
              {h.error ? <span className="text-crit">error</span> : <span className="num">{h.rows ?? '–'} rows · {h.ms ?? '–'} ms</span>}
            </div>
            <div className="sql-hist-sql">{h.sql}</div>
          </button>
        ))}
      </div>
    </>
  );
}

function Lookups({ lookups, onLookup, onEdit, onDelete, currentSql, alias }: { lookups: SqlLookup[]; onLookup: Props['onLookup']; onEdit: Props['onEditLookup']; onDelete: Props['onDeleteLookup']; currentSql: () => string; alias: string }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  return (
    <div className="sql-tree px-2">
      <div className="mb-2 flex gap-1">
        <button className="btn sm flex-1" onClick={() => onEdit({ alias })}><Plus size={12} aria-hidden="true" /> New lookup</button>
        <button className="btn sm flex-1" title="Start a lookup from the statement under the cursor; put ? where the value goes" onClick={() => onEdit({ alias, sql: currentSql() })}><FilePlus2 size={12} aria-hidden="true" /> From this query</button>
      </div>
      <p className="mb-2 px-1 text-[11.5px] text-fg-faint">Also from the palette: Ctrl+K, then <span className="kbd">cb 123456</span>.</p>
      {lookups.map(l => (
        <form key={l.name} className="group mb-2 flex min-w-0 flex-col gap-1 rounded-lg border border-line p-2" onSubmit={e => { e.preventDefault(); if (vals[l.name]?.trim()) onLookup(l.name, vals[l.name]); }}>
          <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
            <span className="mono flex-none font-semibold">{l.name}</span><span className="truncate text-fg-muted" title={l.label}>{l.label}</span><span className="grow" />
            <span className="flex-none text-[10.5px] text-fg-faint group-hover:hidden">{l.alias}</span>
            <span className="hidden flex-none gap-0.5 group-hover:flex">
              {l.source === 'user'
                ? <button type="button" className="iconbtn h-5 w-5" title="Edit" aria-label={`Edit ${l.name}`} onClick={() => onEdit({ ...l, editing: l.name })}><Pencil size={11} /></button>
                : <button type="button" className="iconbtn h-5 w-5" title="Customize: saves your own copy under the same name" aria-label={`Customize ${l.name}`} onClick={() => onEdit({ ...l })}><Copy size={11} /></button>}
              {l.source === 'user' && <button type="button" className="iconbtn h-5 w-5" title="Delete" aria-label={`Delete ${l.name}`} onClick={() => { if (confirm(`Delete the lookup "${l.name}"?`)) onDelete(l.name); }}><Trash2 size={11} /></button>}
            </span>
          </div>
          <div className="flex gap-1">
            <input className="input h-7 min-w-0 flex-1 mono" value={vals[l.name] || ''} onChange={e => setVals(v => ({ ...v, [l.name]: e.target.value }))} placeholder="value" aria-label={`${l.label} value`} />
            <button className="btn sm" type="submit"><Play size={12} aria-hidden="true" /> Run</button>
          </div>
        </form>
      ))}
    </div>
  );
}
