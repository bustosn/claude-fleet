export function age(ts: number | string | null | undefined): string {
  if (!ts) return '';
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${s | 0}s`;
  if (s < 3600) return `${(s / 60) | 0}m`;
  if (s < 86400) return `${(s / 3600) | 0}h`;
  return `${(s / 86400) | 0}d`;
}

export function timeLeft(iso: string | null): { text: string; level: 'ok' | 'warn' | 'crit' } {
  if (!iso) return { text: 'unknown', level: 'crit' };
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return { text: 'expired', level: 'crit' };
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return { text: h ? `${h}h ${m}m` : `${m}m`, level: h < 1 ? 'crit' : h < 2 ? 'warn' : 'ok' };
}

export const shortPath = (p: string | null | undefined) => (p || '').replace(/\\/g, '/').replace(/^C:\/Users\/[^/]+\//i, '~/').replace(/^C:\/Users\/[^/]+$/i, '~');

/** 950 → "950", 12345 → "12.3k", 123456 → "123k", 1500000 → "1.50M". */
export const fmtTokens = (n: number) => n < 1000 ? String(Math.round(n)) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(2)}M`;

/** Ticket key from a branch or folder name: JL-1234, MERC-55, DEVSD-9. */
export function ticketKey(s: string | null | undefined): string | null {
  const m = (s || '').match(/\b([A-Z]{2,6}-\d{2,6})\b/i);
  return m ? m[1].toUpperCase() : null;
}

export const stateLabel: Record<string, string> = {
  busy: 'busy', idle: 'idle', working: 'working', blocked: 'needs you', done: 'done', failed: 'failed', stopped: 'stopped',
  stale: 'stale', running: 'working', 'needs-you': 'needs you', starting: 'starting', ended: 'ended',
};
