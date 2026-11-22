// Small shared UI pieces.

import { Children, createContext, Fragment, isValidElement, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { closestAt, insertionAt, overlayRoot, showMarker, startDrag } from './ui/drag';
import { Icon } from './ui/Icon';
import { getPrefs, isInspectorPanel, moveSection, sectionList, setPrefs, toggleSectionHidden, useArranging, usePrefs } from './ui/prefs';

export const fmtTime = (us: number) => {
  const s = Math.max(0, us) / 1e6;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
};

/** How a slider's value is shown and typed: display = to(value), value = from(typed). */
export interface Units {
  to?: (v: number) => number;
  from?: (n: number) => number;
  suffix?: string;
  digits?: number;
}

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Value restored on double-click. */
  reset?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  /** Marks the control as keyframed at the playhead. */
  keyed?: boolean;
  disabled?: boolean;
  /** Why it can't be changed now: disables it and shows a lock that says so. */
  locked?: string | false;
  hint?: string;
  /** Display units for typing a value in (defaults to the raw value). */
  units?: Units;
}

/** An explanation that appears as soon as the pointer (or keyboard focus) is on something. */
export function useTip(text: string | undefined) {
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const show = (e: { currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    const below = r.top < 110;
    setAt({ x: Math.max(150, Math.min(window.innerWidth - 150, r.left + r.width / 2)), y: below ? r.bottom + 8 : r.top - 8, below });
  };
  const hide = () => setAt(null);
  return {
    handlers: text ? { onPointerEnter: show, onPointerMove: at ? undefined : show, onPointerLeave: hide, onFocus: show, onBlur: hide } : {},
    tip: text && at ? createPortal(<div className={`tip${at.below ? ' below' : ''}`} role="tooltip" style={{ left: at.x, top: at.y }}><Icon name="lock" size={14} /><span>{text}</span></div>, overlayRoot()) : null,
  };
}

/** A little lock that explains, on hover, why something can't be changed right now. */
export function Lock({ reason }: { reason: string }) {
  const { handlers, tip } = useTip(reason);
  return (
    <span className="lock" tabIndex={0} role="img" aria-label={`Locked: ${reason}`} {...handlers}>
      <Icon name="lock" size={13} />
      {tip}
    </span>
  );
}

/** A range input that tells the stylesheet how far along it is (for filled tracks). */
export function Range({ value, min, max, step, disabled, label, onChange, onDoubleClick, onPointerDown }: {
  value: number; min: number; max: number; step?: number; disabled?: boolean; label?: string; onChange: (v: number) => void; onDoubleClick?: () => void; onPointerDown?: () => void;
}) {
  const at = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
  // Sliders that go both ways fill from their zero point.
  const zero = min < 0 && max > 0 ? -min / (max - min) : 0;
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label}
      style={{ '--p': at, '--lo': Math.min(at, zero), '--hi': Math.max(at, zero) } as React.CSSProperties}
      onChange={(e) => onChange(+e.target.value)}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
    />
  );
}

export function Slider({ label, value, min, max, step = 0.01, reset, format, onChange, keyed, disabled: off, locked, hint, units }: SliderProps) {
  const disabled = off || !!locked;
  return (
    <div className={`slider${disabled ? ' disabled' : ''}`} title={locked ? undefined : hint ?? (reset !== undefined ? 'Double-click to reset' : undefined)}>
      <span className="slider-label">
        {keyed && <i className="kf-dot" title="Keyframed" />}
        <span className="slider-name">{label}</span>
        {locked && <Lock reason={locked} />}
      </span>
      <Range min={min} max={max} step={step} value={value} disabled={disabled} label={label} onChange={onChange} onDoubleClick={() => reset !== undefined && onChange(reset)} />
      <NumberField value={value} min={min} max={max} format={format} units={units} disabled={disabled} onChange={onChange} />
    </div>
  );
}

/** Shows a formatted value; click to type a new one (Enter to apply, Esc to cancel). */
export function NumberField({ value, min, max, format, units, disabled, onChange }: {
  value: number; min: number; max: number; format?: (v: number) => string; units?: Units; disabled?: boolean; onChange: (v: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const to = units?.to ?? ((v: number) => v);
  const from = units?.from ?? ((n: number) => n);
  const digits = units?.digits ?? 2;
  const commit = () => {
    if (text === null) return;
    const n = parseFloat(text.replace(',', '.').replace(/[^0-9.+-eE]/g, ''));
    if (Number.isFinite(n)) {
      const v = from(n);
      if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
    }
    setText(null);
  };
  if (text !== null)
    return (
      <input
        className="num-edit"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setText(null);
          e.stopPropagation();
        }}
      />
    );
  return (
    <button
      type="button"
      className="num"
      disabled={disabled}
      title="Click to type a value"
      onClick={() => setText(String(+to(value).toFixed(digits)))}
    >
      {format ? format(value) : value.toFixed(2)}
      {units?.suffix && !format ? units.suffix : ''}
    </button>
  );
}

export function Seg<T extends string>({ value, options, onChange, disabled: off, locked }: { value: T; options: [T, string][]; onChange: (v: T) => void; disabled?: boolean; locked?: string | false }) {
  const disabled = off || !!locked;
  const seg = (
    <div className="seg">
      {options.map(([v, label]) => (
        <button key={v} className={value === v ? 'on' : ''} disabled={disabled} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
  return locked ? <div className="locked-row">{seg}<Lock reason={locked} /></div> : seg;
}

// --- Collapsible sections: which are open is remembered between launches --------------------
const SECTIONS_KEY = 'ace.sections.v1';
let sectionState: Record<string, boolean> = (() => {
  try {
    return JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
})();
const sectionListeners = new Set<() => void>();
const subscribeSections = (f: () => void) => {
  sectionListeners.add(f);
  return () => { sectionListeners.delete(f); };
};
function saveSections(patch: Record<string, boolean>) {
  sectionState = { ...sectionState, ...patch };
  try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(sectionState)); } catch { /* private mode */ }
  sectionListeners.forEach((f) => f());
}
/** Sections on screen now (id → is it open), so all of them can be opened or closed at once. */
const mountedSections = new Map<string, boolean>();

export const openSection = (id: string) => saveSections({ [id]: true });
/** Closes every section on screen, or opens them all if they are already closed. */
export function toggleAllSections() {
  const open = ![...mountedSections.values()].some(Boolean);
  saveSections(Object.fromEntries([...mountedSections.keys()].map((k) => [k, open])));
}

/** Which list a section belongs to (so it can be dragged to another place in it, or elsewhere). */
const ListContext = createContext<string | null>(null);

/** Sections in the user's own order; sections can be dragged by their title. */
export function SectionList({ list, sections, empty }: { list: string; sections: Record<string, ReactNode>; empty?: ReactNode }) {
  const order = usePrefs((p) => p.sections);
  const hidden = usePrefs((p) => p.hiddenSections);
  const arranging = useArranging();
  const ids = sectionList({ ...getPrefs(), sections: order }, list).filter((id) => sections[id] && (arranging || !hidden.includes(id)));
  return (
    <ListContext.Provider value={list}>
      <div className="section-list" data-section-list={list}>
        {ids.map((id) => <div key={id} data-section={id} className={hidden.includes(id) ? 'is-hidden' : undefined}>{sections[id]}</div>)}
        {!ids.length && empty}
      </div>
    </ListContext.Provider>
  );
}

function dragSection(e: React.PointerEvent, id: string, title: string, list: string) {
  const find = (x: number, y: number) => {
    const el = closestAt(x, y, '[data-section-list]');
    const to = el?.dataset.sectionList;
    if (!el || !to || (to !== list && !(isInspectorPanel(to) && isInspectorPanel(list)))) return null;
    const els = [...el.querySelectorAll<HTMLElement>(':scope > [data-section]')];
    const { index, line } = insertionAt(els, x, y, 'y', el.getBoundingClientRect());
    return { to, before: els[index]?.dataset.section ?? null, line };
  };
  startDrag(e, {
    label: title,
    onMove: (x, y) => showMarker(find(x, y)?.line ?? null),
    onDrop: (x, y) => {
      const f = find(x, y);
      if (!f || f.before === id) return;
      const rest = sectionList(getPrefs(), f.to).filter((s) => s !== id);
      moveSection(id, list, f.to, f.before ? rest.indexOf(f.before) : rest.length);
    },
  });
}

/** The rows of a section, each with a lasting id, seen through fragments. */
function rowsOf(children: ReactNode, prefix = ''): { id: string; label: string; el: ReactNode }[] {
  return Children.toArray(children).flatMap((c, i) => {
    if (!isValidElement(c)) return [{ id: `${prefix}t${i}`, label: 'Text', el: c }];
    const el = c as ReactElement<{ children?: ReactNode; label?: string; className?: string }>;
    if (el.type === Fragment) return rowsOf(el.props.children, `${prefix}${el.key ?? i}/`);
    const label = el.props.label;
    return label ? [{ id: `s:${label}`, label, el: c }] : [{ id: `${prefix}${el.key ?? i}`, label: el.props.className?.includes('hint') ? 'Note' : 'Controls', el: c }];
  });
}

function dragRow(e: React.PointerEvent, section: string, id: string, label: string, ids: string[]) {
  const find = (x: number, y: number) => {
    const el = closestAt(x, y, '[data-rows]');
    if (el?.dataset.rows !== section) return null;
    const els = [...el.querySelectorAll<HTMLElement>(':scope > [data-row]')];
    const { index, line } = insertionAt(els, x, y, 'y', el.getBoundingClientRect());
    return { before: els[index]?.dataset.row ?? null, line };
  };
  startDrag(e, {
    label,
    onMove: (x, y) => showMarker(find(x, y)?.line ?? null),
    onDrop: (x, y) => {
      const f = find(x, y);
      if (!f || f.before === id) return;
      const rest = ids.filter((r) => r !== id);
      rest.splice(f.before ? rest.indexOf(f.before) : rest.length, 0, id);
      setPrefs((p) => ({ rows: { ...p.rows, [section]: rest } }));
    },
  });
}

function Rows({ section, children }: { section: string; children: ReactNode }) {
  const order = usePrefs((p) => p.rows[section]);
  const hidden = usePrefs((p) => p.hiddenRows[section]);
  const arranging = useArranging();
  if (!arranging && !order && !hidden?.length) return <div className="section-body">{children}</div>;
  const rows = rowsOf(children);
  if (order) {
    // Rows that weren't there when it was arranged keep their place after their neighbour.
    const at = (r: string, i: number) => { const k = order.indexOf(r); return k >= 0 ? k : (i > 0 ? order.indexOf(rows[i - 1]!.id) : -1) + 0.5; };
    const pos = new Map(rows.map((r, i) => [r.id, at(r.id, i)]));
    rows.sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
  }
  const ids = rows.map((r) => r.id);
  if (!arranging) return <div className="section-body">{rows.filter((r) => !hidden?.includes(r.id)).map((r) => <Fragment key={r.id}>{r.el}</Fragment>)}</div>;
  return (
    <div className="section-body" data-rows={section}>
      {rows.map((r) => {
        const off = !!hidden?.includes(r.id);
        return (
          <div key={r.id} data-row={r.id} className={`arrange-row${off ? ' is-hidden' : ''}`}>
            <button className="ghost grip" title="Drag to reorder" onPointerDown={(e) => dragRow(e, section, r.id, r.label, ids)}><Icon name="grip" size={14} /></button>
            <div className="arrange-row-body" inert>{r.el}</div>
            <button className="ghost" title={off ? 'Show' : 'Hide'} onClick={() => setPrefs((p) => ({ hiddenRows: { ...p.hiddenRows, [section]: off ? hidden!.filter((x) => x !== r.id) : [...(hidden ?? []), r.id] } }))}><Icon name={off ? 'eyeoff' : 'eye'} size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A titled group of controls that opens and closes like a drop-down. `badge` is a short status
 * shown on the right, so a closed section still says whether it's doing something.
 */
export function Section({ title, id = title, children, actions, badge, defaultOpen = false }: {
  title: string; id?: string; children: ReactNode; actions?: ReactNode; badge?: ReactNode; defaultOpen?: boolean;
}) {
  const state = useSyncExternalStore(subscribeSections, () => sectionState);
  const list = useContext(ListContext);
  const arranging = useArranging();
  const hidden = usePrefs((p) => p.hiddenSections.includes(id));
  const open = state[id] ?? defaultOpen;
  useEffect(() => {
    mountedSections.set(id, open);
    return () => { mountedSections.delete(id); };
  }, [id, open]);
  return (
    <section className={`panel-section${open ? ' open' : ''}`}>
      <header>
        <button type="button" className="section-toggle" aria-expanded={open} title={list ? 'Click to open or close · drag to move' : undefined} onPointerDown={(e) => list && dragSection(e, id, title, list)} onClick={() => saveSections({ [id]: !open })}>
          <span className="chevron" aria-hidden />
          <h3>{title}</h3>
          {badge && <span className="section-badge">{badge}</span>}
        </button>
        {open && !arranging && actions}
        {arranging && list && <button className="ghost" title={hidden ? 'Show this section' : 'Hide this section'} onClick={() => toggleSectionHidden(id)}><Icon name={hidden ? 'eyeoff' : 'eye'} size={15} /></button>}
      </header>
      {open && <Rows section={id}>{children}</Rows>}
    </section>
  );
}

/** Calls onDrag(dx, dy) while the pointer is held, and onEnd when released. */
export function useDrag(onDrag: (dx: number, dy: number, e: PointerEvent) => void, onEnd?: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    start.current = { x: e.clientX, y: e.clientY };
    const move = (ev: PointerEvent) => onDrag(ev.clientX - start.current!.x, ev.clientY - start.current!.y, ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      start.current = null;
      onEnd?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
}
