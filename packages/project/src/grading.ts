// Pro grading (milestone 4): colour wheels, curves, an HSL qualifier, power-window grades, noise
// reduction and our own film looks. Pure maths, shared by the finish shader's uniforms
// (packages/media360/src/finish.ts) and the tests; the shader does the same sums per pixel.

// --- Colour wheels ------------------------------------------------------------------------------

/**
 * One wheel: where its puck sits on the colour disc (x, y within a circle of radius 1; right is
 * blue, up is red, as on a vectorscope) and its master ring (−1…1, brightness).
 */
export interface Wheel { x: number; y: number; master: number }
export type WheelName = 'lift' | 'gamma' | 'gain' | 'offset';
/** Lift moves the blacks, gamma the mid-tones, gain the whites, offset everything. */
export type Wheels = Record<WheelName, Wheel>;

export const NEUTRAL_WHEEL: Wheel = { x: 0, y: 0, master: 0 };
export const NEUTRAL_WHEELS: Wheels = { lift: NEUTRAL_WHEEL, gamma: NEUTRAL_WHEEL, gain: NEUTRAL_WHEEL, offset: NEUTRAL_WHEEL };
export const WHEEL_NAMES: [WheelName, string, string][] = [
  ['lift', 'Lift', 'Shadows'],
  ['gamma', 'Gamma', 'Mid-tones'],
  ['gain', 'Gain', 'Highlights'],
  ['offset', 'Offset', 'Everything'],
];

const isNeutralWheel = (w: Wheel) => Math.abs(w.x) < 1e-4 && Math.abs(w.y) < 1e-4 && Math.abs(w.master) < 1e-4;
export const wheelsNeutral = (w: Wheels | undefined) => !w || (Object.keys(NEUTRAL_WHEELS) as WheelName[]).every((k) => isNeutralWheel(w[k]));

/** A puck position as a colour push with no brightness of its own (Rec.709 colour difference), per channel. */
export function puckRgb(x: number, y: number): [number, number, number] {
  // u (blue difference) to the right, v (red difference) up; halved so the strongest push is about ±0.9.
  const u = x * 0.5, v = y * 0.5;
  return [1.5748 * v, -0.1873 * u - 0.4681 * v, 1.8556 * u];
}

/** What the shader multiplies, adds and raises by, per channel (red, green, blue). */
export interface WheelUniforms {
  /** Added to the blacks (white stays put). */
  lift: [number, number, number];
  /** Exponent (1 = unchanged; below 1 brightens the mid-tones). */
  gamma: [number, number, number];
  /** Multiplier. */
  gain: [number, number, number];
  /** Added to everything. */
  offset: [number, number, number];
}

export function wheelUniforms(w: Wheels): WheelUniforms {
  const ch = (k: WheelName, m: number, c: number) => { const p = puckRgb(w[k].x, w[k].y); return [0, 1, 2].map((i) => w[k].master * m + p[i]! * c) as [number, number, number]; };
  return {
    lift: ch('lift', 0.3, 0.2),
    gamma: ch('gamma', 0.8, 0.5).map((v) => 2 ** -v) as [number, number, number],
    gain: ch('gain', 1, 0.6).map((v) => 2 ** v) as [number, number, number],
    offset: ch('offset', 0.2, 0.12),
  };
}

/** The wheels applied to one colour (0–1 display values), exactly as the shader does. */
export function applyWheels(rgb: [number, number, number], u: WheelUniforms): [number, number, number] {
  return rgb.map((v, i) => {
    let c = v * (1 - u.lift[i]!) + u.lift[i]!;
    c *= u.gain[i]!;
    c = Math.max(0, c) ** u.gamma[i]!;
    return c + u.offset[i]!;
  }) as [number, number, number];
}

export function mixWheels(a: Wheels | undefined, b: Wheels | undefined, f: number): Wheels | undefined {
  if (!a && !b) return undefined;
  const A = a ?? NEUTRAL_WHEELS, B = b ?? NEUTRAL_WHEELS;
  const out = {} as Wheels;
  for (const k of Object.keys(NEUTRAL_WHEELS) as WheelName[]) out[k] = { x: A[k].x + (B[k].x - A[k].x) * f, y: A[k].y + (B[k].y - A[k].y) * f, master: A[k].master + (B[k].master - A[k].master) * f };
  return out;
}

/** Keeps a puck inside its disc. */
export function cleanWheel(w: Partial<Wheel> | undefined): Wheel {
  let x = Number(w?.x) || 0, y = Number(w?.y) || 0;
  const r = Math.hypot(x, y);
  if (r > 1) { x /= r; y /= r; }
  return { x, y, master: Math.max(-1, Math.min(1, Number(w?.master) || 0)) };
}
export function cleanWheels(w: unknown): Wheels | undefined {
  if (!w || typeof w !== 'object') return undefined;
  const o = w as Partial<Wheels>;
  const out = { lift: cleanWheel(o.lift), gamma: cleanWheel(o.gamma), gain: cleanWheel(o.gain), offset: cleanWheel(o.offset) };
  return wheelsNeutral(out) ? undefined : out;
}

// --- Curves -------------------------------------------------------------------------------------

export type CurvePoints = [number, number][];
export type GradeCurveName = 'master' | 'r' | 'g' | 'b' | 'hueSat' | 'hueHue' | 'lumSat';
/**
 * Tone curves (master, then red, green and blue: input → output, 0–1) and curves that change
 * colour by hue or brightness. For those, y = 0.5 leaves the picture alone: hue vs saturation and
 * luma vs saturation multiply saturation by 2y; hue vs hue turns the hue by up to ±60°.
 */
export type GradeCurves = Record<GradeCurveName, CurvePoints>;

const LINE: CurvePoints = [[0, 0], [1, 1]];
const FLAT: CurvePoints = [[0, 0.5], [1, 0.5]];
export const NEUTRAL_CURVES: GradeCurves = { master: LINE, r: LINE, g: LINE, b: LINE, hueSat: FLAT, hueHue: FLAT, lumSat: FLAT };
export const CURVE_NAMES: [GradeCurveName, string][] = [['master', 'Luma'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue'], ['hueSat', 'Hue vs sat'], ['hueHue', 'Hue vs hue'], ['lumSat', 'Luma vs sat']];
/** Curves whose x is a hue: they wrap round (red is at both ends). */
export const isHueCurve = (n: GradeCurveName) => n === 'hueSat' || n === 'hueHue';
export const isToneCurve = (n: GradeCurveName) => n === 'master' || n === 'r' || n === 'g' || n === 'b';

/** How many entries each baked row has. */
export const CURVE_SIZE = 256;
/** Hue vs hue at the top or bottom turns the hue this far (turns). */
export const HUE_SHIFT_MAX = 1 / 6;

const neutralFlat = (c: CurvePoints) => c.every(([, y]) => Math.abs(y - 0.5) < 1e-4);
const neutralLine = (c: CurvePoints) => c.every(([x, y]) => Math.abs(x - y) < 1e-4);
export const curveNeutral = (n: GradeCurveName, c: CurvePoints) => (isToneCurve(n) ? neutralLine(c) : neutralFlat(c));
export function curvesNeutral(c: GradeCurves | undefined): boolean {
  return !c || (Object.keys(NEUTRAL_CURVES) as GradeCurveName[]).every((k) => curveNeutral(k, c[k]));
}
/** Which kinds of curve change anything: tone curves, and colour curves. */
export function curvesUsed(c: GradeCurves | undefined): { tone: boolean; color: boolean } {
  if (!c) return { tone: false, color: false };
  return {
    tone: (['master', 'r', 'g', 'b'] as GradeCurveName[]).some((k) => !curveNeutral(k, c[k])),
    color: (['hueSat', 'hueHue', 'lumSat'] as GradeCurveName[]).some((k) => !curveNeutral(k, c[k])),
  };
}

/** Points sorted by x, inside 0–1, at least two, none on top of another. */
export function cleanPoints(raw: unknown, fallback: CurvePoints, hue = false): CurvePoints {
  if (!Array.isArray(raw)) return fallback;
  const pts = raw
    .filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .map((p) => [Math.max(0, Math.min(1, Number(p[0]))), Math.max(0, Math.min(1, Number(p[1])))] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: CurvePoints = [];
  for (const p of pts) if (!out.length || p[0] - out[out.length - 1]![0] > 0.004) out.push(p);
  if (out.length < (hue ? 1 : 2)) return fallback;
  return out.slice(0, 16);
}
export function cleanCurves(raw: unknown): GradeCurves | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Partial<GradeCurves>;
  const out = {} as GradeCurves;
  for (const k of Object.keys(NEUTRAL_CURVES) as GradeCurveName[]) out[k] = cleanPoints(o[k], NEUTRAL_CURVES[k], isHueCurve(k));
  return curvesNeutral(out) ? undefined : out;
}

/**
 * A tone curve's value at x: a smooth curve through the points that never overshoots between
 * them (monotone cubic, Fritsch–Carlson), flat beyond the first and last point.
 */
export function toneAt(pts: CurvePoints, x: number): number {
  const n = pts.length;
  if (n === 1) return pts[0]![1];
  if (x <= pts[0]![0]) return pts[0]![1];
  if (x >= pts[n - 1]![0]) return pts[n - 1]![1];
  let i = 0;
  while (pts[i + 1]![0] < x) i++;
  const d: number[] = [];
  for (let k = 0; k < n - 1; k++) d.push((pts[k + 1]![1] - pts[k]![1]) / (pts[k + 1]![0] - pts[k]![0]));
  const m: number[] = pts.map((_, k) => (k === 0 ? d[0]! : k === n - 1 ? d[n - 2]! : d[k - 1]! * d[k]! <= 0 ? 0 : (d[k - 1]! + d[k]!) / 2));
  for (let k = 0; k < n - 1; k++) {
    if (Math.abs(d[k]!) < 1e-12) { m[k] = 0; m[k + 1] = 0; continue; }
    const a = m[k]! / d[k]!, b = m[k + 1]! / d[k]!, s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[k] = t * a * d[k]!; m[k + 1] = t * b * d[k]!; }
  }
  const [x0, y0] = pts[i]!, [x1, y1] = pts[i + 1]!, h = x1 - x0, t = (x - x0) / h;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m[i]! + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m[i + 1]!;
}

/** A hue curve's value at hue x (0–1, wrapping): a smooth closed curve through the points. */
export function hueAt(pts: CurvePoints, x: number): number {
  const n = pts.length;
  if (n === 1) return pts[0]![1];
  // Copies a turn either side, so the curve joins up smoothly across red.
  const ring: CurvePoints = [...pts.slice(-2).map(([a, b]) => [a - 1, b] as [number, number]), ...pts, ...pts.slice(0, 2).map(([a, b]) => [a + 1, b] as [number, number])];
  const xx = ((x % 1) + 1) % 1;
  let i = 0;
  while (ring[i + 1]![0] < xx) i++;
  // Catmull–Rom through the neighbours (uneven spacing handled by finite differences).
  const p0 = ring[Math.max(0, i - 1)]!, p1 = ring[i]!, p2 = ring[i + 1]!, p3 = ring[Math.min(ring.length - 1, i + 2)]!;
  const h = p2[0] - p1[0], t = (xx - p1[0]) / h;
  const m1 = ((p2[1] - p0[1]) / (p2[0] - p0[0])) * h, m2 = ((p3[1] - p1[1]) / (p3[0] - p1[0])) * h;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2;
}

/**
 * The curves as two rows of CURVE_SIZE RGBA entries (the 1D LUT texture the shader reads):
 * row 0 = the tone curves (master, then each channel) and luma vs sat; row 1 = hue vs sat and
 * hue vs hue. Values 0–1.
 */
export function bakeCurves(c: GradeCurves): Float32Array {
  const out = new Float32Array(CURVE_SIZE * 2 * 4);
  for (let i = 0; i < CURVE_SIZE; i++) {
    const x = i / (CURVE_SIZE - 1);
    const m = Math.max(0, Math.min(1, toneAt(c.master, x)));
    const o = i * 4;
    out[o] = Math.max(0, Math.min(1, toneAt(c.r, m)));
    out[o + 1] = Math.max(0, Math.min(1, toneAt(c.g, m)));
    out[o + 2] = Math.max(0, Math.min(1, toneAt(c.b, m)));
    out[o + 3] = Math.max(0, Math.min(1, toneAt(c.lumSat, x)));
    const q = (CURVE_SIZE + i) * 4;
    // (Hue rows sample the closed curve, so the first and last entries meet at red.)
    out[q] = Math.max(0, Math.min(1, hueAt(c.hueSat, x)));
    out[q + 1] = Math.max(0, Math.min(1, hueAt(c.hueHue, x)));
    out[q + 2] = 0.5;
    out[q + 3] = 1;
  }
  return out;
}

/** Adds a point to a curve (or moves the one near x there). */
export function setCurvePoint(pts: CurvePoints, x: number, y: number, near = 0.03): CurvePoints {
  const i = pts.findIndex((p) => Math.abs(p[0] - x) < near);
  const next: CurvePoints = i >= 0 ? pts.map((p, k) => (k === i ? [x, y] : p)) : [...pts, [x, y]];
  return next.sort((a, b) => a[0] - b[0]);
}

// --- HSL qualifier ------------------------------------------------------------------------------

/**
 * Picks out part of the picture by its colour (hue, saturation, brightness) and changes only
 * that: a secondary correction, like making the sky bluer without touching the trail.
 */
export interface Qualifier {
  /** Centre hue, degrees (0 red, 120 green, 240 blue). */
  hue: number;
  /** How far either side of it counts, degrees (180 = every hue). */
  hueWidth: number;
  /** Saturation and brightness ranges, 0–1. */
  sat: [number, number];
  lum: [number, number];
  /** Soft edges, 0–1. */
  soft: number;
  /** Changes everything except what is picked. */
  invert: boolean;
  /** The change: stops, saturation (−1…1), hue turn (degrees). */
  exposure: number;
  saturation: number;
  hueShift: number;
  off?: boolean;
}

export const DEFAULT_QUALIFIER: Qualifier = { hue: 210, hueWidth: 30, sat: [0.15, 1], lum: [0.1, 1], soft: 0.4, invert: false, exposure: 0, saturation: 0.3, hueShift: 0 };
export const QUALIFIER_PRESETS: [string, Partial<Qualifier>][] = [
  ['Sky', { hue: 210, hueWidth: 28, sat: [0.12, 1], lum: [0.3, 1] }],
  ['Greenery', { hue: 95, hueWidth: 40, sat: [0.12, 1], lum: [0.05, 0.95] }],
  ['Skin', { hue: 22, hueWidth: 16, sat: [0.12, 0.7], lum: [0.15, 0.95] }],
  ['Dirt', { hue: 32, hueWidth: 22, sat: [0.08, 0.6], lum: [0.05, 0.8] }],
  ['Water', { hue: 190, hueWidth: 30, sat: [0.1, 1], lum: [0.05, 1] }],
];

/** RGB (0–1) to hue (0–1 turns), saturation and value, as the shader computes it. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (((h / 6) % 1) + 1) % 1;
  return [h, mx > 1e-6 ? d / mx : 0, mx];
}
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const k = (n: number) => (n + h * 6) % 6;
  const f = (n: number) => v - v * s * Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return [f(5), f(3), f(1)];
}

const smoothstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-6))); return t * t * (3 - 2 * t); };

/** The qualifier's uniforms: [hue (turns), half width (turns), soft, invert, satLo, satHi, lumLo, lumHi, exposure, saturation, hue shift (turns), 0]. */
export function qualifierUniforms(q: Qualifier): number[] {
  return [((q.hue / 360) % 1 + 1) % 1, Math.min(0.5, q.hueWidth / 360), q.soft, q.invert ? 1 : 0, q.sat[0], q.sat[1], q.lum[0], q.lum[1], q.exposure, q.saturation, q.hueShift / 360, 0];
}

/** How much of a colour the qualifier picks (0–1), the same sums as the shader. */
export function qualifierMatte(rgb: [number, number, number], q: Qualifier): number {
  const [h, s] = rgbToHsv(...rgb), l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const [hc, hw, soft, inv, s0, s1, l0, l1] = qualifierUniforms(q);
  const sw = Math.max(soft!, 0.001);
  const dh = Math.abs(((h - hc! + 0.5) % 1 + 1) % 1 - 0.5);
  const mh = hw! >= 0.5 ? 1 : 1 - smoothstep(hw!, hw! + sw * 0.12, dh);
  const ms = smoothstep(s0! - sw * 0.15, s0!, s) * (1 - smoothstep(s1!, s1! + sw * 0.15, s));
  const ml = smoothstep(l0! - sw * 0.15, l0!, l) * (1 - smoothstep(l1!, l1! + sw * 0.15, l));
  const m = mh * ms * ml;
  return inv ? 1 - m : m;
}

export function cleanQualifier(raw: unknown): Qualifier | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Partial<Qualifier>;
  const n = (v: unknown, d: number, a: number, b: number) => Math.max(a, Math.min(b, Number.isFinite(Number(v)) ? Number(v) : d));
  const pair = (v: unknown, d: [number, number]): [number, number] => {
    const a = Array.isArray(v) ? v : d;
    const lo = n(a[0], d[0], 0, 1), hi = n(a[1], d[1], 0, 1);
    return [Math.min(lo, hi), Math.max(lo, hi)];
  };
  const D = DEFAULT_QUALIFIER;
  return {
    hue: n(o.hue, D.hue, 0, 360), hueWidth: n(o.hueWidth, D.hueWidth, 1, 180), sat: pair(o.sat, D.sat), lum: pair(o.lum, D.lum), soft: n(o.soft, D.soft, 0, 1),
    invert: !!o.invert, exposure: n(o.exposure, 0, -3, 3), saturation: n(o.saturation, 0, -1, 1), hueShift: n(o.hueShift, 0, -180, 180), ...(o.off ? { off: true } : {}),
  };
}

// --- Power windows: a grade inside a mask --------------------------------------------------------

/** The grade a colour mask (power window) applies inside its shape. */
export interface WindowGrade {
  /** Stops, −3…3. */
  exposure: number;
  /** −1…1 */
  contrast: number;
  saturation: number;
  temperature: number;
}
export const NEUTRAL_WINDOW: WindowGrade = { exposure: 0, contrast: 0, saturation: 0, temperature: 0 };
export function cleanWindowGrade(raw: unknown): WindowGrade {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<WindowGrade>;
  const n = (v: unknown, a: number, b: number) => Math.max(a, Math.min(b, Number(v) || 0));
  return { exposure: n(o.exposure, -3, 3), contrast: n(o.contrast, -1, 1), saturation: n(o.saturation, -1, 1), temperature: n(o.temperature, -1, 1) };
}

// --- Noise reduction ----------------------------------------------------------------------------

/** 0 (off) … 1 (strong) each. */
export interface Denoise {
  /** Within each frame, keeping edges. */
  spatial: number;
  /** Across frames, where nothing moved. */
  temporal: number;
}
export const denoiseOn = (d: Denoise | undefined) => !!d && (d.spatial > 0.001 || d.temporal > 0.001);
/** Frames the temporal filter looks back over (the newest included), 1 = off. */
export const denoiseFrames = (d: Denoise | undefined) => (d && d.temporal > 0.001 ? 2 + Math.round(Math.min(1, d.temporal) * 4) : 1);
export function cleanDenoise(raw: unknown): Denoise | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Partial<Denoise>;
  const d = { spatial: Math.max(0, Math.min(1, Number(o.spatial) || 0)), temporal: Math.max(0, Math.min(1, Number(o.temporal) || 0)) };
  return denoiseOn(d) ? d : undefined;
}

// --- Film looks: our own LUTs ---------------------------------------------------------------------

export interface FilmChoice {
  /** One of FILM_LOOKS. */
  look: string;
  /** Strength, 0–1. */
  mix: number;
}

/** Each film look as a recipe; `filmLut` turns one into a 3D LUT. */
interface FilmRecipe {
  name: string;
  hint: string;
  /** Contrast S-curve strength, black lift, white roll-off. */
  contrast: number; lift: number; roll: number;
  /** Saturation, and extra saturation kept out of the highlights. */
  sat: number;
  /** Colour pushed into the shadows and highlights (RGB offsets). */
  shadows: [number, number, number];
  highs: [number, number, number];
  /** Channel mixing: each output channel takes this share of the others (cross-talk). */
  cross: number;
  /** Black and white. */
  mono?: boolean;
  /** Bleach bypass: a mono copy laid over the colour. */
  bleach?: number;
}

const RECIPES: FilmRecipe[] = [
  { name: 'Warm print', hint: 'Soft, warm print film with creamy highlights', contrast: 0.35, lift: 0.03, roll: 0.25, sat: 0.95, shadows: [0.01, 0.005, -0.015], highs: [0.04, 0.015, -0.03], cross: 0.04 },
  { name: 'Teal and orange', hint: 'Cool shadows, warm skin and highlights', contrast: 0.4, lift: 0.015, roll: 0.15, sat: 1.1, shadows: [-0.04, 0.01, 0.05], highs: [0.05, 0.015, -0.04], cross: 0 },
  { name: 'Faded 70s', hint: 'Lifted blacks, yellowed whites, muted colour', contrast: 0.15, lift: 0.09, roll: 0.3, sat: 0.75, shadows: [0.02, 0.02, 0.04], highs: [0.04, 0.03, -0.06], cross: 0.08 },
  { name: 'Slide film', hint: 'Deep blacks and rich, saturated colour', contrast: 0.6, lift: 0, roll: 0.1, sat: 1.3, shadows: [0, -0.005, 0.02], highs: [0.01, 0.01, -0.01], cross: 0 },
  { name: 'Bleach bypass', hint: 'Silvery, gritty and low in colour', contrast: 0.55, lift: 0.01, roll: 0.15, sat: 0.6, shadows: [0, 0, 0.01], highs: [0.01, 0.01, 0], cross: 0, bleach: 0.55 },
  { name: 'Cross process', hint: 'Greenish shadows, yellow highlights, punchy', contrast: 0.5, lift: 0.02, roll: 0.1, sat: 1.15, shadows: [-0.02, 0.04, 0.06], highs: [0.04, 0.05, -0.08], cross: 0.06 },
  { name: 'Night city', hint: 'Cool and contrasty with neon colour', contrast: 0.45, lift: 0.0, roll: 0.2, sat: 1.15, shadows: [-0.01, 0, 0.05], highs: [0.02, -0.01, 0.03], cross: 0 },
  { name: 'Silver mono', hint: 'Black and white with deep blacks', contrast: 0.5, lift: 0.01, roll: 0.2, sat: 0, shadows: [0, 0, 0], highs: [0, 0, 0], cross: 0, mono: true },
  { name: 'Sepia', hint: 'Warm-toned black and white', contrast: 0.3, lift: 0.04, roll: 0.25, sat: 0, shadows: [0.03, 0.0, -0.04], highs: [0.05, 0.02, -0.06], cross: 0, mono: true },
];

export const FILM_LOOKS: [string, string][] = RECIPES.map((r) => [r.name, r.hint]);

/** One colour through a film look (0–1 in and out). */
export function filmColor(name: string, rgb: [number, number, number]): [number, number, number] {
  const r = RECIPES.find((x) => x.name === name);
  if (!r) return rgb;
  let [R, G, B] = rgb;
  // Cross-talk between the dye layers.
  if (r.cross) { const k = r.cross; [R, G, B] = [R * (1 - 2 * k) + k * (G + B), G * (1 - 2 * k) + k * (R + B), B * (1 - 2 * k) + k * (R + G)]; }
  let l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  if (r.mono) { R = G = B = l; }
  // Saturation, a little less in the brightest parts (film desaturates as it nears white).
  const sat = r.sat * (1 - 0.3 * smoothstep(0.7, 1, l));
  [R, G, B] = [l + (R - l) * sat, l + (G - l) * sat, l + (B - l) * sat];
  if (r.bleach) { const m = l; const ov = (a: number) => (m < 0.5 ? 2 * a * m : 1 - 2 * (1 - a) * (1 - m)); [R, G, B] = [R + (ov(R) - R) * r.bleach, G + (ov(G) - G) * r.bleach, B + (ov(B) - B) * r.bleach]; }
  const tone = (v: number) => {
    // S-curve around mid grey, a soft shoulder, then lifted blacks.
    const s = v + r.contrast * (v - 0.5) * (1 - Math.abs(2 * v - 1)) * 1.2;
    const shoulder = s > 1 - r.roll ? 1 - r.roll + r.roll * (1 - Math.exp(-(s - (1 - r.roll)) / Math.max(1e-3, r.roll))) : s;
    return r.lift + shoulder * (1 - r.lift);
  };
  l = Math.max(0, Math.min(1, 0.2126 * R + 0.7152 * G + 0.0722 * B));
  const sh = 1 - smoothstep(0, 0.55, l), hi = smoothstep(0.45, 1, l);
  const out = [R, G, B].map((v, i) => Math.max(0, Math.min(1, tone(Math.max(0, Math.min(1.2, v))) + r.shadows[i]! * sh + r.highs[i]! * hi)));
  return out as [number, number, number];
}

/** A film look as a 3D LUT: size³ RGB triples, red fastest (like a .cube file). */
export function filmLut(name: string, size = 33): { size: number; data: Float32Array } {
  const data = new Float32Array(size * size * size * 3);
  let o = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const c = filmColor(name, [r / (size - 1), g / (size - 1), b / (size - 1)]);
    data[o++] = c[0]; data[o++] = c[1]; data[o++] = c[2];
  }
  return { size, data };
}

/** A film look as the text of a .cube file (to use it in other apps). */
export function filmCube(name: string, size = 33): string {
  const { data } = filmLut(name, size);
  const lines = [`TITLE "${name}"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let i = 0; i < data.length; i += 3) lines.push(`${data[i]!.toFixed(6)} ${data[i + 1]!.toFixed(6)} ${data[i + 2]!.toFixed(6)}`);
  return lines.join('\n') + '\n';
}

export function cleanFilm(raw: unknown): FilmChoice | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Partial<FilmChoice>;
  if (!RECIPES.some((r) => r.name === o.look)) return undefined;
  return { look: o.look!, mix: Math.max(0, Math.min(1, Number.isFinite(Number(o.mix)) ? Number(o.mix) : 1)) };
}

/** Clip-level grading switched off to compare (clip.off keys). */
export type GradingOffKey = 'wheels' | 'curves' | 'qualifier' | 'denoise' | 'film';
