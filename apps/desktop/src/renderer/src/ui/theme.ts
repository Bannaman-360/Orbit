// How the app looks: every colour, shape and control style, as data. A theme becomes CSS
// variables and data- attributes on <html>, so changing it never re-renders the editor.

export type Mode = 'light' | 'dark';
export type ColorKey =
  | 'window' | 'toolbar' | 'panel' | 'group' | 'field' | 'control' | 'text' | 'muted' | 'line' | 'knob' | 'track'
  | 'viewer' | 'timeline' | 'ruler' | 'clip' | 'clip360' | 'audio' | 'audioLinked' | 'textOverlay' | 'gauge' | 'playhead' | 'keyframe' | 'tracking'
  | 'ok' | 'error';

export const COLOR_GROUPS: [string, [ColorKey, string][]][] = [
  ['Interface', [['window', 'Window background'], ['toolbar', 'Toolbars'], ['panel', 'Panels'], ['group', 'Sections'], ['line', 'Lines & borders'], ['text', 'Text'], ['muted', 'Quiet text']]],
  ['Controls', [['control', 'Buttons'], ['field', 'Text fields'], ['track', 'Slider track'], ['knob', 'Slider knob']]],
  ['Preview & timeline', [['viewer', 'Around the preview'], ['timeline', 'Timeline'], ['ruler', 'Ruler'], ['playhead', 'Playhead'], ['keyframe', 'Keyframes'], ['tracking', 'Tracking']]],
  ['Clips', [['clip', 'Video'], ['clip360', '360 video'], ['audio', 'Music'], ['audioLinked', 'Detached sound'], ['textOverlay', 'Text'], ['gauge', 'Gauges']]],
  ['Messages', [['ok', 'Success'], ['error', 'Problem']]],
];

const LIGHT: Record<ColorKey, string> = {
  window: '#ececf0', toolbar: '#f6f6f8', panel: '#f6f6f8', group: '#ffffff', field: '#ffffff', control: '#ffffff', text: '#1d1d1f', muted: '#6e6e73', line: '#d8d8dd', knob: '#ffffff', track: '#d9d9de',
  viewer: '#e2e2e7', timeline: '#f2f2f5', ruler: '#e8e8ec', clip: '#5b9bea', clip360: '#8583e8', audio: '#43b37a', audioLinked: '#d09a52', textOverlay: '#b06fc4', gauge: '#4aa9ab', playhead: '#ff3b30', keyframe: '#e8a200', tracking: '#00a5c4',
  ok: '#248a3d', error: '#d70015',
};
const DARK: Record<ColorKey, string> = {
  window: '#1c1c1e', toolbar: '#28282b', panel: '#262629', group: '#323236', field: '#1e1e21', control: '#48484d', text: '#f5f5f7', muted: '#98989f', line: '#3d3d42', knob: '#e8e8ed', track: '#4c4c52',
  viewer: '#141416', timeline: '#202023', ruler: '#2a2a2d', clip: '#3568a8', clip360: '#5654a8', audio: '#2f7d55', audioLinked: '#8a6533', textOverlay: '#84488f', gauge: '#2f7577', playhead: '#ff453a', keyframe: '#ffcc33', tracking: '#35e0ff',
  ok: '#30d158', error: '#ff6961',
};
export const BASE: Record<Mode, Record<ColorKey, string>> = { light: LIGHT, dark: DARK };

/** Apple's system accent colours. */
export const ACCENTS: [string, string][] = [
  ['Blue', '#0a84ff'], ['Purple', '#a550e0'], ['Pink', '#f74f9e'], ['Red', '#ff5257'], ['Orange', '#f7821b'], ['Yellow', '#ffc600'], ['Green', '#62ba46'], ['Teal', '#30b0c7'], ['Graphite', '#8c8c8c'],
];

export interface Theme {
  mode: 'auto' | Mode;
  accent: string;
  /** Changes to the base colours, separately for light and dark. */
  colors: Record<Mode, Partial<Record<ColorKey, string>>>;
  /** Native see-through window material (macOS). */
  translucent: boolean;
  /** How solid panels and toolbars are over it (0–1). */
  panelOpacity: number;
  // Shape
  panelStyle: 'cards' | 'flush';
  gap: number;
  radius: number;
  controlRadius: number;
  clipRadius: number;
  border: number;
  shadow: number;
  density: number;
  // Controls
  buttons: 'mac' | 'glass' | 'flat' | 'soft' | 'outline' | 'raised';
  sliders: 'mac' | 'glass' | 'ios' | 'thin' | 'bar' | 'classic';
  sliderHeight: number;
  knobSize: number;
  segments: 'mac' | 'buttons' | 'underline';
  toggles: 'switch' | 'checkbox';
  tabs: 'segmented' | 'underline' | 'pills' | 'browser';
  sections: 'cards' | 'lines' | 'plain';
  panelBars: 'auto' | 'always';
  // Text & icons
  font: keyof typeof FONTS;
  fontSize: number;
  headings: 'title' | 'caps';
  bold: boolean;
  iconSize: number;
  iconWeight: number;
  iconColor: 'text' | 'accent' | 'colorful';
  toolbarLabels: 'icon' | 'both' | 'text' | 'beside';
  // Timeline
  trackHeight: number;
  playheadWidth: number;
  clipThumbs: boolean;
  clipNames: boolean;
  // Feel
  animations: number;
  scrollbars: 'thin' | 'normal' | 'hidden';
  hints: boolean;
}

export const FONTS = {
  system: ['System (San Francisco)', "system-ui, -apple-system, 'Segoe UI', sans-serif"],
  rounded: ['Rounded', "ui-rounded, 'SF Pro Rounded', 'Arial Rounded MT Bold', system-ui, sans-serif"],
  serif: ['Serif (New York)', "ui-serif, 'New York', Georgia, serif"],
  mono: ['Monospaced', 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'],
  helvetica: ['Helvetica', "'Helvetica Neue', Helvetica, Arial, sans-serif"],
  avenir: ['Avenir', "'Avenir Next', Avenir, 'Segoe UI', sans-serif"],
  gill: ['Gill Sans', "'Gill Sans', 'Gill Sans MT', Calibri, sans-serif"],
} as const;

export const DEFAULT_THEME: Theme = {
  mode: 'auto', accent: '#0a84ff', colors: { light: {}, dark: {} }, translucent: true, panelOpacity: 0.86,
  panelStyle: 'cards', gap: 8, radius: 14, controlRadius: 8, clipRadius: 8, border: 1, shadow: 0.35, density: 1,
  buttons: 'mac', sliders: 'mac', sliderHeight: 4, knobSize: 17, segments: 'mac', toggles: 'switch', tabs: 'segmented', sections: 'cards', panelBars: 'auto',
  font: 'system', fontSize: 13, headings: 'title', bold: true, iconSize: 18, iconWeight: 1.6, iconColor: 'text', toolbarLabels: 'icon',
  trackHeight: 86, playheadWidth: 2, clipThumbs: true, clipNames: true, animations: 1, scrollbars: 'thin', hints: true,
};
const T = (p: Partial<Theme>): Theme => ({ ...DEFAULT_THEME, ...p });

export const THEMES: [string, Theme][] = [
  ['macOS', DEFAULT_THEME],
  ['macOS Light', T({ mode: 'light' })],
  ['macOS Dark', T({ mode: 'dark' })],
  ['Glass', T({ buttons: 'glass', sliders: 'glass', radius: 20, controlRadius: 16, gap: 10, panelOpacity: 0.62, knobSize: 18, sliderHeight: 6, segments: 'mac', tabs: 'pills', iconWeight: 1.8 })],
  ['Pro', T({ mode: 'dark', panelStyle: 'flush', gap: 1, radius: 0, controlRadius: 4, clipRadius: 4, shadow: 0, density: 0.85, fontSize: 12, buttons: 'flat', sliders: 'thin', knobSize: 11, sliderHeight: 3, sections: 'lines', tabs: 'underline', translucent: false, panelOpacity: 1, toggles: 'checkbox', accent: '#8a8aff',
    colors: { light: {}, dark: { window: '#0c0c0d', toolbar: '#1d1d1f', panel: '#1d1d1f', group: '#1d1d1f', viewer: '#0c0c0d', timeline: '#1a1a1c', line: '#333337', control: '#333337' } } })],
  ['Midnight', T({ mode: 'dark', accent: '#5e8bff', colors: { light: {}, dark: { window: '#0a0f1e', toolbar: '#121a30', panel: '#111830', group: '#1a2340', control: '#2a3660', field: '#0c1224', line: '#26304f', track: '#2c3861', timeline: '#0e152a', ruler: '#151d36', viewer: '#070b16' } } })],
  ['Sunset', T({ mode: 'dark', accent: '#ff7a45', colors: { light: {}, dark: { window: '#1d1216', toolbar: '#2b1b21', panel: '#291a20', group: '#37242b', control: '#533640', field: '#1f1318', line: '#47303a', track: '#54394a', timeline: '#22151a', ruler: '#2d1c23', viewer: '#140b0e', muted: '#b8979f' } } })],
  ['Forest', T({ mode: 'dark', accent: '#5cc777', colors: { light: {}, dark: { window: '#0e1512', toolbar: '#17221d', panel: '#16211b', group: '#1f2d26', control: '#31463b', field: '#101a15', line: '#2a3b32', track: '#324a3d', timeline: '#121c17', ruler: '#1a2720', viewer: '#090e0b' } } })],
  ['Paper', T({ mode: 'light', accent: '#b4552d', font: 'serif', buttons: 'soft', sliders: 'classic', translucent: false, panelOpacity: 1, colors: { dark: {}, light: { window: '#efe8dc', toolbar: '#f8f3ea', panel: '#f8f3ea', group: '#fffcf6', line: '#ddd2c0', track: '#ddd2c0', timeline: '#f3ecdf', ruler: '#e8dfcf', viewer: '#e5dccb', text: '#2e261c', muted: '#7b6f5f' } } })],
  ['High contrast', T({ mode: 'dark', accent: '#ffd60a', translucent: false, panelOpacity: 1, border: 2, shadow: 0, buttons: 'outline', sliders: 'bar', sliderHeight: 14, fontSize: 14, colors: { light: {}, dark: { window: '#000000', toolbar: '#000000', panel: '#000000', group: '#000000', control: '#000000', field: '#000000', line: '#ffffff', text: '#ffffff', muted: '#e0e0e0', track: '#4a4a4a', viewer: '#000000', timeline: '#000000', ruler: '#000000' } } })],
  ['Classic', T({ mode: 'dark', accent: '#3d8bfd', panelStyle: 'flush', gap: 1, radius: 0, controlRadius: 6, clipRadius: 6, shadow: 0, buttons: 'raised', sliders: 'classic', segments: 'buttons', toggles: 'checkbox', tabs: 'underline', sections: 'lines', headings: 'caps', translucent: false, panelOpacity: 1, toolbarLabels: 'text', panelBars: 'auto', density: 0.95,
    colors: { light: {}, dark: { window: '#2a2f38', toolbar: '#171a20', panel: '#171a20', group: '#171a20', control: '#242832', field: '#0f1115', line: '#2a2f38', text: '#e6e8eb', muted: '#8a919c', viewer: '#08090b', timeline: '#171a20', ruler: '#1d2128', clip: '#2d4f7c', clip360: '#3b3f87', audio: '#2f6b4f', audioLinked: '#6b4f2f', textOverlay: '#7a3f86', gauge: '#2f6b6b' } } })],
];

const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
/** Allowed range for every numeric setting (also used by the sliders in Customize). */
export const RANGES = {
  panelOpacity: [0.3, 1], gap: [0, 24], radius: [0, 32], controlRadius: [0, 20], clipRadius: [0, 24], border: [0, 3], shadow: [0, 1], density: [0.75, 1.4],
  sliderHeight: [2, 22], knobSize: [8, 26], fontSize: [10, 18], iconSize: [12, 30], iconWeight: [0.8, 3], trackHeight: [44, 160], playheadWidth: [1, 5], animations: [0, 2],
} as const satisfies Partial<Record<keyof Theme, readonly [number, number]>>;
const CHOICES: Partial<Record<keyof Theme, readonly string[]>> = {
  mode: ['auto', 'light', 'dark'], panelStyle: ['cards', 'flush'], buttons: ['mac', 'glass', 'flat', 'soft', 'outline', 'raised'], sliders: ['mac', 'glass', 'ios', 'thin', 'bar', 'classic'],
  segments: ['mac', 'buttons', 'underline'], toggles: ['switch', 'checkbox'], tabs: ['segmented', 'underline', 'pills', 'browser'], sections: ['cards', 'lines', 'plain'], panelBars: ['auto', 'always'],
  font: Object.keys(FONTS), headings: ['title', 'caps'], iconColor: ['text', 'accent', 'colorful'], toolbarLabels: ['icon', 'both', 'text', 'beside'], scrollbars: ['thin', 'normal', 'hidden'],
};

/** A safe theme from anything (a saved or imported file): wrong or missing values fall back. */
export function sanitizeTheme(raw: unknown): Theme {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_THEME } as Record<string, unknown>;
  for (const [k, d] of Object.entries(DEFAULT_THEME)) {
    const v = r[k];
    if (k === 'colors') continue;
    const range = (RANGES as Record<string, readonly [number, number]>)[k];
    const choice = CHOICES[k as keyof Theme];
    if (range) out[k] = clamp(v, range[0], range[1], d as number);
    else if (choice) out[k] = choice.includes(v as string) ? v : d;
    else if (typeof d === 'boolean') out[k] = typeof v === 'boolean' ? v : d;
    else if (k === 'accent') out[k] = typeof v === 'string' && HEX.test(v) ? v : d;
  }
  const c = (r.colors && typeof r.colors === 'object' ? r.colors : {}) as Record<string, unknown>;
  const pick = (m: Mode) => {
    const src = (c[m] && typeof c[m] === 'object' ? c[m] : {}) as Record<string, unknown>;
    return Object.fromEntries(Object.keys(BASE[m]).filter((k) => typeof src[k] === 'string' && HEX.test(src[k] as string)).map((k) => [k, src[k]]));
  };
  out.colors = { light: pick('light'), dark: pick('dark') };
  return out as unknown as Theme;
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
/** Relative luminance 0–1. */
export const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** Black or white, whichever reads better on `hex` (white preferred on mid-tones, as macOS does). */
export const textOn = (hex: string) => (contrast(hex, '#ffffff') >= 2.6 ? '#ffffff' : '#1d1d1f');

export const resolveMode = (t: Theme, systemDark: boolean): Mode => (t.mode === 'auto' ? (systemDark ? 'dark' : 'light') : t.mode);
export const themeColors = (t: Theme, m: Mode): Record<ColorKey, string> => ({ ...BASE[m], ...t.colors[m] });

/** Everything the stylesheet needs, from a theme. */
export function themeVars(t: Theme, mode: Mode, canTranslucent: boolean): { vars: Record<string, string>; attrs: Record<string, string> } {
  const c = themeColors(t, mode);
  const kebab = (s: string) => s.replace(/[A-Z0-9]+/g, (m) => `-${m.toLowerCase()}`);
  const see = t.translucent && canTranslucent;
  const alpha = (hex: string, a: number) => `rgb(${rgb(hex).join(' ')} / ${a})`;
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) vars[k === 'knob' ? '--knob-color' : `--${kebab(k)}`] = v;
  vars['--accent'] = t.accent;
  vars['--on-accent'] = textOn(t.accent);
  vars['--accent-soft'] = alpha(t.accent, mode === 'dark' ? 0.28 : 0.16);
  for (const k of ['clip', 'clip360', 'audio', 'audioLinked', 'textOverlay', 'gauge'] as const) vars[`--on-${kebab(k)}`] = textOn(c[k]);
  // Surfaces that let the native window material through.
  vars['--window-bg'] = see ? alpha(c.window, mode === 'dark' ? 0.35 : 0.3) : c.window;
  vars['--panel-bg'] = see ? alpha(c.panel, t.panelOpacity) : c.panel;
  vars['--toolbar-bg'] = t.panelStyle === 'flush' || !see ? c.toolbar : 'transparent';
  vars['--timeline-bg'] = see ? alpha(c.timeline, Math.min(1, t.panelOpacity + 0.06)) : c.timeline;
  vars['--hover'] = mode === 'dark' ? 'rgb(255 255 255 / 0.08)' : 'rgb(0 0 0 / 0.055)';
  vars['--press'] = mode === 'dark' ? 'rgb(255 255 255 / 0.14)' : 'rgb(0 0 0 / 0.1)';
  vars['--glass'] = mode === 'dark' ? 'rgb(255 255 255 / 0.1)' : 'rgb(255 255 255 / 0.7)';
  vars['--glass-edge'] = mode === 'dark' ? 'rgb(255 255 255 / 0.22)' : 'rgb(255 255 255 / 0.95)';
  vars['--shadow'] = t.shadow > 0 ? `0 ${2 + t.shadow * 6}px ${8 + t.shadow * 26}px rgb(0 0 0 / ${(mode === 'dark' ? 0.55 : 0.22) * t.shadow}), 0 0 0 0.5px rgb(0 0 0 / ${mode === 'dark' ? 0.4 * t.shadow : 0.12 * t.shadow})` : 'none';
  const px = (n: number) => `${n}px`;
  Object.assign(vars, {
    '--gap': px(t.gap), '--radius': px(t.radius), '--r-control': px(t.controlRadius), '--r-clip': px(t.clipRadius), '--bw': px(t.border), '--d': String(t.density),
    '--slider-h': px(t.sliderHeight), '--knob': px(t.knobSize), '--font': FONTS[t.font][1], '--fs': px(t.fontSize), '--weight': t.bold ? '600' : '500', '--icon': px(t.iconSize), '--icon-w': String(t.iconWeight),
    '--track-h': px(t.trackHeight), '--playhead-w': px(t.playheadWidth), '--anim': `${(0.16 * t.animations).toFixed(3)}s`,
  });
  const attrs = {
    mode, buttons: t.buttons, sliders: t.sliders, segments: t.segments, toggles: t.toggles, tabs: t.tabs, sections: t.sections, panels: t.panelStyle, headings: t.headings,
    icons: t.iconColor, scroll: t.scrollbars, hints: t.hints ? 'on' : 'off', thumbs: t.clipThumbs ? 'on' : 'off', names: t.clipNames ? 'on' : 'off', translucent: see ? 'on' : 'off',
  };
  return { vars, attrs };
}
