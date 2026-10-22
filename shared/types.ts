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
  sessions: { id: string; name: string; kind: SessionKind; state: string; column: Column }[];
}

export interface Repo { name: string; path: string; error?: string; worktrees: Worktree[] }

export interface Conversation {
  sessionId: string; title: string; firstPrompt: string; cwd: string; gitBranch: string | null;
  createdAt: number | null; lastModified: number | null; fileSize: number | null;
  repo: string | null; branch: string | null; worktree: string | null; locatedBy: LocatedBy | null;
  running: { id: string; kind: SessionKind; name: string; state: string } | null;
  chat: { id: string; status: ChatStatus } | null;
  /** Listed under Archived, collapsed, instead of with the recent ones: put there by the user, or idle long enough (`autoArchived`). */
  archived: boolean; autoArchived: boolean;
  /** Kept at the top of the recent ones, and never archived automatically. */
  pinned: boolean;
}

/** A slash command the chat's Claude process accepts: built-in, or a skill/command from the user, project, or a plugin. */
export interface SlashCommandView { name: string; description: string; argumentHint: string; aliases: string[]; builtin: boolean }
/** A file pasted or dropped into the composer, base64. Images go to the model inline; other files are saved for it to read. */
export interface Attachment { name: string; mediaType: string; data: string }
/** A path named in a chat, resolved against the chat's folder. `kind` is null when nothing is there. */
export interface FileRef { path: string; abs: string; kind: 'file' | 'dir' | null }
/** What the file viewer shows. `text` is set for text files; images load from the raw route. */
export interface FilePreview {
  abs: string; name: string; size: number; kind: 'text' | 'image' | 'binary' | 'too-large'; text?: string;
  /** VS Code is on the PATH. */ editor: boolean;
  /** Opening it with the default app would run it, so that button is off. */ runnable: boolean;
}
/** A model the chat's Claude process can switch to. `value` may be an alias ("opus"); `resolvedModel` is the full id it stands for. */
export interface ModelOption { value: string; displayName: string; description: string; resolvedModel: string | null }

/** An MCP server as one chat's process sees it. `needs-auth` means a browser sign-in is due; that happens in a terminal, not through the SDK. */
export interface McpServerView { name: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'; scope: string | null; url: string | null; tools: number; error: string | null }

/** One question Claude asks through its AskUserQuestion tool. The answer is an option label, several joined with ", ", or free text. */
export interface AskQuestion { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }

/** `questions` is set when the tool is AskUserQuestion: the card shows the choices instead of Allow/Deny. */
/** What an Edit, MultiEdit or Write changes in one file. Each hunk is old text replaced by new text; a Write is one hunk with no old text. Long text is cut. */
export interface EditPreview { path: string; write: boolean; hunks: { old: string; new: string }[] }
export type TodoItem = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string };
/** `plan` is set for ExitPlanMode (the card shows the plan and the way to approve it), `edit` for file edits (the card shows the diff). */
export interface PermissionView { id: string; toolName: string; input: string; suggestions: number; questions?: AskQuestion[]; plan?: string; edit?: EditPreview }
export type PermissionChoice = { behavior: 'allow' | 'deny'; message?: string; answers?: Record<string, string>; always?: boolean; mode?: string };

/** Token counts. `input` is uncached prompt tokens; cacheRead and cacheWrite are the cached parts of the same prompt. */
export interface TokenUsage { input: number; cacheRead: number; cacheWrite: number; output: number }

export interface ChatSummary {
  id: string; sessionId: string | null; resumeId: string | null; forked: boolean; cwd: string; model: string; title: string;
  repo: string | null; branch: string | null; worktree: string | null; locatedBy: LocatedBy | null; permissionMode: string; effort: string | null; status: ChatStatus; startedAt: number;
  pending: PermissionView[]; error: string | null;
  asksIn: { id: string; from: string }[]; asksOut: { id: string; to: string }[];
  /** Set while a dialogue orchestrates this chat: its turns arrive from Fleet, not from the person typing. */
  dialogueId: string | null;
  /** Set when the chat is the worker on a board task. */
  taskId: string | null;
  /** Session totals from the latest result (the SDK reports them cumulatively), plus the size of the prompt the model last saw. Null until the first turn ends. */
  tokens: { total: TokenUsage; context: number; contextWindow: number | null } | null;
}

/** The context window by category, as `/context` shows it. */
export interface ContextUsage { total: number; max: number; percentage: number; model: string; categories: { name: string; tokens: number; kind: string; color: string }[]; memoryFiles: { path: string; tokens: number }[] }
/** A user message the chat can restore files to, with what that would change. */
export interface RewindPreview { canRewind: boolean; error?: string; files: string[]; insertions: number; deletions: number }

export interface Role { model: string; effort: string; purpose: string }
export interface DispatchDefaults { permissionMode: string; defaultModel: string; maxConcurrent: number }

/** A shell running inside Fleet. The browser attaches over a WebSocket; it keeps running when its tab closes. */
export interface TerminalSummary { id: string; cwd: string; shell: string; title: string; startedAt: number; exitCode: number | null }

/** A unit of work on the board. A chat is its worker: Fleet starts one when a slot is free, and the chat reports back with fleet_report.
 *  queued → working → review | blocked → (approve) done, or (send back) working again. `failed` means the worker is gone. */
export type TaskStatus = 'queued' | 'working' | 'review' | 'blocked' | 'done' | 'failed';
export interface TaskSummary {
  id: string; title: string; prompt: string; cwd: string; model: string; permissionMode: string;
  status: TaskStatus; chatId: string | null;
  /** The worker's latest word: its fleet_report summary, its last message when it stopped without one, or what it is waiting on. */
  summary: string | null;
  /** How many times the person sent it back. */
  rounds: number;
  /** Work on its own branch in a new worktree (`cwd` is then only where the branch starts from). */
  isolate: boolean;
  /** Set once the worktree exists. `worktree` goes back to null when Approve removes it; the branch stays for merging. */
  branch: string | null; worktree: string | null;
  /** What the branch started from: a branch name, or a short sha when that checkout was detached. `baseSha` is the exact commit. */
  base: string | null; baseSha: string | null;
  /** Commits and changed lines against the base, refreshed at each report: "2 commits · 3 files, +40 −5". */
  diff: string | null;
  /** The Jira ticket the task came from, linked by hand or picked up by the watcher. */
  ticket: string | null; ticketUrl: string | null;
  createdAt: number; startedAt: number | null; updatedAt: number; finishedAt: number | null; error: string | null;
}

/** Jira as the board sees it. `jql` is set when the watcher is on; `unmapped` lists tickets it found but has no repo for. */
export interface JiraStatus {
  enabled: boolean; baseUrl: string; jql: string | null; everyMinutes: number;
  lastPoll: number | null; error: string | null; unmapped: string[];
}
/** A ticket as the New task form previews it. `cwd` is the folder Fleet would pick for it, if it knows one. */
export interface JiraIssuePreview { key: string; summary: string; url: string; status: string; type: string; cwd: string | null }

export interface Snapshot {
  jira: JiraStatus | null;
  generatedAt: number; sessions: Session[]; repos: Repo[]; conversations: Conversation[]; chats: ChatSummary[]; terminals: TerminalSummary[]; dialogues: DialogueSummary[]; tasks: TaskSummary[];
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
  | { type: 'tool_use'; id: string; name: string; input: string; description?: string; edit?: EditPreview }
  | { type: 'thinking'; text?: string }
  | { type: string };

export type ChatEvent =
  | { t: 'status'; status: ChatStatus; at: number }
  | { t: 'init'; sessionId: string; model: string; at: number }
  /** The person switched models mid-chat; the next turn uses it. */
  | { t: 'model'; model: string; at: number }
  /** `attachments` names what came with the message: pasted or dropped images and files. */
  | { t: 'user'; text: string; origin: MessageOrigin; attachments?: string[]; uuid?: string; at: number }
  | { t: 'delta'; text: string; at: number }
  | { t: 'tool_start'; name: string; at: number }
  | { t: 'thinking'; at: number }
  /** The chat's task list as it stands now (from TodoWrite, or TaskCreate and TaskUpdate). */
  | { t: 'todos'; todos: TodoItem[]; at: number }
  /** The person (or an approved plan) changed the permission mode. */
  | { t: 'mode'; mode: string; at: number }
  /** A subagent or background task: one event per change, matched by `taskId`. */
  | { t: 'task'; taskId: string; status: 'running' | 'completed' | 'failed' | 'stopped'; description: string; kind: string; tools: number; tokens: number; lastTool?: string; summary?: string; at: number }
  | { t: 'assistant'; uuid: string; blocks: ContentBlock[]; at: number }
  | { t: 'tool_result'; toolUseId: string; isError: boolean; text: string; length: number; at: number }
  | ({ t: 'permission'; at: number } & PermissionView)
  | { t: 'permission_resolved'; id: string; behavior: 'allow' | 'deny'; answers?: Record<string, string>; always?: boolean; at: number }
  /** Live during a turn: what this turn has used so far, and how big the prompt was at the latest model step. */
  | { t: 'usage'; turn: TokenUsage; context: number; at: number }
  | { t: 'result'; subtype: string; isError: boolean; cost: number | null; duration: number | null; turns: number | null; errors: string[] | null;
      usage: TokenUsage | null; total: TokenUsage | null; context: number; contextWindow: number | null; at: number }
  | { t: 'error'; message: string; at: number }
  /** A `!` command the person ran in the chat's own shell. Output streams as snapshots; nothing reaches the model until sent. */
  | { t: 'shell'; id: string; cmd: string; cwd: string; terminalId: string; at: number }
  | { t: 'shell_out'; id: string; output: string; truncated: boolean; at: number }
  | { t: 'shell_done'; id: string; exitCode: number | null; interrupted: boolean; output: string; truncated: boolean; at: number };

export interface TunnelSpec { alias: string; db: string; port: number; prod?: boolean; dbUser?: string }
export interface TeleportTunnel {
  alias: string; port: number; db: string; prod: boolean;
  /** The database the tunnel should point at now: `db` itself, or the newest match of its pattern. Null when nothing matches. */
  target: string | null;
  /** up, stale (an older match of the pattern), other (a db outside the pattern), down, busy (port held by something else), missing, expired, starting. */
  state: 'up' | 'stale' | 'other' | 'down' | 'busy' | 'missing' | 'expired' | 'starting';
  note: string; pid: number | null; runningDb: string | null; owner: 'fleet' | 'external' | null;
  probe: { at: number; ok: boolean; detail: string } | null;
}
export interface TeleportRun {
  id: string; startedAt: number; done: boolean; ok: boolean | null; state: string;
  log: { at: number; line: string }[]; url: string | null; error: string | null; restarted: string[];
}
/** What the setup panel can prefill. `running` and each database's `suggest` are ready-made tunnel rows (port 0: not chosen yet). */
export interface TeleportSetupInfo {
  /** Null version: tsh is not installed or not runnable at `tsh`. */
  tsh: string; version: string | null; proxies: string[]; loggedIn: boolean; user: string | null;
  current: { proxy: string; user: string; tunnels: TunnelSpec[] };
  running: TunnelSpec[];
  databases: { name: string; label: string; stage: string; endpoint: string; suggest: TunnelSpec }[];
  dbError: string | null;
}
export interface TeleportStatus {
  /** False without `teleport.proxy` in the config. */
  enabled: boolean; proxy: string; tsh: string;
  session: { loggedIn: boolean; user: string | null; roles: string[]; validUntil: string | null; expired: boolean; error: string | null } | null;
  tunnels: TeleportTunnel[]; dbListAt: number | null; dbListError: string | null; run: TeleportRun | null; events: { at: number; line: string }[];
}

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
