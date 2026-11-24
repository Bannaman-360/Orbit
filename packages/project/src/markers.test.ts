import { describe, expect, it } from 'vitest';
import { addClip, addMarker, emptyTimeline, loadTimeline, markerNear, newClip, removeMarker, rippleItems, trimClip, TIMELINE_VERSION, updateMarker, youtubeChapters } from './timeline';

const S = 1e6;

describe('project version 2', () => {
  it('opens a version 1 project unchanged, with no markers', () => {
    const v1 = { version: 1, clips: [{ mediaPath: '/a.mp4', inUs: 0, outUs: 5 * S }], audio: [], framing: '16:9', lutPath: null, overlays: [] };
    const tl = loadTimeline(v1);
    expect(tl.version).toBe(TIMELINE_VERSION);
    expect(tl.markers).toEqual([]);
    expect(tl.clips[0]!.mediaPath).toBe('/a.mp4');
    expect(tl.clips[0]!.outUs).toBe(5 * S);
  });
  it('keeps markers through saving and loading, sorted and cleaned up', () => {
    const raw = { markers: [{ id: 'b', t: 9 * S, note: 'Jump', color: 'red' }, { id: 'a', t: 2 * S, note: 'Start', color: 'nope' }, { t: Number.NaN }] };
    const tl = loadTimeline(JSON.parse(JSON.stringify(raw)));
    expect(tl.markers.map((m) => [m.id, m.t, m.color])).toEqual([['a', 2 * S, 'blue'], ['b', 9 * S, 'red']]);
  });
});

describe('markers', () => {
  it('adds, edits, finds and removes', () => {
    let { tl, id } = addMarker(emptyTimeline(), 3 * S, 'Big jump', 'orange');
    tl = addMarker(tl, 1 * S).tl;
    expect(tl.markers.map((m) => m.t)).toEqual([1 * S, 3 * S]);
    tl = updateMarker(tl, id, { note: 'Bigger jump', t: 0.5 * S });
    expect(tl.markers[0]!.note).toBe('Bigger jump');
    expect(markerNear(tl, 0.6 * S, 0.2 * S)?.id).toBe(id);
    expect(markerNear(tl, 2 * S, 0.2 * S)).toBeUndefined();
    expect(removeMarker(tl, id).markers).toHaveLength(1);
  });
  it('move with the picture when a clip before them is trimmed', () => {
    const a = newClip('/a.mp4', 10 * S, false), b = newClip('/b.mp4', 10 * S, false);
    let tl = addClip(addClip(emptyTimeline(), a), b);
    tl = addMarker(tl, 15 * S, 'on b').tl;
    const after = rippleItems(tl, trimClip(tl, a.id, 2 * S, 10 * S, 10 * S), a.id);
    expect(after.markers[0]!.t).toBe(13 * S);
  });
  it('make YouTube chapters, saying what YouTube would reject', () => {
    let tl = emptyTimeline();
    tl = addMarker(tl, 0, 'Intro').tl;
    tl = addMarker(tl, 75 * S, 'Pump track').tl;
    expect(youtubeChapters(tl).problem).toMatch(/three/);
    tl = addMarker(tl, 3725 * S, '').tl;
    const c = youtubeChapters(tl);
    expect(c.text).toBe('0:00 Intro\n1:15 Pump track\n1:02:05 Chapter 3');
    expect(c.problem).toBeUndefined();
    expect(youtubeChapters(addMarker(tl, 80 * S).tl).problem).toMatch(/10 seconds/);
  });
});
