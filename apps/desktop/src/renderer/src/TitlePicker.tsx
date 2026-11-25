// Motion title templates as a grid of small previews (each plays its movement while the pointer
// is over it), and the controls for text on a path.

import { useEffect, useRef, useState } from 'react';
import { newTitleOverlay, TEXT_PATHS, TITLE_CATEGORIES, TITLE_TEMPLATES, type Overlay, type TextPath, type TitleCategory } from '@ace/project';
import { drawTitle } from './motionTitles';
import { Seg, Slider } from './ui';

const TW = 132, TH = 74;
const SAMPLE: Record<string, string> = { '{gps}': '49.2827° N  123.1207° W', '{alt}': '1,234 m', '{date}': '14 JUN 2026', '{time}': '16:42:07', '{speed}': '42 km/h' };
const sample = (s: string) => s.replace(/\{(gps|alt|date|time|speed)\}/g, (m) => SAMPLE[m] ?? m);

function Thumb({ o, play }: { o: Overlay; play: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!, dpr = window.devicePixelRatio || 1;
    c.width = TW * dpr;
    c.height = TH * dpr;
    const x = c.getContext('2d')!;
    const shown = { ...o, text: sample(o.text), subtitle: sample(o.subtitle ?? '') };
    const draw = (T: number) => {
      // A dusk sky, so light and dark titles both show.
      const g = x.createLinearGradient(0, 0, 0, c.height);
      g.addColorStop(0, '#3a4a63'); g.addColorStop(0.65, '#6f6a6a'); g.addColorStop(1, '#2d3326');
      x.fillStyle = g;
      x.fillRect(0, 0, c.width, c.height);
      drawTitle(x, shown, c.width, c.height, T);
    };
    if (!play) { draw(o.title === 'end-credits' ? 2.2e6 : 1.8e6); return; }
    let raf = 0;
    const t0 = performance.now();
    const loop = () => { draw(((performance.now() - t0) * 1000) % (o.endUs - o.startUs)); raf = requestAnimationFrame(loop); };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [o, play]);
  return <canvas ref={ref} style={{ width: TW, height: TH }} />;
}

/** Template previews; picking one turns the text into that title (keeping words already typed). */
export function TitlePicker({ o, onPick }: { o: Overlay; onPick: (id: string | null) => void }) {
  const current = TITLE_TEMPLATES.find((t) => t.id === o.title);
  const [cat, setCat] = useState<TitleCategory>(current?.category ?? 'lower');
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div className="title-picker">
      <div className="curves-groups title-cats" role="group" aria-label="Kinds of title">
        {TITLE_CATEGORIES.map(([id, label]) => <button key={id} className={cat === id ? 'on' : ''} aria-pressed={cat === id} onClick={() => setCat(id)}>{label}</button>)}
      </div>
      <div className="look-grid" role="listbox" aria-label="Motion titles">
        {TITLE_TEMPLATES.filter((t) => t.category === cat).map((t) => {
          const on = o.title === t.id;
          const s = { ...newTitleOverlay(t.id, 0, 3_200_000), id: `title-${t.id}` };
          return (
            <button key={t.id} role="option" aria-selected={on} className={`look${on ? ' on' : ''}`} title={`${t.name}: point at it to see it move`} data-title={t.id}
              onPointerEnter={() => setHover(t.id)} onPointerLeave={() => setHover((h) => (h === t.id ? null : h))} onClick={() => onPick(t.id)}>
              <Thumb o={s} play={hover === t.id} />
              <span>{t.name}</span>
            </button>
          );
        })}
      </div>
      {o.title && <button className="link" onClick={() => onPick(null)}>Back to plain text</button>}
    </div>
  );
}

/** Straight, arc, wave, circle or a line drawn by hand. */
export function TextPathControls({ o, onPath }: { o: Overlay; onPath: (p: TextPath | undefined, key: string) => void }) {
  const kind = o.path?.kind ?? 'none';
  const pad = useRef<HTMLDivElement>(null);
  const [drawing, setDrawing] = useState<[number, number][] | null>(null);
  const pts = drawing ?? o.path?.points ?? [];
  const startDraw = (e: React.PointerEvent) => {
    e.preventDefault();
    const box = pad.current!.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }): [number, number] => [
      Math.max(-0.5, Math.min(0.5, (ev.clientX - box.left) / box.width - 0.5)),
      Math.max(-0.5, Math.min(0.5, (ev.clientY - box.top) / box.height - 0.5)),
    ];
    let line: [number, number][] = [at(e)];
    setDrawing(line);
    const move = (ev: PointerEvent) => {
      const q = at(ev), last = line[line.length - 1]!;
      if (Math.hypot(q[0] - last[0], (q[1] - last[1]) / 2) < 0.012) return;
      line = [...line, q];
      setDrawing(line);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrawing(null);
      if (line.length >= 2) onPath({ kind: 'freehand', bend: o.path?.bend ?? 0.5, points: line.length > 300 ? line.filter((_, i) => i % Math.ceil(line.length / 300) === 0) : line }, 'ov-path-draw');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <>
      <Seg value={kind} options={TEXT_PATHS} onChange={(k) => {
        if (k === 'none') onPath(undefined, 'ov-path');
        else if (k === 'freehand') onPath(o.path?.points ? { kind: k, bend: o.path.bend, points: o.path.points } : { kind: k, bend: 0.5, points: [[-0.5, 0.2], [-0.25, -0.2], [0, 0.1], [0.25, -0.25], [0.5, 0.15]] }, 'ov-path');
        else onPath({ kind: k, bend: o.path?.bend ?? (k === 'circle' ? 1 : 0.5) }, 'ov-path');
      }} />
      {(kind === 'arc' || kind === 'wave') && (
        <Slider label="Bend" value={o.path!.bend} min={-1} max={1} step={0.01} reset={0.5} onChange={(v) => onPath({ ...o.path!, bend: v }, 'ov-path-bend')} format={(v) => `${Math.round(v * 100)}%`} hint="How much the line curves; below 0 it curves the other way." />
      )}
      {kind === 'circle' && <Seg value={o.path!.bend < 0 ? 'in' : 'out'} options={[['out', 'Outside'], ['in', 'Inside']]} onChange={(v) => onPath({ ...o.path!, bend: v === 'in' ? -1 : 1 }, 'ov-path-in')} />}
      {kind === 'freehand' && (
        <>
          <div ref={pad} className="path-pad" onPointerDown={startDraw} aria-label="Draw the line the text follows">
            <svg viewBox="-0.5 -0.5 1 1" preserveAspectRatio="none">
              <polyline points={pts.map(([x, y]) => `${x},${y}`).join(' ')} vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
          <p className="hint">Draw the line the text runs along, from where it starts to where it ends.</p>
        </>
      )}
    </>
  );
}
