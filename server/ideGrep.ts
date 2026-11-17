import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { listFiles } from './files.js';

// Find in files for the IDE view. `git grep` when the folder is a repo (quick, and it leaves out what git ignores), else a plain scan.

export interface GrepOpts { q: string; regex?: boolean; caseSensitive?: boolean; word?: boolean; glob?: string; limit?: number }
export interface GrepHit { path: string; line: number; col: number; text: string }
export interface GrepResult { hits: GrepHit[]; truncated: boolean; error?: string }

const clip = (t: string) => t.length > 300 ? t.slice(0, 300) + '…' : t;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `*.php, app/**` as git pathspecs: a bare name pattern matches in any folder. */
const pathspecs = (glob: string) => glob.split(',').map(g => g.trim()).filter(Boolean).map(g => `:(glob)${g.includes('/') ? g : `**/${g}`}`);

/** Stops at `limit` hits; aborting the signal stops the search. */
export async function grep(root: string, o: GrepOpts, signal?: AbortSignal): Promise<GrepResult> {
  const limit = Math.min(Math.max(o.limit || 500, 1), 2000);
  if (!o.q) return { hits: [], truncated: false };
  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (git.status === 0 && git.stdout.trim() === 'true') {
    const r = await gitGrep(root, o, limit, signal, o.regex ? '-P' : '-F');
    // Some git builds have no PCRE; the extended syntax covers what most searches need.
    if (r.error && /PCRE|perl/i.test(r.error) && o.regex) return gitGrep(root, o, limit, signal, '-E');
    return r;
  }
  return scan(root, o, limit, signal);
}

function gitGrep(root: string, o: GrepOpts, limit: number, signal: AbortSignal | undefined, mode: '-P' | '-E' | '-F'): Promise<GrepResult> {
  const args = ['-c', 'core.quotepath=off', 'grep', '-n', '--column', '-I', '--untracked', '--no-color', mode];
  if (!o.caseSensitive) args.push('-i');
  if (o.word) args.push('-w');
  args.push('-e', o.q, '--', ...pathspecs(o.glob || ''));
  return new Promise(resolve => {
    const hits: GrepHit[] = [];
    let err = '', tail = '', truncated = false, done = false;
    const p = spawn('git', args, { cwd: root, windowsHide: true });
    const timer = setTimeout(() => { truncated = true; p.kill(); }, 20000);
    const finish = (error?: string) => { if (done) return; done = true; clearTimeout(timer); resolve({ hits, truncated, error }); };
    signal?.addEventListener('abort', () => { p.kill(); finish(); });
    const take = (line: string) => {
      const m = /^(.+?):(\d+):(\d+):(.*)$/.exec(line);
      if (m && hits.length < limit) hits.push({ path: m[1], line: Number(m[2]), col: Number(m[3]), text: clip(m[4]) });
    };
    p.stdout.on('data', d => {
      const lines = (tail + d.toString('utf8')).split(/\r?\n/);
      tail = lines.pop() || '';
      for (const l of lines) take(l);
      if (hits.length >= limit) { truncated = true; p.kill(); }
    });
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', e => finish(String(e.message)));
    // Exit 1 is "no matches"; a search stopped on purpose is not an error either.
    p.on('close', code => { if (tail) take(tail); finish(code === 0 || code === 1 || truncated ? undefined : err.trim().split('\n')[0] || 'search failed'); });
  });
}

/** The fallback for a folder that is not a repo: every text file under it, read and matched here. */
async function scan(root: string, o: GrepOpts, limit: number, signal?: AbortSignal): Promise<GrepResult> {
  let re: RegExp;
  try {
    const src = o.regex ? o.q : escapeRe(o.q);
    re = new RegExp(o.word ? `\\b(?:${src})\\b` : src, o.caseSensitive ? '' : 'i');
  } catch (e) { return { hits: [], truncated: false, error: String((e as Error).message) }; }
  const masks = (o.glob || '').split(',').map(g => g.trim()).filter(Boolean)
    .map(g => new RegExp('(^|/)' + escapeRe(g).replace(/\\\*\\\*/g, '.*').replace(/\\\*/g, '[^/]*') + '$', 'i'));
  const hits: GrepHit[] = [];
  let n = 0;
  for (const rel of listFiles(root)) {
    if (signal?.aborted) break;
    if (masks.length && !masks.some(m => m.test(rel))) continue;
    let text: string;
    try {
      const abs = path.join(root, rel);
      if (fs.statSync(abs).size > 1024 * 1024) continue;
      const buf = fs.readFileSync(abs);
      if (buf.subarray(0, 4096).includes(0)) continue;
      text = buf.toString('utf8');
    } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (m) { hits.push({ path: rel, line: i + 1, col: m.index + 1, text: clip(lines[i]) }); if (hits.length >= limit) return { hits, truncated: true }; }
    }
    // Let a newer request and the rest of the server run between files.
    if (++n % 50 === 0) await new Promise(r => setImmediate(r));
  }
  return { hits, truncated: false };
}
