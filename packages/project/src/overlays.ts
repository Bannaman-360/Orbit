// Things drawn on top of the video: text titles and telemetry gauges (speed, altitude,
// distance, G-force, GPS map). Each lives on the timeline between startUs and endUs.
// Positions and sizes are fractions of the output frame, so they work at any framing.

import type { TransitionKind } from './timeline';

export type GaugeKind = 'speed' | 'altitude' | 'distance' | 'gforce' | 'map' | 'timer' | 'clock';
export type OverlayKind = 'text' | GaugeKind;
export type OverlayFont =
  | 'sans' | 'rounded' | 'condensed' | 'heavy' | 'impact' | 'futura' | 'avenir' | 'gill' | 'optima'
  | 'serif' | 'didot' | 'baskerville' | 'rockwell' | 'copperplate'
  | 'mono' | 'typewriter'
  | 'marker' | 'chalk' | 'script';
export type OverlayAnimation = 'none' | 'fade' | 'pop' | 'slide-up' | 'typewriter';
export type OverlayBackground = 'none' | 'shadow' | 'box' | 'glow';
/** Gauge looks; which ones apply depends on the gauge (see GAUGE_STYLES). */
export type GaugeStyle = 'digital' | 'dial' | 'needle' | 'bar' | 'graph' | 'square' | 'round';

export interface Overlay {
  id: string;
  kind: OverlayKind;
  startUs: number;
  endUs: number;
  /** Centre of the overlay, 0–1 across and down the frame. */
  x: number;
  y: number;
  /** Size as a fraction of the frame height (text line height / gauge height). */
  size: number;
  color: string;
  /** Text overlays: the text. Gauges: an optional label override. */
  text: string;
  font: OverlayFont;
  bold: boolean;
  background: OverlayBackground;
  animation: OverlayAnimation;
  /** Gauges: units. */
  units: 'metric' | 'imperial';
  /** Gauges: how it is drawn (see GAUGE_STYLES). */
  style: GaugeStyle;
  /** Second colour: dial/bar fill, graph line, map trail. */
  accent: string;
  /** Background (box / dial face) colour and opacity. */
  bgColor: string;
  bgOpacity: number;
  /** Text: italic, outline, letter spacing, capitals, alignment. */
  italic: boolean;
  /** Outline width as a fraction of the text size (0 = none). */
  outline: number;
  outlineColor: string;
  /** Extra letter spacing, fraction of the text size. */
  tracking: number;
  uppercase: boolean;
  align: 'left' | 'center' | 'right';
}

export const GAUGES: [GaugeKind, string][] = [
  ['speed', 'Speed'],
  ['altitude', 'Altitude'],
  ['distance', 'Distance'],
  ['gforce', 'G-force'],
  ['map', 'GPS map'],
  ['timer', 'Timer'],
  ['clock', 'Time of day'],
];

export const GAUGE_STYLES: Record<GaugeKind, [GaugeStyle, string][]> = {
  speed: [['digital', 'Number'], ['dial', 'Dial'], ['needle', 'Speedometer'], ['bar', 'Bar'], ['graph', 'Graph']],
  gforce: [['digital', 'Number'], ['dial', 'Dial'], ['needle', 'Meter'], ['bar', 'Bar'], ['graph', 'Graph']],
  altitude: [['digital', 'Number'], ['bar', 'Bar'], ['graph', 'Profile']],
  distance: [['digital', 'Number'], ['bar', 'Progress']],
  map: [['square', 'Square'], ['round', 'Round']],
  timer: [['digital', 'Number']],
  clock: [['digital', 'Number']],
};

export const FONTS: [OverlayFont, string][] = [
  ['sans', 'Sans'],
  ['rounded', 'Rounded'],
  ['condensed', 'Condensed'],
  ['heavy', 'Heavy'],
  ['impact', 'Impact'],
  ['futura', 'Futura'],
  ['avenir', 'Avenir'],
  ['gill', 'Gill Sans'],
  ['optima', 'Optima'],
  ['serif', 'Serif'],
  ['didot', 'Didot'],
  ['baskerville', 'Baskerville'],
  ['rockwell', 'Slab'],
  ['copperplate', 'Copperplate'],
  ['mono', 'Mono'],
  ['typewriter', 'Typewriter'],
  ['marker', 'Marker'],
  ['chalk', 'Chalk'],
  ['script', 'Script'],
];

/** One-click text looks. */
export const TEXT_PRESETS: [string, Partial<Overlay>][] = [
  ['Title', { font: 'sans', bold: true, background: 'shadow', outline: 0, uppercase: false, tracking: 0, italic: false, color: '#ffffff' }],
  ['Bold outline', { font: 'impact', bold: false, background: 'none', outline: 0.08, outlineColor: '#000000', uppercase: true, tracking: 0.02, color: '#ffffff' }],
  ['Subtitle', { font: 'sans', bold: false, background: 'box', bgColor: '#000000', bgOpacity: 0.6, outline: 0, uppercase: false, size: 0.05, color: '#ffffff' }],
  ['Neon', { font: 'rounded', bold: true, background: 'glow', outline: 0, color: '#39f3ff', uppercase: true, tracking: 0.08 }],
  ['Cinematic', { font: 'didot', bold: false, background: 'shadow', outline: 0, uppercase: true, tracking: 0.3, color: '#f4efe6' }],
  ['Handwritten', { font: 'script', bold: false, background: 'shadow', outline: 0, uppercase: false, tracking: 0, color: '#ffffff' }],
  ['Sport', { font: 'condensed', bold: true, italic: true, background: 'none', outline: 0.05, outlineColor: '#000000', uppercase: true, color: '#ffd400' }],
  ['Retro', { font: 'typewriter', bold: false, background: 'box', bgColor: '#f4e9d0', bgOpacity: 0.9, color: '#3a2a1a', uppercase: false }],
];

export const ANIMATIONS: [OverlayAnimation, string][] = [
  ['none', 'None'],
  ['fade', 'Fade'],
  ['pop', 'Pop'],
  ['slide-up', 'Slide up'],
  ['typewriter', 'Typewriter'],
];

let counter = 0;
const newId = () => `o${Date.now().toString(36)}${(counter++).toString(36)}`;

const BASE: Omit<Overlay, 'id' | 'kind' | 'startUs' | 'endUs'> = {
  x: 0.5, y: 0.5, size: 0.08, color: '#ffffff', text: '', font: 'sans', bold: true,
  background: 'shadow', animation: 'fade', units: 'metric', style: 'digital',
  accent: '#ff7a1a', bgColor: '#000000', bgOpacity: 0.45,
  italic: false, outline: 0, outlineColor: '#000000', tracking: 0, uppercase: false, align: 'center',
};

export function newTextOverlay(startUs: number, endUs: number, text = 'Your text'): Overlay {
  return { ...BASE, id: newId(), kind: 'text', startUs, endUs, text, y: 0.8 };
}

/** Default spots so several gauges don't land on top of each other. */
const GAUGE_SPOT: Record<GaugeKind, Partial<Overlay>> = {
  speed: { x: 0.12, y: 0.85, size: 0.16, style: 'dial' },
  altitude: { x: 0.88, y: 0.12, size: 0.1 },
  distance: { x: 0.88, y: 0.26, size: 0.1 },
  gforce: { x: 0.3, y: 0.87, size: 0.1 },
  map: { x: 0.87, y: 0.78, size: 0.3, style: 'square' },
  timer: { x: 0.5, y: 0.08, size: 0.08 },
  clock: { x: 0.12, y: 0.1, size: 0.08 },
};

export function newGaugeOverlay(kind: GaugeKind, startUs: number, endUs: number): Overlay {
  return { ...BASE, background: 'shadow', animation: 'fade', ...GAUGE_SPOT[kind], id: newId(), kind, startUs, endUs, font: 'condensed' };
}

/** Fills in anything missing from an overlay loaded from an older project. */
export function fixOverlay(o: Partial<Overlay>): Overlay {
  return { ...BASE, id: newId(), kind: 'text', startUs: 0, endUs: 3_000_000, ...o } as Overlay;
}

export const updateOverlay = <T extends { overlays: Overlay[] }>(tl: T, id: string, patch: Partial<Overlay>): T => ({
  ...tl,
  overlays: tl.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)),
});

export const removeOverlay = <T extends { overlays: Overlay[] }>(tl: T, id: string): T => ({ ...tl, overlays: tl.overlays.filter((o) => o.id !== id) });

/** Animation state of an overlay at timeline time T (null = not visible). */
export interface OverlayState {
  alpha: number;
  scale: number;
  /** Vertical offset, fraction of frame height. */
  dy: number;
  /** Typewriter: fraction of the text shown. */
  reveal: number;
}

const ANIM_US = 400_000;

export function overlayState(o: Overlay, T: number): OverlayState | null {
  if (T < o.startUs || T >= o.endUs) return null;
  const len = o.endUs - o.startUs;
  const d = Math.min(ANIM_US, len / 3);
  const tin = Math.min(1, (T - o.startUs) / d);
  const tout = Math.min(1, (o.endUs - T) / d);
  const ease = (x: number) => 1 - (1 - x) ** 3;
  const s: OverlayState = { alpha: 1, scale: 1, dy: 0, reveal: 1 };
  switch (o.animation) {
    case 'fade':
      s.alpha = ease(Math.min(tin, tout));
      break;
    case 'pop': {
      // Overshoot on the way in, shrink away on the way out.
      const k = tin < 1 ? 1 + 2.70158 * (tin - 1) ** 3 + 1.70158 * (tin - 1) ** 2 : 1;
      s.scale = tout < 1 ? 0.6 + 0.4 * ease(tout) : Math.max(0.01, k);
      s.alpha = Math.min(1, tin * 3, tout * 2);
      break;
    }
    case 'slide-up':
      s.dy = (1 - ease(tin)) * 0.06 - (1 - ease(tout)) * 0.06;
      s.alpha = ease(Math.min(tin, tout));
      break;
    case 'typewriter':
      s.reveal = Math.min(1, (T - o.startUs) / Math.min(1_500_000, len / 2));
      s.alpha = ease(tout);
      break;
  }
  return s;
}

/** Where a clip layer sits during a transition (fractions of the frame; rotate in degrees). */
export interface LayerXf {
  alpha: number;
  dx: number;
  dy: number;
  scale: number;
  rotate: number;
  /** Blur radius as a fraction of the frame width. */
  blur: number;
}

/** Part of the frame where the incoming clip shows. Coordinates are fractions of the frame. */
export type Reveal =
  | { kind: 'rect'; r: [number, number, number, number] }
  /** Circle from the centre; r is a fraction of the half-diagonal (1 = corners). */
  | { kind: 'circle'; r: number }
  | { kind: 'polygon'; pts: [number, number][] };

/**
 * How a transition looks at progress p (0 → 1): where the outgoing clip A and incoming
 * clip B sit, what part of B shows, and an optional colour dip/flash on top.
 * Shared by the preview (CSS) and export (canvas) so both match.
 */
export interface TransitionLook {
  a: LayerXf;
  b: LayerXf;
  reveal: Reveal | null;
  dip: string | null;
  dipAlpha: number;
}

const still = (): LayerXf => ({ alpha: 1, dx: 0, dy: 0, scale: 1, rotate: 0, blur: 0 });
const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
const easeInOutQuint = (p: number) => (p < 0.5 ? 16 * p ** 5 : 1 - (-2 * p + 2) ** 5 / 2);

/** Clock-hand sweep from 12 o'clock, as a polygon (fan from the centre). */
function clockPolygon(e: number): [number, number][] {
  const pts: [number, number][] = [[0.5, 0.5]];
  const sweep = e * Math.PI * 2;
  for (let a = 0; a <= sweep + 1e-9; a += Math.PI / 36) pts.push([0.5 + 1.5 * Math.sin(a), 0.5 - 1.5 * Math.cos(a)]);
  pts.push([0.5 + 1.5 * Math.sin(sweep), 0.5 - 1.5 * Math.cos(sweep)]);
  return pts;
}

export function transitionLook(kind: TransitionKind, p: number): TransitionLook {
  const e = easeInOut(p);
  const t: TransitionLook = { a: still(), b: still(), reveal: null, dip: null, dipAlpha: 0 };
  const peak = Math.sin(Math.PI * p); // 0 → 1 → 0
  switch (kind) {
    case 'crossfade':
      t.b.alpha = p;
      break;
    case 'dip-black':
    case 'dip-white':
      t.dip = kind === 'dip-black' ? '#000000' : '#ffffff';
      t.dipAlpha = 1 - Math.abs(2 * p - 1);
      t.b.alpha = p >= 0.5 ? 1 : 0;
      break;
    case 'flash':
      // A hard cut hidden under a bright flash that fades quickly.
      t.dip = '#ffffff';
      t.dipAlpha = Math.max(0, 1 - Math.abs(p - 0.5) * 3.5) ** 1.5;
      t.b.alpha = p >= 0.5 ? 1 : 0;
      break;
    case 'blur':
      t.a.blur = e * 0.03;
      t.b.blur = (1 - e) * 0.03;
      t.b.alpha = e;
      break;
    case 'wipe-left':
      t.reveal = { kind: 'rect', r: [1 - e, 0, 1, 1] };
      break;
    case 'wipe-right':
      t.reveal = { kind: 'rect', r: [0, 0, e, 1] };
      break;
    case 'wipe-up':
      t.reveal = { kind: 'rect', r: [0, 1 - e, 1, 1] };
      break;
    case 'wipe-down':
      t.reveal = { kind: 'rect', r: [0, 0, 1, e] };
      break;
    case 'barn-door':
      t.reveal = { kind: 'rect', r: [0.5 - e / 2, 0, 0.5 + e / 2, 1] };
      break;
    case 'iris':
      t.reveal = { kind: 'circle', r: e };
      break;
    case 'diagonal':
      t.reveal = { kind: 'polygon', pts: [[0, 0], [2 * e + 0.001, 0], [0, 2 * e + 0.001]] };
      break;
    case 'clock':
      t.reveal = { kind: 'polygon', pts: clockPolygon(p) };
      break;
    case 'slide-left':
      t.a.dx = -e;
      t.b.dx = 1 - e;
      break;
    case 'slide-right':
      t.a.dx = e;
      t.b.dx = e - 1;
      break;
    case 'push-up':
      t.a.dy = -e;
      t.b.dy = 1 - e;
      break;
    case 'push-down':
      t.a.dy = e;
      t.b.dy = e - 1;
      break;
    case 'cover-left':
      t.b.dx = 1 - e;
      t.a.alpha = 1 - 0.4 * e;
      break;
    case 'whip-left':
    case 'whip-right': {
      // A fast pan with motion blur, like whipping the camera round.
      const w = easeInOutQuint(p), s = kind === 'whip-left' ? -1 : 1;
      t.a.dx = s * w;
      t.b.dx = s * (w - 1);
      t.a.blur = t.b.blur = peak * 0.045;
      break;
    }
    case 'zoom':
      t.b.scale = 1.6 - 0.6 * e;
      t.b.alpha = e;
      break;
    case 'zoom-through':
      t.a.scale = 1 + 1.5 * e;
      t.a.alpha = 1 - e;
      t.a.blur = e * 0.02;
      t.b.scale = 0.6 + 0.4 * e;
      t.b.alpha = e;
      break;
    case 'spin':
      t.a.rotate = e * 90;
      t.a.scale = 1 + e;
      t.a.alpha = 1 - e;
      t.b.rotate = (e - 1) * 90;
      t.b.scale = 2 - e;
      t.b.alpha = e;
      t.a.blur = t.b.blur = peak * 0.012;
      break;
  }
  return t;
}
