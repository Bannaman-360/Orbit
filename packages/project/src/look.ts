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

export interface Look {
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
