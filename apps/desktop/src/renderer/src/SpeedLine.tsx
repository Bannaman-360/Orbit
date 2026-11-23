// The speed line drawn over a clip on the timeline: up is faster. Drag the line (or a point) up
// and down for speed, points left and right for when; double-click the line for a new point.

import { useRef, useState } from 'react';
import { hasRamp, localAt, MAX_SPEED, mediaAt, MIN_SPEED, playLength, speedAt, type TimelineClip } from '@ace/project';
import { useDrag } from './ui';

const TOP = 0.2, BOTTOM = 0.1;
const RANGE = Math.log(MAX_SPEED / MIN_SPEED);
const yOf = (speed: number, h: number) => h * (TOP + (1 - TOP - BOTTOM) * (1 - Math.log(speed / MIN_SPEED) / RANGE));
export const fmtSpeed = (s: number) => `${s >= 1 ? +s.toFixed(1) : +s.toFixed(s < 0.2 ? 3 : 2)}×`;

export interface SpeedLineProps {
  clip: TimelineClip;
  /** Pixels a second, and the clip's size. */
  pps: number;
  width: number;
  height: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
  onPoint: (id: string, t: number, speed: number) => void;
  onAdd: (t: number) => void;
  /** A clip without points: its one speed. */
  onSpeed: (speed: number) => void;
  onGrab: () => void;
  onEnd: () => void;
  /** Lines a point's place in the clip (µs from its start) up with beats and markers. */
  snapLocal?: (localUs: number, e: PointerEvent) => number;
}

export function SpeedLine(p: SpeedLineProps) {
  const { clip: c, pps, width, height: h } = p;
  const L = playLength(c), usPerPx = 1e6 / pps;
  const orig = useRef(c);
  const grabbed = useRef({ id: '', speed: 1 });
  const [label, setLabel] = useState<{ x: number; y: number; text: string } | null>(null);

  /** A dragged height → speed; sticks to normal speed for a moment. */
  const drag = (start: number, dy: number, fine: boolean) => {
    const s = Math.max(MIN_SPEED, Math.min(MAX_SPEED, start * Math.exp((-dy / (h * (1 - TOP - BOTTOM))) * RANGE * (fine ? 0.2 : 1))));
    return Math.abs(Math.log(s)) < 0.09 && !fine ? 1 : +s.toFixed(3);
  };
  const movePoint = useDrag((dx, dy, e) => {
    const g = grabbed.current, k = orig.current.speedKeys!.find((x) => x.id === g.id)!;
    const local = localAt(orig.current, k.t) + dx * usPerPx;
    const t = Math.abs(dx) < 3 ? k.t : mediaAt(orig.current, p.snapLocal ? p.snapLocal(local, e) : local);
    const s = drag(g.speed, dy, e.shiftKey);
    p.onPoint(g.id, t, s);
    setLabel((l) => l && { ...l, text: fmtSpeed(s) });
  }, () => { setLabel(null); p.onEnd(); });
  const moveLine = useDrag((_dx, dy, e) => {
    const s = drag(grabbed.current.speed, dy, e.shiftKey);
    p.onSpeed(s);
    setLabel((l) => l && { ...l, text: fmtSpeed(s) });
  }, () => { setLabel(null); p.onEnd(); });

  const ramp = hasRamp(c);
  const pts: string[] = [];
  if (!ramp) { const y = yOf(c.speed, h).toFixed(1); pts.push(`0,${y}`, `${width},${y}`); } else {
    const n = Math.max(2, Math.min(600, Math.round(width / 3)));
    const at = new Set<number>(Array.from({ length: n + 1 }, (_, i) => (L * i) / n));
    for (const k of c.speedKeys!) { const l = localAt(c, k.t); if (l > 0 && l < L) { at.add(l); at.add(l - 1); } }
    for (const T of [...at].sort((a, b) => a - b)) pts.push(`${((T / 1e6) * pps).toFixed(1)},${yOf(speedAt(c, mediaAt(c, T)), h).toFixed(1)}`);
  }
  const one = yOf(1, h);
  return (
    <div className="speed-line">
      <svg width={width} height={h}>
        <line x1={0} x2={width} y1={one} y2={one} className="speed-one" />
        <polyline points={pts.join(' ')} className="speed-curve" />
        <polyline
          points={pts.join(' ')}
          className={`speed-grab${ramp ? ' ramp' : ''}`}
          onPointerDown={(e) => {
            if (e.button !== 0 || e.ctrlKey) return;
            p.onGrab();
            if (ramp) { e.stopPropagation(); return; }
            grabbed.current = { id: '', speed: c.speed };
            const r = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
            setLabel({ x: e.clientX - r.left, y: yOf(c.speed, h), text: fmtSpeed(c.speed) });
            moveLine(e);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
            p.onAdd(mediaAt(c, Math.max(0, Math.min(L, (e.clientX - r.left) * usPerPx))));
          }}
        >
          <title>{ramp ? 'Double-click to add a point' : `${fmtSpeed(c.speed)} — drag up or down to change the speed, double-click to add a point`}</title>
        </polyline>
      </svg>
      {c.speedKeys?.filter((k) => k.t >= c.inUs - 1 && k.t <= c.outUs + 1).map((k) => {
        const x = (localAt(c, k.t) / 1e6) * pps, y = yOf(k.speed, h);
        return (
          <button
            key={k.id}
            className={`speed-point${p.selected === k.id ? ' selected' : ''}`}
            style={{ left: Math.max(6, Math.min(width - 10, x)), top: y }}
            title={`${fmtSpeed(k.speed)} — drag to change, Shift for fine steps, ⌫ or right-click to delete`}
            aria-label={`Speed point ${fmtSpeed(k.speed)}`}
            onPointerDown={(e) => {
              if (e.button !== 0 || e.ctrlKey) return;
              orig.current = c;
              grabbed.current = { id: k.id, speed: k.speed };
              p.onSelect(k.id);
              setLabel({ x, y, text: fmtSpeed(k.speed) });
              movePoint(e);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); p.onMenu(k.id, e.clientX, e.clientY); }}
          />
        );
      })}
      {label && <span className="speed-label" style={{ left: Math.max(22, Math.min(width - 22, label.x)), top: label.y > 26 ? label.y - 22 : label.y + 10 }}>{label.text}</span>}
    </div>
  );
}
