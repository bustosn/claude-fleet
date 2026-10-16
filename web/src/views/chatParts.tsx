import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, CircleDashed, Loader2, Square, Undo2, X } from 'lucide-react';
import { api, type ContextUsage, type EditPreview, type TodoItem } from '../lib/api';
import { md } from '../lib/markdown';
import { fmtTokens } from '../lib/format';
import { actions } from '../lib/store';

/** Permission modes the header can switch between, in the order Shift+Tab cycles them. */
export const MODES: { value: string; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask first', hint: 'Asks before edits and commands' },
  { value: 'acceptEdits', label: 'Auto-edit', hint: 'Edits go through; commands still ask' },
  { value: 'plan', label: 'Plan', hint: 'Reads and plans only; nothing is changed until you approve the plan' },
];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// ---- diffs -----------------------------------------------------------------

const MAX_DIFF_LINES = 80;

/** Lines that changed, with the lines both sides share at the start and end dropped (kept as a little context). */
function diffLines(oldText: string, newText: string): { k: ' ' | '+' | '-'; text: string }[] {
  const a = oldText ? oldText.split('\n') : [], b = newText ? newText.split('\n') : [];
  let head = 0; while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0; while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ctx = 2;
  const out: { k: ' ' | '+' | '-'; text: string }[] = [];
  for (const l of a.slice(Math.max(0, head - ctx), head)) out.push({ k: ' ', text: l });
  for (const l of a.slice(head, a.length - tail)) out.push({ k: '-', text: l });
  for (const l of b.slice(head, b.length - tail)) out.push({ k: '+', text: l });
  for (const l of a.slice(a.length - tail, a.length - tail + ctx)) out.push({ k: ' ', text: l });
  return out;
}

/** The change an Edit, MultiEdit or Write makes: red lines out, green lines in. */
export function DiffView({ edit }: { edit: EditPreview }) {
  const [all, setAll] = useState(false);
  const rows = edit.hunks.flatMap((h, i) => [...(i ? [{ k: 'sep' as const, text: '' }] : []), ...diffLines(h.old, h.new)]);
  const adds = rows.filter(r => r.k === '+').length, dels = rows.filter(r => r.k === '-').length;
  const shown = all ? rows : rows.slice(0, MAX_DIFF_LINES);
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="mono min-w-0 truncate">{edit.path}</span>
        <span className="ml-auto flex shrink-0 gap-2 mono"><span className="text-good">{edit.write ? 'new file ' : ''}+{adds}</span>{dels > 0 && <span className="text-crit">−{dels}</span>}</span>
      </div>
      <pre className="diff-body">{shown.map((r, i) => r.k === 'sep'
        ? <div key={i} className="diff-sep">⋯</div>
        : <div key={i} className={`diff-line ${r.k === '+' ? 'add' : r.k === '-' ? 'del' : ''}`}><span className="diff-mark">{r.k === ' ' ? '' : r.k === '-' ? '−' : '+'}</span>{r.text || ' '}</div>)}</pre>
      {rows.length > MAX_DIFF_LINES && <button className="diff-more" onClick={() => setAll(a => !a)}>{all ? 'show less' : `… ${rows.length - MAX_DIFF_LINES} more lines`}</button>}
    </div>
  );
}

// ---- permission card ---------------------------------------------------------

export interface PermEntry { permId: string; toolName: string; input: string; suggestions: number; plan?: string; edit?: EditPreview; always?: boolean; resolved?: 'allow' | 'deny' }

/** A tool waiting on you. Edits show their diff, a plan shows the plan, anything else shows what it would run. */
export function PermissionCard({ e, chatId }: { e: PermEntry; chatId: string }) {
  const [busy, setBusy] = useState(false);
  const act = (body: { behavior: 'allow' | 'deny'; always?: boolean; mode?: string }) => {
    setBusy(true);
    api.permission(chatId, e.permId, body).catch(err => actions.toast(err.message, 'error')).finally(() => setBusy(false));
  };
  const plan = e.toolName === 'ExitPlanMode' && !!e.plan;
  const outcome = e.resolved === 'allow' ? (e.always ? 'allowed, and remembered for this session' : plan ? 'plan approved' : 'allowed') : e.resolved === 'deny' ? (plan ? 'kept planning' : 'denied') : '';
  return (
    <div className={`msg perm ${e.resolved ? 'resolved' : ''}`}>
      <div className="perm-title"><span className="perm-badge">{plan ? 'Plan ready' : 'Permission'}</span><b>{plan ? 'Review the plan before Claude changes anything' : e.toolName}</b></div>
      {plan ? <div className="plan-body assistant-md" dangerouslySetInnerHTML={{ __html: md(e.plan!) }} />
        : e.edit ? (e.resolved ? <div className="mono truncate text-fg-muted">{e.edit.path}</div> : <DiffView edit={e.edit} />)
        : <pre className="perm-input">{e.input}</pre>}
      {e.resolved ? <div className="perm-outcome">{outcome}</div> : plan ? (
        <div className="perm-actions">
          <button className="btn sm primary" disabled={busy} onClick={() => act({ behavior: 'allow', mode: 'acceptEdits' })}>Approve · auto-accept edits</button>
          <button className="btn sm" disabled={busy} onClick={() => act({ behavior: 'allow', mode: 'default' })}>Approve · ask for each edit</button>
          <button className="btn sm ghost" disabled={busy} onClick={() => act({ behavior: 'deny' })}>Keep planning</button>
        </div>
      ) : (
        <div className="perm-actions">
          <button className="btn sm primary" disabled={busy} onClick={() => act({ behavior: 'allow' })}>Allow</button>
          {e.suggestions > 0 && <button className="btn sm" disabled={busy} onClick={() => act({ behavior: 'allow', always: true })} title="Allow this, and similar calls, for the rest of the session">Always allow</button>}
          <button className="btn sm ghost" disabled={busy} onClick={() => act({ behavior: 'deny' })}>Deny</button>
        </div>
      )}
    </div>
  );
}

// ---- todos ---------------------------------------------------------------------

export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const [open, setOpen] = useState(true);
  const done = todos.filter(t => t.status === 'completed').length;
  const current = todos.find(t => t.status === 'in_progress');
  if (!todos.length) return null;
  return (
    <div className="todo-panel">
      <button className="todo-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <ChevronRight size={13} className={`transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
        <span className="font-semibold">Tasks</span>
        <span className="num text-fg-faint">{done}/{todos.length}</span>
        <span className="todo-bar" aria-hidden="true"><i style={{ width: `${(done / todos.length) * 100}%` }} /></span>
        {!open && current && <span className="min-w-0 truncate text-fg-muted">{current.activeForm}</span>}
      </button>
      {open && <ul className="todo-list">{todos.map((t, i) => (
        <li key={i} className={t.status}>
          {t.status === 'completed' ? <Check size={13} aria-hidden="true" /> : t.status === 'in_progress' ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <CircleDashed size={13} aria-hidden="true" />}
          <span>{t.status === 'in_progress' ? t.activeForm : t.content}</span>
        </li>))}</ul>}
    </div>
  );
}

// ---- subagents and background tasks ------------------------------------------------

export interface TaskEntry { taskId: string; status: 'running' | 'completed' | 'failed' | 'stopped'; description: string; kind: string; tools: number; tokens: number; lastTool?: string; summary?: string }

export function TaskRow({ t, chatId }: { t: TaskEntry; chatId: string }) {
  const running = t.status === 'running';
  return (
    <div className={`msg task ${t.status}`}>
      <span className="task-icon" aria-hidden="true">{running ? <Loader2 size={13} className="animate-spin" /> : t.status === 'completed' ? <Check size={13} /> : <X size={13} />}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="chip">{t.kind.replace(/^local_/, '')}</span>
          <span className="min-w-0 truncate font-medium text-fg">{t.description || 'working'}</span>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-fg-faint">
          {t.summary || (running ? (t.lastTool ? `using ${t.lastTool}` : 'starting') : t.status)}
          {t.tools > 0 && <> · {t.tools} tool call{t.tools > 1 ? 's' : ''}</>}{t.tokens > 0 && <> · {fmtTokens(t.tokens)} tokens</>}
        </div>
      </div>
      {running && <button className="btn sm ghost" title="Stop this task" onClick={() => api.stopTask(chatId, t.taskId).catch(err => actions.toast(err.message, 'error'))}><Square size={11} aria-hidden="true" /> Stop</button>}
    </div>
  );
}

// ---- context breakdown ------------------------------------------------------------------

/** Click target on the token strip: the window by category, like /context. */
export function ContextPopover({ chatId, children, disabled }: { chatId: string; children: React.ReactNode; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [u, setU] = useState<ContextUsage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const toggle = () => {
    const next = !open; setOpen(next);
    if (next) { setErr(null); api.context(chatId).then(setU).catch(e => setErr(e.message)); }
  };
  const used = u?.categories.filter(c => c.kind === 'used' && c.tokens > 0) || [];
  const free = u?.categories.find(c => c.kind === 'free');
  const max = u?.max || 1;
  return (
    <span ref={box} className="relative inline-flex">
      <button className="ctx-trigger" disabled={disabled} onClick={toggle} aria-expanded={open} title="Context window breakdown">{children}</button>
      {open && (
        <div role="dialog" aria-label="Context window" className="panel ctx-pop">
          {err ? <div className="text-crit">{err}</div> : !u ? <div className="text-fg-muted">Loading…</div> : <>
            <div className="flex items-baseline justify-between"><b>Context window</b><span className="num text-fg-muted">{fmtTokens(u.total)} of {fmtTokens(u.max)} · {Math.round(u.percentage)}%</span></div>
            <div className="ctx-bar" role="img" aria-label={`${Math.round(u.percentage)}% used`}>
              {used.map(c => <i key={c.name} style={{ width: `${(c.tokens / max) * 100}%`, background: c.color || 'var(--accent)' }} title={`${c.name}: ${fmtTokens(c.tokens)}`} />)}
            </div>
            <div className="mt-2 grid gap-1">
              {used.sort((a, b) => b.tokens - a.tokens).map(c => (
                <div key={c.name} className="flex items-center gap-2"><i className="ctx-swatch" style={{ background: c.color || 'var(--accent)' }} /><span className="min-w-0 flex-1 truncate">{c.name}</span><span className="num text-fg-muted">{fmtTokens(c.tokens)}</span></div>))}
              {free && <div className="flex items-center gap-2 text-fg-faint"><i className="ctx-swatch free" /><span className="flex-1">Free space</span><span className="num">{fmtTokens(free.tokens)}</span></div>}
            </div>
            {u.memoryFiles.length > 0 && <div className="mt-2 border-t border-line pt-2 text-[11px] text-fg-faint">
              {u.memoryFiles.map(m => <div key={m.path} className="flex gap-2"><span className="min-w-0 flex-1 truncate mono" title={m.path}>{m.path.split(/[\\/]/).slice(-2).join('/')}</span><span className="num">{fmtTokens(m.tokens)}</span></div>)}
            </div>}
          </>}
        </div>
      )}
    </span>
  );
}

// ---- restore files -------------------------------------------------------------------------

/** "Restore files" on a message of this run: previews what would change, then puts the files back. The conversation itself stays. */
export function RewindButton({ chatId, uuid, disabled }: { chatId: string; uuid: string; disabled: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<{ canRewind: boolean; error?: string; files: string[]; insertions: number; deletions: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const start = () => {
    setPreview(null); ref.current?.showModal();
    api.rewind(chatId, uuid, true).then(setPreview).catch(e => setPreview({ canRewind: false, error: e.message, files: [], insertions: 0, deletions: 0 }));
  };
  const go = async () => {
    setBusy(true);
    try { const r = await api.rewind(chatId, uuid, false); const n = preview?.files.length ?? 0; actions.toast(r.canRewind ? `Restored ${n} file${n === 1 ? '' : 's'}` : r.error || 'Nothing was restored', r.canRewind ? 'info' : 'error'); ref.current?.close(); }
    catch (e: any) { actions.toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <>
      <button className="rewind-btn" disabled={disabled} onClick={start} title="Restore files to how they were before this message"><Undo2 size={12} aria-hidden="true" /> Restore files</button>
      <dialog ref={ref} onClick={e => { if (e.target === ref.current) ref.current.close(); }}>
        <h2>Restore files to before this message?</h2>
        {!preview ? <div className="text-fg-muted">Checking what would change…</div>
          : !preview.canRewind ? <div className="text-crit">{preview.error || 'Nothing to restore.'}</div>
          : <>
            <div className="mb-2 text-fg-muted">{preview.files.length} file{preview.files.length === 1 ? '' : 's'} would change <span className="text-good">+{preview.insertions}</span> <span className="text-crit">−{preview.deletions}</span>. The conversation is kept; only files on disk go back.</div>
            <ul className="max-h-48 overflow-auto rounded border border-line bg-raised p-2 mono">{preview.files.map(f => <li key={f} className="truncate" title={f}>{f}</li>)}</ul>
          </>}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn" onClick={() => ref.current?.close()}>Cancel</button>
          <button className="btn primary" disabled={!preview?.canRewind || busy} onClick={go}>Restore</button>
        </div>
      </dialog>
    </>
  );
}

// ---- @file menu ----------------------------------------------------------------------------------

/** Files matching what follows an `@` in the composer. */
export function FileMenu({ matches, index, onPick, onHover }: { matches: string[]; index: number; onPick: (p: string) => void; onHover: (i: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [index]);
  return (
    <div ref={list} role="listbox" aria-label="Files" className="panel menu-pop">
      {matches.map((p, i) => {
        const slash = p.lastIndexOf('/');
        return (
          <div key={p} role="option" aria-selected={i === index} className={`menu-opt ${i === index ? 'on' : ''}`} onMouseEnter={() => onHover(i)} onMouseDown={e => { e.preventDefault(); onPick(p); }}>
            <span className="mono min-w-0 truncate"><b>{p.slice(slash + 1)}</b><span className="text-fg-faint"> {slash >= 0 ? p.slice(0, slash) : ''}</span></span>
          </div>
        );
      })}
    </div>
  );
}
