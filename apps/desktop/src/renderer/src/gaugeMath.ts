// Steady gauge readings. Everything here depends only on the time asked for, never on the
// previous frame, so preview, scrubbing and export draw exactly the same thing.

/** A reading at a media time (µs). */
export type Sampler = (t: number) => number;

/** Average of a reading over ±radius µs (bell-shaped weights): calms sensor noise. */
export function smoothAt(f: Sampler, t: number, radius: number, taps = 8): number {
  if (radius <= 0) return f(t);
  let sum = 0, wsum = 0;
  for (let i = -taps; i <= taps; i++) {
    const v = f(t + (radius * i) / taps);
    if (!Number.isFinite(v)) continue;
    const w = Math.cos((Math.PI / 2) * (i / (taps + 1))) ** 2;
    sum += v * w;
    wsum += w;
  }
  return wsum ? sum / wsum : NaN;
}

/** How often the number on a gauge changes. Faster only makes the last digit flicker. */
export const TEXT_STEP_US = 100_000;
/** The time a gauge's number shows: held for a tenth of a second. */
export const textTime = (t: number) => Math.floor(t / TEXT_STEP_US) * TEXT_STEP_US;

export interface GraphPoint { /** 0 (oldest) … 1 (now) across the graph. */ x: number; v: number }

/**
 * Points of a scrolling graph ending at `now`, spanning `span` µs. The points sit on a grid fixed
 * in time (not to the window), each the average of the reading over its own step, so as time
 * moves they only slide left: their heights never change and the line can't wobble. The last
 * point is exactly at `now`.
 */
export function scrollingGraph(f: Sampler, now: number, span: number, points: number, from = -Infinity): GraphPoint[] {
  const step = span / Math.max(4, points);
  const t0 = Math.max(from, now - span);
  const out: GraphPoint[] = [];
  const bin = (t: number) => {
    // Average over the step centred on t (4 taps): stable and keeps short peaks visible.
    let s = 0, n = 0;
    for (let k = 0; k < 4; k++) { const v = f(t + step * ((k + 0.5) / 4 - 0.5)); if (Number.isFinite(v)) { s += v; n++; } }
    return n ? s / n : NaN;
  };
  // Integer grid indices, so a grid time is computed identically in every frame.
  for (let i = Math.ceil(t0 / step); i * step < now; i++) { const t = i * step; out.push({ x: (t - (now - span)) / span, v: bin(t) }); }
  out.push({ x: 1, v: smoothAt(f, now, step / 2) });
  return out.filter((p) => Number.isFinite(p.v));
}

/** Feet where people think in feet (US, UK and Liberia's English), metres elsewhere. */
export const usesFeet = () => /^en-(US|GB|LR)$/i.test(globalThis.navigator?.language ?? '');
/** A jump length for lists and labels: “4.2 m” or “14 ft”. */
export const fmtJumpLength = (m: number, feet = usesFeet()) => (feet ? `${Math.round(m * 3.28084)} ft` : `${m.toFixed(1)} m`);
