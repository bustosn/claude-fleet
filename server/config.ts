import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role, DispatchDefaults } from '../shared/types.js';

export interface AwsConfig {
  profile: string; credProfile: string; resetScript: string; teleportScript: string; ssoRegion: string; chromePath: string;
  autoApprove: boolean; autoRefresh: boolean; autoRefreshMinutesBefore: number;
}

export interface FleetConfig {
  port: number; reposRoot: string; extraRepos: string[]; claudeHome: string;
  poll: { agentsMs: number; gitMs: number; timelineLines: number; conversationsMs: number; conversationsLimit: number };
  dispatch: DispatchDefaults; roles: Record<string, Role>; aws: Partial<AwsConfig>;
  /** Shell for terminal tabs. Null picks powershell.exe on Windows, $SHELL elsewhere. */
  terminal: { shell: string | null };
  /** Saved conversations idle this many days move to Archived on their own. 0 turns it off. */
  conversations: { archiveAfterDays: number };
}

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// FLEET_CONFIG and FLEET_PORT let a second checkout (a dev worktree) run beside the daily instance.
export function loadConfig(): FleetConfig {
  const file = process.env.FLEET_CONFIG || path.join(root, 'fleet.config.json');
  if (!fs.existsSync(file)) fail(`No config at ${file}.\nRun the installer (powershell -ExecutionPolicy Bypass -File scripts\\install.ps1), or copy fleet.config.example.json to fleet.config.json and set reposRoot.`);
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
    roles: raw.roles || {}, aws: raw.aws || {},
    terminal: { shell: raw.terminal?.shell ? String(raw.terminal.shell) : null },
    conversations: { archiveAfterDays: Number(raw.conversations?.archiveAfterDays ?? 14) || 0 },
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
