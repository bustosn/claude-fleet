import { actions, getState } from '../lib/store';
import { currentFolder } from '../lib/terminal';

const LAST = 'fleet.ide.last';

/** Remembers the folder the IDE was last open on, for the title bar button when nothing on screen names one. */
export function rememberIde(root: string) { try { localStorage.setItem(LAST, root); } catch {} }

const same = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

/** The checkout a folder belongs to: the deepest worktree (or repo) that contains it, else the folder itself. */
function checkoutOf(folder: string): string {
  const f = folder.replace(/\\/g, '/').toLowerCase();
  let best = '';
  for (const r of getState().snapshot?.repos || []) for (const p of [r.path, ...r.worktrees.map(w => w.path)]) {
    const q = p.replace(/\\/g, '/').toLowerCase();
    if ((f === q || f.startsWith(q + '/')) && q.length > best.length) best = p;
  }
  return best || folder;
}

/**
 * The title bar's Code button. Opens the IDE on the folder of what is on screen (a chat's, a worktree's, a terminal's), else on the
 * one used last, else the palette listing every checkout under "Code:".
 */
export function openIde() {
  const here = currentFolder();
  if (here) { actions.go({ kind: 'ide', root: checkoutOf(here) }); return; }
  const open = getState().tabs.find(t => t.view.kind === 'ide');
  if (open) { actions.go(open.view); return; }
  let last: string | null = null;
  try { last = localStorage.getItem(LAST); } catch {}
  const known = last && getState().snapshot?.repos.some(r => [r.path, ...r.worktrees.map(w => w.path)].some(p => same(p, last!)));
  if (last && known) { actions.go({ kind: 'ide', root: last }); return; }
  actions.setPalette(true, 'Code: ');
}
