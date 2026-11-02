import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from 'react';
import { ArrowDown, ArrowUp, Ban, ChevronDown, ClipboardCopy, Database, FileCode2, KeyRound, Pause, Play, Plug, RefreshCw, Search, Unplug, X } from 'lucide-react';
import { api, type SqlAlias, type SqlProcess } from '../lib/api';
import { actions } from '../lib/store';
import { useContextMenu } from '../components/ContextMenu';
import { copy } from './copy';

type Key = 'id' | 'user' | 'host' | 'db' | 'command' | 'time' | 'state' | 'trx' | 'info';
// The query comes right after how long it has run; where it came from is at the end, since through Teleport every host is the agent's.
const COLS: { key: Key; label: string; w: string; num?: boolean }[] = [
  { key: 'id', label: 'Id', w: '96px', num: true }, { key: 'user', label: 'User', w: '170px' }, { key: 'db', label: 'DB', w: '80px' },
  { key: 'command', label: 'Command', w: '76px' }, { key: 'time', label: 'Time', w: '64px', num: true }, { key: 'trx', label: 'Trx open', w: '72px', num: true },
  { key: 'info', label: 'Query', w: 'minmax(260px, 1fr)' }, { key: 'state', label: 'State', w: '130px' }, { key: 'host', label: 'Host', w: '150px' },
];
const REFRESH = [0, 2, 5, 10] as const;
const readLs = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const writeLs = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const dur = (s: number) => s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
const trxAge = (p: SqlProcess) => p.trxStarted ? Math.max(0, Math.round((Date.now() - Date.parse(p.trxStarted.replace(' ', 'T'))) / 1000)) : null;
const idle = (p: SqlProcess) => p.command === 'Sleep' || p.command === 'Daemon' || p.command === 'Binlog Dump';

/** The connection's live sessions, like DBeaver's Session Manager: who runs what and for how long, with Kill query and Kill connection. */
export function ProcessesPanel({ alias, aliases, onAlias, onLogin, onOpenQuery }: {
  alias: SqlAlias; aliases: SqlAlias[]; onAlias: (a: string) => void; onLogin: () => void; onOpenQuery: (sql: string) => void;
}) {
  const [rows, setRows] = useState<SqlProcess[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const [every, setEvery] = useState<number>(() => readLs('fleet.sql.proc.every', 5));
  const [hideIdle, setHideIdle] = useState<boolean>(() => readLs('fleet.sql.proc.hideIdle', true));
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: 'time', dir: -1 });
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [kill, setKill] = useState<{ ids: number[]; mode: 'query' | 'connection' } | null>(null);
  const [view, setView] = useState<SqlProcess | null>(null);
  const [menu, openMenu] = useContextMenu();
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true; setLoading(true);
    try { setRows(await api.sqlProcesses(alias.alias)); setError(null); setAt(Date.now()); }
    catch (err: any) { setError(err.message); }
    finally { busy.current = false; setLoading(false); }
  }, [alias.alias]);
  useEffect(() => { setRows([]); setPicked(new Set()); load(); }, [load]);
  // Live: refreshes on the chosen interval, but not while the window is hidden or a kill is being confirmed.
  useEffect(() => {
    if (!every || kill) return;
    const h = setInterval(() => { if (!document.hidden) load(); }, every * 1000);
    return () => clearInterval(h);
  }, [every, load, kill]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = rows.filter(p => (!hideIdle || !idle(p) || p.trxStarted) && (!t || [p.id, p.user, p.host, p.db, p.command, p.state, p.info].some(v => v != null && String(v).toLowerCase().includes(t))));
    const val = (p: SqlProcess): string | number => sort.key === 'trx' ? trxAge(p) ?? -1 : sort.key === 'id' || sort.key === 'time' ? p[sort.key] : String(p[sort.key] ?? '');
    return list.sort((a, b) => { const x = val(a), y = val(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sort.dir; });
  }, [rows, q, hideIdle, sort]);
  const sleeping = rows.filter(p => idle(p) && !p.trxStarted).length;
  // Checked rows that are still there after a refresh.
  const pickedRows = shown.filter(p => picked.has(p.id));
  const toggle = (id: number) => setPicked(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const doKill = async () => {
    if (!kill) return;
    const { ids, mode } = kill;
    setKill(null);
    const results = await Promise.allSettled(ids.map(id => api.sqlKill(alias.alias, id, mode)));
    const failed = results.map((r, i) => r.status === 'rejected' ? `${ids[i]}: ${(r.reason as Error).message}` : null).filter(Boolean);
    if (failed.length) actions.toast(`Could not kill ${failed.join('; ')}`, 'error');
    else actions.toast(`${mode === 'query' ? 'Stopped the query on' : 'Ended'} ${ids.length === 1 ? `process ${ids[0]}` : `${ids.length} processes`}`);
    setPicked(new Set());
    load();
  };
  const rowMenu = (e: RMouseEvent, p: SqlProcess) => openMenu(e, [
    { label: 'Kill query', icon: Ban, disabled: !p.info, onSelect: () => setKill({ ids: [p.id], mode: 'query' }) },
    { label: 'Kill connection', icon: Unplug, danger: true, onSelect: () => setKill({ ids: [p.id], mode: 'connection' }) },
    'separator',
    { label: 'Show the full query', icon: FileCode2, disabled: !p.info, onSelect: () => setView(p) },
    { label: 'Open the query in a new tab', icon: Play, disabled: !p.info, onSelect: () => onOpenQuery(p.info!) },
    { label: 'Copy the query', icon: ClipboardCopy, disabled: !p.info, onSelect: async () => { await copy(p.info!); actions.toast('Copied'); } },
    { label: 'Copy the id', onSelect: async () => { await copy(String(p.id)); actions.toast('Copied'); } },
  ]);
  const head = (c: typeof COLS[number]) => (
    <button key={c.key} className={`proc-h ${c.num ? 'num' : ''}`} onClick={() => setSort(s => ({ key: c.key, dir: s.key === c.key ? (s.dir === 1 ? -1 : 1) : c.num || c.key === 'trx' ? -1 : 1 }))}>
      <span className="truncate">{c.label}</span>{sort.key === c.key && (sort.dir > 0 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </button>
  );
  const grid = { gridTemplateColumns: `32px ${COLS.map(c => c.w).join(' ')} 64px` };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="sql-toolbar">
        <label className={`sql-conn ${alias.prod ? 'prod' : 'dev'}`}>
          <Database size={13} aria-hidden="true" />
          <select value={alias.alias} onChange={e => onAlias(e.target.value)} aria-label="Connection">
            {aliases.map(a => <option key={a.alias} value={a.alias}>{a.alias}{a.prod ? ' (PRD)' : ''}</option>)}
          </select>
          <ChevronDown size={12} aria-hidden="true" />
        </label>
        <button className="iconbtn h-7 w-7 flex-none" onClick={onLogin} title={`Username and password for ${alias.alias}`} aria-label={`Login for ${alias.alias}`}><KeyRound size={14} /></button>
        <span className="sql-tsep" />
        <div className="sql-search">
          <Search size={12} aria-hidden="true" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter: user, host, query…" aria-label="Filter processes" />
          {q && <button aria-label="Clear filter" onClick={() => setQ('')}><X size={11} /></button>}
        </div>
        <button className={`chip ${hideIdle ? 'ticket' : ''}`} onClick={() => { setHideIdle(h => { writeLs('fleet.sql.proc.hideIdle', !h); return !h; }); }}
          title="Sleeping connections without an open transaction">{hideIdle ? `${sleeping} sleeping hidden` : 'showing sleeping'}</button>
        <span className="grow" />
        {pickedRows.length > 0 && <>
          <span className="text-[11.5px] text-fg-muted">{pickedRows.length} checked</span>
          <button className="btn sm" onClick={() => setKill({ ids: pickedRows.map(p => p.id), mode: 'query' })}><Ban size={13} aria-hidden="true" /> Kill queries</button>
          <button className="btn sm danger" onClick={() => setKill({ ids: pickedRows.map(p => p.id), mode: 'connection' })}><Unplug size={13} aria-hidden="true" /> Kill connections</button>
          <span className="sql-tsep" />
        </>}
        <div className="sql-seg" role="group" aria-label="Refresh every">
          {REFRESH.map(s => <button key={s} aria-selected={every === s} onClick={() => { setEvery(s); writeLs('fleet.sql.proc.every', s); }} title={s ? `Refresh every ${s} s` : 'Refresh by hand only'}>{s ? `${s}s` : <Pause size={12} aria-label="Paused" />}</button>)}
        </div>
        <button className="iconbtn h-7 w-7 flex-none" onClick={load} title="Refresh now" aria-label="Refresh now"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button>
      </div>
      {error && <div className="sql-banner crit" role="alert"><span className="grow mono whitespace-pre-wrap">{error}</span>{/denied|access/i.test(error) && <button className="btn sm" onClick={onLogin}><KeyRound size={12} aria-hidden="true" /> Set login</button>}</div>}

      <div className="proc-table" role="table" aria-label={`Processes on ${alias.alias}`}>
        <div className="proc-row proc-head" style={grid} role="row">
          <span className="proc-c">
            <input type="checkbox" aria-label="Check all" checked={shown.length > 0 && shown.every(p => picked.has(p.id))} onChange={e => setPicked(e.target.checked ? new Set(shown.map(p => p.id)) : new Set())} />
          </span>
          {COLS.map(head)}
          <span />
        </div>
        {shown.map(p => {
          const age = trxAge(p);
          const level = idle(p) ? '' : p.time >= 300 ? 'crit' : p.time >= 30 ? 'warn' : '';
          return (
            <div key={p.id} className={`proc-row ${picked.has(p.id) ? 'is-picked' : ''}`} style={grid} role="row" onContextMenu={e => rowMenu(e, p)} onDoubleClick={() => p.info && setView(p)}>
              <span className="proc-c"><input type="checkbox" aria-label={`Check ${p.id}`} checked={picked.has(p.id)} onChange={() => toggle(p.id)} /></span>
              <span className="proc-c num">{p.id}{p.fleet && <span className="chip ml-1 !h-4 !px-1.5 !text-[9.5px]" title="One of Fleet's own connections">Fleet</span>}</span>
              <span className="proc-c truncate" title={p.user}>{p.user}</span>
              <span className="proc-c truncate">{p.db ?? <span className="sql-null">NULL</span>}</span>
              <span className={`proc-c ${idle(p) ? 'text-fg-faint' : ''}`}>{p.command}</span>
              <span className={`proc-c num ${level === 'crit' ? 'text-crit font-semibold' : level === 'warn' ? 'text-warn font-semibold' : ''}`}>{dur(p.time)}</span>
              <span className={`proc-c num ${age != null && age >= 60 ? 'text-warn font-semibold' : ''}`} title={p.trxStarted ? `Open since ${p.trxStarted}${p.rowsLocked != null ? ` · ${p.rowsLocked} rows locked` : ''}${p.rowsModified != null ? ` · ${p.rowsModified} modified` : ''}` : 'No open transaction'}>{age != null ? dur(age) : ''}</span>
              <span className="proc-c truncate mono" title={p.info || ''}>{p.info ? p.info.replace(/\s+/g, ' ') : ''}</span>
              <span className="proc-c truncate text-fg-muted" title={p.state || ''}>{p.state}</span>
              <span className="proc-c truncate text-fg-muted" title={p.host}>{p.host}</span>
              <span className="proc-c proc-actions">
                <button className="iconbtn h-6 w-6" title="Kill query" aria-label={`Kill the query of ${p.id}`} disabled={!p.info} onClick={() => setKill({ ids: [p.id], mode: 'query' })}><Ban size={13} /></button>
                <button className="iconbtn h-6 w-6 hover:!text-crit" title="Kill connection" aria-label={`Kill connection ${p.id}`} onClick={() => setKill({ ids: [p.id], mode: 'connection' })}><Unplug size={13} /></button>
              </span>
            </div>
          );
        })}
        {!shown.length && !error && <div className="p-6 text-center text-[12px] text-fg-faint">{loading && !rows.length ? 'Reading the process list…' : rows.length ? 'Nothing matches. Sleeping connections are hidden; click the chip to show them.' : 'No other connections.'}</div>}
      </div>

      <div className={`sql-status ${alias.prod ? 'prod' : ''}`} role="status">
        <span className={`sql-env ${alias.prod ? 'prod' : 'dev'}`}><Plug size={11} aria-hidden="true" /> {alias.prod ? 'PRD reader' : 'DEV'}</span>
        <span className="text-fg-muted">{alias.alias}</span>
        <span className="grow" />
        <span className="num">{shown.length} shown · {rows.length} total</span>
        {at && <span className="text-fg-muted">{every ? `live, every ${every} s` : 'paused'} · read {new Date(at).toLocaleTimeString()}</span>}
      </div>

      {kill && <ConfirmKill ids={kill.ids} mode={kill.mode} rows={rows} alias={alias} onClose={() => setKill(null)} onKill={doKill} />}
      {view && <QueryModal p={view} onClose={() => setView(null)} onOpen={() => { onOpenQuery(view.info!); setView(null); }} />}
      {menu}
    </div>
  );
}

function ConfirmKill({ ids, mode, rows, alias, onClose, onKill }: { ids: number[]; mode: 'query' | 'connection'; rows: SqlProcess[]; alias: SqlAlias; onClose: () => void; onKill: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const list = ids.map(id => rows.find(r => r.id === id) || { id, user: '?', host: '', info: null, time: 0, command: '' } as unknown as SqlProcess);
  const what = mode === 'query' ? 'Stop the running statement; the connection stays open.' : 'End the connection; anything it has not committed is rolled back.';
  return (
    <dialog ref={ref} className="w-[min(680px,94vw)]" onClose={onClose}>
      <h2>{mode === 'query' ? 'Kill query' : 'Kill connection'}{ids.length > 1 ? ` on ${ids.length} processes` : ` ${ids[0]}`} on {alias.alias}?</h2>
      <p className="mb-2 text-[12.5px]">{what}</p>
      {alias.prod && <p className="mb-2 rounded-md border border-crit bg-crit-soft px-3 py-2 text-[12px]">This is production (the reader). These may be other people's or other systems' queries.</p>}
      <div className="mb-4 max-h-[260px] overflow-auto rounded-lg border border-line">
        {list.map(p => (
          <div key={p.id} className="border-b border-line px-3 py-1.5 text-[12px] last:border-0">
            <div className="flex gap-2 text-fg-muted"><b className="num text-fg">{p.id}</b><span>{p.user}</span><span className="truncate">{p.host}</span><span className="grow" /><span className="num">{p.command} · {dur(p.time)}</span></div>
            {p.info && <div className="mono mt-0.5 truncate text-[11.5px]">{p.info.replace(/\s+/g, ' ')}</div>}
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <button className="btn" autoFocus onClick={() => ref.current?.close()}>Cancel</button>
        <button className="btn danger" onClick={onKill}>{mode === 'query' ? <Ban size={13} aria-hidden="true" /> : <Unplug size={13} aria-hidden="true" />} {mode === 'query' ? 'Kill query' : 'Kill connection'}{ids.length > 1 ? ` × ${ids.length}` : ''}</button>
      </div>
    </dialog>
  );
}

function QueryModal({ p, onClose, onOpen }: { p: SqlProcess; onClose: () => void; onOpen: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className="w-[min(820px,94vw)]" onClose={onClose}>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="!m-0">Process {p.id}</h2>
        <span className="text-[11.5px] text-fg-muted">{p.user} · {p.host} · {p.command} · {dur(p.time)}{p.state ? ` · ${p.state}` : ''}</span>
        <span className="grow" />
        <button className="iconbtn" aria-label="Close" onClick={() => ref.current?.close()}><X size={15} /></button>
      </div>
      <pre className="sql-pre mb-4 max-h-[50vh] overflow-auto rounded-lg border border-line bg-raised">{p.info}</pre>
      <div className="flex justify-end gap-2">
        <button className="btn" onClick={async () => { await copy(p.info || ''); actions.toast('Copied'); }}><ClipboardCopy size={13} aria-hidden="true" /> Copy</button>
        <button className="btn primary" onClick={onOpen}><Play size={13} aria-hidden="true" /> Open in a new tab</button>
      </div>
    </dialog>
  );
}
