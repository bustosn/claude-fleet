// Shapes that cross the HTTP/SSE boundary. Imported by the server (runtime-erased) and the web app.

export type SessionKind = 'interactive' | 'background' | 'dashboard';
export type Column = 'needs-you' | 'working' | 'idle' | 'done';
export type ChatStatus = 'starting' | 'idle' | 'running' | 'needs-you' | 'ended';
/** How a session was matched to a worktree: its cwd, a user pin, a ticket key in its title, or the files its transcript mentions. */
export type LocatedBy = 'pinned' | 'cwd' | 'ticket' | 'title' | 'transcript';

export interface TimelineEntry { at: string; state: string; detail: string; text: string }

export interface JobInfo {
  bgId: string; transcriptMissing: boolean;
  state: string; detail: string; tempo: string; needs: string; result: string; suggestedReply: string; intent: string;
  tokens: number | null; model: string | null; permissionMode: string | null;
  createdAt: string | null; updatedAt: string | null; cliVersion: string | null;
  inFlight: unknown; timeline: TimelineEntry[];
}

export interface Session {
  id: string; bgId: string | null; pid: number | null; kind: SessionKind;
  name: string; title: string; cwd: string; sessionId: string | null; startedAt: number | null;
  state: string; column: Column;
  repo: string | null; worktree: string | null; branch: string | null; locatedBy: LocatedBy | null;
  chatId?: string; stale?: boolean;
  job: Omit<JobInfo, 'cwd' | 'name' | 'sessionId'> | null;
}

export interface Worktree {
  path: string; head: string; branch: string | null; detached: boolean; locked: boolean; prunable: boolean;
  isMain: boolean; managed: boolean;
  dirty: number; untracked: number; ahead: number; behind: number; upstream: string | null;
  lastCommit: { hash: string; subject: string; at: number } | null; error: string | null;
  sessions: { id: string; name: string; kind: SessionKind; state: string; column: Column }[];
}

export interface Repo { name: string; path: string; error?: string; worktrees: Worktree[] }

export interface Conversation {
  sessionId: string; title: string; firstPrompt: string; cwd: string; gitBranch: string | null;
  createdAt: number | null; lastModified: number | null; fileSize: number | null;
  repo: string | null; branch: string | null; worktree: string | null; locatedBy: LocatedBy | null;
  running: { id: string; kind: SessionKind; name: string; state: string } | null;
  chat: { id: string; status: ChatStatus } | null;
}

/** A slash command the chat's Claude process accepts: built-in, or a skill/command from the user, project, or a plugin. */
export interface SlashCommandView { name: string; description: string; argumentHint: string; aliases: string[]; builtin: boolean }
/** A file pasted or dropped into the composer, base64. Images go to the model inline; other files are saved for it to read. */
export interface Attachment { name: string; mediaType: string; data: string }
/** A model the chat's Claude process can switch to. `value` may be an alias ("opus"); `resolvedModel` is the full id it stands for. */
export interface ModelOption { value: string; displayName: string; description: string; resolvedModel: string | null }

export interface PermissionView { id: string; toolName: string; input: string; suggestions: number }

/** Token counts. `input` is uncached prompt tokens; cacheRead and cacheWrite are the cached parts of the same prompt. */
export interface TokenUsage { input: number; cacheRead: number; cacheWrite: number; output: number }

export interface ChatSummary {
  id: string; sessionId: string | null; resumeId: string | null; forked: boolean; cwd: string; model: string; title: string;
  repo: string | null; branch: string | null; worktree: string | null; locatedBy: LocatedBy | null; permissionMode: string; status: ChatStatus; startedAt: number;
  pending: PermissionView[]; error: string | null;
  asksIn: { id: string; from: string }[]; asksOut: { id: string; to: string }[];
  /** Set while a dialogue orchestrates this chat: its turns arrive from Fleet, not from the person typing. */
  dialogueId: string | null;
  /** Session totals from the latest result (the SDK reports them cumulatively), plus the size of the prompt the model last saw. Null until the first turn ends. */
  tokens: { total: TokenUsage; context: number; contextWindow: number | null } | null;
}

export interface Role { model: string; effort: string; purpose: string }
export interface DispatchDefaults { permissionMode: string; defaultModel: string; maxConcurrent: number }

/** A shell running inside Fleet. The browser attaches over a WebSocket; it keeps running when its tab closes. */
export interface TerminalSummary { id: string; cwd: string; shell: string; title: string; startedAt: number; exitCode: number | null }

export interface Snapshot {
  generatedAt: number; sessions: Session[]; repos: Repo[]; conversations: Conversation[]; chats: ChatSummary[]; terminals: TerminalSummary[]; dialogues: DialogueSummary[];
  errors: Record<string, string>; roles: Record<string, Role>; dispatch: DispatchDefaults;
}

/** peer: a fleet tool call; manual: forwarded by the person from another chat; dialogue: relayed by a dialogue orchestrator. */
export type MessageOrigin = { kind: 'peer' | 'manual' | 'dialogue'; fromChatId: string; fromTitle: string; askId?: string; dialogueId?: string } | null;

/** Two chats talking to each other about a topic, with Fleet relaying every turn and counting rounds. */
export type DialogueStatus = 'running' | 'paused' | 'done' | 'failed' | 'ended';
export type Side = 'A' | 'B';
export interface Participant {
  side: Side; name: string; persona: string; chatId: string; model: string;
  /** The dialogue started this chat and ends it when it finishes. Chats the person attached are left running. */
  owned: boolean;
}
export interface DialogueSummary {
  id: string; topic: string; status: DialogueStatus; cwd: string;
  /** rounds: exchanges wanted (one message from each side); turns: messages delivered so far. */
  rounds: number; turns: number; maxWords: number;
  speaking: Side | null; participants: Participant[];
  startedAt: number; endedAt: number | null; error: string | null;
  /** Moderator notes queued for the next speaker, and whether a pause is waiting for the current message to finish. */
  pendingNotes: number; pausePending: boolean;
}
export type DialogueEvent =
  | { t: 'status'; status: DialogueStatus; at: number }
  | { t: 'speaking'; side: Side; turn: number; at: number }
  | { t: 'turn'; turn: number; side: Side; name: string; text: string; final: boolean; at: number }
  | { t: 'note'; text: string; kind: 'moderator' | 'system'; at: number };

export type ContentBlock =
  | { type: 'text'; text: string }
  /** `input` is the one field that matters (the command, the path, the pattern); `description` is the model's own note on a shell command. */
  | { type: 'tool_use'; id: string; name: string; input: string; description?: string }
  | { type: 'thinking' }
  | { type: string };

export type ChatEvent =
  | { t: 'status'; status: ChatStatus; at: number }
  | { t: 'init'; sessionId: string; model: string; at: number }
  /** The person switched models mid-chat; the next turn uses it. */
  | { t: 'model'; model: string; at: number }
  /** `attachments` names what came with the message: pasted or dropped images and files. */
  | { t: 'user'; text: string; origin: MessageOrigin; attachments?: string[]; at: number }
  | { t: 'delta'; text: string; at: number }
  | { t: 'tool_start'; name: string; at: number }
  | { t: 'thinking'; at: number }
  | { t: 'assistant'; uuid: string; blocks: ContentBlock[]; at: number }
  | { t: 'tool_result'; toolUseId: string; isError: boolean; text: string; length: number; at: number }
  | { t: 'permission'; id: string; toolName: string; input: string; suggestions: number; at: number }
  | { t: 'permission_resolved'; id: string; behavior: 'allow' | 'deny'; at: number }
  /** Live during a turn: what this turn has used so far, and how big the prompt was at the latest model step. */
  | { t: 'usage'; turn: TokenUsage; context: number; at: number }
  | { t: 'result'; subtype: string; cost: number | null; duration: number | null; turns: number | null; errors: string[] | null;
      usage: TokenUsage | null; total: TokenUsage | null; context: number; contextWindow: number | null; at: number }
  | { t: 'error'; message: string; at: number }
  /** A `!` command the person ran in the chat's own shell. Output streams as snapshots; nothing reaches the model until sent. */
  | { t: 'shell'; id: string; cmd: string; cwd: string; terminalId: string; at: number }
  | { t: 'shell_out'; id: string; output: string; truncated: boolean; at: number }
  | { t: 'shell_done'; id: string; exitCode: number | null; interrupted: boolean; output: string; truncated: boolean; at: number };

export interface AwsRun {
  id: string; startedAt: number; done: boolean; ok: boolean | null; state: string;
  log: { at: number; line: string }[]; approveUrl: string | null; code: string | null; error: string | null; forceLogin: boolean; auto: boolean;
}
export interface AwsStatus {
  /** False when no `aws.profile` is configured: the hub is hidden and nothing polls. */
  enabled: boolean;
  profile: string; credProfile: string; expiration: string | null; arn: string | null;
  ssoExpiresAt: string | null; ssoHasRefresh: boolean; error: string | null; run: AwsRun | null;
  /** The timer found the SSO session expired. It stays quiet until you click Refresh, so no browser tabs pop up on their own. */
  needsLogin: boolean;
}
