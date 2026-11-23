import { describe, expect, it } from 'vitest';
import { addClip, audioSpan, clipDuration, clipStarts, detachAudio, emptyTimeline, layersAt, loadTimeline, locate, mediaToTimeline, newClip, setClipSpeed, splitAt, timelineDuration, type TimelineClip } from './timeline';
import { cleanSpeed, fixSpeedKeys, localAt, mediaAt, moveSpeedKey, playLength, rampPreset, RAMP_PRESETS, removeSpeedKey, setSpeedKey, speedAt, speedRange, type SpeedEase, type SpeedKey } from './speed';

const S = 1e6;
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const clip = (p: Partial<TimelineClip> = {}): TimelineClip => ({ ...newClip('a.mp4', 20 * S, false), ...p });
const k = (t: number, speed: number, ease?: SpeedEase): SpeedKey => ({ id: `${t}`, t: t * S, speed, ease });
const random = (): TimelineClip => {
  const keys: SpeedKey[] = [];
  for (let t = rnd() * 3 - 1; t < 21; t += 0.05 + rnd() * 4) keys.push(k(t, 0.1 * 80 ** rnd(), (['smooth', 'linear', 'jump'] as const)[Math.floor(rnd() * 3)]));
  const a = rnd() * 10;
  return clip({ inUs: a * S, outUs: (a + 0.2 + rnd() * 9) * S, speedKeys: keys });
};

describe('without a ramp', () => {
  it('is exactly the old arithmetic', () => {
    for (let i = 0; i < 200; i++) {
      const c = clip({ inUs: rnd() * 5 * S, outUs: (6 + rnd() * 9) * S, speed: 0.25 * 16 ** rnd() }), x = rnd() * 5 * S;
      expect(clipDuration(c)).toBe((c.outUs - c.inUs) / c.speed);
      expect(mediaAt(c, x)).toBe(c.inUs + x * c.speed);
      expect(localAt(c, x)).toBe((x - c.inUs) / c.speed);
      expect(mediaToTimeline(7, c, x)).toBe(7 + (x - c.inUs) / c.speed);
      expect(speedAt(c, x)).toBe(c.speed);
    }
  });
  it('an empty list of points is no ramp', () => expect(clipDuration(clip({ speedKeys: [], speed: 2 }))).toBe(10 * S));
});

describe('a ramp', () => {
  it('maps both ways exactly, and always forwards', () => {
    for (let i = 0; i < 300; i++) {
      const c = random(), L = clipDuration(c);
      expect(L).toBeGreaterThan(0);
      let last = -Infinity;
      for (let j = 0; j <= 60; j++) {
        const T = (L * j) / 60, m = mediaAt(c, T);
        expect(m).toBeGreaterThan(last);
        last = m;
        expect(Math.abs(localAt(c, m) - T)).toBeLessThan(0.01);
      }
      expect(Math.abs(mediaAt(c, 0) - c.inUs)).toBeLessThan(0.01);
      expect(Math.abs(mediaAt(c, L) - c.outUs)).toBeLessThan(0.01);
      // Beyond its ends it carries on.
      expect(mediaAt(c, -S)).toBeLessThan(c.inUs);
      expect(Math.abs(localAt(c, mediaAt(c, L + S)) - L - S)).toBeLessThan(0.01);
    }
  });
  it('the speed is how fast the media really moves', () => {
    for (let i = 0; i < 200; i++) {
      const c = random(), L = clipDuration(c), T = L * (0.05 + 0.9 * rnd()), h = 5;
      const m = mediaAt(c, T);
      if (c.speedKeys!.some((x) => Math.abs(x.t - m) < 500)) continue; // (a jump)
      const real = (mediaAt(c, T + h) - mediaAt(c, T - h)) / (2 * h);
      expect(Math.abs(real / speedAt(c, m) - 1)).toBeLessThan(1e-3);
    }
  });
  it('eases without a jolt', () => {
    const c = clip({ speedKeys: [k(5, 4), k(8, 0.25), k(12, 2)] });
    const v = (T: number) => speedAt(c, mediaAt(c, T));
    let worst = 0;
    for (let T = 0; T < clipDuration(c) - 20_000; T += 10_000) worst = Math.max(worst, Math.abs(v(T + 10_000) - v(T)));
    expect(worst).toBeLessThan(0.08);
  });
  it('one point is a constant speed', () => expect(clipDuration(clip({ speedKeys: [k(3, 0.5)] }))).toBeCloseTo(40 * S, 3));
  it('a point added on the line changes nothing at its spot', () => {
    const c = clip({ speedKeys: [k(5, 4), k(8, 0.25)] }), d = { ...c, speedKeys: setSpeedKey(c, 6.5 * S) };
    expect(d.speedKeys.length).toBe(3);
    expect(speedAt(d, 6.5 * S)).toBeCloseTo(speedAt(c, 6.5 * S), 6);
    const flat = clip({ speed: 2 }), e = { ...flat, speedKeys: setSpeedKey(flat, 4 * S) };
    expect(clipDuration(e)).toBeCloseTo(clipDuration(flat), 3);
  });
  it('points can be moved but not past each other', () => {
    const keys = [k(1, 1), k(3, 2), k(5, 1)];
    expect(moveSpeedKey(keys, '3', 9 * S, 20)[1]).toMatchObject({ t: 5 * S - 20_000, speed: 8 });
    expect(moveSpeedKey(keys, '3', -4 * S, 0)[1]).toMatchObject({ t: S + 20_000, speed: 0.1 });
    expect(removeSpeedKey(clip({ speedKeys: [k(1, 3)] }), '1')).toEqual({ speedKeys: undefined, speed: 3 });
  });
});

describe('the edit', () => {
  const ramp = [k(5, 1), k(6, 0.25), k(7, 0.25), k(9, 4)];
  it('splitting a ramp changes nothing that is seen', () => {
    const one = addClip(emptyTimeline(), clip({ speedKeys: ramp })), total = timelineDuration(one);
    for (const f of [0.1, 0.3, 0.45, 0.6, 0.8]) {
      const two = splitAt(one, total * f);
      expect(two.clips.length).toBe(2);
      expect(Math.abs(timelineDuration(two) - total)).toBeLessThan(0.1);
      for (let j = 0; j < 100; j++) expect(Math.abs(locate(two, (total * j) / 100)!.mediaUs - locate(one, (total * j) / 100)!.mediaUs)).toBeLessThan(1.1);
    }
  });
  it('transitions and later clips follow the new length', () => {
    const tl = addClip(addClip(emptyTimeline(), clip({ speedKeys: ramp })), { ...clip(), id: 'b', transitionIn: { kind: 'crossfade', durationUs: S } });
    expect(clipStarts(tl)[1]).toBeCloseTo(clipDuration(tl.clips[0]!) - S, 3);
    const L = layersAt(tl, clipStarts(tl)[1]! + S / 2)!;
    expect(L.progress).toBeCloseTo(0.5, 5);
    expect(L.b!.mediaUs).toBeCloseTo(S / 2, 3);
  });
  it('detached sound keeps the ramp, and follows when it changes', () => {
    const tl = addClip(emptyTimeline(), clip({ id: 'x', speedKeys: ramp })), d = detachAudio(tl, 'x');
    expect(audioSpan(d, d.audio[0]!).end).toBeCloseTo(timelineDuration(d), 3);
    const e = setClipSpeed(d, 'x', { speedKeys: undefined, speed: 2 });
    expect(playLength(e.audio[0]!)).toBe(10 * S);
    expect(clipDuration(e.clips[0]!)).toBe(10 * S);
  });
  it('saves and loads, repairing nonsense', () => {
    const tl = addClip(emptyTimeline(), clip({ speedKeys: ramp }));
    expect(loadTimeline(JSON.parse(JSON.stringify(tl))).clips[0]!.speedKeys!.map((x) => [x.t, x.speed])).toEqual(ramp.map((x) => [x.t, x.speed]));
    expect(fixSpeedKeys([{ t: 1, speed: 99 }, { t: 1, speed: 1 }, { t: 'x', speed: 1 }, null, { t: -5e6, speed: -1 }])).toMatchObject([{ t: 1, speed: 8 }]);
    expect(fixSpeedKeys([])).toBeUndefined();
    expect('speedKeys' in JSON.parse(JSON.stringify(loadTimeline({ clips: [{ mediaPath: 'a', outUs: 5 }] }))).clips[0]).toBe(false);
  });
});

describe('presets', () => {
  it('fit any clip', () => {
    for (const [kind] of RAMP_PRESETS) for (const len of [0.15, 0.8, 3, 60]) for (const at of [0, 0.5, 1]) {
      const c = clip({ inUs: 2 * S, outUs: (2 + len) * S }), keys = rampPreset(kind, c, c.inUs + len * at * S, 0.25);
      const r = { ...c, speedKeys: keys };
      expect(keys.every((x, i) => x.t >= c.inUs - 1 && x.t <= c.outUs + 1 && (!i || x.t > keys[i - 1]!.t))).toBe(true);
      expect(clipDuration(r)).toBeGreaterThan(0);
      expect(speedRange(r).max / speedRange(r).min).toBeGreaterThan(1.9);
    }
  });
  it('knows the slowest clean speed', () => expect([cleanSpeed(240, 30), cleanSpeed(120, 30), cleanSpeed(60, 30), cleanSpeed(24, 30)]).toEqual([0.125, 0.25, 0.5, 1]));
});
