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
