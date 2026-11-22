import { describe, expect, it } from 'vitest';
import { mulVec } from '@ace/media360';
import { alignToFrames, fitCoriMapping, imageOrientation } from './orientation';
import { axisMapMatrix, correctionAt, gravityAt, smoothGravity, smoothQuats, Stabilizer, type OrientationData, type Smoothing, type StabilizeOptions, type TimedQuat } from './orientation';

const data = (grav: [number, number, number][]): OrientationData => ({
  grav: grav.map((v, i) => ({ t: i * 33_333, v })),
  cori: [],
  streams: ['GRAV'],
});

describe('axis map', () => {
  it('builds signed permutation matrices', () => {
    expect(axisMapMatrix(['x', 'y', 'z'])).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(mulVec(axisMapMatrix(['-y', 'z', 'x']), [1, 2, 3])).toEqual([-2, 3, 1]);
  });
});

describe('horizon correction', () => {
  it('is identity when the camera is level', () => {
    const m = correctionAt(data([[0, -1, 0]]), 0, { mode: 'horizon', axisMap: ['x', 'y', 'z'] });
    m.forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][i]!, 9));
  });

  it('maps measured gravity onto world down for a rolled camera', () => {
    const a = (30 * Math.PI) / 180;
    const g: [number, number, number] = [Math.sin(a), -Math.cos(a), 0]; // rolled 30°
    const m = correctionAt(data([g]), 0, { mode: 'horizon', axisMap: ['x', 'y', 'z'] });
    const down = mulVec(m, g);
    expect(down[0]).toBeCloseTo(0, 9);
    expect(down[1]).toBeCloseTo(-1, 9);
  });

  it('interpolates between samples', () => {
    const d = data([[0, -1, 0], [1, 0, 0]]);
    const g = gravityAt(d, 33_333 / 2)!;
    expect(g[0]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('smoothing keeps vectors unit length', () => {
    const s = smoothGravity(data([[0, -1, 0], [0.1, -1, 0], [0, -1, 0.1]]).grav, 1);
    for (const x of s) expect(Math.hypot(...x.v)).toBeCloseTo(1, 9);
  });
});

describe('stabilisation levels', () => {
  // Camera yawing slowly (intentional pan) with a fast roll wobble (shake).
  const cori: TimedQuat[] = [];
  const grav: { t: number; v: [number, number, number] }[] = [];
  for (let i = 0; i < 600; i++) {
    const t = i * 16_683;
    const yaw = (i / 600) * 1.0; // ~57° pan over 10 s
    const roll = 0.08 * Math.sin(i * 0.9); // ±4.6° shake
    // q = yaw about y, then roll about z
    const qy: [number, number, number, number] = [Math.cos(yaw / 2), 0, Math.sin(yaw / 2), 0];
    const qz: [number, number, number, number] = [Math.cos(roll / 2), 0, 0, Math.sin(roll / 2)];
    const q: [number, number, number, number] = [
      qy[0] * qz[0] - qy[1] * qz[1] - qy[2] * qz[2] - qy[3] * qz[3],
      qy[0] * qz[1] + qy[1] * qz[0] + qy[2] * qz[3] - qy[3] * qz[2],
      qy[0] * qz[2] - qy[1] * qz[3] + qy[2] * qz[0] + qy[3] * qz[1],
      qy[0] * qz[3] + qy[1] * qz[2] - qy[2] * qz[1] + qy[3] * qz[0],
    ];
    cori.push({ t, q });
    grav.push({ t, v: [0, -1, 0] });
  }
  const stab = new Stabilizer({ cori, grav, streams: [] });
  const angle = (m: number[]) => (Math.acos(Math.max(-1, Math.min(1, (m[0]! + m[4]! + m[8]! - 1) / 2))) * 180) / Math.PI;
  const opts = (smoothing: Smoothing): StabilizeOptions => ({ smoothing, horizon: false, axisMap: ['x', 'y', 'z'] });

  it('off leaves the footage alone', () => {
    expect(angle(stab.correctionAt(5e6, opts('off')))).toBeCloseTo(0, 9);
  });

  it('smoothing removes the shake but keeps the pan', () => {
    // Remaining correction ≈ the shake only (a few degrees), not the 28° of pan.
    for (const level of ['low', 'medium', 'high'] as const) {
      const a = angle(stab.correctionAt(5e6, opts(level)));
      expect(a).toBeLessThan(10);
    }
  });

  it('locked cancels the pan as well', () => {
    expect(angle(stab.correctionAt(5e6, opts('locked')))).toBeGreaterThan(20);
  });

  it('smoothed paths stay unit quaternions', () => {
    for (const s of smoothQuats(cori, 300_000)) expect(Math.hypot(...s.q)).toBeCloseTo(1, 9);
  });
});

describe('CORI mapping fit', () => {
  it('finds a hidden axis mapping from gravity consistency', () => {
    // True camera orientation R(t) (cam→world, our axes) with tilt and roll; gravity measured in the camera.
    const hidden: [string, string, string] = ['-z', 'x', '-y'];
    const P = axisMapMatrix(hidden);
    const Pt = [P[0], P[3], P[6], P[1], P[4], P[7], P[2], P[5], P[8]] as typeof P;
    const Pg = axisMapMatrix(['x', '-y', 'z']);
    const cori: TimedQuat[] = [], grav: { t: number; v: [number, number, number] }[] = [];
    for (let i = 0; i < 400; i++) {
      const a = 0.5 * Math.sin(i * 0.05), b = 0.4 * Math.cos(i * 0.031), c = 0.3 * Math.sin(i * 0.017);
      // Random-ish rotation quaternion in our frame.
      const ax = [a, b, c], ang = Math.hypot(a, b, c), n = ax.map((x) => x / (ang || 1));
      const qOurs: [number, number, number, number] = [Math.cos(ang / 2), n[0]! * Math.sin(ang / 2), n[1]! * Math.sin(ang / 2), n[2]! * Math.sin(ang / 2)];
      const R = quatMat(qOurs);
      // Express in the sensor frame: R_sensor = Pᵀ R P, and back to a quaternion.
      const Rs = mul(mul(Pt, R), P);
      cori.push({ t: i * 16_683, q: matQuat(Rs) });
      // Gravity in camera (our axes) = Rᵀ·down; GRAV stores it with Pg applied inversely (Pg is its own inverse here).
      const gCam = mulVec([R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]] as typeof R, [0, -1, 0]);
      grav.push({ t: i * 16_683, v: mulVec(Pg, gCam) as [number, number, number] });
    }
    const fits = fitCoriMapping({ cori, grav, streams: [] }, ['x', '-y', 'z']);
    expect(fits[0]!.score).toBeLessThan(1e-6);
    // P and −P describe the same rotation (PRPᵀ = (−P)R(−P)ᵀ), so either is correct.
    const neg = hidden.map((a) => (a.startsWith('-') ? a.slice(1) : `-${a}`));
    expect([hidden, neg]).toContainEqual(fits[0]!.axisMap);
    expect(fits[0]!.invert).toBe(false);
  });
});

function quatMat(q: [number, number, number, number]) {
  const [w, x, y, z] = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)] as [number, number, number, number, number, number, number, number, number];
}
function mul(a: number[], b: number[]) {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k]! * b[k * 3 + j]!;
  return r as [number, number, number, number, number, number, number, number, number];
}
function matQuat(m: number[]): [number, number, number, number] {
  const tr = m[0]! + m[4]! + m[8]!;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return [0.25 * s, (m[7]! - m[5]!) / s, (m[2]! - m[6]!) / s, (m[3]! - m[1]!) / s];
  }
  if (m[0]! > m[4]! && m[0]! > m[8]!) {
    const s = Math.sqrt(1 + m[0]! - m[4]! - m[8]!) * 2;
    return [(m[7]! - m[5]!) / s, 0.25 * s, (m[1]! + m[3]!) / s, (m[2]! + m[6]!) / s];
  }
  if (m[4]! > m[8]!) {
    const s = Math.sqrt(1 + m[4]! - m[0]! - m[8]!) * 2;
    return [(m[2]! - m[6]!) / s, (m[1]! + m[3]!) / s, 0.25 * s, (m[5]! + m[7]!) / s];
  }
  const s = Math.sqrt(1 + m[8]! - m[0]! - m[4]!) * 2;
  return [(m[3]! - m[1]!) / s, (m[2]! + m[6]!) / s, (m[5]! + m[7]!) / s, 0.25 * s];
}

describe('alignToFrames', () => {
  const q = [1, 0, 0, 0] as [number, number, number, number];
  it('snaps per-frame CORI onto frame times and shifts GRAV by the same offset', () => {
    const frames = [0, 16683, 33367, 50050];
    const data = { cori: frames.map((t) => ({ t: t + 43407, q })), grav: [{ t: 43407, v: [0, 1, 0] as [number, number, number] }], streams: [] };
    const a = alignToFrames(data, frames);
    expect(a.cori.map((s) => s.t)).toEqual(frames);
    expect(a.grav[0]!.t).toBeCloseTo(0, 3);
    expect(a.syncOffsetUs).toBeCloseTo(43407, 3);
  });
  it('aligns the first sample when counts differ', () => {
    const data = { cori: [0, 1, 2].map((i) => ({ t: 10_000 + i * 33_000, q })), grav: [], streams: [] };
    const a = alignToFrames(data, [0, 16683, 33367, 50050, 66733, 83417]);
    expect(a.cori[0]!.t).toBe(0);
    expect(a.cori[2]!.t).toBe(66_000);
  });
});

describe('smoothQuats', () => {
  const rotZ = (a: number) => [Math.cos(a / 2), 0, 0, Math.sin(a / 2)] as [number, number, number, number];
  it('removes vibration evenly at wide windows (no aliasing)', () => {
    // Slow turn plus 10 Hz vibration, 60 Hz samples, 20 s.
    const cori = Array.from({ length: 1200 }, (_, i) => {
      const t = i / 60;
      return { t: t * 1e6, q: rotZ(0.3 * t + 0.02 * Math.sin(2 * Math.PI * 10 * t)) };
    });
    const sm = smoothQuats(cori, 2_000_000);
    const ang = sm.map((s) => 2 * Math.atan2(s.q[3], s.q[0]));
    // Frame-to-frame steps in the middle should be smooth: second difference ~ 0.
    let worst = 0;
    for (let i = 400; i < 800; i++) worst = Math.max(worst, Math.abs(ang[i + 1]! - 2 * ang[i]! + ang[i - 1]!));
    expect(worst).toBeLessThan(1e-4);
  });
  it('handles sign flips in the input', () => {
    const cori = Array.from({ length: 100 }, (_, i) => {
      const q = rotZ(0.01 * i);
      return { t: i * 16_683, q: (i % 2 ? q.map((v) => -v) : q) as [number, number, number, number] };
    });
    const sm = smoothQuats(cori, 100_000);
    const ang = 2 * Math.atan2(sm[50]!.q[3] * Math.sign(sm[50]!.q[0]), Math.abs(sm[50]!.q[0]));
    expect(ang).toBeCloseTo(0.5, 2);
  });
});

describe('imageOrientation', () => {
  it('combines IORI before CORI (I·C) and ignores it in mode 0', () => {
    const c = [Math.cos(0.2), Math.sin(0.2), 0, 0] as [number, number, number, number]; // about x
    const i = [Math.cos(0.1), 0, 0, Math.sin(0.1)] as [number, number, number, number]; // about z
    const data: OrientationData = { cori: [{ t: 0, q: c }], iori: [{ t: 0, q: i }], grav: [], streams: [] };
    expect(imageOrientation(data, 0)[0]!.q).toEqual(c);
    const q = imageOrientation(data, 3)[0]!.q;
    // I·C = (cos.1 cos.2, cos.1 sin.2, sin.1 sin.2, sin.1 cos.2)
    const e = [Math.cos(0.1) * Math.cos(0.2), Math.cos(0.1) * Math.sin(0.2), Math.sin(0.1) * Math.sin(0.2), Math.sin(0.1) * Math.cos(0.2)];
    q.forEach((v, k) => expect(v).toBeCloseTo(e[k]!, 12));
  });
});
