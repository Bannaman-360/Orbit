// 10-bit export: can the encoder write HEVC Main10 from 10-bit pictures?

import { canEncodeVideo, Mp4OutputFormat, Output, StreamTarget, VideoSample, VideoSampleSource, type StreamTargetChunk } from 'mediabunny';
import { ace } from './api';

export async function tenbitProbe() {
  const out: Record<string, unknown> = {};
  const W = 1920, H = 1080;
  for (const s of ['hvc1.2.4.L153.B0', 'hvc1.2.4.L123.B0', 'hev1.2.4.L153.B0']) out[`can ${s}`] = await canEncodeVideo('hevc', { width: W, height: H, fullCodecString: s });
  out['VideoEncoder.isConfigSupported main10'] = await VideoEncoder.isConfigSupported({ codec: 'hvc1.2.4.L153.B0', width: W, height: H, bitrate: 2e7, hardwareAcceleration: 'prefer-hardware' }).then((r) => r.supported, (e) => String(e));
  for (const c of ['vp09.02.10.10', 'vp09.02.40.10', 'av01.0.08M.10', 'av01.0.04M.10', 'av01.1.08M.10', 'hvc1.2.4.L120.B0', 'hvc1.2.6.L153.B0']) {
    for (const hw of ['prefer-hardware', 'prefer-software'] as const) out[`${c} ${hw}`] = await VideoEncoder.isConfigSupported({ codec: c, width: W, height: H, bitrate: 2e7, hardwareAcceleration: hw }).then((r) => r.supported, (e) => String(e).slice(0, 80));
  }
  
  const path = await ace.selftestOut('tenbit-probe.mp4');
  try {
    await ace.createFile(path);
    const target = new StreamTarget(new WritableStream<StreamTargetChunk>({ write: (c) => ace.writeAt(path, c.position, c.data) }));
    const output = new Output({ format: new Mp4OutputFormat(), target });
    const src = new VideoSampleSource({ codec: 'hevc', bitrate: 3e7, keyFrameInterval: 1, fullCodecString: 'hvc1.2.6.L153.B0', onEncoderConfig: (c) => { out.encoderConfig = JSON.stringify(c); } } as ConstructorParameters<typeof VideoSampleSource>[0]);
    output.addVideoTrack(src, { frameRate: 30 });
    await output.start();
    // A gentle grey ramp across the picture: 64…940 (10-bit studio range).
    const ySize = W * H, cSize = (W / 2) * (H / 2);
    const buf = new Uint16Array(ySize + cSize * 2);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) buf[y * W + x] = Math.round(64 + (876 * x) / (W - 1));
    buf.fill(512, ySize);
    for (let i = 0; i < 10; i++) {
      const s = new VideoSample(new Uint8Array(buf.buffer), { format: 'I420P10', codedWidth: W, codedHeight: H, timestamp: i / 30, duration: 1 / 30, colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } });
      await src.add(s);
      s.close();
    }
    await output.finalize();
    await ace.closeFile(path);
    out.written = path;
  } catch (e) {
    out.error = String((e as Error).stack ?? e);
  }
  return { fails: [], ...out };
}

/** Exports the same few seconds as 8-bit H.264, 10-bit HEVC and ProRes, for reading back outside. */
export async function tenbitExport() {
  const { addClip, emptyTimeline, newClip } = await import('@ace/project');
  const { getMedia } = await import('./media');
  const { exportTimeline } = await import('./exporter');
  const out: Record<string, unknown> = {};
  const fails: string[] = [];
  out.encoders = await ace.encoderAvailable();
  const all = await ace.listFixtures();
  const m = await getMedia(all.find((f) => f.endsWith('GS010115.360'))!);
  let tl = addClip(emptyTimeline(), { ...newClip(m.path, m.durationUs, true), inUs: 2e6, outUs: 5e6 });
  // Look up at the sky, and brighten it: smooth gradients, stretched.
  tl = { ...tl, clips: tl.clips.map((c) => ({ ...c, look: { ...c.look, pitch: 12, grade: { ...c.look.grade, exposure: -0.3, contrast: 0.15 } } })) };
  for (const [codec, name, resolution] of [['avc', 'tb-avc.mp4', 1080], ['hevc10', 'tb-hevc10.mp4', 1080], ['prores', 'tb-prores.mov', 1080], ['hevc', 'tb-hevc-4k.mp4', 2160], ['hevc10', 'tb-hevc10-4k.mp4', 2160]] as const) {
    const path = await ace.selftestOut(name);
    const t0 = performance.now();
    try {
      await exportTimeline(tl, { path, resolution, fps: 30, codec, quality: 'high' }, () => {}, new AbortController().signal);
      out[name] = { seconds: +((performance.now() - t0) / 1000).toFixed(1), fps: +(90 / ((performance.now() - t0) / 1000)).toFixed(1) };
    } catch (e) {
      out[name] = String(e);
      fails.push(name);
    }
  }
  return { fails, ...out };
}
