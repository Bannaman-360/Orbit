// Automated smoke test: `pnpm --filter desktop selftest`.
// Generates a synthetic .360, opens it, renders a set of views to PNG and measures
// playback. Also opens any real clips in fixtures/ and records what it finds.
// Output: selftest-out/report.json and selftest-out/*.png at the repo root.

import { DEFAULT_VIEW, TINY_PLANET_VIEW, type RenderMode, type ViewParams } from '@ace/media360';
import type { CorrectionOptions } from '@ace/telemetry';
import { ace } from './api';
import type { Session } from './session';

export interface Controller {
  generate(): Promise<string>;
  load(path: string): Promise<Session>;
  set(o: { mode?: RenderMode; view?: ViewParams; stab?: CorrectionOptions; showTiles?: boolean }): void;
  session(): Session | null;
  nextRender(): Promise<void>;
  renderCount(): number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(ctl: Controller, timeoutMs = 8000) {
  // Wait for a few fresh renders (state updates land on the next React commit).
  const deadline = performance.now() + timeoutMs;
  for (let i = 0; i < 3; i++) {
    await Promise.race([ctl.nextRender(), sleep(Math.max(0, deadline - performance.now()))]);
  }
  await sleep(150);
}

async function measurePlayback(ctl: Controller, seconds: number) {
  const s = ctl.session()!;
  s.player.seek(0);
  await settle(ctl);
  const r0 = ctl.renderCount();
  const stalls0 = s.player.stalls;
  const t0 = performance.now();
  s.player.play();
  await sleep(seconds * 1000);
  s.player.pause();
  const wall = (performance.now() - t0) / 1000;
  return {
    wallSeconds: +wall.toFixed(2),
    mediaSecondsAdvanced: +(s.player.time / 1e6).toFixed(2),
    renderFps: +((ctl.renderCount() - r0) / wall).toFixed(1),
    stalls: s.player.stalls - stalls0,
    decoderErrors: s.player.decoders.flatMap((d) => d.stats.errors),
  };
}

function describe(s: Session) {
  return {
    path: s.path,
    sizeMB: +(s.size / 1e6).toFixed(1),
    openMs: Math.round(s.openMs),
    is360: s.is360,
    durationS: +(s.info.durationUs / 1e6).toFixed(2),
    videoTracks: s.info.videoTracks.map((t) => ({ id: t.id, codec: t.codec, w: t.width, h: t.height, fps: +t.fps.toFixed(3), frames: t.samples.length, keyframes: t.samples.filter((x) => x.isSync).length })),
    audioTracks: s.info.audioTrackCount,
    decoder: s.support,
    layout: s.layout?.name,
    telemetry: s.orientation
      ? { streams: s.orientation.streams, grav: s.orientation.grav.length, cori: s.orientation.cori.length, gravFirst: s.orientation.grav[0], coriFirst: s.orientation.cori[0] }
      : s.telemetryError ?? null,
  };
}

const VIEWS: [string, RenderMode, ViewParams][] = [
  ['front', '360', DEFAULT_VIEW],
  ['right', '360', { ...DEFAULT_VIEW, yaw: 90 }],
  ['back', '360', { ...DEFAULT_VIEW, yaw: 180 }],
  ['up', '360', { ...DEFAULT_VIEW, pitch: 90 }],
  ['down', '360', { ...DEFAULT_VIEW, pitch: -90 }],
  ['seam-corner', '360', { ...DEFAULT_VIEW, yaw: 45, pitch: 35, fov: 120 }],
  ['tiny-planet', '360', TINY_PLANET_VIEW],
  ['raw', 'raw', DEFAULT_VIEW],
];

export async function runSelftest(ctl: Controller, versions: Record<string, string>) {
  const report: Record<string, unknown> = {
    when: new Date().toISOString(),
    versions: { electron: versions.electron, chrome: versions.chrome, node: versions.node },
    webgpu: 'gpu' in navigator,
  };
  try {
    const t0 = performance.now();
    const synth = await ctl.generate();
    report.synthetic = { path: synth, generateMs: Math.round(performance.now() - t0) };

    const s = await ctl.load(synth);
    report.syntheticFile = describe(s);
    s.player.seek(1_000_000);
    for (const [name, mode, view] of VIEWS) {
      ctl.set({ mode, view, showTiles: true });
      await settle(ctl);
      await ace.capture(`synthetic-${name}`);
    }
    ctl.set({ mode: '360', view: { ...DEFAULT_VIEW, yaw: 90 } });
    report.syntheticPlayback = await measurePlayback(ctl, 3);

    // Real footage, if the user has added any.
    const files = (await ace.listFixtures()).filter((f) => !/[\\/]synthetic[\\/]/.test(f));
    const real: unknown[] = [];
    for (const f of files) {
      try {
        const rs = await ctl.load(f);
        const entry: Record<string, unknown> = describe(rs);
        const tag = f.split(/fixtures[\\/]/)[1]!.replace(/[\\/]/g, '_');
        rs.player.seek(Math.min(2_000_000, rs.player.durationUs / 2));
        if (rs.is360) {
          for (const [name, mode, view] of VIEWS.filter(([n]) => ['front', 'back', 'raw', 'tiny-planet'].includes(n))) {
            ctl.set({ mode, view, showTiles: true, stab: { mode: 'off', axisMap: ['x', 'y', 'z'] } });
            await settle(ctl);
            await ace.capture(`${tag}-${name}`);
          }
        } else {
          ctl.set({ mode: 'flat' });
          await settle(ctl);
          await ace.capture(`${tag}-flat`);
        }
        entry.playback = await measurePlayback(ctl, 3);
        real.push(entry);
      } catch (e) {
        real.push({ path: f, error: String(e) });
      }
    }
    report.realFootage = real;
    report.ok = true;
  } catch (e) {
    report.ok = false;
    report.error = String(e instanceof Error ? e.stack ?? e.message : e);
  }
  await ace.selftestDone(report);
}
