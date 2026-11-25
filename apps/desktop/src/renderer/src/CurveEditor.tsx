// The Curves section: how the picture moves between two keyframes. Shows the curve of the move
// the playhead is in, with named curves to pick and two handles to drag (any drag makes it a
// custom curve). Each group of values (framing, position and size, colour, effects) can have a
// curve of its own.

import { useRef, useState } from 'react';
import { CURVES, KEY_GROUPS, curveHandles, curveOf, curvePoints, evalCurve, type Bezier, type Curve, type KeyGroup, type Keyframe } from '@ace/project';
import { fmtTime } from './ui';

const W = 232, H = 170, PAD_X = 14, PAD_Y = 50;
/** Curve space (x 0–1, y about −0.7…1.7 visible, room for overshoot handles) to SVG pixels and back. */
const px = (x: number) => PAD_X + x * (W - 2 * PAD_X);
const py = (y: number) => H - PAD_Y - y * (H - 2 * PAD_Y);
const fromPx = (X: number, Y: number): [number, number] => [(X - PAD_X) / (W - 2 * PAD_X), (H - PAD_Y - Y) / (H - 2 * PAD_Y)];

export interface CurveEditorProps {
  keyframes: Keyframe[];
  /** Media time of the playhead. */
  mediaUs: number;
  /** Timeline time of a media time (for labels). */
  toTimeline: (mediaUs: number) => number;
  /** Sets the curve leaving keyframe `id` (null: the group follows the keyframe's curve again). */
  onCurve: (id: string, curve: Curve | null, group?: KeyGroup) => void;
}

/** The keyframe whose move the playhead is in (a keyframe at the playhead counts as its own move). */
export function segmentAt(keys: Keyframe[], t: number, snapUs = 20_000): { a: Keyframe; b: Keyframe } | null {
  const k = [...keys].sort((x, y) => x.t - y.t);
  for (let i = 0; i + 1 < k.length; i++) if (t >= k[i]!.t - snapUs && (t < k[i + 1]!.t - snapUs || i + 2 === k.length)) return { a: k[i]!, b: k[i + 1]! };
  return null;
}

export function CurveEditor({ keyframes, mediaUs, toTimeline, onCurve }: CurveEditorProps) {
  const [group, setGroup] = useState<KeyGroup | 'all'>('all');
  const svg = useRef<SVGSVGElement>(null);
  const seg = segmentAt(keyframes, mediaUs);
  if (keyframes.length < 2 || !seg) {
    return <p className="hint">{keyframes.length < 2 ? 'Add two keyframes to shape how the picture moves between them.' : 'Put the playhead between two keyframes to shape that move.'}</p>;
  }
  const g = group === 'all' ? undefined : group;
  const own = g ? seg.a.curves?.[g] : undefined;
  const curve = curveOf(seg.a, g);
  const handles: Bezier | null = curve.easing === 'custom' ? curve.bezier ?? null : curveHandles(curve.easing);
  const set = (c: Curve | null) => onCurve(seg.a.id, c, g);
  const f = Math.max(0, Math.min(1, (mediaUs - seg.a.t) / (seg.b.t - seg.a.t)));
  const pts = curvePoints(curve).map(([x, y]) => `${px(x).toFixed(1)},${py(y).toFixed(1)}`).join(' ');

  const drag = (which: 0 | 1) => (e: React.PointerEvent) => {
    if (!handles) return;
    e.preventDefault();
    e.stopPropagation();
    const box = svg.current!.getBoundingClientRect();
    const start: Bezier = [...handles];
    const move = (ev: PointerEvent) => {
      const [x, y] = fromPx(((ev.clientX - box.left) / box.width) * W, ((ev.clientY - box.top) / box.height) * H);
      const b: Bezier = [...start];
      const cx = Math.max(0, Math.min(1, x)), cy = Math.max(-1, Math.min(2, y));
      if (which === 0) { b[0] = cx; b[1] = cy; } else { b[2] = cx; b[3] = cy; }
      // Shift keeps the handle level, like most curve editors.
      if (ev.shiftKey) { if (which === 0) b[1] = 0; else b[3] = 1; }
      set({ easing: 'custom', bezier: b.map((v) => Math.round(v * 1000) / 1000) as Bezier });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="curves">
      <div className="curves-groups" role="group" aria-label="Values the curve moves">
        <button className={group === 'all' ? 'on' : ''} aria-pressed={group === 'all'} onClick={() => setGroup('all')}>All</button>
        {KEY_GROUPS.map(([id, label]) => (
          <button key={id} className={`${group === id ? 'on' : ''}${seg.a.curves?.[id] ? ' own' : ''}`} aria-pressed={group === id} title={seg.a.curves?.[id] ? `${label} has a curve of its own` : `${label} follows the keyframe's curve`} onClick={() => setGroup(id)}>{label}</button>
        ))}
      </div>
      <svg ref={svg} className="curve-graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Curve: ${CURVES.find(([n]) => n === curve.easing)?.[1] ?? 'Custom'}`}>
        <rect x={px(0)} y={py(1)} width={px(1) - px(0)} height={py(0) - py(1)} className="curve-box" />
        <line x1={px(0)} y1={py(0)} x2={px(1)} y2={py(1)} className="curve-diag" />
        <line x1={px(f)} y1={py(1.3)} x2={px(f)} y2={py(-0.3)} className="curve-playhead" />
        {handles && (
          <>
            <line x1={px(0)} y1={py(0)} x2={px(handles[0])} y2={py(handles[1])} className="curve-arm" />
            <line x1={px(1)} y1={py(1)} x2={px(handles[2])} y2={py(handles[3])} className="curve-arm" />
          </>
        )}
        <polyline points={pts} className="curve-line" />
        <circle cx={px(f)} cy={py(curve.easing === 'hold' ? 0 : evalCurve(curve, f))} r={3.5} className="curve-now" />
        <circle cx={px(0)} cy={py(0)} r={4} className="curve-key" />
        <circle cx={px(1)} cy={py(1)} r={4} className="curve-key" />
        {handles && (
          <>
            <circle cx={px(handles[0])} cy={py(handles[1])} r={6} className="curve-handle" onPointerDown={drag(0)} data-handle="1"><title>Drag to shape how the move starts (Shift keeps it level)</title></circle>
            <circle cx={px(handles[2])} cy={py(handles[3])} r={6} className="curve-handle" onPointerDown={drag(1)} data-handle="2"><title>Drag to shape how the move ends (Shift keeps it level)</title></circle>
          </>
        )}
        <text x={px(0)} y={H - 8} className="curve-label">◆ {fmtTime(toTimeline(seg.a.t))}</text>
        <text x={px(1)} y={H - 8} textAnchor="end" className="curve-label">◆ {fmtTime(toTimeline(seg.b.t))}</text>
      </svg>
      <div className="curves-presets">
        {CURVES.map(([id, label]) => (
          <button key={id} className={curve.easing === id ? 'on' : ''} aria-pressed={curve.easing === id} title={label} onClick={() => set({ easing: id })}>
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <polyline points={curvePoints({ easing: id }, 16).map(([x, y]) => `${(3 + x * 18).toFixed(1)},${(19 - y * 14).toFixed(1)}`).join(' ')} />
            </svg>
            <span>{label}</span>
          </button>
        ))}
      </div>
      <p className="hint">
        {curve.easing === 'custom' ? 'Custom curve. ' : ''}
        {g ? (own ? 'Only these values use this curve. ' : 'These values follow the keyframe’s curve until you pick one. ') : 'Every value follows this curve unless its group has its own. '}
        {handles ? 'Drag the handles to shape it.' : ''}
      </p>
      {g && own && <button className="link" onClick={() => set(null)}>Follow the keyframe’s curve again</button>}
    </div>
  );
}
