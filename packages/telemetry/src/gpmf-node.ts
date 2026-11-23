// GPMF telemetry extraction. Node-only (runs in Electron's main process) because
// gopro-telemetry relies on Node's Buffer.

import goproTelemetry from 'gopro-telemetry';
import type { GpsSample } from './metrics';
import type { OrientationData, TimedQuat, TimedVec3 } from './orientation';

export interface GpmfSampleRef {
  offset: number;
  size: number;
  /** µs */
  timestamp: number;
  duration: number;
}

export interface GpmfRequest {
  samples: GpmfSampleRef[];
  durationUs: number;
  created?: string;
  /** Also return the gyroscope at full rate. */
  gyro?: boolean;
}

type Readfn = (offset: number, length: number) => Promise<Buffer>;

interface TelemetrySample { cts: number; value: number[] | number; sticky?: Record<string, unknown> }
type TelemetryOut = Record<string, { streams?: Record<string, { samples?: TelemetrySample[] }> }>;

export async function extractOrientation(read: Readfn, req: GpmfRequest): Promise<OrientationData> {
  const parts: Buffer[] = [];
  for (const s of req.samples) parts.push(await read(s.offset, s.size));
  const rawData = Buffer.concat(parts);
  const timing = {
    frameDuration: req.samples.length ? req.samples[0]!.duration / 1e6 : 1,
    videoDuration: req.durationUs / 1e6,
    start: req.created ? new Date(req.created) : new Date(0),
    samples: req.samples.map((s) => ({ cts: s.timestamp / 1000, duration: s.duration / 1000 })),
  };

  // Diagnostics: list every stream in the file.
  const list = (await goproTelemetry({ rawData, timing }, { streamList: true, tolerant: true })) as unknown as TelemetryOut;
  const streams = new Set<string>();
  for (const dev of Object.values(list)) for (const k of Object.keys(dev.streams ?? {})) streams.add(k);

  const out = (await goproTelemetry(
    { rawData, timing },
    { stream: ['GRAV', 'CORI', 'IORI', 'GPS5', 'GPS9', 'ACCL', ...(req.gyro ? (['GYRO'] as unknown as 'ACCL'[]) : [])], timeOut: 'cts', tolerant: true },
  )) as unknown as TelemetryOut;

  const grav: TimedVec3[] = [];
  const cori: TimedQuat[] = [];
  const iori: TimedQuat[] = [];
  const gps: GpsSample[] = [];
  const accl: TimedVec3[] = [];
  const gyro: TimedVec3[] = [];
  for (const dev of Object.values(out)) {
    // GPS9 (Max 2 and newer): lat, lon, alt, 2D speed, 3D speed, days, secs, DOP, fix.
    for (const s of dev.streams?.GPS9?.samples ?? []) {
      const v = s.value;
      if (Array.isArray(v) && v.length >= 9) gps.push({ t: s.cts * 1000, lat: v[0]!, lon: v[1]!, alt: v[2]!, speed: v[3]!, fix: v[8]! });
    }
    // GPS5 (original Max, Hero 5–10): lat, lon, alt, 2D speed, 3D speed; fix is a sticky value.
    if (!dev.streams?.GPS9?.samples?.length) {
      let fix = 3;
      for (const s of dev.streams?.GPS5?.samples ?? []) {
        const f = s.sticky?.fix ?? s.sticky?.GPSF;
        if (typeof f === 'number') fix = f;
        const v = s.value;
        if (Array.isArray(v) && v.length >= 4) gps.push({ t: s.cts * 1000, lat: v[0]!, lon: v[1]!, alt: v[2]!, speed: v[3]!, fix });
      }
    }
    // Accelerometer: averaged down to ~50 Hz (enough for a G-force readout).
    const acc = dev.streams?.ACCL?.samples ?? [];
    for (let i = 0; i < acc.length; i += 4) {
      const n = Math.min(4, acc.length - i);
      const m: [number, number, number] = [0, 0, 0];
      for (let j = 0; j < n; j++) {
        const v = acc[i + j]!.value;
        if (Array.isArray(v)) { m[0] += v[0]! / n; m[1] += v[1]! / n; m[2] += v[2]! / n; }
      }
      accl.push({ t: acc[i + Math.floor(n / 2)]!.cts * 1000, v: m });
    }
    for (const s of dev.streams?.GYRO?.samples ?? []) {
      if (Array.isArray(s.value) && s.value.length >= 3) gyro.push({ t: s.cts * 1000, v: [s.value[0]!, s.value[1]!, s.value[2]!] });
    }
    for (const s of dev.streams?.IORI?.samples ?? []) {
      if (Array.isArray(s.value) && s.value.length >= 4)
        iori.push({ t: s.cts * 1000, q: [s.value[0]!, s.value[1]!, s.value[2]!, s.value[3]!] });
    }
    for (const s of dev.streams?.GRAV?.samples ?? []) {
      if (Array.isArray(s.value) && s.value.length >= 3) grav.push({ t: s.cts * 1000, v: [s.value[0]!, s.value[1]!, s.value[2]!] });
    }
    for (const s of dev.streams?.CORI?.samples ?? []) {
      if (Array.isArray(s.value) && s.value.length >= 4)
        cori.push({ t: s.cts * 1000, q: [s.value[0]!, s.value[1]!, s.value[2]!, s.value[3]!] });
    }
  }
  grav.sort((a, b) => a.t - b.t);
  cori.sort((a, b) => a.t - b.t);
  iori.sort((a, b) => a.t - b.t);
  gps.sort((a, b) => a.t - b.t);
  accl.sort((a, b) => a.t - b.t);
  gyro.sort((a, b) => a.t - b.t);
  return { grav, cori, iori, gps, accl, ...(req.gyro ? { gyro } : {}), streams: [...streams].sort() };
}
