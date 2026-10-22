import { useEffect, useRef, useState } from 'react';
import { Bell, KeyRound } from 'lucide-react';
import { api, type AwsStatus } from '../lib/api';
import { timeLeft } from '../lib/format';
import { actions, useStore } from '../lib/store';
import { TeleportChip } from './TeleportChip';

/** Bottom strip: fleet counts, Teleport and AWS credential pills, attention list. */
export function StatusStrip() {
  const snap = useStore(s => s.snapshot);
  const [aws, setAws] = useState<AwsStatus | null>(null);
  const [open, setOpen] = useState(false);
  // After a click, check every few seconds (for up to 10 minutes) so the pill turns green as soon as the login lands.
  const [watchUntil, setWatchUntil] = useState(0);

  useEffect(() => {
    let alive = true;
    const watching = watchUntil > Date.now();
    const load = () => api.awsStatus(watching).then(s => { if (alive) setAws(s); }).catch(() => {});
    load();
    const t = setInterval(load, watching ? 5000 : 60000);
    const stop = watching ? setTimeout(() => setWatchUntil(0), watchUntil - Date.now()) : undefined;
    return () => { alive = false; clearInterval(t); clearTimeout(stop); };
  }, [watchUntil]);

  // First-time setup for a machine with no aws.profile: pick one of the CLI's profiles and the hub switches on.
  const [setup, setSetup] = useState<{ profiles: string[]; pick: string; error: string } | null>(null);
  const openSetup = (current?: string) => api.awsProfiles().then(profiles => setSetup({ profiles, pick: current && profiles.includes(current) ? current : profiles[0] || '', error: '' })).catch(() => setSetup({ profiles: [], pick: '', error: '' }));
  const saveSetup = () => setup && api.awsSetup(setup.pick).then(() => { setSetup(null); setWatchUntil(Date.now() + 5000); }).catch(err => setSetup({ ...setup, error: err.message }));
  const switchUser = () => { setSetup(null); api.awsSwitchUser().then(() => setWatchUntil(Date.now() + 600000)).catch(() => {}); };
  // The popover closes on a click anywhere else or on Escape.
  const awsBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!setup) return;
    const away = (e: MouseEvent) => { if (!awsBox.current?.contains(e.target as Node)) setSetup(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setSetup(null); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [!!setup]);
  const runReset = () => { api.awsReset().then(() => setWatchUntil(Date.now() + 600000)).catch(() => {}); };

  const needs = snap?.sessions.filter(s => s.column === 'needs-you') || [];
  const working = snap?.sessions.filter(s => s.column === 'working').length || 0;
  const left = timeLeft(aws?.expiration || null);
  const active = !!aws && !aws.needsLogin && !!aws.arn && !!aws.expiration && Date.parse(aws.expiration) > Date.now();
  const errors = Object.entries(snap?.errors || {});

  return (
    <footer className="statusbar relative">
      <span className="num"><b className="text-fg">{snap?.sessions.length ?? 0}</b> sessions</span>
      <span className="num"><b className="text-fg">{working}</b> working</span>
      {errors.length > 0 && <span className="truncate text-serious" title={errors.map(([k, v]) => `${k}: ${v}`).join('\n')}>{errors.length} collector error{errors.length > 1 ? 's' : ''}</span>}

      <span className="ml-auto" aria-hidden="true" />
      <TeleportChip />
      <div ref={awsBox} className="relative">
        {aws?.enabled !== false && (
        <button onContextMenu={e => { e.preventDefault(); openSetup(aws?.profile); }} className={`chip ${aws ? (active ? 'good' : 'crit') : ''}`} onClick={runReset} title={`Click to refresh AWS credentials. Right-click to switch profile or user. (and run reset.sh for Teleport and the DB tunnels, if you have one).\n${active ? 'AWS credentials are active.' : aws?.needsLogin ? 'SSO session expired.' : 'AWS credentials are not active.'}${aws?.arn ? `\n${aws.arn}` : ''}`}>
          <KeyRound size={11} aria-hidden="true" />
          {aws ? (active ? `AWS ${left.text}` : aws.needsLogin ? 'AWS: login needed' : 'AWS: off') : 'AWS …'}
        </button>
        )}
        {aws?.enabled === false && (
          <button className="chip" onClick={() => setup ? setSetup(null) : openSetup()} title="Set up AWS credential refresh">
            <KeyRound size={11} aria-hidden="true" /> AWS: set up
          </button>
        )}
        {setup && (
          <div className="panel absolute bottom-7 right-0 z-40 w-80 p-3 shadow-[var(--shadow)]">
            <div className="mb-2 text-[12px] font-semibold text-fg">AWS credentials</div>
            {aws?.arn && <p className="m-0 mb-2 break-all text-[11px] text-fg-faint">Signed in as {aws.arn.split('/').pop()}</p>}
            {setup.profiles.length === 0 ? (
              <p className="m-0 text-[12px] text-fg-faint">No AWS CLI profiles found. Install the AWS CLI and run <code className="mono">aws configure sso</code> in a terminal, then click here again.</p>
            ) : (
              <>
                <p className="m-0 mb-2 text-[12px] text-fg-faint">{aws?.enabled === false ? 'Pick the SSO profile to keep fresh. The button then refreshes it silently and only opens a browser when the session has expired.' : 'Profile to keep fresh:'}</p>
                <select className="mb-2 w-full" value={setup.pick} onChange={e => setSetup({ ...setup, pick: e.target.value, error: '' })}>
                  {setup.profiles.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                {setup.error && <p className="m-0 mb-2 text-[12px] text-serious">{setup.error}</p>}
                <div className="flex gap-2">
                  <button className="chip good" onClick={saveSetup}>{aws?.enabled === false ? 'Use this profile' : 'Switch profile'}</button>
                  {aws?.enabled !== false && <button className="chip" onClick={switchUser} title="Signs out of AWS SSO, then logs in again in a private browser window so you can pick a different user.">Sign in as a different user</button>}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="relative">
        <button className="iconbtn" style={{ width: 24, height: 24 }} aria-label={`${needs.length} sessions need you`} aria-expanded={open} onClick={() => setOpen(o => !o)}>
          <Bell size={14} aria-hidden="true" />
          {needs.length > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warn px-1 text-[9px] font-semibold text-bg">{needs.length}</span>}
        </button>
        {open && (
          <div className="panel absolute bottom-7 right-0 z-40 w-80 p-1 shadow-[var(--shadow)]">
            <div className="section-title">Needs you <span className="count num">{needs.length}</span></div>
            {needs.length === 0 && <div className="px-2 pb-2 text-[12px] text-fg-faint">Nothing is waiting on you.</div>}
            {needs.map(s => (
              <button key={s.id} className="row h-auto py-1" onClick={() => { setOpen(false); s.kind === 'dashboard' && s.chatId ? actions.go({ kind: 'chat', chatId: s.chatId, title: s.title }) : actions.go({ kind: 'session', id: s.id }); }}>
                <span className="dot" data-s="needs-you" aria-hidden="true" />
                <span className="grow">
                  <span className="block truncate text-fg">{s.title || s.name}</span>
                  <span className="block truncate text-[11px] text-fg-faint">{s.job?.needs || s.job?.detail || 'waiting on a permission or an answer'}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </footer>
  );
}
