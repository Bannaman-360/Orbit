import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyVerified, driveRoots, findCards, place, runImport, scanCard, Stopped, type CardFile, type Control, type ImportEvent } from './card';

let dir = '', card = '', dest = '';
const go: Control = { gate: async () => {} };

/** A file with a GoPro's layout: pictures first, index last. */
function movie(created: Date, seconds: number, fill: number, bytes = 200_000): Buffer {
  const box = (type: string, body: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(Math.round((created.getTime() - Date.UTC(1904, 0, 1)) / 1000), 4);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(seconds * 1000, 16);
  const big = Buffer.alloc(16);
  big.writeUInt32BE(1); big.write('mdat', 4, 'latin1'); big.writeBigUInt64BE(BigInt(16 + bytes), 8);
  return Buffer.concat([box('ftyp', Buffer.from('mp41')), big, Buffer.alloc(bytes, fill), box('moov', box('mvhd', mvhd))]);
}
const put = async (p: string, b: Buffer | string) => { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, b); };
const at = (s: string) => new Date(`${s}Z`);
const snapshot = async (d: string): Promise<string[]> => (await Promise.all((await readdir(d, { withFileTypes: true })).map(async (e) => { const p = path.join(d, e.name); if (e.isDirectory()) return snapshot(p); const s = await stat(p); return [`${p}|${s.size}|${s.mtimeMs}|${(await readFile(p)).reduce((x, y) => (x * 31 + y) >>> 0, 7)}`]; }))).flat().sort();

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ace-card-'));
  card = path.join(dir, 'drives', 'CARD');
  dest = path.join(dir, 'dest');
  const d = path.join(card, 'DCIM', '100GOPRO');
  await put(path.join(d, 'GX010200.MP4'), movie(at('2026-11-20T09:00:00'), 60, 1));
  await put(path.join(d, 'GX020200.MP4'), movie(at('2026-11-20T09:00:00'), 30, 2));
  await put(path.join(d, 'GX010200.THM'), 'jpeg');
  await put(path.join(d, 'GL010200.LRV'), 'small copy');
  await put(path.join(d, '._GX010200.MP4'), 'notes');
  await put(path.join(d, 'GS010201.360'), movie(at('2026-11-21T23:30:00'), 10, 3));
  await put(path.join(d, 'GX010202.MP4'), movie(at('2026-11-21T08:00:00'), 10, 4));
  await put(path.join(d, 'GX030202.MP4'), movie(at('2026-11-21T08:00:00'), 10, 5));
  await put(path.join(d, 'GX010203.MP4'), Buffer.alloc(5000, 6));
  await put(path.join(d, 'GOPR0204.JPG'), 'photo');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const run = async (recs: Awaited<ReturnType<typeof scanCard>>, ctl = go, test?: Parameters<typeof runImport>[3]) => {
  const ev: ImportEvent[] = [];
  await runImport({ root: card, dest, recordings: recs }, ctl, (e) => ev.push(e), test);
  return ev;
};

describe('finding cards', () => {
  it('lists drives with a DCIM folder only', async () => {
    await mkdir(path.join(dir, 'drives', 'Backup disk'));
    await writeFile(path.join(dir, 'drives', 'file'), '');
    expect(await findCards(await driveRoots('darwin', path.join(dir, 'drives')))).toEqual([{ root: card, name: 'CARD' }]);
  });
  it('knows Windows drive letters', async () => expect(await driveRoots('win32')).toContain('E:\\'));
});

describe('reading a card', () => {
  it('lists recordings oldest first, with parts together', async () => {
    const r = await scanCard(card);
    expect(r.map((x) => [x.name, x.files.length, x.day, x.seconds, x.is360])).toEqual([
      ['GX010200.MP4', 2, '2026-11-20', 90, false], ['GX010202.MP4', 1, '2026-11-21', 10, false], ['GX030202.MP4', 1, '2026-11-21', 10, false], ['GS010201.360', 1, '2026-11-21', 10, true],
      ['GX010203.MP4', 1, new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10), 0, false],
    ]);
    expect(path.basename(r[0]!.thumb!)).toBe('GX010200.THM');
    expect(r.map((x) => x.unfinished)).toEqual([false, false, false, false, true]);
  });
});

describe('importing', () => {
  it('copies everything exactly, by day, and leaves the card alone', async () => {
    const before = await snapshot(card), recs = await scanCard(card);
    const ev = await run(recs.slice(0, 4));
    expect(ev.filter((e) => e.type === 'done').length).toBe(4);
    expect(ev.at(-1)).toEqual({ type: 'end', stopped: false });
    for (const r of recs.slice(0, 4)) for (const f of r.files) {
      const to = path.join(dest, r.day, f.name);
      expect((await readFile(to)).equals(await readFile(f.path))).toBe(true);
      expect(Math.abs((await stat(to)).mtimeMs - f.mtimeMs)).toBeLessThan(2);
    }
    expect(await snapshot(card)).toEqual(before);
    expect((await readdir(path.join(dest, '2026-11-21'))).sort()).toEqual(['GS010201.360', 'GX010202.MP4', 'GX030202.MP4']);
    const bytes = ev.filter((e) => e.type === 'bytes');
    expect(bytes.every((b, i) => !i || b.copied >= bytes[i - 1]!.copied)).toBe(true);
  });
  it('a copy that comes out different is made again; a second time it is refused', async () => {
    const rec = (await scanCard(card)).slice(2, 3);
    let n = 0;
    const spoil = (times: number) => ({ written: async (p: string) => { if (n++ < times) { const b = await readFile(p); b[1000]! ^= 1; await writeFile(p, b); } } });
    const once = await run(rec, go, spoil(1));
    expect(once.some((e) => e.type === 'done')).toBe(true);
    await rm(dest, { recursive: true });
    n = 0;
    const twice = await run(rec, go, spoil(2));
    expect(twice.find((e) => e.type === 'failed')).toMatchObject({ error: expect.stringContaining('match') });
    expect(await readdir(path.join(dest, rec[0]!.day))).toEqual([]);
  });
  it('the same files again are recognised, not copied twice', async () => {
    const recs = (await scanCard(card)).slice(0, 2);
    await run(recs);
    const before = await snapshot(dest);
    expect((await run(recs)).filter((e) => e.type === 'done').length).toBe(2);
    expect(await snapshot(dest)).toEqual(before);
  });
  it('a different recording with the same name or number goes in its own folder, unrenamed', async () => {
    await run((await scanCard(card)).slice(0, 1));
    const d = path.join(card, 'DCIM', '101GOPRO');
    await put(path.join(d, 'GX010200.MP4'), movie(at('2026-11-20T17:00:00'), 5, 9));
    await put(path.join(d, 'GX030200.MP4'), movie(at('2026-11-20T18:00:00'), 5, 8));
    const more = (await scanCard(card)).filter((r) => r.id.includes('101GOPRO'));
    expect(more.length).toBe(2);
    await run(more);
    expect((await readdir(dest)).sort()).toEqual(['2026-11-20', '2026-11-20 2']);
    expect((await readdir(path.join(dest, '2026-11-20 2'))).sort()).toEqual(['GX010200.MP4', 'GX030200.MP4']);
  });
  it('same size but different contents is not mistaken for the same file', async () => {
    const [rec] = await scanCard(card);
    await run([rec!]);
    const there = path.join(dest, '2026-11-20', 'GX020200.MP4'), b = await readFile(there);
    b[5000]! ^= 1;
    await writeFile(there, b);
    expect((await place(path.join(dest, '2026-11-20'), rec!.files, go)).dir).toBe(path.join(dest, '2026-11-20 2'));
  });
  it('stopping leaves no half-written file and keeps what was complete', async () => {
    const recs = await scanCard(card);
    let n = 0;
    const ev = await run(recs, { gate: async () => { if (++n > 4) throw new Stopped(); } });
    expect(ev.at(-1)).toEqual({ type: 'end', stopped: true });
    const left = (await snapshot(dest)).map((x) => path.basename(x.split('|')[0]!));
    expect(left.some((x) => x.endsWith('.part'))).toBe(false);
    expect(left).toContain('GX010200.MP4');
    // Carrying on later finishes the rest in the same folder.
    expect((await run(recs)).filter((e) => e.type === 'done').length).toBe(5);
    expect((await readdir(path.join(dest, '2026-11-20'))).sort()).toEqual(['GX010200.MP4', 'GX020200.MP4']);
  });
  it('a card pulled out ends the import with the reason', async () => {
    const recs = await scanCard(card);
    const ev = await run(recs, { gate: async () => {} }, { written: async () => { await rm(card, { recursive: true, force: true }); } });
    expect(ev.at(-1)).toMatchObject({ type: 'end', error: expect.stringContaining('removed') });
    expect((await snapshot(dest)).some((x) => x.includes('.part'))).toBe(false);
  });
  it('one unreadable file does not stop the others', async () => {
    const recs = (await scanCard(card)).slice(0, 4);
    await rm(recs[1]!.files[0]!.path);
    const ev = await run(recs);
    expect(ev.filter((e) => e.type === 'done').length).toBe(3);
    expect(ev.filter((e) => e.type === 'failed').length).toBe(1);
  });
  it('refuses a file that ends early', async () => {
    const f: CardFile = (await scanCard(card))[0]!.files[0]!;
    await expect(copyVerified(f.path, path.join(dest, 'x.MP4'), { ...f, size: f.size + 1 }, go, { onCopy() {}, onCheck() {} })).rejects.toThrow('early');
    expect(await readdir(dest)).toEqual([]);
  });
  it('keeps file times exact to what the card says', async () => {
    const f = (await scanCard(card))[0]!.files[0]!, t = new Date('2026-03-01T12:00:00Z');
    await utimes(f.path, t, t);
    await run((await scanCard(card)).slice(0, 1));
    expect((await stat(path.join(dest, '2026-11-20', f.name))).mtimeMs).toBe(t.getTime());
  });
});
