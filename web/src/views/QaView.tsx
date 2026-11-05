import { useEffect, useState, type FormEvent } from 'react';
import { Download, Play, Plus, RefreshCw, ShieldCheck, Square, Trash2, X } from 'lucide-react';
import { api, subscribe, type QaEvent, type QaGroup, type QaRunDetail, type QaRunSummary } from '../lib/api';
import { md } from '../lib/markdown';
import { age, shortPath } from '../lib/format';
import { actions, tabKey, useStore } from '../lib/store';
import { Empty, Status } from '../components/ui';

/** QA runs (docs/plans/04-qa.md, QA1): the list with a New run form, or one run with its findings, agents, log and report. */
export function QaView({ id }: { id?: string }) {
  return id ? <QaRun id={id} /> : <QaList />;
}

const phaseDot = (r: QaRunSummary) => r.phase === 'done' ? (r.stale ? 'stale' : 'done') : r.phase === 'failed' ? 'failed' : r.paused ? 'idle' : 'working';
const phaseLabel = (r: QaRunSummary) => r.paused ? `paused at ${r.phase}` : r.stale && r.phase === 'done' ? 'done · stale' : r.phase;
const money = (n: number) => `$${n.toFixed(2)}`;

function QaList() {
  const [runs, setRuns] = useState<QaRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const load = () => api.qaRuns().then(r => { setRuns(r); setError(null); }).catch(e => setError(e.message));
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-11 items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <ShieldCheck size={15} className="text-fg-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1 text-[13px] font-semibold">QA runs</div>
        <button className="btn sm ghost" onClick={load} title="Reload"><RefreshCw size={12} aria-hidden="true" /></button>
        <button className="btn sm primary" onClick={() => setCreating(c => !c)}>{creating ? <><X size={12} aria-hidden="true" /> Close</> : <><Plus size={13} aria-hidden="true" /> New run</>}</button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {creating && <NewRun onStarted={r => { setCreating(false); load(); actions.go({ kind: 'qa', id: r.id }); }} />}
        {error && <div className="msg sys err">{error}</div>}
        {runs && !runs.length && !creating && <Empty title="No QA runs yet">Start one on a branch: fresh reviewer chats read the diff and the code around it, a verifier attacks every finding, and you get one report.</Empty>}
        <div className="grid gap-2">
          {runs?.map(r => (
            <button key={r.id} className="flex min-w-0 items-center gap-3 rounded-md border border-line bg-surface p-3 text-left hover:border-line-strong" onClick={() => actions.go({ kind: 'qa', id: r.id })}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold">{r.title}</div>
                <div className="mt-0.5 truncate text-[11px] text-fg-faint mono">{r.id} · {r.profile} · {r.targets.map(t => `${t.name}@${t.headSha.slice(0, 9)}`).join(' + ') || 'resolving targets'} · {age(r.createdAt)}</div>
              </div>
              <Counts r={r} />
              <Status state={phaseDot(r)} label={phaseLabel(r)} className="shrink-0" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Counts({ r }: { r: QaRunSummary }) {
  const c = r.counts;
  if (!c.findings) return null;
  return (
    <span className="shrink-0 text-[11px] text-fg-muted num">
      {c.blocker ? <b className="text-crit">{c.blocker} blocker </b> : null}{c.major ? <b>{c.major} major </b> : null}{c.minor ? `${c.minor} minor ` : ''}
      <span className="text-fg-faint">· {c.groups} groups · {c.rejected} rejected</span>
    </span>
  );
}

interface TargetRow { repo: string; head: string; pr: string; prTitle: string; prBody: string }
const blankTarget = (): TargetRow => ({ repo: '', head: '', pr: '', prTitle: '', prBody: '' });

function NewRun({ onStarted }: { onStarted: (r: QaRunSummary) => void }) {
  const repos = useStore(s => s.snapshot?.repos || []);
  const [targets, setTargets] = useState<TargetRow[]>([blankTarget()]);
  const [jiraKey, setJiraKey] = useState('');
  const [ticketText, setTicketText] = useState('');
  const [profile, setProfile] = useState('auto');
  const [busy, setBusy] = useState(false);
  const set = (i: number, patch: Partial<TargetRow>) => setTargets(ts => ts.map((t, j) => j === i ? { ...t, ...patch } : t));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api.startQa({ jiraKey: jiraKey.trim() || undefined, ticketText: ticketText.trim() || undefined, profile,
        targets: targets.filter(t => t.repo.trim()).map(t => ({ repo: t.repo.trim(), head: t.head.trim() || undefined, pr: Number(t.pr) || undefined, prTitle: t.prTitle.trim() || undefined, prBody: t.prBody.trim() || undefined })) });
      onStarted(r);
    } catch (err: any) { actions.toast(err.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <form className="mb-4 grid gap-3 rounded-md border border-line bg-surface p-3" onSubmit={submit}>
      <div className="text-[12px] text-fg-muted">Targets are a repo and a head (a branch or commit). The base is the merge base with the remote default branch. PR text is read with <span className="mono">gh</span> when it is installed; otherwise paste it.</div>
      {targets.map((t, i) => (
        <div key={i} className="grid gap-2 rounded-md border border-line p-2">
          <div className="flex gap-2">
            <input className="input flex-1" list="qa-repos" placeholder="Repo (name under reposRoot, or a folder)" value={t.repo} onChange={e => set(i, { repo: e.target.value })} required={i === 0} />
            <input className="input w-56" placeholder="Head (branch or sha; default HEAD)" value={t.head} onChange={e => set(i, { head: e.target.value })} />
            <input className="input w-20" placeholder="PR #" value={t.pr} onChange={e => set(i, { pr: e.target.value })} />
            {targets.length > 1 && <button type="button" className="btn sm ghost" onClick={() => setTargets(ts => ts.filter((_, j) => j !== i))} title="Remove this target"><X size={12} aria-hidden="true" /></button>}
          </div>
          <input className="input" placeholder="PR title (optional)" value={t.prTitle} onChange={e => set(i, { prTitle: e.target.value })} />
          <textarea className="input" rows={2} placeholder="PR description (optional; paste when gh is not installed)" value={t.prBody} onChange={e => set(i, { prBody: e.target.value })} />
        </div>
      ))}
      <datalist id="qa-repos">{repos.map(r => <option key={r.path} value={r.name}>{shortPath(r.path)}</option>)}</datalist>
      <div><button type="button" className="btn sm ghost" onClick={() => setTargets(ts => [...ts, blankTarget()])}><Plus size={12} aria-hidden="true" /> Another repo</button></div>
      <div className="flex gap-2">
        <input className="input w-36" placeholder="Jira key" value={jiraKey} onChange={e => setJiraKey(e.target.value)} />
        <select className="input w-48" value={profile} onChange={e => setProfile(e.target.value)} aria-label="Profile">
          <option value="auto">Profile from the diff</option><option value="quick">quick</option><option value="standard">standard</option><option value="deep">deep</option>
        </select>
      </div>
      <textarea className="input" rows={3} placeholder="Ticket text (optional; read from Jira when it is configured)" value={ticketText} onChange={e => setTicketText(e.target.value)} />
      <div><button className="btn primary" type="submit" disabled={busy}><Play size={12} aria-hidden="true" /> {busy ? 'Starting…' : 'Start QA run'}</button></div>
    </form>
  );
}

type Tab = 'findings' | 'agents' | 'log' | 'report';

function QaRun({ id }: { id: string }) {
  const [d, setD] = useState<QaRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('findings');
  const [report, setReport] = useState<string>('');
  const [confirm, setConfirm] = useState<'stop' | 'remove' | null>(null);

  // The stream carries the summary and the log; the full detail (findings, agents) is refetched when the summary changes, at most once a second.
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | null = null;
    const refetch = () => { if (pending) return; pending = setTimeout(() => { pending = null; api.qaRun(id).then(setD).catch(e => setError(e.message)); }, 800); };
    const off = subscribe<QaRunDetail | QaEvent>(`/api/qa/${id}/events`, (data, event) => {
      if (event === 'detail') setD(data as QaRunDetail);
      else { const ev = data as QaEvent; if (ev.t === 'log') setD(x => x && { ...x, log: [...x.log, { at: ev.at, text: ev.text }] }); else refetch(); }
    }, live => { if (!live) api.qaRun(id).then(setD).catch(e => setError(e.message)); });
    return () => { off(); if (pending) clearTimeout(pending); };
  }, [id]);
  useEffect(() => { if (tab === 'report') api.qaReport(id).then(setReport).catch(e => setReport(`Could not load the report: ${e.message}`)); }, [tab, id, d?.updatedAt]);
  useEffect(() => { if (!confirm) return; const t = setTimeout(() => setConfirm(null), 4000); return () => clearTimeout(t); }, [confirm]);

  if (!d) return <div className="m-auto text-[12px] text-fg-muted">{error ? `Could not open this run: ${error}` : 'Opening QA run'}</div>;
  const running = d.phase !== 'done' && d.phase !== 'failed' && !d.paused;
  const run = (p: Promise<unknown>) => p.catch(e => actions.toast(e.message, 'error'));
  const stop = () => { if (confirm !== 'stop') { setConfirm('stop'); return; } setConfirm(null); run(api.qaAction(id, 'stop')); };
  const remove = () => { if (confirm !== 'remove') { setConfirm('remove'); return; } run(api.removeQa(id).then(() => actions.closeTab(tabKey({ kind: 'qa', id })))); };
  const c = d.cost;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-11 items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold" title={d.title}>{d.title}</div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] leading-4 text-fg-faint mono">
            <span>{d.id}</span><span aria-hidden="true">·</span><span>{d.profile}</span><span aria-hidden="true">·</span>
            {d.targets.map(t => <span key={t.name}>{t.name}@{t.headSha.slice(0, 9)}{t.pr ? ` #${t.pr}` : ''}</span>)}
            <span aria-hidden="true">·</span><span className="num">{c.agents} agents · {Math.round((c.inputTokens + c.outputTokens) / 1000)}k tokens · {money(c.costUsd)} · {Math.round(c.ms / 60000)} min</span>
          </div>
        </div>
        <Counts r={d} />
        <Status state={phaseDot(d)} label={phaseLabel(d)} />
        {d.paused && <button className="btn sm ghost" onClick={() => run(api.qaAction(id, 'resume'))} title="Continue at the phase it stopped in"><Play size={12} aria-hidden="true" /> Resume</button>}
        {running && <button className={`btn sm ${confirm === 'stop' ? 'danger' : 'ghost'}`} onClick={stop}><Square size={12} aria-hidden="true" /> {confirm === 'stop' ? 'Click again to stop' : 'Stop'}</button>}
        <a className="btn sm ghost" href={`/api/qa/${id}/report.md`} download={`qa-${id}.md`} title="Save the report as markdown"><Download size={13} aria-hidden="true" /> Report</a>
        {!running && <button className={`btn sm ${confirm === 'remove' ? 'danger' : 'ghost'}`} onClick={remove} title="Forget this run and its pack"><Trash2 size={12} aria-hidden="true" /> {confirm === 'remove' ? 'Click again to remove' : 'Remove'}</button>}
      </header>
      <nav className="flex gap-1 border-b border-line bg-surface px-4 py-1.5" aria-label="QA run sections">
        {(['findings', 'agents', 'log', 'report'] as Tab[]).map(t => (
          <button key={t} className={`btn sm ${tab === t ? 'primary' : 'ghost'}`} onClick={() => setTab(t)}>{t === 'findings' ? `Findings (${d.groups.length || d.findings.length})` : t === 'agents' ? `Agents (${d.agents.length})` : t === 'log' ? 'Log' : 'Report'}</button>
        ))}
      </nav>
      {d.error && <div className="msg sys err mx-4 mt-3">{d.error}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {tab === 'findings' && <Findings d={d} />}
        {tab === 'agents' && <Agents d={d} />}
        {tab === 'log' && <div className="grid gap-0.5 text-[12px] mono">{d.log.map((l, i) => <div key={i}><span className="text-fg-faint">{new Date(l.at).toLocaleTimeString()}</span> {l.text}</div>)}</div>}
        {tab === 'report' && <div className="msg turn a" dangerouslySetInnerHTML={{ __html: md(report) }} />}
      </div>
    </div>
  );
}

const SEV = { blocker: 0, major: 1, minor: 2 } as const;
function Findings({ d }: { d: QaRunDetail }) {
  const [verdict, setVerdict] = useState('live');
  if (!d.findings.length) return <Empty title={d.phase === 'lenses' || d.phase === 'pack' || d.phase === 'intake' ? 'Reviewing' : 'No findings'}>{d.phase === 'done' ? 'The lenses reported nothing; their checked items are in the report.' : 'Findings show here as the lenses report them.'}</Empty>;
  const byId = new Map(d.findings.map(f => [f.id, f]));
  // Before dedupe, every finding is its own card.
  const groups: QaGroup[] = d.groups.length ? d.groups : d.findings.map(f => ({ id: f.id, title: f.title, rootCause: '', findingIds: [f.id], lenses: f.lenses }));
  const shown = groups.filter(g => verdict === 'all' || (verdict === 'live' ? g.verdict !== 'REJECTED' : g.verdict === verdict))
    .sort((a, b) => (SEV[a.severity || 'minor'] - SEV[b.severity || 'minor']) || (a.verdict === 'CONFIRMED' ? -1 : 1));
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <select className="input w-56" value={verdict} onChange={e => setVerdict(e.target.value)} aria-label="Filter by verdict">
          <option value="live">Not rejected</option><option value="CONFIRMED">Confirmed</option><option value="PLAUSIBLE">Plausible</option><option value="REJECTED">Rejected</option><option value="all">All</option>
        </select>
        <span className="text-[11px] text-fg-faint">{shown.length} shown</span>
      </div>
      {shown.map(g => {
        const ms = g.findingIds.map(x => byId.get(x)).filter(Boolean) as QaRunDetail['findings'];
        const lead = ms[0];
        return (
          <details key={g.id} className="rounded-md border border-line bg-surface p-3">
            <summary className="cursor-pointer text-[13px]">
              <span className={`mr-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase mono ${g.severity === 'blocker' ? 'bg-crit-soft text-crit' : 'bg-raised text-fg-muted'}`}>{g.severity || '—'}</span>
              <span className="mr-2 text-[11px] text-fg-faint mono">{g.verdict || (d.phase === 'verify' ? 'verifying' : 'unverified')}</span>
              <span className="font-semibold">{g.title}</span>
              <span className="ml-2 text-[11px] text-fg-faint">{g.lenses.join(', ')}{ms.length > 1 ? ` · ${ms.length} reports` : ''}</span>
            </summary>
            {lead && <div className="mt-2 grid gap-2 text-[12px]">
              {g.rootCause && <div><b>Root cause:</b> {g.rootCause}</div>}
              <div><b>Scenario:</b> {lead.scenario}</div>
              <div className="mono text-[11px] text-fg-muted">{[...new Set(ms.flatMap(f => f.refs.map(r => `${r.repo}/${r.file}:${r.line}`)))].join('  ')}</div>
              {lead.suggestedFix && <div><b>Suggested fix:</b> {lead.suggestedFix}</div>}
              {g.verdictReason && <div><b>Verifier:</b> {g.verdictReason}</div>}
              {g.settle && <div><b>What would settle it:</b> {g.settle}</div>}
              {ms.slice(1).map(f => <div key={f.id} className="text-fg-muted">· ({f.lenses.join(', ')}) <b>{f.title}</b>: {f.scenario}</div>)}
            </div>}
          </details>
        );
      })}
    </div>
  );
}

function Agents({ d }: { d: QaRunDetail }) {
  return (
    <table className="w-full text-[12px]">
      <thead className="text-left text-[11px] text-fg-faint"><tr><th className="py-1">Agent</th><th>Model</th><th>Status</th><th className="text-right">Results</th><th className="text-right">Tokens</th><th className="text-right">Cost</th><th /></tr></thead>
      <tbody>
        {d.agents.map(a => {
          const n = a.role === 'lens' ? `${d.findings.filter(f => f.agentId === a.id).length} found · ${d.checked.filter(c => c.agentId === a.id).length} checked` : a.role === 'verifier' ? `${(a.groupIds || []).filter(g => d.groups.find(x => x.id === g)?.verdict).length}/${(a.groupIds || []).length} verdicts` : '';
          return (
            <tr key={a.id} className="border-t border-line">
              <td className="py-1.5"><span className="font-semibold">{a.label}</span> <span className="text-fg-faint">{a.role}</span>{a.error && <div className="text-crit">{a.error}</div>}</td>
              <td className="mono">{a.model}</td>
              <td><Status state={a.status === 'running' ? 'working' : a.status === 'queued' ? 'idle' : a.status} label={a.status} /></td>
              <td className="text-right num">{n}</td>
              <td className="text-right num">{Math.round((a.inputTokens + a.outputTokens) / 1000)}k</td>
              <td className="text-right num">{money(a.costUsd)}</td>
              <td className="text-right">
                {a.status === 'running' && a.chatId && <button className="btn sm ghost" onClick={() => actions.go({ kind: 'chat', chatId: a.chatId!, title: `QA ${d.id} · ${a.label}` })}>Watch</button>}
                {a.status !== 'running' && a.sessionId && <button className="btn sm ghost" onClick={() => actions.go({ kind: 'resume', sessionId: a.sessionId!, cwd: a.cwd, title: `QA ${d.id} · ${a.label}` })} title="Opens the saved transcript as a new chat">Transcript</button>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
