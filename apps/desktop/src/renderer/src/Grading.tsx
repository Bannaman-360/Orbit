// Pro grading controls (milestone 4): colour wheels, curves, the HSL qualifier, noise reduction
// and film looks. Wheels keyframe with the look; the rest belongs to the clip.

import { useRef, useState } from 'react';
import {
  CURVE_NAMES, DEFAULT_QUALIFIER, FILM_LOOKS, NEUTRAL_CURVES, NEUTRAL_WHEEL, NEUTRAL_WHEELS, QUALIFIER_PRESETS, WHEEL_NAMES, curveNeutral, curvesNeutral, filmCube, hueAt,
  isHueCurve, isToneCurve, puckRgb, setCurvePoint, toneAt, wheelsNeutral,
  type CurvePoints, type Denoise, type GradeCurveName, type GradeCurves, type Look, type OffKey, type Qualifier, type TimelineClip, type Wheel, type WheelName, type Wheels,
} from '@ace/project';
import { ace } from './api';
import { gradeView } from './gradeView';
import { Section, Slider, type Units } from './ui';

const PCT: Units = { to: (v) => v * 100, from: (n) => n / 100, digits: 0 };
const DEG: Units = { digits: 0 };
const pct = (v: number) => `${Math.round(v * 100)}%`;
const signed = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;

interface Toggle { on: boolean; onToggle: () => void }
export interface GradingProps {
  clip: TimelineClip;
  look: Look;
  keyed: boolean;
  onLook: (patch: Partial<Look>, key: string) => void;
  onClip: (patch: Partial<TimelineClip>, key: string) => void;
  sw: (key: OffKey) => Toggle;
}

// --- Wheels ---------------------------------------------------------------------------------------

/** The colour a puck position pushes towards, for its dot. */
function puckColor(w: Wheel): string {
  const p = puckRgb(w.x, w.y).map((v) => Math.round(Math.max(0, Math.min(1, 0.5 + v * 0.9)) * 255));
  return `rgb(${p.join(',')})`;
}

function WheelPad({ name, label, sub, wheel, onChange, onDone }: { name: string; label: string; sub: string; wheel: Wheel; onChange: (w: Wheel) => void; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const box = ref.current!.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, w: wheel };
    const fine = (ev: PointerEvent) => (ev.shiftKey ? 0.25 : 1);
    const move = (ev: PointerEvent) => {
      // Dragging moves the puck by how far the pointer moved (Shift: finer), so it never jumps.
      let x = start.w.x + ((ev.clientX - start.x) / (box.width / 2)) * fine(ev);
      let y = start.w.y - ((ev.clientY - start.y) / (box.height / 2)) * fine(ev);
      const r = Math.hypot(x, y);
      if (r > 1) { x /= r; y /= r; }
      onChange({ ...start.w, x, y });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); onDone(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="wheel" data-wheel={name}>
      <div className="wheel-title"><b>{label}</b><span className="muted">{sub}</span></div>
      <div ref={ref} className="wheel-disc" role="slider" aria-label={`${label} colour`} aria-valuetext={`${Math.round(Math.hypot(wheel.x, wheel.y) * 100)}%`} title="Drag to push the colour (Shift for fine steps) · double-click to centre" onPointerDown={drag} onDoubleClick={() => { onChange({ ...wheel, x: 0, y: 0 }); onDone(); }}>
        <span className="wheel-puck" style={{ left: `${50 + wheel.x * 50}%`, top: `${50 - wheel.y * 50}%`, background: puckColor(wheel) }} />
      </div>
      <input
        className="wheel-master" type="range" min={-1} max={1} step={0.01} value={wheel.master} aria-label={`${label} brightness`} title="Brightness · double-click to reset"
        onChange={(e) => onChange({ ...wheel, master: Number(e.target.value) })} onPointerUp={onDone} onDoubleClick={() => { onChange({ ...wheel, master: 0 }); onDone(); }}
      />
    </div>
  );
}

export function WheelsSection({ look, keyed, onLook, sw }: GradingProps) {
  const w: Wheels = look.wheels ?? NEUTRAL_WHEELS;
  const set = (k: WheelName) => (v: Wheel) => onLook({ wheels: { ...w, [k]: v } }, `wheel-${k}`);
  const on = !wheelsNeutral(look.wheels);
  const t = sw('wheels');
  return (
    <Section title="Color wheels" badge={on ? (t.on ? 'On' : 'Off') : undefined} actions={on ? <button className="link" onClick={() => onLook({ wheels: undefined }, 'wheels-reset')}>Reset</button> : undefined}>
      <div className={`wheels${t.on ? '' : ' is-off'}`}>
        {WHEEL_NAMES.map(([k, label, sub]) => <WheelPad key={k} name={k} label={label} sub={sub} wheel={w[k] ?? NEUTRAL_WHEEL} onChange={set(k)} onDone={() => {}} />)}
      </div>
      {on && <label className="check"><input type="checkbox" checked={t.on} onChange={t.onToggle} /> Use the wheels (off: compare without them)</label>}
      <p className="hint">{keyed ? 'Keyframed: changes go into the keyframe at the playhead.' : 'Drag a wheel’s dot towards a colour to tint that part of the picture; the slider under it makes it brighter or darker.'}</p>
    </Section>
  );
}

// --- Curves ---------------------------------------------------------------------------------------

const CW = 232, CH = 180, M = 8;
const cx = (x: number) => M + x * (CW - 2 * M);
const cy = (y: number) => CH - M - y * (CH - 2 * M);
const CURVE_TINT: Record<GradeCurveName, string> = { master: 'var(--text)', r: '#ff453a', g: '#30d158', b: '#0a84ff', hueSat: 'var(--accent)', hueHue: 'var(--accent)', lumSat: 'var(--accent)' };

export function CurvesSection({ clip, onClip, sw }: GradingProps) {
  const [which, setWhich] = useState<GradeCurveName>('master');
  const svg = useRef<SVGSVGElement>(null);
  const curves: GradeCurves = clip.curves ?? NEUTRAL_CURVES;
  const pts = curves[which];
  const hue = isHueCurve(which);
  const put = (c: CurvePoints, key = `curve-${which}`) => {
    const next = { ...curves, [which]: c };
    onClip({ curves: curvesNeutral(next) ? undefined : next }, key);
  };
  const toCurve = (e: { clientX: number; clientY: number }): [number, number] => {
    const b = svg.current!.getBoundingClientRect();
    const X = ((e.clientX - b.left) / b.width) * CW, Y = ((e.clientY - b.top) / b.height) * CH;
    return [Math.max(0, Math.min(1, (X - M) / (CW - 2 * M))), Math.max(0, Math.min(1, (CH - M - Y) / (CH - 2 * M)))];
  };
  const dragPoint = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = pts;
    const first = isToneCurve(which) && i === 0, last = isToneCurve(which) && i === start.length - 1;
    let removed = false;
    const move = (ev: PointerEvent) => {
      const [x, y] = toCurve(ev);
      // Dragged well outside: the point is removed (the ends of a tone curve stay).
      const b = svg.current!.getBoundingClientRect();
      const outside = ev.clientY < b.top - 30 || ev.clientY > b.bottom + 30;
      if (outside && !first && !last && start.length > (hue ? 1 : 2)) { removed = true; put(start.filter((_, k) => k !== i), `curve-${which}-drag`); return; }
      removed = false;
      const lo = i > 0 ? start[i - 1]![0] + 0.01 : 0, hi = i < start.length - 1 ? start[i + 1]![0] - 0.01 : 1;
      const nx = first ? 0 : last ? 1 : Math.max(lo, Math.min(hi, x));
      put(start.map((p, k) => (k === i ? [nx, y] : p)), `curve-${which}-drag`);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); void removed; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const add = (e: React.PointerEvent) => {
    const [x] = toCurve(e);
    const y = hue ? hueAt(pts, x) : toneAt(pts, x);
    const next = setCurvePoint(pts, x, y);
    put(next, `curve-${which}-add`);
  };
  const path = Array.from({ length: 65 }, (_, k) => { const x = k / 64; return `${cx(x).toFixed(1)},${cy(Math.max(0, Math.min(1, hue ? hueAt(pts, x) : toneAt(pts, x)))).toFixed(1)}`; }).join(' ');
  const used = !curvesNeutral(clip.curves);
  const t = sw('curves');
  return (
    <Section title="Curves" id="Color curves" badge={used ? (t.on ? 'On' : 'Off') : undefined} actions={used ? <button className="link" onClick={() => onClip({ curves: undefined }, 'curves-reset')}>Reset</button> : undefined}>
      <div className="chips curve-pick">
        {CURVE_NAMES.map(([k, n]) => <button key={k} className={`${which === k ? 'on' : ''}${curveNeutral(k, curves[k]) ? '' : ' changed'}`} onClick={() => setWhich(k)}>{n}</button>)}
      </div>
      <svg ref={svg} className={`grade-curve${t.on ? '' : ' is-off'}`} viewBox={`0 0 ${CW} ${CH}`} onPointerDown={add} role="img" aria-label={`${CURVE_NAMES.find(([k]) => k === which)![1]} curve`}>
        {hue && <defs><linearGradient id="hue-strip"><stop offset="0" stopColor="#f00" /><stop offset="0.17" stopColor="#ff0" /><stop offset="0.33" stopColor="#0f0" /><stop offset="0.5" stopColor="#0ff" /><stop offset="0.67" stopColor="#00f" /><stop offset="0.83" stopColor="#f0f" /><stop offset="1" stopColor="#f00" /></linearGradient></defs>}
        {hue && <rect x={M} y={CH - M - 6} width={CW - 2 * M} height={6} fill="url(#hue-strip)" opacity={0.8} />}
        {[0.25, 0.5, 0.75].map((v) => <g key={v} className="grid"><line x1={cx(v)} x2={cx(v)} y1={M} y2={CH - M} /><line x1={M} x2={CW - M} y1={cy(v)} y2={cy(v)} /></g>)}
        <line className="identity" x1={cx(0)} y1={cy(hue || which === 'lumSat' ? 0.5 : 0)} x2={cx(1)} y2={cy(hue || which === 'lumSat' ? 0.5 : 1)} />
        <polyline points={path} fill="none" stroke={CURVE_TINT[which]} strokeWidth={2} />
        {pts.map(([x, y], i) => <circle key={i} className="curve-point" cx={cx(x)} cy={cy(y)} r={5} onPointerDown={dragPoint(i)} onDoubleClick={(e) => { e.stopPropagation(); if (pts.length > (hue ? 1 : 2) && !(isToneCurve(which) && (i === 0 || i === pts.length - 1))) put(pts.filter((_, k) => k !== i), `curve-${which}-del`); }} />)}
      </svg>
      <div className="row-buttons">
        {!curveNeutral(which, pts) && <button onClick={() => put(NEUTRAL_CURVES[which], `curve-${which}-reset`)}>Reset this curve</button>}
        {isToneCurve(which) && <button title="A gentle S-curve: deeper shadows, brighter highlights" onClick={() => put([[0, 0], [0.25, 0.2], [0.75, 0.82], [1, 1]], 'curve-s')}>S-curve</button>}
      </div>
      {used && <label className="check"><input type="checkbox" checked={t.on} onChange={t.onToggle} /> Use the curves</label>}
      <p className="hint">{hue ? 'Click to add a point, drag it up or down to change that colour. Double-click a point (or drag it away) to remove it.' : which === 'lumSat' ? 'Up adds saturation at that brightness, down takes it away.' : 'Click to add a point and drag it. Double-click a point (or drag it away) to remove it.'}</p>
    </Section>
  );
}

// --- Qualifier ------------------------------------------------------------------------------------

export function QualifierSection({ clip, onClip }: GradingProps) {
  const q = clip.qualifier;
  const [matte, setMatte] = useState(gradeView.matteClip === clip.id);
  const set = (patch: Partial<Qualifier>, key: string) => onClip({ qualifier: { ...(q ?? DEFAULT_QUALIFIER), ...patch } }, key);
  const showMatte = (on: boolean) => { gradeView.matteClip = on ? clip.id : null; setMatte(on); };
  const hueBg = `linear-gradient(90deg, ${Array.from({ length: 7 }, (_, i) => `hsl(${i * 60} 85% 55%)`).join(', ')})`;
  return (
    <Section title="Qualifier" badge={q ? (q.off ? 'Off' : 'On') : undefined} actions={q ? <button className="link" onClick={() => { showMatte(false); onClip({ qualifier: undefined }, 'q-remove'); }}>Remove</button> : undefined}>
      {!q ? (
        <>
          <p className="hint">Changes only one range of colours, like making the sky bluer or the grass greener. Start from one:</p>
          <div className="chips">{QUALIFIER_PRESETS.map(([n, v]) => <button key={n} onClick={() => onClip({ qualifier: { ...DEFAULT_QUALIFIER, ...v } }, `q-${n}`)}>{n}</button>)}</div>
        </>
      ) : (
        <>
          <div className="chips">{QUALIFIER_PRESETS.map(([n, v]) => <button key={n} onClick={() => set(v, `q-${n}`)}>{n}</button>)}</div>
          <div className="hue-bar" style={{ background: hueBg }} aria-hidden>
            <span style={{ left: `${(q.hue / 360) * 100}%`, width: `${(Math.min(180, q.hueWidth) / 180) * 100}%` }} />
          </div>
          <Slider label="Hue" value={q.hue} min={0} max={360} step={1} reset={DEFAULT_QUALIFIER.hue} units={DEG} format={(v) => `${Math.round(v)}°`} onChange={(v) => set({ hue: v }, 'q-hue')} />
          <Slider label="Hue range" value={q.hueWidth} min={1} max={180} step={1} reset={DEFAULT_QUALIFIER.hueWidth} units={DEG} format={(v) => (v >= 180 ? 'All' : `±${Math.round(v)}°`)} onChange={(v) => set({ hueWidth: v }, 'q-hw')} />
          <Slider label="Least saturation" value={q.sat[0]} min={0} max={1} reset={DEFAULT_QUALIFIER.sat[0]} units={PCT} format={pct} onChange={(v) => set({ sat: [Math.min(v, q.sat[1]), q.sat[1]] }, 'q-s0')} />
          <Slider label="Most saturation" value={q.sat[1]} min={0} max={1} reset={1} units={PCT} format={pct} onChange={(v) => set({ sat: [q.sat[0], Math.max(v, q.sat[0])] }, 'q-s1')} />
          <Slider label="Darkest" value={q.lum[0]} min={0} max={1} reset={DEFAULT_QUALIFIER.lum[0]} units={PCT} format={pct} onChange={(v) => set({ lum: [Math.min(v, q.lum[1]), q.lum[1]] }, 'q-l0')} />
          <Slider label="Brightest" value={q.lum[1]} min={0} max={1} reset={1} units={PCT} format={pct} onChange={(v) => set({ lum: [q.lum[0], Math.max(v, q.lum[0])] }, 'q-l1')} />
          <Slider label="Soft edge" value={q.soft} min={0} max={1} reset={DEFAULT_QUALIFIER.soft} units={PCT} format={pct} onChange={(v) => set({ soft: v }, 'q-soft')} />
          <label className="check"><input type="checkbox" checked={q.invert} onChange={(e) => set({ invert: e.target.checked }, 'q-inv')} /> Change everything else instead</label>
          <label className="check" title="Shows what is picked in white, the rest in black (only here, never in the export)"><input type="checkbox" checked={matte} onChange={(e) => showMatte(e.target.checked)} /> Show what is picked</label>
          <h4 className="sub-head">Change</h4>
          <Slider label="Exposure" value={q.exposure} min={-3} max={3} reset={0} units={{ digits: 2 }} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`} onChange={(v) => set({ exposure: v }, 'q-exp')} />
          <Slider label="Saturation" value={q.saturation} min={-1} max={1} reset={0} units={PCT} format={signed} onChange={(v) => set({ saturation: v }, 'q-sat')} />
          <Slider label="Hue shift" value={q.hueShift} min={-180} max={180} step={1} reset={0} units={DEG} format={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}°`} onChange={(v) => set({ hueShift: v }, 'q-hs')} />
          <label className="check"><input type="checkbox" checked={!q.off} onChange={(e) => set({ off: e.target.checked ? undefined : true }, 'q-off')} /> Use the qualifier</label>
        </>
      )}
    </Section>
  );
}

// --- Noise reduction ------------------------------------------------------------------------------

export function NoiseSection({ clip, onClip, sw }: GradingProps) {
  const d: Denoise = clip.denoise ?? { spatial: 0, temporal: 0 };
  const set = (patch: Partial<Denoise>, key: string) => { const n = { ...d, ...patch }; onClip({ denoise: n.spatial > 0.001 || n.temporal > 0.001 ? n : undefined }, key); };
  const on = !!clip.denoise;
  const t = sw('denoise');
  return (
    <Section title="Noise reduction" badge={on ? (t.on ? 'On' : 'Off') : undefined}>
      <Slider label="In each frame" value={d.spatial} min={0} max={1} reset={0} units={PCT} format={pct} toggle={on ? t : undefined} hint="Smooths grain and colour speckle while keeping edges sharp" onChange={(v) => set({ spatial: v }, 'nr-s')} />
      <Slider label="Across frames" value={d.temporal} min={0} max={1} reset={0} units={PCT} format={pct} hint="Averages each pixel with the frames before it where nothing moved: the cleanest result for night and indoor shots" onChange={(v) => set({ temporal: v }, 'nr-t')} />
      <div className="chips">
        <button onClick={() => set({ spatial: 0.3, temporal: 0.3 }, 'nr-light')}>Light</button>
        <button onClick={() => set({ spatial: 0.5, temporal: 0.6 }, 'nr-medium')}>Medium</button>
        <button onClick={() => set({ spatial: 0.8, temporal: 0.9 }, 'nr-strong')}>Low light</button>
      </div>
      <p className="hint">Across frames shows while playing and in exports; a paused frame shows only the in-frame part.</p>
    </Section>
  );
}

// --- Film looks -----------------------------------------------------------------------------------

export function FilmSection({ clip, onClip, sw }: GradingProps) {
  const f = clip.film;
  const t = sw('film');
  const [saved, setSaved] = useState<string | null>(null);
  const saveCube = async () => {
    if (!f) return;
    const path = await ace.saveDialog('lut', `${f.look}.cube`).catch(() => null);
    if (!path) return;
    await ace.writeFile(path, filmCube(f.look));
    setSaved(path);
  };
  return (
    <Section title="Film looks" badge={f ? (t.on ? f.look : 'Off') : undefined} actions={f ? <button className="link" onClick={() => onClip({ film: undefined }, 'film-off')}>Remove</button> : undefined}>
      <div className="film-grid">
        {FILM_LOOKS.map(([name, hint]) => (
          <button key={name} className={`film-chip${f?.look === name ? ' on' : ''}`} title={hint} onClick={() => onClip({ film: { look: name, mix: f?.mix ?? 1 } }, `film-${name}`)}>
            <span className={`film-swatch film-${name.replace(/\W+/g, '-').toLowerCase()}`} aria-hidden />
            {name}
          </button>
        ))}
      </div>
      {f && <Slider label="Strength" value={f.mix} min={0} max={1} reset={1} units={PCT} format={pct} toggle={t} onChange={(v) => onClip({ film: { ...f, mix: v } }, 'film-mix')} />}
      {f && <div className="row-buttons"><button title="Use this look in other apps" onClick={() => void saveCube()}>Save as .cube…</button></div>}
      {saved && <p className="hint">Saved {saved.split(/[\\/]/).pop()}.</p>}
      <p className="hint">Our own film looks, applied over your grade and LUT.</p>
    </Section>
  );
}

