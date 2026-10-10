import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { ChatEvent, ContentBlock } from '../../shared/types.js';

export interface SavedConversation {
  sessionId: string; title: string; firstPrompt: string; cwd: string; gitBranch: string | null;
  createdAt: number | null; lastModified: number | null; fileSize: number | null;
}

// Saved conversations across every project dir, newest first. ~150ms for 75 sessions.
export async function listConversations(limit = 200): Promise<SavedConversation[]> {
  const rows = await listSessions({ limit });
  return rows.filter(r => r.sessionId).sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0)).map(r => ({
    sessionId: r.sessionId, title: r.customTitle || r.summary || r.firstPrompt || r.sessionId.slice(0, 8),
    firstPrompt: r.firstPrompt || '', cwd: (r.cwd || '').replace(/\\/g, '/'), gitBranch: r.gitBranch || null,
    createdAt: r.createdAt || null, lastModified: r.lastModified || null, fileSize: r.fileSize || null,
  }));
}

export type HistoryEvent = Extract<ChatEvent, { t: 'user' | 'assistant' | 'tool_result' }>;

// Transcript trimmed to what a chat view needs: text, tool names, short tool results. Subagent traffic excluded.
export async function conversationHistory(sessionId: string, keep = 300): Promise<HistoryEvent[]> {
  const msgs = await getSessionMessages(sessionId);
  const out: HistoryEvent[] = [];
  for (const m of msgs as any[]) {
    if (m.parent_tool_use_id) continue;
    const c = m.message?.content;
    const at = 0;
    if (m.type === 'user') {
      if (typeof c === 'string') out.push({ t: 'user', text: c, origin: null, at });
      else if (Array.isArray(c)) for (const b of c) {
        if (b.type === 'text') out.push({ t: 'user', text: b.text, origin: null, at });
        else if (b.type === 'tool_result') {
          const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n') : '';
          out.push({ t: 'tool_result', toolUseId: b.tool_use_id, isError: !!b.is_error, text: text.slice(0, 4000), length: text.length, at });
        }
      }
    } else if (m.type === 'assistant' && Array.isArray(c)) {
      const blocks: ContentBlock[] = c.map((b: any) => b.type === 'text' ? { type: 'text', text: b.text }
        : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: summarizeInput(b.input), description: typeof b.input?.description === 'string' ? b.input.description : undefined }
        : { type: b.type }).filter((b: ContentBlock) => b.type !== 'thinking');
      if (blocks.length) out.push({ t: 'assistant', uuid: m.uuid, blocks, at });
    }
  }
  return out.slice(-keep);
}

export function summarizeInput(input: unknown, max = 400): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const pick = i.command || i.file_path || i.pattern || i.url || i.query || i.question || i.message || i.answer || i.prompt || i.description;
  const s = typeof pick === 'string' ? pick : JSON.stringify(input);
  return s.length > max ? s.slice(0, max) + '…' : s;
}
