import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Activity, AlignLeft, Ban, ChevronDown, Columns3, Copy, Database, Gauge, KeyRound, LayoutList, MessageSquareShare, Pencil, Play, PlayCircle, Plus, Rows3, Search, ShieldCheck, Table, X } from 'lucide-react';
import type { SQLNamespace } from '@codemirror/lang-sql';
import { api, type SqlLookup, type SqlRunRequest, type SqlColumnInfo, type SqlHistoryEntry, type SqlInfo, type SqlSchema, type SqlTab } from '../lib/api';
import { actions } from '../lib/store';
import { useContextMenu, type MenuItem } from '../components/ContextMenu';
import { Empty, Kbd } from '../components/ui';
import { age } from '../lib/format';
import { statementAt } from '../../../shared/sqlClassify';
import { SqlEditor, type EditorHandle } from '../sql/SqlEditor';
import { ResultGrid, useOrder, type Selection, type Sort } from '../sql/ResultGrid';
import { RecordView } from '../sql/RecordView';
import { CellModal } from '../sql/CellModal';
import { LeftPane, type PaneMode } from '../sql/LeftPane';
import { CredentialsDialog } from '../sql/CredentialsDialog';
import { LookupEditor } from '../sql/LookupEditor';
import { ProcessesPanel } from '../sql/ProcessesPanel';
import { SendToChat, type Intent, type ShareData } from '../sql/SendToChat';
import { startRun, type SqlResult } from '../sql/run';

/** Per tab, not saved: how its result is shown. */
interface TabUi { mode: 'grid' | 'record'; preferRecord: boolean; selection: Selection; sort: Sort; filter: string; hidden: number[]; record: number }
const freshUi = (preferRecord = false): TabUi => ({ mode: 'grid', preferRecord, selection: null, sort: null, filter: '', hidden: [], record: 0 });
const newId = () => Math.random().toString(36).slice(2, 10);
const readLs = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const writeLs = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
// Lookups already opened, so the same palette pick (kept in the tab list across a reload) never opens a second tab.
const handledLookups = new Set<number>();

export function SqlView({ lookup }: { lookup?: { name: string; value: string; at: number } }) {
  const [info, setInfo] = useState<SqlInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<SqlTab[] | null>(null);
  const [activeId, setActiveId] = useState<string>(() => readLs('fleet.sql.active', ''));
  const [results, setResults] = useState<Record<string, SqlResult>>({});
  const [ui, setUi] = useState<Record<string, TabUi>>({});
  const [schemas, setSchemas] = useState<Record<string, SqlSchema>>({});
  const [schemaErr, setSchemaErr] = useState<Record<string, string>>({});
  const [schemaBusy, setSchemaBusy] = useState<Record<string, boolean>>({});
  const [cols, setCols] = useState<Record<string, Record<string, Record<string, SqlColumnInfo[]>>>>({});
  const [history, setHistory] = useState<SqlHistoryEntry[]>([]);
  const [pane, setPane] = useState<PaneMode>(() => readLs('fleet.sql.pane', 'schema'));
  const [leftW, setLeftW] = useState<number>(() => readLs('fleet.sql.left', 260));
  const [cell, setCell] = useState<{ tab: string; row: number; col: number } | null>(null);
  const [share, setShare] = useState<Intent | null>(null);
  const [login, setLogin] = useState(false);
  const [confirm, setConfirm] = useState<{ tab: string; req: SqlRunRequest; reason: string } | null>(null);
  // One Processes tab per connection: reopening focuses it.
  const openProcesses = (a: string) => {
    const t = tabs?.find(x => x.kind === 'processes' && x.alias === a);
    if (t) setActiveId(t.id); else addTab({ kind: 'processes', alias: a, title: 'Processes' });
  };
  const [lookupEdit, setLookupEdit] = useState<(Partial<SqlLookup> & { editing?: string }) | null>(null);
  const setLookups = (lookups: SqlLookup[]) => setInfo(i => i && { ...i, lookups });
  // The statement under the cursor (or the selection), to start a lookup from.
  const currentSql = () => {
    const snap = active && editors.current[active.id]?.snapshot();
    if (!snap) return '';
    return snap.selection ? snap.text.slice(snap.selection.from, snap.selection.to).trim() : statementAt(snap.text, snap.cursor)?.text || '';
  };
  const tabMenu = (e: React.MouseEvent, t: SqlTab) => openMenu(e, [
    // After the menu has closed: closing it hands focus back to the tab, which would blur the rename box at once.
    { label: 'Rename', icon: Pencil, onSelect: () => { setActiveId(t.id); setTimeout(() => setRenaming(t.id), 60); } },
    { label: 'Duplicate', icon: Copy, onSelect: () => addTab({ alias: t.alias, db: t.db, text: t.text, title: `${t.title} copy` }) },
    'separator',
    { label: 'Close', icon: X, onSelect: () => closeTab(t.id) },
    { label: 'Close others', disabled: (tabs?.length || 0) < 2, onSelect: () => { for (const o of tabs || []) if (o.id !== t.id) aborts.current[o.id]?.(); setTabs(ts => ts && ts.filter(o => o.id === t.id)); setActiveId(t.id); } },
  ]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [, tick] = useState(0);
  const editors = useRef<Record<string, EditorHandle | null>>({});
  const aborts = useRef<Record<string, () => void>>({});
  const colsLoading = useRef(new Set<string>());
  const [menu, openMenu] = useContextMenu();

  // Load: connections, saved tabs, history.
  useEffect(() => {
    api.sqlInfo().then(i => { setInfo(i); if (i.error) setInfoError(i.error); }).catch(err => setInfoError(err.message));
    api.sqlTabs().then(t => setTabs(t)).catch(() => setTabs([]));
    api.sqlHistory().then(setHistory).catch(() => {});
  }, []);
  const tabsReady = tabs != null && info != null;
  // At least one tab, on the default connection.
  useEffect(() => {
    if (!tabsReady || !info) return;
    if (!tabs!.length && info.defaultAlias) { const t = blank(1, info.defaultAlias); setTabs([t]); setActiveId(t.id); }
    else if (tabs!.length && !tabs!.some(t => t.id === activeId)) setActiveId(tabs![0].id);
  }, [tabsReady]);
  // Saved 800 ms after the last change.
  const firstSave = useRef(true);
  useEffect(() => {
    if (!tabs) return;
    if (firstSave.current) { firstSave.current = false; return; }
    const h = setTimeout(() => api.sqlSaveTabs(tabs).catch(() => {}), 800);
    return () => clearTimeout(h);
  }, [tabs]);
  useEffect(() => { if (activeId) writeLs('fleet.sql.active', activeId); }, [activeId]);

  const active = tabs?.find(t => t.id === activeId) || null;
  const alias = info?.aliases.find(a => a.alias === active?.alias) || null;
  const result = active ? results[active.id] : undefined;
  const tui = (active && ui[active.id]) || freshUi();
  const patchUi = (id: string, p: Partial<TabUi>) => setUi(u => ({ ...u, [id]: { ...(u[id] || freshUi()), ...p } }));
  const patchTab = (id: string, p: Partial<SqlTab>) => setTabs(ts => ts && ts.map(t => t.id === id ? { ...t, ...p } : t));

  function blank(n: number, a: string, p: Partial<SqlTab> = {}): SqlTab { return { id: newId(), title: `Query ${n}`, alias: a, db: null, text: '', ...p }; }
  const addTab = (p: Partial<SqlTab> = {}, opts: { preferRecord?: boolean } = {}) => {
    const t = blank((tabs?.length || 0) + 1, p.alias || active?.alias || info?.defaultAlias || '', p);
    setTabs(ts => [...(ts || []), t]); setActiveId(t.id);
    if (opts.preferRecord) patchUi(t.id, { preferRecord: true });
    return t;
  };
  const closeTab = (id: string) => {
    aborts.current[id]?.();
    setTabs(ts => {
      if (!ts) return ts;
      const i = ts.findIndex(t => t.id === id), next = ts.filter(t => t.id !== id);
      if (id === activeId) setActiveId((next[i] || next[i - 1])?.id || '');
      return next.length ? next : [blank(1, info?.defaultAlias || '')];
    });
    setResults(r => { const { [id]: _, ...rest } = r; return rest; });
  };

  // Schema for the active connection, then the columns of the tab's database (cb911 by default) for completion.
  const loadSchema = useCallback(async (a: string, refresh = false) => {
    setSchemaBusy(b => ({ ...b, [a]: true }));
    try {
      const s = await api.sqlSchema(a, refresh);
      setSchemas(x => ({ ...x, [a]: s })); setSchemaErr(x => { const { [a]: _, ...rest } = x; return rest; });
      if (refresh) { setCols(c => ({ ...c, [a]: {} })); for (const k of [...colsLoading.current]) if (k.startsWith(`${a}/`)) colsLoading.current.delete(k); }
    } catch (err: any) { setSchemaErr(x => ({ ...x, [a]: err.message })); }
    finally { setSchemaBusy(b => ({ ...b, [a]: false })); }
  }, []);
  const loadColumns = useCallback(async (a: string, db: string) => {
    const k = `${a}/${db}`;
    if (colsLoading.current.has(k)) return;
    colsLoading.current.add(k);
    try { const c = await api.sqlColumns(a, db); setCols(x => ({ ...x, [a]: { ...(x[a] || {}), [db]: c } })); }
    catch { colsLoading.current.delete(k); }
  }, []);
  useEffect(() => { if (alias && !schemas[alias.alias] && !schemaBusy[alias.alias] && !schemaErr[alias.alias]) loadSchema(alias.alias); }, [alias?.alias]);
  const schema = alias ? schemas[alias.alias] : undefined;
  useEffect(() => {
    if (!alias || !schema) return;
    const db = active?.db || (schema.databases.some(d => d.name === 'cb911') ? 'cb911' : null);
    if (db) loadColumns(alias.alias, db);
  }, [alias?.alias, schema, active?.db]);

  const completion = useMemo<SQLNamespace>(() => {
    if (!schema) return {};
    const loaded = (alias && cols[alias.alias]) || {};
    const ns: Record<string, SQLNamespace> = {};
    for (const d of schema.databases) {
      const tables: Record<string, SQLNamespace> = {};
      for (const t of d.tables) tables[t.name] = (loaded[d.name]?.[t.name] || []).map(c => ({ label: c.name, type: 'property', detail: `${c.key ? `${c.key === 'PRI' ? '🔑' : '⚡'} ` : ''}${c.type}`, boost: c.key ? 1 : 0 }));
      ns[d.name] = tables;
    }
    return ns;
  }, [schema, alias?.alias, cols]);

  // Running.
  const run = (limit: 'auto' | 'max' = 'auto', override?: { text: string; cursor: number; selection: null }) => {
    if (!active || !alias) return;
    const snap = override || editors.current[active.id]?.snapshot();
    if (!snap) return;
    launch(active.id, { alias: alias.alias, text: snap.text, cursor: snap.cursor, selection: snap.selection, db: active.db, limit }, !override);
  };
  const launch = (id: string, req: SqlRunRequest, markErrors: boolean) => {
    aborts.current[id]?.();
    editors.current[id]?.markError(null);
    const { abort } = startRun(req, r => {
      // A risky write on dev: the server asks first, and the same request goes again with confirm once you say so.
      if (r.status === 'error' && r.error?.code === 'CONFIRM') { delete aborts.current[id]; setResults(x => { const { [id]: _, ...rest } = x; return rest; }); setConfirm({ tab: id, req, reason: r.error.message }); return; }
      setResults(x => ({ ...x, [id]: r }));
      if (r.status === 'running') return;
      delete aborts.current[id];
      api.sqlHistory().then(setHistory).catch(() => {});
      if (r.status === 'error' && r.error?.offset != null && markErrors) editors.current[id]?.markError({ from: r.error.offset, to: r.error.offset + Math.max(1, r.error.length) });
      setUi(u => {
        const cur = u[id] || freshUi();
        const mode = cur.preferRecord && r.status === 'done' && r.rows.length === 1 ? 'record' : r.status === 'done' && r.rows.length !== 1 && cur.mode === 'record' && cur.preferRecord ? 'grid' : cur.mode;
        return { ...u, [id]: { ...cur, mode, selection: null, sort: null, hidden: [], record: 0, preferRecord: false } };
      });
    });
    aborts.current[id] = abort;
  };
  const cancel = () => {
    if (!active) return;
    const r = results[active.id];
    if (r?.status === 'running' && r.runId) api.sqlCancel(r.runId).catch(() => aborts.current[active.id]?.());
    else aborts.current[active.id]?.();
  };
  const explain = () => {
    const snap = active && editors.current[active.id]?.snapshot();
    if (!snap) return;
    const s = snap.selection ? { text: snap.text.slice(snap.selection.from, snap.selection.to).trim() } : statementAt(snap.text, snap.cursor);
    if (!s?.text) return;
    run('auto', { text: /^\s*explain\b/i.test(s.text) ? s.text : `EXPLAIN ${s.text}`, cursor: 0, selection: null });
  };
  const format = async () => {
    const ed = active && editors.current[active.id];
    if (!ed) return;
    const { format: fmt } = await import('sql-formatter');
    const snap = ed.snapshot();
    try {
      if (snap.selection) {
        const out = fmt(snap.text.slice(snap.selection.from, snap.selection.to), { language: 'mysql', keywordCase: 'upper', tabWidth: 2 });
        ed.insert(out);
      } else ed.replaceAll(fmt(snap.text, { language: 'mysql', keywordCase: 'upper', tabWidth: 2, linesBetweenQueries: 2 }));
    } catch (err: any) { actions.toast(`Could not format: ${String(err.message || err).split('\n')[0]}`, 'error'); }
  };

  // Lookups from the palette or the left pane: a new tab with the statement, already run.
  const openLookup = async (name: string, value: string) => {
    try {
      const l = await api.sqlLookup(name, value);
      const t = addTab({ alias: l.alias, title: l.title, text: l.sql }, { preferRecord: l.view === 'record' });
      setTimeout(() => runTab(t.id), 60);
    } catch (err: any) { actions.toast(err.message, 'error'); }
  };
  // A tab run before its editor exists (just opened) waits for it.
  const pendingRun = useRef<string | null>(null);
  const runTab = (id: string) => { pendingRun.current = id; tick(n => n + 1); };
  useEffect(() => {
    const id = pendingRun.current;
    if (!id || id !== activeId || !editors.current[id]) return;
    pendingRun.current = null;
    run('auto');
  });
  useEffect(() => {
    if (!lookup || !tabsReady || handledLookups.has(lookup.at) || Date.now() - lookup.at > 15000) return;
    handledLookups.add(lookup.at);
    if (lookup.name) openLookup(lookup.name, lookup.value); else addTab();
    actions.go({ kind: 'sql' });
  }, [lookup?.at, tabsReady]);

  const openQuery = (sql: string, opts: { run?: boolean; title?: string; alias?: string; db?: string | null } = {}) => {
    const t = addTab({ text: sql, title: opts.title || `Query ${(tabs?.length || 0) + 1}`, alias: opts.alias && info?.aliases.some(a => a.alias === opts.alias) ? opts.alias : active?.alias, db: opts.db ?? active?.db ?? null });
    if (opts.run) setTimeout(() => runTab(t.id), 60);
  };

  // Keys inside the view. Alt, not Ctrl: Ctrl+T, Ctrl+W and Ctrl+R belong to the browser when Fleet runs in a tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (e.key === 'Escape' && result?.status === 'running') { e.preventDefault(); cancel(); return; }
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code === 'KeyT') { e.preventDefault(); addTab(); }
      else if (e.code === 'KeyW' && active) { e.preventDefault(); closeTab(active.id); }
      else if (e.code === 'KeyR' && active && result?.status !== 'running') { e.preventDefault(); patchUi(active.id, { mode: tui.mode === 'record' ? 'grid' : 'record' }); }
      else if (/^Digit[1-9]$/.test(e.code) && tabs) { const t = tabs[Number(e.code.slice(5)) - 1]; if (t) { e.preventDefault(); setActiveId(t.id); } }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  // Elapsed time while running.
  useEffect(() => {
    if (result?.status !== 'running') return;
    const h = setInterval(() => tick(n => n + 1), 250);
    return () => clearInterval(h);
  }, [result?.status]);

  // Draggable splits: the left pane's width, and the editor's share of the height (per tab).
  const right = useRef<HTMLDivElement>(null);
  const dragLeft = (e: RPointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = leftW;
    const move = (ev: PointerEvent) => setLeftW(Math.max(180, Math.min(520, w0 + ev.clientX - x0)));
    const up = (ev: PointerEvent) => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); writeLs('fleet.sql.left', Math.max(180, Math.min(520, w0 + ev.clientX - x0))); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  const dragSplit = (e: RPointerEvent) => {
    if (!active || !right.current) return;
    e.preventDefault();
    const box = right.current.getBoundingClientRect(), id = active.id;
    const move = (ev: PointerEvent) => patchTab(id, { split: Math.max(0.12, Math.min(0.85, (ev.clientY - box.top) / box.height)) });
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.style.cursor = ''; };
    addEventListener('pointermove', move); addEventListener('pointerup', up); document.body.style.cursor = 'row-resize';
  };

  // Result shaping shared by the grid, the record view, copying, and sending.
  const columns = result?.columns || [];
  const visible = useMemo(() => columns.map((_, i) => i).filter(i => !tui.hidden.includes(i)), [columns, tui.hidden]);
  const order = useOrder(columns, result?.rows || [], result?.version || 0, visible, tui.filter, tui.sort);
  const recordPos = Math.min(tui.record, Math.max(0, order.length - 1));
  const recordRow = result && order.length ? result.rows[order[tui.selection && tui.selection.kind !== 'col' && tui.mode === 'grid' ? tui.selection.r : recordPos]] : null;

  const shareData = (): ShareData | null => {
    if (!active || !alias) return null;
    const statement = result?.statement || (editors.current[active.id] && statementAt(editors.current[active.id]!.snapshot().text, editors.current[active.id]!.snapshot().cursor)?.text) || '';
    return { alias: alias.alias, prod: alias.prod, db: active.db, statement,
      columns: visible.map(i => columns[i]), rows: order.map(i => visible.map(c => result!.rows[i][c])), rowCount: result?.rows.length || 0,
      ms: result?.ms ?? null, truncated: !!result?.truncated, autoLimited: !!result?.autoLimited, error: result?.error?.message || null,
      record: tui.mode === 'record' && recordRow ? visible.map(c => recordRow[c]) : null };
  };
  const sendMenu = (e: React.MouseEvent) => openMenu(e, [
    { label: 'Share the result', icon: MessageSquareShare, onSelect: () => setShare('result') },
    { label: 'Write a query for…', onSelect: () => setShare('write') },
    { label: 'Explain this query', onSelect: () => setShare('explain') },
    { label: 'Fix this error', disabled: result?.status !== 'error', onSelect: () => setShare('fix') },
  ]);
  const columnsMenu = (e: React.MouseEvent) => {
    if (!active) return;
    const id = active.id, hidden = tui.hidden;
    const items: MenuItem[] = [
      { label: 'Show all', disabled: !hidden.length, onSelect: () => patchUi(id, { hidden: [] }) },
      { label: 'Hide all-NULL columns', onSelect: () => patchUi(id, { hidden: columns.map((_, i) => i).filter(i => result!.rows.every(r => r[i] == null)) }) },
      'separator',
      ...columns.map((c, i): MenuItem => ({ label: `${hidden.includes(i) ? '◻' : '☑'}  ${c.name}`, onSelect: () => patchUi(id, { hidden: hidden.includes(i) ? hidden.filter(x => x !== i) : [...hidden, i] }) })),
    ];
    openMenu(e, items);
  };

  if (infoError && !info?.aliases.length) return <Empty title="The SQL view is not set up">{infoError}</Empty>;
  if (!tabs || !info) return <div className="m-auto text-[12px] text-fg-faint">Loading…</div>;

  const running = result?.status === 'running';
  const split = active?.split ?? 0.4;
  const envOf = (a: string) => info.aliases.find(x => x.alias === a);

  return (
    <div className="sql-view" style={{ gridTemplateColumns: `${leftW}px 5px minmax(0, 1fr)` }}>
      <LeftPane mode={pane} onMode={m => { setPane(m); writeLs('fleet.sql.pane', m); }}
        alias={alias?.alias || ''} schema={schema || null} schemaError={alias ? schemaErr[alias.alias] || null : null} loading={!!(alias && schemaBusy[alias.alias])}
        onRefresh={() => alias && loadSchema(alias.alias, true)} columns={(alias && cols[alias.alias]) || {}} loadColumns={db => alias && loadColumns(alias.alias, db)}
        history={history} lookups={info.lookups} onInsert={t => active && editors.current[active.id]?.insert(t)} onQuery={openQuery} onLookup={openLookup}
        onEditLookup={setLookupEdit} currentSql={currentSql}
        onDeleteLookup={name => api.sqlDeleteLookup(name).then(l => { setLookups(l); actions.toast(`Deleted ${name}`); }).catch(err => actions.toast(err.message, 'error'))} />
      <div className="sql-vsplit" onPointerDown={dragLeft} role="separator" aria-orientation="vertical" aria-label="Resize the schema pane" />

      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="sql-tabs" role="tablist" aria-label="Query tabs">
          {tabs.map((t, i) => {
            const env = envOf(t.alias), r = results[t.id];
            return (
              <div key={t.id} role="tab" aria-selected={t.id === activeId} className={`sql-tab ${t.id === activeId ? 'is-active' : ''} ${env?.prod ? 'prod' : ''}`}
                onClick={() => setActiveId(t.id)} onDoubleClick={() => setRenaming(t.id)} onAuxClick={e => { if (e.button === 1) closeTab(t.id); }} onContextMenu={e => tabMenu(e, t)}
                title={`${t.title} · ${t.alias}${i < 9 ? `  (Alt+${i + 1})` : ''}
Double-click to rename; right-click for more`}>
                <span className={`dot ${r?.status === 'running' ? '' : ''}`} data-s={r?.status === 'running' ? 'running' : env?.prod ? 'failed' : 'done'} aria-hidden="true" />
                {renaming === t.id
                  ? <input autoFocus className="sql-tab-input" defaultValue={t.title} onBlur={e => { patchTab(t.id, { title: e.target.value.trim() || t.title }); setRenaming(null); }}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} onClick={e => e.stopPropagation()} />
                  : <span className="truncate">{t.title}</span>}
                <button className="sql-tab-x" aria-label={`Close ${t.title}`} onClick={e => { e.stopPropagation(); closeTab(t.id); }}><X size={12} /></button>
              </div>
            );
          })}
          <button className="iconbtn h-7 w-7 flex-none" aria-label="New query tab (Alt+T)" title="New query tab (Alt+T)" onClick={() => addTab()}><Plus size={14} /></button>
        </div>

        {active && active.kind === 'processes' && alias && <ProcessesPanel key={active.id} alias={alias} aliases={info.aliases} onAlias={a => patchTab(active.id, { alias: a })}
          onLogin={() => setLogin(true)} onOpenQuery={sql => openQuery(sql, { alias: active.alias, title: 'From processes' })} />}
        {/* Query tabs stay mounted behind a Processes tab, so their editors keep undo history. */}
        {active && <div style={{ display: active.kind === 'processes' ? 'none' : 'contents' }}>
          <div className="sql-toolbar">
            <label className={`sql-conn ${alias?.prod ? 'prod' : 'dev'}`} title={alias?.prod ? 'Production reader: read-only' : 'Development: reads and writes, each statement committed as it runs'}>
              <Database size={13} aria-hidden="true" />
              <select value={active.alias} onChange={e => patchTab(active.id, { alias: e.target.value, db: null })} aria-label="Connection">
                {info.aliases.map(a => <option key={a.alias} value={a.alias}>{a.alias}{a.prod ? ' (PRD)' : ''}</option>)}
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </label>
            <button className="iconbtn h-7 w-7 flex-none" onClick={() => setLogin(true)} title={`Username and password for ${active.alias}`} aria-label={`Login for ${active.alias}`}><KeyRound size={14} /></button>
            <label className="sql-conn" title="Default database for unqualified names">
              <select value={active.db || ''} onChange={e => patchTab(active.id, { db: e.target.value || null })} aria-label="Default database">
                <option value="">no default db</option>
                {(schema?.databases || []).map(d => <option key={d.name} value={d.name}>{d.name}</option>)}
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </label>
            <span className="sql-tsep" />
            {running
              ? <button className="btn sm danger" onClick={cancel} title="Esc"><Ban size={13} aria-hidden="true" /> Cancel</button>
              : <button className="btn sm primary" onClick={() => run('auto')} title={`Run the statement under the cursor (Ctrl+Enter). Adds LIMIT ${info.autoLimit} when there is none.`}><Play size={13} aria-hidden="true" /> Run</button>}
            <button className="btn sm ghost" onClick={() => run('max')} disabled={running} title={`Run up to ${info.maxRows.toLocaleString()} rows (Ctrl+Shift+Enter)`}><PlayCircle size={13} aria-hidden="true" /> {info.maxRows.toLocaleString()}</button>
            <button className="btn sm ghost" onClick={explain} disabled={running} title="EXPLAIN the statement (Ctrl+Shift+E)"><Gauge size={13} aria-hidden="true" /> Explain</button>
            <button className="btn sm ghost" onClick={format} title="Format (Ctrl+Shift+F)"><AlignLeft size={13} aria-hidden="true" /> Format</button>
            <button className="btn sm ghost" onClick={() => openProcesses(active.alias)} title={`Live processes on ${active.alias}: what runs, for how long, and Kill`}><Activity size={13} aria-hidden="true" /> Processes</button>
            <span className="grow" />
            <button className="btn sm ghost" onClick={sendMenu} title="Send the statement and result to a chat"><MessageSquareShare size={13} aria-hidden="true" /> Send to chat <ChevronDown size={12} aria-hidden="true" /></button>
            <div className="sql-seg" role="tablist" aria-label="Result view">
              <button role="tab" aria-selected={tui.mode === 'grid'} onClick={() => patchUi(active.id, { mode: 'grid' })} title="Grid"><Table size={13} aria-label="Grid" /></button>
              <button role="tab" aria-selected={tui.mode === 'record'} onClick={() => patchUi(active.id, { mode: 'record' })} title="Record (Alt+R)"><Rows3 size={13} aria-label="Record" /></button>
            </div>
          </div>

          <div ref={right} className="relative flex min-h-0 flex-1 flex-col">
            <div className={`sql-editor-wrap ${alias?.prod ? 'prod' : ''}`} style={{ height: `${split * 100}%` }}>
              {tabs.filter(t => t.kind !== 'processes').map(t => (
                <div key={t.id} className="h-full" style={{ display: t.id === activeId ? 'block' : 'none' }}>
                  <SqlEditor ref={h => { editors.current[t.id] = h; }} value={t.text} onChange={text => patchTab(t.id, { text })}
                    schema={t.id === activeId ? completion : {}} defaultSchema={t.db || undefined} onRun={run} onFormat={format} onExplain={explain} />
                </div>
              ))}
            </div>
            <div className="sql-hsplit" onPointerDown={dragSplit} role="separator" aria-orientation="horizontal" aria-label="Resize the editor" />
            <div className="flex min-h-0 flex-1 flex-col bg-surface">
              {running && <div className="sql-progress" aria-hidden="true" />}
              {result?.notice && running && <div className="sql-banner warn">{result.notice}</div>}
              {result?.status === 'error' && result.error && (
                <div className="sql-banner crit" role="alert">
                  <span className="grow mono whitespace-pre-wrap">{result.error.message}{result.error.line ? `  (line ${result.error.line})` : ''}</span>
                  {/denied|access/i.test(result.error.message) && <button className="btn sm" onClick={() => setLogin(true)}><KeyRound size={12} aria-hidden="true" /> Set login</button>}
                  <button className="btn sm" onClick={() => setShare('fix')}>Fix in chat</button>
                </div>
              )}
              {!result && <EmptyResult history={history.filter(h => h.alias === active.alias).slice(0, 3)} onOpen={h => editors.current[active.id]?.replaceAll(h.sql)} autoLimit={info.autoLimit} />}
              {result && result.columns.length > 0 && <>
                {tui.mode === 'grid' && (
                  <div className="sql-subbar">
                    <div className="sql-search">
                      <Search size={12} aria-hidden="true" />
                      <input value={tui.filter} onChange={e => patchUi(active.id, { filter: e.target.value })} placeholder="Filter rows" aria-label="Filter rows" />
                      {tui.filter && <button aria-label="Clear filter" onClick={() => patchUi(active.id, { filter: '' })}><X size={11} /></button>}
                    </div>
                    <button className="btn sm ghost" onClick={columnsMenu}><Columns3 size={13} aria-hidden="true" /> Columns{tui.hidden.length ? ` · ${tui.hidden.length} hidden` : ''}</button>
                    {tui.sort && <button className="chip" onClick={() => patchUi(active.id, { sort: null })} title="Clear sort">sorted by {columns[tui.sort.col]?.name} {tui.sort.dir > 0 ? '↑' : '↓'} ×</button>}
                    <span className="grow" />
                    {tui.filter && <span className="num text-[11px] text-fg-muted">{order.length.toLocaleString()} of {result.rows.length.toLocaleString()}</span>}
                  </div>
                )}
                {tui.mode === 'grid'
                  ? <ResultGrid key={`${active.id}:${result.startedAt}`} columns={columns} rows={result.rows} version={result.version} order={order} visible={visible}
                    sort={tui.sort} onSort={s => patchUi(active.id, { sort: s })} selection={tui.selection} onSelect={s => patchUi(active.id, { selection: s })}
                    onHide={c => patchUi(active.id, { hidden: [...tui.hidden, c] })} onShowAll={() => patchUi(active.id, { hidden: [] })} onFilter={f => patchUi(active.id, { filter: f })}
                    onOpenCell={(row, col) => setCell({ tab: active.id, row, col })} onRecord={row => patchUi(active.id, { mode: 'record', record: Math.max(0, order.indexOf(row)) })} />
                  : <RecordView columns={columns} row={recordRow} position={recordPos} count={order.length} onMove={to => patchUi(active.id, { record: to, selection: null })}
                    onOpenCell={col => { const row = result.rows.indexOf(recordRow!); if (row >= 0) setCell({ tab: active.id, row, col }); }} />}
              </>}
              {result && result.status === 'done' && !result.columns.length && <div className="m-auto text-[12px] text-fg-muted">{result.affected != null ? <><b className="num text-fg">{result.affected.toLocaleString()}</b> row{result.affected === 1 ? '' : 's'} affected. Committed.</> : 'The statement ran and returned no result set.'}</div>}
              {result && result.status === 'done' && result.columns.length > 0 && !result.rows.length && <div className="p-6 text-center text-[12px] text-fg-faint">No rows.</div>}
            </div>
          </div>

          <StatusBar alias={alias} db={active.db} result={result} autoLimit={info.autoLimit} maxRows={info.maxRows} onCancel={cancel} onRunMax={() => run('max')} />
        </div>}
      </div>

      {cell && results[cell.tab] && <CellModal column={results[cell.tab].columns[cell.col]} value={results[cell.tab].rows[cell.row]?.[cell.col] ?? null} onClose={() => setCell(null)} />}
      {login && alias && <CredentialsDialog alias={alias.alias} prod={alias.prod} onClose={() => setLogin(false)}
        onSaved={() => { setSchemaErr(x => { const { [alias.alias]: _, ...rest } = x; return rest; }); if (schemaErr[alias.alias]) loadSchema(alias.alias); }} />}
      {lookupEdit && <LookupEditor initial={lookupEdit} aliases={info.aliases} schema={completion} onClose={() => setLookupEdit(null)} onSaved={setLookups} />}
      {confirm && <ConfirmWrite reason={confirm.reason} statement={confirm.req.selection ? confirm.req.text.slice(confirm.req.selection.from, confirm.req.selection.to).trim() : statementAt(confirm.req.text, confirm.req.cursor)?.text || ''} alias={confirm.req.alias}
        onClose={() => setConfirm(null)} onRun={() => { const c = confirm; setConfirm(null); launch(c.tab, { ...c.req, confirm: true }, true); }} />}
      {share && (() => { const d = shareData(); return d ? <SendToChat data={d} intent={share} onClose={() => setShare(null)} /> : null; })()}
      {menu}
    </div>
  );
}

function StatusBar({ alias, db, result, autoLimit, maxRows, onCancel, onRunMax }: { alias: { alias: string; prod: boolean } | null; db: string | null; result: SqlResult | undefined; autoLimit: number; maxRows: number; onCancel: () => void; onRunMax: () => void }) {
  const running = result?.status === 'running';
  const ms = running ? Date.now() - result!.startedAt : result?.ms;
  return (
    <div className={`sql-status ${alias?.prod ? 'prod' : ''}`} role="status">
      <span className={`sql-env ${alias?.prod ? 'prod' : 'dev'}`}><ShieldCheck size={11} aria-hidden="true" /> {alias?.prod ? 'PRD · read-only' : 'DEV · read-write'}</span>
      <span className="text-fg-muted">{alias?.alias}{db ? ` / ${db}` : ''}</span>
      <span className="grow" />
      {result?.autoLimited && <button className="chip warn" onClick={onRunMax} title={`Run again with up to ${maxRows.toLocaleString()} rows`}>LIMIT {autoLimit} added · Ctrl+Shift+Enter for {maxRows.toLocaleString()}</button>}
      {result?.truncated && <span className="chip warn" title="The query was stopped at the row cap. Narrow the WHERE or add a LIMIT.">capped at {maxRows.toLocaleString()} rows</span>}
      {result && (result.affected != null
        ? <span className="num">{result.affected.toLocaleString()} row{result.affected === 1 ? '' : 's'} affected</span>
        : <span className="num">{result.rows.length.toLocaleString()} row{result.rows.length === 1 ? '' : 's'}</span>)}
      {ms != null && <span className="num text-fg-muted">{ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}</span>}
      {running && <button className="chip crit" onClick={onCancel}>Cancel · Esc</button>}
    </div>
  );
}

function EmptyResult({ history, onOpen, autoLimit }: { history: SqlHistoryEntry[]; onOpen: (h: SqlHistoryEntry) => void; autoLimit: number }) {
  const keys: [string[], string][] = [[['Ctrl', 'Enter'], 'run the statement under the cursor'], [['Ctrl', 'Shift', 'Enter'], 'run with the bigger row cap'], [['Ctrl', 'Shift', 'E'], 'EXPLAIN it'],
    [['Ctrl', 'Shift', 'F'], 'format'], [['Alt', 'R'], 'grid or record view'], [['Alt', 'T'], 'new tab'], [['Alt', 'W'], 'close tab'], [['Esc'], 'cancel a running query']];
  return (
    <div className="m-auto grid max-w-[560px] gap-4 p-6 text-[12px] text-fg-muted">
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5">
        {keys.map(([k, what]) => <div key={what} className="contents"><span className="flex gap-1">{k.map(x => <Kbd key={x}>{x}</Kbd>)}</span><span>{what}</span></div>)}
      </div>
      <div className="text-fg-faint">Prod connections are read-only. Dev connections run anything, each statement committed as it runs, and ask first before an UPDATE or DELETE with no WHERE, a TRUNCATE or a DROP. A SELECT without a LIMIT gets LIMIT {autoLimit}.</div>
      {history.length > 0 && <div className="grid gap-1">
        <div className="section-title !m-0 !h-auto !p-0"><LayoutList size={11} aria-hidden="true" /> Recent on this connection</div>
        {history.map(h => <button key={h.at} className="sql-hist" onClick={() => onOpen(h)}><div className="text-[10.5px] text-fg-faint">{age(h.at)} ago</div><div className="sql-hist-sql">{h.sql}</div></button>)}
      </div>}
    </div>
  );
}

/** The second look before a risky write on dev. Cancel is the default button; running it takes a click or Ctrl+Enter. */
function ConfirmWrite({ reason, statement, alias, onClose, onRun }: { reason: string; statement: string; alias: string; onClose: () => void; onRun: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className="w-[min(620px,94vw)]" onClose={onClose}
      onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onRun(); } }}>
      <h2>Run this on {alias}?</h2>
      <p className="mb-3 text-[12.5px] text-fg">{reason} It commits as soon as it runs.</p>
      <pre className="sql-pre mb-4 max-h-[240px] overflow-auto rounded-lg border border-line bg-raised">{statement}</pre>
      <div className="flex justify-end gap-2">
        <button className="btn" autoFocus onClick={() => ref.current?.close()}>Cancel</button>
        <button className="btn danger" onClick={onRun}>Run it</button>
      </div>
    </dialog>
  );
}
