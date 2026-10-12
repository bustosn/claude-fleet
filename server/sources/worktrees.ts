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

async function allRepos(reposRoot: string, extraRepos: string[]) {
  const repos = await listRepos(reposRoot);
  for (const p of extraRepos) {
    const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!repos.some(r => r.path.toLowerCase() === norm.toLowerCase())) repos.push({ name: path.basename(norm), path: norm });
  }
  return repos;
}

// One `git worktree list` per repo. No per-worktree status: keeping branches pulled and clean is the user's job, and
// running git status on every checkout every few seconds kept the CPU (and the antivirus scanning each git.exe) busy.
export async function scanRepos(reposRoot: string, extraRepos: string[] = []): Promise<RepoScan[]> {
  return mapLimit(await allRepos(reposRoot, extraRepos), 4, async repo => {
    let base: ReturnType<typeof parsePorcelain>;
    try { base = parsePorcelain(await run('git', ['-C', repo.path, 'worktree', 'list', '--porcelain'])); }
    catch (err) { return { ...repo, error: errText(err), worktrees: [] }; }
    const worktrees = base.map((wt, i) => ({ ...wt, isMain: i === 0, managed: /\/\.claude\/worktrees\//i.test(wt.path) }));
    return { ...repo, worktrees };
  });
}

/** File timestamps only, no git: changes when a repo appears or goes, a worktree is added or removed, or a checkout switches branch. */
export async function layoutStamp(reposRoot: string, extraRepos: string[] = []): Promise<string> {
  const parts = await mapLimit(await allRepos(reposRoot, extraRepos), 8, async repo => {
    const git = path.join(repo.path, '.git');
    const out = [repo.path, await mtime(path.join(git, 'HEAD')), await mtime(path.join(git, 'worktrees'))];
    let linked: string[] = [];
    try { linked = (await fs.readdir(path.join(git, 'worktrees'))).sort(); } catch {}
    for (const n of linked) out.push(n, await mtime(path.join(git, 'worktrees', n, 'HEAD')));
    return out.join('|');
  });
  return parts.join('\n');
}

const mtime = (p: string) => fs.stat(p).then(s => String(s.mtimeMs), () => '-');

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
