import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2';
import type { SqlConfig } from './config.js';
import type { Teleport } from './teleport.js';
import type { SqlLookup, SqlProcess, SqlAlias, SqlColumn, SqlColumnInfo, SqlEvent, SqlHistoryEntry, SqlIndexInfo, SqlInfo, SqlKind, SqlRunRequest, SqlSchema, SqlTab, SqlValue } from '../shared/types.js';
import { classify, classifyWrite, countParams, errorOffset, limitable, split, statementAt, withLimit } from '../shared/sqlClassify.js';

const SYSTEM_DBS = ['mysql', 'sys', 'performance_schema', 'information_schema'];
const BATCH = 200, FLUSH_MS = 80, HISTORY = 500;
const IDLE_MS = 5 * 60 * 1000;
const serverIds = new WeakMap<object, number>();
// The same ids by connection alias, so the process list can mark Fleet's own connections.
const fleetIds = new Map<string, Set<number>>();

interface Run { id: string; alias: string; conn: object | null; cancelled: boolean; timedOut: boolean }
interface SchemaCache extends SqlSchema { columns: Record<string, Record<string, SqlColumnInfo[]>>; indexes: Record<string, SqlIndexInfo[]> }
type Emit = (ev: SqlEvent) => void;

/** Read-only SQL over the Teleport tunnels. One pool per alias; credentials come from the configured .env each time a pool opens and are kept nowhere else.
 *  Every connection is READ ONLY with a statement time cap, and every statement passes the classifier first: either alone has gaps. */
export class SqlManager {
  private pools = new Map<string, mysql.Pool>();
  private runs = new Map<string, Run>();
  private schemas = new Map<string, SchemaCache>();
  private tabs: SqlTab[] = []; private history: SqlHistoryEntry[] = [];
  private persistFile: string | null = null; private saveTimer: NodeJS.Timeout | null = null;

  constructor(public cfg: SqlConfig, private teleport: Teleport, private stateDir: string) {}

  /** Offered connections: the configured aliases that are tunnels, in config order. A prod tunnel is offered only when it points at a reader. */
  aliases(): SqlAlias[] {
    const tunnels = this.teleport.cfg.tunnels || [];
    return this.cfg.aliases.map(a => tunnels.find(t => t.alias === a)).filter((t): t is NonNullable<typeof t> => !!t && (!t.prod || /reader/i.test(t.db)))
      .map(t => ({ alias: t.alias, port: t.port, prod: !!t.prod, label: `${t.alias} · ${t.port}` }));
  }
  info(): SqlInfo {
    const aliases = this.aliases();
    let error: string | null = null;
    if (!aliases.length) error = 'No tunnels to offer. The SQL view uses the Teleport tunnels named in sql.aliases (main-dev, data-dev, main-prd-reader, data-prd-reader by default).';
    const defaultAlias = aliases.find(a => a.alias === this.cfg.defaultAlias)?.alias || aliases[0]?.alias || '';
    return { aliases, defaultAlias, autoLimit: this.cfg.autoLimit, maxRows: this.cfg.maxRows, lookups: this.lookups(), error };
  }
  private alias(name: string): SqlAlias {
    const a = this.aliases().find(x => x.alias === name);
    if (!a) throw new Error(`${name} is not a connection the SQL view offers.`);
    return a;
  }

  // Credentials: what was entered for the connection in the SQL view first (sql.credentialsFile, outside every repo),
  // then sql.credentials in fleet.config.json, then the .env in sql.envFile. Passwords go to the database and nowhere else; the browser only learns whether one is saved.
  private saved(): Record<string, { user: string; password: string }> {
    try { const j = JSON.parse(fs.readFileSync(this.cfg.credentialsFile, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
  }
  private envCreds(alias: string): { user: string; password: string } | null {
    if (!fs.existsSync(this.cfg.envFile)) return null;
    const env: Record<string, string> = {};
    for (const line of fs.readFileSync(this.cfg.envFile, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m) env[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    }
    // data-* tunnels are the data cluster, everything else the main one.
    const pre = alias.startsWith('data') && env.DB_DATA_USERNAME ? 'DB_DATA' : 'DB_MAIN';
    const user = env[`${pre}_USERNAME`] || env.DB_USERNAME || '';
    return user ? { user, password: env[`${pre}_PASSWORD`] || env.DB_PASSWORD || '' } : null;
  }
  private creds(alias: string) {
    const c = this.saved()[alias] || this.cfg.credentials[alias] || this.envCreds(alias);
    if (!c) throw new Error(`No username for ${alias}. Click the key next to the connection to enter one.`);
    return { user: c.user, password: c.password };
  }
  credentials() {
    const saved = this.saved();
    return this.aliases().map(a => {
      const s = saved[a.alias], cf = s ? null : this.cfg.credentials[a.alias], e = s || cf ? null : this.envCreds(a.alias);
      const c = s || cf || e;
      return { alias: a.alias, user: c?.user || '', hasPassword: !!c?.password, source: s ? 'saved' as const : cf ? 'config' as const : e ? 'env' as const : 'none' as const };
    });
  }
  /** Saves a username and, when given, a new password for one connection; an empty password keeps the saved one. `null` forgets the entry. */
  setCredentials(alias: string, v: { user: string; password?: string } | null) {
    this.alias(alias);
    const all = this.saved();
    if (v) {
      const user = String(v.user || '').trim();
      if (!user) throw new Error('Enter a username.');
      all[alias] = { user, password: v.password ? String(v.password) : all[alias]?.password || '' };
    } else delete all[alias];
    fs.mkdirSync(path.dirname(this.cfg.credentialsFile), { recursive: true });
    fs.writeFileSync(this.cfg.credentialsFile, JSON.stringify(all, null, 2), { mode: 0o600 });
    // Open connections still use the old login.
    this.dropPool(alias);
  }
  private connOpts(a: SqlAlias): mysql.ConnectionOptions {
    return { host: '127.0.0.1', port: a.port, ...this.creds(a.alias), charset: 'utf8mb4', connectTimeout: 10000, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false,
      // JSON columns as their text, binary as bytes; everything else as mysql2 reads it with the options above.
      typeCast: (field: any, next: () => unknown) => field.type === 'JSON' ? field.string('utf8') : next() };
  }
  private pool(a: SqlAlias): mysql.Pool {
    let p = this.pools.get(a.alias);
    if (p) return p;
    p = mysql.createPool({ ...this.connOpts(a), connectionLimit: 4, maxIdle: 0, idleTimeout: IDLE_MS, waitForConnections: true, queueLimit: 20 });
    const capSec = Math.ceil(this.cfg.timeoutMs / 1000);
    p.on('connection', conn => {
      // Prod is read-only at the session too; dev connections may write.
      if (a.prod) conn.query('SET SESSION TRANSACTION READ ONLY');
      conn.query(`SET SESSION max_execution_time = ${this.cfg.timeoutMs}`);
      conn.query(`SET SESSION wait_timeout = ${Math.max(capSec * 3, 600)}`);
      // Teleport's proxy answers the handshake itself, so conn.threadId is its id, not the server's; KILL QUERY needs the server's.
      conn.query('SELECT CONNECTION_ID() AS id', (err: any, rows: any) => { if (err) return; const id = Number(rows[0].id); serverIds.set(conn, id); if (!fleetIds.has(a.alias)) fleetIds.set(a.alias, new Set()); fleetIds.get(a.alias)!.add(id); });
    });
    this.pools.set(a.alias, p);
    return p;
  }
  private dropPool(alias: string) { const p = this.pools.get(alias); this.pools.delete(alias); p?.end(() => {}); }

  private getConn(a: SqlAlias): Promise<mysql.PoolConnection> {
    return new Promise((res, rej) => this.pool(a).getConnection((err, c) => err ? rej(err) : res(c)));
  }

  /** Runs `fn` with a connection; when the tunnel is down, restarts it through Teleport once and tries again. */
  private async withConn<T>(a: SqlAlias, fn: (c: mysql.PoolConnection) => Promise<T>, onRetry?: (text: string) => void): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let conn: mysql.PoolConnection | null = null;
      try {
        conn = await this.getConn(a);
        return await fn(conn);
      } catch (err: any) {
        if (attempt > 0 || !tunnelError(err) || err.rowsSent) throw err;
        conn?.destroy(); conn = null;
        this.dropPool(a.alias);
        onRetry?.(`${a.alias} did not answer (${err.code || err.message}). Restarting the tunnel and trying once more…`);
        try { await this.teleport.start(a.alias); }
        catch (e: any) { throw Object.assign(new Error(`${a.alias} is down and the tunnel would not start: ${e.message || e}`), { code: 'TUNNEL' }); }
      } finally { conn?.release(); }
    }
  }

  private queryAll<T = any>(a: SqlAlias, sql: string, params: unknown[] = []): Promise<T[]> {
    return this.withConn(a, c => new Promise((res, rej) => c.query(sql, params, (err, rows) => err ? rej(err) : res(rows as T[]))));
  }

  /** Picks the statement (selection, or the one under the cursor), checks it, limits it, runs it, and streams what comes back.
   *  Prod connections, and any run with `readOnly` (the fleet_sql tool), take reads only; dev connections take any one statement,
   *  and the risky ones (UPDATE or DELETE with no WHERE, TRUNCATE, DROP) only with `confirm`. */
  async run(req: SqlRunRequest, emit: Emit, opts: { maxRows?: number; readOnly?: boolean } = {}): Promise<void> {
    const t0 = Date.now();
    const text = String(req.text || '');
    let stmtText = '', offset = 0;
    const entry: SqlHistoryEntry = { at: t0, alias: req.alias, db: req.db || null, sql: '', rows: null, ms: null, error: null };
    const fail = (message: string, extra: Partial<Extract<SqlEvent, { t: 'error' }>> = {}) => {
      emit({ t: 'error', message, code: null, offset: null, length: 0, line: null, ...extra });
      if (entry.sql) { entry.error = message; entry.ms = Date.now() - t0; this.addHistory(entry); }
    };
    let a: SqlAlias;
    try { a = this.alias(req.alias); } catch (err: any) { return fail(err.message); }
    if (req.selection && req.selection.to > req.selection.from) {
      const body = text.slice(req.selection.from, req.selection.to);
      const all = split(body, { blankLines: false });
      if (all.length !== 1) return fail(all.length ? 'The selection has more than one statement. Select one, or put the cursor in it.' : 'The selection has no statement in it.');
      stmtText = all[0].text; offset = req.selection.from + all[0].start;
    } else {
      const s = statementAt(text, Number(req.cursor) || 0);
      if (!s) return fail('Nothing to run.');
      stmtText = s.text; offset = s.start;
    }
    entry.sql = stmtText;
    const writable = !a.prod && !opts.readOnly;
    const c = writable ? classifyWrite(stmtText) : { ...classify(stmtText), write: false, danger: null };
    if (!c.ok) return fail(c.reason || 'Not a read.');
    // Asked once, answered in the browser: the same request again with confirm set.
    if (c.danger && !req.confirm) return emit({ t: 'error', message: c.danger, code: 'CONFIRM', offset: null, length: 0, line: null });
    const db = req.db ? String(req.db) : null;
    if (db && !/^[\w$]+$/.test(db)) return fail(`Not a database name: ${db}`);

    const maxRows = opts.maxRows || this.cfg.maxRows;
    const appended = limitable(stmtText);
    const limit = req.limit === 'max' ? maxRows : Math.min(this.cfg.autoLimit, maxRows);
    const exec = appended ? withLimit(stmtText, limit) : stmtText;
    const run: Run = { id: randomUUID().slice(0, 8), alias: a.alias, conn: null, cancelled: false, timedOut: false };
    this.runs.set(run.id, run);
    emit({ t: 'start', id: run.id, statement: stmtText, offset });

    let rowCount = 0, truncated = false, affected: number | null = null;
    const timer = setTimeout(() => { run.timedOut = true; this.kill(a, run); }, this.cfg.timeoutMs + 2000);
    try {
      await this.withConn(a, conn => new Promise<void>((resolve, reject) => {
        run.conn = conn;
        if (run.cancelled) return reject(Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' }));
        const go = () => {
          let buf: SqlValue[][] = [], sent = false, failed = false, fields: mysql.FieldPacket[] | null = null;
          const flush = () => { if (buf.length) { emit({ t: 'rows', rows: buf }); buf = []; sent = true; } };
          const tick = setInterval(flush, FLUSH_MS);
          const q = conn.query({ sql: exec, rowsAsArray: true });
          // A write fires 'fields' too, with nothing in it.
          q.on('fields', (f: mysql.FieldPacket[] | undefined) => { if (!f) return; fields = f; emit({ t: 'columns', columns: f.map(column) }); });
          q.on('result', (row: any) => {
            if (!Array.isArray(row)) { if (row && typeof row.affectedRows === 'number') affected = (affected || 0) + row.affectedRows; return; }
            if (rowCount >= maxRows) { if (!truncated) { truncated = true; this.kill(a, run, true); } return; }
            rowCount++;
            buf.push(row.map(cell));
            if (buf.length >= BATCH) flush();
          });
          q.on('error', (err: any) => { failed = true; clearInterval(tick); flush(); err.rowsSent = sent || rowCount > 0 || c.write; reject(err); });
          q.on('end', () => { if (failed) return; clearInterval(tick); flush(); if (!fields) emit({ t: 'columns', columns: [] }); resolve(); });
        };
        if (db) conn.query(`USE \`${db}\``, err => err ? reject(err) : go()); else go();
      }), text => emit({ t: 'notice', text }));
      // A killed SLEEP or a query stopped between rows can still end cleanly; it was stopped all the same.
      if (run.cancelled || run.timedOut) throw Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' });
      const ms = Date.now() - t0;
      emit({ t: 'done', ms, rowCount, truncated, autoLimited: appended && req.limit !== 'max' && rowCount >= limit, affected });
      entry.rows = affected ?? rowCount; entry.ms = ms; this.addHistory(entry);
    } catch (err: any) {
      // Hitting the row cap kills the query on purpose; what was read is the result.
      if (truncated && /interrupted/i.test(String(err.message))) {
        const ms = Date.now() - t0;
        emit({ t: 'done', ms, rowCount, truncated: true, autoLimited: false, affected: null });
        entry.rows = rowCount; entry.ms = ms; this.addHistory(entry);
      } else {
        const msg = run.timedOut ? `Stopped after ${Math.round(this.cfg.timeoutMs / 1000)} s (the SQL view's time limit).`
          : run.cancelled ? 'Cancelled.' : explain(String(err.sqlMessage || err.message || err), a);
        const pos = errorOffset(exec, msg);
        const inStmt = pos.offset != null && pos.offset < stmtText.length;
        fail(msg, { code: err.code || null, line: pos.line, offset: inStmt ? offset + pos.offset! : null, length: inStmt ? pos.length : 0 });
      }
    } finally {
      clearTimeout(timer);
      this.runs.delete(run.id);
    }
  }

  /** Who is connected and what they run, like DBeaver's Session Manager: the server's process list with each open transaction's age.
   *  The connection reading the list leaves itself out. Without the rights to read INNODB_TRX, the plain list. */
  async processes(alias: string): Promise<SqlProcess[]> {
    const a = this.alias(alias);
    let rows: any[];
    try {
      rows = await this.queryAll(a, `SELECT p.ID AS id, p.USER AS user, p.HOST AS host, p.DB AS db, p.COMMAND AS command, p.TIME AS time, p.STATE AS state, p.INFO AS info,
        t.trx_started AS trxStarted, t.trx_rows_locked AS rowsLocked, t.trx_rows_modified AS rowsModified
        FROM information_schema.PROCESSLIST p LEFT JOIN information_schema.INNODB_TRX t ON t.trx_mysql_thread_id = p.ID
        WHERE p.ID <> CONNECTION_ID() ORDER BY p.TIME DESC`);
    } catch {
      rows = (await this.queryAll(a, 'SHOW FULL PROCESSLIST')).map((r: any) => ({ id: r.Id, user: r.User, host: r.Host, db: r.db, command: r.Command, time: r.Time, state: r.State, info: r.Info }));
    }
    const mine = fleetIds.get(a.alias) || new Set<number>();
    return rows.map(r => ({ id: Number(r.id), user: String(r.user ?? ''), host: String(r.host ?? ''), db: r.db ?? null, command: String(r.command ?? ''), time: Number(r.time) || 0,
      state: r.state || null, info: r.info == null ? null : String(r.info), trxStarted: r.trxStarted ?? null,
      rowsLocked: r.rowsLocked == null ? null : Number(r.rowsLocked), rowsModified: r.rowsModified == null ? null : Number(r.rowsModified), fleet: mine.has(Number(r.id)) }));
  }
  /** KILL QUERY (stop the statement, keep the connection) or KILL (end the connection). RDS refuses a plain KILL of another user's thread
   *  unless the login may; then its own procedures, mysql.rds_kill_query and mysql.rds_kill, are tried. Each kill goes into history. */
  async killProcess(alias: string, id: number, mode: 'query' | 'connection'): Promise<{ ok: true; via: string }> {
    const a = this.alias(alias);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Not a process id.');
    const plain = mode === 'query' ? `KILL QUERY ${id}` : `KILL ${id}`;
    const rds = mode === 'query' ? `CALL mysql.rds_kill_query(${id})` : `CALL mysql.rds_kill(${id})`;
    const log = (sql: string, error: string | null) => this.addHistory({ at: Date.now(), alias: a.alias, db: null, sql, rows: null, ms: null, error });
    try { await this.queryAll(a, plain); log(plain, null); return { ok: true, via: plain }; }
    catch (err: any) {
      if (!/denied|not owner|1095/i.test(`${err.code} ${err.errno} ${err.message}`)) { log(plain, err.message); throw err; }
      try { await this.queryAll(a, rds); log(rds, null); return { ok: true, via: rds }; }
      catch (e: any) { log(rds, e.message); throw new Error(`${err.message} (and ${rds}: ${e.message})`); }
    }
  }

  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run) return false;
    run.cancelled = true;
    this.kill(this.alias(run.alias), run);
    return true;
  }
  /** KILL QUERY from a second connection: the running one is busy. */
  private kill(a: SqlAlias, run: Run, quiet = false) {
    // Read now, not at checkout: on a new connection the id query is still in flight when the run starts.
    const id = run.conn ? serverIds.get(run.conn) : undefined;
    if (id == null) { if (run.conn && !quiet) console.error(`sql: no server connection id for a run on ${a.alias}; cannot cancel it`); return; }
    const c = mysql.createConnection(this.connOpts(a));
    c.query(`KILL QUERY ${Number(id)}`, err => { if (err && !quiet) console.error(`sql: KILL QUERY on ${a.alias} failed: ${err.message}`); c.end(() => {}); });
    c.on('error', () => {});
  }

  /** A whole result at once, for the fleet_sql tool. */
  async collect(alias: string, sql: string, maxRows: number) {
    const out = { statement: '', columns: [] as SqlColumn[], rows: [] as SqlValue[][], error: null as string | null, ms: 0, truncated: false, autoLimited: false };
    await this.run({ alias, text: sql, cursor: 0, limit: 'auto' }, ev => {
      if (ev.t === 'start') out.statement = ev.statement;
      else if (ev.t === 'columns') out.columns = ev.columns;
      else if (ev.t === 'rows') out.rows.push(...ev.rows);
      else if (ev.t === 'done') { out.ms = ev.ms; out.truncated = ev.truncated; out.autoLimited = ev.autoLimited; }
      else if (ev.t === 'error') out.error = ev.message;
    }, { maxRows, readOnly: true });
    return out;
  }

  // Schema: databases and tables in one query; columns per database and indexes per table when first asked for.
  // Kept on disk per alias, and thrown away when the tunnel points at another cluster (the dev clone is rebuilt nightly).
  private cacheFile(alias: string) { return path.join(this.stateDir, `sql-schema-${alias.replace(/[^\w.-]/g, '_')}.json`); }
  private async target(alias: string): Promise<string | null> {
    try { return (await this.teleport.status()).tunnels.find(t => t.alias === alias)?.target || null; } catch { return null; }
  }
  private async cached(alias: string, refresh = false): Promise<SchemaCache> {
    const a = this.alias(alias);
    const target = await this.target(alias);
    let c = this.schemas.get(alias);
    if (!c) { try { c = JSON.parse(fs.readFileSync(this.cacheFile(alias), 'utf8')); } catch {} }
    if (c && !refresh && (!target || !c.target || c.target === target)) { this.schemas.set(alias, c); return c; }
    const rows = await this.queryAll<{ TABLE_SCHEMA: string; TABLE_NAME: string; TABLE_TYPE: string; TABLE_ROWS: number | null }>(a,
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN (${SYSTEM_DBS.map(() => '?').join(',')}) ORDER BY TABLE_SCHEMA, TABLE_NAME`, SYSTEM_DBS);
    const dbs = new Map<string, SqlSchema['databases'][number]>();
    for (const r of rows) {
      if (!dbs.has(r.TABLE_SCHEMA)) dbs.set(r.TABLE_SCHEMA, { name: r.TABLE_SCHEMA, tables: [] });
      dbs.get(r.TABLE_SCHEMA)!.tables.push({ name: r.TABLE_NAME, type: r.TABLE_TYPE === 'VIEW' ? 'view' : 'table', rows: r.TABLE_ROWS == null ? null : Number(r.TABLE_ROWS) });
    }
    c = { alias, target, at: Date.now(), databases: [...dbs.values()], columns: {}, indexes: {} };
    this.schemas.set(alias, c); this.saveCache(c);
    return c;
  }
  private saveCache(c: SchemaCache) { try { fs.writeFileSync(this.cacheFile(c.alias), JSON.stringify(c)); } catch {} }

  async schema(alias: string, refresh = false): Promise<SqlSchema> {
    const c = await this.cached(alias, refresh);
    return { alias: c.alias, target: c.target, at: c.at, databases: c.databases };
  }
  async columns(alias: string, db: string): Promise<Record<string, SqlColumnInfo[]>> {
    const c = await this.cached(alias);
    if (c.columns[db]) return c.columns[db];
    const rows = await this.queryAll<{ TABLE_NAME: string; COLUMN_NAME: string; COLUMN_TYPE: string; IS_NULLABLE: string; COLUMN_KEY: string; COLUMN_COMMENT: string }>(this.alias(alias),
      'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION', [db]);
    const out: Record<string, SqlColumnInfo[]> = {};
    for (const r of rows) (out[r.TABLE_NAME] ||= []).push({ name: r.COLUMN_NAME, type: String(r.COLUMN_TYPE), nullable: r.IS_NULLABLE === 'YES', key: r.COLUMN_KEY || '', comment: r.COLUMN_COMMENT || '' });
    c.columns[db] = out; this.saveCache(c);
    return out;
  }
  async indexes(alias: string, db: string, table: string): Promise<SqlIndexInfo[]> {
    const key = `${db}.${table}`;
    const c = await this.cached(alias);
    if (c.indexes[key]) return c.indexes[key];
    if (!/^[\w$]+$/.test(db) || !/^[\w$]+$/.test(table)) throw new Error('Not a table name.');
    const rows = await this.queryAll<{ Key_name: string; Non_unique: number; Column_name: string; Seq_in_index: number }>(this.alias(alias), `SHOW INDEX FROM \`${db}\`.\`${table}\``);
    const byName = new Map<string, SqlIndexInfo>();
    for (const r of [...rows].sort((x, y) => x.Seq_in_index - y.Seq_in_index)) {
      if (!byName.has(r.Key_name)) byName.set(r.Key_name, { name: r.Key_name, unique: Number(r.Non_unique) === 0, columns: [] });
      byName.get(r.Key_name)!.columns.push(r.Column_name);
    }
    c.indexes[key] = [...byName.values()]; this.saveCache(c);
    return c.indexes[key];
  }

  // Lookups: the configured ones (fleet.config.json, or the built-ins), plus the ones made in the SQL view, kept in state/sql-lookups.json
  // and shared by every Fleet instance. One made in the view replaces a configured one of the same name.
  private lookupsFile() { return path.join(this.stateDir, 'sql-lookups.json'); }
  private userLookups(): SqlLookup[] {
    try { const j = JSON.parse(fs.readFileSync(this.lookupsFile(), 'utf8')); return Array.isArray(j) ? j.map((l: SqlLookup) => ({ ...l, source: 'user' as const })) : []; } catch { return []; }
  }
  lookups(): SqlLookup[] {
    const mine = this.userLookups(), names = new Set(mine.map(l => l.name));
    return [...this.cfg.lookups.filter(l => !names.has(l.name)), ...mine];
  }
  /** Saves a lookup made or edited in the SQL view. It must be one read with at least one ?, since lookups run on prod readers too. */
  saveLookup(name: string, v: Partial<SqlLookup>, rename?: string) {
    const n = String(name || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,23}$/.test(n)) throw new Error('The name is what you type in the palette: letters, digits, - or _, starting with a letter (like cb or client).');
    const sql = String(v.sql || '').trim().replace(/;\s*$/, '');
    if (!sql) throw new Error('The lookup needs SQL.');
    if (split(sql, { blankLines: false }).length !== 1) throw new Error('A lookup is one statement.');
    if (!countParams(sql)) throw new Error('Put a ? where the value goes, like WHERE c.case_no = ?. Every ? gets the value.');
    const c = classify(sql);
    if (!c.ok) throw new Error(`Lookups only read: ${c.reason}`);
    const alias = String(v.alias || this.info().defaultAlias);
    this.alias(alias);
    const type = v.type === 'number' ? 'number' : 'text';
    const l: SqlLookup = { name: n, label: String(v.label || '').trim() || n, pattern: type === 'number' ? '^\\d+$' : '^\\S+$', alias, sql, view: v.view === 'grid' ? 'grid' : 'record', type };
    const all = this.userLookups().filter(x => x.name !== n && x.name !== rename).map(({ source: _, ...x }) => x);
    all.push(l);
    fs.writeFileSync(this.lookupsFile(), JSON.stringify(all, null, 2));
    return this.lookups();
  }
  /** Removes a lookup made in the view; a configured one of the same name shows again. */
  deleteLookup(name: string) {
    const all = this.userLookups().filter(x => x.name !== name.toLowerCase()).map(({ source: _, ...x }) => x);
    fs.writeFileSync(this.lookupsFile(), JSON.stringify(all, null, 2));
    return this.lookups();
  }

  /** A lookup turned into a statement. Every ? gets the value through mysql2's escaping, never pasted. */
  lookup(name: string, value: string) {
    const l = this.lookups().find(x => x.name === name.toLowerCase());
    if (!l) throw new Error(`No lookup named ${name}.`);
    const v = value.trim();
    if (!new RegExp(l.pattern).test(v)) throw new Error(`"${v}" does not look like a ${l.label.toLowerCase()} value.`);
    const alias = this.aliases().some(a => a.alias === l.alias) ? l.alias : this.info().defaultAlias;
    // Numbers unquoted for numeric ids, so the comparison uses the index; quoted for text, so a varchar column is not compared to a number.
    const asNumber = l.type ? l.type === 'number' && /^-?\d+$/.test(v) : /^\d+$/.test(v) && l.pattern.includes('\\d');
    const arg = asNumber ? Number(v) : v;
    return { alias, sql: mysql.format(l.sql, Array(countParams(l.sql)).fill(arg)), view: l.view, title: `${l.name} ${v}` };
  }

  // Tabs and history, kept per Fleet port like every other state file so a dev instance never overwrites the daily one's.
  getTabs() { return this.tabs; }
  setTabs(tabs: unknown) {
    if (!Array.isArray(tabs)) throw new Error('tabs must be a list');
    this.tabs = tabs.slice(0, 50).filter((t: any) => t && typeof t.id === 'string').map((t: any): SqlTab => ({
      id: String(t.id).slice(0, 40), title: String(t.title || 'Query').slice(0, 80), alias: String(t.alias || ''), db: t.db ? String(t.db) : null,
      text: String(t.text || '').slice(0, 200000), split: Number.isFinite(t.split) ? Math.min(0.9, Math.max(0.1, Number(t.split))) : undefined,
      ...(t.kind === 'processes' ? { kind: 'processes' as const } : {}) }));
    this.save();
  }
  getHistory() { return this.history; }
  private addHistory(e: SqlHistoryEntry) {
    const last = this.history[0];
    if (last && last.sql === e.sql && last.alias === e.alias) this.history[0] = e; else this.history.unshift(e);
    if (this.history.length > HISTORY) this.history.length = HISTORY;
    this.save();
  }
  persistTo(file: string) {
    this.persistFile = file;
    try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); this.tabs = Array.isArray(s.tabs) ? s.tabs : []; this.history = Array.isArray(s.history) ? s.history : []; } catch {}
  }
  private save() {
    if (!this.persistFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try { fs.writeFileSync(this.persistFile!, JSON.stringify({ tabs: this.tabs, history: this.history })); } catch {}
    }, 500);
  }
}

function tunnelError(err: any): boolean {
  return ['ECONNREFUSED', 'ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'EPIPE', 'PROTOCOL_SEQUENCE_TIMEOUT'].includes(err?.code)
    || [2006, 2013].includes(err?.errno) || /gone away|lost connection|handshake/i.test(String(err?.message || ''));
}

// mysql2 type codes to what the grid needs: alignment and how to sort.
const NUMERIC = new Set([0, 1, 2, 3, 4, 5, 8, 9, 13, 16, 246]);
const DATES = new Set([7, 10, 11, 12, 14, 17, 18, 19]);
const TYPE_NAMES: Record<number, string> = { 0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float', 5: 'double', 7: 'timestamp', 8: 'bigint', 9: 'mediumint', 10: 'date', 11: 'time', 12: 'datetime', 13: 'year', 15: 'varchar', 16: 'bit', 245: 'json', 246: 'decimal', 247: 'enum', 248: 'set', 249: 'tinyblob', 250: 'mediumblob', 251: 'longblob', 252: 'text', 253: 'varchar', 254: 'char', 255: 'geometry' };
function column(f: mysql.FieldPacket): SqlColumn {
  const code = Number((f as any).columnType ?? (f as any).type);
  const binary = Number((f as any).characterSet) === 63;
  const kind: SqlKind = NUMERIC.has(code) ? 'number' : DATES.has(code) ? 'date' : code === 245 ? 'json' : binary && code >= 249 && code <= 254 ? 'blob' : 'string';
  const type = binary && code >= 249 && code <= 252 ? 'blob' : binary && code >= 253 ? 'binary' : TYPE_NAMES[code] || String(code);
  return { name: f.name, table: (f as any).orgTable || f.table || '', kind, type };
}
function cell(v: unknown): SqlValue {
  if (v == null) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.length <= 32 ? `0x${v.toString('hex')}` : `0x${v.subarray(0, 32).toString('hex')}… (${v.length} bytes)`;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Teleport answers some refusals itself, in words that do not say it was Teleport.
function explain(msg: string, a: SqlAlias): string {
  if (/access to db denied/i.test(msg)) return `${msg}\n\nThis came from Teleport, not MySQL: your Teleport role does not let the tunnel's database user into ${a.alias}. Check "tsh status" for your roles, or request access to the ${a.prod ? 'prod ' : ''}database.`;
  return msg;
}
