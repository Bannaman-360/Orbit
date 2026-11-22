// Customizable toolbars, like the ones in macOS: any item can go in any bar, in any order, with
// icons, labels or both. ⌘-drag moves items at any time; arrange mode lets you drag freely.

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AppMenu, type MenuItem } from '../Menu';
import { useTip } from '../ui';
import { closestAt, insertionAt, showMarker, startDrag } from './drag';
import { Icon } from './Icon';
import { BAR_NAMES, isArranging, isSpacer, placeItem, setArranging, setBar, setTheme, useArranging, usePrefs, type BarId } from './prefs';

export interface ToolItem {
  label: string;
  icon?: string;
  title?: string;
  run?: () => void;
  disabled?: boolean;
  /** Why it can't be used now: shows a small lock, and says so on hover. */
  locked?: string;
  on?: boolean;
  primary?: boolean;
  danger?: boolean;
  menu?: (MenuItem | 'sep')[];
  /** On while the button is held down, instead of a click. */
  hold?: (on: boolean) => void;
  /** A live control instead of a button (time, zoom slider…). */
  control?: ReactNode;
  /** The control takes the free space. */
  wide?: boolean;
}

export const SPACERS: Record<string, string> = { space: 'Space', flex: 'Flexible space', sep: 'Divider' };

/** Drags a toolbar item from a bar (or the palette) to any bar; dropping it elsewhere removes it. */
export function dragItem(e: React.PointerEvent, item: string, label: string, from: { bar: BarId; index: number } | null) {
  const find = (x: number, y: number) => {
    const bar = closestAt(x, y, '[data-bar]');
    if (!bar) return null;
    const box = bar.getBoundingClientRect();
    const { index, line } = insertionAt([...bar.querySelectorAll<HTMLElement>(':scope > [data-slot]')], x, y, 'x', box);
    return { bar: bar.dataset.bar as BarId, index, line };
  };
  startDrag(e, {
    label,
    onMove: (x, y) => showMarker(find(x, y)?.line ?? null),
    onDrop: (x, y) => {
      const to = find(x, y);
      if (to) placeItem(item, from, { bar: to.bar, index: to.index });
      else if (from && isArranging()) placeItem(item, from, null);
    },
  });
}

export function Bar({ id, items, className = '' }: { id: BarId; items: Record<string, ToolItem>; className?: string }) {
  const list = usePrefs((p) => p.bars[id].items);
  const pos = usePrefs((p) => p.bars[id].position);
  const display = usePrefs((p) => p.theme.toolbarLabels);
  const arranging = useArranging();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // When the bar is too narrow, what doesn't fit moves into a » menu, as in macOS.
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(Infinity);
  const theme = usePrefs((p) => p.theme);
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => {
      const kids = [...el.querySelectorAll<HTMLElement>(':scope > [data-slot]')];
      el.classList.add('measuring'); // show everything while measuring
      let n = kids.length;
      if (el.scrollWidth > el.clientWidth + 1) {
        const cs = getComputedStyle(el);
        const limit = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 40;
        // Free space doesn't count: add up what the items themselves need.
        let used = 0;
        n = 0;
        for (const k of kids) {
          const m = getComputedStyle(k);
          used += k.classList.contains('bar-flex') ? 6 : k.classList.contains('wide') ? 0 : k.offsetWidth + parseFloat(m.marginLeft) + parseFloat(m.marginRight);
          if (used > limit) break;
          n++;
        }
      }
      el.classList.remove('measuring');
      setFit(n >= kids.length ? Infinity : n);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [list, theme, arranging]);
  const rest = fit === Infinity ? [] : list.slice(fit).filter((k) => items[k] && !items[k]!.control);
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  // Runs of buttons between spaces share one background, as in macOS.
  const isBtn = (k: number) => { const it = items[list[k] ?? '']; return !!it && !it.control; };
  return (
    <div
      ref={ref}
      className={`bar bar-${id} at-${pos} show-${display} ${className}`}
      data-bar={id}
      role="toolbar"
      aria-label={BAR_NAMES[id]}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
    >
      {list.map((key, i) => {
        const off = i >= fit;
        const grab = (e: React.PointerEvent, label: string) => { if (arranging || e.metaKey) { e.preventDefault(); e.stopPropagation(); dragItem(e, key, label, { bar: id, index: i }); } };
        if (isSpacer(key)) return <span key={`${key}${i}`} data-slot={i} className={`bar-${key}${off ? ' off' : ''}`} onPointerDown={(e) => grab(e, SPACERS[key]!)} />;
        const it = items[key];
        if (!it) return <span key={key} data-slot={i} className="bar-missing" />;
        if (it.control)
          return (
            <span key={key} data-slot={i} data-item={key} className={`bar-control${it.wide ? ' wide' : ''}${off ? ' off' : ''}`} title={it.title} onPointerDownCapture={(e) => grab(e, it.label)}>
              {it.control}
            </span>
          );
        return <ToolButton key={key} slot={i} id={key} it={it} first={!isBtn(i - 1)} last={!isBtn(i + 1) || i === fit - 1} grab={grab} inert={arranging} off={off} />;
      })}
      {rest.length > 0 && <span className="dock-grow" />}
      {rest.length > 0 && <button className="tool first last bar-more" title="More" aria-label="More" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMore({ x: r.left, y: r.bottom + 6 }); }}>»</button>}
      <AppMenu
        open={!!more}
        at={more ?? undefined}
        onClose={() => setMore(null)}
        items={rest.flatMap((k): (MenuItem | 'sep')[] => {
          const it = items[k]!;
          return it.menu ? ['sep', ...it.menu, 'sep'] : [{ label: it.label, icon: it.icon, disabled: it.disabled || !!it.locked, checked: it.on, onClick: () => (it.hold ? it.hold(!it.on) : it.run?.()) }];
        })}
      />
      <AppMenu
        open={!!menu}
        at={menu ?? undefined}
        title={BAR_NAMES[id]}
        onClose={() => setMenu(null)}
        items={[
          ...([['both', 'Icon and text'], ['beside', 'Icon with text beside it'], ['icon', 'Icon only'], ['text', 'Text only']] as const).map(([v, label]) => ({ label, checked: display === v, onClick: () => setTheme({ toolbarLabels: v }) })),
          'sep',
          { label: pos === 'top' ? 'Move to the bottom' : 'Move to the top', onClick: () => setBar(id, { position: pos === 'top' ? 'bottom' : 'top' }) },
          { label: 'Hide this toolbar', onClick: () => setBar(id, { hidden: true }) },
          'sep',
          { label: 'Customize toolbars…', onClick: () => setArranging(true) },
        ]}
      />
    </div>
  );
}

function ToolButton({ slot, id, it, first, last, grab, inert, off }: { off: boolean; slot: number; id: string; it: ToolItem; first: boolean; last: boolean; grab: (e: React.PointerEvent, label: string) => void; inert: boolean }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  // Pressing the button while its menu is open closes it (the press itself already did).
  const closedAt = useRef(0);
  const locked = inert ? undefined : it.locked;
  const { handlers, tip } = useTip(locked);
  return (
    <>
      <button
        data-slot={slot}
        data-item={id}
        className={`tool${it.primary ? ' primary' : ''}${it.danger ? ' danger' : ''}${it.on ? ' on' : ''}${first ? ' first' : ''}${last ? ' last' : ''}${off ? ' off' : ''}${locked ? ' locked' : ''}`}
        disabled={!inert && it.disabled}
        aria-disabled={!!locked}
        title={locked ? undefined : it.title ?? it.label}
        {...handlers}
        aria-label={it.label}
        onPointerDown={(e) => {
          grab(e, it.label);
          if (!it.hold || inert || locked || e.button !== 0 || e.metaKey) return;
          const hold = it.hold;
          hold(true);
          // Letting go anywhere (or leaving the app) ends it.
          const end = () => {
            hold(false);
            for (const t of ['pointerup', 'pointercancel', 'blur']) window.removeEventListener(t, end);
          };
          for (const t of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(t, end);
        }}
        onClick={(e) => {
          if (inert || locked || it.hold) return;
          if (it.menu) {
            const r = e.currentTarget.getBoundingClientRect();
            const up = r.bottom > window.innerHeight * 0.6;
            if (performance.now() - closedAt.current > 250) setAt({ x: r.left, y: up ? r.top - 6 : r.bottom + 6 });
          } else it.run?.();
        }}
      >
        {it.icon && <Icon name={it.icon} />}
        <span className="tool-label">{it.label}</span>
        {it.menu && <Icon name="chevron" size={10} className="tool-more" />}
        {locked && <Icon name="lock" className="tool-lock" />}
        {tip}
      </button>
      {it.menu && <AppMenu open={!!at} at={at ?? undefined} onClose={() => { closedAt.current = performance.now(); setAt(null); }} items={it.menu} />}
    </>
  );
}
