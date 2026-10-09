import { useEffect, useState } from 'react';
import { KeyRound, RefreshCw } from 'lucide-react';
import { api, type AwsStatus } from '../lib/api';
import { timeLeft } from '../lib/format';

/** Personal one-click chores. First tile: AWS credentials. */
export function HubView() {
  return (
    <div className="grid min-h-0 flex-1 auto-rows-max content-start gap-4 overflow-y-auto p-5 grid-cols-[repeat(auto-fill,minmax(420px,1fr))]">
      <AwsTile />
    </div>
  );
}

function AwsTile() {
  const [s, setS] = useState<AwsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const running = !!s?.run && !s.run.done;

  useEffect(() => {
    let alive = true;
    const load = (force = false) => api.awsStatus(force).then(x => { if (alive) setS(x); }).catch(() => {});
    load(true);
    const t = setInterval(() => load(false), running ? 1500 : 30000);
    return () => { alive = false; clearInterval(t); };
  }, [running]);

  const start = async (forceLogin: boolean) => {
    setBusy(true);
    try { const run = await api.awsRefresh(forceLogin); setS(prev => prev ? { ...prev, run } : prev); } finally { setBusy(false); }
  };
  if (s && !s.enabled) return (
    <section className="panel grid content-start gap-3 p-4">
      <header className="flex items-center gap-2">
        <KeyRound size={16} className="text-fg-faint" aria-hidden="true" />
        <h2 className="m-0 text-[13px] font-semibold">AWS credentials</h2>
        <span className="chip">off</span>
      </header>
      <p className="m-0 text-[12px] text-fg-faint">Set <code className="mono">aws.profile</code> in <code className="mono">fleet.config.json</code> to turn this on. It needs the AWS CLI and an SSO profile.</p>
    </section>
  );
  const role = timeLeft(s?.expiration || null);
  const sso = timeLeft(s?.ssoExpiresAt || null);
  const tone = (l: 'ok' | 'warn' | 'crit') => l === 'ok' ? 'text-good' : l === 'warn' ? 'text-warn' : 'text-crit';

  return (
    <section className="panel grid content-start gap-3 p-4">
      <header className="flex items-center gap-2">
        <KeyRound size={16} className="text-accent" aria-hidden="true" />
        <h2 className="m-0 text-[13px] font-semibold">AWS credentials</h2>
        <span className="mono text-[11px] text-fg-faint">{s?.profile}</span>
      </header>
      <dl className="kv">
        <dt>Role keys</dt><dd><b className={`num ${tone(role.level)}`}>{s ? role.text : '…'}</b> <span className="text-fg-faint">{s?.expiration ? `until ${new Date(s.expiration).toLocaleString()}` : s?.error || ''}</span></dd>
        <dt>SSO session</dt><dd><b className={`num ${tone(sso.level)}`}>{s ? sso.text : '…'}</b> <span className="text-fg-faint">{!s ? '' : s.ssoExpiresAt ? `token until ${new Date(s.ssoExpiresAt).toLocaleTimeString()}${s.ssoHasRefresh ? ', refresh token present' : ''}` : 'no SSO token cached'}</span></dd>
        <dt>Identity</dt><dd className="mono text-[11px]">{s?.arn || (s?.error ? `not working: ${s.error}` : '…')}</dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <button className="btn primary" disabled={busy || running} onClick={() => start(false)}><RefreshCw size={13} className={running ? 'animate-spin' : ''} aria-hidden="true" /> {running ? `Working: ${s!.run!.state}` : 'Refresh credentials'}</button>
        <button className="btn" disabled={busy || running} onClick={() => start(true)} title="Skip the cached session and do a full SSO login">Force new login</button>
        {running && s!.run!.approveUrl && (s!.run!.state === 'approve' || s!.run!.state === 'approve-manual') && <a className="btn" href={s!.run!.approveUrl} target="_blank" rel="noreferrer">Open approval page</a>}
        {running && <button className="btn" onClick={() => api.awsCancel()}>Cancel</button>}
      </div>
      {s?.needsLogin && <p className="m-0 text-[12px] text-crit">The SSO session has expired, so the timer stopped. Click Refresh credentials to log in once; the timer takes over again after that.</p>}
      <p className="m-0 text-[11px] text-fg-faint">Refresh uses the cached SSO session and needs no browser while that session is alive. When it has expired, a device-code login opens in your browser with the code filled in: two clicks. A timer checks every 10 minutes and refreshes silently an hour before the keys expire, around the clock while Fleet is running.</p>
      {s?.run && <pre className="logs">{s.run.log.map(l => `${new Date(l.at).toLocaleTimeString()}  ${l.line}`).join('\n')}</pre>}
    </section>
  );
}
