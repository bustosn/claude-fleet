import { run } from '../util.js';
import type { SessionKind } from '../../shared/types.js';

export interface AgentRow {
  id: string; bgId: string | null; pid: number | null; kind: SessionKind; name: string; cwd: string;
  sessionId: string | null; startedAt: number | null; state: string;
}

// Documented listing source: `claude agents --json --all` (interactive + background, incl. completed).
export async function listAgents(): Promise<AgentRow[]> {
  const out = await run('claude', ['agents', '--json', '--all']);
  const start = out.indexOf('[');
  const arr: any[] = JSON.parse(start >= 0 ? out.slice(start) : '[]');
  return arr.map(a => ({
    id: a.id || (a.pid != null ? `pid-${a.pid}` : a.sessionId),
    bgId: a.id || null,
    pid: a.pid ?? null,
    kind: a.kind,
    name: a.name || '',
    cwd: a.cwd || '',
    sessionId: a.sessionId || null,
    startedAt: a.startedAt || null,
    // background: working|blocked|done|failed|stopped ; interactive: busy|idle
    state: a.kind === 'background' ? (a.state || 'unknown') : (a.status || 'unknown'),
  }));
}
