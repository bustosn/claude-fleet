import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import type { TeleportConfig } from './config.js';
import type { TeleportRun, TeleportSetupInfo, TeleportStatus, TeleportTunnel, TunnelSpec } from '../shared/types.js';

const IS_WIN = process.platform === 'win32';
const DB_LIST_MS = 10 * 60000, STATUS_MS = 15000, TICK_MS = 2 * 60000, SESSION_MS = 10000;

interface TshProc { pid: number; db: string; port: number }
interface DbEntry { name: string; label: string; stage: string; endpoint: string }

// Teleport session and DB tunnels. Tunnels are found again from the process table on every look (the tsh command line says which db and port),
// so tunnels started by reset.sh are adopted, and the ones Fleet starts survive a server restart.
export class Teleport {
  cfg: TeleportConfig; run: TeleportRun | null = null; login: ChildProcess | null = null;
  events: { at: number; line: string }[] = [];
  private logDir: string; private pidFile: string; private ours = new Set<number>();
  private dbs: DbEntry[] = []; private dbsAt = 0; private dbsError: string | null = null;
  private cached: TeleportStatus | null = null; private cachedAt = 0;
  // tsh status takes about a second; inside one operation (a batch start reads the state before and after) it is reused briefly.
  // Login and logout clear it.
  private sessionCache: { at: number; value: Awaited<ReturnType<Teleport['session']>> } | null = null;
  // Keyed by alias, kept with the PID it was taken against, so a tunnel replaced outside Fleet (reset.sh) does not show an old result.
  /** Tunnels stopped for a logout, started again after the next successful login. */
  private reopen: string[] = [];
  private probes = new Map<string, { pid: number | null; at: number; ok: boolean; detail: string }>();
  private busy = new Set<string>();

  configFile: string | null; private timer: NodeJS.Timeout | null = null;

  constructor(cfg: Partial<TeleportConfig>, stateDir: string, configFile: string | null = null) {
    this.configFile = configFile;
    this.cfg = { proxy: '', user: '', auth: '', tsh: '', dbUser: 'developer', tunnels: [], autoRepoint: true, restartAfterLogin: true, ...cfg };
    this.cfg.tsh = this.cfg.tsh || defaultTsh();
    this.logDir = path.join(stateDir, 'teleport'); fs.mkdirSync(this.logDir, { recursive: true });
    this.pidFile = path.join(this.logDir, 'pids.json');
    try { for (const p of JSON.parse(fs.readFileSync(this.pidFile, 'utf8'))) this.ours.add(Number(p)); } catch {}
    this.startTimer();
  }

  get enabled() { return !!this.cfg.proxy; }
  private startTimer() {
    if (this.enabled && !this.timer) this.timer = setInterval(() => this.tick().catch(err => this.note(`check failed: ${short(err)}`)), TICK_MS);
  }

  // What setup can fill in for you: is tsh installed, which proxies it has logged in to, which tunnels are already running
  // (reset.sh's, say) and, when logged in, the databases you can reach. Everything comes back as ready-made tunnel rows.
  async setupInfo(): Promise<TeleportSetupInfo> {
    let version: string | null = null;
    try { version = (await tsh(this.cfg.tsh, ['version', '--client'], 10000)).match(/Teleport v(\S+)/)?.[1] || 'unknown'; } catch {}
    const info: TeleportSetupInfo = { tsh: this.cfg.tsh, version, proxies: [], loggedIn: false, user: null,
      current: { proxy: this.cfg.proxy, user: this.cfg.user, tunnels: this.cfg.tunnels }, running: [], databases: [], dbError: null };
    if (!version) return info;
    try { for (const f of fs.readdirSync(path.join(os.homedir(), '.tsh'))) if (f.endsWith('.yaml')) info.proxies.push(f.slice(0, -5)); } catch {}
    const s = await this.session();
    info.loggedIn = s.loggedIn && !s.expired; info.user = s.user;
    if (info.loggedIn) {
      try { const host = new URL(JSON.parse(await tsh(this.cfg.tsh, ['status', '--format=json'])).active.profile_url).hostname; if (!info.proxies.includes(host)) info.proxies.unshift(host); } catch {}
      await this.loadDbs();
      info.dbError = this.dbsError;
      info.databases = this.dbs.filter(d => !/-(old|restore)(-|$)|-custom-/.test(d.name)).map(d => ({ name: d.name, label: d.label, stage: d.stage, endpoint: d.endpoint, suggest: suggest(d.name, d.label, 0, d.stage) }));
    }
    const used = new Set<number>();
    info.running = (await tshProcs()).sort((a, b) => a.port - b.port).filter(p => !used.has(p.port) && used.add(p.port)).map(p => suggest(p.db, '', p.port));
    return info;
  }

  /** Save the proxy and tunnels to fleet.config.json and switch on. Replaces the tunnel list as a whole. */
  async setup(input: { proxy: string; user?: string; tunnels: TunnelSpec[] }) {
    const proxy = String(input.proxy || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:443$/, '');
    if (!/^[\w.-]+(:\d+)?$/.test(proxy)) throw new Error('Enter the Teleport proxy address, like teleport.example.com');
    const tunnels: TunnelSpec[] = [];
    for (const t of input.tunnels || []) {
      const alias = String(t.alias || '').trim(), db = String(t.db || '').trim(), port = Number(t.port);
      if (!/^[\w.-]+$/.test(alias)) throw new Error(`"${alias}" is not a usable tunnel name: letters, numbers, dot, dash and underscore only`);
      if (!db) throw new Error(`${alias}: pick a database`);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${alias}: the port must be a number from 1024 to 65535`);
      if (tunnels.some(x => x.alias === alias)) throw new Error(`Two tunnels are named ${alias}`);
      if (tunnels.some(x => x.port === port)) throw new Error(`Two tunnels use port ${port}`);
      tunnels.push({ alias, db, port, ...(typeof t.prod === 'boolean' ? { prod: t.prod } : {}), ...(t.dbUser ? { dbUser: String(t.dbUser) } : {}) });
    }
    const user = String(input.user || '').trim();
    if (this.configFile) {
      const raw = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      raw.teleport = { ...(raw.teleport || {}), proxy, user, tunnels };
      fs.writeFileSync(this.configFile, JSON.stringify(raw, null, 2) + '\n');
    }
    Object.assign(this.cfg, { proxy, user, tunnels });
    this.cachedAt = 0; this.dbsAt = 0;
    this.note(`setup saved: ${proxy}, ${tunnels.length} tunnel${tunnels.length === 1 ? '' : 's'}`);
    this.startTimer();
  }
  private spec(alias: string) { return this.cfg.tunnels.find(t => t.alias === alias) || null; }
  private isProd(t: TunnelSpec) { return t.prod ?? /(^|-)(prd|prod)(-|$)/.test(`${t.alias}-${t.db}`); }

  note(line: string) { this.events.push({ at: Date.now(), line }); if (this.events.length > 100) this.events.shift(); }

  async status(force = false): Promise<TeleportStatus> {
    if (!this.enabled) return { enabled: false, proxy: '', tsh: this.cfg.tsh, session: null, tunnels: [], dbListAt: null, dbListError: null, run: null, events: [] };
    if (!force && this.cached && Date.now() - this.cachedAt < STATUS_MS) return { ...this.cached, run: this.run, events: this.events.slice(-30) };
    if (!this.sessionCache || Date.now() - this.sessionCache.at > SESSION_MS) this.sessionCache = { at: Date.now(), value: await this.session() };
    const session = this.sessionCache.value;
    const live = session.loggedIn && !session.expired;
    // tsh db ls is a round trip to the proxy, so it is not part of a forced look: it reloads when old, after a login, and at setup.
    if (live && Date.now() - this.dbsAt > DB_LIST_MS) await this.loadDbs();
    const [procs, listeners] = await Promise.all([tshProcs(), listening()]);
    const alive = new Set(procs.map(p => p.pid));
    for (const p of [...this.ours]) if (!alive.has(p)) this.ours.delete(p);
    this.savePids();
    const tunnels = this.cfg.tunnels.map(t => this.view(t, procs, listeners, live));
    this.cached = { enabled: true, proxy: this.cfg.proxy, tsh: this.cfg.tsh, session, tunnels, dbListAt: this.dbsAt || null, dbListError: this.dbsError, run: this.run, events: [] };
    this.cachedAt = Date.now();
    return { ...this.cached, events: this.events.slice(-30) };
  }

  private async session(): Promise<TeleportStatus['session'] & {}> {
    try {
      const j = JSON.parse(await tsh(this.cfg.tsh, ['status', '--format=json']));
      const a = j.active || {};
      const until = a.valid_until || null;
      return { loggedIn: !!a.username, user: a.username || null, roles: a.roles || [], validUntil: until, expired: !until || Date.parse(until) <= Date.now(), error: null };
    } catch (err) {
      const msg = short(err);
      return { loggedIn: false, user: null, roles: [], validUntil: null, expired: true, error: /not logged in|expired/i.test(msg) ? null : msg };
    }
  }

  // tsh exits 1 when one leaf cluster denies access but still prints the rest, so the JSON is read off a failed run too.
  private async loadDbs() {
    let out = '';
    try { out = await tsh(this.cfg.tsh, ['db', 'ls', '--all', '--format=json'], 60000); }
    catch (err: any) { out = String(err?.stdout || ''); if (!out.trim().startsWith('[')) { this.dbsError = short(err); return; } }
    try {
      this.dbs = (JSON.parse(out) as any[]).map(x => x.database || x).map((d: any) => ({
        name: d.metadata?.name || '', label: d.metadata?.labels?.Name || '', stage: d.metadata?.labels?.STAGE || d.metadata?.labels?.Stage || '', endpoint: d.metadata?.labels?.['endpoint-type'] || '',
      })).filter(d => d.name);
      this.dbsAt = Date.now(); this.dbsError = null;
    } catch (err) { this.dbsError = `could not read tsh db ls: ${short(err)}`; }
  }

  // A pattern with * picks the newest match (the dev clusters are re-created nightly with the date in the name); anything else is used as written.
  // A running tunnel may name its db by the full resource name or by its Name label (reset.sh uses the label), so both count as the same db.
  private resolve(t: TunnelSpec): { target: string | null; same: (db: string) => boolean; matches: (db: string) => boolean } {
    // Before the db list loads, a short name still counts when the full name is it plus the -rds-<region>-<account> suffix.
    const is = (e: DbEntry | undefined, fallback: string) => (db: string) => db === fallback || (e ? db === e.name || db === e.label : fallback.startsWith(`${db}-rds-`));
    if (!t.db.includes('*')) {
      const e = this.dbs.find(d => d.name === t.db) || this.dbs.find(d => d.label === t.db && d.endpoint === 'primary');
      return { target: t.db, same: is(e, t.db), matches: is(e, t.db) };
    }
    const re = new RegExp(`^${t.db.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    const hits = this.dbs.filter(d => re.test(d.name)).sort((a, b) => a.name.localeCompare(b.name));
    const e = hits.at(-1);
    return { target: e?.name || null, same: e ? is(e, e.name) : () => false, matches: db => re.test(db) };
  }

  private probe_(alias: string, pid: number | null) {
    const p = this.probes.get(alias);
    return p && p.pid === pid ? { at: p.at, ok: p.ok, detail: p.detail } : null;
  }

  private view(t: TunnelSpec, procs: TshProc[], listeners: Map<number, number>, live: boolean): TeleportTunnel {
    const { target, same, matches } = this.resolve(t);
    const proc = procs.find(p => p.port === t.port) || null;
    const holder = listeners.get(t.port) ?? null;
    const base = { alias: t.alias, port: t.port, db: t.db, prod: this.isProd(t), target, pid: proc?.pid ?? holder, runningDb: proc?.db ?? null,
      owner: proc ? (this.ours.has(proc.pid) ? 'fleet' as const : 'external' as const) : null, probe: this.probe_(t.alias, proc?.pid ?? null) };
    if (this.busy.has(t.alias)) return { ...base, state: 'starting', note: 'starting' };
    if (!proc && holder) return { ...base, state: 'busy', note: `port ${t.port} is held by PID ${holder}, which is not a tsh tunnel` };
    if (!proc) return { ...base, state: target ? 'down' : 'missing', note: target ? 'not running' : `no database matches ${t.db}${this.dbsAt ? '' : ' (database list not loaded yet)'}` };
    if (!holder) return { ...base, state: 'down', note: `tsh (PID ${proc.pid}) is running but nothing listens on ${t.port}` };
    if (!live) return { ...base, state: 'expired', note: 'the Teleport session has expired, so connections through this tunnel fail' };
    if (target && !same(proc.db)) {
      return matches(proc.db) ? { ...base, state: 'stale', note: `points at ${proc.db}; the newest is ${target}` } : { ...base, state: 'other', note: `points at ${proc.db}, not ${t.db}` };
    }
    return { ...base, state: 'up', note: proc.db };
  }

  // Background check: re-point dev tunnels that still aim at yesterday's cluster. Never logs in and never touches prod tunnels.
  async tick() {
    if (this.login) return;
    const s = await this.status(true);
    if (!this.cfg.autoRepoint || !s.session?.loggedIn || s.session.expired) return;
    const stale = s.tunnels.filter(t => t.state === 'stale' && !t.prod);
    for (const t of stale) this.note(`${t.alias}: ${t.note}; re-pointing it`);
    if (stale.length) for (const r of await this.startMany(stale.map(t => t.alias))) if (r.error) this.note(`${r.alias}: re-point failed: ${r.error}`);
  }

  /** Start or restart one tunnel on its configured port, aimed at the current target. */
  async start(alias: string): Promise<TeleportTunnel> {
    const [r] = await this.startMany([alias]);
    if (r.error) throw new Error(r.error);
    return r.tunnel!;
  }

  /** Start or restart several tunnels at once: one look at the state, the old processes stopped together, the new ones launched
   *  together, and one wait for all their ports. Done one by one this took 5-8 s a tunnel, mostly re-reading the state each time. */
  async startMany(aliases: string[]): Promise<{ alias: string; ok: boolean; detail: string; error?: string; tunnel?: TeleportTunnel }[]> {
    const errors = new Map<string, string>();
    for (const a of aliases) {
      if (!this.spec(a)) errors.set(a, `No tunnel named ${a}. Configured: ${this.cfg.tunnels.map(x => x.alias).join(', ') || 'none'}`);
      else if (this.busy.has(a)) errors.set(a, `${a} is already starting`);
    }
    const s = await this.status(true);
    if (!s.session?.loggedIn || s.session.expired) for (const a of aliases) if (!errors.has(a)) errors.set(a, 'The Teleport session has expired. Log in first.');
    const plan = aliases.filter(a => !errors.has(a)).map(a => ({ t: this.spec(a)!, cur: s.tunnels.find(x => x.alias === a)! })).filter(({ t, cur }) => {
      if (!cur.target) errors.set(t.alias, cur.note); else if (cur.state === 'busy') errors.set(t.alias, cur.note); else return true;
      return false;
    });
    for (const { t } of plan) this.busy.add(t.alias);
    try {
      const old = plan.filter(p => p.cur.pid && p.cur.runningDb);
      for (const { t, cur } of old) this.note(`${t.alias}: stopping PID ${cur.pid} (${cur.runningDb})`);
      await Promise.all(old.map(p => kill(p.cur.pid!)));
      if (old.length) await waitPorts(old.map(p => p.t.port), false, 5000);
      for (const { t, cur } of plan) {
        const log = fs.openSync(path.join(this.logDir, `${t.alias}.log`), 'a');
        fs.writeSync(log, `\n--- ${new Date().toISOString()} ${cur.target} on ${t.port}\n`);
        // Detached, so a server restart (tsx watch, npm run restart) does not drop the tunnel.
        const p = spawn(this.cfg.tsh, ['proxy', 'db', cur.target!, '--tunnel', `--db-user=${t.dbUser || this.cfg.dbUser}`, `--port=${t.port}`],
          { detached: true, windowsHide: true, stdio: ['ignore', log, log] });
        fs.closeSync(log);
        p.on('error', err => this.note(`${t.alias}: could not run tsh: ${err.message}`));
        if (p.pid) this.ours.add(p.pid);
        p.unref();
      }
      this.savePids();
      const up = plan.length ? await waitPorts(plan.map(p => p.t.port), true, 15000) : new Set<number>();
      for (const { t, cur } of plan) {
        this.probes.delete(t.alias);
        this.note(up.has(t.port) ? `${t.alias}: listening on ${t.port} -> ${cur.target}` : `${t.alias}: tsh started but ${t.port} is not listening yet; see state/teleport/${t.alias}.log`);
      }
    } finally { for (const { t } of plan) this.busy.delete(t.alias); this.cachedAt = 0; }
    const after = plan.length ? await this.status(true) : s;
    return aliases.map(a => {
      const tunnel = after.tunnels.find(x => x.alias === a), error = errors.get(a);
      return error ? { alias: a, ok: false, detail: error, error } : { alias: a, ok: tunnel?.state === 'up', detail: tunnel?.note || '', tunnel };
    });
  }

  async stop(alias: string) {
    const t = this.spec(alias); if (!t) throw new Error(`No tunnel named ${alias}`);
    const cur = (await this.status(true)).tunnels.find(x => x.alias === alias)!;
    if (!cur.runningDb || !cur.pid) return cur;
    await kill(cur.pid); await waitPort(t.port, false, 5000);
    this.note(`${alias}: stopped`); this.cachedAt = 0;
    return (await this.status(true)).tunnels.find(x => x.alias === alias)!;
  }

  /** Bring every tunnel to `up`: start what is down, re-point what is stale. Prod tunnels only with includeProd. */
  async startAll(includeProd: boolean) {
    const s = await this.status(true);
    const todo = s.tunnels.filter(t => ['down', 'stale', 'other'].includes(t.state) && (includeProd || !t.prod));
    return (await this.startMany(todo.map(t => t.alias))).map(({ alias, ok, detail }) => ({ alias, ok, detail }));
  }

  // A real round trip: connect through the tunnel and read the MySQL greeting. Only on request, since every probe is a session in the Teleport audit log.
  async probe(alias?: string) {
    const s = await this.status(true);
    const list = s.tunnels.filter(t => (alias ? t.alias === alias : true) && t.runningDb);
    await Promise.all(list.map(async t => { this.probes.set(t.alias, { pid: t.pid, at: Date.now(), ...(await greet(t.port)) }); }));
    this.cachedAt = 0;
    return (await this.status()).tunnels.filter(t => !alias || t.alias === alias);
  }

  /** tsh login in the background. tsh opens the sign-in page itself; the URL is kept on the run in case it does not.
   *  force logs out first: tsh login on a session that is still valid just reuses it, so "Log in again" would change nothing. */
  startLogin(force = false): TeleportRun {
    if (this.run && !this.run.done) return this.run;
    const args = ['login', `--proxy=${this.cfg.proxy}`, ...(this.cfg.user ? [`--user=${this.cfg.user}`] : []), ...(this.cfg.auth ? [`--auth=${this.cfg.auth}`] : [])];
    const run: TeleportRun = { id: Date.now().toString(36), startedAt: Date.now(), done: false, ok: null, state: 'login', log: [], url: null, error: null, restarted: [] };
    this.run = run;
    const log = (l: string) => { run.log.push({ at: Date.now(), line: l }); if (run.log.length > 200) run.log.shift(); };
    const fail = (error: string) => { Object.assign(run, { done: true, ok: false, state: 'failed', error }); this.note(`login failed: ${error}`); };
    (async () => {
      const cur = await this.session(), before = cur.validUntil;
      // A profile tsh cannot read (a logout that half-failed leaves a scrambled key) gets the same clean-out as a forced login.
      if ((force && cur.loggedIn) || cur.error) {
        if (cur.error) log(`tsh cannot read its profile (${cur.error}); clearing it`);
        // Stop the tunnels first. On Windows a running tsh holds the key file open, so tsh logout overwrites the key, fails to delete it,
        // and leaves a profile no tsh command can read. reset.sh kills every tsh before logging out for the same reason.
        const procs = await tshProcs();
        for (const t of this.cfg.tunnels) if (procs.some(p => p.port === t.port) && !this.reopen.includes(t.alias)) this.reopen.push(t.alias);
        if (procs.length) log(`Stopping ${procs.length} tunnel${procs.length === 1 ? '' : 's'} so tsh can remove the old keys; they restart after the sign-in`);
        for (const p of procs) await kill(p.pid);
        if (procs.length) await waitPort(procs[0].port, false, 5000);
        // Plain "tsh logout" clears every profile. With --user it would default to the OS user (nikolas.bustos, not nikolasbustos) and do nothing.
        log('tsh logout');
        try { const o = await tsh(this.cfg.tsh, ['logout'], 30000); for (const l of o.split('\n')) if (l.trim()) log(l.trim()); } catch (err) { log(`logout: ${short(err)}`); }
        this.cachedAt = 0; this.sessionCache = null;
        let left = await this.session();
        // tsh logout reads the profile first, so it cannot clear one whose key is scrambled. Move that key folder aside; the next plain tsh logout clears it.
        if (left.error) {
          const dir = path.join(os.homedir(), '.tsh', 'keys', this.cfg.proxy.replace(/:\d+$/, ''));
          const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
          try { fs.renameSync(dir, `${dir}.broken-${stamp}`); log(`Moved the unreadable keys to ${path.basename(dir)}.broken-${stamp}`); left = await this.session(); }
          catch (err) { log(`could not move ${dir}: ${short(err)}`); }
        }
        if (left.loggedIn && !left.expired) return fail(`tsh logout left the session in place (valid until ${left.validUntil}). Close Teleport Connect if it is open, then try again.`);
        if (left.error) return fail(`tsh still cannot read its profile after logout: ${left.error}. Close Teleport Connect if it is open, then try again.`);
      }
      log(`tsh ${args.join(' ')}`);
      log('A Teleport sign-in page opens in your browser. Pick the sign-in option you normally use (GitHub).');
      const p = spawn(this.cfg.tsh, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.login = p;
      let buf = '';
      const scan = (c: Buffer) => {
        const s = c.toString().replace(/\r/g, ''); buf += s;
        for (const l of s.split('\n')) if (l.trim()) log(l.trim());
        const m = buf.match(/https?:\/\/127\.0\.0\.1:\d+\/\S+/); if (m && !run.url) run.url = m[0];
      };
      p.stdout!.on('data', scan); p.stderr!.on('data', scan);
      const timer = setTimeout(() => { log('timed out after 5 minutes'); p.kill(); }, 300000);
      p.on('error', err => { clearTimeout(timer); this.login = null; fail(`could not run tsh: ${err.message}`); });
      p.on('exit', async code => {
        clearTimeout(timer); this.login = null; this.cachedAt = 0; this.sessionCache = null;
        if (code !== 0) return fail((buf.trim().split('\n').slice(-2).join(' | ') || `tsh login exited ${code}`) + (this.reopen.length ? `. ${this.reopen.length} tunnels are stopped until you log in.` : ''));
        const after = (await this.session()).validUntil;
        // Same expiry: tsh kept the existing session, so the tunnels already hold the current certificates.
        if (after && after === before) {
          log('The session was still valid, so tsh kept it. Nothing to restart.');
          return Object.assign(run, { done: true, ok: true, state: 'done' });
        }
        this.note(`logged in to Teleport until ${after}`);
        run.state = 'tunnels';
        try {
          this.dbsAt = 0;
          const s = await this.status(true);
          // Tunnels started before the login hold the old certificates, so they are restarted along with the stale ones.
          // Plus the ones stopped for the logout, here or in an earlier attempt whose sign-in did not finish.
          const todo = s.tunnels.filter(t => this.reopen.includes(t.alias) || (t.runningDb && (this.cfg.restartAfterLogin || t.state === 'stale')));
          if (todo.length) log(`Starting ${todo.length} tunnel${todo.length === 1 ? '' : 's'}`);
          for (const r of await this.startMany(todo.map(t => t.alias))) {
            const state = r.error ? 'failed' : r.tunnel?.state || 'unknown';
            run.restarted.push(`${r.alias}: ${state}`); log(`${r.alias}: ${state} (${r.detail})`);
          }
          this.reopen = [];
          Object.assign(run, { done: true, ok: true, state: 'done' });
        } catch (err) { fail(`logged in, but restarting tunnels failed: ${short(err)}`); }
      });
    })().catch(err => fail(short(err)));
    return run;
  }

  cancelLogin() { this.login?.kill(); }

  private savePids() { try { fs.writeFileSync(this.pidFile, JSON.stringify([...this.ours])); } catch {} }
}

function defaultTsh() {
  for (const p of IS_WIN ? ['C:/Program Files/teleport/tsh.exe'] : ['/usr/local/bin/tsh', '/opt/homebrew/bin/tsh']) if (fs.existsSync(p)) return p;
  return 'tsh';
}

function tsh(bin: string, args: string[], timeout = 20000): Promise<string> {
  return new Promise((resolve, reject) => execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    (err, stdout, stderr) => err ? reject(Object.assign(err, { stdout, stderr })) : resolve(String(stdout))));
}
const sh = (cmd: string, args: string[]) => tsh(cmd, args, 20000).catch(() => '');

// Every running `tsh proxy db`, with the db and port from its command line.
async function tshProcs(): Promise<TshProc[]> {
  const out = IS_WIN
    ? await sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "name='tsh.exe'" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`])
    : await sh('ps', ['-axww', '-o', 'pid=,command=']);
  const procs: TshProc[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/); if (!m || !/\btsh(\.exe)?["']?\s/.test(m[2] + ' ')) continue;
    const db = m[2].match(/\bproxy\s+db\s+(?:--\S+\s+)*([^\s-][^\s]*)/)?.[1], port = m[2].match(/--port[=\s](\d+)/)?.[1];
    if (db && port) procs.push({ pid: Number(m[1]), db, port: Number(port) });
  }
  return procs;
}

// Listening local TCP ports and the PID holding each. Read from the OS so a check never opens a connection (and a Teleport session).
async function listening(): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (IS_WIN) {
    for (const l of (await sh('netstat', ['-ano', '-p', 'TCP'])).split(/\r?\n/)) {
      const m = l.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i); if (m) map.set(Number(m[2]), Number(m[3]));
    }
  } else {
    for (const l of (await sh('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'])).split('\n').reduce((acc, l) => {
      if (l.startsWith('p')) acc.pid = Number(l.slice(1)); else if (l.startsWith('n')) acc.rows.push(`${acc.pid} ${l.slice(1)}`); return acc;
    }, { pid: 0, rows: [] as string[] }).rows) { const m = l.match(/^(\d+) .*:(\d+)$/); if (m) map.set(Number(m[2]), Number(m[1])); }
  }
  return map;
}

// Waits until every port is listening (up) or free (!up), or the time runs out. Returns the ports that got there.
async function waitPorts(ports: number[], up: boolean, ms: number): Promise<Set<number>> {
  const until = Date.now() + ms, done = new Set<number>();
  while (true) {
    const l = await listening();
    for (const p of ports) if (l.has(p) === up) done.add(p);
    if (done.size === ports.length || Date.now() >= until) return done;
    await new Promise(r => setTimeout(r, 400));
  }
}

async function waitPort(port: number, up: boolean, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if ((await listening()).has(port) === up) return true; await new Promise(r => setTimeout(r, 700)); }
  return false;
}

async function kill(pid: number) {
  if (IS_WIN) await sh('taskkill', ['/PID', String(pid), '/F']);
  else try { process.kill(pid, 'SIGTERM'); } catch {}
}

// MySQL sends its greeting first: protocol 10 means the server answered; 0xff is an error packet with a message.
function greet(port: number): Promise<{ ok: boolean; detail: string }> {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const end = (ok: boolean, detail: string) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); resolve({ ok, detail }); };
    const timer = setTimeout(() => end(false, 'no answer from the database within 10s'), 10000);
    sock.once('data', (b: Buffer) => {
      if (b[4] === 0x0a) end(true, `MySQL ${b.subarray(5, b.indexOf(0, 5)).toString()}`);
      else if (b[4] === 0xff) end(false, b.subarray(7).toString().replace(/^#\w{5}/, '').trim() || 'error packet');
      else end(true, 'answered');
    });
    sock.once('error', err => end(false, err.message));
    sock.once('close', () => end(false, 'the tunnel closed the connection before the database answered'));
  });
}

function short(err: any): string { return String(err?.stderr || err?.message || err).replace(/\r/g, '').trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300); }

// A tunnel row for a database: a short alias, and for a nightly-recreated cluster (a timestamp in the name) a pattern that follows it.
// Prod comes from the STAGE label when there is one, else from prd/prod in the name. Port 0 means "pick one" and is left for the UI.
function suggest(name: string, label: string, port: number, stage = ''): TunnelSpec {
  const base = (label && name.startsWith(label) ? label + name.slice(label.length) : name).replace(/-rds(-aurora)?-[a-z]+-[a-z]+-\d-\d+$/, '');
  const dated = /-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}/.exec(name);
  const db = dated ? name.slice(0, dated.index) + '-*' : name;
  const alias = base.replace(/-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}.*$/, '').replace(/-aurora-cluster(-\d+)?/, '').replace(/^-+|-+$/g, '') || base;
  return { alias, db, port, prod: stage ? /^(prd|prod)$/i.test(stage) : /(^|-)(prd|prod)(-|$)/.test(alias) };
}
