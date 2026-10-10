import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { actions, useStore } from '../lib/store';
import { ProjectTree } from './ProjectTree';
import { ConversationList } from './ConversationList';
import { TerminalList } from './TerminalList';
import { DialogueList } from './DialogueList';

export function Sidebar() {
  const width = useStore(s => s.sidebarWidth);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; w: number } | null>(null);

  const onDown = (e: RPointerEvent<HTMLDivElement>) => { e.currentTarget.setPointerCapture(e.pointerId); start.current = { x: e.clientX, w: width }; setDragging(true); };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => { if (start.current) actions.setSidebarWidth(start.current.w + e.clientX - start.current.x); };
  const onUp = () => { start.current = null; setDragging(false); };

  return (
    <aside className="relative flex min-h-0 flex-col border-r border-line bg-surface" style={{ width }}>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <ProjectTree />
        <TerminalList />
        <DialogueList />
        <ConversationList />
      </div>
      <div
        role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabIndex={0}
        className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onDoubleClick={() => actions.setSidebarWidth(300)}
        onKeyDown={e => { if (e.key === 'ArrowLeft') actions.setSidebarWidth(width - 8); if (e.key === 'ArrowRight') actions.setSidebarWidth(width + 8); }}
      >
        <span className={`absolute left-[3px] top-0 h-full w-px transition-colors ${dragging ? 'bg-accent' : 'bg-transparent hover:bg-accent'}`} />
      </div>
    </aside>
  );
}
