// Milestone 5, AI tools: smart reframe (and, as they land, auto subtitles, smooth slow motion and
// sharper pictures). Runs hidden; generates its own footage where the right answer is known.

import { AudioBufferSource, BufferTarget, CanvasSource, canEncodeAudio, canEncodeVideo, Mp4OutputFormat, Output, QUALITY_HIGH } from 'mediabunny';
import { addClip, emptyTimeline, fromSrt, lookAt, newClip, toSrt, withCaptions, type Timeline } from '@ace/project';
import { ace as aceApi } from './api';
import { makeSubtitles } from './subtitles';
import { ace } from './api';
import { framesAt } from './calib';
import { grabFrame } from './exporter';
import { getMedia } from './media';
import type { EditorApi } from './selftest';
import { lastShifts, plannedAt, smartReframe } from './smartReframe';
import { aiSource, between, copyFor, enhanceEp, lastBuild, rifeVariant } from './aiCopy';
import { exportTimeline } from './exporter';
import { openMedia, TrackDecoder } from '@ace/engine';
import { ipcReader } from './api';
import { openSection } from './ui';
import type { LayerFrame } from './timelinePlayer';

const S = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(api: EditorApi, renders = 6) {
  const deadline = performance.now() + 8000;
  for (let i = 0; i < renders; i++) await Promise.race([api.nextRender(), sleep(Math.max(0, deadline - performance.now()))]);
  await sleep(250);
}

interface Pic { w: number; h: number; d: Uint8ClampedArray }
async function readPicture(path: string, crop?: { x: number; y: number; w: number; h: number }, size?: { w: number; h: number }): Promise<Pic> {
  const bmp = await createImageBitmap(new Blob([(await ace.readAll(path)) as Uint8Array<ArrayBuffer>]));
  const c = crop ?? { x: 0, y: 0, w: bmp.width, h: bmp.height };
  const w = size?.w ?? Math.round(c.w), h = size?.h ?? Math.round(c.h);
  const cv = new OffscreenCanvas(w, h), x = cv.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(bmp, c.x, c.y, c.w, c.h, 0, 0, w, h);
  return { w, h, d: x.getImageData(0, 0, w, h).data };
}
/** Where the red subject is in a picture, across (0–1), or null when it isn't there. */
function redAt(p: Pic): number | null {
  let sx = 0, n = 0;
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    const i = (y * p.w + x) * 4;
    if (p.d[i]! > 180 && p.d[i + 1]! < 90 && p.d[i + 2]! < 90) { sx += x; n++; }
  }
  return n > 3 ? sx / n / p.w : null;
}

/** Where the subject is in the test clip at time t (seconds), across the picture (0–1). */
const subjectX = (t: number) => (t < 1 ? 0.2 : t > 5 ? 0.8 : 0.2 + 0.6 * ((t - 1) / 4));

/**
 * A 6 s 16:9 clip: a textured background the camera pans slowly across, and a red ball that
 * moves from the left to the right between 1 s and 5 s.
 */
async function subjectClip(): Promise<string> {
  const { fixtures } = await ace.info();
  const path = `${fixtures}/synthetic/ai-subject.mp4`;
  if ((await ace.listFixtures()).some((f) => f.endsWith('synthetic/ai-subject.mp4'))) return path;
  const W = 1280, H = 720, fps = 30;
  const cv = new OffscreenCanvas(W, H), ctx = cv.getContext('2d')!;
  // Background: soft blobs, wider than the picture so the camera can pan.
  const bg = new OffscreenCanvas(W + 400, H), b = bg.getContext('2d')!;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  b.fillStyle = '#6a7a5a';
  b.fillRect(0, 0, bg.width, H);
  for (let i = 0; i < 900; i++) {
    const g = 60 + rnd() * 120;
    b.fillStyle = `rgb(${g * 0.8 | 0},${g | 0},${g * 0.7 | 0})`;
    b.beginPath(); b.arc(rnd() * bg.width, rnd() * H, 4 + rnd() * 22, 0, Math.PI * 2); b.fill();
  }
  const codec = (await canEncodeVideo('avc', { width: W, height: H })) ? 'avc' : 'vp9';
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const src = new CanvasSource(cv, { codec, bitrate: QUALITY_HIGH, keyFrameInterval: 1 });
  output.addVideoTrack(src, { frameRate: fps });
  await output.start();
  for (let f = 0; f < fps * 6; f++) {
    const t = f / fps;
    ctx.drawImage(bg, -60 * t, 0);
    ctx.fillStyle = '#e8251c';
    ctx.beginPath(); ctx.arc(subjectX(t) * W, H * 0.55, 46, 0, Math.PI * 2); ctx.fill();
    await src.add(t, 1 / fps);
  }
  await output.finalize();
  return ace.writeFile(path, new Uint8Array((output.target as BufferTarget).buffer!));
}


/** A 16 s clip whose sound is speech/known sentences (fixtures/synthetic/speech.wav, made by scripts/make-speech-fixture.sh). */
async function speechClip(): Promise<string | null> {
  const all = await ace.listFixtures();
  const { fixtures } = await ace.info();
  const path = `${fixtures}/synthetic/ai-speech.mp4`;
  if (all.some((f) => f.endsWith('synthetic/ai-speech.mp4'))) return path;
  const wav = `${fixtures}/synthetic/speech.wav`;
  if (!(await ace.stat(wav).then(() => true, () => false))) return null;
  const ctx = new OfflineAudioContext(2, 48000, 48000);
  const sound = await ctx.decodeAudioData(((await ace.readAll(wav)) as Uint8Array).slice().buffer);
  // Up to 48 kHz stereo, as a camera would record.
  const up = new OfflineAudioContext(2, Math.ceil(sound.duration * 48000), 48000);
  const src = up.createBufferSource();
  src.buffer = sound;
  src.connect(up.destination);
  src.start();
  const buf = await up.startRendering();
  const W = 640, H = 360, fps = 30;
  const cv = new OffscreenCanvas(W, H), c = cv.getContext('2d')!;
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const video = new CanvasSource(cv, { codec: (await canEncodeVideo('avc', { width: W, height: H })) ? 'avc' : 'vp9', bitrate: QUALITY_HIGH, keyFrameInterval: 1 });
  const audio = new AudioBufferSource({ codec: (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000 })) ? 'aac' : 'opus', bitrate: QUALITY_HIGH });
  output.addVideoTrack(video, { frameRate: fps });
  output.addAudioTrack(audio);
  await output.start();
  await audio.add(buf);
  for (let f = 0; f < Math.ceil(buf.duration * fps); f++) {
    c.fillStyle = '#20303a'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#fff'; c.font = '40px sans-serif'; c.fillText(`${(f / fps).toFixed(1)} s`, 40, 80);
    await video.add(f / fps, 1 / fps);
  }
  await output.finalize();
  return ace.writeFile(path, new Uint8Array((output.target as BufferTarget).buffer!));
}


/** Every frame of a video file (first track), as small pictures, in order. */
async function framesOf(path: string, w: number, h: number, from = 0, to = Infinity): Promise<{ t: number; pic: Pic }[]> {
  const { size } = await ace.stat(path);
  const reader = ipcReader(path, size);
  const info = await openMedia(reader);
  const track = info.videoTracks[0]!;
  const times = track.samples.map((s) => s.timestamp).sort((a, b) => a - b).filter((t) => t >= from && t < to);
  const dec = new TrackDecoder(reader, track);
  dec.maxAhead = 6;
  dec.seek(times[0]!);
  const cv = new OffscreenCanvas(w, h), x = cv.getContext('2d', { willReadFrequently: true })!;
  const out: { t: number; pic: Pic }[] = [];
  for (const t of times) {
    let f: VideoFrame | null = null;
    for (let i = 0; i < 3000 && !f; i++) { void dec.pump(); f = dec.frameAt(t); if (!f) await sleep(2); }
    if (!f) break;
    x.drawImage(f, 0, 0, w, h);
    out.push({ t, pic: { w, h, d: x.getImageData(0, 0, w, h).data } });
  }
  dec.close();
  return out;
}

export async function aiCheck(api: EditorApi) {
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  const ok = (n: string, pass: boolean, info: unknown = undefined) => { out[n] = pass ? `ok${info === undefined ? '' : ` ${JSON.stringify(info)}`}` : { FAILED: info ?? true }; if (!pass) fails.push(n); };

  // --- Smart reframe: a regular clip into 9:16 -------------------------------------------------
  const path = await subjectClip();
  const m = await getMedia(path);
  const clip0 = { ...newClip(path, m.durationUs, false), fit: 'fit' as const };
  const t0 = performance.now();
  const r = await smartReframe(clip0, m, 9 / 16, () => {}, new AbortController().signal);
  const took = (performance.now() - t0) / 1000;
  out['measured (every 0.5 s: across, sure)'] = (r.raw ?? []).filter((_, i) => i % 5 === 0).map((p) => `${p.v.toFixed(2)},${(p.w ?? 1).toFixed(2)}`).join(' ');
  out['camera shift measured'] = lastShifts.filter((_, i) => i % 5 === 0).join(' ');
  ok('smart reframe follows what moves', r.how === 'motion', r.how);
  ok('and takes less time than the clip lasts', took < 6, +took.toFixed(1));
  // The frame shows 9/16 ÷ 16/9 of the picture's width; the subject must stay inside it.
  const seen = (9 / 16) / (16 / 9), room = 1 - seen;
  const misses: string[] = [];
  for (let t = 0.3; t <= 5.8; t += 0.1) {
    const centre = plannedAt(r, t * S), want = subjectX(t) * 2 - 1;
    if (Math.abs(centre - want) > seen * 0.85) misses.push(`${t.toFixed(1)}s: ${centre.toFixed(2)} vs ${want.toFixed(2)}`);
  }
  ok('the subject stays in the 9:16 frame all the way', !misses.length, misses.slice(0, 6));
  ok('the move is a handful of keyframes', r.keys >= 2 && r.keys <= 16, r.keys);
  ok('nothing outside the picture is shown', (r.planned ?? []).every((p) => Math.abs(p.v) <= room + 1e-6));
  ok('the clip fills the frame', r.patch.fit === 'fill');

  // Through the app: frame shape 9:16, the Inspector button.
  api.setTimeline({ ...addClip(emptyTimeline(), clip0), framing: '9:16' });
  api.player.seek(3 * S);
  await settle(api);
  document.querySelector<HTMLElement>('.dock-tab[data-panel="reframe"]')?.click();
  openSection('Smart reframe');
  await sleep(300);
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent === 'Smart reframe this clip');
  ok('the Reframe panel offers smart reframe', !!button);
  button?.click();
  for (let i = 0; i < 300 && !api.getTimeline().clips[0]!.keyframes.length; i++) await sleep(100);
  const tl: Timeline = api.getTimeline();
  const c = tl.clips[0]!;
  ok('it writes pan keyframes on the clip', c.keyframes.length >= 2 && c.fit === 'fill' && c.keyframes.every((k) => k.look.pan && Math.abs(k.look.pan.x) <= 1), c.keyframes.map((k) => k.look.pan?.x.toFixed(2)));
  ok('the note says what it followed', document.body.textContent?.includes('the frame follows what moves') ?? false);

  // Preview and export both show the ball, in the same place.
  for (const T of [0.5, 3, 5.5]) {
    api.player.seek(T * S);
    await settle(api, 8);
    const frame = document.querySelector<HTMLElement>('.frame')!.getBoundingClientRect();
    const shot = await ace.capture(`ai-reframe-preview-${T}`);
    const sx = (await createImageBitmap(new Blob([(await ace.readAll(shot)) as Uint8Array<ArrayBuffer>]))).width / window.innerWidth;
    const prev = redAt(await readPicture(shot, { x: frame.left * sx, y: frame.top * sx, w: frame.width * sx, h: frame.height * sx }));
    const f = await framesAt(m, T * S);
    const layers: LayerFrame[] = [{ clip: c, index: 0, track: 0, media: m, layout: m.layout, level: 1, mediaUs: T * S, frames: f.frames }];
    const png = await ace.selftestOut(`ai-reframe-export-${T}.png`);
    await grabFrame(tl, T * S, layers, png, 720);
    f.close();
    const exp = redAt(await readPicture(png));
    // Where it should be: the pan puts the frame's middle at pan × room on the picture.
    const pan = lookAt(c.keyframes, c.look, T * S).pan?.x ?? 0;
    const want = ((subjectX(T) * 2 - 1 - pan * room) / seen + 1) / 2;
    ok(`at ${T}s the ball is in the frame, where the pan puts it (preview and export)`, exp !== null && prev !== null && Math.abs(exp - want) < 0.05 && Math.abs(prev - exp) < 0.03, { preview: prev?.toFixed(3), export: exp?.toFixed(3), want: want.toFixed(3) });
  }

  // A clip that already has the frame's shape has nothing to pan across.
  const same = await smartReframe(clip0, m, 16 / 9, () => {}, new AbortController().signal);
  ok('a clip already the frame’s shape is left whole', same.how === 'whole' && !same.patch.keyframes, same.how);



  // --- In-between frames on two pictures: a textured background panning 1 px, a disc moving 3.2 px ---
  {
    const W = 640, H = 384, R = 23;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const blobs = Array.from({ length: 300 }, () => [rnd() * (W + 200), rnd() * H, 2 + rnd() * 11, 0.25 + rnd() * 0.45] as const);
    const pic = (pan: number, cx: number) => {
      const d = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let g = 0.4;
        for (const [bx, by, br, v] of blobs) if ((x + pan - bx) ** 2 + (y - by) ** 2 < br * br) g = v;
        let c = [g * 0.8, g, g * 0.7];
        if ((x - cx) ** 2 + (y - 200) ** 2 < R * R) c = [0.91, 0.15, 0.1];
        const i = (y * W + x) * 4;
        d[i] = c[0]! * 255; d[i + 1] = c[1]! * 255; d[i + 2] = c[2]! * 255; d[i + 3] = 255;
      }
      return d;
    };
    try {
      await rifeVariant({});
      const t = performance.now();
      const mids = await between(pic(0, 300), pic(1, 303.2), W, H, [0.25, 0.5, 0.75]);
      const xs = mids.map((d) => redAt({ w: W, h: H, d }));
      out['test pictures: disc at ¼ ½ ¾ (want 300.8 301.6 302.4)'] = `${xs.map((x) => (x === null ? 'none' : (x * W).toFixed(2))).join(' ')} in ${(performance.now() - t).toFixed(0)} ms`;
      ok('in-between frames move a disc evenly', xs.every((x, i) => x !== null && Math.abs(x * W - (300.8 + 0.8 * i)) < 0.3), xs.map((x) => x && +(x * W).toFixed(2)));
    } catch (e) { ok('in-between frames on test pictures', false, String(e)); }
  }

  // --- Smooth slow motion -------------------------------------------------------------------------
  {
    // The ball moves steadily from 1 s to 5 s: in-between frames must put it where it really was.
    const slow = { ...clip0, inUs: 2 * S, outUs: 2.5 * S, speed: 0.25, enhance: { smooth: true } };
    const t2 = performance.now();
    let src: Awaited<ReturnType<typeof copyFor>> | null = null;
    try { src = await copyFor(slow); } catch (e) { ok('smooth slow motion is made', false, String(e)); }
    if (src) {
      const took = (performance.now() - t2) / 1000;
      out['smooth slow motion took (s, incl. any download)'] = +took.toFixed(1);
      out['models run on'] = enhanceEp;
      ok('it makes 4 pictures for each recorded one at ¼ speed', lastBuild.made >= lastBuild.frames * 4 - 8, [lastBuild.frames, lastBuild.made]);
      // Read the copy back: each picture's ball where it was at that moment.
      const frames: { t: number; x: number | null }[] = [];
      {
        const dec = new TrackDecoder(src.reader, src.tracks[0]!);
        const times = src.tracks[0]!.samples.map((x) => x.timestamp).sort((a, b) => a - b);
        dec.maxAhead = 6; dec.seek(times[0]!);
        const cv = new OffscreenCanvas(320, 180), x = cv.getContext('2d', { willReadFrequently: true })!;
        for (const t of times) {
          let f: VideoFrame | null = null;
          for (let i = 0; i < 3000 && !f; i++) { void dec.pump(); f = dec.frameAt(t); if (!f) await sleep(2); }
          if (!f) break;
          x.drawImage(f, 0, 0, 320, 180);
          frames.push({ t, x: redAt({ w: 320, h: 180, d: x.getImageData(0, 0, 320, 180).data }) });
        }
        dec.close();
      }
      // (Measuring a blurry, compressed ball reads it a little to one side; the recorded frames show how much.)
      const off = (f: { t: number; x: number | null }) => (f.x! - subjectX(f.t / S)) * 1280;
      const recorded = frames.filter((f, i) => f.x !== null && i % 4 === 0).map(off).sort((a, b) => a - b);
      const bias = recorded[recorded.length >> 1] ?? 0;
      out['measuring bias (px)'] = +bias.toFixed(2);
      const errs = frames.filter((f) => f.x !== null).map((f) => Math.abs(off(f) - bias));
      out['ball across in the copy (time ms: got−true px)'] = frames.slice(0, 24).map((f) => `${((f.t - 2 * S) / 1000).toFixed(1)}:${f.x === null ? 'none' : ((f.x - subjectX(f.t / S)) * 1280).toFixed(1)}`).join(' ');
      const worst = Math.max(...errs), mean = errs.reduce((a, b) => a + b, 0) / errs.length;
      ok('the copy has the recording’s own times, 4 times as many', frames.length >= 60 && Math.abs(frames[0]!.t - 2 * S) < 40_000, [frames.length, frames[0]?.t]);
      ok('in-between frames put the ball where it really was (within 1 px of 1280)', mean < 0.5 && worst < 1, { mean: +mean.toFixed(2), worst: +worst.toFixed(2), holdWouldBe: 4.8 });

      // The preview plays the copy.
      api.setTimeline(addClip(emptyTimeline(), slow));
      for (let i = 0; i < 50 && !aiSource(slow); i++) await sleep(100);
      ok('the preview uses the copy', !!aiSource(slow));
      const mid = 2 * S + (3 * S) / 30 + (S / 30) * 0.5; // half way between two recorded frames
      api.player.seek((mid - 2 * S) * 4);
      await settle(api, 8);
      const frameBox = document.querySelector<HTMLElement>('.frame')!.getBoundingClientRect();
      const shot = await ace.capture('ai-smooth-preview');
      const sx = (await createImageBitmap(new Blob([(await ace.readAll(shot)) as Uint8Array<ArrayBuffer>]))).width / window.innerWidth;
      const px = redAt(await readPicture(shot, { x: frameBox.left * sx, y: frameBox.top * sx, w: frameBox.width * sx, h: frameBox.height * sx }));
      document.querySelector<HTMLElement>('.dock-tab[data-panel="clip"]')?.click();
      openSection('Smooth & sharp');
      await sleep(400);
      const sect = document.querySelector('[data-section="Smooth & sharp"]')?.textContent ?? '';
      ok('the Clip panel shows Smooth & sharp, ready', sect.includes('Smooth slow motion') && sect.includes('Ready'), sect.slice(0, 160));
      await ace.capture('ai-smooth-section');
      ok('the preview shows the in-between frame half way between recorded ones', px !== null && Math.abs(px - subjectX(mid / S)) * 1280 < 3, px !== null && { got: +(px * 1280).toFixed(1), want: +(subjectX(mid / S) * 1280).toFixed(1) });

      // The export uses it: every output frame moves the ball on (no repeated frames).
      const outPath = await ace.selftestOut('ai-smooth-export.mp4');
      await exportTimeline(addClip(emptyTimeline(), slow), { path: outPath, resolution: 720, fps: 30, codec: 'avc', quality: 'high' }, () => {}, new AbortController().signal);
      const outFrames = await framesOf(outPath, 320, 180);
      const xs = outFrames.map((f) => redAt(f.pic)).filter((v): v is number => v !== null);
      const steps = xs.slice(1).map((v, i) => (v - xs[i]!) * 1280);
      const stuck = steps.filter((d) => d < 0.6).length;
      out['export steps px'] = steps.slice(0, 30).map((d) => d.toFixed(1)).join(' ');
      ok('the export shows a new picture every frame (smooth, not repeated)', xs.length >= 55 && stuck <= 2, { frames: xs.length, stuck, step: +(steps.reduce((a, b) => a + b, 0) / Math.max(1, steps.length)).toFixed(2) });
    }
  }

  // --- Sharper pictures ---------------------------------------------------------------------------
  {
    const small = { ...clip0, inUs: 3 * S, outUs: 3.2 * S, enhance: { upscale: 2 as const } };
    const t3 = performance.now();
    let src: Awaited<ReturnType<typeof copyFor>> | null = null;
    try { src = await copyFor(small); } catch (e) { ok('sharper pictures are made', false, String(e)); }
    if (src) {
      const t = src.tracks[0]!;
      out['upscaling took (s per picture)'] = +((performance.now() - t3) / 1000 / Math.max(1, lastBuild.made)).toFixed(2);
      ok('the copy is twice the size', t.width === 2560 && t.height === 1440, [t.width, t.height]);
      ok('one picture for each recorded one', lastBuild.made === lastBuild.frames, [lastBuild.frames, lastBuild.made]);
      // Sharper than simply enlarging: more fine detail (edge strength) than a plain resize of the original.
      const [orig] = await framesOf(path, 2560, 1440, 3.1 * S, 3.2 * S);
      const dec = new TrackDecoder(src.reader, t);
      const at = t.samples.map((x) => x.timestamp).sort((a, b) => a - b).find((x) => x >= orig!.t - 500)!;
      dec.seek(at);
      let f: VideoFrame | null = null;
      for (let i = 0; i < 3000 && !f; i++) { void dec.pump(); f = dec.frameAt(at); if (!f) await sleep(2); }
      const cv = new OffscreenCanvas(2560, 1440), x = cv.getContext('2d', { willReadFrequently: true })!;
      x.drawImage(f!, 0, 0);
      const up = { w: 2560, h: 1440, d: x.getImageData(0, 0, 2560, 1440).data };
      dec.close();
      const edges = (p: Pic) => { let s = 0; for (let y = 400; y < 1000; y += 2) for (let xx = 400; xx < 2100; xx += 2) { const i = (y * p.w + xx) * 4; s += Math.abs(p.d[i + 1]! - p.d[i + 5]!); } return s; };
      const e0 = edges(orig!.pic), e1 = edges(up);
      ok('the picture is sharper than plain enlarging', e1 > e0 * 1.15, { plain: e0, sharper: e1 });
      const same = redAt({ w: 2560, h: 1440, d: up.d }), want = redAt(orig!.pic);
      ok('and shows the same thing in the same place', same !== null && want !== null && Math.abs(same - want) < 0.005, [same, want]);
    }
  }

  // --- Auto subtitles -----------------------------------------------------------------------------
  const speech = await speechClip();
  if (!speech) ok('the speech test file is there (run scripts/make-speech-fixture.sh)', false);
  else {
    const sm = await getMedia(speech);
    const stl: Timeline = addClip(emptyTimeline(), newClip(speech, sm.durationUs, false));
    const stages: string[] = [];
    const t1 = performance.now();
    let sub: Awaited<ReturnType<typeof makeSubtitles>> | null = null;
    try {
      sub = await makeSubtitles(stl, 'auto', (p) => { if (stages[stages.length - 1] !== p.stage) stages.push(p.stage); }, new AbortController().signal);
    } catch (e) { ok('auto subtitles run', false, String(e)); }
    const secs = (performance.now() - t1) / 1000;
    if (sub) {
      const words = sub.captions.map((c) => c.text.replace(/\n/g, ' ')).join(' ').toLowerCase().replace(/[^a-z ]/g, '');
      out['heard'] = words;
      out['subtitles took (s, incl. any download)'] = +secs.toFixed(1);
      out['listening took (s)'] = +(sub.ms / 1000).toFixed(1);
      ok('it finds the language (English)', sub.language === 'en', sub.language);
      const want = ['pump track', 'big jump', 'speed', 'berm', 'best lap'];
      ok('it writes down what was said', want.every((w) => words.includes(w)), want.filter((w) => !words.includes(w)));
      const caps = sub.captions;
      const keep = caps.find((c) => /keep your speed/i.test(c.text.replace(/\n/g, ' ')));
      const first = caps[0];
      ok('captions start when the talking starts', !!first && first.startUs < 1.2 * S, first && first.startUs / S);
      ok('and later sentences come later, after the pause', !!keep && keep.startUs > 4 * S && keep.startUs > first!.endUs, keep && [keep.startUs / S, first!.endUs / S]);
      ok('captions are short and in order', caps.every((c, i) => c.text.split('\n').length <= 2 && c.endUs > c.startUs && (!i || c.startUs >= caps[i - 1]!.endUs)), caps.length);
      ok('listening is quicker than the sound lasts', sub.ms / 1000 < sm.durationUs / S, +(sub.ms / 1000).toFixed(1));
      // On the timeline, and as an .srt file.
      const withCaps = withCaptions(stl, sub.captions);
      const srt = toSrt(withCaps);
      ok('the .srt file has every caption', fromSrt(srt).length === caps.length && srt.startsWith('1\n00:00:0'), srt.slice(0, 80));
      void aceApi;
      // Through the app: AI tools → Auto subtitles.
      api.setTimeline(stl);
      api.player.seek(2 * S);
      await settle(api, 2);
      api.run?.('subtitles');
      await sleep(300);
      const make = [...document.querySelectorAll<HTMLButtonElement>('.subtitles-dialog button')].find((b) => b.textContent === 'Make subtitles');
      ok('the Auto subtitles window opens', !!make);
      make?.click();
      for (let i = 0; i < 600 && !document.querySelector('.subtitles-dialog .notice-text'); i++) await sleep(100);
      const said = document.querySelector('.subtitles-dialog .notice-text')?.textContent ?? '';
      ok('it says how many captions were added', /Added \d+ captions? \(English\)/.test(said), said);
      await ace.capture('ai-subtitles-dialog');
      const caps2 = api.getTimeline().overlays.filter((o) => o.caption);
      ok('the captions are on the timeline', caps2.length === sub.captions.length, caps2.length);
      [...document.querySelectorAll<HTMLButtonElement>('.subtitles-dialog button')].find((b) => b.textContent === 'Done')?.click();
      api.player.seek(2 * S);
      await settle(api);
      await ace.capture('ai-subtitles-preview');
      ok('undo takes them away in one step', (() => { api.run?.('undo'); return !api.getTimeline().overlays.some((o) => o.caption); })());
    }
  }

  // --- Smart reframe: a 360 clip follows the way it travels -------------------------------------
  const all = await ace.listFixtures();
  const ride = all.find((f) => f.endsWith('max2/GS010004.360'));
  if (ride) {
    const rm = await getMedia(ride);
    const rc = { ...newClip(ride, rm.durationUs, true), inUs: 60 * S, outUs: 90 * S };
    const rr = await smartReframe(rc, rm, 9 / 16, () => {}, new AbortController().signal);
    ok('a 360 ride follows its direction of travel from GPS', rr.how === 'gps', rr.how);
    ok('kept steady and level', rr.patch.stabilize?.smoothing === 'locked' && rr.patch.stabilize.horizon === true);
    // The view turns no faster than about 90° a second (a calm camera).
    const ks = rr.patch.keyframes ?? [];
    let fastest = 0;
    for (let i = 1; i < ks.length; i++) { let d = ks[i]!.look.yaw - ks[i - 1]!.look.yaw; d = ((d + 540) % 360) - 180; fastest = Math.max(fastest, Math.abs(d) / ((ks[i]!.t - ks[i - 1]!.t) / S)); }
    ok('and turns calmly', ks.length >= 2 && fastest < 90, { keys: ks.length, fastest: +fastest.toFixed(1) });
  } else out['360 ride'] = 'skipped (no GS010004.360)';
  return { fails, ...out };
}
