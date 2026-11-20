import { useSyncExternalStore } from 'react';
import type { EditorState } from '@codemirror/state';
import { api, type IdeEntry, type IdeFile, type IdeGitStatus } from '../lib/api';
import { lspChange, lspClose, lspOpen, lspSaved } from './lsp';

// What the IDE view holds per folder: the files open, their unsaved text, which folders are expanded. It lives here, not in the view,
// so switching to a chat and back finds every buffer, its undo history and its cursor as they were.

export interface Buf {
  path: string; kind: IdeFile['kind']; size: number; mtime: number; eol: 'lf' | 'crlf'; bom: boolean;
  /** The text as last read from or written to disk. */
  saved: string;
  /** The editor's state, kept current by the editor, so the text, cursor and undo history survive the view being left. */
  state: EditorState | null;
  dirty: boolean;
  /** The file changed on disk while this buffer had unsaved edits. */
  stale: boolean;
  saving: boolean;
  error?: string;
}

export interface Session {
  root: string; order: string[]; bufs: Map<string, Buf>; active: string | null;
  expanded: Set<string>; dirs: Map<string, IdeEntry[]>; rev: number;
  /** Where the editor should put the cursor when it next shows `active`. */
  goto: { path: string; line: number; col: number; find?: Find; at: number } | null;
  /** Places jumped from, for Ctrl+Alt+Left and Right. `i` is where in the list the editor is now. */
  nav: { stack: Loc[]; i: number };
  /** A list of places (usages, several definitions) to choose from. */
  peek: Peek | null;
  /** The branch and each changed file, for the tree. Null outside a repo. */
  git: IdeGitStatus | null;
  /** The Annotate column is showing. */
  blame: boolean;
}

/** The server's range for a definition starts at its docblock; the cursor should land on the name, found as `word` between `line` and `endLine`. */
export interface Find { word: string; endLine: number }
export interface Loc { path: string; line: number; col: number; find?: Find }
/** `from` is where the cursor was, so jumping to an item can be walked back. */
export interface Peek { title: string; from: Loc; items: (Loc & { text: string })[] }

const sessions = new Map<string, Session>();
const listeners = new Map<string, Set<() => void>>();
const key = (root: string) => root.toLowerCase();
const storeKey = (root: string) => `fleet.ide.${key(root)}`;

function persist(s: Session) {
  try { localStorage.setItem(storeKey(s.root), JSON.stringify({ order: s.order, active: s.active, expanded: [...s.expanded] })); } catch {}
}

function touch(s: Session, save = true) {
  s.rev++;
  if (save) persist(s);
  listeners.get(key(s.root))?.forEach(l => l());
}

const readBlame = () => { try { return localStorage.getItem('fleet.ide.blame') === '1'; } catch { return false; } };

export function getSession(root: string): Session {
  let s = sessions.get(key(root));
  if (s) return s;
  s = { root, order: [], bufs: new Map(), active: null, expanded: new Set(['']), dirs: new Map(), rev: 0, goto: null, nav: { stack: [], i: -1 }, peek: null, git: null, blame: readBlame() };
  sessions.set(key(root), s);
  // What was open last time comes back; files that no longer exist drop out.
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey(root)) || 'null');
    if (saved) {
      for (const d of saved.expanded || []) s.expanded.add(String(d));
      const active = saved.active;
      (async () => {
        for (const p of (saved.order || []) as string[]) await load(s!, p).catch(() => {});
        if (active && s!.bufs.has(active)) s!.active = active;
        touch(s!);
      })();
    }
  } catch {}
  for (const d of s.expanded) loadDir(s, d);
  refreshGit(s);
  return s;
}

export function useSession(root: string): Session {
  const s = getSession(root);
  useSyncExternalStore(
    l => { const set = listeners.get(key(root)) || new Set(); set.add(l); listeners.set(key(root), set); return () => set.delete(l); },
    () => s.rev,
  );
  return s;
}

/** The buffers that have unsaved edits, across every folder, for a warning before the window closes. */
export const anyDirty = () => [...sessions.values()].some(s => [...s.bufs.values()].some(b => b.dirty));

async function load(s: Session, path: string): Promise<Buf> {
  const f = await api.ideFile(s.root, path);
  const buf: Buf = { path, kind: f.kind, size: f.size, mtime: f.mtime, eol: f.eol || 'lf', bom: !!f.bom, saved: f.text || '', state: null, dirty: false, stale: false, saving: false };
  s.bufs.set(path, buf);
  if (!s.order.includes(path)) s.order.push(path);
  if (buf.kind === 'text') lspOpen(s.root, path, () => textOf(buf));
  return buf;
}

export async function loadDir(s: Session, dir: string) {
  try { s.dirs.set(dir, await api.ideList(s.root, dir)); } catch { s.dirs.delete(dir); s.expanded.delete(dir); }
  touch(s, false);
}

export function toggleDir(s: Session, dir: string) {
  if (s.expanded.has(dir)) s.expanded.delete(dir); else { s.expanded.add(dir); if (!s.dirs.has(dir)) loadDir(s, dir); }
  touch(s);
}

/** Reloads every folder that is open in the tree: files Claude just created appear. */
export async function refreshTree(s: Session) {
  await Promise.all([...s.expanded].map(d => loadDir(s, d)));
}

/** Expands every folder above a file, so the tree shows where it lives. */
function reveal(s: Session, path: string) {
  const parts = path.split('/'); parts.pop();
  let dir = '';
  for (const p of parts) {
    dir = dir ? `${dir}/${p}` : p;
    if (!s.expanded.has(dir)) { s.expanded.add(dir); if (!s.dirs.has(dir)) loadDir(s, dir); }
  }
}

export async function openFile(root: string, path: string, line?: number, col = 1, find?: Find) {
  const s = getSession(root);
  path = path.replace(/\\/g, '/').replace(/^\.?\//, '');
  try {
    if (!s.bufs.has(path)) await load(s, path);
    s.active = path;
    if (line) s.goto = { path, line, col, find, at: Date.now() };
    reveal(s, path);
  } catch (e) { return String((e as Error).message || e); }
  touch(s);
}

export function setActive(s: Session, path: string) { s.active = path; touch(s); }

export function closeFile(s: Session, path: string) {
  const i = s.order.indexOf(path);
  if (i < 0) return;
  s.order.splice(i, 1);
  s.bufs.delete(path);
  lspClose(s.root, path);
  if (s.active === path) s.active = s.order[i] || s.order[i - 1] || null;
  touch(s);
}

/** Called by the editor on every change: keeps the state and works out whether the text still differs from disk. */
export function edited(s: Session, path: string, state: EditorState) {
  const b = s.bufs.get(path);
  if (!b) return;
  const wasDirty = b.dirty;
  b.state = state;
  b.dirty = !(state.doc.length === b.saved.length && state.doc.toString() === b.saved);
  lspChange(s.root, path, () => textOf(b));
  if (b.dirty !== wasDirty) touch(s, false);
}

export const textOf = (b: Buf) => b.state ? b.state.doc.toString() : b.saved;

export async function save(s: Session, path: string, force = false): Promise<boolean> {
  const b = s.bufs.get(path);
  if (!b || b.kind !== 'text' || b.saving) return false;
  const text = textOf(b);
  b.saving = true; b.error = undefined; touch(s, false);
  try {
    const r = await api.ideSave({ root: s.root, path, text, expect: b.mtime, eol: b.eol, bom: b.bom, force });
    b.saved = text; b.mtime = r.mtime; b.dirty = false; b.stale = false;
    lspSaved(s.root, path);
    refreshGit(s);
    return true;
  } catch (e) {
    b.stale = !!(e as any)?.conflict || /changed on disk/.test(String((e as Error).message));
    b.error = String((e as Error).message || e);
    return false;
  } finally { b.saving = false; touch(s, false); }
}

/** Replaces the buffer with what is on disk now, dropping unsaved edits. */
export async function reload(s: Session, path: string) {
  const b = s.bufs.get(path);
  if (!b) return;
  const f = await api.ideFile(s.root, path);
  b.kind = f.kind; b.size = f.size; b.mtime = f.mtime; b.eol = f.eol || 'lf'; b.bom = !!f.bom;
  b.saved = f.text || ''; b.state = null; b.dirty = false; b.stale = false; b.error = undefined;
  lspChange(s.root, path, () => textOf(b), true);
  touch(s);
}

/** Checks the open files against disk. A file changed outside (Claude, git) reloads when it has no edits, and is flagged when it has. */
export async function checkDisk(s: Session) {
  const files = [...s.bufs.values()].map(b => ({ path: b.path, mtime: b.mtime }));
  if (!files.length) return;
  let stale: string[];
  try { stale = await api.ideStale(s.root, files); } catch { return; }
  for (const p of stale) {
    const b = s.bufs.get(p);
    if (!b || b.saving) continue;
    if (b.dirty) { if (!b.stale) { b.stale = true; touch(s, false); } }
    else await reload(s, p).catch(() => { closeFile(s, p); });
  }
}

/** Opens a place and remembers where the cursor was, so Ctrl+Alt+Left comes back. */
export async function jumpTo(s: Session, from: Loc, to: Loc): Promise<string | void> {
  const err = await openFile(s.root, to.path, to.line, to.col, to.find);
  if (err) return err;
  const n = s.nav;
  n.stack = n.stack.slice(0, n.i + 1);
  if (!n.stack.length || n.stack[n.stack.length - 1].path !== from.path || n.stack[n.stack.length - 1].line !== from.line) n.stack.push(from);
  n.stack.push(to);
  n.i = n.stack.length - 1;
}

/** Back to the place jumped from, or forward again to where the jump landed. */
export async function navigate(s: Session, dir: -1 | 1): Promise<void> {
  const n = s.nav;
  const at = n.i + dir;
  if (at < 0 || at >= n.stack.length) return;
  n.i = at;
  const to = n.stack[at];
  await openFile(s.root, to.path, to.line, to.col, to.find);
}

export function showPeek(s: Session, peek: Peek | null) { s.peek = peek; touch(s, false); }

/** Reads the branch and the changed files; the tree colors its rows from it. */
export async function refreshGit(s: Session) {
  try {
    const g = await api.ideGitStatus(s.root);
    if (JSON.stringify(g) === JSON.stringify(s.git)) return;
    s.git = g;
    touch(s, false);
  } catch {}
}

export function toggleBlame(s: Session) {
  s.blame = !s.blame;
  try { localStorage.setItem('fleet.ide.blame', s.blame ? '1' : '0'); } catch {}
  touch(s, false);
}
