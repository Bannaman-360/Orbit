// Everything needed to play one file: container index, decoders, layout, telemetry.

import { find360Pair, openMedia, probeDecoder, SyncedPlayer, type DecoderSupport, type MediaInfo } from '@ace/engine';
import { goproMaxLayout, type EacLayout } from '@ace/media360';
import { smoothGravity, type OrientationData } from '@ace/telemetry';
import { ace, ipcReader } from './api';

export interface Session {
  path: string;
  size: number;
  info: MediaInfo;
  is360: boolean;
  support: DecoderSupport[];
  player: SyncedPlayer;
  layout: EacLayout | null;
  orientation: OrientationData | null;
  telemetryError?: string;
  openMs: number;
}

export async function openSession(path: string, size: number): Promise<Session> {
  const t0 = performance.now();
  const reader = ipcReader(path, size);
  const info = await openMedia(reader);
  const pair = find360Pair(info);
  const tracks = pair ?? info.videoTracks.slice(0, 1);
  if (!tracks.length) throw new Error('No video track found');
  const support = await Promise.all(tracks.map(probeDecoder));
  const bad = support.find((s) => !s.supported);
  if (bad) throw new Error(`This machine cannot decode ${bad.codec}${bad.detail ? ` (${bad.detail})` : ''}`);

  const player = new SyncedPlayer(reader, tracks);
  const layout = pair ? goproMaxLayout(pair[0].width, pair[0].height) : null;

  let orientation: OrientationData | null = null;
  let telemetryError: string | undefined;
  if (info.gpmfTrack) {
    try {
      const raw = await ace.orientation(path, {
        samples: info.gpmfTrack.samples.map(({ offset, size, timestamp, duration }) => ({ offset, size, timestamp, duration })),
        durationUs: info.durationUs,
        created: info.created?.toISOString(),
      });
      orientation = { ...raw, grav: smoothGravity(raw.grav) };
    } catch (e) {
      telemetryError = String(e);
    }
  }

  return { path, size, info, is360: !!pair, support, player, layout, orientation, telemetryError, openMs: performance.now() - t0 };
}
