import { FileText, X } from 'lucide-react';
import type { Attachment } from '../lib/api';

/** An attachment waiting in a composer. `preview` is a data URL for images, so the chip can show a thumbnail. */
export type Pending = Attachment & { id: number; size: number; preview: string | null };
export const MAX_ATTACHMENT = 30 * 1024 * 1024;
let attachSeq = 0;

export function readAttachment(file: File): Promise<Pending> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => {
      const url = String(r.result);
      const mediaType = file.type || 'application/octet-stream';
      resolve({ id: ++attachSeq, name: file.name || 'pasted file', mediaType, size: file.size, data: url.slice(url.indexOf(',') + 1), preview: mediaType.startsWith('image/') ? url : null });
    };
    r.readAsDataURL(file);
  });
}

/** Images on the clipboard, for Alt+V. Throws when the browser blocks clipboard access; Ctrl+V needs no permission. */
export async function clipboardImages(): Promise<File[]> {
  const files: File[] = [];
  for (const item of await navigator.clipboard.read())
    for (const type of item.types) if (type.startsWith('image/')) files.push(new File([await item.getType(type)], `pasted image.${type.split('/')[1]}`, { type }));
  return files;
}

/** What goes over the wire: the composer-only fields stripped. */
export const toSend = (items: Pending[]): Attachment[] => items.map(({ name, mediaType, data }) => ({ name, mediaType, data }));

export function AttachmentChips({ items, onRemove }: { items: Pending[]; onRemove: (id: number) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Attachments">
      {items.map(a => (
        <span key={a.id} className="inline-flex max-w-[260px] items-center gap-1.5 rounded border border-line bg-raised py-0.5 pl-1 pr-0.5 text-[11px]" title={`${a.name} · ${fmtBytes(a.size)}`}>
          {a.preview ? <img src={a.preview} alt="" className="h-6 w-6 rounded-sm object-cover" /> : <FileText size={14} className="shrink-0 text-fg-faint" aria-hidden="true" />}
          <span className="truncate">{a.name}</span>
          <span className="shrink-0 text-fg-faint">{fmtBytes(a.size)}</span>
          <button type="button" className="btn sm ghost h-5 px-1" onClick={() => onRemove(a.id)} aria-label={`Remove ${a.name}`}><X size={11} aria-hidden="true" /></button>
        </span>
      ))}
    </div>
  );
}
export const fmtBytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
