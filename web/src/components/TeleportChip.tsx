import { useEffect, useRef, useState } from 'react';
import { Cable, Play, RotateCw, Settings, Square, Stethoscope } from 'lucide-react';
import { api, type TeleportStatus, type TeleportTunnel } from '../lib/api';
import { timeLeft } from '../lib/format';
import { TeleportSetup } from './TeleportSetup';

const COLOR: Record<TeleportTunnel['state'], string> = {
  up: 'var(--good)', starting: 'var(--accent)', stale: 'var(--warn)', other: 'var(--warn)', down: 'var(--crit)', busy: 'var(--crit)', expired: 'var(--crit)', missing: 'var(--fg-faint)',
};

/** Status-strip chip for the Teleport session, with a panel to log in and start, restart, stop or check the DB tunnels.
 *  Without a proxy configured it offers setup instead, like the AWS pill; right-click edits the setup later. */
export function TeleportChip() {
  const [st, setSt] = useState<TeleportStatus | null>(null);
  const [open, setOpen] = useState<null | 'panel' | 'setup'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const running = !!st?.run && !st.run.done;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [!!open]);

  useEffect(() => {
    let alive = true;
    const load = () => api.teleportStatus().then(s => { if (alive) setSt(s); }).catch(() => {});
    load();
    const t = setInterval(load, open === 'panel' || running || busy ? 3000 : 60000);
    return () => { alive = false; clearInterval(t); };
  }, [open, running, busy]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); api.teleportStatus(true).then(setSt).catch(() => {}); }
  };
  const start = (t: TeleportTunnel) => {
    if (t.prod && !t.runningDb && !confirm(`Open a tunnel to ${t.alias} (prod) on port ${t.port}?`)) return;
    act(t.alias, () => api.tunnelStart(t.alias));
  };

  const toggle = (what: 'panel' | 'setup') => setOpen(o => o === what ? null : what);
  const setupDone = () => { setOpen(null); api.teleportStatus(true).then(setSt).catch(() => {}); };
  const setupPanel = open === 'setup' && st && (
    <div className="panel absolute bottom-7 right-0 z-40 w-[560px] p-3 shadow-[var(--shadow)]">
      <TeleportSetup firstTime={!st.enabled} onDone={setupDone} />
    </div>
  );

  if (st && !st.enabled) return (
    <div ref={box} className="relative">
      <button className="chip" aria-expanded={open === 'setup'} onClick={() => toggle('setup')} title="Set up Teleport login and DB tunnels">
        <Cable size={11} aria-hidden="true" /> Teleport: set up
      </button>
      {setupPanel}
    </div>
  );

  const s = st?.session;
  const live = !!s?.loggedIn && !s.expired;
  const left = timeLeft(s?.validUntil || null);
  const bad = st?.tunnels.filter(t => t.state !== 'up' && t.state !== 'missing' && t.state !== 'starting').length || 0;
  const level = !st ? '' : !live || left.level === 'crit' ? 'crit' : bad || left.level === 'warn' ? 'warn' : 'good';
  const label = !st ? 'Teleport …' : running ? 'Teleport: signing in' : !live ? 'Teleport: log in' : `Teleport ${left.text}${bad ? ` · ${bad} down` : ''}`;

  return (
    <div ref={box} className="relative">
      <button className={`chip ${level}`} aria-expanded={open === 'panel'} onClick={() => toggle('panel')} onContextMenu={e => { e.preventDefault(); toggle('setup'); }}
        title={`${live ? `Teleport session for ${s!.user} until ${new Date(s!.validUntil!).toLocaleTimeString()}` : 'Teleport session expired or not logged in'}
Right-click to edit the proxy and tunnels.`}>
        <Cable size={11} aria-hidden="true" />{label}
      </button>
      {setupPanel}
      {open === 'panel' && st && (
        <div className="panel absolute bottom-7 right-0 z-40 w-[460px] p-1 shadow-[var(--shadow)]">
          <div className="flex items-center gap-2 px-2 pt-1.5">
            <span className="grow truncate text-[12px] text-fg">{live ? <>{s!.user} · <span className="text-fg-muted">{left.text} left</span></> : s?.error || 'Not logged in'}</span>
            <button className={`btn sm ${live ? 'ghost' : 'primary'}`} disabled={running} title={live ? 'Sign out and in again for a fresh session. Tunnels drop until the sign-in finishes, then restart.' : undefined} onClick={() => act('login', () => api.teleportLogin(live))}>{live ? 'Log in again' : 'Log in'}</button>
            <button className="iconbtn" style={{ width: 22, height: 22 }} title="Edit the proxy and tunnels" aria-label="Teleport setup" onClick={() => setOpen('setup')}><Settings size={12} /></button>
          </div>

          {st.run && (running || !st.run.ok) && (
            <div className="mx-2 mt-1.5 rounded-md bg-raised/60 px-2 py-1.5 text-[11px] text-fg-muted">
              <div className="flex items-center gap-2">
                <span className="grow">{running ? (st.run.state === 'tunnels' ? 'Logged in. Restarting tunnels…' : 'Waiting for the sign-in in your browser…') : `Login failed: ${st.run.error}`}</span>
                {running && <button className="btn ghost sm" onClick={() => api.teleportCancel()}>Cancel</button>}
              </div>
              {running && st.run.url && <a className="block truncate text-accent underline" href={st.run.url} target="_blank" rel="noreferrer">Open the sign-in page</a>}
            </div>
          )}

          <div className="section-title">
            Tunnels <span className="count num">{st.tunnels.filter(t => t.state === 'up').length}/{st.tunnels.length} up</span>
            <button className="iconbtn" style={{ width: 22, height: 22 }} title="Check: connect through each running tunnel and read the database greeting" disabled={!!busy} onClick={() => act('probe', () => api.tunnelProbe())}><Stethoscope size={12} /></button>
            <button className="iconbtn" style={{ width: 22, height: 22 }} title="Start every non-prod tunnel that is down or stale" disabled={!!busy || !live} onClick={() => act('all', () => api.tunnelStartAll(false))}><Play size={12} /></button>
          </div>
          {st.tunnels.length === 0 && <div className="px-2 pb-2 text-[12px] text-fg-faint">No tunnels in fleet.config.json (teleport.tunnels).</div>}
          {st.tunnels.map(t => (
            <div key={t.alias} className="row tall" title={`${t.note}${t.target ? `\ntarget: ${t.target}` : ''}${t.pid ? `\nPID ${t.pid}${t.owner ? ` (${t.owner === 'fleet' ? 'started by Fleet' : 'started outside Fleet'})` : ''}` : ''}`}>
              <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: COLOR[t.state] }} aria-label={t.state} />
              <span className="grow">
                <span className="block truncate text-fg">{t.alias} <span className="num text-fg-faint">:{t.port}</span>{t.prod && <span className="ml-1 text-[10px] text-warn">PROD</span>}</span>
                <span className="block truncate text-[11px] text-fg-faint">
                  {busy === t.alias ? 'working…' : t.state === 'up' ? 'up' : t.note}
                  {t.probe && <span className={t.probe.ok ? 'text-good' : 'text-crit'}> · {t.probe.ok ? '✓' : '✗'} {t.probe.detail}</span>}
                </span>
              </span>
              <button className="iconbtn" style={{ width: 22, height: 22 }} disabled={!!busy || !live || !t.target || t.state === 'busy'} title={t.runningDb ? 'Restart' : 'Start'} onClick={() => start(t)}>
                {t.runningDb ? <RotateCw size={12} /> : <Play size={12} />}
              </button>
              <button className="iconbtn" style={{ width: 22, height: 22 }} disabled={!!busy || !t.runningDb} title="Stop" onClick={() => act(t.alias, () => api.tunnelStop(t.alias))}><Square size={11} /></button>
            </div>
          ))}

          {err && <div className="px-2 py-1 text-[11px] text-crit">{err}</div>}
          {st.dbListError && <div className="px-2 py-1 text-[11px] text-warn" title={st.dbListError}>Database list: {st.dbListError}</div>}
          {st.events.length > 0 && (
            <div className="mt-1 border-t border-line px-2 py-1.5 text-[10.5px] leading-snug text-fg-faint">
              {st.events.slice(-4).map(e => <div key={e.at + e.line} className="truncate" title={e.line}>{new Date(e.at).toLocaleTimeString()} {e.line}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
