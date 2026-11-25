// What the preview shows for grading, outside the edit itself: the scopes (fed from the finished
// picture of one clip) and the qualifier's matte. Set by the Scopes panel and the Color panel,
// read by the preview's draw loop.

export const gradeView = {
  /** The scopes want a new picture (the Scopes panel is open). */
  scopes: null as null | { analyse: (tex: GPUTexture, enc: GPUCommandEncoder) => void; drawn: () => void },
  /** When the scopes last got one (ms). */
  last: 0,
  /** The clip the scopes read (the one being graded); missing = the bottom layer. */
  clipId: null as string | null,
  /** Shows what this clip's qualifier picks, in grey. */
  matteClip: null as string | null,
};

/** Scopes refresh at most this often (ms): enough to follow a grade, light on playback. */
export const SCOPE_EVERY_MS = 90;
