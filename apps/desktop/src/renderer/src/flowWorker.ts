// Works out how the camera turned from one frame to the next, away from the window (see flowStab.ts).
import { frameTurn, pyramid, type Gray } from '@ace/media360/src/flow';
import { pictureToDir, type SourceLens } from '@ace/media360/src/sourceLens';

type Msg =
  | { kind: 'start'; lens: SourceLens; w: number; h: number }
  | { kind: 'frame'; id: number; gray: Float32Array };

let lens: SourceLens | null = null;
let W = 0, H = 0;
let prev: Gray[] | null = null;

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.kind === 'start') { lens = m.lens; W = m.w; H = m.h; prev = null; return; }
  const pyr = pyramid({ w: W, h: H, d: m.gray }, 3);
  // Pixel → direction through the clip's lens (picture x right, y up, −1…1).
  const ray = (x: number, y: number) => pictureToDir(lens!, ((x + 0.5) / W) * 2 - 1, 1 - ((y + 0.5) / H) * 2);
  const r = prev ? frameTurn(prev, pyr, ray, { tolerance: 0.004 * (480 / W) }) : null;
  prev = pyr;
  (self as unknown as Worker).postMessage({ id: m.id, q: r?.q ?? null, inliers: r?.inliers ?? 0, tracked: r?.tracked ?? 0 });
};
