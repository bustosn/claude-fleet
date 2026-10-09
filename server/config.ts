import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role, DispatchDefaults } from '../shared/types.js';

export interface AwsConfig {
  profile: string; credProfile: string; resetScript: string; ssoRegion: string; chromePath: string;
  autoApprove: boolean; autoRefresh: boolean; autoRefreshMinutesBefore: number;
}

export interface FleetConfig {
  port: number; reposRoot: string; extraRepos: string[]; claudeHome: string;
  poll: { agentsMs: number; gitMs: number; timelineLines: number; conversationsMs: number; conversationsLimit: number };
  dispatch: DispatchDefaults; roles: Record<string, Role>; aws: Partial<AwsConfig>;
}

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// FLEET_CONFIG and FLEET_PORT let a second checkout (a dev worktree) run beside the daily instance.
export function loadConfig(): FleetConfig {
  const file = process.env.FLEET_CONFIG || path.join(root, 'fleet.config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg: FleetConfig = {
    port: Number(process.env.FLEET_PORT || raw.port || 7777),
    reposRoot: raw.reposRoot, extraRepos: Array.isArray(raw.extraRepos) ? raw.extraRepos.map(String) : [], claudeHome: raw.claudeHome,
    poll: { agentsMs: 3000, gitMs: 10000, timelineLines: 30, conversationsMs: 15000, conversationsLimit: 200, ...(raw.poll || {}) },
    dispatch: { permissionMode: 'auto', defaultModel: 'fable', maxConcurrent: 4, ...(raw.dispatch || {}) },
    roles: raw.roles || {}, aws: raw.aws || {},
  };
  return cfg;
}
