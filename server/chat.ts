import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { query, type SDKUserMessage, type Query } from '@anthropic-ai/claude-agent-sdk';
import { createFleetServer, FLEET_TOOL_NAMES } from './fleetTools.js';
import { summarizeInput } from './sources/conversations.js';
import type { FleetConfig } from './config.js';
import { ShellRunner } from './shellRunner.js';
import type { TerminalManager } from './terminals.js';
import type { ChatEvent, ChatStatus, ChatSummary, ContentBlock, MessageOrigin, PermissionView, SlashCommandView, TokenUsage } from '../shared/types.js';

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
interface Pending { resolve: (r: any) => void; input: Record<string, unknown>; view: PermissionView }
interface OpenOptions { sessionId?: string | null; cwd: string; model?: string; fork?: boolean; permissionMode?: string; id?: string }
type Located = { repo: string; branch: string | null; path: string; by: import('../shared/types.js').LocatedBy } | null;

export class ChatManager extends EventEmitter {
  config: FleetConfig; chats = new Map<string, Chat>(); asks = new Map<string, AskRecord>();
  titleFor: (sessionId: string | null) => string | null = () => null;
  locate: (cwd: string, sessionId?: string | null, title?: string) => Located = () => null;
  /** For `!` commands: the shells live in the terminal manager so they show in the sidebar and can open as tabs. */
  terminals: TerminalManager | null = null; shellDir = '';
  private persistFile: string | null = null;

  constructor(config: FleetConfig) { super(); this.config = config; }

  list(): ChatSummary[] { return [...this.chats.values()].map(c => c.summary()); }
  get(id: string) { return this.chats.get(id); }
  bySession(sessionId: string) { return [...this.chats.values()].find(c => c.sessionId === sessionId && c.status !== 'ended'); }

  open({ sessionId, cwd, model, fork, permissionMode, id }: OpenOptions): Chat {
    const existing = sessionId ? this.bySession(sessionId) : undefined;
    if (existing) return existing;
    const chat = new Chat(this, { sessionId: sessionId || null, cwd, model: model || this.config.dispatch.defaultModel, fork: !!fork, permissionMode: permissionMode || this.config.dispatch.permissionMode, id });
    this.chats.set(chat.id, chat);
    chat.start();
    return chat;
  }

  // Live chats are written to disk on every change so a server restart can reopen them (resumed, not forked).
  persistTo(file: string) { this.persistFile = file; this.on('change', () => this.save()); }
  save() {
    if (!this.persistFile) return;
    const live = [...this.chats.values()].filter(c => c.status !== 'ended' && c.sessionId).map(c => ({ id: c.id, sessionId: c.sessionId, cwd: c.cwd, model: c.model, permissionMode: c.permissionMode }));
    try { writeFileSync(this.persistFile, JSON.stringify(live, null, 1)); } catch {}
  }
  reopen(): number {
    if (!this.persistFile || !existsSync(this.persistFile)) return 0;
    let saved: any[] = [];
    try { saved = JSON.parse(readFileSync(this.persistFile, 'utf8')); } catch { return 0; }
    for (const s of saved) if (s.sessionId && s.cwd && existsSync(s.cwd)) this.open({ id: typeof s.id === 'string' && /^[0-9a-f]{8}$/.test(s.id) ? s.id : undefined, sessionId: s.sessionId, cwd: s.cwd, model: s.model, permissionMode: s.permissionMode, fork: false });
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


const zeroUsage = (): TokenUsage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

export class Chat extends EventEmitter {
  mgr: ChatManager; id = randomUUID().slice(0, 8);
  resumeId: string | null; sessionId: string | null; cwd: string; model: string; fork: boolean; permissionMode: string;
  status: ChatStatus = 'starting'; events: ChatEvent[] = []; pending = new Map<string, Pending>(); inbox = new Inbox();
  abort = new AbortController(); startedAt = Date.now(); error: string | null = null;
  firstText = ''; asksIn: AskRecord[] = []; asksOut: AskRecord[] = []; turnText = '';
  /** A dialogue names its participants ("Critic · topic") and owns their turns; both show in the summary. */
  label: string | null = null; dialogueId: string | null = null;
  // Token accounting. `turn` accumulates over the model steps of the current turn; `stepOutput` is what the current step has reported so far
  // (message_delta carries a cumulative count). `context` is the prompt size at the latest step. `total` comes from the SDK, cumulative per session.
  turn: TokenUsage = zeroUsage(); private stepOutput = 0; context = 0; total: TokenUsage | null = null; contextWindow: number | null = null;
  private q: Query | null = null;
  private commands: import('@anthropic-ai/claude-agent-sdk').SlashCommand[] = [];
  private terminalCommands = new Set<string>();
  private shell: ShellRunner | null = null;

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
      permissionMode: this.permissionMode, status: this.status, startedAt: this.startedAt, pending: [...this.pending.values()].map(p => p.view), error: this.error,
      asksIn: this.asksIn.map(a => ({ id: a.id, from: a.fromChatId })), asksOut: this.asksOut.map(a => ({ id: a.id, to: a.toChatId })), dialogueId: this.dialogueId,
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
  send(text: string, origin?: MessageOrigin) {
    if (this.status === 'ended') throw new Error('chat ended');
    if (!this.firstText && !origin) this.firstText = text;
    let body = text;
    if (origin && origin.kind !== 'dialogue') {
      const head = origin.kind === 'manual' ? `[Forwarded from chat "${origin.fromTitle}" (${origin.fromChatId}) by the user]`
        : `[Fleet message from chat "${origin.fromTitle}" (${origin.fromChatId})${origin.askId ? `, ask_id ${origin.askId}` : ''}]`;
      const tail = origin.askId ? `\n\nAnswer by calling fleet_reply with ask_id "${origin.askId}". Be concise and concrete.` : '';
      body = `${head}\n\n${text}${tail}`;
    }
    // Commands the person ran with `!` since their last message ride along, so "fix that" after `!npm test` just works.
    if (!origin) { const ctx = this.shell?.takeContext(); if (ctx) body = `${ctx}\n\n${body}`; }
    this.turn = zeroUsage(); this.stepOutput = 0; // a new turn starts with this message
    this.inbox.push({ type: 'user', message: { role: 'user', content: body }, parent_tool_use_id: null } as SDKUserMessage);
    this.emitEvent({ t: 'user', text, origin: origin || null });
    this.turnText = '';
    this.setStatus('running');
  }

  resolvePermission(id: string, behavior: 'allow' | 'deny', message?: string): boolean {
    const p = this.pending.get(id); if (!p) return false;
    this.pending.delete(id);
    p.resolve(behavior === 'allow' ? { behavior: 'allow', updatedInput: p.input } : { behavior: 'deny', message: message || 'Denied from dashboard' });
    this.emitEvent({ t: 'permission_resolved', id, behavior });
    this.mgr.emit('change');
    return true;
  }

  /** Asks the process for its command list. The call can fail or come back empty while the process is still settling. */
  private async fetchCommands(): Promise<boolean> {
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
  async interrupt() { try { await this.q?.interrupt(); } catch (e: any) { this.emitEvent({ t: 'error', message: String(e.message || e) }); } }
  close() {
    this.shell?.close();
    this.inbox.close(); this.abort.abort(); try { this.q?.close(); } catch {}
    for (const a of [...this.asksOut]) a.reject(new Error('asking chat ended'));
    for (const a of [...this.asksIn]) a.reject(new Error(`"${this.title}" ended before answering`));
    this.setStatus('ended');
  }

  start() {
    const opts: any = {
      cwd: this.cwd, model: this.model, permissionMode: this.permissionMode,
      includePartialMessages: true, abortController: this.abort,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      mcpServers: { fleet: createFleetServer(this.mgr, this) },
      allowedTools: FLEET_TOOL_NAMES,
      canUseTool: (toolName: string, input: Record<string, unknown>, { suggestions }: any) => new Promise(resolve => {
        const id = randomUUID().slice(0, 8);
        const view: PermissionView = { id, toolName, input: summarizeInput(input), suggestions: (suggestions || []).length };
        this.pending.set(id, { resolve, input, view });
        this.emitEvent({ t: 'permission', ...view });
        this.setStatus('needs-you');
      }),
    };
    if (this.resumeId) { opts.resume = this.resumeId; if (this.fork) opts.forkSession = true; }
    this.q = query({ prompt: this.inbox, options: opts });
    this.setStatus('idle');
    this.pump().catch(err => { this.error = String(err.message || err); this.emitEvent({ t: 'error', message: this.error! }); this.setStatus('ended'); });
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
            : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: summarizeInput(b.input), description: typeof b.input?.description === 'string' ? b.input.description : undefined }
            : b.type === 'thinking' ? { type: 'thinking' } : { type: b.type });
          for (const b of blocks) if (b.type === 'text') this.turnText += (this.turnText ? '\n\n' : '') + (b as any).text;
          if (blocks.length) this.emitEvent({ t: 'assistant', uuid: msg.uuid, blocks });
          break;
        }
        case 'user': {
          const c = msg.message?.content;
          if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') {
            const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n') : '';
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
          this.emitEvent({ t: 'result', subtype: msg.subtype, cost: msg.total_cost_usd ?? null, duration: msg.duration_ms ?? null, turns: msg.num_turns ?? null, errors: msg.errors || null,
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
