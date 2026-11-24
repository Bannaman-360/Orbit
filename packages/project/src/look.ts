// A "look" is everything about how a frame is rendered that can change over time:
// where the virtual camera points, its lens, the colour grade and motion blur.
// Keyframes store whole looks; values between keyframes are interpolated.

export interface Grade {
  /** Stops, -8..4. */
  exposure: number;
  /** -1..1 */
  contrast: number;
  highlights: number;
  shadows: number;
  /** Lifts blacks for a faded/film look, 0..1. */
  fade: number;
  saturation: number;
  /** Saturation that protects already-saturated colours and skin, -1..1. */
  vibrance: number;
  /** Cool ← → warm, -1..1. */
  temperature: number;
  /** Green ← → magenta, -1..1. */
  tint: number;
  /** 0..1 */
  vignette: number;
  /** 0..3 */
  sharpen: number;
  /** Strength of the loaded LUT, 0..1 (ignored when no LUT is loaded). */
  lutMix: number;
}

/** Creative effects, each 0 (off) … 1 (strong). */
export interface Effects {
  /** Film grain. */
  grain: number;
  /** Soft glow around bright areas (bloom). */
  glow: number;
  /** Colour fringing towards the edges, like a cheap lens. */
  chroma: number;
  /** Radial "speed" blur from the centre. */
  zoomBlur: number;
  /** Warm light leaks drifting across the frame. */
  leak: number;
  /** Cinematic black bars, top and bottom. */
  bars: number;
}

export const NO_EFFECTS: Effects = { grain: 0, glow: 0, chroma: 0, zoomBlur: 0, leak: 0, bars: 0 };

/**
 * Where a clip sits in the frame (picture-in-picture, split screen). Fractions of the output
 * frame; a missing transform is the whole frame. Keyframed with the rest of the look.
 */
export interface Transform {
  /** Centre offset from the frame's centre, fractions of the frame's width / height. */
  x: number;
  y: number;
  /** 1 = the size of the frame. */
  scale: number;
  /** Cut from each side of the clip's picture: left, top, right, bottom, 0–0.9. */
  crop: [number, number, number, number];
  /** Degrees, clockwise. */
  rotate: number;
  /** 0–1 */
  opacity: number;
  /** Rounded corners, a share of the shorter side of the shown picture, 0–0.5. */
  radius: number;
  /** Border width, a share of the frame's height, 0–0.05. */
  border: number;
  borderColor: string;
  /** Drop shadow, 0 (none) … 1 (strong). */
  shadow: number;
}

export const IDENTITY_XF: Transform = { x: 0, y: 0, scale: 1, crop: [0, 0, 0, 0], rotate: 0, opacity: 1, radius: 0, border: 0, borderColor: '#ffffff', shadow: 0 };

export const xfOf = (l: { xf?: Transform }): Transform => l.xf ?? IDENTITY_XF;

/** Whether a transform leaves the picture exactly as it is (full frame, nothing drawn round it). */
export function isIdentityXf(x: Transform | undefined): boolean {
  if (!x) return true;
  return Math.abs(x.x) < 1e-6 && Math.abs(x.y) < 1e-6 && Math.abs(x.scale - 1) < 1e-6 && x.crop.every((c) => c < 1e-6)
    && Math.abs(x.rotate) < 1e-6 && x.opacity >= 1 - 1e-6 && x.radius < 1e-6 && x.border < 1e-6 && x.shadow < 1e-6;
}

export interface Look {
  /** Placement in the frame (missing = full frame). */
  xf?: Transform;
  yaw: number;
  pitch: number;
  roll: number;
  fov: number;
  fisheye: number;
  /** Motion blur ("ND filter"): 0 = off … 1 = longest shutter. */
  motionBlur: number;
  grade: Grade;
  fx: Effects;
}

export const NEUTRAL_GRADE: Grade = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, fade: 0,
  saturation: 0, vibrance: 0, temperature: 0, tint: 0, vignette: 0, sharpen: 0, lutMix: 1,
};

export const DEFAULT_LOOK: Look = { yaw: 0, pitch: 0, roll: 0, fov: 100, fisheye: 0, motionBlur: 0, grade: NEUTRAL_GRADE, fx: NO_EFFECTS };

export const GRADE_PRESETS: Record<string, Partial<Grade>> = {
  Neutral: {},
  Vivid: { contrast: 0.2, saturation: 0.15, vibrance: 0.35, sharpen: 0.3 },
  'Golden hour': { exposure: 0.1, temperature: 0.35, tint: 0.05, contrast: 0.15, vibrance: 0.25, highlights: -0.2, vignette: 0.25 },
  'Cool action': { temperature: -0.25, contrast: 0.25, saturation: -0.05, vibrance: 0.2, shadows: 0.1, sharpen: 0.4 },
  Film: { contrast: 0.1, fade: 0.25, saturation: -0.15, temperature: 0.08, highlights: -0.25, vignette: 0.3 },
  'Punchy contrast': { contrast: 0.45, highlights: -0.35, shadows: 0.25, vibrance: 0.3, sharpen: 0.35 },
  'Black & white': { saturation: -1, contrast: 0.3, vignette: 0.2, sharpen: 0.2 },
};

export function gradeFromPreset(name: string): Grade {
  return { ...NEUTRAL_GRADE, ...(GRADE_PRESETS[name] ?? {}) };
}

/** Motion blur amount → number of source frames blended (1 = off). */
export function blurFrames(motionBlur: number): number {
  return 1 + Math.round(Math.max(0, Math.min(1, motionBlur)) * 7);
}

/** Shutter description for the UI, e.g. "ND16 · 4 frames". */
export function blurLabel(motionBlur: number, sourceFps: number): string {
  const n = blurFrames(motionBlur);
  if (n === 1) return 'Off';
  const shutter = Math.round(sourceFps / n);
  return `${n} frames · ≈1/${shutter}s shutter`;
}
