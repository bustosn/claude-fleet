import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { shortPath } from '../lib/format';
import { actions, useStore } from '../lib/store';

const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
/** `new:<model>` starts a fresh chat; `chat:<id>` attaches a live one. */
type Source = string;
interface Draft { name: string; persona: string; source: Source }

const DEFAULTS: [Draft, Draft] = [
  { name: 'Proponent', persona: '', source: 'new:' },
  { name: 'Critic', persona: '', source: 'new:' },
];

/** Form for a new dialogue: a topic, how long, and two participants, each a new chat on a chosen model or a live chat to attach. */
export function NewDialogueView() {
  const snap = useStore(s => s.snapshot);
  const dirs = [...new Set((snap?.repos || []).flatMap(r => r.worktrees.map(w => w.path)))];
  const liveChats = (snap?.chats || []).filter(c => c.status !== 'ended' && !c.dialogueId);
  const defaultModel = snap?.dispatch.defaultModel || 'fable';
  const [topic, setTopic] = useState('');
  const [rounds, setRounds] = useState(6);
  const [maxWords, setMaxWords] = useState(250);
  const [dir, setDir] = useState('');
  const [perm, setPerm] = useState(snap?.dispatch.permissionMode || 'auto');
  const [parts, setParts] = useState<[Draft, Draft]>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const patch = (i: 0 | 1, p: Partial<Draft>) => setParts(ps => { const next: [Draft, Draft] = [{ ...ps[0] }, { ...ps[1] }]; next[i] = { ...next[i], ...p }; return next; });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const participants = parts.map(p => ({ name: p.name.trim(), persona: p.persona.trim(),
        ...(p.source.startsWith('chat:') ? { chatId: p.source.slice(5) } : { model: p.source.slice(4) || defaultModel }) }));
      const d = await api.startDialogue({ topic: topic.trim(), rounds, maxWords, cwd: dir || undefined, permissionMode: perm, participants });
      actions.go({ kind: 'dialogue', id: d.id }, { replace: 'new-dialogue' });
    } catch (err: any) { actions.toast(err.message, 'error'); setBusy(false); }
  };

  return (
    <form className="m-auto w-[760px] max-w-[94%] panel p-5" onSubmit={submit}>
      <h2 className="mb-1 text-[14px] font-semibold">New dialogue</h2>
      <p className="mb-3 text-[12px] text-fg-muted">Two Claude sessions talk about a topic. Fleet relays each message to the other side, counts the rounds, and you can pause, add a moderator note, extend, or stop at any point.</p>
      <label className="mb-3 grid gap-1 text-[12px] text-fg-muted">Topic
        <textarea className="input" rows={3} value={topic} onChange={e => setTopic(e.target.value)} placeholder="What should they talk about? A question, a claim to debate, a design to review." required />
      </label>
      <div className="mb-3 grid grid-cols-4 gap-3">
        <label className="grid gap-1 text-[12px] text-fg-muted">Rounds
          <input className="input" type="number" min={1} max={50} value={rounds} onChange={e => setRounds(Number(e.target.value))} title="One round is a message from each side" />
        </label>
        <label className="grid gap-1 text-[12px] text-fg-muted">Words per message
          <input className="input" type="number" min={50} max={2000} step={50} value={maxWords} onChange={e => setMaxWords(Number(e.target.value))} />
        </label>
        <label className="grid gap-1 text-[12px] text-fg-muted">Working directory
          <select className="input" value={dir} onChange={e => setDir(e.target.value)} title="Where new participant chats start. The scratch folder has no project instructions, so the chats stay on topic.">
            <option value="">Fleet scratch folder</option>
            {dirs.map(d => <option key={d} value={d}>{shortPath(d)}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-[12px] text-fg-muted">Permissions
          <select className="input" value={perm} onChange={e => setPerm(e.target.value)}>
            <option value="auto">auto</option><option value="default">ask</option><option value="acceptEdits">acceptEdits</option><option value="plan">plan</option>
          </select>
        </label>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3">
        {parts.map((p, i) => (
          <fieldset key={i} className={`grid gap-2 rounded-md border border-line p-3 ${i === 0 ? 'bg-accent-soft/40' : 'bg-raised/60'}`}>
            <legend className="px-1 text-[11px] font-semibold text-fg-muted"><span className="side" aria-hidden="true">{i === 0 ? 'A' : 'B'}</span> {i === 0 ? 'Speaks first' : 'Replies'}</legend>
            <label className="grid gap-1 text-[12px] text-fg-muted">Name
              <input className="input" value={p.name} onChange={e => patch(i as 0 | 1, { name: e.target.value })} required />
            </label>
            <label className="grid gap-1 text-[12px] text-fg-muted">Persona and stance
              <textarea className="input" rows={3} value={p.persona} onChange={e => patch(i as 0 | 1, { persona: e.target.value })}
                placeholder={i === 0 ? 'e.g. A staff engineer who has shipped this pattern and defends it from experience.' : 'e.g. A sceptical reviewer who pushes for evidence and concrete failure cases.'} />
            </label>
            <label className="grid gap-1 text-[12px] text-fg-muted">Session
              <select className="input" value={p.source} onChange={e => patch(i as 0 | 1, { source: e.target.value })}>
                <optgroup label="New chat">
                  <option value="new:">new chat · {defaultModel} (default)</option>
                  {MODELS.filter(m => m !== defaultModel).map(m => <option key={m} value={`new:${m}`}>new chat · {m}</option>)}
                </optgroup>
                {liveChats.length > 0 && (
                  <optgroup label="Attach a live chat (keeps its context; not ended when the dialogue finishes)">
                    {liveChats.map(c => <option key={c.id} value={`chat:${c.id}`}>{c.title} · {c.repo ? `${c.repo} / ${c.branch || ''}` : shortPath(c.cwd)} · {c.model}</option>)}
                  </optgroup>
                )}
              </select>
            </label>
          </fieldset>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-fg-faint">{rounds * 2} messages in total. Each side's context grows with every round.</span>
        <button type="button" className="btn" onClick={() => actions.closeTab('new-dialogue')}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || !topic.trim() || !parts[0].name.trim() || !parts[1].name.trim()}>{busy ? 'Starting' : 'Start dialogue'}</button>
      </div>
    </form>
  );
}
