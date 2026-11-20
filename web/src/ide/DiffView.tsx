import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { MergeView, goToNextChunk, goToPreviousChunk } from '@codemirror/merge';
import { theme } from '../sql/SqlEditor';
import { ideHighlight } from './syntax';
import { languageFor } from './languages';

export interface DiffSpec { title: string; oldLabel: string; newLabel: string; oldText: string; newText: string; path: string }

const diffTheme = EditorView.baseTheme({
  '&': { fontSize: '12.5px' },
  '.cm-changedLine': { backgroundColor: 'color-mix(in srgb, var(--good) 11%, transparent)' },
  '.cm-changedText': { backgroundColor: 'color-mix(in srgb, var(--good) 30%, transparent)' },
  '.cm-deletedChunk': { backgroundColor: 'color-mix(in srgb, var(--crit) 10%, transparent)' },
  '.cm-deletedChunk .cm-deletedText, .cm-deletedLine .cm-changedText': { backgroundColor: 'color-mix(in srgb, var(--crit) 28%, transparent)' },
  '.cm-merge-a .cm-changedLine, .cm-merge-a .cm-deletedLine': { backgroundColor: 'color-mix(in srgb, var(--crit) 10%, transparent)' },
  '.cm-collapsedLines': { background: 'var(--raised) !important', color: 'var(--fg-faint) !important', fontSize: '11.5px', padding: '3px 8px', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' },
  '.cm-mergeView': { background: 'var(--surface)' },
  '.cm-merge-gap': { backgroundColor: 'var(--raised)' },
});

/** Two versions of a file side by side, read-only, with what did not change folded away. F7 and Shift+F7 move between changes. */
export function DiffView({ spec, onClose }: { spec: DiffSpec; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const merge = useRef<MergeView | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // Focus the dialog so Escape and F7 reach it, not the editor underneath.
  useEffect(() => { box.current?.focus(); }, []);

  useEffect(() => {
    if (!host.current) return;
    const lang = new Compartment();
    const base = [lineNumbers(), syntaxHighlighting(ideHighlight), theme, diffTheme, EditorState.readOnly.of(true), EditorView.editable.of(false), lang.of([])];
    const mv = new MergeView({
      a: { doc: spec.oldText, extensions: base },
      b: { doc: spec.newText, extensions: base },
      parent: host.current,
      highlightChanges: true, gutter: true,
      collapseUnchanged: { margin: 3, minSize: 5 },
    });
    merge.current = mv;
    languageFor(spec.path).then(ext => { if (ext) for (const v of [mv.a, mv.b]) v.dispatch({ effects: lang.reconfigure(ext) }); });
    // Start on the first change rather than the top of a long file.
    setTimeout(() => goToNextChunk(mv.b), 50);
    return () => { mv.destroy(); merge.current = null; };
  }, [spec]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-[4vh]" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="panel flex h-full w-full max-w-[1500px] flex-col overflow-hidden shadow-[var(--shadow)] outline-none" role="dialog" aria-label={spec.title} tabIndex={-1}
        onKeyDown={e => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'F7' && merge.current) { e.preventDefault(); (e.shiftKey ? goToPreviousChunk : goToNextChunk)(merge.current.b); }
        }}>
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-semibold" title={spec.title}>{spec.title}</div>
            <div className="mono truncate text-[11px] text-fg-faint">{spec.path}</div>
          </div>
          <button className="iconbtn" title="Previous change (Shift+F7)" aria-label="Previous change" onClick={() => merge.current && goToPreviousChunk(merge.current.b)}><ChevronUp size={15} aria-hidden="true" /></button>
          <button className="iconbtn" title="Next change (F7)" aria-label="Next change" onClick={() => merge.current && goToNextChunk(merge.current.b)}><ChevronDown size={15} aria-hidden="true" /></button>
          <button className="iconbtn" title="Close (Esc)" aria-label="Close" onClick={onClose}><X size={15} aria-hidden="true" /></button>
        </div>
        <div className="grid shrink-0 grid-cols-2 border-b border-line text-[11px] text-fg-muted">
          <div className="truncate border-r border-line px-3 py-1">{spec.oldLabel}</div>
          <div className="truncate px-3 py-1">{spec.newLabel}</div>
        </div>
        <div ref={host} className="min-h-0 flex-1 overflow-auto" />
      </div>
    </div>
  );
}
