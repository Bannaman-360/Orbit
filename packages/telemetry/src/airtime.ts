// Airtime: in the air, the camera falls with the rider and its accelerometer reads close to 0 G
// (on the ground it reads about 1 G, more in turns and landings). A stretch below a threshold,
// long enough, is a jump.

export interface AirtimeSettings {
  /** Below this many G counts as in the air. */
  below: number;
  /** Shorter dips aren't jumps (ms). */
  minMs: number;
  /** Also count a shallower dip that ends in a hard landing (the dip-then-spike shape). */
  shape: boolean;
  /** Stretches in the air closer together than this (ms) are one jump: a rider moving mid-air
   *  lifts the reading for a moment without landing. */
  joinMs: number;
}
export const DEFAULT_AIRTIME: AirtimeSettings = { below: 0.4, minMs: 200, shape: true, joinMs: 300 };
/** Dip-then-spike: the dip may read this much above the threshold… */
const SHAPE_SLACK = 0.2;
/** …when it ends in a landing at least this hard (G), within LAND_WINDOW_US. Pumping over a
 *  roller dips about as low but lands softer or the dip is shorter (measured on pump-track rides). */
const SHAPE_LANDING_G = 2.5;
const LAND_WINDOW_US = 300_000;
/** Between two parts of one jump the reading stays under this: a lift mid-air, not a landing. */
const STILL_IN_AIR_G = 1.0;
/** A wheel that clips something mid-air (the lip, the next roller) reads one short knock above
 *  STILL_IN_AIR_G and goes straight back to falling: still one jump when the knock lasts no longer
 *  than this… */
const KNOCK_MS = 150;
/** …and the parts are at most this many times joinMs apart (500 ms by default; measured on a jump
 *  at 6:49 in GS010004 that split in two: a 120 ms knock of 3.9 G between parts 360 ms apart). */
const KNOCK_JOIN = 5 / 3;
/** Every jump ends in a landing: a reading that never comes back above this wasn't in the air. */
const MIN_LANDING_G = 1.3;
/** Back on the ground only once the reading is this much above the threshold (no chatter). */
const HYSTERESIS = 0.15;
/** Longer than this isn't a jump (a camera dropped or thrown). */
const MAX_MS = 8000;

export interface Jump {
  /** Takeoff and landing, media time µs. */
  startUs: number;
  endUs: number;
  airMs: number;
  /** Hardest reading in the landing (G). */
  landingG: number;
  /** Ground speed through the jump (m/s), from GPS; missing without a GPS fix. */
  speedMs?: number;
  /** How far it went along the ground (m): ground speed × time in the air. */
  distanceM?: number;
}

/**
 * Distance of a jump from the ground speed around it. In the air nothing pushes the bike
 * forward or holds it back (air drag over a second is a few cm), so the horizontal speed stays
 * what it was at takeoff and distance = speed × airtime. GPS speed is Doppler-measured and
 * smoothed over about a second, so it's read across the whole jump and a little either side,
 * which also steadies it against the jolt of the landing.
 */
export function jumpDistance(j: Jump, speedAt: (t: number) => number): Jump {
  const a = j.startUs - 150_000, b = j.endUs;
  let sum = 0, c = 0;
  for (let k = 0; k <= 10; k++) { const v = speedAt(a + ((b - a) * k) / 10); if (Number.isFinite(v)) { sum += v; c++; } }
  if (c < 6) return j;
  const speedMs = sum / c;
  return { ...j, speedMs: Math.round(speedMs * 100) / 100, distanceM: Math.round(speedMs * (j.airMs / 1000) * 10) / 10 };
}

/** Jumps in a G-force series (`t` in µs, `g` in G, gravity included), in time order. */
export function findJumps(t: ArrayLike<number>, g: ArrayLike<number>, s: Partial<AirtimeSettings> = {}): Jump[] {
  const { below, minMs, shape, joinMs } = { ...DEFAULT_AIRTIME, ...s };
  const n = Math.min(t.length, g.length);
  if (n < 3) return [];
  // Light smoothing (±~20 ms): enough to steady single noisy samples, not to blur takeoff.
  const rate = (n - 1) / ((t[n - 1]! - t[0]!) / 1e6 || 1);
  const r = Math.max(0, Math.round(rate * 0.02));
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, c = 0;
    for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) { sum += g[k]!; c++; }
    v[i] = sum / c;
  }
  // When a level is crossed between two samples (linear).
  const cross = (i: number, level: number) => {
    const a = v[i - 1]!, b = v[i]!;
    const f = b === a ? 0 : (level - a) / (b - a);
    return t[i - 1]! + Math.max(0, Math.min(1, f)) * (t[i]! - t[i - 1]!);
  };
  // Stretches below a level, with the landing (back up through the level) found to the sample.
  const stretches = (level: number) => {
    const raw: { s: number; e: number; ei: number }[] = [];
    let inAir = false, s0 = 0;
    for (let i = 1; i < n; i++) {
      if (!inAir && v[i]! < level) { inAir = true; s0 = v[i - 1]! >= level ? cross(i, level) : t[i]!; }
      else if (inAir && v[i]! > level + HYSTERESIS) {
        inAir = false;
        let j = i;
        while (j > 1 && v[j - 1]! >= level) j--;
        raw.push({ s: s0, e: cross(j, level), ei: i });
      }
    }
    // Parts of one jump: close together, and nothing in between that reads like touching down.
    // How long the reading spends at ground level between two parts (ms).
    const onGround = (from: number, until: number) => {
      let ms = 0;
      for (let k = Math.max(1, from - 1); k < n && t[k - 1]! < until; k++) if (v[k]! >= STILL_IN_AIR_G) ms += (t[k]! - t[k - 1]!) / 1000;
      return ms;
    };
    const merged: typeof raw = [];
    for (const x of raw) {
      const last = merged[merged.length - 1];
      const gap = last ? (x.s - last.e) / 1000 : Infinity;
      // A knock only joins two parts that are each long enough to be a jump: short dips around
      // a roller are pumping, not one jump.
      const jumpLike = last && (last.e - last.s) / 1000 >= minMs && (x.e - x.s) / 1000 >= minMs;
      const ground = gap < joinMs || (jumpLike && gap < joinMs * KNOCK_JOIN) ? onGround(last!.ei, x.s) : Infinity;
      if ((gap < joinMs && ground === 0) || (jumpLike && gap < joinMs * KNOCK_JOIN && ground <= KNOCK_MS)) { last!.e = x.e; last!.ei = x.ei; } else merged.push({ ...x });
    }
    return merged.filter((x) => { const ms = (x.e - x.s) / 1000; return ms >= minMs && ms <= MAX_MS; });
  };
  const found = stretches(below);
  if (shape) {
    // A shallower dip counts when a hard landing follows it straight away.
    for (const x of stretches(below + SHAPE_SLACK)) {
      if (found.some((f) => f.s < x.e && x.s < f.e)) continue;
      let spike = 0;
      for (let k = x.ei; k < n && t[k]! - x.e < LAND_WINDOW_US; k++) spike = Math.max(spike, v[k]!);
      if (spike >= SHAPE_LANDING_G) found.push(x);
    }
    found.sort((a, b) => a.s - b.s);
  }
  const out: Jump[] = [];
  for (const x of found) {
    const airMs = (x.e - x.s) / 1000;
    // Hardest moment within 0.4 s of touching down.
    let peak = 0;
    for (let k = x.ei; k < n && t[k]! - x.e < 400_000; k++) peak = Math.max(peak, g[k]!);
    if (peak < MIN_LANDING_G) continue;
    out.push({ startUs: Math.round(x.s), endUs: Math.round(x.e), airMs: Math.round(airMs), landingG: Math.round(peak * 10) / 10 });
  }
  return out;
}

/** Totals for a list of jumps. */
export function airtimeStats(j: Jump[]) {
  const total = j.reduce((a, x) => a + x.airMs, 0);
  const far = j.filter((x) => x.distanceM !== undefined);
  return { farthestM: far.length ? far.reduce((a, x) => Math.max(a, x.distanceM!), 0) : undefined, count: j.length, longestMs: j.reduce((a, x) => Math.max(a, x.airMs), 0), totalMs: total, hardestG: j.reduce((a, x) => Math.max(a, x.landingG), 0) };
}
