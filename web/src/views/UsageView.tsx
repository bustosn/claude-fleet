import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, type UsageReport, type UsageTotals } from '../lib/api';
import { fmtTokens } from '../lib/format';

const RANGES = [{ days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 90, label: '90 days' }, { days: 0, label: 'All time' }];
type Metric = 'output' | 'fresh' | 'total' | 'messages';
const METRICS: { id: Metric; label: string; of: (t: UsageTotals) => number }[] = [
  { id: 'output', label: 'Output', of: t => t.output },
  { id: 'fresh', label: 'Input', of: t => t.input + t.cacheWrite },
  { id: 'total', label: 'All tokens', of: t => t.input + t.output + t.cacheRead + t.cacheWrite },
  { id: 'messages', label: 'Messages', of: t => t.messages },
];
const SERIES = ['var(--accent)', 'var(--good)', 'var(--warn)', 'var(--serious)', 'var(--crit)', 'var(--fg-faint)'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const num = (n: number) => n.toLocaleString();
const everything = (t: UsageTotals) => t.input + t.output + t.cacheRead + t.cacheWrite;
/** claude-opus-5-5 → Opus 5.5, claude-3-5-sonnet-20241022 → Sonnet 3.5 */
function modelName(id: string) {
  const m = /(opus|sonnet|haiku|fable)/i.exec(id);
  if (!m) return id;
  const ver = id.replace(/^claude-/, '').replace(m[1], '').replace(/-\d{8}$/, '').split('-').filter(Boolean).join('.');
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}${ver ? ` ${ver}` : ''}`;
}
const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

/** What your Claude chats have used, read from the transcripts on this machine. Tokens only: the transcripts carry no prices or plan limits. */
export function UsageView() {
  const [days, setDays] = useState(() => { const v = Number(localStorage.getItem('fleet.usage.days')); return RANGES.some(r => r.days === v) ? v : 30; });
  const [metric, setMetric] = useState<Metric>('output');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setReport(await api.usage(days)); setError(null); } catch (err: any) { setError(err.message); } finally { setLoading(false); }
  }, [days]);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  const pick = (d: number) => { try { localStorage.setItem('fleet.usage.days', String(d)); } catch {} setDays(d); };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-[1180px] content-start gap-4 p-5">
        <header className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="m-0 text-[17px] font-semibold tracking-tight">Usage</h1>
            <p className="m-0 mt-0.5 text-[12px] text-fg-faint">Read from your Claude transcripts on this machine. Counts tokens, not dollars.</p>
          </div>
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map(r => <button key={r.days} aria-pressed={days === r.days} onClick={() => pick(r.days)}>{r.label}</button>)}
          </div>
          <button className="iconbtn" aria-label="Refresh" title="Refresh" onClick={load}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" /></button>
        </header>

        {error && <div className="panel p-4 text-[12px] text-crit">Could not read usage: {error}</div>}
        {!report && !error && <div className="panel p-10 text-center text-[12px] text-fg-faint">Reading transcripts… the first time takes a few seconds.</div>}
        {report && report.total.messages === 0 && <div className="panel p-10 text-center text-[12px] text-fg-faint">No Claude messages in this range.</div>}
        {report && report.total.messages > 0 && <Body r={report} metric={metric} setMetric={setMetric} />}
      </div>
    </div>
  );
}

function Body({ r, metric, setMetric }: { r: UsageReport; metric: Metric; setMetric: (m: Metric) => void }) {
  const t = r.total;
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  const hit = prompt ? t.cacheRead / prompt : 0;
  const perActive = r.activeDays ? t.output / r.activeDays : 0;
  return (
    <>
      <section className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(170px,1fr))]">
        <Stat label="All tokens" value={fmtTokens(everything(t))} sub={`${fmtTokens(t.cacheRead)} read from cache`} />
        <Stat label="Output" value={fmtTokens(t.output)} sub={`${fmtTokens(perActive)} per active day`} />
        <Stat label="Fresh input" value={fmtTokens(t.input + t.cacheWrite)} sub={`${fmtTokens(t.cacheWrite)} written to cache`} />
        <Stat label="Cache hit rate" value={`${Math.round(hit * 100)}%`} sub="of prompt tokens served from cache" meter={hit} />
        <Stat label="Messages" value={num(t.messages)} sub={`${num(r.sessions)} conversations`} />
        <Stat label="Active days" value={String(r.activeDays)} sub={`streak ${r.currentStreak}, best ${r.longestStreak}`} />
      </section>

      <DailyChart r={r} metric={metric} setMetric={setMetric} />

      <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(380px,1fr))]">
        <Models r={r} />
        <Projects r={r} />
      </div>
      <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(380px,1fr))]">
        <Rhythm title="Time of day" sub="messages by hour you sent them" values={r.hours} label={h => (h % 6 === 0 ? `${h % 12 || 12}${h < 12 ? 'a' : 'p'}` : '')} tip={h => `${h % 12 || 12}${h < 12 ? ' am' : ' pm'}`} />
        <Rhythm title="Day of week" sub="messages by weekday" values={r.weekdays} label={d => WEEKDAYS[d]} tip={d => WEEKDAYS[d]} />
      </div>
    </>
  );
}

function Stat({ label, value, sub, meter }: { label: string; value: string; sub: string; meter?: number }) {
  return (
    <div className="panel grid content-start gap-1 px-4 py-3">
      <span className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">{label}</span>
      <b className="num text-[26px] font-semibold leading-none tracking-tight">{value}</b>
      {meter != null && <div className="meter" role="img" aria-label={`${Math.round(meter * 100)} percent`}><i style={{ width: `${Math.round(meter * 100)}%` }} /></div>}
      <span className="text-[11.5px] text-fg-faint">{sub}</span>
    </div>
  );
}

function Card({ title, sub, aside, children }: { title: string; sub?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel grid content-start gap-3 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[13px] font-semibold">{title}</h2>
          {sub && <p className="m-0 text-[11.5px] text-fg-faint">{sub}</p>}
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

function DailyChart({ r, metric, setMetric }: { r: UsageReport; metric: Metric; setMetric: (m: Metric) => void }) {
  const m = METRICS.find(x => x.id === metric)!;
  const [hot, setHot] = useState<number | null>(null);
  const values = useMemo(() => r.daily.map(d => m.of(d)), [r, m]);
  const max = Math.max(1, ...values);
  const shown = hot != null ? r.daily[hot] : null;
  const fmt = metric === 'messages' ? num : fmtTokens;
  const total = values.reduce((a, b) => a + b, 0);
  const step = Math.max(1, Math.ceil(r.daily.length / 8));
  return (
    <Card title="Daily activity" sub={shown ? `${dayLabel(shown.day)}: ${fmt(values[hot!])} ${m.label.toLowerCase()} · ${num(shown.messages)} messages` : `${fmt(total)} ${m.label.toLowerCase()} over ${r.daily.length} days`}
      aside={<div className="seg" role="group" aria-label="Measure">{METRICS.map(x => <button key={x.id} aria-pressed={metric === x.id} onClick={() => setMetric(x.id)}>{x.label}</button>)}</div>}>
      <div className="bars" style={{ height: 180 }} onMouseLeave={() => setHot(null)} role="img" aria-label={`Daily ${m.label.toLowerCase()}`}>
        {values.map((v, i) => (
          <div key={r.daily[i].day} className="bar-col" data-hot={hot === i || undefined} onMouseEnter={() => setHot(i)}>
            <i style={{ height: v ? `${Math.max(2, (v / max) * 100)}%` : 0 }} />
          </div>
        ))}
      </div>
      <div className="axis">
        {r.daily.map((d, i) => <span key={d.day}>{i % step === 0 ? new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}</span>)}
      </div>
    </Card>
  );
}

function Models({ r }: { r: UsageReport }) {
  const sum = r.models.reduce((a, x) => a + x.output, 0) || 1;
  return (
    <Card title="Models" sub="share of output tokens">
      <div className="split" role="img" aria-label="Output tokens by model">
        {r.models.map((x, i) => <i key={x.model} style={{ width: `${(x.output / sum) * 100}%`, background: SERIES[Math.min(i, SERIES.length - 1)] }} title={`${modelName(x.model)}: ${fmtTokens(x.output)}`} />)}
      </div>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {r.models.map((x, i) => (
          <li key={x.model} className="flex items-center gap-2 text-[12.5px]">
            <span className="swatch" style={{ background: SERIES[Math.min(i, SERIES.length - 1)] }} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate" title={x.model}>{modelName(x.model)}</span>
            <span className="num text-fg-faint">{num(x.messages)} msgs</span>
            <b className="num w-16 text-right font-medium">{fmtTokens(x.output)}</b>
            <span className="num w-10 text-right text-fg-faint">{Math.round((x.output / sum) * 100)}%</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Projects({ r }: { r: UsageReport }) {
  const max = Math.max(1, ...r.projects.map(p => p.output));
  return (
    <Card title="Projects" sub="by output tokens, from the folder each conversation ran in">
      <ul className="m-0 grid list-none gap-2 p-0">
        {r.projects.map(p => (
          <li key={p.project} className="grid gap-1">
            <div className="flex items-baseline gap-2 text-[12.5px]">
              <span className="min-w-0 flex-1 truncate" title={p.project}>{p.project}</span>
              <span className="num text-[11.5px] text-fg-faint">{num(p.sessions)} chats</span>
              <b className="num w-16 text-right font-medium">{fmtTokens(p.output)}</b>
            </div>
            <div className="meter"><i style={{ width: `${(p.output / max) * 100}%` }} /></div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Rhythm({ title, sub, values, label, tip }: { title: string; sub: string; values: number[]; label: (i: number) => string; tip: (i: number) => string }) {
  const max = Math.max(1, ...values);
  const [hot, setHot] = useState<number | null>(null);
  return (
    <Card title={title} sub={hot != null ? `${tip(hot)}: ${num(values[hot])} messages` : sub}>
      <div className="bars" style={{ height: 90 }} onMouseLeave={() => setHot(null)} role="img" aria-label={title}>
        {values.map((v, i) => <div key={i} className="bar-col" data-hot={hot === i || undefined} onMouseEnter={() => setHot(i)}><i style={{ height: v ? `${Math.max(3, (v / max) * 100)}%` : 0 }} /></div>)}
      </div>
      <div className="axis">{values.map((_, i) => <span key={i}>{label(i)}</span>)}</div>
    </Card>
  );
}
