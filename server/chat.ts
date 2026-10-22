import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { query, type SDKUserMessage, type Query } from '@anthropic-ai/claude-agent-sdk';
import { createFleetServer, FLEET_TOOL_NAMES } from './fleetTools.js';
import { summarizeInput, editPreview, todoList, cut } from './sources/conversations.js';
import type { TodoItem } from '../shared/types.js';
import type { FleetConfig } from './config.js';
import { ShellRunner } from './shellRunner.js';
import type { TerminalManager } from './terminals.js';
import type { Teleport } from './teleport.js';
import type { AskQuestion, Attachment, ChatEvent, ContextUsage, PermissionChoice, RewindPreview, ChatStatus, ChatSummary, ContentBlock, McpServerView, MessageOrigin, ModelOption, PermissionView, SlashCommandView, TokenUsage } from '../shared/types.js';

// Async queue the SDK consumes as its prompt stream: one live subprocess per chat, prompts pushed in over time.
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []; private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = []; closed = false;
  push(v: SDKUserMessage) { const w = this.waiters.shift(); w ? w({ value: v, done: false }) : this.items.push(v); }
  close() { this.closed = true; for (const w of this.waiters.splice(0)) w({ value: undefined as any, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return { next: () => this.items.length ? Promise.resolve({ value: this.items.shift()!, done: false })
      : this.closed ? Promise.resolve({ value: undefined as any, done: true })
      : new Promise(r => this.waiters.push(r)) };
  }
}

// Distributive Omit: a plain Omit over the union would collapse it to the shared keys.
type ChatEventInput = ChatEvent extends infer E ? (E extends ChatEvent ? Omit<E, 'at'> : never) : never;

interface AskRecord { id: string; fromChatId: string; toChatId: string; unambiguous: boolean; resolve: (v: string) => void; reject: (e: Error) => void }
interface Pending { resolve: (r: any) => void; input: Record<string, unknown>; view: PermissionView; suggestions: unknown[] }
interface OpenOptions { sessionId?: string | null; cwd: string; model?: string; fork?: boolean; permissionMode?: string; id?: string; taskId?: string | null; lazy?: boolean }
type Located = { repo: string; branch: string | null; path: string; by: import('../shared/types.js').LocatedBy } | null;

export class ChatManager extends EventEmitter {
  config: FleetConfig; chats = new Map<string, Chat>(); asks = new Map<string, AskRecord>();
  titleFor: (sessionId: string | null) => string | null = () => null;
  locate: (cwd: string, sessionId?: string | null, title?: string) => Located = () => null;
  /** For `!` commands: the shells live in the terminal manager so they show in the sidebar and can open as tabs. */
  terminals: TerminalManager | null = null; shellDir = '';
  /** For the fleet_teleport_* tools, so a chat can check and fix its own DB tunnel. */
  teleport: Teleport | null = null;
  /** Dropped files that are not sent as images are saved here; every chat may read it without asking. */
  attachDir = '';
  private persistFile: string | null = null;

  constructor(config: FleetConfig) { super(); this.config = config; }

  list(): ChatSummary[] { return [...this.chats.values()].map(c => c.summary()); }
  get(id: string) { return this.chats.get(id); }
  bySession(sessionId: string) { return [...this.chats.values()].find(c => c.sessionId === sessionId && c.status !== 'ended'); }

  open({ sessionId, cwd, model, fork, permissionMode, id, taskId, lazy }: OpenOptions): Chat {
    const existing = sessionId ? this.bySession(sessionId) : undefined;
    if (existing) return existing;
    const chat = new Chat(this, { sessionId: sessionId || null, cwd, model: model || this.config.dispatch.defaultModel, fork: !!fork, permissionMode: permissionMode || this.config.dispatch.permissionMode, id });
    chat.taskId = taskId || null;
    this.chats.set(chat.id, chat);
    if (lazy) chat.sleep(); else chat.start();
    return chat;
  }

  // Reopened chats come back asleep (no Claude process) and wake on first use, so a restart does not boot every saved chat, and its MCP servers, at once.
  // Live chats are written to disk on every change so a server restart can reopen them (resumed, not forked).
  persistTo(file: string) { this.persistFile = file; this.on('change', () => this.save()); }
  save() {
    if (!this.persistFile) return;
    const live = [...this.chats.values()].filter(c => c.status !== 'ended' && c.sessionId).map(c => ({ id: c.id, sessionId: c.sessionId, cwd: c.cwd, model: c.model, permissionMode: c.permissionMode, taskId: c.taskId }));
    try { writeFileSync(this.persistFile, JSON.stringify(live, null, 1)); } catch {}
  }
  reopen(): number {
    if (!this.persistFile || !existsSync(this.persistFile)) return 0;
    let saved: any[] = [];
    try { saved = JSON.parse(readFileSync(this.persistFile, 'utf8')); } catch { return 0; }
    for (const s of saved) if (s.sessionId && s.cwd && existsSync(s.cwd)) this.open({ id: typeof s.id === 'string' && /^[0-9a-f]{8}$/.test(s.id) ? s.id : undefined, sessionId: s.sessionId, cwd: s.cwd, model: s.model, permissionMode: s.permissionMode, taskId: typeof s.taskId === 'string' ? s.taskId : null, fork: false, lazy: true });
    return saved.length;
  }

  // Ask: deliver to the target with an ask id; resolved by fleet_reply, or by the target's next turn result when that turn is unambiguous.
  ask(from: Chat, to: Chat, question: string, timeoutMs: number): Promise<string> {
    const id = randomUUID().slice(0, 6);
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.asks.delete(id); from.asksOut = from.asksOut.filter(a => a.id !== id); to.asksIn = to.asksIn.filter(a => a.id !== id); this.emit('change'); };
      const rec: AskRecord = { id, fromChatId: from.id, toChatId: to.id, unambiguous: to.status === 'idle' || to.status === 'needs-you',
        resolve: v => { finish(); resolve(v); }, reject: e => { finish(); reject(e); } };
      const timer = setTimeout(() => rec.reject(new Error(`"${to.title}" did not answer within ${Math.round(timeoutMs / 1000)}s. It may still be working; try fleet_read or ask again.`)), timeoutMs);
      this.asks.set(id, rec); from.asksOut.push(rec); to.asksIn.push(rec);
      to.send(question, { kind: 'peer', fromChatId: from.id, fromTitle: from.title, askId: id });
      this.emit('change');
    });
  }

  reply(from: Chat, askId: string, answer: string): boolean {
    const rec = this.asks.get(askId); if (!rec || rec.toChatId !== from.id) return false;
    rec.resolve(answer);
    return true;
  }
}


const INLINE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_INLINE_IMAGE = 5 * 1024 * 1024; // the API's per-image limit, measured on the base64 text

/** The questions in an AskUserQuestion call, trimmed to what the card needs. Malformed ones are dropped, so a bad call falls back to Allow/Deny. */
function askQuestions(input: Record<string, unknown>): AskQuestion[] {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  return qs.filter((q: any) => q && typeof q.question === 'string' && Array.isArray(q.options)).map((q: any) => ({
    question: q.question, header: typeof q.header === 'string' ? q.header : '', multiSelect: !!q.multiSelect,
    options: q.options.filter((o: any) => o && typeof o.label === 'string').map((o: any) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : '' })),
  }));
}

const zeroUsage = (): TokenUsage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

export class Chat extends EventEmitter {
  mgr: ChatManager; id = randomUUID().slice(0, 8);
  resumeId: string | null; sessionId: string | null; cwd: string; model: string; fork: boolean; permissionMode: string;
  status: ChatStatus = 'starting'; events: ChatEvent[] = []; pending = new Map<string, Pending>(); inbox = new Inbox();
  abort = new AbortController(); startedAt = Date.now(); error: string | null = null;
  firstText = ''; asksIn: AskRecord[] = []; asksOut: AskRecord[] = []; turnText = '';
  /** A dialogue names its participants ("Critic · topic") and owns their turns; both show in the summary. */
  label: string | null = null; dialogueId: string | null = null;
  /** The board task this chat works on. Set before start(), so the chat gets the fleet_report tool. */
  taskId: string | null = null;
  // Token accounting. `turn` accumulates over the model steps of the current turn; `stepOutput` is what the current step has reported so far
  // (message_delta carries a cumulative count). `context` is the prompt size at the latest step. `total` comes from the SDK, cumulative per session.
  turn: TokenUsage = zeroUsage(); private stepOutput = 0; context = 0; total: TokenUsage | null = null; contextWindow: number | null = null;
  private q: Query | null = null;
  private commands: import('@anthropic-ai/claude-agent-sdk').SlashCommand[] = [];
  private terminalCommands = new Set<string>();
  private models: import('@anthropic-ai/claude-agent-sdk').ModelInfo[] = [];
  private shell: ShellRunner | null = null;
  effort: string | null = null;
  /** Ids given to the messages sent in this process, so files can be rewound to before one. */
  private userUuids = new Set<string>();

  constructor(mgr: ChatManager, opts: { sessionId: string | null; cwd: string; model: string; fork: boolean; permissionMode: string; id?: string }) {
    super();
    if (opts.id) this.id = opts.id; // reopened after a restart: same id, so open tabs still point at it
    this.mgr = mgr; this.resumeId = opts.sessionId; this.sessionId = opts.sessionId;
    this.cwd = opts.cwd; this.model = opts.model; this.fork = opts.fork; this.permissionMode = opts.permissionMode;
  }

  get title(): string { return this.label || this.mgr.titleFor(this.sessionId) || this.firstText.slice(0, 60) || `chat ${this.id}`; }

  summary(): ChatSummary {
    const wt = this.mgr.locate(this.cwd, this.sessionId || this.resumeId, this.title);
    return { id: this.id, sessionId: this.sessionId, resumeId: this.resumeId, forked: this.fork, cwd: this.cwd, model: this.model, title: this.title,
      repo: wt?.repo || null, branch: wt?.branch || null, worktree: wt?.path || null, locatedBy: wt?.by || null,
      permissionMode: this.permissionMode, effort: this.effort, status: this.status, startedAt: this.startedAt, pending: [...this.pending.values()].map(p => p.view), error: this.error,
      asksIn: this.asksIn.map(a => ({ id: a.id, from: a.fromChatId })), asksOut: this.asksOut.map(a => ({ id: a.id, to: a.toChatId })), dialogueId: this.dialogueId, taskId: this.taskId,
      tokens: this.total ? { total: this.total, context: this.context, contextWindow: this.contextWindow } : null };
  }

  // keep=false for high-rate progress events (shell output snapshots) that would otherwise push real history out of the ring.
  emitEvent(ev: ChatEventInput, keep = true) {
    const full = { ...ev, at: Date.now() } as ChatEvent;
    if (keep) { this.events.push(full); if (this.events.length > 800) this.events.splice(0, this.events.length - 800); }
    this.emit('event', full);
  }

  /** The chat's own shell, started on the first `!`. Its runs stream into the log; nothing reaches the model until sent. */
  private shellRunner(): ShellRunner {
    if (this.shell) return this.shell;
    if (!this.mgr.terminals) throw new Error('terminals are not available');
    const r = new ShellRunner(this.mgr.terminals, this.cwd, this.mgr.shellDir, () => this.title);
    r.on('start', run => this.emitEvent({ t: 'shell', id: run.id, cmd: run.cmd, cwd: run.cwd, terminalId: run.terminalId }));
    r.on('output', run => this.emitEvent({ t: 'shell_out', id: run.id, output: run.output, truncated: run.truncated }, false));
    r.on('done', run => this.emitEvent({ t: 'shell_done', id: run.id, exitCode: run.exitCode, interrupted: run.interrupted, output: run.output, truncated: run.truncated }));
    return this.shell = r;
  }
  runShell(cmd: string) { if (this.status === 'ended') throw new Error('chat ended'); return this.shellRunner().run(cmd); }
  interruptShell() { return this.shell?.interrupt() ?? false; }
  /** "Send to Claude" on a finished run: it goes with a short message so the model knows to look at it. */
  sendShellRun(runId: string) {
    const run = this.shell?.get(runId);
    if (!run || !this.shell!.queue(runId)) throw new Error('no finished shell command with that id');
    this.send('Look at the output of `' + run.cmd + '` above.');
  }
  setStatus(s: ChatStatus) { this.status = s; this.emitEvent({ t: 'status', status: s }); this.mgr.emit('change'); }

  // origin: null for the person typing; peer/manual for fleet traffic; dialogue text arrives already framed by the orchestrator.
  send(text: string, origin?: MessageOrigin, attachments: Attachment[] = []) {
    if (this.status === 'ended') throw new Error('chat ended');
    this.wake();
    if (!this.firstText && !origin) this.firstText = text;
    const { images, files } = this.placeAttachments(attachments);
    let body = text;
    if (origin && origin.kind !== 'dialogue') {
      const head = origin.kind === 'manual' ? `[Forwarded from chat "${origin.fromTitle}" (${origin.fromChatId}) by the user]`
        : `[Fleet message from chat "${origin.fromTitle}" (${origin.fromChatId})${origin.askId ? `, ask_id ${origin.askId}` : ''}]`;
      const tail = origin.askId ? `\n\nAnswer by calling fleet_reply with ask_id "${origin.askId}". Be concise and concrete.` : '';
      body = `${head}\n\n${text}${tail}`;
    }
    // Commands the person ran with `!` since their last message ride along, so "fix that" after `!npm test` just works.
    if (!origin) { const ctx = this.shell?.takeContext(); if (ctx) body = `${ctx}\n\n${body}`; }
    if (files.length) body = `${body}\n\nAttached file${files.length > 1 ? 's' : ''}:\n${files.map(f => `- ${f}`).join('\n')}`.trim();
    const content = images.length ? [...images, ...(body ? [{ type: 'text', text: body }] : [])] : body;
    this.turn = zeroUsage(); this.stepOutput = 0; // a new turn starts with this message
    const uuid = randomUUID(); this.userUuids.add(uuid);
    this.inbox.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid } as SDKUserMessage);
    this.emitEvent({ t: 'user', text, origin: origin || null, uuid, ...(attachments.length ? { attachments: attachments.map(a => a.name) } : {}) });
    this.turnText = '';
    this.setStatus('running');
  }

  /** Images the API takes go inline, as Claude Code sends a pasted image. Anything else, or an image over the API's size limit, is
   *  saved under the attachments folder and named in the message: a browser cannot tell us where a dropped file lives, so Claude reads a copy. */
  private placeAttachments(attachments: Attachment[]) {
    const images: { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }[] = [];
    const files: string[] = [];
    if (!attachments.length) return { images, files };
    const dir = path.join(this.mgr.attachDir, this.id, Date.now().toString(36));
    for (const a of attachments) {
      if (INLINE_IMAGE.has(a.mediaType) && a.data.length <= MAX_INLINE_IMAGE) { images.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } }); continue; }
      mkdirSync(dir, { recursive: true });
      const base = path.basename(a.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
      let file = path.join(dir, base);
      for (let n = 2; existsSync(file); n++) file = path.join(dir, base.replace(/(\.[^.]*)?$/, ` (${n})$1`));
      writeFileSync(file, Buffer.from(a.data, 'base64'));
      files.push(file);
    }
    return { images, files };
  }

  /** `answers` (question text to chosen label or typed text) answers an AskUserQuestion; a deny on one tells Claude the person skipped it. */
  resolvePermission(id: string, c: PermissionChoice): boolean {
    const p = this.pending.get(id); if (!p) return false;
    this.pending.delete(id);
    const asked = !!p.view.questions, plan = p.view.toolName === 'ExitPlanMode';
    if (c.behavior === 'allow') {
      const updates: unknown[] = c.always ? [...p.suggestions] : [];
      if (plan) {
        const mode = c.mode === 'acceptEdits' ? 'acceptEdits' : 'default';
        updates.push({ type: 'setMode', mode, destination: 'session' });
        this.permissionMode = mode; this.emitEvent({ t: 'mode', mode });
      }
      p.resolve({ behavior: 'allow', updatedInput: asked ? { ...p.input, answers: c.answers || {} } : p.input, ...(updates.length ? { updatedPermissions: updates } : {}) });
    } else p.resolve({ behavior: 'deny', message: c.message || (asked ? 'The user skipped these questions. Continue with your best judgment, or ask in plain text.'
      : plan ? 'The user wants to keep planning. Revise the plan or ask what to change.' : 'Denied from dashboard') });
    const behavior = c.behavior;
    this.emitEvent({ t: 'permission_resolved', id, behavior, ...(asked && behavior === 'allow' ? { answers: c.answers || {} } : {}), ...(c.always && behavior === 'allow' ? { always: true } : {}) });
    this.mgr.emit('change');
    return true;
  }

  /** Asks the process for its command list. The call can fail or come back empty while the process is still settling. */
  private async fetchCommands(): Promise<boolean> {
    this.wake();
    if (!this.q) return false;
    try {
      const c = await Promise.race([this.q.supportedCommands(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
      if (c.length) this.commands = c;
      return c.length > 0;
    } catch { return false; }
  }

  /** Commands the composer can offer. Ones bound to a terminal UI (exit, statusline) are left out.
   *  An empty cache is refilled here, so a fetch that failed at init does not leave the popup empty for the chat's lifetime. */
  async commandList(): Promise<SlashCommandView[]> {
    if (!this.commands.length) await this.fetchCommands();
    return this.commands.filter(c => !this.terminalCommands.has(c.name))
      .map(c => ({ name: c.name, description: c.description || '', argumentHint: c.argumentHint || '', aliases: c.aliases || [], builtin: !!c.builtin }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  /** Models the process offers, fetched once. The list depends on the account, so it comes from the process rather than a fixed table. */
  async modelList(): Promise<ModelOption[]> {
    this.wake();
    if (!this.q) return [];
    if (!this.models.length) {
      try { this.models = await Promise.race([this.q.supportedModels(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]); }
      catch { return []; }
    }
    return this.models.map(m => ({ value: m.value, displayName: m.displayName || m.value, description: m.description || '', resolvedModel: m.resolvedModel || null }));
  }
  /** MCP servers as this chat's process sees them. Fleet's own in-process server is left out; it is not something to manage. */
  async mcpList(): Promise<McpServerView[]> {
    this.wake();
    if (this.status === 'ended' || !this.q) throw new Error('chat is not running');
    const list = await Promise.race([this.q.mcpServerStatus(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out asking the chat for its MCP servers')), 8000))]);
    return list.filter(m => m.name !== 'fleet').map(m => ({
      name: m.name, status: m.status, scope: m.scope ?? null, url: (m.config as any)?.url ?? null, tools: m.tools?.length ?? 0, error: m.error ?? null,
    }));
  }
  async mcpReconnect(name: string) { this.wake(); if (!this.q) throw new Error('chat is not running'); await this.q.reconnectMcpServer(name); }
  async mcpToggle(name: string, enabled: boolean) { this.wake(); if (!this.q) throw new Error('chat is not running'); await this.q.toggleMcpServer(name, enabled); }
  /** Switches the live process; the turn in flight finishes on the old model and the next one uses the new. */
  async setModel(model: string) {
    this.wake();
    if (this.status === 'ended' || !this.q) throw new Error('chat is not running');
    await this.q.setModel(model);
    this.model = model;
    this.emitEvent({ t: 'model', model }); this.mgr.emit('change');
  }
  /** Shift+Tab in the terminal: the next tool call is judged under the new mode. */
  async setPermissionMode(mode: string) {
    this.wake();
    if (this.status === 'ended' || !this.q) throw new Error('chat is not running');
    if (!['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'].includes(mode)) throw new Error(`unknown mode: ${mode}`);
    await this.q.setPermissionMode(mode as any);
    this.permissionMode = mode; this.emitEvent({ t: 'mode', mode }); this.mgr.emit('change');
  }
  /** Thinking effort for the following turns. Null goes back to the model's default. */
  async setEffort(level: string | null) {
    this.wake();
    if (this.status === 'ended' || !this.q) throw new Error('chat is not running');
    if (level !== null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(level)) throw new Error(`unknown effort: ${level}`);
    await this.q.applyFlagSettings({ effortLevel: level as any });
    this.effort = level; this.mgr.emit('change');
  }
  /** The window by category, as /context shows it. */
  async contextUsage(): Promise<ContextUsage> {
    this.wake();
    if (this.status === 'ended' || !this.q) throw new Error('chat is not running');
    const u = await Promise.race([this.q.getContextUsage({ detail: 'summary' }), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out asking for context usage')), 10000))]);
    return { total: u.totalTokens, max: u.maxTokens, percentage: u.percentage, model: u.model,
      categories: u.categories.map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind, color: c.color })), memoryFiles: u.memoryFiles.map(m => ({ path: m.path, tokens: m.tokens })) };
  }
  /** Files back to how they were before a message of this chat. Conversation history is not rewound; only files on disk. */
  async rewind(uuid: string, dryRun: boolean): Promise<RewindPreview> {
    this.wake();
    if (this.status === 'ended' || !this.q) throw new Error('chat is not running');
    if (!this.userUuids.has(uuid)) throw new Error('that message was not sent in this chat run');
    const r = await this.q.rewindFiles(uuid, { dryRun });
    return { canRewind: r.canRewind, error: r.error, files: r.filesChanged || [], insertions: r.insertions || 0, deletions: r.deletions || 0 };
  }
  async stopTask(taskId: string) { if (!this.q) throw new Error('chat is not running'); await this.q.stopTask(taskId); }
  async interrupt() { try { await this.q?.interrupt(); } catch (e: any) { this.emitEvent({ t: 'error', message: String(e.message || e) }); } }
  close() {
    this.shell?.close();
    this.inbox.close(); this.abort.abort(); try { this.q?.close(); } catch {}
    for (const a of [...this.asksOut]) a.reject(new Error('asking chat ended'));
    for (const a of [...this.asksIn]) a.reject(new Error(`"${this.title}" ended before answering`));
    this.setStatus('ended');
  }

  private asleep = false;
  /** Restored after a restart without starting the Claude process. Shown as idle; `wake` starts it. */
  sleep() { this.asleep = true; this.setStatus('idle'); }
  /** Starts the process of a chat restored asleep. Called on anything that needs it: viewing, sending, model or MCP calls. */
  wake() { if (!this.asleep || this.status === 'ended') return; this.asleep = false; this.start(); }

  start() {
    const opts: any = {
      cwd: this.cwd, model: this.model, permissionMode: this.permissionMode,
      additionalDirectories: this.mgr.attachDir ? [this.mgr.attachDir] : [],
      includePartialMessages: true, abortController: this.abort, enableFileCheckpointing: true, agentProgressSummaries: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      mcpServers: { fleet: createFleetServer(this.mgr, this) },
      allowedTools: FLEET_TOOL_NAMES,
      canUseTool: (toolName: string, input: Record<string, unknown>, { suggestions }: any) => new Promise(resolve => {
        const id = randomUUID().slice(0, 8);
        const questions = toolName === 'AskUserQuestion' ? askQuestions(input) : undefined;
        const plan = toolName === 'ExitPlanMode' && typeof input.plan === 'string' ? cut(input.plan, 20000) : undefined;
        const edit = editPreview(toolName, input) || undefined;
        const view: PermissionView = { id, toolName, input: summarizeInput(input), suggestions: (suggestions || []).length, ...(questions?.length ? { questions } : {}), ...(plan ? { plan } : {}), ...(edit ? { edit } : {}) };
        this.pending.set(id, { resolve, input, view, suggestions: suggestions || [] });
        this.emitEvent({ t: 'permission', ...view });
        this.setStatus('needs-you');
      }),
    };
    if (this.resumeId) { opts.resume = this.resumeId; if (this.fork) opts.forkSession = true; }
    this.q = query({ prompt: this.inbox, options: opts });
    this.setStatus('idle');
    this.pump().catch(err => { this.error = String(err.message || err); this.emitEvent({ t: 'error', message: this.error! }); this.setStatus('ended'); });
  }

  /** The task list the model keeps for itself. Older tools send the whole list (TodoWrite); newer ones create and update items by id
   *  (TaskCreate, TaskUpdate), where the id is only known from the result. Every change goes out as one `todos` event. */
  private board = new Map<string, TodoItem>();
  private creating = new Map<string, TodoItem>();
  private pushTodos() { this.emitEvent({ t: 'todos', todos: [...this.board.values()] }); }
  private trackTasks(b: any) {
    const input = b.input || {};
    if (b.name === 'TodoWrite') {
      const list = todoList('TodoWrite', input); if (!list) return;
      this.board = new Map(list.map((t, i) => [String(i + 1), t])); this.pushTodos();
    } else if (b.name === 'TaskCreate' && typeof input.subject === 'string') {
      this.creating.set(b.id, { content: input.subject, activeForm: typeof input.activeForm === 'string' && input.activeForm ? input.activeForm : input.subject, status: 'pending' });
    } else if (b.name === 'TaskUpdate' && input.taskId != null) {
      const id = String(input.taskId), t = this.board.get(id);
      if (input.status === 'deleted') { if (this.board.delete(id)) this.pushTodos(); return; }
      if (!t) return;
      if (typeof input.subject === 'string') t.content = input.subject;
      if (typeof input.activeForm === 'string') t.activeForm = input.activeForm;
      if (input.status === 'pending' || input.status === 'in_progress' || input.status === 'completed') t.status = input.status;
      this.pushTodos();
    }
  }
  private taskResult(toolUseId: string, text: string, isError: boolean) {
    const t = this.creating.get(toolUseId); if (!t) return;
    this.creating.delete(toolUseId);
    if (isError) return;
    this.board.set(/#(\d+)/.exec(text)?.[1] || String(this.board.size + 1), t); this.pushTodos();
  }

  /** Subagents and background tasks, tracked by id so the log can show one row per task that updates in place. */
  private tasks = new Map<string, { description: string; kind: string; tools: number; tokens: number; lastTool?: string; summary?: string }>();
  private onTask(msg: any) {
    const id = String(msg.task_id || ''); if (!id) return;
    if (msg.subtype === 'task_updated' && !msg.patch?.status) return;
    const t = this.tasks.get(id) || { description: '', kind: 'task', tools: 0, tokens: 0 };
    if (msg.description) t.description = String(msg.description);
    if (msg.subagent_type) t.kind = String(msg.subagent_type); else if (msg.task_type && t.kind === 'task') t.kind = String(msg.task_type);
    const u = msg.usage; if (u) { t.tools = u.tool_uses ?? t.tools; t.tokens = u.total_tokens ?? t.tokens; }
    if (msg.last_tool_name) t.lastTool = String(msg.last_tool_name);
    if (typeof msg.summary === 'string' && msg.summary) t.summary = msg.summary;
    this.tasks.set(id, t);
    const status = msg.subtype === 'task_notification' ? (['completed', 'failed', 'stopped'].includes(msg.status) ? msg.status : 'completed') : 'running';
    this.emitEvent({ t: 'task', taskId: id, status, description: t.description, kind: t.kind, tools: t.tools, tokens: t.tokens, lastTool: t.lastTool, summary: t.summary });
  }

  private async pump() {
    for await (const m of this.q!) {
      const msg = m as any;
      if (msg.parent_tool_use_id) continue; // subagent traffic stays out of the main thread view
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') {
            this.sessionId = msg.session_id; this.model = msg.model || this.model;
            this.terminalCommands = new Set(msg.terminal_slash_commands || []);
            this.fetchCommands().then(ok => { if (!ok) setTimeout(() => this.fetchCommands(), 1500); });
            this.emitEvent({ t: 'init', sessionId: msg.session_id, model: msg.model }); this.mgr.emit('change');
          }
          else if (msg.subtype === 'commands_changed') this.commands = msg.commands || [];
          else if (msg.subtype === 'task_started' || msg.subtype === 'task_progress' || msg.subtype === 'task_notification' || msg.subtype === 'task_updated') this.onTask(msg);
          break;
        case 'stream_event': {
          const e = msg.event;
          if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') this.emitEvent({ t: 'delta', text: e.delta.text });
          else if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') this.emitEvent({ t: 'tool_start', name: e.content_block.name });
          else if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') this.emitEvent({ t: 'thinking' });
          else if (e.type === 'message_start') {
            // One model step begins: its prompt size is known now. Output arrives at the step's end in message_delta.
            const u = e.message?.usage || {};
            const input = u.input_tokens || 0, cacheRead = u.cache_read_input_tokens || 0, cacheWrite = u.cache_creation_input_tokens || 0;
            this.turn.input += input; this.turn.cacheRead += cacheRead; this.turn.cacheWrite += cacheWrite;
            this.context = input + cacheRead + cacheWrite; this.stepOutput = 0;
            this.emitEvent({ t: 'usage', turn: { ...this.turn }, context: this.context });
          }
          else if (e.type === 'message_delta' && typeof e.usage?.output_tokens === 'number') {
            this.turn.output += e.usage.output_tokens - this.stepOutput; this.stepOutput = e.usage.output_tokens;
            this.emitEvent({ t: 'usage', turn: { ...this.turn }, context: this.context });
          }
          break;
        }
        case 'assistant': {
          const blocks: ContentBlock[] = (msg.message?.content || []).map((b: any) => b.type === 'text' ? { type: 'text', text: b.text }
            : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: summarizeInput(b.input), description: typeof b.input?.description === 'string' ? b.input.description : undefined,
              edit: editPreview(b.name, b.input) || undefined }
            : b.type === 'thinking' ? { type: 'thinking', text: typeof b.thinking === 'string' && b.thinking.trim() ? cut(b.thinking, 6000) : undefined } : { type: b.type });
          for (const b of (msg.message?.content || [])) if (b.type === 'tool_use') this.trackTasks(b);
          for (const b of blocks) if (b.type === 'text') this.turnText += (this.turnText ? '\n\n' : '') + (b as any).text;
          if (blocks.length) this.emitEvent({ t: 'assistant', uuid: msg.uuid, blocks });
          break;
        }
        case 'user': {
          const c = msg.message?.content;
          if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') {
            const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n') : '';
            this.taskResult(b.tool_use_id, typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => x?.text || '').join('\n') : '', !!b.is_error);
            // Enough to read a command's output in the chat, like the terminal shows it. The view previews a few lines and expands on click.
            this.emitEvent({ t: 'tool_result', toolUseId: b.tool_use_id, isError: !!b.is_error, text: text.slice(0, 8000), length: text.length });
          }
          break;
        }
        case 'result': {
          // `usage` is this turn, main loop only. `modelUsage` is cumulative for the session and is where the context window size lives.
          const u = msg.usage;
          const usage: TokenUsage | null = u ? { input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0 } : null;
          const models = Object.values(msg.modelUsage || {}) as any[];
          if (models.length) {
            this.total = models.reduce((a, m) => ({ input: a.input + (m.inputTokens || 0), cacheRead: a.cacheRead + (m.cacheReadInputTokens || 0), cacheWrite: a.cacheWrite + (m.cacheCreationInputTokens || 0), output: a.output + (m.outputTokens || 0) }), zeroUsage());
            this.contextWindow = Math.max(0, ...models.map(m => m.contextWindow || 0)) || null;
          }
          if (usage) this.turn = usage;
          this.emitEvent({ t: 'result', subtype: msg.subtype, isError: !!msg.is_error, cost: msg.total_cost_usd ?? null, duration: msg.duration_ms ?? null, turns: msg.num_turns ?? null, errors: msg.errors || null,
            usage, total: this.total, context: this.context, contextWindow: this.contextWindow });
          // Fallback for asks the target answered in prose instead of via fleet_reply: only when the turn clearly belonged to that ask.
          for (const a of [...this.asksIn]) if (a.unambiguous && this.turnText.trim()) a.resolve(this.turnText.trim());
          this.setStatus(this.pending.size ? 'needs-you' : 'idle');
          break;
        }
        default:
          break;
      }
    }
    this.setStatus('ended');
  }
}
