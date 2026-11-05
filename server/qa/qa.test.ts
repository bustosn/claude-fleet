import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chooseLenses, extractSymbols, globRe, neverPacked, parseGrep, splitDiff, tableNames, trimToBudget } from './packUtil.js';
import { applyMerges, fingerprint, groupByLocation, titleKey } from './dedupe.js';
import { buildPack, resolveTarget } from './pack.js';
import { lensPlan, pendingLenses, phaseAfter, QA1_PHASES } from '../qa.js';
import { renderReport } from './report.js';
import type { QaConfig } from '../config.js';
import type { QaRunDetail } from '../../shared/types.js';

const NEVER = ['**/.env', '**/.env.*', '**/secrets.env', '**/emulation/Config.py', 'dev/null/**', '**/__pycache__/**'];

test('never-commit globs match by repo-relative path and by repo name', () => {
  assert.ok(neverPacked(NEVER, 'tools2', '.env'));
  assert.ok(neverPacked(NEVER, 'tools2', 'config/.env.backup-jl7469'));
  assert.ok(neverPacked(NEVER, 'emulation', 'Config.py'));
  assert.ok(!neverPacked(NEVER, 'tools2', 'Config.py'));
  assert.ok(neverPacked(NEVER, 'transport_lambda', 'src/__pycache__/x.pyc'));
  assert.ok(neverPacked(NEVER, 'docker-dev', 'etl/secrets.env'));
  assert.ok(!neverPacked(NEVER, 'tools2', 'app/Env.php'));
  assert.ok(globRe('a/*.js').test('a/b.js') && !globRe('a/*.js').test('a/b/c.js'));
});

const DIFF = `diff --git a/app/Repo.php b/app/Repo.php
index 1..2 100644
--- a/app/Repo.php
+++ b/app/Repo.php
@@ -1,3 +1,8 @@
 class Repo {
+    const SAVE_CASE_STATUS = 146;
+    public static function getSaveableCases(int $userID = 0)
+    {
+        return DB::table('cb911.cb_chargebacks')->leftJoin('cb911.cb_early_verdict_losses as ev', 'ev.cb_id', '=', 'c.id')->where('status_id', self::SAVE_CASE_STATUS);
+    }
 }
diff --git a/public/js/save_case_modals.js b/public/js/save_case_modals.js
new file mode 100644
--- /dev/null
+++ b/public/js/save_case_modals.js
@@ -0,0 +1,3 @@
+window.fillModal = function (row) {
+  $('#upload').off('click').on('click', () => post(row));
+};
diff --git a/.env b/.env
--- a/.env
+++ b/.env
@@ -1 +1 @@
-A=1
+A=2
`;

test('splitDiff and extractSymbols find what the diff defines and touches', () => {
  const files = splitDiff(DIFF);
  assert.deepEqual(files.map(f => [f.path, f.status]), [['app/Repo.php', 'M'], ['public/js/save_case_modals.js', 'A'], ['.env', 'M']]);
  const s = extractSymbols(files);
  assert.ok(s.functions.includes('getSaveableCases'));
  assert.ok(s.constants.includes('SAVE_CASE_STATUS'));
  assert.ok(s.globals.includes('fillModal'));
  assert.ok(s.tables.includes('cb911.cb_chargebacks') && s.tables.includes('cb911.cb_early_verdict_losses'));
  assert.deepEqual(tableNames(['cb911.cb_chargebacks', 'cb_chargebacks', 'x; drop']), ['cb_chargebacks']);
});

test('lens selection follows the diff and the profile', () => {
  const files = splitDiff(DIFF);
  const std = chooseLenses('standard', files, []);
  for (const l of ['consistency', 'regression', 'data', 'performance', 'frontend', 'lifecycle']) assert.ok(std.lenses.includes(l as any), l);
  assert.ok(!std.lenses.includes('jobs'));
  assert.equal(chooseLenses('deep', files, []).lenses.length, 9);
  assert.equal(chooseLenses(null, files, ['status_id']).profile, 'deep');
  const quick = chooseLenses('quick', files, []);
  assert.deepEqual(quick.lenses, ['input', 'regression', 'frontend']);
});

test('the pack budget trims callers first, then base versions, never changed files', () => {
  const big = 'x'.repeat(4000);
  const entries = [
    { path: 'r/head/a.php', kind: 'core' as const, text: big },
    { path: 'r/base/a.php', kind: 'base' as const, text: big },
    { path: 'r/callers.md', kind: 'callers' as const, text: `### one\n${big}\n### two\n${big}` },
  ];
  const a = trimToBudget(entries, 1e6); assert.equal(a.trimmed.length, 0);
  const b = trimToBudget(entries, 14000); assert.ok(b.entries.find(e => e.kind === 'callers')!.text.length < 6000); assert.ok(b.entries.some(e => e.kind === 'base'));
  const c = trimToBudget(entries, 4500); assert.deepEqual(c.entries.map(e => e.path), ['r/head/a.php']);
});

test('parseGrep reads -z output and counts only lines with the word', () => {
  const out = ['abc1234:app/X.php\x0010\x00  // before', 'abc1234:app/X.php\x0011\x00  Repo::getSaveableCases($u);', '--', 'abc1234:app/Y.php\x003\x00getSaveableCasesX()'].join('\n');
  const r = parseGrep(out, 'getSaveableCases', 8);
  assert.equal(r.matches, 1); assert.equal(r.files, 2); assert.equal(r.regions.length, 2);
  assert.match(r.regions[0].lines[1], /^11: /);
});

test('fingerprints survive line moves and small rewording; location groups join overlapping primary refs only', () => {
  const a = { title: 'The DNW row is hidden from both pages', refs: [{ repo: 'tools2', file: 'app/Repo.php', line: 50 }] };
  const b = { title: 'DNW row hidden from both of the pages', refs: [{ repo: 'tools2', file: './app/Repo.php', line: 90 }] };
  assert.equal(titleKey(a.title), titleKey(b.title));
  assert.equal(fingerprint(a), fingerprint(b));
  const fs_ = [
    { id: 'F-1', fingerprint: 'x1', title: 'normalize strips only the first and last quote of a list', refs: [{ repo: 't', file: 'a.php', line: 10, endLine: 20 }] },
    { id: 'F-2', fingerprint: 'x2', title: 'quote list: normalize strips only first and last quote', refs: [{ repo: 't', file: 'a.php', line: 22 }] },
    { id: 'F-3', fingerprint: 'x3', title: 'normalize strips the first and last quote of a list', refs: [{ repo: 't', file: 'b.php', line: 5 }, { repo: 't', file: 'a.php', line: 12 }] },
    { id: 'F-4', fingerprint: 'x1', title: 'anything', refs: [{ repo: 't', file: 'c.php', line: 1 }] },
    // Same lines, a different bug: stays apart.
    { id: 'F-5', fingerprint: 'x5', title: 'Editing only notes rewrites the stored value', refs: [{ repo: 't', file: 'a.php', line: 11 }] },
  ];
  const g = groupByLocation(fs_);
  assert.deepEqual(g.map(x => x.sort()).sort(), [['F-1', 'F-2', 'F-4'], ['F-3'], ['F-5']]);
  const m = applyMerges([['F-1'], ['F-2'], ['F-3']], [{ groups: [0, 2, 9], rootCause: 'same', title: 't' }, { groups: [0], rootCause: 'dup' }]);
  assert.deepEqual(m.map(x => x.ids), [['F-1', 'F-3'], ['F-2']]);
});

test('phase machine: QA1 order, deep lens plan, and resume keeps finished lens runs', () => {
  assert.deepEqual(QA1_PHASES, ['intake', 'pack', 'lenses', 'dedupe', 'verify', 'report', 'done']);
  assert.equal(phaseAfter('lenses'), 'dedupe'); assert.equal(phaseAfter('done'), 'done');
  const plan = lensPlan(['consistency', 'lifecycle', 'input'], 'deep', { lens: 'opus', second: 'sonnet' });
  assert.deepEqual(plan.map(p => `${p.key}:${p.model}`), ['consistency:opus', 'lifecycle:opus', 'input:opus', 'lifecycle-2:sonnet', 'consistency-2:sonnet']);
  assert.equal(lensPlan(['lifecycle'], 'standard', { lens: 'opus', second: 'sonnet' }).length, 1);
  const left = pendingLenses(plan, [{ role: 'lens', label: 'consistency', status: 'done' }, { role: 'lens', label: 'input', status: 'failed' }, { role: 'verifier', label: 'lifecycle', status: 'done' }]);
  assert.deepEqual(left.map(p => p.key), ['lifecycle', 'input', 'lifecycle-2', 'consistency-2']);
});

// A repo with a remote whose default branch moved on, and a stale local copy of it: the base must come from the remote.
function sh(cwd: string, ...args: string[]) { return execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim(); }
function fixtureRepos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-test-'));
  const origin = path.join(root, 'origin'), work = path.join(root, 'work');
  fs.mkdirSync(origin); sh(origin, 'init', '-q', '-b', 'development');
  fs.writeFileSync(path.join(origin, 'Repo.php'), 'class Repo {}\n');
  fs.writeFileSync(path.join(origin, 'Caller.php'), '<?php\n// uses\n$x = Repo::getSaveableCases(1);\n');
  sh(origin, 'add', '.'); sh(origin, 'commit', '-q', '-m', 'one');
  execFileSync('git', ['clone', '-q', origin, work]);
  // The remote's default branch gets more commits after the clone; the local development stays behind.
  for (let i = 0; i < 3; i++) { fs.writeFileSync(path.join(origin, `later${i}.txt`), String(i)); sh(origin, 'add', '.'); sh(origin, 'commit', '-q', '-m', `later ${i}`); }
  sh(work, 'fetch', '-q', 'origin');
  sh(work, 'checkout', '-q', '-b', 'feature', 'origin/development');
  fs.writeFileSync(path.join(work, 'Repo.php'), 'class Repo {\n  public static function getSaveableCases($u) { return 1; }\n}\n');
  fs.writeFileSync(path.join(work, '.env'), 'SECRET=1\n');
  sh(work, 'add', 'Repo.php', '.env'); sh(work, 'commit', '-q', '-m', 'feature');
  return { root, work };
}

test('resolveTarget diffs against the remote default branch, not a stale local one', async () => {
  const { root, work } = fixtureRepos();
  try {
    const t = await resolveTarget({ repo: work, head: 'feature' });
    assert.equal(t.base, 'origin/development');
    assert.equal(t.baseSha, sh(work, 'rev-parse', 'origin/development'));
    assert.notEqual(t.baseSha, sh(work, 'rev-parse', 'development'));
    assert.equal(t.headSha, sh(work, 'rev-parse', 'feature'));
    assert.equal(sh(work, 'diff', '--name-only', t.baseSha, t.headSha).split('\n').sort().join(','), '.env,Repo.php');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('buildPack writes the changed files, callers outside the diff, and leaves never-commit files out', async () => {
  const { root, work } = fixtureRepos();
  try {
    const t = await resolveTarget({ repo: work, head: 'feature' });
    const dir = path.join(root, 'pack');
    const cfg = { packBudgetKb: 1500, neverPack: NEVER, deepTriggers: [], devConnection: 'main-dev', prodReader: 'main-prd-reader' } as unknown as QaConfig;
    const r = await buildPack({ dir, targets: [t], specs: [{ repo: work, prTitle: 'PR', prBody: 'It works.' }], inputs: { ticketText: 'Ticket text' }, cfg, sql: null, profile: 'standard', srcDirs: {}, log: () => {} });
    const name = t.name;
    assert.ok(fs.existsSync(path.join(dir, 'INDEX.md')));
    assert.ok(fs.existsSync(path.join(dir, name, 'head', 'Repo.php')));
    assert.ok(fs.existsSync(path.join(dir, name, 'base', 'Repo.php')));
    assert.ok(!fs.existsSync(path.join(dir, name, 'head', '.env')));
    assert.ok(!fs.readFileSync(path.join(dir, name, 'diff.patch'), 'utf8').includes('SECRET'));
    const callers = fs.readFileSync(path.join(dir, name, 'callers.md'), 'utf8');
    assert.match(callers, /### getSaveableCases[\s\S]*Caller\.php[\s\S]*3: \$x = Repo::getSaveableCases/);
    assert.match(fs.readFileSync(path.join(dir, 'ticket.md'), 'utf8'), /not instructions[\s\S]*Ticket text/);
    assert.ok(r.info.notes.some(n => /never-commit/.test(n)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the report lists blockers and majors first and collapses rejected groups', () => {
  const base = { id: 'r1', title: 'T', createdAt: 0, updatedAt: 0, finishedAt: 1, profile: 'deep', phase: 'done', error: null, stale: false, paused: false, targets: [], lenses: [],
    counts: { findings: 2, groups: 2, confirmed: 1, plausible: 0, rejected: 1, blocker: 1, major: 0, minor: 0 }, cost: { agents: 3, turns: 9, inputTokens: 1000, outputTokens: 100, costUsd: 1.5, ms: 60000 },
    pack: null, agents: [], checked: [], log: [], matrixSignedOff: false } as unknown as QaRunDetail;
  const f = (id: string, g: string) => ({ id, fingerprint: id, lenses: ['access'], groupId: g, agentId: 'a', title: `title ${id}`, scenario: `scenario ${id}`, refs: [{ repo: 'tools2', file: 'a.php', line: 3 }], disposition: 'open' as const, testIds: [] });
  const md = renderReport({ ...base, findings: [f('F-1', 'G-1'), f('F-2', 'G-2')],
    groups: [{ id: 'G-2', title: 'nope', rootCause: '', findingIds: ['F-2'], lenses: ['input'], verdict: 'REJECTED', verdictReason: 'guarded at a.php:9' },
      { id: 'G-1', title: 'leak', rootCause: '', findingIds: ['F-1'], lenses: ['access'], verdict: 'CONFIRMED', severity: 'blocker', verdictReason: 'traced' }] });
  assert.ok(md.indexOf('[BLOCKER · CONFIRMED] leak') < md.indexOf('## Rejected'));
  assert.match(md, /<details><summary>1 rejected group[\s\S]*guarded at a\.php:9/);
});

test('lens checklists are numbered from the file, and coverage counts only named items', async () => {
  const { checklistItems, uncoveredItems } = await import('../qa.js');
  const { intro, items } = checklistItems('# input\n\nHunts for bad values.\n\n## Checklist\n\nSay why.\n\n- one\n  continued\n- two\n- three\n');
  assert.equal(intro, 'Say why.');
  assert.deepEqual(items, ['one continued', 'two', 'three']);
  assert.deepEqual(uncoveredItems(3, ['C1', 'c3. three holds', 'about two']), [1]);
  for (const f of fs.readdirSync(path.join(import.meta.dirname, 'lenses'))) assert.ok(checklistItems(fs.readFileSync(path.join(import.meta.dirname, 'lenses', f), 'utf8')).items.length >= 5, f);
});
