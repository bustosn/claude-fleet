import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as pty from 'node-pty';
import type { TerminalSummary } from '../shared/types.js';

// Output kept per terminal so a tab that reopens (or a reload) sees what happened while it was away.
const SCROLLBACK_CHARS = 200_000;

export function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || '/bin/bash';
}

/** One shell in a pseudo-terminal. The browser attaches over a WebSocket; closing the tab leaves the shell running. */
export class Terminal extends EventEmitter {
  id = randomUUID().slice(0, 8); cwd: string; shell: string; title: string; startedAt = Date.now(); exitCode: number | null = null;
  private p: pty.IPty; private buf = '';

  constructor(opts: { cwd: string; shell: string; cols?: number; rows?: number }) {
    super();
    this.cwd = opts.cwd; this.shell = opts.shell; this.title = path.basename(this.shell).replace(/\.exe$/i, '');
    this.p = pty.spawn(this.shell, [], { name: 'xterm-256color', cols: opts.cols || 120, rows: opts.rows || 30, cwd: this.cwd, env: process.env as Record<string, string> });
    this.p.onData(d => { this.buf += d; if (this.buf.length > SCROLLBACK_CHARS) this.buf = this.buf.slice(-SCROLLBACK_CHARS); this.emit('data', d); });
    this.p.onExit(({ exitCode }) => { this.exitCode = exitCode; this.emit('exit', exitCode); });
  }

  get scrollback() { return this.buf; }
  write(d: string) { if (this.exitCode == null) this.p.write(d); }
  resize(cols: number, rows: number) { if (this.exitCode == null && cols > 0 && rows > 0 && cols < 1000 && rows < 1000) this.p.resize(Math.floor(cols), Math.floor(rows)); }
  kill() { if (this.exitCode == null) this.p.kill(); }
  // Shells and programs set the window title (claude sets it to the conversation topic); the tab shows it.
  setTitle(t: string) { const s = String(t).trim().slice(0, 120); if (s && s !== this.title) { this.title = s; this.emit('change'); } }
  summary(): TerminalSummary { return { id: this.id, cwd: this.cwd, shell: this.shell, title: this.title, startedAt: this.startedAt, exitCode: this.exitCode }; }
}

export class TerminalManager extends EventEmitter {
  private terms = new Map<string, Terminal>();
  constructor(private shell: string | null) { super(); }

  open(opts: { cwd: string; shell?: string | null; cols?: number; rows?: number }): Terminal {
    const t = new Terminal({ cwd: opts.cwd, shell: opts.shell || this.shell || defaultShell(), cols: opts.cols, rows: opts.rows });
    this.terms.set(t.id, t);
    t.on('exit', () => this.emit('change'));
    t.on('change', () => this.emit('change'));
    this.emit('change');
    return t;
  }
  get(id: string) { return this.terms.get(id) || null; }
  list(): TerminalSummary[] { return [...this.terms.values()].map(t => t.summary()); }
  close(id: string): boolean {
    const t = this.terms.get(id); if (!t) return false;
    t.kill(); this.terms.delete(id); this.emit('change');
    return true;
  }
  closeAll() { for (const t of this.terms.values()) t.kill(); this.terms.clear(); }
}
