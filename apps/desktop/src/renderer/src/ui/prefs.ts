// Every interface preference in one store: theme, panel layout, toolbars, sections, shortcuts.
// Saved to this computer; parts of the app subscribe only to what they use.

import { useSyncExternalStore } from 'react';
import { TRANSITION_GROUPS } from '@ace/project';
import { group, sanitize, split, type DockLayout } from './dockModel';
import { DEFAULT_THEME, resolveMode, sanitizeTheme, THEMES, themeVars, type Mode, type Theme } from './theme';

export const PANELS = {
  media: 'Media', viewer: 'Preview', timeline: 'Timeline', reframe: 'Reframe', stabilize: 'Stabilize', color: 'Color', effects: 'Effects', clip: 'Clip', selection: 'Selected item', markers: 'Markers',
} as const;
export type BuiltinPanel = keyof typeof PANELS;
export interface CustomPanel { id: string; title: string }

export type BarId = 'main' | 'transport' | 'timeline';
export const BAR_NAMES: Record<BarId, string> = { main: 'Window toolbar', transport: 'Preview controls', timeline: 'Timeline toolbar' };
export interface BarPrefs { items: string[]; position: 'top' | 'bottom'; hidden: boolean }

export interface Prefs {
  theme: Theme;
  /** The user's saved themes. */
  themes: Record<string, Theme>;
  layout: DockLayout;
  workspaces: Record<string, { layout: DockLayout; bars: Record<BarId, BarPrefs> }>;
  bars: Record<BarId, BarPrefs>;
  customPanels: CustomPanel[];
  /** Section ids in each panel (or selected-item list), in order. Missing = the default. */
  sections: Record<string, string[]>;
  hiddenSections: string[];
  /** Order of the rows inside a section, and the rows hidden from it. */
  rows: Record<string, string[]>;
  hiddenRows: Record<string, string[]>;
  shortcuts: Record<string, string>;
  /** Items added to the app after these toolbars were saved, already offered once. */
  seen: string[];
  /** The welcome screen has been seen (first launch done). */
  welcomed: boolean;
}

const INSPECTOR = ['reframe', 'stabilize', 'color', 'effects', 'clip', 'selection'];
export const LAYOUTS: [string, () => DockLayout][] = [
  ['Standard', () => ({ root: split('col', [split('row', [group('media'), 0.17], [group('viewer'), 0.57], [group(...INSPECTOR), 0.26]), 0.64], [group('timeline'), 0.36]), floats: [] })],
  ['Big preview', () => ({ root: split('row', [split('col', [group('viewer'), 0.72], [group('timeline'), 0.28]), 0.76], [group(...INSPECTOR, 'media'), 0.24]), floats: [] })],
  // The timeline runs under one side panel; the other side panel is full height.
  ['Tall inspector', () => ({ root: split('row', [split('col', [split('row', [group('media'), 0.23], [group('viewer'), 0.77]), 0.64], [group('timeline'), 0.36]), 0.74], [group(...INSPECTOR), 0.26]), floats: [] })],
  ['Tall media', () => ({ root: split('row', [group('media'), 0.17], [split('col', [split('row', [group('viewer'), 0.69], [group(...INSPECTOR), 0.31]), 0.64], [group('timeline'), 0.36]), 0.83]), floats: [] })],
  ['Tall sidebars', () => ({ root: split('row', [group('media'), 0.16], [split('col', [group('viewer'), 0.62], [group('timeline'), 0.38]), 0.58], [group(...INSPECTOR), 0.26]), floats: [] })],
  ['Color & effects', () => ({ root: split('col', [split('row', [group('viewer', 'media'), 0.5], [group('color'), 0.25], [group('effects', 'reframe', 'stabilize', 'clip', 'selection'), 0.25]), 0.68], [group('timeline'), 0.32]), floats: [] })],
  ['Reframe', () => ({ root: split('col', [split('row', [group('reframe', 'stabilize'), 0.24], [group('viewer'), 0.54], [group('color', 'effects', 'clip', 'selection', 'media'), 0.22]), 0.66], [group('timeline'), 0.34]), floats: [] })],
  ['Focus', () => ({ root: split('col', [group('viewer'), 0.7], [group('timeline'), 0.3]), floats: [] })],
];

export const DEFAULT_BARS: Record<BarId, BarPrefs> = {
  // (On a Mac the menu bar does the menu's job.)
  main: { items: [...(navigator.platform.toLowerCase().includes('mac') ? [] : ['menu']), 'projects', 'space', 'import', 'card', 'music', 'space', 'undo', 'redo', 'space', 'text', 'gauges', 'track', 'flex', 'status', 'flex', 'frame', 'grab', 'space', 'workspaces', 'customize', 'space', 'export'], position: 'top', hidden: false },
  transport: { items: ['time', 'flex', 'start', 'prev', 'play', 'next', 'end', 'flex', 'compare', 'quality', 'fps', 'fullscreen'], position: 'bottom', hidden: false },
  timeline: { items: ['split', 'delLeft', 'delRight', 'space', 'detach', 'tool', 'speedline', 'jumps', 'snap', 'multicam', 'delete', 'flex', 'tlinfo', 'tlzoom'], position: 'top', hidden: false },
};

/** Which sections each panel shows to begin with. */
export const DEFAULT_SECTIONS: Record<string, string[]> = {
  reframe: ['Keyframes', 'Subject tracking', 'View', 'Framing', 'Lens', 'Lens details', 'Debug'],
  stabilize: ['Stabilization', 'Crop', 'Horizon'],
  color: ['Input color', 'Presets', 'Light', 'Color', 'Detail', 'LUT', 'Lens match', 'Match clips'],
  effects: ['Masks', 'Motion blur (ND filter)', 'Speed & lens', 'Film & light', 'Quick looks'],
  clip: ['Transform', 'Layout', 'Speed', 'Airtime', 'Audio', 'Trim'],
  'sel:text': ['Text', 'Font', 'Colour & effect', 'Position', 'Overlay timing'],
  'sel:gauge': ['Look', 'Position', 'Overlay timing'],
  'sel:transition': [...TRANSITION_GROUPS.map(([g]) => g), 'Transition timing'],
  'sel:audio': ['Volume & fades'],
};

/** Toolbar items added later: put into saved toolbars once (next to a neighbour), then left to the user. */
const NEW_ITEMS: { item: string; bar: BarId; before: string }[] = [{ item: 'projects', bar: 'main', before: 'import' }, { item: 'compare', bar: 'transport', before: 'quality' }, { item: 'card', bar: 'main', before: 'music' }, { item: 'speedline', bar: 'timeline', before: 'delete' }, { item: 'jumps', bar: 'timeline', before: 'delete' }, { item: 'snap', bar: 'timeline', before: 'delete' }, { item: 'tool', bar: 'timeline', before: 'speedline' }, { item: 'multicam', bar: 'timeline', before: 'delete' }];
function offerNew(bars: Record<BarId, BarPrefs>, seen: string[]) {
  for (const n of NEW_ITEMS) {
    if (seen.includes(n.item) || Object.values(bars).some((b) => b.items.includes(n.item))) continue;
    const list = bars[n.bar].items, at = list.indexOf(n.before);
    list.splice(at < 0 ? list.length : at, 0, n.item);
  }
  return bars;
}

const defaults = (): Prefs => ({
  theme: DEFAULT_THEME, themes: {}, layout: LAYOUTS[0]![1](), workspaces: {}, bars: structuredClone(DEFAULT_BARS), customPanels: [], sections: {}, hiddenSections: [], rows: {}, hiddenRows: {}, shortcuts: {}, seen: NEW_ITEMS.map((n) => n.item), welcomed: false,
});
export const defaultPrefs = defaults;

const KEY = 'ace.ui.v1';
const strs = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : []);
const rec = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const lists = (v: unknown) => Object.fromEntries(Object.entries(rec(v)).map(([k, x]) => [k, strs(x)]));
const SPACERS = ['space', 'flex', 'sep'];
export const isSpacer = (id: string) => SPACERS.includes(id);

function sanitizeBars(v: unknown): Record<BarId, BarPrefs> {
  const out = structuredClone(DEFAULT_BARS), src = rec(v), seen = new Set<string>();
  for (const id of Object.keys(out) as BarId[]) {
    const b = rec(src[id]);
    if (Array.isArray(b.items)) out[id].items = b.items.filter((x): x is string => typeof x === 'string' && (isSpacer(x) || (!seen.has(x) && !!seen.add(x))));
    if (b.position === 'top' || b.position === 'bottom') out[id].position = b.position;
    if (typeof b.hidden === 'boolean') out[id].hidden = b.hidden;
  }
  return out;
}

/** Safe preferences from anything stored or imported. */
export function sanitizePrefs(raw: unknown): Prefs {
  const r = rec(raw), d = defaults();
  const customPanels = (Array.isArray(r.customPanels) ? r.customPanels : []).flatMap((p) => {
    const o = rec(p);
    return typeof o.id === 'string' && o.id.startsWith('custom:') && typeof o.title === 'string' ? [{ id: o.id, title: o.title.slice(0, 40) }] : [];
  });
  const known = (p: string) => p in PANELS || customPanels.some((c) => c.id === p);
  const shortcuts = Object.fromEntries(Object.entries(rec(r.shortcuts)).filter((e): e is [string, string] => typeof e[1] === 'string'));
  return {
    theme: r.theme ? sanitizeTheme(r.theme) : d.theme,
    themes: Object.fromEntries(Object.entries(rec(r.themes)).map(([k, t]) => [k, sanitizeTheme(t)])),
    layout: sanitize(r.layout, known) ?? d.layout,
    workspaces: Object.fromEntries(Object.entries(rec(r.workspaces)).flatMap(([k, w]) => { const l = sanitize(rec(w).layout, known); return l ? [[k, { layout: l, bars: sanitizeBars(rec(w).bars) }]] : []; })),
    bars: r.bars ? offerNew(sanitizeBars(r.bars), strs(r.seen)) : d.bars,
    seen: d.seen,
    welcomed: r.welcomed === true,
    customPanels, sections: lists(r.sections), hiddenSections: strs(r.hiddenSections), rows: lists(r.rows), hiddenRows: lists(r.hiddenRows), shortcuts,
  };
}

let prefs: Prefs = (() => {
  try {
    return sanitizePrefs(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return defaults();
  }
})();
const subs = new Set<() => void>();
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };
window.addEventListener('pagehide', save);

// Undo for interface changes (theme, layout, toolbars…), separate from the edit's own undo.
const past: Prefs[] = [];
let lastKey = '', lastAt = 0;
export const canUndoPrefs = () => past.length > 0;

/** Changes preferences. Changes with the same `key` within a second are one undo step. */
export function setPrefs(patch: Partial<Prefs> | ((p: Prefs) => Partial<Prefs>), key = '') {
  const now = performance.now();
  if (!key || key !== lastKey || now - lastAt > 1000) {
    past.push(prefs);
    if (past.length > 100) past.shift();
  }
  lastKey = key;
  lastAt = now;
  apply({ ...prefs, ...(typeof patch === 'function' ? patch(prefs) : patch) });
}
export function undoPrefs() {
  const p = past.pop();
  lastKey = '';
  if (p) apply(p);
}
function apply(next: Prefs) {
  const themeChanged = next.theme !== prefs.theme;
  prefs = next;
  if (themeChanged) applyTheme();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
  subs.forEach((f) => f());
}
export const getPrefs = () => prefs;
export const usePrefs = <T,>(pick: (p: Prefs) => T): T => useSyncExternalStore(subscribe, () => pick(prefs));
export const setTheme = (patch: Partial<Theme>, key = '') => setPrefs((p) => ({ theme: { ...p.theme, ...patch } }), key || `theme:${Object.keys(patch).join()}`);

// --- Theme → page ------------------------------------------------------------------------------
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const isMac = navigator.platform.toLowerCase().includes('mac');
let native: ((o: { mode: Theme['mode']; translucent: boolean }) => void) | null = null;
/** Called with the window-level part of the theme (native appearance and material). */
export const onNativeTheme = (f: NonNullable<typeof native>) => { native = f; f({ mode: prefs.theme.mode, translucent: prefs.theme.translucent }); };
let mode: Mode = resolveMode(prefs.theme, darkQuery.matches);
export const currentMode = () => mode;

export function applyTheme() {
  mode = resolveMode(prefs.theme, darkQuery.matches);
  const root = document.documentElement;
  const { vars, attrs } = themeVars(prefs.theme, mode, isMac);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  for (const [k, v] of Object.entries(attrs)) root.dataset[k] = v;
  root.dataset.platform = isMac ? 'mac' : 'other';
  native?.({ mode: prefs.theme.mode, translucent: prefs.theme.translucent });
}
darkQuery.addEventListener('change', () => { applyTheme(); subs.forEach((f) => f()); });
applyTheme();

export const BUILTIN_THEMES = THEMES;
export const platformMac = isMac;

// --- Arrange mode: everything can be dragged around --------------------------------------------
let arranging = false;
const arrangeSubs = new Set<() => void>();
export const isArranging = () => arranging;
export function setArranging(v: boolean) {
  arranging = v;
  document.documentElement.dataset.arrange = v ? 'on' : 'off';
  arrangeSubs.forEach((f) => f());
}
export const useArranging = () => useSyncExternalStore((f) => { arrangeSubs.add(f); return () => { arrangeSubs.delete(f); }; }, () => arranging);

// --- Sections ----------------------------------------------------------------------------------
/** Panels whose sections can be moved between each other (they all edit the clip). */
export const isInspectorPanel = (id: string) => ['reframe', 'stabilize', 'color', 'effects', 'clip'].includes(id) || id.startsWith('custom:');
/** The section ids a list shows, in order: saved order, plus any defaults that are nowhere else. */
export function sectionList(p: Prefs, list: string): string[] {
  const saved = p.sections[list];
  const base = DEFAULT_SECTIONS[list] ?? [];
  if (!saved && !isInspectorPanel(list)) return base;
  const placedElsewhere = new Set(isInspectorPanel(list) ? Object.entries(p.sections).filter(([k]) => k !== list && isInspectorPanel(k)).flatMap(([, v]) => v) : []);
  const own = saved ?? base.filter((s) => !placedElsewhere.has(s));
  // A section added in a later version, or never moved, stays in its home panel.
  const missing = saved ? base.filter((s) => !own.includes(s) && !placedElsewhere.has(s)) : [];
  return [...own, ...missing];
}
export function moveSection(id: string, from: string, to: string, index: number) {
  setPrefs((p) => {
    const a = sectionList(p, from).filter((s) => s !== id);
    const b = from === to ? a : sectionList(p, to).filter((s) => s !== id);
    const at = Math.max(0, Math.min(b.length, index));
    const next = [...b.slice(0, at), id, ...b.slice(at)];
    return { sections: { ...p.sections, [from]: a, [to]: next } };
  });
}
export const toggleSectionHidden = (id: string) => setPrefs((p) => ({ hiddenSections: p.hiddenSections.includes(id) ? p.hiddenSections.filter((s) => s !== id) : [...p.hiddenSections, id] }));

// --- Toolbars ------------------------------------------------------------------------------------
/** Puts an item in a bar at `index` (removing it from wherever it was), or takes it out (`to` null). */
export function placeItem(item: string, from: { bar: BarId; index: number } | null, to: { bar: BarId; index: number } | null) {
  setPrefs((p) => {
    const bars = structuredClone(p.bars);
    let at = to?.index ?? 0;
    if (from) {
      bars[from.bar].items.splice(from.index, 1);
      if (to && to.bar === from.bar && from.index < at) at--;
    } else if (!isSpacer(item)) {
      for (const b of Object.keys(bars) as BarId[]) {
        const i = bars[b].items.indexOf(item);
        if (i >= 0) { bars[b].items.splice(i, 1); if (to?.bar === b && i < at) at--; }
      }
    }
    if (to) bars[to.bar].items.splice(Math.max(0, Math.min(bars[to.bar].items.length, at)), 0, item);
    return { bars };
  });
}
export const setBar = (id: BarId, patch: Partial<BarPrefs>) => setPrefs((p) => ({ bars: { ...p.bars, [id]: { ...p.bars[id], ...patch } } }));
