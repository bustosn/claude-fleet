import type { Attachment, ContextUsage, PermissionChoice, RewindPreview, AwsRun, AwsStatus, TeleportRun, TeleportSetupInfo, TeleportStatus, TeleportTunnel, TunnelSpec, ChatEvent, ChatSummary, DialogueSummary, FilePreview, FileRef, McpServerView, ModelOption, SlashCommandView, Snapshot, TaskSummary, TerminalSummary, JiraIssuePreview, JiraStatus, JiraBoard, JiraTransition, JiraCreateInfo, JiraCreated, SqlInfo, SqlSchema, SqlColumnInfo, SqlIndexInfo, SqlTab, SqlHistoryEntry, SqlCredential, SqlLookup, SqlProcess, SqlTableMeta, SqlReference, SqlColumnHit, SqlSaved, SqlSnippet, SqlValue, UsageReport } from '../../../shared/types';

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
  pin: (sessionId: string, pinned: boolean) => post<{ ok: true }>(`/api/conversations/${sessionId}/pin`, { pinned }),
  openWorktree: (path: string, how: 'editor' | 'folder') => post<{ ok: true }>('/api/worktrees/open', { path, how }),
  archive: (sessionId: string, archived: boolean) => post<{ ok: true }>(`/api/conversations/${sessionId}/archive`, { archived }),
  deleteConversation: (sessionId: string) => j<{ ok: true }>(`/api/conversations/${sessionId}`, { method: 'DELETE' }),
  logs: (bgId: string) => j<{ logs: string }>(`/api/sessions/${encodeURIComponent(bgId)}/logs`).then(r => r.logs),
  removeSession: (bgId: string) => post<{ ok: true }>(`/api/sessions/${encodeURIComponent(bgId)}/remove`),
  openChat: (opts: { sessionId?: string; cwd: string; model?: string; permissionMode?: string }) => post<ChatSummary>('/api/chats', opts),
  chat: (id: string) => j<ChatSummary>(`/api/chats/${id}`),
  commands: (id: string) => j<SlashCommandView[]>(`/api/chats/${id}/commands`),
  resolveFiles: (id: string, paths: string[]) => post<FileRef[]>(`/api/chats/${id}/files/resolve`, { paths }),
  file: (id: string, path: string) => j<FilePreview>(`/api/chats/${id}/file?path=${encodeURIComponent(path)}`),
  fileRawUrl: (id: string, path: string) => `/api/chats/${id}/file/raw?path=${encodeURIComponent(path)}`,
  openFile: (id: string, path: string, how: 'editor' | 'default' | 'reveal', line?: number) => post<{ ok: true }>(`/api/chats/${id}/file/open`, { path, how, line }),
  models: (id: string) => j<ModelOption[]>(`/api/chats/${id}/models`),
  setModel: (id: string, model: string) => post<ChatSummary>(`/api/chats/${id}/model`, { model }),
  mcp: (id: string) => j<McpServerView[]>(`/api/chats/${id}/mcp`),
  mcpAction: (id: string, name: string, action: 'reconnect' | 'enable' | 'disable') => post<McpServerView[]>(`/api/chats/${id}/mcp/${encodeURIComponent(name)}/${action}`),
  mcpLogin: (id: string) => post<TerminalSummary>(`/api/chats/${id}/mcp/login`),
  send: (id: string, text: string, fromChatId?: string, attachments?: Attachment[]) => post<{ ok: true }>(`/api/chats/${id}/send`, { text, fromChatId, attachments }),
  /** Forwarded text: from a live chat (`chatId`), or from a saved conversation, which only has a title. */
  forward: (id: string, text: string, from: { chatId?: string; title?: string }) => post<{ ok: true }>(`/api/chats/${id}/send`, { text, fromChatId: from.chatId, fromTitle: from.title }),
  permission: (id: string, permId: string, choice: PermissionChoice) => post<{ ok: boolean }>(`/api/chats/${id}/permission`, { id: permId, ...choice }),
  setMode: (id: string, mode: string) => post<ChatSummary>(`/api/chats/${id}/mode`, { mode }),
  setEffort: (id: string, effort: string | null) => post<ChatSummary>(`/api/chats/${id}/effort`, { effort }),
  context: (id: string) => j<ContextUsage>(`/api/chats/${id}/context`),
  rewind: (id: string, uuid: string, dryRun: boolean) => post<RewindPreview>(`/api/chats/${id}/rewind`, { uuid, dryRun }),
  stopTask: (id: string, taskId: string) => post<{ ok: true }>(`/api/chats/${id}/tasks/${encodeURIComponent(taskId)}/stop`),
  suggestFiles: (id: string, q: string) => j<string[]>(`/api/chats/${id}/files/suggest?q=${encodeURIComponent(q)}`),
  answerQuestions: (id: string, permId: string, answers: Record<string, string>) => post<{ ok: boolean }>(`/api/chats/${id}/permission`, { id: permId, behavior: 'allow', answers }),
  interrupt: (id: string) => post<{ ok: true }>(`/api/chats/${id}/interrupt`),
  shell: (id: string, cmd: string) => post<{ id: string; terminalId: string }>(`/api/chats/${id}/shell`, { cmd }),
  shellInterrupt: (id: string) => post<{ ok: boolean }>(`/api/chats/${id}/shell/interrupt`),
  shellSend: (id: string, runId: string) => post<{ ok: true }>(`/api/chats/${id}/shell/${runId}/send`),
  endChat: (id: string) => j<{ ok: true }>(`/api/chats/${id}`, { method: 'DELETE' }),
  awsStatus: (force = false) => j<AwsStatus>(`/api/aws/status${force ? '?force=1' : ''}`),
  awsRefresh: (forceLogin = false) => post<AwsRun>('/api/aws/refresh', { forceLogin }),
  awsReset: () => post<{ ok: true }>('/api/aws/reset'),
  awsProfiles: () => j<{ profiles: string[] }>('/api/aws/profiles').then(r => r.profiles),
  awsSwitchUser: () => post<AwsRun>('/api/aws/switch-user'),
  awsSetup: (profile: string) => post<{ ok: true }>('/api/aws/setup', { profile }),
  awsCancel: () => post<{ ok: true }>('/api/aws/cancel'),
  teleportStatus: (force = false) => j<TeleportStatus>(`/api/teleport/status${force ? '?force=1' : ''}`),
  teleportSetupInfo: () => j<TeleportSetupInfo>('/api/teleport/setup'),
  teleportSetup: (body: { proxy: string; user?: string; tunnels: TunnelSpec[] }) => post<{ ok: true }>('/api/teleport/setup', body),
  teleportLogin: (force = false) => post<TeleportRun>('/api/teleport/login', { force }),
  teleportCancel: () => post<{ ok: true }>('/api/teleport/cancel'),
  tunnelStart: (alias: string) => post<TeleportTunnel>(`/api/teleport/tunnels/${encodeURIComponent(alias)}/start`),
  tunnelStop: (alias: string) => post<TeleportTunnel>(`/api/teleport/tunnels/${encodeURIComponent(alias)}/stop`),
  tunnelStartAll: (includeProd = false) => post<{ alias: string; ok: boolean; detail: string }[]>('/api/teleport/tunnels/start-all', { includeProd }),
  tunnelProbe: (alias?: string) => post<TeleportTunnel[]>('/api/teleport/probe', alias ? { alias } : {}),
  terminals: () => j<TerminalSummary[]>('/api/terminals'),
  openTerminal: (cwd?: string) => post<TerminalSummary>('/api/terminals', { cwd }),
  closeTerminal: (id: string) => j<{ ok: true }>(`/api/terminals/${id}`, { method: 'DELETE' }),
  dialogue: (id: string) => j<DialogueSummary>(`/api/dialogues/${id}`),
  startDialogue: (spec: DialogueSpec) => post<DialogueSummary>('/api/dialogues', spec),
  dialogueAction: (id: string, action: 'pause' | 'resume' | 'stop') => post<DialogueSummary>(`/api/dialogues/${id}/${action}`),
  steerDialogue: (id: string, text: string) => post<DialogueSummary>(`/api/dialogues/${id}/steer`, { text }),
  extendDialogue: (id: string, rounds: number) => post<DialogueSummary>(`/api/dialogues/${id}/extend`, { rounds }),
  removeDialogue: (id: string) => j<{ ok: true }>(`/api/dialogues/${id}`, { method: 'DELETE' }),
  addTask: (spec: { title?: string; prompt: string; cwd: string; model?: string; permissionMode?: string; isolate?: boolean; ticket?: string }) => post<TaskSummary>('/api/tasks', spec),
  jiraIssue: (key: string) => j<JiraIssuePreview>(`/api/jira/issue/${encodeURIComponent(key)}`),
  jiraPoll: () => post<JiraStatus>('/api/jira/poll'),
  jiraBoard: (project?: string) => j<JiraBoard>(`/api/jira/board${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  jiraTransitions: (key: string) => j<JiraTransition[]>(`/api/jira/issue/${encodeURIComponent(key)}/transitions`),
  jiraMove: (key: string, by: { id?: string; to?: string }) => post<{ ok: true }>(`/api/jira/issue/${encodeURIComponent(key)}/transition`, by),
  jiraCreateInfo: () => j<JiraCreateInfo>('/api/jira/create'),
  jiraIssueTypes: (project: string) => j<{ id: string; name: string }[]>(`/api/jira/projects/${encodeURIComponent(project)}/types`),
  jiraCreate: (spec: { project: string; issueType: string; summary: string; description: string; assignToMe: boolean }) => post<JiraCreated>('/api/jira/issues', spec),
  taskAction: (id: string, action: 'approve' | 'retry' | 'start') => post<TaskSummary>(`/api/tasks/${id}/${action}`),
  sendBackTask: (id: string, text: string) => post<TaskSummary>(`/api/tasks/${id}/send-back`, { text }),
  removeTask: (id: string) => j<{ ok: true }>(`/api/tasks/${id}`, { method: 'DELETE' }),
  clearDoneTasks: () => post<{ ok: true }>('/api/tasks/clear-done'),
  sqlInfo: () => j<SqlInfo>('/api/sql/info'),
  sqlSchema: (alias: string, refresh = false) => j<SqlSchema>(`/api/sql/schema/${encodeURIComponent(alias)}${refresh ? '?refresh=1' : ''}`),
  sqlColumns: (alias: string, db: string) => j<Record<string, SqlColumnInfo[]>>(`/api/sql/schema/${encodeURIComponent(alias)}/${encodeURIComponent(db)}/columns`),
  sqlTableColumns: (alias: string, db: string, table: string) => j<SqlColumnInfo[]>(`/api/sql/schema/${encodeURIComponent(alias)}/${encodeURIComponent(db)}/${encodeURIComponent(table)}/columns`),
  sqlIndexes: (alias: string, db: string, table: string) => j<SqlIndexInfo[]>(`/api/sql/schema/${encodeURIComponent(alias)}/${encodeURIComponent(db)}/${encodeURIComponent(table)}/indexes`),
  sqlTableMeta: (alias: string, db: string, table: string) => j<SqlTableMeta>(`/api/sql/schema/${encodeURIComponent(alias)}/${encodeURIComponent(db)}/${encodeURIComponent(table)}/meta`),
  sqlReferencedBy: (alias: string, db: string, table: string, all = false) => j<SqlReference[]>(`/api/sql/schema/${encodeURIComponent(alias)}/${encodeURIComponent(db)}/${encodeURIComponent(table)}/referenced-by${all ? '?all=1' : ''}`),
  sqlFindColumns: (alias: string, q: string, db?: string | null) => j<SqlColumnHit[]>(`/api/sql/find-columns/${encodeURIComponent(alias)}?q=${encodeURIComponent(q)}${db ? `&db=${encodeURIComponent(db)}` : ''}`),
  sqlSaved: (jira?: string) => j<SqlSaved[]>(`/api/sql/saved${jira ? `?jira=${encodeURIComponent(jira)}` : ''}`),
  sqlSaveQuery: (id: string, v: Partial<SqlSaved>) => j<SqlSaved[]>(`/api/sql/saved/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(v) }),
  sqlDeleteSaved: (id: string) => j<SqlSaved[]>(`/api/sql/saved/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  sqlSnippets: () => j<SqlSnippet[]>('/api/sql/snippets'),
  sqlSaveSnippet: (name: string, v: Partial<SqlSnippet> & { rename?: string }) => j<SqlSnippet[]>(`/api/sql/snippets/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(v) }),
  sqlDeleteSnippet: (name: string) => j<SqlSnippet[]>(`/api/sql/snippets/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  sqlEdit: (body: { alias: string; op: 'update' | 'delete'; db: string; table: string; pk: Record<string, SqlValue>; set?: Record<string, SqlValue>; dryRun: boolean }) =>
    post<{ sql: string; matches: number | null; affected: number | null }>('/api/sql/edit', body),
  sqlTabs: () => j<SqlTab[]>('/api/sql/tabs'),
  sqlSaveTabs: (tabs: SqlTab[]) => j<{ ok: true }>('/api/sql/tabs', { method: 'PUT', body: JSON.stringify({ tabs }) }),
  sqlHistory: () => j<SqlHistoryEntry[]>('/api/sql/history'),
  sqlLookup: (name: string, value: string) => post<{ alias: string; sql: string; view: 'record' | 'grid'; title: string }>('/api/sql/lookup', { name, value }),
  sqlCredentials: () => j<SqlCredential[]>('/api/sql/credentials'),
  sqlSetCredentials: (alias: string, user: string, password?: string) => j<SqlCredential[]>(`/api/sql/credentials/${encodeURIComponent(alias)}`, { method: 'PUT', body: JSON.stringify({ user, password }) }),
  sqlForgetCredentials: (alias: string) => j<SqlCredential[]>(`/api/sql/credentials/${encodeURIComponent(alias)}`, { method: 'DELETE' }),
  sqlSaveLookup: (name: string, l: Partial<SqlLookup> & { rename?: string }) => j<SqlLookup[]>(`/api/sql/lookups/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(l) }),
  sqlDeleteLookup: (name: string) => j<SqlLookup[]>(`/api/sql/lookups/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  sqlProcesses: (alias: string) => j<SqlProcess[]>(`/api/sql/processes/${encodeURIComponent(alias)}`),
  sqlKill: (alias: string, id: number, mode: 'query' | 'connection') => post<{ ok: true; via: string }>(`/api/sql/processes/${encodeURIComponent(alias)}/${id}/kill`, { mode }),
  usage: (days: number) => j<UsageReport>(`/api/usage?days=${days}`),
  sqlCancel: (id: string) => j<{ ok: boolean }>(`/api/sql/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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
