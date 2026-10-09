import { execFile } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

export interface ExecError extends Error { stdout?: string; stderr?: string }

export function run(cmd: string, args: string[], opts: Record<string, unknown> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: IS_WIN && cmd === 'claude', ...opts } as any,
      (err, stdout, stderr) => err ? reject(Object.assign(err, { stdout, stderr })) : resolve(String(stdout)));
  });
}

export function normPath(p: string | null | undefined): string {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function pathWithin(child: string, parent: string): boolean {
  const c = normPath(child), p = normPath(parent);
  return c === p || c.startsWith(p + '/');
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

export function errText(err: unknown): string {
  const e = err as ExecError;
  return String(e?.stderr || e?.stdout || e?.message || err).replace(/\r/g, '').trim();
}
