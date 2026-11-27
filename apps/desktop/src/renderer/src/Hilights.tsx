// HiLight tags: the moments the rider marked by pressing the camera's HiLight button (or saying
// "GoPro, HiLight") while recording. Read from the file when it opens (media.ts, `hilightTags`);
// shown on the timeline, listed in Clip ▸ HiLight tags, and turned into markers there.

import { localAt, mediaToTimeline, type TimelineClip } from '@ace/project';
import type { Media } from './media';
import { fmtTime, Section } from './ui';

/** The tags inside a clip's in and out points (media µs). */
export const clipTags = (clip: TimelineClip, media: Media) => media.hilights.filter((t) => t >= clip.inUs && t < clip.outUs);

export function HilightSection({ clip, media, clipStartUs, onSeekMedia, onMark, marks, onMarks }: {
  clip: TimelineClip;
  media: Media;
  clipStartUs: number;
  onSeekMedia: (mediaUs: number) => void;
  /** Adds a marker for each (timeline times and notes). */
  onMark: (list: { t: number; note: string }[]) => void;
  marks: boolean;
  onMarks: () => void;
}) {
  const tags = clipTags(clip, media);
  const outside = media.hilights.length - tags.length;
  return (
    <Section title="HiLight tags" badge={tags.length ? `${tags.length}` : undefined}>
      {tags.length ? (
        <>
          <div className="air-list hl-list">
            {tags.map((t, i) => (
              <button key={t} className="air-row hl-row" title="Go to this tag" onClick={() => onSeekMedia(t)}>
                <span>HiLight {i + 1}</span>
                <span className="muted">{fmtTime(mediaToTimeline(clipStartUs, clip, t))}</span>
              </button>
            ))}
          </div>
          <div className="row-buttons">
            <button title="Adds a marker on the timeline at each tag" onClick={() => onMark(tags.map((t, i) => ({ t: clipStartUs + localAt(clip, t), note: `HiLight ${i + 1}` })))}>Add as markers</button>
          </div>
        </>
      ) : (
        <p className="hint">No HiLight tags in this clip. Press the HiLight button on the camera while recording (or say “GoPro, HiLight”) to tag a moment; the tags show up here.</p>
      )}
      {outside > 0 && <p className="hint">{outside} more tag{outside === 1 ? ' is' : 's are'} in parts of the file this clip doesn’t use.</p>}
      <label className="check"><input type="checkbox" checked={marks} onChange={onMarks} /> Show HiLight tags and jumps on the timeline</label>
    </Section>
  );
}
