// Draws text and telemetry overlays, and composites transitions, onto a 2D canvas.
// Shared by the preview overlay layer, export and frame grabs so they always match.

import {
  locate, overlayState, transitionLook,
  type LayerXf, type Overlay, type OverlayFont, type Reveal, type Timeline, type TransitionLook,
} from '@ace/project';
import type { TelemetrySeries } from '@ace/telemetry';
import { mediaNow } from './media';

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

const font = (o: Overlay, px: number, weight?: number) =>
  `${o.italic ? 'italic ' : ''}${weight ?? (o.bold ? (o.font === 'heavy' ? 900 : 700) : 400)} ${Math.max(1, px)}px ${FONT_STACK[o.font]}`;

const rgba = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** Telemetry of whatever clip is on screen at timeline time T. */
function telemetryAt(tl: Timeline, T: number): { t: TelemetrySeries; mediaUs: number; created?: Date } | null {
  const at = locate(tl, T);
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
    case 'altitude': return raw * (imp ? 3.28084 : 1);
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

export function gaugeReading(o: Overlay, tl: Timeline, T: number): GaugeReading {
  const src = telemetryAt(tl, T);
  const imp = o.units === 'imperial';
  const tm = src?.t;
  const t = src?.mediaUs ?? 0;
  const label = o.text.trim();
  const blank = (unit: string, def: string, max = 1): GaugeReading => ({ value: '--', unit, label: label || def, fraction: 0, available: false, max, num: NaN });
  switch (o.kind) {
    case 'speed': {
      const max = Math.max(imp ? 20 : 30, Math.ceil(toDisplay(o, tm?.maxSpeed ?? 0) / 10) * 10);
      const v = tm ? toDisplay(o, tm.speedAt(t)) : NaN;
      if (!Number.isFinite(v)) return blank(imp ? 'mph' : 'km/h', 'SPEED', max);
      return { value: Math.round(v).toString(), unit: imp ? 'mph' : 'km/h', label: label || 'SPEED', fraction: Math.min(1, v / max), available: true, max, num: v };
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
      const v = tm?.gforceAt(t) ?? NaN;
      if (!Number.isFinite(v)) return blank('G', 'G-FORCE', max);
      return { value: v.toFixed(1), unit: 'G', label: label || 'G-FORCE', fraction: Math.min(1, v / max), available: true, max, num: v };
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
  const src = telemetryAt(tl, T);
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
  const t1 = profile ? range[1] : src.mediaUs;
  const t0 = profile ? range[0] : Math.max(range[0], t1 - 10_000_000);
  const N = 120;
  const vals: number[] = [];
  for (let i = 0; i <= N; i++) vals.push(toDisplay(o, rawAt(o, tm, t0 + ((t1 - t0) * i) / N)));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (o.kind === 'speed' || o.kind === 'gforce') { lo = 0; hi = Math.max(hi, r.max); }
  if (hi - lo < 1e-6) hi = lo + 1;
  const gx = x0 + pad, gy = y0 + pad + s * 0.32, gw = w - pad * 2, gh = h - pad * 2 - s * 0.32;
  const P = (i: number, v: number) => [gx + (gw * i) / N, gy + gh - ((v - lo) / (hi - lo)) * gh] as const;
  const g = ctx.createLinearGradient(0, gy, 0, gy + gh);
  g.addColorStop(0, rgba(o.accent, 0.55));
  g.addColorStop(1, rgba(o.accent, 0));
  ctx.beginPath();
  ctx.moveTo(gx, gy + gh);
  vals.forEach((v, i) => ctx.lineTo(...P(i, v)));
  ctx.lineTo(gx + gw, gy + gh);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  vals.forEach((v, i) => (i ? ctx.lineTo(...P(i, v)) : ctx.moveTo(...P(i, v))));
  ctx.strokeStyle = o.accent;
  ctx.lineWidth = Math.max(1.5, s * 0.025);
  ctx.lineJoin = 'round';
  ctx.stroke();
  // Where we are: the right edge for scrolling graphs, a marker on the profile.
  const fi = profile ? ((src.mediaUs - t0) / (t1 - t0)) * N : N;
  const [mx, my] = P(fi, toDisplay(o, rawAt(o, tm, profile ? src.mediaUs : t1)));
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
  const src = telemetryAt(tl, T);
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
    else if (o.kind === 'map') drawMap(ctx, o, tl, T, W, H);
    else {
      const r = gaugeReading(o, tl, T);
      if (isRound(o) && o.style === 'needle') drawNeedle(ctx, o, r, W, H);
      else if (isRound(o)) drawDial(ctx, o, r, W, H);
      else if (o.style === 'bar') drawBar(ctx, o, r, W, H);
      else if (o.style === 'graph') drawGraph(ctx, o, r, tl, T, W, H);
      else drawDigital(ctx, o, r, W, H);
    }
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

function drawLayer(ctx: Ctx2D, W: number, H: number, src: CanvasImageSource, x: LayerXf) {
  if (x.alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = x.alpha;
  if (x.blur > 0.0005) ctx.filter = `blur(${(x.blur * W).toFixed(1)}px)`;
  ctx.translate(W / 2 + x.dx * W, H / 2 + x.dy * H);
  if (x.rotate) ctx.rotate((x.rotate * Math.PI) / 180);
  if (x.scale !== 1) ctx.scale(x.scale, x.scale);
  ctx.drawImage(src, -W / 2, -H / 2, W, H);
  ctx.restore();
}

function clipReveal(ctx: Ctx2D, W: number, H: number, r: Reveal) {
  ctx.beginPath();
  if (r.kind === 'rect') ctx.rect(r.r[0] * W, r.r[1] * H, (r.r[2] - r.r[0]) * W, (r.r[3] - r.r[1]) * H);
  else if (r.kind === 'circle') ctx.arc(W / 2, H / 2, (r.r * Math.hypot(W, H)) / 2, 0, Math.PI * 2);
  else r.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
  ctx.clip();
}

/**
 * Composites one or two rendered clips into ctx: `a` alone, or a transition from a to b.
 * Sources are the per-clip renderer canvases (same size as the output).
 */
export function compositeLayers(ctx: Ctx2D, W: number, H: number, a: CanvasImageSource, b: CanvasImageSource | null, look: TransitionLook | null) {
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!b || !look) {
    ctx.drawImage(a, 0, 0, W, H);
    ctx.restore();
    return;
  }
  drawLayer(ctx, W, H, a, look.a);
  ctx.save();
  if (look.reveal) clipReveal(ctx, W, H, look.reveal);
  drawLayer(ctx, W, H, b, look.b);
  ctx.restore();
  if (look.dip && look.dipAlpha > 0) {
    ctx.globalAlpha = look.dipAlpha;
    ctx.fillStyle = look.dip;
    ctx.fillRect(0, 0, W, H);
  }
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

export { transitionLook };
