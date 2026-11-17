import { RangeSet, RangeSetBuilder, StateEffect, StateField, type Range, type Text } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { api, type IdeBlame, type IdeHunk } from '../lib/api';

// Git in the editor: bars beside lines that differ from HEAD, a column naming who last changed each line (Annotate), and the same
// for the line the cursor is on, faintly after its text. The server answers for the file on disk; the markers are mapped through
// edits made since, so they stay on their lines until the next save refreshes them.

const ago = (t: number) => {
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 3600) return `${Math.max(1, (s / 60) | 0)}m ago`;
  if (s < 86400) return `${(s / 3600) | 0}h ago`;
  if (s < 86400 * 30) return `${(s / 86400) | 0}d ago`;
  if (s < 86400 * 365) return `${(s / (86400 * 30)) | 0}mo ago`;
  return `${(s / (86400 * 365)) | 0}y ago`;
};
const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// ---- Change bars

class Bar extends GutterMarker {
  constructor(readonly kind: IdeHunk['kind']) { super(); }
  eq(o: Bar) { return o.kind === this.kind; }
  toDOM() { const d = document.createElement('div'); d.className = `cm-git-bar cm-git-${this.kind}`; return d; }
}
const bars = { added: new Bar('added'), modified: new Bar('modified'), deleted: new Bar('deleted') };

const setHunks = StateEffect.define<IdeHunk[]>();
function buildBars(doc: Text, hunks: IdeHunk[]): RangeSet<GutterMarker> {
  const b = new RangeSetBuilder<GutterMarker>();
  const at = (n: number) => doc.line(Math.min(Math.max(1, n), doc.lines)).from;
  for (const h of [...hunks].sort((a, c) => a.start - c.start)) {
    if (h.kind === 'deleted') { b.add(at(h.start), at(h.start), bars.deleted); continue; }
    for (let l = h.start; l < h.start + h.count && l <= doc.lines; l++) b.add(at(l), at(l), bars[h.kind]);
  }
  return b.finish();
}
const barField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(v, tr) {
    v = v.map(tr.changes);
    for (const e of tr.effects) if (e.is(setHunks)) v = buildBars(tr.state.doc, e.value);
    return v;
  },
});

// ---- Blame

type Commit = IdeBlame['commits'][number];
class BlameMark extends GutterMarker {
  constructor(readonly c: Commit, readonly first: boolean) { super(); }
  eq(o: BlameMark) { return o.c === this.c && o.first === this.first; }
  toDOM() {
    const d = document.createElement('div');
    const days = (Date.now() / 1000 - this.c.time) / 86400;
    // The stripe is stronger for recent commits, so a glance shows what changed lately.
    const strength = /^0+$/.test(this.c.sha) ? 100 : days < 7 ? 90 : days < 30 ? 65 : days < 180 ? 40 : 18;
    d.className = 'cm-blame-cell';
    d.style.borderLeftColor = `color-mix(in srgb, var(--accent) ${strength}%, transparent)`;
    d.title = `${this.c.summary}\n${this.c.author} · ${when(this.c.time)}\n${this.c.sha.slice(0, 8)}`;
    if (this.first) {
      const a = document.createElement('span'); a.className = 'cm-blame-author'; a.textContent = this.c.author;
      const t = document.createElement('span'); t.className = 'cm-blame-age'; t.textContent = /^0+$/.test(this.c.sha) ? '' : ago(this.c.time);
      d.append(a, t);
    }
    return d;
  }
}

const setBlame = StateEffect.define<IdeBlame | null>();
function buildBlame(doc: Text, data: IdeBlame): RangeSet<BlameMark> {
  const b = new RangeSetBuilder<BlameMark>();
  const marks = data.commits.map(c => [new BlameMark(c, true), new BlameMark(c, false)] as const);
  let prev = -1;
  for (let l = 1; l <= doc.lines; l++) {
    const i = data.lines[l - 1];
    if (i === undefined) { prev = -1; continue; }
    const from = doc.line(l).from;
    b.add(from, from, marks[i][prev === i ? 1 : 0]);
    prev = i;
  }
  return b.finish();
}
const blameField = StateField.define<RangeSet<BlameMark>>({
  create: () => RangeSet.empty,
  update(v, tr) {
    v = v.map(tr.changes);
    for (const e of tr.effects) if (e.is(setBlame)) v = e.value ? buildBlame(tr.state.doc, e.value) : RangeSet.empty;
    return v;
  },
});

/** The Annotate column. Click a name to see that commit's change to the file. */
export const blameGutter = (onCommit: (sha: string, summary: string) => void) => gutter({
  class: 'cm-blame-gutter',
  markers: v => v.state.field(blameField),
  initialSpacer: () => new BlameMark({ sha: 'x', author: 'xxxxxxxxxxxxxxxx', time: 0, summary: '' }, true),
  domEventHandlers: {
    click(view, line) {
      let hit: Commit | null = null;
      view.state.field(blameField).between(line.from, line.from, (_f, _t, m) => { hit = m.c; return false; });
      const c = hit as Commit | null;
      if (c && !/^0+$/.test(c.sha)) { onCommit(c.sha, c.summary); return true; }
      return false;
    },
  },
});

class Inline extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(o: Inline) { return o.text === this.text; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-blame-inline'; s.textContent = this.text; return s; }
  ignoreEvent() { return true; }
}

/** Who changed the cursor's line, and when, shown faintly after its text. */
const inlineBlame = ViewPlugin.fromClass(class {
  decorations: DecorationSet = Decoration.none;
  constructor(view: EditorView) { this.build(view); }
  update(u: ViewUpdate) { if (u.docChanged || u.selectionSet || u.transactions.some(t => t.effects.some(e => e.is(setBlame)))) this.build(u.view); }
  build(view: EditorView) {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    let c: Commit | null = null;
    view.state.field(blameField).between(line.from, line.from, (_f, _t, m) => { c = m.c; return false; });
    const commit = c as Commit | null;
    this.decorations = !commit ? Decoration.none
      : Decoration.set([Decoration.widget({ widget: new Inline(/^0+$/.test(commit.sha) ? 'Not committed yet' : `${commit.author}, ${ago(commit.time)} · ${commit.summary}`), side: 1 }).range(line.to)]);
  }
}, { decorations: v => v.decorations });


// ---- Author above declarations, as PhpStorm's code author: who last changed the line that declares a function or class.

class Lens extends WidgetType {
  constructor(readonly author: string, readonly indent: number) { super(); }
  eq(o: Lens) { return o.author === this.author && o.indent === this.indent; }
  toDOM() {
    const d = document.createElement('div');
    d.className = 'cm-author-lens';
    d.style.paddingLeft = `calc(${this.indent}ch + 6px)`;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 16 16'); icon.setAttribute('width', '11'); icon.setAttribute('height', '11'); icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<circle cx="8" cy="5" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 14c.5-3 2.7-4.5 5.5-4.5s5 1.5 5.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5"/>';
    const name = document.createElement('span'); name.textContent = this.author;
    d.append(icon, name);
    return d;
  }
  ignoreEvent() { return true; }
}

const declaration = /^\s*(?:(?:export|default|public|protected|private|static|final|abstract|readonly|async)\s+)*(?:function|class|interface|trait|enum)\b/;
function buildLens(doc: Text, data: IdeBlame): DecorationSet {
  const out: Range<Decoration>[] = [];
  for (let l = 1; l <= doc.lines && out.length < 2000; l++) {
    const i = data.lines[l - 1];
    if (i === undefined) continue;
    const c = data.commits[i];
    if (/^0+$/.test(c.sha)) continue;
    const line = doc.line(l);
    if (!declaration.test(line.text)) continue;
    const indent = line.text.length - line.text.trimStart().length;
    out.push(Decoration.widget({ widget: new Lens(c.author, indent), block: true, side: -1 }).range(line.from));
  }
  return Decoration.set(out);
}
// Built when the blame arrives and carried through edits after it. A block decoration has to come from a field, not a plugin.
const lensField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    v = v.map(tr.changes);
    for (const e of tr.effects) if (e.is(setBlame)) v = e.value ? buildLens(tr.state.doc, e.value) : Decoration.none;
    return v;
  },
  provide: f => EditorView.decorations.from(f),
});

/** Clicking a change bar shows the diff against HEAD. */
export const gitExtensions = (onBar: () => void) => [
  barField,
  gutter({ class: 'cm-git-gutter', markers: v => v.state.field(barField), initialSpacer: () => bars.modified, domEventHandlers: { click: () => { onBar(); return true; } } }),
  blameField,
  lensField,
  inlineBlame,
  EditorView.baseTheme({
    '.cm-git-gutter': { width: '5px', marginRight: '2px' },
    '.cm-git-bar': { width: '3px', height: '100%', borderRadius: '1px', marginLeft: '1px' },
    '.cm-git-added': { backgroundColor: 'var(--good)' },
    '.cm-git-modified': { backgroundColor: 'var(--info, var(--accent))' },
    '.cm-git-deleted': { height: '0', width: '0', borderLeft: '4px solid var(--crit)', borderTop: '3px solid transparent', borderBottom: '3px solid transparent', position: 'relative', top: '100%', marginTop: '-3px' },
    '.cm-blame-gutter': { minWidth: '190px' },
    '.cm-blame-gutter .cm-gutterElement': { padding: '0 8px 0 0', cursor: 'pointer' },
    '.cm-blame-cell': { display: 'flex', gap: '8px', height: '100%', paddingLeft: '6px', borderLeft: '3px solid transparent', fontSize: '11px', color: 'var(--fg-muted)', whiteSpace: 'nowrap', overflow: 'hidden' },
    '.cm-blame-author': { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '130px' },
    '.cm-blame-age': { color: 'var(--fg-faint)' },
    '.cm-author-lens': { display: 'flex', alignItems: 'center', gap: '4px', height: '20px', color: 'var(--fg-faint)', fontFamily: 'var(--sans, inherit)', fontSize: '11px', userSelect: 'none' },
    '.cm-blame-inline': { marginLeft: '2.5em', color: 'var(--fg-faint)', fontStyle: 'italic', fontSize: '11.5px', userSelect: 'none' },
  }),
];

/** Asks the server what differs from HEAD, and who changed each line, and puts both in the editor. */
export async function refreshGit(view: EditorView, root: string, path: string, stillShown: () => boolean) {
  const [ch, bl] = await Promise.all([
    api.ideGitChanges(root, path).catch(() => null),
    api.ideGitBlame(root, path).catch(() => null),
  ]);
  if (!stillShown()) return;
  view.dispatch({ effects: [setHunks.of(ch?.hunks || []), setBlame.of(bl)] });
}
