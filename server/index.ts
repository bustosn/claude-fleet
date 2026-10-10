import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { renameSession } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig, root } from './config.js';
import { Collector } from './collector.js';
import { ChatManager } from './chat.js';
import { AwsCreds } from './aws.js';
import { TerminalManager, type Terminal } from './terminals.js';
import { DialogueManager } from './dialogue.js';
import { conversationHistory } from './sources/conversations.js';
import { run, errText } from './util.js';

// Fleet tools are deliberately auto-approved via allowedTools; the SDK warns about that on every chat start.
process.on('warning', w => { if ((w as any).code !== 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') console.warn(w); });

const config = loadConfig();
const stateDir = path.join(root, 'state');
fs.mkdirSync(stateDir, { recursive: true });

const chats = new ChatManager(config);
const collector = new Collector(config, chats, path.join(stateDir, `homes-${config.port}.json`));
chats.titleFor = id => collector.titleOf(id);
chats.locate = (cwd, sessionId, title) => collector.locate(cwd, sessionId, title);
const aws = new AwsCreds(config.aws, stateDir);
const terminals = new TerminalManager(config.terminal.shell);
collector.terminals = terminals;
chats.terminals = terminals; chats.shellDir = path.join(stateDir, 'shell');
terminals.on('change', () => collector.publish());
const dialogues = new DialogueManager(chats);
collector.dialogues = dialogues;
dialogues.on('change', () => collector.publish());
// Participant chats start here by default: no project CLAUDE.md, so the two sides argue the topic, not a repo.
const scratchDir = path.join(stateDir, 'scratch');
fs.mkdirSync(scratchDir, { recursive: true });

const app = express();
app.use(express.json({ limit: '1mb' }));

function sse(res: Response) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  return { send: (data: unknown, event?: string) => res.write((event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`), stop: () => clearInterval(ping) };
}
const UUID = /^[0-9a-f-]{36}$/i;

app.get('/api/snapshot', (_req, res) => res.json(collector.snapshot));
app.get('/api/config', (_req, res) => res.json({ roles: config.roles, dispatch: config.dispatch, reposRoot: config.reposRoot, port: config.port }));
app.get('/api/events', (req, res) => {
  const s = sse(res);
  s.send(collector.snapshot);
  const onSnap = (snap: unknown) => s.send(snap);
  collector.on('snapshot', onSnap);
  req.on('close', () => { collector.off('snapshot', onSnap); s.stop(); });
});

// AWS credentials (Hub)
app.get('/api/aws/status', async (req, res) => res.json(await aws.status(req.query.force === '1')));
app.post('/api/aws/refresh', (req, res) => res.json(aws.start({ forceLogin: !!req.body?.forceLogin })));
app.post('/api/aws/cancel', (_req, res) => { aws.login?.kill(); res.json({ ok: true }); });

// Background sessions
app.get('/api/sessions/:id/logs', async (req, res) => {
  if (!/^[a-z0-9-]{4,40}$/i.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  try { res.json({ logs: await run('claude', ['logs', req.params.id]) }); }
  catch (err) { res.status(500).json({ error: errText(err) }); }
});
// `claude rm` drops a background session from the list. It does not start the on-demand daemon itself, so start it and retry once.
app.post('/api/sessions/:id/remove', async (req, res) => {
  if (!/^[a-z0-9]{6,12}$/i.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const rm = () => run('claude', ['rm', req.params.id]);
  try {
    let out: string;
    try { out = await rm(); }
    catch (err) {
      if (!/background service/i.test(errText(err))) throw err;
      spawn('claude', ['daemon', 'run'], { detached: true, stdio: 'ignore', shell: process.platform === 'win32', windowsHide: true }).unref();
      await new Promise(r => setTimeout(r, 6000));
      out = await rm();
    }
    await collector.pollAgents(); collector.publish(); res.json({ ok: true, out: out.trim() });
  } catch (err) { res.status(500).json({ error: errText(err) }); }
});

// Saved conversations
app.get('/api/conversations/:sessionId/history', async (req, res) => {
  if (!UUID.test(req.params.sessionId)) return res.status(400).json({ error: 'bad session id' });
  try { res.json({ history: await conversationHistory(req.params.sessionId) }); }
  catch (err) { res.status(500).json({ error: errText(err) }); }
});
app.post('/api/conversations/:sessionId/rename', async (req, res) => {
  if (!UUID.test(req.params.sessionId)) return res.status(400).json({ error: 'bad session id' });
  const title = String(req.body?.title || '').trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: 'empty title' });
  try { await renameSession(req.params.sessionId, title); await collector.pollConversations(); collector.publish(); res.json({ ok: true, title }); }
  catch (err) { res.status(500).json({ error: errText(err) }); }
});

// Pin a session to a worktree (or clear the pin) when the automatic placement is wrong.
app.post('/api/conversations/:sessionId/home', (req, res) => {
  if (!UUID.test(req.params.sessionId)) return res.status(400).json({ error: 'bad session id' });
  const wt = req.body?.worktree ? String(req.body.worktree) : null;
  if (wt && !collector.repos.some(r => r.worktrees.some(w => w.path.toLowerCase() === wt.toLowerCase()))) return res.status(400).json({ error: 'not a tracked worktree' });
  collector.pin(req.params.sessionId, wt);
  res.json({ ok: true });
});

// Chats: one live SDK session per chat. Resuming a session that is open in a terminal forks it.
app.post('/api/chats', (req, res) => {
  const { sessionId, cwd, model, permissionMode } = req.body || {};
  if (sessionId && !UUID.test(sessionId)) return res.status(400).json({ error: 'bad session id' });
  const dir = cwd || config.reposRoot;
  if (!fs.existsSync(dir)) return res.status(400).json({ error: `cwd not found: ${dir}` });
  const running = !!sessionId && collector.agents.some(a => a.sessionId === sessionId);
  res.json(chats.open({ sessionId, cwd: dir, model, permissionMode, fork: running }).summary());
});
app.get('/api/chats', (_req, res) => res.json(chats.list()));
app.get('/api/chats/:id/commands', async (req, res) => { const c = chats.get(req.params.id); c ? res.json(await c.commandList()) : res.status(404).json({ error: 'no such chat' }); });
app.get('/api/chats/:id/models', async (req, res) => { const c = chats.get(req.params.id); c ? res.json(await c.modelList()) : res.status(404).json({ error: 'no such chat' }); });
app.post('/api/chats/:id/model', async (req, res) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).json({ error: 'no such chat' });
  const model = String(req.body?.model || '').trim(); if (!model) return res.status(400).json({ error: 'no model given' });
  try { await c.setModel(model); res.json(c.summary()); } catch (e: any) { res.status(409).json({ error: String(e.message || e) }); }
});
app.get('/api/chats/:id', (req, res) => { const c = chats.get(req.params.id); c ? res.json(c.summary()) : res.status(404).json({ error: 'no such chat' }); });
app.get('/api/chats/:id/events', (req, res) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).end();
  const s = sse(res);
  s.send(c.summary(), 'chat');
  for (const ev of c.events) s.send(ev);
  const onEv = (ev: unknown) => s.send(ev);
  c.on('event', onEv);
  req.on('close', () => { c.off('event', onEv); s.stop(); });
});
app.post('/api/chats/:id/send', (req, res) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).json({ error: 'no such chat' });
  const text = String(req.body?.text || '').trim(); if (!text) return res.status(400).json({ error: 'empty' });
  const from = req.body?.fromChatId ? chats.get(String(req.body.fromChatId)) : null;
  const origin = from && from.id !== c.id ? { kind: 'manual' as const, fromChatId: from.id, fromTitle: from.title } : undefined;
  try { c.send(text, origin); res.json({ ok: true }); } catch (err: any) { res.status(409).json({ error: err.message }); }
});
app.post('/api/chats/:id/permission', (req, res) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).json({ error: 'no such chat' });
  res.json({ ok: c.resolvePermission(String(req.body?.id || ''), req.body?.behavior === 'allow' ? 'allow' : 'deny', req.body?.message) });
});
// `!` commands: run in the chat's own shell. Output streams on the chat's event feed; the model only sees it when sent.
app.post('/api/chats/:id/shell', (req, res) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).json({ error: 'no such chat' });
  const cmd = String(req.body?.cmd || '').trim(); if (!cmd) return res.status(400).json({ error: 'empty command' });
  try { const run = c.runShell(cmd); res.json({ id: run.id, terminalId: run.terminalId }); }
  catch (e: any) { res.status(409).json({ error: String(e.message || e) }); }
});
app.post('/api/chats/:id/shell/interrupt', (req, res) => { const c = chats.get(req.params.id); if (!c) return res.status(404).end(); res.json({ ok: c.interruptShell() }); });
app.post('/api/chats/:id/shell/:runId/send', (req, res) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).json({ error: 'no such chat' });
  try { c.sendShellRun(req.params.runId); res.json({ ok: true }); } catch (e: any) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/chats/:id/interrupt', async (req, res) => { const c = chats.get(req.params.id); if (!c) return res.status(404).end(); await c.interrupt(); res.json({ ok: true }); });
app.delete('/api/chats/:id', (req, res) => { const c = chats.get(req.params.id); if (!c) return res.status(404).end(); c.close(); res.json({ ok: true }); });

// Dialogues: two chats talking about a topic, Fleet relaying each turn. The person is the moderator: pause, steer, extend, stop.
app.post('/api/dialogues', (req, res) => {
  const b = req.body || {};
  const dir = b.cwd ? String(b.cwd) : scratchDir;
  if (!fs.existsSync(dir)) return res.status(400).json({ error: `cwd not found: ${dir}` });
  try { res.json(dialogues.start({ topic: b.topic, rounds: b.rounds, maxWords: b.maxWords, cwd: dir, permissionMode: b.permissionMode, participants: b.participants }).summary()); }
  catch (err) { res.status(400).json({ error: errText(err) }); }
});
app.get('/api/dialogues', (_req, res) => res.json(dialogues.list()));
app.get('/api/dialogues/:id', (req, res) => { const d = dialogues.get(req.params.id); d ? res.json(d.summary()) : res.status(404).json({ error: 'no such dialogue' }); });
app.get('/api/dialogues/:id/transcript.md', (req, res) => { const d = dialogues.get(req.params.id); d ? res.type('text/markdown').send(d.transcript()) : res.status(404).json({ error: 'no such dialogue' }); });
app.get('/api/dialogues/:id/events', (req, res) => {
  const d = dialogues.get(req.params.id); if (!d) return res.status(404).end();
  const s = sse(res);
  s.send(d.summary(), 'dialogue');
  for (const ev of d.events) s.send(ev);
  const onEv = (ev: unknown) => { s.send(ev); s.send(d.summary(), 'dialogue'); };
  d.on('event', onEv);
  req.on('close', () => { d.off('event', onEv); s.stop(); });
});
for (const action of ['pause', 'resume', 'stop', 'steer', 'extend'] as const) {
  app.post(`/api/dialogues/:id/${action}`, (req, res) => {
    const d = dialogues.get(req.params.id); if (!d) return res.status(404).json({ error: 'no such dialogue' });
    try {
      if (action === 'steer') d.steer(String(req.body?.text || ''));
      else if (action === 'extend') d.extend(Number(req.body?.rounds) || 1);
      else d[action]();
      res.json(d.summary());
    } catch (err) { res.status(400).json({ error: errText(err) }); }
  });
}
app.delete('/api/dialogues/:id', (req, res) => dialogues.remove(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'no such dialogue' }));

// Terminals: a shell per tab, attached over a WebSocket. REST creates and lists; the socket carries keystrokes and output.
app.get('/api/terminals', (_req, res) => res.json(terminals.list()));
app.post('/api/terminals', (req, res) => {
  const dir = String(req.body?.cwd || config.reposRoot);
  if (!fs.existsSync(dir)) return res.status(400).json({ error: `cwd not found: ${dir}` });
  try { res.json(terminals.open({ cwd: dir, cols: Number(req.body?.cols) || undefined, rows: Number(req.body?.rows) || undefined }).summary()); }
  catch (err) { res.status(500).json({ error: `could not start a shell: ${errText(err)}` }); }
});
app.delete('/api/terminals/:id', (req, res) => terminals.close(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'no such terminal' }));

// Browsers do not apply same-origin rules to WebSockets, so any web page could otherwise open a shell here. Only Fleet's own pages may.
function originAllowed(req: IncomingMessage): boolean {
  const o = req.headers.origin;
  if (!o) return true; // not a browser
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o);
}
function attachTerminal(ws: WebSocket, t: Terminal) {
  const send = (m: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
  if (t.scrollback) send({ t: 'out', d: t.scrollback });
  if (t.exitCode != null) send({ t: 'exit', code: t.exitCode });
  const onData = (d: string) => send({ t: 'out', d });
  const onExit = (code: number) => send({ t: 'exit', code });
  t.on('data', onData); t.on('exit', onExit);
  ws.on('message', raw => {
    let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.t === 'in' && typeof m.d === 'string') t.write(m.d);
    else if (m.t === 'resize') t.resize(Number(m.cols), Number(m.rows));
    else if (m.t === 'title' && typeof m.title === 'string') t.setTitle(m.title);
  });
  ws.on('close', () => { t.off('data', onData); t.off('exit', onExit); });
}

// Built web app (vite build → dist/web). In dev, Vite serves the app and proxies /api here.
const webDist = path.join(root, 'dist', 'web');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api\/).*/, (_req: Request, res: Response) => res.sendFile(path.join(webDist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.type('text').send(`claude-fleet API on :${config.port}. No built web app found; run "npm run build" or use "npm run dev" for the Vite dev server.`));
}

collector.start();
chats.persistTo(path.join(stateDir, `chats-${config.port}.json`));
dialogues.persistTo(path.join(stateDir, `dialogues-${config.port}.json`));
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const m = /^\/api\/terminals\/([a-z0-9]{4,16})\/ws$/i.exec(req.url || '');
  const t = m && originAllowed(req) ? terminals.get(m[1]) : null;
  if (!t) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => attachTerminal(ws, t));
});
server.listen(config.port, '127.0.0.1', () => {
  console.log(`claude-fleet API on http://127.0.0.1:${config.port}  repos=${config.reposRoot}${fs.existsSync(webDist) ? '  web=dist/web' : '  web=none'}`);
  const reopened = chats.reopen();
  if (reopened) console.log(`reopened ${reopened} chat(s) from the previous run`);
  const kept = dialogues.reopen();
  if (kept) console.log(`restored ${kept} dialogue(s); live ones are paused until resumed`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { terminals.closeAll(); process.exit(0); });
