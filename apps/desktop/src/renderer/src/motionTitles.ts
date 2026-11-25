// Motion titles: lower thirds, title cards, end cards and location tags, each moving in and out
// on its own. Also text on a path (arc, wave, circle, drawn). Drawn in Canvas2D like the other
// overlays, so the preview, export and frame grabs all match.
//
// A title uses the overlay's own settings: colour (text), accent (bars, lines, pins), background
// colour and opacity (panels), font, size, outline and shadow. Lower thirds and location tags are
// placed by their left edge, cards by their centre.

import { titleTemplate, titleTime, type Overlay, type TextPath, type TitleTime } from '@ace/project';
import { font, rgba } from './textStyle';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const out3 = (x: number) => 1 - (1 - clamp01(x)) ** 3;
const inOut = (x: number) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2; };
const back = (x: number) => { x = clamp01(x); return 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2; };
function bounce(f: number) {
  f = clamp01(f);
  const n = 7.5625, d = 2.75;
  if (f < 1 / d) return n * f * f;
  if (f < 2 / d) return n * (f -= 1.5 / d) * f + 0.75;
  if (f < 2.5 / d) return n * (f -= 2.25 / d) * f + 0.9375;
  return n * (f -= 2.625 / d) * f + 0.984375;
}
/** Part of a phase: 0 before `a`, 1 after `b`. */
const part = (x: number, a: number, b: number) => clamp01((x - a) / (b - a));
/** A repeatable random number for a whole number. */
const hash = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

const shown = (o: Overlay, s: string) => (o.uppercase ? s.toUpperCase() : s);

function setFont(ctx: Ctx2D, o: Overlay, px: number, weight?: number, tracking = o.tracking) {
  ctx.font = font(o, px, weight);
  (ctx as CanvasRenderingContext2D).letterSpacing = `${(tracking * px).toFixed(2)}px`;
}
function noShadow(ctx: Ctx2D) { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; }

/** Text with the overlay's outline, shadow or glow, at (x, y) (middle baseline). */
function paint(ctx: Ctx2D, o: Overlay, str: string, x: number, y: number, px: number, color = o.color) {
  if (!str) return;
  ctx.textBaseline = 'middle';
  if (o.outline > 0) {
    noShadow(ctx);
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = o.outline * px * 2;
    ctx.strokeStyle = o.outlineColor;
    ctx.strokeText(str, x, y);
  }
  if (o.background === 'shadow') { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = px * 0.12; ctx.shadowOffsetY = px * 0.03; }
  else if (o.background === 'glow') { ctx.shadowColor = color; ctx.shadowBlur = px * 0.45; ctx.shadowOffsetY = 0; }
  else noShadow(ctx);
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
  noShadow(ctx);
}

/** Width of text in the current font (letter spacing counts once per letter, as Canvas draws it). */
const width = (ctx: Ctx2D, s: string) => (s ? ctx.measureText(s).width : 0);

function panel(ctx: Ctx2D, color: string, opacity: number, x: number, y: number, w: number, h: number, r: number) {
  if (opacity <= 0 || w <= 0 || h <= 0) return;
  ctx.fillStyle = rgba(color, opacity);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  ctx.fill();
}

/** Draws inside a rectangle only. */
function clipped(ctx: Ctx2D, x: number, y: number, w: number, h: number, draw: () => void) {
  if (w <= 0 || h <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  draw();
  ctx.restore();
}

interface Frame { ctx: Ctx2D; o: Overlay; W: number; H: number; X: number; Y: number; s: number; sub: number; name: string; second: string; tt: TitleTime }

type Draw = (f: Frame) => void;

/** Both lines of a lower third: name on top, second line under, starting at x. */
function nameAndSecond(f: Frame, x: number, nameY: number, subY: number, nameColor = f.o.color, subColor = f.o.color) {
  const { ctx, o } = f;
  setFont(ctx, o, f.s);
  ctx.textAlign = 'left';
  paint(ctx, o, f.name, x, nameY, f.s, nameColor);
  if (f.second) {
    setFont(ctx, o, f.sub, o.bold ? 500 : 400);
    ctx.globalAlpha *= 0.92;
    paint(ctx, o, f.second, x, subY, f.sub, subColor);
  }
}
function widths(f: Frame): { name: number; second: number; most: number } {
  setFont(f.ctx, f.o, f.s);
  const name = width(f.ctx, f.name);
  setFont(f.ctx, f.o, f.sub, f.o.bold ? 500 : 400);
  const second = width(f.ctx, f.second);
  return { name, second, most: Math.max(name, second) };
}

const TEMPLATES: Record<string, Draw> = {
  // ---- Lower thirds --------------------------------------------------------------------------
  'lt-bar': (f) => {
    const { ctx, o, X, Y, s } = f;
    const v = Math.min(f.tt.tin, f.tt.tout);
    const w = widths(f), bar = s * 0.13, gap = s * 0.35, h = f.second ? s * 2.1 : s * 1.4;
    const grow = out3(part(v, 0, 0.45)), open = inOut(part(v, 0.3, 1));
    const full = w.most + gap * 2;
    panel(ctx, o.bgColor, o.bgOpacity, X + bar, Y - h / 2, full * open, h, s * 0.12);
    ctx.fillStyle = o.accent;
    ctx.fillRect(X, Y - (h / 2) * grow, bar, h * grow);
    clipped(ctx, X + bar, Y - h, full * open, h * 2, () => {
      const dx = -(1 - open) * full * 0.4;
      nameAndSecond(f, X + bar + gap + dx, f.second ? Y - s * 0.38 : Y, Y + s * 0.5);
    });
  },
  'lt-line': (f) => {
    const { ctx, o, X, Y, s } = f;
    const v = Math.min(f.tt.tin, f.tt.tout);
    const w = widths(f), line = out3(part(v, 0, 0.5)), up = out3(part(v, 0.25, 1));
    ctx.fillStyle = o.accent;
    ctx.fillRect(X, Y - s * 0.03, (w.most + s * 0.3) * line, s * 0.06);
    clipped(ctx, X - s, Y - s * 2, w.most + s * 3, s * 2 - s * 0.05, () => {
      setFont(ctx, o, f.s);
      ctx.textAlign = 'left';
      paint(ctx, o, f.name, X, Y - s * 0.6 + (1 - up) * s * 1.2, s);
    });
    if (f.second) clipped(ctx, X - s, Y + s * 0.05, w.most + s * 3, s * 2, () => {
      setFont(ctx, o, f.sub, 500);
      ctx.textAlign = 'left';
      paint(ctx, o, f.second, X, Y + s * 0.5 - (1 - up) * s, f.sub);
    });
  },
  'lt-box': (f) => {
    const { ctx, o, X, Y, s } = f;
    const v = Math.min(f.tt.tin, f.tt.tout);
    const w = widths(f), pad = s * 0.45, h = f.second ? s * 2.1 : s * 1.4, full = w.most + pad * 2;
    const open = inOut(part(v, 0, 0.6)), text = part(v, 0.45, 1);
    panel(ctx, o.bgColor, Math.max(0.05, o.bgOpacity), X, Y - h / 2, full * open, h, s * 0.08);
    ctx.fillStyle = o.accent;
    ctx.fillRect(X, Y - h / 2, Math.min(s * 0.12, full * open), h);
    ctx.globalAlpha *= text;
    nameAndSecond(f, X + pad + (1 - out3(text)) * s * 0.3, f.second ? Y - s * 0.38 : Y, Y + s * 0.5);
  },
  'lt-tag': (f) => {
    const { ctx, o, X, Y, s } = f;
    const w = widths(f), pad = s * 0.35, skew = s * 0.3;
    const a = out3(part(f.tt.tin, 0, 0.6)) * out3(part(f.tt.tout, 0.3, 1));
    const b = out3(part(f.tt.tin, 0.35, 1)) * out3(part(f.tt.tout, 0, 0.7));
    const nameW = w.name + pad * 2, top = Y - s * 0.95;
    const slide = (k: number, len: number) => -(1 - k) * (len + X + skew * 2);
    ctx.save();
    ctx.translate(slide(a, nameW), 0);
    ctx.fillStyle = o.accent;
    ctx.beginPath();
    ctx.moveTo(X + skew, top); ctx.lineTo(X + nameW + skew, top); ctx.lineTo(X + nameW, top + s * 1.2); ctx.lineTo(X, top + s * 1.2); ctx.closePath();
    ctx.fill();
    setFont(ctx, o, s);
    ctx.textAlign = 'left';
    paint(ctx, o, f.name, X + pad + skew / 2, top + s * 0.6, s);
    ctx.restore();
    if (f.second) {
      setFont(ctx, o, f.sub, 500);
      const sw = width(ctx, f.second) + pad * 2;
      ctx.save();
      ctx.translate(slide(b, sw), 0);
      panel(ctx, o.bgColor, o.bgOpacity, X + skew * 0.5, top + s * 1.25, sw, f.sub * 1.5, s * 0.05);
      ctx.textAlign = 'left';
      paint(ctx, o, f.second, X + skew * 0.5 + pad, top + s * 1.25 + f.sub * 0.75, f.sub);
      ctx.restore();
    }
  },
  'lt-stack': (f) => {
    const { ctx, o, X, Y, s } = f;
    const w = widths(f), pad = s * 0.4, r = s * 0.35;
    const a = back(part(f.tt.tin, 0, 0.6)) * inOut(part(f.tt.tout, 0.35, 1));
    const b = back(part(f.tt.tin, 0.25, 0.9)) * inOut(part(f.tt.tout, 0, 0.65));
    const topH = s * 1.35, nameW = w.name + pad * 2;
    ctx.save();
    ctx.translate(X, 0); ctx.scale(Math.max(0, a), 1); ctx.translate(-X, 0);
    panel(ctx, o.accent, 1, X, Y - topH, nameW, topH, r);
    ctx.restore();
    const base = ctx.globalAlpha;
    ctx.globalAlpha = base * clamp01(a * 1.5);
    setFont(ctx, o, s);
    ctx.textAlign = 'left';
    paint(ctx, o, f.name, X + pad, Y - topH / 2, s);
    ctx.globalAlpha = base * clamp01(b * 1.5);
    if (f.second) {
      setFont(ctx, o, f.sub, 500);
      const sw = width(ctx, f.second) + pad * 2;
      ctx.save();
      ctx.translate(X, 0); ctx.scale(Math.max(0, b), 1); ctx.translate(-X, 0);
      panel(ctx, o.bgColor, o.bgOpacity, X, Y + s * 0.12, sw, f.sub * 1.6, r * 0.8);
      ctx.restore();
      paint(ctx, o, f.second, X + pad, Y + s * 0.12 + f.sub * 0.8, f.sub);
    }
  },
  'lt-minimal': (f) => {
    const { ctx, o, X, Y, s } = f;
    const v = Math.min(f.tt.tin, f.tt.tout);
    const e = out3(v);
    setFont(ctx, o, s, undefined, o.tracking + (1 - e) * 0.35);
    ctx.textAlign = 'left';
    ctx.globalAlpha *= e;
    paint(ctx, o, f.name, X, f.second ? Y - s * 0.38 : Y, s);
    if (f.second) {
      setFont(ctx, o, f.sub, 400, o.tracking + (1 - out3(part(v, 0.3, 1))) * 0.35);
      ctx.globalAlpha *= part(v, 0.3, 1);
      paint(ctx, o, f.second, X, Y + s * 0.5, f.sub);
    }
  },

  // ---- Title cards ---------------------------------------------------------------------------
  'tc-spread': (f) => {
    const { ctx, o, X, Y, s } = f;
    const v = Math.min(f.tt.tin, f.tt.tout);
    const e = out3(v);
    ctx.textAlign = 'center';
    ctx.globalAlpha *= e;
    setFont(ctx, o, s, undefined, o.tracking + (1 - e) * 0.8);
    paint(ctx, o, f.name, X, f.second ? Y - s * 0.25 : Y, s);
    if (f.second) {
      const k = out3(part(v, 0.4, 1));
      ctx.globalAlpha *= k;
      setFont(ctx, o, f.sub, 500, 0.2);
      paint(ctx, o, f.second, X, Y + s * 0.6 + (1 - k) * s * 0.3, f.sub);
    }
  },
  'tc-drop': (f) => {
    const { ctx, o, X, Y, s, tt } = f;
    setFont(ctx, o, s);
    ctx.textAlign = 'left';
    const chars = [...f.name];
    const total = width(ctx, f.name);
    let x = X - total / 2;
    const fall = 1 - out3(tt.tout);
    chars.forEach((c, i) => {
      const lp = clamp01((tt.t - i * 0.06) / 0.55);
      const cw = width(ctx, c);
      ctx.save();
      ctx.globalAlpha *= clamp01(lp * 4) * (1 - fall);
      paint(ctx, o, c, x, Y - (1 - bounce(lp)) * s * 1.6 + fall * s * (0.6 + hash(i) * 0.8), s);
      ctx.restore();
      x += cw;
    });
  },
  'tc-cinema': (f) => {
    const { ctx, o, W, H, X, Y, s, tt } = f;
    const v = Math.min(tt.tin, tt.tout);
    const bars = inOut(part(v, 0, 0.7)) * H * 0.11;
    ctx.fillStyle = rgba(o.bgColor, o.bgOpacity);
    ctx.fillRect(0, 0, W, bars);
    ctx.fillRect(0, H - bars, W, bars);
    const k = inOut(part(v, 0.35, 1));
    const push = 1.06 - 0.06 * clamp01(tt.t / Math.max(0.1, tt.len));
    ctx.save();
    ctx.translate(X, Y); ctx.scale(push, push); ctx.translate(-X, -Y);
    ctx.globalAlpha *= k;
    ctx.textAlign = 'center';
    setFont(ctx, o, s);
    paint(ctx, o, f.name, X, Y, s);
    if (f.second) {
      setFont(ctx, o, f.sub, 400, 0.35);
      const sw = width(ctx, f.second);
      paint(ctx, o, f.second, X, Y + s * 0.95, f.sub);
      ctx.fillStyle = o.accent;
      const lw = s * 1.2 * k;
      ctx.fillRect(X - sw / 2 - s * 0.3 - lw, Y + s * 0.95 - 0.5, lw, 1.2);
      ctx.fillRect(X + sw / 2 + s * 0.3, Y + s * 0.95 - 0.5, lw, 1.2);
    }
    ctx.restore();
  },
  'tc-glitch': (f) => {
    const { ctx, o, X, Y, s, tt } = f;
    const frame = Math.floor(tt.t * 24);
    // Glitchy while coming in and going out, and for a moment every 2.5 s.
    const calm = Math.min(tt.tin, tt.tout);
    const burst = (tt.t % 2.5) < 0.12 ? 0.5 : 0;
    const amt = Math.max(1 - calm, burst);
    const vis = calm < 1 ? (hash(frame) < calm * 1.3 ? 1 : 0.15) : 1;
    ctx.textAlign = 'center';
    setFont(ctx, o, s);
    const tw = width(ctx, f.name);
    const j = amt * s * 0.18;
    ctx.save();
    ctx.globalAlpha *= vis;
    ctx.globalCompositeOperation = 'lighter';
    paint(ctx, { ...o, outline: 0, background: 'none' }, f.name, X - j * (0.5 + hash(frame + 1)), Y + j * (hash(frame + 2) - 0.5) * 0.4, s, o.accent);
    paint(ctx, { ...o, outline: 0, background: 'none' }, f.name, X + j * (0.5 + hash(frame + 3)), Y + j * (hash(frame + 4) - 0.5) * 0.4, s, o.bgColor);
    ctx.globalCompositeOperation = 'source-over';
    // Slices of the text pushed sideways.
    const bands = amt > 0.05 ? 4 : 0;
    if (!bands) paint(ctx, o, f.name, X, Y, s);
    for (let i = 0; i < 6; i++) {
      const y0 = Y - s * 0.6 + (i * s * 1.2) / 6;
      const shift = bands && hash(frame * 7 + i) > 0.55 ? (hash(frame * 13 + i) - 0.5) * s * 0.6 * amt : 0;
      if (!bands) break;
      clipped(ctx, X - tw, y0, tw * 2, s * 1.2 / 6 + 0.5, () => paint(ctx, o, f.name, X + shift, Y, s));
    }
    ctx.restore();
  },
  'tc-punch': (f) => {
    const { ctx, o, X, Y, s, tt } = f;
    const sc = tt.tout < 1 ? 0.7 + 0.3 * out3(tt.tout) : 3 - 2 * back(tt.tin);
    const alpha = clamp01(tt.tin * 3) * out3(tt.tout);
    ctx.textAlign = 'center';
    setFont(ctx, o, s);
    // Echoes behind it while it lands.
    for (const [k, a] of [[1.35, 0.18], [1.15, 0.32]] as const) {
      if (tt.tin >= 1) break;
      ctx.save();
      ctx.globalAlpha *= alpha * a * (1 - tt.tin);
      ctx.translate(X, Y); ctx.scale(sc * k, sc * k); ctx.translate(-X, -Y);
      paint(ctx, { ...o, outline: 0 }, f.name, X, Y, s, o.accent);
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(X, Y); ctx.scale(sc, sc); ctx.translate(-X, -Y);
    paint(ctx, o, f.name, X, Y, s);
    ctx.restore();
  },
  'tc-outline': (f) => {
    const { ctx, o, X, Y, s, tt } = f;
    const v = Math.min(tt.tin, tt.tout);
    const line = part(v, 0, 0.45), fill = inOut(part(v, 0.45, 1));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    setFont(ctx, o, s);
    const tw = width(ctx, f.name);
    ctx.save();
    ctx.globalAlpha *= line;
    ctx.lineWidth = Math.max(1, s * 0.035);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = o.accent;
    ctx.strokeText(f.name, X, Y);
    ctx.restore();
    clipped(ctx, X - tw / 2 - s, Y - s, (tw + s * 2) * fill, s * 2, () => paint(ctx, { ...o, outline: 0 }, f.name, X, Y, s));
  },
  'tc-split': (f) => {
    const { ctx, o, X, Y, s, tt } = f;
    const v = Math.min(tt.tin, tt.tout);
    const w = widths(f), line = inOut(part(v, 0, 0.5)), slide = out3(part(v, 0.3, 1));
    const L = (w.most + s) * line;
    ctx.fillStyle = o.accent;
    ctx.fillRect(X - L / 2, Y - s * 0.03, L, s * 0.06);
    ctx.textAlign = 'center';
    clipped(ctx, X - w.most, Y - s * 2, w.most * 2, s * 2 - s * 0.06, () => {
      setFont(ctx, o, s);
      paint(ctx, o, f.name, X, Y - s * 0.6 + (1 - slide) * s * 1.3, s);
    });
    if (f.second) clipped(ctx, X - w.most, Y + s * 0.06, w.most * 2, s * 2, () => {
      setFont(ctx, o, f.sub, 500, 0.15);
      paint(ctx, o, f.second, X, Y + s * 0.5 - (1 - slide) * s, f.sub);
    });
  },
  'tc-type': (f) => {
    const { ctx, o, X, Y, s, tt } = f;
    const rate = 16; // letters a second
    const n1 = Math.min(f.name.length, Math.floor(tt.t * rate));
    const n2 = Math.max(0, Math.min(f.second.length, Math.floor((tt.t - f.name.length / rate - 0.25) * rate)));
    ctx.globalAlpha *= out3(tt.tout);
    ctx.textAlign = 'left';
    setFont(ctx, o, s);
    const tw = width(ctx, f.name);
    const y1 = f.second ? Y - s * 0.3 : Y;
    const part1 = f.name.slice(0, n1);
    paint(ctx, o, part1, X - tw / 2, y1, s);
    let cx = X - tw / 2 + width(ctx, part1), cy = y1, ch = s;
    if (f.second) {
      setFont(ctx, o, f.sub, 400);
      const sw = width(ctx, f.second), part2 = f.second.slice(0, n2);
      paint(ctx, o, part2, X - sw / 2, Y + s * 0.6, f.sub);
      if (n1 >= f.name.length && tt.t > f.name.length / rate + 0.25) { cx = X - sw / 2 + width(ctx, part2); cy = Y + s * 0.6; ch = f.sub; }
    }
    // A blinking cursor.
    if (Math.floor(tt.t * 2.5) % 2 === 0 || n1 < f.name.length) {
      ctx.fillStyle = o.accent;
      ctx.fillRect(cx + ch * 0.06, cy - ch * 0.42, ch * 0.08, ch * 0.84);
    }
  },

  // ---- End cards -----------------------------------------------------------------------------
  'end-thanks': (f) => {
    const { ctx, o, W, H, X, Y, s, tt } = f;
    const v = Math.min(tt.tin, tt.tout);
    ctx.fillStyle = rgba(o.bgColor, o.bgOpacity * out3(v));
    ctx.fillRect(0, 0, W, H);
    const pop = tt.tout < 1 ? out3(tt.tout) : back(part(tt.tin, 0.1, 0.8));
    ctx.save();
    ctx.globalAlpha *= clamp01(pop * 2);
    ctx.translate(X, Y - s * 0.4); ctx.scale(pop, pop); ctx.translate(-X, -(Y - s * 0.4));
    ctx.textAlign = 'center';
    setFont(ctx, o, s);
    paint(ctx, o, f.name, X, Y - s * 0.4, s);
    ctx.restore();
    if (f.second) {
      const k = tt.tout < 1 ? out3(tt.tout) : back(part(tt.tin, 0.45, 1));
      setFont(ctx, o, f.sub, 700);
      const pw = width(ctx, f.second) + f.sub * 1.6, ph = f.sub * 2;
      ctx.save();
      ctx.translate(X, Y + s * 0.75); ctx.scale(k, k); ctx.translate(-X, -(Y + s * 0.75));
      panel(ctx, o.accent, 1, X - pw / 2, Y + s * 0.75 - ph / 2, pw, ph, ph / 2);
      ctx.textAlign = 'center';
      paint(ctx, { ...o, outline: 0, background: 'none' }, f.second, X, Y + s * 0.75, f.sub, '#ffffff');
      ctx.restore();
    }
  },
  'end-credits': (f) => {
    const { ctx, o, W, H, X, s, tt } = f;
    ctx.fillStyle = rgba(o.bgColor, o.bgOpacity * out3(Math.min(tt.tin, tt.tout)));
    ctx.fillRect(0, 0, W, H);
    const lines = f.name.split('\n');
    const lh = s * 1.5, total = lines.length * lh;
    // From just below the frame to just above it over the title's length.
    const y0 = H + s - (H + total + s * 2) * clamp01(tt.t / Math.max(0.1, tt.len));
    ctx.textAlign = 'center';
    lines.forEach((l, i) => {
      const y = y0 + i * lh;
      if (!l || y < -lh || y > H + lh) return;
      const heading = i === 0 || lines[i - 1] === '';
      if (heading) { setFont(ctx, o, s * 0.7, 600, 0.2); paint(ctx, o, l.toUpperCase(), X, y, s * 0.7, o.accent); }
      else { setFont(ctx, o, s); paint(ctx, o, l, X, y, s); }
    });
  },
  'end-card': (f) => {
    const { ctx, o, W, H, X, Y, s, tt } = f;
    const v = Math.min(tt.tin, tt.tout);
    ctx.fillStyle = rgba(o.bgColor, o.bgOpacity * inOut(part(v, 0, 0.6)));
    ctx.fillRect(0, 0, W, H);
    const k = out3(part(v, 0.3, 1));
    ctx.textAlign = 'center';
    ctx.globalAlpha *= k;
    setFont(ctx, o, s);
    const tw = width(ctx, f.name);
    paint(ctx, o, f.name, X, Y - s * 0.3 + (1 - k) * s * 0.4, s);
    ctx.fillStyle = o.accent;
    const L = Math.min(tw, s * 3) * out3(part(v, 0.5, 1));
    ctx.fillRect(X - L / 2, Y + s * 0.35, L, s * 0.06);
    if (f.second) { setFont(ctx, o, f.sub, 500, 0.1); paint(ctx, o, f.second, X, Y + s * 0.95, f.sub); }
  },

  // ---- Location tags -------------------------------------------------------------------------
  'loc-pin': (f) => {
    const { ctx, o, X, Y, s, tt } = f;
    const w = widths(f), pin = s * 0.55;
    const drop = (1 - bounce(part(tt.tin, 0, 0.7))) * s * 2.2;
    const open = inOut(part(tt.tin, 0.35, 1)) * inOut(tt.tout);
    const left = X + pin * 2.1, full = w.most + s * 0.6, h = f.second ? s * 2 : s * 1.3;
    panel(ctx, o.bgColor, o.bgOpacity * open, X - s * 0.25, Y - h / 2, (left - X + s * 0.25) + full * open, h, s * 0.3);
    // The pin: a teardrop with a hole.
    ctx.save();
    ctx.globalAlpha *= clamp01(tt.tin * 4) * out3(tt.tout);
    const px = X + pin, py = Y - pin * 0.35 - drop;
    ctx.fillStyle = o.accent;
    ctx.beginPath();
    ctx.arc(px, py, pin * 0.75, Math.PI * 0.82, Math.PI * 0.18);
    ctx.lineTo(px, py + pin * 1.25);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(px, py, pin * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    clipped(ctx, left - s * 0.2, Y - h, full * open + s * 0.2, h * 2, () => nameAndSecond(f, left - (1 - open) * s, f.second ? Y - s * 0.33 : Y, Y + s * 0.47));
  },
  'loc-coords': (f) => {
    const { ctx, o, X, Y, s, tt } = f;
    const rate = 24;
    const n1 = Math.min(f.name.length, Math.floor(tt.t * rate));
    const n2 = Math.max(0, Math.min(f.second.length, Math.floor((tt.t - 0.2) * rate)));
    ctx.globalAlpha *= out3(tt.tout);
    const w = widths(f), cross = s * 0.9, h = f.second ? s * 2.2 : s * 1.4;
    panel(ctx, o.bgColor, o.bgOpacity, X - s * 0.3, Y - h / 2, cross + w.most + s * 0.9, h, s * 0.15);
    // A crosshair that blinks while it "locks on".
    if (tt.tin >= 1 || Math.floor(tt.t * 8) % 2 === 0) {
      const cx = X + cross / 2 - s * 0.05, cy = Y;
      ctx.strokeStyle = o.accent;
      ctx.lineWidth = Math.max(1, s * 0.07);
      ctx.beginPath(); ctx.arc(cx, cy, cross * 0.28, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - cross * 0.45, cy); ctx.lineTo(cx - cross * 0.12, cy);
      ctx.moveTo(cx + cross * 0.12, cy); ctx.lineTo(cx + cross * 0.45, cy);
      ctx.moveTo(cx, cy - cross * 0.45); ctx.lineTo(cx, cy - cross * 0.12);
      ctx.moveTo(cx, cy + cross * 0.12); ctx.lineTo(cx, cy + cross * 0.45);
      ctx.stroke();
    }
    nameAndSecond({ ...f, name: f.name.slice(0, n1), second: f.second.slice(0, n2) }, X + cross + s * 0.1, f.second ? Y - s * 0.4 : Y, Y + s * 0.5);
  },
  'loc-stamp': (f) => {
    const { ctx, o, X, Y, s, tt } = f;
    // On and off in one go, like a camcorder.
    if (tt.t < 0.1 || tt.len - tt.t < 0.05) return;
    ctx.textAlign = 'left';
    setFont(ctx, o, s);
    paint(ctx, o, f.name, X, Y, s);
    if (f.second) { setFont(ctx, o, f.sub * 1.3); paint(ctx, o, f.second, X, Y + s * 1.05, f.sub * 1.3); }
    if (Math.floor(tt.t * 1.6) % 2 === 0) {
      ctx.fillStyle = o.accent;
      ctx.beginPath(); ctx.arc(X + s * 0.3, Y - s * 1.1, s * 0.25, 0, Math.PI * 2); ctx.fill();
      setFont(ctx, o, s * 0.75);
      paint(ctx, o, 'REC', X + s * 0.75, Y - s * 1.1, s * 0.75);
    }
  },
  'loc-sign': (f) => {
    const { ctx, o, X, Y, s, tt } = f;
    const w = widths(f), pad = s * 0.45, arrow = s * 0.8, h = f.second ? s * 2.2 : s * 1.5;
    const bw = w.most + pad * 2 + arrow;
    // Swings in from its top corner and settles.
    const angle = tt.t < 2 ? 28 * Math.exp(-4 * tt.t) * Math.cos(9 * tt.t) : 0;
    ctx.save();
    ctx.globalAlpha *= clamp01(tt.t * 5) * out3(tt.tout);
    ctx.translate(X, Y - h / 2 - (1 - out3(tt.tout)) * s);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.translate(-X, -(Y - h / 2));
    panel(ctx, o.bgColor, o.bgOpacity, X, Y - h / 2, bw, h, s * 0.18);
    ctx.strokeStyle = rgba('#ffffff', 0.85);
    ctx.lineWidth = Math.max(1, s * 0.05);
    ctx.beginPath(); ctx.roundRect(X + s * 0.1, Y - h / 2 + s * 0.1, bw - s * 0.2, h - s * 0.2, s * 0.12); ctx.stroke();
    // An arrow pointing on along the trail.
    const ax = X + bw - pad * 0.6 - arrow / 2;
    ctx.fillStyle = o.accent;
    ctx.beginPath();
    ctx.moveTo(ax - arrow * 0.35, Y - arrow * 0.12); ctx.lineTo(ax + arrow * 0.05, Y - arrow * 0.12); ctx.lineTo(ax + arrow * 0.05, Y - arrow * 0.32);
    ctx.lineTo(ax + arrow * 0.4, Y); ctx.lineTo(ax + arrow * 0.05, Y + arrow * 0.32); ctx.lineTo(ax + arrow * 0.05, Y + arrow * 0.12); ctx.lineTo(ax - arrow * 0.35, Y + arrow * 0.12);
    ctx.closePath(); ctx.fill();
    nameAndSecond(f, X + pad, f.second ? Y - s * 0.38 : Y, Y + s * 0.5);
    ctx.restore();
  },
};

/** Draws a motion title at timeline time T (text and second line already filled in). */
export function drawTitle(ctx: Ctx2D, o: Overlay, W: number, H: number, T: number) {
  const draw = TEMPLATES[o.title ?? ''];
  if (!draw) return;
  const s = o.size * H;
  const f: Frame = { ctx, o, W, H, X: o.x * W, Y: o.y * H, s, sub: s * 0.55, name: shown(o, o.text), second: shown(o, o.subtitle ?? ''), tt: titleTime(o, T) };
  if (!titleTemplate(o.title)?.hasSubtitle) f.second = '';
  ctx.save();
  draw(f);
  ctx.restore();
  (ctx as CanvasRenderingContext2D).letterSpacing = '0px';
}

let measure: OffscreenCanvasRenderingContext2D | null = null;
/** Where a title sits in pixels (for selecting and dragging it), when fully in. */
export function titleBox(o: Overlay, W: number, H: number): { x: number; y: number; w: number; h: number } {
  measure ??= new OffscreenCanvas(8, 8).getContext('2d');
  const s = o.size * H, sub = s * 0.55, t = titleTemplate(o.title);
  const ctx = measure!;
  const lines = shown(o, o.text).split('\n');
  ctx.font = font(o, s);
  (ctx as unknown as CanvasRenderingContext2D).letterSpacing = `${(o.tracking * s).toFixed(2)}px`;
  const nameW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  ctx.font = font(o, sub, 500);
  const subW = t?.hasSubtitle && o.subtitle ? ctx.measureText(shown(o, o.subtitle)).width : 0;
  const most = Math.max(nameW, subW);
  const X = o.x * W, Y = o.y * H;
  if (o.title === 'end-credits') return { x: X - most / 2, y: H * 0.1, w: most, h: H * 0.8 };
  if (t?.category === 'lower' || t?.category === 'place') {
    const extra = o.title === 'loc-pin' ? s * 1.4 : o.title === 'loc-coords' ? s * 1.2 : o.title === 'loc-sign' ? s * 1.7 : s * 0.9;
    const h = subW ? s * 2.3 : s * 1.5;
    return { x: X - s * 0.3, y: Y - h / 2 - (o.title === 'loc-stamp' ? s * 1.3 : 0), w: most + extra + s * 0.3, h: h + (o.title === 'loc-stamp' ? s * 1.3 : 0) };
  }
  const h = subW ? s * 2.1 : s * 1.3;
  return { x: X - most / 2 - s * 0.2, y: Y - s * 0.8, w: most + s * 0.4, h };
}

// ---- Text on a path ----------------------------------------------------------------------------

/** The path as points in pixels, centred on (0, 0), for text `len` pixels long. */
export function pathPoints(p: TextPath, len: number, px: number): [number, number][] {
  const n = 96, out: [number, number][] = [];
  switch (p.kind) {
    case 'arc': {
      // A circular arc as long as the text; more bend = a tighter circle.
      const b = Math.abs(p.bend) < 0.02 ? 0.02 * Math.sign(p.bend || 1) : p.bend;
      const sweep = Math.abs(b) * Math.PI * 1.6, r = len / sweep, dir = b > 0 ? 1 : -1;
      for (let i = 0; i <= n; i++) {
        const a = -sweep / 2 + (sweep * i) / n;
        out.push([r * Math.sin(a) * 1.15, dir * (r - r * Math.cos(a)) - dir * r * (1 - Math.cos(sweep / 2)) / 2]);
      }
      return out;
    }
    case 'wave': {
      const amp = p.bend * px * 0.7, waves = Math.max(1, Math.round(len / (px * 4)));
      for (let i = 0; i <= n; i++) { const x = -len * 0.6 + (len * 1.2 * i) / n; out.push([x, amp * Math.sin((x / (len * 1.2)) * waves * Math.PI * 2)]); }
      return out;
    }
    case 'circle': {
      // The text goes once round (the top, clockwise); inside when bend < 0.
      const r = len / (Math.PI * 2) + px * 0.3;
      for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 - Math.PI + (Math.PI * 2 * i) / n; out.push([r * Math.cos(a), r * Math.sin(a)]); }
      return p.bend < 0 ? out.reverse() : out;
    }
    case 'freehand': {
      const pts = p.points ?? [];
      const span = len * 1.15;
      return pts.map(([x, y]) => [x * span, y * span * 0.5]);
    }
  }
}

/** Draws text along a path at the overlay's place (`reveal`: part of the text shown, for typewriter). */
export function drawTextOnPath(ctx: Ctx2D, o: Overlay, W: number, H: number, reveal: number) {
  const p = o.path!;
  const px = o.size * H;
  const text = shown(o, o.text).replace(/\n/g, ' ');
  ctx.font = font(o, px);
  (ctx as CanvasRenderingContext2D).letterSpacing = '0px';
  const chars = [...text];
  const adv = chars.map((c) => ctx.measureText(c).width + o.tracking * px);
  const len = adv.reduce((a, b) => a + b, 0);
  const pts = pathPoints(p, len, px).map(([x, y]) => [x + o.x * W, y + o.y * H] as [number, number]);
  if (pts.length < 2) return;
  // Lengths along the path.
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  const total = acc[acc.length - 1]!;
  const at = (d: number): { x: number; y: number; a: number } => {
    d = Math.max(0, Math.min(total, d));
    let i = 1;
    while (i < acc.length - 1 && acc[i]! < d) i++;
    const f = (d - acc[i - 1]!) / Math.max(1e-9, acc[i]! - acc[i - 1]!);
    const [x0, y0] = pts[i - 1]!, [x1, y1] = pts[i]!;
    return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f, a: Math.atan2(y1 - y0, x1 - x0) };
  };
  let d = o.align === 'left' ? 0 : o.align === 'right' ? total - len : (total - len) / 2;
  const count = Math.round(chars.length * reveal);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  chars.forEach((c, i) => {
    if (i >= count) return;
    const mid = at(d + adv[i]! / 2);
    ctx.save();
    ctx.translate(mid.x, mid.y);
    ctx.rotate(mid.a);
    paint(ctx, o, c, 0, 0, px);
    ctx.restore();
    d += adv[i]!;
  });
}

/** Where text on a path sits in pixels. */
export function pathBox(o: Overlay, W: number, H: number): { x: number; y: number; w: number; h: number } {
  measure ??= new OffscreenCanvas(8, 8).getContext('2d');
  const px = o.size * H;
  measure!.font = font(o, px);
  const text = shown(o, o.text).replace(/\n/g, ' ');
  const len = measure!.measureText(text).width + text.length * o.tracking * px;
  const pts = pathPoints(o.path!, len, px);
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const x0 = Math.min(...xs) - px * 0.6, x1 = Math.max(...xs) + px * 0.6, y0 = Math.min(...ys) - px * 0.7, y1 = Math.max(...ys) + px * 0.7;
  return { x: o.x * W + x0, y: o.y * H + y0, w: x1 - x0, h: y1 - y0 };
}
