// Things drawn on top of the video: text titles and telemetry gauges (speed, altitude,
// distance, G-force, GPS map). Each lives on the timeline between startUs and endUs.
// Positions and sizes are fractions of the output frame, so they work at any framing.

import type { TransitionKind } from './timeline';

export type GaugeKind = 'speed' | 'altitude' | 'distance' | 'gforce' | 'airtime' | 'jumpdist' | 'sound' | 'spectrum' | 'map' | 'timer' | 'clock';
export type OverlayKind = 'text' | GaugeKind;
export type OverlayFont =
  | 'sans' | 'rounded' | 'condensed' | 'heavy' | 'impact' | 'futura' | 'avenir' | 'gill' | 'optima'
  | 'serif' | 'didot' | 'baskerville' | 'rockwell' | 'copperplate'
  | 'mono' | 'typewriter'
  | 'marker' | 'chalk' | 'script';
export type OverlayAnimation = 'none' | 'fade' | 'pop' | 'slide-up' | 'typewriter';
export type OverlayBackground = 'none' | 'shadow' | 'box' | 'glow';
/** Gauge looks; which ones apply depends on the gauge (see GAUGE_STYLES). */
export type GaugeStyle = 'digital' | 'dial' | 'needle' | 'bar' | 'graph' | 'square' | 'round' | 'bars' | 'mirror' | 'radial' | 'wave' | 'leds';
/** A gauge's design: its shapes, type and colours (see GAUGE_DESIGNS). */
export type GaugeDesign = 'classic' | 'minimal' | 'sport' | 'neon' | 'carbon' | 'lcd' | 'cockpit' | 'arc' | 'ring' | 'tape' | 'badge' | 'moto';

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
  /** Gauges: the design. Missing = classic. */
  design?: GaugeDesign;
  /** Airtime gauge, between jumps: the longest jump so far, all time in the air so far, or the last jump. Missing = longest. */
  /** Between jumps: the best, last or total so far. 'running': only ever the total, growing through each jump. */
  airShow?: 'best' | 'total' | 'last' | 'running';
  /** Gauges: keep counting (distance, jumps, timer) across cuts in the video. Missing = start again at each cut. */
  keepCounting?: boolean;
  /** Gauges: read the ride data of this clip on V2–V6. Missing = the main-row clip under the playhead. */
  sourceClipId?: string;
  /** Text: a motion title template (see TITLE_TEMPLATES); it brings its own movement in and out. */
  title?: string;
  /** Motion titles: the second line (a role, place, date…). */
  subtitle?: string;
  /** Text: runs along a path instead of a straight line. */
  path?: TextPath;
  /** Sound spectrum: what it listens to. Missing = the music while there is some, else the clip's own sound. */
  listen?: 'clip' | 'music';
  /** Text: a caption made by auto subtitles (replaced when they are made again, saved in the .srt). */
  caption?: boolean;
}

/** A path for text: an arc, a wave, a full circle, or a line drawn by hand. */
export interface TextPath {
  kind: 'arc' | 'wave' | 'circle' | 'freehand';
  /** Arc and wave: how much it bends, −1…1 (negative bends the other way). Circle: −1 runs the text inside. */
  bend: number;
  /** Freehand: the line, each point −0.5…0.5 across and down a box twice as wide as high. */
  points?: [number, number][];
}
export const TEXT_PATHS: [TextPath['kind'] | 'none', string][] = [['none', 'Straight'], ['arc', 'Arc'], ['wave', 'Wave'], ['circle', 'Circle'], ['freehand', 'Drawn']];

export type TitleCategory = 'lower' | 'card' | 'end' | 'place';
export const TITLE_CATEGORIES: [TitleCategory, string][] = [['lower', 'Lower thirds'], ['card', 'Title cards'], ['end', 'End cards'], ['place', 'Location tags']];
export interface TitleTemplate {
  id: string;
  name: string;
  category: TitleCategory;
  /** Starting text and second line. Second line words in braces are filled in from the ride: {gps}, {date}, {time}, {alt}, {speed}. */
  text: string;
  subtitle: string;
  /** Uses the second line. */
  hasSubtitle: boolean;
  patch: Partial<Overlay>;
}

const LT: Partial<Overlay> = { x: 0.06, y: 0.8, size: 0.065, align: 'left', background: 'none', outline: 0, tracking: 0, italic: false };
const CARD: Partial<Overlay> = { x: 0.5, y: 0.5, size: 0.12, align: 'center', background: 'none', outline: 0, italic: false };
export const TITLE_TEMPLATES: TitleTemplate[] = [
  // Lower thirds: the anchor is their left edge.
  { id: 'lt-bar', name: 'Accent bar', category: 'lower', text: 'Your name', subtitle: 'Rider · Team', hasSubtitle: true, patch: { ...LT, font: 'avenir', bold: true, color: '#ffffff', accent: '#ff7a1a', bgColor: '#000000', bgOpacity: 0.5 } },
  { id: 'lt-line', name: 'Underline', category: 'lower', text: 'Your name', subtitle: 'Where or what', hasSubtitle: true, patch: { ...LT, font: 'futura', bold: true, uppercase: true, tracking: 0.06, color: '#ffffff', accent: '#ffd60a', bgColor: '#000000', bgOpacity: 0 } },
  { id: 'lt-box', name: 'Solid box', category: 'lower', text: 'Your name', subtitle: 'Rider', hasSubtitle: true, patch: { ...LT, font: 'sans', bold: true, color: '#111111', accent: '#ff375f', bgColor: '#ffffff', bgOpacity: 0.95 } },
  { id: 'lt-tag', name: 'Name tag', category: 'lower', text: 'Your name', subtitle: 'Pro rider', hasSubtitle: true, patch: { ...LT, font: 'condensed', bold: true, uppercase: true, italic: true, color: '#ffffff', accent: '#e10600', bgColor: '#111111', bgOpacity: 0.9 } },
  { id: 'lt-stack', name: 'Stacked', category: 'lower', text: 'Your name', subtitle: 'Riding since 2012', hasSubtitle: true, patch: { ...LT, font: 'rounded', bold: true, color: '#ffffff', accent: '#0a84ff', bgColor: '#1c1c1e', bgOpacity: 0.85 } },
  { id: 'lt-minimal', name: 'Minimal', category: 'lower', text: 'Your name', subtitle: 'Second line', hasSubtitle: true, patch: { ...LT, font: 'avenir', bold: false, tracking: 0.04, color: '#ffffff', accent: '#ffffff', bgColor: '#000000', bgOpacity: 0, background: 'shadow' } },
  // Title cards: the anchor is their centre.
  { id: 'tc-spread', name: 'Spread', category: 'card', text: 'SEND IT', subtitle: 'Summer session', hasSubtitle: true, patch: { ...CARD, font: 'futura', bold: true, uppercase: true, tracking: 0.12, color: '#ffffff', accent: '#ffffff', background: 'shadow' } },
  { id: 'tc-drop', name: 'Letter drop', category: 'card', text: 'DROP IN', subtitle: '', hasSubtitle: false, patch: { ...CARD, font: 'impact', bold: false, uppercase: true, outline: 0.06, outlineColor: '#000000', color: '#ffd400', accent: '#ffd400' } },
  { id: 'tc-cinema', name: 'Cinematic', category: 'card', text: 'The Long Way Down', subtitle: 'A ride film', hasSubtitle: true, patch: { ...CARD, size: 0.09, font: 'didot', bold: false, uppercase: true, tracking: 0.25, color: '#f4efe6', accent: '#f4efe6', bgColor: '#000000', bgOpacity: 1 } },
  { id: 'tc-glitch', name: 'Glitch', category: 'card', text: 'FULL SEND', subtitle: '', hasSubtitle: false, patch: { ...CARD, font: 'heavy', bold: true, uppercase: true, color: '#ffffff', accent: '#ff2bd6', bgColor: '#00e5ff' } },
  { id: 'tc-punch', name: 'Zoom punch', category: 'card', text: 'BIG AIR', subtitle: '', hasSubtitle: false, patch: { ...CARD, size: 0.16, font: 'impact', bold: false, italic: true, uppercase: true, outline: 0.05, outlineColor: '#000000', color: '#ffffff', accent: '#ff3b30', background: 'shadow' } },
  { id: 'tc-outline', name: 'Outline fill', category: 'card', text: 'ENDURO', subtitle: '', hasSubtitle: false, patch: { ...CARD, font: 'heavy', bold: true, uppercase: true, tracking: 0.04, color: '#ffffff', accent: '#ffffff' } },
  { id: 'tc-split', name: 'Split line', category: 'card', text: 'DAY ONE', subtitle: 'Whistler bike park', hasSubtitle: true, patch: { ...CARD, size: 0.1, font: 'futura', bold: true, uppercase: true, tracking: 0.1, color: '#ffffff', accent: '#30d158', background: 'shadow' } },
  { id: 'tc-type', name: 'Typed', category: 'card', text: 'Lap 1', subtitle: 'Warm-up run', hasSubtitle: true, patch: { ...CARD, size: 0.09, font: 'mono', bold: true, color: '#ffffff', accent: '#30d158', background: 'shadow' } },
  // End cards.
  { id: 'end-thanks', name: 'Thanks for watching', category: 'end', text: 'Thanks for watching', subtitle: 'Subscribe for more rides', hasSubtitle: true, patch: { ...CARD, size: 0.09, font: 'rounded', bold: true, color: '#ffffff', accent: '#ff3b30', bgColor: '#000000', bgOpacity: 0.55 } },
  { id: 'end-credits', name: 'Credits roll', category: 'end', text: 'Filmed by\nYour name\n\nRiders\nFirst rider\nSecond rider\n\nMusic\nSong name', subtitle: '', hasSubtitle: false, patch: { ...CARD, size: 0.055, font: 'avenir', bold: false, color: '#ffffff', accent: '#ffffff', bgColor: '#000000', bgOpacity: 0.6 } },
  { id: 'end-card', name: 'Fade out card', category: 'end', text: 'See you on the trail', subtitle: '@yourchannel', hasSubtitle: true, patch: { ...CARD, size: 0.08, font: 'futura', bold: true, color: '#ffffff', accent: '#ff7a1a', bgColor: '#0b0b0d', bgOpacity: 1 } },
  // Location tags.
  { id: 'loc-pin', name: 'Map pin', category: 'place', text: 'Place name', subtitle: '{gps}', hasSubtitle: true, patch: { ...LT, y: 0.14, font: 'avenir', bold: true, color: '#ffffff', accent: '#ff3b30', bgColor: '#000000', bgOpacity: 0.45 } },
  { id: 'loc-coords', name: 'Coordinates', category: 'place', text: '{gps}', subtitle: '{alt}', hasSubtitle: true, patch: { ...LT, y: 0.88, size: 0.045, font: 'mono', bold: true, color: '#ffffff', accent: '#30d158', bgColor: '#000000', bgOpacity: 0.5 } },
  { id: 'loc-stamp', name: 'Date stamp', category: 'place', text: '{date}', subtitle: '{time}', hasSubtitle: true, patch: { ...LT, x: 0.72, y: 0.9, size: 0.05, font: 'mono', bold: true, color: '#ffb000', accent: '#ff3b30', bgColor: '#000000', bgOpacity: 0, background: 'shadow' } },
  { id: 'loc-sign', name: 'Trail sign', category: 'place', text: 'Trail name', subtitle: 'Black · 4.2 km', hasSubtitle: true, patch: { ...LT, y: 0.2, size: 0.06, font: 'condensed', bold: true, uppercase: true, color: '#ffffff', accent: '#ffffff', bgColor: '#1f5f3a', bgOpacity: 1 } },
];
export const titleTemplate = (id: string | undefined) => (id ? TITLE_TEMPLATES.find((t) => t.id === id) : undefined);

/** A motion title from a template (its starting words, look and place). */
export function newTitleOverlay(templateId: string, startUs: number, endUs: number): Overlay {
  const t = titleTemplate(templateId) ?? TITLE_TEMPLATES[0]!;
  return { ...newTextOverlay(startUs, endUs, t.text), ...t.patch, title: t.id, subtitle: t.subtitle, animation: 'none' };
}

/**
 * Changes a title's template, keeping its words when they were changed from the old template's
 * (and its place when it stays the same kind of title).
 */
export function applyTitleTemplate(o: Overlay, templateId: string | null): Partial<Overlay> {
  if (!templateId) return { title: undefined, animation: 'fade' };
  const t = titleTemplate(templateId);
  if (!t) return {};
  const old = titleTemplate(o.title);
  const keepText = old ? o.text !== old.text : o.kind === 'text' && o.text !== 'Your text';
  const keepSub = !!o.subtitle && (!old || o.subtitle !== old.subtitle);
  const { x, y, ...look } = t.patch;
  const samePlace = old?.category === t.category;
  return { ...look, ...(samePlace ? {} : { x, y }), title: t.id, animation: 'none', text: keepText ? o.text : t.text, subtitle: keepSub ? o.subtitle : t.subtitle, path: undefined };
}

/** How far a title's movement in and out has gone at timeline time T (seconds since it started, and its length). */
export interface TitleTime { t: number; len: number; tin: number; tout: number }
export function titleTime(o: Pick<Overlay, 'startUs' | 'endUs'>, T: number, inS = 0.8, outS = 0.5): TitleTime {
  const len = (o.endUs - o.startUs) / 1e6, t = (T - o.startUs) / 1e6;
  const scale = Math.min(1, len / (inS + outS + 0.2));
  return { t, len, tin: Math.max(0, Math.min(1, t / (inS * scale))), tout: Math.max(0, Math.min(1, (len - t) / (outS * scale))) };
}

/** A text path made safe (from a file). */
export function cleanTextPath(p: unknown): TextPath | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const r = p as Partial<TextPath>;
  if (!['arc', 'wave', 'circle', 'freehand'].includes(r.kind as string)) return undefined;
  const bend = Number.isFinite(r.bend) ? Math.max(-1, Math.min(1, r.bend!)) : 0.5;
  const points = Array.isArray(r.points)
    ? r.points.filter((q): q is [number, number] => Array.isArray(q) && q.length === 2 && q.every((v) => typeof v === 'number' && Number.isFinite(v))).map(([a, b]) => [Math.max(-0.5, Math.min(0.5, a)), Math.max(-0.5, Math.min(0.5, b))] as [number, number]).slice(0, 400)
    : undefined;
  if (r.kind === 'freehand' && (!points || points.length < 2)) return undefined;
  return { kind: r.kind!, bend, ...(r.kind === 'freehand' ? { points } : {}) };
}

export const GAUGES: [GaugeKind, string][] = [
  ['speed', 'Speed'],
  ['altitude', 'Altitude'],
  ['distance', 'Distance'],
  ['gforce', 'G-force'],
  ['airtime', 'Airtime'],
  ['jumpdist', 'Jump distance'],
  ['sound', 'Sound level'],
  ['spectrum', 'Sound spectrum'],
  ['map', 'GPS map'],
  ['timer', 'Timer'],
  ['clock', 'Time of day'],
];

export const GAUGE_STYLES: Record<GaugeKind, [GaugeStyle, string][]> = {
  speed: [['digital', 'Number'], ['dial', 'Dial'], ['needle', 'Speedometer'], ['bar', 'Bar'], ['graph', 'Graph']],
  gforce: [['digital', 'Number'], ['dial', 'Dial'], ['needle', 'Meter'], ['bar', 'Bar'], ['graph', 'Graph']],
  altitude: [['digital', 'Number'], ['bar', 'Bar'], ['graph', 'Profile']],
  distance: [['digital', 'Number'], ['bar', 'Progress']],
  airtime: [['digital', 'Number'], ['bar', 'Bar']],
  jumpdist: [['digital', 'Number'], ['bar', 'Bar']],
  sound: [['digital', 'Number'], ['dial', 'Dial'], ['needle', 'Meter'], ['bar', 'Bar'], ['graph', 'Graph']],
  spectrum: [['bars', 'Bars'], ['mirror', 'Mirrored'], ['radial', 'Circle'], ['wave', 'Curve'], ['leds', 'LED meter']],
  map: [['square', 'Square'], ['round', 'Round']],
  timer: [['digital', 'Number']],
  clock: [['digital', 'Number']],
};

/**
 * Gauge designs. Choosing one sets its colours, type and panel (which can then be changed);
 * `styles` are the drawing types it comes in, `kinds` the gauges it suits (missing = all but the map).
 */
export interface GaugeDesignInfo { id: GaugeDesign; name: string; styles: GaugeStyle[]; kinds?: GaugeKind[]; patch: Partial<Overlay> }
const WITH_VALUE: GaugeKind[] = ['speed', 'gforce', 'altitude', 'distance', 'airtime', 'jumpdist', 'sound'];
export const GAUGE_DESIGNS: GaugeDesignInfo[] = [
  { id: 'classic', name: 'Classic', styles: ['digital', 'dial', 'needle', 'bar', 'graph', 'square', 'round', 'bars', 'mirror', 'radial', 'wave', 'leds'], kinds: [...WITH_VALUE, 'map', 'spectrum', 'timer', 'clock'], patch: { color: '#ffffff', accent: '#ff7a1a', bgColor: '#000000', bgOpacity: 0.45, font: 'condensed', bold: true, italic: false, background: 'shadow' } },
  { id: 'minimal', name: 'Minimal', styles: ['digital', 'dial', 'bar', 'graph', 'square', 'round', 'bars', 'mirror', 'radial', 'wave', 'leds'], kinds: [...WITH_VALUE, 'map', 'spectrum', 'timer', 'clock'], patch: { color: '#ffffff', accent: '#ffffff', bgColor: '#000000', bgOpacity: 0, font: 'avenir', bold: false, italic: false, background: 'shadow' } },
  { id: 'sport', name: 'Sport', styles: ['digital', 'bar'], patch: { color: '#ffffff', accent: '#ffd400', bgColor: '#111111', bgOpacity: 0.85, font: 'condensed', bold: true, italic: true, background: 'box' } },
  { id: 'neon', name: 'Neon', styles: ['digital', 'dial', 'needle', 'bar', 'graph', 'square', 'round', 'bars', 'mirror', 'radial', 'wave', 'leds'], kinds: [...WITH_VALUE, 'map', 'spectrum', 'timer', 'clock'], patch: { color: '#e9fdff', accent: '#ff2bd6', bgColor: '#05000f', bgOpacity: 0.35, font: 'rounded', bold: true, italic: false, background: 'glow' } },
  { id: 'carbon', name: 'Carbon', styles: ['digital', 'dial', 'needle', 'bar', 'graph', 'square', 'round', 'bars', 'mirror', 'radial', 'wave', 'leds'], kinds: [...WITH_VALUE, 'map', 'spectrum', 'timer', 'clock'], patch: { color: '#f2f2f2', accent: '#e10600', bgColor: '#16181b', bgOpacity: 0.92, font: 'futura', bold: true, italic: false, background: 'box' } },
  { id: 'lcd', name: 'Retro LCD', styles: ['digital'], patch: { color: '#1d2a12', accent: '#1d2a12', bgColor: '#a8c27a', bgOpacity: 0.95, font: 'mono', bold: true, italic: false, background: 'box' } },
  { id: 'cockpit', name: 'Cockpit', styles: ['needle'], kinds: ['speed', 'gforce', 'altitude', 'airtime', 'jumpdist', 'sound'], patch: { color: '#ffffff', accent: '#ff9f0a', bgColor: '#0a0a0a', bgOpacity: 1, font: 'sans', bold: true, italic: false, background: 'box' } },
  { id: 'arc', name: 'Arc', styles: ['dial'], kinds: WITH_VALUE, patch: { color: '#ffffff', accent: '#30d158', bgColor: '#000000', bgOpacity: 0.35, font: 'rounded', bold: true, italic: false, background: 'shadow' } },
  { id: 'ring', name: 'Ring', styles: ['dial'], kinds: WITH_VALUE, patch: { color: '#ffffff', accent: '#0a84ff', bgColor: '#000000', bgOpacity: 0.4, font: 'sans', bold: true, italic: false, background: 'shadow' } },
  { id: 'tape', name: 'Tape', styles: ['digital'], kinds: ['speed', 'gforce', 'altitude'], patch: { color: '#ffffff', accent: '#ffd60a', bgColor: '#000000', bgOpacity: 0.5, font: 'condensed', bold: true, italic: false, background: 'box' } },
  { id: 'badge', name: 'Badge', styles: ['digital'], patch: { color: '#ffffff', accent: '#ff375f', bgColor: '#1c1c1e', bgOpacity: 0.8, font: 'rounded', bold: true, italic: false, background: 'box' } },
  { id: 'moto', name: 'Moto', styles: ['needle'], kinds: ['speed', 'gforce'], patch: { color: '#ffffff', accent: '#ff3b30', bgColor: '#000000', bgOpacity: 0.55, font: 'heavy', bold: true, italic: true, background: 'shadow' } },
];
/** The looks a gauge can take: every design × drawing type that suits it. */
export function gaugeLooks(kind: GaugeKind): { design: GaugeDesign; style: GaugeStyle; name: string }[] {
  const own = GAUGE_STYLES[kind];
  const out: { design: GaugeDesign; style: GaugeStyle; name: string }[] = [];
  for (const d of GAUGE_DESIGNS) {
    if (!(d.kinds ?? WITH_VALUE.concat(['timer', 'clock'])).includes(kind)) continue;
    const styles = d.styles.length === 1 ? d.styles : d.styles.filter((s) => own.some(([o]) => o === s));
    for (const st of styles) {
      const typeName = own.find(([o]) => o === st)?.[1];
      out.push({ design: d.id, style: st, name: d.styles.length === 1 || !typeName ? d.name : d.id === 'classic' ? typeName : `${d.name} ${typeName.toLowerCase()}` });
    }
  }
  return out;
}
/** What choosing a look changes. */
export const lookPatch = (design: GaugeDesign, style: GaugeStyle): Partial<Overlay> => ({ ...GAUGE_DESIGNS.find((d) => d.id === design)!.patch, design, style });

/** The look a gauge gets in a design: the design itself if it suits the gauge, else a plain number in its colours. */
export function designFor(kind: GaugeKind, design: GaugeDesign, prefer?: GaugeStyle): Partial<Overlay> {
  const looks = gaugeLooks(kind).filter((l) => l.design === design);
  const pick = looks.find((l) => l.style === prefer) ?? looks[0];
  if (pick) return lookPatch(pick.design, pick.style);
  const d = GAUGE_DESIGNS.find((x) => x.id === design)!;
  const fallback = gaugeLooks(kind).find((l) => l.design === 'classic' && (kind !== 'map' || l.style === 'square'))!;
  return { ...lookPatch('classic', fallback.style), color: d.patch.color, accent: d.patch.accent, font: d.patch.font, italic: d.patch.italic };
}
/** A matching set of gauges in one design, placed so they don't overlap. */
export function gaugeSet(design: GaugeDesign, startUs: number, endUs: number): Overlay[] {
  const place: [GaugeKind, Partial<Overlay>, GaugeStyle?][] = [
    ['speed', { x: 0.13, y: 0.8, size: 0.2 }, 'needle'],
    ['gforce', { x: 0.36, y: 0.86, size: 0.1 }, 'digital'],
    ['airtime', { x: 0.6, y: 0.86, size: 0.1 }, 'digital'],
    ['altitude', { x: 0.86, y: 0.12, size: 0.09 }, 'digital'],
    ['map', { x: 0.87, y: 0.77, size: 0.26 }, 'round'],
  ];
  return place.map(([kind, at, prefer]) => {
    const o = { ...newGaugeOverlay(kind, startUs, endUs), ...designFor(kind, design, prefer), ...at };
    // Wide designs get a smaller size so the set still fits.
    if (o.design === 'tape' || o.design === 'badge' || o.design === 'sport' || o.design === 'lcd') o.size *= kind === 'speed' ? 0.55 : 0.85;
    if (kind === 'speed' && (o.style === 'digital' || o.style === 'bar')) o.size = Math.min(o.size, 0.12);
    // Round gauges are as wide as they are high: bigger, to read as easily as the numbers.
    const round = o.style === 'dial' || o.style === 'needle';
    if (round && kind !== 'speed') o.size = kind === 'altitude' ? 0.14 : 0.17;
    if (round && kind === 'altitude') { o.x = 0.9; o.y = 0.14; }
    return o;
  });
}

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
  airtime: { x: 0.5, y: 0.87, size: 0.1 },
  jumpdist: { x: 0.7, y: 0.87, size: 0.1 },
  sound: { x: 0.88, y: 0.4, size: 0.1, style: 'bar' },
  spectrum: { x: 0.5, y: 0.84, size: 0.14, style: 'bars', accent: '#30d158' },
  map: { x: 0.87, y: 0.78, size: 0.3, style: 'square' },
  timer: { x: 0.5, y: 0.08, size: 0.08 },
  clock: { x: 0.12, y: 0.1, size: 0.08 },
};

export function newGaugeOverlay(kind: GaugeKind, startUs: number, endUs: number): Overlay {
  return { ...BASE, background: 'shadow', animation: 'fade', ...GAUGE_SPOT[kind], id: newId(), kind, startUs, endUs, font: 'condensed' };
}

/** Fills in anything missing from an overlay loaded from an older project. */
export function fixOverlay(o: Partial<Overlay>): Overlay {
  const out = { ...BASE, id: newId(), kind: 'text', startUs: 0, endUs: 3_000_000, ...o } as Overlay;
  if (out.title !== undefined && !titleTemplate(out.title)) delete out.title;
  if (out.subtitle !== undefined && typeof out.subtitle !== 'string') delete out.subtitle;
  if (out.path !== undefined) { const p = cleanTextPath(out.path); if (p) out.path = p; else delete out.path; }
  return out;
}

export const updateOverlay = <T extends { overlays: Overlay[] }>(tl: T, id: string, patch: Partial<Overlay>): T => ({
  ...tl,
  overlays: tl.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)),
});

/** Overlays shorter than this can't be made by cutting. */
export const MIN_OVERLAY_US = 100_000;

/**
 * Cuts an overlay in two at T (both halves keep its look; a gauge's second half counts from the
 * cut). Unchanged when T isn't inside it, or either half would be too short.
 */
export function splitOverlay<T extends { overlays: Overlay[] }>(tl: T, id: string, at: number): T {
  const i = tl.overlays.findIndex((o) => o.id === id);
  const o = tl.overlays[i];
  if (!o || at - o.startUs < MIN_OVERLAY_US || o.endUs - at < MIN_OVERLAY_US) return tl;
  const overlays = [...tl.overlays];
  overlays.splice(i, 1, { ...o, endUs: at }, { ...o, id: newId(), startUs: at });
  return { ...tl, overlays };
}

/** Removes the part of an overlay before (left) or after (right) T. Unchanged when T isn't inside it. */
export function trimOverlayAt<T extends { overlays: Overlay[] }>(tl: T, id: string, at: number, side: 'left' | 'right'): T {
  const o = tl.overlays.find((x) => x.id === id);
  if (!o || at - o.startUs < MIN_OVERLAY_US || o.endUs - at < MIN_OVERLAY_US) return tl;
  return updateOverlay(tl, id, side === 'left' ? { startUs: at } : { endUs: at });
}

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
  /** The outgoing clip is drawn over the incoming one (it moves away to show it). */
  aOnTop?: boolean;
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

/** A star with five points round the centre, `r` of the half-diagonal out (frame fractions). */
function starPolygon(r: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, k = (i % 2 ? 0.45 : 1) * r * 1.9;
    // (In a 16:9 frame: x is squeezed so the star isn't stretched sideways.)
    pts.push([0.5 + Math.cos(a) * k * 0.5625, 0.5 + Math.sin(a) * k]);
  }
  return pts;
}
/**
 * Several rectangles as one polygon: each starts and ends at its top-left corner, and the path
 * from one corner to the next is walked back again at the end, so the joins enclose nothing.
 */
function rectsPolygon(rects: [number, number, number, number][]): [number, number][] {
  const pts: [number, number][] = [];
  for (const [x0, y0, x1, y1] of rects) pts.push([x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]);
  for (let i = rects.length - 2; i >= 0; i--) pts.push([rects[i]![0], rects[i]![1]]);
  return pts;
}
/** A steady random number for step i (the same every time it is drawn). */
const jitter = (i: number, k: number) => { const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };

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
    case 'split-h':
      t.reveal = { kind: 'rect', r: [0, 0.5 - e / 2, 1, 0.5 + e / 2] };
      break;
    case 'corner':
      t.reveal = { kind: 'rect', r: [0, 0, e, e] };
      break;
    case 'fan': {
      // Two hands sweeping down from 12 o'clock, one each way.
      const pts: [number, number][] = [[0.5, 0.5]];
      const sweep = e * Math.PI;
      for (let a = -sweep; a <= sweep + 1e-9; a += Math.PI / 36) pts.push([0.5 + 1.5 * Math.sin(a), 0.5 - 1.5 * Math.cos(a)]);
      pts.push([0.5 + 1.5 * Math.sin(sweep), 0.5 - 1.5 * Math.cos(sweep)]);
      t.reveal = { kind: 'polygon', pts };
      break;
    }
    case 'blinds': {
      const n = 8, w = 1 / n;
      t.reveal = { kind: 'polygon', pts: rectsPolygon(Array.from({ length: n }, (_, i) => [i * w, 0, i * w + w * e, 1] as [number, number, number, number])) };
      break;
    }
    case 'checker': {
      // Squares grow from their centres, the second half of the board a little later.
      const cols = 8, rows = 5, out: [number, number, number, number][] = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const late = (r + c) % 2 ? 0.35 : 0;
        const g = Math.max(0, Math.min(1, (p - late) / 0.65));
        const s = (g < 0.5 ? 2 * g * g : 1 - (-2 * g + 2) ** 2 / 2) / 2;
        const cx = (c + 0.5) / cols, cy = (r + 0.5) / rows;
        if (s > 0) out.push([cx - s / cols - 0.001, cy - s / rows - 0.001, cx + s / cols + 0.001, cy + s / rows + 0.001]);
      }
      t.reveal = out.length ? { kind: 'polygon', pts: rectsPolygon(out) } : { kind: 'rect', r: [0, 0, 0, 0] };
      break;
    }
    case 'diamond': {
      const r = e * 1.05;
      t.reveal = { kind: 'polygon', pts: [[0.5, 0.5 - r], [0.5 + r, 0.5], [0.5, 0.5 + r], [0.5 - r, 0.5]] };
      break;
    }
    case 'star':
      t.reveal = { kind: 'polygon', pts: starPolygon(e * 1.35) };
      break;
    case 'cover-right':
      t.b.dx = e - 1;
      t.a.alpha = 1 - 0.4 * e;
      break;
    case 'cover-up':
      t.b.dy = 1 - e;
      t.a.alpha = 1 - 0.4 * e;
      break;
    case 'cover-down':
      t.b.dy = e - 1;
      t.a.alpha = 1 - 0.4 * e;
      break;
    case 'uncover-left':
      // The outgoing clip slides away and the incoming one is already there underneath.
      t.a.dx = -e;
      t.b.scale = 1.08 - 0.08 * e;
      t.aOnTop = true;
      break;
    case 'drop-in': {
      // Falls in from the top and settles with a small bounce.
      const b = p < 0.7 ? 1 - (p / 0.7) ** 2 : -0.06 * Math.sin(((p - 0.7) / 0.3) * Math.PI);
      t.b.dy = -b;
      t.a.alpha = 1 - 0.3 * e;
      break;
    }
    case 'whip-up':
    case 'whip-down': {
      const w = easeInOutQuint(p), s = kind === 'whip-up' ? -1 : 1;
      t.a.dy = s * w;
      t.b.dy = s * (w - 1);
      t.a.blur = t.b.blur = peak * 0.045;
      break;
    }
    case 'zoom-out':
      // The outgoing clip shrinks away into the middle.
      t.a.scale = 1 - 0.85 * e;
      t.a.alpha = 1 - e * e;
      t.b.scale = 1.25 - 0.25 * e;
      t.aOnTop = true;
      break;
    case 'shake': {
      // A hard cut hidden in a burst of camera shake.
      const i = Math.floor(p * 24), amp = peak * 0.06;
      const dx = jitter(i, 1) * amp, dy = jitter(i, 2) * amp * 0.7, rot = jitter(i, 3) * peak * 3;
      t.a = { ...t.a, dx, dy, rotate: rot, scale: 1 + peak * 0.1, blur: peak * 0.006 };
      t.b = { ...t.b, dx, dy, rotate: rot, scale: 1 + peak * 0.1, blur: peak * 0.006, alpha: p >= 0.5 ? 1 : 0 };
      break;
    }
    case 'glitch': {
      // Jumps back and forth between the clips in steps, the picture knocked sideways.
      const i = Math.floor(p * 18);
      const show = p > 0.85 ? 1 : p < 0.15 ? 0 : jitter(i, 5) + (p - 0.5) * 2.4 > 0 ? 1 : 0;
      const kick = peak * 0.08 * jitter(i, 6);
      t.a.dx = kick;
      t.b.dx = -kick;
      t.b.alpha = show;
      t.dip = '#ff00ff';
      t.dipAlpha = Math.max(0, jitter(i, 7)) * peak * 0.18;
      break;
    }
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
