import { EventEmitter } from 'node:events';
import { listAgents, type AgentRow } from './sources/agents.js';
import { readJobs, type JobRecord } from './sources/jobs.js';
import { scanRepos, type RepoScan } from './sources/worktrees.js';
import { listConversations, type SavedConversation } from './sources/conversations.js';
import { normPath, errText, mapLimit } from './util.js';
import { SessionHomes, type WorktreeRef, type Placement } from './sources/homes.js';
import type { ChatManager } from './chat.js';
import type { TerminalManager } from './terminals.js';
import type { DialogueManager } from './dialogue.js';
import type { FleetConfig } from './config.js';
import type { Snapshot, Session, Column, ChatStatus, Worktree } from '../shared/types.js';

type Located = (Omit<Worktree, 'sessions'> & { repo: string; by: Placement['by'] }) | null;

export class Collector extends EventEmitter {
  config: FleetConfig; chats: ChatManager | null; homes: SessionHomes;
  /** Set by the server after construction; its `change` events call publish(). */
  terminals: TerminalManager | null = null; dialogues: DialogueManager | null = null;
  agents: AgentRow[] = []; jobs: Record<string, JobRecord> = {}; repos: RepoScan[] = []; conversations: SavedConversation[] = [];
  errors: Record<string, string> = {};
  snapshot: Snapshot; private lastSig = '';

  constructor(config: FleetConfig, chats: ChatManager | null, homesFile: string) {
    super();
    this.config = config; this.chats = chats;
    this.homes = new SessionHomes(homesFile, config.claudeHome);
    this.snapshot = this.build();
    chats?.on('change', () => this.publish());
  }

  start() {
    this.tick('agents', () => this.pollAgents(), this.config.poll.agentsMs);
    this.tick('git', () => this.pollGit(), this.config.poll.gitMs);
    this.tick('conversations', () => this.pollConversations(), this.config.poll.conversationsMs);
  }

  private tick(name: string, fn: () => Promise<void>, ms: number) {
    const loop = async () => {
      try { await fn(); delete this.errors[name]; }
      catch (err) { this.errors[name] = errText(err).slice(0, 300); }
      this.publish();
      setTimeout(loop, ms);
    };
    void loop();
  }

  async pollAgents() {
    const [agents, jobs] = await Promise.all([listAgents(), readJobs(this.config.claudeHome, this.config.poll.timelineLines)]);
    this.agents = agents; this.jobs = jobs;
    await this.scanHomes(agents.map(a => ({ sessionId: a.sessionId, cwd: (a.bgId && jobs[a.bgId]?.cwd) || a.cwd, title: this.titleOf(a.sessionId) || a.name || '' })));
  }
  async pollGit() { this.repos = await scanRepos(this.config.reposRoot, this.config.extraRepos); }
  async pollConversations() {
    this.conversations = await listConversations(this.config.poll.conversationsLimit);
    await this.scanHomes(this.conversations.map(c => ({ sessionId: c.sessionId, cwd: c.cwd, title: c.title })));
  }

  private worktreeRefs(): WorktreeRef[] {
    return this.repos.flatMap(r => r.worktrees.map(w => ({ path: w.path, branch: w.branch, isMain: w.isMain, repo: r.name })));
  }
  // Transcript scans only for sessions the cheaper rules cannot place.
  private async scanHomes(items: { sessionId: string | null; cwd: string; title: string }[]) {
    const refs = this.worktreeRefs();
    if (!refs.length) return;
    const todo = items.filter(i => i.sessionId && !this.homes.place(i.sessionId, i.cwd, i.title, refs));
    await mapLimit(todo, 3, i => this.homes.scan(i.sessionId!, i.cwd, refs).catch(() => {}));
  }

  titleOf(sessionId: string | null): string | null { return this.conversations.find(c => c.sessionId === sessionId)?.title || null; }
  locate(cwd: string, sessionId: string | null = null, title = ''): Located {
    const p = this.homes.place(sessionId, cwd, title, this.worktreeRefs());
    if (!p) return null;
    for (const r of this.repos) for (const w of r.worktrees) if (w.path === p.worktree.path) return { ...w, repo: r.name, by: p.by };
    return null;
  }
  pin(sessionId: string, worktree: string | null) { this.homes.pin(sessionId, worktree); this.publish(); }

  publish() {
    const next = this.build();
    const sig = JSON.stringify({ s: next.sessions, r: next.repos, c: next.conversations, ch: next.chats, t: next.terminals, d: next.dialogues, e: next.errors });
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.snapshot = next;
    this.emit('snapshot', next);
  }

  build(): Snapshot {
    const titles = new Map(this.conversations.map(c => [c.sessionId, c.title]));
    const chats = this.chats ? this.chats.list() : [];
    const chatBySession = new Map(chats.filter(c => c.sessionId && c.status !== 'ended').map(c => [c.sessionId!, c]));

    const sessions: Session[] = this.agents.map(a => {
      const job = a.bgId ? this.jobs[a.bgId] : null;
      const chat = a.sessionId ? chatBySession.get(a.sessionId) : undefined; // SDK chat subprocesses also register as interactive sessions
      const cwd = chat?.cwd || job?.cwd || a.cwd;
      const title = titles.get(a.sessionId || '') || chat?.title || job?.name || a.name || '';
      const wt = this.locate(cwd, a.sessionId, title);
      const { cwd: _c, name: _n, sessionId: _s, ...jobView } = job || ({} as JobRecord);
      const s: Session = {
        ...a,
        name: a.name || job?.name || '',
        title,
        cwd,
        repo: wt?.repo || null, worktree: wt?.path || null, branch: wt?.branch || null, locatedBy: wt?.by || null,
        column: columnFor(a),
        job: job ? jobView : null,
      };
      if (chat) Object.assign(s, { kind: 'dashboard', chatId: chat.id, state: chat.status, column: chatColumn(chat.status) });
      else if (job?.transcriptMissing) Object.assign(s, { state: 'stale', column: 'done', stale: true });
      return s;
    });
    // Dashboard chats that have not registered with `claude agents` yet (first seconds of life) still get a card.
    for (const c of chats) if (c.status !== 'ended' && !sessions.some(s => s.sessionId === c.sessionId)) {
      const wt = this.locate(c.cwd, c.sessionId, c.title);
      sessions.push({
        id: `chat-${c.id}`, bgId: null, pid: null, kind: 'dashboard', chatId: c.id,
        name: c.title, title: c.title, cwd: c.cwd, sessionId: c.sessionId, startedAt: c.startedAt, state: c.status,
        repo: wt?.repo || null, worktree: wt?.path || null, branch: wt?.branch || null, locatedBy: wt?.by || null,
        column: chatColumn(c.status), job: null,
      });
    }
    sessions.sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0));

    const running = new Map(this.agents.map(a => [a.sessionId, a]));
    const conversations = this.conversations.map(c => {
      const a = running.get(c.sessionId); const wt = this.locate(c.cwd, c.sessionId, c.title); const chat = chatBySession.get(c.sessionId);
      return { ...c, repo: wt?.repo || null, branch: wt?.branch || null, worktree: wt?.path || null, locatedBy: wt?.by || null,
        running: a ? { id: a.id, kind: a.kind, name: a.name, state: a.state } : null,
        chat: chat ? { id: chat.id, status: chat.status } : null };
    });

    const byWorktree = new Map<string, Worktree['sessions']>();
    for (const s of sessions) if (s.worktree) {
      const k = normPath(s.worktree);
      if (!byWorktree.has(k)) byWorktree.set(k, []);
      byWorktree.get(k)!.push({ id: s.id, name: s.title || s.name, kind: s.kind, state: s.state, column: s.column });
    }
    const repos = this.repos.map(r => ({ ...r, worktrees: r.worktrees.map(w => ({ ...w, sessions: byWorktree.get(normPath(w.path)) || [] })) }));

    return { generatedAt: Date.now(), sessions, repos, conversations, chats, terminals: this.terminals?.list() || [], dialogues: this.dialogues?.list() || [], errors: { ...this.errors }, roles: this.config.roles, dispatch: this.config.dispatch };
  }
}

const chatColumn = (status: ChatStatus): Column => ({ 'needs-you': 'needs-you', running: 'working', idle: 'idle', starting: 'working', ended: 'done' } as Record<ChatStatus, Column>)[status] || 'idle';

// Board column: needs-you | working | idle | done
function columnFor(a: AgentRow): Column {
  if (a.kind === 'background') return ({ blocked: 'needs-you', working: 'working', done: 'done', failed: 'done', stopped: 'done' } as Record<string, Column>)[a.state] || 'idle';
  return a.state === 'busy' ? 'working' : 'idle';
}
