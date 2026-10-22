import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { api, type TeleportSetupInfo, type TunnelSpec } from '../lib/api';

/** Teleport setup: the proxy and the tunnel list, prefilled from what tsh already knows on this machine. Saved to fleet.config.json. */
export function TeleportSetup({ firstTime, onDone }: { firstTime: boolean; onDone: () => void }) {
  const [info, setInfo] = useState<TeleportSetupInfo | null>(null);
  const [proxy, setProxy] = useState('');
  const [rows, setRows] = useState<TunnelSpec[]>([]);
  const [pick, setPick] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.teleportSetupInfo().then(i => {
      setInfo(i);
      setProxy(i.current.proxy || i.proxies[0] || '');
      // An existing list is edited as it is; a first setup starts from the tunnels already running, if any.
      setRows(i.current.tunnels.length ? i.current.tunnels : i.running);
    }).catch(e => setErr((e as Error).message));
  }, []);

  if (!info) return <div className="p-1 text-[12px] text-fg-faint">{err || 'Looking for tsh, its profiles and running tunnels…'}</div>;

  if (!info.version) return (
    <div className="text-[12px] text-fg-faint">
      <p className="m-0 mb-2">tsh is not installed{info.tsh !== 'tsh' ? <> at <code className="mono">{info.tsh}</code></> : ''}. Install the Teleport client, log in once with <code className="mono">tsh login --proxy=&lt;your proxy&gt;</code>, then click here again.</p>
      <a className="text-accent underline" href="https://goteleport.com/download/" target="_blank" rel="noreferrer">Download Teleport</a>
      <p className="m-0 mt-2">If it is installed somewhere else, set <code className="mono">teleport.tsh</code> in fleet.config.json.</p>
    </div>
  );

  const ports = new Set(rows.map(r => r.port));
  const nextPort = () => { let p = Math.max(3315, ...rows.map(r => r.port)) + 1; while (ports.has(p)) p++; return p; };
  const set = (i: number, patch: Partial<TunnelSpec>) => setRows(rows.map((r, j) => j === i ? { ...r, ...patch } : r));
  const newRunning = info.running.filter(r => !ports.has(r.port));
  const db = info.databases.find(d => d.name === pick);
  const add = () => {
    if (!db) return;
    let alias = db.suggest.alias, n = 2;
    while (rows.some(r => r.alias === alias)) alias = `${db.suggest.alias}-${n++}`;
    setRows([...rows, { ...db.suggest, alias, port: nextPort() }]); setPick('');
  };
  const save = () => {
    setSaving(true); setErr(null);
    api.teleportSetup({ proxy, tunnels: rows }).then(onDone).catch(e => setErr((e as Error).message)).finally(() => setSaving(false));
  };

  return (
    <div className="text-[12px]">
      <div className="mb-2 font-semibold text-fg">Teleport {firstTime ? 'setup' : 'tunnels'}</div>
      {firstTime && <p className="m-0 mb-2 text-fg-faint">Fleet keeps your Teleport login and DB tunnels up: it starts them, moves dev tunnels to the newest nightly cluster, and lets chats fix a broken one.</p>}

      <label className="mb-1 block text-fg-faint">Proxy</label>
      <input className="input mb-2 w-full" list="tp-proxies" placeholder="teleport.example.com" value={proxy} onChange={e => setProxy(e.target.value)} />
      <datalist id="tp-proxies">{info.proxies.map(p => <option key={p} value={p} />)}</datalist>

      <div className="mb-1 flex items-center text-fg-faint">
        <span className="grow">Tunnels <span className="num">({rows.length})</span></span>
        {newRunning.length > 0 && <button className="chip" onClick={() => setRows([...rows, ...newRunning])} title={newRunning.map(r => `${r.alias} :${r.port}`).join('\n')}>Import {newRunning.length} running</button>}
      </div>
      <div className="mb-2 max-h-[260px] overflow-y-auto">
        {rows.length === 0 && <p className="m-0 py-1 text-fg-faint">No tunnels yet. Add one from the list below{info.loggedIn ? '' : ' after you log in'}.</p>}
        {rows.map((r, i) => (
          <div key={i} className="mb-1 flex items-center gap-1" title={r.db}>
            <input className="input h-[26px] w-[130px] px-2" value={r.alias} onChange={e => set(i, { alias: e.target.value })} aria-label="Name" />
            <input className="input h-[26px] min-w-0 grow px-2 text-[11px] text-fg-muted" value={r.db} onChange={e => set(i, { db: e.target.value })} aria-label="Database (a * follows the newest match)" />
            <input className="input num h-[26px] w-[64px] px-2" inputMode="numeric" value={r.port || ''} onChange={e => set(i, { port: Number(e.target.value.replace(/\D/g, '')) })} aria-label="Local port" />
            <label className="flex items-center gap-1 text-[10px] text-warn" title="Prod tunnels are never started or re-pointed on their own, and need a confirm to open">
              <input type="checkbox" checked={!!r.prod} onChange={e => set(i, { prod: e.target.checked })} />PROD
            </label>
            <button className="iconbtn" style={{ width: 22, height: 22 }} aria-label={`Remove ${r.alias}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}><X size={12} /></button>
          </div>
        ))}
      </div>

      {info.loggedIn ? (
        <div className="mb-2 flex gap-1">
          <select className="input h-[26px] min-w-0 grow px-2" value={pick} onChange={e => setPick(e.target.value)}>
            <option value="">Add a database…</option>
            {info.databases.map(d => <option key={d.name} value={d.name}>{d.stage ? `[${d.stage}] ` : ''}{d.suggest.db}{d.endpoint && d.endpoint !== 'primary' ? ` (${d.endpoint})` : ''}</option>)}
          </select>
          <button className="btn sm" disabled={!db} onClick={add}><Plus size={12} />Add</button>
        </div>
      ) : (
        <p className="m-0 mb-2 text-fg-faint">Not logged in to Teleport, so the database list is not available yet. Save the proxy, log in from the chip, then right-click it to add tunnels.</p>
      )}
      {info.dbError && <p className="m-0 mb-2 text-warn" title={info.dbError}>Some databases could not be listed: {info.dbError}</p>}

      {err && <p className="m-0 mb-2 text-serious">{err}</p>}
      <div className="flex gap-2">
        <button className="chip good" disabled={saving || !proxy.trim()} onClick={save}>{saving ? 'Saving…' : firstTime ? 'Turn on Teleport' : 'Save'}</button>
        <button className="chip" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}
