// Editing panels: sections for the clip under the playhead (which the user can move between
// panels), and the settings of the selected overlay, transition or audio.

import { useSyncExternalStore, type ReactNode } from 'react';
import { effectiveLens, lensK, MIN_FISHEYE } from '@ace/media360';
import {
  ANIMATIONS, blurLabel, FONTS, clipStarts, framingAspect, DEFAULT_CROP, DEFAULT_TRACK_EASE_S, DEFAULT_TRACK_LENS, DEFAULT_TRACK_MAX_FOV, MAX_ZOOM_FOV, mediaToTimeline, NO_EFFECTS, trackActive, trackExtent, lookAt, trackHeld, trackRange, trackWeight, GAUGES, lookPatch, GRADE_PRESETS, TEXT_PRESETS, gradeFromPreset, keyframeNear, NEUTRAL_GRADE, timelineDuration, TRANSITION_GROUPS, transitionUs,
  cleanSpeed, hasRamp, localAt, mediaAt, MAX_SPEED, MIN_SPEED, RAMP_PRESETS, rampPreset, removeSpeedKey, setSpeedEase, setSpeedKey, speedAt, speedKeyNear, speedRange,
  fisheyeForLook, cleanXf, isIdentityXf, addMaskKey, MASK_EFFECTS, MAX_MASKS, maskPoseAt, newMask, removeMaskKey, setMaskPose, type Mask, type MaskPose, type MaskShape, LAYOUT_TEMPLATES, xfOf, type Transform,
  type AudioClip, type ClipTrack, type Easing, type Effects, type GaugeDesign, type Grade, type InputChoice, type Look, type Overlay, type Smoothing, type Timeline, type TimelineClip, type Transition,
  type OffKey, isCompound, CURVES, setEasing, titleTemplate, applyTitleTemplate, TEXT_PATHS, isNeutralSound,
  NEUTRAL_WINDOW, type WindowGrade,
} from '@ace/project';
import { airtimeStats, CUSTOM_SIGMA_RANGE, DEFAULT_AIRTIME, SMOOTHING_SIGMA_S } from '@ace/telemetry';
import { baseName } from './api';
import { autoInput, INPUT_NAMES, inputName, resolvedInput, wideColor } from './color';
import { adoptReframe, clipLens, flatShot, lensLookOf, roomFov, shutterDoneInCamera } from './frameRender';
import type { Media } from './media';
import { FONT_STACK } from './overlayRender';
import { GaugeLookPicker } from './GaugeLooks';
import { LensMatchSection } from './LensMatch';
import { TransitionTile } from './TransitionTiles';
import { analysed, canAnalyse, motionFromPicture } from './flowStab';
import { CurvesSection, FilmSection, NoiseSection, QualifierSection, WheelsSection, type GradingProps } from './Grading';
import { fmtSpeed } from './SpeedLine';
import { CurveEditor } from './CurveEditor';
import { SoundTools } from './SoundTools';
import { TextPathControls, TitlePicker } from './TitlePicker';
import { fmtTime, Lock, Section, SectionList, Seg, Slider, toggleAllSections, type Units } from './ui';
import { Icon } from './ui/Icon';
import { fmtJumpLength } from './gaugeMath';
import { copyState, ESRGAN, onCopyChange, RIFE } from './aiCopy';
import { ModelNeeded } from './AiDialogs';
import { HighlightsSection, type HighlightPick } from './Highlights';
import { canUpscale, enhancedSize, enhanceOn, smoothFactor, type Enhance } from '@ace/project';

export interface InspectorProps {
  clip: TimelineClip | null;
  clipIndex: number;
  clipCount: number;
  /** Timeline time where the clip being edited starts. */
  clipStartUs: number;
  /** The clip being edited is on a track above the main row ("V2"…), or null for the main row. */
  layerTrack: string | null;
  /** Places what is on screen at the playhead in a layout (picture in picture, split screen…). */
  onLayout: (id: string) => void;
  /** Main-row or track clips on screen at the playhead (to say what a layout will place). */
  layersHere: number;
  /** The mask being edited (outlined on the preview, where it can be dragged). */
  maskSel: string | null;
  onMaskSel: (id: string | null) => void;
  /** Replaces the clip's masks. */
  onMasks: (masks: Mask[], key: string) => void;
  /** Turns following the tracked subject on or off (keeps the mask where it is now). */
  onMaskFollow: (id: string, on: boolean) => void;
  /** Draw a freehand mask on the preview. */
  onDrawMask: () => void;
  drawingMask: boolean;
  /** Track only for masks: the view doesn't move with the subject. */
  onTrackPatchSteer: (steer: boolean) => void;
  media: Media | null;
  mediaUs: number;
  look: Look | null;
  audio: AudioClip | null;
  overlay: Overlay | null;
  transitionClip: TimelineClip | null;
  timeline: Timeline;
  lutPath: string | null;
  showRaw: boolean;
  onShowRaw: (v: boolean) => void;
  /** Changes the look: keyframes the change when the clip is keyframed. `key` groups slider drags into one undo step. */
  onLook: (patch: Partial<Look>, key: string) => void;
  onGrade: (patch: Partial<Grade>, key: string) => void;
  onAddKeyframe: () => void;
  onDeleteKeyframe: () => void;
  onDeleteKeyframeId: (id: string) => void;
  onGoToKeyframe: (id: string) => void;
  onClearKeyframes: () => void;
  onEasing: (e: Easing) => void;
  onPrevKey: () => void;
  onNextKey: () => void;
  onClip: (patch: Partial<TimelineClip>, key: string) => void;
  /** Changes speed or ramp. */
  onSpeed: (patch: Partial<Pick<TimelineClip, 'speed' | 'speedKeys' | 'muteBelow' | 'keepPitch'>>, key: string) => void;
  speedLines: boolean;
  onSpeedLines: () => void;
  jumpMarks: boolean;
  onJumpMarks: () => void;
  /** Adds markers (timeline times, notes). */
  onAddMarkers: (list: { t: number; note: string }[]) => void;
  /** Adds clips at the end of the main row (a highlight reel). */
  onAppendClips: (clips: TimelineClip[], what: string) => void;
  /** A highlight reel from every clip on the main row. */
  onReelAll: (pick: HighlightPick) => void;
  /** Moves the playhead to a moment of the selected clip (media time). */
  onSeekMedia: (mediaUs: number) => void;
  /** Play from timeline time T (to show an overlay's animation). */
  onPreviewAt: (T: number) => void;
  /** Works out corrections that make the lenses of a 360 clip alike. */
  onMatchLenses: (which?: 'front' | 'back') => void;
  lensBusy: boolean;
  onLensesToAll: () => void;
  onGradeToAll: () => void;
  onLoadLut: () => void;
  onClearLut: () => void;
  onAudio: (patch: Partial<AudioClip>, key: string) => void;
  onDetachAudio: () => void;
  onReattachAudio: (clipId: string) => void;
  onOverlay: (patch: Partial<Overlay>, key: string) => void;
  /** A compound clip being edited: its name, and how to open it. */
  compoundName?: string;
  onOpenCompound: (clipId: string) => void;
  /** Clips on V2–V6 a gauge can read its ride data from. */
  gaugeSources: { id: string; label: string }[];
  /** Gives every gauge this design. */
  onGaugeDesignAll: (design: GaugeDesign) => void;
  onTransition: (patch: Partial<Transition>, key: string) => void;
  /** Deletes the selected overlay / transition / audio. */
  onRemoveSelected: () => void;
  onCloseSelection: () => void;
  onTrackSubject: () => void;
  trackBusy: boolean;
  /** Change which part of the tracked path is used (media times). */
  onTrackRange: (from: number, to: number, edge: 'from' | 'to') => void;
  onClearTrack: () => void;
  onTrackPatch: (patch: Partial<ClipTrack>, key: string) => void;
  /** Stabilising from the picture (clips without motion data). */
  motionJob: { progress: number } | null;
  motionBusy: boolean;
  motionNote: string | null;
  onPictureMotion: () => void;
  onCancelPictureMotion: () => void;
  onForgetPictureMotion: () => void;
  /** Smart reframe for the frame shape (this clip), and its progress. */
  reframeJob: { progress: number } | null;
  reframeNote: string | null;
  onSmartReframe: () => void;
  /** Makes a failed AI copy (smooth slow motion, sharper picture) again. */
  onRetryCopy: () => void;
  onCancelSmartReframe: () => void;
  onSplit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
}

const VIEW_PRESETS: [string, Partial<Look>][] = [
  ['Front', { yaw: 0, pitch: 0, roll: 0, fov: 100, fisheye: 0.1 }],
  ['Back', { yaw: 180, pitch: 0, roll: 0, fov: 100, fisheye: 0.1 }],
  ['Natural wide', { yaw: 0, pitch: -5, roll: 0, fov: 120, fisheye: 0.25 }],
  ['Fisheye', { pitch: -10, fov: 190, fisheye: 0.6 }],
  ['Tiny planet', { pitch: -90, roll: 0, fov: 260, fisheye: 1 / 3 }],
  ['Rabbit hole', { pitch: 90, roll: 0, fov: 240, fisheye: 1 / 3 }],
];

const lensName = (k: number) => (k > 1.05 ? 'Beyond linear — edges stretched, lines bow inward' : k > 0.9 ? 'Linear' : k > 0.6 ? 'Mild fisheye' : k > 0.4 ? 'Stereographic' : k > -0.1 ? 'Fisheye' : 'Extreme fisheye');
// Strength slider: position 0..1 maps logarithmically onto the smoothing window.
const LOG_SPAN = Math.log(CUSTOM_SIGMA_RANGE.max / CUSTOM_SIGMA_RANGE.min);
const sigmaToPos = (s: number) => Math.log(s / CUSTOM_SIGMA_RANGE.min) / LOG_SPAN;
const posToSigma = (u: number) => CUSTOM_SIGMA_RANGE.min * Math.exp(u * LOG_SPAN);
const fmtSigma = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(s < 10 ? 2 : 1)} s`);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const signed = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
const deg = (v: number) => `${v.toFixed(1)}°`;
const secs = (v: number) => `${v.toFixed(1)}s`;
const FX_PRESETS: [string, Partial<Effects>][] = [
  ['Clean', {}],
  ['Speed', { zoomBlur: 0.45, chroma: 0.3 }],
  ['Dreamy', { glow: 0.6, leak: 0.35 }],
  ['Retro film', { grain: 0.5, leak: 0.45, glow: 0.2 }],
  ['Cinematic', { bars: 1, grain: 0.2, glow: 0.15 }],
  ['Music video', { chroma: 0.7, glow: 0.35, grain: 0.3 }],
  ['VHS tape', { vhs: 0.8, grain: 0.15 }],
  ['Glitch', { rgbSplit: 0.7, shake: 0.35, chroma: 0.3 }],
  ['Film print', { halation: 0.6, bloom: 0.3, grain: 0.35 }],
  ['Handheld', { shake: 0.45 }],
];
// Typing units: what the number you type means for each kind of slider.
const PCT: Units = { to: (v) => v * 100, from: (n) => n / 100, digits: 0 };
const DEG: Units = { digits: 1 };
const EV: Units = { digits: 2 };
const SEC: Units = { digits: 1 };
const CLOCK: Units = { digits: 2 };

/** Which part of the clip the subject is followed in. Times are shown as timeline times. */
function TrackRangeControls(p: InspectorProps & { clip: TimelineClip; track: ClipTrack }) {
  const { clip, track } = p;
  const r = trackRange(track), e = trackExtent(track);
  if (!r || !e) return null;
  const start = p.clipStartUs;
  const toT = (t: number) => mediaToTimeline(start, clip, t) / 1e6;
  const toMedia = (s: number) => mediaAt(clip, s * 1e6 - start);
  // Only the part of the path inside this (possibly trimmed) clip can be chosen.
  const lo = Math.max(e[0], clip.inUs), hi = Math.min(e[1], clip.outUs);
  if (hi <= lo) return <p className="hint">The tracked part is outside this clip’s trim.</p>;
  const a = Math.max(lo, Math.min(hi, r[0])), b = Math.max(lo, Math.min(hi, r[1]));
  // Reaching the limit means “all of it”, even if the clip is trimmed there.
  const from = (t: number) => p.onTrackRange(t <= lo + 1000 ? e[0] : Math.min(t, b - 100_000), r[1], 'from');
  const to = (t: number) => p.onTrackRange(r[0], t >= hi - 1000 ? e[1] : Math.max(t, a + 100_000), 'to');
  const hold = (track.after ?? 'hold') === 'hold';
  const state = trackActive(track, p.mediaUs)
    ? `Following the subject. Drag the preview to shift the framing around it${track.autoZoom ? '; scroll to change how big it is kept' : ''}.`
    : trackHeld(track, p.mediaUs)
      ? 'Following has stopped here. Drag or scroll the preview to choose the view it settles on.'
      : 'Not following the subject here.';
  const time = (v: number) => fmtTime(v * 1e6);
  return (
    <>
      <p className="hint">{state}</p>
      <Slider label="Start" value={toT(a)} min={toT(lo)} max={toT(hi)} step={0.01} reset={toT(lo)} format={time} units={CLOCK} hint="Where the view starts following the subject (timeline time). Also the left cyan handle on the clip." onChange={(v) => from(toMedia(v))} />
      <Slider label="Stop" value={toT(b)} min={toT(lo)} max={toT(hi)} step={0.01} reset={toT(hi)} format={time} units={CLOCK} hint="Where the view stops following the subject (timeline time). Also the right cyan handle on the clip." onChange={(v) => to(toMedia(v))} />
      <div className="row-buttons">
        <button disabled={p.mediaUs < lo || p.mediaUs >= b} title="Start following at the playhead" onClick={() => from(p.mediaUs)}>Start here</button>
        <button disabled={p.mediaUs > hi || p.mediaUs <= a} title="Stop following at the playhead" onClick={() => to(p.mediaUs)}>Stop here</button>
        {(track.from !== undefined || track.to !== undefined) && <button title="Follow the subject everywhere it was tracked" onClick={() => p.onTrackPatch({ from: undefined, to: undefined }, 'track-all')}>Use all</button>}
      </div>
      <div className="field-row">
        <span>After it stops</span>
        <Seg value={hold ? 'hold' : 'return'} options={[['hold', 'Stay there'], ['return', 'Go back']]} onChange={(v) => p.onTrackPatch({ after: v }, 'track-after')} />
      </div>
      {hold && track.end && <div className="row-buttons"><button onClick={() => p.onTrackPatch({ end: undefined }, 'track-end')}>Reset view after stop</button></div>}
      <Slider label="Ease in/out" value={track.ease ?? DEFAULT_TRACK_EASE_S} min={0} max={4} step={0.05} reset={DEFAULT_TRACK_EASE_S} format={secs} units={SEC} hint="How long the view takes to move onto the subject once the section starts, and away from it afterwards (seconds)." onChange={(v) => p.onTrackPatch({ ease: v }, 'track-ease')} />
    </>
  );
}

/** The name of the clip being edited, at the top of every inspector panel. */
function ClipStrip({ p, clip }: { p: InspectorProps; clip: TimelineClip }) {
  return (
    <div className="clip-title">
      <div className="clip-title-text">
        <b>{p.media?.name ?? baseName(clip.mediaPath)}</b>
        <span className="muted">{p.layerTrack ? `${p.layerTrack} · ` : ''}Clip {p.clipIndex + 1}/{p.clipCount} · {fmtTime(p.mediaUs)}{p.media?.is360 ? ' · 360°' : ''}</span>
      </div>
      <button className="ghost" title="Close all sections (or open them all)" onClick={toggleAllSections}><Icon name="collapse" size={16} /></button>
    </div>
  );
}

/** A panel of sections that edit the clip under the playhead. */
export function InspectorPanel(p: InspectorProps & { panel: string }) {
  if (!p.clip || !p.look) return <aside className="inspector"><p className="empty-panel">Add clips to the timeline to start editing.</p></aside>;
  if (isCompound(p.clip)) {
    const id = p.clip.id;
    return (
      <aside className="inspector">
        <div className="tab-body empty-panel">
          <p><b>{p.compoundName ?? 'Compound clip'}</b></p>
          <p className="hint">A compound clip holds clips of its own. Open it to change their color, effects, speed and framing; the changes show wherever it is used.</p>
          <div className="row-buttons"><button onClick={() => p.onOpenCompound(id)}>Open compound clip</button></div>
        </div>
      </aside>
    );
  }
  return (
    <aside className="inspector">
      <ClipStrip p={p} clip={p.clip} />
      <div className="tab-body">
        <SectionList list={p.panel} sections={clipSections({ ...p, clip: p.clip, look: p.look })} empty={<p className="empty-panel">Drag sections here by their titles.</p>} />
      </div>
    </aside>
  );
}

/** Settings of whatever is selected: text, gauge, transition or sound. */
export function SelectionPanel(p: InspectorProps) {
  if (p.overlay) return <OverlayPanel {...p} overlay={p.overlay} />;
  if (p.transitionClip?.transitionIn) return <TransitionPanel {...p} clip={p.transitionClip} transition={p.transitionClip.transitionIn} />;
  if (p.audio) return <AudioPanel {...p} audio={p.audio} />;
  if (p.layerTrack) return <aside className="inspector"><p className="empty-panel">This clip is on {p.layerTrack}. Edit it in Reframe, Color, Effects and Clip, like any clip.</p></aside>;
  return <aside className="inspector"><p className="empty-panel">Select a text, gauge, transition or sound to edit it here.</p></aside>;
}

/** Every section that edits the clip under the playhead, by id (placed by SectionList). */
function clipSections(p: InspectorProps & { clip: TimelineClip; look: Look }): Record<string, ReactNode> {
  const { clip, look, media } = p;
  const is360 = !!media?.is360;
  const key = keyframeNear(clip.keyframes, p.mediaUs);
  const ramp = hasRamp(clip), speedNow = speedAt(clip, p.mediaUs), fps = p.media?.fps ?? 30;
  const speedPoint = speedKeyNear(clip, p.mediaUs);
  /** The point whose way to the next one the playhead is in. */
  const stretch = clip.speedKeys?.filter((k, _i, all) => k.t <= p.mediaUs + 1000 && all.some((x) => x.t > k.t)).sort((a, b) => b.t - a.t)[0];
  const setSpeed = (s: number, k: string) => p.onSpeed(ramp ? { speedKeys: setSpeedKey(clip, p.mediaUs, s) } : { speed: s }, k);
  const keyed = !!key;
  const keyCount = clip.keyframes.length;
  const lens = effectiveLens({ fov: look.fov, fisheye: look.fisheye, autoLens: true });
  const g = look.grade;
  // The lens look kept while zooming.
  const kept = lensLookOf(clip);
  const keepLook = (
    <>
      <label className="check" title="The fisheye follows the field of view, so zooming in or out keeps the same look instead of the same lens"><input type="checkbox" checked={!!clip.lensLook} onChange={(e) => p.onClip({ lensLook: e.target.checked ? { fov: look.fov, fisheye: look.fisheye } : undefined, ...(e.target.checked ? {} : { look: { ...clip.look, fisheye: look.fisheye }, keyframes: clip.keyframes.map((k) => ({ ...k, look: { ...k.look, fisheye: look.fisheye } })) }) }, 'lens-look')} /> Keep this look when zooming</label>
      {kept && <p className="hint">{[60, 120, 200, 300].map((f) => `${f}°: ${lensName(lensK(fisheyeForLook(kept, f))).replace(/ —.*/, '').toLowerCase()}`).join(' · ')}</p>}
    </>
  );

  // What subject tracking controls at the playhead, and why it can't be changed there.
  const tr = clip.track;
  const range = tr && trackRange(tr);
  const clipStart = p.clipStartUs;
  const when = range ? `${fmtTime(mediaToTimeline(clipStart, clip, range[0]))}–${fmtTime(mediaToTimeline(clipStart, clip, range[1]))}` : '';
  const steered = !!tr && trackWeight(tr, p.mediaUs) > 0;
  const heldNow = !!tr && trackHeld(tr, p.mediaUs);
  const settling = heldNow && (p.mediaUs - range![1]) / 1e6 < (tr.ease ?? DEFAULT_TRACK_EASE_S) * 0.35;
  const aimLock = (what: string): string | false =>
    settling ? `Following has only just stopped, and the view is still settling. Move the playhead a little later to set the ${what}.`
    : steered && !heldNow ? `Subject tracking sets the ${what} here (${when}). Use “Shift across” and “Shift up” in Subject tracking, or drag the preview, to move the framing. Outside ${when} you can set it freely.`
    : false;
  const zoomLock: string | false =
    settling ? aimLock('zoom')
    : steered && !heldNow && (tr!.autoZoom ?? 0) > 0 ? `Auto zoom sets the field of view here (${when}) to keep the subject the same size. Use “Subject size” in Subject tracking, scroll on the preview, or turn Auto zoom down to 0%.`
    : false;
  const bent = steered && (tr!.autoZoom ?? 0) > 0 && look.fisheye > lookAt(clip.keyframes, clip.look, p.mediaUs).fisheye + 0.004;
  const lensLock: string | false = bent ? 'Auto fisheye is bending the lens here to avoid stretched edges. Change “Auto fisheye” in Subject tracking, or set it to 0% to use this slider.' : false;
  const viewLock = aimLock('view') || zoomLock;
  // Regular clips: the lens they were shot through.
  const flat = media ? clipLens(media, clip) : null;
  const canMove = is360 || !!flat;
  // A regular clip whose camera is known (an action camera) can also change its lens; any other
  // video (a phone clip, an edit from another app) is simply moved, sized and cropped.
  const knownLens = !!flat && flat.from !== 'guess';
  const shot = flat && media && clip.lensMode ? flatShot(clip, media, look, p.mediaUs, framingAspect(p.timeline.framing)) : null;
  const shown = shot?.fov ?? look.fov;
  const customLens = clip.lensMode === 'custom';
  const widest = flat && media ? Math.round(roomFov(clip, media)) : MAX_ZOOM_FOV;
  /** Changes what the lens is thought to be, keeping an unzoomed clip unzoomed. */
  const fixLens = (patch: { hfov?: number; bend?: number }) => {
    const next = { ...clip.lensFix, ...patch };
    const grow = (f: number) => (patch.hfov && flat ? Math.min(170, (f * patch.hfov) / flat.hfov) : f);
    p.onClip({ lensFix: next, look: { ...clip.look, fov: grow(clip.look.fov) }, keyframes: clip.keyframes.map((k) => ({ ...k, look: { ...k.look, fov: grow(k.look.fov) } })) }, `lensfix-${Object.keys(patch)}`);
  };
  const noZoom = !!tr && !(tr.autoZoom ?? 0) && 'This only matters when the view zooms with the subject. Turn up Auto zoom first.';
  const stitched = !!media?.layout?.equirect;
  const noMotion = !media?.stabilizer.hasOrientation ? stitched ? 'This 360 video was stitched before you downloaded it. GoPro normally builds its stabilization into these, and the file has no motion data to change it with.' : flat ? 'This clip has no motion data from the camera: choose “Stabilize from the picture” first.' : 'This clip has no motion data from the camera, so it can’t be stabilized.' : false;
  const stabOn = clip.stabilize.smoothing !== 'off' && !noMotion;
  const levelOn = clip.stabilize.horizon && !!media?.stabilizer.hasGravity;
  const cropLock: string | false = !stabOn && !levelOn && (noMotion || 'Cropping hides the edges that stabilization and leveling uncover. Turn Stabilization or Level horizon on first.');
  const steadyLock: string | false = cropLock || noMotion || (!stabOn && 'This only matters while the picture is stabilized. Turn Stabilization on first.');
  const rollLock: string | false = steadyLock || (!!media && shutterDoneInCamera(media) && 'This camera already corrects it while recording, so fixing it again would add wobble.') || (!media?.camera.readoutMs && 'The file doesn’t say how fast the sensor is read, so the wobble can’t be worked out.') || (media!.turns !== 0 && 'This isn’t available yet for clips recorded with the camera turned.') || (!!media && motionFromPicture(media) && 'This needs the camera’s own motion data, which this clip doesn’t have.');
  /** Changes stabilisation (a regular clip becomes reframable first, which doesn't change how it looks). */
  const setStab = (patch: Partial<typeof clip.stabilize>, k: string) => {
    const c = adoptReframe(clip);
    p.onClip({ ...(c === clip ? {} : { lensMode: c.lensMode, look: c.look, keyframes: c.keyframes }), stabilize: { ...clip.stabilize, ...patch } }, k);
  };
  const noGravity = !media?.stabilizer.hasGravity ? 'This clip has no gravity data from the camera, so the horizon can’t be found.' : false;

  const keyBar = (
    <div className="keybar">
      <button title="Previous keyframe" onClick={p.onPrevKey} disabled={!keyCount}>◀</button>
      <button className={keyed ? 'on' : ''} title={keyed ? 'Update this keyframe with the current settings' : 'Add a keyframe here (K)'} onClick={p.onAddKeyframe}>◆ {keyed ? 'Keyframe' : 'Add keyframe'}</button>
      <button title="Next keyframe" onClick={p.onNextKey} disabled={!keyCount}>▶</button>
      {keyed && (
        <select value={key!.easing} onChange={(e) => p.onEasing(e.target.value as Easing)} title="How the move into the next keyframe accelerates (shape it in Curves)">
          {CURVES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          {key!.easing === 'custom' && <option value="custom">Custom</option>}
        </select>
      )}
      <span className="grow" />
      {keyCount > 0 && <button className="link" title="Delete every keyframe in this clip" onClick={p.onClearKeyframes}>Clear {keyCount}</button>}
    </div>
  );
  const start = p.clipStartUs;
  const keyList = keyCount > 0 && (
    <div className="kf-list">
      {[...clip.keyframes].sort((a, b) => a.t - b.t).map((k) => (
        <div key={k.id} className={`kf-row${key?.id === k.id ? ' on' : ''}`}>
          <button className="ghost" title="Go to this keyframe" onClick={() => p.onGoToKeyframe(k.id)}><i className="kf-dot" />{fmtTime(mediaToTimeline(start, clip, k.t))}{k.t < clip.inUs || k.t > clip.outUs ? <span className="muted">trimmed off</span> : null}</button>
          <button className="ghost" title="Delete this keyframe" aria-label="Delete this keyframe" onClick={() => p.onDeleteKeyframeId(k.id)}><Icon name="trash" size={15} /></button>
        </div>
      ))}
    </div>
  );

    const st = clip.stabilize;
    const sigma =
      st.smoothing === 'custom' ? st.strength ?? SMOOTHING_SIGMA_S.medium
      : st.smoothing === 'low' || st.smoothing === 'medium' || st.smoothing === 'high' ? SMOOTHING_SIGMA_S[st.smoothing]
      : st.strength ?? SMOOTHING_SIGMA_S.medium;
    const off = !media?.stabilizer.hasOrientation;
    const fx = look.fx;
    const set = (k: keyof Effects) => (v: number) => p.onLook({ fx: { ...fx, [k]: v } }, `fx-${k}`);
    /** The on/off switch for one setting (switching it off keeps its value, to compare). */
    const sw = (key: OffKey) => ({
      on: !clip.off?.includes(key),
      onToggle: () => {
        const off = clip.off?.includes(key) ? clip.off.filter((k) => k !== key) : [...(clip.off ?? []), key];
        p.onClip({ off: off.length ? off : undefined }, `off-${key}`);
      },
    });
    const grading: GradingProps = { clip, look, keyed, onLook: p.onLook, onClip: p.onClip, sw };
    const fxSlider = (k: keyof Effects, label: string, hint: string) => (
      <Slider label={label} value={fx[k]} min={0} max={1} reset={0} keyed={keyed} units={PCT} format={pct} hint={hint} toggle={sw(`fx.${k}`)} onChange={set(k)} />
    );
  const hasSound = !!media?.info.audioTracks.length;
  return {
    'Keyframes': (
        <Section title="Keyframes" badge={keyCount ? `${keyCount}${keyed ? ' · here' : ''}` : undefined}>{keyBar}
          {keyList}
          <p className="hint">{keyCount ? 'Changes now set a keyframe at the playhead. Delete one with its bin, or click its ◆ on the timeline and press ⌫.' : 'Add a keyframe to animate the view, lens and color over time.'}</p>
        </Section>
    ),
    'Curves': (
        <Section title="Curves" badge={keyCount > 1 ? undefined : 'Needs 2 keyframes'}>
          <CurveEditor keyframes={clip.keyframes} mediaUs={p.mediaUs} toTimeline={(t) => mediaToTimeline(start, clip, t)}
            onCurve={(id, c, g) => p.onClip({ keyframes: setEasing(clip.keyframes, id, c, g) }, `curve-${id}-${g ?? 'all'}`)} />
        </Section>
    ),
    'Subject tracking': canMove && (
        <Section title="Subject tracking" badge={clip.track ? (trackActive(clip.track, p.mediaUs) ? 'Following' : 'On') : undefined}>
          {clip.track ? (
            <>
              <TrackRangeControls {...p} clip={clip} track={clip.track} />
              <Slider label="Auto zoom" value={clip.track.autoZoom ?? 0} min={0} max={1} step={0.01} reset={1} units={PCT} format={pct} hint="Zooms in and out so the subject stays the same size in the frame (0% = off)." onChange={(v) => p.onTrackPatch({ autoZoom: v, subjectFrac: clip.track!.subjectFrac ?? 0.25 }, 'track-zoom')} />
              <Slider label="Subject size" value={clip.track.subjectFrac ?? 0.25} min={0.03} max={0.9} step={0.005} reset={0.25} units={PCT} format={pct} locked={noZoom} hint="How much of the frame width the subject fills when auto zoom is on. Scrolling over the preview changes this too." onChange={(v) => p.onTrackPatch({ subjectFrac: v }, 'track-size')} />
              <Slider label="Auto fisheye" value={clip.track.lens ?? DEFAULT_TRACK_LENS} min={0} max={1} step={0.01} reset={DEFAULT_TRACK_LENS} units={PCT} format={pct} locked={noZoom || (!!flat && !customLens && 'The original lens is kept as it is. Choose Custom under Lens to let it bend.')} hint="Bends the lens as auto zoom goes wide, so the edges don't stretch. 0% keeps the clip's own lens." onChange={(v) => p.onTrackPatch({ lens: v }, 'track-lens')} />
              <Slider label="Widest zoom" value={Math.min(widest, clip.track.maxFov ?? DEFAULT_TRACK_MAX_FOV)} min={Math.min(50, widest - 1)} max={widest} step={1} reset={Math.min(widest, DEFAULT_TRACK_MAX_FOV)} units={DEG} format={deg} locked={noZoom} hint={`Auto zoom never shows a wider view than this; the subject gets bigger instead.${flat ? ` This clip’s picture is ${widest.toFixed(0)}° wide, so it can’t go wider.` : ''}`} onChange={(v) => p.onTrackPatch({ maxFov: v }, 'track-maxfov')} />
              <Slider label="Shift across" value={clip.track.offsetYaw} min={-60} max={60} step={0.1} reset={0} units={DEG} format={deg} hint="Moves the framing left or right of the subject." onChange={(v) => p.onTrackPatch({ offsetYaw: v }, 'track-ox')} />
              <Slider label="Shift up" value={clip.track.offsetPitch} min={-45} max={45} step={0.1} reset={0} units={DEG} format={deg} hint="Moves the framing above or below the subject." onChange={(v) => p.onTrackPatch({ offsetPitch: v }, 'track-oy')} />
              <Slider label="Smoothness" value={clip.track.smoothing} min={0} max={1.5} step={0.01} reset={0.25} format={secs} units={SEC} hint="How much the camera's follow movement is smoothed (seconds)." onChange={(v) => p.onTrackPatch({ smoothing: v }, 'track-smooth')} />
              <div className="row-buttons">
                <button onClick={p.onTrackSubject} disabled={p.trackBusy}>◎ Track again from here</button>
                {(clip.track.offsetYaw || clip.track.offsetPitch) ? <button onClick={() => p.onTrackPatch({ offsetYaw: 0, offsetPitch: 0 }, 'track-centre')}>Re-centre</button> : null}
                <button className="danger" onClick={p.onClearTrack}>Clear</button>
              </div>
            </>
          ) : (
            <>
              <div className="row-buttons"><button onClick={p.onTrackSubject} disabled={p.trackBusy}>◎ Track subject…</button></div>
              <p className="hint">Drag a box around a person, bike or anything else on the preview: the view follows it from here on. Afterwards you can choose where it starts and stops.{flat ? ' A regular clip zooms in a little so there is picture left to move into, and never shows past its edges.' : ''}</p>
              {flat && noMotion && <p className="hint">This clip has no motion data, so the subject is followed in the picture itself. Hard camera shake makes that less sure.</p>}
            </>
          )}
        </Section>
    ),
    'View': is360 && (
        <Section title="View" defaultOpen>
          <Slider label="Pan" locked={aimLock('pan')} value={look.yaw} min={-180} max={180} step={0.1} reset={0} format={deg} units={DEG} keyed={keyed} onChange={(v) => p.onLook({ yaw: v }, 'yaw')} />
          <Slider label="Tilt" locked={aimLock('tilt')} value={look.pitch} min={-90} max={90} step={0.1} reset={0} format={deg} units={DEG} keyed={keyed} onChange={(v) => p.onLook({ pitch: v }, 'pitch')} />
          <Slider label="Roll" value={look.roll} min={-180} max={180} step={0.1} reset={0} format={deg} units={DEG} keyed={keyed} onChange={(v) => p.onLook({ roll: v }, 'roll')} />
          <p className="hint">{flat ? 'Scroll on the preview to zoom in, then drag to move around the picture.' : 'Drag on the preview to look around; scroll to zoom.'}</p>
          {flat && <div className="row-buttons"><button onClick={() => p.onLook({ yaw: 0, pitch: 0, roll: 0, fov: flat.hfov, fisheye: 0 }, 'view-reset')}>Show the whole picture</button></div>}
        </Section>
    ),
    'Framing': !is360 && (
        <Section title="Framing" defaultOpen>
          <Seg value={clip.fit} options={[['fit', 'Fit (whole picture)'], ['fill', 'Fill frame']]} onChange={(v) => p.onClip({ fit: v }, 'fit')} />
          <p className="hint">Fit shows the whole video, with black where it doesn’t reach the edges. Fill zooms in until there is no black. Drag the picture on the preview to move it, and scroll or pinch to make it bigger or smaller (see Transform).</p>
          {clip.fit === 'fill' && !clip.lensMode && media && (() => {
            const pic = media.width / media.height, out = framingAspect(p.timeline.framing);
            const pan = look.pan ?? { x: 0, y: 0 };
            const set = (k: 'x' | 'y') => (v: number) => p.onLook({ pan: { ...pan, [k]: v } }, `pan-${k}`);
            return (
              <>
                <Slider label="Part shown across" value={pan.x} min={-1} max={1} step={0.01} reset={0} keyed={keyed} units={PCT} format={signed} locked={pic <= out * 1.01 && 'The whole width of the picture is already shown.'} hint="Which part of the picture fills the frame: −100 is its left edge, +100 its right edge. Keyframe it to pan across. Smart reframe sets it for you." onChange={set('x')} />
                <Slider label="Part shown down" value={pan.y} min={-1} max={1} step={0.01} reset={0} keyed={keyed} units={PCT} format={signed} locked={pic >= out * 0.99 && 'The whole height of the picture is already shown.'} hint="Which part of the picture fills the frame: −100 is its top, +100 its bottom." onChange={set('y')} />
              </>
            );
          })()}
        </Section>
    ),
    'Smart reframe': media && (
        <Section title="Smart reframe" badge={p.reframeJob ? `${Math.round(p.reframeJob.progress * 100)}%` : undefined}>
          {p.reframeJob ? (
            <>
              <p className="hint">Finding where the action is… {Math.round(p.reframeJob.progress * 100)}%</p>
              <div className="flow-progress"><span style={{ width: `${Math.round(p.reframeJob.progress * 100)}%` }} /></div>
              <div className="row-buttons"><button onClick={p.onCancelSmartReframe}>Stop</button></div>
            </>
          ) : (
            <>
              <p className="hint">{p.reframeNote ?? (is360
                ? 'Points the view where you’re riding, for a tall or square frame. It uses GPS when the clip has it, or else where the camera faces.'
                : clip.track && clip.lensMode ? 'Fills the frame and keeps following the subject you tracked.'
                : 'Fills the frame and pans to keep the action in view: what moves, or where you’re heading on a ride.')} The result is keyframes you can change.</p>
              <div className="row-buttons"><button className="primary" onClick={p.onSmartReframe}>Smart reframe this clip</button></div>
            </>
          )}
        </Section>
    ),
    'Lens': flat ? knownLens && (
        <Section title="Lens" badge={customLens ? lensName(lens.k) : 'Original'}>
          <Seg value={customLens ? 'custom' : 'source'} options={[['source', 'Original lens'], ['custom', 'Custom']]} onChange={(v) => p.onClip({ ...adoptReframe(clip), lensMode: v }, 'lensmode')} />
          <Slider label="Field of view" locked={zoomLock} value={look.fov} min={5} max={customLens ? 170 : flat.hfov} step={0.1} reset={flat.hfov} format={deg} units={DEG} keyed={keyed} onChange={(v) => p.onLook({ fov: v }, 'fov')} />
          <Slider label="Fisheye" locked={lensLock || (!customLens && 'The original lens is kept as it is. Choose Custom to straighten or bend it.')} value={look.fisheye} min={MIN_FISHEYE} max={1} step={0.005} reset={0} format={pct} units={PCT} keyed={keyed && !lensLookOf(clip)} onChange={(v) => p.onLook({ fisheye: v }, 'fisheye')} />
          {customLens && keepLook}
          {shown < look.fov - 0.2 && <p className="hint">Showing {shown.toFixed(0)}°: zoomed in so nothing outside the picture appears.</p>}
          <div className="chips">
            {(([['Original', 'source', 0], ['Linear', 'custom', 0], ['Slight fisheye', 'custom', 0.33], ['Fisheye', 'custom', 0.67]] as const)).map(([name, mode, fisheye]) => (
              <button key={name} disabled={!!viewLock} className={(customLens ? 'custom' : 'source') === mode && (mode === 'source' || Math.abs(look.fisheye - fisheye) < 0.01) ? 'on' : ''}
                onClick={() => { const c = adoptReframe(clip); p.onClip({ ...c, lensMode: mode, ...(c.lensLook ? { lensLook: { fov: look.fov, fisheye } } : {}), look: { ...c.look, fisheye }, keyframes: c.keyframes.map((k) => ({ ...k, look: { ...k.look, fisheye } })) }, `lens-${name}`); }}>{name}</button>
            ))}
            {viewLock && <Lock reason={viewLock} />}
          </div>
        </Section>
    ) : is360 && (
        <Section title="Lens" badge={`${look.fov.toFixed(0)}°`}>
          <Slider label="Field of view" locked={zoomLock} value={look.fov} min={1} max={360} step={0.5} reset={100} format={deg} units={DEG} keyed={keyed} onChange={(v) => p.onLook({ fov: v }, 'fov')} />
          <Slider label="Fisheye" locked={lensLock} value={look.fisheye} min={MIN_FISHEYE} max={1} step={0.005} reset={0} format={pct} units={PCT} keyed={keyed && !lensLookOf(clip)} onChange={(v) => p.onLook({ fisheye: v }, 'fisheye')} />
          {keepLook}
          <p className="hint">
            {lensName(lens.k)}
            {lens.k < lensK(look.fisheye) - 1e-3 &&
              (look.fisheye < 0 ? ' — eased back towards linear so this FOV fits (below 0% the widest view is about 100°)' : ' — extra fisheye added automatically so this FOV fits')}
          </p>
          <div className="chips">
            {VIEW_PRESETS.map(([name, v]) => (
              <button key={name} disabled={!!viewLock} onClick={() => p.onLook(v, `preset-${name}`)}>{name}</button>
            ))}
            {viewLock && <Lock reason={viewLock} />}
          </div>
        </Section>
    ),
    'Lens details': knownLens && (
        <Section title="Lens details" badge={flat.name}>
          <p className="hint">{media!.camera.model ? `${media!.camera.model} · ` : ''}{flat.name}{flat.from === 'file' ? ' (read from the file)' : flat.from === 'table' ? ' (typical for this camera)' : ' (not known: adjust below if straight lines look bent)'}</p>
          <Slider label="Recorded width" value={flat.hfov} min={20} max={160} step={0.5} reset={media!.lens!.hfov} units={DEG} format={deg} hint="How wide the camera's view really was. It changes how pan, lens and stabilization behave, not the picture itself." onChange={(v) => fixLens({ hfov: v })} />
          <Slider label="Bend" locked={!!flat.gopro && 'The exact shape of this lens is stored in the file, so there is nothing to correct.'} value={clip.lensFix?.bend ?? 1} min={0} max={2} step={0.01} reset={1} units={PCT} format={pct} hint="How curved the lens is: lower if a Linear view bends outwards, higher if it bends inwards." onChange={(v) => fixLens({ bend: v })} />
          {clip.lensFix && <div className="row-buttons"><button onClick={() => p.onClip({ lensFix: undefined, look: { ...clip.look, fov: (clip.look.fov * media!.lens!.hfov) / flat.hfov } }, 'lensfix-reset')}>Back to detected</button></div>}
        </Section>
    ),
    'Debug': is360 && (
        <Section title="Debug">
          <label className="check"><input type="checkbox" checked={p.showRaw} onChange={(e) => p.onShowRaw(e.target.checked)} /> Show raw camera streams</label>
        </Section>
    ),
    'Stabilization': (
        <Section title="Stabilization" defaultOpen badge={off ? undefined : st.smoothing[0]!.toUpperCase() + st.smoothing.slice(1)}>
          {flat && media && canAnalyse(media) && (
            <div className="picture-motion">
              {p.motionJob ? (
                <>
                  <p className="hint">Working out the shake from the picture… {Math.round(p.motionJob.progress * 100)}%</p>
                  <div className="flow-progress"><span style={{ width: `${Math.round(p.motionJob.progress * 100)}%` }} /></div>
                  <div className="row-buttons"><button onClick={p.onCancelPictureMotion}>Cancel</button></div>
                </>
              ) : motionFromPicture(media) && analysed(media, clip.inUs, clip.outUs) ? (
                <>
                  <p className="hint">{p.motionNote ?? 'The shake was worked out from the picture (the camera recorded no motion data).'}</p>
                  <div className="row-buttons"><button className="link" title="Back to no stabilization for this file" onClick={p.onForgetPictureMotion}>Forget it</button></div>
                </>
              ) : (
                <>
                  <p className="hint">{p.motionNote ?? 'This clip has no motion data from the camera. The shake can be worked out from the picture instead: it takes about as long as playing the clip, once.'}</p>
                  <div className="row-buttons"><button className="primary" disabled={p.motionBusy} onClick={p.onPictureMotion}>{motionFromPicture(media) ? 'Work out this part too' : 'Stabilize from the picture'}</button></div>
                </>
              )}
            </div>
          )}
          <Seg<Smoothing>
            value={st.smoothing}
            locked={noMotion}
            options={[['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['custom', 'Custom'], ...(flat ? [] : [['locked', 'Locked'] as [Smoothing, string]])]}
            onChange={(v) => setStab({ smoothing: v }, 'stab')}
          />
          <Slider
            label="Strength"
            value={sigmaToPos(sigma)}
            min={0}
            max={1}
            step={0.001}
            locked={noMotion}
            format={() => fmtSigma(sigma)}
            units={{ to: (u) => posToSigma(u), from: (n) => sigmaToPos(n), digits: 2 }}
            hint="Smoothing window in seconds: how much of the camera's motion is averaged away. Moving this switches to Custom."
            onChange={(u) => setStab({ smoothing: 'custom', strength: +posToSigma(u).toFixed(3) }, 'stab-strength')}
          />
          {flat && media?.camera.stabilizedInCamera && <p className="hint">The camera already stabilized this while recording{media.camera.stabilization && media.camera.stabilization !== 'N/A' ? ` (${media.camera.stabilization})` : ''}, so it starts Off here. Doing it twice can look wobbly.</p>}
          {flat ? <p className="hint">Low removes vibration and small bumps, Medium smooths shake, High keeps only slow turns. The picture is cropped to hide its moving edges (see Crop).</p> : <>
          <p className="hint">
            Low removes vibration and small bumps, Medium smooths shake, High keeps only slow turns. Locked keeps the view pointing the
            same way no matter how the camera turns. Presets: Low {fmtSigma(SMOOTHING_SIGMA_S.low)}, Medium {fmtSigma(SMOOTHING_SIGMA_S.medium)}, High {fmtSigma(SMOOTHING_SIGMA_S.high)}.
          </p>
          </>}
          {is360 && !media?.stabilizer.hasOrientation && <p className="hint">{stitched ? 'A stitched 360 video: any stabilization is already built into the picture. It has no motion data, so it can’t be changed here.' : 'This clip has no motion data (GPMF), so stabilization is unavailable.'}</p>}
        </Section>
    ),
    'Crop': flat && (
        <Section title="Crop" defaultOpen badge={(stabOn || levelOn) && shown < look.fov - 0.2 ? `${Math.round((1 - shown / look.fov) * 100)}%` : undefined}>
          <Seg value={st.crop ?? 'auto'} locked={cropLock} options={[['auto', 'Automatic'], ['manual', 'Manual']]} onChange={(v) => setStab({ crop: v }, 'crop-mode')} />
          {(st.crop ?? 'auto') === 'auto' ? <>
            <Slider label="Crop speed" locked={cropLock || (st.cropSpeed === 0 && 'One crop is used for the whole clip, so it never changes. Untick “Same crop for the whole clip” first.')} value={st.cropSpeed || DEFAULT_CROP.cropSpeed} min={0.3} max={8} step={0.1} reset={DEFAULT_CROP.cropSpeed} format={secs} units={SEC} hint="How long the zoom takes to change. Longer is calmer but crops more." onChange={(v) => setStab({ cropSpeed: v }, 'crop-speed')} />
            <Slider label="Maximum crop" locked={cropLock} value={st.maxCrop ?? DEFAULT_CROP.maxCrop} min={0.02} max={0.8} step={0.01} reset={DEFAULT_CROP.maxCrop} units={PCT} format={pct} hint="The most it may zoom in. Where the shake needs more, it is stabilized a little less instead." onChange={(v) => setStab({ maxCrop: v }, 'crop-max')} />
            <label className="check"><input type="checkbox" disabled={!!cropLock} checked={st.cropSpeed === 0} onChange={(e) => setStab({ cropSpeed: e.target.checked ? 0 : DEFAULT_CROP.cropSpeed }, 'crop-fixed')} /> Same crop for the whole clip</label>
          </> : <Slider label="Crop" locked={cropLock} value={st.cropAmount ?? DEFAULT_CROP.cropAmount} min={0.01} max={0.6} step={0.01} reset={DEFAULT_CROP.cropAmount} units={PCT} format={pct} hint="How much of the view is given up. Edges never show: with too little crop, hard shake is stabilized less." onChange={(v) => setStab({ cropAmount: v }, 'crop-amount')} />}
          <label className="check">
            <input type="checkbox" disabled={!!rollLock} checked={st.rolling === true && !rollLock} onChange={(e) => setStab({ rolling: e.target.checked }, 'rolling')} />
            Fix rolling shutter wobble
            {rollLock && <Lock reason={rollLock} />}
          </label>
        </Section>
    ),
    'Horizon': (
        <Section title="Horizon" badge={st.horizon && !off ? 'Level' : undefined}>
          <label className="check">
            <input type="checkbox" disabled={!!noGravity} checked={st.horizon} onChange={(e) => setStab({ horizon: e.target.checked }, 'horizon')} />
            {flat ? 'Level horizon (removes roll)' : 'Level horizon (removes roll and tilt)'}
            {noGravity && <Lock reason={noGravity} />}
          </label>
          {flat && st.horizon && !noGravity && (shot && shot.level < 0.97
            ? <><p className="hint">Not fully level here: that would need more zoom than Maximum crop allows ({Math.round((st.maxCrop ?? DEFAULT_CROP.maxCrop) * 100)}%).</p>
              {(st.crop ?? 'auto') === 'auto' && <div className="row-buttons"><button onClick={() => setStab({ maxCrop: 0.7 }, 'crop-max')}>Allow more crop</button></div>}</>
            : <p className="hint">Leaning the camera needs room at the corners, so the picture zooms in (see Crop). Looking up and down is left as filmed.</p>)}
        </Section>
    ),
    'Presets': (
        <Section title="Presets" actions={<button className="link" onClick={() => p.onGrade({ ...NEUTRAL_GRADE, lutMix: g.lutMix }, 'reset-grade')}>Reset</button>}>
          <div className="chips">
            {Object.keys(GRADE_PRESETS).map((name) => (
              <button key={name} onClick={() => p.onGrade({ ...gradeFromPreset(name), lutMix: g.lutMix }, `grade-preset-${name}`)}>{name}</button>
            ))}
          </div>
        </Section>
    ),
    'Input color': (
        <Section title="Input color" badge={p.media && resolvedInput(p.media, clip) !== 'standard' ? inputName(resolvedInput(p.media, clip)).replace(/[ ,(].*/, '') : undefined}>
          <div className="field-row">
            <span>Recorded as</span>
            <select aria-label="Input color" value={clip.inputColor ?? 'auto'} onChange={(e) => p.onClip({ inputColor: e.target.value === 'auto' ? undefined : (e.target.value as InputChoice) }, 'input-color')}>
              {INPUT_NAMES.map(([k, name]) => <option key={k} value={k}>{k === 'auto' && p.media ? `Auto: ${inputName(autoInput(p.media.color, p.media.camera)).replace(/ \(.*/, '')}` : name}</option>)}
            </select>
          </div>
          {p.media && ['gplog', 'gplog2', 'flat', 'hlg'].includes(resolvedInput(p.media, clip)) && (
            <>
              <label className="check"><input type="checkbox" checked={wideColor(p.media, clip)} onChange={(e) => p.onClip({ wideColor: e.target.checked }, 'wide-color')} /> Wide colors (Rec.2020)</label>
              <p className="hint">Turned into normal color before everything below. Highlights are kept: lower Exposure or Highlights to bring them back.{p.media.color && p.media.color.bits > 8 ? ' This clip is 10-bit; it is decoded as 8-bit and everything after that is done more precisely.' : ''}</p>
            </>
          )}
          {p.media && resolvedInput(p.media, clip) === 'raw' && <p className="hint">The camera’s values as recorded, for a LUT made for this camera (load it under LUT). Without one the picture looks flat or dark.</p>}
          {p.media && resolvedInput(p.media, clip) === 'standard' && p.media.camera.colorProfile === 'FLAT' && <p className="hint">Recorded in GoPro’s Flat profile and shown as recorded. Choose “Flat / Protune” to turn it into full-contrast color.</p>}
        </Section>
    ),
    'Lens match': <LensMatchSection {...p} />,
    'Light': (
        <Section title="Light" defaultOpen>
          <Slider label="Exposure" value={g.exposure} min={-8} max={4} reset={0} units={EV} keyed={keyed} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`} toggle={sw('grade.exposure')} onChange={(v) => p.onGrade({ exposure: v }, 'exposure')} />
          <Slider label="Contrast" value={g.contrast} min={-1} max={1} reset={0} keyed={keyed} units={PCT} format={signed} toggle={sw('grade.contrast')} onChange={(v) => p.onGrade({ contrast: v }, 'contrast')} />
          <Slider label="Highlights" value={g.highlights} min={-1} max={1} reset={0} keyed={keyed} units={PCT} format={signed} toggle={sw('grade.highlights')} onChange={(v) => p.onGrade({ highlights: v }, 'highlights')} />
          <Slider label="Shadows" value={g.shadows} min={-1} max={1} reset={0} keyed={keyed} units={PCT} format={signed} toggle={sw('grade.shadows')} onChange={(v) => p.onGrade({ shadows: v }, 'shadows')} />
          <Slider label="Fade" value={g.fade} min={0} max={1} reset={0} keyed={keyed} units={PCT} format={pct} toggle={sw('grade.fade')} onChange={(v) => p.onGrade({ fade: v }, 'fade')} />
        </Section>
    ),
    'Color': (
        <Section title="Color">
          <Slider label="Temperature" value={g.temperature} min={-1} max={1} reset={0} keyed={keyed} units={PCT} format={signed} toggle={sw('grade.temperature')} onChange={(v) => p.onGrade({ temperature: v }, 'temperature')} />
          <Slider label="Tint" value={g.tint} min={-1} max={1} reset={0} keyed={keyed} units={PCT} format={signed} toggle={sw('grade.tint')} onChange={(v) => p.onGrade({ tint: v }, 'tint')} />
          <Slider label="Saturation" value={g.saturation} min={-1} max={1} reset={0} keyed={keyed} units={PCT} format={signed} toggle={sw('grade.saturation')} onChange={(v) => p.onGrade({ saturation: v }, 'saturation')} />
          <Slider label="Vibrance" value={g.vibrance} min={-1} max={1} reset={0} keyed={keyed} units={PCT} format={signed} toggle={sw('grade.vibrance')} onChange={(v) => p.onGrade({ vibrance: v }, 'vibrance')} />
        </Section>
    ),
    'Detail': (
        <Section title="Detail">
          <Slider label="Sharpen" value={g.sharpen} min={0} max={3} reset={0} keyed={keyed} units={PCT} format={pct} toggle={sw('grade.sharpen')} onChange={(v) => p.onGrade({ sharpen: v }, 'sharpen')} />
          <Slider label="Vignette" value={g.vignette} min={0} max={1} reset={0} keyed={keyed} units={PCT} format={pct} toggle={sw('grade.vignette')} onChange={(v) => p.onGrade({ vignette: v }, 'vignette')} />
        </Section>
    ),
    'LUT': (
        <Section title="LUT" badge={p.lutPath ? baseName(p.lutPath) : undefined}>
          <div className="row-buttons">
            <button onClick={p.onLoadLut}>{p.lutPath ? 'Change LUT…' : 'Load .cube LUT…'}</button>
            {p.lutPath && <button onClick={p.onClearLut}>Remove</button>}
          </div>
          {p.lutPath && (
            <>
              <p className="hint">{baseName(p.lutPath)} (shared by all clips)</p>
              <Slider label="LUT strength" value={g.lutMix} min={0} max={1} reset={1} keyed={keyed} units={PCT} format={pct} toggle={sw('grade.lutMix')} onChange={(v) => p.onGrade({ lutMix: v }, 'lutMix')} />
            </>
          )}
        </Section>
    ),
    'Match clips': (
        <Section title="Match clips">
          <div className="row-buttons"><button onClick={p.onGradeToAll}>Apply this color to all clips</button></div>
        </Section>
    ),
    'Motion blur (ND filter)': (
        <Section title="Motion blur (ND filter)" defaultOpen badge={look.motionBlur ? blurLabel(look.motionBlur, media?.fps ?? 30) : undefined}>
          <Slider label="Amount" value={look.motionBlur} min={0} max={1} step={1 / 7} reset={0} keyed={keyed} units={PCT} format={() => blurLabel(look.motionBlur, media?.fps ?? 30)} toggle={sw('motionBlur')} onChange={(v) => p.onLook({ motionBlur: v }, 'blur')} />
          <p className="hint">
            Blends consecutive frames like a slow shutter behind an ND filter: smooth, cinematic motion. Visible during playback and in
            exports; a paused frame shows no blur. Works best on 50/60 fps footage.
          </p>
        </Section>
    ),
    'Speed & lens': (
        <Section title="Speed & lens" badge={['zoomBlur' as const, 'chroma' as const].some((k) => look.fx[k] > 0) ? 'On' : undefined} actions={<button className="link" onClick={() => p.onLook({ fx: NO_EFFECTS }, 'fx-reset')}>Reset</button>}>
          {fxSlider('zoomBlur', 'Zoom blur', 'Radial blur streaking out from the centre — a sense of speed.')}
          {fxSlider('chroma', 'Colour fringe', 'Chromatic aberration: red/blue edges towards the corners, like a cheap lens.')}
        </Section>
    ),
    'Film & light': (
        <Section title="Film & light" badge={['glow' as const, 'leak' as const, 'grain' as const, 'bars' as const, 'bloom' as const, 'halation' as const].some((k) => look.fx[k] > 0) ? 'On' : undefined}>
          {fxSlider('glow', 'Glow', 'Soft light blooming out of bright areas — sun, sky, reflections.')}
          {fxSlider('bloom', 'Bloom', 'Wide, soft light spreading from the brightest parts of the picture.')}
          {fxSlider('halation', 'Halation', 'A red-orange fringe round bright edges, like light scattering inside film.')}
          {fxSlider('leak', 'Light leak', 'Warm light drifting in from the edges, like old film.')}
          {fxSlider('grain', 'Film grain', 'Moving film grain, strongest in the mid-tones.')}
          {fxSlider('bars', 'Cinema bars', 'Black bars top and bottom for a widescreen look.')}
        </Section>
    ),
    'Glitch & tape': (
        <Section title="Glitch & tape" badge={['vhs' as const, 'shake' as const, 'rgbSplit' as const].some((k) => look.fx[k] > 0) ? 'On' : undefined}>
          {fxSlider('vhs', 'VHS', 'Old video tape: wobbling lines, smeared colour, scan lines and a rolling glitch.')}
          {fxSlider('rgbSplit', 'RGB split', 'Red and blue pulled apart sideways.')}
          {fxSlider('shake', 'Camera shake', 'Handheld shake added to the picture (zooms in a little so no edge shows).')}
        </Section>
    ),
    'Color wheels': <WheelsSection {...grading} />,
    'Color curves': <CurvesSection {...grading} />,
    'Qualifier': <QualifierSection {...grading} />,
    'Noise reduction': <NoiseSection {...grading} />,
    'Film looks': <FilmSection {...grading} />,
    'Quick looks': (
        <Section title="Quick looks">
          <div className="chips">
            {FX_PRESETS.map(([name, v]) => (
              <button key={name} onClick={() => p.onLook({ fx: { ...NO_EFFECTS, ...v } }, `fx-preset-${name}`)}>{name}</button>
            ))}
          </div>
        </Section>
    ),
    'Smooth & sharp': media && (
        <Section title="Smooth & sharp" badge={enhanceOn(clip.enhance) ? 'AI' : undefined}>
          <EnhanceControls clip={clip} media={media} onClip={p.onClip} onRetry={p.onRetryCopy} />
        </Section>
    ),
    'Speed': (
        <Section title="Speed" defaultOpen badge={ramp ? 'Ramp' : clip.speed !== 1 ? fmtSpeed(clip.speed) : undefined}>
        <Slider label={ramp ? 'Speed here' : 'Speed'} keyed={ramp && !!speedPoint} value={Math.log2(speedNow)} min={Math.log2(MIN_SPEED)} max={Math.log2(MAX_SPEED)} step={0.01} reset={0} format={() => fmtSpeed(speedNow)} units={{ to: (v) => 2 ** v, from: (n) => Math.log2(Math.max(MIN_SPEED, n)), digits: 2 }} hint={ramp ? 'Changes the point at the playhead, or adds one there. Double-click for normal speed.' : 'Double-click for normal speed'} onChange={(v) => setSpeed(Math.abs(v) < 0.04 ? 1 : +(2 ** v).toFixed(3), 'speed')} />
        <div className="chips">
          {[0.25, 0.5, 1, 2, 4, 8].map((s) => <button key={s} className={Math.abs(speedNow - s) < 0.005 ? 'on' : ''} onClick={() => setSpeed(s, 'speed-preset')}>{s}×</button>)}
        </div>
        {fps >= 50 && !ramp && (
          <div className="row-buttons"><button title="Plays every recorded picture, at 30 a second" onClick={() => p.onSpeed({ speed: cleanSpeed(fps, 30), ...(clip.muteBelow === undefined ? { muteBelow: 0.5 } : {}) }, 'slowmo')}>Use as slow motion ({fmtSpeed(cleanSpeed(fps, 30))})</button></div>
        )}
        {media && <p className="hint">Recorded at {Math.round(fps)} pictures a second: smooth down to {fmtSpeed(cleanSpeed(fps, 30))} in a 30 fps video{fps >= 50 ? `, ${fmtSpeed(cleanSpeed(fps, 60))} in a 60 fps one` : ''}. {clip.enhance?.smooth ? 'Slower than that, Smooth slow motion (below) makes the pictures in between.' : <>Slower than that, pictures repeat{fps * speedRange(clip).min < 23.5 ? ` (this clip goes down to ${Math.max(1, Math.round(fps * speedRange(clip).min))} different pictures a second)` : ''}. Smooth slow motion (below) can make the pictures in between.</>}</p>}
        <div className="chips">
          {RAMP_PRESETS.map(([k, name, hint]) => <button key={k} title={`${hint}. Replaces the speed of the whole clip.`} onClick={() => p.onSpeed({ speedKeys: rampPreset(k, clip, p.mediaUs, media ? Math.min(0.5, cleanSpeed(fps, 30)) : 0.5), ...(clip.muteBelow === undefined ? { muteBelow: 0.5 } : {}) }, `ramp-${k}`)}>{name}</button>)}
        </div>
        <div className="row-buttons">
          {speedPoint
            ? <button onClick={() => p.onSpeed(removeSpeedKey(clip, speedPoint.id), 'speeddel')}>Delete point</button>
            : <button title="Adds a point to the ramp at the playhead" onClick={() => p.onSpeed({ speedKeys: setSpeedKey(clip, p.mediaUs), ...(ramp || clip.muteBelow !== undefined ? {} : { muteBelow: 0.5 }) }, 'speedadd')}>Add point here</button>}
          {ramp && <button title="Back to one speed for the whole clip" onClick={() => p.onSpeed({ speedKeys: undefined, speed: 1 }, 'ramp-off')}>Remove ramp</button>}
        </div>
        {ramp && stretch && (
          <div className="field-row">
            <span>Change from {fmtTime(localAt(clip, stretch.t) + clipStart)}</span>
            <Seg value={stretch.ease ?? 'smooth'} options={[['smooth', 'Eased'], ['linear', 'Even'], ['jump', 'Jump']]} onChange={(v) => p.onSpeed({ speedKeys: setSpeedEase(clip.speedKeys!, stretch.id, v) }, 'speed-ease')} />
          </div>
        )}
        {hasSound && <Slider label="Mute below" value={clip.muteBelow ?? 0} min={0} max={1} step={0.05} reset={0.5} format={(v) => (v > 0 ? fmtSpeed(v) : 'Never')} units={{ digits: 2 }} hint="Silences this clip’s sound where it plays slower than this." onChange={(v) => p.onSpeed({ muteBelow: v > 0.001 ? +v.toFixed(2) : 0 }, 'mute-below')} />}
        {hasSound && <label className="check" title="Off: sound plays faster or slower like a tape, higher or deeper"><input type="checkbox" checked={clip.keepPitch !== false} onChange={(e) => p.onSpeed({ keepPitch: e.target.checked ? undefined : false }, 'keep-pitch')} /> Keep the sound’s pitch</label>}
        <label className="check"><input type="checkbox" checked={p.speedLines} onChange={p.onSpeedLines} /> Show speed lines on the timeline</label>
      </Section>
    ),
    'Highlights': media ? (
      <HighlightsSection
        clip={clip} media={media} clipStartUs={clipStart} clipCount={p.clipCount} onSeekMedia={p.onSeekMedia} onMark={p.onAddMarkers}
        onReel={p.layerTrack ? null : (pieces) => p.onAppendClips(pieces, `highlight${pieces.length === 1 ? '' : 's'} from ${media.name}`)}
        onReelAll={p.layerTrack ? null : p.onReelAll} marks={p.jumpMarks} onMarks={p.onJumpMarks}
      />
    ) : null,
    'Airtime': media?.telemetry.hasAccel ? (() => {
      const set = { ...DEFAULT_AIRTIME, ...clip.airtime };
      const jumps = media.telemetry.jumps(clip.airtime ?? {}).filter((j) => j.startUs >= clip.inUs && j.startUs < clip.outUs);
      const st = airtimeStats(jumps);
      const sec = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
      // What the length setting leaves out, so moving it visibly does something.
      const shorter = media.telemetry.jumps({ below: set.below, minMs: 1 }).filter((j) => j.airMs < set.minMs && j.startUs >= clip.inUs && j.startUs < clip.outUs);
      const longestLeftOut = shorter.reduce((a, j) => Math.max(a, j.airMs), 0);
      return (
        <Section title="Airtime" badge={jumps.length ? `${jumps.length} jump${jumps.length === 1 ? '' : 's'}` : undefined}>
          {jumps.length ? (
            <>
              <div className={`air-stats${st.farthestM !== undefined ? ' four' : ''}`}>
                <span><b>{sec(st.longestMs)}</b>longest</span>
                {st.farthestM !== undefined && <span title="Ground speed × time in the air, from the camera’s GPS"><b>{fmtJumpLength(st.farthestM)}</b>farthest</span>}
                <span><b>{sec(st.totalMs)}</b>in the air</span>
                <span><b>{st.hardestG.toFixed(1)} G</b>hardest landing</span>
              </div>
              {st.farthestM === undefined && <p className="hint">{media.telemetry.hasGps ? 'Jump distances need GPS during the jumps.' : 'The camera had no GPS position in this clip, so how far each jump went can’t be worked out.'}</p>}
              <div className={`air-list${st.farthestM !== undefined ? ' dist' : ''}`}>
                {jumps.map((j, i) => (
                  <button key={j.startUs} className="air-row" title="Go to this jump" onClick={() => p.onSeekMedia(j.startUs)}>
                    <span>Jump {i + 1}</span><span className="muted">{fmtTime(mediaToTimeline(clipStart, clip, j.startUs))}</span><b>{sec(j.airMs)}</b>{st.farthestM !== undefined && <span title={j.speedMs !== undefined ? `At ${(j.speedMs * 3.6).toFixed(0)} km/h (${(j.speedMs * 2.23694).toFixed(0)} mph)` : 'No GPS here'}>{j.distanceM !== undefined ? fmtJumpLength(j.distanceM) : '–'}</span>}<span className="muted">{j.landingG.toFixed(1)} G</span>
                  </button>
                ))}
              </div>
            </>
          ) : <p className="hint">No jumps found in this clip. If it has some, raise “In the air below” or lower “Ignore jumps shorter than”.</p>}
          <Slider label="In the air below" value={set.below} min={0.1} max={0.8} step={0.05} reset={DEFAULT_AIRTIME.below} format={(v) => `${v.toFixed(2)} G`} units={{ digits: 2 }} hint="In the air, the camera reads close to 0 G; on the ground about 1 G. Readings below this count as airtime." onChange={(v) => p.onClip({ airtime: { ...clip.airtime, below: +v.toFixed(2) } }, 'air-below')} />
          <Slider label="Ignore jumps shorter than" value={set.minMs / 1000} min={0.05} max={1} step={0.01} reset={DEFAULT_AIRTIME.minMs / 1000} format={(v) => `${v.toFixed(2)} s`} units={{ digits: 2 }} hint="Moments in the air shorter than this (a bump, a small hop) aren’t counted as jumps. Raise it to keep only the big jumps." onChange={(v) => p.onClip({ airtime: { ...clip.airtime, minMs: Math.round(v * 1000) } }, 'air-min')} />
          <p className="hint air-left-out">{shorter.length
            ? `Not counted: ${shorter.length} shorter moment${shorter.length === 1 ? '' : 's'} in the air (up to ${sec(longestLeftOut)}).`
            : 'Nothing in this clip is left out by this setting.'}</p>
          <Slider label="Join jumps closer than" value={set.joinMs / 1000} min={0} max={1} step={0.01} reset={DEFAULT_AIRTIME.joinMs / 1000} format={(v) => `${v.toFixed(2)} s`} units={{ digits: 2 }} hint="Moving on the bike mid-air can lift the reading for a moment, splitting one jump in two. Parts of a jump closer together than this count as one jump." onChange={(v) => p.onClip({ airtime: { ...clip.airtime, joinMs: Math.round(v * 1000) } }, 'air-join')} />
          <label className="check" title="A jump where the reading doesn’t get that low, but drops and then spikes on landing (over 2.5 G), also counts."><input type="checkbox" checked={set.shape} onChange={(e) => p.onClip({ airtime: { ...clip.airtime, shape: e.target.checked } }, 'air-shape')} /> Also count dips that end in a hard landing</label>
          <label className="check"><input type="checkbox" checked={p.jumpMarks} onChange={p.onJumpMarks} /> Show jumps on the timeline</label>
        </Section>
      );
    })() : null,
    'Audio': (
        <Section title="Audio" badge={!hasSound ? 'No sound' : clip.audioDetached ? 'Detached' : undefined}>
        {!hasSound && <p className="hint">This clip has no sound.</p>}
        {hasSound && !clip.audioDetached && (
          <>
            <Slider label="Clip volume" value={clip.volume} min={0} max={1.5} reset={1} units={PCT} format={pct} onChange={(v) => p.onClip({ volume: v }, 'volume')} />
            {!p.layerTrack && <div className="row-buttons"><button onClick={p.onDetachAudio} title="Move this clip's sound to the audio track">Detach audio</button></div>}
            {!p.layerTrack && <p className="hint">Detaching puts the sound on its own track so you can move, trim and fade it separately from the video.</p>}
          </>
        )}
        {hasSound && (
          <label className="check" title="While this clip plays, every other clip playing at the same time is silent (music keeps playing). Useful to hear a clip on V2–V6 on its own.">
            <input type="checkbox" checked={!!clip.soloSound} onChange={(e) => p.onClip({ soloSound: e.target.checked || undefined }, 'solo')} /> Solo sound: mute the other clips while this one plays
          </label>
        )}
        {hasSound && clip.audioDetached && (
          <>
            <p className="hint">This clip’s sound is on the audio track. Click it there to edit it.</p>
            <div className="row-buttons"><button onClick={() => p.onReattachAudio(clip.id)}>Reattach audio</button></div>
          </>
        )}
      </Section>
    ),
    'Sound tools': hasSound && !clip.audioDetached && (
        <Section title="Sound tools" badge={clip.sound?.voice ? 'Talking' : isNeutralSound(clip.sound) ? undefined : 'On'}>
          <SoundTools sound={clip.sound} onSound={(sound, key) => p.onClip({ sound }, key)} />
        </Section>
    ),
    'Transform': <TransformSection p={p} look={look} keyed={keyed} picture={!is360 && clip.fit !== 'fill'} />,
    'Masks': <MasksSection p={p} clip={clip} />,
    'Layout': (
      <Section title="Layout" defaultOpen>
        <p className="hint">Places the clips on screen at the playhead: the main row first, then V2, V3… {p.layersHere < 2 ? 'Add clips over the main row (Media ▸ layers button, E, or drag onto the row above the main row) to fill the other places.' : `${p.layersHere} clips are on screen here.`}</p>
        <div className="layout-grid">
          {LAYOUT_TEMPLATES.map((l) => (
            <button key={l.id} className="layout-pick" title={l.label} aria-label={l.label} onClick={() => p.onLayout(l.id)}>
              <svg viewBox="0 0 32 18" aria-hidden>
                <rect x="0.5" y="0.5" width="31" height="17" rx="1.5" className="layout-frame" />
                {l.cells.slice(0, l.id === 'full' ? 1 : undefined).map(([x, y, w, h], i) => (
                  <rect key={i} x={x * 32 + 1} y={y * 18 + 1} width={Math.max(1, w * 32 - 2)} height={Math.max(1, h * 18 - 2)} rx="1" className={i === 0 ? 'layout-main' : 'layout-cell'} />
                ))}
              </svg>
            </button>
          ))}
        </div>
      </Section>
    ),
    'Trim': (
        <Section title="Trim">
        <p className="hint">Uses {fmtTime(clip.inUs)} → {fmtTime(clip.outUs)} of {fmtTime(media?.durationUs ?? clip.outUs)}. Drag the clip’s edges on the timeline to trim, or split at the playhead.</p>
        <div className="row-buttons">
          <button onClick={p.onSplit}>Split at playhead (S)</button>
          <button onClick={p.onDuplicate}>Duplicate</button>
        </div>
        <div className="row-buttons">
          <button onClick={() => p.onMove(-1)} disabled={!!p.layerTrack || p.clipIndex === 0}>← Move earlier</button>
          <button onClick={() => p.onMove(1)} disabled={!!p.layerTrack || p.clipIndex === p.clipCount - 1}>Move later →</button>
        </div>
        <div className="row-buttons"><button className="danger" onClick={p.onDelete}>Delete clip (⌫)</button></div>
      </Section>
    ),
  };
}

/** Masks: shapes that blur, pixelate or hide part of the picture; keyframed on their own; can follow the tracked subject. */
function MasksSection({ p, clip }: { p: InspectorProps; clip: TimelineClip }) {
  const masks = clip.masks ?? [];
  const m = masks.find((x) => x.id === p.maskSel) ?? null;
  const t = p.mediaUs;
  const put = (next: Mask[], key: string) => p.onMasks(next, key);
  const change = (id: string, f: (m: Mask) => Mask, key: string) => put(masks.map((x) => (x.id === id ? f(x) : x)), `${key}:${id}`);
  const pose = m ? maskPoseAt(m, t) : null;
  const setPose = (patch: Partial<MaskPose>, k: string) => m && change(m.id, (x) => setMaskPose(x, t, patch), `mask-${k}`);
  const keyHere = m?.keys.find((k) => Math.abs(k.t - t) <= 20_000);
  const add = (shape: MaskShape) => {
    const made = newMask(shape, 'blur');
    put([...masks, made], 'mask-add');
    p.onMaskSel(made.id);
  };
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const full = masks.length >= MAX_MASKS;
  const names: Record<string, string> = { blur: 'Blur', pixelate: 'Pixelate', hide: 'Hide', grade: 'Color' };
  const win = m?.grade ?? NEUTRAL_WINDOW;
  const setWin = (patch: Partial<WindowGrade>, k: string) => m && change(m.id, (x) => ({ ...x, grade: { ...(x.grade ?? NEUTRAL_WINDOW), ...patch } }), `mask-win-${k}`);
  return (
    <Section title="Masks" badge={masks.length ? String(masks.length) : undefined}>
      <div className="row-buttons">
        <button disabled={full} onClick={() => add('rect')} title="A rectangle in the middle of the picture: drag it on the preview">+ Rectangle</button>
        <button disabled={full} onClick={() => add('ellipse')} title="An ellipse in the middle of the picture: drag it on the preview">+ Ellipse</button>
        <button disabled={full} className={p.drawingMask ? 'on' : ''} onClick={p.onDrawMask} title="Draw round what to cover on the preview">{p.drawingMask ? 'Drawing… (Esc)' : '+ Draw'}</button>
      </div>
      {full && <p className="hint">A clip can have {MAX_MASKS} masks.</p>}
      {masks.length > 0 && (
        <div className="mask-list">
          {masks.map((x, i) => (
            <div key={x.id} className={`mask-row${x.id === p.maskSel ? ' selected' : ''}${x.off ? ' off' : ''}`} onClick={() => p.onMaskSel(x.id === p.maskSel ? null : x.id)}>
              <span>Mask {i + 1} · {names[x.effect]}{x.follow ? ' · follows' : ''}{x.keys.length ? ` · ${x.keys.length} key${x.keys.length === 1 ? '' : 's'}` : ''}</span>
              <button className="link" title={x.off ? 'Turn this mask on' : 'Turn this mask off'} onClick={(e) => { e.stopPropagation(); change(x.id, (y) => ({ ...y, off: !y.off || undefined }), 'mask-off'); }}>{x.off ? 'Off' : 'On'}</button>
              <button className="link danger" aria-label={`Delete mask ${i + 1}`} title="Delete this mask" onClick={(e) => { e.stopPropagation(); put(masks.filter((y) => y.id !== x.id), 'mask-del'); if (x.id === p.maskSel) p.onMaskSel(null); }}>✕</button>
            </div>
          ))}
        </div>
      )}
      {!masks.length && <p className="hint">Blur a face or a number plate, pixelate it, hide it, or give it its own color (a power window). Add a shape, then drag it on the preview and scroll to resize it. Turn on “Follow subject” to keep it on a tracked rider.</p>}
      {m && pose && (
        <>
          <Seg value={m.effect} options={MASK_EFFECTS} onChange={(e) => change(m.id, (x) => ({ ...x, effect: e, ...(e === 'grade' && !x.grade ? { grade: { ...NEUTRAL_WINDOW, exposure: 0.5 }, amount: 1, feather: Math.max(x.feather, 0.06) } : {}) }), 'mask-effect')} />
          {m.effect === 'grade' && (
            <>
              <p className="hint">A power window: its own color inside the shape, like brightening a face or darkening the sky.</p>
              <Slider label="Exposure" value={win.exposure} min={-3} max={3} reset={0} units={EV} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`} onChange={(v) => setWin({ exposure: v }, 'exp')} />
              <Slider label="Contrast" value={win.contrast} min={-1} max={1} reset={0} units={PCT} format={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`} onChange={(v) => setWin({ contrast: v }, 'con')} />
              <Slider label="Saturation" value={win.saturation} min={-1} max={1} reset={0} units={PCT} format={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`} onChange={(v) => setWin({ saturation: v }, 'sat')} />
              <Slider label="Temperature" value={win.temperature} min={-1} max={1} reset={0} units={PCT} format={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`} onChange={(v) => setWin({ temperature: v }, 'temp')} />
            </>
          )}
          <Slider label={m.effect === 'hide' ? 'Opacity' : 'Strength'} value={pose.amount} min={0} max={1} reset={0.8} keyed={!!keyHere} units={PCT} format={pct} onChange={(v) => setPose({ amount: v }, 'amount')} />
          {m.effect === 'hide' && <label className="field">Colour <input type="color" value={m.color} onChange={(e) => change(m.id, (x) => ({ ...x, color: e.target.value }), 'mask-color')} /></label>}
          <Slider label="Width" value={pose.w} min={0.01} max={1.5} step={0.001} reset={0.25} keyed={!!keyHere} units={PCT} format={pct} onChange={(v) => setPose({ w: v }, 'w')} />
          <Slider label="Height" value={pose.h} min={0.01} max={1.5} step={0.001} reset={0.25} keyed={!!keyHere} units={PCT} format={pct} onChange={(v) => setPose({ h: v }, 'h')} />
          <Slider label="Turn" value={pose.rotate} min={-180} max={180} step={0.1} reset={0} keyed={!!keyHere} units={DEG} format={(v) => `${v.toFixed(1)}°`} onChange={(v) => setPose({ rotate: v }, 'rotate')} />
          <Slider label="Soft edge" value={pose.feather} min={0} max={0.2} step={0.001} reset={0.01} keyed={!!keyHere} units={PCT} format={pct} hint="How gradually the effect fades out at the edge." onChange={(v) => setPose({ feather: v }, 'feather')} />
          <Slider label="Grow / shrink" value={pose.expand} min={-0.1} max={0.1} step={0.001} reset={0} keyed={!!keyHere} units={PCT} format={pct} hint="Makes the shape bigger (right) or smaller (left) all round." onChange={(v) => setPose({ expand: v }, 'expand')} />
          <label className="check"><input type="checkbox" checked={m.invert} onChange={(e) => change(m.id, (x) => ({ ...x, invert: e.target.checked }), 'mask-invert')} /> Everything outside the shape</label>
          <label className="check" title={clip.track ? 'The mask moves with the subject tracked in Subject tracking' : 'Track a subject first (Reframe ▸ Subject tracking)'}>
            <input type="checkbox" checked={m.follow} disabled={!clip.track && !m.follow} onChange={(e) => p.onMaskFollow(m.id, e.target.checked)} /> Follow subject
          </label>
          {m.follow && clip.track && (
            <label className="check"><input type="checkbox" checked={clip.track.steer !== false} onChange={(e) => p.onTrackPatchSteer(e.target.checked)} /> The view follows the subject too</label>
          )}
          {!clip.track && <p className="hint">To follow someone, track them first: Reframe ▸ Subject tracking, or right-click the clip ▸ Track subject.</p>}
          <div className="row-buttons">
            {keyHere
              ? <button onClick={() => change(m.id, (x) => removeMaskKey(x, keyHere.id), 'mask-unkey')}>Delete keyframe</button>
              : <button onClick={() => change(m.id, (x) => addMaskKey(x, t), 'mask-key')} title="Keyframe this mask here: then move the playhead and change it to animate it">Add keyframe</button>}
            {m.keys.length > 0 && <button className="link" onClick={() => change(m.id, (x) => ({ ...x, ...pose, keys: [] }), 'mask-clearkeys')}>Clear {m.keys.length}</button>}
          </div>
        </>
      )}
    </Section>
  );
}

/** Where the clip sits in the frame: position, size, crop, turn, opacity, corners, border, shadow. Keyframed with the look. */
function TransformSection({ p, look, keyed, picture }: { p: InspectorProps; look: Look; keyed: boolean; picture: boolean }) {
  const xf = xfOf(look);
  const set = (patch: Partial<Transform>, k: string) => p.onLook({ xf: cleanXf({ ...xf, ...patch }) }, `xf-${k}`);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const crop = (i: number) => (v: number) => { const c = [...xf.crop] as Transform['crop']; c[i] = v; set({ crop: c }, `crop${i}`); };
  const moved = !isIdentityXf(look.xf);
  return (
    <Section title="Transform" badge={moved ? 'On' : undefined} actions={moved ? <button className="link" onClick={() => p.onLook({ xf: undefined }, 'xf-reset')} title="Back to the whole frame">Reset</button> : undefined}>
      <Slider label="Position across" value={xf.x} min={-1} max={1} step={0.001} reset={0} keyed={keyed} units={PCT} format={pct} hint="Left ← → right, as a share of the frame's width. Double-click to centre." onChange={(v) => set({ x: v }, 'x')} />
      <Slider label="Position up/down" value={xf.y} min={-1} max={1} step={0.001} reset={0} keyed={keyed} units={PCT} format={pct} hint="Up ← → down, as a share of the frame's height. Double-click to centre." onChange={(v) => set({ y: v }, 'y')} />
      <Slider label="Size" value={Math.log2(xf.scale)} min={-4} max={2} step={0.005} reset={0} keyed={keyed} format={() => pct(xf.scale)} units={{ to: (v) => 2 ** v * 100, from: (n) => Math.log2(Math.max(2, n) / 100), digits: 0 }} hint={picture ? '100% is as big as fits in the frame. Double-click for 100%.' : '100% fills the frame. Double-click for 100%.'} onChange={(v) => set({ scale: Math.abs(v) < 0.01 ? 1 : 2 ** v }, 'scale')} />
      <Slider label="Turn" value={xf.rotate} min={-180} max={180} step={0.1} reset={0} keyed={keyed} units={DEG} format={(v) => `${v.toFixed(1)}°`} hint="Turns the picture (degrees). Double-click for straight." onChange={(v) => set({ rotate: v }, 'rotate')} />
      <Slider label="Opacity" value={xf.opacity} min={0} max={1} reset={1} keyed={keyed} units={PCT} format={pct} onChange={(v) => set({ opacity: v }, 'opacity')} />
      <p className="subhead">Crop</p>
      {picture && <p className="hint">A share of the video cut from each side.</p>}
      {(['Left', 'Top', 'Right', 'Bottom'] as const).map((n, i) => (
        <Slider key={n} label={n} value={xf.crop[i]!} min={0} max={0.9} reset={0} keyed={keyed} units={PCT} format={pct} onChange={crop(i)} />
      ))}
      <p className="subhead">Frame</p>
      <Slider label="Rounded corners" value={xf.radius} min={0} max={0.5} reset={0} keyed={keyed} units={PCT} format={pct} hint="0% = square corners, 50% = fully round (a circle on a square picture)." onChange={(v) => set({ radius: v }, 'radius')} />
      <Slider label="Border" value={xf.border} min={0} max={0.05} step={0.0005} reset={0} keyed={keyed} units={{ to: (v) => v * 1000, from: (n) => n / 1000, digits: 1 }} format={(v) => (v ? `${(v * 1000).toFixed(1)}‰` : 'None')} hint="Width of the line round the picture, as a share of the frame's height." onChange={(v) => set({ border: v }, 'border')} />
      {xf.border > 0 && (
        <label className="field">Border colour <input type="color" value={xf.borderColor} onChange={(e) => set({ borderColor: e.target.value }, 'bcolor')} /></label>
      )}
      <Slider label="Shadow" value={xf.shadow} min={0} max={1} reset={0} keyed={keyed} units={PCT} format={pct} onChange={(v) => set({ shadow: v }, 'shadow')} />
      {!moved && <p className="hint">{picture ? 'The video is as big as fits in the frame. Drag it on the preview to move it, scroll or pinch to size it, or change these. Add a keyframe (K) to animate it.' : 'The clip fills the frame. Use Layout for picture in picture or split screen, or change these to place it yourself. Add a keyframe (K) to animate it.'}</p>}
    </Section>
  );
}

function PanelHeader({ title, sub, onClose }: { title: string; sub: string; onClose: () => void }) {
  return (
    <div className="clip-title">
      <div className="clip-title-text">
        <b>{title}</b>
        <span className="muted">{sub}</span>
      </div>
      <button className="icon" title="Back to the clip (Esc)" onClick={onClose}>✕</button>
    </div>
  );
}

function AudioPanel(p: InspectorProps & { audio: AudioClip }) {
  const a = p.audio;
  const linked = a.linkedClipId ? p.timeline.clips.find((c) => c.id === a.linkedClipId) : null;
  return (
    <aside className="inspector">
      <PanelHeader title={`♪ ${baseName(a.path)}`} sub={linked ? 'Detached clip audio' : 'Music'} onClose={p.onCloseSelection} />
      <div className="tab-body">
        <SectionList list="sel:audio" sections={{ 'Volume & fades': (
        <Section title="Volume & fades" defaultOpen>
          <Slider label="Volume" value={a.volume} min={0} max={2} reset={linked ? 1 : 0.8} units={PCT} format={pct} onChange={(v) => p.onAudio({ volume: v }, 'm-vol')} />
          <Slider label="Fade in" value={a.fadeInUs / 1e6} min={0} max={10} step={0.1} reset={0} format={secs} units={SEC} onChange={(v) => p.onAudio({ fadeInUs: v * 1e6 }, 'm-fi')} />
          <Slider label="Fade out" value={a.fadeOutUs / 1e6} min={0} max={10} step={0.1} reset={linked ? 0 : 1.5} format={secs} units={SEC} onChange={(v) => p.onAudio({ fadeOutUs: v * 1e6 }, 'm-fo')} />
          <p className="hint">Drag it on the timeline to move it, or drag its edges to trim. It stops where the video ends.</p>
        </Section>
        ), 'Sound tools': (
        <Section title="Sound tools" badge={a.sound?.duck ? 'Ducking' : isNeutralSound(a.sound) ? undefined : 'On'}>
          <SoundTools sound={a.sound} music={!linked} hasVoiceClips={[...p.timeline.clips, ...p.timeline.connected, ...p.timeline.audio].some((c) => c.sound?.voice)} onSound={(sound, key) => p.onAudio({ sound }, key)} />
        </Section>
        ) }} />
        <div className="row-buttons">
          {linked && <button onClick={() => p.onReattachAudio(linked.id)}>Reattach to clip</button>}
          <button className="danger" onClick={p.onRemoveSelected}>{linked ? 'Delete audio' : 'Remove music'}</button>
        </div>
      </div>
    </aside>
  );
}

function TransitionPanel(p: InspectorProps & { clip: TimelineClip; transition: Transition }) {
  const t = p.transition;
  const i = p.timeline.clips.findIndex((c) => c.id === p.clip.id);
  const effective = transitionUs(p.timeline, i);
  return (
    <aside className="inspector">
      <PanelHeader title="Transition" sub={`Into clip ${i + 1}`} onClose={p.onCloseSelection} />
      <div className="tab-body">
        <SectionList
          list="sel:transition"
          sections={{
            ...Object.fromEntries(TRANSITION_GROUPS.map(([group, list]) => [group, (
          <Section title={group} defaultOpen={list.some(([k]) => k === t.kind)} badge={list.find(([k]) => k === t.kind)?.[1]}>
            <div className="tr-grid">
              {list.map(([k, label]) => <TransitionTile key={k} kind={k} label={label} on={t.kind === k} onPick={() => p.onTransition({ kind: k }, 'tr-kind')} />)}
            </div>
          </Section>
            )])),
            'Transition timing': (
        <Section title="Timing" id="Transition timing" defaultOpen badge={secs(t.durationUs / 1e6)}>
          <Slider label="Duration" value={t.durationUs / 1e6} min={0.1} max={4} step={0.05} reset={1} format={secs} units={SEC} onChange={(v) => p.onTransition({ durationUs: Math.round(v * 1e6) }, 'tr-dur')} />
          {effective + 1000 < t.durationUs && <p className="hint">Limited to {secs(effective / 1e6)} because a transition can use at most half of either clip.</p>}
          <p className="hint">The two clips overlap for the length of the transition, so the edit gets that much shorter.</p>
        </Section>
            ),
          }}
        />
        <div className="row-buttons"><button className="danger" onClick={p.onRemoveSelected}>Remove transition</button></div>
      </div>
    </aside>
  );
}

function OverlayPanel(p: InspectorProps & { overlay: Overlay }) {
  const o = p.overlay;
  const isText = o.kind === 'text';
  const gauge = GAUGES.find(([k]) => k === o.kind)?.[1];
  const hasUnits = o.kind === 'speed' || o.kind === 'altitude' || o.kind === 'distance' || o.kind === 'jumpdist';
  const total = Math.max(1, timelineDuration(p.timeline) / 1e6);
  const colour = (label: string, key: 'color' | 'accent' | 'bgColor' | 'outlineColor') => (
    <label className="field">
      {label}
      <input type="color" value={o[key]} onChange={(e) => p.onOverlay({ [key]: e.target.value }, `ov-${key}`)} />
    </label>
  );
  return (
    <aside className="inspector">
      <PanelHeader title={isText ? 'Text' : gauge ?? 'Overlay'} sub={`${fmtTime(o.startUs)} → ${fmtTime(o.endUs)}`} onClose={p.onCloseSelection} />
      <div className="tab-body">
        <SectionList
          list={isText ? 'sel:text' : 'sel:gauge'}
          sections={{
            'Text': isText && (
            <Section title="Text" defaultOpen>
              <textarea className="text-input" rows={3} value={o.text} onChange={(e) => p.onOverlay({ text: e.target.value }, 'ov-text')} placeholder="Type your text" />
              {titleTemplate(o.title)?.hasSubtitle && (
                <label className="field">Second line
                  <input value={o.subtitle ?? ''} placeholder="(none)" onChange={(e) => p.onOverlay({ subtitle: e.target.value }, 'ov-subtitle')} />
                </label>
              )}
              {o.title ? (
                <p className="hint">Words in braces are filled in from the ride: {'{gps}'}, {'{alt}'}, {'{date}'}, {'{time}'}, {'{speed}'}.</p>
              ) : (
                <div className="chips">
                  {TEXT_PRESETS.map(([name, patch]) => (
                    <button key={name} onClick={() => p.onOverlay(patch, `ov-preset-${name}`)}>{name}</button>
                  ))}
                </div>
              )}
            </Section>
            ),
            'Motion title': isText && (
            <Section title="Motion title" badge={titleTemplate(o.title)?.name}>
              <TitlePicker o={o} onPick={(id) => { p.onOverlay(applyTitleTemplate(o, id), 'ov-title'); if (id) p.onPreviewAt(o.startUs); }} />
              <p className="hint">Titles move in and out by themselves, in your colours and font. Point at one to see it move.</p>
            </Section>
            ),
            'Text path': isText && !o.title && (
            <Section title="Text path" badge={o.path ? TEXT_PATHS.find(([k]) => k === o.path!.kind)?.[1] : undefined}>
              <TextPathControls o={o} onPath={(path, key) => p.onOverlay({ path }, key)} />
            </Section>
            ),
            'Font': isText && (
            <Section title="Font" badge={FONTS.find(([k]) => k === o.font)?.[1]}>
              <div className="font-grid">
                {FONTS.map(([k, label]) => (
                  <button key={k} className={o.font === k ? 'on' : ''} style={{ fontFamily: FONT_STACK[k], fontWeight: k === 'heavy' ? 900 : undefined }} onClick={() => p.onOverlay({ font: k }, 'ov-font')}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="field-row">
                <label className="check"><input type="checkbox" checked={o.bold} onChange={(e) => p.onOverlay({ bold: e.target.checked }, 'ov-bold')} /> Bold</label>
                <label className="check"><input type="checkbox" checked={o.italic} onChange={(e) => p.onOverlay({ italic: e.target.checked }, 'ov-italic')} /> Italic</label>
                <label className="check"><input type="checkbox" checked={o.uppercase} onChange={(e) => p.onOverlay({ uppercase: e.target.checked }, 'ov-upper')} /> CAPITALS</label>
              </div>
              <Seg value={o.align} options={[['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]} onChange={(v) => p.onOverlay({ align: v }, 'ov-align')} />
              <Slider label="Size" value={o.size} min={0.02} max={0.6} step={0.005} reset={0.08} units={PCT} format={pct} onChange={(v) => p.onOverlay({ size: v }, 'ov-size')} />
              <Slider label="Spacing" value={o.tracking} min={-0.1} max={0.6} step={0.005} reset={0} units={PCT} format={pct} onChange={(v) => p.onOverlay({ tracking: v }, 'ov-track')} />
            </Section>
            ),
            'Colour & effect': isText && (
            <Section title="Colour & effect">
              <div className="field-row">
                {colour('Text', 'color')}
                {colour('Outline', 'outlineColor')}
                {o.title && colour('Accent', 'accent')}
                {colour(o.title ? 'Panel' : 'Box', 'bgColor')}
              </div>
              {o.title && <Slider label="Panel opacity" value={o.bgOpacity} min={0} max={1} reset={titleTemplate(o.title)?.patch.bgOpacity ?? 0.45} units={PCT} format={pct} onChange={(v) => p.onOverlay({ bgOpacity: v }, 'ov-bgop')} />}
              <Slider label="Outline" value={o.outline} min={0} max={0.2} step={0.002} reset={0} units={PCT} format={pct} onChange={(v) => p.onOverlay({ outline: v }, 'ov-outline')} />
              <Seg value={o.background} options={[['none', 'Plain'], ['shadow', 'Shadow'], ['glow', 'Glow'], ['box', 'Box']]} onChange={(v) => p.onOverlay({ background: v }, 'ov-bg')} />
              {o.background === 'box' && <Slider label="Box opacity" value={o.bgOpacity} min={0} max={1} reset={0.45} units={PCT} format={pct} onChange={(v) => p.onOverlay({ bgOpacity: v }, 'ov-bgop')} />}
            </Section>
            ),
            'Look': !isText && (
            <Section title="Look" defaultOpen>
              <GaugeLookPicker o={o} onPick={(design, style) => p.onOverlay(lookPatch(design, style), 'ov-look')} />
              <div className="row-buttons"><button title="Gives every gauge this design (each in the closest type it comes in)" onClick={() => p.onGaugeDesignAll(o.design ?? 'classic')}>Use this design for all gauges</button></div>
              {o.kind !== 'timer' && (p.gaugeSources.length > 0 || o.sourceClipId) && (
                <label className="field" title="Which clip’s ride data (speed, G-force, GPS…) the gauge shows">
                  Ride data from
                  <select aria-label="Ride data from" value={o.sourceClipId ?? ''} onChange={(e) => p.onOverlay({ sourceClipId: e.target.value || undefined }, 'ov-source')}>
                    <option value="">The main row (clip under the playhead)</option>
                    {p.gaugeSources.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                    {o.sourceClipId && !p.gaugeSources.some((g) => g.id === o.sourceClipId) && <option value={o.sourceClipId}>A clip that was removed</option>}
                  </select>
                </label>
              )}
              {o.kind === 'spectrum' && (
                <label className="field" title="Which sound the bars move to">
                  Listens to
                  <Seg value={o.listen ?? 'auto'} options={[['auto', 'Music, else clip'], ['music', 'Music'], ['clip', 'Clip sound']]} onChange={(v) => p.onOverlay({ listen: v === 'auto' ? undefined : v }, 'ov-listen')} />
                </label>
              )}
              {(o.kind === 'airtime' || o.kind === 'jumpdist') && <Seg value={o.airShow ?? 'best'} options={[['best', o.kind === 'jumpdist' ? 'Longest' : 'Best'], ['last', 'Last'], ['total', 'Total'], ['running', 'Running total']]} onChange={(v) => p.onOverlay({ airShow: v }, 'ov-air')} />}
              {(o.kind === 'distance' || o.kind === 'airtime' || o.kind === 'jumpdist' || o.kind === 'timer') && <>
                <label className="check" title="Off: the count starts again at every cut in the video under the gauge"><input type="checkbox" checked={!!o.keepCounting} onChange={(e) => p.onOverlay({ keepCounting: e.target.checked || undefined }, 'ov-keepcount')} /> Keep counting across cuts</label>
                <p className="hint">Counts from where the gauge starts on the timeline{o.keepCounting ? ', over the footage shown' : ' and starts again at each cut'}. Cut the gauge (S) to start it again anywhere.</p>
              </>}
              {hasUnits && <Seg value={o.units} options={[['metric', 'Metric'], ['imperial', 'Imperial']]} onChange={(v) => p.onOverlay({ units: v }, 'ov-units')} />}
              <div className="field-row">
                {colour('Text', 'color')}
                {colour('Accent', 'accent')}
                {colour('Background', 'bgColor')}
              </div>
              <Seg value={o.background} options={[['none', 'None'], ['shadow', 'Shadow'], ['box', 'Panel']]} onChange={(v) => p.onOverlay({ background: v }, 'ov-bg')} />
              <Slider label="Bg opacity" value={o.bgOpacity} min={0} max={1} reset={0.45} units={PCT} format={pct} onChange={(v) => p.onOverlay({ bgOpacity: v }, 'ov-bgop')} />
              <Slider label="Size" value={o.size} min={0.03} max={0.6} step={0.005} reset={0.12} units={PCT} format={pct} onChange={(v) => p.onOverlay({ size: v }, 'ov-size')} />
              {o.kind !== 'spectrum' && <label className="field">
                Label
                <input value={o.text} placeholder="(default)" onChange={(e) => p.onOverlay({ text: e.target.value }, 'ov-label')} />
              </label>}
              {o.kind !== 'spectrum' && <div className="font-grid compact">
                {FONTS.map(([k, label]) => (
                  <button key={k} className={o.font === k ? 'on' : ''} style={{ fontFamily: FONT_STACK[k] }} onClick={() => p.onOverlay({ font: k }, 'ov-font')}>{label}</button>
                ))}
              </div>}
              <p className="hint">
                {o.kind === 'spectrum' ? 'How strong each pitch is, from deep bass on the left to the highest sounds on the right. Text is the bars’ top colour, Accent their bottom. Pick the look above.'
                  : o.kind === 'timer' ? 'Counts up from when this overlay starts.'
                  : o.kind === 'clock' ? 'Time of day from the camera’s clock.'
                  : o.kind === 'sound' ? 'How loud the clip’s own sound is, in decibels. Camera microphones aren’t calibrated, so it’s an estimate: a quiet room reads about 40 dB, loud wind or an engine about 90–100 dB.'
                  : o.kind === 'jumpdist' ? 'How far each jump went: ground speed from the GPS × time in the air. Counts up during the jump and holds it for 3 s after landing; between jumps it shows the longest (or last, or total) so far. How jumps are found is set per clip, under Airtime.'
                  : o.kind === 'airtime' ? 'Counts up while in the air and holds each jump for 3 s after landing; between jumps it shows the best (or last, or total) so far; Running total shows only the total, adding up as you jump. How jumps are found is set per clip, under Airtime.'
                  : 'Shows data from the camera’s GPS / motion sensors for whichever clip is playing. Clips without the data show “--”.'}
              </p>
            </Section>
            ),
            'Position': (
            <Section title="Position">
          <Slider label="Across" value={o.x} min={0} max={1} step={0.001} reset={0.5} units={PCT} format={pct} onChange={(v) => p.onOverlay({ x: v }, 'ov-x')} />
          <Slider label="Down" value={o.y} min={0} max={1} step={0.001} reset={0.5} units={PCT} format={pct} onChange={(v) => p.onOverlay({ y: v }, 'ov-y')} />
          <p className="hint">Or drag it on the preview; scroll over the preview to resize.</p>
        </Section>
            ),
            'Overlay timing': (
            <Section title="Timing" id="Overlay timing">
          {o.title ? (
            <p className="hint">The title moves in at its start and out at its end. <button className="link" onClick={() => p.onPreviewAt(o.startUs)}>Play it</button></p>
          ) : (
            <>
              <Seg value={o.animation} options={o.kind === 'text' ? ANIMATIONS : ANIMATIONS.filter(([a]) => a !== 'typewriter')} onChange={(v) => { p.onOverlay({ animation: v }, 'ov-anim'); if (v !== 'none') p.onPreviewAt(o.startUs); }} />
              <p className="hint">How the {o.kind === 'text' ? 'text' : 'gauge'} appears at its start and leaves at its end. It doesn’t move in between.
                {o.animation !== 'none' && <> <button className="link" onClick={() => p.onPreviewAt(o.startUs)}>Play it</button></>}</p>
            </>
          )}
          <Slider label="Start" value={o.startUs / 1e6} min={0} max={total} step={0.05} format={secs} units={SEC} onChange={(v) => p.onOverlay({ startUs: Math.round(v * 1e6), endUs: Math.round(v * 1e6) + (o.endUs - o.startUs) }, 'ov-start')} />
          <Slider label="Duration" value={(o.endUs - o.startUs) / 1e6} min={0.2} max={total} step={0.05} format={secs} units={SEC} onChange={(v) => p.onOverlay({ endUs: o.startUs + Math.round(v * 1e6) }, 'ov-dur')} />
        </Section>
            ),
          }}
        />
        <div className="row-buttons"><button className="danger" onClick={p.onRemoveSelected}>Delete overlay (⌫)</button></div>
      </div>
    </aside>
  );
}

/** Smooth slow motion and sharper pictures (AI), and how making the copy is going. */
function EnhanceControls(p: { clip: TimelineClip; media: Media; onClip: InspectorProps['onClip']; onRetry: () => void }) {
  const { clip, media } = p;
  useSyncExternalStore(onCopyChange, copyTick);
  const e = clip.enhance ?? {};
  const k = smoothFactor(clip);
  const set = (patch: Partial<Enhance>) => { const next = { ...e, ...patch }; p.onClip({ enhance: next.smooth || next.upscale ? next : undefined }, 'enhance'); };
  const st = copyState(clip);
  const upOk = !media.is360 && canUpscale(media.tracks[0]!.width, media.tracks[0]!.height);
  const size = (u: 2 | 4) => { const s = enhancedSize(media.tracks[0]!.width, media.tracks[0]!.height, { upscale: u }); return `${s.w}×${s.h}`; };
  return (
    <>
      <label className="check" title={k > 1 ? undefined : 'Slow this clip down first (Speed)'}>
        <input type="checkbox" checked={!!e.smooth} disabled={k <= 1 && !e.smooth} onChange={(x) => set({ smooth: x.target.checked || undefined })} /> Smooth slow motion
      </label>
      <p className="hint">{k > 1 ? `Makes in-between frames where this clip plays slowly (up to ${k - 1} for each recorded one), so slow motion flows instead of stuttering.` : 'For clips slowed down under Speed: makes in-between frames so slow motion flows instead of stuttering.'}</p>
      <label className="field">Sharper picture
        <Seg value={String(e.upscale ?? 0)} options={[['0', 'Off'], ['2', '2×'], ['4', '4×']]} onChange={(v) => set({ upscale: v === '0' ? undefined : (Number(v) as 2 | 4) })} />
      </label>
      <p className="hint">{media.is360 ? '360 videos are already big: this is for regular clips.' : upOk ? `Makes the picture bigger and sharper: 2× is ${size(2)}, 4× is ${size(4)} (at most 4K). Good for older or phone clips.` : 'This clip is already 4K, the biggest this makes.'}</p>
      {enhanceOn(clip.enhance) && <ModelNeeded id={e.smooth ? RIFE : ESRGAN} />}
      {e.smooth && e.upscale && <ModelNeeded id={ESRGAN} />}
      {st.state === 'making' && (
        <>
          <p className="hint">Making the improved copy… {Math.round(st.fraction * 100)}%. The preview shows the original until it’s ready; the export waits for it.</p>
          <div className="flow-progress"><span style={{ width: `${Math.round(st.fraction * 100)}%` }} /></div>
        </>
      )}
      {st.state === 'waiting' && <p className="hint">Waiting to be made (one clip at a time).</p>}
      {st.state === 'ready' && <p className="hint">Ready: the preview and the export use it.</p>}
      {st.state === 'failed' && <p className="hint">It couldn’t be made: {st.error} <button className="link" onClick={p.onRetry}>Try again</button></p>}
    </>
  );
}
let copyCount = 0;
const copyTick = () => copyCount;
onCopyChange(() => { copyCount++; });
