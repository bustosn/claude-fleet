import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { api } from '../lib/api';
import { shortPath } from '../lib/format';
import { actions, useStore } from '../lib/store';

// Dialogs the sidebar's right-click menus open. One host renders them (in the Sidebar), so any row can open one
// without holding dialog state of its own.

type Open =
  | { kind: 'forward'; text: string; fromChatId?: string; fromTitle?: string }
  | { kind: 'move'; sessionId: string; title: string; worktree: string | null }
  | null;
let current: Open = null;
const listeners = new Set<() => void>();
const show = (next: Open) => { current = next; listeners.forEach(l => l()); };

/** Forward text to a live chat. `fromChatId` names a live chat as the sender; `fromTitle` a saved conversation. */
export const openForward = (text: string, from: { chatId?: string; title?: string }) => show({ kind: 'forward', text, fromChatId: from.chatId, fromTitle: from.title });
export const openMove = (sessionId: string, title: string, worktree: string | null) => show({ kind: 'move', sessionId, title, worktree });

/** The last reply in a conversation's transcript, for forwarding. Works for live chats too: the transcript is written as they go. */
export async function forwardLastReply(sessionId: string, from: { chatId?: string; title: string }) {
  try {
    const history = await api.history(sessionId);
    const last = [...history].reverse().find(e => e.t === 'assistant' && e.blocks.some(b => 'text' in b && b.text?.trim()));
    const text = last?.t === 'assistant' ? last.blocks.map(b => ('text' in b ? b.text ?? '' : '')).filter(Boolean).join('\n\n') : '';
    openForward(text, from);
  } catch (err: any) { actions.toast(err.message, 'error'); }
}

/** Downloads the transcript as markdown. Fetched rather than linked, so a failure is a toast and not a downloaded error page. */
export async function exportConversation(sessionId: string) {
  try {
    const r = await fetch(`/api/conversations/${sessionId}/export`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `${r.status} ${r.statusText}`);
    const name = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '')?.[1] || `${sessionId}.md`;
    const url = URL.createObjectURL(await r.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err: any) { actions.toast(`Export failed: ${err.message}`, 'error'); }
}

export function SidebarDialogs() {
  const open = useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l); }, () => current);
  const close = () => show(null);
  if (open?.kind === 'forward') return <ForwardDialog {...open} onClose={close} />;
  if (open?.kind === 'move') return <MoveDialog {...open} onClose={close} />;
  return null;
}

/** Sends text to another live chat, which sees it as forwarded from the sender. Also used by the chat view's "Send to chat". */
export function ForwardDialog({ text: initial, fromChatId, fromTitle, onClose }: { text: string; fromChatId?: string; fromTitle?: string; onClose: () => void }) {
  const snap = useStore(s => s.snapshot);
  const targets = (snap?.chats || []).filter(c => c.id !== fromChatId && c.status !== 'ended');
  const [target, setTarget] = useState(targets[0]?.id || '');
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try { await api.forward(target, text.trim(), { chatId: fromChatId, title: fromTitle }); actions.toast(`Sent to ${targets.find(t => t.id === target)?.title}`); ref.current?.close(); }
    catch (err: any) { actions.toast(err.message, 'error'); }
  };
  return (
    <dialog ref={ref} onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Send to another chat</h2>
        {targets.length === 0 ? <p className="text-[12px] text-fg-muted">No other live chat to send to. Open or start another chat first.</p> : (
          <>
            <label>Target chat
              <select className="input" value={target} onChange={e => setTarget(e.target.value)}>
                {targets.map(c => <option key={c.id} value={c.id}>{c.title} ({c.repo ? `${c.repo} / ${c.branch || ''}` : shortPath(c.cwd)}, {c.status})</option>)}
              </select>
            </label>
            <label>Message<textarea className="input" rows={8} value={text} onChange={e => setText(e.target.value)} /></label>
            <p className="text-[11px] text-fg-faint">The target sees it as a forwarded message{fromTitle && !fromChatId ? ` from "${fromTitle}"` : ' from this chat'}. Agents can also message each other on their own with the fleet tools.</p>
          </>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
          {targets.length > 0 && <button type="submit" className="btn primary" disabled={!text.trim()}>Send</button>}
        </div>
      </form>
    </dialog>
  );
}

/** Pins a conversation to a worktree, so it shows under that project; "Automatic" clears the pin and lets Fleet place it again. */
function MoveDialog({ sessionId, title, worktree, onClose }: { sessionId: string; title: string; worktree: string | null; onClose: () => void }) {
  const snap = useStore(s => s.snapshot);
  const options = (snap?.repos || []).flatMap(r => r.worktrees.map(w => ({ path: w.path, label: w.isMain ? r.name : `${r.name} / ${w.branch || shortPath(w.path)}` })));
  const [target, setTarget] = useState(options.find(o => o.path.toLowerCase() === (worktree || '').toLowerCase())?.path || '');
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try { await api.setHome(sessionId, target || null); actions.toast(target ? `Moved to ${options.find(o => o.path === target)?.label}` : 'Placed automatically again'); ref.current?.close(); }
    catch (err: any) { actions.toast(err.message, 'error'); }
  };
  return (
    <dialog ref={ref} onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Move "{title}" to a project</h2>
        <label>Project
          <select className="input" value={target} onChange={e => setTarget(e.target.value)} autoFocus>
            <option value="">Automatic (from its folder, title, or transcript)</option>
            {options.map(o => <option key={o.path} value={o.path}>{o.label}</option>)}
          </select>
        </label>
        <p className="text-[11px] text-fg-faint">Only changes where Fleet lists it. The conversation's folder and transcript stay as they are.</p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
          <button type="submit" className="btn primary">Move</button>
        </div>
      </form>
    </dialog>
  );
}
