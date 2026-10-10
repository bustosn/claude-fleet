import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Terminal, TerminalManager } from './terminals.js';

/** Output a row in the chat keeps; past it the row says to open the terminal. */
const MAX_UI_CHARS = 60_000;
/** What rides along to the model: the tail of the output. */
const MAX_CTX_LINES = 200, MAX_CTX_CHARS = 8_000;
/** The script did not print its start marker: a parse error, or the shell is wedged. */
const START_TIMEOUT_MS = 4_000;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/g;
/** Plain text: escapes gone, CRLF to LF, and a bare CR keeps only what was drawn last on that line (progress bars). */
function clean(s: string): string {
  return s.replace(ANSI, '').replace(/\r\n/g, '\n').split('\n').map(l => l.includes('\r') ? l.slice(l.lastIndexOf('\r') + 1) : l).join('\n');
}

export interface ShellRun {
  id: string; cmd: string; cwd: string; terminalId: string; startedAt: number;
  output: string; truncated: boolean; exitCode: number | null; done: boolean; interrupted: boolean; sent: boolean;
}

/** A persistent shell for one chat, used for `!` commands. Each command is written to a script the shell dot-sources, so quoting,
 *  comments and multi-line input cannot break the markers that bracket its output; `cd` and variables persist between commands. */
export class ShellRunner extends EventEmitter {
  private term: Terminal | null = null;
  private current: ShellRun | null = null;
  private runs = new Map<string, ShellRun>();
  private pending: ShellRun[] = [];
  private interruptCurrent: (() => void) | null = null;

  constructor(private terminals: TerminalManager, private cwd: string, private scriptDir: string, private title: () => string) { super(); }

  get terminalId() { return this.term && this.term.exitCode == null ? this.term.id : null; }
  get running() { return this.current; }
  get(id: string) { return this.runs.get(id) || null; }

  private shell(): Terminal {
    // Gone if it exited, or if someone killed it from the Terminals list.
    if (this.term && (this.term.exitCode != null || !this.terminals.get(this.term.id))) this.term = null;
    if (!this.term) {
      // Wide, so the shell does not wrap captured lines; a tab that attaches resizes it to what it shows.
      this.term = this.terminals.open({ cwd: this.cwd, cols: 400, rows: 50 });
      this.term.setTitle(`! ${this.title()}`);
    }
    return this.term;
  }

  run(cmd: string): ShellRun {
    if (this.current) throw new Error("a command is still running in this chat's shell; Esc interrupts it, or open the terminal");
    const t = this.shell();
    const id = randomUUID().slice(0, 8), begin = `FLEET-BEGIN-${id}`, end = `FLEET-END-${id}`;
    const ps = /powershell|pwsh/i.test(path.basename(t.shell));
    fs.mkdirSync(this.scriptDir, { recursive: true });
    const file = path.join(this.scriptDir, `${id}.${ps ? 'ps1' : 'sh'}`);
    // $LASTEXITCODE is reset first: it only changes when a native program runs, so a cmdlet failure after an earlier `exit 7` would report 7.
    const script = ps
      ? `Write-Host "${begin}"\r\n$global:LASTEXITCODE = 0\r\n${cmd}\r\n$ok = $?; $ec = if ($ok) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }\r\nWrite-Host ("${end} " + $ec)\r\n`
      : `printf '%s\\n' "${begin}"\n${cmd}\n__fleet_ec=$?\nprintf '%s %s\\n' "${end}" "$__fleet_ec"\n`;
    fs.writeFileSync(file, script);
    const run: ShellRun = { id, cmd, cwd: this.cwd, terminalId: t.id, startedAt: Date.now(), output: '', truncated: false, exitCode: null, done: false, interrupted: false, sent: false };
    this.runs.set(id, run); this.current = run;

    // A POSIX shell prints the start marker and then aborts the script at a syntax error, so the end marker never comes.
    // Checking the syntax first (-n parses without running) turns that hang into an immediate, readable failure.
    if (!ps) {
      try { execFileSync(t.shell, ['-n', file], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 5000, windowsHide: true }); }
      catch (e: any) {
        const msg = String(e.stderr || e.message || e).replace(file.replace(/\\/g, '/'), 'command').replace(file, 'command').trim();
        run.output = msg; run.exitCode = 2; run.done = true; this.current = null; this.pending.push(run);
        try { fs.unlinkSync(file); } catch {}
        this.emit('start', run); this.emit('done', run);
        return run;
      }
    }

    // Negative codes are real on Windows: npm reports -4058 for ENOENT.
    const endRe = new RegExp(`${end} (-?\\d+)`);
    let raw = '', buf = '', started = false;
    let flush: NodeJS.Timeout | null = null;
    const setOutput = (text: string, holdBack: boolean) => {
      let out = clean(text);
      // A marker split across chunks must not leak into the row; keep the tail back until the next chunk settles it.
      if (holdBack) out = out.slice(0, Math.max(0, out.length - (end.length + 8)));
      if (out.length > MAX_UI_CHARS) { run.truncated = true; out = out.slice(-MAX_UI_CHARS); }
      run.output = out;
    };
    const finish = (exitCode: number | null, note?: string) => {
      clearTimeout(startGuard); if (flush) clearTimeout(flush);
      t.off('data', onData); t.off('exit', onExit);
      this.interruptCurrent = null;
      if (note) run.output = note;
      run.output = run.output.replace(/\s+$/, '');
      run.exitCode = exitCode; run.done = true; this.current = null;
      this.pending.push(run);
      try { fs.unlinkSync(file); } catch {}
      this.emit('done', run);
    };
    const onData = (d: string) => {
      if (!started) {
        raw += d; if (raw.length > MAX_UI_CHARS) raw = raw.slice(-MAX_UI_CHARS);
        const i = raw.indexOf(begin); if (i < 0) return;
        const nl = raw.indexOf('\n', i); if (nl < 0) return; // the marker's own line end arrives with it; wait if it has not yet
        started = true; buf = raw.slice(nl + 1); raw = '';
      } else buf += d;
      if (buf.length > MAX_UI_CHARS * 2) { run.truncated = true; buf = buf.slice(-MAX_UI_CHARS); }
      const m = endRe.exec(clean(buf));
      if (m) { setOutput(clean(buf).slice(0, m.index), false); finish(Number(m[1])); return; }
      setOutput(buf, true);
      if (!flush) flush = setTimeout(() => { flush = null; this.emit('output', run); }, 150);
    };
    const onExit = () => finish(null, run.output + '\n(the shell exited)');
    // Prompts and the echoed dot-source line are noise in the diagnostic; the error the shell printed is the point.
    const noise = (s: string) => s.split('\n').filter(l => !/^PS [^>]*>+\s*(\. '.*')?\s*$/.test(l.trim())).join('\n').trim();
    const startGuard = setTimeout(() => { if (!started) finish(null, `(the shell did not start the command; what it printed instead:)\n${noise(clean(raw))}`); }, START_TIMEOUT_MS);
    this.interruptCurrent = () => {
      // What was there when Ctrl+C went in is the output; what follows is the shell's ^C and a fresh prompt.
      run.interrupted = true; const before = buf; t.write('\x03');
      setTimeout(() => { if (!run.done) { setOutput(before, false); finish(130); } }, 400);
    };
    t.on('data', onData); t.on('exit', onExit);
    this.emit('start', run);
    // Dot-sourcing runs the script in the shell's own scope, so a `cd` or a variable set here is still there for the next command.
    t.write(ps ? `. '${file.replace(/'/g, "''")}'\r` : `. '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\n`);
    return run;
  }

  interrupt(): boolean { if (!this.current || !this.interruptCurrent) return false; this.interruptCurrent(); return true; }

  /** Runs since the last turn, as a block for the model; clears the queue. Null when nothing ran. */
  takeContext(): string | null {
    const runs = this.pending.filter(r => !r.sent); this.pending = [];
    if (!runs.length) return null;
    for (const r of runs) r.sent = true;
    const tail = (s: string) => {
      let lines = s.split('\n'); let cut = false;
      if (lines.length > MAX_CTX_LINES) { cut = true; lines = lines.slice(-MAX_CTX_LINES); }
      let text = lines.join('\n');
      if (text.length > MAX_CTX_CHARS) { cut = true; text = text.slice(-MAX_CTX_CHARS); }
      return (cut ? '… (earlier output omitted; the full output is in the terminal)\n' : '') + text;
    };
    const status = (r: ShellRun) => r.interrupted ? 'interrupted' : r.exitCode == null ? 'did not finish' : `exit ${r.exitCode}`;
    const blocks = runs.map(r => `$ ${r.cmd}   (${status(r)})\n${tail(r.output) || '(no output)'}`);
    return `[Commands the user ran themselves in this chat's shell (${this.cwd}) since their last message. You did not run these; the output is for your reference.]\n\n${blocks.join('\n\n')}`;
  }
  /** Queue one finished run for the next message (the "Send to Claude" button). A run already sent goes again. */
  queue(id: string): boolean {
    const r = this.runs.get(id); if (!r || !r.done) return false;
    r.sent = false; if (!this.pending.includes(r)) this.pending.push(r);
    return true;
  }

  close() { if (this.term) { this.terminals.close(this.term.id); this.term = null; } }
}
