import type { View } from './store';

// A tab popped out into its own window: the same app at /?popout=<view as JSON>, showing that one view without the sidebar or tab strip.
// The main window and its popped-out windows talk over a BroadcastChannel: a view opened from inside a popped-out window
// goes to the main window, and opening a popped-out view from the main window brings its window to the front instead of a second copy.

function parse(raw: string | null): View | null {
  if (!raw) return null;
  try { const v = JSON.parse(raw); return v && typeof v.kind === 'string' && v.kind !== 'overview' ? v as View : null; } catch { return null; }
}

/** The view this window holds when it is a popped-out window, else null. */
export const POPOUT: View | null = parse(new URLSearchParams(location.search).get('popout'));

export type PopoutMessage =
  | { t: 'go'; view: View; to?: string }     // to: a popped-out window's tab key; none means the main window
  | { t: 'popin'; view: View };              // a popped-out window closing itself and handing its view back

const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('fleet-popout');
export const post = (m: PopoutMessage) => channel?.postMessage(m);
export function listen(fn: (m: PopoutMessage) => void): () => void {
  if (!channel) return () => {};
  const h = (e: MessageEvent<PopoutMessage>) => fn(e.data);
  channel.addEventListener('message', h);
  return () => channel.removeEventListener('message', h);
}

// Windows this main window opened, by tab key. A reload forgets them; then the view simply opens here again.
const windows = new Map<string, Window>();

/** Opens the view in its own window. Named per tab, so popping out the same tab twice reuses its window. False when the browser blocked it. */
export function popOut(view: View, key: string): boolean {
  const w = window.open(`/?popout=${encodeURIComponent(JSON.stringify(view))}`, `fleet-pop-${key}`, `popup,width=${Math.min(1400, screen.availWidth - 80)},height=${Math.min(900, screen.availHeight - 80)}`);
  if (!w) return false;
  windows.set(key, w);
  w.focus();
  return true;
}

/** The popped-out window holding this tab, if it is still open. */
export function poppedWindow(key: string): Window | null {
  const w = windows.get(key);
  if (w && !w.closed) return w;
  windows.delete(key);
  return null;
}

/** Drops the window for this tab: it is closing and handing its view back. */
export function forget(key: string) { windows.delete(key); }
