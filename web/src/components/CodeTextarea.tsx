import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from 'react';

type Seg = { code: false; text: string } | { code: true; info: string; text: string };

const OPEN = /^```/;
const CLOSE = /^```\s*$/;

/** Message text → alternating text / code segments (always starting and ending with text). Only a fence that closes makes a block. */
function parse(value: string): Seg[] {
  const lines = value.split('\n');
  const segs: Seg[] = [];
  let cur: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const close = OPEN.test(lines[i]) ? lines.findIndex((l, j) => j > i && CLOSE.test(l)) : -1;
    if (close < 0) { cur.push(lines[i]); continue; }
    segs.push({ code: false, text: cur.join('\n') });
    segs.push({ code: true, info: lines[i].slice(3), text: lines.slice(i + 1, close).join('\n') });
    cur = []; i = close;
    if (i === lines.length - 1) cur = [''];
  }
  segs.push({ code: false, text: cur.join('\n') });
  return segs;
}

function serialize(segs: Seg[]): string {
  return segs.map(s => s.code ? '```' + s.info + '\n' + s.text + '\n```' : s.text).join('\n');
}

export type CodeTextareaHandle = { focus: () => void };

type Props = {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  className?: string;
  /** Extra class for the wrapper; `rich-boxed` draws the box itself when no surrounding box exists. */
  wrapClass?: string;
};

/** A message box where typing ``` turns the spot into an embedded code block (no backticks shown) and the text carries on below it.
 *  The value stays a plain string with ``` fences. Text and code are separate textareas that look like one box. */
export const CodeTextarea = forwardRef<CodeTextareaHandle, Props>(function CodeTextarea({ value, onChange, onKeyDown, onPaste, placeholder, disabled, rows = 3, className = 'input', wrapClass = '' }, ref) {
  const segs = parse(value);
  const boxes = useRef<(HTMLTextAreaElement | null)[]>([]);
  const want = useRef<{ i: number; pos: number } | null>(null);
  const multi = segs.length > 1;

  useImperativeHandle(ref, () => ({
    focus: () => { const el = boxes.current[segs.length - 1]; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } },
  }));
  useLayoutEffect(() => {
    boxes.current.length = segs.length;
    for (const el of boxes.current) if (el) { el.style.height = 'auto'; if (multi) el.style.height = el.scrollHeight + 'px'; }
    const w = want.current; want.current = null;
    const el = w && boxes.current[w.i];
    if (el) { el.focus(); const p = w.pos < 0 ? el.value.length : w.pos; el.setSelectionRange(p, p); }
  });

  const commit = (next: Seg[], focus?: { i: number; pos: number }) => { if (focus) want.current = focus; onChange(serialize(next)); };
  const edit = (i: number, text: string) => commit(segs.map((s, k) => k === i ? { ...s, text } : s));

  const onText = (i: number, e: ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value, caret = e.target.selectionStart ?? v.length;
    const before = v.slice(0, caret), after = v.slice(caret);
    const typed = (e.nativeEvent as InputEvent).inputType === 'insertText';
    if (typed && !segs[i].code && !value.startsWith('!') && /(^|\n)```$/.test(before)) {
      const head = before.slice(0, -3).replace(/\n$/, ''), tail = after.replace(/^\n/, '');
      const next: Seg[] = [...segs.slice(0, i), { code: false, text: head }, { code: true, info: '', text: '' }, { code: false, text: tail }, ...segs.slice(i + 1)];
      commit(next, { i: i + 1, pos: 0 });
      return;
    }
    edit(i, v);
  };

  const keys = (i: number, e: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    const el = e.currentTarget, s = segs[i];
    const collapsed = el.selectionStart === el.selectionEnd, atStart = collapsed && el.selectionStart === 0, atEnd = collapsed && el.selectionStart === el.value.length;
    const go = (to: number, pos: number) => {
      e.preventDefault();
      const t = boxes.current[to];
      if (t) { t.focus(); const p = pos < 0 ? t.value.length : pos; t.setSelectionRange(p, p); }
    };
    if (s.code) {
      if (e.key === 'Escape') { go(i + 1, 0); return; }
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const a = el.selectionStart, b = el.selectionEnd; commit(segs.map((x, k) => k === i ? { ...x, text: s.text.slice(0, a) + '  ' + s.text.slice(b) } : x), { i, pos: a + 2 }); return; }
      if (e.key === 'Backspace' && atStart && s.text === '') { // an empty block disappears and its neighbours join
        e.preventDefault();
        const a = segs[i - 1].text, b = segs[i + 1].text;
        commit([...segs.slice(0, i - 1), { code: false, text: a && b ? a + '\n' + b : a + b }, ...segs.slice(i + 2)], { i: i - 1, pos: a.length });
        return;
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowRight') && atEnd) go(i + 1, 0);
      else if ((e.key === 'ArrowUp' || e.key === 'ArrowLeft') && atStart) go(i - 1, -1);
    } else {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowRight') && atEnd && segs[i + 1]) go(i + 1, 0);
      else if ((e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'Backspace') && atStart && i > 0) go(i - 1, -1);
    }
  };

  return (
    <div className={`rich-wrap ${multi ? 'multi' : ''} ${wrapClass}`}>
      {segs.map((s, i) => s.code
        ? <div key={i} className="rich-code"><textarea ref={el => { boxes.current[i] = el; }} data-code="true" className="rich-code-body mono" rows={1} value={s.text} spellCheck={false} disabled={disabled} aria-label="Code block"
            onChange={e => onText(i, e)} onKeyDown={e => keys(i, e)} onPaste={onPaste} /></div>
        : <textarea key={i} ref={el => { boxes.current[i] = el; }} className={className} rows={multi ? 1 : rows} value={s.text} disabled={disabled}
            placeholder={!multi ? placeholder : undefined} onChange={e => onText(i, e)} onKeyDown={e => keys(i, e)} onPaste={onPaste} />)}
    </div>
  );
});
