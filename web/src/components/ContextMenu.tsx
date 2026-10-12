import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent as RMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';

export type MenuItem = { label: string; icon?: LucideIcon; onSelect: () => void; danger?: boolean; disabled?: boolean } | 'separator';

/** A right-click menu for a list row. Spread the handler on the row: `onContextMenu={e => openMenu(e, items)}`, and render `menu` once.
 *  The keyboard's menu key (or Shift+F10) opens it too, anchored under the focused row. */
export function useContextMenu() {
  const [state, setState] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const open = (e: RMouseEvent, items: MenuItem[]) => {
    e.preventDefault(); e.stopPropagation();
    let x = e.clientX, y = e.clientY;
    if (!x && !y) { const r = e.currentTarget.getBoundingClientRect(); x = r.left + 16; y = r.bottom; }
    setState({ x, y, items });
  };
  const menu = state && <ContextMenu {...state} onClose={() => setState(null)} />;
  return [menu, open] as const;
}

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // Through a ref: the owner re-renders on every snapshot, and a new onClose each time must not re-run the effect (and refocus the row).
  const close = useRef(onClose); close.current = onClose;
  // Read during render, before the layout effect moves focus into the menu, so closing hands focus back to the row.
  const [back] = useState(() => document.activeElement as HTMLElement | null);
  // Kept inside the window: a menu opened near the bottom or right edge flips up or left.
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ left: Math.max(4, x + r.width > innerWidth - 4 ? x - r.width : x), top: Math.max(4, y + r.height > innerHeight - 4 ? y - r.height : y) });
    ref.current!.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [x, y]);
  useEffect(() => {
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) close.current(); };
    const shut = () => close.current();
    addEventListener('pointerdown', away, true); addEventListener('scroll', away, true); addEventListener('resize', shut); addEventListener('blur', shut);
    return () => {
      removeEventListener('pointerdown', away, true); removeEventListener('scroll', away, true); removeEventListener('resize', shut); removeEventListener('blur', shut);
      if (back?.isConnected) back.focus();
    };
  }, []);

  const onKey = (e: KeyboardEvent) => {
    const all = [...ref.current!.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); all[(i + 1) % all.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); all[(i - 1 + all.length) % all.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); all[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); all[all.length - 1]?.focus(); }
  };

  return createPortal(
    <div ref={ref} className="menu" role="menu" style={pos} onKeyDown={onKey} onContextMenu={e => e.preventDefault()}>
      {items.map((it, i) => it === 'separator' ? <div key={i} className="menu-sep" role="separator" /> : (
        <button key={i} type="button" role="menuitem" className={`menu-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled}
          onClick={() => { onClose(); it.onSelect(); }}>
          {it.icon ? <it.icon size={13} aria-hidden="true" /> : <span className="w-[13px]" />}{it.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
