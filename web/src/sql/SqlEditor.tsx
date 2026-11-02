import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, placeholder, rectangularSelection, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, type CompletionSource } from '@codemirror/autocomplete';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { MySQL, keywordCompletionSource, schemaCompletionSource, sql, type SQLNamespace } from '@codemirror/lang-sql';
import { tags as t } from '@lezer/highlight';
import { statementAt } from '../../../shared/sqlClassify';

export interface EditorHandle {
  /** Text, cursor and selection at this moment, for a run. */
  snapshot(): { text: string; cursor: number; selection: { from: number; to: number } | null };
  insert(text: string): void;
  replaceAll(text: string): void;
  focus(): void;
  /** Underlines the failing token of the last run, or clears it. */
  markError(range: { from: number; to: number } | null): void;
}

interface Props {
  value: string; onChange: (text: string) => void;
  schema: SQLNamespace; defaultSchema: string | undefined;
  onRun: (limit: 'auto' | 'max') => void; onFormat: () => void; onExplain: () => void;
  /** Column completion from the statement's tables and aliases (columnCompletion). */
  columns?: CompletionSource;
}

// Fleet's palette: the same keyword/string/number colors as chat code blocks, everything else from the theme tokens.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'light-dark(#a626a4, #c792ea)', fontWeight: '500' },
  { tag: [t.string, t.special(t.string)], color: 'light-dark(#2f8a3c, #9ece6a)' },
  { tag: [t.number, t.bool, t.null], color: 'light-dark(#b45f06, #ff9e64)' },
  { tag: [t.typeName, t.standard(t.name)], color: 'light-dark(#0e7490, #2ac3de)' },
  { tag: [t.function(t.variableName), t.special(t.name)], color: 'light-dark(#2b5fd9, #7aa2f7)' },
  { tag: [t.lineComment, t.blockComment, t.comment], color: 'var(--fg-faint)', fontStyle: 'italic' },
  { tag: [t.special(t.variableName), t.labelName], color: 'light-dark(#c2410c, #e0af68)' },
  { tag: t.punctuation, color: 'var(--fg-muted)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--surface)', color: 'var(--fg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'color-mix(in srgb, var(--accent) 24%, transparent) !important' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--fg-faint)', border: 'none', paddingLeft: '4px' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '3ch', padding: '0 10px 0 4px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--hover) 55%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg-muted)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 18%, transparent)' },
  '.cm-placeholder': { color: 'var(--fg-faint)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--line-strong)', borderRadius: '10px', boxShadow: 'var(--shadow)', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: '12px', maxHeight: '18em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 10px 2px 6px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--selected)', color: 'var(--fg)' },
  '.cm-completionDetail': { color: 'var(--fg-faint)', fontStyle: 'normal', marginLeft: '10px' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent)', fontWeight: '600' },
  '.cm-panels': { backgroundColor: 'var(--raised)', color: 'var(--fg)', borderColor: 'var(--line)' },
  '.cm-panels input, .cm-panels button': { fontSize: '12px' },
  '.cm-textfield': { backgroundColor: 'var(--surface)', border: '1px solid var(--line-strong)', borderRadius: '6px', padding: '2px 6px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--surface)', border: '1px solid var(--line-strong)', borderRadius: '6px' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 30%, transparent)' },
  '.cm-sql-current': { backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
  '.cm-sql-error': { textDecoration: 'underline wavy var(--crit)', textUnderlineOffset: '3px', backgroundColor: 'var(--crit-soft)' },
});

// The statement Ctrl+Enter would run gets a faint band, so it is clear which one that is when the tab holds several.
const currentStatement = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(u: ViewUpdate) { if (u.docChanged || u.selectionSet) this.decorations = this.build(u.view); }
  build(view: EditorView): DecorationSet {
    const doc = view.state.doc;
    if (doc.length > 200000) return Decoration.none;
    const text = doc.toString();
    const s = statementAt(text, view.state.selection.main.head);
    // One statement in the tab needs no marker.
    if (!s || (s.start === text.search(/\S/) && s.end === text.trimEnd().length)) return Decoration.none;
    const marks: Range<Decoration>[] = [];
    const first = doc.lineAt(s.start).number, last = doc.lineAt(s.end).number;
    for (let l = first; l <= last; l++) marks.push(Decoration.line({ class: 'cm-sql-current' }).range(doc.line(l).from));
    return Decoration.set(marks);
  }
}, { decorations: v => v.decorations });

const setError = StateEffect.define<{ from: number; to: number } | null>();
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setError)) deco = e.value && e.value.to > e.value.from ? Decoration.set([Decoration.mark({ class: 'cm-sql-error' }).range(e.value.from, Math.min(e.value.to, tr.state.doc.length))]) : Decoration.none;
    // Editing clears the underline: it described the text as it was.
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: f => EditorView.decorations.from(f),
});

export const SqlEditor = forwardRef<EditorHandle, Props>(function SqlEditor({ value, onChange, schema, defaultSchema, onRun, onFormat, onExplain, columns }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const schemaComp = useRef(schemaCompletionSource({ dialect: MySQL, upperCaseKeywords: true, schema, defaultSchema }));
  // Handlers change every render; the keymap reads them through this ref instead of being rebuilt.
  const cb = useRef({ onChange, onRun, onFormat, onExplain, columns }); cb.current = { onChange, onRun, onFormat, onExplain, columns };

  useEffect(() => {
    const keys = keymap.of([
      { key: 'Mod-Enter', preventDefault: true, run: () => { cb.current.onRun('auto'); return true; } },
      { key: 'Shift-Mod-Enter', preventDefault: true, run: () => { cb.current.onRun('max'); return true; } },
      { key: 'Shift-Mod-f', preventDefault: true, run: () => { cb.current.onFormat(); return true; } },
      { key: 'Shift-Mod-e', preventDefault: true, run: () => { cb.current.onExplain(); return true; } },
    ]);
    // The completion list, in order: columns of the statement's tables (columnCompletion), then databases and tables, then keywords.
    // Each is one function for the editor's life, since completion tells sources apart by identity; they read the latest props through refs.
    const columnSource = (ctx: CompletionContext) => cb.current.columns ? cb.current.columns(ctx) : null;
    const schemaSource = (ctx: CompletionContext) => schemaComp.current(ctx);
    const keywords = keywordCompletionSource(MySQL, true);
    // No keywords right after a qualifier: f.ca wants columns, not CASE.
    const keywordSource = (ctx: CompletionContext) => /[\w$`]\.[\w$]*$/.test(ctx.state.sliceDoc(Math.max(0, ctx.pos - 100), ctx.pos)) ? null : keywords(ctx);
    const extensions: Extension[] = [
      keys, lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), EditorState.allowMultipleSelections.of(true),
      indentOnInput(), bracketMatching(), closeBrackets(), autocompletion({ activateOnTyping: true, maxRenderedOptions: 80, override: [columnSource, schemaSource, keywordSource] }), rectangularSelection(),
      highlightActiveLine(), highlightSelectionMatches(), search({ top: true }), syntaxHighlighting(highlight), theme, currentStatement, errorField,
      placeholder('SELECT … — Ctrl+Enter runs the statement under the cursor'),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
      lang.current.of(sql({ dialect: MySQL, upperCaseKeywords: true, schema, defaultSchema })),
      // Beside the language's own completion (keywords, databases, tables): columns of the tables the statement uses.
      EditorView.updateListener.of(u => { if (u.docChanged) cb.current.onChange(u.state.doc.toString()); }),
    ];
    const v = new EditorView({ parent: host.current!, state: EditorState.create({ doc: value, extensions }) });
    view.current = v;
    v.focus();
    return () => { v.destroy(); view.current = null; };
    // The editor is made once per tab (the parent keys it by tab id); later value changes come from typing.
  }, []);

  useEffect(() => {
    schemaComp.current = schemaCompletionSource({ dialect: MySQL, upperCaseKeywords: true, schema, defaultSchema });
    view.current?.dispatch({ effects: lang.current.reconfigure(sql({ dialect: MySQL, upperCaseKeywords: true, schema, defaultSchema })) });
  }, [schema, defaultSchema]);

  useImperativeHandle(ref, () => ({
    snapshot() {
      const v = view.current!;
      const sel = v.state.selection.main;
      return { text: v.state.doc.toString(), cursor: sel.head, selection: sel.empty ? null : { from: sel.from, to: sel.to } };
    },
    insert(text) {
      const v = view.current!;
      const sel = v.state.selection.main;
      v.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length }, scrollIntoView: true });
      v.focus();
    },
    replaceAll(text) {
      const v = view.current!;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    },
    focus() { view.current?.focus(); },
    markError(range) {
      const v = view.current; if (!v) return;
      v.dispatch({ effects: setError.of(range), ...(range ? { selection: { anchor: Math.min(range.from, v.state.doc.length) }, scrollIntoView: true } : {}) });
    },
  }), []);

  return <div ref={host} className="sql-editor h-full min-h-0" />;
});
