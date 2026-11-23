// Making the two lenses of a 360 camera look alike: small corrections for each, and working them
// out from the strip of the world both lenses see. CPU reference for the WGSL below.

import type { Rgb } from './inputColor';

/** Corrections for one lens. All 0 = as recorded. */
export interface LensAdjust {
  /** Stops, −2…2. */
  brightness: number;
  contrast: number;
  /** Takes a veil of haze away (a dirty or fogged lens); negative adds one. −1…1. */
  haze: number;
  saturation: number;
  warmth: number;
  tint: number;
  /** Local contrast, 0…1, and fine sharpness, 0…2. */
  clarity: number;
  sharpness: number;
}
export const NO_LENS_ADJUST: LensAdjust = { brightness: 0, contrast: 0, haze: 0, saturation: 0, warmth: 0, tint: 0, clarity: 0, sharpness: 0 };
export interface LensPair { front?: Partial<LensAdjust>; back?: Partial<LensAdjust> }

const KEYS = Object.keys(NO_LENS_ADJUST) as (keyof LensAdjust)[];
export const lensAdjusted = (a: Partial<LensAdjust> | undefined) => !!a && KEYS.some((k) => Math.abs(a[k] ?? 0) > 1e-6);

/** How strong a full haze setting is: share of white lying over the picture. */
const VEIL = 0.35;
const luma = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const pw = (v: number, p: number) => (v < 0 ? -((-v) ** p) : v ** p);

/** Colour part of a lens's correction (clarity and sharpness need the neighbouring pixels). */
export function lensColor(c: Rgb, a: Partial<LensAdjust>): Rgb {
  const { brightness = 0, contrast = 0, haze = 0, saturation = 0, warmth = 0, tint = 0 } = a;
  const wb: Rgb = [(1 + 0.25 * warmth) * (1 + 0.08 * tint), 1 - 0.18 * tint, (1 - 0.25 * warmth) * (1 + 0.08 * tint)];
  const g = 2 ** brightness / luma(wb), v = haze * VEIL;
  let e = c.map((x, i) => {
    const lit = pw(pw(x, 2.2) * g * wb[i]!, 1 / 2.2);
    return (((v >= 0 ? (lit - v) / (1 - v) : lit * (1 + v) - v) - 0.5) * (1 + contrast)) + 0.5;
  }) as Rgb;
  const l = luma(e);
  e = e.map((x) => Math.max(0, l + (x - l) * (1 + saturation))) as Rgb;
  return e;
}

/** The shader's uniforms: front, back (2 × 8 numbers). */
export function lensUniforms(p: LensPair | undefined): number[] {
  const one = (a: Partial<LensAdjust> | undefined) => [a?.brightness ?? 0, a?.contrast ?? 0, (a?.haze ?? 0) * VEIL, a?.saturation ?? 0, a?.warmth ?? 0, a?.tint ?? 0, lensAdjusted(a) ? 1 : 0, 0];
  return [...one(p?.front), ...one(p?.back)];
}

export const LENS_WGSL = /* wgsl */ `
fn lensColor(c : vec3f, a : vec4f, b : vec4f) -> vec3f {
  if (b.z < 0.5) { return c; }
  let wb = vec3f((1.0 + 0.25 * b.x) * (1.0 + 0.08 * b.y), 1.0 - 0.18 * b.y, (1.0 - 0.25 * b.x) * (1.0 + 0.08 * b.y));
  let g = exp2(a.x) / dot(wb, vec3f(0.2126, 0.7152, 0.0722));
  var e = sgn3(sgn3(c, 2.2) * g * wb, 1.0 / 2.2);
  if (a.z >= 0.0) { e = (e - a.z) / (1.0 - a.z); } else { e = e * (1.0 + a.z) - a.z; }
  e = (e - 0.5) * (1.0 + a.y) + 0.5;
  let l = dot(e, vec3f(0.2126, 0.7152, 0.0722));
  return max(vec3f(0.0), l + (e - l) * (1.0 + a.w));
}
// A sample from one lens, converted and corrected.
fn fromLens(stream : f32, uv : vec2f, back : bool) -> vec3f {
  let c = inputColor(sampleStreams(stream, uv)).rgb;
  if (back) { return lensColor(c, u.lensB0, u.lensB1); }
  return lensColor(c, u.lensF0, u.lensF1);
}
`;

// --- Working it out ------------------------------------------------------------------------------------

/** The same spot as each lens shows it (averages over a few pixels, 0–1). */
export interface LensSample { front: Rgb; back: Rgb; /** How much is going on there (local contrast) in each. */ busy: [number, number] }

export interface LensMatch {
  /** Which lens was corrected. */
  lens: 'front' | 'back';
  adjust: Partial<LensAdjust>;
  /** Average difference between the lenses (of 255), before and after. */
  before: number;
  after: number;
  samples: number;
}

const FIT: [keyof LensAdjust, number, number, number][] = [
  ['brightness', -1.5, 1.5, 0.25], ['haze', -0.6, 0.8, 0.12], ['contrast', -0.5, 0.5, 0.12], ['warmth', -0.6, 0.6, 0.12], ['tint', -0.6, 0.6, 0.12], ['saturation', -0.6, 0.6, 0.15],
];

/**
 * Corrections that make one lens look like the other, from samples of what both see. The lens
 * with less contrast (the fogged or dirty one) is corrected, unless told otherwise. Spots that
 * disagree wildly (near things, seen from two places) count little. Null when there is too
 * little to go by.
 */
export function matchLenses(samples: LensSample[], which?: 'front' | 'back'): LensMatch | null {
  const ok = samples.filter((s) => [...s.front, ...s.back].every((v) => v > 0.012 && v < 0.985));
  if (ok.length < 40) return null;
  const med = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1]!;
  const busy = med(ok.map((s) => Math.log((s.busy[1] + 0.004) / (s.busy[0] + 0.004))));
  // Less contrast, or much lighter blacks: that lens has the veil.
  const dark = (k: 'front' | 'back') => { const v = ok.map((s) => luma(s[k])).sort((a, b) => a - b); return v[Math.floor(v.length * 0.1)]!; };
  const score = busy - 3 * (dark('back') - dark('front'));
  const lens = which ?? (score > 0 ? 'front' : 'back');
  const from = ok.map((s) => s[lens]), to = ok.map((s) => s[lens === 'front' ? 'back' : 'front']);
  const cost = (a: Partial<LensAdjust>, soft: number) => {
    let sum = 0;
    for (let i = 0; i < from.length; i++) {
      const c = lensColor(from[i]!, a), t = to[i]!;
      for (let k = 0; k < 3; k++) { const d = Math.abs(c[k]! - t[k]!); sum += d < soft ? (d * d) / (2 * soft) : d - soft / 2 > 3 * soft ? 2.5 * soft + 0.1 * (d - 3.5 * soft) : d - soft / 2; }
    }
    // (A gentle pull towards no change, so what can't be told apart stays alone.)
    const reg = 0.0006 * ((a.brightness ?? 0) ** 2 + (a.contrast ?? 0) ** 2 * 2 + (a.haze ?? 0) ** 2 + (a.saturation ?? 0) ** 2 + (a.warmth ?? 0) ** 2 + (a.tint ?? 0) ** 2);
    return sum / (from.length * 3) + reg;
  };
  let a: Partial<LensAdjust> = {}, best = cost(a, 0.04);
  for (const s0 of [1, 0.5, 0.25, 0.12, 0.06, 0.03]) {
    for (let round = 0; round < 8; round++) {
      let moved = false;
      for (const [k, lo, hi, step] of FIT) for (const sg of [1, -1]) {
        const v = Math.max(lo, Math.min(hi, (a[k] ?? 0) + sg * step * s0)), n = { ...a, [k]: v }, c = cost(n, 0.04);
        if (c < best - 1e-7) { best = c; a = n; moved = true; }
      }
      if (!moved) break;
    }
  }
  const diff = (p: Partial<LensAdjust>) => med(from.map((c, i) => { const q = lensColor(c, p); return (Math.abs(q[0] - to[i]![0]) + Math.abs(q[1] - to[i]![1]) + Math.abs(q[2] - to[i]![2])) / 3; })) * 255;
  // A lens that also lost its fine detail gets some clarity back.
  const soft = lens === 'front' ? busy : -busy, veiled = Math.log(1 / (1 - Math.max(0, (a.haze ?? 0) * VEIL))) + Math.log(1 + (a.contrast ?? 0));
  const clarity = Math.max(0, Math.min(0.6, (soft - Math.max(0, veiled) - 0.08) * 0.8));
  const adjust = Object.fromEntries(Object.entries({ ...a, ...(clarity > 0.04 ? { clarity } : {}) }).map(([k, v]) => [k, Math.round(v * 100) / 100]).filter(([, v]) => v !== 0)) as Partial<LensAdjust>;
  return { lens, adjust, before: diff({}), after: diff(adjust), samples: ok.length };
}
