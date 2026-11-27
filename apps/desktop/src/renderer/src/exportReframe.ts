// Exporting in another frame shape than the edit (a 16:9 edit as a 9:16 Reel, say): each clip is
// reframed for the new shape on the way out, so it looks framed for it rather than squeezed in.
// - 360 clips and clips reframed through their lens keep where they look and their zoom: the view
//   keeps its corner-to-corner angle, so the width that was across a wide frame now runs down a
//   tall one (instead of the whole width being forced into the narrow frame).
// - Regular clips that showed their whole width fill the narrower frame and pan to follow the
//   action (smart reframe), unless they had already been framed with room to pan.
// The edit itself is left as it is.

import { fovForAspect } from '@ace/media360';
import { framingAspect, isIdentityXf, type Look, type Timeline, type TimelineClip } from '@ace/project';
import { canReframe } from './frameRender';
import { getMedia, type Media } from './media';
import { smartReframe } from './smartReframe';

/** A clip that covers the whole frame (not shrunk, moved or turned as picture in picture). */
const fullFrame = (c: TimelineClip) => isIdentityXf(c.look.xf) && c.keyframes.every((k) => isIdentityXf(k.look.xf));

/** The same view in a frame of `to` instead of `from` (width ÷ height). */
const adaptLook = (l: Look, from: number, to: number): Look => ({ ...l, fov: fovForAspect(l, from, to) });

export type ExportReframeKind = 'view' | 'follow' | 'none';

/** What the export does to a clip for the new shape (no analysis yet). */
export function exportReframeKind(c: TimelineClip, m: Media, from: number, to: number): ExportReframeKind {
  if (Math.abs(Math.log(from / to)) < 0.01 || c.mediaPath.startsWith('seq:') || !fullFrame(c)) return 'none';
  if (m.is360 || (c.lensMode && canReframe(m))) return 'view';
  const pic = m.width / m.height;
  // Narrower than the picture, which used to fit across: there's now picture to pan over.
  return to < pic * 0.99 && from >= pic * 0.99 ? 'follow' : 'none';
}

/** Reframes the edit's clips for `framing`. Returns the edit for the export (the edit itself is untouched). */
export async function reframeForExport(tl: Timeline, framing: string, onProgress: (stage: string) => void, signal: AbortSignal): Promise<Timeline> {
  const from = framingAspect(tl.framing), to = framingAspect(framing);
  const all = [...tl.clips, ...tl.connected];
  const kinds = new Map<string, { kind: ExportReframeKind; m: Media }>();
  for (const c of all) {
    if (c.mediaPath.startsWith('seq:')) continue;
    const m = await getMedia(c.mediaPath);
    kinds.set(c.id, { kind: exportReframeKind(c, m, from, to), m });
  }
  const follow = all.filter((c) => kinds.get(c.id)?.kind === 'follow');
  const patches = new Map<string, Partial<TimelineClip>>();
  for (const [i, c] of follow.entries()) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const tag = follow.length > 1 ? `clip ${i + 1} of ${follow.length}, ` : '';
    try {
      const r = await smartReframe(c, kinds.get(c.id)!.m, to, (f) => onProgress(`Reframing for ${framing} (${tag}${Math.round(f * 100)}%)`), signal);
      patches.set(c.id, r.patch);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      // Too short or unreadable for the analysis: it still fills the frame, from the middle.
      patches.set(c.id, { fit: 'fill' });
    }
  }
  const pic = (m: Media) => m.width / m.height;
  const apply = <C extends TimelineClip>(c: C): C => {
    const k = kinds.get(c.id);
    if (!k || k.kind === 'none') return c;
    if (k.kind === 'follow') return { ...c, ...patches.get(c.id) };
    return {
      ...c,
      // Clips seen through their lens fill the narrower frame rather than sit between bars.
      ...(!k.m.is360 && c.fit !== 'fill' && to < pic(k.m) * 0.99 ? { fit: 'fill' as const } : {}),
      look: adaptLook(c.look, from, to),
      keyframes: c.keyframes.map((kf) => ({ ...kf, look: adaptLook(kf.look, from, to) })),
    };
  };
  return { ...tl, framing, clips: tl.clips.map(apply), connected: tl.connected.map(apply) };
}
