import { execFile } from 'node:child_process';

// What the IDE view asks git: which commit last touched each line, which lines differ from HEAD, a file at a revision, a file's history,
// and the status of everything for the tree. Every path is relative to the folder the IDE has open, which may be a subfolder of the repo.

import type { IdeBlame as BlameResult, IdeHunk as Hunk, IdeLogEntry as LogEntry, IdeGitStatus as GitStatus } from '../shared/types.js';

const run = (root: string, args: string[], opts: { maxBuffer?: number } = {}) => new Promise<{ code: number; out: string; err: string }>(resolve => {
  execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: opts.maxBuffer || 32 * 1024 * 1024 },
    (e, out, err) => resolve({ code: e ? (typeof (e as any).code === 'number' ? (e as any).code : 1) : 0, out: String(out || ''), err: String(err || '') }));
});

/** A revision as the editor may ask for it: HEAD or a hash, optionally a parent of one. Anything else could be read by git as an option. */
export const validRev = (rev: string) => /^(HEAD|[0-9a-f]{4,40})(\^|~\d{1,3})?$/i.test(rev);

/** The folder's place in its repo ("sub/dir/" or ""), or null outside a repo. */
async function prefix(root: string): Promise<string | null> {
  const r = await run(root, ['rev-parse', '--show-prefix']);
  return r.code === 0 ? r.out.trim() : null;
}

export async function isRepo(root: string) { return (await prefix(root)) !== null; }

export async function blame(root: string, file: string): Promise<BlameResult | null> {
  const r = await run(root, ['blame', '--porcelain', '--', file]);
  if (r.code !== 0) return null;
  const commits: BlameResult['commits'] = [], index = new Map<string, number>(), lines: number[] = [];
  let sha = '', final = 0;
  for (const l of r.out.split('\n')) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l);
    if (head) {
      sha = head[1]; final = Number(head[2]);
      if (!index.has(sha)) { index.set(sha, commits.length); commits.push({ sha, author: '', time: 0, summary: '' }); }
    } else if (l.startsWith('\t')) lines[final - 1] = index.get(sha)!;
    else if (sha) {
      const c = commits[index.get(sha)!];
      if (l.startsWith('author ')) c.author = l.slice(7);
      else if (l.startsWith('author-time ')) c.time = Number(l.slice(12));
      else if (l.startsWith('summary ')) c.summary = l.slice(8);
    }
  }
  for (const c of commits) if (/^0+$/.test(c.sha)) { c.author = 'Not committed yet'; c.summary = 'Changes not yet committed'; }
  return { commits, lines };
}

/** The lines of the file on disk that differ from HEAD. Empty for a file git does not track. */
export async function changes(root: string, file: string): Promise<{ tracked: boolean; hunks: Hunk[] }> {
  const tracked = (await run(root, ['ls-files', '--error-unmatch', '--', file])).code === 0;
  if (!tracked) return { tracked: false, hunks: [] };
  const r = await run(root, ['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD', '--', file]);
  if (r.code !== 0) return { tracked: true, hunks: [] };
  const hunks: Hunk[] = [];
  for (const l of r.out.split('\n')) {
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (!m) continue;
    const oldCount = m[1] === undefined ? 1 : Number(m[1]), start = Number(m[2]), count = m[3] === undefined ? 1 : Number(m[3]);
    hunks.push({ kind: oldCount === 0 ? 'added' : count === 0 ? 'deleted' : 'modified', start, count });
  }
  return { tracked: true, hunks };
}

/** The file as it was at `rev`; `exists` is false when it was not there (a new file, or the first commit's parent). */
export async function show(root: string, rev: string, file: string): Promise<{ text: string; exists: boolean }> {
  const r = await run(root, ['show', `${rev}:./${file}`]);
  if (r.code !== 0) return { text: '', exists: false };
  return { text: r.out.replace(/\r\n/g, '\n'), exists: true };
}

export async function log(root: string, file: string, limit = 100): Promise<LogEntry[]> {
  const r = await run(root, ['log', '--follow', `-n${limit}`, '--format=%H%x1f%an%x1f%at%x1f%s%x1e', '--', file]);
  if (r.code !== 0) return [];
  return r.out.split('\x1e').map(s => s.trim()).filter(Boolean).map(s => { const [sha, author, time, subject] = s.split('\x1f'); return { sha, author, time: Number(time), subject }; });
}

/** The branch, and each changed file's status code (M modified, A added, D deleted, R renamed, ? untracked, U conflict) by path under the folder. */
export async function status(root: string): Promise<GitStatus | null> {
  const pre = await prefix(root);
  if (pre === null) return null;
  const r = await run(root, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=normal']);
  if (r.code !== 0) return null;
  const tokens = r.out.split('\0');
  const out: GitStatus = { branch: '', ahead: 0, behind: 0, files: {} };
  const head = /^## (.*)$/.exec(tokens.shift() || '');
  if (head) {
    const m = /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.\S+)?(?: \[(.*)\])?$/.exec(head[1]);
    out.branch = m?.[1] || head[1];
    out.ahead = Number(/ahead (\d+)/.exec(m?.[2] || '')?.[1] || 0);
    out.behind = Number(/behind (\d+)/.exec(m?.[2] || '')?.[1] || 0);
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length < 4) continue;
    const x = t[0], y = t[1];
    let p = t.slice(3);
    // A rename lists its old path as the next token.
    if (x === 'R' || x === 'C') i++;
    if (!p.startsWith(pre)) continue;
    p = p.slice(pre.length);
    const code = x === '?' ? '?' : (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) ? 'U' : x === 'R' ? 'R' : (x === 'A' || y === 'A') ? 'A' : (x === 'D' || y === 'D') ? 'D' : 'M';
    out.files[p] = code;
  }
  return out;
}
