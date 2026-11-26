// Readouts for telemetry overlays: speed, altitude, distance travelled, G-force and the
// GPS track for a map. Built once per file from GPS and accelerometer samples.

export interface GpsSample {
  /** µs, media time */
  t: number;
  lat: number;
  lon: number;
  /** metres */
  alt: number;
  /** ground speed, m/s */
  speed: number;
  /** 0 = no fix, 2 = 2D, 3 = 3D */
  fix: number;
}

interface TimedV { t: number; v: [number, number, number] }

import { findJumps, jumpDistance, type AirtimeSettings, type Jump } from './airtime';
import { findHighlights, type Highlight } from './highlights';

const G = 9.80665;
const EARTH_R = 6_371_000;

function haversine(a: GpsSample, b: GpsSample): number {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Linear interpolation of a sampled series at t (clamped at the ends). */
function interp(ts: Float64Array, vs: Float64Array, t: number): number {
  const n = ts.length;
  if (!n) return NaN;
  if (t <= ts[0]!) return vs[0]!;
  if (t >= ts[n - 1]!) return vs[n - 1]!;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (ts[m]! <= t) lo = m; else hi = m;
  }
  const f = (t - ts[lo]!) / (ts[hi]! - ts[lo]! || 1);
  return vs[lo]! + (vs[hi]! - vs[lo]!) * f;
}

/** Centred moving average over ±radius samples. */
function smooth(v: Float64Array, radius: number): Float64Array<ArrayBuffer> {
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(v.length - 1, i + radius); j++) { s += v[j]!; n++; }
    out[i] = s / n;
  }
  return out;
}

export class TelemetrySeries {
  readonly hasGps: boolean;
  readonly hasAccel: boolean;
  /** Fastest smoothed speed in the file, m/s (for dial scales). */
  readonly maxSpeed: number;
  readonly maxG: number;
  /** GPS track projected flat: x right (east), y down (south), fitted to 0–1 keeping the aspect. */
  readonly track: { x: number; y: number }[] = [];

  private gT: Float64Array<ArrayBuffer> = new Float64Array(0);
  private speedV: Float64Array<ArrayBuffer> = new Float64Array(0);
  private altV: Float64Array<ArrayBuffer> = new Float64Array(0);
  private distV: Float64Array<ArrayBuffer> = new Float64Array(0);
  private xV: Float64Array<ArrayBuffer> = new Float64Array(0);
  private yV: Float64Array<ArrayBuffer> = new Float64Array(0);
  private latV: Float64Array<ArrayBuffer> = new Float64Array(0);
  private lonV: Float64Array<ArrayBuffer> = new Float64Array(0);
  private aT: Float64Array<ArrayBuffer> = new Float64Array(0);
  private gV: Float64Array<ArrayBuffer> = new Float64Array(0);
  /** G without the readout smoothing (for airtime). */
  private rawG: Float64Array<ArrayBuffer> = new Float64Array(0);
  private jumpCache = new Map<string, Jump[]>();
  private highlightCache = new Map<string, Highlight[]>();

  constructor(gps: GpsSample[] = [], accl: TimedV[] = []) {
    // Only real fixes; GoPro writes 0,0 while searching for satellites.
    const fixes = gps.filter((s) => s.fix >= 2 && !(s.lat === 0 && s.lon === 0) && Number.isFinite(s.lat));
    this.hasGps = fixes.length >= 2;
    if (this.hasGps) {
      const n = fixes.length;
      this.gT = Float64Array.from(fixes, (s) => s.t);
      const rate = (n - 1) / ((fixes[n - 1]!.t - fixes[0]!.t) / 1e6 || 1); // samples per second
      const r1 = Math.max(1, Math.round(rate * 0.5));
      this.speedV = smooth(Float64Array.from(fixes, (s) => s.speed), r1);
      this.altV = smooth(Float64Array.from(fixes, (s) => s.alt), Math.max(1, Math.round(rate * 1.5)));
      // Distance: sum of steps, ignoring GPS wander while standing still.
      this.distV = new Float64Array(n);
      for (let i = 1; i < n; i++) {
        const step = haversine(fixes[i - 1]!, fixes[i]!);
        this.distV[i] = this.distV[i - 1]! + (this.speedV[i]! > 0.5 ? step : 0);
      }
      // Map projection (equirectangular around the middle), fitted into a unit square.
      this.latV = Float64Array.from(fixes, (s) => s.lat);
      this.lonV = Float64Array.from(fixes, (s) => s.lon);
      const lat0 = (fixes.reduce((a, s) => a + s.lat, 0) / n) * (Math.PI / 180);
      const px = fixes.map((s) => s.lon * Math.cos(lat0));
      const py = fixes.map((s) => -s.lat);
      const x0 = Math.min(...px), x1 = Math.max(...px), y0 = Math.min(...py), y1 = Math.max(...py);
      const span = Math.max(x1 - x0, y1 - y0) || 1e-9;
      const ox = (1 - (x1 - x0) / span) / 2, oy = (1 - (y1 - y0) / span) / 2;
      this.xV = Float64Array.from(px, (x) => ox + (x - x0) / span);
      this.yV = Float64Array.from(py, (y) => oy + (y - y0) / span);
      const step = Math.max(1, Math.floor(n / 600));
      for (let i = 0; i < n; i += step) this.track.push({ x: this.xV[i]!, y: this.yV[i]! });
      this.maxSpeed = Math.max(...this.speedV);
    } else {
      this.maxSpeed = 0;
    }

    this.hasAccel = accl.length >= 2;
    if (this.hasAccel) {
      this.aT = Float64Array.from(accl, (s) => s.t);
      const rate = (accl.length - 1) / ((accl[accl.length - 1]!.t - accl[0]!.t) / 1e6 || 1);
      // Total acceleration in G (1 G at rest), lightly smoothed so the number is readable.
      this.rawG = Float64Array.from(accl, (s) => Math.hypot(...s.v) / G);
      this.gV = smooth(this.rawG, Math.max(1, Math.round(rate * 0.1)));
      this.maxG = Math.max(...this.gV);
    } else {
      this.maxG = 0;
    }
  }

  /** Media time range covered by GPS / accelerometer data (µs), or null. */
  get gpsRange(): [number, number] | null {
    return this.hasGps ? [this.gT[0]!, this.gT[this.gT.length - 1]!] : null;
  }
  get accelRange(): [number, number] | null {
    return this.hasAccel ? [this.aT[0]!, this.aT[this.aT.length - 1]!] : null;
  }
  get minAltitude() { return this.hasGps ? Math.min(...this.altV) : NaN; }
  get maxAltitude() { return this.hasGps ? Math.max(...this.altV) : NaN; }
  get totalDistance() { return this.hasGps ? this.distV[this.distV.length - 1]! : NaN; }

  /** m/s */
  speedAt(t: number) { return this.hasGps ? interp(this.gT, this.speedV, t) : NaN; }
  /** metres */
  altitudeAt(t: number) { return this.hasGps ? interp(this.gT, this.altV, t) : NaN; }
  /** metres travelled since the start of the file */
  distanceAt(t: number) { return this.hasGps ? interp(this.gT, this.distV, t) : NaN; }
  /** G */
  gforceAt(t: number) { return this.hasAccel ? interp(this.aT, this.gV, t) : NaN; }
  /** Jumps in this file (worked out once per setting). */
  jumps(s: Partial<AirtimeSettings> = {}): Jump[] {
    if (!this.hasAccel) return [];
    const key = `${s.below ?? ''}|${s.minMs ?? ''}|${s.shape ?? ''}|${s.joinMs ?? ''}`;
    let j = this.jumpCache.get(key);
    if (!j) {
      j = findJumps(this.aT, this.rawG, s);
      if (this.hasGps) { const [g0, g1] = this.gpsRange!; j = j.map((x) => (x.startUs >= g0 && x.endUs <= g1 ? jumpDistance(x, (t) => this.speedAt(t)) : x)); }
      this.jumpCache.set(key, j);
    }
    return j;
  }
  /**
   * Highlights in this file (worked out once per setting): HiLight `tags` (media µs), jumps,
   * top speed and hard hits.
   */
  highlights(durationUs: number, tags: number[] = [], s: Partial<AirtimeSettings> = {}): Highlight[] {
    const key = `${durationUs}|${tags.join(',')}|${s.below ?? ''}|${s.minMs ?? ''}|${s.shape ?? ''}|${s.joinMs ?? ''}`;
    let h = this.highlightCache.get(key);
    if (!h) {
      h = findHighlights({
        durationUs, tags, jumps: this.jumps(s),
        ...(this.hasGps ? { speedT: this.gT, speed: this.speedV } : {}),
        ...(this.hasAccel ? { gT: this.aT, g: this.rawG } : {}),
      });
      this.highlightCache.set(key, h);
    }
    return h;
  }
  /** Where the camera was (degrees), or null without GPS. */
  latLonAt(t: number): { lat: number; lon: number } | null {
    return this.hasGps ? { lat: interp(this.gT, this.latV, t), lon: interp(this.gT, this.lonV, t) } : null;
  }
  /** Position on the fitted map (0–1). */
  positionAt(t: number): { x: number; y: number } | null {
    return this.hasGps ? { x: interp(this.gT, this.xV, t), y: interp(this.gT, this.yV, t) } : null;
  }
  /** Index into `track` reached at time t (for drawing the travelled part). */
  trackIndexAt(t: number): number {
    if (!this.hasGps) return 0;
    const n = this.gT.length;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.gT[m]! <= t) lo = m; else hi = m;
    }
    const step = Math.max(1, Math.floor(n / 600));
    return Math.min(this.track.length - 1, Math.floor(lo / step));
  }
}
