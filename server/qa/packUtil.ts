// Pure helpers for the context pack: what a diff defines and touches, which files never go in, which lenses a diff calls for, the size budget.
// No git or I/O here, so they can be tested on their own.
import type { QaProfile } from '../../shared/types.js';

export const LENSES = ['consistency', 'lifecycle', 'access', 'input', 'regression', 'data', 'jobs', 'frontend', 'performance'] as const;
export type LensName = typeof LENSES[number];

/** Glob on a repo-relative path: `**` spans folders (and may be empty), `*` stays inside one. */
export function globRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** True for a file on the never-commit list. Checked as `<repo>/<path>` and as `<path>`, so `**\/emulation/Config.py` catches the emulation repo's root file. */
export function neverPacked(patterns: string[], repoName: string, rel: string): boolean {
  const p = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const res = patterns.map(globRe);
  return res.some(r => r.test(p) || r.test(`${repoName}/${p}`));
}

export interface DiffFile { path: string; oldPath?: string; status: string; text: string; added: string[]; removed: string[] }

/** Splits a unified diff into files with their added and removed lines. */
export function splitDiff(diff: string): DiffFile[] {
  const out: DiffFile[] = [];
  const parts = diff.split(/^(?=diff --git )/m).filter(p => p.startsWith('diff --git '));
  for (const text of parts) {
    const head = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(text);
    if (!head) continue;
    const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(text)?.[1];
    const minus = /^--- (?:a\/)?(.+)$/m.exec(text)?.[1];
    const pathB = plus && plus !== '/dev/null' ? plus : head[2];
    const status = /^new file mode/m.test(text) ? 'A' : /^deleted file mode/m.test(text) ? 'D' : /^rename from/m.test(text) ? 'R' : 'M';
    const added: string[] = [], removed: string[] = [];
    let inHunk = false;
    for (const line of text.split('\n')) {
      if (line.startsWith('@@')) { inHunk = true; continue; }
      if (!inHunk) continue;
      if (line.startsWith('+')) added.push(line.slice(1));
      else if (line.startsWith('-')) removed.push(line.slice(1));
    }
    out.push({ path: status === 'D' && minus && minus !== '/dev/null' ? minus : pathB, ...(head[1] !== head[2] ? { oldPath: head[1] } : {}), status, text, added, removed });
  }
  return out;
}

export interface Symbols { functions: string[]; classes: string[]; constants: string[]; tables: string[]; routes: string[]; globals: string[] }

// Too common to grep for usefully: every controller has them.
const STOP = new Set(['index', 'show', 'store', 'update', 'destroy', 'create', 'edit', 'handle', '__construct', 'render', 'init', 'data', 'get', 'set', 'up', 'down',
  'boot', 'register', 'run', 'main', 'value', 'name', 'type', 'function', 'return', 'this', 'self', 'static', 'parent', 'true', 'false', 'null', 'NULL', 'TRUE', 'FALSE',
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'INNER', 'ORDER', 'GROUP', 'LIMIT', 'COUNT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'AND', 'NOT', 'EXISTS', 'DISTINCT', 'UNION', 'HAVING', 'INSERT', 'UPDATE', 'DELETE', 'VALUES', 'INTO',
  'information_schema', 'dual']);
const SQL_WORDS = new Set(['select', 'from', 'where', 'join', 'set', 'as', 'on', 'and', 'or', 'not', 'null', 'the', 'a', 'an', 'is', 'in', 'to', 'of', 'if', 'exists', 'table', 'into', 'values', 'dual', 'information_schema']);

function uniq(xs: Iterable<string>): string[] { return [...new Set(xs)].sort(); }

/** Names the diff defines or touches, from its added and removed lines: what a lens needs callers for. */
export function extractSymbols(files: DiffFile[]): Symbols {
  const fn = new Set<string>(), cls = new Set<string>(), cons = new Set<string>(), tables = new Set<string>(), routes = new Set<string>(), globals = new Set<string>();
  const each = (re: RegExp, s: string, f: (m: RegExpExecArray) => void) => { re.lastIndex = 0; let m; while ((m = re.exec(s))) f(m); };
  for (const f of files) {
    const body = [...f.added, ...f.removed].join('\n');
    each(/\bfunction\s+&?([A-Za-z_]\w*)\s*\(/g, body, m => fn.add(m[1]));
    each(/^\s*(?:(?:public|private|protected|static|async)\s+)*([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/gm, body, m => { if (!/^(if|for|foreach|while|switch|catch|function|elseif)$/.test(m[1])) fn.add(m[1]); });
    each(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g, body, m => fn.add(m[1]));
    each(/\b(?:class|trait|interface|enum)\s+([A-Z]\w*)/g, body, m => cls.add(m[1]));
    each(/^\s*use\s+([A-Z]\w*)\s*;/gm, body, m => cls.add(m[1]));
    each(/\b(?:const\s+|define\(\s*['"])([A-Z][A-Z0-9_]{2,})\b/g, body, m => cons.add(m[1]));
    each(/\b(?:self|static|[A-Z]\w*)::([A-Z][A-Z0-9_]{3,})\b/g, body, m => cons.add(m[1]));
    each(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]{2,})\b/g, body, m => cons.add(m[1]));
    each(/->name\(\s*['"]([\w.\-]+)['"]/g, body, m => routes.add(m[1]));
    each(/\broute\(\s*['"]([\w.\-]+)['"]/g, body, m => routes.add(m[1]));
    each(/\bwindow\.([A-Za-z_$][\w$]*)\s*=(?!=)/g, body, m => globals.add(m[1]));
    each(/\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+`?([a-z_][a-z0-9_]*(?:`?\.`?[a-z_][a-z0-9_]*)?)`?/gi, body, m => { const t = m[1].replace(/`/g, '').toLowerCase(); if (!SQL_WORDS.has(t.split('.').pop()!)) tables.add(t); });
    each(/(?:DB::table|->from|->join|->leftJoin|->rightJoin|->table)\(\s*['"]([a-z_][a-z0-9_.]*)(?:\s+as\s+\w+)?['"]/gi, body, m => tables.add(m[1].toLowerCase()));
    each(/\$table\s*=\s*['"]([a-z_][a-z0-9_.]*)['"]/gi, body, m => tables.add(m[1].toLowerCase()));
    each(/\b((?:[a-z_][a-z0-9_]*\.)?cb_[a-z0-9_]{3,})\b/g, body, m => tables.add(m[1].toLowerCase()));
  }
  const keep = (s: Set<string>, min = 4) => uniq([...s].filter(x => x.length >= min && !STOP.has(x)));
  return { functions: keep(fn), classes: keep(cls, 3), constants: keep(cons), tables: uniq([...tables].filter(t => !SQL_WORDS.has(t) && t.length >= 3)), routes: keep(routes, 3), globals: keep(globals, 3) };
}

/** Table names without their database, for INFORMATION_SCHEMA. Only plain identifiers, since they go into the query as literals. */
export function tableNames(tables: string[]): string[] {
  return uniq(tables.map(t => t.split('.').pop()!).filter(t => /^[a-z_][a-z0-9_]{2,63}$/.test(t)));
}

export interface LensChoice { lenses: LensName[]; profile: QaProfile; reasons: Record<string, string> }

/** Which lenses the diff calls for (doc: lens selection by profile and diff), and the profile it suggests. */
export function chooseLenses(profile: QaProfile | null, files: DiffFile[], deepTriggers: string[]): LensChoice {
  const paths = files.map(f => f.path);
  const body = files.map(f => [...f.added, ...f.removed].join('\n')).join('\n');
  const has = (re: RegExp) => re.test(body);
  const reasons: Record<string, string> = {};
  const trig: Partial<Record<LensName, boolean>> = {
    data: paths.some(p => /\.sql$/i.test(p) || /migrations?\//i.test(p)) || has(/\b(SELECT|JOIN|INSERT INTO|UPDATE\s+\S+\s+SET|CREATE TABLE|ALTER TABLE)\b|DB::|->where\(|->join\(/i),
    jobs: paths.some(p => /Console[\\/]|Commands?[\\/]|Kernel\.php$|cron|jobs?[\\/]/i.test(p)) || has(/->(daily|hourly|cron|everyMinute|dailyAt)\(|\$signature\s*=/),
    frontend: paths.some(p => /\.(js|jsx|ts|tsx|vue|blade\.php|html|css)$/i.test(p)),
    access: has(/Gate::|Auth::|auth\(\)|->can\(|->cannot\(|middleware|permission|isAdmin|is_admin|user_id|->user\(\)/),
    lifecycle: has(/status_id|\bstatus\b|\bis_[a-z]+\b|resolved_at|verdict/i),
    input: has(/json_decode|JSON\.parse|explode\(|split\(|trim\(|str_replace|preg_|\(string\)|request\(|\$request->|->input\(|\.val\(\)|sanitize|normali[sz]e/i),
  };
  trig.performance = trig.data;
  for (const [k, v] of Object.entries(trig)) if (v) reasons[k] = 'triggered by the diff';
  const lower = body.toLowerCase() + '\n' + paths.join('\n').toLowerCase();
  const deepHit = deepTriggers.find(t => lower.includes(t.toLowerCase()));
  const suggested: QaProfile = deepHit ? 'deep' : files.length <= 3 && body.length < 4000 ? 'quick' : 'standard';
  const p = profile || suggested;
  let lenses: LensName[];
  if (p === 'deep') { lenses = [...LENSES]; for (const l of LENSES) reasons[l] ||= 'deep profile'; }
  else if (p === 'quick') {
    lenses = ['input', 'regression'];
    if (trig.frontend) lenses.push('frontend'); else if (trig.data) lenses.push('data');
    reasons.input ||= 'quick profile'; reasons.regression ||= 'quick profile';
  } else {
    lenses = LENSES.filter(l => l === 'consistency' || l === 'regression' || trig[l]);
    reasons.consistency ||= 'always'; reasons.regression ||= 'always';
  }
  if (deepHit) reasons._profile = `suggested deep: the diff mentions "${deepHit}"`;
  return { lenses: LENSES.filter(l => lenses.includes(l)), profile: suggested, reasons };
}

export interface PackEntry { path: string; kind: 'core' | 'base' | 'callers' | 'meta'; text: string }

/** Keeps the pack under budget: callers are cut first (to their first hits, then dropped), then base versions (largest first). Changed files and diffs stay. */
export function trimToBudget(entries: PackEntry[], budgetBytes: number): { entries: PackEntry[]; trimmed: string[] } {
  const size = (es: PackEntry[]) => es.reduce((n, e) => n + Buffer.byteLength(e.text), 0);
  let out = entries.map(e => ({ ...e }));
  const trimmed: string[] = [];
  if (size(out) <= budgetBytes) return { entries: out, trimmed };
  for (const e of out.filter(e => e.kind === 'callers')) {
    const before = Buffer.byteLength(e.text);
    // Callers files are blocks per symbol; keep each block's head.
    e.text = e.text.split(/\n(?=### )/).map(b => b.length > 2500 ? b.slice(0, 2500) + '\n… (trimmed for the pack budget)\n' : b).join('\n');
    if (Buffer.byteLength(e.text) < before) trimmed.push(`${e.path}: caller hits cut to the first lines of each symbol`);
  }
  if (size(out) > budgetBytes) for (const e of out.filter(e => e.kind === 'callers')) { out = out.filter(x => x !== e); trimmed.push(`${e.path}: dropped`); if (size(out) <= budgetBytes) break; }
  if (size(out) > budgetBytes) for (const e of out.filter(e => e.kind === 'base').sort((a, b) => b.text.length - a.text.length)) { out = out.filter(x => x !== e); trimmed.push(`${e.path}: base version dropped`); if (size(out) <= budgetBytes) break; }
  return { entries: out, trimmed };
}

/** `git grep -z -n -C` output for one symbol into regions per file, capped. Lines are `sha:path NUL line NUL text`; a line is a match when it has the word. */
export function parseGrep(out: string, sym: string, maxRegions: number): { regions: { file: string; lines: string[] }[]; matches: number; files: number } {
  const regions: { file: string; lines: string[] }[] = [];
  let cur: { file: string; lines: string[] } | null = null, matches = 0;
  const files = new Set<string>();
  const word = new RegExp(`(^|[^\\w$])${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w])`);
  for (const line of out.split('\n')) {
    if (line === '--') { cur = null; continue; }
    const parts = line.split('\0');
    if (parts.length < 3) continue;
    const file = parts[0].replace(/^[0-9a-f]{7,40}:/, ''), n = parts[1], text = parts.slice(2).join(' ').replace(/\r$/, '');
    const hit = word.test(text);
    files.add(file);
    if (hit) matches++;
    if (!cur || cur.file !== file) { cur = { file, lines: [] }; regions.push(cur); }
    cur.lines.push(`${n}${hit ? ':' : ' '} ${text}`);
  }
  return { regions: regions.slice(0, maxRegions), matches, files: files.size };
}
