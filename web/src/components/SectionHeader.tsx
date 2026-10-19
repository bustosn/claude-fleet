import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { actions, useStore } from '../lib/store';

/** Whether a collapsible sidebar section is open. Sections start collapsed; the choice is remembered. */
export const useSectionOpen = (name: string) => useStore(s => !!s.openSections[name]);

/** A collapsible sidebar section header: chevron, label, count, and an optional + for starting a new one. */
export function SectionHeader({ name, label, count, add }: { name: string; label: string; count: number; add?: { label: string; onClick: () => void } }) {
  const open = useSectionOpen(name);
  return (
    <div className="section-title">
      <button className="flex items-center gap-1" onClick={() => actions.toggleSection(name)} aria-expanded={open}>
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        {label}
      </button>
      <span className="count num">{count}</span>
      {add && <button className="iconbtn" style={{ width: 20, height: 20 }} title={add.label} aria-label={add.label} onClick={add.onClick}><Plus size={13} aria-hidden="true" /></button>}
    </div>
  );
}
