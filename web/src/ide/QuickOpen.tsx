import { useEffect, useMemo, useRef, useState } from 'react';
import { File, Search, TextSearch } from 'lucide-react';
import { api } from '../lib/api';
import { workspaceSymbols, type SymbolHit } from './lsp';

const kindLabel: Record<number, string> = { 2: 'module', 3: 'namespace', 5: 'class', 6: 'method', 7: 'property', 8: 'field', 9: 'constructor', 10: 'enum', 11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 22: 'enum member', 23: 'struct' };

export type Picked =
  | { kind: 'file'; path: string }
  | { kind: 'symbol'; hit: SymbolHit }
  | { kind: 'text'; q: string };

/**
 * Ctrl+P finds a file by name. Shift+Shift ("everywhere") adds symbols (classes, methods, functions) from the language servers
 * and a last row that searches the text of every file. Empty, it lists the files open now.
 */
export function QuickOpen({ root, recent, everywhere, onPick, onClose }: { root: string; recent: string[]; everywhere: boolean; onPick: (p: Picked) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [symbols, setSymbols] = useState<SymbolHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  // Each keystroke asks again; an answer that arrives after a newer question is dropped.
  useEffect(() => {
    let live = true;
    const term = q.trim();
    const t = setTimeout(() => {
      if (!term) { setFiles(recent); setSymbols([]); setCursor(0); return; }
      api.ideFind(root, term, 40).then(h => { if (live) { setFiles(h); setCursor(0); } }).catch(() => { if (live) setFiles([]); });
      if (everywhere && term.length >= 2) workspaceSymbols(root, recent, term).then(h => { if (live) setSymbols(rank(h, term).slice(0, 30)); });
      else setSymbols([]);
    }, q ? 80 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q, root, everywhere]);

  const rows = useMemo(() => {
    const out: (Picked & { section?: string })[] = [];
    files.forEach((path, i) => out.push({ kind: 'file', path, section: i === 0 ? (q.trim() ? 'Files' : 'Open files') : undefined }));
    symbols.forEach((hit, i) => out.push({ kind: 'symbol', hit, section: i === 0 ? 'Symbols' : undefined }));
    if (everywhere && q.trim()) out.push({ kind: 'text', q: q.trim(), section: 'Text' });
    return out;
  }, [files, symbols, q, everywhere]);

  useEffect(() => { list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' }); }, [cursor]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="panel w-[680px] max-w-[94vw] overflow-hidden shadow-[var(--shadow)]" role="dialog" aria-label={everywhere ? 'Search everywhere' : 'Open file'}>
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search size={14} className="text-fg-faint" aria-hidden="true" />
          <input ref={input} className="h-10 w-full bg-transparent text-[13px] outline-none" placeholder={everywhere ? 'Search files, classes, methods and text' : 'Type a file name'} value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(rows.length - 1, c + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(0, c - 1)); }
              // preventDefault: focus moves to the editor while Enter is still going down, and it would type a newline there.
              if (e.key === 'Enter' && rows[cursor]) { e.preventDefault(); onPick(rows[cursor]); }
            }} />
        </div>
        <div ref={list} className="max-h-[56vh] overflow-y-auto p-1">
          {rows.length === 0 && <div className="px-3 py-4 text-[12px] text-fg-faint">{q.trim() ? 'No file matches.' : 'Nothing open yet. Type to find a file.'}</div>}
          {rows.map((r, i) => (
            <div key={r.kind === 'file' ? `f:${r.path}` : r.kind === 'symbol' ? `s:${r.hit.path}:${r.hit.line}:${r.hit.name}` : 't'}>
              {r.section && <div className="px-2 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-fg-faint">{r.section}</div>}
              <button className="row h-8" aria-current={i === cursor ? 'true' : undefined} onMouseEnter={() => setCursor(i)} onClick={() => onPick(r)}>
                {r.kind === 'file' && <File size={13} className="shrink-0 text-fg-faint" aria-hidden="true" />}
                {r.kind === 'symbol' && <span className="w-[62px] shrink-0 truncate rounded bg-[var(--accent-soft)] px-1 text-center text-[10px] text-accent">{kindLabel[r.hit.kind] || 'symbol'}</span>}
                {r.kind === 'text' && <TextSearch size={13} className="shrink-0 text-fg-faint" aria-hidden="true" />}
                {r.kind === 'file' && <>
                  <span className="shrink-0 text-[12.5px]">{r.path.slice(r.path.lastIndexOf('/') + 1)}</span>
                  <span className="grow truncate text-[11px] text-fg-faint">{r.path.lastIndexOf('/') > 0 ? r.path.slice(0, r.path.lastIndexOf('/')) : ''}</span>
                </>}
                {r.kind === 'symbol' && <>
                  <span className="shrink-0 text-[12.5px]">{r.hit.name}</span>
                  <span className="grow truncate text-[11px] text-fg-faint">{r.hit.container ? `${r.hit.container} · ` : ''}{r.hit.path}:{r.hit.line}</span>
                </>}
                {r.kind === 'text' && <span className="grow truncate text-[12.5px]">Search for “{r.q}” in files</span>}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Exact names first, then names that start with the text, then the rest; shorter names win within each. */
function rank(hits: SymbolHit[], q: string): SymbolHit[] {
  const low = q.toLowerCase();
  const score = (h: SymbolHit) => { const n = h.name.toLowerCase(); return (n === low ? 0 : n.startsWith(low) ? 1 : n.includes(low) ? 2 : 3) * 1000 + n.length; };
  return hits.slice().sort((a, b) => score(a) - score(b));
}
