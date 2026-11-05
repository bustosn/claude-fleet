// Dedupe, server side: a stable fingerprint per finding (for carrying findings across re-runs) and a first grouping by code location.
// The agent pass then merges groups that share a root cause. Being found by several lenses raises confidence; it never replaces verification.
import { createHash } from 'node:crypto';
import type { QaCodeRef, QaFinding } from '../../shared/types.js';

const norm = (f: string) => f.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();

/** Words that carry meaning in a title, for a fingerprint that survives rewording of the small words and line moves. */
export function titleKey(title: string): string {
  const stop = new Set(['the', 'a', 'an', 'is', 'are', 'of', 'on', 'in', 'to', 'for', 'and', 'or', 'but', 'when', 'with', 'by', 'it', 'its', 'not', 'no', 'be', 'can', 'that', 'this', 'from', 'as', 'at']);
  return [...new Set(title.toLowerCase().replace(/[^a-z0-9_$]+/g, ' ').split(' ').filter(w => w.length > 2 && !stop.has(w)))].sort().slice(0, 8).join(' ');
}

/** Repo + files (not lines, which move between commits) + the title's key words. */
export function fingerprint(f: { title: string; refs: QaCodeRef[] }): string {
  const files = [...new Set(f.refs.map(r => `${r.repo}:${norm(r.file)}`))].sort().join('|');
  return createHash('sha1').update(`${files}#${titleKey(f.title)}`).digest('hex').slice(0, 12);
}

const overlaps = (a: QaCodeRef, b: QaCodeRef, slack = 3) =>
  a.repo === b.repo && norm(a.file) === norm(b.file) && a.line - slack <= (b.endLine ?? b.line) && b.line - slack <= (a.endLine ?? a.line);

/** How alike two titles are: shared key words over all key words (0 to 1). */
export function titleSimilarity(a: string, b: string): number {
  const x = new Set(titleKey(a).split(' ').filter(Boolean)), y = new Set(titleKey(b).split(' ').filter(Boolean));
  if (!x.size || !y.size) return 0;
  let both = 0; for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** Union-find over findings: same fingerprint, or primary refs (the first one) within a few lines of each other *and* alike titles.
 *  Location alone is not enough: a short function often holds several different bugs (strips the wrong quote, and runs on every edit).
 *  Merging by root cause beyond that is the dedupe agent's job. */
export function groupByLocation(findings: Pick<QaFinding, 'id' | 'fingerprint' | 'refs' | 'title'>[]): string[][] {
  const parent = new Map(findings.map(f => [f.id, f.id]));
  const find = (x: string): string => { const p = parent.get(x)!; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  const join = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  for (let i = 0; i < findings.length; i++) for (let j = i + 1; j < findings.length; j++) {
    const a = findings[i], b = findings[j];
    if (a.fingerprint === b.fingerprint || (a.refs[0] && b.refs[0] && overlaps(a.refs[0], b.refs[0]) && titleSimilarity(a.title, b.title) >= 0.4)) join(a.id, b.id);
  }
  const groups = new Map<string, string[]>();
  for (const f of findings) { const r = find(f.id); groups.set(r, [...(groups.get(r) || []), f.id]); }
  return [...groups.values()];
}

/** Applies the agent's merges: each merge names location groups (by index) that share a root cause. Unknown or repeated indexes are ignored. */
export function applyMerges(groups: string[][], merges: { groups: number[]; rootCause: string; title?: string }[]): { ids: string[]; rootCause: string; title?: string }[] {
  const used = new Set<number>();
  const out: { ids: string[]; rootCause: string; title?: string }[] = [];
  for (const m of merges) {
    const idx = [...new Set(m.groups)].filter(i => Number.isInteger(i) && i >= 0 && i < groups.length && !used.has(i));
    if (!idx.length) continue;
    idx.forEach(i => used.add(i));
    out.push({ ids: idx.flatMap(i => groups[i]), rootCause: m.rootCause, title: m.title });
  }
  groups.forEach((g, i) => { if (!used.has(i)) out.push({ ids: g, rootCause: '' }); });
  return out;
}
