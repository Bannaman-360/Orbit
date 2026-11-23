import { describe, expect, it } from 'vitest';
import { cannotFollow, chapterName, chaptersOf, joinMedia, joinReaders } from './chapters';
import type { MediaInfo } from './source';

const reader = (d: number[]) => ({ size: d.length, read: async (o: number, n: number) => Uint8Array.from(d.slice(o, o + n)) });
const info = (o: Partial<MediaInfo> = {}, frames = 3): MediaInfo => ({
  durationUs: frames * 100, audioTrackCount: 1, created: new Date('2026-11-22T10:00:00Z'),
  videoTracks: [{ id: 1, codec: 'hvc1', width: 100, height: 50, fps: 30, turns: 0, description: Uint8Array.from([1, 2]), samples: Array.from({ length: frames }, (_, i) => ({ offset: i, size: 1, timestamp: i * 100, duration: 100, dts: i * 100, isSync: i === 0 })) }],
  audioTracks: [{ id: 2, codec: 'mp4a', sampleRate: 48000, channels: 2, samples: [{ offset: 3, size: 1, timestamp: 0, duration: 40, dts: 0, isSync: true }, { offset: 4, size: 1, timestamp: 40, duration: 40, dts: 40, isSync: true }] }],
  ...o,
});

describe('chapter names', () => {
  it('reads every GoPro scheme', () => {
    expect(chapterName('/a/GX010133.MP4')).toEqual({ key: 'gx0133.mp4', part: 1 });
    expect(chapterName('gs030007.360')).toEqual({ key: 'gs0007.360', part: 3 });
    expect(chapterName('C:\\x\\GH120007.mp4')).toEqual({ key: 'gh0007.mp4', part: 12 });
    expect(chapterName('GOPR0042.MP4')).toEqual({ key: 'gopr0042.mp4', part: 1 });
    expect(chapterName('GP010042.MP4')).toEqual({ key: 'gopr0042.mp4', part: 2 });
    for (const n of ['GX000133.MP4', 'GX010133 (1).MP4', 'GXAA0133.MP4', 'holiday.mp4', 'GX010133.LRV', 'GL010133.LRV', 'GP000042.MP4']) expect(chapterName(n)).toBeNull();
  });
  it('groups a folder', () => {
    const dir = ['GX010133.MP4', 'GX030133.MP4', 'GX020133.MP4', 'GX010134.MP4', 'GS020133.360', 'GX020133.LRV', 'notes.txt'];
    expect(chaptersOf('GX020133.MP4', dir).map((x) => [x.name, x.part])).toEqual([['GX010133.MP4', 1], ['GX020133.MP4', 2], ['GX030133.MP4', 3]]);
    expect(chaptersOf('GX010134.MP4', dir)).toHaveLength(1);
    expect(chaptersOf('notes.txt', dir)).toEqual([]);
  });
});

describe('joining', () => {
  it('refuses what does not belong', () => {
    const a = info();
    expect(cannotFollow(a, a, info())).toBeNull();
    expect(cannotFollow(a, a, info({ videoTracks: [{ ...a.videoTracks[0]!, width: 99 }] }))).toMatch(/size/);
    expect(cannotFollow(a, a, info({ videoTracks: [{ ...a.videoTracks[0]!, fps: 60 }] }))).toMatch(/frame rate/);
    expect(cannotFollow(a, a, info({ videoTracks: [{ ...a.videoTracks[0]!, description: Uint8Array.from([1, 3]) }] }))).toMatch(/encoded/);
    expect(cannotFollow(a, a, info({ audioTracks: [] }))).toMatch(/sound/);
    expect(cannotFollow(a, a, info({ created: new Date('2026-11-23T10:00:00Z') }))).toMatch(/time/);
    expect(cannotFollow(a, a, info({ created: new Date('2026-11-21T10:00:00Z') }))).toMatch(/time/);
    expect(cannotFollow(a, a, info({ created: new Date('2026-11-22T10:04:00Z') }))).toBeNull();
    expect(cannotFollow(a, a, info({ created: new Date('2026-11-22T10:30:00Z') }), 40 * 60e6)).toBeNull();
    expect(cannotFollow(a, a, info({ created: undefined }))).toBeNull();
  });
  it('reads across files', async () => {
    const r = joinReaders([reader([1, 2, 3]), reader([4]), reader([5, 6, 7, 8])]);
    expect(r.size).toBe(8);
    for (let o = 0; o < 8; o++) for (let n = 1; n < 10; n++) expect([...(await r.read(o, n))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8].slice(o, o + n));
  });
  it('puts samples one after another', () => {
    const j = joinMedia([{ reader: reader([0, 0, 0, 0, 0]), info: info() }, { reader: reader([0, 0, 0, 0, 0, 0]), info: info({}, 2) }, { reader: reader([0]), info: info() }]);
    expect(j.starts).toEqual([0, 300, 500]);
    expect(j.info.videoTracks[0]!.samples.map((s) => [s.offset, s.timestamp, s.dts])).toEqual([[0, 0, 0], [1, 100, 100], [2, 200, 200], [5, 300, 300], [6, 400, 400], [11, 500, 500], [12, 600, 600], [13, 700, 700]]);
    expect(j.info.audioTracks[0]!.joins).toEqual([2, 4]);
    expect(j.info.audioTracks[0]!.samples.map((s) => s.timestamp)).toEqual([0, 40, 300, 340, 500, 540]);
    expect(j.info.durationUs).toBe(800);
  });
  it('lets sound carry on where files meet within a packet', () => {
    const part = (end: number) => {
      const m = info();
      m.audioTracks[0]!.samples = Array.from({ length: end / 50 }, (_, i) => ({ offset: 3, size: 1, timestamp: i * 50, duration: 50, dts: i * 50, isSync: true }));
      return { reader: reader([0, 0, 0, 0, 0]), info: m };
    };
    // (The picture is 300 long.)
    expect(joinMedia([part(350), part(300), part(100), part(300)]).info.audioTracks[0]!.samples.filter((s, i) => i % 1 === 0 && s.timestamp >= 300).map((s) => s.timestamp).slice(0, 3)).toEqual([300, 350, 400]);
    const t = joinMedia([part(350), part(300), part(100), part(300)]).info.audioTracks[0]!;
    expect(t.joins!.map((j) => t.samples[j]!.timestamp)).toEqual([350, 650, 900]);
  });
});
