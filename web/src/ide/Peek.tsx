import { useEffect, useRef, useState } from 'react';
import { File } from 'lucide-react';
import { actions } from '../lib/store';
import { jumpTo, showPeek, type Session } from './session';

/** Several places to choose from: the usages of a method, or a definition that has more than one. Enter opens the highlighted one. */
export function Peek({ session }: { session: Session }) {
  const peek = session.peek;
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { setCursor(0); box.current?.focus(); }, [peek]);
  useEffect(() => { box.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' }); }, [cursor]);
  if (!peek) return null;

  const close = () => showPeek(session, null);
  const pick = async (i: number) => {
    const it = peek.items[i];
    close();
    const err = await jumpTo(session, peek.from, it);
    if (err) actions.toast(err, 'error');
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]" onPointerDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div ref={box} tabIndex={-1} className="panel w-[760px] max-w-[94vw] overflow-hidden shadow-[var(--shadow)] outline-none" role="dialog" aria-label={peek.title}
        onKeyDown={e => {
          if (e.key === 'Escape') close();
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(peek.items.length - 1, c + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(0, c - 1)); }
          // preventDefault: focus moves to the editor while this key is still going down, and it would type a newline there.
          if (e.key === 'Enter') { e.preventDefault(); pick(cursor); }
        }}>
        <div className="border-b border-line px-3 py-2 text-[12px] font-semibold">{peek.title}</div>
        <div className="max-h-[60vh] overflow-y-auto p-1">
          {peek.items.map((it, i) => (
            <button key={`${it.path}:${it.line}:${it.col}`} className="row h-8" aria-current={i === cursor ? 'true' : undefined} onMouseEnter={() => setCursor(i)} onClick={() => pick(i)}>
              <File size={13} className="shrink-0 text-fg-faint" aria-hidden="true" />
              <span className="mono min-w-0 shrink-0 text-[11.5px] text-fg-muted">{it.path.slice(it.path.lastIndexOf('/') + 1)}:{it.line}</span>
              <span className="mono grow truncate text-[12px]">{it.text}</span>
              <span className="max-w-[40%] shrink truncate text-[11px] text-fg-faint">{it.path.includes('/') ? it.path.slice(0, it.path.lastIndexOf('/')) : ''}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
