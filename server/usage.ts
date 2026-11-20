import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { UsageReport, UsageTotals } from '../shared/types.js';

interface Row { id: string; at: number; model: string; project: string; session: string; input: number; output: number; cacheRead: number; cacheWrite: number }

// Rows per transcript file, kept until the file changes: the first report reads every transcript, later ones only what grew.
const files = new Map<string, { sig: string; rows: Row[] }>();

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: fs.Dirent[] = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

async function readRows(file: string): Promise<Row[]> {
  // A streamed reply is written several times under one message id, the last with the final counts; keep the largest.
  const byId = new Map<string, Row>();
  let cwd = '';
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!cwd && line.includes('"cwd"')) { try { cwd = JSON.parse(line).cwd || ''; } catch {} }
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const m = o?.message, u = m?.usage;
    if (o.type !== 'assistant' || !u || typeof m.model !== 'string' || m.model.startsWith('<')) continue;
    const at = Date.parse(o.timestamp);
    if (!Number.isFinite(at)) continue;
    const row: Row = {
      id: m.id || o.uuid, at, model: m.model, project: cwd || o.cwd || '', session: o.sessionId || path.basename(file, '.jsonl'),
      input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
    };
    const prev = byId.get(row.id);
    if (!prev || row.output >= prev.output) byId.set(row.id, row);
  }
  return [...byId.values()];
}

async function load(claudeHome: string): Promise<Row[]> {
  const seen = new Set<string>();
  for await (const f of walk(path.join(claudeHome, 'projects'))) {
    seen.add(f);
    let st: fs.Stats;
    try { st = await fsp.stat(f); } catch { continue; }
    const sig = `${st.size}:${st.mtimeMs}`;
    if (files.get(f)?.sig === sig) continue;
    try { files.set(f, { sig, rows: await readRows(f) }); } catch { files.delete(f); }
  }
  for (const f of files.keys()) if (!seen.has(f)) files.delete(f);
  // A resumed session copies earlier messages into its new transcript; one message counts once.
  const all = new Map<string, Row>();
  for (const { rows } of files.values()) for (const r of rows) { const p = all.get(r.id); if (!p || r.output > p.output) all.set(r.id, r); }
  return [...all.values()];
}

const blank = (): UsageTotals => ({ messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
function add(t: UsageTotals, r: Row) { t.messages++; t.input += r.input; t.output += r.output; t.cacheRead += r.cacheRead; t.cacheWrite += r.cacheWrite; }
const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

let inflight: Promise<Row[]> | null = null;

/** Token usage read from the transcripts under claudeHome/projects. `days` 0 means everything. */
export async function usageReport(claudeHome: string, days: number): Promise<UsageReport> {
  // Two requests at once share one scan.
  const run = inflight || (inflight = load(claudeHome).finally(() => { inflight = null; }));
  const all = await run;
  const start = days > 0 ? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (days - 1)); return d.getTime(); })() : 0;
  const rows = all.filter(r => r.at >= start);

  const total = blank(), byDay = new Map<string, UsageTotals>(), byModel = new Map<string, UsageTotals>(), byProject = new Map<string, UsageTotals & { sessions: Set<string> }>();
  const sessions = new Set<string>(), hours = new Array<number>(24).fill(0), weekdays = new Array<number>(7).fill(0);
  for (const r of rows) {
    add(total, r);
    const k = dayKey(r.at);
    add(byDay.get(k) || byDay.set(k, blank()).get(k)!, r);
    add(byModel.get(r.model) || byModel.set(r.model, blank()).get(r.model)!, r);
    const name = r.project ? r.project.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || r.project : '(unknown)';
    const p = byProject.get(name) || byProject.set(name, { ...blank(), sessions: new Set() }).get(name)!;
    add(p, r); p.sessions.add(r.session);
    sessions.add(r.session);
    const d = new Date(r.at); hours[d.getHours()]++; weekdays[d.getDay()]++;
  }

  // One entry per calendar day in the range, so quiet days show as gaps instead of vanishing.
  const first = days > 0 ? start : rows.reduce((m, r) => Math.min(m, r.at), Date.now());
  const daily: UsageReport['daily'] = [];
  for (const d = new Date(first); d.setHours(0, 0, 0, 0) <= Date.now(); d.setDate(d.getDate() + 1)) {
    const k = dayKey(d.getTime());
    daily.push({ day: k, ...(byDay.get(k) || blank()) });
  }

  // Longest run of consecutive active days, and the run that includes today (or yesterday) if there is one.
  let longest = 0, run2 = 0;
  for (const d of daily) { run2 = d.messages ? run2 + 1 : 0; longest = Math.max(longest, run2); }
  let current = 0;
  for (let i = daily.length - 1; i >= 0; i--) { if (daily[i].messages) current++; else if (i === daily.length - 1) continue; else break; }

  const sorted = <T extends UsageTotals>(m: Map<string, T>) => [...m].map(([name, t]) => ({ name, t })).sort((a, b) => (b.t.input + b.t.output + b.t.cacheRead + b.t.cacheWrite) - (a.t.input + a.t.output + a.t.cacheRead + a.t.cacheWrite));
  return {
    days, generatedAt: Date.now(), total, sessions: sessions.size, activeDays: daily.filter(d => d.messages).length, longestStreak: longest, currentStreak: current,
    daily, hours, weekdays,
    models: sorted(byModel).map(({ name, t }) => ({ model: name, ...t })),
    projects: sorted(byProject).slice(0, 12).map(({ name, t }) => ({ project: name, messages: t.messages, input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, sessions: t.sessions.size })),
  };
}
