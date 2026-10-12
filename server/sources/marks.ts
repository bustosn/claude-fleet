import fs from 'node:fs';
import path from 'node:path';

const DAY = 24 * 60 * 60 * 1000;

/**
 * What the user did to saved conversations in Fleet's list: archived, pinned, or restored from the archive.
 * Fleet's own file; the transcripts are untouched.
 *
 * A conversation idle for `autoArchiveDays` counts as archived without being listed. Restoring one records when,
 * and it stays out of the archive until it has been idle that long again, counted from the later of its last
 * message and the restore. Pinned conversations are never archived automatically.
 */
export class ConversationMarks {
  private archived = new Set<string>();
  private pinned = new Set<string>();
  /** Restored from the archive at (ms): the auto-archive clock restarts from here. */
  private restored: Record<string, number> = {};

  constructor(private file: string, private autoArchiveDays: number) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.archived = new Set(raw.archived || []); this.pinned = new Set(raw.pinned || []); this.restored = raw.restored || {};
    } catch { /* first run */ }
  }

  state(sessionId: string, lastModified: number | null): { archived: boolean; autoArchived: boolean; pinned: boolean } {
    const pinned = this.pinned.has(sessionId);
    if (pinned) return { archived: false, autoArchived: false, pinned };
    if (this.archived.has(sessionId)) return { archived: true, autoArchived: false, pinned };
    const since = Math.max(lastModified || 0, this.restored[sessionId] || 0);
    const auto = this.autoArchiveDays > 0 && since > 0 && Date.now() - since > this.autoArchiveDays * DAY;
    return { archived: auto, autoArchived: auto, pinned };
  }

  archive(sessionId: string, on: boolean) {
    if (on) { this.archived.add(sessionId); this.pinned.delete(sessionId); delete this.restored[sessionId]; }
    else { this.archived.delete(sessionId); this.restored[sessionId] = Date.now(); }
    this.save();
  }
  /** Pinning takes a conversation out of the archive too. */
  pin(sessionId: string, on: boolean) {
    if (on) { this.pinned.add(sessionId); this.archived.delete(sessionId); } else this.pinned.delete(sessionId);
    this.save();
  }
  forget(sessionId: string) {
    this.archived.delete(sessionId); this.pinned.delete(sessionId); delete this.restored[sessionId];
    this.save();
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ archived: [...this.archived], pinned: [...this.pinned], restored: this.restored }, null, 2));
  }
}
