// "Lens match": corrections for each lens of a 360 camera, by hand or worked out.

import { useEffect } from 'react';
import { lensAdjusted, NO_LENS_ADJUST, type LensAdjust } from '@ace/media360';
import type { InspectorProps } from './Inspector';
import { hasTwoLenses, setLensUi, useLensUi } from './lensMatching';
import { Lock, Section, Seg, Slider, type Units } from './ui';

const PCT: Units = { to: (v) => v * 100, from: (n) => n / 100, digits: 0 };
const signed = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

const ROWS: [keyof LensAdjust, string, number, number, string, (v: number) => string, Units?][] = [
  ['brightness', 'Brightness', -2, 2, 'Makes this lens’s half lighter or darker.', (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`, { digits: 2 }],
  ['haze', 'Remove haze', -1, 1, 'Takes away the pale veil of a fogged or dirty lens. Below zero adds one, to match the other lens.', signed, PCT],
  ['contrast', 'Contrast', -1, 1, 'Light against dark on this half.', signed, PCT],
  ['saturation', 'Saturation', -1, 1, 'Strength of the colors on this half.', signed, PCT],
  ['warmth', 'Warmth', -1, 1, 'Cooler or warmer on this half.', signed, PCT],
  ['tint', 'Tint', -1, 1, 'Greener or more magenta on this half.', signed, PCT],
  ['clarity', 'Clarity', 0, 1, 'Brings back shapes a smeared lens has softened.', pct, PCT],
  ['sharpness', 'Sharpness', 0, 2, 'Brings back fine detail. Can’t undo heavy blur.', pct, PCT],
];

export function LensMatchSection(p: InspectorProps) {
  const { lens, highlight } = useLensUi();
  useEffect(() => () => setLensUi({ highlight: false }), []);
  const clip = p.clip!, pair = clip.lenses ?? {}, a = (pair[lens] ?? {}) as Partial<LensAdjust>;
  const two = hasTwoLenses(p.media);
  const locked = two ? false : p.media?.layout?.equirect ? 'This 360 video was stitched before you downloaded it, so the two lenses can’t be told apart any more.' : 'This is for 360 clips with two lenses.';
  const set = (patch: Partial<LensAdjust>, key: string) => {
    const next = { ...a, ...patch };
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== 0)) as Record<string, number>;
    const both = { ...pair, [lens]: Object.keys(clean).length ? clean : undefined };
    p.onClip({ lenses: both.front || both.back ? both : undefined }, key);
  };
  const on = [lensAdjusted(pair.front) && 'Front', lensAdjusted(pair.back) && 'Back'].filter(Boolean).join(' + ');
  return (
    <Section title="Lens match" badge={on || undefined} actions={on ? <button className="link" onClick={() => p.onClip({ lenses: undefined }, 'lens-reset')}>Reset</button> : undefined}>
      <div className="field-row">
        <span>Lens {locked && <Lock reason={locked} />}</span>
        <Seg value={lens} options={[['front', pair.front && lensAdjusted(pair.front) ? 'Front •' : 'Front'], ['back', pair.back && lensAdjusted(pair.back) ? 'Back •' : 'Back']]} disabled={!!locked} onChange={(v) => setLensUi({ lens: v })} />
      </div>
      <label className="check"><input type="checkbox" checked={highlight && !locked} disabled={!!locked} onChange={(e) => setLensUi({ highlight: e.target.checked })} /> Show this lens in blue</label>
      <div className="row-buttons">
        <button disabled={!!locked || p.lensBusy} title="Compares the strip both lenses see and corrects the poorer one" onClick={() => p.onMatchLenses()}>{p.lensBusy ? 'Matching…' : 'Match automatically'}</button>
        <button disabled={!!locked || p.lensBusy} title={`Makes the ${lens} lens look like the other one`} onClick={() => p.onMatchLenses(lens)}>Match the {lens} lens</button>
      </div>
      {ROWS.map(([k, name, min, max, hint, format, units]) => (
        <Slider key={k} label={name} value={a[k] ?? NO_LENS_ADJUST[k]} min={min} max={max} step={0.01} reset={0} format={format} units={units} hint={`${hint} Double-click to reset.`} disabled={!!locked} onChange={(v) => set({ [k]: Math.round(v * 100) / 100 }, `lens-${lens}-${k}`)} />
      ))}
      {on && p.clipCount > 1 && <div className="row-buttons"><button title="Gives every 360 clip these corrections" onClick={p.onLensesToAll}>Use on all 360 clips</button></div>}
      <p className="hint">For a lens that is dirtier, foggier or a different color than the other. The change blends in where the lenses meet. A smudge on one spot of the glass can’t be removed.</p>
    </Section>
  );
}
