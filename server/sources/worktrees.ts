import fs from 'node:fs/promises';
import path from 'node:path';
import { run, mapLimit, errText } from '../util.js';
import type { Repo, Worktree } from '../../shared/types.js';

export type RepoScan = Omit<Repo, 'worktrees'> & { worktrees: Omit<Worktree, 'sessions'>[] };

export async function listRepos(reposRoot: string): Promise<{ name: string; path: string }[]> {
  let entries: import('node:fs').Dirent[] = [];
  try { entries = await fs.readdir(reposRoot, { withFileTypes: true }); } catch { return []; }
  const repos: { name: string; path: string }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(reposRoot, e.name);
    // A directory whose .git is a file is a linked worktree of another repo; it shows up under that repo, not as its own.
    try { const st = await fs.stat(path.join(p, '.git')); if (st.isDirectory()) repos.push({ name: e.name, path: p.replace(/\\/g, '/') }); } catch {}
  }
  return repos;
}

export async function scanRepos(reposRoot: string, extraRepos: string[] = []): Promise<RepoScan[]> {
  const repos = await listRepos(reposRoot);
  for (const p of extraRepos) {
    const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!repos.some(r => r.path.toLowerCase() === norm.toLowerCase())) repos.push({ name: path.basename(norm), path: norm });
  }
  return mapLimit(repos, 4, async repo => {
    let base: ReturnType<typeof parsePorcelain>;
    try { base = parsePorcelain(await run('git', ['-C', repo.path, 'worktree', 'list', '--porcelain'])); }
    catch (err) { return { ...repo, error: errText(err), worktrees: [] }; }
    const worktrees = await mapLimit(base, 3, async (wt, i) => ({
      ...wt, ...(await describe(wt.path)), isMain: i === 0, managed: /\/\.claude\/worktrees\//i.test(wt.path),
    }));
    return { ...repo, worktrees };
  });
}

function parsePorcelain(out: string) {
  const blocks = out.trim().split(/\n\s*\n/).filter(Boolean);
  return blocks.map(b => {
    const wt = { path: '', head: '', branch: null as string | null, detached: false, locked: false, prunable: false };
    for (const line of b.split('\n')) {
      const [k, ...rest] = line.split(' '); const v = rest.join(' ');
      if (k === 'worktree') wt.path = v.replace(/\\/g, '/');
      else if (k === 'HEAD') wt.head = v.slice(0, 9);
      else if (k === 'branch') wt.branch = v.replace(/^refs\/heads\//, '');
      else if (k === 'detached') wt.detached = true;
      else if (k === 'locked') wt.locked = true;
      else if (k === 'prunable') wt.prunable = true;
    }
    return wt;
  });
}

async function describe(wtPath: string) {
  const d = { dirty: 0, untracked: 0, ahead: 0, behind: 0, upstream: null as string | null, lastCommit: null as Worktree['lastCommit'], error: null as string | null };
  try {
    const st = await run('git', ['-C', wtPath, 'status', '--porcelain', '--branch']);
    const lines = st.split('\n');
    const head = lines.shift() || '';
    const m = head.match(/^## \S+?(?:\.\.\.(\S+))?(?: \[(.*)\])?$/);
    if (m) {
      d.upstream = m[1] || null;
      const a = /ahead (\d+)/.exec(m[2] || ''); const b = /behind (\d+)/.exec(m[2] || '');
      d.ahead = a ? +a[1] : 0; d.behind = b ? +b[1] : 0;
    }
    for (const l of lines) { if (!l) continue; if (l.startsWith('??')) d.untracked++; else d.dirty++; }
    const log = await run('git', ['-C', wtPath, 'log', '-1', '--format=%h%x1f%s%x1f%ct']);
    const [hash, subject, ct] = log.trim().split('\x1f');
    if (hash) d.lastCommit = { hash, subject, at: (+ct) * 1000 };
  } catch (err) { d.error = errText(err).slice(0, 200); }
  return d;
}
