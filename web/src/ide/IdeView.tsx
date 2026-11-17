import { useCallback, useEffect, useRef, useState } from 'react';
import { FileWarning, GitCompare, History as HistoryIcon, UserSearch, X } from 'lucide-react';
import { api, type IdeLogEntry } from '../lib/api';
import { actions } from '../lib/store';
import { Empty } from '../components/ui';
import { FileTree } from './FileTree';
import { QuickOpen, type Picked } from './QuickOpen';
import { FindInFiles } from './FindInFiles';
import { Editor } from './Editor';
import { languageName } from './languages';
import { checkDisk, closeFile, jumpTo, navigate, openFile, refreshGit, reload, save, setActive, textOf, toggleBlame, useSession, type Loc } from './session';
import { useLspStatus } from './lsp';
import { Peek } from './Peek';
import { DiffView, type DiffSpec } from './DiffView';
import { History } from './History';
import { rememberIde } from './open';

const SHORTCUTS: [string, string][] = [
  ['Ctrl+P', 'Open a file by name'], ['Shift Shift', 'Search files, classes, methods, text'], ['Ctrl+Shift+F', 'Find in files'],
  ['Ctrl+B / Ctrl+click', 'Go to definition (on one: its usages)'], ['Ctrl+Alt+B', 'Go to implementations'], ['Alt+F7', 'Find usages'],
  ['Ctrl+Alt+Left / Right', 'Back / forward through jumps'], ['Ctrl+S', 'Save'], ['F7 in a diff', 'Next change'],
];

/** The folder's files, editable in place: tree, tabs, save, go to definition, Ctrl+P and Shift+Shift to find things, Ctrl+Shift+F to search text. */
export function IdeView({ root, open }: { root: string; open?: { path: string; line?: number; at: number } }) {
  const s = useSession(root);
  const [quick, setQuick] = useState<false | 'files' | 'everywhere'>(false);
  const [find, setFind] = useState<{ seed: string } | null>(null);
  const [diff, setDiff] = useState<DiffSpec | null>(null);
  const [history, setHistory] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1, sel: 0 });
  const onCursor = useCallback((line: number, col: number, sel: number) => setCursor(c => c.line === line && c.col === col && c.sel === sel ? c : { line, col, sel }), []);
  const act = s.active ? s.bufs.get(s.active) : undefined;
  const lsp = useLspStatus(root, act?.kind === 'text' ? act.path : null);

  useEffect(() => { rememberIde(root); }, [root]);

  // A file asked for from outside (a link in a chat, the palette).
  useEffect(() => {
    if (open?.path) openFile(root, open.path, open.line).then(err => { if (err) actions.toast(err, 'error'); });
  }, [root, open?.path, open?.line, open?.at]);

  // Files change under the editor: Claude writes them, git switches branches. Check when the window comes back and every few seconds.
  useEffect(() => {
    const check = () => { if (!document.hidden) { checkDisk(s); refreshGit(s); } };
    const t = setInterval(check, 4000);
    window.addEventListener('focus', check);
    return () => { clearInterval(t); window.removeEventListener('focus', check); };
  }, [s]);

  // Unsaved edits are not lost to a reload or a closed window.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if ([...s.bufs.values()].some(b => b.dirty)) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [s]);

  // Ctrl+S saves, Ctrl+P finds a file, a double tap of Shift searches everywhere, Ctrl+Shift+F searches text. A Shift that other keys came between does not count.
  const lastShift = useRef(0);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); if (s.active) save(s, s.active).then(ok => { if (!ok) { const b = s.bufs.get(s.active!); if (b?.error && !b.stale) actions.toast(b.error, 'error'); } }); }
      else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') { e.preventDefault(); setQuick('files'); }
      else if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        // What is selected in the editor becomes the search, as in PhpStorm.
        const st = s.active ? s.bufs.get(s.active)?.state : null;
        const sel = st ? st.sliceDoc(st.selection.main.from, st.selection.main.to) : '';
        setFind({ seed: sel && !/[\r\n]/.test(sel) && sel.length < 200 ? sel : '' });
      }
      else if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); navigate(s, e.key === 'ArrowLeft' ? -1 : 1); }
      else if (e.key === 'Shift') return;
      lastShift.current = 0;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== 'Shift' || e.ctrlKey || e.altKey || e.metaKey) return;
      const now = Date.now();
      if (now - lastShift.current < 400) { lastShift.current = 0; setQuick('everywhere'); } else lastShift.current = now;
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); };
  }, [s]);

  const here = (): Loc | null => s.active ? { path: s.active, line: cursor.line, col: cursor.col } : null;
  const go = async (to: Loc) => {
    const err = await jumpTo(s, here() || to, to);
    if (err) actions.toast(err, 'error');
  };
  const picked = (p: Picked) => {
    setQuick(false);
    if (p.kind === 'file') openFile(root, p.path).then(err => { if (err) actions.toast(err, 'error'); });
    else if (p.kind === 'symbol') go({ path: p.hit.path, line: p.hit.line, col: p.hit.col, find: { word: p.hit.name, endLine: p.hit.line + 3 } });
    else setFind({ seed: p.q });
  };

  // Your current text (saved or not) against HEAD, or one commit's change to the file against its parent.
  const showWorking = async () => {
    if (!act || act.kind !== 'text') return;
    setHistory(false);
    try {
      const head = await api.ideGitShow(root, 'HEAD', act.path);
      setDiff({ title: `${act.path}: working copy against HEAD`, oldLabel: head.exists ? 'HEAD' : 'Not in HEAD (new file)', newLabel: act.dirty ? 'Working copy (unsaved)' : 'Working copy', oldText: head.text, newText: textOf(act), path: act.path });
    } catch (e) { actions.toast(String((e as Error).message || e), 'error'); }
  };
  const showCommit = async (sha: string, subject?: string) => {
    if (!act) return;
    setHistory(false);
    try {
      const [before, after] = await Promise.all([api.ideGitShow(root, `${sha}^`, act.path), api.ideGitShow(root, sha, act.path)]);
      setDiff({ title: `${sha.slice(0, 7)} ${subject || act.path}`, oldLabel: before.exists ? `${sha.slice(0, 7)}^ (before)` : 'Did not exist', newLabel: `${sha.slice(0, 7)} (after)`, oldText: before.text, newText: after.text, path: act.path });
    } catch (e) { actions.toast(String((e as Error).message || e), 'error'); }
  };
  const gitHooks = { onCommit: (sha: string, summary: string) => { showCommit(sha, summary); }, onDiff: () => { showWorking(); } };

  const close = (path: string) => {
    const b = s.bufs.get(path);
    if (b?.dirty && !window.confirm(`${path} has unsaved changes. Close it and lose them?`)) return;
    closeFile(s, path);
  };

  return (
    <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: '260px minmax(0, 1fr)' }}>
      <FileTree session={s} />
      <div className="flex min-h-0 min-w-0 flex-col">
        {s.order.length > 0 && (
          <div role="tablist" aria-label="Open files" className="tabstrip shrink-0">
            {s.order.map(p => {
              const b = s.bufs.get(p)!;
              const name = p.slice(p.lastIndexOf('/') + 1);
              return (
                <div key={p} role="tab" aria-selected={p === s.active} tabIndex={0} title={p} className="group tab"
                  onClick={() => setActive(s, p)} onAuxClick={e => { if (e.button === 1) { e.preventDefault(); close(p); } }} onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(s, p); } }}>
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  {b.dirty && <span className="inline-block size-1.5 shrink-0 rounded-full bg-warn" title="Unsaved changes" aria-label="Unsaved changes" />}
                  <button className={`iconbtn shrink-0 ${p === s.active ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`} style={{ width: 20, height: 20 }} aria-label={`Close ${name}`} title="Close" onClick={e => { e.stopPropagation(); close(p); }}><X size={12} aria-hidden="true" /></button>
                </div>
              );
            })}
            {act?.kind === 'text' && (
              <div className="my-auto ml-auto flex shrink-0 items-center gap-0.5 pl-2 pr-1">
                <button className="iconbtn" style={{ width: 26, height: 26 }} title="Compare with HEAD" aria-label="Compare with HEAD" onClick={showWorking}><GitCompare size={14} aria-hidden="true" /></button>
                <button className="iconbtn" style={{ width: 26, height: 26 }} title="File history" aria-label="File history" onClick={() => setHistory(true)}><HistoryIcon size={14} aria-hidden="true" /></button>
                <button className="iconbtn" style={{ width: 26, height: 26 }} aria-pressed={s.blame} title="Annotate with Git Blame" aria-label="Annotate with Git Blame" onClick={() => toggleBlame(s)}><UserSearch size={14} className={s.blame ? 'text-accent' : ''} aria-hidden="true" /></button>
              </div>
            )}
          </div>
        )}

        {act?.stale && (
          <div className="flex shrink-0 items-center gap-3 border-b border-line bg-warn-soft px-3 py-1.5 text-[12px]" role="alert">
            <FileWarning size={14} className="shrink-0 text-warn" aria-hidden="true" />
            <span className="grow">{act.path} changed on disk while you have unsaved edits.</span>
            <button className="btn" onClick={() => reload(s, act.path).catch(e => actions.toast(String(e.message || e), 'error'))}>Load from disk</button>
            <button className="btn" onClick={() => save(s, act.path, true)}>Overwrite</button>
          </div>
        )}

        {!act && (
          <Empty title="Nothing open">
            Pick a file from the tree.
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-left text-[11.5px]">
              {SHORTCUTS.map(([k, what]) => <div key={k} className="contents"><dt className="mono text-fg">{k}</dt><dd className="m-0 text-fg-muted">{what}</dd></div>)}
            </dl>
          </Empty>
        )}
        {act && act.kind === 'text' && <Editor session={s} buf={act} onCursor={onCursor} git={gitHooks} />}
        {act && act.kind !== 'text' && <Empty title={act.kind === 'binary' ? 'Binary file' : 'File too large to edit here'}>{act.path} · {Math.round(act.size / 1024).toLocaleString()} KB. Open it with VS Code or your file manager instead.</Empty>}

        {act && act.kind === 'text' && (
          <div className="flex h-6 shrink-0 items-center gap-4 border-t border-line px-3 text-[11px] text-fg-faint">
            <span className="mono min-w-0 flex-1 truncate" title={act.path}>{act.path}</span>
            {act.saving && <span>Saving…</span>}
            {act.error && !act.stale && <span className="text-crit" title={act.error}>Not saved</span>}
            <span className="num">{cursor.line}:{cursor.col}{cursor.sel ? ` (${cursor.sel} selected)` : ''}</span>
            <span>{act.eol === 'crlf' ? 'CRLF' : 'LF'}</span>
            {lsp && <span className={lsp.state === 'failed' ? 'text-crit' : ''} title={lsp.detail || `${lsp.name} language server`}>{lsp.name || 'Language server'} · {lsp.state === 'ready' ? (lsp.progress ? `indexing: ${lsp.progress}` : 'ready') : lsp.state === 'failed' ? 'not running' : lsp.state === 'closed' ? 'off' : 'starting…'}</span>}
            <span>{languageName(act.path)}</span>
          </div>
        )}
      </div>
      <Peek session={s} />
      {history && act && <History root={root} path={act.path} onClose={() => setHistory(false)} onWorking={showWorking} onCommit={(e: IdeLogEntry) => showCommit(e.sha, e.subject)} />}
      {diff && <DiffView spec={diff} onClose={() => setDiff(null)} />}
      {quick && <QuickOpen root={root} recent={[...s.order].reverse()} everywhere={quick === 'everywhere'} onClose={() => setQuick(false)} onPick={picked} />}
      {find && <FindInFiles root={root} seed={find.seed} onClose={() => setFind(null)} onPick={h => { setFind(null); go({ path: h.path, line: h.line, col: h.col }); }} />}
    </div>
  );
}
