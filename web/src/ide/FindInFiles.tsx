import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { CaseSensitive, File, Regex, Search, WholeWord } from 'lucide-react';
import { api } from '../lib/api';

interface Hit { path: string; line: number; col: number; text: string }

/** A copy of the search's pattern for marking what matched on each line; null when it does not compile (the server says why). */
function marker(q: string, regex: boolean, cs: boolean, word: boolean): RegExp | null {
  if (!q) return null;
  try {
    const src = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(word ? `\\b(?:${src})\\b` : src, cs ? 'g' : 'gi');
  } catch { return null; }
}

function Marked({ text, re }: { text: string; re: RegExp | null }) {
  if (!re) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) && parts.length < 40) {
    if (!m[0]) { re.lastIndex++; continue; }
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<mark key={m.index} className="rounded-[3px] bg-[color-mix(in_srgb,var(--warn)_35%,transparent)] text-inherit">{m[0]}</mark>);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

const toggle = 'iconbtn shrink-0 aria-pressed:bg-[var(--accent-soft)] aria-pressed:text-accent';

/** Ctrl+Shift+F: text search across the folder. Results are grouped by file; Enter or a click opens the line. */
export function FindInFiles({ root, seed, onPick, onClose }: { root: string; seed: string; onPick: (hit: Hit) => void; onClose: () => void }) {
  const [q, setQ] = useState(seed);
  const [regex, setRegex] = useState(false), [cs, setCs] = useState(false), [word, setWord] = useState(false);
  const [glob, setGlob] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [state, setState] = useState<{ busy: boolean; truncated: boolean; error?: string }>({ busy: false, truncated: false });
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);

  // A search runs when typing pauses. The one before it is cancelled, on the server too.
  useEffect(() => {
    if (!q) { setHits([]); setState({ busy: false, truncated: false }); return; }
    const stop = new AbortController();
    setState(s => ({ ...s, busy: true }));
    const t = setTimeout(() => {
      api.ideGrep(root, { q, regex, caseSensitive: cs, word, glob }, stop.signal)
        .then(r => { setHits(r.hits); setCursor(0); setState({ busy: false, truncated: r.truncated, error: r.error }); })
        .catch(e => { if (e.name !== 'AbortError') setState({ busy: false, truncated: false, error: String(e.message || e) }); });
    }, 250);
    return () => { clearTimeout(t); stop.abort(); };
  }, [q, regex, cs, word, glob, root]);

  useEffect(() => { list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' }); }, [cursor]);

  const re = useMemo(() => marker(q, regex, cs, word), [q, regex, cs, word]);
  const files = new Set(hits.map(h => h.path)).size;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[8vh]" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="panel flex max-h-[80vh] w-[880px] max-w-[94vw] flex-col overflow-hidden shadow-[var(--shadow)]" role="dialog" aria-label="Find in files"
        onKeyDown={e => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(hits.length - 1, c + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(0, c - 1)); }
          // preventDefault: focus moves to the editor while Enter is still going down, and it would type a newline there.
          if (e.key === 'Enter' && hits[cursor]) { e.preventDefault(); onPick(hits[cursor]); }
        }}>
        <div className="flex items-center gap-1 border-b border-line px-3">
          <Search size={14} className="shrink-0 text-fg-faint" aria-hidden="true" />
          <input ref={input} className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none" placeholder="Find in files" value={q} onChange={e => setQ(e.target.value)} />
          <button className={toggle} style={{ width: 26, height: 26 }} aria-pressed={cs} title="Match case" aria-label="Match case" onClick={() => setCs(v => !v)}><CaseSensitive size={15} aria-hidden="true" /></button>
          <button className={toggle} style={{ width: 26, height: 26 }} aria-pressed={word} title="Whole words" aria-label="Whole words" onClick={() => setWord(v => !v)}><WholeWord size={15} aria-hidden="true" /></button>
          <button className={toggle} style={{ width: 26, height: 26 }} aria-pressed={regex} title="Regular expression" aria-label="Regular expression" onClick={() => setRegex(v => !v)}><Regex size={15} aria-hidden="true" /></button>
          <input className="input ml-2 h-7 w-40 text-[12px]" placeholder="File mask: *.php, app/**" aria-label="File mask" value={glob} onChange={e => setGlob(e.target.value)} />
        </div>
        <div className="border-b border-line px-3 py-1 text-[11px] text-fg-faint" aria-live="polite">
          {state.error ? <span className="text-crit">{state.error}</span>
            : !q ? 'Type to search the folder. Git-ignored files are left out.'
            : state.busy ? 'Searching…'
            : `${hits.length}${state.truncated ? '+' : ''} match${hits.length === 1 ? '' : 'es'} in ${files} file${files === 1 ? '' : 's'}${state.truncated ? ' (narrow the search to see the rest)' : ''}`}
        </div>
        <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1">
          {hits.map((h, i) => (
            <Fragment key={`${h.path}:${h.line}:${h.col}`}>
              {(i === 0 || hits[i - 1].path !== h.path) && (
                <div className="flex items-center gap-2 px-2 pb-0.5 pt-2 text-[11.5px] font-semibold text-fg-muted"><File size={12} className="shrink-0" aria-hidden="true" /><span className="truncate" title={h.path}>{h.path}</span></div>
              )}
              <button className="row h-6" aria-current={i === cursor ? 'true' : undefined} onMouseEnter={() => setCursor(i)} onClick={() => onPick(h)}>
                <span className="num w-10 shrink-0 text-right text-[11px] text-fg-faint">{h.line}</span>
                <span className="mono grow truncate text-[12px]"><Marked text={h.text.trim()} re={re} /></span>
              </button>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
