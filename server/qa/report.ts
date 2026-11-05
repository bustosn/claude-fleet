// The run's markdown report. QA1 has no spec or tests yet, so the gate and the matrix sections come with QA2 to QA4.
import type { QaFinding, QaGroup, QaRunDetail, QaSeverity } from '../../shared/types.js';

const SEV: Record<QaSeverity, number> = { blocker: 0, major: 1, minor: 2 };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ref = (f: QaFinding) => f.refs.map(r => `\`${r.repo}/${r.file}:${r.line}${r.endLine && r.endLine !== r.line ? `-${r.endLine}` : ''}\``).join(', ');

export function renderReport(run: QaRunDetail): string {
  const byId = new Map(run.findings.map(f => [f.id, f]));
  const members = (g: QaGroup) => g.findingIds.map(id => byId.get(id)).filter((f): f is QaFinding => !!f);
  const sorted = [...run.groups].sort((a, b) => (SEV[a.severity || 'minor'] - SEV[b.severity || 'minor']) || (a.verdict === 'CONFIRMED' ? -1 : 1));
  const live = sorted.filter(g => g.verdict === 'CONFIRMED' || g.verdict === 'PLAUSIBLE');
  const top = live.filter(g => g.severity === 'blocker' || g.severity === 'major');
  const minors = live.filter(g => g.severity === 'minor' || !g.severity);
  const rejected = sorted.filter(g => g.verdict === 'REJECTED');
  const unverified = sorted.filter(g => !g.verdict);

  const L: string[] = [];
  L.push(`# QA run ${run.id}: ${run.title}`, '');
  L.push(`Profile **${run.profile}** · phase **${run.phase}**${run.stale ? ' · **stale: a head moved during the run**' : ''} · ${new Date(run.createdAt).toISOString().slice(0, 16).replace('T', ' ')}`, '');
  for (const t of run.targets) L.push(`- ${t.name}: ${t.head} \`${t.headSha.slice(0, 9)}\` against ${t.base} \`${t.baseSha.slice(0, 9)}\`${t.pr ? ` · PR #${t.pr}` : ''}`);
  L.push('', run.matrixSignedOff ? '' : '_No signed-off state matrix (QA1): the lenses read the ticket and PR text directly._', '');
  if (run.error) L.push(`**Error:** ${run.error}`, '');

  L.push('## Summary', '');
  L.push(`${plural(run.findings.length, 'finding')} from ${plural(run.agents.filter(a => a.role === 'lens').length, 'lens run')}, in ${plural(run.groups.length, 'group')} after dedupe.`,
    `${run.counts.confirmed} confirmed, ${run.counts.plausible} plausible, ${run.counts.rejected} rejected${unverified.length ? `, ${unverified.length} not verified` : ''}.`,
    `Of the confirmed and plausible: ${run.counts.blocker} blocker, ${run.counts.major} major, ${run.counts.minor} minor.`, '');

  const card = (g: QaGroup, i: number) => {
    const ms = members(g), lead = ms[0];
    if (!lead) return;
    L.push(`### ${i}. [${(g.severity || '?').toUpperCase()} · ${g.verdict || 'UNVERIFIED'}] ${g.title}`, '');
    L.push(`Lenses: ${g.lenses.join(', ')} · ${plural(ms.length, 'finding')} · group ${g.id}`, '');
    if (g.rootCause) L.push(`**Root cause:** ${g.rootCause}`, '');
    L.push(`**Failure scenario:** ${lead.scenario}`, '');
    const refs = [...new Set(ms.map(ref).filter(Boolean))];
    if (refs.length) L.push(`**Code:** ${refs.join('; ')}`, '');
    if (lead.suggestedFix) L.push(`**Suggested fix:** ${lead.suggestedFix}`, '');
    if (g.verdictReason) L.push(`**Verifier:** ${g.verdictReason}`, '');
    if (g.settle) L.push(`**What would settle it:** ${g.settle}`, '');
    if (ms.length > 1) L.push('<details><summary>Other reports in this group</summary>', '', ...ms.slice(1).map(f => `- (${f.lenses.join(', ')}) **${f.title}**: ${f.scenario}`), '', '</details>', '');
  };
  L.push('## Blockers and majors', '');
  if (!top.length) L.push('None.', '');
  top.forEach((g, i) => card(g, i + 1));
  L.push('## Minors', '');
  if (!minors.length) L.push('None.', '');
  minors.forEach((g, i) => card(g, top.length + i + 1));
  if (unverified.length) { L.push('## Not verified', '', 'The verifier gave no verdict on these; treat them as open.', ''); unverified.forEach((g, i) => card(g, top.length + minors.length + i + 1)); }

  L.push('## Rejected', '');
  if (!rejected.length) L.push('None.', '');
  else {
    L.push('<details><summary>' + plural(rejected.length, 'rejected group') + ' (open to overrule)</summary>', '');
    for (const g of rejected) { const lead = members(g)[0]; L.push(`- **${g.title}** (${g.lenses.join(', ')}): ${lead?.scenario || ''}`, `  - Rejected because: ${g.verdictReason || '(no reason)'}`); }
    L.push('', '</details>', '');
  }

  L.push('## Coverage', '');
  for (const a of run.agents.filter(a => a.role === 'lens')) {
    const checked = run.checked.filter(c => c.agentId === a.id);
    const found = run.findings.filter(f => f.agentId === a.id).length;
    L.push(`- **${a.label}** (${a.model}): ${a.status}${a.error ? ` (${a.error})` : ''}, ${plural(found, 'finding')}, ${plural(checked.length, 'checked item')}`);
    for (const c of checked) L.push(`  - ${c.item}: ${c.reason}`);
  }
  if (run.pack) {
    L.push('', `Pack: ${Math.round(run.pack.bytes / 1024)} KB in ${run.pack.files} files.${run.pack.trimmed.length ? ` Trimmed: ${run.pack.trimmed.join('; ')}.` : ' Nothing trimmed.'}`);
    if (run.pack.notes.length) L.push('', 'Pack notes:', ...run.pack.notes.map(n => `- ${n}`));
  }
  L.push('');

  const c = run.cost;
  L.push('## Cost', '', `${plural(c.agents, 'agent')}, ${plural(c.turns, 'turn')}, ${Math.round(c.inputTokens / 1000)}k input and ${Math.round(c.outputTokens / 1000)}k output tokens, $${c.costUsd.toFixed(2)}, ${Math.round(c.ms / 60000)} min.`, '');
  return L.join('\n');
}
