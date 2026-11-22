// Editing panels: sections for the clip under the playhead (which the user can move between
// panels), and the settings of the selected overlay, transition or audio.

import type { ReactNode } from 'react';
import { effectiveLens, lensK, MIN_FISHEYE } from '@ace/media360';
import {
  ANIMATIONS, blurLabel, FONTS, clipStarts, DEFAULT_TRACK_EASE_S, DEFAULT_TRACK_LENS, DEFAULT_TRACK_MAX_FOV, MAX_ZOOM_FOV, mediaToTimeline, NO_EFFECTS, trackActive, trackExtent, lookAt, trackHeld, trackRange, trackWeight, GAUGE_STYLES, GAUGES, GRADE_PRESETS, TEXT_PRESETS, gradeFromPreset, keyframeNear, NEUTRAL_GRADE, timelineDuration, TRANSITION_GROUPS, transitionUs,
  type AudioClip, type ClipTrack, type Easing, type Effects, type GaugeKind, type Grade, type Look, type Overlay, type Smoothing, type Timeline, type TimelineClip, type Transition,
} from '@ace/project';
import { CUSTOM_SIGMA_RANGE, SMOOTHING_SIGMA_S } from '@ace/telemetry';
import { baseName } from './api';
import type { Media } from './media';
import { FONT_STACK } from './overlayRender';
import { fmtTime, Lock, Section, SectionList, Seg, Slider, toggleAllSections, type Units } from './ui';
import { Icon } from './ui/Icon';

export interface InspectorProps {
  clip: TimelineClip | null;
  clipIndex: number;
  clipCount: number;
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
  onGradeToAll: () => void;
  onLoadLut: () => void;
  onClearLut: () => void;
  onAudio: (patch: Partial<AudioClip>, key: string) => void;
  onDetachAudio: () => void;
  onReattachAudio: (clipId: string) => void;
  onOverlay: (patch: Partial<Overlay>, key: string) => void;
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
  const start = clipStarts(p.timeline)[p.clipIndex] ?? 0;
  const toT = (t: number) => mediaToTimeline(start, clip, t) / 1e6;
  const toMedia = (s: number) => clip.inUs + (s * 1e6 - start) * clip.speed;
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
        <span className="muted">Clip {p.clipIndex + 1}/{p.clipCount} · {fmtTime(p.mediaUs)}{p.media?.is360 ? ' · 360°' : ''}</span>
      </div>
      <button className="ghost" title="Close all sections (or open them all)" onClick={toggleAllSections}><Icon name="collapse" size={16} /></button>
    </div>
  );
}

/** A panel of sections that edit the clip under the playhead. */
export function InspectorPanel(p: InspectorProps & { panel: string }) {
  if (!p.clip || !p.look) return <aside className="inspector"><p className="empty-panel">Add clips to the timeline to start editing.</p></aside>;
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
  return <aside className="inspector"><p className="empty-panel">Select a text, gauge, transition or sound to edit it here.</p></aside>;
}

/** Every section that edits the clip under the playhead, by id (placed by SectionList). */
function clipSections(p: InspectorProps & { clip: TimelineClip; look: Look }): Record<string, ReactNode> {
  const { clip, look, media } = p;
  const is360 = !!media?.is360;
  const key = keyframeNear(clip.keyframes, p.mediaUs);
  const keyed = !!key;
  const keyCount = clip.keyframes.length;
  const lens = effectiveLens({ fov: look.fov, fisheye: look.fisheye, autoLens: true });
  const g = look.grade;

  // What subject tracking controls at the playhead, and why it can't be changed there.
  const tr = clip.track;
  const range = tr && trackRange(tr);
  const clipStart = clipStarts(p.timeline)[p.clipIndex] ?? 0;
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
  const noZoom = !!tr && !(tr.autoZoom ?? 0) && 'This only matters when the view zooms with the subject. Turn up Auto zoom first.';
  const noMotion = !is360 ? 'Stabilization uses 360 camera motion data, which regular clips don’t have.' : !media?.stabilizer.hasOrientation ? 'This clip has no motion data from the camera, so it can’t be stabilized.' : false;
  const noGravity = !is360 ? 'Leveling the horizon needs a 360 clip.' : !media?.stabilizer.hasGravity ? 'This clip has no gravity data from the camera, so the horizon can’t be found.' : false;

  const keyBar = (
    <div className="keybar">
      <button title="Previous keyframe" onClick={p.onPrevKey} disabled={!keyCount}>◀</button>
      <button className={keyed ? 'on' : ''} title={keyed ? 'Update this keyframe with the current settings' : 'Add a keyframe here (K)'} onClick={p.onAddKeyframe}>◆ {keyed ? 'Keyframe' : 'Add keyframe'}</button>
      <button title="Next keyframe" onClick={p.onNextKey} disabled={!keyCount}>▶</button>
      {keyed && (
        <select value={key!.easing} onChange={(e) => p.onEasing(e.target.value as Easing)} title="How the move into the next keyframe accelerates">
          <option value="smooth">Ease in/out</option>
          <option value="linear">Linear</option>
          <option value="hold">Hold</option>
        </select>
      )}
      <span className="grow" />
      {keyCount > 0 && <button className="link" title="Delete every keyframe in this clip" onClick={p.onClearKeyframes}>Clear {keyCount}</button>}
    </div>
  );
  const start = clipStarts(p.timeline)[p.clipIndex] ?? 0;
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
    const off = !is360 || !media?.stabilizer.hasOrientation;
    const fx = look.fx;
    const set = (k: keyof Effects) => (v: number) => p.onLook({ fx: { ...fx, [k]: v } }, `fx-${k}`);
    const fxSlider = (k: keyof Effects, label: string, hint: string) => (
      <Slider label={label} value={fx[k]} min={0} max={1} reset={0} keyed={keyed} units={PCT} format={pct} hint={hint} onChange={set(k)} />
    );
  const hasSound = !!media?.info.audioTracks.length;
  return {
    'Keyframes': (
        <Section title="Keyframes" badge={keyCount ? `${keyCount}${keyed ? ' · here' : ''}` : undefined}>{keyBar}
          {keyList}
          <p className="hint">{keyCount ? 'Changes now set a keyframe at the playhead. Delete one with its bin, or click its ◆ on the timeline and press ⌫.' : 'Add a keyframe to animate the view, lens and color over time.'}</p>
        </Section>
    ),
    'Subject tracking': is360 && (
        <Section title="Subject tracking" badge={clip.track ? (trackActive(clip.track, p.mediaUs) ? 'Following' : 'On') : undefined}>
          {clip.track ? (
            <>
              <TrackRangeControls {...p} clip={clip} track={clip.track} />
              <Slider label="Auto zoom" value={clip.track.autoZoom ?? 0} min={0} max={1} step={0.01} reset={1} units={PCT} format={pct} hint="Zooms in and out so the subject stays the same size in the frame (0% = off)." onChange={(v) => p.onTrackPatch({ autoZoom: v, subjectFrac: clip.track!.subjectFrac ?? 0.25 }, 'track-zoom')} />
              <Slider label="Subject size" value={clip.track.subjectFrac ?? 0.25} min={0.03} max={0.9} step={0.005} reset={0.25} units={PCT} format={pct} locked={noZoom} hint="How much of the frame width the subject fills when auto zoom is on. Scrolling over the preview changes this too." onChange={(v) => p.onTrackPatch({ subjectFrac: v }, 'track-size')} />
              <Slider label="Auto fisheye" value={clip.track.lens ?? DEFAULT_TRACK_LENS} min={0} max={1} step={0.01} reset={DEFAULT_TRACK_LENS} units={PCT} format={pct} locked={noZoom} hint="Bends the lens as auto zoom goes wide, so the edges don't stretch. 0% keeps the clip's own lens." onChange={(v) => p.onTrackPatch({ lens: v }, 'track-lens')} />
              <Slider label="Widest zoom" value={clip.track.maxFov ?? DEFAULT_TRACK_MAX_FOV} min={50} max={MAX_ZOOM_FOV} step={1} reset={DEFAULT_TRACK_MAX_FOV} units={DEG} format={deg} locked={noZoom} hint="Auto zoom never shows a wider view than this; the subject gets bigger instead." onChange={(v) => p.onTrackPatch({ maxFov: v }, 'track-maxfov')} />
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
              <p className="hint">Drag a box around a person, bike or anything else on the preview: the view follows it from here on. Afterwards you can choose where it starts and stops.</p>
            </>
          )}
        </Section>
    ),
    'View': is360 && (
        <Section title="View" defaultOpen>
          <Slider label="Pan" locked={aimLock('pan')} value={look.yaw} min={-180} max={180} step={0.1} reset={0} format={deg} units={DEG} keyed={keyed} onChange={(v) => p.onLook({ yaw: v }, 'yaw')} />
          <Slider label="Tilt" locked={aimLock('tilt')} value={look.pitch} min={-90} max={90} step={0.1} reset={0} format={deg} units={DEG} keyed={keyed} onChange={(v) => p.onLook({ pitch: v }, 'pitch')} />
          <Slider label="Roll" value={look.roll} min={-180} max={180} step={0.1} reset={0} format={deg} units={DEG} keyed={keyed} onChange={(v) => p.onLook({ roll: v }, 'roll')} />
          <p className="hint">Drag on the preview to look around; scroll to zoom.</p>
        </Section>
    ),
    'Framing': !is360 && (
        <Section title="Framing" defaultOpen>
          <Seg value={clip.fit} options={[['fill', 'Fill frame'], ['fit', 'Fit (bars)']]} onChange={(v) => p.onClip({ fit: v }, 'fit')} />
          <p className="hint">This is a regular (non-360) clip, so view and lens controls don’t apply.</p>
        </Section>
    ),
    'Lens': is360 && (
        <Section title="Lens" badge={`${look.fov.toFixed(0)}°`}>
          <Slider label="Field of view" locked={zoomLock} value={look.fov} min={1} max={360} step={0.5} reset={100} format={deg} units={DEG} keyed={keyed} onChange={(v) => p.onLook({ fov: v }, 'fov')} />
          <Slider label="Fisheye" locked={lensLock} value={look.fisheye} min={MIN_FISHEYE} max={1} step={0.005} reset={0} format={pct} units={PCT} keyed={keyed} onChange={(v) => p.onLook({ fisheye: v }, 'fisheye')} />
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
    'Debug': is360 && (
        <Section title="Debug">
          <label className="check"><input type="checkbox" checked={p.showRaw} onChange={(e) => p.onShowRaw(e.target.checked)} /> Show raw camera streams</label>
        </Section>
    ),
    'Stabilization': (
        <Section title="Stabilization" defaultOpen badge={off ? undefined : st.smoothing[0]!.toUpperCase() + st.smoothing.slice(1)}>
          <Seg<Smoothing>
            value={st.smoothing}
            locked={noMotion}
            options={[['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['custom', 'Custom'], ['locked', 'Locked']]}
            onChange={(v) => p.onClip({ stabilize: { ...st, smoothing: v } }, 'stab')}
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
            onChange={(u) => p.onClip({ stabilize: { ...st, smoothing: 'custom', strength: +posToSigma(u).toFixed(3) } }, 'stab-strength')}
          />
          <p className="hint">
            Low removes vibration and small bumps, Medium smooths shake, High keeps only slow turns. Locked keeps the view pointing the
            same way no matter how the camera turns. Presets: Low {fmtSigma(SMOOTHING_SIGMA_S.low)}, Medium {fmtSigma(SMOOTHING_SIGMA_S.medium)}, High {fmtSigma(SMOOTHING_SIGMA_S.high)}.
          </p>
          {is360 && !media?.stabilizer.hasOrientation && <p className="hint">This clip has no motion data (GPMF), so stabilization is unavailable.</p>}
        </Section>
    ),
    'Horizon': (
        <Section title="Horizon" badge={st.horizon && !off ? 'Level' : undefined}>
          <label className="check">
            <input type="checkbox" disabled={!!noGravity} checked={st.horizon} onChange={(e) => p.onClip({ stabilize: { ...st, horizon: e.target.checked } }, 'horizon')} />
            Level horizon (removes roll and tilt)
            {noGravity && <Lock reason={noGravity} />}
          </label>
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
    'Light': (
        <Section title="Light" defaultOpen>
          <Slider label="Exposure" value={g.exposure} min={-8} max={4} reset={0} units={EV} keyed={keyed} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`} onChange={(v) => p.onGrade({ exposure: v }, 'exposure')} />
          <Slider label="Contrast" value={g.contrast} min={-1} max={1} reset={0} keyed={keyed} units={PCT} format={signed} onChange={(v) => p.onGrade({ contrast: v }, 'contrast')} />
          <Slider label="Highlights" value={g.highlights} min={-1} max={1} reset={0} keyed={keyed} units={PCT} format={signed} onChange={(v) => p.onGrade({ highlights: v }, 'highlights')} />
          <Slider label="Shadows" value={g.shadows} min={-1} max={1} reset={0} keyed={keyed} units={PCT} format={signed} onChange={(v) => p.onGrade({ shadows: v }, 'shadows')} />
          <Slider label="Fade" value={g.fade} min={0} max={1} reset={0} keyed={keyed} units={PCT} format={pct} onChange={(v) => p.onGrade({ fade: v }, 'fade')} />
        </Section>
    ),
    'Color': (
        <Section title="Color">
          <Slider label="Temperature" value={g.temperature} min={-1} max={1} reset={0} keyed={keyed} units={PCT} format={signed} onChange={(v) => p.onGrade({ temperature: v }, 'temperature')} />
          <Slider label="Tint" value={g.tint} min={-1} max={1} reset={0} keyed={keyed} units={PCT} format={signed} onChange={(v) => p.onGrade({ tint: v }, 'tint')} />
          <Slider label="Saturation" value={g.saturation} min={-1} max={1} reset={0} keyed={keyed} units={PCT} format={signed} onChange={(v) => p.onGrade({ saturation: v }, 'saturation')} />
          <Slider label="Vibrance" value={g.vibrance} min={-1} max={1} reset={0} keyed={keyed} units={PCT} format={signed} onChange={(v) => p.onGrade({ vibrance: v }, 'vibrance')} />
        </Section>
    ),
    'Detail': (
        <Section title="Detail">
          <Slider label="Sharpen" value={g.sharpen} min={0} max={3} reset={0} keyed={keyed} units={PCT} format={pct} onChange={(v) => p.onGrade({ sharpen: v }, 'sharpen')} />
          <Slider label="Vignette" value={g.vignette} min={0} max={1} reset={0} keyed={keyed} units={PCT} format={pct} onChange={(v) => p.onGrade({ vignette: v }, 'vignette')} />
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
              <Slider label="LUT strength" value={g.lutMix} min={0} max={1} reset={1} keyed={keyed} units={PCT} format={pct} onChange={(v) => p.onGrade({ lutMix: v }, 'lutMix')} />
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
          <Slider label="Amount" value={look.motionBlur} min={0} max={1} step={1 / 7} reset={0} keyed={keyed} units={PCT} format={() => blurLabel(look.motionBlur, media?.fps ?? 30)} onChange={(v) => p.onLook({ motionBlur: v }, 'blur')} />
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
        <Section title="Film & light" badge={['glow' as const, 'leak' as const, 'grain' as const, 'bars' as const].some((k) => look.fx[k] > 0) ? 'On' : undefined}>
          {fxSlider('glow', 'Glow', 'Soft light blooming out of bright areas — sun, sky, reflections.')}
          {fxSlider('leak', 'Light leak', 'Warm light drifting in from the edges, like old film.')}
          {fxSlider('grain', 'Film grain', 'Moving film grain, strongest in the mid-tones.')}
          {fxSlider('bars', 'Cinema bars', 'Black bars top and bottom for a widescreen look.')}
        </Section>
    ),
    'Quick looks': (
        <Section title="Quick looks">
          <div className="chips">
            {FX_PRESETS.map(([name, v]) => (
              <button key={name} onClick={() => p.onLook({ fx: { ...NO_EFFECTS, ...v } }, `fx-preset-${name}`)}>{name}</button>
            ))}
          </div>
        </Section>
    ),
    'Speed': (
        <Section title="Speed" defaultOpen badge={clip.speed !== 1 ? `${clip.speed}×` : undefined}>
        <Slider label="Speed" value={Math.log2(clip.speed)} min={-2} max={2} step={0.05} reset={0} format={() => `${clip.speed.toFixed(2)}×`} units={{ to: (v) => 2 ** v, from: (n) => Math.log2(n), digits: 2 }} onChange={(v) => p.onClip({ speed: Math.round(2 ** v * 100) / 100 }, 'speed')} />
        <div className="chips">
          {[0.25, 0.5, 1, 2, 4].map((s) => <button key={s} className={clip.speed === s ? 'on' : ''} onClick={() => p.onClip({ speed: s }, 'speed-preset')}>{s}×</button>)}
        </div>
      </Section>
    ),
    'Audio': (
        <Section title="Audio" badge={!hasSound ? 'No sound' : clip.audioDetached ? 'Detached' : undefined}>
        {!hasSound && <p className="hint">This clip has no sound.</p>}
        {hasSound && !clip.audioDetached && (
          <>
            <Slider label="Clip volume" value={clip.volume} min={0} max={1.5} reset={1} units={PCT} format={pct} onChange={(v) => p.onClip({ volume: v }, 'volume')} />
            <div className="row-buttons"><button onClick={p.onDetachAudio} title="Move this clip's sound to the audio track">Detach audio</button></div>
            <p className="hint">Detaching puts the sound on its own track so you can move, trim and fade it separately from the video.</p>
          </>
        )}
        {hasSound && clip.audioDetached && (
          <>
            <p className="hint">This clip’s sound is on the audio track. Click it there to edit it.</p>
            <div className="row-buttons"><button onClick={() => p.onReattachAudio(clip.id)}>Reattach audio</button></div>
          </>
        )}
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
          <button onClick={() => p.onMove(-1)} disabled={p.clipIndex === 0}>← Move earlier</button>
          <button onClick={() => p.onMove(1)} disabled={p.clipIndex === p.clipCount - 1}>Move later →</button>
        </div>
        <div className="row-buttons"><button className="danger" onClick={p.onDelete}>Delete clip (⌫)</button></div>
      </Section>
    ),
  };
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
            <div className="chips">
              {list.map(([k, label]) => (
                <button key={k} className={t.kind === k ? 'on' : ''} onClick={() => p.onTransition({ kind: k }, 'tr-kind')}>{label}</button>
              ))}
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
  const styles = isText ? [] : GAUGE_STYLES[o.kind as GaugeKind];
  const hasUnits = o.kind === 'speed' || o.kind === 'altitude' || o.kind === 'distance';
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
              <div className="chips">
                {TEXT_PRESETS.map(([name, patch]) => (
                  <button key={name} onClick={() => p.onOverlay(patch, `ov-preset-${name}`)}>{name}</button>
                ))}
              </div>
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
                {colour('Box', 'bgColor')}
              </div>
              <Slider label="Outline" value={o.outline} min={0} max={0.2} step={0.002} reset={0} units={PCT} format={pct} onChange={(v) => p.onOverlay({ outline: v }, 'ov-outline')} />
              <Seg value={o.background} options={[['none', 'Plain'], ['shadow', 'Shadow'], ['glow', 'Glow'], ['box', 'Box']]} onChange={(v) => p.onOverlay({ background: v }, 'ov-bg')} />
              {o.background === 'box' && <Slider label="Box opacity" value={o.bgOpacity} min={0} max={1} reset={0.45} units={PCT} format={pct} onChange={(v) => p.onOverlay({ bgOpacity: v }, 'ov-bgop')} />}
            </Section>
            ),
            'Look': !isText && (
            <Section title="Look" defaultOpen>
              {styles.length > 1 && <Seg value={o.style} options={styles} onChange={(v) => p.onOverlay({ style: v }, 'ov-style')} />}
              {hasUnits && <Seg value={o.units} options={[['metric', 'Metric'], ['imperial', 'Imperial']]} onChange={(v) => p.onOverlay({ units: v }, 'ov-units')} />}
              <div className="field-row">
                {colour('Text', 'color')}
                {colour('Accent', 'accent')}
                {colour('Background', 'bgColor')}
              </div>
              <Seg value={o.background} options={[['none', 'None'], ['shadow', 'Shadow'], ['box', 'Panel']]} onChange={(v) => p.onOverlay({ background: v }, 'ov-bg')} />
              <Slider label="Bg opacity" value={o.bgOpacity} min={0} max={1} reset={0.45} units={PCT} format={pct} onChange={(v) => p.onOverlay({ bgOpacity: v }, 'ov-bgop')} />
              <Slider label="Size" value={o.size} min={0.03} max={0.6} step={0.005} reset={0.12} units={PCT} format={pct} onChange={(v) => p.onOverlay({ size: v }, 'ov-size')} />
              <label className="field">
                Label
                <input value={o.text} placeholder="(default)" onChange={(e) => p.onOverlay({ text: e.target.value }, 'ov-label')} />
              </label>
              <div className="font-grid compact">
                {FONTS.map(([k, label]) => (
                  <button key={k} className={o.font === k ? 'on' : ''} style={{ fontFamily: FONT_STACK[k] }} onClick={() => p.onOverlay({ font: k }, 'ov-font')}>{label}</button>
                ))}
              </div>
              <p className="hint">
                {o.kind === 'timer' ? 'Counts up from when this overlay starts.'
                  : o.kind === 'clock' ? 'Time of day from the camera’s clock.'
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
          <Seg value={o.animation} options={ANIMATIONS} onChange={(v) => p.onOverlay({ animation: v }, 'ov-anim')} />
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
