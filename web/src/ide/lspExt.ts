import { EditorView, hoverTooltip, keymap } from '@codemirror/view';
import type { Text } from '@codemirror/state';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import type { Completion, CompletionSource } from '@codemirror/autocomplete';
import { api } from '../lib/api';
import { actions } from '../lib/store';
import { lspFor, type LspDiagnostic } from './lsp';
import { jumpTo, showPeek, type Loc, type Session } from './session';

// What the language server adds to the editor: Ctrl+B and Ctrl+click to jump to a definition (on a definition, to its usages),
// Ctrl+Alt+B for implementations, Alt+F7 for usages, hover documentation, completion, and problems in the gutter.

export interface Ctx { root: string; path: string; session: Session }
type Pos = { line: number; character: number };
type Method = 'definition' | 'implementation' | 'references';

const toPos = (doc: Text, at: number): Pos => { const l = doc.lineAt(at); return { line: l.number - 1, character: at - l.from }; };
const toOffset = (doc: Text, p: Pos) => { const l = doc.line(Math.min(doc.lines, Math.max(1, p.line + 1))); return l.from + Math.min(p.character, l.length); };

/** Location, Location[] or LocationLink[], as one list of uri and range. */
function locationsOf(res: any): { uri: string; range: { start: Pos; end: Pos } }[] {
  if (!res) return [];
  return (Array.isArray(res) ? res : [res]).map((r: any) => r?.targetUri ? { uri: r.targetUri, range: r.targetSelectionRange || r.targetRange } : r).filter((r: any) => r?.uri && r.range);
}

const label: Record<Method, string> = { definition: 'definition', implementation: 'implementations', references: 'usages' };

async function go(view: EditorView, ctx: () => Ctx, method: Method): Promise<void> {
  const { root, path, session } = ctx();
  const c = lspFor(root, path);
  if (!c) return;
  const doc = view.state.doc, head = view.state.selection.main.head;
  const line = doc.lineAt(head);
  const from: Loc = { path, line: line.number, col: head - line.from + 1 };
  if (c.status.state === 'failed') { actions.toast(c.status.detail || 'The language server is not running', 'error'); return; }
  c.flush(path);
  let res: any;
  try {
    res = await c.request(`textDocument/${method}`, { textDocument: { uri: c.uri(path) }, position: toPos(doc, head), ...(method === 'references' ? { context: { includeDeclaration: false } } : {}) });
  } catch (e) { actions.toast(String((e as Error).message || e), 'error'); return; }
  const all = locationsOf(res);
  const wordAt = view.state.wordAt(head);
  const word = wordAt ? doc.sliceString(wordAt.from, wordAt.to) : '';
  const here = all.flatMap(l => { const p = c.pathOf(l.uri); return p == null ? [] : [{ path: p, line: l.range.start.line + 1, col: l.range.start.character + 1, range: l.range, ...(word && method !== 'references' ? { find: { word, endLine: l.range.end.line + 1 } } : {}) }]; });
  if (!here.length) {
    actions.toast(all.length ? 'That is defined outside this folder (a built-in or a package elsewhere).' : c.status.progress ? `Still indexing (${c.status.progress}); try again in a moment.` : `No ${label[method]} found.`);
    return;
  }
  // Already on the definition: what the person wants is where it is used.
  if (method === 'definition' && here.length === 1 && here[0].path === path) {
    const r = here[0].range, a = toOffset(doc, r.start), b = toOffset(doc, r.end);
    if (head >= a && head <= b && line.number === here[0].line) { await go(view, ctx, 'references'); return; }
  }
  if (here.length === 1 && method !== 'references') {
    const err = await jumpTo(session, from, here[0]);
    if (err) actions.toast(err, 'error');
    return;
  }
  const items = here.slice(0, 300).map(h => ({ path: h.path, line: h.line, col: h.col }));
  const texts = await api.ideLines(root, items).catch(() => [] as string[]);
  showPeek(session, { title: `${here.length} ${label[method]}`, from, items: items.map((it, i) => ({ ...it, text: texts[i] || '' })) });
}

/** The hover text as DOM: fenced code as a block, `code` and **bold** inline. Server text is never inserted as HTML. */
function render(markdown: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'cm-lsp-hover';
  markdown.slice(0, 3000).split(/```[^\n]*\n?/).forEach((chunk, i) => {
    if (!chunk.trim()) return;
    if (i % 2 === 1) { const pre = document.createElement('pre'); pre.textContent = chunk.replace(/^<\?php\s*/, '').trim(); root.append(pre); return; }
    for (const para of chunk.trim().split(/\n{2,}/)) {
      const p = document.createElement('p');
      para.split(/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__)/).forEach(part => {
        if (/^`[^`]+`$/.test(part)) { const c = document.createElement('code'); c.textContent = part.slice(1, -1); p.append(c); }
        else if (/^(\*\*|__)[^]+\1$/.test(part)) { const b = document.createElement('strong'); b.textContent = part.slice(2, -2); p.append(b); }
        else p.append(part.replace(/\\(.)/g, '$1'));
      });
      root.append(p);
    }
  });
  return root;
}

function hoverText(contents: any): string {
  if (!contents) return '';
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join('\n\n');
  if (contents.language) return '```\n' + contents.value + '\n```';
  return String(contents.value || '');
}

const hover = (ctx: () => Ctx) => hoverTooltip(async (view, at) => {
  const { root, path } = ctx();
  const c = lspFor(root, path);
  if (!c || c.status.state !== 'ready') return null;
  c.flush(path);
  let res: any;
  try { res = await c.request('textDocument/hover', { textDocument: { uri: c.uri(path) }, position: toPos(view.state.doc, at) }, 8000); } catch { return null; }
  const text = hoverText(res?.contents).trim();
  if (!text) return null;
  return { pos: at, above: true, create: () => ({ dom: render(text) }) };
}, { hideOnChange: true, hoverTime: 350 });

const kinds: Record<number, string> = { 2: 'method', 3: 'function', 4: 'function', 5: 'property', 6: 'variable', 7: 'class', 8: 'interface', 9: 'namespace', 10: 'property', 12: 'constant', 13: 'enum', 14: 'keyword', 20: 'enum', 21: 'constant', 22: 'class', 25: 'type' };
/** Snippet syntax in an insertion ($1, ${2:name}) is flattened to plain text: the editor has no tab stops. */
const plain = (t: string) => t.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d+\}|\$\d+/g, '');

export const lspCompletion = (ctx: () => Ctx): CompletionSource => async cc => {
  const { root, path } = ctx();
  const c = lspFor(root, path);
  if (!c || c.status.state !== 'ready') return null;
  const w = cc.matchBefore(/[\w$\\]*/)!;
  const afterOp = /(->|::|\\|\?->)$/.test(cc.state.sliceDoc(Math.max(0, cc.pos - 3), cc.pos));
  if (!cc.explicit && w.from === w.to && !afterOp) return null;
  c.flush(path);
  let res: any;
  try { res = await c.request('textDocument/completion', { textDocument: { uri: c.uri(path) }, position: toPos(cc.state.doc, cc.pos), context: { triggerKind: 1 } }, 6000); } catch { return null; }
  const list: any[] = Array.isArray(res) ? res : res?.items || [];
  if (!list.length) return null;
  const options: Completion[] = list.slice(0, 400).map(i => ({
    label: i.label, detail: i.detail && String(i.detail).length < 60 ? i.detail : undefined, type: kinds[i.kind] || 'text',
    apply: plain(i.textEdit?.newText ?? i.insertText ?? i.label),
    info: typeof i.documentation === 'string' ? i.documentation : i.documentation?.value,
  }));
  return { from: w.from, options, validFor: /^[\w$\\]*$/ };
};

/** Shows the server's problems for the open file in the gutter and as underlines. */
export function applyDiagnostics(view: EditorView, diags: LspDiagnostic[]) {
  const doc = view.state.doc;
  const out: Diagnostic[] = diags.map(d => {
    const from = toOffset(doc, d.range.start);
    // A diagnostic with no severity is an error, as the protocol says.
    return { from, to: Math.max(from, toOffset(doc, d.range.end)), severity: !d.severity || d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info', message: d.message, source: d.source };
  });
  view.dispatch(setDiagnostics(view.state, out));
}

export const lspExtensions = (ctx: () => Ctx) => [
  keymap.of([
    { key: 'Mod-b', preventDefault: true, run: v => { go(v, ctx, 'definition'); return true; } },
    { key: 'Mod-Alt-b', preventDefault: true, run: v => { go(v, ctx, 'implementation'); return true; } },
    { key: 'Alt-F7', preventDefault: true, run: v => { go(v, ctx, 'references'); return true; } },
  ]),
  // Ctrl+click is "go to" here, as in PhpStorm, not "add a cursor".
  EditorView.domEventHandlers({
    mousedown(e, view) {
      if (e.button !== 0 || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
      const at = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (at == null) return false;
      view.dispatch({ selection: { anchor: at } });
      go(view, ctx, 'definition');
      e.preventDefault();
      return true;
    },
  }),
  hover(ctx),
  lintGutter(),
  EditorView.baseTheme({
    '.cm-lsp-hover': { maxWidth: '640px', maxHeight: '320px', overflow: 'auto', padding: '8px 10px', fontSize: '12px', lineHeight: '1.5' },
    '.cm-lsp-hover p': { margin: '0 0 6px' },
    '.cm-lsp-hover pre': { margin: '0 0 6px', fontFamily: 'var(--mono)', fontSize: '11.5px', whiteSpace: 'pre-wrap' },
    '.cm-lsp-hover code': { fontFamily: 'var(--mono)', fontSize: '11.5px', color: 'var(--accent)' },
  }),
];
