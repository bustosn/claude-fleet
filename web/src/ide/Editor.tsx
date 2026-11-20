import { useEffect, useRef } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, codeFolding, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { theme } from '../sql/SqlEditor';
import { ideHighlight } from './syntax';
import { edited, type Buf, type Session } from './session';
import { languageFor } from './languages';
import { langOf, lspFor } from './lsp';
import { blameGutter, gitExtensions, refreshGit } from './gitExt';
import { applyDiagnostics, lspCompletion, lspExtensions, type Ctx } from './lspExt';

const lang = new Compartment();
const blame = new Compartment();

export interface GitHooks { onCommit: (sha: string, summary: string) => void; onDiff: () => void }

const extensions = (path: string, ctx: () => Ctx, git: () => GitHooks, showBlame: boolean, onUpdate: (state: EditorState) => void, onCursor: (line: number, col: number, sel: number) => void): Extension[] => [
  lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), codeFolding(), drawSelection(), indentOnInput(),
  syntaxHighlighting(ideHighlight), bracketMatching(), closeBrackets(), autocompletion(langOf(path) ? { override: [lspCompletion(ctx)] } : {}), rectangularSelection(), highlightActiveLine(), highlightSelectionMatches(),
  search({ top: true }),
  EditorState.tabSize.of(4),
  ...(langOf(path) ? lspExtensions(ctx) : []),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
  theme,
  // PhpStorm's look: JetBrains Mono where it is installed, and the 120-column guide.
  EditorView.theme({
    '.cm-scroller': { fontFamily: "'JetBrains Mono', 'JetBrainsMono Nerd Font', var(--mono)" },
    '.cm-content::before': { content: '""', position: 'absolute', top: '0', bottom: '0', left: 'calc(120ch + 6px)', borderLeft: '1px solid color-mix(in srgb, var(--fg) 9%, transparent)', pointerEvents: 'none' },
  }),
  lang.of([]),
  ...gitExtensions(() => git().onDiff()),
  blame.of(showBlame ? blameGutter((sha, summary) => git().onCommit(sha, summary)) : []),
  EditorView.updateListener.of(u => {
    if (u.docChanged) onUpdate(u.state);
    if (u.docChanged || u.selectionSet) {
      const h = u.state.selection.main, line = u.state.doc.lineAt(h.head);
      onCursor(line.number, h.head - line.from + 1, Math.abs(h.to - h.from));
    }
  }),
];

/** One CodeMirror view, shown for whichever file is active. Each file keeps its own EditorState (text, undo history, cursor) in the session. */
export function Editor({ session, buf, onCursor, git }: { session: Session; buf: Buf; onCursor: (line: number, col: number, sel: number) => void; git: GitHooks }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const shown = useRef<{ path: string; mtime: number } | null>(null);
  const cur = useRef({ session, buf, onCursor, git }); cur.current = { session, buf, onCursor, git };

  const makeState = (b: Buf) => EditorState.create({
    doc: b.saved,
    extensions: extensions(
      b.path,
      () => ({ root: cur.current.session.root, path: b.path, session: cur.current.session }),
      () => cur.current.git,
      cur.current.session.blame,
      state => edited(cur.current.session, b.path, state),
      (l, c, s) => cur.current.onCursor(l, c, s),
    ),
  });

  useEffect(() => () => { view.current?.destroy(); view.current = null; shown.current = null; }, []);

  // Show the active file: its saved state when it has one, else a fresh one from the text read from disk.
  useEffect(() => {
    if (!host.current) return;
    const prev = shown.current;
    const same = prev && prev.path === buf.path;
    // A save changes the mtime but not the text on screen; a reload clears the state and needs a rebuild.
    if (same && (prev.mtime === buf.mtime || buf.state)) { prev.mtime = buf.mtime; return; }
    const state = buf.state || makeState(buf);
    if (!view.current) view.current = new EditorView({ state, parent: host.current });
    else view.current.setState(state);
    shown.current = { path: buf.path, mtime: buf.mtime };
    const v = view.current, path = buf.path;
    const h = state.selection.main, line = state.doc.lineAt(h.head);
    cur.current.onCursor(line.number, h.head - line.from + 1, Math.abs(h.to - h.from));
    // Language support loads once per kind and is added to the state already on screen.
    languageFor(path).then(ext => { if (ext && shown.current?.path === path) v.dispatch({ effects: lang.reconfigure(ext) }); });
    if (!buf.state) buf.state = state;
    v.focus();
  }, [buf.path, buf.mtime, buf.state]);

  // Problems the language server reports for this file, now and as they change.
  useEffect(() => {
    const c = lspFor(session.root, buf.path);
    const show = () => { const v = view.current; if (v && shown.current?.path === buf.path) applyDiagnostics(v, c?.diagnostics.get(buf.path) || []); };
    if (!c) return;
    show();
    const on = (p: string) => { if (p === buf.path) show(); };
    c.diagSubs.add(on);
    return () => { c.diagSubs.delete(on); };
  }, [buf.path, buf.mtime]);

  // The change bars and blame describe the file on disk, so they load when it is shown or saved, and not while it has unsaved edits.
  useEffect(() => {
    const v = view.current, path = buf.path;
    if (!v || shown.current?.path !== path) return;
    v.dispatch({ effects: blame.reconfigure(session.blame ? blameGutter((sha, summary) => cur.current.git.onCommit(sha, summary)) : []) });
    if (!buf.dirty) refreshGit(v, session.root, path, () => shown.current?.path === path && view.current === v);
  }, [buf.path, buf.mtime, session.blame]);

  // Jump to a line when something asked for one (a search result, a link).
  const goto = session.goto;
  useEffect(() => {
    const v = view.current;
    if (!v || !goto || goto.path !== buf.path) return;
    const n = Math.min(Math.max(1, goto.line), v.state.doc.lines);
    let ln = v.state.doc.line(n);
    let at = ln.from + Math.min(Math.max(0, (goto.col || 1) - 1), ln.length);
    // A definition's range begins at its docblock; move on to the line that names it, skipping comment lines.
    if (goto.find) {
      const word = goto.find.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![\\w$])${word}(?![\\w])`);
      for (let l = n; l <= Math.min(goto.find.endLine, v.state.doc.lines, n + 400); l++) {
        const line = v.state.doc.line(l);
        if (/^\s*(\*|\/\*|\/\/|#)/.test(line.text)) continue;
        const m = re.exec(line.text);
        if (m) { ln = line; at = line.from + m.index; break; }
      }
    }
    v.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
    v.focus();
  }, [goto?.at, buf.path, buf.mtime]);

  return <div ref={host} className="min-h-0 flex-1 overflow-hidden" />;
}
