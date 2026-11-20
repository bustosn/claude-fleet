import { useMemo } from 'react';
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, GitBranch, RefreshCw } from 'lucide-react';
import { openFile, refreshTree, toggleDir, type Session } from './session';
import { actions } from '../lib/store';

/** The folder as a tree. Folders load when first opened; what git ignores (node_modules, vendor) is dimmed. */
const statusColor: Record<string, string> = { M: 'text-accent', R: 'text-accent', A: 'text-good', '?': 'text-good', D: 'text-crit', U: 'text-crit' };
const statusName: Record<string, string> = { M: 'modified', R: 'renamed', A: 'added', '?': 'not tracked yet', D: 'deleted', U: 'conflict' };

export function FileTree({ session }: { session: Session }) {
  const g = session.git;
  // Folders that hold a changed file get a dot, so a change can be found without opening everything.
  const changedDirs = useMemo(() => {
    const out = new Set<string>();
    for (const f of Object.keys(g?.files || {})) { let i = f.lastIndexOf('/'); while (i > 0) { out.add(f.slice(0, i)); i = f.lastIndexOf('/', i - 1); } }
    return out;
  }, [g]);
  const name = session.root.replace(/\\/g, '/').split('/').filter(Boolean).pop() || session.root;
  return (
    <div className="flex min-h-0 flex-col border-r border-line">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="min-w-0 truncate text-[12px] font-semibold" title={session.root}>{name}</span>
        {g?.branch && (
          <span className="ml-1 flex min-w-0 flex-1 items-center gap-1 text-[11px] text-fg-muted" title={`${g.branch}${g.ahead ? `, ${g.ahead} ahead` : ''}${g.behind ? `, ${g.behind} behind` : ''}`}>
            <GitBranch size={11} className="shrink-0" aria-hidden="true" /><span className="truncate">{g.branch}</span>
            {(g.ahead > 0 || g.behind > 0) && <span className="num shrink-0 text-fg-faint">{g.ahead ? `↑${g.ahead}` : ''}{g.behind ? `↓${g.behind}` : ''}</span>}
          </span>
        )}
        {!g?.branch && <span className="flex-1" />}
        <button className="iconbtn" style={{ width: 22, height: 22 }} title="Reload the tree" aria-label="Reload the tree" onClick={() => refreshTree(session)}><RefreshCw size={12} aria-hidden="true" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1" role="tree" aria-label="Files">
        <Level session={session} dir="" depth={0} changedDirs={changedDirs} />
      </div>
    </div>
  );
}

function Level({ session, dir, depth, changedDirs }: { session: Session; dir: string; depth: number; changedDirs: Set<string> }) {
  const entries = session.dirs.get(dir);
  if (!entries) return <div className="px-3 py-1 text-[11px] text-fg-faint" style={{ paddingLeft: 12 + depth * 12 }}>Loading…</div>;
  if (!entries.length) return depth ? <div className="py-1 text-[11px] text-fg-faint" style={{ paddingLeft: 28 + depth * 12 }}>empty</div> : null;
  return (
    <>
      {entries.map(e => {
        const path = dir ? `${dir}/${e.name}` : e.name;
        const pad = { paddingLeft: 6 + depth * 12 };
        if (e.dir) {
          const open = session.expanded.has(path);
          const Icon = open ? FolderOpen : Folder;
          return (
            <div key={path} role="treeitem" aria-expanded={open}>
              <button className="row h-6 text-[12px]" style={pad} onClick={() => toggleDir(session, path)} title={path}>
                {open ? <ChevronDown size={12} className="shrink-0 text-fg-faint" aria-hidden="true" /> : <ChevronRight size={12} className="shrink-0 text-fg-faint" aria-hidden="true" />}
                <Icon size={13} className={`shrink-0 ${e.ignored ? 'text-fg-faint' : 'text-accent'}`} aria-hidden="true" />
                <span className={`grow ${e.ignored ? 'text-fg-faint' : ''}`}>{e.name}</span>
                {changedDirs.has(path) && <span className="inline-block size-1.5 shrink-0 rounded-full bg-accent opacity-60" title="Contains changes" aria-label="Contains changes" />}
              </button>
              {open && <Level session={session} dir={path} depth={depth + 1} changedDirs={changedDirs} />}
            </div>
          );
        }
        const b = session.bufs.get(path);
        const st = session.git?.files[path];
        return (
          <button key={path} role="treeitem" className="row h-6 text-[12px]" style={{ ...pad, paddingLeft: 24 + depth * 12 }} aria-current={session.active === path ? 'true' : undefined} title={st ? `${path} (${statusName[st] || 'changed'})` : path}
            onClick={async () => { const err = await openFile(session.root, path); if (err) actions.toast(err, 'error'); }}>
            <File size={13} className="shrink-0 text-fg-faint" aria-hidden="true" />
            <span className={`grow ${e.ignored ? 'text-fg-faint' : st ? statusColor[st] || '' : ''}`}>{e.name}</span>
            {b?.dirty && <span className="inline-block size-1.5 shrink-0 rounded-full bg-warn" title="Unsaved changes" aria-label="Unsaved changes" />}
          </button>
        );
      })}
    </>
  );
}
