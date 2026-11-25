// One-press export settings for social media (checked 2026-11).
//
// Sources: YouTube's "Recommended upload encoding settings" (H.264 High profile in MP4; SDR 1080p
// 8 Mbps at 24–30 fps, 12 Mbps at 48–60; 4K 35–45 / 53–68 Mbps; upload at the frame rate it was
// filmed). TikTok, Instagram, Facebook and Snapchat publish no bit rates: they re-encode every
// upload, so a clean 1080×1920 H.264 at a generous bit rate keeps the most detail after theirs.
// None publishes a loudness target; −14 LUFS with peaks under −1 dB is what they (and YouTube)
// are measured to play at, so louder uploads are only turned down.

import type { ExportOptions, Quality, Resolution } from './exporter';

export type Codec = ExportOptions['codec'];

export interface ExportPreset {
  id: string;
  name: string;
  /** Output shape (the edit is reframed to fill it); missing = the edit's own. */
  framing?: '16:9' | '9:16';
  /** Missing = H.264. */
  codec?: Codec;
  resolution: Resolution;
  /** Frame rates the platform takes; the edit's own is used when it is one of them (else the nearest). */
  fps: number[];
  /** Video bit rate, bits a second, for 30 fps (60 fps gets 1.5×). */
  bitrate: number;
  /** Integrated loudness the sound is brought to (LUFS). */
  loudness: number;
  /** Longest video the platform takes (s), for a warning. */
  maxSeconds?: number;
  note: string;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: 'youtube', name: 'YouTube', framing: '16:9', resolution: 2160, fps: [24, 25, 30, 50, 60], bitrate: 40e6, loudness: -14, note: '16:9, 4K when the footage is 4K (else 1080p), at the frame rate it was filmed. YouTube’s recommended bit rates.' },
  { id: 'youtube-1080', name: 'YouTube 1080p', framing: '16:9', resolution: 1080, fps: [24, 25, 30, 50, 60], bitrate: 8e6, loudness: -14, note: '16:9 1080p at the frame rate it was filmed: quicker to upload than 4K.' },
  { id: 'shorts', name: 'YouTube Shorts', framing: '9:16', resolution: 1080, fps: [24, 25, 30, 50, 60], bitrate: 12e6, loudness: -14, maxSeconds: 180, note: '1080×1920 vertical, up to 3 minutes.' },
  { id: 'tiktok', name: 'TikTok', framing: '9:16', resolution: 1080, fps: [30, 60], bitrate: 10e6, loudness: -14, maxSeconds: 600, note: '1080×1920 vertical, up to 10 minutes. TikTok re-encodes uploads, so this leaves it plenty of detail.' },
  { id: 'reels', name: 'Instagram Reels', framing: '9:16', resolution: 1080, fps: [30], bitrate: 10e6, loudness: -14, maxSeconds: 900, note: '1080×1920 vertical at 30 fps, up to 15 minutes.' },
  { id: 'facebook', name: 'Facebook', framing: '9:16', resolution: 1080, fps: [30, 60], bitrate: 10e6, loudness: -14, maxSeconds: 900, note: 'Facebook now posts videos as Reels: 1080×1920 vertical.' },
  { id: 'archive', name: 'Archive (ProRes)', resolution: 2160, codec: 'prores', fps: [24, 25, 30, 50, 60], bitrate: 0, loudness: -14, note: 'ProRes 422 HQ in your edit’s own shape, 4K when the footage has the detail: the best copy to keep or finish in another editor. Very large files.' },
  { id: 'snapchat', name: 'Snapchat', framing: '9:16', resolution: 1080, fps: [30], bitrate: 8e6, loudness: -14, maxSeconds: 60, note: '1080×1920 vertical at 30 fps; Spotlight takes up to 60 seconds.' },
];

/** The settings a preset gives for an edit filmed at `sourceFps` whose biggest clip is `sourceHeight` tall. */
export function presetSettings(p: ExportPreset, sourceFps: number, sourceHeight: number, editFraming = '16:9'): { framing: string; resolution: Resolution; fps: number; bitrate: number; loudness: number; codec: Codec } {
  const fps = p.fps.reduce((best, f) => (Math.abs(f - sourceFps) < Math.abs(best - sourceFps) ? f : best), p.fps[0]!);
  // 4K only when the footage has the detail for it (360 footage reframed to 16:9 rarely does).
  const resolution: Resolution = p.resolution === 2160 && sourceHeight < 2000 ? 1080 : p.resolution;
  const high = fps >= 48;
  let bitrate = p.bitrate * (high ? 1.5 : 1);
  if (p.id === 'youtube') bitrate = resolution === 2160 ? (high ? 60e6 : 40e6) : high ? 12e6 : 8e6;
  if (p.id === 'youtube-1080') bitrate = high ? 12e6 : 8e6;
  return { framing: p.framing ?? editFraming, resolution, fps, bitrate, loudness: p.loudness, codec: p.codec ?? 'avc' };
}

/** Export settings the user saved under a name. */
export interface UserPreset { id: string; name: string; resolution: Resolution; fps: number; codec: Codec; quality: Quality; loudness: number | null; framing?: string }
const KEY = 'ace.exportPresets.v1';
export function userPresets(): UserPreset[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && [720, 1080, 1440, 2160].includes(p.resolution) && typeof p.fps === 'number' && ['avc', 'hevc', 'hevc10', 'prores'].includes(p.codec)) : [];
  } catch { return []; }
}
export function saveUserPresets(list: UserPreset[]) { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 40))); }

/** Sound levels to export at (LUFS); null leaves the level as mixed (peaks are still kept under −1 dBTP). */
export const LOUDNESS_CHOICES: [number | null, string][] = [[-14, '−14 LUFS (YouTube, social media)'], [-16, '−16 LUFS (Apple, podcasts)'], [-23, '−23 LUFS (TV)'], [null, 'Leave as mixed']];
