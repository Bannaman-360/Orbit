// The lens a regular (non-360) clip was shot through. It turns the clip into a window on the
// same sphere 360 footage uses: direction ↔ point in the picture, both ways.
//
// Picture points are "normalised": x and y from −1 to 1 across the recorded frame, y up.
// Keep in step with the WGSL in shader.ts (srcForward / srcInverse / stretch).

import type { Vec3 } from './math';
import { effectiveLens, lensForward, lensInverse } from './projection';

const RAD = Math.PI / 180;

/**
 * GoPro's own lens description, as stored in the file. Picture point (x, y from −½ to ½) →
 * lens plane: X = Σ mapX[k]·x^(2k+1) (k<7) + mapX[7]·x·y², Y = y·(mapY[0] + mapY[1]y² + mapY[2]x² + mapY[3]x⁴);
 * then the angle from the axis is Σ poly[k]·r^k with r = 2·|(X·aspect, Y)| / zoom.
 * (The factor 2 / zoom isn't documented: with it the picture's corners come out at the file's
 * own diagonal field of view.)
 */
export interface GoProLens {
  poly: number[];
  mapX: number[];
  mapY: number[];
  aspect: number;
  zoom: number;
}

export interface SourceLens {
  /** 'linear' = straight lines stay straight; 'poly' = radius Σ cᵢ·θ^(2i+1); 'gopro' = see GoProLens. */
  kind: 'linear' | 'poly' | 'gopro';
  gopro?: GoProLens;
  coeffs: [number, number, number, number, number];
  /** Horizontal field of view of the whole picture, degrees. */
  hfov: number;
  /** Width / height of the picture before any stretching. */
  aspect: number;
  /** How much the middle is squeezed relative to the edges (1 = not stretched; SuperView < 1). */
  stretch: number;
  /** Where this came from: the file, a table of known cameras, or a guess. */
  from: 'file' | 'table' | 'guess';
  name: string;
}

export const LINEAR: SourceLens['coeffs'] = [1, 0, 0, 0, 0];

const IDENTITY_X = [1, 0, 0, 0, 0, 0, 0, 0], IDENTITY_Y = [1, 0, 0, 0];
/** Picture point (−1…1) → lens plane (height units ×2, i.e. ±1 top to bottom), GoPro's way. */
function gpPlane(g: GoProLens, x: number, y: number): [number, number] {
  const a = x / 2, b = y / 2, a2 = a * a, b2 = b * b, m = g.mapX;
  const X = a * (m[0]! + a2 * (m[1]! + a2 * (m[2]! + a2 * (m[3]! + a2 * (m[4]! + a2 * (m[5]! + a2 * m[6]!))))) + m[7]! * b2);
  const Y = b * (g.mapY[0]! + g.mapY[1]! * b2 + g.mapY[2]! * a2 + g.mapY[3]! * a2 * a2);
  return [2 * X * g.aspect, 2 * Y];
}
const gpTheta = (g: GoProLens, r: number) => { let t = 0; for (let k = 6; k >= 0; k--) t = t * r + g.poly[k]!; return t; };
const gpSlope = (g: GoProLens, r: number) => { let t = 0; for (let k = 6; k >= 1; k--) t = t * r + k * g.poly[k]!; return t; };
/** Largest radius the polynomial can be trusted to. */
const gpMax = new WeakMap<GoProLens, number>();
export function gpRadiusMax(g: GoProLens): number {
  let m = gpMax.get(g);
  if (m === undefined) {
    m = 0;
    while (m < 4 && gpSlope(g, m + 0.01) > g.poly[1]! * 0.05) m += 0.01;
    gpMax.set(g, m);
  }
  return m;
}
function gpRadius(g: GoProLens, theta: number): number {
  const max = gpRadiusMax(g);
  if (theta >= gpTheta(g, max)) return max;
  let r = Math.min(max, theta / g.poly[1]!);
  for (let i = 0; i < 8; i++) r = Math.max(0, Math.min(max, r - (gpTheta(g, r) - theta) / Math.max(1e-3, gpSlope(g, r))));
  return r;
}
/** Lens plane → picture point: solved a step at a time. `off` = how far it missed (outside the picture). */
function gpPicture(g: GoProLens, u: number, v: number): { x: number; y: number; off: number } {
  let x = Math.max(-1, Math.min(1, u / g.aspect)), y = Math.max(-1, Math.min(1, v));
  const h = 1e-4, L = 1.01;
  for (let i = 0; i < 9; i++) {
    const [a, b] = gpPlane(g, x, y), [ax, bx] = gpPlane(g, x + h, y), [ay, by] = gpPlane(g, x, y + h);
    const j00 = (ax - a) / h, j01 = (ay - a) / h, j10 = (bx - b) / h, j11 = (by - b) / h;
    const det = j00 * j11 - j01 * j10;
    if (Math.abs(det) < 1e-6) break;
    const eu = u - a, ev = v - b;
    x = Math.max(-L, Math.min(L, x + Math.max(-0.4, Math.min(0.4, (j11 * eu - j01 * ev) / det))));
    y = Math.max(-L, Math.min(L, y + Math.max(-0.4, Math.min(0.4, (j00 * ev - j10 * eu) / det))));
  }
  const [a, b] = gpPlane(g, x, y);
  return { x, y, off: Math.hypot(a - u, b - v) };
}

/** Image radius for an angle (unscaled). */
export function srcRadius(l: SourceLens, t: number): number {
  if (l.kind === 'linear') return Math.tan(t);
  const t2 = t * t, c = l.coeffs;
  return t * (c[0] + t2 * (c[1] + t2 * (c[2] + t2 * (c[3] + t2 * c[4]))));
}
function srcSlope(l: SourceLens, t: number): number {
  if (l.kind === 'linear') return 1 + Math.tan(t) ** 2;
  const t2 = t * t, c = l.coeffs;
  return c[0] + t2 * (3 * c[1] + t2 * (5 * c[2] + t2 * (7 * c[3] + t2 * 9 * c[4])));
}

/** Widest angle the lens formula can be trusted to (it must keep growing), radians. */
const maxCache = new WeakMap<SourceLens, number>();
export function srcThetaMax(l: SourceLens): number {
  if (l.gopro) return Math.min(120 * RAD, gpTheta(l.gopro, gpRadiusMax(l.gopro)));
  let m = maxCache.get(l);
  if (m === undefined) {
    if (l.kind === 'linear') m = 85 * RAD;
    else {
      m = 0;
      const step = 0.5 * RAD, floor = l.coeffs[0] * 0.05;
      while (m < 120 * RAD && srcSlope(l, m + step) > floor) m += step;
    }
    maxCache.set(l, m);
  }
  return m;
}

/** Angle for an image radius (Newton; clamped to what the lens covers). */
export function srcAngle(l: SourceLens, r: number): number {
  if (l.kind === 'linear') return Math.atan(r);
  const max = srcThetaMax(l);
  if (r >= srcRadius(l, max)) return max;
  let t = Math.min(max, r / l.coeffs[0]);
  for (let i = 0; i < 6; i++) t = Math.max(0, Math.min(max, t - (srcRadius(l, t) - r) / Math.max(1e-4, srcSlope(l, t))));
  return t;
}

const norm = (l: SourceLens) => srcRadius(l, (l.hfov * RAD) / 2);

/** SuperView-style stretch: natural in the middle, wider towards the sides. */
export const stretchX = (a: number, x: number) => x * (a + (1 - a) * x * x);
export function unstretchX(a: number, x: number): number {
  if (a === 1) return x;
  let u = x;
  for (let i = 0; i < 6; i++) u -= (stretchX(a, u) - x) / Math.max(0.05, a + 3 * (1 - a) * u * u);
  return u;
}

/** Where a direction (camera axes: +x right, +y up, +z forward) lands in the picture. */
export function dirToPicture(l: SourceLens, d: Vec3): { x: number; y: number; inside: boolean } {
  const s = Math.hypot(d[0], d[1]);
  const theta = Math.atan2(s, d[2]);
  const max = srcThetaMax(l);
  if (l.gopro) {
    const g = l.gopro, rr = (gpRadius(g, Math.min(theta, max)) * g.zoom) / (s > 1e-9 ? s : 1);
    const p = gpPicture(g, d[0] * rr, d[1] * rr);
    // Past the picture's edge: say how far, so edges can be searched for.
    const out = theta > max || p.off > 1e-3;
    const k = out ? 1.01 + Math.min(1, p.off + Math.max(0, theta - max)) : 1;
    return { x: p.x * k, y: p.y * k, inside: !out && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 };
  }
  const r = srcRadius(l, Math.min(theta, max)) / norm(l);
  const ux = s > 1e-9 ? d[0] / s : 0, uy = s > 1e-9 ? d[1] / s : 0;
  const x = stretchX(l.stretch, r * ux), y = r * uy * l.aspect;
  return { x, y, inside: theta <= max && Math.abs(x) <= 1 && Math.abs(y) <= 1 };
}

/** The direction seen at a point of the picture (also just outside it). */
export function pictureToDir(l: SourceLens, x: number, y: number): Vec3 {
  if (l.gopro) {
    const g = l.gopro, [u, v] = gpPlane(g, Math.max(-1.02, Math.min(1.02, x)), Math.max(-1.02, Math.min(1.02, y)));
    const r = Math.hypot(u, v);
    if (r < 1e-9) return [0, 0, 1];
    const t = gpTheta(g, Math.min(gpRadiusMax(g), r / g.zoom)), k = Math.sin(t) / r;
    return [u * k, v * k, Math.cos(t)];
  }
  const qx = unstretchX(l.stretch, x), qy = y / l.aspect;
  const r = Math.hypot(qx, qy);
  if (r < 1e-9) return [0, 0, 1];
  const t = srcAngle(l, r * norm(l)), s = Math.sin(t) / r;
  return [qx * s, qy * s, Math.cos(t)];
}

/** Normalised x where an angle to the right lands (how far a field of view reaches). */
export const reachX = (l: SourceLens, halfDeg: number) => l.gopro ? Math.min(1, Math.abs(dirToPicture(l, [Math.sin(halfDeg * RAD), 0, Math.cos(halfDeg * RAD)]).x)) : stretchX(l.stretch, srcRadius(l, Math.min(halfDeg * RAD, srcThetaMax(l))) / norm(l));

export interface FlatView {
  /** Field of view across the picture's width, degrees. */
  fov: number;
  fisheye: number;
  /** 'source' keeps the clip's own lens; 'custom' uses the fisheye setting. */
  lens: 'source' | 'custom';
}

/**
 * How output points (−1…1) map onto the picture's plane before zoom: fill crops, fit leaves
 * bars, 'camera' spans the field of view across the output's width.
 */
export function planeScale(outAspect: number, pictureAspect: number, how: 'fill' | 'fit' | 'camera'): [number, number] {
  if (how === 'camera') return [1, pictureAspect / outAspect];
  return (outAspect > pictureAspect) !== (how === 'fill') ? [outAspect / pictureAspect, 1] : [1, pictureAspect / outAspect];
}

/** The view ray (before rotation) at an output point. Null where the lens shows nothing. */
export function flatRay(l: SourceLens, v: FlatView, pictureAspect: number, scale: [number, number], nx: number, ny: number): Vec3 | null {
  const x = nx * scale[0], y = ny * scale[1];
  if (v.lens === 'source') {
    const z = reachX(l, v.fov / 2);
    return pictureToDir(l, x * z, y * z);
  }
  const e = effectiveLens({ fov: v.fov, fisheye: v.fisheye, autoLens: true });
  const R = lensForward(e.k, (e.fov * RAD) / 2);
  const px = x * R, py = (y * R) / pictureAspect, r = Math.hypot(px, py);
  if (r < 1e-12) return [0, 0, 1];
  const t = lensInverse(e.k, r);
  if (!Number.isFinite(t) || t > Math.PI) return null;
  const s = Math.sin(t) / r;
  return [px * s, py * s, Math.cos(t)];
}

/** Points round the output's edge (corners included) used to check nothing outside shows. */
export const BORDER: [number, number][] = (() => {
  const out: [number, number][] = [], n = 8;
  for (let i = 0; i < n; i++) {
    const u = -1 + (2 * i) / n;
    out.push([u, -1], [1, u], [-u, 1], [-1, -u]);
  }
  return out;
})();

/** Whether every edge point of the output lies inside the picture. `m` = row-major camera rotation. */
export function viewInside(l: SourceLens, v: FlatView, pictureAspect: number, scale: [number, number], m: ArrayLike<number>, slack = 1.0005): boolean {
  for (const [nx, ny] of BORDER) {
    const r = flatRay(l, v, pictureAspect, scale, nx, ny);
    if (!r) return false;
    const d: Vec3 = [m[0]! * r[0] + m[1]! * r[1] + m[2]! * r[2], m[3]! * r[0] + m[4]! * r[1] + m[5]! * r[2], m[6]! * r[0] + m[7]! * r[1] + m[8]! * r[2]];
    const p = dirToPicture(l, d);
    if (Math.abs(p.x) > slack || Math.abs(p.y) > slack || Math.atan2(Math.hypot(d[0], d[1]), d[2]) > srcThetaMax(l)) return false;
  }
  return true;
}

/** The widest field of view up to `v.fov` that shows nothing outside the picture. */
export function insideFov(l: SourceLens, v: FlatView, pictureAspect: number, scale: [number, number], m: ArrayLike<number>): number {
  if (viewInside(l, v, pictureAspect, scale, m)) return v.fov;
  let lo = 1, hi = v.fov;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (viewInside(l, { ...v, fov: mid }, pictureAspect, scale, m)) lo = mid; else hi = mid;
  }
  return lo;
}

/** The facts about a shot that decide its lens (see telemetry's CameraInfo). */
export interface LensFacts {
  model?: string;
  fovMode?: string;
  diagonalFov?: number;
  aspectUnwarped?: number;
  lenses?: Record<string, number[]>;
  poly?: number[];
  polyScale?: number;
  mapX?: number[];
  mapY?: number[];
}
const poly = (c: number[]): SourceLens['coeffs'] => [c[0] ?? 1, c[1] ?? 0, c[2] ?? 0, c[3] ?? 0, c[4] ?? 0];

/** Horizontal field of view of a w×h picture whose corner-to-corner field of view is known. */
function hfovFromDiagonal(l: Pick<SourceLens, 'kind' | 'coeffs' | 'aspect'>, diag: number): number {
  const full = { ...l, hfov: 90, stretch: 1, from: 'guess', name: '' } as SourceLens;
  const rd = srcRadius(full, Math.min((diag * RAD) / 2, srcThetaMax(full)));
  return (2 * srcAngle(full, rd * (l.aspect / Math.hypot(l.aspect, 1)))) / RAD;
}

/** GoPro's lens is close to equidistant with a little extra towards the edges. */
const GOPRO_POLY = poly([1, 0.075, -0.085, 0.028, -0.0036]);

/** Best description of a clip's lens from what is known about it. */
export function lensFor(facts: LensFacts, width: number, height: number): SourceLens {
  const shown = width / height;
  if (shown < 1) {
    // Held upright: the same lens turned on its side.
    const land = lensFor(facts, height, width);
    return { ...land, hfov: (2 * srcAngle(land, norm(land) / land.aspect)) / RAD, aspect: shown, stretch: 1 };
  }
  const gopro = /hero|gopro|max/i.test(facts.model ?? '');
  const mode = (facts.fovMode ?? '').toUpperCase()[0] ?? '';
  const exact = gopro ? goproLens(facts, shown) : null;
  if (exact) {
    const name = mode === 'S' ? 'SuperView' : mode === 'H' ? 'HyperView' : mode === 'L' ? 'Linear' : mode === 'N' ? 'Narrow' : 'Wide';
    const l: SourceLens = { kind: 'gopro', gopro: exact, coeffs: LINEAR, hfov: 100, aspect: shown, stretch: 1, from: 'file', name };
    return { ...l, hfov: goproWidth(l) };
  }
  const front = facts.lenses && (facts.lenses.FRNT ?? Object.values(facts.lenses)[0]);
  const coeffs = front?.length && front[0] ? poly(front.map((v) => v / front[0]!)) : GOPRO_POLY;
  const fileLens = !!front?.length;
  if (!gopro) return { kind: 'linear', coeffs: LINEAR, hfov: 70, aspect: shown, stretch: 1, from: 'guess', name: 'Unknown lens' };
  if (mode === 'L' || mode === 'N') {
    const base = { kind: 'linear' as const, coeffs: LINEAR, aspect: shown };
    return { ...base, hfov: facts.diagonalFov ? hfovFromDiagonal(base, facts.diagonalFov) : mode === 'N' ? 68 : 87, stretch: 1, from: facts.diagonalFov ? 'file' : 'table', name: mode === 'N' ? 'Narrow' : 'Linear' };
  }
  // SuperView squeezes 4:3 into 16:9, HyperView 8:7: the middle keeps its shape.
  const stretched = mode === 'S' || mode === 'H';
  const unwarped = facts.aspectUnwarped && facts.aspectUnwarped > 0.8 && facts.aspectUnwarped < 2.4 ? facts.aspectUnwarped : mode === 'S' ? 4 / 3 : mode === 'H' ? 8 / 7 : shown;
  const aspect = stretched ? unwarped : shown;
  const base = { kind: 'poly' as const, coeffs, aspect };
  return {
    ...base,
    hfov: facts.diagonalFov ? hfovFromDiagonal(base, facts.diagonalFov) : mode === 'S' ? 121 : mode === 'H' ? 130 : shown > 1.5 ? 118 : shown > 1.2 ? 122 : 130,
    stretch: stretched ? Math.max(0.5, Math.min(1, aspect / shown)) : 1,
    from: facts.diagonalFov || fileLens ? 'file' : 'table',
    name: mode === 'S' ? 'SuperView' : mode === 'H' ? 'HyperView' : 'Wide',
  };
}

/** GoPro's own description, if the file has a complete and believable one. */
function goproLens(f: LensFacts, shown: number): GoProLens | null {
  // Linear clips are straightened by the camera; the stored formula describes the glass, not them.
  if (!f.poly || f.poly.length < 5 || !f.poly[1] || !f.polyScale || /^L|^N/i.test(f.fovMode ?? '')) return null;
  const g: GoProLens = {
    poly: Array.from({ length: 7 }, (_, i) => f.poly![i] ?? 0),
    mapX: f.mapX?.length ? Array.from({ length: 8 }, (_, i) => f.mapX![i] ?? 0) : IDENTITY_X,
    mapY: f.mapY?.length ? Array.from({ length: 4 }, (_, i) => f.mapY![i] ?? 0) : IDENTITY_Y,
    aspect: f.mapX?.length && f.aspectUnwarped ? f.aspectUnwarped : shown,
    zoom: f.polyScale,
  };
  const l = { kind: 'gopro', gopro: g } as SourceLens;
  const half = goproWidth(l) / 2, d = pictureToDir(l, 1, 1);
  const diag = (2 * Math.acos(Math.max(-1, Math.min(1, d[2])))) / RAD;
  const believable = half > 15 && half < 89 && (!f.diagonalFov || Math.abs(diag - f.diagonalFov) < f.diagonalFov * 0.12);
  return believable ? g : null;
}
function goproWidth(l: SourceLens): number {
  const d = pictureToDir(l, 1, 0);
  return (2 * Math.atan2(d[0], d[2])) / RAD;
}

/** The user's own correction of a lens: its width, and how bent it is (0 straight … 1 as detected … 2). */
export function adjustLens(l: SourceLens, o: { hfov?: number; bend?: number } | undefined): SourceLens {
  if (!o) return l;
  const hfov = o.hfov ?? l.hfov, bend = o.bend ?? 1;
  if (l.gopro) {
    // The shape is exact; only its scale can be nudged.
    if (Math.abs(hfov - l.hfov) < 1e-6) return l;
    let lo = l.gopro.zoom * 0.5, hi = l.gopro.zoom * 2.5;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (goproWidth({ ...l, gopro: { ...l.gopro, zoom: m } }) > hfov) lo = m; else hi = m; }
    const gopro = { ...l.gopro, zoom: (lo + hi) / 2 };
    return { ...l, gopro, hfov: goproWidth({ ...l, gopro }) };
  }
  if (bend === 1) return { ...l, hfov };
  // Blend between a straight lens and the detected one by mixing their radius curves.
  const half = Math.min((hfov * RAD) / 2, 75 * RAD);
  const tanPoly = poly([1, 1 / 3, 2 / 15, 17 / 315, 62 / 2835]);
  const own = l.kind === 'linear' ? tanPoly : l.coeffs;
  // A straight lens has nothing to exaggerate; going above 1 bends it towards a fisheye.
  const away = l.kind === 'linear' ? GOPRO_POLY : tanPoly;
  const f = l.kind === 'linear' ? Math.max(0, bend - 1) : 1 - bend;
  const coeffs = own.map((c, i) => c + (away[i]! - c) * f) as SourceLens['coeffs'];
  const out: SourceLens = { ...l, kind: 'poly', coeffs, hfov };
  return srcThetaMax(out) > half * 0.98 ? out : { ...l, hfov };
}
