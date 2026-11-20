import { shortPath } from '../lib/format';
import { useStore } from '../lib/store';
import { openHerdr } from '../lib/terminal';
import { SectionHeader, useSectionOpen } from './SectionHeader';

/** Sidebar section: the agents herdr is running, by workspace, with their state. Clicking one opens herdr on it. Hidden until herdr is installed. */
export function HerdrList() {
  const herdr = useStore(s => s.snapshot?.herdr);
  const open = useSectionOpen('herdr');
  if (!herdr?.installed) return null;
  const blocked = herdr.agents.filter(a => a.status === 'blocked').length;
  return (
    <section className="mb-3">
      <SectionHeader name="herdr" label={blocked ? `herdr · ${blocked} blocked` : 'herdr'} count={herdr.agents.length} add={{ label: 'Open herdr', onClick: () => openHerdr() }} />
      {open && !herdr.running && <div className="px-2 pb-1 text-[11px] text-fg-faint">{herdr.error || 'herdr is not running. Open it with +.'}</div>}
      {open && herdr.running && !herdr.agents.length && <div className="px-2 pb-1 text-[11px] text-fg-faint">No agents in herdr yet.</div>}
      {open && herdr.agents.map(a => (
        <div key={a.paneId} className="row tall" role="button" tabIndex={0} title={`${a.workspace} · ${a.status}`}
          onClick={() => openHerdr(undefined, a.paneId)} onKeyDown={e => { if (e.key === 'Enter') openHerdr(undefined, a.paneId); }}>
          <span className="dot shrink-0" data-s={a.status} aria-hidden="true" />
          <span className="min-w-0 grow">
            <span className="block truncate text-fg">{a.title || a.agent}</span>
            <span className="block truncate text-[11px] text-fg-faint">{a.workspace}{a.cwd ? ` · ${shortPath(a.cwd)}` : ''}</span>
          </span>
        </div>
      ))}
    </section>
  );
}
