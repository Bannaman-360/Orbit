// The Scopes panel: waveform, RGB parade, vectorscope and histogram of the clip being graded,
// worked out on the GPU from the finished preview picture (see gradeView.ts).

import { useEffect, useRef, useState } from 'react';
import { ScopeRenderer, SCOPE_KINDS, type ScopeKind } from '@ace/media360';
import { gradeView } from './gradeView';
import { Seg } from './ui';

const KIND_KEY = 'ace.scope.kind';

/** Where the colour bars' 75% targets sit on the vectorscope (fractions of its square). */
function target(r: number, g: number, b: number): [number, number] {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [0.5 + (b - y) / 1.8556, 0.5 - (r - y) / 1.5748];
}
const TARGETS: [string, [number, number]][] = [
  ['R', target(0.75, 0, 0)], ['Y', target(0.75, 0.75, 0)], ['G', target(0, 0.75, 0)],
  ['C', target(0, 0.75, 0.75)], ['B', target(0, 0, 0.75)], ['M', target(0.75, 0, 0.75)],
];
/** Skin of every colour lies close to this line (about 123° on a vectorscope). */
const SKIN = target(0.8, 0.55, 0.42);

function Graticule({ kind }: { kind: ScopeKind }) {
  if (kind === 'vector') {
    const [sx, sy] = SKIN, len = 0.5 / Math.hypot(sx - 0.5, sy - 0.5);
    return (
      <svg className="scope-grid" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden>
        <circle cx="50" cy="50" r="45" />
        <circle cx="50" cy="50" r="22.5" />
        <line x1="50" y1="2" x2="50" y2="98" />
        <line x1="2" y1="50" x2="98" y2="50" />
        <line className="skin" x1="50" y1="50" x2={50 + (sx - 0.5) * len * 100} y2={50 + (sy - 0.5) * len * 100} />
        {TARGETS.map(([n, [x, y]]) => (
          <g key={n}>
            <rect x={x * 100 - 2.5} y={y * 100 - 2.5} width="5" height="5" />
            <text x={x * 100 + 3.5} y={y * 100 + 1.5}>{n}</text>
          </g>
        ))}
      </svg>
    );
  }
  if (kind === 'histogram') return null;
  return (
    <svg className="scope-grid" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      {[0, 25, 50, 75, 100].map((v) => <line key={v} x1="0" x2="100" y1={100 - v} y2={100 - v} />)}
    </svg>
  );
}

export function ScopesPanel({ clipId }: { clipId: string | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [kind, setKind] = useState<ScopeKind>(() => (SCOPE_KINDS.some(([k]) => k === localStorage.getItem(KIND_KEY)) ? localStorage.getItem(KIND_KEY) as ScopeKind : 'waveform'));
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const [seen, setSeen] = useState(false);
  const scope = useRef<ScopeRenderer | null>(null);

  useEffect(() => { gradeView.clipId = clipId; }, [clipId]);

  useEffect(() => {
    let gone = false;
    const c = canvas.current!;
    void ScopeRenderer.create(c).then((s) => {
      if (gone) { s.destroy(); return; }
      scope.current = s;
      gradeView.scopes = {
        analyse: (tex, enc) => s.analyse(tex, enc),
        drawn: () => { s.draw(kindRef.current); if (s.analysed === 1) setSeen(true); },
      };
    });
    // Drawn at the panel's own pixel size.
    const ro = new ResizeObserver(() => {
      const r = box.current!.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio);
      c.width = Math.max(64, Math.round(r.width * dpr));
      c.height = Math.max(64, Math.round(r.height * dpr));
      if (scope.current?.analysed) scope.current.draw(kindRef.current);
    });
    ro.observe(box.current!);
    return () => {
      gone = true;
      ro.disconnect();
      gradeView.scopes = null;
      scope.current?.destroy();
      scope.current = null;
    };
  }, []);

  const pick = (k: ScopeKind) => {
    setKind(k);
    localStorage.setItem(KIND_KEY, k);
    kindRef.current = k;
    if (scope.current?.analysed) scope.current.draw(k);
  };

  return (
    <aside className="inspector scopes-panel">
      <div className="scopes-bar">
        <Seg value={kind} options={SCOPE_KINDS.map(([k, n]) => [k, n] as [ScopeKind, string])} onChange={pick} />
      </div>
      <div ref={box} className="scope-box">
        <canvas ref={canvas} className="scope-canvas" />
        <Graticule kind={kind} />
        {!seen && <p className="scope-empty">Add a clip to the timeline to see its scopes.</p>}
      </div>
      <p className="hint scope-hint">
        {kind === 'waveform' ? 'Brightness across the picture, left to right: bottom is black, top is white.'
          : kind === 'parade' ? 'Red, green and blue side by side: where they line up, whites and greys are neutral.'
          : kind === 'vector' ? 'Colour: further out is more saturated. Skin of every colour sits near the line.'
          : 'How many pixels have each brightness, for red, green, blue and overall.'}
      </p>
    </aside>
  );
}
