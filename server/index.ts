import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { deleteSession, renameSession } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig, root } from './config.js';
import { Collector } from './collector.js';
import { ChatManager } from './chat.js';
import { AwsCreds } from './aws.js';
import { Teleport } from './teleport.js';
import { TerminalManager, type Terminal } from './terminals.js';
import { DialogueManager } from './dialogue.js';
import { TaskManager } from './tasks.js';
import { JiraClient, JiraWatcher, ticketKey } from './jira.js';
import { conversationHistory, exportMarkdown } from './sources/conversations.js';
import { openFile, openFolder, preview, rawImage, statRefs, suggestFiles } from './files.js';
import { run, errText } from './util.js';

// Fleet tools are deliberately auto-approved via allowedTools; the SDK warns about that on every chat start.
process.on('warning', w => { if ((w as any).code !== 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') console.warn(w); });

const config = loadConfig();
const stateDir = path.join(root, 'state');
fs.mkdirSync(stateDir, { recursive: true });

const chats = new ChatManager(config);
const collector = new Collector(config, chats, path.join(stateDir, `homes-${config.port}.json`), path.join(stateDir, `conversation-marks-${config.port}.json`));
chats.titleFor = id => collector.titleOf(id);
chats.locate = (cwd, sessionId, title) => collector.locate(cwd, sessionId, title);
const aws = new AwsCreds(config.aws, stateDir, process.env.FLEET_CONFIG || path.join(root, 'fleet.config.json'));
const teleport = new Teleport(config.teleport, stateDir);
const terminals = new TerminalManager(config.terminal.shell);
collector.terminals = terminals;
chats.terminals = terminals; chats.teleport = teleport; chats.shellDir = path.join(stateDir, 'shell'); chats.attachDir = path.join(stateDir, 'attachments');
terminals.on('change', () => collector.publish());
const dialogues = new DialogueManager(chats);
collector.dialogues = dialogues;
dialogues.on('change', () => collector.publish());
const tasks = new TaskManager(chats, config);
collector.tasks = tasks;
tasks.on('change', () => collector.publish());
// Where a ticket gets worked: jira.repos by project key, else a ticket label that names a repo Fleet knows.
const folderFor = (project: string, labels: string[]) => {
  const mapped = config.jira.repos[project.toUpperCase()];
  if (mapped && fs.existsSync(mapped)) return mapped;
  const names = new Set(labels.map(l => l.toLowerCase()));
  return collector.repos.find(r => names.has(r.name.toLowerCase()))?.path || null;
};
const jira = new JiraWatcher(config.jira, new JiraClient(config.jira), tasks, folderFor, path.join(stateDir, `jira-claimed-${config.port}.json`));
collector.jira = jira;
jira.on('change', () => collector.publish());
// Participant chats start here by default: no project CLAUDE.md, so the two sides argue the topic, not a repo.
const scratchDir = path.join(stateDir, 'scratch');
fs.mkdirSync(scratchDir, { recursive: true });

const app = express();
// Sending a message can carry attachments (base64 images and files), so that one route takes a larger body.
const smallJson = express.json({ limit: '1mb' }), sendJson = express.json({ limit: '60mb' });
app.use((req, res, next) => (/^\/api\/chats\/[^/]+\/send$/.test(req.path) ? sendJson : smallJson)(req, res, next));

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
app.post('/api/aws/switch-user', async (_req, res) => res.json(await aws.switchUser()));
app.get('/api/aws/profiles', async (_req, res) => res.json({ profiles: await aws.profiles() }));
app.post('/api/aws/setup', async (req, res) => {
  try { await aws.setup(String(req.body?.profile || '')); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: (err as Error).message }); }
});
app.post('/api/aws/reset', (_req, res) => {
  if (!aws.enabled) return res.status(400).json({ error: 'No AWS profile set up yet' });
  // reset.sh is a personal script. Without it the button runs the built-in refresh: silent first, then a browser login.
  if (fs.existsSync(aws.cfg.resetSh)) aws.openReset(); else aws.start();
  res.json({ ok: true });
});
app.post('/api/aws/cancel', (_req, res) => { aws.login?.kill(); res.json({ ok: true }); });

// Teleport session and DB tunnels
const tp = (fn: (req: Request) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
  try { res.json(await fn(req)); } catch (err) { res.status(400).json({ error: errText(err) }); }
};
app.get('/api/teleport/status', tp(req => teleport.status(req.query.force === '1')));
app.post('/api/teleport/login', tp(() => teleport.startLogin()));
app.post('/api/teleport/cancel', tp(() => { teleport.cancelLogin(); return { ok: true }; }));
app.post('/api/teleport/tunnels/start-all', tp(req => teleport.startAll(!!req.body?.includeProd)));
app.post('/api/teleport/tunnels/:alias/start', tp(req => teleport.start(req.params.alias)));
app.post('/api/teleport/tunnels/:alias/stop', tp(req => teleport.stop(req.params.alias)));
app.post('/api/teleport/probe', tp(req => teleport.probe(req.body?.alias)));

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
// Parsed history is kept until the transcript file changes, so switching back to a chat tab does not re-read and re-parse it.
const historyCache = new Map<string, { stamp: string; history: unknown }>();
function transcriptStamp(sessionId: string): string | null {
  const c = collector.conversations.find(x => x.sessionId === sessionId);
  if (!c?.cwd) return null;
  try { const st = fs.statSync(path.join(config.claudeHome, 'projects', c.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`)); return `${st.size}:${st.mtimeMs}`; }
  catch { return null; }
}
app.get('/api/conversations/:sessionId/history', async (req, res) => {
  const id = req.params.sessionId;
  if (!UUID.test(id)) return res.status(400).json({ error: 'bad session id' });
  try {
    const stamp = transcriptStamp(id), hit = historyCache.get(id);
    if (stamp && hit?.stamp === stamp) return res.json({ history: hit.history });
    const history = await conversationHistory(id);
    if (stamp) { historyCache.delete(id); historyCache.set(id, { stamp, history }); if (historyCache.size > 40) historyCache.delete(historyCache.keys().next().value!); }
    res.json({ history });
  }
  catch (err) { res.status(500).json({ error: errText(err) }); }
});
app.post('/api/conversations/:sessionId/rename', async (req, res) => {
  if (!UUID.test(req.params.sessionId)) return res.status(400).json({ error: 'bad session id' });
  const title = String(req.body?.title || '').trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: 'empty title' });
  try { await renameSession(req.params.sessionId, title); await collector.pollConversations(); collector.publish(); res.json({ ok: true, title }); }
  catch (err) { res.status(500).json({ error: errText(err) }); }
});
app.post('/api/conversations/:sessionId/archive', (req, res) => {
  if (!UUID.test(req.params.sessionId)) return res.status(400).json({ error: 'bad session id' });
  collector.archive(req.params.sessionId, req.body?.archived !== false);
  res.json({ ok: true });
});
app.post('/api/conversations/:sessionId/pin', (req, res) => {
  if (!UUID.test(req.params.sessionId)) return res.status(400).json({ error: 'bad session id' });
  collector.pinToTop(req.params.sessionId, req.body?.pinned !== false);
  res.json({ ok: true });
});
// The whole transcript as markdown, downloaded as a file.
app.get('/api/conversations/:sessionId/export', async (req, res) => {
  const id = req.params.sessionId;
  if (!UUID.test(id)) return res.status(400).json({ error: 'bad session id' });
  const c = collector.snapshot.conversations.find(c => c.sessionId === id);
  const title = c?.title || id;
  try {
    const md = await exportMarkdown(id, { title, cwd: c?.cwd || null, branch: c?.branch || (c?.gitBranch !== 'HEAD' && c?.gitBranch) || null, createdAt: c?.createdAt || null, lastModified: c?.lastModified || null });
    const name = `${title.replace(/[^\w .-]+/g, '').trim().slice(0, 80) || id}.md`;
    res.set({ 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}` }).send(md);
  } catch (err) { res.status(500).json({ error: errText(err) }); }
});
// Deletes the transcript for good (and its subagent transcripts). A conversation that is running somewhere is refused.
app.delete('/api/conversations/:sessionId', async (req, res) => {
  const id = req.params.sessionId;
  if (!UUID.test(id)) return res.status(400).json({ error: 'bad session id' });
  const live = collector.snapshot.conversations.find(c => c.sessionId === id);
  if (live?.running || live?.chat) return res.status(409).json({ error: 'this conversation is running; close it first' });
  try {
    await deleteSession(id);
    collector.marks.forget(id); collector.pin(id, null);
    await collector.pollConversations(); collector.publish();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: errText(err) }); }
});

// A worktree opened in VS Code or the file manager. Only paths Fleet tracks.
app.post('/api/worktrees/open', (req, res) => {
  const p = String(req.body?.path || '');
  const wt = collector.repos.flatMap(r => r.worktrees).find(w => w.path.toLowerCase() === p.toLowerCase());
  if (!wt) return res.status(400).json({ error: 'not a tracked worktree' });
  try { openFolder(wt.path, req.body?.how === 'editor' ? 'editor' : 'folder'); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: errText(err) }); }
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
// MCP servers per chat: status, reconnect, on/off. Signing in to a server that needs it happens in a terminal running `claude` (`/mcp`), which the SDK cannot do for us.
app.get('/api/chats/:id/mcp', async (req, res) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).json({ error: 'no such chat' });
  try { res.json(await c.mcpList()); } catch (e: any) { res.status(409).json({ error: String(e.message || e) }); }
});
app.post('/api/chats/:id/mcp/login', (req, res) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).json({ error: 'no such chat' });
  try { const t = terminals.open({ cwd: c.cwd }); t.write('claude\r'); res.json(t.summary()); }
  catch (err) { res.status(500).json({ error: `could not start a shell: ${errText(err)}` }); }
});
app.post('/api/chats/:id/mcp/:name/:action', async (req, res) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).json({ error: 'no such chat' });
  const { name, action } = req.params;
  if (!['reconnect', 'enable', 'disable'].includes(action)) return res.status(400).json({ error: `unknown action: ${action}` });
  try {
    if (action === 'reconnect') await c.mcpReconnect(name); else await c.mcpToggle(name, action === 'enable');
    res.json(await c.mcpList());
  } catch (e: any) { res.status(409).json({ error: String(e.message || e) }); }
});
// Files named in a chat: which exist (so only real ones become links), a preview, and opening them outside Fleet. Paths resolve from the chat's folder.
app.post('/api/chats/:id/files/resolve', (req, res) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).json({ error: 'no such chat' });
  const paths = Array.isArray(req.body?.paths) ? req.body.paths.slice(0, 200).map(String) : [];
  res.json(statRefs(c.cwd, paths));
});
app.get('/api/chats/:id/file', (req, res) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).json({ error: 'no such chat' });
  try { res.json(preview(c.cwd, String(req.query.path || ''))); } catch (err) { res.status(404).json({ error: errText(err) }); }
});
app.get('/api/chats/:id/file/raw', (req, res) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).end();
  try {
    const { abs, type } = rawImage(c.cwd, String(req.query.path || ''));
    res.set({ 'Content-Type': type, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff' }).sendFile(abs);
  } catch { res.status(404).end(); }
});
app.post('/api/chats/:id/file/open', (req, res) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).json({ error: 'no such chat' });
  const how = req.body?.how === 'editor' || req.body?.how === 'reveal' ? req.body.how : 'default';
  try { openFile(c.cwd, String(req.body?.path || ''), how, Number(req.body?.line) || undefined); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: errText(err) }); }
});
app.get('/api/chats/:id', (req, res) => { const c = chats.get(req.params.id); c ? res.json(c.summary()) : res.status(404).json({ error: 'no such chat' }); });
app.get('/api/chats/:id/events', (req, res) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).end();
  c.wake(); // someone is looking at it: start a chat that was restored asleep
  const s = sse(res);
  s.send(c.summary(), 'chat');
  for (const ev of c.events) s.send(ev);
  const onEv = (ev: unknown) => s.send(ev);
  c.on('event', onEv);
  req.on('close', () => { c.off('event', onEv); s.stop(); });
});
app.post('/api/chats/:id/send', (req, res) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).json({ error: 'no such chat' });
  const text = String(req.body?.text || '').trim();
  const raw = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  if (raw.length > 20) return res.status(400).json({ error: 'at most 20 attachments per message' });
  const attachments = raw.map((a: any) => ({ name: String(a?.name || 'file'), mediaType: String(a?.mediaType || 'application/octet-stream'), data: String(a?.data || '') }));
  if (attachments.some((a: { data: string }) => !a.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data))) return res.status(400).json({ error: 'attachment data must be base64' });
  if (!text && !attachments.length) return res.status(400).json({ error: 'empty' });
  const from = req.body?.fromChatId ? chats.get(String(req.body.fromChatId)) : null;
  // A saved conversation has no chat to name, only its title.
  const fromTitle = req.body?.fromTitle ? String(req.body.fromTitle).slice(0, 120) : '';
  const origin = from && from.id !== c.id ? { kind: 'manual' as const, fromChatId: from.id, fromTitle: from.title }
    : fromTitle ? { kind: 'manual' as const, fromChatId: '', fromTitle } : undefined;
  try { c.send(text, origin, attachments); res.json({ ok: true }); } catch (err: any) { res.status(409).json({ error: err.message }); }
});
const answersOf = (a: unknown): Record<string, string> | undefined => a && typeof a === 'object' && !Array.isArray(a)
  ? Object.fromEntries(Object.entries(a).filter(([, v]) => typeof v === 'string')) as Record<string, string> : undefined;
app.post('/api/chats/:id/permission', (req, res) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).json({ error: 'no such chat' });
  const b = req.body || {};
  res.json({ ok: c.resolvePermission(String(b.id || ''), { behavior: b.behavior === 'allow' ? 'allow' : 'deny', message: b.message ? String(b.message) : undefined, answers: answersOf(b.answers), always: !!b.always, mode: b.mode ? String(b.mode) : undefined }) });
});
const guarded = (fn: (c: import('./chat.js').Chat, req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  const c = chats.get(req.params.id); if (!c) return res.status(404).json({ error: 'no such chat' });
  try { res.json(await fn(c, req)); } catch (e: any) { res.status(409).json({ error: String(e.message || e) }); }
};
app.post('/api/chats/:id/mode', guarded(async (c, req) => { await c.setPermissionMode(String(req.body?.mode || '')); return c.summary(); }));
app.post('/api/chats/:id/effort', guarded(async (c, req) => { await c.setEffort(req.body?.effort ? String(req.body.effort) : null); return c.summary(); }));
app.get('/api/chats/:id/context', guarded(c => c.contextUsage()));
app.post('/api/chats/:id/rewind', guarded((c, req) => c.rewind(String(req.body?.uuid || ''), req.body?.dryRun !== false)));
app.post('/api/chats/:id/tasks/:taskId/stop', guarded(async (c, req) => { await c.stopTask(req.params.taskId); return { ok: true }; }));
app.get('/api/chats/:id/files/suggest', guarded(async (c, req) => suggestFiles(c.cwd, String(req.query.q || ''))));
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

// Board tasks: queued work that Fleet hands to a chat when a slot frees up. The chat reports back; the person approves or sends it back.
// With a ticket, the task is built from the Jira issue and `prompt` is only extra notes; the folder can come from jira.repos.
app.post('/api/tasks', async (req, res) => {
  const b = req.body || {};
  const dir = b.cwd ? String(b.cwd) : b.ticket ? '' : config.reposRoot;
  if (dir && !fs.existsSync(dir)) return res.status(400).json({ error: `cwd not found: ${dir}` });
  try {
    if (b.ticket) {
      const key = ticketKey(String(b.ticket));
      if (!key) return res.status(400).json({ error: `Not a ticket key or link: ${b.ticket}` });
      return res.json(await jira.taskFor(key, { cwd: dir || undefined, notes: String(b.prompt || ''), model: b.model, permissionMode: b.permissionMode, isolate: b.isolate !== false }));
    }
    res.json(tasks.add({ title: b.title, prompt: b.prompt, cwd: dir, model: b.model, permissionMode: b.permissionMode, isolate: b.isolate !== false }));
  } catch (err) { res.status(400).json({ error: errText(err) }); }
});
app.get('/api/jira/issue/:key', async (req, res) => {
  const key = ticketKey(req.params.key);
  if (!key) return res.status(400).json({ error: 'not a ticket key' });
  try { res.json(await jira.preview(key)); } catch (err) { res.status(400).json({ error: errText(err) }); }
});
app.post('/api/jira/poll', async (_req, res) => res.json(await jira.poll()));
app.post('/api/tasks/clear-done', (_req, res) => { tasks.clearDone(); res.json({ ok: true }); });
for (const action of ['approve', 'send-back', 'retry', 'start'] as const) {
  app.post(`/api/tasks/:id/${action}`, (req, res) => {
    try {
      const id = req.params.id;
      res.json(action === 'approve' ? tasks.approve(id) : action === 'send-back' ? tasks.sendBack(id, String(req.body?.text || '')) : action === 'retry' ? tasks.retry(id) : tasks.startNow(id));
    } catch (err) { res.status(400).json({ error: errText(err) }); }
  });
}
app.delete('/api/tasks/:id', (req, res) => { try { tasks.remove(req.params.id); res.json({ ok: true }); } catch (err) { res.status(404).json({ error: errText(err) }); } });

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
tasks.persistTo(path.join(stateDir, `tasks-${config.port}.json`));
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
  const board = tasks.reopen();
  if (board) console.log(`restored ${board} task(s)`);
  jira.start();
  if (jira.status.jql) console.log(`watching Jira every ${config.jira.everyMinutes} min: ${jira.status.jql}`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { terminals.closeAll(); process.exit(0); });
