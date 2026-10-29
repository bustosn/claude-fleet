import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role, DispatchDefaults, TunnelSpec } from '../shared/types.js';

export interface AwsConfig {
  profile: string; credProfile: string; resetScript: string; resetSh: string; teleportScript: string; ssoRegion: string; chromePath: string;
  autoApprove: boolean; autoRefresh: boolean; autoRefreshMinutesBefore: number;
}

/** Teleport session and DB tunnels. Off without a proxy. A tunnel `db` with * picks the newest match (dated dev clusters). */
export interface TeleportConfig {
  proxy: string; user: string; auth: string; tsh: string; dbUser: string; tunnels: TunnelSpec[];
  /** Re-point non-prod tunnels that still aim at an older match of their pattern. */
  autoRepoint: boolean;
  /** Restart running tunnels after a login, since they hold the old certificates. */
  restartAfterLogin: boolean;
}

export interface FleetConfig {
  port: number; reposRoot: string; extraRepos: string[]; claudeHome: string;
  poll: { agentsMs: number; gitMs: number; timelineLines: number; conversationsMs: number; conversationsLimit: number };
  dispatch: DispatchDefaults; roles: Record<string, Role>; aws: Partial<AwsConfig>; teleport: Partial<TeleportConfig>;
  /** Shell for terminal tabs. Null picks powershell.exe on Windows, $SHELL elsewhere. */
  terminal: { shell: string | null };
  /** Saved conversations idle this many days move to Archived on their own. 0 turns it off. */
  conversations: { archiveAfterDays: number };
  jira: JiraConfig;
}

/** Jira Cloud (email + API token, REST v3) or Data Center (personal access token only, REST v2). Off without a baseUrl and token.
 *  `repos` maps a project key to the folder its tickets are worked in; a ticket label naming a repo under reposRoot also works.
 *  `jql` turns the watcher on: matching tickets become tasks, each picked up once. */
export interface JiraConfig {
  baseUrl: string; email: string; apiToken: string;
  repos: Record<string, string>; jql: string; everyMinutes: number;
  /** The Jira view: which tickets it shows; `projects` are the switcher's choices, the first one the default (none means one board of everything);
   *  `columns` are statuses to show first and in this order (even when empty, so cards can be dropped there): one list for every project, or a list per project key. */
  board: { jql: string; projects: { key: string; name: string }[]; columns: string[] | Record<string, string[]> };
  /** New tickets: the form's defaults, extra `fields` sent with the create, `afterCreate` field sets applied one at a time in order,
   *  then the ticket is assigned to you when `assignToMe` (last, because some workflows clear the assignee when other fields change). */
  create: { project: string; issueType: string; assignToMe: boolean; template: string; fields: Record<string, unknown>; afterCreate: Record<string, unknown>[] };
}

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// FLEET_CONFIG and FLEET_PORT let a second checkout (a dev worktree) run beside the daily instance.
export function loadConfig(): FleetConfig {
  const file = process.env.FLEET_CONFIG || path.join(root, 'fleet.config.json');
  if (!fs.existsSync(file)) fail(`No config at ${file}.\nRun the installer (Windows: powershell -ExecutionPolicy Bypass -File scripts\\install.ps1; Mac: ./scripts/install.sh), or copy fleet.config.example.json to fleet.config.json and set reposRoot.`);
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { fail(`${file} is not valid JSON: ${(err as Error).message}`); }
  if (!raw.reposRoot || !fs.existsSync(raw.reposRoot)) fail(`reposRoot in ${file} is ${raw.reposRoot ? `"${raw.reposRoot}", which does not exist` : 'not set'}. Set it to the folder your git repos live in.`);
  // Claude Code keeps its sessions under ~/.claude unless told otherwise; the example's placeholder path counts as unset.
  if (!raw.claudeHome || /[\\/]you[\\/]/.test(raw.claudeHome)) raw.claudeHome = path.join(os.homedir(), '.claude');
  const cfg: FleetConfig = {
    port: Number(process.env.FLEET_PORT || raw.port || 7777),
    reposRoot: raw.reposRoot, extraRepos: Array.isArray(raw.extraRepos) ? raw.extraRepos.map(String) : [], claudeHome: raw.claudeHome,
    poll: { agentsMs: 3000, gitMs: 10000, timelineLines: 30, conversationsMs: 15000, conversationsLimit: 200, ...(raw.poll || {}) },
    dispatch: { permissionMode: 'auto', defaultModel: 'fable', maxConcurrent: 4, ...(raw.dispatch || {}) },
    roles: raw.roles || {}, aws: raw.aws || {}, teleport: raw.teleport || {},
    terminal: { shell: raw.terminal?.shell ? String(raw.terminal.shell) : null },
    conversations: { archiveAfterDays: Number(raw.conversations?.archiveAfterDays ?? 14) || 0 },
    jira: {
      baseUrl: String(raw.jira?.baseUrl || '').replace(/\/+$/, ''), email: String(raw.jira?.email || ''),
      // The token can stay out of the file.
      apiToken: String(raw.jira?.apiToken || process.env.JIRA_API_TOKEN || ''),
      repos: raw.jira?.repos && typeof raw.jira.repos === 'object' ? Object.fromEntries(Object.entries(raw.jira.repos).map(([k, v]) => [k.toUpperCase(), String(v)])) : {},
      jql: String(raw.jira?.jql || '').trim(), everyMinutes: Math.max(1, Number(raw.jira?.everyMinutes) || 5),
      board: {
        jql: String(raw.jira?.board?.jql || '').trim() || 'assignee = currentUser() AND (statusCategory != Done OR resolved >= -7d) ORDER BY updated DESC',
        projects: (Array.isArray(raw.jira?.board?.projects) ? raw.jira.board.projects : []).map((p: any) => typeof p === 'string' ? { key: p, name: p } : { key: String(p?.key || ''), name: String(p?.name || p?.key || '') })
          .map((p: { key: string; name: string }) => ({ ...p, key: p.key.toUpperCase() })).filter((p: { key: string }) => /^[A-Z][A-Z0-9_]+$/.test(p.key)),
        columns: Array.isArray(raw.jira?.board?.columns) ? raw.jira.board.columns.map(String)
          : raw.jira?.board?.columns && typeof raw.jira.board.columns === 'object' ? Object.fromEntries(Object.entries(raw.jira.board.columns).map(([k, v]) => [k.toUpperCase(), Array.isArray(v) ? v.map(String) : []])) : [],
      },
      create: {
        project: String(raw.jira?.create?.project || '').toUpperCase(), issueType: String(raw.jira?.create?.issueType || 'Task'),
        assignToMe: raw.jira?.create?.assignToMe !== false, template: String(raw.jira?.create?.template || ''),
        fields: raw.jira?.create?.fields && typeof raw.jira.create.fields === 'object' ? raw.jira.create.fields : {},
        afterCreate: Array.isArray(raw.jira?.create?.afterCreate) ? raw.jira.create.afterCreate.filter((f: unknown) => f && typeof f === 'object') : [],
      },
    },
  };
  return cfg;
}

/** A setup mistake: one readable line instead of a stack trace. */
function fail(msg: string): never {
  console.error(`
Fleet cannot start: ${msg}
`);
  process.exit(1);
}
