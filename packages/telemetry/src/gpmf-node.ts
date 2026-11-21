// GPMF telemetry extraction. Node-only (runs in Electron's main process) because
// gopro-telemetry relies on Node's Buffer.

import goproTelemetry from 'gopro-telemetry';
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
}

type Readfn = (offset: number, length: number) => Promise<Buffer>;

interface TelemetrySample { cts: number; value: number[] | number }
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
    { stream: ['GRAV', 'CORI'], timeOut: 'cts', tolerant: true },
  )) as unknown as TelemetryOut;

  const grav: TimedVec3[] = [];
  const cori: TimedQuat[] = [];
  for (const dev of Object.values(out)) {
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
  return { grav, cori, streams: [...streams].sort() };
}
