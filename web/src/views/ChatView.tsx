import { useEffect, useReducer, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { ArrowRight, Brain, Code2, ExternalLink, FileText, FolderOpen, Paperclip, Pencil, Plug, Send, Square, Terminal as TerminalIcon, X } from 'lucide-react';
import { api, subscribe, type Attachment, type ChatEvent, type FilePreview, type ChatSummary, type ChatStatus, type McpServerView, type MessageOrigin, type ModelOption, type SlashCommandView } from '../lib/api';
import { rankCommands } from '../lib/commands';
import { md, esc, fileRefs } from '../lib/markdown';
import { fmtTokens, shortPath } from '../lib/format';
import { actions, useStore } from '../lib/store';
import { Status, WorktreePicker } from '../components/ui';
import { ForwardDialog } from '../components/SidebarDialogs';
import { AttachmentChips, MAX_ATTACHMENT, clipboardImages, fmtBytes, readAttachment, toSend, type Pending } from '../components/Attachments';
import type { AskQuestion, EditPreview, TodoItem, TokenUsage } from '../../../shared/types';
import { CodeTextarea, type CodeTextareaHandle } from '../components/CodeTextarea';
import { ContextPopover, DiffView, EFFORTS, FileMenu, MODES, PermissionCard, RewindButton, TaskRow, TodoPanel, type TaskEntry } from './chatParts';

type Entry =
  | { k: 'user'; id: number; text: string; origin: MessageOrigin; attachments?: string[]; uuid?: string }
  | { k: 'thinking'; id: number; text: string }
  | ({ k: 'task'; id: number } & TaskEntry)
  | { k: 'assistant'; id: number; text: string; streaming: boolean }
  | { k: 'tool'; id: number; toolId: string; name: string; input: string; description?: string; edit?: EditPreview; result?: { text: string; length: number; isError: boolean } }
  | { k: 'sys'; id: number; text: string; err?: boolean }
  | { k: 'perm'; id: number; permId: string; toolName: string; input: string; suggestions: number; plan?: string; edit?: EditPreview; questions?: AskQuestion[]; answers?: Record<string, string>; always?: boolean; resolved?: 'allow' | 'deny' }
  | { k: 'shell'; id: number; runId: string; cmd: string; cwd: string; terminalId: string; output: string; truncated: boolean; exitCode: number | null; done: boolean; interrupted: boolean };

// Distributive Omit: a plain Omit over the union would collapse it to the shared keys.
type EntryInput = Entry extends infer E ? (E extends Entry ? Omit<E, 'id'> : never) : never;
/** What the model is doing right now, shown under the log while a turn runs. */
type Activity = { kind: 'thinking' | 'tool'; name?: string; since: number } | null;
/** Token readout. `estOut` is a chars/4 guess for text that has streamed since the last exact count, so the number keeps moving mid-reply. */
type Tokens = { turn: TokenUsage; context: number; estOut: number; total: TokenUsage | null; contextWindow: number | null; cost: number | null };
const noUsage: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const noTokens: Tokens = { turn: noUsage, context: 0, estOut: 0, total: null, contextWindow: null, cost: null };
interface ChatState { todos: TodoItem[]; entries: Entry[]; status: ChatStatus; summary: ChatSummary | null; seq: number; activity: Activity; tokens: Tokens | null }
type Action = { type: 'event'; ev: ChatEvent } | { type: 'summary'; summary: ChatSummary } | { type: 'history'; evs: ChatEvent[] } | { type: 'sys'; text: string; err?: boolean };

function apply(state: ChatState, ev: ChatEvent, history: boolean): ChatState {
  let { entries, seq, status, activity, tokens, summary, todos } = state;
  const now = Date.now();
  const thinking = (keepSince = false) => { activity = { kind: 'thinking', since: keepSince && activity ? activity.since : now }; };
  const push = (e: EntryInput) => { entries = [...entries, { ...e, id: ++seq } as Entry]; };
  const last = entries[entries.length - 1];
  switch (ev.t) {
    case 'status': status = ev.status; if (status === 'running') { if (!activity) thinking(); } else activity = null; break;
    case 'user': if (last?.k === 'assistant' && last.streaming) entries = entries.map(e => e === last ? { ...e, streaming: false } : e); push({ k: 'user', text: ev.text, origin: ev.origin, attachments: ev.attachments, uuid: ev.uuid }); thinking(); break;
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
        } else if (b.type === 'tool_use') push({ k: 'tool', toolId: (b as any).id, name: (b as any).name, input: (b as any).input, description: (b as any).description, edit: (b as any).edit });
        else if (b.type === 'thinking' && (b as any).text) push({ k: 'thinking', text: (b as any).text });
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
    case 'permission': push({ k: 'perm', permId: ev.id, toolName: ev.toolName, input: ev.input, suggestions: ev.suggestions, plan: ev.plan, edit: ev.edit, questions: ev.questions }); status = 'needs-you'; activity = null; break;
    case 'permission_resolved': entries = entries.map(e => e.k === 'perm' && e.permId === ev.id ? { ...e, resolved: ev.behavior, answers: ev.answers, always: ev.always } : e); thinking(); break;
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
    case 'todos': todos = ev.todos; break;
    case 'mode': push({ k: 'sys', text: `permission mode: ${MODES.find(m => m.value === ev.mode)?.label || ev.mode}` }); if (summary) summary = { ...summary, permissionMode: ev.mode }; break;
    case 'task': {
      const { t: _t, at: _at, ...rest } = ev;
      if (entries.some(e => e.k === 'task' && e.taskId === ev.taskId)) entries = entries.map(e => e.k === 'task' && e.taskId === ev.taskId ? { ...e, ...rest } : e);
      else push({ k: 'task', ...rest });
      break;
    }
  }
  if (history) return { ...state, entries, seq };
  return { ...state, entries, seq, status, activity, tokens, summary, todos };
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
  const [state, dispatch] = useReducer(reducer, { todos: [], entries: [], status: 'starting', summary: null, seq: 0, activity: null, tokens: null });
  const snap = useStore(s => s.snapshot);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [text, setText] = useState('');
  const [forward, setForward] = useState(false);
  const [commands, setCommands] = useState<SlashCommandView[]>([]);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const [histIdx, setHistIdx] = useState(-1);
  const composer = useRef<CodeTextareaHandle>(null);
  const [attachments, setAttachments] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  // Files dropped or pasted wait above the composer and go with the next message.
  const attach = async (files: File[]) => {
    const tooBig = files.filter(f => f.size > MAX_ATTACHMENT);
    if (tooBig.length) dispatch({ type: 'sys', text: `Too large to attach (over ${MAX_ATTACHMENT / 1024 / 1024} MB): ${tooBig.map(f => f.name).join(', ')}`, err: true });
    const read = await Promise.all(files.filter(f => f.size <= MAX_ATTACHMENT).map(readAttachment));
    if (read.length) setAttachments(a => [...a, ...read]);
  };
  // Alt+V, as in Claude Code on Windows. The browser asks once for clipboard access; Ctrl+V needs no permission and works too.
  const pasteImage = async () => {
    try {
      const files = await clipboardImages();
      if (files.length) attach(files); else dispatch({ type: 'sys', text: 'No image on the clipboard.' });
    } catch { dispatch({ type: 'sys', text: 'The browser blocked clipboard access. Ctrl+V pastes images too.', err: true }); }
  };
  const isFileDrag = (e: DragEvent) => e.dataTransfer.types.includes('Files');

  // `!` runs in the chat's own shell. Up/Down walk earlier commands while the composer is empty or holds a one-line `!`.
  const bang = text.startsWith('!');
  const shellRunning = [...state.entries].reverse().find((e): e is Extract<Entry, { k: 'shell' }> => e.k === 'shell' && !e.done);
  const bangHistory = [...new Set(state.entries.filter((e): e is Extract<Entry, { k: 'shell' }> => e.k === 'shell').map(e => e.cmd).reverse())];

  // The command list exists once the Claude process has started; refetch after init in case it was empty before.
  const initDone = state.entries.length > 0 || state.status !== 'starting';
  useEffect(() => { if (initDone) api.commands(chatId).then(setCommands).catch(() => {}); }, [chatId, initDone]);

  // `@` in the composer completes file names from the chat's folder.
  const atQuery = /(?:^|\s)@([^\s@]*)$/.exec(text)?.[1];
  const [atItems, setAtItems] = useState<string[]>([]);
  const [atIndex, setAtIndex] = useState(0);
  const [atDismissed, setAtDismissed] = useState(false);
  useEffect(() => {
    if (atQuery == null || state.status === 'ended') { setAtItems([]); return; }
    let live = true;
    const t = setTimeout(() => api.suggestFiles(chatId, atQuery).then(r => { if (live) { setAtItems(r); setAtIndex(0); } }).catch(() => { if (live) setAtItems([]); }), 100);
    return () => { live = false; clearTimeout(t); };
  }, [chatId, atQuery, state.status === 'ended']); // eslint-disable-line react-hooks/exhaustive-deps
  const atOpen = atQuery != null && !atDismissed && atItems.length > 0;
  const pickFile = (p: string) => { setText(t => t.replace(/(^|\s)@[^\s@]*$/, `$1@${p} `)); setAtDismissed(false); setAtItems([]); composer.current?.focus(); };
  const cycleMode = () => {
    const cur = MODES.findIndex(m => m.value === (state.summary?.permissionMode || 'default'));
    api.setMode(chatId, MODES[(cur + 1) % MODES.length].value).catch(err => dispatch({ type: 'sys', text: `Could not switch mode: ${err.message}`, err: true }));
  };

  const slashQuery = /^\/(\S*)$/.exec(text)?.[1];
  // Typing "/" into a chat whose list never arrived asks again, so one failed fetch at init is not permanent.
  useEffect(() => { if (slashQuery != null && commands.length === 0) api.commands(chatId).then(setCommands).catch(() => {}); }, [chatId, slashQuery != null, commands.length]);
  const matches = slashQuery == null || cmdDismissed ? [] : rankCommands(commands, slashQuery);
  const menuOpen = matches.length > 0;
  const pickCommand = (c: SlashCommandView) => { setText(`/${c.name} `); setCmdDismissed(true); composer.current?.focus(); };
  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); return; }
    if (atOpen && !menuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAtIndex(i => (i + 1) % atItems.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAtIndex(i => (i - 1 + atItems.length) % atItems.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pickFile(atItems[Math.min(atIndex, atItems.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setAtDismissed(true); return; }
    }
    if (menuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex(i => (i + 1) % matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex(i => (i - 1 + matches.length) % matches.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pickCommand(matches[Math.min(cmdIndex, matches.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setCmdDismissed(true); return; }
    }
    if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteImage(); return; }
    if (e.key === 'Escape' && shellRunning) { e.preventDefault(); api.shellInterrupt(chatId).catch(() => {}); return; }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && bangHistory.length && (text === '' || (bang && !text.includes('\n')))) {
      const next = e.key === 'ArrowUp' ? Math.min(histIdx + 1, bangHistory.length - 1) : Math.max(histIdx - 1, -1);
      e.preventDefault(); setHistIdx(next); setText(next < 0 ? '' : '!' + bangHistory[next]);
      return;
    }
    // Inside a ``` block Enter is a new line; Ctrl+Enter sends from there.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey || e.currentTarget.dataset.code !== 'true')) { e.preventDefault(); send(); }
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
    const t = text.trim();
    if (t.startsWith('!')) { // attachments stay put for the next message to Claude
      setText(''); setHistIdx(-1);
      const cmd = t.slice(1).trim(); if (!cmd) return;
      api.shell(chatId, cmd).catch(err => dispatch({ type: 'sys', text: err.message, err: true }));
      return;
    }
    if (!t && !attachments.length) return;
    const sent = attachments;
    setText(''); setHistIdx(-1); setAttachments([]);
    api.send(chatId, t, undefined, toSend(sent))
      .catch(err => { dispatch({ type: 'sys', text: err.message, err: true }); setAttachments(a => [...sent, ...a]); });
  };
  // Paths in finished replies are checked once against the chat's folder; only files that exist become links.
  const [, setRefsVersion] = useState(0); // bumped when an answer arrives, to re-render with the new links
  const isFile = (p: string) => knownFiles.get(`${chatId}\n${p}`) === true;
  useEffect(() => {
    const unknown = [...new Set(state.entries.flatMap(e => e.k === 'assistant' && !e.streaming ? fileRefs(e.text) : []))].filter(p => !knownFiles.has(`${chatId}\n${p}`));
    if (!unknown.length) return;
    for (const p of unknown) knownFiles.set(`${chatId}\n${p}`, false); // asked once, even if the request fails
    api.resolveFiles(chatId, unknown).then(refs => {
      for (const r of refs) knownFiles.set(`${chatId}\n${r.path}`, r.kind === 'file');
      if (refs.some(r => r.kind === 'file')) setRefsVersion(v => v + 1);
    }).catch(() => {});
  }, [chatId, state.entries]);
  const [viewing, setViewing] = useState<{ path: string; line: number | null } | null>(null);
  const openFileLink = (e: MouseEvent<HTMLDivElement>) => {
    const copy = (e.target as HTMLElement).closest<HTMLElement>('button.copy-btn');
    if (copy) {
      const text = copy.parentElement?.querySelector('pre')?.textContent ?? '';
      navigator.clipboard.writeText(text.replace(/\n$/, '')).then(
        () => { copy.textContent = 'Copied'; copy.classList.add('done'); setTimeout(() => { copy.textContent = 'Copy'; copy.classList.remove('done'); }, 1500); },
        () => actions.toast('The browser blocked clipboard access.', 'error'));
      return;
    }
    const a = (e.target as HTMLElement).closest<HTMLElement>('a.file-link'); if (!a?.dataset.path) return;
    e.preventDefault();
    const path = a.dataset.path, line = a.dataset.line ? Number(a.dataset.line) : null;
    if (e.ctrlKey || e.metaKey) api.openFile(chatId, path, 'editor', line ?? undefined).catch(err => actions.toast(err.message, 'error'));
    else setViewing({ path, line });
  };

  const rename = async () => {
    if (!s?.sessionId) { dispatch({ type: 'sys', text: 'Send a first message before renaming; the session id does not exist yet.', err: true }); return; }
    const next = window.prompt('Rename conversation', title);
    if (!next?.trim()) return;
    try { await api.rename(s.sessionId, next.trim()); actions.toast('Renamed'); } catch (err: any) { actions.toast(err.message, 'error'); }
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={e => { if (!isFileDrag(e) || state.status === 'ended') return; e.preventDefault(); dragDepth.current++; setDragging(true); }}
      onDragOver={e => { if (isFileDrag(e) && state.status !== 'ended') { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={e => { if (isFileDrag(e) && --dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
      onDrop={e => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth.current = 0; setDragging(false); if (state.status !== 'ended') attach([...e.dataTransfer.files]); }}>
      {dragging && <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-lg border-2 border-dashed border-accent bg-accent-soft/80 text-[13px] font-semibold">Drop to attach to your next message</div>}
      <header className="chat-head">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-5">{title}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-fg-faint mono">
            {s && s.sessionId && s.locatedBy !== 'cwd' ? <WorktreePicker sessionId={s.sessionId} worktree={s.worktree} locatedBy={s.locatedBy} /> : <span className="truncate">{s ? (s.repo ? `${s.repo} / ${s.branch || ''}` : shortPath(s.cwd)) : ''}</span>}
            {s && <><span aria-hidden="true">·</span><ModelPicker chatId={chatId} model={s.model} ready={initDone && state.status !== 'ended'} onError={msg => dispatch({ type: 'sys', text: msg, err: true })} /><span aria-hidden="true">·</span><EffortPicker chatId={chatId} effort={s.effort} ready={initDone && state.status !== 'ended'} onError={msg => dispatch({ type: 'sys', text: msg, err: true })} /><span aria-hidden="true">·</span><ModePicker chatId={chatId} mode={s.permissionMode} ready={initDone && state.status !== 'ended'} onError={msg => dispatch({ type: 'sys', text: msg, err: true })} /><span aria-hidden="true">·</span><McpPicker chatId={chatId} ready={initDone && state.status !== 'ended'} onError={msg => dispatch({ type: 'sys', text: msg, err: true })} /></>}
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

      <div ref={log} className="chat-log min-h-0 flex-1 overflow-y-auto" onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} onClick={openFileLink}>
        <div className="chat-col">
        {state.entries.length === 0 && <div className="msg sys">Say what you need. Replies stream in here, and tool calls show as they run.</div>}
        {groupTools(state.entries).map(e => e.k === 'group' ? <ToolGroup key={e.id} tools={e.tools} chatId={chatId} /> : <EntryView key={e.id} e={e} chatId={chatId} isFile={isFile} canRewind={state.status === 'idle'} />)}
        {state.activity && <ActivityRow activity={state.activity} />}
        </div>
      </div>

      {state.todos.length > 0 && <TodoPanel todos={state.todos} />}
      <TokenStrip t={state.tokens} running={state.status === 'running'} chatId={chatId} ready={initDone && state.status !== 'ended'} />
      <form className="composer" onSubmit={send}>
        {atOpen && !menuOpen && <FileMenu matches={atItems} index={Math.min(atIndex, atItems.length - 1)} onPick={pickFile} onHover={setAtIndex} />}
        {menuOpen && <CommandMenu matches={matches} index={Math.min(cmdIndex, matches.length - 1)} onPick={pickCommand} onHover={setCmdIndex} />}
        {bang && !menuOpen && <div className="panel menu-pop px-3 py-1.5 text-[11px] text-fg-faint">
          Runs in this chat's shell{s ? ` (${shortPath(s.cwd)})` : ''}. Enter runs, Esc interrupts, Up recalls. The output is yours until you send it to Claude.</div>}
        <div className="composer-box">
          {attachments.length > 0 && <div className="px-3 pt-3"><AttachmentChips items={attachments} onRemove={id => setAttachments(a => a.filter(x => x.id !== id))} /></div>}
          <CodeTextarea ref={composer} className={`input ${bang ? 'mono' : ''}`} rows={3} value={text} placeholder={state.status === 'ended' ? 'This chat has ended.' : 'Message Claude…'} onChange={v => { setText(v); setCmdIndex(0); setCmdDismissed(false); setAtDismissed(false); setHistIdx(-1); }}
            onKeyDown={onComposerKey} onPaste={e => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); attach(files); } }} disabled={state.status === 'ended'} />
          <div className="composer-bar">
            <span className="truncate"><span className="kbd">Enter</span> send · <span className="kbd">Shift</span>+<span className="kbd">Enter</span> new line · <span className="kbd">/</span> commands · <span className="kbd">@</span> files · <span className="kbd">!</span> shell · <span className="kbd">Shift</span>+<span className="kbd">Tab</span> mode</span>
            <button className="send-btn" type="submit" aria-label="Send" title="Send (Enter)" disabled={state.status === 'ended' || (!text.trim() && !attachments.length)}><Send size={15} aria-hidden="true" /></button>
          </div>
        </div>
      </form>

      {viewing && <FileViewer key={`${viewing.path}:${viewing.line}`} chatId={chatId} path={viewing.path} line={viewing.line} onClose={() => setViewing(null)} />}
      {forward && <ForwardDialog fromChatId={chatId} text={[...state.entries].reverse().find(e => e.k === 'assistant')?.text || ''} onClose={() => setForward(false)} />}
    </div>
  );
}

/** Which paths named in a chat are files, keyed `chatId\npath`. Kept across tab switches so a reopened chat does not ask again. */
const knownFiles = new Map<string, boolean>();
const VIEW_LINES = 5000;

/** A file Claude named, previewed without leaving the chat: markdown rendered, images shown, text with line numbers and the cited line marked.
 *  Buttons hand it to VS Code (at the line), the default app, or the file manager. */
function FileViewer({ chatId, path, line, onClose }: { chatId: string; path: string; line: number | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [f, setF] = useState<FilePreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const isMd = /\.(md|markdown)$/i.test(path);
  const [raw, setRaw] = useState(!isMd || line != null);
  useEffect(() => { ref.current?.showModal(); api.file(chatId, path).then(setF).catch(e => setErr(e.message)); }, [chatId, path]);
  useEffect(() => { ref.current?.querySelector('[data-hl]')?.scrollIntoView({ block: 'center' }); }, [f, raw]);
  const open = (how: 'editor' | 'default' | 'reveal') =>
    api.openFile(chatId, path, how, line ?? undefined).then(() => ref.current?.close()).catch(e => actions.toast(e.message, 'error'));

  const lines = f?.kind === 'text' ? f.text!.split(/\r?\n/) : [];
  const from = line && line > VIEW_LINES ? line - VIEW_LINES / 2 : 0; // a long file shows the stretch around the cited line
  return (
    <dialog ref={ref} className="file-viewer" onClose={onClose} onClick={e => { if (e.target === ref.current) ref.current.close(); }}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <FileText size={15} className="shrink-0 text-fg-faint" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{f?.name || path.split(/[\\/]/).pop()}{line ? <span className="font-normal text-fg-faint">, line {line}</span> : null}</div>
          <div className="truncate text-[11px] text-fg-faint mono" title={f?.abs}>{f?.abs || path}{f ? ` · ${fmtBytes(f.size)}` : ''}</div>
        </div>
        {isMd && f?.kind === 'text' && <button className="btn sm ghost" onClick={() => setRaw(r => !r)}>{raw ? 'Rendered' : 'Source'}</button>}
        {f?.editor && <button className="btn sm" onClick={() => open('editor')} title={`Open in VS Code${line ? ` at line ${line}` : ''}`}><Code2 size={13} aria-hidden="true" /> VS Code</button>}
        <button className="btn sm" disabled={!f || f.runnable} onClick={() => open('default')} title={f?.runnable ? 'This would run the file, not open it' : 'Open with the default app'}><ExternalLink size={13} aria-hidden="true" /> Open</button>
        <button className="btn sm" disabled={!f} onClick={() => open('reveal')} title="Show in the file manager"><FolderOpen size={13} aria-hidden="true" /> Show in folder</button>
        <button className="btn sm ghost" onClick={() => ref.current?.close()} aria-label="Close"><X size={14} aria-hidden="true" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {err ? <div className="p-4 text-[12px] text-crit">{err}</div>
          : !f ? <div className="p-4 text-[12px] text-fg-faint">Loading…</div>
          : f.kind === 'image' ? <div className="grid h-full place-items-center p-4"><img src={api.fileRawUrl(chatId, path)} alt={f.name} className="max-h-full max-w-full object-contain" /></div>
          : f.kind === 'binary' ? <div className="p-4 text-[12px] text-fg-muted">Binary file; no preview. Open it with one of the buttons above.</div>
          : f.kind === 'too-large' ? <div className="p-4 text-[12px] text-fg-muted">Too large to preview ({fmtBytes(f.size)}). Open it with one of the buttons above.</div>
          : !raw ? <div className="msg assistant m-4" dangerouslySetInnerHTML={{ __html: md(f.text!) }} />
          : <pre className="file-lines">{lines.slice(from, from + VIEW_LINES).map((l, i) => {
              const n = from + i + 1;
              return <div key={n} data-hl={n === line ? '' : undefined}><span className="ln">{n}</span>{l || ' '}</div>;
            })}{lines.length > from + VIEW_LINES && <div className="text-fg-faint">… {lines.length - from - VIEW_LINES} more lines; open the file to see them</div>}</pre>}
      </div>
    </dialog>
  );
}


/** Permission mode, switchable from here or with Shift+Tab in the composer. A mode outside the usual three (bypass, auto) is shown but only left, not entered. */
function ModePicker({ chatId, mode, ready, onError }: { chatId: string; mode: string; ready: boolean; onError: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const known = MODES.some(m => m.value === mode);
  const change = async (next: string) => {
    if (next === mode) return;
    setBusy(true);
    try { await api.setMode(chatId, next); } catch (err: any) { onError(`Could not switch mode: ${err.message}`); } finally { setBusy(false); }
  };
  return (
    <select className={`inline-select mode-${mode} shrink-0`} value={mode} disabled={busy || !ready} onChange={e => change(e.target.value)} aria-label="Permission mode for this chat"
      title={`${MODES.find(m => m.value === mode)?.hint || mode}. Shift+Tab in the message box cycles modes.`}>
      {!known && <option value={mode}>{mode}</option>}
      {MODES.map(m => <option key={m.value} value={m.value} title={m.hint}>{m.label}</option>)}
    </select>
  );
}

/** How hard the model thinks on the following turns. */
function EffortPicker({ chatId, effort, ready, onError }: { chatId: string; effort: string | null; ready: boolean; onError: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const change = async (next: string) => {
    setBusy(true);
    try { await api.setEffort(chatId, next || null); } catch (err: any) { onError(`Could not set effort: ${err.message}`); } finally { setBusy(false); }
  };
  return (
    <select className="inline-select shrink-0" value={effort || ''} disabled={busy || !ready} onChange={e => change(e.target.value)} aria-label="Thinking effort for this chat" title="Thinking effort. Takes effect from the next turn.">
      <option value="">effort: default</option>
      {EFFORTS.map(l => <option key={l} value={l}>effort: {l}</option>)}
    </select>
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

const MCP_DOT: Record<McpServerView['status'], string> = { connected: 'bg-green-500', pending: 'bg-amber-400', 'needs-auth': 'bg-amber-400', failed: 'bg-red-500', disabled: 'bg-fg-faint' };
const MCP_LABEL: Record<McpServerView['status'], string> = { connected: 'connected', pending: 'connecting', 'needs-auth': 'needs sign-in', failed: 'failed', disabled: 'off' };

/** MCP servers this chat's process loaded, with reconnect and on/off. A server that needs sign-in opens a terminal running `claude`, where `/mcp` does the browser login;
 *  the SDK has no call for that. The list is read when the popover opens, so a server added after the chat started does not appear until a new chat. */
function McpPicker({ chatId, ready, onError }: { chatId: string; ready: boolean; onError: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const load = () => api.mcp(chatId).then(setServers).catch(err => { setServers([]); onError(`Could not read MCP servers: ${err.message}`); });
  useEffect(() => { if (ready) load(); }, [chatId, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const away = (e: globalThis.MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const act = async (name: string, action: 'reconnect' | 'enable' | 'disable') => {
    setBusy(name);
    try { setServers(await api.mcpAction(chatId, name, action)); } catch (err: any) { onError(`MCP ${action} failed for ${name}: ${err.message}`); } finally { setBusy(null); }
  };
  const login = async () => {
    try { const t = await api.mcpLogin(chatId); setOpen(false); actions.go({ kind: 'terminal', id: t.id }); actions.toast('Type /mcp, pick the server, finish the browser sign-in, then Reconnect here'); }
    catch (err: any) { onError(`Could not open a terminal: ${err.message}`); }
  };
  const list = servers || [];
  const attention = list.some(m => m.status === 'needs-auth' || m.status === 'failed');
  return (
    <span ref={box} className="relative inline-flex shrink-0">
      <button className="inline-flex h-5 items-center gap-1 rounded px-0.5 hover:bg-hover disabled:opacity-60" disabled={!ready} aria-expanded={open} aria-label="MCP servers for this chat"
        title="MCP servers for this chat" onClick={() => { setOpen(o => !o); if (!open) load(); }}>
        <Plug size={11} aria-hidden="true" />MCP{servers && <span className={attention ? 'text-amber-500' : ''}>{list.filter(m => m.status === 'connected').length}/{list.length}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="MCP servers" className="panel absolute left-0 top-full z-30 mt-1 w-[360px] py-1 text-[12px] text-fg shadow-[var(--shadow)]">
          {servers === null && <div className="px-3 py-2 text-fg-muted">Loading…</div>}
          {servers && !list.length && <div className="px-3 py-2 text-fg-muted">No MCP servers in this chat. Add one with <span className="mono">claude mcp add -s user</span>, then start a new chat.</div>}
          {list.map(m => (
            <div key={m.name} className="px-3 py-1.5 hover:bg-hover">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${MCP_DOT[m.status]}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-semibold" title={m.url || m.name}>{m.name}</span>
                <span className="shrink-0 text-fg-muted">{MCP_LABEL[m.status]}{m.status === 'connected' ? ` · ${m.tools} tools` : ''}</span>
              </div>
              {m.error && <div className="mt-0.5 break-words text-red-500">{m.error}</div>}
              <div className="mt-1 flex gap-1.5">
                {m.status === 'needs-auth' && <button className="btn sm" onClick={login}>Sign in…</button>}
                {m.status !== 'disabled' && m.status !== 'needs-auth' && <button className="btn sm ghost" disabled={busy === m.name} onClick={() => act(m.name, 'reconnect')}>Reconnect</button>}
                <button className="btn sm ghost" disabled={busy === m.name} onClick={() => act(m.name, m.status === 'disabled' ? 'enable' : 'disable')}>{m.status === 'disabled' ? 'Turn on' : 'Turn off'}</button>
                {m.scope && <span className="ml-auto self-center text-fg-faint">{m.scope}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

/** Slash command picker above the composer, like Claude Code's. Arrow keys move, Tab or Enter fills the command in, Esc hides it. */
function CommandMenu({ matches, index, onPick, onHover }: { matches: SlashCommandView[]; index: number; onPick: (c: SlashCommandView) => void; onHover: (i: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [index]);
  return (
    <div ref={list} role="listbox" aria-label="Commands" className="panel menu-pop">
      {matches.map((c, i) => (
        <div key={c.name} role="option" aria-selected={i === index} className={`grid cursor-pointer grid-cols-[minmax(120px,auto)_1fr_auto] items-baseline gap-3 rounded-lg px-3 py-1 text-[12px] ${i === index ? 'bg-selected' : 'hover:bg-hover'}`}
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
function TokenStrip({ t, running, chatId, ready }: { t: Tokens | null; running: boolean; chatId: string; ready: boolean }) {
  if (!t) return null;
  const read = (u: TokenUsage) => u.input + u.cacheRead + u.cacheWrite;
  const out = t.turn.output + (running ? Math.round(t.estOut) : 0);
  const pct = t.contextWindow ? Math.round((t.context / t.contextWindow) * 100) : null;
  const level = pct == null ? '' : pct >= 90 ? 'text-crit' : pct >= 70 ? 'text-warn' : '';
  const n = (v: number, cls = '') => <b className={`num text-fg-muted ${cls}`}>{fmtTokens(v)}</b>;
  return (
    <div className="token-strip mono" role="status" aria-live={running ? 'polite' : 'off'} title="Tokens: context is the prompt size at the latest model step; in/out are totals for the turn and the session">
      <ContextPopover chatId={chatId} disabled={!ready}><span>context {n(t.context, level)}{t.contextWindow ? <> of {fmtTokens(t.contextWindow)} <span className={level}>{pct}%</span></> : null}</span></ContextPopover>
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
/** Tools that have their own UI (the question card, the plan card, the task list), so a row of raw JSON would only repeat them. */
const OWN_UI = /^(AskUserQuestion|ExitPlanMode|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet)$/;

function groupTools(entries: Entry[]): Rendered[] {
  const out: Rendered[] = [];
  for (const e of entries) {
    if (e.k === 'tool' && OWN_UI.test(e.name)) continue;
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

/** Subagent calls get their own live row from the task events, so the hand-back text is not repeated under the call. */
const SUBAGENT_TOOLS = /^(Agent|Task)$/;
const SHELL_TOOLS = /^(Bash|PowerShell)$/;
/** Tools whose input is a file path, shown as a link to it. */
const FILE_TOOLS = /^(Read|Write|Edit|MultiEdit|NotebookEdit)$/;
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
        {shell ? <span className="min-w-0 truncate text-fg-muted">{e.description || ''}</span>
          : FILE_TOOLS.test(e.name) && e.input ? <a className="file-link mono min-w-0 truncate" href="#" data-path={e.input} title={`Open ${e.input} (Ctrl+click: VS Code)`}>{e.input}</a>
          : <span className="mono min-w-0 truncate">{e.input}</span>}
        {r && !shell && <span className={`ml-auto shrink-0 text-[11px] ${r.isError ? 'text-crit' : 'text-fg-faint'}`}>{r.isError ? 'error' : ''}</span>}
      </div>
      {shell && <pre className="cmd">{(e.name === 'PowerShell' ? 'PS> ' : '$ ') + e.input}</pre>}
      {e.edit && <DiffView edit={e.edit} />}
      {r && !((e.edit || SUBAGENT_TOOLS.test(e.name)) && !r.isError) && (
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

function EntryView({ e, chatId, isFile, canRewind = false }: { e: Entry; chatId: string; isFile?: (path: string) => boolean; canRewind?: boolean }) {
  switch (e.k) {
    case 'user': {
      const o = e.origin;
      const label = o?.kind === 'manual' ? 'forwarded from' : o?.kind === 'dialogue' ? 'dialogue · relayed from' : 'from';
      return <div className={`msg user ${o ? o.kind : ''}`}>{o && <span className="origin">{label} {o.fromTitle || o.fromChatId}{o.askId ? ` (ask ${o.askId})` : ''}</span>}{e.text}
        {e.attachments?.length ? <span className={`flex flex-wrap gap-1 ${e.text ? 'mt-1.5' : ''}`}>{e.attachments.map((n, i) => <span key={i} className="inline-flex items-center gap-1 rounded bg-surface/60 px-1.5 text-[11px] text-fg-muted"><Paperclip size={10} aria-hidden="true" />{n}</span>)}</span> : null}
        {e.uuid && !o && <RewindButton chatId={chatId} uuid={e.uuid} disabled={!canRewind} />}</div>;
    }
    case 'thinking': return (
      <details className="msg thinking"><summary><Brain size={12} aria-hidden="true" /> Thinking</summary><div className="thinking-text">{e.text}</div></details>
    );
    case 'task': return <TaskRow t={e} chatId={chatId} />;
    case 'assistant': return <div className={`msg assistant ${e.streaming ? 'opacity-90' : ''}`} dangerouslySetInnerHTML={{ __html: md(e.text, isFile) }} />;
    case 'tool': return <ToolRow e={e} />;
    case 'shell': return <ShellRow e={e} chatId={chatId} />;
    case 'sys': return <div className={`msg sys ${e.err ? 'err' : ''}`}>{e.text}</div>;
    case 'perm': return e.questions?.length ? <QuestionCard e={e} chatId={chatId} /> : <PermissionCard e={e} chatId={chatId} />;
  }
}

const OTHER = '__other__';

/** Claude's AskUserQuestion as a checklist: each question lists its options (radio, or checkboxes when several may be picked) plus an "Other" box.
 *  Submitting sends the answers back as the tool's result; Skip tells Claude to carry on without them. */
function QuestionCard({ e, chatId }: { e: Extract<Entry, { k: 'perm' }>; chatId: string }) {
  const qs = e.questions!;
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toggle = (q: AskQuestion, label: string) => setPicked(p => {
    const cur = p[q.question] || [];
    return { ...p, [q.question]: q.multiSelect ? (cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label]) : [label] };
  });
  const answer = (q: AskQuestion) => (picked[q.question] || []).map(l => l === OTHER ? (other[q.question] || '').trim() : l).filter(Boolean).join(', ');
  const ready = qs.every(q => answer(q));
  const submit = () => {
    setBusy(true);
    api.answerQuestions(chatId, e.permId, Object.fromEntries(qs.map(q => [q.question, answer(q)])))
      .catch(err => actions.toast(err.message, 'error')).finally(() => setBusy(false));
  };
  const skip = () => api.permission(chatId, e.permId, { behavior: 'deny' });
  const done = !!e.resolved;
  return (
    <div className={`msg perm ${done ? 'resolved' : ''}`}>
      <div className="grid gap-3">
        {qs.map(q => (
          <fieldset key={q.question} className="grid gap-1" disabled={done || busy}>
            <legend className="mb-1 text-[13px] font-semibold">{q.header && <span className="mr-2 rounded bg-accent-soft px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-muted">{q.header}</span>}{q.question}</legend>
            {q.options.map(o => {
              const on = (picked[q.question] || []).includes(o.label) || (done && e.answers?.[q.question]?.split(', ').includes(o.label));
              return (
                <label key={o.label} className={`flex cursor-pointer items-start gap-2 rounded border px-2 py-1.5 text-[12px] ${on ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover'}`}>
                  <input type={q.multiSelect ? 'checkbox' : 'radio'} name={e.permId + q.question} className="mt-0.5" checked={!!on} onChange={() => toggle(q, o.label)} />
                  <span><b>{o.label}</b>{o.description && <span className="block text-fg-muted">{o.description}</span>}</span>
                </label>
              );
            })}
            <label className="flex items-center gap-2 rounded border border-line px-2 py-1.5 text-[12px]">
              <input type={q.multiSelect ? 'checkbox' : 'radio'} name={e.permId + q.question} checked={(picked[q.question] || []).includes(OTHER)} onChange={() => toggle(q, OTHER)} />
              <span className="shrink-0 font-semibold">Other</span>
              <input className="input h-6 min-w-0 flex-1" placeholder="Type your own answer" value={other[q.question] || ''}
                onFocus={() => { if (!(picked[q.question] || []).includes(OTHER)) toggle(q, OTHER); }} onChange={ev => setOther(o => ({ ...o, [q.question]: ev.target.value }))} />
            </label>
          </fieldset>
        ))}
      </div>
      {done ? <div className="mt-2 text-[11px] text-fg-muted">{e.resolved === 'allow' ? 'answered' : 'skipped'}</div> : (
        <div className="mt-2 flex gap-2">
          <button className="btn sm primary" disabled={!ready || busy} onClick={submit}>Submit</button>
          <button className="btn sm" disabled={busy} onClick={skip}>Skip</button>
        </div>
      )}
    </div>
  );
}

export const escapeHtml = esc;
