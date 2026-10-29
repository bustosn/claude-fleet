import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent, type MouseEvent } from 'react';
import { ArrowRightLeft, ExternalLink, ListPlus, Plus, RefreshCw } from 'lucide-react';
import { api, type JiraBoard, type JiraCard, type JiraCreateInfo } from '../lib/api';
import { age } from '../lib/format';
import { actions, useStore } from '../lib/store';
import { useContextMenu } from '../components/ContextMenu';
import { Empty } from '../components/ui';
import { CodeTextarea } from '../components/CodeTextarea';
import { MOD } from '../lib/platform';

// Status category to the board's dot colors: to do, in progress, done.
const dotFor: Record<string, string> = { new: 'idle', indeterminate: 'working', done: 'done' };

/** Your Jira tickets as columns by status. Drag a card to another column, or use Move, to transition it in Jira.
 *  The query and column order come from jira.board in fleet.config.json. */
export function JiraView({ create }: { create: boolean }) {
  const enabled = useStore(s => s.snapshot?.jira?.enabled);
  const [board, setBoard] = useState<JiraBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(create);
  // Keys being moved, so their cards show it and can't be moved twice.
  const [moving, setMoving] = useState<Record<string, boolean>>({});
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [menu, openMenu] = useContextMenu();
  // The project picked in the switcher, remembered across visits. Unset means the server's default: the first configured project.
  const [project, setProject] = useState<string | undefined>(() => localStorage.getItem('fleet.jira.project') || undefined);
  const pick = (key: string) => { localStorage.setItem('fleet.jira.project', key); setBoard(null); setProject(key); };

  const showing = useRef(project); showing.current = project;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const b = await api.jiraBoard(project);
      // Switched projects while this was loading: the answer is for the old one.
      if (showing.current === project) { setBoard(b); setError(null); }
    } catch (err: any) { if (showing.current === project) setError(err.message); } finally { setLoading(false); }
  }, [project]);
  useEffect(() => { setCreating(create); }, [create]);
  useEffect(() => {
    if (!enabled) return;
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [enabled, load]);

  // Shows the card in its new column right away; the reload afterwards puts it wherever Jira says it is.
  const move = async (card: JiraCard, by: { id?: string; to?: string }, toName: string) => {
    if (moving[card.key] || card.status === toName) return;
    setMoving(m => ({ ...m, [card.key]: true }));
    setBoard(b => b && { ...b, issues: b.issues.map(i => i.key === card.key ? { ...i, status: toName } : i) });
    try { await api.jiraMove(card.key, by); actions.toast(`${card.key} → ${toName}`); }
    catch (err: any) { actions.toast(err.message, 'error'); }
    finally { setMoving(m => { const { [card.key]: _, ...rest } = m; return rest; }); load(); }
  };

  // The moves are fetched first, and the event is spent by then; the menu opens at where the click was, or under the button.
  const openMove = async (e: MouseEvent, card: JiraCard) => {
    const el = e.currentTarget as HTMLElement, box = el.getBoundingClientRect();
    const at = { clientX: e.clientX || box.left, clientY: e.clientY || box.bottom, currentTarget: el, preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent;
    try {
      const ts = await api.jiraTransitions(card.key);
      openMenu(at, ts.length ? ts.map(t => ({ label: t.name === t.to ? t.to : `${t.name} → ${t.to}`, onSelect: () => move(card, { id: t.id }, t.to) }))
        : [{ label: 'No moves from this status', disabled: true, onSelect: () => {} }]);
    } catch (err: any) { actions.toast(err.message, 'error'); }
  };

  if (!enabled) return (
    <Empty title="Jira is not connected">
      Add a <span className="mono">jira</span> section to fleet.config.json and set <span className="mono">JIRA_API_TOKEN</span>, then restart Fleet. JIRA-SETUP.md in the Fleet folder walks through it.
    </Empty>
  );

  const onDrop = (e: DragEvent, column: string) => {
    e.preventDefault(); setDropOn(null);
    const card = board?.issues.find(i => i.key === e.dataTransfer.getData('text/x-jira-key'));
    if (card) move(card, { to: column }, column);
  };

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_auto_1fr] gap-3 p-4">
      {menu}
      <div className="flex items-center gap-3">
        <h2 className="text-[14px] font-semibold">Jira</h2>
        {board && board.projects.length > 0 && (
          <div className="flex items-center gap-1" role="tablist" aria-label="Project">
            {[...board.projects, { key: 'all', name: 'All' }].map(p => {
              const on = (board.project ?? 'all') === p.key;
              return <button key={p.key} role="tab" aria-selected={on} className={`btn sm ${on ? 'primary' : 'ghost'}`} title={p.key === 'all' ? 'Every project' : p.key} onClick={() => !on && pick(p.key)}>{p.name}</button>;
            })}
          </div>
        )}
        {board && <span className="num truncate text-[11px] text-fg-muted" title={board.jql}>{board.issues.length} ticket{board.issues.length === 1 ? '' : 's'} · updated {age(board.fetchedAt)} ago</span>}
        {error && <span className="truncate text-[11px] text-crit" title={error}>{error}</span>}
        <button className="btn sm ghost ml-auto" disabled={loading} onClick={load} title={board?.jql}><RefreshCw size={13} className={loading ? 'animate-spin' : ''} aria-hidden="true" /> Refresh</button>
        <button className="btn primary sm" onClick={() => setCreating(c => !c)}><Plus size={13} aria-hidden="true" /> New ticket</button>
      </div>
      {creating ? <CreateForm project={board?.project || undefined} onClose={() => setCreating(false)} onCreated={load} /> : <div />}
      {!board && !error && <div className="text-[12px] text-fg-muted">Loading tickets…</div>}
      {board && (
        <div className="flex min-h-0 gap-3 overflow-x-auto pb-1">
          {board.columns.map(col => {
            const list = board.issues.filter(i => i.status === col.name);
            return (
              <section key={col.name} className={`panel flex min-h-0 w-[280px] shrink-0 flex-col p-2 ${dropOn === col.name ? 'ring-2 ring-accent' : ''}`}
                onDragOver={e => { if (e.dataTransfer.types.includes('text/x-jira-key')) { e.preventDefault(); setDropOn(col.name); } }}
                onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOn(null); }}
                onDrop={e => onDrop(e, col.name)}>
                <div className="section-title"><span className="dot" data-s={dotFor[col.category] || 'idle'} aria-hidden="true" />{col.name}<span className="count num">{list.length}</span></div>
                <div className="grid min-h-0 content-start gap-1.5 overflow-y-auto">
                  {list.length === 0 && <div className="px-2 py-3 text-[11px] text-fg-faint">Drop a ticket here to move it</div>}
                  {list.map(card => <Card key={card.key} card={card} busy={!!moving[card.key]} onMove={e => openMove(e, card)} />)}
                </div>
              </section>
            );
          })}
          {board.columns.length === 0 && <div className="text-[12px] text-fg-muted">No tickets match <span className="mono">{board.jql}</span>.</div>}
        </div>
      )}
    </div>
  );
}

function Card({ card, busy, onMove }: { card: JiraCard; busy: boolean; onMove: (e: MouseEvent) => void }) {
  const onTask = useStore(s => s.snapshot?.tasks.find(t => t.ticket === card.key && t.status !== 'done'));
  return (
    <div draggable={!busy} onDragStart={e => { e.dataTransfer.setData('text/x-jira-key', card.key); e.dataTransfer.effectAllowed = 'move'; }}
      className={`min-w-0 cursor-grab rounded-xl border border-line bg-raised p-2.5 shadow-[var(--shadow-sm)] active:cursor-grabbing ${busy ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-2">
        <a className="mono shrink-0 text-[11px] text-accent hover:underline" href={card.url} target="_blank" rel="noreferrer" title="Open in Jira">{card.key}</a>
        <span className="truncate text-[11px] text-fg-faint">{[card.type, card.priority].filter(Boolean).join(' · ')}</span>
        <span className="num ml-auto shrink-0 text-[10px] text-fg-faint" title={new Date(card.updated).toLocaleString()}>{age(card.updated)}</span>
      </div>
      <div className="mt-1 line-clamp-3 text-[12px] font-medium">{card.summary}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <button className="btn sm ghost" style={{ height: 22, padding: '0 8px' }} disabled={busy} onClick={onMove} title="Move to another status">
          <ArrowRightLeft size={12} aria-hidden="true" /> {busy ? 'Moving' : 'Move'}
        </button>
        {onTask ? <span className="chip" title="Already a task on the board">task: {onTask.status}</span>
          : <button className="btn sm ghost" style={{ height: 22, padding: '0 8px' }} title="Queue a Fleet task built from this ticket" onClick={() => actions.go({ kind: 'new-task', ticket: card.key })}><ListPlus size={12} aria-hidden="true" /> Task</button>}
        <a className="btn sm ghost ml-auto" style={{ height: 22, padding: '0 6px' }} href={card.url} target="_blank" rel="noreferrer" aria-label={`Open ${card.key} in Jira`}><ExternalLink size={12} aria-hidden="true" /></a>
      </div>
    </div>
  );
}

/** A new ticket. Defaults and any fields your Jira requires (set after creation, in order) come from jira.create in fleet.config.json. */
function CreateForm({ project: shown, onClose, onCreated }: { project?: string; onClose: () => void; onCreated: () => void }) {
  const [info, setInfo] = useState<JiraCreateInfo | null>(null);
  const [types, setTypes] = useState<{ id: string; name: string }[]>([]);
  const [project, setProject] = useState('');
  const [type, setType] = useState('');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [assignToMe, setAssignToMe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The project on screen, if one is picked; otherwise jira.create.project.
    api.jiraCreateInfo().then(i => { setInfo(i); setProject(shown && i.projects.some(p => p.key === shown) ? shown : i.project); setAssignToMe(i.assignToMe); setDescription(i.template); }).catch(e => setError(e.message));
  }, []);
  useEffect(() => {
    if (!project) return;
    let live = true;
    api.jiraIssueTypes(project).then(ts => {
      if (!live) return;
      setTypes(ts);
      setType(t => ts.some(x => x.name === t) ? t : ts.find(x => x.name === info?.issueType)?.name || ts[0]?.name || '');
    }).catch(e => live && setError(e.message));
    return () => { live = false; };
  }, [project]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!summary.trim() || !project || !type) return;
    setBusy(true); setError(null);
    try {
      const made = await api.jiraCreate({ project, issueType: type, summary, description, assignToMe });
      if (made.warnings.length) actions.toast(`Created ${made.key}, but: ${made.warnings.join(' ')}`, 'error');
      else actions.toast(`Created ${made.key}`);
      setSummary(''); setDescription(info?.template || '');
      onCreated(); onClose();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <form className="panel grid max-w-[760px] gap-3 p-4" onSubmit={submit}>
      <div className="flex items-center gap-2">
        <h3 className="text-[13px] font-semibold">New ticket</h3>
        {!info && !error && <span className="text-[11px] text-fg-faint">Loading projects…</span>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1 text-[12px] text-fg-muted">Project
          <select className="input" value={project} onChange={e => setProject(e.target.value)} disabled={!info}>
            {info?.projects.map(p => <option key={p.key} value={p.key}>{p.name} ({p.key})</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-[12px] text-fg-muted">Type
          <select className="input" value={type} onChange={e => setType(e.target.value)} disabled={!types.length}>
            {types.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
        </label>
      </div>
      <label className="grid gap-1 text-[12px] text-fg-muted">Summary
        <input className="input" value={summary} onChange={e => setSummary(e.target.value)} placeholder="One line: what needs doing" autoFocus />
      </label>
      <label className="grid gap-1 text-[12px] text-fg-muted">Description <span className="text-fg-faint">(blank lines split paragraphs; <span className="mono"># </span>starts a heading, <span className="mono">- </span>a bullet)</span>
        <CodeTextarea className="input" wrapClass="rich-boxed" rows={8} value={description} onChange={setDescription}
          placeholder={`What and why. ${MOD}Enter creates it.`}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!busy) e.currentTarget.form?.requestSubmit(); } if (e.key === 'Escape') onClose(); }} />
      </label>
      <label className="flex items-center gap-2 text-[12px] text-fg-muted">
        <input type="checkbox" checked={assignToMe} onChange={e => setAssignToMe(e.target.checked)} /> Assign to me
      </label>
      {error && <div className="text-[12px] text-crit">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || !summary.trim() || !project || !type}>{busy ? 'Creating' : 'Create ticket'}</button>
      </div>
    </form>
  );
}
