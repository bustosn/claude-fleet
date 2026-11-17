import { useSyncExternalStore } from 'react';

// The browser end of a language server: JSON-RPC over a WebSocket to Fleet, which runs the server (server/lsp.ts).
// One connection per folder and language. Open files are announced to it, edits are sent a moment after typing stops,
// and requests (definition, hover, usages, completion) flush any pending edit first so the answer matches what is on screen.

export type LspKind = 'php' | 'ts' | 'python';
export interface LspStatus { name: string; state: 'connecting' | 'starting' | 'ready' | 'failed' | 'closed'; detail: string; progress: string }
export interface LspDiagnostic { range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity?: 1 | 2 | 3 | 4; message: string; source?: string }

const LANGS: Record<string, { kind: LspKind; id: string }> = {
  php: { kind: 'php', id: 'php' }, phtml: { kind: 'php', id: 'php' },
  js: { kind: 'ts', id: 'javascript' }, mjs: { kind: 'ts', id: 'javascript' }, cjs: { kind: 'ts', id: 'javascript' }, jsx: { kind: 'ts', id: 'javascriptreact' },
  ts: { kind: 'ts', id: 'typescript' }, tsx: { kind: 'ts', id: 'typescriptreact' },
  py: { kind: 'python', id: 'python' },
};
export const langOf = (path: string) => LANGS[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] || null;

interface Doc { version: number; text: () => string; timer: ReturnType<typeof setTimeout> | null }

class Client {
  ws: WebSocket | null = null;
  status: LspStatus;
  rootUri = '';
  rev = 0;
  private nextId = 1;
  private pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private docs = new Map<string, Doc>();
  private ready: Promise<void> | null = null;
  private tokens = new Map<string, string>();
  diagnostics = new Map<string, LspDiagnostic[]>();
  private subs = new Set<() => void>();
  diagSubs = new Set<(path: string) => void>();

  constructor(readonly root: string, readonly kind: LspKind) { this.status = { name: kindName[kind], state: 'connecting', detail: '', progress: '' }; }

  subscribe(fn: () => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  private set(patch: Partial<LspStatus>) { this.status = { ...this.status, ...patch }; this.rev++; this.subs.forEach(f => f()); }

  uri(path: string) { return `${this.rootUri}/${path.split('/').map(encodeURIComponent).join('/')}`; }
  /** A path under the folder from a uri the server sent (it encodes the drive colon and may change its case), or null when it points elsewhere. */
  pathOf(uri: string): string | null {
    const norm = (u: string) => decodeURIComponent(u).replace(/^file:\/\//i, '').replace(/^\/([a-z]:)/i, '$1').replace(/\\/g, '/').replace(/\/$/, '');
    const root = norm(this.rootUri), p = norm(uri);
    return p.toLowerCase().startsWith(root.toLowerCase() + '/') ? p.slice(root.length + 1) : null;
  }

  /** Connects once; resolves when the server has said hello. Opens everything that was open before a reconnect. */
  connect(): Promise<void> {
    if (this.ready && this.ws && this.ws.readyState <= 1) return this.ready;
    this.set({ state: 'connecting', detail: '' });
    this.ready = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ide/lsp?root=${encodeURIComponent(this.root)}&kind=${this.kind}`);
      this.ws = ws;
      ws.onmessage = e => {
        let m: any;
        try { m = JSON.parse(String(e.data)); } catch { return; }
        if (m.fleet === 'hello') {
          this.rootUri = m.rootUri;
          this.tokens.clear(); (m.progress as string[]).forEach((t, i) => this.tokens.set(`hello${i}`, t));
          this.set({ name: m.name, state: m.state, detail: m.detail || '', progress: this.progressText() });
          if (m.state !== 'failed') { for (const [path, d] of this.docs) this.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: this.uri(path), languageId: langOf(path)?.id || 'plaintext', version: d.version, text: d.text() } } }); }
          resolve();
        } else if (m.fleet === 'state') this.set({ state: m.state, detail: m.detail || '' });
        else this.onMessage(m);
      };
      ws.onclose = () => {
        if (this.ws === ws) { this.set({ state: 'closed', progress: '' }); this.ws = null; this.ready = null; }
        for (const [, p] of this.pending) p.fail(new Error('the language server connection closed'));
        this.pending.clear();
        reject(new Error('could not reach the language server'));
      };
      ws.onerror = () => {};
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  private progressText() { return [...this.tokens.values()].pop() || ''; }

  private onMessage(m: any) {
    if (m.id != null && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.fail(new Error(m.error.message || 'request failed')); else p.ok(m.result);
    } else if (m.method === 'textDocument/publishDiagnostics') {
      const path = this.pathOf(m.params.uri);
      if (path == null) return;
      this.diagnostics.set(path, m.params.diagnostics || []);
      this.diagSubs.forEach(f => f(path));
    } else if (m.method === '$/progress') {
      const v = m.params?.value, token = String(m.params?.token);
      if (v?.kind === 'end') this.tokens.delete(token);
      else if (v) this.tokens.set(token, [v.title, v.message, v.percentage != null ? `${v.percentage}%` : ''].filter(Boolean).join(' · '));
      this.set({ progress: this.progressText() });
    }
  }

  private send(msg: object) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); }

  async request<T = any>(method: string, params: object, timeout = 20000): Promise<T> {
    await this.connect();
    const id = this.nextId++;
    return new Promise<T>((ok, fail) => {
      const t = setTimeout(() => { this.pending.delete(id); fail(new Error('the language server did not answer in time')); }, timeout);
      this.pending.set(id, { ok: v => { clearTimeout(t); ok(v); }, fail: e => { clearTimeout(t); fail(e); } });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  open(path: string, text: () => string) {
    if (this.docs.has(path)) return;
    this.docs.set(path, { version: 1, text, timer: null });
    this.connect().then(() => {
      // Connecting already sent every open document, this one included.
    }).catch(() => {});
    if (this.ws?.readyState === 1 && this.status.state !== 'failed') this.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: this.uri(path), languageId: langOf(path)?.id || 'plaintext', version: 1, text: text() } } });
  }

  /** Tells the server the text changed, after typing pauses. */
  change(path: string, text: () => string, now = false) {
    const d = this.docs.get(path);
    if (!d) return;
    d.text = text;
    if (d.timer) clearTimeout(d.timer);
    const go = () => { d.timer = null; d.version++; this.send({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri: this.uri(path), version: d.version }, contentChanges: [{ text: d.text() }] } }); };
    if (now) go(); else d.timer = setTimeout(go, 150);
  }

  /** Sends any edit still waiting, so a request is answered for the text on screen. */
  flush(path: string) {
    const d = this.docs.get(path);
    if (d?.timer) { clearTimeout(d.timer); d.timer = null; this.change(path, d.text, true); }
  }

  close(path: string) {
    const d = this.docs.get(path);
    if (!d) return;
    if (d.timer) clearTimeout(d.timer);
    this.docs.delete(path);
    this.diagnostics.delete(path);
    this.send({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri: this.uri(path) } } });
  }

  saved(path: string) { this.send({ jsonrpc: '2.0', method: 'textDocument/didSave', params: { textDocument: { uri: this.uri(path) } } }); }
}

const kindName: Record<LspKind, string> = { php: 'PHP', ts: 'TypeScript', python: 'Python' };
const clients = new Map<string, Client>();

/** The connection for this folder and file kind, created on first use. Null for files no server handles. */
export function lspFor(root: string, path: string): Client | null {
  const l = langOf(path);
  if (!l) return null;
  const k = `${root.toLowerCase()}|${l.kind}`;
  let c = clients.get(k);
  if (!c) { c = new Client(root, l.kind); clients.set(k, c); }
  return c;
}

const none: LspStatus = { name: '', state: 'closed', detail: '', progress: '' };
/** What to show for the language server behind a file: connecting, indexing, ready, or why it is not. Null for files with no server. */
export function useLspStatus(root: string, path: string | null): LspStatus | null {
  const c = path ? lspFor(root, path) : null;
  useSyncExternalStore(l => c ? c.subscribe(l) : () => {}, () => c?.rev ?? 0);
  return c ? c.status : path ? none : null;
}

export const lspOpen = (root: string, path: string, text: () => string) => { lspFor(root, path)?.open(path, text); };
export const lspChange = (root: string, path: string, text: () => string, now = false) => { lspFor(root, path)?.change(path, text, now); };
export const lspClose = (root: string, path: string) => { lspFor(root, path)?.close(path); };
export const lspSaved = (root: string, path: string) => { lspFor(root, path)?.saved(path); };

export interface SymbolHit { name: string; kind: number; container: string; path: string; line: number; col: number }

/** Classes, methods, functions and the like matching `q`, asked of every language server the open files use. */
export async function workspaceSymbols(root: string, probes: string[], q: string): Promise<SymbolHit[]> {
  const seen = new Set<Client>();
  const clients = probes.map(p => lspFor(root, p)).filter((c): c is Client => !!c && !seen.has(c) && !!seen.add(c) && c.status.state === 'ready');
  const lists = await Promise.all(clients.map(async c => {
    try {
      const res: any[] = (await c.request('workspace/symbol', { query: q }, 8000)) || [];
      return res.flatMap(r => {
        const loc = r.location;
        const path = loc?.uri ? c.pathOf(loc.uri) : null;
        return path == null ? [] : [{ name: String(r.name), kind: Number(r.kind) || 0, container: String(r.containerName || ''), path, line: (loc.range?.start?.line ?? 0) + 1, col: (loc.range?.start?.character ?? 0) + 1 }];
      });
    } catch { return []; }
  }));
  return lists.flat();
}
