import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findImportable, matchMissing } from './importPaths';

let root = '';
const f = async (rel: string) => { const p = path.join(root, rel); await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, 'x'); return p; };

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ace-import-'));
  await f('ride/GX010133.MP4');
  await f('ride/GL010133.LRV');
  await f('ride/GL010140.LRV'); // no full file next to it: kept
  await f('ride/GX010133.THM');
  await f('ride/notes.txt');
  await f('ride/.hidden/GX019999.MP4');
  await f('card/DCIM/100GOPRO/GS010083.360');
  await f('card/DCIM/100GOPRO/GS010083.mp4.app/x.mp4');
  await f('song.MP3');
  await f('photo.jpg');
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe('finding what can be imported', () => {
  it('files and folders, with proxies and clutter left out', async () => {
    const r = await findImportable([path.join(root, 'ride'), path.join(root, 'card'), path.join(root, 'song.MP3'), path.join(root, 'photo.jpg'), path.join(root, 'gone.mp4')]);
    expect(r.video.map((p) => path.relative(root, p))).toEqual(['ride/GL010140.LRV', 'ride/GX010133.MP4', 'card/DCIM/100GOPRO/GS010083.360']);
    expect(r.audio.map((p) => path.basename(p))).toEqual(['song.MP3']);
    expect(r.skipped.map((s) => s.name)).toEqual(['photo.jpg', 'gone.mp4']);
    expect(r.skipped[0]!.why).toContain('.jpg');
  });
  it('a single dropped file', async () => {
    const r = await findImportable([path.join(root, 'ride/GX010133.MP4')]);
    expect(r.video).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
  });
});

describe('relink', () => {
  const C = (p: string, size: number) => ({ path: p, size });
  it('finds moved files by name and size, then name, then size alone', () => {
    const r = matchMissing(
      [{ path: '/old/GX010132.MP4', size: 5_000_000 }, { path: '/old/GS010004.360' }, { path: '/old/renamed.mp4', size: 7_777_777 }, { path: '/old/lost.mp4', size: 3_000_000 }],
      [C('/new/a/GX010132.MP4', 4_000_000), C('/new/b/gx010132.mp4', 5_000_000), C('/new/GS010004.360', 9), C('/new/Ride 3.mp4', 7_777_777)],
    );
    expect(r).toEqual([
      { from: '/old/GX010132.MP4', to: '/new/b/gx010132.mp4', how: 'name and size' },
      { from: '/old/GS010004.360', to: '/new/GS010004.360', how: 'name' },
      { from: '/old/renamed.mp4', to: '/new/Ride 3.mp4', how: 'size' },
    ]);
  });
  it('uses each found file once', () => {
    const r = matchMissing([{ path: '/x/A.MP4' }, { path: '/y/A.MP4' }], [C('/n/A.MP4', 1)]);
    expect(r).toHaveLength(1);
  });
});
