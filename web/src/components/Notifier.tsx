import { useEffect, useRef } from 'react';
import { actions, getState, useStore } from '../lib/store';
import type { ChatStatus } from '../lib/api';

const BASE_TITLE = 'Fleet';

/** Tells you when a chat is waiting on you while you are somewhere else: a tab-title count always, and a desktop notification
 *  (once the browser allows it) when this window is hidden or the chat is not the one on screen. Renders nothing. */
export function Notifier() {
  const chats = useStore(s => s.snapshot?.chats);
  const seen = useRef(new Map<string, ChatStatus>());

  // Browsers only grant notifications after a gesture, so ask on the first click anywhere.
  useEffect(() => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
    const ask = () => { Notification.requestPermission().catch(() => {}); };
    window.addEventListener('pointerdown', ask, { once: true });
    return () => window.removeEventListener('pointerdown', ask);
  }, []);

  useEffect(() => {
    if (!chats) return;
    const waiting = chats.filter(c => c.status === 'needs-you').length;
    document.title = waiting ? `(${waiting}) ${BASE_TITLE}` : BASE_TITLE;

    const first = seen.current.size === 0;
    for (const c of chats) {
      const before = seen.current.get(c.id);
      seen.current.set(c.id, c.status);
      if (first || before === c.status || typeof Notification === 'undefined' || Notification.permission !== 'granted') continue;
      const v = getState().view;
      const looking = !document.hidden && v.kind === 'chat' && v.chatId === c.id;
      if (looking) continue;
      const needs = c.status === 'needs-you';
      const finished = before === 'running' && c.status === 'idle' && document.hidden;
      if (!needs && !finished) continue;
      const first_ = c.pending[0];
      const n = new Notification(needs ? `${c.title} needs you` : `${c.title} finished`, {
        body: needs ? (first_?.questions?.[0]?.question || (first_?.plan ? 'A plan is ready for review' : `${first_?.toolName || 'A tool'} is waiting for permission`)) : 'Ready for your next message',
        tag: `fleet-${c.id}`, silent: false,
      });
      n.onclick = () => { window.focus(); actions.go({ kind: 'chat', chatId: c.id }); n.close(); };
    }
  }, [chats]);

  return null;
}
