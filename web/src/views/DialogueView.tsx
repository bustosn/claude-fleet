import { useEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import { Download, MessageSquare, Pause, Play, Plus, Send, Square, Trash2 } from 'lucide-react';
import { api, subscribe, type DialogueEvent, type DialogueStatus, type DialogueSummary, type Side } from '../lib/api';
import { md } from '../lib/markdown';
import { shortPath } from '../lib/format';
import { actions, tabKey, useStore } from '../lib/store';
import { Status } from '../components/ui';

interface State { summary: DialogueSummary | null; events: DialogueEvent[]; error: string | null }
type Action = { type: 'summary'; summary: DialogueSummary } | { type: 'event'; ev: DialogueEvent } | { type: 'error'; error: string };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'summary': return { ...s, summary: a.summary };
    case 'event':
      if (a.ev.t === 'speaking') return s; // who is speaking lives in the summary
      if (a.ev.t === 'status' && a.ev.status === 'running' && s.events.length === 0) return s; // the opening status is not news
      return { ...s, events: [...s.events, a.ev] };
    case 'error': return { ...s, error: a.error };
  }
}

/** Board-dot state for a dialogue status; the label stays the dialogue's own word. */
export const dialogueDot: Record<DialogueStatus, string> = { running: 'working', paused: 'idle', done: 'done', failed: 'failed', ended: 'ended' };
const over = (st: DialogueStatus) => st === 'ended' || st === 'failed';

export function DialogueView({ id }: { id: string }) {
  const [state, dispatch] = useReducer(reducer, { summary: null, events: [], error: null });
  const chats = useStore(s => s.snapshot?.chats);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [note, setNote] = useState('');
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => subscribe<DialogueEvent | DialogueSummary>(`/api/dialogues/${id}/events`, (data, event) => {
    if (event === 'dialogue') dispatch({ type: 'summary', summary: data as DialogueSummary });
    else dispatch({ type: 'event', ev: data as DialogueEvent });
  }, live => { if (!live) api.dialogue(id).catch(e => dispatch({ type: 'error', error: e.message })); }), [id]);

  useEffect(() => { if (stick.current && log.current) log.current.scrollTop = log.current.scrollHeight; }, [state.events, state.summary?.speaking]);
  useEffect(() => { if (!confirmStop) return; const t = setTimeout(() => setConfirmStop(false), 4000); return () => clearTimeout(t); }, [confirmStop]);
  useEffect(() => { if (!confirmRemove) return; const t = setTimeout(() => setConfirmRemove(false), 4000); return () => clearTimeout(t); }, [confirmRemove]);

  const d = state.summary;
  if (!d) return <div className="m-auto text-[12px] text-fg-muted">{state.error ? `Could not open this dialogue: ${state.error}` : 'Opening dialogue'}</div>;

  const run = (p: Promise<unknown>) => p.catch(e => actions.toast(e.message, 'error'));
  const act = (a: 'pause' | 'resume' | 'stop') => run(api.dialogueAction(id, a));
  const stop = () => { if (!confirmStop) { setConfirmStop(true); return; } setConfirmStop(false); act('stop'); };
  const remove = () => { if (!confirmRemove) { setConfirmRemove(true); return; } run(api.removeDialogue(id).then(() => actions.closeTab(tabKey({ kind: 'dialogue', id })))); };
  const extend = () => { const n = Number(window.prompt('How many more rounds?', '2')); if (n > 0) run(api.extendDialogue(id, n)); };
  const steer = (e?: FormEvent) => { e?.preventDefault(); const t = note.trim(); if (!t) return; setNote(''); run(api.steerDialogue(id, t)); };
  const total = d.rounds * 2;
  const speaker = d.speaking ? d.participants.find(p => p.side === d.speaking) : null;
  const speakerChat = speaker ? chats?.find(c => c.id === speaker.chatId) : null;
  const liveStatus = d.status === 'running' && speakerChat?.status === 'needs-you' ? 'needs-you' : dialogueDot[d.status];
  const liveLabel = liveStatus === 'needs-you' ? `${speaker!.name} needs you` : d.pausePending ? 'pausing' : d.status;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-11 items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-5" title={d.topic}>{d.topic}</div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] leading-4 text-fg-faint mono">
            <span className="num">message {d.turns} of {total}</span><span aria-hidden="true">·</span>
            <span>{d.rounds} round{d.rounds === 1 ? '' : 's'}</span><span aria-hidden="true">·</span>
            <span>≤{d.maxWords} words</span><span aria-hidden="true">·</span>
            <span className="truncate">{shortPath(d.cwd)}</span>
          </div>
        </div>
        <Status state={liveStatus} label={liveLabel} />
        {d.status === 'running' && <button className="btn sm ghost" disabled={d.pausePending} onClick={() => act('pause')} title="Finish the current message, then hold"><Pause size={12} aria-hidden="true" /> Pause</button>}
        {d.status === 'paused' && <button className="btn sm ghost" onClick={() => act('resume')} title="Continue with the next speaker"><Play size={12} aria-hidden="true" /> Resume</button>}
        {!over(d.status) && <button className="btn sm ghost" onClick={extend} title="Add rounds; a finished dialogue continues where it stopped"><Plus size={13} aria-hidden="true" /> Extend</button>}
        <a className="btn sm ghost" href={`/api/dialogues/${id}/transcript.md`} download={`dialogue-${id}.md`} title="Save the transcript as markdown"><Download size={13} aria-hidden="true" /> Transcript</a>
        {!over(d.status) && d.status !== 'done' && <button className={`btn sm ${confirmStop ? 'danger' : 'ghost'}`} onClick={stop} title="End the dialogue and the chats it started"><Square size={12} aria-hidden="true" /> {confirmStop ? 'Click again to stop' : 'Stop'}</button>}
        {(over(d.status) || d.status === 'done') && <button className={`btn sm ${confirmRemove ? 'danger' : 'ghost'}`} onClick={remove} title="Forget this dialogue and end the chats it started"><Trash2 size={12} aria-hidden="true" /> {confirmRemove ? 'Click again to remove' : 'Remove'}</button>}
      </header>

      <div className="grid grid-cols-2 gap-2 border-b border-line bg-surface px-4 py-2">
        {d.participants.map(p => {
          const c = chats?.find(x => x.id === p.chatId);
          return (
            <button key={p.side} className={`flex min-w-0 items-center gap-2 rounded-md border p-2 text-left hover:border-line-strong ${p.side === 'A' ? 'border-line bg-accent-soft' : 'border-line bg-raised'}`}
              onClick={() => actions.go({ kind: 'chat', chatId: p.chatId, title: `${p.name} · ${d.topic.slice(0, 40)}` })} title={`Open ${p.name}'s chat${p.persona ? `\n${p.persona}` : ''}`}>
              <span className="side" aria-hidden="true">{p.side}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-semibold">{p.name}</span>
                <span className="block truncate text-[11px] text-fg-muted">{p.persona || 'no persona given'}</span>
              </span>
              <span className="shrink-0 text-[11px] text-fg-faint mono">{p.model}{p.owned ? '' : ' · attached'}</span>
              {c && <Status state={c.status} className="shrink-0" />}
              <MessageSquare size={13} className="shrink-0 text-fg-faint" aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <div ref={log} className="grid min-h-0 flex-1 auto-rows-max content-start gap-2 overflow-y-auto px-4 py-3" onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {state.events.length === 0 && <div className="msg sys">Starting both chats and briefing the first speaker.</div>}
        {state.events.map((ev, i) => <EventRow key={i} ev={ev} total={total} />)}
        {speaker && d.status === 'running' && (
          <div className={`flex items-center gap-2 px-1 py-1 text-[12px] text-fg-muted ${speaker.side === 'B' ? 'justify-self-end' : ''}`} role="status" aria-live="polite">
            <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
            <span>{speaker.name} is {speakerChat?.status === 'needs-you' ? 'waiting on a permission in its chat' : 'writing'}</span>
          </div>
        )}
        {d.status === 'done' && <div className="msg sys">Dialogue complete. Both chats are still open: Extend to keep it going, open a chat to ask a participant something, or Remove to end them.</div>}
        {d.error && <div className="msg sys err">{d.error}</div>}
      </div>

      <form className="flex gap-2 border-t border-line bg-surface px-4 py-3" onSubmit={steer}>
        <textarea className="input flex-1" rows={2} value={note} disabled={over(d.status)} onChange={e => setNote(e.target.value)}
          placeholder={over(d.status) ? 'This dialogue is over.' : `Moderator note: the next speaker reads it with their message. Enter sends.${d.pendingNotes ? ` ${d.pendingNotes} queued.` : ''}`}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); steer(); } }} />
        <button className="btn primary self-end" type="submit" disabled={over(d.status) || !note.trim()}><Send size={13} aria-hidden="true" /> Note</button>
      </form>
    </div>
  );
}

function EventRow({ ev, total }: { ev: DialogueEvent; total: number }) {
  switch (ev.t) {
    case 'turn': return (
      <div className={`msg turn ${ev.side === 'B' ? 'b' : 'a'}`}>
        <span className="origin"><span className="side" aria-hidden="true">{ev.side}</span>{ev.name} <span className="num text-fg-faint">{ev.turn}/{total}</span>{ev.final ? <span className="text-fg-faint"> · closing</span> : null}</span>
        <div dangerouslySetInnerHTML={{ __html: md(ev.text) }} />
      </div>
    );
    case 'note': return ev.kind === 'moderator'
      ? <div className="msg note"><span className="origin">Moderator note</span>{ev.text}</div>
      : <div className="msg sys">{ev.text}</div>;
    case 'status': return <div className="msg sys">{ev.status}</div>;
    case 'speaking': return null;
  }
}

export type { Side };
