import { describe, expect, it } from 'vitest';
import { airtimeStats, findJumps, jumpDistance } from './airtime';

const RATE = 50; // Hz, like the averaged GoPro accelerometer
let seed = 3;
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.16;

/** A ride: 1 G riding with noise, with stretches of given G. */
function ride(seconds: number, parts: { at: number; len: number; g: number }[]) {
  const n = seconds * RATE, t = new Float64Array(n), g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = i / RATE;
    t[i] = s * 1e6;
    g[i] = 1 + 0.25 * Math.sin(s * 3) + noise();
    for (const p of parts) if (s >= p.at && s < p.at + p.len) g[i] = p.g + Math.abs(noise()) * 0.5;
  }
  return { t, g };
}

describe('airtime', () => {
  it('finds jumps where they are, to about a sample', () => {
    const { t, g } = ride(30, [
      { at: 5, len: 0.3, g: 0.05 }, { at: 5.3, len: 0.15, g: 3.2 }, // short jump, landing
      { at: 12, len: 1.0, g: 0.1 }, { at: 13, len: 0.2, g: 4.1 }, // big jump, hard landing
      { at: 20, len: 0.12, g: 0.1 }, // a dip, too short
    ]);
    const j = findJumps(t, g);
    expect(j).toHaveLength(2);
    expect(Math.abs(j[0]!.startUs - 5e6)).toBeLessThan(25_000);
    expect(Math.abs(j[0]!.airMs - 300)).toBeLessThan(45);
    expect(Math.abs(j[1]!.airMs - 1000)).toBeLessThan(45);
    expect(j[1]!.landingG).toBeGreaterThan(3.9);
    const st = airtimeStats(j);
    expect(st.count).toBe(2);
    expect(st.longestMs).toBe(j[1]!.airMs);
    expect(st.hardestG).toBe(j[1]!.landingG);
  });
  it('a bump in the air doesn’t split a jump', () => {
    const { t, g } = ride(10, [{ at: 3, len: 0.4, g: 0.1 }, { at: 3.4, len: 0.04, g: 0.9 }, { at: 3.44, len: 0.5, g: 0.1 }, { at: 3.94, len: 0.1, g: 3 }]);
    const j = findJumps(t, g);
    expect(j).toHaveLength(1);
    expect(Math.abs(j[0]!.airMs - 940)).toBeLessThan(45);
  });
  it('the threshold and shortest jump can be changed', () => {
    const { t, g } = ride(10, [{ at: 2, len: 0.5, g: 0.5 }, { at: 2.5, len: 0.1, g: 2 }, { at: 6, len: 0.15, g: 0.1 }, { at: 6.15, len: 0.1, g: 2 }]);
    expect(findJumps(t, g)).toHaveLength(0);
    expect(findJumps(t, g, { below: 0.7 })).toHaveLength(1);
    expect(findJumps(t, g, { minMs: 100 })).toHaveLength(1);
  });
  it('nothing on flat ground, nothing from too little data', () => {
    const { t, g } = ride(20, []);
    expect(findJumps(t, g)).toHaveLength(0);
    expect(findJumps([0, 1], [0, 0])).toHaveLength(0);
  });
  it('a shallower dip ending in a hard landing counts; pumping doesn’t', () => {
    // Dips to ~0.5 G (never under 0.4): one lands at 3.5 G, one at 1.6 G, one is too short.
    const { t, g } = ride(20, [
      { at: 4, len: 0.35, g: 0.45 }, { at: 4.35, len: 0.1, g: 3.5 },
      { at: 9, len: 0.35, g: 0.45 }, { at: 9.35, len: 0.1, g: 1.6 },
      { at: 14, len: 0.12, g: 0.45 }, { at: 14.12, len: 0.1, g: 3.5 },
    ]);
    const j = findJumps(t, g);
    expect(j).toHaveLength(1);
    expect(Math.abs(j[0]!.startUs - 4e6)).toBeLessThan(25_000);
    expect(Math.abs(j[0]!.airMs - 350)).toBeLessThan(45);
    expect(findJumps(t, g, { shape: false })).toHaveLength(0);
  });
  it('a mid-air lift joins into one jump, unless asked not to', () => {
    const { t, g } = ride(10, [{ at: 3, len: 0.3, g: 0.15 }, { at: 3.3, len: 0.2, g: 0.65 }, { at: 3.5, len: 0.3, g: 0.15 }, { at: 3.8, len: 0.1, g: 4 }]);
    const j = findJumps(t, g);
    expect(j).toHaveLength(1);
    expect(Math.abs(j[0]!.airMs - 800)).toBeLessThan(45);
    // Not joined: the first part never lands, so only the last part counts.
    const apart = findJumps(t, g, { joinMs: 80 });
    expect(apart).toHaveLength(1);
    expect(Math.abs(apart[0]!.airMs - 300)).toBeLessThan(45);
  });
  it('a short knock mid-air (a wheel clipping the next roller) doesn’t split a jump', () => {
    // As at 6:49 in GS010004: 0.3 s up, a 0.1 s knock of ~3.5 G, 0.26 s falling, 0.5 s up, landing.
    const parts = [{ at: 3, len: 0.3, g: 0.2 }, { at: 3.3, len: 0.1, g: 3.5 }, { at: 3.4, len: 0.26, g: 0.8 }, { at: 3.66, len: 0.5, g: 0.2 }, { at: 4.16, len: 0.15, g: 5 }];
    const { t, g } = ride(10, parts);
    const j = findJumps(t, g);
    expect(j).toHaveLength(1);
    expect(Math.abs(j[0]!.airMs - 1160)).toBeLessThan(60);
    // A real touchdown in between (on the ground for 0.3 s) is two jumps.
    const twice = ride(10, [{ at: 3, len: 0.3, g: 0.2 }, { at: 3.3, len: 0.3, g: 2.5 }, { at: 3.6, len: 0.5, g: 0.2 }, { at: 4.1, len: 0.15, g: 5 }]);
    expect(findJumps(twice.t, twice.g)).toHaveLength(2);
    // Two short pumping dips around a knock aren't joined into a jump.
    const pump = ride(10, [{ at: 3, len: 0.15, g: 0.2 }, { at: 3.15, len: 0.1, g: 3 }, { at: 3.25, len: 0.1, g: 0.8 }, { at: 3.35, len: 0.15, g: 0.2 }, { at: 3.5, len: 0.1, g: 3 }]);
    expect(findJumps(pump.t, pump.g, { shape: false })).toHaveLength(0);
  });
  it('no landing, no jump', () => {
    const { t, g } = ride(10, [{ at: 3, len: 0.5, g: 0.1 }, { at: 3.5, len: 2, g: 1 }]);
    expect(findJumps(t, g)).toHaveLength(0);
  });
  it('distance is ground speed × time in the air', () => {
    const j = { startUs: 5e6, endUs: 5.8e6, airMs: 800, landingG: 4 };
    const d = jumpDistance(j, () => 6.25);
    expect(d.speedMs).toBe(6.25);
    expect(d.distanceM).toBe(5);
    // Speed read across the jump: a slowing rider gets the average.
    const slowing = jumpDistance(j, (t) => 8 - (t - 4.85e6) / 1e6 * 2.5);
    expect(slowing.distanceM!).toBeGreaterThan(5.2);
    expect(slowing.distanceM!).toBeLessThan(5.6);
    // No GPS, no distance.
    expect(jumpDistance(j, () => NaN).distanceM).toBeUndefined();
    expect(airtimeStats([d, { ...j, startUs: 9e6 }]).farthestM).toBe(5);
    expect(airtimeStats([j]).farthestM).toBeUndefined();
  });
});
