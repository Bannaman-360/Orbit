import { describe, expect, it } from 'vitest';
import { mixLook } from './keyframes';
import { DEFAULT_LOOK, IDENTITY_XF, isIdentityXf } from './look';
import {
  addTrack, applyLayout, cellTransform, connectedAt, hitsLayer, LAYOUT_TEMPLATES, moveConnected, placeConnected, removeTrack,
  shownRect, splitConnected, stackAt, trackFree, trimEmptyTracks, updateTrack,
} from './layers';
import { addClip, emptyTimeline, insertClipAt, loadTimeline, MAX_TRACKS, newClip, removeClip, rippleItems, TIMELINE_VERSION, updateClip } from './timeline';

const S = 1_000_000;
const base = () => addClip(addClip(emptyTimeline(), newClip('/a.mp4', 10 * S, false)), newClip('/b.mp4', 10 * S, false));
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('tracks above the main row', () => {
  it('places a clip on V2 and finds a free track when V2 is taken', () => {
    let tl = base();
    const a = placeConnected(tl, newClip('/p.mp4', 4 * S, false), 2 * S)!;
    tl = a.tl;
    expect(tl.tracks).toHaveLength(1);
    expect(tl.connected[0]).toMatchObject({ id: a.id, startUs: 2 * S, trackId: tl.tracks[0]!.id });
    const b = placeConnected(tl, newClip('/q.mp4', 4 * S, false), 5 * S)!;
    tl = b.tl;
    expect(tl.tracks).toHaveLength(2);
    expect(tl.connected[1]!.trackId).toBe(tl.tracks[1]!.id);
    // After the first one ends, V2 is free again.
    const c = placeConnected(tl, newClip('/r.mp4', 1 * S, false), 6 * S)!;
    expect(c.tl.connected[2]!.trackId).toBe(tl.tracks[0]!.id);
  });

  it('stops at six video tracks', () => {
    let tl = base();
    for (let i = 0; i < MAX_TRACKS; i++) tl = placeConnected(tl, newClip('/p.mp4', 4 * S, false), 0)!.tl;
    expect(tl.tracks).toHaveLength(MAX_TRACKS);
    expect(placeConnected(tl, newClip('/p.mp4', 4 * S, false), 0)).toBeNull();
    expect(addTrack(tl).id).toBeNull();
  });

  it('refuses moves onto a taken place or a locked track', () => {
    let tl = base();
    tl = placeConnected(tl, newClip('/p.mp4', 4 * S, false), 0)!.tl;
    tl = placeConnected(tl, newClip('/q.mp4', 4 * S, false), 6 * S)!.tl;
    const [p, q] = tl.connected;
    expect(moveConnected(tl, q!.id, 3 * S)).toBe(tl);
    const moved = moveConnected(tl, q!.id, 4 * S);
    expect(moved.connected[1]!.startUs).toBe(4 * S);
    const locked = updateTrack(tl, tl.tracks[0]!.id, { locked: true });
    expect(moveConnected(locked, p!.id, 1 * S)).toBe(locked);
    expect(trackFree(tl, tl.tracks[0]!.id, 4 * S, 6 * S)).toBe(true);
  });

  it('shows the stack bottom first, leaving out hidden tracks', () => {
    let tl = base();
    tl = placeConnected(tl, newClip('/p.mp4', 4 * S, false), 2 * S)!.tl;
    tl = placeConnected(tl, newClip('/q.mp4', 4 * S, false), 3 * S)!.tl;
    const st = stackAt(tl, 3.5 * S)!;
    expect(st.layers.map((l) => [l.clip.mediaPath, l.track])).toEqual([['/a.mp4', 0], ['/p.mp4', 1], ['/q.mp4', 2]]);
    expect(st.layers[1]!.mediaUs).toBe(1.5 * S);
    const hidden = updateTrack(tl, tl.tracks[0]!.id, { hidden: true });
    expect(stackAt(hidden, 3.5 * S)!.layers.map((l) => l.clip.mediaPath)).toEqual(['/a.mp4', '/q.mp4']);
    // Nothing past the end of the edit.
    const late = placeConnected(tl, newClip('/z.mp4', 4 * S, false), 19 * S)!.tl;
    expect(connectedAt(late, 19.5 * S).map((l) => l.clip.mediaPath)).toContain('/z.mp4');
    expect(connectedAt(late, 20.5 * S)).toEqual([]);
  });

  it('splits a track clip at the playhead', () => {
    let tl = placeConnected(base(), newClip('/p.mp4', 4 * S, false), 2 * S)!.tl;
    tl = splitConnected(tl, tl.connected[0]!.id, 3 * S);
    expect(tl.connected.map((c) => [c.startUs, c.inUs, c.outUs])).toEqual([[2 * S, 0, 1 * S], [3 * S, 1 * S, 4 * S]]);
  });

  it('moves track clips along with the main row', () => {
    let tl = placeConnected(base(), newClip('/p.mp4', 2 * S, false), 12 * S)!.tl;
    const before = tl;
    // The first clip gets 2 s shorter: things after it move 2 s earlier.
    tl = rippleItems(before, updateClip(before, before.clips[0]!.id, { outUs: 8 * S }), before.clips[0]!.id);
    expect(tl.connected[0]!.startUs).toBe(10 * S);
    // Insert before it pushes it on.
    const ins = insertClipAt(before, newClip('/i.mp4', 3 * S, false), 5 * S);
    expect(ins.connected[0]!.startUs).toBe(15 * S);
  });

  it('removes tracks and their clips', () => {
    let tl = placeConnected(base(), newClip('/p.mp4', 2 * S, false), 0)!.tl;
    tl = placeConnected(tl, newClip('/q.mp4', 2 * S, false), 0)!.tl;
    expect(removeTrack(tl, tl.tracks[0]!.id).connected.map((c) => c.mediaPath)).toEqual(['/q.mp4']);
    const gone = removeClip(tl, tl.connected[1]!.id);
    expect(trimEmptyTracks(gone).tracks).toHaveLength(1);
  });

  it('saves and loads tracks; older projects get none', () => {
    let tl = placeConnected(base(), newClip('/p.mp4', 2 * S, false), S)!.tl;
    tl = updateTrack(tl, tl.tracks[0]!.id, { muted: true });
    const back = loadTimeline(JSON.parse(JSON.stringify(tl)));
    expect(back.version).toBe(TIMELINE_VERSION);
    expect(back.tracks).toEqual(tl.tracks);
    expect(back.connected[0]).toMatchObject({ startUs: S, trackId: tl.tracks[0]!.id, mediaPath: '/p.mp4' });
    const old = loadTimeline({ version: 2, clips: [newClip('/a.mp4', S, false)] });
    expect(old.tracks).toEqual([]);
    expect(old.connected).toEqual([]);
    // A clip whose track is missing is dropped.
    expect(loadTimeline({ ...JSON.parse(JSON.stringify(tl)), tracks: [] }).connected).toEqual([]);
  });
});

describe('transform', () => {
  it('fills a half-frame cell, cropping evenly', () => {
    const xf = cellTransform([0, 0, 0.5, 1], 'fill');
    expect(xf.scale).toBe(1);
    close(xf.crop[0], 0.25);
    close(xf.x, -0.25);
    const r = shownRect(xf);
    close(r.x, 0); close(r.w, 0.5); close(r.y, 0); close(r.h, 1);
  });

  it('puts every layout cell exactly where it says', () => {
    for (const lay of LAYOUT_TEMPLATES) {
      for (const cell of lay.cells) {
        const r = shownRect(cellTransform(cell, lay.fill));
        if (lay.fill === 'fill') { close(r.x, cell[0]); close(r.y, cell[1]); close(r.w, cell[2]); close(r.h, cell[3]); }
        else { expect(r.w).toBeLessThanOrEqual(cell[2] + 1e-9); expect(r.h).toBeLessThanOrEqual(cell[3] + 1e-9); }
      }
    }
  });

  it('applies a layout to what is on screen', () => {
    let tl = placeConnected(base(), newClip('/p.mp4', 4 * S, false), 2 * S)!.tl;
    tl = applyLayout(tl, 3 * S, 'split-h');
    const a = shownRect(tl.clips[0]!.look.xf!), p = shownRect(tl.connected[0]!.look.xf!);
    close(a.x, 0); close(p.x, 0.5); close(p.w, 0.5);
    // The second main-row clip isn't on screen, so it stays full frame.
    expect(tl.clips[1]!.look.xf).toBeUndefined();
    expect(isIdentityXf(applyLayout(tl, 3 * S, 'full').clips[0]!.look.xf)).toBe(true);
  });

  it('hits only the shown picture, rotation included', () => {
    const xf = { ...cellTransform([0.6, 0.6, 0.3, 0.3], 'fit') };
    expect(hitsLayer(xf, 0.75, 0.75, 16 / 9)).toBe(true);
    expect(hitsLayer(xf, 0.3, 0.3, 16 / 9)).toBe(false);
    const turned = { ...IDENTITY_XF, scale: 0.5, rotate: 90 };
    // A 16:9 picture on its side is tall and narrow.
    expect(hitsLayer(turned, 0.5, 0.5 + 0.2, 16 / 9)).toBe(true);
    expect(hitsLayer(turned, 0.5 + 0.2, 0.5, 16 / 9)).toBe(false);
  });

  it('keyframes the transform', () => {
    const a = { ...DEFAULT_LOOK, xf: { ...IDENTITY_XF, x: 0, scale: 0.25 } };
    const b = { ...DEFAULT_LOOK, xf: { ...IDENTITY_XF, x: 0.4, scale: 1 } };
    const m = mixLook(a, b, 0.5);
    close(m.xf!.x, 0.2);
    close(m.xf!.scale, 0.5);
    // From no transform to one.
    close(mixLook(DEFAULT_LOOK, b, 0.5).xf!.x, 0.2);
    expect(mixLook(DEFAULT_LOOK, DEFAULT_LOOK, 0.5).xf).toBeUndefined();
  });
});
