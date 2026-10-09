import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Plus, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import { shortPath } from '../lib/format';
import { actions, useStore } from '../lib/store';
import { openTerminal } from '../lib/terminal';
import { Status } from '../components/ui';

type Link = 'connecting' | 'live' | 'exited' | 'lost';

/** xterm draws its own colors, so it reads the same tokens the rest of the app uses and follows the theme switch. */
function themeFromCss() {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  return { background: v('--bg'), foreground: v('--fg'), cursor: v('--fg'), cursorAccent: v('--bg'), selectionBackground: v('--selected'), selectionForeground: v('--fg') };
}

/** A shell in a tab. Keystrokes go up a WebSocket, output comes down it; the server keeps the shell alive when the tab closes. */
export function TerminalView({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [link, setLink] = useState<Link>('connecting');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const t = useStore(s => s.snapshot?.terminals.find(x => x.id === id) || null);

  useEffect(() => {
    const el = host.current; if (!el) return;
    const term = new XTerm({ fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace', fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, theme: themeFromCss() });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    // Ctrl+K belongs to the command palette, not the shell.
    term.attachCustomKeyEventHandler(e => !(e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'k'));

    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminals/${id}/ws`);
    const send = (m: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
    let exited = false;
    ws.onopen = () => { setLink('live'); send({ t: 'resize', cols: term.cols, rows: term.rows }); term.focus(); };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.t === 'out') term.write(m.d);
      else if (m.t === 'exit') { exited = true; setExitCode(m.code); setLink('exited'); term.write(`\r\n\x1b[2m[process exited with code ${m.code}]\x1b[0m\r\n`); }
    };
    ws.onclose = () => setLink(l => (exited || l === 'exited' ? 'exited' : 'lost'));
    term.onData(d => send({ t: 'in', d }));
    term.onResize(({ cols, rows }) => send({ t: 'resize', cols, rows }));
    term.onTitleChange(title => send({ t: 'title', title }));

    const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    ro.observe(el);
    const mo = new MutationObserver(() => { term.options.theme = themeFromCss(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { ro.disconnect(); mo.disconnect(); ws.close(); term.dispose(); };
  }, [id]);

  const gone = !t && link !== 'connecting';
  const state = link === 'live' ? 'idle' : link === 'connecting' ? 'starting' : 'ended';
  const label = link === 'live' ? 'live' : link === 'connecting' ? 'connecting' : link === 'exited' ? `exited${exitCode != null ? ` (${exitCode})` : ''}` : 'connection lost';
  const kill = () => api.closeTerminal(id).then(() => { actions.closeTab(`terminal:${id}`); actions.toast('Terminal closed'); }).catch(e => actions.toast(e.message, 'error'));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 items-center gap-2 border-b border-line bg-surface px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{t?.title || 'Terminal'}</div>
          <div className="truncate text-[11px] text-fg-faint mono">{t ? `${t.shell}  ${shortPath(t.cwd)}` : gone ? 'this terminal is no longer running' : ''}</div>
        </div>
        <Status state={state} label={label} />
        <button className="btn sm ghost" onClick={() => openTerminal(t?.cwd)} title="Another terminal in the same folder"><Plus size={13} aria-hidden="true" /> New</button>
        {link === 'exited' || gone
          ? <button className="btn sm ghost" onClick={() => { api.closeTerminal(id).catch(() => {}); actions.closeTab(`terminal:${id}`); }} title="Close this tab"><X size={13} aria-hidden="true" /> Close</button>
          : <button className="btn sm ghost" onClick={kill} title="Kill the shell and close the tab"><Trash2 size={13} aria-hidden="true" /> Kill</button>}
      </header>
      <div className="min-h-0 flex-1 bg-bg p-2" onClick={() => host.current?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus()}>
        <div ref={host} className="h-full w-full" />
      </div>
      <div className="border-t border-line bg-surface px-4 py-1 text-[11px] text-fg-faint">Closing the tab keeps the shell running; find it again under Terminals in the sidebar. Kill ends it.</div>
    </div>
  );
}
