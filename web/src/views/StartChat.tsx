import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { api } from '../lib/api';
import { shortPath } from '../lib/format';
import { actions, useStore } from '../lib/store';
import { Empty } from '../components/ui';
import { MOD } from '../lib/platform';
import { CodeTextarea } from '../components/CodeTextarea';
import { AttachmentChips, MAX_ATTACHMENT, clipboardImages, readAttachment, toSend, type Pending } from '../components/Attachments';

/** Opens (or reuses) a live chat for a saved session, then hands off to the chat view. */
export function ResumeView({ sessionId, cwd, title }: { sessionId: string; cwd: string; title: string }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.openChat({ sessionId, cwd }).then(c => { if (!cancelled) actions.go({ kind: 'chat', chatId: c.id, title }, { replace: `resume:${sessionId}` }); }).catch(e => setError(e.message));
    return () => { cancelled = true; };
  }, [sessionId, cwd, title]);
  return <Empty title={error ? 'Could not open this conversation' : `Opening ${title}`}>{error || 'Starting a Claude process and loading the saved history.'}</Empty>;
}

export function NewChatView({ cwd }: { cwd?: string }) {
  const snap = useStore(s => s.snapshot);
  const dirs = [...new Set([...(snap?.repos || []).flatMap(r => r.worktrees.map(w => w.path)), ...(snap?.sessions.map(s => s.cwd) || [])].filter(Boolean))];
  const [dir, setDir] = useState(cwd || dirs[0] || '');
  const [model, setModel] = useState(snap?.dispatch.defaultModel || 'fable');
  const [perm, setPerm] = useState(snap?.dispatch.permissionMode || 'auto');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  // Same as the chat composer: files dropped or pasted (Ctrl+V / Cmd+V, or Alt+V / Option+V for a clipboard image) go with the first message.
  const attach = async (files: File[]) => {
    const tooBig = files.filter(f => f.size > MAX_ATTACHMENT);
    if (tooBig.length) actions.toast(`Too large to attach (over ${MAX_ATTACHMENT / 1024 / 1024} MB): ${tooBig.map(f => f.name).join(', ')}`, 'error');
    const read = await Promise.all(files.filter(f => f.size <= MAX_ATTACHMENT).map(readAttachment));
    if (read.length) setAttachments(a => [...a, ...read]);
  };
  const pasteImage = async () => {
    try { const files = await clipboardImages(); if (files.length) attach(files); else actions.toast('No image on the clipboard.'); }
    catch { actions.toast(`The browser blocked clipboard access. ${MOD}V pastes images too.`, 'error'); }
  };
  const isFileDrag = (e: DragEvent) => e.dataTransfer.types.includes('Files');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const c = await api.openChat({ cwd: dir, model, permissionMode: perm });
      if (text.trim() || attachments.length) await api.send(c.id, text.trim(), undefined, attachments.length ? toSend(attachments) : undefined);
      actions.go({ kind: 'chat', chatId: c.id, title: text.trim().slice(0, 60) || attachments[0]?.name || 'New chat' }, { replace: 'new-chat' });
    } catch (err: any) { actions.toast(err.message, 'error'); setBusy(false); }
  };

  return (
    <form className="relative m-auto w-[560px] max-w-[94%] panel p-5" onSubmit={submit}
      onDragEnter={e => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth.current++; setDragging(true); }}
      onDragOver={e => { if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={e => { if (isFileDrag(e) && --dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
      onDrop={e => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth.current = 0; setDragging(false); attach([...e.dataTransfer.files]); }}>
      {dragging && <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-lg border-2 border-dashed border-accent bg-accent-soft/80 text-[13px] font-semibold">Drop to attach to the first message</div>}
      <h2 className="mb-3 text-[14px] font-semibold">New chat</h2>
      <label className="mb-3 grid gap-1 text-[12px] text-fg-muted">Working directory
        <select className="input" value={dir} onChange={e => setDir(e.target.value)}>{dirs.map(d => <option key={d} value={d}>{shortPath(d)}</option>)}</select>
      </label>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <label className="grid gap-1 text-[12px] text-fg-muted">Model
          <select className="input" value={model} onChange={e => setModel(e.target.value)}>{['fable', 'opus', 'sonnet', 'haiku'].map(m => <option key={m}>{m}</option>)}</select>
        </label>
        <label className="grid gap-1 text-[12px] text-fg-muted">Permissions
          <select className="input" value={perm} onChange={e => setPerm(e.target.value)}>
            <option value="auto">auto</option><option value="default">ask</option><option value="acceptEdits">acceptEdits</option><option value="plan">plan</option>
          </select>
        </label>
      </div>
      <label className="mb-4 grid gap-1 text-[12px] text-fg-muted">First message
        {attachments.length > 0 && <AttachmentChips items={attachments} onRemove={id => setAttachments(a => a.filter(x => x.id !== id))} />}
        <CodeTextarea className="input" wrapClass="rich-boxed" rows={5} value={text} onChange={setText} placeholder="What should this chat work on? Enter starts the chat, Shift+Enter adds a line. Drop files or paste images to attach."
          onPaste={e => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); attach(files); } }}
          onKeyDown={e => {
            if (e.altKey && !e.ctrlKey && e.code === 'KeyV') { e.preventDefault(); pasteImage(); return; }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey || e.currentTarget.dataset.code !== 'true')) { e.preventDefault(); if (!busy && dir) e.currentTarget.form?.requestSubmit(); }
          }} />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={() => actions.go({ kind: 'overview' })}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || !dir}>{busy ? 'Starting' : 'Start chat'}</button>
      </div>
    </form>
  );
}
