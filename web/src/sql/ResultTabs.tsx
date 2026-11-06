import { Check, CircleSlash, ListChecks, Pin, PinOff, X } from 'lucide-react';
import type { SqlResult } from './run';

/** A result beside the live one: pinned (kept, never overwritten), or one statement of a script run. */
export interface Slot { key: string; label: string; kind: 'pin' | 'script' | 'summary' }
/** A script run: every statement in order, stopped at the first error. */
export interface ScriptRun { items: { text: string; key: string; status: 'waiting' | 'running' | 'done' | 'error' | 'skipped'; rows: number | null; affected: number | null; ms: number | null; error: string | null }[]; running: boolean }

const PIN_MAX = 8;
export const canPin = (slots: Slot[]) => slots.filter(s => s.kind === 'pin').length < PIN_MAX;

/** The strip above a result when an editor tab holds more than one: the live slot (where the next run lands), pinned results, a script's statements.
 *  Alt+[ and Alt+] move between them, Alt+P pins the live one. */
export function ResultTabs({ slots, view, liveKey, results, onView, onClose, onPin }: {
  slots: Slot[]; view: string; liveKey: string; results: Record<string, SqlResult>;
  onView: (key: string) => void; onClose: (key: string) => void; onPin: (key: string) => void;
}) {
  const live = results[liveKey];
  const dot = (r: SqlResult | undefined) => !r ? null : <span className="dot" data-s={r.status === 'running' ? 'running' : r.status === 'error' ? 'failed' : 'done'} aria-hidden="true" />;
  return (
    <div className="sql-rtabs" role="tablist" aria-label="Results">
      <div role="tab" tabIndex={0} aria-selected={view === liveKey} className={`sql-rtab ${view === liveKey ? 'is-active' : ''}`} onClick={() => onView(liveKey)} title="The next run lands here">
        {dot(live)} Result{live?.status === 'done' ? <span className="num text-fg-faint">{live.affected ?? live.rows.length}</span> : null}
        {live && live.status !== 'running' && <button className="sql-rtab-x" title="Pin: keep this result; the next run opens a new one (Alt+P)" aria-label="Pin result" onClick={e => { e.stopPropagation(); onPin(liveKey); }}><Pin size={11} /></button>}
      </div>
      {slots.map(s => {
        const r = results[s.key];
        return (
          <div key={s.key} role="tab" tabIndex={0} aria-selected={view === s.key} className={`sql-rtab ${view === s.key ? 'is-active' : ''} ${s.kind}`} onClick={() => onView(s.key)}
            title={s.kind === 'summary' ? 'What each statement of the script did' : r?.statement || s.label}>
            {s.kind === 'pin' ? <Pin size={11} className="text-accent" aria-hidden="true" /> : s.kind === 'summary' ? <ListChecks size={11} aria-hidden="true" /> : dot(r)}
            <span className="max-w-[160px] truncate">{s.label}</span>
            {r?.status === 'done' && <span className="num text-fg-faint">{r.affected ?? r.rows.length}</span>}
            {s.kind === 'script' && r && r.status !== 'running' && <button className="sql-rtab-x" title="Pin this result" aria-label="Pin" onClick={e => { e.stopPropagation(); onPin(s.key); }}><Pin size={11} /></button>}
            <button className="sql-rtab-x" title={s.kind === 'pin' ? 'Unpin and close' : 'Close'} aria-label="Close result" onClick={e => { e.stopPropagation(); onClose(s.key); }}>{s.kind === 'pin' ? <PinOff size={11} /> : <X size={11} />}</button>
          </div>
        );
      })}
    </div>
  );
}

/** The script's summary: one line per statement, what it did or why it stopped. Click a line for its result. */
export function ScriptSummary({ run, onView }: { run: ScriptRun; onView: (key: string) => void }) {
  const done = run.items.filter(i => i.status === 'done').length, failed = run.items.find(i => i.status === 'error');
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="sql-subbar text-[12px]">
        <span className={failed ? 'text-crit' : 'text-fg-muted'}>{run.running ? `Running ${done + 1} of ${run.items.length}…` : failed ? `Stopped at statement ${run.items.indexOf(failed) + 1} of ${run.items.length}` : `${done} of ${run.items.length} statements ran`}</span>
      </div>
      <div className="sql-record">
        {run.items.map((it, i) => (
          <button key={it.key} className="sql-script-row" onClick={() => it.status !== 'waiting' && it.status !== 'skipped' && onView(it.key)} disabled={it.status === 'waiting' || it.status === 'skipped'}>
            <span className="num w-6 flex-none text-right text-fg-faint">{i + 1}</span>
            <span className="w-5 flex-none">{it.status === 'done' ? <Check size={13} className="text-good" aria-label="ran" /> : it.status === 'error' ? <X size={13} className="text-crit" aria-label="failed" /> : it.status === 'skipped' ? <CircleSlash size={13} className="text-fg-faint" aria-label="not run" /> : it.status === 'running' ? <span className="dot" data-s="running" /> : null}</span>
            <span className="mono min-w-0 grow truncate">{it.text.replace(/\s+/g, ' ')}</span>
            <span className="num flex-none text-fg-muted">{it.error ? <span className="text-crit">{it.error.slice(0, 90)}</span> : it.affected != null ? `${it.affected.toLocaleString()} affected` : it.rows != null ? `${it.rows.toLocaleString()} rows` : ''}</span>
            <span className="num w-16 flex-none text-right text-fg-faint">{it.ms != null ? (it.ms < 1000 ? `${it.ms} ms` : `${(it.ms / 1000).toFixed(1)} s`) : ''}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
