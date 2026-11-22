import { describe, expect, it } from 'vitest';
import { TelemetrySeries, type GpsSample } from './metrics';

// 10 Hz GPS heading north at 10 m/s for 20 s, climbing 1 m/s.
const track = (fix = 3): GpsSample[] =>
  Array.from({ length: 201 }, (_, i) => ({ t: i * 100_000, lat: 45 + (i * 1) / 111_195, lon: 7, alt: 100 + i / 10, speed: 10, fix }));

describe('TelemetrySeries', () => {
  it('reports speed, altitude and distance', () => {
    const t = new TelemetrySeries(track());
    expect(t.hasGps).toBe(true);
    expect(t.speedAt(10e6)).toBeCloseTo(10, 5);
    expect(t.altitudeAt(10e6)).toBeCloseTo(110, 0);
    expect(t.distanceAt(20e6)).toBeCloseTo(200, -1);
    expect(t.maxSpeed).toBeCloseTo(10, 5);
  });
  it('ignores samples without a fix (GoPro writes 0,0 while searching)', () => {
    const t = new TelemetrySeries(track(0));
    expect(t.hasGps).toBe(false);
    expect(Number.isNaN(t.speedAt(1e6))).toBe(true);
  });
  it('fits the track into the map square', () => {
    const t = new TelemetrySeries(track());
    const xs = t.track.map((p) => p.x), ys = t.track.map((p) => p.y);
    expect(Math.min(...ys)).toBeCloseTo(0, 5);
    expect(Math.max(...ys)).toBeCloseTo(1, 5);
    expect(xs.every((x) => Math.abs(x - 0.5) < 1e-6)).toBe(true);
    // Heading north: later = higher up on the map (smaller y).
    expect(t.positionAt(20e6)!.y).toBeLessThan(t.positionAt(0)!.y);
  });
  it('turns accelerometer readings into G', () => {
    const accl = Array.from({ length: 100 }, (_, i) => ({ t: i * 20_000, v: [0, 9.80665 * 2, 0] as [number, number, number] }));
    expect(new TelemetrySeries([], accl).gforceAt(1e6)).toBeCloseTo(2, 5);
  });
});
