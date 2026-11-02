import { useEffect, useRef, useState, type FormEvent } from 'react';
import { KeyRound, X } from 'lucide-react';
import { api, type SqlCredential } from '../lib/api';
import { actions } from '../lib/store';

/** The username and password one connection logs in with, as in DBeaver's connection settings.
 *  Saved in your profile (~/.fleet/sql-credentials.json), not in any repo; the password is never sent back here. */
export function CredentialsDialog({ alias, prod, onClose, onSaved }: { alias: string; prod: boolean; onClose: () => void; onSaved: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [cur, setCur] = useState<SqlCredential | null>(null);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => {
    api.sqlCredentials().then(all => { const c = all.find(x => x.alias === alias) || null; setCur(c); setUser(c?.source === 'saved' ? c.user : ''); }).catch(err => actions.toast(err.message, 'error'));
  }, [alias]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!user.trim()) return;
    setBusy(true);
    try { await api.sqlSetCredentials(alias, user.trim(), password || undefined); actions.toast(`Saved the login for ${alias}`); onSaved(); ref.current?.close(); }
    catch (err: any) { actions.toast(err.message, 'error'); setBusy(false); }
  };
  const forget = async () => {
    setBusy(true);
    try { await api.sqlForgetCredentials(alias); actions.toast(`${alias} uses the .env login again`); onSaved(); ref.current?.close(); }
    catch (err: any) { actions.toast(err.message, 'error'); setBusy(false); }
  };

  return (
    <dialog ref={ref} onClose={onClose}>
      <form onSubmit={save}>
        <div className="mb-3 flex items-center gap-2">
          <KeyRound size={15} className={prod ? 'text-crit' : 'text-good'} aria-hidden="true" />
          <h2 className="!m-0">Login for {alias}</h2>
          <span className="grow" />
          <button type="button" className="iconbtn" aria-label="Close" onClick={() => ref.current?.close()}><X size={15} /></button>
        </div>
        <p className="mb-3 text-[12px] text-fg-muted">
          {cur?.source === 'saved' ? <>Saved login: <b className="mono text-fg">{cur.user}</b>{cur.hasPassword ? ' with a password' : ' without a password'}.</>
            : cur?.source === 'config' ? <>Using <b className="mono text-fg">{cur.user}</b> from sql.credentials in fleet.config.json. Saving here overrides it for this connection.</>
            : cur?.source === 'env' ? <>Using <b className="mono text-fg">{cur.user}</b> from the .env file. Enter one here to use a different login for this connection.</>
              : 'No login yet for this connection.'}
        </p>
        <label>Username
          <input className="input mono" value={user} onChange={e => setUser(e.target.value)} autoFocus autoComplete="off" spellCheck={false} placeholder="the username DBeaver uses" />
        </label>
        <label>Password
          <input className="input mono" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password"
            placeholder={cur?.source === 'saved' && cur.hasPassword ? 'saved; leave empty to keep it' : ''} />
        </label>
        <p className="mb-3 text-[11px] text-fg-faint">Kept in your profile at ~/.fleet/sql-credentials.json, outside every repo. Fleet never shows the password again.</p>
        <div className="flex items-center gap-2">
          {cur?.source === 'saved' && <button type="button" className="btn ghost" onClick={forget} disabled={busy}>Forget</button>}
          <span className="grow" />
          <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !user.trim()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </dialog>
  );
}
