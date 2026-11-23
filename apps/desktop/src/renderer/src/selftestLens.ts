// Lens match, against a recording whose back lens was fogged on purpose (and the same one clear).

import { BufferTarget, CanvasSource, Mp4OutputFormat, Output } from 'mediabunny';
import { TrackDecoder } from '@ace/engine';
import { ReframeRenderer } from '@ace/media360';
import { addClip, DEFAULT_LOOK, emptyTimeline, newClip, type Look, type TimelineClip } from '@ace/project';
import { ace } from './api';
import { framesAt } from './calib';
import { exportTimeline } from './exporter';
import { presentLook, pushClipFrame } from './frameRender';
import { lensUi, matchClipLenses } from './lensMatching';
import { clipLookAt } from './frameRender';
import { fisheyeForLook } from '@ace/project';
import { getMedia, type Media } from './media';
import { previewSource, proxiesIdle, setPreviewLevel } from './proxy';
import { defaultPrefs, setPrefs } from './ui/prefs';
import type { EditorApi } from './selftest';

const S = 1_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const W = 4096, H = 1344;

/** Re-records a moment of a real 360 clip, with or without fog on the back lens. */
async function make(src: Media, fromS: number, count: number, fogged: boolean): Promise<string> {
  const { fixtures } = await ace.info();
  const path = `${fixtures}/synthetic/lens-${fogged ? 'fogged' : 'clear'}.360`;
  if ((await ace.listFixtures()).includes(path)) return path;
  const canvases = [0, 1].map(() => new OffscreenCanvas(W, H)), ctx = canvases.map((c) => c.getContext('2d')!);
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const sources = canvases.map((c) => new CanvasSource(c, { codec: 'hevc', bitrate: 60e6, keyFrameInterval: 0.5 }));
  for (const s of sources) output.addVideoTrack(s, { frameRate: 30 });
  await output.start();
  const times = src.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b).filter((t) => t >= fromS * S).slice(0, count);
  const decs = src.tracks.map((t) => new TrackDecoder(src.reader, t));
  decs.forEach((d) => { d.maxAhead = 6; d.seek(times[0]!); });
  for (const [n, t] of times.entries()) {
    let fr: (VideoFrame | null)[] = [];
    for (let k = 0; ; k++) { for (const d of decs) void d.pump(); fr = decs.map((d) => d.frameAt(t)); if (fr.every(Boolean)) break; if (k > 5000) throw new Error('decode'); await sleep(2); }
    for (const s of [0, 1]) {
      const c = ctx[s]!;
      c.filter = 'none';
      c.globalAlpha = 1;
      c.drawImage(fr[s]!, 0, 0);
      // The parts the back lens recorded.
      for (const [x, w] of s === 0 ? [[0, 688], [3408, 688]] as const : [[688, 2720]] as const) if (fogged) {
        c.save();
        c.beginPath();
        c.rect(x, 0, w, H);
        c.clip();
        c.filter = 'blur(2px) brightness(0.9) saturate(0.8)';
        c.drawImage(fr[s]!, 0, 0);
        c.filter = 'none';
        c.globalAlpha = 0.17;
        c.fillStyle = 'rgb(255, 246, 232)';
        c.fillRect(x, 0, w, H);
        c.restore();
      }
      await sources[s]!.add(n / 30, 1 / 30);
    }
  }
  decs.forEach((d) => d.close());
  await output.finalize();
  return ace.writeFile(path, new Uint8Array((output.target as BufferTarget).buffer!));
}

export async function lensCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  setPrefs(defaultPrefs());
  const all = await ace.listFixtures();
  const open = async (n: string) => getMedia(all.find((f) => f.endsWith(n))!);
  const src = await open('GS010004.360');
  const clear = await getMedia(await make(src, 130, 60, false)), fog = await getMedia(await make(src, 130, 60, true));
  const base = (m: Media, o: Partial<TimelineClip> = {}): TimelineClip => ({ ...newClip(m.path, m.durationUs, true), stabilize: { smoothing: 'off', horizon: false }, ...o, id: `l${Math.random()}` });
  const N = 480, cv = new OffscreenCanvas(N, N), r = await ReframeRenderer.create(cv);
  const read = new OffscreenCanvas(N, N).getContext('2d', { willReadFrequently: true })!;
  const view = async (m: Media, c: TimelineClip, yaw: number, pitch: number, fov = 90, t = 0.5 * S, frames?: VideoFrame[]) => {
    const got = frames ? null : await framesAt(m, t);
    r.setLayout(m.layout);
    r.resetHistory();
    pushClipFrame(r, { ...c, look: { ...DEFAULT_LOOK, yaw, pitch, fov } }, m, t, frames ?? got!.frames);
    presentLook(r, { ...DEFAULT_LOOK } as Look);
    read.drawImage(await createImageBitmap(cv), 0, 0);
    got?.close();
    return read.getImageData(0, 0, N, N).data.slice();
  };
  const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let s = 0, w = 0; for (let i = 0; i < a.length; i++) if (i % 4 < 3) { const d = Math.abs(a[i]! - b[i]!); s += d; w = Math.max(w, d); } return { mean: s / ((a.length / 4) * 3), worst: w }; };

  // --- Only the chosen lens changes ------------------------------------------------------------------------
  const plain = base(clear);
  {
    const f0 = await view(clear, plain, 0, 0), b0 = await view(clear, plain, 180, 0);
    const c = { ...plain, lenses: { back: { brightness: 0.8, haze: 0.4, clarity: 0.6, sharpness: 1 } } };
    const f1 = await view(clear, c, 0, 0), b1 = await view(clear, c, 180, 0);
    ok('the front lens is untouched when the back one is changed', diff(f0, f1).worst <= 1 && diff(b0, b1).mean > 6, [diff(f0, f1), diff(b0, b1)]);
    const d = { ...plain, lenses: { front: { warmth: 0.5 } } };
    ok('and the other way round', diff(await view(clear, d, 180, 0), b0).worst <= 1 && diff(await view(clear, d, 0, 0), f0).mean > 3);
    // Across the seam the change comes in gradually.
    const s0 = await view(clear, plain, 90, 25, 50), s1 = await view(clear, { ...plain, lenses: { back: { brightness: 1 } } }, 90, 25, 50);
    const col: number[] = [];
    for (let x = 0; x < N; x++) { let v = 0; for (let y = 40; y < N - 40; y++) v += Math.log((s1[(y * N + x) * 4 + 1]! + 2) / (s0[(y * N + x) * 4 + 1]! + 2)); col.push(v / (N - 80)); }
    let step = 0;
    for (let x = 3; x < N; x++) step = Math.max(step, Math.abs(col[x]! - col[x - 3]!));
    const span = Math.max(...col) - Math.min(...col);
    ok('the change blends in where the lenses meet', span > 0.1 && step < span * 0.4, { span: +span.toFixed(2), biggestStepIn3px: +step.toFixed(3), left: +col[10]!.toFixed(2), right: +col[N - 10]!.toFixed(2) });
    const z = await view(clear, { ...plain, lenses: { front: {}, back: {} } }, 90, 0);
    ok('no corrections: exactly as before', diff(z, await view(clear, plain, 90, 0)).worst === 0);
  }

  // --- A fogged back lens, matched automatically ------------------------------------------------------------------
  const views = [[180, 0], [150, 20], [210, -10], [90, 30], [-90, 30], [180, 60]] as const;
  {
    const m = (await matchClipLenses(fog, base(fog), 0.5 * S))!;
    ok('finds which lens is fogged', m?.lens === 'back', m);
    const fixed = base(fog, { lenses: { [m.lens]: m.adjust as Record<string, number> } });
    const before: number[] = [], after: number[] = [];
    for (const [y, p] of views) { const t = await view(clear, base(clear), y, p); before.push(diff(t, await view(fog, base(fog), y, p)).mean); after.push(diff(t, await view(fog, fixed, y, p)).mean); }
    const mb = before.reduce((a, b) => a + b) / before.length, ma = after.reduce((a, b) => a + b) / after.length;
    ok('and brings it back to how it looked clear', ma < mb * 0.45, { differenceBefore: +mb.toFixed(1), after: +ma.toFixed(1), each: before.map((b, i) => `${b.toFixed(1)}→${after[i]!.toFixed(1)}`) });
    const other = (await matchClipLenses(fog, base(fog), 0.5 * S, 'front'))!;
    ok('or can be told to change the other one', other.lens === 'front' && other.after < other.before * 0.6, other);
    const none = (await matchClipLenses(clear, base(clear), 0.5 * S))!;
    out['clear recording'] = none;
    ok('a clear recording is hardly changed', Math.abs(none.adjust.brightness ?? 0) < 0.35 && Math.abs(none.adjust.haze ?? 0) < 0.2, none.adjust);
    const raw = async (n: string, c: TimelineClip) => { const a = await view(fog, c, 90, 20, 70); const o = new OffscreenCanvas(N, N); o.getContext('2d')!.putImageData(new ImageData(a, N, N), 0, 0); await ace.writeFile(await ace.selftestOut(n), new Uint8Array(await (await o.convertToBlob({ type: 'image/png' })).arrayBuffer())); };
    await raw('lens-fogged.png', base(fog));
    await raw('lens-matched.png', fixed);

    // Preview copy and export look the same.
    const a = await view(fog, fixed, 120, 10, 90, 0);
    setPreviewLevel(2, [fog]);
    await proxiesIdle();
    const ps = previewSource(fog), fr: VideoFrame[] = [];
    for (const t of ps.tracks) { const k = t.samples[0]!, data = await ps.reader.read(k.offset, k.size); fr.push(await new Promise<VideoFrame>((res, rej) => { const d = new VideoDecoder({ output: res, error: rej }); d.configure({ codec: t.codec, codedWidth: t.width, codedHeight: t.height, description: t.description }); d.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data })); void d.flush(); })); }
    r.setLayout(ps.layout);
    r.resetHistory();
    pushClipFrame(r, { ...fixed, look: { ...DEFAULT_LOOK, yaw: 120, pitch: 10, fov: 90 } }, fog, 0, fr);
    presentLook(r, { ...DEFAULT_LOOK } as Look);
    read.drawImage(await createImageBitmap(cv), 0, 0);
    const b = read.getImageData(0, 0, N, N).data.slice();
    fr.forEach((f) => f.close());
    ok('preview copies get the same corrections', ps.level === 2 && diff(a, b).mean < 5, +diff(a, b).mean.toFixed(2));
    setPreviewLevel(1, [fog]);
    const path = await ace.selftestOut('lens.mp4');
    const c = { ...fixed, look: { ...DEFAULT_LOOK, yaw: 120, pitch: 10, fov: 90 } };
    await exportTimeline({ ...addClip(emptyTimeline(), c), framing: '1:1' }, { path, resolution: 720, fps: 30, codec: 'avc', quality: 'max' }, () => {}, new AbortController().signal);
    const ex = await getMedia(path), ef = await framesAt(ex, 0);
    r.setLayout(null);
    r.resetHistory();
    r.pushFrame({ frames: [ef.frames[0]!], mode: 'flat', view: { yaw: 0, pitch: 0, roll: 0, fov: 90, fisheye: 0 }, fill: true });
    presentLook(r, { ...DEFAULT_LOOK } as Look);
    read.drawImage(await createImageBitmap(cv), 0, 0);
    ef.close();
    ok('and so do exports', diff(a, read.getImageData(0, 0, N, N).data).mean < 4, +diff(a, read.getImageData(0, 0, N, N).data).mean.toFixed(2));
  }
  // --- Your own recordings ------------------------------------------------------------------------------------------
  for (const n of ['GS010004.360', 'GS010119.360', 'GS010113.360', 'GS010118.360', 'GS010083.360']) {
    const m = await open(n), q = await matchClipLenses(m, base(m), m.durationUs * 0.4);
    ok(`${n}: matching never makes it worse`, !q || q.after <= q.before + 0.3, q && { lens: q.lens, before: +q.before.toFixed(1), after: +q.after.toFixed(1), adjust: q.adjust, samples: q.samples });
  }

  // --- In the app --------------------------------------------------------------------------------------------------------
  const flat = await open('GX010133.MP4'), stitched = await open('GS010004.mp4');
  await api.importPaths([fog.path, flat.path, stitched.path]);
  api.setTimeline(addClip(addClip(emptyTimeline(), base(fog, { look: { ...DEFAULT_LOOK, yaw: 120, fov: 100 } })), newClip(flat.path, 3 * S, false)));
  api.player.seek(0.5 * S);
  await sleep(900);
  const tab = document.querySelector('.dock-tab[data-panel="color"]')!.getBoundingClientRect();
  for (const type of ['mouseDown', 'mouseUp']) await ace.selftestInput({ type, x: Math.round(tab.left + tab.width / 2), y: Math.round(tab.top + tab.height / 2), button: 'left', clickCount: 1 });
  await sleep(400);
  const body = () => document.querySelector<HTMLElement>('[data-section="Lens match"]');
  if (!body()?.querySelector('.slider')) { body()!.querySelector<HTMLButtonElement>('.section-toggle')!.click(); await sleep(300); }
  body()!.scrollIntoView({ block: 'start' });
  const btn = (t: RegExp) => [...body()!.querySelectorAll('button')].find((b) => t.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
  ok('Lens match is in the Color tab', !!btn(/Match automatically/) && body()!.querySelectorAll('.slider').length === 8, body()!.querySelectorAll('.slider').length);
  const pic = async () => { await sleep(400); await api.nextRender(); const f = document.querySelector('.frame canvas.layer') as HTMLCanvasElement; const o = new OffscreenCanvas(64, 36), x = o.getContext('2d')!; x.drawImage(await createImageBitmap(f), 0, 0, 64, 36); return x.getImageData(0, 0, 64, 36).data.slice(); };
  const p0 = await pic();
  await ace.capture('lens-before');
  btn(/Match automatically/)!.click();
  for (let i = 0; i < 100 && !api.getTimeline().clips[0]!.lenses; i++) await sleep(100);
  const p1 = await pic();
  ok('the button corrects it', !!api.getTimeline().clips[0]!.lenses?.back && diff(p0, p1).mean > 4, [api.getTimeline().clips[0]!.lenses, +diff(p0, p1).mean.toFixed(1)]);
  ok('and says by how much', /Corrected the back lens/.test(document.body.textContent!) && lensUi().lens === 'back');
  await ace.capture('lens-after');
  await ace.selftestInput({ type: 'keyDown', keyCode: 'B' });
  const pb = await pic();
  await ace.selftestInput({ type: 'keyUp', keyCode: 'B' });
  ok('before / after leaves it out', diff(p0, pb).mean < 1.5 && diff(await pic(), p1).mean < 1.5, [+diff(p0, pb).mean.toFixed(2)]);
  (body()!.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
  const ph = await pic();
  let blue = 0, n = 0;
  for (let i = 0; i < ph.length; i += 4) if (Math.abs(ph[i]! - p1[i]!) > 6) { n++; if (ph[i + 2]! - ph[i]! > p1[i + 2]! - p1[i]!) blue++; }
  ok('the lens can be shown in blue', n > 300 && blue > n * 0.9, [n, blue]);
  await ace.capture('lens-highlight');
  (body()!.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
  ok('and turned off', diff(await pic(), p1).mean < 1.5);
  btn(/^Front/)!.click();
  await sleep(200);
  const range = body()!.querySelector<HTMLInputElement>('input[aria-label="Brightness"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range, '0.5');
  range.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(250);
  ok('sliders change the chosen lens', api.getTimeline().clips[0]!.lenses?.front?.brightness === 0.5 && !!api.getTimeline().clips[0]!.lenses?.back);
  await ace.selftestInput({ type: 'keyDown', keyCode: 'Z', modifiers: ['meta'] });
  await ace.selftestInput({ type: 'keyUp', keyCode: 'Z', modifiers: ['meta'] });
  await sleep(250);
  ok('undo', !api.getTimeline().clips[0]!.lenses?.front);
  btn(/^Reset$/)!.click();
  await sleep(250);
  ok('reset', !api.getTimeline().clips[0]!.lenses && diff(await pic(), p0).mean < 1.5);
  api.player.seek(3 * S);
  await sleep(600);
  ok('locked on a regular clip, with the reason', btn(/Match automatically/)!.disabled && !!body()!.querySelector('[aria-label*="two lenses"]'));
  api.setTimeline(addClip(emptyTimeline(), { ...newClip(stitched.path, 5 * S, true) }));
  api.player.seek(S);
  await sleep(700);
  ok('locked on a stitched video, with the reason', btn(/Match automatically/)!.disabled && !!body()!.querySelector('[aria-label*="stitched"]'));
  // --- What it costs --------------------------------------------------------------------------------------------------------
  const big = await open('GS010083.360');
  for (const [n2, l] of [['off', undefined], ['everything on', { front: { brightness: 0.3, haze: 0.2, contrast: 0.1, clarity: 0.5, sharpness: 1 }, back: { brightness: -0.3, haze: 0.4, saturation: 0.2, warmth: 0.1, clarity: 0.5, sharpness: 1 } }]] as const) {
    api.setTimeline(addClip(emptyTimeline(), { ...newClip(big.path, big.durationUs, true), lenses: l as TimelineClip['lenses'] }));
    api.player.seek(0);
    await sleep(1200);
    const s0 = api.player.stalls, t0 = api.player.time, w0 = performance.now();
    api.player.play();
    await sleep(4000);
    api.player.pause();
    const speed = (api.player.time - t0) / 1000 / (performance.now() - w0);
    ok(`4K60 360 plays in real time: ${n2}`, speed > 0.95, { speed: +speed.toFixed(3), stalls: api.player.stalls - s0 });
  }
  ok('no errors', !errors.length, errors);
  setPrefs(defaultPrefs());
  r.destroy();
  return { fails, ...out };
}

/** The lens look kept while zooming, in the app. */
export async function lensLookCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };
  setPrefs(defaultPrefs());
  const all = await ace.listFixtures();
  const path = all.find((f) => f.endsWith('GS010120.360'))!;
  await getMedia(path);
  api.setTimeline(emptyTimeline());
  await api.importPaths([path]);
  await sleep(500);
  [...document.querySelectorAll<HTMLElement>('.bin-item')].find((e) => e.textContent?.includes('GS010120'))!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await sleep(800);
  const clip = () => api.getTimeline().clips[0]!;
  ok('a new 360 clip keeps its look while zooming', !!clip().lensLook, clip().lensLook);
  api.player.seek(2 * S);
  await sleep(500);
  const frame = document.querySelector('.frame') as HTMLElement;
  const seen: [number, number][] = [];
  for (let k = 0; k < 40 && clip().look.fov < 240; k++) {
    frame.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 }));
    await sleep(25);
    const l = clipLookAt(clip(), 2 * S);
    seen.push([+l.fov.toFixed(1), +l.fisheye.toFixed(3)]);
  }
  const at200 = fisheyeForLook(clip().lensLook!, 200);
  let jump = 0;
  for (let i = 1; i < seen.length; i++) jump = Math.max(jump, Math.abs(seen[i]![1] - seen[i - 1]![1]));
  ok('zooming out adds fisheye smoothly, by itself', seen.at(-1)![0] > 200 && seen.at(-1)![1] > 0.3 && jump < 0.05 && Math.abs(at200 - 1 / 3) < 0.02, { from: seen[0], to: seen.at(-1), biggestStep: jump });
  ok('the fisheye stored on the clip is left alone', clip().look.fisheye === 0 && clip().keyframes.length === 0, clip().look);
  await ace.capture('lenslook-wide');
  // The Reframe tab: setting the fisheye sets the look at this width.
  const tab = document.querySelector('.dock-tab[data-panel="reframe"]')!.getBoundingClientRect();
  for (const type of ['mouseDown', 'mouseUp']) await ace.selftestInput({ type, x: Math.round(tab.left + tab.width / 2), y: Math.round(tab.top + tab.height / 2), button: 'left', clickCount: 1 });
  await sleep(400);
  const lensSec = document.querySelector<HTMLElement>('[data-section="Lens"]')!;
  if (!lensSec.querySelector('.slider')) { lensSec.querySelector<HTMLButtonElement>('.section-toggle')!.click(); await sleep(300); }
  const fish = lensSec.querySelector<HTMLInputElement>('input[aria-label="Fisheye"]')!;
  const fov = clip().look.fov;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(fish, '0.6');
  fish.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(300);
  ok('the fisheye slider sets the look', Math.abs(clip().lensLook!.fisheye - 0.6) < 1e-6 && Math.abs(clip().lensLook!.fov - fov) < 0.01 && Math.abs(clipLookAt(clip(), 2 * S).fisheye - 0.6) < 1e-3, clip().lensLook);
  ok('and says what it gives at other widths', /60°: .*300°: /.test(lensSec.textContent ?? ''), lensSec.querySelector('.hint')?.textContent);
  await ace.capture('lenslook-panel');
  const box = [...lensSec.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((b) => /Keep this look/.test(b.parentElement?.textContent ?? ''))!;
  box.click();
  await sleep(300);
  ok('turning it off keeps the picture as it is', !clip().lensLook && Math.abs(clip().look.fisheye - 0.6) < 1e-6, clip().look.fisheye);
  frame.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -200 }));
  await sleep(200);
  ok('then zooming keeps the same lens', Math.abs(clipLookAt(clip(), 2 * S).fisheye - 0.6) < 1e-6 && clip().look.fov < fov);
  await ace.selftestInput({ type: 'keyDown', keyCode: 'Z', modifiers: ['meta'] });
  await ace.selftestInput({ type: 'keyUp', keyCode: 'Z', modifiers: ['meta'] });
  await ace.selftestInput({ type: 'keyDown', keyCode: 'Z', modifiers: ['meta'] });
  await ace.selftestInput({ type: 'keyUp', keyCode: 'Z', modifiers: ['meta'] });
  await sleep(300);
  ok('undo brings it back', !!clip().lensLook);
  setPrefs(defaultPrefs());
  return { fails, ...out };
}
