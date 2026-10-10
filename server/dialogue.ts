import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ChatManager, Chat } from './chat.js';
import type { ChatEvent, DialogueEvent, DialogueStatus, DialogueSummary, Participant, Side } from '../shared/types.js';

export interface ParticipantSpec { name: string; persona?: string; model?: string; chatId?: string }
export interface DialogueSpec { topic: string; rounds?: number; maxWords?: number; cwd: string; permissionMode?: string; participants: ParticipantSpec[] }

// Distributive Omit: a plain Omit over the union would collapse it to the shared keys.
type DialogueEventInput = DialogueEvent extends infer E ? (E extends DialogueEvent ? Omit<E, 'at'> : never) : never;
type Saved = DialogueSummary & { events: DialogueEvent[]; notes: string[] };

const MAX_ROUNDS = 50;
const other = (s: Side): Side => (s === 'A' ? 'B' : 'A');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Starts dialogues, keeps them across a restart, and feeds the snapshot. */
export class DialogueManager extends EventEmitter {
  chats: ChatManager; dialogues = new Map<string, Dialogue>();
  private persistFile: string | null = null;

  constructor(chats: ChatManager) { super(); this.chats = chats; }

  list(): DialogueSummary[] { return [...this.dialogues.values()].map(d => d.summary()).sort((a, b) => b.startedAt - a.startedAt); }
  get(id: string) { return this.dialogues.get(id); }

  start(spec: DialogueSpec): Dialogue {
    const topic = String(spec.topic || '').trim();
    if (!topic) throw new Error('A topic is required.');
    if (!Array.isArray(spec.participants) || spec.participants.length !== 2) throw new Error('A dialogue needs exactly two participants.');
    const rounds = Math.min(MAX_ROUNDS, Math.max(1, Math.round(Number(spec.rounds) || 6)));
    const maxWords = Math.min(2000, Math.max(50, Math.round(Number(spec.maxWords) || 250)));
    const names = spec.participants.map(p => String(p.name || '').trim());
    if (names.some(n => !n)) throw new Error('Both participants need a name.');
    if (names[0].toLowerCase() === names[1].toLowerCase()) throw new Error('The two participants need different names.');
    const ids = spec.participants.map(p => p.chatId).filter((x): x is string => !!x);
    if (ids.length === 2 && ids[0] === ids[1]) throw new Error('A chat cannot talk to itself.');
    for (const id of ids) {
      const c = this.chats.get(id);
      if (!c || c.status === 'ended') throw new Error(`No live chat with id ${id}.`);
      if (c.dialogueId) throw new Error(`"${c.title}" is already in a dialogue.`);
    }

    const id = randomUUID().slice(0, 8);
    const participants = spec.participants.map((p, i): Participant => {
      const chat = p.chatId ? this.chats.get(p.chatId)! : this.chats.open({ cwd: spec.cwd, model: p.model || undefined, permissionMode: spec.permissionMode || undefined });
      return { side: i === 0 ? 'A' : 'B', name: names[i], persona: String(p.persona || '').trim(), chatId: chat.id, model: chat.model, owned: !p.chatId };
    });
    const d = new Dialogue(this, { id, topic, rounds, maxWords, cwd: spec.cwd, participants, startedAt: Date.now() });
    this.dialogues.set(id, d);
    d.claimChats();
    d.emitEvent({ t: 'status', status: 'running' });
    d.run();
    this.emit('change');
    return d;
  }

  remove(id: string): boolean {
    const d = this.dialogues.get(id); if (!d) return false;
    d.stop();
    this.dialogues.delete(id);
    this.emit('change');
    return true;
  }

  // Every dialogue, transcript included, is written on each change so a restart keeps the record and can continue a live one.
  persistTo(file: string) { this.persistFile = file; this.on('change', () => this.save()); }
  save() {
    if (!this.persistFile) return;
    const all: Saved[] = [...this.dialogues.values()].map(d => ({ ...d.summary(), events: d.events, notes: d.notes }));
    try { writeFileSync(this.persistFile, JSON.stringify(all)); } catch {}
  }
  reopen(): number {
    if (!this.persistFile || !existsSync(this.persistFile)) return 0;
    let saved: Saved[] = [];
    try { saved = JSON.parse(readFileSync(this.persistFile, 'utf8')); } catch { return 0; }
    for (const s of saved) {
      if (!s || typeof s.id !== 'string' || !Array.isArray(s.participants) || s.participants.length !== 2) continue;
      const d = new Dialogue(this, { id: s.id, topic: s.topic, rounds: s.rounds, maxWords: s.maxWords, cwd: s.cwd, participants: s.participants, startedAt: s.startedAt });
      d.turns = s.turns; d.endedAt = s.endedAt; d.error = s.error; d.events = s.events || []; d.notes = s.notes || []; d.status = s.status;
      this.dialogues.set(d.id, d);
      if (s.status === 'running' || s.status === 'paused') {
        d.claimChats();
        d.status = 'paused';
        d.emitEvent({ t: 'note', kind: 'system', text: 'Fleet restarted. The participant chats were reopened from their saved sessions; press Resume to continue.' });
        d.emitEvent({ t: 'status', status: 'paused' });
      }
    }
    this.emit('change');
    return saved.length;
  }
}

export class Dialogue extends EventEmitter {
  mgr: DialogueManager; id: string; topic: string; rounds: number; maxWords: number; cwd: string; participants: Participant[];
  status: DialogueStatus = 'running'; turns = 0; speaking: Side | null = null; startedAt: number; endedAt: number | null = null; error: string | null = null;
  events: DialogueEvent[] = []; notes: string[] = [];
  private pauseRequested = false; private looping = false;
  private cancelWait: (() => void) | null = null; private wakeUp: (() => void) | null = null;

  constructor(mgr: DialogueManager, o: { id: string; topic: string; rounds: number; maxWords: number; cwd: string; participants: Participant[]; startedAt: number }) {
    super();
    this.mgr = mgr; this.id = o.id; this.topic = o.topic; this.rounds = o.rounds; this.maxWords = o.maxWords; this.cwd = o.cwd; this.participants = o.participants; this.startedAt = o.startedAt;
  }

  summary(): DialogueSummary {
    return { id: this.id, topic: this.topic, status: this.status, cwd: this.cwd, rounds: this.rounds, turns: this.turns, maxWords: this.maxWords,
      speaking: this.speaking, participants: this.participants, startedAt: this.startedAt, endedAt: this.endedAt, error: this.error, pendingNotes: this.notes.length, pausePending: this.pauseRequested };
  }
  emitEvent(ev: DialogueEventInput) {
    const full = { ...ev, at: Date.now() } as DialogueEvent;
    this.events.push(full);
    this.emit('event', full);
    this.mgr.emit('change');
  }
  private setStatus(s: DialogueStatus) { if (this.status !== s) { this.status = s; this.emitEvent({ t: 'status', status: s }); } }
  private side(s: Side) { return this.participants.find(p => p.side === s)!; }
  private liveChat(p: Participant): Chat {
    const c = this.mgr.chats.get(p.chatId);
    if (!c || c.status === 'ended') throw new Error(`${p.name}'s chat (${p.chatId}) is not running.`);
    return c;
  }
  /** Mark the participant chats as ours: titled after their role, and flagged so the chat view says who is driving them. */
  claimChats() {
    for (const p of this.participants) {
      const c = this.mgr.chats.get(p.chatId); if (!c) continue;
      c.label = `${p.name} · ${this.topic.slice(0, 40)}`; c.dialogueId = this.id;
    }
    this.mgr.chats.emit('change');
  }
  private releaseChats(endOwned: boolean) {
    for (const p of this.participants) {
      const c = this.mgr.chats.get(p.chatId); if (!c) continue;
      c.dialogueId = null;
      if (endOwned && p.owned && c.status !== 'ended') c.close();
    }
    this.mgr.chats.emit('change');
  }

  /** The relay loop. One iteration delivers a message to the speaker and waits for the reply; the reply is the next speaker's prompt. */
  async run() {
    if (this.looping) return; this.looping = true;
    try {
      while (this.turns < this.rounds * 2) {
        if (this.pauseRequested) { this.pauseRequested = false; this.setStatus('paused'); }
        if (this.status === 'paused') await new Promise<void>(r => { this.wakeUp = r; });
        this.wakeUp = null;
        if (this.status === 'ended') return;
        this.setStatus('running');
        const turn = this.turns + 1;
        const side: Side = turn % 2 === 1 ? 'A' : 'B';
        const speaker = this.side(side), listener = this.side(other(side));
        const chat = this.liveChat(speaker);
        this.speaking = side; this.emitEvent({ t: 'speaking', side, turn });
        // The person may have typed into the participant chat; let that turn finish first.
        await this.waitChat(chat, ev => ev.t === 'status' && ev.status === 'idle', () => chat.status === 'idle');
        const origin = { kind: 'dialogue' as const, fromChatId: listener.chatId, fromTitle: listener.name, dialogueId: this.id };
        chat.send(this.compose(side, turn), origin);
        let reply = await this.awaitReply(chat);
        if (!reply) {
          chat.send(`[Fleet dialogue ${this.id}] Your turn ended without any text. Answer ${listener.name} in plain prose now; no tools are needed.`, origin);
          reply = await this.awaitReply(chat);
          if (!reply) throw new Error(`${speaker.name} ended two turns in a row without saying anything.`);
        }
        this.turns = turn; this.speaking = null;
        this.emitEvent({ t: 'turn', turn, side, name: speaker.name, text: reply, final: turn >= this.rounds * 2 - 1 });
      }
      this.finish('done');
    } catch (err: any) {
      if (this.status === 'ended') return;
      this.error = String(err?.message || err);
      this.emitEvent({ t: 'note', kind: 'system', text: this.error });
      this.finish('failed');
    } finally { this.looping = false; this.speaking = null; }
  }

  // Done keeps the participant chats alive, so Extend can continue the same conversation; Stop and Remove end the ones we started.
  private finish(status: DialogueStatus) {
    this.endedAt = Date.now(); this.speaking = null;
    this.releaseChats(status === 'failed');
    this.setStatus(status);
  }

  /** What the speaker reads this turn: the brief on its first turn, then the other side's last message, any moderator notes, and the closing cue. */
  private compose(side: Side, turn: number): string {
    const me = this.side(side), them = this.side(other(side));
    const total = this.rounds * 2;
    const parts: string[] = [];
    if (turn <= 2) parts.push(
      `[Fleet dialogue ${this.id}: "${this.topic}"]\n\n` +
      'You are one of two Claude sessions in a conversation that Fleet orchestrates. Fleet delivers the other participant\'s words to you and delivers your reply to them verbatim. ' +
      'There is nothing to call or coordinate: do not use fleet_send, fleet_ask, or other tools, and do not run commands unless the topic genuinely needs a fact looked up. ' +
      'Answer in plain prose, in your own voice, addressed to the other participant.\n\n' +
      `Topic: ${this.topic}\n` +
      `You are ${me.name}.${me.persona ? ` ${me.persona}` : ''}\n` +
      `The other participant is ${them.name}.\n` +
      `Length: ${plural(this.rounds, 'exchange')} in total, ${plural(this.rounds, 'message')} from each of you. Keep each message under about ${this.maxWords} words. Build on what was said rather than restating it, and disagree when you have reason to.`);
    const last = [...this.events].reverse().find(e => e.t === 'turn');
    if (turn === 1 || !last || last.t !== 'turn') parts.push('You speak first. Open the conversation.');
    else parts.push(`[Dialogue ${this.id}, message ${turn} of ${total}. ${them.name} says:]\n\n${last.text}`);
    for (const n of this.notes.splice(0)) parts.push(`[Moderator note from the person running this dialogue: ${n}]`);
    if (turn >= total - 1) parts.push('[This is your last message in this dialogue. Bring your side to a close; no new threads.]');
    return parts.join('\n\n');
  }

  /** Resolves on the chat event `until` accepts; rejects if the chat ends or the dialogue is stopped. `already` short-circuits. */
  private waitChat<T>(chat: Chat, until: (ev: ChatEvent) => T | false | null | undefined, already?: () => boolean): Promise<T | undefined> {
    if (already?.()) return Promise.resolve(undefined);
    return new Promise<T | undefined>((resolve, reject) => {
      const off = () => { chat.off('event', onEv); this.cancelWait = null; };
      const onEv = (ev: ChatEvent) => {
        if (ev.t === 'status' && ev.status === 'ended') { off(); reject(new Error(`${chat.title} ended mid-dialogue.`)); return; }
        const v = until(ev);
        if (v !== false && v != null) { off(); resolve(v); }
      };
      chat.on('event', onEv);
      this.cancelWait = () => { off(); reject(new Error('stopped')); };
    });
  }
  private async awaitReply(chat: Chat): Promise<string> {
    const r = await this.waitChat(chat, ev => (ev.t === 'result' ? { text: chat.turnText.trim() } : null));
    return r?.text || '';
  }

  pause() {
    if (this.status !== 'running' || this.pauseRequested) return;
    this.pauseRequested = true;
    this.emitEvent({ t: 'note', kind: 'system', text: this.speaking ? `Pausing after ${this.side(this.speaking).name} finishes this message.` : 'Paused.' });
  }
  resume() {
    this.pauseRequested = false;
    if (this.status !== 'paused') return;
    this.status = 'running'; this.emitEvent({ t: 'status', status: 'running' });
    if (this.wakeUp) this.wakeUp();
    else { this.claimChats(); this.run(); } // restored after a restart: the loop is not running yet
  }
  /** End the dialogue and the chats it started. On a finished dialogue it only ends the chats. */
  stop() {
    if (this.status === 'running' || this.status === 'paused') {
      this.status = 'ended';
      const speaker = this.speaking ? this.mgr.chats.get(this.side(this.speaking).chatId) : null;
      this.cancelWait?.(); this.wakeUp?.();
      speaker?.interrupt().catch(() => {});
      this.endedAt = Date.now(); this.speaking = null;
      this.emitEvent({ t: 'status', status: 'ended' });
    }
    this.releaseChats(true);
  }
  /** Queue a note the next speaker reads with its message. The person running the dialogue is its moderator. */
  steer(text: string) {
    const t = text.trim(); if (!t) throw new Error('empty note');
    if (this.status === 'ended' || this.status === 'failed') throw new Error('this dialogue is over');
    this.notes.push(t);
    this.emitEvent({ t: 'note', kind: 'moderator', text: t });
  }
  /** More rounds. A finished dialogue picks up where it stopped, as long as both chats are still running. */
  extend(n: number) {
    const add = Math.max(1, Math.round(Number(n) || 1));
    if (this.status === 'ended' || this.status === 'failed') throw new Error('this dialogue is over; start a new one');
    if (this.rounds + add > MAX_ROUNDS) throw new Error(`at most ${MAX_ROUNDS} rounds`);
    if (this.status === 'done') for (const p of this.participants) { const c = this.mgr.chats.get(p.chatId); if (!c || c.status === 'ended' || c.dialogueId) throw new Error(`${p.name}'s chat is ${c?.dialogueId ? 'in another dialogue' : 'no longer running'}; start a new dialogue.`); }
    this.rounds += add;
    this.emitEvent({ t: 'note', kind: 'system', text: `Extended by ${plural(add, 'round')}, now ${this.rounds}.` });
    // The next speaker may already have been told to close; tell it the conversation goes on.
    this.notes.push(`The conversation continues for ${plural(add, 'more round')}, ${this.rounds * 2} messages in total now.`);
    if (this.status === 'done') { this.endedAt = null; this.status = 'running'; this.emitEvent({ t: 'status', status: 'running' }); this.claimChats(); this.run(); }
  }

  /** The conversation as markdown, for saving or pasting somewhere. */
  transcript(): string {
    const lines = [`# ${this.topic}`, '', `Dialogue ${this.id} · ${this.participants.map(p => `${p.name} (${p.model})`).join(' and ')} · ${plural(this.rounds, 'round')} · ${this.status}`, ''];
    for (const p of this.participants) if (p.persona) lines.push(`**${p.name}**: ${p.persona}`, '');
    for (const e of this.events) {
      if (e.t === 'turn') lines.push(`## ${e.turn}. ${e.name}`, '', e.text, '');
      else if (e.t === 'note' && e.kind === 'moderator') lines.push(`> Moderator: ${e.text}`, '');
    }
    return lines.join('\n');
  }
}
