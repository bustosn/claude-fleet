import { useEffect, useRef, useState } from 'react';
import { GitCommitHorizontal, GitCompare } from 'lucide-react';
import { api, type IdeLogEntry } from '../lib/api';

const when = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' });

/** The commits that changed this file, newest first. Pick one to see what it changed; the first row compares your current text with HEAD. */
export function History({ root, path, onCommit, onWorking, onClose }: { root: string; path: string; onCommit: (e: IdeLogEntry) => void; onWorking: () => void; onClose: () => void }) {
  const [log, setLog] = useState<IdeLogEntry[] | null>(null);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus(); api.ideGitLog(root, path).then(setLog).catch(e => setError(String(e.message || e))); }, [root, path]);
  useEffect(() => { box.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' }); }, [cursor]);

  const rows = log ? log.length + 1 : 1;
  const pick = (i: number) => { if (i === 0) onWorking(); else if (log) onCommit(log[i - 1]); };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[10vh]" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} tabIndex={-1} className="panel w-[760px] max-w-[94vw] overflow-hidden shadow-[var(--shadow)] outline-none" role="dialog" aria-label="File history"
        onKeyDown={e => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(rows - 1, c + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(0, c - 1)); }
          if (e.key === 'Enter') { e.preventDefault(); pick(cursor); }
        }}>
        <div className="border-b border-line px-3 py-2"><div className="text-[12px] font-semibold">History</div><div className="mono truncate text-[11px] text-fg-faint">{path}</div></div>
        <div className="max-h-[60vh] overflow-y-auto p-1">
          <button className="row h-8" aria-current={cursor === 0 ? 'true' : undefined} onMouseEnter={() => setCursor(0)} onClick={() => pick(0)}>
            <GitCompare size={13} className="shrink-0 text-accent" aria-hidden="true" /><span className="grow">Working copy against HEAD</span>
          </button>
          {error && <div className="px-3 py-3 text-[12px] text-crit">{error}</div>}
          {!log && !error && <div className="px-3 py-3 text-[12px] text-fg-faint">Loading…</div>}
          {log && log.length === 0 && <div className="px-3 py-3 text-[12px] text-fg-faint">No commits touch this file yet.</div>}
          {log?.map((e, i) => (
            <button key={e.sha} className="row h-8" aria-current={cursor === i + 1 ? 'true' : undefined} onMouseEnter={() => setCursor(i + 1)} onClick={() => pick(i + 1)}>
              <GitCommitHorizontal size={13} className="shrink-0 text-fg-faint" aria-hidden="true" />
              <span className="mono shrink-0 text-[11px] text-fg-faint">{e.sha.slice(0, 7)}</span>
              <span className="grow truncate text-[12.5px]" title={e.subject}>{e.subject}</span>
              <span className="max-w-[30%] shrink-0 truncate text-[11px] text-fg-muted">{e.author}</span>
              <span className="shrink-0 text-[11px] text-fg-faint">{when(e.time)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
