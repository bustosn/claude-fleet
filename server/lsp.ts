import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { WebSocket } from 'ws';

// Language servers for the IDE view. One process per folder and language, kept running after the tab is left so a large PHP
// project is not indexed again each time. The editor talks to it over a WebSocket carrying plain JSON-RPC messages;
// this file frames them for the server's stdio, answers the server's own requests (configuration, capability registration),
// and keeps the open-document list straight across the editor reconnecting.

export type LspKind = 'php' | 'ts' | 'python';

const require = createRequire(import.meta.url);
const resolveBin = (pkg: string, rel: string): string | null => {
  try { return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), rel); } catch { return null; }
};
const SERVERS: Record<LspKind, { name: string; bin: () => string | null }> = {
  php: { name: 'Intelephense', bin: () => resolveBin('intelephense', 'lib/intelephense.js') },
  ts: { name: 'TypeScript', bin: () => resolveBin('typescript-language-server', 'lib/cli.mjs') },
  python: { name: 'Pyright', bin: () => resolveBin('pyright', 'langserver.index.js') },
};

export const lspKindFor = (file: string): LspKind | null => {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === 'php' || ext === 'phtml') return 'php';
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'].includes(ext)) return 'ts';
  if (ext === 'py') return 'python';
  return null;
};

class Server {
  proc: ChildProcess | null = null;
  state: 'starting' | 'ready' | 'failed' = 'starting';
  detail = '';
  /** Documents the server believes are open, by uri. */
  open = new Set<string>();
  client: WebSocket | null = null;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pendingInit = new Map<number, (r: any) => void>();
  /** Progress the server reports (indexing), replayed to an editor that connects mid-way. */
  progress = new Map<string, string>();
  /** What the editor sent before the server finished initializing; sent once it has. */
  private queue: string[] = [];

  constructor(readonly root: string, readonly kind: LspKind, private stateDir: string) { this.start(); }

  get rootUri() { return pathToFileURL(this.root).href.replace(/\/$/, ''); }

  private start() {
    const spec = SERVERS[this.kind];
    const bin = spec.bin();
    if (!bin || !fs.existsSync(bin)) { this.fail(`${spec.name} is not installed (npm install in claude-fleet)`); return; }
    const p = spawn(process.execPath, ['--max-old-space-size=4096', bin, '--stdio'], { cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = p;
    p.stdout.on('data', d => this.onData(d));
    p.stderr.on('data', d => { this.detail = String(d).slice(-300); });
    p.on('error', e => this.fail(String(e.message || e)));
    p.on('exit', code => { if (this.state !== 'failed') this.fail(`${spec.name} stopped (exit ${code})`); this.proc = null; });
    this.initialize().catch(e => this.fail(String(e.message || e)));
  }

  private fail(why: string) {
    this.state = 'failed'; this.detail = why;
    this.client?.send(JSON.stringify({ fleet: 'state', state: 'failed', detail: why }));
  }

  private send(msg: object) {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.proc?.stdin?.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise(res => { this.pendingInit.set(id, res); this.send({ jsonrpc: '2.0', id, method, params }); });
  }

  private async initialize() {
    const r = await this.request('initialize', {
      processId: process.pid, rootUri: this.rootUri, rootPath: this.root, workspaceFolders: [{ uri: this.rootUri, name: path.basename(this.root) }],
      clientInfo: { name: 'claude-fleet' },
      initializationOptions: this.kind === 'php'
        ? { storagePath: path.join(this.stateDir, 'intelephense'), globalStoragePath: path.join(this.stateDir, 'intelephense-global'), clearCache: false }
        : undefined,
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, symbol: {} },
        window: { workDoneProgress: true },
        textDocument: {
          synchronization: { didSave: true },
          definition: {}, implementation: {}, typeDefinition: {}, references: {},
          hover: { contentFormat: ['markdown', 'plaintext'] },
          completion: { completionItem: { snippetSupport: false, documentationFormat: ['markdown', 'plaintext'] } },
          publishDiagnostics: { relatedInformation: false },
        },
      },
    });
    if (r?.error) throw new Error(r.error.message || 'initialize failed');
    this.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    this.state = 'ready';
    this.client?.send(JSON.stringify({ fleet: 'state', state: 'ready' }));
    for (const m of this.queue.splice(0)) this.fromClient(m);
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const head = this.buf.indexOf('\r\n\r\n');
      if (head < 0) return;
      const m = /content-length:\s*(\d+)/i.exec(this.buf.subarray(0, head).toString('ascii'));
      if (!m) { this.buf = this.buf.subarray(head + 4); continue; }
      const len = Number(m[1]), end = head + 4 + len;
      if (this.buf.length < end) return;
      const text = this.buf.subarray(head + 4, end).toString('utf8');
      this.buf = this.buf.subarray(end);
      try { this.onMessage(JSON.parse(text), text); } catch {}
    }
  }

  private onMessage(msg: any, raw: string) {
    // A reply to something this file asked (initialize).
    if (msg.id != null && !msg.method && this.pendingInit.has(msg.id)) { this.pendingInit.get(msg.id)!(msg); this.pendingInit.delete(msg.id); return; }
    // The server asking the client something: answer here, the editor has nothing to say.
    if (msg.id != null && msg.method) {
      let result: unknown = null;
      if (msg.method === 'workspace/configuration') result = (msg.params?.items || []).map(() => null);
      else if (msg.method === 'workspace/workspaceFolders') result = [{ uri: this.rootUri, name: path.basename(this.root) }];
      this.send({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    if (msg.method === '$/progress') {
      const v = msg.params?.value;
      if (v?.kind === 'end') this.progress.delete(String(msg.params.token));
      else if (v) this.progress.set(String(msg.params.token), [v.title, v.message].filter(Boolean).join(' · '));
    }
    this.client?.readyState === 1 && this.client.send(raw);
  }

  /** The editor's message to the server. A document opened twice (the editor reconnected) is turned into a change. */
  fromClient(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (this.state === 'failed') return;
    if (this.state === 'starting') { this.queue.push(raw); return; }
    const uri = msg.params?.textDocument?.uri;
    if (msg.method === 'textDocument/didOpen') {
      if (this.open.has(uri)) { this.send({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: msg.params.textDocument.version }, contentChanges: [{ text: msg.params.textDocument.text }] } }); return; }
      this.open.add(uri);
    } else if (msg.method === 'textDocument/didClose') this.open.delete(uri);
    this.send(msg);
  }

  attach(ws: WebSocket) {
    if (this.client && this.client !== ws) this.client.close();
    this.client = ws;
    ws.send(JSON.stringify({ fleet: 'hello', rootUri: this.rootUri, name: SERVERS[this.kind].name, state: this.state, detail: this.detail, progress: [...this.progress.values()] }));
    ws.on('message', d => this.fromClient(String(d)));
    ws.on('close', () => {
      if (this.client !== ws) return;
      this.client = null;
      // The editor's documents go with it; it opens them again on reconnecting.
      for (const uri of this.open) this.send({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } });
      this.open.clear();
    });
  }

  stop() { this.proc?.kill(); }
}

export class LspManager {
  private servers = new Map<string, Server>();
  constructor(private stateDir: string) {}

  attach(root: string, kind: LspKind, ws: WebSocket) {
    const k = `${root.toLowerCase()}|${kind}`;
    let s = this.servers.get(k);
    if (!s || s.state === 'failed') { s?.stop(); s = new Server(root, kind, this.stateDir); this.servers.set(k, s); }
    s.attach(ws);
  }

  stopAll() { for (const s of this.servers.values()) s.stop(); }
}
