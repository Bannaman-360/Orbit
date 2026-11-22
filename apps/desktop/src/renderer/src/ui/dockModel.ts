// Where panels sit: a tree of rows / columns whose leaves are groups of tabbed panels, plus
// floating groups. Pure functions (no DOM), so every move can be tested.

export type PanelId = string;
export interface Group { kind: 'group'; id: string; panels: PanelId[]; active: PanelId }
export interface Split { kind: 'split'; id: string; dir: 'row' | 'col'; children: Node[]; sizes: number[] }
export type Node = Group | Split;
/** A floating group; position and size in px of the work area. */
export interface Float { group: Group; x: number; y: number; w: number; h: number }
export interface DockLayout { root: Node | null; floats: Float[] }
export type Side = 'left' | 'right' | 'top' | 'bottom';
export type Zone = Side | 'center';
export interface Rect { x: number; y: number; w: number; h: number }

let seq = 0;
const nid = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;
export const group = (...panels: PanelId[]): Group => ({ kind: 'group', id: nid(), panels, active: panels[0]! });
export const split = (dir: 'row' | 'col', ...parts: [Node, number][]): Split => ({ kind: 'split', id: nid(), dir, children: parts.map((p) => p[0]), sizes: parts.map((p) => p[1]) });

/** Drops empty groups, merges nested same-direction splits, and makes sizes add up to 1. */
function tidy(n: Node | null): Node | null {
  if (!n) return null;
  if (n.kind === 'group') {
    if (!n.panels.length) return null;
    return n.panels.includes(n.active) ? n : { ...n, active: n.panels[0]! };
  }
  const children: Node[] = [], sizes: number[] = [];
  n.children.forEach((c, i) => {
    const t = tidy(c);
    if (!t) return;
    const size = n.sizes[i] ?? 0.1;
    if (t.kind === 'split' && t.dir === n.dir) {
      t.children.forEach((cc, j) => { children.push(cc); sizes.push(size * t.sizes[j]!); });
    } else {
      children.push(t);
      sizes.push(size);
    }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0]!;
  const sum = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...n, children, sizes: sizes.map((s) => s / sum) };
}
const clean = (l: DockLayout): DockLayout => ({
  root: tidy(l.root),
  floats: l.floats.filter((f) => f.group.panels.length).map((f) => (f.group.panels.includes(f.group.active) ? f : { ...f, group: { ...f.group, active: f.group.panels[0]! } })),
});

const mapNode = (n: Node | null, f: (g: Group) => Node): Node | null =>
  !n ? null : n.kind === 'group' ? f(n) : { ...n, children: n.children.map((c) => mapNode(c, f)!) };

const mapGroups = (l: DockLayout, f: (g: Group) => Group): DockLayout => ({
  root: mapNode(l.root, f),
  floats: l.floats.map((x) => ({ ...x, group: f(x.group) })),
});

export function groupsOf(l: DockLayout): Group[] {
  const out: Group[] = [];
  mapNode(l.root, (g) => (out.push(g), g));
  return [...out, ...l.floats.map((f) => f.group)];
}
export const openPanels = (l: DockLayout): PanelId[] => groupsOf(l).flatMap((g) => g.panels);
export const groupWith = (l: DockLayout, p: PanelId) => groupsOf(l).find((g) => g.panels.includes(p));
export const isFloating = (l: DockLayout, p: PanelId) => l.floats.some((f) => f.group.panels.includes(p));

const without = (l: DockLayout, p: PanelId): DockLayout =>
  mapGroups(l, (g) => {
    const i = g.panels.indexOf(p);
    if (i < 0) return g;
    const panels = g.panels.filter((x) => x !== p);
    return { ...g, panels, active: g.active === p ? panels[Math.max(0, i - 1)] ?? '' : g.active };
  });
export const closePanel = (l: DockLayout, p: PanelId): DockLayout => clean(without(l, p));

export const activate = (l: DockLayout, p: PanelId): DockLayout => mapGroups(l, (g) => (g.panels.includes(p) && g.active !== p ? { ...g, active: p } : g));

/** Drops panel `p` on a group: into its tabs ('center', at `index`) or beside it. */
export function dockPanel(l: DockLayout, p: PanelId, targetId: string, zone: Zone, index?: number): DockLayout {
  const target = groupsOf(l).find((g) => g.id === targetId);
  if (!target) return l;
  if (zone === 'center') {
    const from = target.panels.indexOf(p);
    const base = without(l, p);
    return clean(mapGroups(base, (g) => {
      if (g.id !== targetId) return g;
      let at = index ?? g.panels.length;
      if (from >= 0 && index !== undefined && from < index) at--; // its own removal shifted things
      const panels = [...g.panels];
      panels.splice(Math.max(0, Math.min(panels.length, at)), 0, p);
      return { ...g, panels, active: p };
    }));
  }
  if (target.panels.length === 1 && target.panels[0] === p) return l; // beside itself
  // Floating groups don't split: join their tabs instead.
  if (l.floats.some((f) => f.group.id === targetId)) return dockPanel(l, p, targetId, 'center');
  const base = without(l, p);
  const dir = zone === 'left' || zone === 'right' ? 'row' : 'col';
  const first = zone === 'left' || zone === 'top';
  const fresh = group(p);
  const root = mapNode(base.root, (g) => (g.id === targetId ? split(dir, ...((first ? [[fresh, 0.4], [g, 0.6]] : [[g, 0.6], [fresh, 0.4]]) as [Node, number][])) : g));
  return clean({ ...base, root });
}

/** Docks a panel along a whole side of the work area. */
export function dockAtEdge(l: DockLayout, p: PanelId, side: Side, size = 0.24): DockLayout {
  const base = clean(without(l, p));
  const g = group(p);
  if (!base.root) return { ...base, root: g };
  const dir = side === 'left' || side === 'right' ? 'row' : 'col';
  const first = side === 'left' || side === 'top';
  return clean({ ...base, root: split(dir, ...((first ? [[g, size], [base.root, 1 - size]] : [[base.root, 1 - size], [g, size]]) as [Node, number][])) });
}

export const floatPanel = (l: DockLayout, p: PanelId, r: Rect): DockLayout => {
  const base = clean(without(l, p));
  return { ...base, floats: [...base.floats, { group: group(p), ...r }] };
};
export const moveFloat = (l: DockLayout, groupId: string, r: Partial<Rect>): DockLayout => ({ ...l, floats: l.floats.map((f) => (f.group.id === groupId ? { ...f, ...r } : f)) });
export const raiseFloat = (l: DockLayout, groupId: string): DockLayout => {
  const f = l.floats.find((x) => x.group.id === groupId);
  return !f || l.floats[l.floats.length - 1] === f ? l : { ...l, floats: [...l.floats.filter((x) => x !== f), f] };
};

/** Moves the divider after child `i` of a split by `delta` (share of the split), keeping `min`. */
export function resizeSplit(l: DockLayout, splitId: string, i: number, startSizes: number[], delta: number, min: number): DockLayout {
  const walk = (n: Node): Node => {
    if (n.kind === 'group') return n;
    if (n.id !== splitId) return { ...n, children: n.children.map(walk) };
    const a = startSizes[i]!, b = startSizes[i + 1]!;
    const m = Math.min(min, (a + b) / 2);
    const na = Math.max(m, Math.min(a + b - m, a + delta));
    const sizes = [...startSizes];
    sizes[i] = na;
    sizes[i + 1] = a + b - na;
    return { ...n, sizes };
  };
  return { ...l, root: l.root && walk(l.root) };
}
export const evenSplit = (l: DockLayout, splitId: string): DockLayout => {
  const walk = (n: Node): Node => (n.kind === 'group' ? n : n.id === splitId ? { ...n, sizes: n.children.map(() => 1 / n.children.length) } : { ...n, children: n.children.map(walk) });
  return { ...l, root: l.root && walk(l.root) };
};

export interface GroupRect { group: Group; rect: Rect; float: boolean }
export interface Gutter { splitId: string; index: number; dir: 'row' | 'col'; rect: Rect; sizes: number[]; total: number }

/** Pixel rectangles for every group and divider. */
export function layoutRects(l: DockLayout, W: number, H: number, gap: number): { groups: GroupRect[]; gutters: Gutter[] } {
  const groups: GroupRect[] = [], gutters: Gutter[] = [];
  const g = Math.max(4, gap); // dividers stay grabbable even with no visible gap
  const walk = (n: Node, r: Rect) => {
    if (n.kind === 'group') { groups.push({ group: n, rect: r, float: false }); return; }
    const row = n.dir === 'row';
    const full = row ? r.w : r.h;
    const total = Math.max(1, full - gap * (n.children.length - 1));
    let at = row ? r.x : r.y;
    n.children.forEach((c, i) => {
      const last = i === n.children.length - 1;
      const end = row ? r.x + r.w : r.y + r.h;
      const size = last ? Math.max(0, end - at) : Math.round(n.sizes[i]! * total);
      walk(c, row ? { x: at, y: r.y, w: size, h: r.h } : { x: r.x, y: at, w: r.w, h: size });
      at += size;
      if (!last) {
        const mid = at + gap / 2 - g / 2;
        gutters.push({ splitId: n.id, index: i, dir: n.dir, sizes: n.sizes, total, rect: row ? { x: mid, y: r.y, w: g, h: r.h } : { x: r.x, y: mid, w: r.w, h: g } });
        at += gap;
      }
    });
  };
  if (l.root) walk(l.root, { x: 0, y: 0, w: W, h: H });
  for (const f of l.floats) {
    // Keep floating panels reachable however small the window gets.
    const w = Math.min(f.w, W), h = Math.min(f.h, H);
    groups.push({ group: f.group, float: true, rect: { x: Math.max(0, Math.min(W - w, f.x)), y: Math.max(0, Math.min(H - h, f.y)), w, h } });
  }
  return { groups, gutters };
}

/** Which zone of `r` a point is in (edges = the outer quarter). */
export function zoneAt(r: Rect, x: number, y: number): Zone {
  const fx = (x - r.x) / Math.max(1, r.w), fy = (y - r.y) / Math.max(1, r.h);
  const d: [Side, number][] = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]];
  const [side, v] = d.reduce((a, b) => (b[1] < a[1] ? b : a));
  return v < 0.25 ? side : 'center';
}
export function zoneRect(r: Rect, z: Zone): Rect {
  switch (z) {
    case 'left': return { ...r, w: r.w * 0.4 };
    case 'right': return { ...r, x: r.x + r.w * 0.6, w: r.w * 0.4 };
    case 'top': return { ...r, h: r.h * 0.4 };
    case 'bottom': return { ...r, y: r.y + r.h * 0.6, h: r.h * 0.4 };
    default: return r;
  }
}

/** Makes sense of a stored layout: unknown or repeated panels go, bad numbers are replaced. */
export function sanitize(raw: unknown, known: (p: PanelId) => boolean): DockLayout | null {
  const seen = new Set<PanelId>();
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const grp = (o: Record<string, unknown>): Group => {
    const panels = (Array.isArray(o.panels) ? o.panels : []).filter((p): p is string => typeof p === 'string' && known(p) && !seen.has(p) && !!seen.add(p));
    return { kind: 'group', id: typeof o.id === 'string' ? o.id : nid(), panels, active: typeof o.active === 'string' ? o.active : panels[0] ?? '' };
  };
  const node = (o: unknown, depth: number): Node | null => {
    if (!o || typeof o !== 'object' || depth > 24) return null;
    const n = o as Record<string, unknown>;
    if (n.kind === 'group') return grp(n);
    if (n.kind !== 'split' || !Array.isArray(n.children)) return null;
    const sizes = Array.isArray(n.sizes) ? n.sizes : [];
    const parts = n.children.map((c, i) => [node(c, depth + 1), Math.max(0.02, num(sizes[i], 0.5))] as const).filter((x): x is [Node, number] => !!x[0]);
    return { kind: 'split', id: typeof n.id === 'string' ? n.id : nid(), dir: n.dir === 'col' ? 'col' : 'row', children: parts.map((x) => x[0]), sizes: parts.map((x) => x[1]) };
  };
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const root = node(o.root, 0);
  const floats = (Array.isArray(o.floats) ? o.floats : []).flatMap((f: Record<string, unknown>) =>
    f && typeof f.group === 'object' && f.group ? [{ group: grp(f.group as Record<string, unknown>), x: num(f.x, 40), y: num(f.y, 40), w: Math.max(160, num(f.w, 320)), h: Math.max(90, num(f.h, 400)) }] : []);
  const l = clean({ root, floats });
  return l.root || l.floats.length ? l : null;
}
