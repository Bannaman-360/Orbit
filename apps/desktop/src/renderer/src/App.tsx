import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_VIEW,
  MAX_FOV,
  ReframeRenderer,
  TINY_PLANET_VIEW,
  validateLayout,
  type EacLayout,
  type RenderMode,
  type ViewParams,
} from '@ace/media360';
import { correctionAt, DEFAULT_AXIS_MAP, type AxisMap, type CorrectionOptions } from '@ace/telemetry';
import { ace } from './api';
import { openSession, type Session } from './session';
import { generateSynthetic360 } from './synth';
import { runSelftest, type Controller } from './selftest';
import { calibrateSession } from './calib';

const AXES = ['x', '-x', 'y', '-y', 'z', '-z'];
const fmt = (us: number) => {
  const s = us / 1e6;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
};
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ReframeRenderer | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const renderWaiters = useRef<(() => void)[]>([]);
  const renderCount = useRef(0);

  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fixtures, setFixtures] = useState<string[]>([]);
  const [mode, setMode] = useState<RenderMode>('360');
  const [view, setView] = useState<ViewParams>(DEFAULT_VIEW);
  const [stab, setStab] = useState<CorrectionOptions>({ mode: 'off', axisMap: DEFAULT_AXIS_MAP, invert: false });
  const [showTiles, setShowTiles] = useState(true);
  const [layoutText, setLayoutText] = useState('');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [stats, setStats] = useState({ renderFps: 0, decoded: [] as number[], dropped: [] as number[], stalls: 0, errors: [] as string[] });

  const [calibration, setCalibration] = useState<string | null>(null);

  function applyLayoutObj(l: EacLayout) {
    rendererRef.current?.setLayout(l);
    if (sessionRef.current) sessionRef.current.layout = l;
    setLayoutText(JSON.stringify(l, null, 1));
  }

  // Hot-path state lives in refs so the render loop never waits on React.
  const live = useRef({ mode, view, stab, showTiles });
  live.current = { mode, view, stab, showTiles };

  const refreshFixtures = useCallback(() => ace.listFixtures().then(setFixtures), []);

  const load = useCallback(async (path: string, size?: number) => {
    setError(null);
    setBusy(`Opening ${baseName(path)}…`);
    try {
      sessionRef.current?.player.close();
      sessionRef.current = null;
      const sz = size ?? (await ace.stat(path)).size;
      const s = await openSession(path, sz);
      sessionRef.current = s;
      if (s.layout) rendererRef.current?.setLayout(s.layout);
      setLayoutText(s.layout ? JSON.stringify(s.layout, null, 1) : '');
      setMode(s.is360 ? '360' : 'flat');
      setSession(s);
      return s;
    } catch (e) {
      setError(String(e));
      throw e;
    } finally {
      setBusy(null);
    }
  }, []);

  // GPU setup + render loop.
  useEffect(() => {
    let raf = 0;
    let stop = false;
    let frames = 0;
    let fpsT = performance.now();
    (async () => {
      try {
        rendererRef.current = await ReframeRenderer.create(canvasRef.current!);
      } catch (e) {
        setError(`GPU: ${e}`);
        return;
      }
      const loop = (now: number) => {
        if (stop) return;
        const c = canvasRef.current!;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        const s = sessionRef.current;
        const r = rendererRef.current;
        if (s && r) {
          const got = s.player.tick(now);
          if (got) {
            const { mode, view, stab, showTiles } = live.current;
            const m = s.is360 ? mode : 'flat';
            r.render({
              frames: got as [VideoFrame, VideoFrame],
              mode: m,
              view,
              correction: m === '360' ? correctionAt(s.orientation, s.player.time, stab) : undefined,
              showTiles,
            });
            frames++;
            renderCount.current++;
            const waiters = renderWaiters.current.splice(0);
            waiters.forEach((f) => f());
          }
        }
        if (now - fpsT > 500) {
          const s2 = sessionRef.current;
          setStats({
            renderFps: (frames * 1000) / (now - fpsT),
            decoded: s2?.player.decoders.map((d) => d.stats.decoded) ?? [],
            dropped: s2?.player.decoders.map((d) => d.stats.dropped) ?? [],
            stalls: s2?.player.stalls ?? 0,
            errors: s2?.player.decoders.flatMap((d) => d.stats.errors) ?? [],
          });
          frames = 0;
          fpsT = now;
        }
        if (s) { setTime(s.player.time); setPlaying(s.player.playing); }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();
    return () => { stop = true; cancelAnimationFrame(raf); };
  }, []);

  // Fixtures list + self-test entry point.
  useEffect(() => {
    void refreshFixtures();
    void ace.info().then((info) => {
      if (!info.selftest) return;
      const ctl: Controller = {
        setLayout: (l) => applyLayoutObj(l),
        generate: () => generateSynthetic360({}, (p) => setBusy(`Generating synthetic .360… ${Math.round(p * 100)}%`)),
        load: (p) => load(p),
        set: (o) => {
          if (o.mode) setMode(o.mode);
          if (o.view) setView(o.view);
          if (o.stab) setStab(o.stab);
          if (o.showTiles !== undefined) setShowTiles(o.showTiles);
        },
        session: () => sessionRef.current,
        nextRender: () => new Promise((res) => renderWaiters.current.push(res)),
        renderCount: () => renderCount.current,
      };
      void runSelftest(ctl, info.versions);
    });
  }, [load, refreshFixtures]);

  // Drag to look, wheel to zoom.
  const drag = useRef<{ x: number; y: number; view: ViewParams } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, view };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || mode !== '360') return;
    const c = canvasRef.current!;
    const degPerPx = Math.min(d.view.fov, 120) / c.clientWidth;
    setView({
      ...d.view,
      yaw: d.view.yaw - (e.clientX - d.x) * degPerPx,
      pitch: Math.max(-90, Math.min(90, d.view.pitch + (e.clientY - d.y) * degPerPx)),
    });
  };
  const onWheel = (e: React.WheelEvent) => {
    if (mode !== '360') return;
    setView((v) => ({ ...v, fov: Math.max(20, Math.min(MAX_FOV[v.projection], v.fov * Math.exp(e.deltaY * 0.001))) }));
  };

  const togglePlay = () => {
    const p = sessionRef.current?.player;
    if (!p) return;
    if (p.playing) p.pause(); else p.play();
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const applyLayout = () => {
    try {
      const l = JSON.parse(layoutText) as EacLayout;
      validateLayout(l);
      applyLayoutObj(l);
      setError(null);
    } catch (e) {
      setError(`Layout: ${e}`);
    }
  };

  const autoCalibrate = async () => {
    const s = sessionRef.current;
    if (!s) return;
    setBusy('Calibrating layout from footage…');
    try {
      const r = await calibrateSession(s);
      applyLayoutObj(r.layout);
      setCalibration(`Edge mismatch ${r.baselineScore.toFixed(1)} → ${r.score.toFixed(1)} (${r.seam}${r.mirroredTiles.length ? `, mirrored: ${r.mirroredTiles.join(', ')}` : ''})`);
    } catch (e) {
      setError(`Calibration: ${e}`);
    } finally {
      setBusy(null);
    }
  };

  const slider = (label: string, key: 'yaw' | 'pitch' | 'roll' | 'fov', min: number, max: number) => (
    <label className="row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={0.5} value={view[key]} onChange={(e) => setView({ ...view, [key]: +e.target.value })} />
      <code>{view[key].toFixed(1)}°</code>
    </label>
  );

  const s = session;
  return (
    <div className="app">
      <header>
        <strong>Action Cam Editor</strong>
        <span className="muted">Phase 0 spike</span>
        <button onClick={async () => { const r = await ace.openDialog(); if (r) await load(r.path, r.size); }}>Open file…</button>
        <select value="" onChange={(e) => e.target.value && load(e.target.value)}>
          <option value="">Fixtures ({fixtures.length})</option>
          {fixtures.map((f) => <option key={f} value={f}>{f.split(/fixtures[\\/]/)[1]}</option>)}
        </select>
        <button onClick={async () => {
          try {
            const p = await generateSynthetic360({}, (x) => setBusy(`Generating synthetic .360… ${Math.round(x * 100)}%`));
            await refreshFixtures();
            await load(p);
          } catch (e) { setError(String(e)); } finally { setBusy(null); }
        }}>Generate synthetic .360</button>
        {busy && <span className="busy">{busy}</span>}
        {error && <span className="error" title={error}>{error}</span>}
      </header>

      <main>
        <div className="stage">
          <canvas ref={canvasRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
            onPointerUp={() => (drag.current = null)} onWheel={onWheel} />
          {!s && !busy && <div className="empty">Open a GoPro .360 or .MP4 file, pick one from fixtures/, or generate a synthetic test file.</div>}
          {s && mode === 'raw' && <div className="rawlabels"><span>stream 0</span><span>stream 1</span></div>}
        </div>
        <div className="transport">
          <button disabled={!s} onClick={togglePlay}>{playing ? 'Pause' : 'Play'}</button>
          <input type="range" min={0} max={s?.player.durationUs ?? 1} value={time} disabled={!s}
            onChange={(e) => sessionRef.current?.player.seek(+e.target.value)} />
          <code>{fmt(time)} / {fmt(s?.player.durationUs ?? 0)}</code>
        </div>
      </main>

      <aside>
        <section>
          <h3>View</h3>
          <div className="seg">
            {(['360', 'raw', 'flat'] as RenderMode[]).map((m) => (
              <button key={m} className={mode === m ? 'on' : ''} disabled={!s?.is360 && m !== 'flat'} onClick={() => setMode(m)}>
                {m === '360' ? 'Reframe' : m === 'raw' ? 'Raw streams' : 'Flat'}
              </button>
            ))}
          </div>
          <label className="row"><span>Lens</span>
            <select value={view.projection} onChange={(e) => setView({ ...view, projection: e.target.value as ViewParams['projection'], fov: Math.min(view.fov, MAX_FOV[e.target.value as ViewParams['projection']]) })}>
              <option value="rectilinear">Flat (rectilinear)</option>
              <option value="stereographic">Wide / tiny planet (stereographic)</option>
            </select>
          </label>
          {slider('Yaw', 'yaw', -180, 180)}
          {slider('Pitch', 'pitch', -90, 90)}
          {slider('Roll', 'roll', -180, 180)}
          {slider('FOV', 'fov', 20, MAX_FOV[view.projection])}
          <div className="seg">
            <button onClick={() => setView(DEFAULT_VIEW)}>Reset</button>
            <button onClick={() => setView(TINY_PLANET_VIEW)}>Tiny planet</button>
          </div>
          <label className="row"><span>Tile outlines</span><input type="checkbox" checked={showTiles} onChange={(e) => setShowTiles(e.target.checked)} /></label>
        </section>

        <section>
          <h3>Stabilise</h3>
          <div className="seg">
            {(['off', 'horizon', 'lock'] as const).map((m) => (
              <button key={m} className={stab.mode === m ? 'on' : ''} disabled={m !== 'off' && !s?.orientation} onClick={() => setStab({ ...stab, mode: m })}>
                {m === 'off' ? 'Off' : m === 'horizon' ? 'Level horizon' : 'Lock (CORI)'}
              </button>
            ))}
          </div>
          <label className="row"><span>Sensor axes</span>
            <span className="axes">
              {[0, 1, 2].map((i) => (
                <select key={i} value={stab.axisMap[i]} onChange={(e) => {
                  const a = [...stab.axisMap] as AxisMap; a[i] = e.target.value; setStab({ ...stab, axisMap: a });
                }}>{AXES.map((x) => <option key={x}>{x}</option>)}</select>
              ))}
            </span>
          </label>
          <label className="row"><span>Invert</span><input type="checkbox" checked={!!stab.invert} onChange={(e) => setStab({ ...stab, invert: e.target.checked })} /></label>
          <p className="muted small">Calibration: with Level horizon on, tilt-heavy footage should look level. If it tilts the wrong way, try Invert or other axis orders.</p>
        </section>

        <section>
          <h3>Diagnostics</h3>
          {s ? (
            <table className="diag"><tbody>
              <tr><td>File</td><td title={s.path}>{baseName(s.path)} ({(s.size / 1e6).toFixed(0)} MB)</td></tr>
              <tr><td>Index parsed</td><td>{s.openMs.toFixed(0)} ms</td></tr>
              {s.info.videoTracks.map((t) => (
                <tr key={t.id}><td>Video #{t.id}</td><td>{t.codec} {t.width}×{t.height} @ {t.fps.toFixed(2)} fps, {t.samples.length} frames</td></tr>
              ))}
              <tr><td>Decoder</td><td>{s.support.map((x) => (x.hardware === true ? 'hardware' : x.hardware === false ? 'software' : '?')).join(' / ')}</td></tr>
              <tr><td>Audio tracks</td><td>{s.info.audioTrackCount}</td></tr>
              <tr><td>Render</td><td>{stats.renderFps.toFixed(1)} fps, stalls {stats.stalls}</td></tr>
              <tr><td>Decoded</td><td>{stats.decoded.join(' / ')} (dropped {stats.dropped.join(' / ')})</td></tr>
              <tr><td>Telemetry</td><td>{s.orientation ? `GRAV ${s.orientation.grav.length}, CORI ${s.orientation.cori.length}` : s.telemetryError ?? 'none'}</td></tr>
              {s.orientation && <tr><td>Streams</td><td className="small">{s.orientation.streams.join(' ')}</td></tr>}
              {stats.errors.length > 0 && <tr><td>Errors</td><td className="error">{stats.errors.slice(-3).join('; ')}</td></tr>}
            </tbody></table>
          ) : <p className="muted">No file loaded.</p>}
        </section>

        {s?.is360 && (
          <section>
            <h3>Layout (calibration)</h3>
            <textarea value={layoutText} onChange={(e) => setLayoutText(e.target.value)} spellCheck={false} />
            <div className="seg">
              <button onClick={applyLayout}>Apply layout</button>
              <button onClick={autoCalibrate}>Auto-calibrate from footage</button>
            </div>
            {calibration && <p className="muted small">{calibration}</p>}
          </section>
        )}
      </aside>
    </div>
  );
}
