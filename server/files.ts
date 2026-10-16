import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { FilePreview, FileRef } from '../shared/types.js';

// Files a chat names in its replies, opened from the chat: previewed in Fleet, or handed to VS Code, the default app, or the file manager.

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon' };
/** Opening these with the default app would run them, so Fleet only offers VS Code and the folder. */
const RUNNABLE = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|lnk|reg|hta|cpl|jar|sh|command|app)$/i;
const MAX_TEXT = 2 * 1024 * 1024;

/** A path as Claude wrote it, made absolute: relative paths are taken from the chat's folder, `~` from home. */
export function resolvePath(cwd: string, p: string): string {
  const s = p.trim().replace(/^~(?=$|[\\/])/, os.homedir());
  return path.resolve(cwd, s);
}

export function statRefs(cwd: string, paths: string[]): FileRef[] {
  return paths.map(p => {
    const abs = resolvePath(cwd, p);
    try { const st = fs.statSync(abs); return { path: p, abs, kind: st.isFile() ? 'file' : st.isDirectory() ? 'dir' : null }; }
    catch { return { path: p, abs, kind: null }; }
  });
}

// @-mention completion: the files under a chat's folder, from git when it is a repo (so ignored folders stay out), else a bounded walk.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__', 'target', 'vendor', '.cache']);
const fileLists = new Map<string, { at: number; files: string[] }>();
function listFiles(cwd: string): string[] {
  const hit = fileLists.get(cwd);
  if (hit && Date.now() - hit.at < 30_000) return hit.files;
  let files: string[] = [];
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (git.status === 0 && git.stdout) files = git.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  else {
    const walk = (dir: string, rel: string, depth: number) => {
      if (files.length >= 8000 || depth > 6) return;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), `${rel}${e.name}/`, depth + 1); }
        else if (e.isFile()) files.push(rel + e.name);
      }
    };
    walk(cwd, '', 0);
  }
  fileLists.set(cwd, { at: Date.now(), files });
  return files;
}

/** Best matches for what follows an `@`: a name prefix beats a name substring beats the letters appearing in order. Shorter paths win ties. */
export function suggestFiles(cwd: string, query: string, limit = 12): string[] {
  const q = query.toLowerCase().replace(/\\/g, '/');
  const files = listFiles(cwd);
  if (!q) return files.slice().sort((a, b) => a.length - b.length).slice(0, limit);
  const scored: [number, string][] = [];
  for (const f of files) {
    const low = f.toLowerCase(), base = low.slice(low.lastIndexOf('/') + 1);
    let score = -1;
    if (base.startsWith(q)) score = 0;
    else if (low.startsWith(q)) score = 1;
    else if (base.includes(q)) score = 2;
    else if (low.includes(q)) score = 3;
    else { let i = 0; for (const ch of low) if (ch === q[i]) i++; if (i === q.length) score = 4; }
    if (score >= 0) scored.push([score * 1000 + f.length, f]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(s => s[1]);
}

let vscode: boolean | null = null;
const hasVSCode = () => vscode ??= spawnSync(process.platform === 'win32' ? 'where' : 'which', ['code'], { windowsHide: true }).status === 0;

export function preview(cwd: string, p: string): FilePreview {
  const abs = resolvePath(cwd, p);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('not a file');
  const base = { abs, name: path.basename(abs), size: st.size, editor: hasVSCode(), runnable: RUNNABLE.test(abs) };
  const ext = path.extname(abs).toLowerCase();
  if (IMAGE_TYPES[ext]) return { ...base, kind: 'image' };
  if (st.size > MAX_TEXT) return { ...base, kind: 'too-large' };
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) return { ...base, kind: 'binary' };
  return { ...base, kind: 'text', text: buf.toString('utf8') };
}

/** Images only, for the preview's <img>. The sandbox header keeps an SVG opened on its own from running script on Fleet's origin. */
export function rawImage(cwd: string, p: string): { abs: string; type: string } {
  const abs = resolvePath(cwd, p);
  const type = IMAGE_TYPES[path.extname(abs).toLowerCase()];
  if (!type || !fs.statSync(abs).isFile()) throw new Error('not an image');
  return { abs, type };
}

const detached = (cmd: string, args: string[]) => spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => {}).unref();
/** Hands a URL or file to the OS, never through a shell, so nothing in a file name is parsed as a command. */
function shellOpen(target: string) {
  if (process.platform === 'win32') detached('explorer.exe', [target]);
  else detached(process.platform === 'darwin' ? 'open' : 'xdg-open', [target]);
}

/** A folder in VS Code (a new window) or the file manager. */
export function openFolder(abs: string, how: 'editor' | 'folder') {
  if (!fs.statSync(abs).isDirectory()) throw new Error('not a folder');
  if (how === 'editor') {
    if (!hasVSCode()) throw new Error('VS Code is not on the PATH');
    shellOpen(`vscode://file/${encodeURI(abs.replace(/\\/g, '/')).replace(/[#?]/g, encodeURIComponent)}/`);
  } else shellOpen(abs);
}

export function openFile(cwd: string, p: string, how: 'editor' | 'default' | 'reveal', line?: number) {
  const abs = resolvePath(cwd, p);
  const st = fs.statSync(abs);
  if (how === 'reveal') {
    if (process.platform === 'win32') detached('explorer.exe', [`/select,${abs}`]);
    else if (process.platform === 'darwin') detached('open', ['-R', abs]);
    else detached('xdg-open', [st.isDirectory() ? abs : path.dirname(abs)]);
    return;
  }
  if (!st.isFile()) throw new Error('not a file');
  if (how === 'editor') {
    if (!hasVSCode()) throw new Error('VS Code is not on the PATH');
    // The vscode:// handler opens at a line without going through code.cmd, which Node cannot spawn without a shell.
    shellOpen(`vscode://file/${encodeURI(abs.replace(/\\/g, '/')).replace(/[#?]/g, encodeURIComponent)}${line ? `:${line}` : ''}`);
    return;
  }
  if (RUNNABLE.test(abs)) throw new Error('this file would run rather than open; use VS Code or Show in folder');
  shellOpen(abs);
}
