// How a clip's recorded values become the picture that gets graded. CPU reference for the WGSL
// below (keep them in step).
//
// The browser hands frames over already converted for display: code value → a display curve →
// sRGB, with Rec.2020 colours turned into Rec.709. That conversion is undone first, so curves work
// on what the camera wrote.

export type Rgb = [number, number, number];
export type InputCurve = 'none' | 'raw' | 'log' | 'hlg';

export interface InputColor {
  /** What the browser did: code^gamma, then sRGB encoding; 0 = nothing. */
  gamma: number;
  /** It also turned Rec.2020 colours into Rec.709. */
  browserWide: boolean;
  /** Decoded as if video range although the file holds full range. */
  rangeFix: boolean;
  /** none = as the browser shows it, raw = the recorded values, or a curve to undo. */
  curve: InputCurve;
  /** Log curves: value = log(light × (base − 1) + 1) / log(base). */
  base: number;
  /** Brightening that brings mid grey to its place (log curves), as a factor on light. */
  gain: number;
  /** The camera recorded Rec.2020 colours. */
  wide: boolean;
  /** What the browser does to ordinary video (so converted clips match it). */
  outGamma: number;
  /** Half a step of the recorded values as noise, against banding (0 = none). */
  dither: number;
}

export const PLAIN_INPUT: InputColor = { gamma: 0, browserWide: false, rangeFix: false, curve: 'none', base: 400, gain: 1, wide: false, outGamma: 0, dither: 0 };

/** Published curves: Protune Flat (base 113), GP-Log (400), GP-Log2 (600). */
export const LOG_BASE = { flat: 113, gplog: 400, gplog2: 600 } as const;
/** GoPro's published default for GP-Log2: +1.8 stops puts 18 % grey at its Rec.709 place. */
export const LOG_EV = 1.8;

const M709: Rgb[] = [[1.6605, -0.5876, -0.0729], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1188]];
const M2020: Rgb[] = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.088, 0.8956]];
const mul = (m: Rgb[], c: Rgb): Rgb => [0, 1, 2].map((i) => m[i]![0] * c[0] + m[i]![1] * c[1] + m[i]![2] * c[2]) as Rgb;
const each = (c: Rgb, f: (v: number) => number): Rgb => [f(c[0]), f(c[1]), f(c[2])];
const odd = (f: (v: number) => number) => (v: number) => (v < 0 ? -f(-v) : f(v));

export const srgbEncode = odd((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
export const srgbDecode = odd((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
export const rec709Encode = odd((v) => (v < 0.018 ? 4.5 * v : 1.099 * v ** 0.45 - 0.099));
export const logDecode = (v: number, base: number) => (base ** v - 1) / (base - 1);
export const logEncode = (l: number, base: number) => Math.log(Math.max(0, l) * (base - 1) + 1) / Math.log(base);

const HLG_A = 0.17883277, HLG_B = 1 - 4 * HLG_A, HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A);
/** HLG value → light from the scene (0–1). */
export const hlgDecode = odd((v) => (v <= 0.5 ? (v * v) / 3 : (Math.exp((v - HLG_C) / HLG_A) + HLG_B) / 12));
/** On a 1000-nit display; 203 nits (what BT.2408 calls white) becomes 1. */
const HLG_SCALE = 1000 / 203;
const L2020: Rgb = [0.2627, 0.678, 0.0593];

/** What the browser does to a recorded value (the opposite of `recorded`). */
export function browserSees(v: Rgb, i: Pick<InputColor, 'gamma' | 'browserWide'>): Rgb {
  if (!i.gamma) return v;
  let l = each(v, odd((x) => x ** i.gamma));
  if (i.browserWide) l = mul(M709, l);
  return each(l, srgbEncode);
}

/** The recorded values behind what the browser handed over. */
export function recorded(c: Rgb, i: Pick<InputColor, 'gamma' | 'browserWide' | 'rangeFix'>): Rgb {
  let v = c;
  if (i.gamma) {
    let l = each(c, srgbDecode);
    if (i.browserWide) l = mul(M2020, l);
    v = each(l, odd((x) => x ** (1 / i.gamma)));
  }
  if (i.rangeFix) {
    const y = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    v = each(v, (x) => 16 / 255 + y * (219 / 255) + (x - y) * (224 / 255));
  }
  return v;
}

/** The picture to grade (may exceed 1: highlights that can still be brought back). */
export function convertInput(c: Rgb, i: InputColor): Rgb {
  const v = recorded(c, i);
  if (i.curve === 'raw') return v;
  if (i.curve === 'none') return browserSees(v, { gamma: i.outGamma, browserWide: i.browserWide });
  if (i.curve === 'hlg') {
    const e = each(v, hlgDecode), y = Math.max(1e-6, L2020[0] * e[0] + L2020[1] * e[1] + L2020[2] * e[2]);
    const l = mul(M709, each(e, (x) => x * y ** 0.2 * HLG_SCALE));
    return each(l, i.outGamma ? srgbEncode : odd((x) => x ** (1 / 2.2)));
  }
  let l = each(v, (x) => logDecode(x, i.base) * i.gain);
  if (i.wide) l = mul(M709, l);
  return browserSees(each(l, rec709Encode), { gamma: i.outGamma, browserWide: false });
}

/** Eases values above 1 into the top of the range instead of cutting them off. */
export const SHOULDER = 0.8;
export const shoulder = (x: number) => (x <= SHOULDER ? x : SHOULDER + (1 - SHOULDER) * (1 - Math.exp(-(x - SHOULDER) / (1 - SHOULDER))));

/** The shader's uniforms (12 numbers). */
export function inputUniforms(i: InputColor | undefined, seed: number): number[] {
  if (!i || !needsConversion(i)) return new Array<number>(12).fill(0);
  return [
    1, i.gamma, i.browserWide ? 1 : 0, i.rangeFix ? 1 : 0,
    { none: 0, raw: 1, log: 2, hlg: 3 }[i.curve], i.base, i.gain, i.wide ? 1 : 0,
    i.outGamma, i.dither, seed, 0,
  ];
}

/** Whether anything has to be done at all (ordinary clips are left exactly as the browser shows them). */
export const needsConversion = (i: InputColor) => i.curve !== 'none' || i.rangeFix || i.gamma !== i.outGamma;
/** Whether the result needs more than 8 bits (it is stretched a lot, and reaches above white). */
export const highRange = (i: InputColor | undefined) => !!i && (i.curve === 'log' || i.curve === 'hlg');

export const INPUT_WGSL = /* wgsl */ `
fn sgn3(v : vec3f, p : f32) -> vec3f { return sign(v) * pow(abs(v), vec3f(p)); }
fn srgbEnc(v : vec3f) -> vec3f {
  let a = abs(v);
  return sign(v) * select(1.055 * pow(a, vec3f(1.0 / 2.4)) - 0.055, 12.92 * a, a <= vec3f(0.0031308));
}
fn srgbDec(v : vec3f) -> vec3f {
  let a = abs(v);
  return sign(v) * select(pow((a + 0.055) / 1.055, vec3f(2.4)), a / 12.92, a <= vec3f(0.04045));
}
fn rec709Enc(v : vec3f) -> vec3f {
  let a = abs(v);
  return sign(v) * select(1.099 * pow(a, vec3f(0.45)) - 0.099, 4.5 * a, a < vec3f(0.018));
}
fn to709(c : vec3f) -> vec3f {
  return vec3f(dot(c, vec3f(1.6605, -0.5876, -0.0729)), dot(c, vec3f(-0.1246, 1.1329, -0.0083)), dot(c, vec3f(-0.0182, -0.1006, 1.1188)));
}
fn to2020(c : vec3f) -> vec3f {
  return vec3f(dot(c, vec3f(0.6274, 0.3293, 0.0433)), dot(c, vec3f(0.0691, 0.9195, 0.0114)), dot(c, vec3f(0.0164, 0.0880, 0.8956)));
}
fn browserSees(v : vec3f, gamma : f32, wide : bool) -> vec3f {
  if (gamma < 0.01) { return v; }
  var l = sgn3(v, gamma);
  if (wide) { l = to709(l); }
  return srgbEnc(l);
}
fn noise3(p : vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}
var<private> pixel : vec2f;

// Recorded values → the picture to grade. CPU reference: inputColor.ts.
fn inputColor(c4 : vec4f) -> vec4f {
  if (u.col0.x < 0.5) { return c4; }
  var v = c4.rgb;
  if (u.col0.y > 0.01) {
    var l = srgbDec(v);
    if (u.col0.z > 0.5) { l = to2020(l); }
    v = sgn3(l, 1.0 / u.col0.y);
  }
  if (u.col0.w > 0.5) {
    let y = dot(v, vec3f(0.2126, 0.7152, 0.0722));
    v = vec3f(16.0 / 255.0 + y * (219.0 / 255.0)) + (v - y) * (224.0 / 255.0);
  }
  if (u.col2.y > 0.0) {
    // The same for all three, so it doesn't show as colour.
    v += vec3f(noise3(vec3f(pixel, u.col2.z)) + noise3(vec3f(pixel.yx + 17.0, u.col2.z + 7.0)) - 1.0) * u.col2.y;
  }
  let curve = u.col1.x;
  let out = u.col2.x;
  if (curve < 0.5) { return vec4f(browserSees(v, out, u.col0.z > 0.5), 1.0); }
  if (curve < 1.5) { return vec4f(v, 1.0); }
  if (curve < 2.5) {
    var l = (pow(vec3f(u.col1.y), v) - 1.0) / (u.col1.y - 1.0) * u.col1.z;
    if (u.col1.w > 0.5) { l = to709(l); }
    return vec4f(browserSees(rec709Enc(l), out, false), 1.0);
  }
  let a = abs(v);
  let e = sign(v) * select((exp((a - 0.55991073) / 0.17883277) + 0.28466892) / 12.0, a * a / 3.0, a <= vec3f(0.5));
  let y = max(1e-6, dot(e, vec3f(0.2627, 0.6780, 0.0593)));
  let l = to709(e * pow(y, 0.2) * 4.926108);
  if (out < 0.01) { return vec4f(sgn3(l, 1.0 / 2.2), 1.0); }
  return vec4f(srgbEnc(l), 1.0);
}
`;
