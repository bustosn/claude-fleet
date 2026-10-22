import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChatManager, Chat } from './chat.js';
import type { Teleport } from './teleport.js';
import type { TeleportTunnel } from '../shared/types.js';

export const FLEET_TOOL_NAMES = ['fleet_list_chats', 'fleet_send', 'fleet_ask', 'fleet_reply', 'fleet_read', 'fleet_report', 'fleet_teleport_status', 'fleet_tunnel_restart', 'fleet_teleport_login'].map(n => `mcp__fleet__${n}`);

const text = (s: unknown) => ({ content: [{ type: 'text' as const, text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
const fail = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true });

// One in-process MCP server per chat so each tool call knows who is calling.
export function createFleetServer(mgr: ChatManager, self: Chat) {
  const peers = () => mgr.list().filter(c => c.id !== self.id && c.status !== 'ended');
  const target = (id: string) => { const c = mgr.get(id); return c && c.id !== self.id && c.status !== 'ended' ? c : null; };

  return createSdkMcpServer({
    name: 'fleet', version: '0.2.0',
    instructions: 'Other Claude chats are running on this machine, often in other repos or worktrees. Use fleet_list_chats to see them, fleet_ask when you need an answer from one, fleet_send to hand something over without waiting, and fleet_reply to answer an ask that was sent to you. Keep messages specific: say which repo, branch, file, or ticket you mean.'
      + (mgr.teleport?.enabled ? ' Local DB ports (3316, 3317, ...) are Teleport tunnels: when a connection to one fails, call fleet_teleport_status and fleet_tunnel_restart instead of asking for reset.sh.' : ''),
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

      ...(mgr.teleport?.enabled ? teleportTools(mgr.teleport) : []),

      // Only task workers get this: it is how a card moves to Needs you with something worth reading on it.
      ...(self.taskId ? [tool('fleet_report', 'Report on the board task you are working on. Call it once at the end of your work with status "review" and a summary for the person, or with status "blocked" when you cannot go on without them, putting the question in the summary. Then end your turn.', {
        status: z.enum(['review', 'blocked']).describe('review: the work is ready for the person to check. blocked: you need a decision, access, or information from them.'),
        summary: z.string().describe('For review: what you changed, how you verified it, and anything left open. For blocked: exactly what you need. Markdown, a few short paragraphs at most.'),
      }, async ({ status, summary }) => {
        mgr.emit('task-report', self, { status, summary });
        return text(status === 'review' ? 'Reported. The task is in the person\'s review queue; end your turn now.' : 'Reported. The person will answer in this chat; end your turn now.');
      })] : []),
    ],
  });
}

// DB tunnels through Teleport. A chat whose query fails with "server has gone away" or a refused connection can see why and fix its own tunnel.
// Prod tunnels can be restarted when they are already running, but only the person opens a new one, from the Teleport chip.
function teleportTools(tp: Teleport) {
  const brief = (t: TeleportTunnel) => ({ alias: t.alias, port: t.port, state: t.state, note: t.note, prod: t.prod, target: t.target, probe: t.probe ? `${t.probe.ok ? 'ok' : 'FAILED'}: ${t.probe.detail}` : undefined });
  return [
    tool('fleet_teleport_status', 'Teleport session and the local DB tunnels (alias, localhost port, state, what each points at). Call it when a database connection fails, before suggesting reset.sh. probe=true also connects through each running tunnel and checks the database answers.', {
      probe: z.boolean().optional().describe('Round-trip check through the tunnels. Default false.'),
    }, async ({ probe }) => {
      if (probe) await tp.probe();
      const s = await tp.status(true);
      return text({ session: s.session && { user: s.session.user, validUntil: s.session.validUntil, expired: s.session.expired, loggedIn: s.session.loggedIn },
        tunnels: s.tunnels.map(brief), hint: !s.session?.loggedIn || s.session.expired ? 'The session is expired: call fleet_teleport_login, or ask the person to click the Teleport chip.' : undefined });
    }),

    tool('fleet_tunnel_restart', 'Start or restart one DB tunnel on its configured port, aimed at the current database (the newest dev cluster for dated ones). Use it when fleet_teleport_status shows the tunnel down, stale or failing its probe.', {
      alias: z.string().describe('Tunnel alias from fleet_teleport_status'),
    }, async ({ alias }) => {
      const cur = (await tp.status(true)).tunnels.find(t => t.alias === alias);
      if (!cur) return fail(`No tunnel named ${alias}. Call fleet_teleport_status for the list.`);
      if (cur.prod && !cur.runningDb) return fail(`${alias} is a prod tunnel that is not running. Ask the person to start it from the Teleport chip in Fleet.`);
      try { const r = await tp.start(alias); return text(brief(r)); } catch (err: any) { return fail(String(err.message || err)); }
    }),

    tool('fleet_teleport_login', 'Start a Teleport login when the session has expired. It opens a sign-in page in the browser that the person they must click through, so tell them it is waiting on them. Running tunnels are restarted once it succeeds.', {},
      async () => {
        const s = await tp.status(true);
        if (s.session?.loggedIn && !s.session.expired) return text(`Already logged in as ${s.session.user} until ${s.session.validUntil}. No login needed.`);
        const r = tp.startLogin();
        return text(`Login ${r.done ? 'finished' : 'started'}. A Teleport sign-in page is open in the person's browser${r.url ? ` (${r.url})` : ''}; it needs their click. Check fleet_teleport_status in a minute.`);
      }),
  ];
}
