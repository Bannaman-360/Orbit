// The gauge designs that have their own shapes (see GAUGE_DESIGNS in @ace/project). The others
// (classic, minimal, neon, carbon) reuse the standard drawings in overlayRender.ts with their
// own colours, a panel (carbon) or a glow pass (neon).
//
// Parts that never change while playing (dial faces, ticks, panels) are drawn once into a small
// bitmap and reused, so a frame costs no more than the plain gauges.

import type { GaugeKind, Overlay, OverlayFont } from '@ace/project';
import type { GaugeReading } from './overlayRender';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Fonts = Record<OverlayFont, string>;

let STACK: Fonts;
export const setFontStack = (f: Fonts) => { STACK = f; };
const font = (o: Overlay, px: number, weight?: number, italic = o.italic) => `${italic ? 'italic ' : ''}${weight ?? (o.bold ? 700 : 400)} ${Math.max(1, px)}px ${STACK[o.font]}`;
export const rgba = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const dim = (ctx: Ctx2D, r: GaugeReading) => { ctx.globalAlpha *= r.available ? 1 : 0.55; };
const shadow = (ctx: Ctx2D, blur: number, color = 'rgba(0,0,0,0.6)', dy = blur * 0.25) => { ctx.shadowColor = color; ctx.shadowBlur = blur; ctx.shadowOffsetY = dy; };
const noShadow = (ctx: Ctx2D) => { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; };

// --- Cached static parts -----------------------------------------------------------------------

const cache = new Map<string, OffscreenCanvas>();
/** A part drawn once (per key) at w×h px and reused. */
function still(key: string, w: number, h: number, draw: (c: OffscreenCanvasRenderingContext2D) => void): OffscreenCanvas {
  const k = `${key}|${Math.round(w)}x${Math.round(h)}`;
  let c = cache.get(k);
  if (!c) {
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    c = new OffscreenCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
    draw(c.getContext('2d')!);
    cache.set(k, c);
  }
  return c;
}

/** Carbon-fibre weave (a repeating tile), for the Carbon design's panels. */
function carbonFill(ctx: Ctx2D, s: number) {
  const t = Math.max(4, Math.round(s * 0.06));
  const tile = still(`carbon`, t * 2, t * 2, (c) => {
    c.fillStyle = '#15171a'; c.fillRect(0, 0, t * 2, t * 2);
    const g = (x: number, y: number, horiz: boolean) => {
      const gr = horiz ? c.createLinearGradient(0, y, 0, y + t) : c.createLinearGradient(x, 0, x + t, 0);
      gr.addColorStop(0, '#1c1f23'); gr.addColorStop(0.5, '#2c3036'); gr.addColorStop(1, '#16181b');
      c.fillStyle = gr; c.fillRect(x, y, t, t);
    };
    g(0, 0, true); g(t, t, true); g(t, 0, false); g(0, t, false);
  });
  return ctx.createPattern(tile, 'repeat')!;
}

/** Carbon panel: weave, a fine metal edge and a soft top light. */
export function carbonPanel(ctx: Ctx2D, o: Overlay, x: number, y: number, w: number, h: number, round: boolean) {
  const s = o.size * (ctx.canvas.height || 1);
  ctx.save();
  shadow(ctx, s * 0.08);
  ctx.beginPath();
  if (round) ctx.arc(x + w / 2, y + h / 2, w / 2, 0, Math.PI * 2); else ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.16);
  ctx.globalAlpha *= o.bgOpacity;
  ctx.fillStyle = carbonFill(ctx, Math.min(w, h) * 3);
  ctx.fill();
  noShadow(ctx);
  ctx.clip();
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, 'rgba(255,255,255,0.16)'); g.addColorStop(0.45, 'rgba(255,255,255,0.02)'); g.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = g; ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  if (round) ctx.arc(x + w / 2, y + h / 2, w / 2 - 1, 0, Math.PI * 2); else ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, Math.min(w, h) * 0.16);
  const e = ctx.createLinearGradient(x, y, x + w, y + h);
  e.addColorStop(0, '#9aa0a6'); e.addColorStop(0.5, '#3a3d42'); e.addColorStop(1, '#b8bec4');
  ctx.strokeStyle = e; ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.025); ctx.stroke();
  ctx.restore();
}

// --- Icons ---------------------------------------------------------------------------------------

/** Small line icons for each gauge (24-unit paths), used by Badge and Sport. */
const ICON: Partial<Record<GaugeKind, string>> = {
  speed: 'M4 16a8 8 0 1 1 16 0M12 16l4-5M8 16h0M16 16h0',
  gforce: 'M7 6h6M7 6v12h6v-6h-3M17 6v12',
  altitude: 'M3 19l6-10 4 6 3-4 5 8z',
  distance: 'M5 19c0-6 14-8 14-14M5 19a2 2 0 1 0 0 .1M19 5a2 2 0 1 0 0 .1',
  airtime: 'M3 19h5M16 19h5M6 19c2-8 10-8 12 0M12 4v5M9.500 6.500 12 9l2.500-2.500',
  jumpdist: 'M3 18c3-9 15-9 18 0M3 21h18M3 19.500v3M21 19.500v3',
  timer: 'M12 8v5l3 2M9 3h6M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
};
function icon(ctx: Ctx2D, kind: GaugeKind, x: number, y: number, size: number, color: string) {
  const d = ICON[kind];
  if (!d) return;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D(d));
  ctx.restore();
}

// --- Seven-segment digits (Retro LCD) ---------------------------------------------------------------

const SEG: Record<string, string> = { '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '' };
function segDigit(ctx: Ctx2D, ch: string, x: number, y: number, w: number, h: number, on: string, off: string) {
  const t = w * 0.2, half = h / 2, sk = w * 0.12;
  const bars: Record<string, [number, number, number, number]> = {
    a: [x + t * 0.6, y, w - t * 1.2, t], g: [x + t * 0.6, y + half - t / 2, w - t * 1.2, t], d: [x + t * 0.6, y + h - t, w - t * 1.2, t],
    f: [x, y + t * 0.6, t, half - t * 0.9], b: [x + w - t, y + t * 0.6, t, half - t * 0.9],
    e: [x, y + half + t * 0.3, t, half - t * 0.9], c: [x + w - t, y + half + t * 0.3, t, half - t * 0.9],
  };
  const lit = SEG[ch] ?? '';
  for (const [k, [bx, by, bw, bh]] of Object.entries(bars)) {
    ctx.fillStyle = lit.includes(k) ? on : off;
    // Slanted like a real display.
    const s0 = sk * (1 - (by - y) / h), s1 = sk * (1 - (by + bh - y) / h);
    ctx.beginPath();
    ctx.moveTo(bx + s0, by); ctx.lineTo(bx + bw + s0, by); ctx.lineTo(bx + bw + s1, by + bh); ctx.lineTo(bx + s1, by + bh);
    ctx.fill();
  }
}

// --- The designs -------------------------------------------------------------------------------------

/** Footprint of a design's gauge, in multiples of its size (for hit-testing and placing). */
export function designBox(o: Overlay): { w: number; h: number } | null {
  switch (o.design) {
    case 'lcd': return { w: 2.6, h: 1.1 };
    case 'sport': return o.style === 'bar' ? { w: 3.4, h: 0.9 } : { w: 2.6, h: 1 };
    case 'tape': return { w: 3.2, h: 1 };
    case 'badge': return { w: 2.7, h: 0.8 };
    case 'arc': case 'ring': case 'moto': case 'cockpit': return { w: 1, h: 1 };
    default: return null;
  }
}

export interface DesignInput { ctx: Ctx2D; o: Overlay; r: GaugeReading; W: number; H: number; /** Readings a little before and after (Tape). */ around?: (dt: number) => number }

/** Draws gauges whose design has its own shape. False = use the standard drawing. */
export function drawDesigned(p: DesignInput): boolean {
  switch (p.o.design) {
    case 'lcd': lcd(p); return true;
    case 'sport': if (p.o.style === 'bar') sportBar(p); else sport(p); return true;
    case 'tape': tape(p); return true;
    case 'badge': badge(p); return true;
    case 'arc': arc(p); return true;
    case 'ring': ring(p); return true;
    case 'moto': moto(p); return true;
    case 'cockpit': cockpit(p); return true;
    default: return false;
  }
}

function lcd({ ctx, o, r, W, H }: DesignInput) {
  const s = o.size * H, w = s * 2.6, h = s * 1.1, x0 = o.x * W - w / 2, y0 = o.y * H - h / 2;
  dim(ctx, r);
  const face = still(`lcd|${o.bgColor}|${o.bgOpacity}`, w, h, (c) => {
    c.fillStyle = '#2b2b2b';
    c.beginPath(); c.roundRect(0, 0, w, h, s * 0.12); c.fill();
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, rgba(o.bgColor, o.bgOpacity)); g.addColorStop(1, rgba(o.bgColor, o.bgOpacity * 0.82));
    c.fillStyle = g;
    c.beginPath(); c.roundRect(s * 0.08, s * 0.08, w - s * 0.16, h - s * 0.16, s * 0.06); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.18)'; c.fillRect(s * 0.1, s * 0.1, w - s * 0.2, s * 0.03);
  });
  ctx.drawImage(face, x0, y0);
  ctx.fillStyle = o.color;
  ctx.font = font(o, s * 0.15, 700, false);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(r.label.toUpperCase(), x0 + s * 0.2, y0 + s * 0.3);
  ctx.textAlign = 'right';
  ctx.fillText(r.unit.toUpperCase(), x0 + w - s * 0.2, y0 + h - s * 0.18);
  // Right-aligned digits, with the unlit segments faintly showing.
  const text = r.value.replace(/,/g, '');
  const dw = s * 0.34, dh = s * 0.58, gap = s * 0.08;
  let x = x0 + w - s * 0.22 - (r.unit ? s * 0.42 : 0);
  const on = o.color, off = rgba(o.color, 0.08);
  const by = y0 + s * 0.37;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === '.' || ch === ':') {
      ctx.fillStyle = on;
      if (ch === '.') ctx.fillRect(x - s * 0.06, by + dh - s * 0.07, s * 0.07, s * 0.07);
      else { ctx.fillRect(x - s * 0.06, by + dh * 0.25, s * 0.07, s * 0.07); ctx.fillRect(x - s * 0.06, by + dh * 0.7, s * 0.07, s * 0.07); }
      x -= s * 0.12;
      continue;
    }
    x -= dw;
    segDigit(ctx, ch, x, by, dw, dh, on, off);
    x -= gap;
  }
}

function sport({ ctx, o, r, W, H }: DesignInput) {
  const s = o.size * H, w = s * 2.6, h = s * 1, cx = o.x * W, cy = o.y * H, x0 = cx - w / 2, y0 = cy - h / 2;
  const k = h * 0.28; // slant
  dim(ctx, r);
  ctx.save();
  shadow(ctx, s * 0.1);
  ctx.fillStyle = rgba(o.bgColor, o.bgOpacity);
  ctx.beginPath(); ctx.moveTo(x0 + k, y0); ctx.lineTo(x0 + w, y0); ctx.lineTo(x0 + w - k, y0 + h); ctx.lineTo(x0, y0 + h); ctx.closePath(); ctx.fill();
  noShadow(ctx);
  ctx.fillStyle = o.accent;
  ctx.beginPath(); ctx.moveTo(x0 + k, y0); ctx.lineTo(x0 + k + s * 0.16, y0); ctx.lineTo(x0 + s * 0.16, y0 + h); ctx.lineTo(x0, y0 + h); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = o.accent;
  ctx.font = font(o, s * 0.2, 800);
  const lx = x0 + k + s * 0.3;
  ctx.fillText(r.label.toUpperCase(), lx, y0 + s * 0.3);
  ctx.fillStyle = o.color;
  ctx.font = font(o, s * 0.6, 900);
  ctx.fillText(r.value, lx - s * 0.06, y0 + h - s * 0.14);
  const vw = ctx.measureText(r.value).width;
  ctx.font = font(o, s * 0.22, 700);
  ctx.fillStyle = rgba(o.color, 0.75);
  ctx.fillText(r.unit.toUpperCase(), lx - s * 0.06 + vw + s * 0.08, y0 + h - s * 0.16);
}

function sportBar({ ctx, o, r, W, H }: DesignInput) {
  const s = o.size * H, w = s * 3.4, h = s * 0.9, x0 = o.x * W - w / 2, y0 = o.y * H - h / 2;
  dim(ctx, r);
  ctx.save(); shadow(ctx, s * 0.08);
  ctx.fillStyle = rgba(o.bgColor, o.bgOpacity);
  const k = h * 0.25;
  ctx.beginPath(); ctx.moveTo(x0 + k, y0); ctx.lineTo(x0 + w, y0); ctx.lineTo(x0 + w - k, y0 + h); ctx.lineTo(x0, y0 + h); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = o.accent; ctx.font = font(o, s * 0.2, 800); ctx.textAlign = 'left';
  ctx.fillText(r.label.toUpperCase(), x0 + k + s * 0.12, y0 + s * 0.3);
  ctx.fillStyle = o.color; ctx.font = font(o, s * 0.32, 900); ctx.textAlign = 'right';
  ctx.fillText(`${r.value} ${r.unit}`.trim(), x0 + w - k - s * 0.1, y0 + s * 0.34);
  // Slanted segments, lit up to the reading.
  const n = 16, bx = x0 + k + s * 0.1, bw = w - 2 * k - s * 0.2, sw = bw / n, by = y0 + h * 0.52, bh = h * 0.3;
  const lit = Math.round(clamp01(r.fraction) * n);
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i < lit ? (i > n * 0.8 ? '#ff3b30' : o.accent) : 'rgba(255,255,255,0.14)';
    const x = bx + i * sw;
    ctx.beginPath(); ctx.moveTo(x + sw * 0.35, by); ctx.lineTo(x + sw * 0.9, by); ctx.lineTo(x + sw * 0.55, by + bh); ctx.lineTo(x, by + bh); ctx.closePath(); ctx.fill();
  }
}

function badge({ ctx, o, r, W, H }: DesignInput) {
  const s = o.size * H, w = s * 2.7, h = s * 0.8, x0 = o.x * W - w / 2, y0 = o.y * H - h / 2;
  dim(ctx, r);
  ctx.save(); shadow(ctx, s * 0.1);
  ctx.fillStyle = rgba(o.bgColor, o.bgOpacity);
  ctx.beginPath(); ctx.roundRect(x0, y0, w, h, h / 2); ctx.fill();
  ctx.restore();
  const ic = h - s * 0.16, icx = x0 + s * 0.08 + ic / 2, icy = y0 + h / 2;
  ctx.fillStyle = o.accent;
  ctx.beginPath(); ctx.arc(icx, icy, ic / 2, 0, Math.PI * 2); ctx.fill();
  icon(ctx, o.kind as GaugeKind, icx, icy, ic * 0.62, '#ffffff');
  const tx = x0 + s * 0.16 + ic + s * 0.06;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = rgba(o.color, 0.7);
  ctx.font = font(o, s * 0.14, 700, false);
  ctx.fillText(r.label.toUpperCase(), tx, y0 + s * 0.27);
  ctx.fillStyle = o.color;
  ctx.font = font(o, s * 0.36, 800, false);
  ctx.fillText(r.value, tx, y0 + h - s * 0.14);
  const vw = ctx.measureText(r.value).width;
  ctx.font = font(o, s * 0.17, 700, false);
  ctx.fillText(r.unit, tx + vw + s * 0.06, y0 + h - s * 0.15);
}

/** A ruler scrolling past a fixed pointer, like an aircraft's speed tape (horizontal). */
function tape({ ctx, o, r, W, H, around }: DesignInput) {
  const s = o.size * H, w = s * 3.2, h = s * 1, x0 = o.x * W - w / 2, y0 = o.y * H - h / 2, cx = o.x * W;
  dim(ctx, r);
  ctx.save(); shadow(ctx, s * 0.08);
  ctx.fillStyle = rgba(o.bgColor, o.bgOpacity);
  ctx.beginPath(); ctx.roundRect(x0, y0, w, h, s * 0.12); ctx.fill();
  ctx.restore();
  const v = r.num;
  // Ticks every `step`, numbers every 5 steps, `span` units across.
  const span = r.max > 0 ? Math.max(4, r.max / 3) : 20;
  const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].find((x) => span / x <= 24) ?? 1000;
  const pxPer = w / span;
  ctx.save();
  ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
  if (Number.isFinite(v)) {
    const first = Math.ceil((v - span / 2) / step);
    ctx.strokeStyle = rgba(o.color, 0.8); ctx.fillStyle = rgba(o.color, 0.85);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = font(o, s * 0.16, 600, false);
    for (let i = first; i * step <= v + span / 2; i++) {
      const x = cx + (i * step - v) * pxPer, big = i % 5 === 0;
      ctx.lineWidth = Math.max(1, s * (big ? 0.022 : 0.012));
      ctx.beginPath(); ctx.moveTo(x, y0 + h); ctx.lineTo(x, y0 + h - s * (big ? 0.22 : 0.12)); ctx.stroke();
      if (big) ctx.fillText(String(+(i * step).toFixed(1)), x, y0 + h - s * 0.3);
    }
    // Where it is heading: a short trend arrow from the reading 1 s from now.
    const ahead = around?.(1e6);
    if (ahead !== undefined && Number.isFinite(ahead)) {
      ctx.strokeStyle = o.accent; ctx.lineWidth = s * 0.04; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx, y0 + h - s * 0.05); ctx.lineTo(cx + Math.max(-w / 2, Math.min(w / 2, (ahead - v) * pxPer)), y0 + h - s * 0.05); ctx.stroke();
    }
  }
  // Fade at the ends.
  ctx.globalCompositeOperation = 'destination-out';
  for (const [a, b] of [[x0, x0 + w * 0.18], [x0 + w, x0 + w * 0.82]] as const) {
    const g = ctx.createLinearGradient(a, 0, b, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.9)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(Math.min(a, b), y0, Math.abs(b - a), h);
  }
  ctx.restore();
  // Pointer and the value box.
  ctx.fillStyle = o.accent;
  ctx.beginPath(); ctx.moveTo(cx - s * 0.09, y0 + h * 0.42); ctx.lineTo(cx + s * 0.09, y0 + h * 0.42); ctx.lineTo(cx, y0 + h * 0.55); ctx.fill();
  ctx.font = font(o, s * 0.27, 800, false);
  const vw = ctx.measureText(r.value).width;
  ctx.font = font(o, s * 0.12, 700, false);
  const uw = r.unit ? ctx.measureText(r.unit).width + s * 0.06 : 0;
  const bw = vw + uw + s * 0.3, bx = cx - bw / 2, by = y0 + s * 0.05, bh = h * 0.36;
  ctx.fillStyle = rgba(o.bgColor, Math.max(0.85, o.bgOpacity));
  ctx.strokeStyle = o.accent; ctx.lineWidth = Math.max(1, s * 0.025);
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, s * 0.06); ctx.fill(); ctx.stroke();
  ctx.fillStyle = o.color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = font(o, s * 0.27, 800, false);
  ctx.fillText(r.value, bx + s * 0.15, by + bh / 2);
  ctx.font = font(o, s * 0.12, 700, false);
  ctx.fillText(r.unit, bx + s * 0.15 + vw + s * 0.06, by + bh / 2 + s * 0.03);
  ctx.fillStyle = rgba(o.color, 0.7);
  ctx.fillText(r.label.toUpperCase(), x0 + s * 0.12, by + bh / 2);
}

/** A thick 270° arc with a big number in the middle. */
function arc({ ctx, o, r, W, H }: DesignInput) {
  const s = o.size * H, cx = o.x * W, cy = o.y * H, R = s * 0.42, a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  dim(ctx, r);
  if (o.bgOpacity > 0) { ctx.fillStyle = rgba(o.bgColor, o.bgOpacity); ctx.beginPath(); ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2); ctx.fill(); }
  ctx.lineCap = 'round';
  ctx.lineWidth = s * 0.12;
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.beginPath(); ctx.arc(cx, cy, R, a0, a1); ctx.stroke();
  const f = clamp01(r.fraction);
  if (f > 0.001) {
    const g = ctx.createConicGradient(a0, cx, cy);
    g.addColorStop(0, rgba(o.accent, 0.55)); g.addColorStop(0.75, o.accent); g.addColorStop(1, o.accent);
    ctx.save(); shadow(ctx, s * 0.08, rgba(o.accent, 0.6), 0);
    ctx.strokeStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R, a0, a0 + (a1 - a0) * f); ctx.stroke();
    ctx.restore();
  }
  ctx.save(); shadow(ctx, s * 0.06);
  ctx.fillStyle = o.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = font(o, s * 0.34, 800, false);
  ctx.fillText(r.value, cx, cy - s * 0.02);
  ctx.font = font(o, s * 0.1, 700, false);
  ctx.fillStyle = rgba(o.color, 0.75);
  ctx.fillText(r.unit, cx, cy + s * 0.19);
  ctx.fillText(r.label.toUpperCase(), cx, cy + s * 0.38);
  ctx.restore();
}

/** A full ring that fills up, value in the middle. */
function ring({ ctx, o, r, W, H }: DesignInput) {
  const s = o.size * H, cx = o.x * W, cy = o.y * H, R = s * 0.43, top = -Math.PI / 2;
  dim(ctx, r);
  ctx.fillStyle = rgba(o.bgColor, o.bgOpacity);
  ctx.beginPath(); ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = s * 0.08; ctx.lineCap = 'round';
  ctx.strokeStyle = rgba(o.accent, 0.22);
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  const f = clamp01(r.fraction);
  if (f > 0.001) { ctx.strokeStyle = o.accent; ctx.beginPath(); ctx.arc(cx, cy, R, top, top + Math.PI * 2 * f); ctx.stroke(); }
  // A dot at the end of the fill.
  const ea = top + Math.PI * 2 * f;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(cx + Math.cos(ea) * R, cy + Math.sin(ea) * R, s * 0.028, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = o.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = font(o, s * 0.1, 600, false);
  ctx.fillText(r.label.toUpperCase(), cx, cy - s * 0.17);
  ctx.font = font(o, s * 0.3, 700, false);
  ctx.fillText(r.value, cx, cy + s * 0.03);
  ctx.font = font(o, s * 0.1, 600, false);
  ctx.fillText(r.unit, cx, cy + s * 0.22);
}

/** Rev counter: lit segments sweep round, red near the top of the scale. */
function moto({ ctx, o, r, W, H }: DesignInput) {
  const s = o.size * H, cx = o.x * W, cy = o.y * H, R = s * 0.45;
  const a0 = Math.PI * 0.8, a1 = Math.PI * 2.05, n = 28;
  dim(ctx, r);
  const face = still(`moto|${o.bgColor}|${o.bgOpacity}|${o.color}|${o.font}|${r.max}`, s, s, (c) => {
    c.fillStyle = rgba(o.bgColor, o.bgOpacity);
    c.beginPath(); c.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2); c.fill();
    c.fillStyle = rgba(o.color, 0.7); c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = font(o, s * 0.075, 700, false);
    for (let i = 0; i <= 4; i++) {
      const a = a0 + ((a1 - a0) * i) / 4, v = (r.max * i) / 4;
      c.fillText(String(+v.toFixed(1)), s / 2 + Math.cos(a) * R * 0.62, s / 2 + Math.sin(a) * R * 0.62);
    }
  });
  ctx.drawImage(face, cx - s / 2, cy - s / 2);
  const lit = clamp01(r.fraction) * n;
  ctx.lineCap = 'butt';
  for (let i = 0; i < n; i++) {
    const a = a0 + ((a1 - a0) * (i + 0.15)) / n, b = a0 + ((a1 - a0) * (i + 0.85)) / n;
    const red = i >= n * 0.8;
    ctx.strokeStyle = i < lit ? (red ? o.accent : o.color) : red ? rgba(o.accent, 0.25) : 'rgba(255,255,255,0.14)';
    ctx.lineWidth = s * (0.07 + 0.05 * (i / n));
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.86, a, b); ctx.stroke();
  }
  ctx.save(); shadow(ctx, s * 0.05);
  ctx.fillStyle = o.color; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = font(o, s * 0.3, 900);
  ctx.fillText(r.value, cx, cy + s * 0.2);
  ctx.font = font(o, s * 0.085, 700);
  ctx.fillText(r.unit.toUpperCase(), cx, cy + s * 0.31);
  ctx.fillStyle = o.accent;
  ctx.fillText(r.label.toUpperCase(), cx, cy + s * 0.43);
  ctx.restore();
}

/** Aviation instrument: black face, bezel with screws, white ticks, orange needle. */
function cockpit({ ctx, o, r, W, H }: DesignInput) {
  const s = o.size * H, cx = o.x * W, cy = o.y * H, R = s * 0.4;
  const a0 = Math.PI * 0.75, span = Math.PI * 1.5;
  dim(ctx, r);
  const face = still(`cockpit|${o.bgColor}|${o.color}|${o.font}|${r.max}|${r.unit}|${r.label}`, s, s, (c) => {
    const m = s / 2;
    const bez = c.createLinearGradient(0, 0, s, s);
    bez.addColorStop(0, '#5a5e64'); bez.addColorStop(0.5, '#1d1f22'); bez.addColorStop(1, '#6b7077');
    c.fillStyle = bez; c.beginPath(); c.roundRect(0, 0, s, s, s * 0.12); c.fill();
    for (const [sx, sy] of [[0.09, 0.09], [0.91, 0.09], [0.09, 0.91], [0.91, 0.91]] as const) {
      c.fillStyle = '#2a2c30'; c.beginPath(); c.arc(sx * s, sy * s, s * 0.035, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#8a8f96'; c.lineWidth = s * 0.008; c.beginPath(); c.moveTo(sx * s - s * 0.022, sy * s); c.lineTo(sx * s + s * 0.022, sy * s); c.stroke();
    }
    c.fillStyle = o.bgColor; c.beginPath(); c.arc(m, m, s * 0.45, 0, Math.PI * 2); c.fill();
    c.strokeStyle = o.color; c.fillStyle = o.color; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = font(o, s * 0.08, 700, false);
    for (let i = 0; i <= 40; i++) {
      const a = a0 + (span * i) / 40, big = i % 5 === 0;
      c.lineWidth = s * (big ? 0.014 : 0.006);
      c.beginPath(); c.moveTo(m + Math.cos(a) * R * (big ? 0.82 : 0.9), m + Math.sin(a) * R * (big ? 0.82 : 0.9)); c.lineTo(m + Math.cos(a) * R, m + Math.sin(a) * R); c.stroke();
      if (i % 10 === 0) { const v = (r.max * i) / 40; c.fillText(String(+v.toFixed(1)), m + Math.cos(a) * R * 0.64, m + Math.sin(a) * R * 0.64); }
    }
    c.font = font(o, s * 0.055, 700, false);
    c.fillText(r.label.toUpperCase(), m, m + R * 0.24);
    c.fillText(r.unit.toUpperCase(), m, m + R * 0.7);
    // Glass.
    const gl = c.createLinearGradient(0, 0, 0, s);
    gl.addColorStop(0, 'rgba(255,255,255,0.10)'); gl.addColorStop(0.5, 'rgba(255,255,255,0)');
    c.fillStyle = gl; c.beginPath(); c.arc(m, m, s * 0.45, Math.PI, 0); c.fill();
  });
  ctx.drawImage(face, cx - s / 2, cy - s / 2);
  const a = a0 + span * clamp01(r.fraction);
  ctx.save(); shadow(ctx, s * 0.03, 'rgba(0,0,0,0.8)', s * 0.01);
  ctx.fillStyle = o.accent;
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(a) * R * 0.92, cy + Math.sin(a) * R * 0.92);
  ctx.lineTo(cx + Math.cos(a + Math.PI / 2) * s * 0.022, cy + Math.sin(a + Math.PI / 2) * s * 0.022);
  ctx.lineTo(cx - Math.cos(a) * R * 0.18, cy - Math.sin(a) * R * 0.18);
  ctx.lineTo(cx + Math.cos(a - Math.PI / 2) * s * 0.022, cy + Math.sin(a - Math.PI / 2) * s * 0.022);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#3a3d42'; ctx.beginPath(); ctx.arc(cx, cy, s * 0.04, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = o.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = font(o, s * 0.1, 700, false);
  ctx.fillText(r.value, cx, cy + R * 0.47);
}
