import { useEffect, useState } from 'react';
import { Bell, KeyRound } from 'lucide-react';
import { api, type AwsStatus } from '../lib/api';
import { timeLeft } from '../lib/format';
import { actions, useStore } from '../lib/store';

/** Bottom strip: fleet counts, AWS credential pill, attention list. */
export function StatusStrip() {
  const snap = useStore(s => s.snapshot);
  const [aws, setAws] = useState<AwsStatus | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => api.awsStatus().then(s => { if (alive) setAws(s); }).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const needs = snap?.sessions.filter(s => s.column === 'needs-you') || [];
  const working = snap?.sessions.filter(s => s.column === 'working').length || 0;
  const left = timeLeft(aws?.expiration || null);
  const errors = Object.entries(snap?.errors || {});

  return (
    <footer className="relative flex items-center gap-3 border-t border-line bg-surface px-3 text-[11px] text-fg-muted">
      <span className="num"><b className="text-fg">{snap?.sessions.length ?? 0}</b> sessions</span>
      <span className="num"><b className="text-fg">{working}</b> working</span>
      {errors.length > 0 && <span className="truncate text-serious" title={errors.map(([k, v]) => `${k}: ${v}`).join('\n')}>{errors.length} collector error{errors.length > 1 ? 's' : ''}</span>}

      {aws?.enabled !== false && (
        <button className={`ml-auto chip ${aws?.run && !aws.run.done ? 'warn' : aws?.needsLogin ? 'crit' : left.level === 'ok' ? 'good' : left.level === 'warn' ? 'warn' : 'crit'}`} onClick={() => actions.go({ kind: 'hub' })} title={aws?.needsLogin ? 'SSO session expired. Open the Hub and click Refresh credentials.' : aws?.arn || 'AWS credentials'}>
          <KeyRound size={11} aria-hidden="true" />
          {aws?.run && !aws.run.done ? `AWS: ${aws.run.state}` : aws?.needsLogin ? 'AWS: login needed' : aws ? `AWS ${left.text}` : 'AWS …'}
        </button>
      )}

      <div className={`relative${aws?.enabled === false ? ' ml-auto' : ''}`}>
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
