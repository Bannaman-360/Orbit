// A grid of every look a gauge can take, each drawn live as a small preview.

import { useEffect, useRef } from 'react';
import { gaugeLooks, lookPatch, newGaugeOverlay, type GaugeDesign, type GaugeKind, type GaugeStyle, type Overlay } from '@ace/project';
import { drawGaugePreview, overlayBox } from './overlayRender';

const TW = 132, TH = 78;

function Thumb({ o }: { o: Overlay }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!, dpr = window.devicePixelRatio || 1;
    c.width = TW * dpr;
    c.height = TH * dpr;
    const x = c.getContext('2d')!;
    x.clearRect(0, 0, c.width, c.height);
    // Fit the gauge in the tile.
    const b = overlayBox({ ...o, x: 0.5, y: 0.5, size: 1 }, 1, 1);
    const size = Math.min((TH * 0.86) / b.h, (TW * 0.9) / b.w) / TH;
    drawGaugePreview(x, { ...o, size, x: 0.5, y: 0.5, animation: 'none' }, c.width, c.height);
  }, [o]);
  return <canvas ref={ref} style={{ width: TW, height: TH }} />;
}

/** Looks for this gauge; the current one is marked. Colours shown are each design's own. */
export function GaugeLookPicker({ o, onPick }: { o: Overlay; onPick: (design: GaugeDesign, style: GaugeStyle) => void }) {
  const kind = o.kind as GaugeKind;
  const looks = gaugeLooks(kind);
  const current = o.design ?? 'classic';
  return (
    <div className="look-grid" role="listbox" aria-label="Gauge looks">
      {looks.map((l) => {
        const on = l.design === current && l.style === o.style;
        const sample = { ...newGaugeOverlay(kind, 0, 1), id: `look-${l.design}-${l.style}`, units: o.units, airShow: o.airShow, ...lookPatch(l.design, l.style), ...(on ? { color: o.color, accent: o.accent, bgColor: o.bgColor, bgOpacity: o.bgOpacity, font: o.font, background: o.background } : {}) };
        return (
          <button key={`${l.design}-${l.style}`} role="option" aria-selected={on} className={`look${on ? ' on' : ''}`} title={l.name} onClick={() => onPick(l.design, l.style)}>
            <Thumb o={sample} />
            <span>{l.name}</span>
          </button>
        );
      })}
    </div>
  );
}
