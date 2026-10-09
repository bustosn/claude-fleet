import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChatManager, Chat } from './chat.js';

export const FLEET_TOOL_NAMES = ['fleet_list_chats', 'fleet_send', 'fleet_ask', 'fleet_reply', 'fleet_read'].map(n => `mcp__fleet__${n}`);

const text = (s: unknown) => ({ content: [{ type: 'text' as const, text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
const fail = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true });

// One in-process MCP server per chat so each tool call knows who is calling.
export function createFleetServer(mgr: ChatManager, self: Chat) {
  const peers = () => mgr.list().filter(c => c.id !== self.id && c.status !== 'ended');
  const target = (id: string) => { const c = mgr.get(id); return c && c.id !== self.id && c.status !== 'ended' ? c : null; };

  return createSdkMcpServer({
    name: 'fleet', version: '0.2.0',
    instructions: 'Other Claude chats are running on this machine, often in other repos or worktrees. Use fleet_list_chats to see them, fleet_ask when you need an answer from one, fleet_send to hand something over without waiting, and fleet_reply to answer an ask that was sent to you. Keep messages specific: say which repo, branch, file, or ticket you mean.',
    tools: [
      tool('fleet_list_chats', 'List the other chats in the fleet with their id, title, repo, branch, working directory, and status.', {},
        async () => text(peers().map(c => ({ chat_id: c.id, title: c.title, repo: c.repo, branch: c.branch, cwd: c.cwd, status: c.status, model: c.model })))),

      tool('fleet_send', 'Send a message to another chat without waiting for a reply. Use it to hand over findings, a request, or an answer to a question you were asked outside of an ask.', {
        chat_id: z.string().describe('Target chat id from fleet_list_chats'),
        message: z.string().describe('What to tell the other chat'),
      }, async ({ chat_id, message }) => {
        const t = target(chat_id); if (!t) return fail(`No live chat with id ${chat_id}. Call fleet_list_chats.`);
        t.send(message, { kind: 'peer', fromChatId: self.id, fromTitle: self.title });
        return text(`Delivered to "${t.title}" (${t.id}). It will reply with fleet_send if it has something for you.`);
      }),

      tool('fleet_ask', 'Ask another chat a question and wait for its answer. The other chat is told to answer with fleet_reply. Prefer fleet_send when you are answering someone, so two chats never wait on each other.', {
        chat_id: z.string().describe('Target chat id from fleet_list_chats'),
        question: z.string().describe('The question, with enough context to answer it without reading your conversation'),
        timeout_seconds: z.number().int().min(10).max(900).optional().describe('How long to wait. Default 300.'),
      }, async ({ chat_id, question, timeout_seconds }) => {
        const t = target(chat_id); if (!t) return fail(`No live chat with id ${chat_id}. Call fleet_list_chats.`);
        if (t.asksOut.some(a => a.toChatId === self.id)) return fail(`"${t.title}" is currently waiting on an answer from you. Answer it with fleet_reply first, or use fleet_send.`);
        try {
          const answer = await mgr.ask(self, t, question, (timeout_seconds || 300) * 1000);
          return text(`Answer from "${t.title}" (${t.id}):\n\n${answer}`);
        } catch (err: any) { return fail(String(err.message || err)); }
      }),

      tool('fleet_reply', 'Answer an ask that another chat sent you. Use the ask_id from the message header.', {
        ask_id: z.string().describe('The ask id quoted in the incoming message'),
        answer: z.string().describe('Your answer'),
      }, async ({ ask_id, answer }) => {
        const ok = mgr.reply(self, ask_id, answer);
        return ok ? text(`Reply delivered for ask ${ask_id}.`) : fail(`No open ask with id ${ask_id}. It may have timed out; use fleet_send to the asking chat instead.`);
      }),

      tool('fleet_read', 'Read the most recent messages of another chat, to understand what it is doing before asking it something.', {
        chat_id: z.string().describe('Target chat id from fleet_list_chats'),
        limit: z.number().int().min(1).max(60).optional().describe('How many recent messages. Default 15.'),
      }, async ({ chat_id, limit }) => {
        const t = target(chat_id); if (!t) return fail(`No live chat with id ${chat_id}.`);
        const rows = t.events.filter(e => e.t === 'user' || e.t === 'assistant').slice(-(limit || 15)).map(e =>
          e.t === 'user' ? `USER${e.origin ? ` (from ${e.origin.fromTitle || e.origin.kind})` : ''}: ${e.text}`
            : e.t === 'assistant' ? `ASSISTANT: ${e.blocks.map(b => b.type === 'text' ? (b as any).text : b.type === 'tool_use' ? `[${(b as any).name}: ${(b as any).input}]` : '').join('\n')}` : '');
        return text(rows.join('\n\n') || '(no messages yet)');
      }),
    ],
  });
}
