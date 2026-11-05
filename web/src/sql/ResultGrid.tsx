import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Braces, ClipboardCopy, Columns3, CornerDownRight, EyeOff, Filter, Link2, Maximize2, Rows3 } from 'lucide-react';
import type { SqlColumn, SqlFk, SqlValue } from '../lib/api';
import { useContextMenu, type MenuItem } from '../components/ContextMenu';
import { actions } from '../lib/store';
import { copy, csv, inList, rowJson, tsv, whereEq } from './copy';

const ROW_H = 24, HEAD_H = 30, RN_W = 52, MIN_W = 56, MAX_W = 320;

export type Sort = { col: number; dir: 1 | -1 } | null;
/** What is selected: one cell, a whole row, or a whole column. Rows are positions in `order`, columns indexes into the result's columns. */
export type Selection = { kind: 'cell'; r: number; c: number } | { kind: 'row'; r: number } | { kind: 'col'; c: number } | null;

/** Rows in display order: the quick filter (any visible cell contains the text) and then the sort. */
export function useOrder(columns: SqlColumn[], rows: SqlValue[][], version: number, visible: number[], filter: string, sort: Sort): number[] {
  return useMemo(() => {
    let idx = rows.map((_, i) => i);
    const f = filter.trim().toLowerCase();
    if (f) idx = idx.filter(i => visible.some(c => { const v = rows[i][c]; return v != null && String(v).toLowerCase().includes(f); }));
    if (sort) {
      const { col, dir } = sort, kind = columns[col]?.kind;
      const key = (v: SqlValue) => v == null ? null : kind === 'number' ? Number(v) : String(v);
      idx.sort((a, b) => {
        const x = key(rows[a][col]), y = key(rows[b][col]);
        if (x == null || y == null) return x == null && y == null ? a - b : x == null ? 1 : -1;
        const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
        return d * dir || a - b;
      });
    }
    return idx;
    // `rows` grows in place while streaming; `version` is what changes.
  }, [columns, rows, version, visible, filter, sort]);
}

export const looksJson = (v: SqlValue) => typeof v === 'string' && v.length > 1 && /^\s*[[{]/.test(v) && /[\]}]\s*$/.test(v);

/** Width from the header and the first 200 values, in characters of the mono face. */
function measure(columns: SqlColumn[], rows: SqlValue[][]): number[] {
  return columns.map((c, i) => {
    let n = c.name.length + 3;
    for (let r = 0; r < Math.min(rows.length, 200); r++) { const v = rows[r][i]; n = Math.max(n, v == null ? 4 : Math.min(60, String(v).length)); }
    return Math.max(MIN_W, Math.min(MAX_W, Math.round(n * 7.3 + 18)));
  });
}

interface Props {
  columns: SqlColumn[]; rows: SqlValue[][]; version: number; order: number[]; visible: number[];
  sort: Sort; onSort: (s: Sort) => void; selection: Selection; onSelect: (s: Selection) => void;
  onHide: (col: number) => void; onShowAll: () => void; onFilter: (text: string) => void;
  onOpenCell: (rowIndex: number, col: number) => void; onRecord: (rowIndex: number) => void;
  /** Keys: where a column's values point (a foreign key, declared or guessed), and the table a column is the primary key of. */
  keys?: { fk: (col: number) => SqlFk | null; pk: (col: number) => { db: string; table: string; column: string } | null };
  onFollow?: (fk: SqlFk, v: SqlValue) => void; onReferencedBy?: (target: { db: string; table: string; column: string }, v: SqlValue) => void;
}

export function ResultGrid({ columns, rows, version, order, visible, sort, onSort, selection, onSelect, onHide, onShowAll, onFilter, onOpenCell, onRecord, keys, onFollow, onReferencedBy }: Props) {
  // Holding Ctrl shows which cells follow a key on click.
  const [mod, setMod] = useState(false);
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => setMod(e.ctrlKey || e.metaKey);
    const off = () => setMod(false);
    addEventListener('keydown', on); addEventListener('keyup', on); addEventListener('blur', off);
    return () => { removeEventListener('keydown', on); removeEventListener('keyup', on); removeEventListener('blur', off); };
  }, []);
  const fks = useMemo(() => columns.map((_, i) => keys?.fk(i) || null), [columns, keys]);
  const scroller = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<number[]>(() => measure(columns, rows));
  // New columns (a new run) are measured again once the first rows are in.
  const measuredFor = useRef<{ cols: SqlColumn[]; rows: number }>({ cols: columns, rows: rows.length });
  useEffect(() => {
    const m = measuredFor.current;
    if (m.cols !== columns || (m.rows < 50 && rows.length > m.rows)) { measuredFor.current = { cols: columns, rows: rows.length }; setWidths(measure(columns, rows)); }
  }, [columns, version]);

  const rowV = useVirtualizer({ count: order.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 14, paddingStart: HEAD_H });
  const colV = useVirtualizer({ horizontal: true, count: visible.length, getScrollElement: () => scroller.current, estimateSize: i => widths[visible[i]] ?? 120, overscan: 3, paddingStart: RN_W });
  useEffect(() => { colV.measure(); }, [widths, visible]);

  const [menu, openMenu] = useContextMenu();
  const toast = (ok: boolean, what: string) => actions.toast(ok ? `Copied ${what}` : 'The clipboard is not available here', ok ? 'info' : 'error');
  const colValues = (c: number) => order.map(i => rows[i][c]);
  const visCols = () => visible.map(c => columns[c]);
  const rowsOf = (list: number[]) => list.map(i => visible.map(c => rows[i][c]));

  const copySelection = async (asIn = false) => {
    if (!selection) return;
    if (selection.kind === 'cell') { const v = rows[order[selection.r]]?.[selection.c]; toast(await copy(asIn ? inList([v], columns[selection.c]) : v == null ? 'NULL' : String(v)), asIn ? 'as IN list' : 'value'); }
    else if (selection.kind === 'row') toast(await copy(tsv(visCols(), rowsOf([order[selection.r]]))), 'row');
    else toast(await copy(asIn ? inList(colValues(selection.c), columns[selection.c]) : colValues(selection.c).map(v => v == null ? '' : String(v)).join('\n')), asIn ? `${columns[selection.c].name} as IN list` : 'column');
  };

  const scrollTo = (r: number | null, cPos: number | null) => {
    if (r != null) rowV.scrollToIndex(r, { align: 'auto' });
    if (cPos != null && cPos >= 0) colV.scrollToIndex(cPos, { align: 'auto' });
  };
  const onKey = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === 'KeyC') { e.preventDefault(); copySelection(e.shiftKey); return; }
    if (!order.length || !visible.length) return;
    const cur = selection?.kind === 'cell' ? selection : selection?.kind === 'row' ? { r: selection.r, c: visible[0] } : selection?.kind === 'col' ? { r: 0, c: selection.c } : null;
    let r = cur?.r ?? 0, cp = cur ? Math.max(0, visible.indexOf(cur.c)) : 0;
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight || 300) / ROW_H) - 2);
    switch (e.key) {
      case 'ArrowDown': r = Math.min(order.length - 1, cur ? r + 1 : 0); break;
      case 'ArrowUp': r = Math.max(0, r - 1); break;
      case 'ArrowRight': cp = Math.min(visible.length - 1, cur ? cp + 1 : 0); break;
      case 'ArrowLeft': cp = Math.max(0, cp - 1); break;
      case 'PageDown': r = Math.min(order.length - 1, r + page); break;
      case 'PageUp': r = Math.max(0, r - page); break;
      case 'Home': if (mod) r = 0; cp = 0; break;
      case 'End': if (mod) r = order.length - 1; cp = visible.length - 1; break;
      case 'Enter': if (cur) { e.preventDefault(); onOpenCell(order[cur.r], cur.c); } return;
      default: return;
    }
    e.preventDefault();
    onSelect({ kind: 'cell', r, c: visible[cp] });
    scrollTo(r, cp);
  };

  const cellMenu = (e: RMouseEvent, r: number, c: number) => {
    onSelect({ kind: 'cell', r, c });
    const ri = order[r], v = rows[ri][c], col = columns[c];
    const fk = fks[c], pk = keys?.pk(c);
    const nav: MenuItem[] = [
      ...(fk && v != null && onFollow ? [{ label: `Open ${fk.refTable} where ${fk.refColumn} = ${String(v).slice(0, 40)}`, icon: Link2, onSelect: () => onFollow(fk, v) }] : []),
      ...(pk && v != null && onReferencedBy ? [{ label: 'Referenced by…', icon: CornerDownRight, onSelect: () => onReferencedBy(pk, v) }] : []),
    ];
    const items: MenuItem[] = [
      ...nav, ...(nav.length ? ['separator' as const] : []),
      { label: 'Copy value', icon: ClipboardCopy, onSelect: async () => toast(await copy(v == null ? 'NULL' : String(v)), 'value') },
      { label: `Copy as WHERE ${col.name} = …`, onSelect: async () => toast(await copy(whereEq(col, v)), 'WHERE clause') },
      { label: `Copy ${col.name} column as IN (…)`, onSelect: async () => toast(await copy(inList(colValues(c), col)), 'IN list') },
      'separator',
      { label: 'Copy row', onSelect: async () => toast(await copy(tsv(visCols(), rowsOf([ri]))), 'row') },
      { label: 'Copy row as CSV', onSelect: async () => toast(await copy(csv(visCols(), rowsOf([ri]))), 'row as CSV') },
      { label: 'Copy row as JSON', icon: Braces, onSelect: async () => toast(await copy(rowJson(visCols(), visible.map(i => rows[ri][i]))), 'row as JSON') },
      { label: 'Copy all as TSV', onSelect: async () => toast(await copy(tsv(visCols(), rowsOf(order))), `${order.length} rows`) },
      { label: 'Copy all as CSV', onSelect: async () => toast(await copy(csv(visCols(), rowsOf(order))), `${order.length} rows as CSV`) },
      'separator',
      { label: 'Open value', icon: Maximize2, onSelect: () => onOpenCell(ri, c) },
      { label: 'Show row as record', icon: Rows3, onSelect: () => onRecord(ri) },
      { label: 'Filter to this value', icon: Filter, disabled: v == null, onSelect: () => onFilter(String(v)) },
      { label: `Hide ${col.name}`, icon: EyeOff, onSelect: () => onHide(c) },
    ];
    openMenu(e, items);
  };
  const rowMenu = (e: RMouseEvent, r: number) => {
    onSelect({ kind: 'row', r });
    const ri = order[r];
    openMenu(e, [
      { label: 'Copy row', icon: ClipboardCopy, onSelect: async () => toast(await copy(tsv(visCols(), rowsOf([ri]))), 'row') },
      { label: 'Copy row as CSV', onSelect: async () => toast(await copy(csv(visCols(), rowsOf([ri]))), 'row as CSV') },
      { label: 'Copy row as JSON', icon: Braces, onSelect: async () => toast(await copy(rowJson(visCols(), visible.map(i => rows[ri][i]))), 'row as JSON') },
      'separator',
      { label: 'Show row as record', icon: Rows3, onSelect: () => onRecord(ri) },
    ]);
  };
  const headMenu = (e: RMouseEvent, c: number) => {
    const col = columns[c];
    openMenu(e, [
      { label: 'Sort ascending', icon: ArrowUp, onSelect: () => onSort({ col: c, dir: 1 }) },
      { label: 'Sort descending', icon: ArrowDown, onSelect: () => onSort({ col: c, dir: -1 }) },
      { label: 'Clear sort', disabled: !sort, onSelect: () => onSort(null) },
      'separator',
      { label: 'Copy column name', icon: ClipboardCopy, onSelect: async () => toast(await copy(col.name), 'column name') },
      { label: 'Copy values as IN (…)', onSelect: async () => toast(await copy(inList(colValues(c), col)), 'IN list') },
      'separator',
      { label: `Hide ${col.name}`, icon: EyeOff, onSelect: () => onHide(c) },
      { label: 'Show all columns', icon: Columns3, disabled: visible.length === columns.length, onSelect: onShowAll },
    ]);
  };

  // Drag a header's right edge to resize; double-click it to fit the header and the first values again.
  const startResize = (e: RPointerEvent, c: number) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = widths[c];
    const move = (ev: PointerEvent) => setWidths(ws => ws.map((w, i) => i === c ? Math.max(MIN_W, Math.min(900, w0 + ev.clientX - x0)) : w));
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.style.cursor = ''; };
    addEventListener('pointermove', move); addEventListener('pointerup', up); document.body.style.cursor = 'col-resize';
  };
  const fit = (c: number) => setWidths(ws => { const m = measure(columns, rows); return ws.map((w, i) => i === c ? m[c] : w); });

  const total = colV.getTotalSize(), vRows = rowV.getVirtualItems(), vCols = colV.getVirtualItems();
  const selRow = selection?.kind === 'row' || selection?.kind === 'cell' ? selection.r : -1;
  const selCol = selection?.kind === 'col' || selection?.kind === 'cell' ? selection.c : -1;

  return (
    <div ref={scroller} className="sql-grid" tabIndex={0} onKeyDown={onKey} role="grid" aria-rowcount={order.length} aria-colcount={visible.length}>
      <div style={{ width: total, height: rowV.getTotalSize(), position: 'relative' }}>
        <div className="sql-head" style={{ width: total, height: HEAD_H }} role="row">
          <div className="sql-corner" style={{ width: RN_W }}>#</div>
          {vCols.map(vc => {
            const c = visible[vc.index], col = columns[c];
            const sorted = sort?.col === c ? sort.dir : 0;
            return (
              <div key={c} role="columnheader" className={`sql-hcell ${col.kind === 'number' ? 'num' : ''} ${selection?.kind === 'col' && selection.c === c ? 'is-sel' : ''}`}
                style={{ left: vc.start, width: vc.size }} title={`${col.name} · ${col.type}${col.table ? ` · ${col.table}` : ''}`}
                onClick={() => onSelect({ kind: 'col', c })} onContextMenu={e => headMenu(e, c)}>
                <span className="truncate">{col.name}</span>
                <button className={`sql-sort ${sorted ? 'on' : ''}`} aria-label={`Sort by ${col.name}`} onClick={e => { e.stopPropagation(); onSort(sorted === 1 ? { col: c, dir: -1 } : sorted === -1 ? null : { col: c, dir: 1 }); }}>
                  {sorted === -1 ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
                </button>
                <span className="sql-resize" onPointerDown={e => startResize(e, c)} onDoubleClick={e => { e.stopPropagation(); fit(c); }} />
              </div>
            );
          })}
        </div>
        {vRows.map(vr => {
          const ri = order[vr.index], row = rows[ri];
          return (
            <div key={vr.key} role="row" className={`sql-row ${vr.index === selRow ? 'is-sel-row' : ''} ${vr.index % 2 ? 'odd' : ''}`} style={{ top: vr.start, width: total, height: ROW_H }}>
              <div className={`sql-rn ${selection?.kind === 'row' && selection.r === vr.index ? 'is-sel' : ''}`} style={{ width: RN_W }}
                onClick={() => onSelect({ kind: 'row', r: vr.index })} onDoubleClick={() => onRecord(ri)} onContextMenu={e => rowMenu(e, vr.index)}>{ri + 1}</div>
              {vCols.map(vc => {
                const c = visible[vc.index];
                const isSel = (selection?.kind === 'cell' && selection.r === vr.index && selection.c === c) || (selection?.kind === 'col' && selCol === c);
                const fk = fks[c];
                return <Cell key={c} v={row[c]} kind={columns[c].kind} left={vc.start} width={vc.size} sel={isSel} fk={!!fk && row[c] != null} mod={mod}
                  onClick={e => { if (fk && row[c] != null && onFollow && (e.ctrlKey || e.metaKey)) { onFollow(fk, row[c]); return; } onSelect({ kind: 'cell', r: vr.index, c }); }} onOpen={() => onOpenCell(ri, c)} onMenu={e => cellMenu(e, vr.index, c)} />;
              })}
            </div>
          );
        })}
      </div>
      {menu}
    </div>
  );
}

const Cell = memo(function Cell({ v, kind, left, width, sel, fk, mod, onClick, onOpen, onMenu }: { v: SqlValue; kind: SqlColumn['kind']; left: number; width: number; sel: boolean; fk: boolean; mod: boolean; onClick: (e: RMouseEvent) => void; onOpen: () => void; onMenu: (e: RMouseEvent) => void }) {
  const s = v == null ? null : String(v);
  const json = looksJson(v), long = !!s && s.length > 200;
  return (
    <div role="gridcell" className={`sql-cell ${kind === 'number' ? 'num' : ''} ${sel ? 'is-sel' : ''} ${fk ? 'fk' : ''} ${fk && mod ? 'mod' : ''}`} style={{ left, width }} title={fk ? 'Ctrl+click to open the row this points at' : undefined} onClick={onClick} onDoubleClick={onOpen} onContextMenu={onMenu}>
      {s == null ? <span className="sql-null">NULL</span> : <span className="truncate">{long ? `${s.slice(0, 200)}…` : s}</span>}
      {(json || long) && <button className="sql-open" aria-label="Open value" onClick={e => { e.stopPropagation(); onOpen(); }}>{json ? <Braces size={11} /> : <Maximize2 size={11} />}</button>}
    </div>
  );
});
