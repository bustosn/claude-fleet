import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { HerdrAgent, HerdrState, HerdrStatus, HerdrWorkspace } from '../shared/types.js';

const CALL_TIMEOUT_MS = 2000;
const POLL_MS = 3000;
const IDLE_POLL_MS = 15000;

/** herdr on PATH, then the places its installer and cargo put it. */
export function findHerdr(): string | null {
  const exe = process.platform === 'win32' ? ['herdr.exe', 'herdr.cmd', 'herdr.bat'] : ['herdr'];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.cargo', 'bin'));
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'herdr'));
  for (const d of dirs) for (const e of exe) { const p = path.join(d, e); try { if (fs.statSync(p).isFile()) return p; } catch {} }
  return null;
}

/** herdr's API socket for the default session. On Windows it is a named pipe called `\\.\pipe\` plus the socket file's path. */
function socketPath(): string | null {
  if (process.platform === 'win32') {
    const dir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return `\\\\.\\pipe\\${path.join(dir, 'herdr', 'herdr.sock')}`;
  }
  const candidates = [
    process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, 'herdr', 'herdr.sock'),
    path.join(os.homedir(), '.config', 'herdr', 'herdr.sock'),
    path.join(os.homedir(), 'Library', 'Application Support', 'herdr', 'herdr.sock'),
  ].filter((p): p is string => !!p);
  return candidates.find(p => fs.existsSync(p)) || null;
}

class NotRunning extends Error { constructor() { super('herdr is not running'); } }

/** One request per connection: herdr answers a JSON line and closes. */
function call(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = socketPath();
    if (!sock) return reject(new NotRunning());
    const conn = net.connect(sock);
    let buf = '', done = false;
    const finish = (err: Error | null, value?: unknown) => { if (done) return; done = true; clearTimeout(timer); conn.destroy(); err ? reject(err) : resolve(value); };
    const timer = setTimeout(() => finish(new Error(`herdr did not answer ${method} within ${timeoutMs} ms`)), timeoutMs);
    conn.on('connect', () => conn.write(JSON.stringify({ id: 'fleet', method, params }) + '\n'));
    conn.on('data', d => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let msg: any; try { msg = JSON.parse(buf.slice(0, nl)); } catch { return finish(new Error(`herdr's answer to ${method} did not parse`)); }
      if (msg.error) return finish(new Error(`herdr refused ${method}: ${msg.error.message || msg.error.code || 'unknown'}`));
      finish(null, msg.result ?? {});
    });
    conn.on('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new NotRunning() : e));
    conn.on('close', () => finish(new Error(`herdr closed the connection without answering ${method}`)));
  });
}

const norm = (p?: string | null) => (p || '').replace(/\\/g, '/').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase();
const status = (s: unknown): HerdrStatus => (s === 'idle' || s === 'working' || s === 'blocked' || s === 'done') ? s : 'unknown';

/** Watches herdr's agents and workspaces over its local socket, and moves its focus. herdr itself runs in a Fleet terminal. */
export class HerdrMonitor extends EventEmitter {
  state: HerdrState = { installed: false, running: false, agents: [], workspaces: [] };
  private bin: string | null = null; private timer: NodeJS.Timeout | null = null; private seen: Map<string, HerdrStatus> | null = null;

  get binary() { return this.bin; }

  start() { this.bin = findHerdr(); void this.tick(); }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  private async tick() {
    this.bin = this.bin && fs.existsSync(this.bin) ? this.bin : findHerdr();
    let next: HerdrState;
    if (!this.bin) next = { installed: false, running: false, agents: [], workspaces: [] };
    else {
      try {
        const [agents, workspaces] = await Promise.all([call('agent.list'), call('workspace.list')]);
        next = { installed: true, running: true, ...this.shape(agents?.agents, workspaces?.workspaces) };
      } catch (err) {
        next = { installed: true, running: false, agents: [], workspaces: [], ...(err instanceof NotRunning ? {} : { error: (err as Error).message }) };
      }
    }
    this.apply(next);
    this.timer = setTimeout(() => void this.tick(), next.running ? POLL_MS : IDLE_POLL_MS);
  }

  private shape(rawAgents: any[] = [], rawSpaces: any[] = []): { agents: HerdrAgent[]; workspaces: HerdrWorkspace[] } {
    const workspaces: HerdrWorkspace[] = rawSpaces.map(w => ({ id: String(w.workspace_id), label: String(w.label || w.workspace_id), status: status(w.agent_status), cwd: w.worktree?.checkout_path || undefined }));
    const label = new Map(workspaces.map(w => [w.id, w.label]));
    const agents: HerdrAgent[] = rawAgents.map(a => ({
      paneId: String(a.pane_id), workspaceId: String(a.workspace_id), workspace: label.get(String(a.workspace_id)) || String(a.workspace_id),
      status: status(a.agent_status), agent: a.display_agent || a.agent || 'agent', title: a.terminal_title_stripped || a.name || '', cwd: a.cwd || a.foreground_cwd || undefined,
    }));
    return { agents, workspaces };
  }

  /** Publishes a changed state, and reports agents that just became blocked or done (not on the first look). */
  private apply(next: HerdrState) {
    const now = new Map(next.agents.map(a => [a.paneId, a.status]));
    if (this.seen) for (const a of next.agents) {
      const was = this.seen.get(a.paneId);
      if (was && was !== a.status && (a.status === 'blocked' || a.status === 'done')) this.emit('agent', a);
    }
    this.seen = next.running ? now : null;
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.emit('change');
  }

  async refresh() { this.stop(); await this.tick(); }

  /** Brings herdr's focus to the workspace for a folder, opening one if there is none. Moves the client used last, which is the Fleet terminal when you are looking at it. */
  async hop(cwd: string): Promise<{ workspaceId: string; opened: boolean }> {
    const want = norm(cwd);
    const [spaces, panes] = await Promise.all([call('workspace.list'), call('pane.list')]);
    const byCheckout = (spaces?.workspaces || []).find((w: any) => norm(w.worktree?.checkout_path) === want);
    const byPane = (panes?.panes || []).find((p: any) => norm(p.cwd) === want || norm(p.foreground_cwd) === want);
    const id = byCheckout?.workspace_id || byPane?.workspace_id;
    if (id) { await call('workspace.focus', { workspace_id: id }); return { workspaceId: String(id), opened: false }; }
    const made = await call('workspace.create', { cwd, label: path.basename(cwd), focus: true }, 8000);
    return { workspaceId: String(made?.workspace?.workspace_id || ''), opened: true };
  }

  async focusAgent(paneId: string) { await call('agent.focus', { target: paneId }); }
}
