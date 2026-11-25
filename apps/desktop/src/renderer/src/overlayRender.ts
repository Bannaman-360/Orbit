// Draws text and telemetry overlays, and composites transitions, onto a 2D canvas.
// Shared by the preview overlay layer, export and frame grabs so they always match.

import {
  locate, overlayState, transitionLook, mediaAt, playLength, type TimelineClip,
  isIdentityXf, shownRect, type Transform,
  type LayerXf, type Overlay, type OverlayFont, type Reveal, type Timeline, type TransitionLook,
} from '@ace/project';
import { TelemetrySeries } from '@ace/telemetry';
import { mediaNow } from './media';
import { scrollingGraph, smoothAt, textTime } from './gaugeMath';
import { carbonPanel, designBox, drawDesigned, setFontStack } from './gaugeDesigns';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Font stacks: macOS fonts first, Windows equivalents after. */
export const FONT_STACK: Record<OverlayFont, string> = {
  sans: '-apple-system, "SF Pro Display", "Segoe UI", system-ui, sans-serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", system-ui, sans-serif',
  condensed: '"Avenir Next Condensed", "DIN Condensed", "Bahnschrift SemiCondensed", "Arial Narrow", sans-serif',
  heavy: '"Arial Black", "Helvetica Neue", Arial, sans-serif',
  impact: 'Impact, Haettenschweiler, "Arial Narrow", sans-serif',
  futura: 'Futura, "Century Gothic", "Trebuchet MS", sans-serif',
  avenir: '"Avenir Next", Avenir, "Segoe UI", sans-serif',
  gill: '"Gill Sans", "Gill Sans MT", Calibri, sans-serif',
  optima: 'Optima, Candara, "Segoe UI", sans-serif',
  serif: 'ui-serif, "New York", Georgia, "Times New Roman", serif',
  didot: 'Didot, "Bodoni 72", "Bodoni MT", Georgia, serif',
  baskerville: 'Baskerville, "Baskerville Old Face", Georgia, serif',
  rockwell: 'Rockwell, "Rockwell Nova", "American Typewriter", Georgia, serif',
  copperplate: 'Copperplate, "Copperplate Gothic Light", "Copperplate Gothic", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  typewriter: '"American Typewriter", "Courier New", Courier, monospace',
  marker: '"Marker Felt", "Ink Free", "Comic Sans MS", cursive',
  chalk: '"Chalkboard SE", Chalkduster, "Segoe Print", cursive',
  script: '"Snell Roundhand", "Brush Script MT", "Segoe Script", cursive',
};

setFontStack(FONT_STACK);

const font = (o: Overlay, px: number, weight?: number) =>
  `${o.italic ? 'italic ' : ''}${weight ?? (o.bold ? (o.font === 'heavy' ? 900 : 700) : 400)} ${Math.max(1, px)}px ${FONT_STACK[o.font]}`;

const rgba = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** Sample telemetry used instead of the timeline's while drawing a look preview. */
let forced: { t: TelemetrySeries; mediaUs: number } | null = null;

/**
 * The clip a gauge reads its ride data from at timeline time T: the clip it is set to (on a track
 * above the main row: the moment of it at T, held at its ends), or else the main-row clip there.
 */
export function gaugeSource(tl: Timeline, T: number, o?: Pick<Overlay, 'sourceClipId'>): { clip: TimelineClip; mediaUs: number } | null {
  const id = o?.sourceClipId;
  let own = id ? tl.connected.find((c) => c.id === id) ?? null : null;
  // Past its ends: a piece of the same recording on that track (after a split) takes over.
  if (own && (T < own.startUs || T >= own.startUs + playLength(own))) {
    const o2 = own;
    own = tl.connected.find((c) => c.trackId === o2.trackId && c.mediaPath === o2.mediaPath && T >= c.startUs && T < c.startUs + playLength(c)) ?? own;
  }
  if (own) {
    const local = Math.max(0, Math.min(playLength(own) - 1, T - own.startUs));
    return { clip: own, mediaUs: Math.min(own.outUs - 1, mediaAt(own, local)) };
  }
  const at = locate(tl, T);
  return at ? { clip: at.clip, mediaUs: at.mediaUs } : null;
}

/** Telemetry of the clip a gauge reads at timeline time T. */
function telemetryAt(tl: Timeline, T: number, o?: Overlay): { t: TelemetrySeries; mediaUs: number; created?: Date } | null {
  if (forced) return { ...forced, created: new Date(2026, 5, 14, 16, 42, 0) };
  const at = gaugeSource(tl, T, o);
  const m = at && mediaNow(at.clip.mediaPath);
  return m ? { t: m.telemetry, mediaUs: at.mediaUs, created: m.info.created } : null;
}

export interface GaugeReading {
  value: string;
  unit: string;
  label: string;
  /** 0–1 for dials, bars and needles. */
  fraction: number;
  available: boolean;
  /** Scale end, in display units (for needle tick labels). */
  max: number;
  /** Display value as a number (for graphs). */
  num: number;
}

/** Converts a raw telemetry value into display units for a gauge. */
function toDisplay(o: Overlay, raw: number): number {
  const imp = o.units === 'imperial';
  switch (o.kind) {
    case 'speed': return raw * (imp ? 2.23694 : 3.6);
    case 'altitude': case 'jumpdist': return raw * (imp ? 3.28084 : 1);
    case 'distance': return raw / (imp ? 1609.344 : 1000);
    default: return raw;
  }
}

function rawAt(o: Overlay, tm: TelemetrySeries, t: number): number {
  switch (o.kind) {
    case 'speed': return tm.speedAt(t);
    case 'altitude': return tm.altitudeAt(t);
    case 'distance': return tm.distanceAt(t);
    case 'gforce': return tm.gforceAt(t);
    default: return NaN;
  }
}

const pad2 = (n: number) => String(Math.floor(n)).padStart(2, '0');

/** Extra calming (± µs) for needles and numbers; the sensors' own noise makes them shiver. */
const CALM = { speed: 250_000, gforce: 180_000 };

export function gaugeReading(o: Overlay, tl: Timeline, T: number): GaugeReading {
  const src = telemetryAt(tl, T, o);
  const imp = o.units === 'imperial';
  const tm = src?.t;
  const t = src?.mediaUs ?? 0;
  const label = o.text.trim();
  const blank = (unit: string, def: string, max = 1): GaugeReading => ({ value: '--', unit, label: label || def, fraction: 0, available: false, max, num: NaN });
  switch (o.kind) {
    case 'speed': {
      const max = Math.max(imp ? 20 : 30, Math.ceil(toDisplay(o, tm?.maxSpeed ?? 0) / 10) * 10);
      const f = (x: number) => tm!.speedAt(x);
      const v = tm ? toDisplay(o, smoothAt(f, t, CALM.speed)) : NaN;
      if (!Number.isFinite(v)) return blank(imp ? 'mph' : 'km/h', 'SPEED', max);
      const shown = toDisplay(o, smoothAt(f, textTime(t), CALM.speed));
      return { value: Math.round(shown).toString(), unit: imp ? 'mph' : 'km/h', label: label || 'SPEED', fraction: Math.min(1, v / max), available: true, max, num: v };
    }
    case 'altitude': {
      const v = tm ? toDisplay(o, tm.altitudeAt(t)) : NaN;
      if (!Number.isFinite(v)) return blank(imp ? 'ft' : 'm', 'ALTITUDE');
      const lo = toDisplay(o, tm!.minAltitude), hi = toDisplay(o, tm!.maxAltitude);
      return { value: Math.round(v).toLocaleString(), unit: imp ? 'ft' : 'm', label: label || 'ALTITUDE', fraction: hi > lo ? (v - lo) / (hi - lo) : 0.5, available: true, max: hi, num: v };
    }
    case 'distance': {
      const v = tm ? toDisplay(o, tm.distanceAt(t)) : NaN;
      if (!Number.isFinite(v)) return blank(imp ? 'mi' : 'km', 'DISTANCE');
      const total = toDisplay(o, tm!.totalDistance);
      return { value: v.toFixed(2), unit: imp ? 'mi' : 'km', label: label || 'DISTANCE', fraction: total > 0 ? v / total : 0, available: true, max: total, num: v };
    }
    case 'gforce': {
      const max = Math.max(2, Math.ceil(tm?.maxG ?? 0));
      const f = (x: number) => tm!.gforceAt(x);
      const v = tm ? smoothAt(f, t, CALM.gforce) : NaN;
      if (!Number.isFinite(v)) return blank('G', 'G-FORCE', max);
      return { value: smoothAt(f, textTime(t), CALM.gforce).toFixed(1), unit: 'G', label: label || 'G-FORCE', fraction: Math.min(1, v / max), available: true, max, num: v };
    }
    case 'airtime':
    case 'jumpdist': {
      const dist = o.kind === 'jumpdist';
      const at = forced ? null : gaugeSource(tl, T, o);
      // Jumps over the whole recording, so totals and bests are right however the clip is trimmed.
      const all = !tm ? [] : at ? tm.jumps(at.clip.airtime ?? {}) : tm.jumps();
      const unit = dist ? (imp ? 'ft' : 'm') : 's';
      if (!tm?.hasAccel || (dist && !tm.hasGps)) return blank(unit, dist ? 'JUMP' : 'AIRTIME');
      // What each jump is worth, in display units: its time in the air, or how far it went.
      const jumps = dist ? all.filter((j) => j.distanceM !== undefined) : all;
      const of = (j: (typeof all)[number]) => (dist ? toDisplay(o, j.distanceM!) : j.airMs / 1000);
      const best = jumps.reduce((a, j) => Math.max(a, of(j)), 0) || 1;
      const now = jumps.find((j) => t >= j.startUs && t < j.endUs);
      const done = jumps.filter((j) => j.endUs <= t);
      const last = done[done.length - 1];
      // In the air: counting up. Just landed: that jump, for 3 s. Otherwise as chosen.
      let v: number, lab = label || (dist ? 'JUMP' : 'AIRTIME');
      const sofar = done.reduce((a, j) => a + of(j), 0);
      const inAir = now ? of(now) * Math.min(1, (t - now.startUs) / (now.endUs - now.startUs)) : 0;
      if (o.airShow === 'running') {
        // Only the total: it grows through every jump and stays put on the ground.
        v = sofar + inAir; lab = label || (dist ? 'TOTAL JUMPED' : 'TOTAL AIR');
        const all = jumps.reduce((a, j) => a + of(j), 0) || 1;
        return { value: v.toFixed(dist ? 1 : 2), unit, label: lab, fraction: Math.min(1, v / all), available: true, max: all, num: v };
      }
      if (now) v = inAir;
      else if (last && t - last.endUs < 3e6) v = of(last);
      else if (o.airShow === 'total') { v = sofar; lab = label || (dist ? 'TOTAL JUMPED' : 'TOTAL AIR'); }
      else if (o.airShow === 'last') v = last ? of(last) : 0;
      else { v = done.reduce((a, j) => Math.max(a, of(j)), 0); lab = label || (dist ? 'LONGEST JUMP' : 'BEST AIR'); }
      return { value: v.toFixed(dist ? 1 : 2), unit, label: lab, fraction: Math.min(1, v / best), available: true, max: best, num: v };
    }
    case 'timer': {
      const s = Math.max(0, (T - o.startUs) / 1e6);
      return { value: `${pad2(s / 60)}:${pad2(s % 60)}.${Math.floor((s * 10) % 10)}`, unit: '', label: label || 'TIME', fraction: 0, available: true, max: 0, num: s };
    }
    case 'clock': {
      if (!src?.created || src.created.getTime() < 86_400_000 * 365) return blank('', 'TIME OF DAY');
      const d = new Date(src.created.getTime() + t / 1000);
      return { value: `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`, unit: '', label: label || 'TIME OF DAY', fraction: 0, available: true, max: 0, num: 0 };
    }
    default:
      return { value: '', unit: '', label: label || 'MAP', fraction: 0, available: !!tm?.hasGps, max: 0, num: NaN };
  }
}

function withShadow(ctx: Ctx2D, o: Overlay, px: number) {
  if (o.background === 'shadow') {
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = px * 0.12;
    ctx.shadowOffsetY = px * 0.03;
  } else if (o.background === 'glow') {
    ctx.shadowColor = o.color;
    ctx.shadowBlur = px * 0.45;
    ctx.shadowOffsetY = 0;
  } else {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }
}
const noShadow = (ctx: Ctx2D) => {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
};

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Panel behind a gauge, in the overlay's background colour/opacity (none for 'none'). */
function panel(ctx: Ctx2D, o: Overlay, x: number, y: number, w: number, h: number, r: number) {
  if (o.background === 'none' || o.bgOpacity <= 0) return;
  noShadow(ctx);
  ctx.fillStyle = rgba(o.bgColor, o.bgOpacity);
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
}

const isRound = (o: Overlay) => (o.kind === 'speed' || o.kind === 'gforce') && (o.style === 'dial' || o.style === 'needle');

/** Bounding box of an overlay in pixels (for hit-testing and selection outlines). */
export function overlayBox(o: Overlay, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const s = o.size * H;
  const d = o.kind !== 'text' && o.kind !== 'map' ? designBox(o) : null;
  if (d) return { x: o.x * W - (d.w * s) / 2, y: o.y * H - (d.h * s) / 2, w: d.w * s, h: d.h * s };
  if (o.kind === 'map' || isRound(o)) return { x: o.x * W - s / 2, y: o.y * H - s / 2, w: s, h: s };
  if (o.kind === 'text') {
    const lines = (o.text || ' ').split('\n');
    const est = Math.max(...lines.map((l) => l.length)) * s * (0.55 + o.tracking);
    const x0 = o.align === 'left' ? o.x * W : o.align === 'right' ? o.x * W - est : o.x * W - est / 2;
    return { x: x0 - s * 0.3, y: o.y * H - (lines.length * s * 1.2) / 2, w: est + s * 0.6, h: lines.length * s * 1.2 };
  }
  if (o.style === 'graph') return { x: o.x * W - s * 1.6, y: o.y * H - s * 0.6, w: s * 3.2, h: s * 1.2 };
  if (o.style === 'bar') return { x: o.x * W - s * 1.6, y: o.y * H - s * 0.45, w: s * 3.2, h: s * 0.9 };
  return { x: o.x * W - s * 1.1, y: o.y * H - s * 0.6, w: s * 2.2, h: s * 1.2 };
}

function drawText(ctx: Ctx2D, o: Overlay, W: number, H: number, reveal: number) {
  const px = o.size * H;
  const text = o.uppercase ? o.text.toUpperCase() : o.text;
  const lines = text.split('\n');
  let total = Math.round(text.length * reveal);
  const shown = lines.map((l) => {
    const part = l.slice(0, Math.max(0, total));
    total -= l.length + 1;
    return part;
  });
  ctx.font = font(o, px);
  (ctx as CanvasRenderingContext2D).letterSpacing = `${(o.tracking * px).toFixed(1)}px`;
  ctx.textAlign = o.align;
  ctx.textBaseline = 'middle';
  const lh = px * 1.2;
  const y0 = o.y * H - ((lines.length - 1) * lh) / 2;
  const x = o.x * W;
  if (o.background === 'box') {
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + px * 0.8;
    const bx = o.align === 'left' ? x - px * 0.4 : o.align === 'right' ? x - w + px * 0.4 : x - w / 2;
    ctx.fillStyle = rgba(o.bgColor, o.bgOpacity);
    roundRect(ctx, bx, y0 - lh / 2 - px * 0.1, w, lh * lines.length + px * 0.2, px * 0.25);
    ctx.fill();
  }
  if (o.outline > 0) {
    noShadow(ctx);
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = o.outline * px * 2;
    ctx.strokeStyle = o.outlineColor;
    shown.forEach((l, i) => ctx.strokeText(l, x, y0 + i * lh));
  }
  withShadow(ctx, o, px);
  ctx.fillStyle = o.color;
  shown.forEach((l, i) => ctx.fillText(l, x, y0 + i * lh));
  // A second pass makes neon brighter.
  if (o.background === 'glow') shown.forEach((l, i) => ctx.fillText(l, x, y0 + i * lh));
  (ctx as CanvasRenderingContext2D).letterSpacing = '0px';
}

function valueWithUnit(ctx: Ctx2D, o: Overlay, r: GaugeReading, x: number, y: number, vPx: number, uPx: number, align: 'left' | 'center') {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = font(o, vPx, 700);
  const vw = ctx.measureText(r.value).width;
  ctx.font = font(o, uPx, 600);
  const uw = r.unit ? ctx.measureText(r.unit).width + uPx * 0.3 : 0;
  const x0 = align === 'center' ? x - (vw + uw) / 2 : x;
  ctx.font = font(o, vPx, 700);
  ctx.fillText(r.value, x0, y);
  if (r.unit) {
    ctx.font = font(o, uPx, 600);
    ctx.fillText(r.unit, x0 + vw + uPx * 0.3, y);
  }
}

function drawDigital(ctx: Ctx2D, o: Overlay, r: GaugeReading, W: number, H: number) {
  const s = o.size * H;
  const cx = o.x * W, cy = o.y * H;
  if (o.background === 'box') panel(ctx, o, cx - s * 1.1, cy - s * 0.6, s * 2.2, s * 1.2, s * 0.18);
  withShadow(ctx, o, s);
  ctx.fillStyle = o.color;
  ctx.globalAlpha *= r.available ? 1 : 0.55;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  ctx.font = font(o, s * 0.24, 600);
  ctx.fillText(r.label.toUpperCase(), cx, cy - s * 0.28);
  valueWithUnit(ctx, o, r, cx, cy + s * 0.36, s * 0.62, s * 0.26, 'center');
}

function drawDial(ctx: Ctx2D, o: Overlay, r: GaugeReading, W: number, H: number) {
  const s = o.size * H;
  const cx = o.x * W, cy = o.y * H, rad = s * 0.46;
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  ctx.globalAlpha *= r.available ? 1 : 0.55;
  if (o.background !== 'none') {
    noShadow(ctx);
    ctx.fillStyle = rgba(o.bgColor, o.background === 'box' ? Math.max(o.bgOpacity, 0.5) : o.bgOpacity * 0.7);
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineCap = 'round';
  ctx.lineWidth = s * 0.07;
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath();
  ctx.arc(cx, cy, rad * 0.86, a0, a1);
  ctx.stroke();
  ctx.strokeStyle = o.accent;
  ctx.beginPath();
  ctx.arc(cx, cy, rad * 0.86, a0, a0 + (a1 - a0) * Math.max(0.001, r.fraction));
  ctx.stroke();
  withShadow(ctx, o, s);
  ctx.fillStyle = o.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = font(o, s * 0.3, 700);
  ctx.fillText(r.value, cx, cy - s * 0.02);
  ctx.font = font(o, s * 0.11, 600);
  ctx.fillText(r.unit, cx, cy + s * 0.2);
  ctx.fillText(r.label.toUpperCase(), cx, cy + s * 0.36);
}

/** Classic speedometer: ticks, numbers and a needle. */
function drawNeedle(ctx: Ctx2D, o: Overlay, r: GaugeReading, W: number, H: number) {
  const s = o.size * H;
  const cx = o.x * W, cy = o.y * H, R = s * 0.46;
  const a0 = Math.PI * 0.75, span = Math.PI * 1.5;
  ctx.globalAlpha *= r.available ? 1 : 0.55;
  if (o.background !== 'none') {
    noShadow(ctx);
    ctx.fillStyle = rgba(o.bgColor, Math.max(0.35, o.bgOpacity));
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // Ticks: 10 major, 4 minor between.
  const majors = 10;
  ctx.strokeStyle = o.color;
  ctx.fillStyle = o.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = font(o, s * 0.075, 600);
  for (let i = 0; i <= majors * 5; i++) {
    const a = a0 + (span * i) / (majors * 5);
    const major = i % 5 === 0;
    const r1 = R * (major ? 0.8 : 0.87), r2 = R * 0.95;
    ctx.lineWidth = major ? s * 0.016 : s * 0.007;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    ctx.stroke();
    if (major && i % 10 === 0) {
      const v = (r.max * i) / (majors * 5);
      ctx.fillText(Number.isInteger(v) ? String(v) : v.toFixed(1), cx + Math.cos(a) * R * 0.66, cy + Math.sin(a) * R * 0.66);
    }
  }
  // Red zone in the accent colour.
  ctx.strokeStyle = o.accent;
  ctx.lineWidth = s * 0.03;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.97, a0 + span * 0.8, a0 + span);
  ctx.stroke();
  // Needle.
  const a = a0 + span * Math.max(0, Math.min(1, r.fraction));
  withShadow(ctx, o, s);
  ctx.strokeStyle = o.accent;
  ctx.lineWidth = s * 0.025;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(a) * R * 0.12, cy - Math.sin(a) * R * 0.12);
  ctx.lineTo(cx + Math.cos(a) * R * 0.86, cy + Math.sin(a) * R * 0.86);
  ctx.stroke();
  noShadow(ctx);
  ctx.fillStyle = o.color;
  ctx.beginPath();
  ctx.arc(cx, cy, s * 0.04, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = font(o, s * 0.17, 700);
  ctx.fillText(r.value, cx, cy + R * 0.48);
  ctx.font = font(o, s * 0.07, 600);
  ctx.fillText(`${r.unit} ${r.label.toUpperCase()}`.trim(), cx, cy + R * 0.72);
}

/** Horizontal bar with label and value. */
function drawBar(ctx: Ctx2D, o: Overlay, r: GaugeReading, W: number, H: number) {
  const s = o.size * H;
  const w = s * 3.2, h = s * 0.9;
  const x0 = o.x * W - w / 2, y0 = o.y * H - h / 2;
  panel(ctx, o, x0, y0, w, h, s * 0.14);
  ctx.globalAlpha *= r.available ? 1 : 0.55;
  const pad = s * 0.18;
  withShadow(ctx, o, s);
  ctx.fillStyle = o.color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = font(o, s * 0.2, 600);
  ctx.fillText(r.label.toUpperCase(), x0 + pad, y0 + pad + s * 0.16);
  ctx.textAlign = 'right';
  ctx.font = font(o, s * 0.3, 700);
  ctx.fillText(`${r.value}${r.unit ? ` ${r.unit}` : ''}`, x0 + w - pad, y0 + pad + s * 0.22);
  noShadow(ctx);
  const by = y0 + h - pad - s * 0.16, bw = w - pad * 2, bh = s * 0.16;
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  roundRect(ctx, x0 + pad, by, bw, bh, bh / 2);
  ctx.fill();
  const g = ctx.createLinearGradient(x0 + pad, 0, x0 + pad + bw, 0);
  g.addColorStop(0, o.color);
  g.addColorStop(1, o.accent);
  ctx.fillStyle = g;
  roundRect(ctx, x0 + pad, by, Math.max(bh, bw * Math.max(0, Math.min(1, r.fraction))), bh, bh / 2);
  ctx.fill();
}

/** Line graph: the last 10 s (speed / G-force) or the whole file (altitude profile). */
function drawGraph(ctx: Ctx2D, o: Overlay, r: GaugeReading, tl: Timeline, T: number, W: number, H: number) {
  const s = o.size * H;
  const w = s * 3.2, h = s * 1.2;
  const x0 = o.x * W - w / 2, y0 = o.y * H - h / 2;
  panel(ctx, o, x0, y0, w, h, s * 0.14);
  const src = telemetryAt(tl, T, o);
  const tm = src?.t;
  const pad = s * 0.14;
  ctx.globalAlpha *= r.available ? 1 : 0.55;
  withShadow(ctx, o, s);
  ctx.fillStyle = o.color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = font(o, s * 0.17, 600);
  ctx.fillText(r.label.toUpperCase(), x0 + pad, y0 + pad + s * 0.12);
  ctx.textAlign = 'right';
  ctx.font = font(o, s * 0.26, 700);
  ctx.fillText(`${r.value}${r.unit ? ` ${r.unit}` : ''}`, x0 + w - pad, y0 + pad + s * 0.2);
  noShadow(ctx);
  if (!tm || !src || !r.available) return;
  const range = o.kind === 'gforce' ? tm.accelRange : tm.gpsRange;
  if (!range) return;
  const profile = o.kind === 'altitude';
  const gx = x0 + pad, gy = y0 + pad + s * 0.32, gw = w - pad * 2, gh = h - pad * 2 - s * 0.32;
  // About one point per 3 pixels. Scrolling graphs use a grid fixed in time so the line slides
  // without wobbling; the profile is the whole file and doesn't move.
  const N = Math.max(40, Math.min(240, Math.round(gw / 3)));
  const f = (x: number) => toDisplay(o, rawAt(o, tm, x));
  const SPAN = 10_000_000;
  const pts = profile
    ? Array.from({ length: N + 1 }, (_, i) => ({ x: i / N, v: f(range[0] + ((range[1] - range[0]) * i) / N) })).filter((p) => Number.isFinite(p.v))
    : scrollingGraph(f, src.mediaUs, SPAN, N, range[0]);
  if (pts.length < 2) return;
  let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
  if (o.kind === 'speed' || o.kind === 'gforce') { lo = 0; hi = Math.max(hi, r.max); }
  if (hi - lo < 1e-6) hi = lo + 1;
  const P = (x: number, v: number) => [gx + gw * x, gy + gh - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * gh] as const;
  const g = ctx.createLinearGradient(0, gy, 0, gy + gh);
  g.addColorStop(0, rgba(o.accent, 0.55));
  g.addColorStop(1, rgba(o.accent, 0));
  // Clipped to the graph area: points slide in from the left edge.
  ctx.save();
  ctx.beginPath();
  ctx.rect(gx, gy - gh, gw, gh * 2);
  ctx.clip();
  const first = pts[0]!, last = pts[pts.length - 1]!;
  ctx.beginPath();
  ctx.moveTo(P(first.x, lo)[0], gy + gh);
  pts.forEach((p) => ctx.lineTo(...P(p.x, p.v)));
  ctx.lineTo(P(last.x, lo)[0], gy + gh);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(...P(p.x, p.v)) : ctx.moveTo(...P(p.x, p.v))));
  ctx.strokeStyle = o.accent;
  ctx.lineWidth = Math.max(1.5, s * 0.025);
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
  // Where we are: the right edge for scrolling graphs, a marker on the profile.
  const [mx, my] = profile ? P((src.mediaUs - range[0]) / Math.max(1, range[1] - range[0]), f(src.mediaUs)) : P(1, last.v);
  ctx.fillStyle = o.color;
  ctx.beginPath();
  ctx.arc(mx, my, Math.max(2.5, s * 0.045), 0, Math.PI * 2);
  ctx.fill();
}

function drawMap(ctx: Ctx2D, o: Overlay, tl: Timeline, T: number, W: number, H: number) {
  const s = o.size * H;
  const x0 = o.x * W - s / 2, y0 = o.y * H - s / 2;
  const round = o.style === 'round';
  ctx.save();
  ctx.beginPath();
  if (round) ctx.arc(o.x * W, o.y * H, s / 2, 0, Math.PI * 2);
  else ctx.roundRect(x0, y0, s, s, s * 0.08);
  if (o.background !== 'none') {
    ctx.fillStyle = rgba(o.bgColor, o.bgOpacity);
    ctx.fill();
  }
  ctx.clip();
  const src = telemetryAt(tl, T, o);
  const tm = src?.t;
  if (!tm?.hasGps || tm.track.length < 2) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = font(o, s * 0.08, 600);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No GPS', o.x * W, o.y * H);
    ctx.restore();
    return;
  }
  const pad = s * (round ? 0.2 : 0.1), inner = s - pad * 2;
  const P = (p: { x: number; y: number }) => [x0 + pad + p.x * inner, y0 + pad + p.y * inner] as const;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.5, s * 0.018);
  ctx.strokeStyle = rgba(o.color, 0.35);
  ctx.beginPath();
  tm.track.forEach((p, i) => (i ? ctx.lineTo(...P(p)) : ctx.moveTo(...P(p))));
  ctx.stroke();
  const reached = tm.trackIndexAt(src!.mediaUs);
  ctx.strokeStyle = o.accent;
  ctx.lineWidth = Math.max(2, s * 0.028);
  ctx.beginPath();
  tm.track.slice(0, reached + 1).forEach((p, i) => (i ? ctx.lineTo(...P(p)) : ctx.moveTo(...P(p))));
  const pos = tm.positionAt(src!.mediaUs);
  if (pos) ctx.lineTo(...P(pos));
  ctx.stroke();
  if (pos) {
    ctx.fillStyle = o.color;
    ctx.strokeStyle = o.accent;
    ctx.lineWidth = Math.max(1.5, s * 0.016);
    ctx.beginPath();
    ctx.arc(...P(pos), Math.max(3, s * 0.04), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** One gauge, in its design. */
function drawGauge(ctx: Ctx2D, o: Overlay, tl: Timeline, T: number, W: number, H: number) {
  const r = o.kind === 'map' ? null : gaugeReading(o, tl, T);
  const plain = (oo: Overlay) => {
    if (oo.kind === 'map') drawMap(ctx, oo, tl, T, W, H);
    else if (drawDesigned({ ctx, o: oo, r: r!, W, H, around: (dt) => gaugeReading(oo, tl, T + dt).num })) return;
    else if (isRound(oo) && oo.style === 'needle') drawNeedle(ctx, oo, r!, W, H);
    else if (isRound(oo)) drawDial(ctx, oo, r!, W, H);
    else if (oo.style === 'bar') drawBar(ctx, oo, r!, W, H);
    else if (oo.style === 'graph') drawGraph(ctx, oo, r!, tl, T, W, H);
    else drawDigital(ctx, oo, r!, W, H);
  };
  if (o.design === 'carbon') {
    // The carbon panel, then the gauge on it without its own background.
    const b = overlayBox(o, W, H), round = (o.kind === 'map' && o.style === 'round') || isRound(o);
    const pad = round ? 0 : o.size * H * 0.04;
    carbonPanel(ctx, o, b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2, round);
    plain({ ...o, background: o.kind === 'map' ? 'none' : 'shadow', bgOpacity: 0 });
  } else if (o.design === 'neon') {
    // A blurred copy underneath makes the lines and numbers glow.
    ctx.save();
    ctx.filter = `blur(${Math.max(1, o.size * H * 0.05).toFixed(1)}px)`;
    ctx.globalAlpha *= 0.9;
    plain({ ...o, background: 'none', bgOpacity: 0 });
    ctx.restore();
    plain(o);
  } else plain(o);
}

let sample: TelemetrySeries | null = null;
/** A made-up ride (a loop with a jump at 5 s) for previews of gauge looks. */
function sampleRide(): TelemetrySeries {
  if (sample) return sample;
  const gps = Array.from({ length: 121 }, (_, i) => {
    const a = (i / 120) * Math.PI * 2;
    return { t: i * 100_000, lat: 46.2 + 0.0004 * Math.sin(a), lon: 7.3 + 0.0006 * Math.cos(a) * (1 + 0.3 * Math.sin(a * 3)), alt: 520 + 8 * Math.sin(a * 2), speed: 9 + 3 * Math.sin(a * 2.2), fix: 3 };
  });
  const accl = Array.from({ length: 600 }, (_, i) => {
    const t = i * 20_000, air = t >= 5e6 && t < 5.84e6, land = t >= 5.84e6 && t < 6e6;
    const g = air ? 0.08 : land ? 3.4 : 1 + 0.5 * Math.sin(i / 9) + 0.2 * Math.sin(i / 2.3);
    return { t, v: [0, 0, g * 9.80665] as [number, number, number] };
  });
  return (sample = new TelemetrySeries(gps, accl));
}
const PREVIEW_TL = { clips: [], overlays: [], audio: [] } as unknown as Timeline;
/** Draws a gauge with sample readings (look pickers, the tour). */
export function drawGaugePreview(ctx: Ctx2D, o: Overlay, W: number, H: number) {
  forced = { t: sampleRide(), mediaUs: 7.2e6 };
  try { ctx.save(); drawGauge(ctx, o, PREVIEW_TL, 83.4e6, W, H); ctx.restore(); } finally { forced = null; }
}

/** Draws every overlay visible at timeline time T. */
export function drawOverlays(ctx: Ctx2D, W: number, H: number, tl: Timeline, T: number, selectedId?: string | null) {
  for (const o of tl.overlays) {
    const st = overlayState(o, T);
    if (!st) continue;
    ctx.save();
    ctx.globalAlpha = st.alpha;
    const cx = o.x * W, cy = o.y * H;
    ctx.translate(cx, cy + st.dy * H);
    ctx.scale(st.scale, st.scale);
    ctx.translate(-cx, -cy);
    if (o.kind === 'text') drawText(ctx, o, W, H, st.reveal);
    else drawGauge(ctx, o, tl, T, W, H);
    ctx.restore();
    if (o.id === selectedId) {
      const b = overlayBox(o, W, H);
      ctx.save();
      ctx.strokeStyle = '#3d8bfd';
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.restore();
    }
  }
}

/** Topmost overlay under a point (pixels), for click-to-select on the preview. */
export function hitOverlay(tl: Timeline, T: number, W: number, H: number, px: number, py: number): Overlay | null {
  for (let i = tl.overlays.length - 1; i >= 0; i--) {
    const o = tl.overlays[i]!;
    if (!overlayState(o, T)) continue;
    const b = overlayBox(o, W, H);
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return o;
  }
  return null;
}

/** Transition movement of a whole main-row layer (about the frame's centre). */
function withTransition(ctx: Ctx2D, W: number, H: number, x: LayerXf, draw: () => void) {
  if (x.alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= x.alpha;
  if (x.blur > 0.0005) ctx.filter = `blur(${(x.blur * W).toFixed(1)}px)`;
  ctx.translate(W / 2 + x.dx * W, H / 2 + x.dy * H);
  if (x.rotate) ctx.rotate((x.rotate * Math.PI) / 180);
  if (x.scale !== 1) ctx.scale(x.scale, x.scale);
  ctx.translate(-W / 2, -H / 2);
  draw();
  ctx.restore();
}

/** Pixel sizes of a placed layer's frame: corner radius, border and shadow (shared with the preview). */
export function placedStyle(xf: Transform, W: number, H: number) {
  const r = shownRect(xf);
  const w = r.w * W, h = r.h * H;
  const s = xf.shadow;
  return {
    rect: { x: r.x * W, y: r.y * H, w, h },
    radius: xf.radius * Math.min(w, h),
    border: xf.border * H,
    shadow: s > 0.001 ? { blur: 0.05 * H * s, dy: 0.015 * H * s, alpha: Math.min(0.85, 0.65 * s) } : null,
  };
}

/** Adds a rectangle (rounded when r > 0) to the current path. */
function rectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
  if (r > 0.01) ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  else ctx.rect(x, y, w, h);
}

/** Draws one clip's picture (the size of the frame) where its transform puts it. */
export function drawPlaced(ctx: Ctx2D, W: number, H: number, src: CanvasImageSource & { width: number; height: number }, xf: Transform | undefined) {
  if (isIdentityXf(xf)) { ctx.drawImage(src, 0, 0, W, H); return; }
  const x = xf!;
  if (x.opacity <= 0.001) return;
  const st = placedStyle(x, W, H);
  const { w, h } = st.rect;
  if (w < 0.5 || h < 0.5) return;
  ctx.save();
  ctx.globalAlpha *= x.opacity;
  ctx.translate(st.rect.x + w / 2, st.rect.y + h / 2);
  if (x.rotate) ctx.rotate((x.rotate * Math.PI) / 180);
  const b = st.border, outerR = st.radius > 0.01 ? st.radius + b : 0;
  if (st.shadow) {
    // Only outside the picture (as a CSS box shadow): a see-through picture shows no shadow under it.
    ctx.save();
    ctx.beginPath();
    ctx.rect(-W * 4, -H * 4, W * 8, H * 8);
    rectPath(ctx, -w / 2 - b, -h / 2 - b, w + 2 * b, h + 2 * b, outerR);
    ctx.clip('evenodd');
    ctx.shadowColor = `rgba(0,0,0,${st.shadow.alpha})`;
    ctx.shadowBlur = st.shadow.blur;
    ctx.shadowOffsetY = st.shadow.dy;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    rectPath(ctx, -w / 2 - b, -h / 2 - b, w + 2 * b, h + 2 * b, outerR);
    ctx.fill();
    ctx.restore();
  }
  if (b > 0.01) {
    ctx.save();
    ctx.beginPath();
    rectPath(ctx, -w / 2 - b, -h / 2 - b, w + 2 * b, h + 2 * b, outerR);
    rectPath(ctx, -w / 2, -h / 2, w, h, st.radius);
    ctx.fillStyle = x.borderColor;
    ctx.fill('evenodd');
    ctx.restore();
  }
  if (st.radius > 0.01) {
    ctx.beginPath();
    rectPath(ctx, -w / 2, -h / 2, w, h, st.radius);
    ctx.clip();
  }
  const [l, t, r, bt] = x.crop, sw = src.width, sh = src.height;
  ctx.drawImage(src, l * sw, t * sh, Math.max(1, (1 - l - r) * sw), Math.max(1, (1 - t - bt) * sh), -w / 2, -h / 2, w, h);
  ctx.restore();
}

function clipReveal(ctx: Ctx2D, W: number, H: number, r: Reveal) {
  ctx.beginPath();
  if (r.kind === 'rect') ctx.rect(r.r[0] * W, r.r[1] * H, (r.r[2] - r.r[0]) * W, (r.r[3] - r.r[1]) * H);
  else if (r.kind === 'circle') ctx.arc(W / 2, H / 2, (r.r * Math.hypot(W, H)) / 2, 0, Math.PI * 2);
  else r.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
  ctx.clip();
}

/** One picture to composite: a clip's rendered frame (the size of the output) and where it goes. */
export interface CompLayer {
  src: CanvasImageSource & { width: number; height: number };
  xf?: Transform;
  /** Main row during a transition. */
  role?: 'out' | 'in';
  /** 0 = main row. */
  track: number;
}

/**
 * Composites what is on screen, bottom first: the main row (a transition from `out` to `in`, with
 * its colour dip), then the clips on the tracks above, each where its transform puts it.
 */
export function compositeLayers(ctx: Ctx2D, W: number, H: number, layers: CompLayer[], look: TransitionLook | null) {
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  let dipped = false;
  const dip = () => {
    if (dipped) return;
    dipped = true;
    if (look?.dip && look.dipAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = look.dipAlpha;
      ctx.fillStyle = look.dip;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  };
  for (const l of layers) {
    if (l.track > 0) dip();
    if (!look || !l.role) { drawPlaced(ctx, W, H, l.src, l.xf); continue; }
    if (l.role === 'out') { withTransition(ctx, W, H, look.a, () => drawPlaced(ctx, W, H, l.src, l.xf)); continue; }
    ctx.save();
    if (look.reveal) clipReveal(ctx, W, H, look.reveal);
    withTransition(ctx, W, H, look.b, () => drawPlaced(ctx, W, H, l.src, l.xf));
    ctx.restore();
  }
  dip();
  ctx.restore();
}

/** CSS for one video layer of the preview during a transition. */
export function layerCss(x: LayerXf, widthPx: number, reveal: Reveal | null): Partial<CSSStyleDeclaration> {
  const transform = [
    x.dx || x.dy ? `translate(${x.dx * 100}%, ${x.dy * 100}%)` : '',
    x.rotate ? `rotate(${x.rotate}deg)` : '',
    x.scale !== 1 ? `scale(${x.scale})` : '',
  ].join(' ').trim();
  let clipPath = '';
  if (reveal?.kind === 'rect') {
    const [x0, y0, x1, y1] = reveal.r;
    clipPath = `inset(${y0 * 100}% ${(1 - x1) * 100}% ${(1 - y1) * 100}% ${x0 * 100}%)`;
  } else if (reveal?.kind === 'circle') {
    // circle() percentages are of the diagonal / √2; the half-diagonal is that / √2.
    clipPath = `circle(${reveal.r * 70.7107}% at 50% 50%)`;
  } else if (reveal?.kind === 'polygon') {
    clipPath = `polygon(${reveal.pts.map(([px, py]) => `${px * 100}% ${py * 100}%`).join(', ')})`;
  }
  return {
    opacity: String(x.alpha),
    transform,
    filter: x.blur > 0.0005 ? `blur(${(x.blur * widthPx).toFixed(1)}px)` : '',
    clipPath,
  };
}

/**
 * CSS that places a clip in the preview as `drawPlaced` does in export: the box (the shown part of
 * the picture, with corners, border and shadow) and the canvas inside it (the whole picture,
 * shifted so the crop lines up). `W`, `H`: the preview frame's size in CSS pixels.
 */
export function placedCss(xf: Transform | undefined, W: number, H: number): { box: Partial<CSSStyleDeclaration>; canvas: Partial<CSSStyleDeclaration> } {
  if (isIdentityXf(xf)) {
    return {
      box: { left: '0', top: '0', width: '100%', height: '100%', transform: '', opacity: '', borderRadius: '', overflow: '', boxShadow: '', visibility: '' },
      canvas: { left: '0', top: '0', width: '100%', height: '100%' },
    };
  }
  const x = xf!, st = placedStyle(x, W, H), r = shownRect(x);
  const shadows: string[] = [];
  if (st.border > 0.01) shadows.push(`0 0 0 ${st.border.toFixed(2)}px ${x.borderColor}`);
  if (st.shadow) shadows.push(`0 ${st.shadow.dy.toFixed(2)}px ${st.shadow.blur.toFixed(2)}px ${st.border.toFixed(2)}px rgba(0,0,0,${st.shadow.alpha})`);
  const pct = (v: number) => `${(v * 100).toFixed(4)}%`;
  const [l, t] = x.crop;
  return {
    box: {
      left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h),
      transform: x.rotate ? `rotate(${x.rotate}deg)` : '',
      opacity: x.opacity < 1 ? String(x.opacity) : '',
      borderRadius: st.radius > 0.01 ? `${Math.min(st.radius, st.rect.w / 2, st.rect.h / 2).toFixed(2)}px` : '',
      overflow: 'hidden',
      boxShadow: shadows.join(', '),
      visibility: r.w <= 0 || r.h <= 0 || x.opacity <= 0.001 ? 'hidden' : '',
    },
    canvas: {
      left: pct(r.w > 0 ? (-l * x.scale) / r.w : 0), top: pct(r.h > 0 ? (-t * x.scale) / r.h : 0),
      width: pct(r.w > 0 ? x.scale / r.w : 1), height: pct(r.h > 0 ? x.scale / r.h : 1),
    },
  };
}

export { transitionLook };
