import { useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowRight, Pencil, Send, Square, Terminal as TerminalIcon, X } from 'lucide-react';
import { api, subscribe, type ChatEvent, type ChatSummary, type ChatStatus, type MessageOrigin, type ModelOption, type SlashCommandView } from '../lib/api';
import { rankCommands } from '../lib/commands';
import { md, esc } from '../lib/markdown';
import { fmtTokens, shortPath } from '../lib/format';
import { actions, useStore } from '../lib/store';
import { Status, WorktreePicker } from '../components/ui';
import type { TokenUsage } from '../../../shared/types';

type Entry =
  | { k: 'user'; id: number; text: string; origin: MessageOrigin }
  | { k: 'assistant'; id: number; text: string; streaming: boolean }
  | { k: 'tool'; id: number; toolId: string; name: string; input: string; description?: string; result?: { text: string; length: number; isError: boolean } }
  | { k: 'sys'; id: number; text: string; err?: boolean }
  | { k: 'perm'; id: number; permId: string; toolName: string; input: string; resolved?: 'allow' | 'deny' }
  | { k: 'shell'; id: number; runId: string; cmd: string; cwd: string; terminalId: string; output: string; truncated: boolean; exitCode: number | null; done: boolean; interrupted: boolean };

// Distributive Omit: a plain Omit over the union would collapse it to the shared keys.
type EntryInput = Entry extends infer E ? (E extends Entry ? Omit<E, 'id'> : never) : never;
/** What the model is doing right now, shown under the log while a turn runs. */
type Activity = { kind: 'thinking' | 'tool'; name?: string; since: number } | null;
/** Token readout. `estOut` is a chars/4 guess for text that has streamed since the last exact count, so the number keeps moving mid-reply. */
type Tokens = { turn: TokenUsage; context: number; estOut: number; total: TokenUsage | null; contextWindow: number | null; cost: number | null };
const noUsage: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const noTokens: Tokens = { turn: noUsage, context: 0, estOut: 0, total: null, contextWindow: null, cost: null };
interface ChatState { entries: Entry[]; status: ChatStatus; summary: ChatSummary | null; seq: number; activity: Activity; tokens: Tokens | null }
type Action = { type: 'event'; ev: ChatEvent } | { type: 'summary'; summary: ChatSummary } | { type: 'history'; evs: ChatEvent[] } | { type: 'sys'; text: string; err?: boolean };

function apply(state: ChatState, ev: ChatEvent, history: boolean): ChatState {
  let { entries, seq, status, activity, tokens, summary } = state;
  const now = Date.now();
  const thinking = (keepSince = false) => { activity = { kind: 'thinking', since: keepSince && activity ? activity.since : now }; };
  const push = (e: EntryInput) => { entries = [...entries, { ...e, id: ++seq } as Entry]; };
  const last = entries[entries.length - 1];
  switch (ev.t) {
    case 'status': status = ev.status; if (status === 'running') { if (!activity) thinking(); } else activity = null; break;
    case 'user': if (last?.k === 'assistant' && last.streaming) entries = entries.map(e => e === last ? { ...e, streaming: false } : e); push({ k: 'user', text: ev.text, origin: ev.origin }); thinking(); break;
    case 'thinking': thinking(); break;
    case 'delta':
      if (last?.k === 'assistant' && last.streaming) entries = entries.map(e => e === last ? { ...e, text: e.text + ev.text } : e);
      else push({ k: 'assistant', text: ev.text, streaming: true });
      activity = null; // words are arriving; the text itself is the signal
      if (tokens) tokens = { ...tokens, estOut: tokens.estOut + ev.text.length / 4 };
      break;
    case 'usage': tokens = { ...(tokens || noTokens), turn: ev.turn, context: ev.context, estOut: 0 }; break;
    case 'tool_start': if (last?.k === 'assistant' && last.streaming) entries = entries.map(e => e === last ? { ...e, streaming: false } : e); activity = { kind: 'tool', name: ev.name, since: now }; break;
    case 'assistant': {
      // The complete message replaces the entry the deltas were streaming into instead of adding a second copy.
      let streaming = last?.k === 'assistant' && last.streaming ? last : null;
      for (const b of ev.blocks) {
        if (b.type === 'text' && (b as any).text.trim()) {
          if (streaming) { const s = streaming; entries = entries.map(e => e === s ? { ...e, text: (b as any).text, streaming: false } : e); streaming = null; }
          else push({ k: 'assistant', text: (b as any).text, streaming: false });
        } else if (b.type === 'tool_use') push({ k: 'tool', toolId: (b as any).id, name: (b as any).name, input: (b as any).input, description: (b as any).description });
      }
      if (streaming) { const s = streaming; entries = entries.map(e => e === s ? { ...e, streaming: false } : e); }
      break;
    }
    case 'tool_result': {
      const i = entries.findIndex(e => e.k === 'tool' && e.toolId === ev.toolUseId);
      if (i >= 0) entries = entries.map((e, idx) => idx === i ? { ...(e as any), result: { text: ev.text, length: ev.length, isError: ev.isError } } : e);
      else push({ k: 'sys', text: `${ev.isError ? 'error' : 'result'}: ${ev.text.slice(0, 200)}`, err: ev.isError });
      thinking(); // tool came back, the model is reading it
      break;
    }
    case 'permission': push({ k: 'perm', permId: ev.id, toolName: ev.toolName, input: ev.input }); status = 'needs-you'; activity = null; break;
    case 'permission_resolved': entries = entries.map(e => e.k === 'perm' && e.permId === ev.id ? { ...e, resolved: ev.behavior } : e); thinking(); break;
    case 'result': {
      activity = null;
      const t = tokens || noTokens;
      tokens = { turn: ev.usage || t.turn, context: ev.context || t.context, estOut: 0, total: ev.total ?? t.total, contextWindow: ev.contextWindow ?? t.contextWindow, cost: ev.cost ?? t.cost };
      const u = ev.usage;
      push({ k: 'sys', text: `turn done, ${ev.subtype}${u ? `, ${fmtTokens(u.input + u.cacheRead + u.cacheWrite)} in, ${fmtTokens(u.output)} out` : ''}${ev.cost != null ? `, $${ev.cost.toFixed(3)}` : ''}${ev.duration ? `, ${(ev.duration / 1000).toFixed(1)}s` : ''}${ev.errors ? `, ${ev.errors.join('; ')}` : ''}` });
      break;
    }
    case 'error': push({ k: 'sys', text: ev.message, err: true }); activity = null; break;
    case 'shell': push({ k: 'shell', runId: ev.id, cmd: ev.cmd, cwd: ev.cwd, terminalId: ev.terminalId, output: '', truncated: false, exitCode: null, done: false, interrupted: false }); break;
    case 'shell_out': entries = entries.map(e => e.k === 'shell' && e.runId === ev.id ? { ...e, output: ev.output, truncated: ev.truncated } : e); break;
    case 'shell_done':
      if (entries.some(e => e.k === 'shell' && e.runId === ev.id)) entries = entries.map(e => e.k === 'shell' && e.runId === ev.id ? { ...e, output: ev.output, truncated: ev.truncated, exitCode: ev.exitCode, done: true, interrupted: ev.interrupted } : e);
      else push({ k: 'shell', runId: ev.id, cmd: '(earlier command)', cwd: '', terminalId: '', output: ev.output, truncated: ev.truncated, exitCode: ev.exitCode, done: true, interrupted: ev.interrupted });
      break;
    // The process reports the model it actually runs; the summary may still hold the alias it was opened with.
    case 'init': if (summary && ev.model) summary = { ...summary, model: ev.model }; break;
    case 'model': push({ k: 'sys', text: `model set to ${ev.model}` }); if (summary) summary = { ...summary, model: ev.model }; break;
  }
  if (history) return { ...state, entries, seq };
  return { ...state, entries, seq, status, activity, tokens, summary };
}

function reducer(state: ChatState, a: Action): ChatState {
  switch (a.type) {
    case 'event': return apply(state, a.ev, false);
    case 'history': { let s = state; for (const ev of a.evs) s = apply(s, ev, true); return { ...s, entries: [...s.entries, { k: 'sys', id: ++s.seq, text: 'end of saved history' }] }; }
    case 'summary': {
      // Session totals survive reopening the tab; the live turn figures only exist while the tab is subscribed.
      const st = a.summary.tokens;
      const tokens = st ? { ...(state.tokens || noTokens), total: st.total, contextWindow: st.contextWindow, context: state.tokens?.context || st.context } : state.tokens;
      return { ...state, summary: a.summary, status: a.summary.status, tokens, activity: a.summary.status === 'running' ? state.activity || { kind: 'thinking', since: Date.now() } : null };
    }
    case 'sys': return { ...state, entries: [...state.entries, { k: 'sys', id: state.seq + 1, text: a.text, err: a.err }], seq: state.seq + 1 };
  }
}

export function ChatView({ chatId }: { chatId: string }) {
  const [state, dispatch] = useReducer(reducer, { entries: [], status: 'starting', summary: null, seq: 0, activity: null, tokens: null });
  const snap = useStore(s => s.snapshot);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [text, setText] = useState('');
  const [forward, setForward] = useState(false);
  const [commands, setCommands] = useState<SlashCommandView[]>([]);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const [histIdx, setHistIdx] = useState(-1);
  const composer = useRef<HTMLTextAreaElement>(null);

  // `!` runs in the chat's own shell. Up/Down walk earlier commands while the composer is empty or holds a one-line `!`.
  const bang = text.startsWith('!');
  const shellRunning = [...state.entries].reverse().find((e): e is Extract<Entry, { k: 'shell' }> => e.k === 'shell' && !e.done);
  const bangHistory = [...new Set(state.entries.filter((e): e is Extract<Entry, { k: 'shell' }> => e.k === 'shell').map(e => e.cmd).reverse())];

  // The command list exists once the Claude process has started; refetch after init in case it was empty before.
  const initDone = state.entries.length > 0 || state.status !== 'starting';
  useEffect(() => { if (initDone) api.commands(chatId).then(setCommands).catch(() => {}); }, [chatId, initDone]);

  const slashQuery = /^\/(\S*)$/.exec(text)?.[1];
  // Typing "/" into a chat whose list never arrived asks again, so one failed fetch at init is not permanent.
  useEffect(() => { if (slashQuery != null && commands.length === 0) api.commands(chatId).then(setCommands).catch(() => {}); }, [chatId, slashQuery != null, commands.length]);
  const matches = slashQuery == null || cmdDismissed ? [] : rankCommands(commands, slashQuery);
  const menuOpen = matches.length > 0;
  const pickCommand = (c: SlashCommandView) => { setText(`/${c.name} `); setCmdDismissed(true); composer.current?.focus(); };
  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex(i => (i + 1) % matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex(i => (i - 1 + matches.length) % matches.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pickCommand(matches[Math.min(cmdIndex, matches.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setCmdDismissed(true); return; }
    }
    if (e.key === 'Escape' && shellRunning) { e.preventDefault(); api.shellInterrupt(chatId).catch(() => {}); return; }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && bangHistory.length && (text === '' || (bang && !text.includes('\n')))) {
      const next = e.key === 'ArrowUp' ? Math.min(histIdx + 1, bangHistory.length - 1) : Math.max(histIdx - 1, -1);
      e.preventDefault(); setHistIdx(next); setText(next < 0 ? '' : '!' + bangHistory[next]);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  useEffect(() => {
    let off: (() => void) | undefined; let cancelled = false;
    (async () => {
      try {
        const summary = await api.chat(chatId);
        if (cancelled) return;
        dispatch({ type: 'summary', summary });
        if (summary.resumeId) {
          try { dispatch({ type: 'history', evs: await api.history(summary.resumeId) }); }
          catch (e: any) { dispatch({ type: 'sys', text: `history unavailable: ${e.message}`, err: true }); }
        }
        if (cancelled) return;
        off = subscribe<ChatEvent | ChatSummary>(`/api/chats/${chatId}/events`, (data, event) => {
          if (event === 'chat') dispatch({ type: 'summary', summary: data as ChatSummary });
          else dispatch({ type: 'event', ev: data as ChatEvent });
        });
      } catch (e: any) { dispatch({ type: 'sys', text: `Could not open chat: ${e.message}`, err: true }); }
    })();
    return () => { cancelled = true; off?.(); };
  }, [chatId]);

  useEffect(() => { if (stick.current && log.current) log.current.scrollTop = log.current.scrollHeight; }, [state.entries, state.activity]);

  const title = snap?.conversations.find(c => c.sessionId === state.summary?.sessionId)?.title || state.summary?.title || 'Chat';
  const s = state.summary;

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim(); if (!t) return;
    setText(''); setHistIdx(-1);
    if (t.startsWith('!')) {
      const cmd = t.slice(1).trim(); if (!cmd) return;
      api.shell(chatId, cmd).catch(err => dispatch({ type: 'sys', text: err.message, err: true }));
      return;
    }
    api.send(chatId, t).catch(err => dispatch({ type: 'sys', text: err.message, err: true }));
  };
  const rename = async () => {
    if (!s?.sessionId) { dispatch({ type: 'sys', text: 'Send a first message before renaming; the session id does not exist yet.', err: true }); return; }
    const next = window.prompt('Rename conversation', title);
    if (!next?.trim()) return;
    try { await api.rename(s.sessionId, next.trim()); actions.toast('Renamed'); } catch (err: any) { actions.toast(err.message, 'error'); }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-11 items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-5">{title}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-fg-faint mono">
            {s && s.sessionId && s.locatedBy !== 'cwd' ? <WorktreePicker sessionId={s.sessionId} worktree={s.worktree} locatedBy={s.locatedBy} /> : <span className="truncate">{s ? (s.repo ? `${s.repo} / ${s.branch || ''}` : shortPath(s.cwd)) : ''}</span>}
            {s && <><span aria-hidden="true">·</span><ModelPicker chatId={chatId} model={s.model} ready={initDone && state.status !== 'ended'} onError={msg => dispatch({ type: 'sys', text: msg, err: true })} /><span aria-hidden="true">·</span><span className="shrink-0">{s.permissionMode}</span></>}
            {s?.forked && <><span aria-hidden="true">·</span><span className="shrink-0">forked copy</span></>}
          </div>
        </div>
        <Status state={state.status} />
        <button className="btn sm ghost" onClick={rename} title="Rename"><Pencil size={13} aria-hidden="true" /> Rename</button>
        <button className="btn sm ghost" onClick={() => setForward(true)} title="Send text to another live chat"><ArrowRight size={13} aria-hidden="true" /> Send to chat</button>
        <button className="btn sm ghost" disabled={state.status !== 'running'} onClick={() => api.interrupt(chatId)} title="Interrupt the current turn"><Square size={12} aria-hidden="true" /> Stop</button>
        <button className="btn sm ghost" onClick={() => api.endChat(chatId).then(() => actions.toast('Chat ended'))} title="End this chat process"><X size={13} aria-hidden="true" /> End</button>
      </header>
      {s?.forked && <div className="border-b border-warn/40 bg-warn-soft px-4 py-1.5 text-[11px] text-fg-muted">The original session is open in a terminal, so this chat continues a forked copy with its own session id.</div>}
      {s?.dialogueId && <div className="flex items-center gap-2 border-b border-line bg-accent-soft px-4 py-1.5 text-[11px] text-fg-muted">This chat is a participant in a dialogue; Fleet is delivering its turns. Anything you type here goes to it as well.
        <button className="btn sm ghost ml-auto" onClick={() => actions.go({ kind: 'dialogue', id: s.dialogueId! })}>Open the dialogue</button></div>}

      <div ref={log} className="grid min-h-0 flex-1 auto-rows-max content-start gap-2 overflow-y-auto px-4 py-3" onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {state.entries.length === 0 && <div className="msg sys">Say what you need. Replies stream in here, and tool calls show as they run.</div>}
        {groupTools(state.entries).map(e => e.k === 'group' ? <ToolGroup key={e.id} tools={e.tools} chatId={chatId} /> : <EntryView key={e.id} e={e} chatId={chatId} />)}
        {state.activity && <ActivityRow activity={state.activity} />}
      </div>

      <TokenStrip t={state.tokens} running={state.status === 'running'} />
      <form className="relative flex gap-2 border-t border-line bg-surface px-4 py-3" onSubmit={send}>
        {menuOpen && <CommandMenu matches={matches} index={Math.min(cmdIndex, matches.length - 1)} onPick={pickCommand} onHover={setCmdIndex} />}
        {bang && !menuOpen && <div className="absolute bottom-full left-4 right-4 mb-1 rounded border border-line bg-surface px-3 py-1.5 text-[11px] text-fg-faint">
          Runs in this chat's shell{s ? ` (${shortPath(s.cwd)})` : ''}. Enter runs, Esc interrupts, Up recalls. The output is yours until you send it to Claude.</div>}
        <textarea ref={composer} className={`input flex-1 ${bang ? 'mono' : ''}`} rows={3} value={text} placeholder="Message Claude. Enter sends, Shift+Enter for a new line, / for commands, ! for your shell." onChange={e => { setText(e.target.value); setCmdIndex(0); setCmdDismissed(false); setHistIdx(-1); }}
          onKeyDown={onComposerKey} disabled={state.status === 'ended'} />
        <button className="btn primary self-end" type="submit" disabled={state.status === 'ended' || !text.trim()}><Send size={13} aria-hidden="true" /> Send</button>
      </form>

      {forward && <ForwardDialog chatId={chatId} lastReply={[...state.entries].reverse().find(e => e.k === 'assistant')?.text || ''} onClose={() => setForward(false)} />}
    </div>
  );
}

/** The chat's current model, and a dropdown to switch it. The list comes from the chat's own process, so it matches the account.
 *  The current model may be an alias ("opus") or the full id the process reported, so options match on either. */
function ModelPicker({ chatId, model, ready, onError }: { chatId: string; model: string; ready: boolean; onError: (msg: string) => void }) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (ready && !models.length) api.models(chatId).then(setModels).catch(() => {}); }, [chatId, ready, models.length]);
  if (!models.length) return <span className="shrink-0">{model}</span>;
  // "default" resolves to the same id as a named alias; show the name.
  const current = (models.find(m => m.value === model) || models.find(m => m.resolvedModel === model && m.value !== 'default') || models.find(m => m.resolvedModel === model))?.value ?? model;
  const options = models.some(m => m.value === current) ? models : [{ value: model, displayName: model, description: '', resolvedModel: null }, ...models];
  const change = async (next: string) => {
    if (next === current) return;
    setBusy(true);
    try { await api.setModel(chatId, next); } catch (err: any) { onError(`Could not switch model: ${err.message}`); } finally { setBusy(false); }
  };
  return (
    <select className="inline-select shrink-0" value={current} disabled={busy || !ready} onChange={e => change(e.target.value)} aria-label="Model for this chat"
      title={`${options.find(m => m.value === current)?.description || model}. Takes effect from the next turn.`}>
      {options.map(m => <option key={m.value} value={m.value} title={m.description}>{m.displayName}</option>)}
    </select>
  );
}

/** Slash command picker above the composer, like Claude Code's. Arrow keys move, Tab or Enter fills the command in, Esc hides it. */
function CommandMenu({ matches, index, onPick, onHover }: { matches: SlashCommandView[]; index: number; onPick: (c: SlashCommandView) => void; onHover: (i: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [index]);
  return (
    <div ref={list} role="listbox" aria-label="Commands" className="panel absolute bottom-full left-4 right-4 mb-1 max-h-[300px] overflow-y-auto py-1 shadow-[var(--shadow)]">
      {matches.map((c, i) => (
        <div key={c.name} role="option" aria-selected={i === index} className={`grid cursor-pointer grid-cols-[minmax(120px,auto)_1fr_auto] items-baseline gap-3 px-3 py-1 text-[12px] ${i === index ? 'bg-selected' : 'hover:bg-hover'}`}
          onMouseEnter={() => onHover(i)} onMouseDown={e => { e.preventDefault(); onPick(c); }}>
          <span className="mono whitespace-nowrap">/{c.name}{c.argumentHint ? <span className="text-fg-faint"> {c.argumentHint}</span> : null}</span>
          <span className="truncate text-fg-muted">{c.description}</span>
          <span className="text-[10px] text-fg-faint">{c.builtin ? 'built-in' : c.aliases.length ? `/${c.aliases[0]}` : ''}</span>
        </div>
      ))}
    </div>
  );
}

/** Context fill, this turn, and session totals. "in" counts every prompt token the model read, cached or not, so a turn with many tool
 *  steps reads far more than its context size. The output count is a chars/4 guess (marked ~) until the step reports the exact number. */
function TokenStrip({ t, running }: { t: Tokens | null; running: boolean }) {
  if (!t) return null;
  const read = (u: TokenUsage) => u.input + u.cacheRead + u.cacheWrite;
  const out = t.turn.output + (running ? Math.round(t.estOut) : 0);
  const pct = t.contextWindow ? Math.round((t.context / t.contextWindow) * 100) : null;
  const level = pct == null ? '' : pct >= 90 ? 'text-crit' : pct >= 70 ? 'text-warn' : '';
  const n = (v: number, cls = '') => <b className={`num text-fg-muted ${cls}`}>{fmtTokens(v)}</b>;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 border-t border-line bg-surface px-4 py-1 text-[11px] text-fg-faint mono" role="status" aria-live={running ? 'polite' : 'off'} title="Tokens: context is the prompt size at the latest model step; in/out are totals for the turn and the session">
      <span>context {n(t.context, level)}{t.contextWindow ? <> of {fmtTokens(t.contextWindow)} <span className={level}>{pct}%</span></> : null}</span>
      <span>turn {n(read(t.turn))} in, {running && t.estOut > 0 ? '~' : ''}{n(out)} out</span>
      {t.total && <span>session {n(read(t.total))} in, {n(t.total.output)} out{t.cost != null ? `, $${t.cost.toFixed(2)}` : ''}</span>}
    </div>
  );
}

/** Pulsing dots plus what is happening and for how long. Gone the moment words stream or the turn ends. */
function ActivityRow({ activity }: { activity: NonNullable<Activity> }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t); }, []);
  const secs = Math.max(0, Math.floor((Date.now() - activity.since) / 1000));
  const label = activity.kind === 'tool' ? `Running ${activity.name?.replace(/^mcp__fleet__/, 'fleet: ') || 'a tool'}` : 'Thinking';
  return (
    <div className="flex items-center gap-2 px-1 py-1 text-[12px] text-fg-muted" role="status" aria-live="polite">
      <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
      <span>{label}</span>
      <span className="num text-fg-faint">{secs}s</span>
    </div>
  );
}

type ToolEntry = Extract<Entry, { k: 'tool' }>;
type Rendered = Entry | { k: 'group'; id: number; tools: ToolEntry[] };

/** Consecutive tool calls fold into one row, like the terminal does, so the log reads prompt to reply. A lone call stays as it is. */
function groupTools(entries: Entry[]): Rendered[] {
  const out: Rendered[] = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (e.k === 'tool' && prev?.k === 'group') prev.tools.push(e);
    else if (e.k === 'tool') out.push({ k: 'group', id: e.id, tools: [e] }); // keyed by the first call, so the row keeps its open state as calls are added
    else out.push(e);
  }
  return out.map(e => e.k === 'group' && e.tools.length === 1 ? e.tools[0] : e);
}

const toolLabel = (name: string) => name.replace(/^mcp__fleet__/, 'fleet: ');

function ToolGroup({ tools, chatId }: { tools: ToolEntry[]; chatId: string }) {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(toolLabel(t.name), (counts.get(toolLabel(t.name)) || 0) + 1);
  const errors = tools.filter(t => t.result?.isError).length;
  const running = tools.filter(t => !t.result).length;
  return (
    <details className="msg tool group">
      <summary>
        <span className="font-semibold text-info">{tools.length} tool calls</span>
        <span className="text-fg-faint"> · {[...counts].map(([n, c]) => c > 1 ? `${n} ×${c}` : n).join(', ')}</span>
        {errors > 0 && <span className="text-crit"> · {errors} error{errors > 1 ? 's' : ''}</span>}
        {running > 0 && <span className="text-fg-faint"> · {running} running</span>}
      </summary>
      <div className="grid gap-1.5 px-2.5 pb-2.5">{tools.map(t => <EntryView key={t.id} e={t} chatId={chatId} />)}</div>
    </details>
  );
}

const SHELL_TOOLS = /^(Bash|PowerShell)$/;
const PREVIEW_LINES = 6;

/** One tool call, laid out like the terminal: a shell call shows its description, the command on a `$` line, and the first lines of
 *  output with "… +N lines" to see the rest. Other tools show their one meaningful input and the output the same way. */
function ToolRow({ e }: { e: ToolEntry }) {
  const [open, setOpen] = useState(false);
  const fleet = e.name.startsWith('mcp__fleet__');
  const shell = SHELL_TOOLS.test(e.name);
  const r = e.result;
  const text = r ? r.text.replace(/\s+$/, '') : '';
  const lines = text ? text.split('\n') : [];
  const hidden = Math.max(0, lines.length - PREVIEW_LINES);
  const cut = !!r && r.length > r.text.length;
  return (
    <div className="msg tool">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className={`shrink-0 font-semibold ${fleet ? 'text-warn' : 'text-info'}`}>{toolLabel(e.name)}</span>
        {shell ? <span className="min-w-0 truncate text-fg-muted">{e.description || ''}</span> : <span className="mono min-w-0 truncate">{e.input}</span>}
        {r && !shell && <span className={`ml-auto shrink-0 text-[11px] ${r.isError ? 'text-crit' : 'text-fg-faint'}`}>{r.isError ? 'error' : ''}</span>}
      </div>
      {shell && <pre className="cmd">{(e.name === 'PowerShell' ? 'PS> ' : '$ ') + e.input}</pre>}
      {r && (
        <div className={`mt-1 border-l-2 pl-2 ${r.isError ? 'border-crit' : 'border-line'}`}>
          {lines.length === 0
            ? <span className="text-[11px] text-fg-faint">(no output)</span>
            : <pre className={`out ${r.isError ? 'text-crit' : ''}`}>{(open ? lines : lines.slice(0, PREVIEW_LINES)).join('\n')}</pre>}
          {(hidden > 0 || cut) && (
            <button className="mt-0.5 text-[11px] text-fg-faint hover:text-fg" onClick={() => setOpen(o => !o)}>
              {hidden > 0 ? (open ? 'show less' : `… +${hidden} lines`) : ''}{cut ? `${hidden > 0 ? ' · ' : ''}output cut at ${r.text.length} of ${r.length} chars` : ''}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const SHELL_PREVIEW = 12;

/** A `!` command: the command on a prompt line, output under it (the tail while it runs, the head once done, like a tool row),
 *  and what to do with it. Nothing here has reached the model unless it was sent. */
function ShellRow({ e, chatId }: { e: Extract<Entry, { k: 'shell' }>; chatId: string }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const lines = e.output ? e.output.split('\n') : [];
  const hidden = Math.max(0, lines.length - SHELL_PREVIEW);
  const shown = open ? lines : e.done ? lines.slice(0, SHELL_PREVIEW) : lines.slice(-SHELL_PREVIEW);
  const bad = e.done && (e.interrupted || e.exitCode !== 0);
  const status = !e.done ? 'running' : e.interrupted ? 'interrupted' : e.exitCode == null ? 'did not finish' : `exit ${e.exitCode}`;
  const send = () => api.shellSend(chatId, e.runId).then(() => setSent(true)).catch(err => actions.toast(err.message, 'error'));
  return (
    <div className="msg tool">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-semibold text-accent">you ran</span>
        <span className="min-w-0 truncate text-fg-faint">{shortPath(e.cwd)}</span>
        <span className={`ml-auto shrink-0 text-[11px] ${!e.done ? 'text-fg-muted' : bad ? 'text-crit' : 'text-fg-faint'}`}>{status}</span>
      </div>
      <pre className="cmd">{'❯ ' + e.cmd}</pre>
      <div className={`mt-1 border-l-2 pl-2 ${bad ? 'border-crit' : 'border-line'}`}>
        {lines.length === 0 ? <span className="text-[11px] text-fg-faint">{e.done ? '(no output)' : '…'}</span> : <pre className="out">{shown.join('\n')}</pre>}
        {(hidden > 0 || e.truncated) && (
          <button className="mt-0.5 text-[11px] text-fg-faint hover:text-fg" onClick={() => setOpen(o => !o)}>
            {hidden > 0 ? (open ? 'show less' : `… +${hidden} lines`) : ''}{e.truncated ? `${hidden > 0 ? ' · ' : ''}output cut; the terminal has all of it` : ''}
          </button>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {!e.done && <button className="btn sm" onClick={() => api.shellInterrupt(chatId)} title="Send Ctrl+C to the shell (Esc in the composer does the same)"><Square size={12} aria-hidden="true" /> Stop</button>}
        {e.terminalId && <button className="btn sm ghost" onClick={() => actions.go({ kind: 'terminal', id: e.terminalId })} title="Open this chat's shell as a tab"><TerminalIcon size={12} aria-hidden="true" /> Open terminal</button>}
        {e.done && <button className="btn sm ghost" disabled={sent} onClick={send} title="Send this output to Claude now. Otherwise it rides along with your next message."><Send size={12} aria-hidden="true" /> {sent ? 'Sent to Claude' : 'Send to Claude'}</button>}
      </div>
    </div>
  );
}

function EntryView({ e, chatId }: { e: Entry; chatId: string }) {
  switch (e.k) {
    case 'user': {
      const o = e.origin;
      const label = o?.kind === 'manual' ? 'forwarded from' : o?.kind === 'dialogue' ? 'dialogue · relayed from' : 'from';
      return <div className={`msg user ${o ? o.kind : ''}`}>{o && <span className="origin">{label} {o.fromTitle || o.fromChatId}{o.askId ? ` (ask ${o.askId})` : ''}</span>}{e.text}</div>;
    }
    case 'assistant': return <div className={`msg assistant ${e.streaming ? 'opacity-90' : ''}`} dangerouslySetInnerHTML={{ __html: md(e.text) }} />;
    case 'tool': return <ToolRow e={e} />;
    case 'shell': return <ShellRow e={e} chatId={chatId} />;
    case 'sys': return <div className={`msg sys ${e.err ? 'err' : ''}`}>{e.text}</div>;
    case 'perm': return (
      <div className={`msg perm ${e.resolved ? 'resolved' : ''}`}>
        <div><b>Permission:</b> {e.toolName}</div>
        <pre>{e.input}</pre>
        {e.resolved ? <div className="text-[11px] text-fg-muted">{e.resolved === 'allow' ? 'allowed' : 'denied'}</div> : (
          <div className="mt-2 flex gap-2">
            <button className="btn sm primary" onClick={() => api.permission(chatId, e.permId, 'allow')}>Allow</button>
            <button className="btn sm" onClick={() => api.permission(chatId, e.permId, 'deny')}>Deny</button>
          </div>
        )}
      </div>
    );
  }
}

function ForwardDialog({ chatId, lastReply, onClose }: { chatId: string; lastReply: string; onClose: () => void }) {
  const snap = useStore(s => s.snapshot);
  const targets = (snap?.chats || []).filter(c => c.id !== chatId && c.status !== 'ended');
  const [target, setTarget] = useState(targets[0]?.id || '');
  const [text, setText] = useState(lastReply);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try { await api.send(target, text.trim(), chatId); actions.toast(`Sent to ${targets.find(t => t.id === target)?.title}`); onClose(); }
    catch (err: any) { actions.toast(err.message, 'error'); }
  };
  return (
    <dialog ref={ref} onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Send to another chat</h2>
        {targets.length === 0 ? <p className="text-[12px] text-fg-muted">No other live chat to send to. Open or start another chat first.</p> : (
          <>
            <label>Target chat
              <select className="input" value={target} onChange={e => setTarget(e.target.value)}>
                {targets.map(c => <option key={c.id} value={c.id}>{c.title} ({c.repo ? `${c.repo} / ${c.branch || ''}` : shortPath(c.cwd)}, {c.status})</option>)}
              </select>
            </label>
            <label>Message<textarea className="input" rows={8} value={text} onChange={e => setText(e.target.value)} /></label>
            <p className="text-[11px] text-fg-faint">The target sees it as a forwarded message from this chat. Agents can also message each other on their own with the fleet tools.</p>
          </>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
          {targets.length > 0 && <button type="submit" className="btn primary" disabled={!text.trim()}>Send</button>}
        </div>
      </form>
    </dialog>
  );
}

export const escapeHtml = esc;
