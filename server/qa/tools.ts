// Tools mounted into QA chats. Structured (zod), so nothing is parsed out of prose. Each call goes to the run that owns the chat.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { Chat } from '../chat.js';
import type { QaAgentRole, QaSeverity, QaVerdict } from '../../shared/types.js';

export interface QaChatInfo { runId: string; agentId: string; role: QaAgentRole; lens?: string; dirs: string[] }

export interface FindingInput { title: string; scenario: string; refs: { repo: string; file: string; line: number; end_line?: number }[]; suggested_fix?: string; checklist_item?: string; severity?: QaSeverity }
export interface VerdictInput { group_id: string; verdict: QaVerdict; reason: string; severity?: QaSeverity; settle?: string }
export interface MergeInput { groups: number[]; root_cause: string; title: string }

/** What the QA manager answers each tool call with: the text the chat sees, and whether it was an error. */
export interface QaToolSink {
  finding(chat: Chat, f: FindingInput): { ok: boolean; text: string };
  checked(chat: Chat, item: string, reason: string): { ok: boolean; text: string };
  verdict(chat: Chat, v: VerdictInput): { ok: boolean; text: string };
  merge(chat: Chat, merges: MergeInput[]): { ok: boolean; text: string };
}

export const QA_BUILTIN_TOOLS = ['Read', 'Grep', 'Glob'];
const BY_ROLE: Record<QaAgentRole, string[]> = { lens: ['fleet_qa_finding', 'fleet_qa_checked', 'fleet_sql'], verifier: ['fleet_qa_verdict', 'fleet_sql'], dedupe: ['fleet_qa_group'] };
export const qaToolNames = (role: QaAgentRole) => BY_ROLE[role].map(n => `mcp__fleet__${n}`);

const out = (r: { ok: boolean; text: string }) => ({ content: [{ type: 'text' as const, text: r.text }], ...(r.ok ? {} : { isError: true }) });
const severity = z.enum(['blocker', 'major', 'minor']);

export function qaTools(sink: QaToolSink, self: Chat) {
  const role = self.qa!.role;
  const all = {
    fleet_qa_finding: tool('fleet_qa_finding', 'Report one bug you found. Call it once per bug, as soon as you have traced it. Style, naming and "consider" items are not findings.', {
      title: z.string().min(8).describe('The wrong behaviour in one line, e.g. "DNW\'d early-loss case that returns to 146 shows on neither page"'),
      scenario: z.string().min(40).describe('The concrete state and inputs → the code path (files and lines) → the wrong result. Say what you could not establish, if anything.'),
      refs: z.array(z.object({
        repo: z.string().describe('Target name as in INDEX.md (e.g. tools2)'),
        file: z.string().describe('Path inside the repo, as in the diff'),
        line: z.number().int().min(1),
        end_line: z.number().int().min(1).optional(),
      })).min(1).describe('Where it happens; the first ref is the main one'),
      suggested_fix: z.string().optional(),
      checklist_item: z.string().optional().describe('The checklist item it came from'),
      severity: severity.optional().describe('Your estimate; the verifier sets the final one'),
    }, async (input) => out(sink.finding(self, input))),

    fleet_qa_checked: tool('fleet_qa_checked', 'Record a checklist item you checked that holds, and why. Feeds the coverage section of the report.', {
      item: z.string().min(3).describe('The checklist item'),
      reason: z.string().min(20).describe('What you looked at (files, lines, queries) and why it holds'),
    }, async ({ item, reason }) => out(sink.checked(self, item, reason))),

    fleet_qa_verdict: tool('fleet_qa_verdict', 'Give your verdict on one finding group, by its group id.', {
      group_id: z.string(),
      verdict: z.enum(['CONFIRMED', 'PLAUSIBLE', 'REJECTED']),
      reason: z.string().min(20).describe('The trace: lines checked, the guard that prevents it (REJECTED), or the path that proves it (CONFIRMED)'),
      severity: severity.optional().describe('Required for CONFIRMED and PLAUSIBLE'),
      settle: z.string().optional().describe('PLAUSIBLE: what would settle it'),
    }, async (input) => out(sink.verdict(self, input))),

    fleet_qa_group: tool('fleet_qa_group', 'Merge report groups that share a root cause. One call with every merge; an empty list when nothing should be merged.', {
      merges: z.array(z.object({
        groups: z.array(z.number().int().min(0)).min(2).describe('Group numbers from the list'),
        root_cause: z.string().min(10),
        title: z.string().min(5),
      })),
    }, async ({ merges }) => out(sink.merge(self, merges))),
  };
  return BY_ROLE[role].filter(n => n in all).map(n => all[n as keyof typeof all]);
}
