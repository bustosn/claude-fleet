import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { IdeEntry, IdeFile } from '../shared/types.js';
import { forgetFiles, suggestFiles } from './files.js';

// The IDE view's file access. Every path is a folder Fleet already knows (a checkout or a chat's folder) plus a path inside it;
// anything that resolves outside that folder, through `..` or a link, is refused.

const MAX_EDIT = 5 * 1024 * 1024;
const same = (a: string, b: string) => process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root: string, p: string) => {
  const r = path.relative(root, p);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

export class Ide {
  /** `known` lists the folders that may be opened. */
  constructor(private known: () => string[]) {}

  /** The folder as Fleet knows it, or an error when it is not one of them. */
  root(r: string): string {
    const abs = path.resolve(r);
    const hit = this.known().find(k => same(path.resolve(k), abs));
    if (!hit) throw new Error('not a folder Fleet knows');
    return path.resolve(hit);
  }

  /** The absolute path of `rel` under `root`; for a file that does not exist yet, its folder is the one checked against links. */
  private resolve(root: string, rel: string): string {
    const abs = path.resolve(root, rel);
    if (!inside(root, abs)) throw new Error('outside the folder');
    const real = fs.realpathSync(root);
    let probe = abs;
    while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
    if (!inside(real, fs.realpathSync(probe))) throw new Error('outside the folder');
    return abs;
  }

  /** A path under the folder as git wants it: relative, with forward slashes. Throws for anything that resolves outside. */
  check(root: string, rel: string): string {
    const abs = this.resolve(root, rel);
    return path.relative(root, abs).split(path.sep).join('/');
  }

  /** One folder's entries, folders first. `ignored` marks what git ignores, so node_modules and vendor can be dimmed. */
  list(root: string, rel: string): IdeEntry[] {
    const dir = this.resolve(root, rel);
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.name !== '.git');
    const dirs = new Map<string, boolean>(entries.map(e => [e.name, e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(dir, e.name)))]));
    const ignored = ignoredNames(dir, entries.map(e => e.name + (dirs.get(e.name) ? '/' : '')));
    return entries
      .map(e => ({ name: e.name, dir: !!dirs.get(e.name), ignored: ignored.has(e.name) }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }

  read(root: string, rel: string): IdeFile {
    const abs = this.resolve(root, rel);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error('not a file');
    const base = { size: st.size, mtime: st.mtimeMs };
    if (st.size > MAX_EDIT) return { kind: 'too-large', ...base };
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) return { kind: 'binary', ...base };
    const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const raw = buf.toString('utf8', bom ? 3 : 0);
    // The editor works in \n. A file that uses \r\n goes back out that way, so saving does not rewrite every line.
    const crlf = (raw.match(/\r\n/g)?.length || 0) > (raw.match(/(?<!\r)\n/g)?.length || 0);
    return { kind: 'text', ...base, text: crlf ? raw.replace(/\r\n/g, '\n') : raw, eol: crlf ? 'crlf' : 'lf', bom };
  }

  /** Writes the file and returns its new mtime. When `expect` is given and the file has changed on disk since, nothing is written. */
  write(root: string, rel: string, text: string, opts: { expect?: number; eol?: 'lf' | 'crlf'; bom?: boolean; force?: boolean } = {}): { mtime: number } {
    const abs = this.resolve(root, rel);
    if (!opts.force && opts.expect != null && fs.existsSync(abs) && Math.abs(fs.statSync(abs).mtimeMs - opts.expect) > 1) throw new ConflictError();
    const body = opts.eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text;
    fs.writeFileSync(abs, Buffer.concat([opts.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(body, 'utf8')]));
    forgetFiles(root);
    return { mtime: fs.statSync(abs).mtimeMs };
  }

  /** Files under the folder matching what was typed in Ctrl+P: from git when it is a repo, so ignored folders stay out. */
  find(root: string, q: string, limit = 50): string[] {
    return suggestFiles(root, q, limit);
  }

  /** The text of single lines, for the preview next to a usage or definition. Files are read once each. */
  lines(root: string, items: { path: string; line: number }[]): string[] {
    const cache = new Map<string, string[] | null>();
    return items.map(it => {
      if (!cache.has(it.path)) {
        try { const abs = this.resolve(root, it.path); cache.set(it.path, fs.statSync(abs).size > MAX_EDIT ? null : fs.readFileSync(abs, 'utf8').split(/\r?\n/)); } catch { cache.set(it.path, null); }
      }
      return (cache.get(it.path)?.[it.line - 1] ?? '').trim().slice(0, 240);
    });
  }

  /** Whether the file still has the mtime the editor loaded it with: false when it changed or was deleted. */
  unchanged(root: string, rel: string, mtime: number): boolean {
    try { return Math.abs(fs.statSync(this.resolve(root, rel)).mtimeMs - mtime) <= 1; } catch { return false; }
  }
}

export class ConflictError extends Error { constructor() { super('the file changed on disk since it was opened'); } }

const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** Which of these names git ignores in `dir`. Outside a repo nothing is ignored. */
function ignoredNames(dir: string, names: string[]): Set<string> {
  if (!names.length) return new Set();
  const r = spawnSync('git', ['check-ignore', '--stdin', '-z'], { cwd: dir, input: names.join('\0'), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  // 0: some are ignored; 1: none are; anything else: not a repo, or git failed.
  if (r.status !== 0 || !r.stdout) return new Set();
  return new Set(r.stdout.split('\0').filter(Boolean).map(n => n.replace(/\/$/, '')));
}
