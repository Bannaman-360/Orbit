// Stitched 360 videos (equirectangular MP4, as downloaded from GoPro's site).

import { addClip, DEFAULT_LOOK, emptyTimeline, newClip, type Look, type TimelineClip } from '@ace/project';
import { TrackDecoder } from '@ace/engine';
import { cameraRay, effectiveLens, equirectLayout, mulVec, ReframeRenderer, sampleMatrix, IDENTITY, type Vec3 } from '@ace/media360';
import { ace } from './api';
import { backgroundShift } from './background';
import { framesAt } from './calib';
import { exportTimeline } from './exporter';
import { presentLook, pushClipFrame } from './frameRender';
import { clipSound, getMedia, mediaNow } from './media';
import { previewSource, proxiesIdle, setPreviewLevel } from './proxy';
import type { EditorApi } from './selftest';
import { trackSubject } from './tracker';

const S = 1_000_000, RAD = Math.PI / 180;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const look = (o: Partial<Look>): Look => ({ ...DEFAULT_LOOK, ...o });
const pixels = async (c: OffscreenCanvas) => {
  const o = new OffscreenCanvas(c.width, c.height), x = o.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(await createImageBitmap(c), 0, 0);
  return x.getImageData(0, 0, c.width, c.height).data;
};
/** A smooth colour for every direction. */
const colour = (d: Vec3): [number, number, number] => [128 + 100 * d[0], 128 + 100 * d[1], 128 + 100 * d[2]];

export async function equirectCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };

  // --- The projection, against a picture whose every direction is known -----------------------------------
  {
    const W = 1440, H = 720, pic = new OffscreenCanvas(W, H), x = pic.getContext('2d')!, img = x.createImageData(W, H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const lon = ((i + 0.5) / W - 0.5) * 2 * Math.PI, lat = (0.5 - (j + 0.5) / H) * Math.PI;
      const c = colour([Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)]);
      img.data.set([...c, 255], (j * W + i) * 4);
    }
    x.putImageData(img, 0, 0);
    const frame = new VideoFrame(pic, { timestamp: 0 });
    const w = 320, h = 180, cv = new OffscreenCanvas(w, h), r = await ReframeRenderer.create(cv);
    r.setLayout(equirectLayout(W, H));
    let worst = 0;
    for (const v of [{ yaw: 0, pitch: 0, fov: 90 }, { yaw: 70, pitch: 20, fov: 60, roll: 15 }, { yaw: 180, pitch: 0, fov: 100 }, { yaw: -175, pitch: -40, fov: 40 }, { yaw: 30, pitch: 90, fov: 100 }, { yaw: 0, pitch: -90, fov: 200, fisheye: 0.33 }]) {
      const l = look(v);
      r.resetHistory();
      r.pushFrame({ frames: [frame], mode: '360', view: { yaw: l.yaw, pitch: l.pitch, roll: l.roll, fov: l.fov, fisheye: l.fisheye, autoLens: true } });
      presentLook(r, look({}));
      const px = await pixels(cv), m = sampleMatrix(l, IDENTITY), e = effectiveLens({ fov: l.fov, fisheye: l.fisheye, autoLens: true });
      let max = 0;
      for (let j = 2; j < h; j += 3) for (let i = 2; i < w; i += 3) {
        const ray = cameraRay(e.k, e.fov, w / h, ((i + 0.5) / w) * 2 - 1, 1 - ((j + 0.5) / h) * 2);
        if (!ray) continue;
        const c = colour(mulVec(m, ray));
        for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs(px[(j * w + i) * 4 + k]! - c[k]!));
      }
      worst = Math.max(worst, max);
    }
    frame.close();
    r.destroy();
    ok('every direction shows the right part of the picture (seam and poles too)', worst < 9, +worst.toFixed(1));
  }

  // --- The real file --------------------------------------------------------------------------------------
  const file = (await ace.listFixtures()).find((f) => f.endsWith('GS010004.mp4'))!;
  const m = await getMedia(file);
  out.file = { is360: m.is360, size: `${m.width}x${m.height}`, fps: +m.fps.toFixed(2), seconds: +(m.durationUs / S).toFixed(2), tracks: m.tracks.length, motion: m.stabilizer.hasOrientation, camera: m.camera.model, hardware: m.support[0]!.hardware };
  ok('recognised as 360', m.is360 && !!m.layout?.equirect && !m.lens);
  const times = m.tracks[0]!.samples.map((s) => s.timestamp).sort((a, b) => a - b);
  ok('the video starts at 0', times[0] === 0, times[0]);
  const sheet = new OffscreenCanvas(4 * 480, 3 * 270), sx = sheet.getContext('2d')!;
  const cv = new OffscreenCanvas(480, 270), r = await ReframeRenderer.create(cv);
  r.setLayout(m.layout);
  const base: TimelineClip = newClip(file, m.durationUs, true);
  let k = 0;
  for (const t of [20, 150, 300]) for (const v of [{ fov: 100 }, { yaw: 180, fov: 100 }, { yaw: 90, pitch: 10, fov: 70 }, { pitch: -90, fov: 260, fisheye: 0.33 }]) {
    const { frames, close } = await framesAt(m, t * S);
    r.resetHistory();
    pushClipFrame(r, { ...base, look: look(v) }, m, t * S, frames);
    presentLook(r, look({}));
    sx.drawImage(await createImageBitmap(cv), (k % 4) * 480, Math.floor(k / 4) * 270);
    close();
    k++;
  }
  await ace.writeFile(await ace.selftestOut('equirect.png'), new Uint8Array(await (await sheet.convertToBlob({ type: 'image/png' })).arrayBuffer()));
  // Frame accuracy with reordered frames, round keyframes and at the ends.
  const keys = m.tracks[0]!.samples.filter((s) => s.isSync).map((s) => s.timestamp);
  out.keyframes = { count: keys.length, everySeconds: +((keys.at(-1)! - keys[0]!) / (keys.length - 1) / S).toFixed(2) };
  const dec = new TrackDecoder(m.reader, m.tracks[0]!);
  let wrong = 0, n = 0;
  const slow: number[] = [];
  const around = [0, 1, 2, ...keys.slice(1, 4).flatMap((x) => { const i = times.indexOf(x); return [i - 2, i - 1, i, i + 1]; }), 1234, 1230, times.length - 2, times.length - 1];
  for (const i of around) {
    dec.seek(times[i]!);
    const t0 = performance.now();
    let f: VideoFrame | null = null;
    while (!f && performance.now() - t0 < 6000) { void dec.pump(); f = dec.frameAt(times[i]!); if (!f) await sleep(2); }
    slow.push(Math.round(performance.now() - t0));
    n++;
    if (f?.timestamp !== times[i]) wrong++;
  }
  dec.close();
  ok('every sought frame is the right one', wrong === 0, { wrong, of: n, ms: slow });

  // --- In the app ---------------------------------------------------------------------------------------------
  await api.importPaths([file]);
  await sleep(500);
  const bin = [...document.querySelectorAll<HTMLElement>('.bin-item')].find((e) => e.textContent?.includes('GS010004'))!;
  ok('the media bin marks it 360', !!bin.querySelector('.badge') && !bin.textContent?.includes('×2'), bin.textContent);
  bin.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await sleep(1000);
  const clip = () => api.getTimeline().clips[0]!;
  const frame = document.querySelector('.frame') as HTMLElement, r0 = frame.getBoundingClientRect();
  const at = (fx: number, fy: number) => ({ x: Math.round(r0.left + r0.width * fx), y: Math.round(r0.top + r0.height * fy) });
  const a = at(0.6, 0.5), b = at(0.3, 0.4);
  await ace.selftestInput({ type: 'mouseMove', ...a });
  await ace.selftestInput({ type: 'mouseDown', ...a, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) { await ace.selftestInput({ type: 'mouseMove', x: Math.round(a.x + ((b.x - a.x) * i) / 8), y: Math.round(a.y + ((b.y - a.y) * i) / 8), button: 'left', modifiers: ['leftButtonDown'] }); await sleep(20); }
  await ace.selftestInput({ type: 'mouseUp', ...b, button: 'left', clickCount: 1 });
  await sleep(200);
  ok('dragging looks around', Math.abs(clip().look.yaw) > 15 && Math.abs(clip().look.pitch) > 2, [clip().look.yaw, clip().look.pitch]);
  const f0 = clip().look.fov;
  for (let i = 0; i < 5; i++) { frame.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })); await sleep(20); }
  await sleep(200);
  ok('scrolling zooms, wider than any flat lens', clip().look.fov > f0 * 1.5, [f0, clip().look.fov]);
  document.querySelector<HTMLElement>('.dock-tab[data-panel="reframe"]')?.click();
  await sleep(300);
  const sections = [...document.querySelectorAll<HTMLElement>('[data-section]')].map((e) => e.dataset.section);
  ok('it has the 360 controls', ['View', 'Lens', 'Subject tracking', 'Keyframes'].every((x) => sections.includes(x)) && !sections.includes('Framing') && !sections.includes('Lens details'), sections);
  api.player.seek(20 * S);
  await sleep(1500);
  await ace.capture('equirect-ui');
  // Playing, and jumping about.
  const s0 = api.player.stalls, p0 = api.player.time, w0 = performance.now();
  api.player.play();
  await sleep(5000);
  api.player.pause();
  const speed = (api.player.time - p0) / 1000 / (performance.now() - w0);
  ok('plays in real time', speed > 0.95 && api.player.stalls - s0 < 6, [+speed.toFixed(3), api.player.stalls - s0]);
  const jumps: number[] = [];
  for (const t of [100, 333.3, 41.7, 250.1, 8.2, 455]) {
    const t0 = performance.now();
    api.player.seek(t * S);
    for (;;) { await sleep(15); const ts = api.lastResult()?.layers?.[0]?.frames[0]?.timestamp; if (ts !== undefined && Math.abs(ts - t * S) < 40_000) break; if (performance.now() - t0 > 5000) break; }
    jumps.push(Math.round(performance.now() - t0));
  }
  ok('jumping anywhere shows the frame', Math.max(...jumps) < 3000, jumps);
  // Sound in step: the sound and picture are equally long.
  const snd = clipSound(m), b0 = await snd?.fetch(3);
  ok('sound decodes and is as long as the picture', !!b0 && Math.abs(snd!.seconds - m.durationUs / S) < 0.1, [snd?.seconds, m.durationUs / S]);
  // Proxy: still 360.
  {
    const small = { ...m, path: m.path };
    void small;
    const short = mediaNow(file)!;
    const p0 = performance.now();
    setPreviewLevel(8, [short]);
    await proxiesIdle();
    const src = previewSource(short);
    ok('its proxy is 360 too', src.level === 8 && !!src.layout?.equirect && src.tracks[0]!.samples.length === times.length, [src.level, src.layout?.name, src.tracks[0]!.samples.length, `${((performance.now() - p0) / 1000).toFixed(0)} s to build`]);
    api.player.seek(150 * S);
    await sleep(1200);
    await ace.capture('equirect-proxy');
    setPreviewLevel(1, [short]);
  }
  // Tracking (no motion data: in the picture itself) and export.
  const t1 = times.find((t) => t >= 20 * S)!;
  const res = await trackSubject({ clip: { ...base, outUs: t1 + 3 * S }, media: m, startUs: t1, yaw: 180, pitch: -25, sizeDeg: 25 }, () => {}, new AbortController().signal);
  out.track = { points: res.points.length, lostAt: res.lostAt && res.lostAt / S };
  ok('a subject can be tracked', res.points.length > 10, res.points.length);
  const t0 = performance.now();
  await exportTimeline(addClip(emptyTimeline(), { ...base, inUs: 20 * S, outUs: 24 * S, look: look({ yaw: 40, fov: 90 }) }, 0), { path: await ace.selftestOut('equirect.mp4'), resolution: 1080, fps: 30, codec: 'avc', quality: 'high' }, () => {}, new AbortController().signal);
  out.exportSpeed = +(4000 / (performance.now() - t0)).toFixed(2);
  r.destroy();
  void RAD;
  return { fails, ...out };
}

/**
 * Is a stitched 360 file already steadied? Fits the turn of the whole sphere between frames from
 * the scenery (ahead, sides, up), and how the helmet behind moves in the same picture.
 */
export async function equirectMotion() {
  const out: Record<string, unknown> = {};
  const fx = await ace.listFixtures();
  const N = 128, FOV = 60, pxDeg = N / FOV;
  const run = async (name: string, from: number, seconds: number, stab: TimelineClip['stabilize']) => {
    const m = await getMedia(fx.find((f) => f.endsWith(name))!);
    const cv = new OffscreenCanvas(N, N), r = await ReframeRenderer.create(cv);
    r.setLayout(m.layout);
    const c: TimelineClip = { ...newClip(m.path, m.durationUs, true), stabilize: stab };
    const times = m.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b).filter((t) => t >= from * S && t < (from + seconds) * S);
    const decs = m.tracks.map((t) => new TrackDecoder(m.reader, t));
    decs.forEach((d) => { d.maxAhead = 6; d.seek(times[0]!); });
    // Straight ahead and to the sides, a little up; and the helmet, straight behind.
    const dirs = { ahead: [0, 12], left: [-90, 12], right: [90, 12], helmet: [180, 0] } as Record<string, [number, number]>;
    const prev: Record<string, Float64Array> = {}, mv: Record<string, { x: number[]; y: number[]; roll: number[] }> = {};
    for (const t of times) {
      let fr: (VideoFrame | null)[] = [];
      for (let k = 0; ; k++) { for (const d of decs) void d.pump(); fr = decs.map((d) => d.frameAt(t)); if (fr.every(Boolean)) break; if (k > 6000) throw new Error('decode'); await sleep(1); }
      for (const [n, [yaw, pitch]] of Object.entries(dirs)) {
        r.resetHistory();
        pushClipFrame(r, { ...c, look: look({ yaw, pitch, fov: FOV }) }, m, t, fr as VideoFrame[]);
        presentLook(r, look({}));
        const px = await pixels(cv), g = new Float64Array(N * N);
        for (let i = 0; i < g.length; i++) g[i] = 0.3 * px[i * 4]! + 0.59 * px[i * 4 + 1]! + 0.11 * px[i * 4 + 2]!;
        if (prev[n]) {
          const s = backgroundShift(g, prev[n]!, N, 0);
          ((mv[n] ??= { x: [], y: [], roll: [] }).x).push(s.dx / pxDeg); mv[n]!.y.push(s.dy / pxDeg); mv[n]!.roll.push((s.b * 180) / Math.PI);
        }
        prev[n] = g;
      }
    }
    decs.forEach((d) => d.close());
    r.destroy();
    const med = (v: number[]) => [...v].map(Math.abs).sort((a, b) => a - b)[v.length >> 1]!;
    const jerk = (v: number[]) => med(v.slice(1).map((x, i) => x - v[i]!));
    const res: Record<string, unknown> = { fps: +m.fps.toFixed(1) };
    for (const [n, v] of Object.entries(mv)) res[n] = { shakeDeg: +Math.hypot(jerk(v.x), jerk(v.y)).toFixed(3), shakeRollDeg: +jerk(v.roll).toFixed(3), moveDeg: +Math.hypot(med(v.x), med(v.y)).toFixed(3) };
    // The turn left over in the whole picture: yaw = common sideways, pitch = ahead up/down, roll = sides' up/down.
    const a = mv.ahead!, l = mv.left!, rr = mv.right!;
    res.sphere = { yawShake: +jerk(a.x.map((x, i) => (x + l.x[i]! + rr.x[i]!) / 3)).toFixed(3), pitchShake: +jerk(a.y).toFixed(3), rollShake: +jerk(l.y.map((y, i) => (y - rr.y[i]!) / 2)).toFixed(3) };
    return res;
  };
  const off = { smoothing: 'off' as const, horizon: false };
  for (const t of [20, 150, 300]) out[`GS010004.mp4 from ${t}s`] = await run('GS010004.mp4', t, 5, off);
  out['GS010120.360 as recorded'] = await run('GS010120.360', 3, 5, off);
  out['GS010120.360 medium'] = await run('GS010120.360', 3, 5, { smoothing: 'medium', horizon: false });
  out['GS010119.360 as recorded'] = await run('GS010119.360', 20, 5, off);
  out['GS010119.360 medium'] = await run('GS010119.360', 20, 5, { smoothing: 'medium', horizon: false });
  // A strip of frames, to look at.
  const m = await getMedia(fx.find((f) => f.endsWith('GS010004.mp4'))!);
  const cv = new OffscreenCanvas(240, 135), r = await ReframeRenderer.create(cv);
  r.setLayout(m.layout);
  const sh = new OffscreenCanvas(8 * 240, 6 * 135), x = sh.getContext('2d')!;
  for (let row = 0; row < 6; row++) for (let k = 0; k < 8; k++) {
    const t = ([20, 20, 150, 150, 300, 300][row]! + k * 0.4) * S;
    const { frames, close } = await framesAt(m, t);
    r.resetHistory();
    pushClipFrame(r, { ...newClip(m.path, m.durationUs, true), look: look(row % 2 ? { yaw: 180, fov: 110 } : { pitch: 15, fov: 110 }) }, m, t, frames);
    presentLook(r, look({}));
    x.drawImage(await createImageBitmap(cv), k * 240, row * 135);
    close();
  }
  r.destroy();
  await ace.writeFile(await ace.selftestOut('equirect-motion.png'), new Uint8Array(await (await sh.convertToBlob({ type: 'image/png' })).arrayBuffer()));
  return out;
}
