// The work area: panels in movable, resizable, tabbed groups. Panel contents are positioned by
// rectangle and never change parent, so moving the preview keeps its GPU canvases running.

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AppMenu, type MenuItem } from '../Menu';
import {
  activate, closePanel, dockAtEdge, dockPanel, evenSplit, floatPanel, isFloating, layoutRects, moveFloat, raiseFloat, resizeSplit, zoneAt, zoneRect,
  type DockLayout, type GroupRect, type Gutter, type PanelId, type Rect, type Side,
} from './dockModel';
import { showMarker, startDrag } from './drag';
import { Icon } from './Icon';
import { setPrefs, useArranging, usePrefs } from './prefs';

export interface PanelDef {
  title: string;
  icon: string;
  render: () => ReactNode;
  /** No title bar when alone in its group (preview, timeline). */
  bare?: boolean;
  /** Stays mounted while another tab is in front. */
  keep?: boolean;
  /** Not offered as a tab right now (nothing selected). */
  idle?: boolean;
}

const MIN_PX = 120;

export function Dock({ panels, front, onFront }: { panels: Record<PanelId, PanelDef>; front: PanelId | null; onFront: (p: PanelId) => void }) {
  const layout = usePrefs((p) => p.layout);
  const gap = usePrefs((p) => p.theme.gap);
  const density = usePrefs((p) => p.theme.density);
  const panelBars = usePrefs((p) => p.theme.panelBars);
  const arranging = useArranging();
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [menu, setMenu] = useState<{ panel: PanelId; group: string; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const setLayout = (f: (l: DockLayout) => DockLayout, key = '') => setPrefs((p) => { const l = f(p.layout); return l === p.layout ? {} : { layout: l }; }, key);
  const { groups, gutters } = layoutRects(layout, size.w, size.h, gap);
  const barH = Math.round(36 * density);

  /** The panels of a group that are shown as tabs, and the one in front. */
  const view = (g: GroupRect['group']) => {
    const usable = g.panels.filter((p) => panels[p]);
    const shown = usable.filter((p) => arranging || !panels[p]!.idle);
    const tabs = shown.length ? shown : usable;
    const active = front && tabs.includes(front) ? front : tabs.includes(g.active) ? g.active : tabs[0];
    return { tabs, active };
  };
  const barFor = (g: GroupRect['group']) => {
    const { tabs, active } = view(g);
    return !(tabs.length === 1 && active && panels[active]!.bare && panelBars === 'auto' && !arranging);
  };

  // --- Dragging a panel --------------------------------------------------------------------
  const dragPanel = (e: React.PointerEvent, panel: PanelId) => {
    type Drop = { kind: 'group'; id: string; zone: ReturnType<typeof zoneAt>; index?: number } | { kind: 'edge'; side: Side } | { kind: 'float' };
    let drop: Drop | null = null;
    const find = (cx: number, cy: number, alt: boolean): { drop: Drop; mark: Rect | null } | null => {
      const box = ref.current!.getBoundingClientRect();
      const x = cx - box.left, y = cy - box.top;
      const abs = (r: Rect): Rect => ({ ...r, x: r.x + box.left, y: r.y + box.top });
      const src = groups.find((g) => g.group.panels.includes(panel))?.rect;
      const fw = Math.min(380, size.w * 0.5), fh = Math.min(Math.max(260, src?.h ?? 420), size.h * 0.75);
      if (x < 0 || y < 0 || x > size.w || y > size.h) return null;
      if (alt) return { drop: { kind: 'float' }, mark: abs({ x: Math.max(0, x - 60), y: Math.max(0, y - 14), w: fw, h: fh }) };
      const E = 14;
      const side: Side | null = x < E ? 'left' : x > size.w - E ? 'right' : y < E ? 'top' : y > size.h - E ? 'bottom' : null;
      if (side) {
        const full = { x: 0, y: 0, w: size.w, h: size.h };
        const s = 0.24;
        const r = side === 'left' ? { ...full, w: size.w * s } : side === 'right' ? { ...full, x: size.w * (1 - s), w: size.w * s } : side === 'top' ? { ...full, h: size.h * s } : { ...full, y: size.h * (1 - s), h: size.h * s };
        return { drop: { kind: 'edge', side }, mark: abs(r) };
      }
      const over = [...groups].reverse().find((g) => x >= g.rect.x && x <= g.rect.x + g.rect.w && y >= g.rect.y && y <= g.rect.y + g.rect.h);
      if (!over) return null;
      // Over the tabs: choose the position among them.
      if (barFor(over.group) && y < over.rect.y + barH) {
        const tabs = [...ref.current!.querySelectorAll<HTMLElement>(`[data-group="${over.group.id}"] .dock-tab`)];
        const i = tabs.findIndex((t) => { const r = t.getBoundingClientRect(); return cx < r.left + r.width / 2; });
        const before = i >= 0 ? tabs[i]!.dataset.panel! : null;
        const index = before ? over.group.panels.indexOf(before) : over.group.panels.length;
        return { drop: { kind: 'group', id: over.group.id, zone: 'center', index }, mark: abs({ ...over.rect, h: barH }) };
      }
      const zone = over.float ? 'center' : zoneAt(over.rect, x, y);
      return { drop: { kind: 'group', id: over.group.id, zone }, mark: abs(zoneRect(over.rect, zone)) };
    };
    startDrag(e, {
      label: panels[panel]!.title,
      onMove: (x, y, ev) => { const f = find(x, y, ev.altKey); drop = f?.drop ?? null; showMarker(f?.mark ?? null, 'area'); },
      onDrop: (x, y, ev) => {
        drop = find(x, y, ev.altKey)?.drop ?? null;
        if (!drop) return;
        const d = drop;
        const box = ref.current!.getBoundingClientRect();
        setLayout((l) =>
          d.kind === 'edge' ? dockAtEdge(l, panel, d.side)
          : d.kind === 'float' ? floatPanel(l, panel, { x: Math.max(0, x - box.left - 60), y: Math.max(0, y - box.top - 14), w: Math.min(380, size.w * 0.5), h: Math.min(480, size.h * 0.75) })
          : dockPanel(l, panel, d.id, d.zone, d.index));
      },
    });
  };

  const dragGutter = (e: React.PointerEvent, g: Gutter) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY, sizes = g.sizes;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const d = (g.dir === 'row' ? ev.clientX - x0 : ev.clientY - y0) / g.total;
      setLayout((l) => resizeSplit(l, g.splitId, g.index, sizes, d, MIN_PX / g.total), `gutter:${g.splitId}:${g.index}`);
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const dragFloat = (e: React.PointerEvent, g: GroupRect, how: 'move' | 'size') => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY, r = g.rect;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      setLayout((l) => moveFloat(l, g.group.id, how === 'move'
        ? { x: Math.max(0, Math.min(size.w - r.w, r.x + dx)), y: Math.max(0, Math.min(size.h - r.h, r.y + dy)) }
        : { w: Math.max(200, Math.min(size.w - r.x, r.w + dx)), h: Math.max(120, Math.min(size.h - r.y, r.h + dy)) }), `float:${g.group.id}`);
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const menuItems = (m: { panel: PanelId; group: string }): (MenuItem | 'sep')[] => {
    const floating = isFloating(layout, m.panel);
    return [
      floating
        ? { label: 'Dock at the right', onClick: () => setLayout((l) => dockAtEdge(l, m.panel, 'right')) }
        : { label: 'Float as a window', onClick: () => { const g = groups.find((x) => x.group.id === m.group)!; setLayout((l) => floatPanel(l, m.panel, { x: g.rect.x + 24, y: g.rect.y + 24, w: Math.min(g.rect.w, 420), h: Math.min(g.rect.h, 520) })); } },
      'sep',
      ...(['left', 'right', 'top', 'bottom'] as const).map((s) => ({ label: `Move to the ${s}`, onClick: () => setLayout((l) => dockAtEdge(l, m.panel, s)) })),
      'sep',
      { label: 'Close panel', onClick: () => setLayout((l) => closePanel(l, m.panel)) },
    ];
  };

  const style = (r: Rect): React.CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h });
  // Fixed order, so React never moves a panel's elements.
  const bodies: ReactNode[] = [];
  for (const id of Object.keys(panels)) {
    const at = groups.find((g) => g.group.panels.includes(id));
    const def = panels[id]!;
    const shown = !!at && view(at.group).active === id;
    if (!shown && !def.keep) continue;
    const bar = at ? barFor(at.group) : false;
    const r = at?.rect ?? { x: 0, y: 0, w: 0, h: 0 };
    const fi = at?.float ? groups.indexOf(at) : 0;
    bodies.push(
      <div
        key={id}
        className={`dock-panel panel-${id.replace(':', '-')}${bar ? ' with-bar' : ''}`}
        data-panel-body={id}
        style={{ ...style(bar ? { x: r.x, y: r.y + barH, w: r.w, h: Math.max(0, r.h - barH) } : r), ...(shown ? {} : { display: 'none' }), zIndex: at?.float ? 41 + fi * 2 : 2 }}
        onPointerDownCapture={at?.float ? () => setLayout((l) => raiseFloat(l, at.group.id), 'raise') : undefined}
      >
        {def.render()}
      </div>,
    );
  }

  return (
    <div className="dock" ref={ref}>
      {groups.map((g, gi) => {
        const { tabs, active } = view(g.group);
        const bar = barFor(g.group);
        return (
          <div key={g.group.id} className={`dock-group${g.float ? ' floating' : ''}${bar ? '' : ' bare'}`} data-group={g.group.id} style={{ ...style(g.rect), zIndex: g.float ? 40 + gi * 2 : 1 }}>
            {bar && (
              <div
                className="dock-bar"
                style={{ height: barH }}
                onPointerDown={(e) => { if (!(e.target as HTMLElement).closest('.dock-tab, button')) { if (g.float) dragFloat(e, g, 'move'); else if (active) dragPanel(e, active); } }}
                onContextMenu={(e) => { e.preventDefault(); const p = (e.target as HTMLElement).closest<HTMLElement>('.dock-tab')?.dataset.panel ?? active; if (p) setMenu({ panel: p, group: g.group.id, x: e.clientX, y: e.clientY }); }}
              >
                <div className="dock-tabs" role="tablist" data-count={tabs.length}>
                  {tabs.map((p) => (
                    <button
                      key={p}
                      role="tab"
                      aria-selected={p === active}
                      data-panel={p}
                      className={`dock-tab${p === active ? ' on' : ''}`}
                      title={`${panels[p]!.title} — drag to move`}
                      onPointerDown={(e) => dragPanel(e, p)}
                      onClick={() => { onFront(p); setLayout((l) => activate(l, p), 'tab'); }}
                    >
                      <Icon name={panels[p]!.icon} size={15} />
                      <span>{panels[p]!.title}</span>
                    </button>
                  ))}
                </div>
                <span className="dock-grow" />
                <button className="ghost dock-more" title="Panel options" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (active) setMenu({ panel: active, group: g.group.id, x: r.left, y: r.bottom + 4 }); }}>
                  <Icon name="more" size={16} />
                </button>
              </div>
            )}
            {!bar && active && (
              <button
                className="dock-grabber"
                title="Drag to move this panel (right-click for options)"
                onPointerDown={(e) => dragPanel(e, active)}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ panel: active, group: g.group.id, x: e.clientX, y: e.clientY }); }}
              />
            )}
          </div>
        );
      })}
      {gutters.map((g) => (
        <div key={`${g.splitId}:${g.index}`} className={`dock-gutter ${g.dir}`} style={style(g.rect)} title="Drag to resize · double-click for equal sizes" onPointerDown={(e) => dragGutter(e, g)} onDoubleClick={() => setLayout((l) => evenSplit(l, g.splitId))} />
      ))}
      {bodies}
      {groups.map((g, gi) => g.float && <div key={`rs${g.group.id}`} className="dock-resize" style={{ left: g.rect.x + g.rect.w - 18, top: g.rect.y + g.rect.h - 18, zIndex: 42 + gi * 2 }} onPointerDown={(e) => dragFloat(e, g, 'size')} />)}
      {!groups.length && <div className="dock-empty">All panels are closed. Open them from Customize › Layout, or the View menu.</div>}
      <AppMenu open={!!menu} at={menu ?? undefined} title={menu ? panels[menu.panel]?.title : undefined} onClose={() => setMenu(null)} items={menu ? menuItems(menu) : []} />
    </div>
  );
}
