import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { ChevronDown, ListPlus, MessageSquarePlus, Plus, SquareTerminal, Users } from 'lucide-react';
import { actions, useStore } from '../lib/store';
import { openTerminal } from '../lib/terminal';
import { useContextMenu } from './ContextMenu';
import { ProjectTree } from './ProjectTree';
import { ConversationList } from './ConversationList';
import { TerminalList } from './TerminalList';
import { DialogueList } from './DialogueList';
import { SidebarDialogs } from './SidebarDialogs';

export function Sidebar() {
  const width = useStore(s => s.sidebarWidth);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; w: number } | null>(null);
  const [menu, openMenu] = useContextMenu();

  const onDown = (e: RPointerEvent<HTMLDivElement>) => { e.currentTarget.setPointerCapture(e.pointerId); start.current = { x: e.clientX, w: width }; setDragging(true); };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => { if (start.current) actions.setSidebarWidth(start.current.w + e.clientX - start.current.x); };
  const onUp = () => { start.current = null; setDragging(false); };

  return (
    <aside className="sidebar relative flex min-h-0 flex-col" style={{ width }}>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {/* Every "start something" lives in this one menu, so section headers carry no buttons. */}
        <button className="btn sm mb-2 w-full" aria-haspopup="menu" onClick={e => openMenu(e, [
          { label: 'Chat', icon: MessageSquarePlus, onSelect: () => actions.go({ kind: 'new-chat' }) },
          { label: 'Task', icon: ListPlus, onSelect: () => actions.go({ kind: 'new-task' }) },
          { label: 'Terminal', icon: SquareTerminal, onSelect: () => openTerminal() },
          { label: 'Dialogue', icon: Users, onSelect: () => actions.go({ kind: 'new-dialogue' }) },
        ])}><Plus size={14} aria-hidden="true" /> New <ChevronDown size={13} className="ml-auto text-fg-faint" aria-hidden="true" /></button>
        {menu}
        <ProjectTree />
        <TerminalList />
        <DialogueList />
        <ConversationList />
      </div>
      <SidebarDialogs />
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
