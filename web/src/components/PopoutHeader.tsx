import { useEffect } from 'react';
import { Minimize2 } from 'lucide-react';
import { post } from '../lib/popout';
import { useStore, type View } from '../lib/store';
import { iconFor, tabLabel } from './TabStrip';

/** The strip across the top of a popped-out window: what it shows, and Pop back in, which returns the view to the main window as a tab. */
export function PopoutHeader({ view }: { view: View }) {
  const snap = useStore(s => s.snapshot);
  const label = tabLabel(view, snap);
  const Icon = iconFor(view, label.state);
  useEffect(() => { document.title = `${label.text} · Fleet`; }, [label.text]);
  const popIn = () => { post({ t: 'popin', view }); window.close(); };
  return (
    <header className="popout-head">
      {label.state ? <span className="dot shrink-0" data-s={label.state} aria-hidden="true" /> : <Icon size={14} className="shrink-0 text-fg-faint" aria-hidden="true" />}
      <span className="min-w-0 truncate font-semibold" title={label.hint}>{label.text}</span>
      <span className="grow" />
      <button className="btn sm ghost" onClick={popIn} title="Close this window and put the view back in the main window as a tab"><Minimize2 size={13} aria-hidden="true" /> Pop back in</button>
    </header>
  );
}
