// Transition picker tiles: each shows its transition between two sample pictures, animated while
// the pointer is over it. Drawn by the export's own compositing, so the tile moves like the edit.

import { useEffect, useRef } from 'react';
import { transitionLook, type TransitionKind } from '@ace/project';
import { compositeLayers, type CompLayer } from './overlayRender';

const TW = 160, TH = 90;
let samples: [OffscreenCanvas, OffscreenCanvas] | null = null;

/** The two sample pictures ("A" going out, "B" coming in), in the theme's colours. */
function sampleFrames(): [OffscreenCanvas, OffscreenCanvas] {
  if (samples) return samples;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#0a84ff';
  const draw = (label: string, from: string, to: string) => {
    const c = new OffscreenCanvas(TW, TH), x = c.getContext('2d')!;
    const g = x.createLinearGradient(0, 0, TW, TH);
    g.addColorStop(0, from);
    g.addColorStop(1, to);
    x.fillStyle = g;
    x.fillRect(0, 0, TW, TH);
    // A horizon and a sun, so movement reads.
    x.fillStyle = 'rgba(0,0,0,0.25)';
    x.beginPath(); x.moveTo(0, TH * 0.72); x.quadraticCurveTo(TW * 0.4, TH * 0.55, TW, TH * 0.7); x.lineTo(TW, TH); x.lineTo(0, TH); x.fill();
    x.fillStyle = 'rgba(255,255,255,0.85)';
    x.font = `700 ${TH * 0.42}px -apple-system, system-ui, sans-serif`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(label, TW / 2, TH / 2);
    return c;
  };
  samples = [draw('A', '#f29d38', '#b8402a'), draw('B', accent, '#1d2b6b')];
  return samples;
}

function paint(c: HTMLCanvasElement, kind: TransitionKind, p: number) {
  const ctx = c.getContext('2d')!;
  const [a, b] = sampleFrames();
  const layers: CompLayer[] = [{ src: a, role: 'out', track: 0 }, { src: b, role: 'in', track: 0 }];
  compositeLayers(ctx, TW, TH, layers, transitionLook(kind, p));
}

export function TransitionTile({ kind, label, on, onPick }: { kind: TransitionKind; label: string; on: boolean; onPick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const raf = useRef(0);
  useEffect(() => { paint(ref.current!, kind, 0.45); return () => cancelAnimationFrame(raf.current); }, [kind]);
  const play = () => {
    const t0 = performance.now();
    const step = (now: number) => {
      // 1.2 s of transition, then a short hold on each picture.
      const u = ((now - t0) / 1800) % 1;
      paint(ref.current!, kind, Math.max(0, Math.min(1, (u - 0.17) / 0.66)));
      raf.current = requestAnimationFrame(step);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(step);
  };
  const stop = () => { cancelAnimationFrame(raf.current); paint(ref.current!, kind, 0.45); };
  return (
    <button className={`tr-tile${on ? ' on' : ''}`} onClick={onPick} onPointerEnter={play} onPointerLeave={stop} onFocus={play} onBlur={stop} title={label} aria-pressed={on}>
      <canvas ref={ref} width={TW} height={TH} aria-hidden />
      <span>{label}</span>
    </button>
  );
}
