import { api } from './api';
import { actions, getState } from './store';

/** Where a new terminal should start: the folder of what is on screen, else the server's default (reposRoot). */
export function currentFolder(): string | undefined {
  const { view, snapshot } = getState();
  if (view.kind === 'worktree') return view.path;
  if (view.kind === 'chat') return snapshot?.chats.find(c => c.id === view.chatId)?.cwd;
  if (view.kind === 'terminal') return snapshot?.terminals.find(t => t.id === view.id)?.cwd;
  if (view.kind === 'session') return snapshot?.sessions.find(s => s.id === view.id)?.cwd;
  if (view.kind === 'new-chat' || view.kind === 'resume') return view.cwd;
  return undefined;
}

export async function openTerminal(cwd: string | undefined = currentFolder()) {
  try { const t = await api.openTerminal(cwd); actions.go({ kind: 'terminal', id: t.id }); }
  catch (e: any) { actions.toast(`Could not open a terminal: ${e.message}`, 'error'); }
}
