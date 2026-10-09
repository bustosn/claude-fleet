import fs from 'node:fs/promises';
import path from 'node:path';
import type { JobInfo } from '../../shared/types.js';

export interface JobRecord extends JobInfo { cwd: string; name: string; sessionId: string | null }

// Best-effort enrichment from ~/.claude/jobs/<id>/. Not a stable contract, so every read is guarded.
export async function readJobs(claudeHome: string, timelineLines: number): Promise<Record<string, JobRecord>> {
  const dir = path.join(claudeHome, 'jobs');
  let entries: import('node:fs').Dirent[] = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return {}; }
  const jobs: Record<string, JobRecord> = {};
  await Promise.all(entries.filter(e => e.isDirectory()).map(async e => {
    const base = path.join(dir, e.name);
    let state: any = null;
    try { state = JSON.parse(await fs.readFile(path.join(base, 'state.json'), 'utf8')); } catch { return; }
    let timeline: JobInfo['timeline'] = [];
    try {
      const raw = await fs.readFile(path.join(base, 'timeline.jsonl'), 'utf8');
      timeline = raw.trim().split('\n').slice(-timelineLines)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .map((t: any) => ({ at: t.at, state: t.state, detail: t.detail, text: String(t.text || '').slice(0, 2000) }));
    } catch {}
    // A job whose transcript was swept by cleanupPeriodDays can never be resumed or attached; its record just lingers.
    let transcriptMissing = false;
    if (state.linkScanPath) { try { await fs.stat(state.linkScanPath); } catch { transcriptMissing = true; } }
    jobs[e.name] = {
      bgId: e.name, transcriptMissing,
      state: state.state, detail: state.detail || '', tempo: state.tempo || '',
      needs: state.needs || '', result: state.output?.result || '',
      suggestedReply: state.suggestedReply || '', intent: state.intent || '',
      tokens: state.tokens ?? null, model: flag(state.respawnFlags, '--model'), permissionMode: flag(state.respawnFlags, '--permission-mode'),
      cwd: state.cwd || '', name: state.name || '', sessionId: state.sessionId || null,
      createdAt: state.createdAt || null, updatedAt: state.updatedAt || null, cliVersion: state.cliVersion || null,
      inFlight: state.inFlight || null, timeline,
    };
  }));
  return jobs;
}

function flag(flags: unknown, name: string): string | null {
  if (!Array.isArray(flags)) return null;
  const i = flags.indexOf(name);
  return i >= 0 ? String(flags[i + 1]) : null;
}
