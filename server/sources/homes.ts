import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { normPath, pathWithin } from '../util.js';

import type { LocatedBy } from '../../shared/types.js';
export type { LocatedBy };
export interface WorktreeRef { path: string; branch: string | null; isMain: boolean; repo: string }
export interface Placement { worktree: WorktreeRef; by: LocatedBy }

const TICKET = /\b([A-Z]{2,6}-\d{2,6})\b/i;
export const ticketKey = (s: string | null | undefined) => { const m = (s || '').match(TICKET); return m ? m[1].toUpperCase() : null; };

const TAIL_BYTES = 2 * 1024 * 1024;
const RESCAN_MS = 60_000;
const MIN_MENTIONS = 3;

/**
 * Where a session lives when its cwd says nothing useful (sessions started from ~, for instance).
 * Order: a pin set by the user, the cwd itself, a ticket key in the title that names exactly one worktree,
 * a repo named in the title, then the worktree whose files (or, failing that, whose repo name) the transcript mentions most. Transcript scans are cached per session
 * and only redone when the file has grown and a minute has passed.
 */
export class SessionHomes {
  private pins: Record<string, string> = {};
  private cache = new Map<string, { size: number; at: number; worktree: string | null }>();
  constructor(private file: string, private claudeHome: string) {
    try { this.pins = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.pins = {}; }
  }

  pin(sessionId: string, worktree: string | null) {
    if (worktree) this.pins[sessionId] = worktree; else delete this.pins[sessionId];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.pins, null, 2));
  }
  pinned(sessionId: string | null) { return sessionId ? this.pins[sessionId] || null : null; }

  /** Synchronous placement from what is already known. Call `scan` beforehand for the transcript step. */
  place(sessionId: string | null, cwd: string, title: string, worktrees: WorktreeRef[]): Placement | null {
    const byPath = (p: string | null) => p ? worktrees.find(w => normPath(w.path) === normPath(p)) || null : null;
    const pinned = byPath(this.pinned(sessionId));
    if (pinned) return { worktree: pinned, by: 'pinned' };
    let best: WorktreeRef | null = null;
    for (const w of worktrees) if (pathWithin(cwd, w.path) && (!best || w.path.length > best.path.length)) best = w;
    if (best) return { worktree: best, by: 'cwd' };
    const key = ticketKey(title);
    if (key) {
      const hits = worktrees.filter(w => !w.isMain && (ticketKey(w.branch) === key || ticketKey(path.basename(w.path)) === key));
      if (hits.length === 1) return { worktree: hits[0], by: 'ticket' };
    }
    const named = repoNamed(title, worktrees);
    if (named) return { worktree: named, by: 'title' };
    const scanned = sessionId ? byPath(this.cache.get(sessionId)?.worktree || null) : null;
    return scanned ? { worktree: scanned, by: 'transcript' } : null;
  }

  /** Reads the tail of the transcript and remembers which worktree it talks about most. */
  async scan(sessionId: string, cwd: string, worktrees: WorktreeRef[]): Promise<void> {
    const file = await this.transcriptPath(sessionId, cwd);
    if (!file) return;
    let size = 0;
    try { size = (await fsp.stat(file)).size; } catch { return; }
    const prev = this.cache.get(sessionId);
    if (prev && (prev.size === size || Date.now() - prev.at < RESCAN_MS)) return;
    const fh = await fsp.open(file, 'r');
    let text = '';
    try {
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { await fh.close(); }
    this.cache.set(sessionId, { size, at: Date.now(), worktree: mostMentioned(text, worktrees) });
  }

  private async transcriptPath(sessionId: string, cwd: string): Promise<string | null> {
    const projects = path.join(this.claudeHome, 'projects');
    const guess = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
    if (fs.existsSync(guess)) return guess;
    let dirs: string[] = [];
    try { dirs = await fsp.readdir(projects); } catch { return null; }
    for (const d of dirs) { const p = path.join(projects, d, `${sessionId}.jsonl`); if (fs.existsSync(p)) return p; }
    return null;
  }
}

/** A repo named as a word in the title: "ExpressResolve pull request 1476" → ExpressResolve's main checkout. Short lowercase names are skipped as too common. */
function repoNamed(title: string, worktrees: WorktreeRef[]): WorktreeRef | null {
  const hits = worktrees.filter(w => w.isMain && nameRe(w.repo)?.test(title));
  return hits.length === 1 ? hits[0] : null;
}
function nameRe(name: string): RegExp | null {
  if (name.length < 4 && name !== name.toUpperCase()) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, c => '\\' + c);
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i');
}

// Windows paths inside JSON come escaped (C:\\Users\\...) or forward-slashed; both are accepted.
// Only file paths count: repo names in the text are no signal, since CLAUDE.md and memory mention every repo in every transcript.
const PATH_RE = /[A-Za-z]:(?:\\\\|\\|\/)(?:[^"'\s\\/]+(?:\\\\|\\|\/))+[^"'\s\\/]*/g;

function mostMentioned(text: string, worktrees: WorktreeRef[]): string | null {
  const counts = new Map<string, number>();
  const sorted = [...worktrees].sort((a, b) => b.path.length - a.path.length);
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[0].replace(/\\\\/g, '/').replace(/\\/g, '/');
    const w = sorted.find(w => pathWithin(p, w.path));
    if (w) counts.set(w.path, (counts.get(w.path) || 0) + 1);
  }
  let best: [string, number] | null = null;
  for (const e of counts) if (!best || e[1] > best[1]) best = e;
  return best && best[1] >= MIN_MENTIONS ? best[0] : null;
}
