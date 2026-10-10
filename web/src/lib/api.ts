import type { Attachment, AwsRun, AwsStatus, ChatEvent, ChatSummary, DialogueSummary, ModelOption, SlashCommandView, Snapshot, TerminalSummary } from '../../../shared/types';

export interface DialogueSpec { topic: string; rounds: number; maxWords: number; cwd?: string; permissionMode?: string; participants: { name: string; persona: string; model?: string; chatId?: string }[] }
export type * from '../../../shared/types';

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body?.error) throw new Error(body?.error || `${r.status} ${r.statusText}`);
  return body as T;
}
const post = <T,>(url: string, data?: unknown) => j<T>(url, { method: 'POST', body: data ? JSON.stringify(data) : undefined });

export const api = {
  snapshot: () => j<Snapshot>('/api/snapshot'),
  history: (sessionId: string) => j<{ history: ChatEvent[] }>(`/api/conversations/${sessionId}/history`).then(r => r.history),
  setHome: (sessionId: string, worktree: string | null) => post<{ ok: true }>(`/api/conversations/${sessionId}/home`, { worktree }),
  rename: (sessionId: string, title: string) => post<{ ok: true; title: string }>(`/api/conversations/${sessionId}/rename`, { title }),
  logs: (bgId: string) => j<{ logs: string }>(`/api/sessions/${encodeURIComponent(bgId)}/logs`).then(r => r.logs),
  removeSession: (bgId: string) => post<{ ok: true }>(`/api/sessions/${encodeURIComponent(bgId)}/remove`),
  openChat: (opts: { sessionId?: string; cwd: string; model?: string; permissionMode?: string }) => post<ChatSummary>('/api/chats', opts),
  chat: (id: string) => j<ChatSummary>(`/api/chats/${id}`),
  commands: (id: string) => j<SlashCommandView[]>(`/api/chats/${id}/commands`),
  models: (id: string) => j<ModelOption[]>(`/api/chats/${id}/models`),
  setModel: (id: string, model: string) => post<ChatSummary>(`/api/chats/${id}/model`, { model }),
  send: (id: string, text: string, fromChatId?: string, attachments?: Attachment[]) => post<{ ok: true }>(`/api/chats/${id}/send`, { text, fromChatId, attachments }),
  permission: (id: string, permId: string, behavior: 'allow' | 'deny') => post<{ ok: boolean }>(`/api/chats/${id}/permission`, { id: permId, behavior }),
  interrupt: (id: string) => post<{ ok: true }>(`/api/chats/${id}/interrupt`),
  shell: (id: string, cmd: string) => post<{ id: string; terminalId: string }>(`/api/chats/${id}/shell`, { cmd }),
  shellInterrupt: (id: string) => post<{ ok: boolean }>(`/api/chats/${id}/shell/interrupt`),
  shellSend: (id: string, runId: string) => post<{ ok: true }>(`/api/chats/${id}/shell/${runId}/send`),
  endChat: (id: string) => j<{ ok: true }>(`/api/chats/${id}`, { method: 'DELETE' }),
  awsStatus: (force = false) => j<AwsStatus>(`/api/aws/status${force ? '?force=1' : ''}`),
  awsRefresh: (forceLogin = false) => post<AwsRun>('/api/aws/refresh', { forceLogin }),
  awsCancel: () => post<{ ok: true }>('/api/aws/cancel'),
  terminals: () => j<TerminalSummary[]>('/api/terminals'),
  openTerminal: (cwd?: string) => post<TerminalSummary>('/api/terminals', { cwd }),
  closeTerminal: (id: string) => j<{ ok: true }>(`/api/terminals/${id}`, { method: 'DELETE' }),
  dialogue: (id: string) => j<DialogueSummary>(`/api/dialogues/${id}`),
  startDialogue: (spec: DialogueSpec) => post<DialogueSummary>('/api/dialogues', spec),
  dialogueAction: (id: string, action: 'pause' | 'resume' | 'stop') => post<DialogueSummary>(`/api/dialogues/${id}/${action}`),
  steerDialogue: (id: string, text: string) => post<DialogueSummary>(`/api/dialogues/${id}/steer`, { text }),
  extendDialogue: (id: string, rounds: number) => post<DialogueSummary>(`/api/dialogues/${id}/extend`, { rounds }),
  removeDialogue: (id: string) => j<{ ok: true }>(`/api/dialogues/${id}`, { method: 'DELETE' }),
};

/** Server-sent events with a typed handler. Reconnects on its own; the browser handles that. */
export function subscribe<T>(url: string, onMessage: (data: T, event: string) => void, onState?: (live: boolean) => void): () => void {
  const es = new EventSource(url);
  es.onmessage = e => onMessage(JSON.parse(e.data), 'message');
  for (const name of ['chat', 'dialogue']) es.addEventListener(name, e => onMessage(JSON.parse((e as MessageEvent).data), name));
  es.onopen = () => onState?.(true);
  es.onerror = () => onState?.(false);
  return () => es.close();
}
