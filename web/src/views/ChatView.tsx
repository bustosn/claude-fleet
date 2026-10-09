import { useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowRight, Pencil, Send, Square, X } from 'lucide-react';
import { api, subscribe, type ChatEvent, type ChatSummary, type ChatStatus, type MessageOrigin, type SlashCommandView } from '../lib/api';
import { md, esc } from '../lib/markdown';
import { shortPath } from '../lib/format';
import { actions, useStore } from '../lib/store';
import { Status, WorktreePicker } from '../components/ui';

type Entry =
  | { k: 'user'; id: number; text: string; origin: MessageOrigin }
  | { k: 'assistant'; id: number; text: string; streaming: boolean }
  | { k: 'tool'; id: number; toolId: string; name: string; input: string; result?: { text: string; length: number; isError: boolean } }
  | { k: 'sys'; id: number; text: string; err?: boolean }
  | { k: 'perm'; id: number; permId: string; toolName: string; input: string; resolved?: 'allow' | 'deny' };

// Distributive Omit: a plain Omit over the union would collapse it to the shared keys.
type EntryInput = Entry extends infer E ? (E extends Entry ? Omit<E, 'id'> : never) : never;
/** What the model is doing right now, shown under the log while a turn runs. */
type Activity = { kind: 'thinking' | 'tool'; name?: string; since: number } | null;
interface ChatState { entries: Entry[]; status: ChatStatus; summary: ChatSummary | null; seq: number; activity: Activity }
type Action = { type: 'event'; ev: ChatEvent } | { type: 'summary'; summary: ChatSummary } | { type: 'history'; evs: ChatEvent[] } | { type: 'sys'; text: string; err?: boolean };

function apply(state: ChatState, ev: ChatEvent, history: boolean): ChatState {
  let { entries, seq, status, activity } = state;
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
      break;
    case 'tool_start': if (last?.k === 'assistant' && last.streaming) entries = entries.map(e => e === last ? { ...e, streaming: false } : e); activity = { kind: 'tool', name: ev.name, since: now }; break;
    case 'assistant': {
      // The complete message replaces the entry the deltas were streaming into instead of adding a second copy.
      let streaming = last?.k === 'assistant' && last.streaming ? last : null;
      for (const b of ev.blocks) {
        if (b.type === 'text' && (b as any).text.trim()) {
          if (streaming) { const s = streaming; entries = entries.map(e => e === s ? { ...e, text: (b as any).text, streaming: false } : e); streaming = null; }
          else push({ k: 'assistant', text: (b as any).text, streaming: false });
        } else if (b.type === 'tool_use') push({ k: 'tool', toolId: (b as any).id, name: (b as any).name, input: (b as any).input });
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
    case 'result': activity = null; push({ k: 'sys', text: `turn done, ${ev.subtype}${ev.cost != null ? `, $${ev.cost.toFixed(3)}` : ''}${ev.duration ? `, ${(ev.duration / 1000).toFixed(1)}s` : ''}${ev.errors ? `, ${ev.errors.join('; ')}` : ''}` }); break;
    case 'error': push({ k: 'sys', text: ev.message, err: true }); activity = null; break;
    case 'init': break;
  }
  if (history) return { ...state, entries, seq };
  return { ...state, entries, seq, status, activity };
}

function reducer(state: ChatState, a: Action): ChatState {
  switch (a.type) {
    case 'event': return apply(state, a.ev, false);
    case 'history': { let s = state; for (const ev of a.evs) s = apply(s, ev, true); return { ...s, entries: [...s.entries, { k: 'sys', id: ++s.seq, text: 'end of saved history' }] }; }
    case 'summary': return { ...state, summary: a.summary, status: a.summary.status, activity: a.summary.status === 'running' ? state.activity || { kind: 'thinking', since: Date.now() } : null };
    case 'sys': return { ...state, entries: [...state.entries, { k: 'sys', id: state.seq + 1, text: a.text, err: a.err }], seq: state.seq + 1 };
  }
}

export function ChatView({ chatId }: { chatId: string }) {
  const [state, dispatch] = useReducer(reducer, { entries: [], status: 'starting', summary: null, seq: 0, activity: null });
  const snap = useStore(s => s.snapshot);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [text, setText] = useState('');
  const [forward, setForward] = useState(false);
  const [commands, setCommands] = useState<SlashCommandView[]>([]);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);

  // The command list exists once the Claude process has started; refetch after init in case it was empty before.
  const initDone = state.entries.length > 0 || state.status !== 'starting';
  useEffect(() => { if (initDone) api.commands(chatId).then(setCommands).catch(() => {}); }, [chatId, initDone]);

  const slashQuery = /^\/(\S*)$/.exec(text)?.[1];
  const matches = slashQuery == null || cmdDismissed ? [] : commands.filter(c => c.name.startsWith(slashQuery) || c.aliases.some(a => a.startsWith(slashQuery)) || (slashQuery.length > 1 && c.name.includes(slashQuery))).slice(0, 12);
  const menuOpen = matches.length > 0;
  const pickCommand = (c: SlashCommandView) => { setText(`/${c.name} `); setCmdDismissed(true); composer.current?.focus(); };
  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex(i => (i + 1) % matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex(i => (i - 1 + matches.length) % matches.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pickCommand(matches[Math.min(cmdIndex, matches.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setCmdDismissed(true); return; }
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
    setText('');
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
      <header className="flex h-11 items-center gap-2 border-b border-line bg-surface px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{title}</div>
          <div className="flex items-center gap-2 truncate text-[11px] text-fg-faint mono">
            {s && s.sessionId && s.locatedBy !== 'cwd' ? <WorktreePicker sessionId={s.sessionId} worktree={s.worktree} locatedBy={s.locatedBy} /> : <span>{s ? (s.repo ? `${s.repo} / ${s.branch || ''}` : shortPath(s.cwd)) : ''}</span>}
            <span>{s ? `${s.model}  ${s.permissionMode}${s.forked ? '  forked copy' : ''}` : ''}</span>
          </div>
        </div>
        <Status state={state.status} />
        <button className="btn sm ghost" onClick={rename} title="Rename"><Pencil size={13} aria-hidden="true" /> Rename</button>
        <button className="btn sm ghost" onClick={() => setForward(true)} title="Send text to another live chat"><ArrowRight size={13} aria-hidden="true" /> Send to chat</button>
        <button className="btn sm ghost" disabled={state.status !== 'running'} onClick={() => api.interrupt(chatId)} title="Interrupt the current turn"><Square size={12} aria-hidden="true" /> Stop</button>
        <button className="btn sm ghost" onClick={() => api.endChat(chatId).then(() => actions.toast('Chat ended'))} title="End this chat process"><X size={13} aria-hidden="true" /> End</button>
      </header>
      {s?.forked && <div className="border-b border-warn/40 bg-warn-soft px-4 py-1.5 text-[11px] text-fg-muted">The original session is open in a terminal, so this chat continues a forked copy with its own session id.</div>}

      <div ref={log} className="grid min-h-0 flex-1 auto-rows-max content-start gap-2 overflow-y-auto px-4 py-3" onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {state.entries.length === 0 && <div className="msg sys">Say what you need. Replies stream in here, and tool calls show as they run.</div>}
        {state.entries.map(e => <EntryView key={e.id} e={e} chatId={chatId} />)}
        {state.activity && <ActivityRow activity={state.activity} />}
      </div>

      <form className="relative flex gap-2 border-t border-line bg-surface px-4 py-3" onSubmit={send}>
        {menuOpen && <CommandMenu matches={matches} index={Math.min(cmdIndex, matches.length - 1)} onPick={pickCommand} onHover={setCmdIndex} />}
        <textarea ref={composer} className="input flex-1" rows={3} value={text} placeholder="Message Claude. Enter sends, Shift+Enter for a new line, / for commands." onChange={e => { setText(e.target.value); setCmdIndex(0); setCmdDismissed(false); }}
          onKeyDown={onComposerKey} disabled={state.status === 'ended'} />
        <button className="btn primary self-end" type="submit" disabled={state.status === 'ended' || !text.trim()}><Send size={13} aria-hidden="true" /> Send</button>
      </form>

      {forward && <ForwardDialog chatId={chatId} lastReply={[...state.entries].reverse().find(e => e.k === 'assistant')?.text || ''} onClose={() => setForward(false)} />}
    </div>
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

function EntryView({ e, chatId }: { e: Entry; chatId: string }) {
  switch (e.k) {
    case 'user': {
      const o = e.origin;
      return <div className={`msg user ${o ? o.kind : ''}`}>{o && <span className="origin">{o.kind === 'manual' ? 'forwarded from' : 'from'} {o.fromTitle || o.fromChatId}{o.askId ? ` (ask ${o.askId})` : ''}</span>}{e.text}</div>;
    }
    case 'assistant': return <div className={`msg assistant ${e.streaming ? 'opacity-90' : ''}`} dangerouslySetInnerHTML={{ __html: md(e.text) }} />;
    case 'tool': {
      const fleet = e.name.startsWith('mcp__fleet__');
      return (
        <div className="msg tool">
          <span className={`font-semibold ${fleet ? 'text-warn' : 'text-info'}`}>{e.name.replace(/^mcp__fleet__/, 'fleet: ')}</span> <span className="mono">{e.input}</span>
          {e.result && (
            <details className="mt-1">
              <summary className={`cursor-pointer text-[11px] ${e.result.isError ? 'text-crit' : 'text-fg-faint'}`}>{e.result.isError ? 'error' : 'result'} · {e.result.length} chars</summary>
              <pre>{e.result.text}</pre>
            </details>
          )}
        </div>
      );
    }
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
