// QA runs (docs/plans/04-qa.md), milestone QA1: intake → context pack → lenses (parallel) → dedupe → verify (parallel) → markdown report.
// Every reviewer, deduper and verifier is a new chat with read-only tools; none of them ever sees the author chat. Each phase writes the
// run's state file, so a restart keeps the run and Resume continues at the phase it was in (lens and verifier work already done is kept).
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatManager, Chat } from './chat.js';
import type { QaConfig } from './config.js';
import type { SqlManager } from './sql.js';
import type { ChatEvent, QaAgent, QaAgentRole, QaChecked, QaCodeRef, QaCost, QaEvent, QaFinding, QaGroup, QaPackInfo, QaPhase, QaProfile, QaRunDetail, QaRunSummary, QaTarget } from '../shared/types.js';
import { buildPack, resolveTarget, sourceSnapshot, type PackInputs, type TargetSpec } from './qa/pack.js';
import { LENSES } from './qa/packUtil.js';
import { applyMerges, fingerprint, groupByLocation } from './qa/dedupe.js';
import { renderReport } from './qa/report.js';
import type { FindingInput, MergeInput, QaToolSink, VerdictInput } from './qa/tools.js';
import { errText, run as exec } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readPrompt = (name: string) => fs.readFileSync(path.join(HERE, 'qa', 'prompts', `${name}.md`), 'utf8');
const readLens = (name: string) => fs.readFileSync(path.join(HERE, 'qa', 'lenses', `${name}.md`), 'utf8');
const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** QA1's phases in order. spec/awaiting-signoff (QA2) and plan/tests (QA3) are skipped. */
export const QA1_PHASES: QaPhase[] = ['intake', 'pack', 'lenses', 'dedupe', 'verify', 'report', 'done'];
export function phaseAfter(p: QaPhase): QaPhase {
  const i = QA1_PHASES.indexOf(p);
  return i < 0 || i === QA1_PHASES.length - 1 ? p : QA1_PHASES[i + 1];
}

export interface LensPlan { key: string; lens: string; model: string }
/** The lens runs for a profile: each chosen lens once on the lens model; deep adds a second lifecycle and consistency run on another model. */
export function lensPlan(lenses: string[], profile: QaProfile, models: { lens: string; second: string }): LensPlan[] {
  const plan = lenses.map(l => ({ key: l, lens: l, model: models.lens }));
  if (profile === 'deep') for (const l of ['lifecycle', 'consistency']) if (lenses.includes(l)) plan.push({ key: `${l}-2`, lens: l, model: models.second });
  return plan;
}

/** After a restart, what the lens phase still has to run: plan entries without a finished agent. Findings of unfinished agents are dropped. */
export function pendingLenses(plan: LensPlan[], agents: Pick<QaAgent, 'role' | 'label' | 'status'>[]): LensPlan[] {
  const done = new Set(agents.filter(a => a.role === 'lens' && a.status === 'done').map(a => a.label));
  return plan.filter(p => !done.has(p.key));
}

/** A lens file's checklist: the text before the first bullet under "## Checklist", and each bullet (continuation lines joined). */
export function checklistItems(md: string): { intro: string; items: string[] } {
  const body = md.split(/^## Checklist\s*$/m)[1] ?? md.replace(/^# .*$/m, '');
  const items: string[] = []; const intro: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^- /.test(line)) items.push(line.slice(2).trim());
    else if (items.length && /^\s+\S/.test(line)) items[items.length - 1] += ' ' + line.trim();
    else if (!items.length && line.trim()) intro.push(line.trim());
  }
  return { intro: intro.join('\n'), items };
}

/** Indexes of checklist items no finding or check named. Items are named "C3" (or "C3. text"); anything else counts for nothing. */
export function uncoveredItems(count: number, said: string[]): number[] {
  const hit = new Set(said.map(s => /\bC(\d+)\b/i.exec(s)?.[1]).filter(Boolean).map(n => Number(n) - 1));
  return Array.from({ length: count }, (_, i) => i).filter(i => !hit.has(i));
}

export interface QaStartSpec { targets: TargetSpec[]; jiraKey?: string; ticketText?: string; profile?: QaProfile | 'auto'; title?: string;
  /** Only these lens runs (keys like "input" or "lifecycle-2"), for re-checking lens briefs; the profile still decides the rest. */
  lenses?: string[] }

interface RunState extends Omit<QaRunDetail, 'counts' | 'cost'> {
  specs: TargetSpec[]; inputs: { jiraKey?: string; ticketText?: string }; plan: LensPlan[]; profileAuto: boolean; startedAt: number;
  srcDirs: Record<string, string>; costBase: QaCost; nextFinding: number; nextGroup: number; capHit: string | null; only?: string[]; limitHit?: string | null;
}

class Stopped extends Error { constructor() { super('Stopped.'); } }
/** The account's usage or rate limit: more agents would fail the same way, so the run pauses instead and Resume picks up the unfinished work. */
class LimitHit extends Error {}
export const isLimitText = (s: string) => /session limit|usage limit|usage_limit|rate.?limit|hit your .*limit|resets \d/i.test(s);

/** Owns QA runs: the phase machine, the chats it starts (through ChatManager with read-only tools), the slots, and the state files. */
export class QaManager extends EventEmitter implements QaToolSink {
  runs = new Map<string, RunState>();
  private active = new Set<string>();
  private slotsUsed = 0; private slotWaiters: (() => void)[] = [];
  /** Live agent chats by chat id, so tool calls find their run and agent. */
  private chatAgent = new Map<string, { runId: string; agentId: string }>();
  private saveTimers = new Map<string, NodeJS.Timeout>();

  constructor(private chats: ChatManager, private cfg: QaConfig, private sql: SqlManager | null, private dir: string,
    private jiraFetch?: PackInputs['jiraFetch']) {
    super();
    fs.mkdirSync(dir, { recursive: true });
  }

  // ── list, detail, report ────────────────────────────────────────────────────────────────
  list(): QaRunSummary[] { return [...this.runs.values()].map(r => this.summary(r)).sort((a, b) => b.createdAt - a.createdAt); }
  detail(id: string): QaRunDetail | null { const r = this.runs.get(id); return r ? this.toDetail(r) : null; }
  report(id: string): string | null { const r = this.runs.get(id); return r ? renderReport(this.toDetail(r)) : null; }

  private cost(r: RunState): QaCost {
    const a = r.agents;
    return { agents: a.filter(x => x.chatId).length, turns: a.reduce((n, x) => n + x.turns, 0), inputTokens: a.reduce((n, x) => n + x.inputTokens, 0),
      outputTokens: a.reduce((n, x) => n + x.outputTokens, 0), costUsd: a.reduce((n, x) => n + x.costUsd, 0), ms: r.costBase.ms + (r.finishedAt || Date.now()) - r.startedAt };
  }
  private summary(r: RunState): QaRunSummary {
    const live = r.groups.filter(g => g.verdict === 'CONFIRMED' || g.verdict === 'PLAUSIBLE');
    return { id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt, finishedAt: r.finishedAt, profile: r.profile, phase: r.phase, error: r.error, stale: r.stale, paused: r.paused,
      targets: r.targets, jiraKey: r.jiraKey, lenses: r.plan.map(p => p.key),
      counts: { findings: r.findings.length, groups: r.groups.length, confirmed: r.groups.filter(g => g.verdict === 'CONFIRMED').length, plausible: r.groups.filter(g => g.verdict === 'PLAUSIBLE').length,
        rejected: r.groups.filter(g => g.verdict === 'REJECTED').length, blocker: live.filter(g => g.severity === 'blocker').length, major: live.filter(g => g.severity === 'major').length, minor: live.filter(g => g.severity === 'minor').length },
      cost: this.cost(r) };
  }
  private toDetail(r: RunState): QaRunDetail {
    return { ...this.summary(r), pack: r.pack, agents: r.agents, findings: r.findings, groups: r.groups, checked: r.checked, log: r.log, matrixSignedOff: r.matrixSignedOff };
  }

  // ── start, stop, resume, remove ─────────────────────────────────────────────────────────
  start(spec: QaStartSpec): QaRunSummary {
    if (!Array.isArray(spec.targets) || !spec.targets.length) throw new Error('A QA run needs at least one target (a repo folder and a head).');
    for (const t of spec.targets) if (!t || !t.repo || !fs.existsSync(t.repo)) throw new Error(`No repo folder ${t?.repo || '(missing)'}.`);
    const profile = spec.profile && spec.profile !== 'auto' ? spec.profile : null;
    if (profile && !['quick', 'standard', 'deep'].includes(profile)) throw new Error(`Unknown profile ${profile}.`);
    const id = randomUUID().slice(0, 8), now = Date.now();
    const title = String(spec.title || '').trim() || [spec.jiraKey, spec.targets.map(t => `${path.basename(t.repo)}${t.head ? `@${t.head}` : ''}`).join(' + ')].filter(Boolean).join(' · ');
    const r: RunState = {
      id, title, createdAt: now, updatedAt: now, startedAt: now, finishedAt: null, profile: profile || this.cfg.defaultProfile, profileAuto: !profile, phase: 'intake', error: null, stale: false, paused: false,
      targets: [], jiraKey: spec.jiraKey ? String(spec.jiraKey).toUpperCase() : undefined, lenses: [], specs: spec.targets.map(t => ({ ...t, repo: path.resolve(t.repo) })),
      inputs: { jiraKey: spec.jiraKey, ticketText: spec.ticketText }, plan: [], pack: null, agents: [], findings: [], groups: [], checked: [], log: [], matrixSignedOff: false,
      srcDirs: {}, costBase: { agents: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 }, nextFinding: 1, nextGroup: 1, capHit: null,
      ...(Array.isArray(spec.lenses) && spec.lenses.length ? { only: spec.lenses.map(String) } : {}),
    };
    this.runs.set(id, r);
    this.note(r, `Started: ${title}${profile ? `, ${profile} profile` : ', profile from the diff'}.`);
    void this.drive(r);
    return this.summary(r);
  }

  stop(id: string) {
    const r = this.must(id);
    if (r.phase === 'done' || r.phase === 'failed') return this.summary(r);
    this.active.delete(r.id);
    for (const a of r.agents) if (a.status === 'running' && a.chatId) this.chats.get(a.chatId)?.close();
    this.finish(r, 'failed', 'Stopped by the person.');
    return this.summary(r);
  }

  resume(id: string) {
    const r = this.must(id);
    // A finished run with groups that never got a verdict (verifiers that failed) goes back to verify; nothing else is redone.
    if (!r.paused && r.phase === 'done' && r.groups.some(g => !g.verdict)) { r.phase = 'verify'; r.capHit = null; }
    else if (!r.paused) throw new Error('This run is not waiting to be resumed.');
    // The time cap and the cost's duration count active time: the segment that just ended is banked, and a new one starts now.
    r.costBase.ms += Math.max(0, (r.finishedAt || r.updatedAt) - r.startedAt); r.startedAt = Date.now(); r.finishedAt = null;
    r.paused = false; r.error = null; r.limitHit = null;
    this.note(r, `Resumed at ${r.phase}.`);
    void this.drive(r);
    return this.summary(r);
  }

  remove(id: string) {
    const r = this.must(id);
    if (this.active.has(id)) this.stop(id);
    this.runs.delete(id);
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    for (const a of r.agents) fs.rmSync(a.cwd, { recursive: true, force: true });
    // Source snapshots are shared between runs at the same sha; drop the ones nothing uses any more.
    const used = new Set([...this.runs.values()].flatMap(x => Object.values(x.srcDirs)));
    for (const d of Object.values(r.srcDirs)) if (!used.has(d)) fs.rmSync(d, { recursive: true, force: true });
    this.emit('change');
  }

  private must(id: string) { const r = this.runs.get(id); if (!r) throw new Error('No such QA run.'); return r; }

  // ── the phase machine ───────────────────────────────────────────────────────────────────
  private async drive(r: RunState) {
    if (this.active.has(r.id)) return;
    this.active.add(r.id);
    try {
      while (this.active.has(r.id) && r.phase !== 'done' && r.phase !== 'failed') {
        await this.step(r);
        if (!this.active.has(r.id)) return;
        this.setPhase(r, phaseAfter(r.phase));
      }
    } catch (err) {
      if (err instanceof Stopped || !this.active.has(r.id)) return;
      if (err instanceof LimitHit) { r.paused = true; r.error = err.message; this.note(r, `Paused at ${r.phase}: ${err.message}`); this.changed(r); return; }
      this.finish(r, 'failed', errText(err));
    } finally { this.active.delete(r.id); }
  }

  private async step(r: RunState) {
    switch (r.phase) {
      case 'intake': return this.intake(r);
      case 'pack': return this.packPhase(r);
      case 'lenses': return this.lensPhase(r);
      case 'dedupe': return this.dedupePhase(r);
      case 'verify': return this.verifyPhase(r);
      case 'report': return this.reportPhase(r);
    }
  }

  private async intake(r: RunState) {
    r.targets = [];
    for (const s of r.specs) {
      const t = await resolveTarget(s, msg => this.note(r, msg));
      r.targets.push(t);
      this.note(r, `${t.name}: ${t.head} at ${t.headSha.slice(0, 9)}, base ${t.baseSha.slice(0, 9)} (merge base with ${t.base}).`);
    }
    const names = r.targets.map(t => t.name);
    if (new Set(names).size !== names.length) throw new Error('Two targets are the same repo; give one target per repo.');
    this.changed(r);
  }

  private async packPhase(r: RunState) {
    const runDir = path.join(this.dir, r.id);
    for (const t of r.targets) {
      this.note(r, `${t.name}: extracting the source snapshot at ${t.headSha.slice(0, 9)}…`);
      r.srcDirs[t.name] = (await sourceSnapshot(t, path.join(this.dir, 'src'), this.cfg.neverPack)).replace(/\\/g, '/');
    }
    this.note(r, 'Building the context pack…');
    const built = await buildPack({ dir: path.join(runDir, 'pack'), targets: r.targets, specs: r.specs, inputs: { jiraKey: r.inputs.jiraKey, ticketText: r.inputs.ticketText, jiraFetch: this.jiraFetch },
      cfg: this.cfg, sql: this.sql, profile: r.profileAuto ? null : r.profile, srcDirs: r.srcDirs, log: s => this.note(r, s) });
    r.pack = built.info;
    if (r.profileAuto) { r.profile = built.profile; this.note(r, `Profile from the diff: ${built.profile}${built.reasons._profile ? ` (${built.reasons._profile})` : ''}.`); }
    // built.lenses already follows the chosen profile (or the suggested one, when the profile comes from the diff).
    r.lenses = r.profile === 'deep' ? [...LENSES] : built.lenses;
    r.plan = lensPlan(r.lenses, r.profile, { lens: this.cfg.models.lens, second: this.cfg.deepSecondModel });
    if (r.only) { r.plan = r.plan.filter(p => r.only!.includes(p.key)); if (!r.plan.length) throw new Error(`None of the lenses asked for (${r.only.join(', ')}) is in the ${r.profile} plan.`); }
    this.note(r, `Pack: ${Math.round(built.info.bytes / 1024)} KB in ${built.info.files} files${built.info.trimmed.length ? `, ${built.info.trimmed.length} trimmed` : ''}. Lenses: ${r.plan.map(p => `${p.key} (${p.model})`).join(', ')}.`);
    for (const n of built.info.notes) this.note(r, `Pack note: ${n}`);
    this.changed(r);
  }

  private dirsFor(r: RunState) { return [r.pack!.dir, ...Object.values(r.srcDirs)]; }

  private async lensPhase(r: RunState) {
    // Resume: unfinished lens agents' findings and checks go; finished ones stay.
    const unfinished = new Set(r.agents.filter(a => a.role === 'lens' && a.status !== 'done').map(a => a.id));
    if (unfinished.size) {
      r.findings = r.findings.filter(f => !unfinished.has(f.agentId)); r.checked = r.checked.filter(c => !unfinished.has(c.agentId));
      r.agents = r.agents.filter(a => !unfinished.has(a.id));
    }
    const todo = pendingLenses(r.plan, r.agents);
    const frame = readPrompt('lens');
    await Promise.all(todo.map(async p => {
      const { intro, items } = checklistItems(readLens(p.lens));
      const numbered = [intro, ...items.map((t, i) => `- **C${i + 1}.** ${t}`)].filter(Boolean).join('\n');
      const prompt = fill(frame, { runId: r.id, lens: p.lens, packDir: r.pack!.dir, checklist: numbered });
      const a = this.newAgent(r, 'lens', p.key, p.model, { lens: p.lens });
      await this.runAgent(r, a, prompt, () => {
        const said = [...r.findings.filter(f => f.agentId === a.id).map(f => f.checklistItem || ''), ...r.checked.filter(c => c.agentId === a.id).map(c => c.item)];
        if (!said.length) return 'You ended your turn without calling fleet_qa_finding or fleet_qa_checked. Work through the checklist now: report each bug with fleet_qa_finding and record each item that holds with fleet_qa_checked. An empty report with no reasoning is a failed review.';
        const open = uncoveredItems(items.length, said);
        if (open.length) return `These checklist items have no finding and no fleet_qa_checked yet:\n\n${open.map(i => `- C${i + 1}. ${items[i]}`).join('\n')}\n\nWork through each one now. Each ends in a fleet_qa_finding (checklist_item "C<n>") or a fleet_qa_checked (item "C<n>").`;
        return null;
      });
    }));
    if (r.limitHit) throw new LimitHit(`Usage limit hit (${r.limitHit}). Resume when it resets; finished lens runs are kept.`);
    const failed = r.agents.filter(a => a.role === 'lens' && a.status === 'failed');
    this.note(r, `Lenses done: ${plural(r.findings.length, 'finding')}${failed.length ? `; ${failed.length} lens run(s) failed (${failed.map(a => a.label).join(', ')})` : ''}.`);
    if (failed.length === r.plan.length) throw new Error('Every lens run failed; see the agents for why.');
  }

  private async dedupePhase(r: RunState) {
    for (const f of r.findings) delete f.groupId;
    r.groups = []; r.nextGroup = 1;
    if (!r.findings.length) return;
    const loc = groupByLocation(r.findings);
    let merged: { ids: string[]; rootCause: string; title?: string }[] = loc.map(ids => ({ ids, rootCause: '' }));
    if (loc.length > 1 && !r.capHit) {
      const byId = new Map(r.findings.map(f => [f.id, f]));
      const text = loc.map((ids, i) => {
        const fs_ = ids.map(id => byId.get(id)!);
        return `### Group ${i}\n\n` + fs_.map(f => `- **${f.title}** (${f.lenses.join(', ')}; ${f.refs.map(x => `${x.repo}/${x.file}:${x.line}`).join(', ')})\n  ${f.scenario.replace(/\s+/g, ' ').slice(0, 700)}`).join('\n');
      }).join('\n\n');
      const a = this.newAgent(r, 'dedupe', 'dedupe', this.cfg.models.dedupe);
      this.mergeBuffer.set(a.id, null);
      await this.runAgent(r, a, fill(readPrompt('dedupe'), { runId: r.id, packDir: r.pack!.dir, groups: text }),
        () => this.mergeBuffer.get(a.id) ? null : 'Call fleet_qa_group now with your merges (an empty list if none), then end your turn.');
      const m = this.mergeBuffer.get(a.id); this.mergeBuffer.delete(a.id);
      if (m) merged = applyMerges(loc, m.map(x => ({ groups: x.groups, rootCause: x.root_cause, title: x.title })));
    }
    const byId = new Map(r.findings.map(f => [f.id, f]));
    for (const g of merged) {
      const ms = g.ids.map(id => byId.get(id)!).filter(Boolean);
      // The lead report is the one with the most detail.
      ms.sort((a, b) => b.scenario.length - a.scenario.length);
      const id = `G-${r.nextGroup++}`;
      for (const f of ms) f.groupId = id;
      r.groups.push({ id, title: g.title || ms[0].title, rootCause: g.rootCause, findingIds: ms.map(f => f.id), lenses: [...new Set(ms.flatMap(f => f.lenses))] });
    }
    this.note(r, `Dedupe: ${plural(r.findings.length, 'finding')} in ${plural(r.groups.length, 'group')}.`);
    this.changed(r);
  }
  private mergeBuffer = new Map<string, MergeInput[] | null>();

  private async verifyPhase(r: RunState) {
    // Resume: groups that already have a verdict keep it.
    r.agents = r.agents.filter(a => !(a.role === 'verifier' && a.status !== 'done'));
    const todo = r.groups.filter(g => !g.verdict);
    if (!todo.length) return;
    // Up to five groups per verifier, kept together by file so one verifier reads related code.
    todo.sort((a, b) => this.leadFile(r, a).localeCompare(this.leadFile(r, b)));
    const batches: QaGroup[][] = [];
    for (let i = 0; i < todo.length; i += 5) batches.push(todo.slice(i, i + 5));
    const tpl = readPrompt('verifier');
    await Promise.all(batches.map(async batch => {
      const a = this.newAgent(r, 'verifier', `verify-${Math.max(0, ...r.agents.filter(x => x.role === 'verifier').map(x => Number(/-(\d+)$/.exec(x.label)?.[1] || 0))) + 1}`, this.cfg.models.verifier);
      a.groupIds = batch.map(g => g.id);
      const missing = () => batch.filter(g => !g.verdict).map(g => g.id);
      await this.runAgent(r, a, fill(tpl, { runId: r.id, packDir: r.pack!.dir, groups: batch.map(g => this.groupText(r, g)).join('\n\n') }),
        () => missing().length ? `These groups still have no verdict: ${missing().join(', ')}. Call fleet_qa_verdict for each, then end your turn.` : null);
    }));
    if (r.limitHit) throw new LimitHit(`Usage limit hit (${r.limitHit}). Resume when it resets; groups with a verdict are kept.`);
    const left = r.groups.filter(g => !g.verdict).length;
    this.note(r, `Verify: ${plural(r.groups.length - left, 'verdict')}${left ? `, ${left} group(s) left without one` : ''}.`);
  }

  private leadFile(r: RunState, g: QaGroup) { const f = r.findings.find(x => x.id === g.findingIds[0]); return f?.refs[0] ? `${f.refs[0].repo}/${f.refs[0].file}` : ''; }
  private groupText(r: RunState, g: QaGroup): string {
    const ms = g.findingIds.map(id => r.findings.find(f => f.id === id)!).filter(Boolean);
    const lines = [`### ${g.id}: ${g.title}`, '', `Reported by: ${g.lenses.join(', ')}${g.rootCause ? `\nRoot cause (from dedupe): ${g.rootCause}` : ''}`, ''];
    for (const f of ms) {
      lines.push(`- **${f.title}**`, `  Scenario: ${f.scenario}`, `  Code: ${f.refs.map(x => `${x.repo}/${x.file}:${x.line}${x.endLine ? `-${x.endLine}` : ''}`).join(', ')}`);
      if (f.suggestedFix) lines.push(`  Suggested fix: ${f.suggestedFix}`);
    }
    return lines.join('\n');
  }

  private async reportPhase(r: RunState) {
    // A head that moved while the run went on makes the run stale.
    for (const t of r.targets) {
      if (/^[0-9a-f]{7,40}$/i.test(t.head)) continue;
      try { const now = (await exec('git', ['-C', t.repo, 'rev-parse', '--verify', '--quiet', `${t.head}^{commit}`])).trim(); if (now && now !== t.headSha) { r.stale = true; this.note(r, `${t.name}: ${t.head} moved to ${now.slice(0, 9)} during the run; the report is stale.`); } } catch {}
    }
    r.finishedAt = Date.now();
    fs.mkdirSync(path.join(this.dir, r.id), { recursive: true });
    fs.writeFileSync(path.join(this.dir, r.id, 'report.md'), renderReport(this.toDetail(r)));
    const s = this.summary(r).counts;
    this.note(r, `Report: ${s.blocker} blocker, ${s.major} major, ${s.minor} minor among ${s.confirmed + s.plausible} confirmed or plausible; ${s.rejected} rejected.`);
  }

  // ── agents ──────────────────────────────────────────────────────────────────────────────
  private newAgent(r: RunState, role: QaAgentRole, label: string, model: string, extra: Partial<QaAgent> = {}): QaAgent {
    const cwd = path.join(path.dirname(this.dir), 'scratch', `qa-${r.id}-${label}`).replace(/\\/g, '/');
    const a: QaAgent = { id: `${r.id}-${label}`, role, label, model, chatId: null, sessionId: null, cwd, status: 'queued', startedAt: null, endedAt: null, error: null,
      turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ...extra };
    r.agents.push(a);
    this.changed(r);
    return a;
  }

  private async slot() {
    if (this.slotsUsed < this.cfg.maxConcurrent) { this.slotsUsed++; return; }
    await new Promise<void>(res => this.slotWaiters.push(res));
    this.slotsUsed++;
  }
  private release() { this.slotsUsed--; this.slotWaiters.shift()?.(); }

  /** One agent: a new chat with the QA tools, the brief, and up to two nudges when `unfinished` says the work is not done. The chat ends after. */
  private async runAgent(r: RunState, a: QaAgent, prompt: string, unfinished: () => string | null) {
    await this.slot();
    try {
      if (!this.active.has(r.id)) throw new Stopped();
      if (r.limitHit) { Object.assign(a, { status: 'failed', error: 'Not started: the usage limit was hit.' }); return; }
      const started = r.agents.filter(x => x.chatId).length;
      const minutes = (r.costBase.ms + Date.now() - r.startedAt) / 60000;
      if (started >= this.cfg.maxAgents || minutes >= this.cfg.maxMinutes) {
        r.capHit = started >= this.cfg.maxAgents ? `the agent cap (${this.cfg.maxAgents})` : `the time cap (${this.cfg.maxMinutes} min)`;
        Object.assign(a, { status: 'failed', error: `Not started: the run hit ${r.capHit}.` });
        this.note(r, `${a.label}: not started, the run hit ${r.capHit}.`);
        return;
      }
      fs.mkdirSync(a.cwd, { recursive: true });
      const chat = this.chats.open({ cwd: a.cwd, model: a.model, permissionMode: 'dontAsk', lazy: true });
      chat.qa = { runId: r.id, agentId: a.id, role: a.role, lens: a.lens, dirs: this.dirsFor(r) };
      chat.label = `QA ${r.id} · ${a.label}`;
      this.chatAgent.set(chat.id, { runId: r.id, agentId: a.id });
      Object.assign(a, { chatId: chat.id, status: 'running', startedAt: Date.now() });
      this.changed(r);
      chat.wake();
      if (this.cfg.effort) await chat.setEffort(this.cfg.effort).catch(() => {});
      let message = prompt;
      try {
        for (let round = 0; round < 3; round++) {
          const ev = await this.turn(chat, message);
          a.sessionId = chat.sessionId;
          if (ev.total) { a.inputTokens = ev.total.input + ev.total.cacheRead + ev.total.cacheWrite; a.outputTokens = ev.total.output; }
          if (typeof ev.cost === 'number') a.costUsd = ev.cost;
          a.turns += ev.turns || 0;
          this.changed(r);
          if (ev.isError) {
            const said = `${chat.turnText} ${ev.errors?.join(' ') || ''}`.trim();
            if (isLimitText(said)) { r.limitHit = said.replace(/\s+/g, ' ').slice(0, 200); throw new LimitHit(r.limitHit); }
            throw new Error(`the turn ended with an error (${ev.subtype})${said ? `: ${said.slice(0, 300)}` : ''}`);
          }
          const more = unfinished();
          if (!more || round === 2) break;
          message = `[Fleet QA ${r.id}] ${more}`;
        }
        Object.assign(a, { status: 'done', endedAt: Date.now() });
      } catch (err) {
        if (!this.active.has(r.id)) throw new Stopped();
        Object.assign(a, { status: 'failed', endedAt: Date.now(), error: errText(err) });
        if (!(err instanceof LimitHit)) this.note(r, `${a.label} failed: ${a.error}`);
      } finally {
        this.chatAgent.delete(chat.id);
        if (chat.status !== 'ended') chat.close();
        this.changed(r);
      }
    } finally { this.release(); }
  }

  /** Sends one message and resolves with the turn's result event; rejects if the chat ends first. */
  private turn(chat: Chat, text: string): Promise<Extract<ChatEvent, { t: 'result' }>> {
    return new Promise((resolve, reject) => {
      const onEv = (ev: ChatEvent) => {
        if (ev.t === 'result') { chat.off('event', onEv); resolve(ev); }
        else if (ev.t === 'status' && ev.status === 'ended') { chat.off('event', onEv); reject(new Error(chat.error || 'the chat ended')); }
      };
      chat.on('event', onEv);
      try { chat.send(text); } catch (err) { chat.off('event', onEv); reject(err); }
    });
  }

  // ── tool calls from QA chats ────────────────────────────────────────────────────────────
  private owner(chat: Chat, role: QaAgentRole): { r: RunState; a: QaAgent } | string {
    const link = this.chatAgent.get(chat.id);
    const r = link && this.runs.get(link.runId), a = r?.agents.find(x => x.id === link!.agentId);
    if (!r || !a) return 'This chat is not part of a running QA run.';
    if (a.role !== role) return `This tool is not for a ${a.role}.`;
    return { r, a };
  }

  finding(chat: Chat, f: FindingInput) {
    const o = this.owner(chat, 'lens'); if (typeof o === 'string') return { ok: false, text: o };
    const { r, a } = o;
    if (/^\s*(consider|maybe|perhaps|possibly|might|could\b|nit\b|style\b)/i.test(f.title)) return { ok: false, text: 'Not recorded: "consider"/"might"/style items are not findings. Report a concrete wrong behaviour with its failure scenario, or record the item with fleet_qa_checked.' };
    const names = r.targets.map(t => t.name);
    const refs: QaCodeRef[] = [];
    for (const x of f.refs) {
      const repo = names.find(n => n.toLowerCase() === String(x.repo).toLowerCase()) || (names.length === 1 ? names[0] : null);
      if (!repo) return { ok: false, text: `Not recorded: repo "${x.repo}" is not a target. Use one of: ${names.join(', ')}.` };
      refs.push({ repo, file: String(x.file).replace(/\\/g, '/').replace(/^\.?\//, ''), line: x.line, ...(x.end_line ? { endLine: x.end_line } : {}) });
    }
    const id = `F-${r.nextFinding++}`;
    const finding: QaFinding = { id, fingerprint: fingerprint({ title: f.title, refs }), lenses: [a.lens || a.label], agentId: a.id, title: f.title.trim(), scenario: f.scenario.trim(), refs,
      ...(f.suggested_fix ? { suggestedFix: f.suggested_fix } : {}), ...(f.checklist_item ? { checklistItem: f.checklist_item } : {}), ...(f.severity ? { lensSeverity: f.severity } : {}),
      disposition: 'open', testIds: [] };
    r.findings.push(finding);
    this.note(r, `${a.label}: ${id} ${finding.title}`);
    this.changed(r);
    return { ok: true, text: `Recorded as ${id}. Carry on with the checklist.` };
  }

  checked(chat: Chat, item: string, reason: string) {
    const o = this.owner(chat, 'lens'); if (typeof o === 'string') return { ok: false, text: o };
    const c: QaChecked = { agentId: o.a.id, lens: o.a.lens || o.a.label, item: item.trim(), reason: reason.trim() };
    o.r.checked.push(c);
    this.changed(o.r);
    return { ok: true, text: 'Recorded.' };
  }

  verdict(chat: Chat, v: VerdictInput) {
    const o = this.owner(chat, 'verifier'); if (typeof o === 'string') return { ok: false, text: o };
    const { r, a } = o;
    if (!a.groupIds?.includes(v.group_id)) return { ok: false, text: `Group ${v.group_id} is not one of yours: ${(a.groupIds || []).join(', ')}.` };
    if (v.verdict !== 'REJECTED' && !v.severity) return { ok: false, text: 'Set severity (blocker, major or minor) for a CONFIRMED or PLAUSIBLE verdict.' };
    const g = r.groups.find(x => x.id === v.group_id)!;
    Object.assign(g, { verdict: v.verdict, verdictReason: v.reason.trim(), severity: v.verdict === 'REJECTED' ? undefined : v.severity, settle: v.settle?.trim() || undefined });
    for (const id of g.findingIds) { const f = r.findings.find(x => x.id === id); if (f) Object.assign(f, { verdict: g.verdict, verdictReason: g.verdictReason, severity: g.severity, settle: g.settle }); }
    this.note(r, `${a.label}: ${g.id} ${v.verdict}${g.severity ? ` (${g.severity})` : ''}: ${g.title}`);
    this.changed(r);
    return { ok: true, text: `Recorded ${v.verdict} for ${g.id}.` };
  }

  merge(chat: Chat, merges: MergeInput[]) {
    const o = this.owner(chat, 'dedupe'); if (typeof o === 'string') return { ok: false, text: o };
    this.mergeBuffer.set(o.a.id, merges);
    return { ok: true, text: `Recorded ${plural(merges.length, 'merge')}. End your turn now.` };
  }

  // ── events and persistence ──────────────────────────────────────────────────────────────
  private note(r: RunState, text: string) {
    const e = { at: Date.now(), text };
    r.log.push(e); if (r.log.length > 2000) r.log.splice(0, r.log.length - 2000);
    this.emit('run-event', r.id, { t: 'log', ...e } satisfies QaEvent);
    this.changed(r);
  }
  private setPhase(r: RunState, p: QaPhase) {
    if (r.phase === p) return;
    r.phase = p;
    if (p === 'done') { r.finishedAt ||= Date.now(); }
    this.note(r, `Phase: ${p}.`);
  }
  private finish(r: RunState, phase: 'failed' | 'done', error: string | null) {
    r.phase = phase; r.error = error; r.finishedAt = Date.now();
    this.note(r, phase === 'failed' ? `Failed: ${error}` : 'Done.');
  }
  private changed(r: RunState) {
    r.updatedAt = Date.now();
    this.emit('run-event', r.id, { t: 'run', run: this.summary(r) } satisfies QaEvent);
    this.emit('change');
    if (this.saveTimers.has(r.id)) return;
    this.saveTimers.set(r.id, setTimeout(() => { this.saveTimers.delete(r.id); this.save(r); }, 300));
  }
  private save(r: RunState) {
    if (!this.runs.has(r.id)) return;
    try { const d = path.join(this.dir, r.id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'run.json'), JSON.stringify(r, null, 1)); } catch {}
  }
  saveAll() { for (const r of this.runs.values()) this.save(r); }

  /** Loads every saved run. One that was mid-run comes back paused at its phase, since its chats did not survive the restart. */
  reopen(): number {
    let n = 0;
    for (const e of fs.existsSync(this.dir) ? fs.readdirSync(this.dir, { withFileTypes: true }) : []) {
      if (!e.isDirectory() || e.name === 'src') continue;
      const f = path.join(this.dir, e.name, 'run.json');
      if (!fs.existsSync(f)) continue;
      try {
        const r = JSON.parse(fs.readFileSync(f, 'utf8')) as RunState;
        if (!r?.id || !Array.isArray(r.agents)) continue;
        if (r.phase !== 'done' && r.phase !== 'failed') {
          for (const a of r.agents) if (a.status === 'running' || a.status === 'queued') Object.assign(a, { status: 'failed', error: 'Fleet restarted.', endedAt: Date.now() });
          r.paused = true; r.error = `Fleet restarted during ${r.phase}; press Resume to continue from there.`;
        }
        this.runs.set(r.id, r); n++;
      } catch {}
    }
    this.emit('change');
    return n;
  }
}
