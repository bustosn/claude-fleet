import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatManager, Chat } from './chat.js';
import type { FleetConfig } from './config.js';
import { run, errText } from './util.js';
import type { ChatEvent, TaskStatus, TaskSummary } from '../shared/types.js';

export interface TaskSpec { title?: string; prompt: string; cwd: string; model?: string; permissionMode?: string; isolate?: boolean; ticket?: string | null; ticketUrl?: string | null }
type Report = { status: 'review' | 'blocked'; summary: string };

const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args], { timeout: 120000 }).then(s => s.trim());
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'task';
const ticket = (s: string) => /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/.exec(s)?.[1];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The board's work queue. Each task gets a chat when a slot is free (dispatch.maxConcurrent counts the working ones);
 *  the chat's turn ending, or its fleet_report, moves the card to Needs you. Approving ends the chat. */
export class TaskManager extends EventEmitter {
  chats: ChatManager; config: FleetConfig; tasks = new Map<string, TaskSummary>();
  private persistFile: string | null = null;
  /** fleet_report calls made during the current turn, applied when the turn ends. */
  private reports = new Map<string, Report>();
  private unwatch = new Map<string, () => void>();

  constructor(chats: ChatManager, config: FleetConfig) {
    super(); this.chats = chats; this.config = config;
    chats.on('task-report', (chat: Chat, r: Report) => { if (chat.taskId && this.tasks.has(chat.taskId)) this.reports.set(chat.taskId, r); });
  }

  list(): TaskSummary[] { return [...this.tasks.values()].map(t => ({ ...t })).sort((a, b) => b.updatedAt - a.updatedAt); }
  get(id: string) { return this.tasks.get(id); }
  private touch(t: TaskSummary, patch: Partial<TaskSummary>) { Object.assign(t, patch, { updatedAt: Date.now() }); this.emit('change'); }
  private liveChat(t: TaskSummary): Chat | null { const c = t.chatId ? this.chats.get(t.chatId) : undefined; return c && c.status !== 'ended' ? c : null; }

  add(spec: TaskSpec): TaskSummary {
    const prompt = String(spec.prompt || '').trim();
    if (!prompt) throw new Error('Describe the task.');
    const title = String(spec.title || '').trim().slice(0, 120) || prompt.split('\n')[0].slice(0, 80);
    const now = Date.now();
    const t: TaskSummary = { id: randomUUID().slice(0, 8), title, prompt, cwd: spec.cwd, model: spec.model || this.config.dispatch.defaultModel,
      permissionMode: spec.permissionMode || this.config.dispatch.permissionMode, status: 'queued', chatId: null, summary: null, rounds: 0,
      isolate: spec.isolate !== false, branch: null, worktree: null, base: null, baseSha: null, diff: null,
      ticket: spec.ticket || null, ticketUrl: spec.ticketUrl || null,
      createdAt: now, startedAt: null, updatedAt: now, finishedAt: null, error: null };
    this.tasks.set(t.id, t);
    this.emit('change');
    this.pump();
    return t;
  }

  /** Starts queued tasks, oldest first, while fewer than maxConcurrent are working. */
  pump() {
    const max = Math.max(1, this.config.dispatch.maxConcurrent || 1);
    const queued = [...this.tasks.values()].filter(t => t.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
    let working = [...this.tasks.values()].filter(t => t.status === 'working').length;
    for (const t of queued) { if (working >= max) break; this.start(t); working++; }
  }

  /** Takes the slot at once (status working), then makes the worktree if the task wants one, then opens the chat. */
  private async start(t: TaskSummary) {
    if (!existsSync(t.cwd)) { this.touch(t, { status: 'failed', error: `Folder not found: ${t.cwd}` }); return; }
    this.touch(t, { status: 'working', chatId: null, startedAt: Date.now(), summary: t.isolate && !t.worktree ? 'Creating a worktree…' : null, error: null });
    const reused = !!t.worktree && existsSync(t.worktree);
    try {
      if (t.isolate && !reused) await this.makeWorktree(t);
    } catch (err) { if (this.tasks.get(t.id) === t) this.touch(t, { status: 'failed', summary: null, error: `Could not create a worktree: ${errText(err)}` }); this.pump(); return; }
    if (this.tasks.get(t.id) !== t || t.status !== 'working') return; // removed or retried while git ran
    try {
      const chat = this.chats.open({ cwd: t.worktree || t.cwd, model: t.model, permissionMode: t.permissionMode, taskId: t.id });
      chat.label = t.title;
      this.touch(t, { chatId: chat.id, summary: null });
      this.watch(t, chat);
      chat.send(this.brief(t, reused));
    } catch (err: any) { this.touch(t, { status: 'failed', error: String(err?.message || err) }); this.pump(); }
  }

  /** A new branch and worktree under the repo's .claude/worktrees (where Claude Code keeps its own), started from the chosen checkout's HEAD.
   *  A folder that is not in a git repo just runs in place. */
  private async makeWorktree(t: TaskSummary) {
    let top: string;
    try { top = await git(t.cwd, 'rev-parse', '--show-toplevel'); } catch { t.isolate = false; return; }
    const common = path.resolve(top, await git(top, 'rev-parse', '--git-common-dir'));
    const mainRoot = path.dirname(common);
    const baseSha = await git(top, 'rev-parse', 'HEAD');
    const head = await git(top, 'rev-parse', '--abbrev-ref', 'HEAD');
    const name = `${slug(ticket(t.title) || ticket(t.prompt) || t.title)}-${t.id.slice(0, 4)}`;
    const dir = path.join(mainRoot, '.claude', 'worktrees', `fleet-${name}`);
    // Nested inside the main checkout, so keep it out of that checkout's git status. info/exclude is local; nothing gets committed.
    try {
      const exclude = path.join(common, 'info', 'exclude');
      const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
      if (!/^\/?\.claude\/worktrees\/?$/m.test(cur)) { mkdirSync(path.dirname(exclude), { recursive: true }); appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}/.claude/worktrees/\n`); }
    } catch {}
    await git(top, 'worktree', 'add', '-b', `fleet/${name}`, dir, baseSha);
    Object.assign(t, { worktree: dir.replace(/\\/g, '/'), branch: `fleet/${name}`, base: head === 'HEAD' ? baseSha.slice(0, 9) : head, baseSha });
  }

  /** "2 commits · 3 files, +40 −5" against the base, uncommitted changes included. Null when nothing changed. */
  private async diffStat(t: TaskSummary): Promise<string | null> {
    if (!t.worktree || !t.baseSha || !existsSync(t.worktree)) return t.diff;
    try {
      const [count, short, untracked] = await Promise.all([git(t.worktree, 'rev-list', '--count', `${t.baseSha}..HEAD`), git(t.worktree, 'diff', '--shortstat', t.baseSha),
        git(t.worktree, 'ls-files', '--others', '--exclude-standard')]);
      const n = (re: RegExp) => Number(re.exec(short)?.[1] || 0);
      const files = n(/(\d+) files? changed/), plus = n(/(\d+) insertions?/), minus = n(/(\d+) deletions?/);
      const newFiles = untracked ? untracked.split('\n').filter(Boolean).length : 0;
      const parts = [Number(count) ? `${count} commit${count === '1' ? '' : 's'}` : 'no commits'];
      if (files) parts.push(`${files} file${files === 1 ? '' : 's'}, +${plus} −${minus}`);
      if (newFiles) parts.push(`${newFiles} untracked`);
      return files || newFiles || Number(count) ? parts.join(' · ') : null;
    } catch { return t.diff; }
  }

  /** `git worktree remove` without --force, so uncommitted work is never thrown away. The chat process may still hold the folder for a moment on Windows. */
  private async dropWorktree(t: TaskSummary) {
    if (!t.worktree) return;
    if (!existsSync(t.worktree)) { this.touch(t, { worktree: null }); return; }
    for (let i = 0; i < 5; i++) {
      try { await git(t.cwd, 'worktree', 'remove', t.worktree); this.touch(t, { worktree: null }); return; }
      catch (err) { if (/modified or untracked|uncommitted/i.test(errText(err))) return; await sleep(1500); }
    }
  }

  private brief(t: TaskSummary, reused = false): string {
    const where = t.worktree
      ? `You are in a git worktree made for this task, on branch \`${t.branch}\`, started from \`${t.base}\`. ` +
        (reused ? 'An earlier attempt worked here too; check `git status` and `git log` first. ' : '') +
        'Commit your work to this branch with clear messages before you report, so the person can review the branch. '
      : '';
    return `[Fleet task ${t.id}: "${t.title}"]\n\n` +
      'This task comes from the Fleet board. Work on it on your own until it is done; the person is not watching this chat. ' + where +
      'When the work is ready, call fleet_report with status "review" and a summary: what you changed, how you checked it, and anything left open. ' +
      'If you cannot go on without the person (a decision, access, missing information), call fleet_report with status "blocked" and say exactly what you need, instead of asking in plain text. ' +
      'Do not push, merge, or open pull requests unless the task asks for it.\n\n' +
      `Task:\n${t.prompt}`;
  }

  /** Follows the worker chat and moves the card: running → working, waiting on a permission → blocked, turn end → review (or what it reported). */
  private watch(t: TaskSummary, chat: Chat) {
    this.unwatch.get(t.id)?.();
    const onEv = (ev: ChatEvent) => {
      if (ev.t === 'status' && ev.status === 'running' && t.status !== 'working') this.touch(t, { status: 'working' });
      else if (ev.t === 'permission') this.touch(t, { status: 'blocked', summary: ev.questions?.[0]?.question || (ev.plan ? 'A plan is waiting for your approval.' : `Waiting for permission to use ${ev.toolName}: ${ev.input}`) });
      else if (ev.t === 'permission_resolved' && !chat.pending.size && t.status === 'blocked') this.touch(t, { status: 'working' });
      else if (ev.t === 'result') {
        const report = this.reports.get(t.id); this.reports.delete(t.id);
        const text = chat.turnText.trim();
        if (chat.pending.size) return;
        if (ev.isError || ev.subtype !== 'success') this.touch(t, { status: 'blocked', summary: `The turn ended with an error (${ev.subtype}).${ev.errors?.length ? `\n\n${ev.errors.join('\n')}` : ''}${text ? `\n\n${text}` : ''}` });
        else if (report) this.touch(t, { status: report.status, summary: report.summary });
        else this.touch(t, { status: 'review', summary: text || 'The chat ended its turn without saying anything.' });
        this.diffStat(t).then(diff => { if (diff !== t.diff) this.touch(t, { diff }); });
        this.pump();
      }
      else if (ev.t === 'status' && ev.status === 'ended') {
        off();
        if (t.status !== 'done') this.touch(t, { status: 'failed', error: chat.error || 'The worker chat ended.' });
        this.pump();
      }
    };
    const off = () => { chat.off('event', onEv); this.unwatch.delete(t.id); };
    chat.on('event', onEv);
    this.unwatch.set(t.id, off);
  }

  /** Accept the work: the card goes to Done and its chat ends (the conversation stays saved and can be resumed). */
  approve(id: string) {
    const t = this.must(id);
    if (t.status === 'done') return t;
    const chat = this.liveChat(t);
    this.unwatch.get(t.id)?.();
    this.touch(t, { status: 'done', finishedAt: Date.now() });
    chat?.close();
    // The branch stays for merging; the worktree goes unless it still has uncommitted changes.
    void (async () => { const diff = await this.diffStat(t); if (diff !== t.diff) this.touch(t, { diff }); await this.dropWorktree(t); })();
    this.pump();
    return t;
  }

  /** Feedback goes to the worker as its next message; the card goes back to Working. */
  sendBack(id: string, feedback: string) {
    const t = this.must(id), text = feedback.trim();
    if (!text) throw new Error('Say what to change.');
    const chat = this.liveChat(t);
    if (!chat) throw new Error('The worker chat is gone; use Retry to start the task over.');
    if (chat.status === 'running') throw new Error('The worker is busy; wait for its turn to end.');
    this.touch(t, { rounds: t.rounds + 1, status: 'working', finishedAt: null });
    chat.send(`[Feedback on Fleet task ${t.id} from the person reviewing it]\n\n${text}\n\nWhen you are done, call fleet_report again.`);
    return t;
  }

  /** Start over with a fresh chat. The old chat, if still running, ends. */
  retry(id: string) {
    const t = this.must(id);
    this.unwatch.get(t.id)?.();
    this.liveChat(t)?.close();
    this.touch(t, { status: 'queued', chatId: null, summary: null, error: null, startedAt: null, finishedAt: null });
    this.pump();
    return t;
  }

  /** Start a queued task now, past the concurrency limit. */
  startNow(id: string) {
    const t = this.must(id);
    if (t.status !== 'queued') throw new Error('Only a queued task can be started.');
    this.start(t);
    return t;
  }

  remove(id: string) {
    const t = this.must(id);
    this.unwatch.get(t.id)?.();
    if (t.status !== 'done') { this.liveChat(t)?.close(); void this.dropWorktree(t); }
    this.tasks.delete(id); this.reports.delete(id);
    this.emit('change');
    this.pump();
  }

  clearDone() {
    for (const t of [...this.tasks.values()]) if (t.status === 'done') this.tasks.delete(t.id);
    this.emit('change');
  }

  private must(id: string) { const t = this.tasks.get(id); if (!t) throw new Error('No such task.'); return t; }

  persistTo(file: string) { this.persistFile = file; this.on('change', () => this.save()); }
  save() {
    if (!this.persistFile) return;
    try { writeFileSync(this.persistFile, JSON.stringify(this.list(), null, 1)); } catch {}
  }
  /** Call after the chats reopen. Workers come back attached to their chats; one that was mid-turn is told to carry on. */
  reopen(): number {
    if (!this.persistFile || !existsSync(this.persistFile)) return 0;
    let saved: TaskSummary[] = [];
    try { saved = JSON.parse(readFileSync(this.persistFile, 'utf8')); } catch { return 0; }
    for (const s of saved) {
      if (!s || typeof s.id !== 'string' || typeof s.prompt !== 'string') continue;
      // Tasks saved before worktrees existed ran in place.
      const t = { isolate: false, branch: null, worktree: null, base: null, baseSha: null, diff: null, ticket: null, ticketUrl: null, ...(s as Partial<TaskSummary>) } as TaskSummary;
      this.tasks.set(t.id, t);
      if (!(['working', 'review', 'blocked'] as TaskStatus[]).includes(t.status)) continue;
      const chat = this.liveChat(t);
      if (!chat) { t.status = 'failed'; t.error = 'Fleet restarted and the worker chat could not be reopened.'; continue; }
      chat.label = t.title; chat.taskId = t.id;
      this.watch(t, chat);
      if (t.status === 'working') chat.send(`[Fleet restarted while you were working on task ${t.id}. Check where you left off and carry on; call fleet_report when done.]`);
    }
    this.emit('change');
    this.pump();
    return saved.length;
  }
}
