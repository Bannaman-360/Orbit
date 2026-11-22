import { describe, expect, it } from 'vitest';
import { activate, closePanel, dockAtEdge, dockPanel, floatPanel, group, groupsOf, groupWith, layoutRects, openPanels, resizeSplit, sanitize, split, zoneAt, type DockLayout, type Split } from './dockModel';

const base = (): DockLayout => ({ root: split('col', [split('row', [group('a'), 0.2], [group('b'), 0.5], [group('c', 'd'), 0.3]), 0.7], [group('e'), 0.3]), floats: [] });
const all = ['a', 'b', 'c', 'd', 'e'];
/** Everything stays exactly once, and the pieces tile the area without overlapping. */
const sound = (l: DockLayout, panels = all) => {
  expect([...openPanels(l)].sort()).toEqual([...panels].sort());
  for (const gap of [0, 8]) {
    const { groups } = layoutRects(l, 1200, 800, gap);
    const docked = groups.filter((g) => !g.float);
    for (const g of docked) {
      expect(g.rect.x).toBeGreaterThanOrEqual(0);
      expect(g.rect.x + g.rect.w).toBeLessThanOrEqual(1200);
      expect(g.rect.y + g.rect.h).toBeLessThanOrEqual(800);
    }
    for (const g of docked) for (const h of docked) if (g !== h) {
      const apart = g.rect.x + g.rect.w <= h.rect.x || h.rect.x + h.rect.w <= g.rect.x || g.rect.y + g.rect.h <= h.rect.y || h.rect.y + h.rect.h <= g.rect.y;
      expect(apart).toBe(true);
    }
    if (!gap) expect(docked.reduce((s, g) => s + g.rect.w * g.rect.h, 0)).toBe(1200 * 800);
  }
};

describe('dock layout', () => {
  it('moves any panel next to or into any other', () => {
    for (const p of all) for (const q of all) for (const z of ['left', 'right', 'top', 'bottom', 'center'] as const) {
      const l = base();
      const next = dockPanel(l, p, groupWith(l, q)!.id, z);
      sound(next);
      if (z === 'center' && p !== q) expect(groupWith(next, p)).toBe(groupWith(next, q));
    }
  });
  it('survives long random sequences of moves', () => {
    let l = base(), r = 7;
    const rnd = (n: number) => (r = (r * 1103515245 + 12345) & 0x7fffffff) % n;
    for (let i = 0; i < 400; i++) {
      const p = all[rnd(5)]!;
      const k = rnd(4);
      if (k === 0) l = dockAtEdge(l, p, (['left', 'right', 'top', 'bottom'] as const)[rnd(4)]!);
      else if (k === 1) l = floatPanel(l, p, { x: rnd(3000), y: rnd(2000), w: 300, h: 300 });
      else { const gs = groupsOf(l); l = dockPanel(l, p, gs[rnd(gs.length)]!.id, (['left', 'right', 'top', 'bottom', 'center'] as const)[rnd(5)]!); }
      expect([...openPanels(l)].sort()).toEqual(all);
    }
    sound(l);
  });
  it('reorders tabs, activates and closes', () => {
    const l = base();
    const g = groupWith(l, 'c')!;
    expect(groupWith(dockPanel(l, 'c', g.id, 'center', 2), 'c')!.panels).toEqual(['d', 'c']);
    expect(groupWith(activate(l, 'd'), 'd')!.active).toBe('d');
    sound(closePanel(l, 'b'), ['a', 'c', 'd', 'e']);
    let n = l;
    for (const p of all) n = closePanel(n, p);
    expect(n.root).toBeNull();
    expect(dockAtEdge(n, 'a', 'left').root).toMatchObject({ panels: ['a'] });
  });
  it('resizes within limits', () => {
    const l = base();
    const row = (l.root as Split).children[0] as Split;
    const r = resizeSplit(l, row.id, 0, row.sizes, -5, 0.1);
    const s = ((r.root as Split).children[0] as Split).sizes;
    expect(s[0]).toBeCloseTo(0.1);
    expect(s.reduce((a, b) => a + b)).toBeCloseTo(1);
    sound(r);
  });
  it('keeps floating panels on screen and picks drop zones', () => {
    const l = floatPanel(base(), 'a', { x: 9000, y: -50, w: 300, h: 200 });
    expect(layoutRects(l, 1000, 600, 8).groups.find((g) => g.float)!.rect).toEqual({ x: 700, y: 0, w: 300, h: 200 });
    const r = { x: 0, y: 0, w: 100, h: 100 };
    expect([zoneAt(r, 5, 50), zoneAt(r, 95, 50), zoneAt(r, 50, 5), zoneAt(r, 50, 95), zoneAt(r, 50, 50)]).toEqual(['left', 'right', 'top', 'bottom', 'center']);
  });
  it('repairs damaged or foreign saved layouts', () => {
    const known = (p: string) => all.includes(p);
    const rt = sanitize(JSON.parse(JSON.stringify(base())), known)!;
    sound(rt);
    expect(sanitize(null, known)).toBeNull();
    expect(sanitize({ root: { kind: 'group', panels: ['nope'] } }, known)).toBeNull();
    const weird = sanitize({ root: { kind: 'split', dir: 'row', children: [{ kind: 'group', panels: ['a', 'a', 'zz'] }, { kind: 'group', panels: ['a', 'b'] }, 5], sizes: ['x', NaN] }, floats: [{ group: { panels: ['c'] }, x: 'no' }, {}] }, known)!;
    sound(weird, ['a', 'b', 'c']);
  });
});
