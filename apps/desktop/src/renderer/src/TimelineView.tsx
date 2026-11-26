// The timeline: ruler, overlay track (text & gauges), video tracks V6…V2 (clips placed freely,
// drawn over the main row), the main row V1 (clips and the transitions between them), audio
// track (music and detached clip audio), playhead.
// Drag clip edges to trim, drag a clip to reorder, drag overlays/audio to move them.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from './ui/Icon';
import { MARKER_HEX } from './Markers';
import { analyseBeats, beatsOf, useBeatsVersion } from './musicBeats';
import { usePrefs } from './ui/prefs';
import {
  assignLanes, audioSpan, clipDuration, clipStarts, GAUGES, hasRamp, localAt, mediaAt, mediaToTimeline, speedAt, speedRange, timelineDuration, trackExtent, trackRange, transitionUs, TRANSITIONS,
  snapSpan, snapTargets, snapTime, type SnapTarget, connectedSpan, MAX_TRACKS, trackName, playLength,
  findSequence, sequenceIdOf,
  type ConnectedClip, type Marker, type VideoTrack, type MarkerColor, type Overlay, type Timeline, type TimelineClip,
} from '@ace/project';
import type { Selection } from './App';
import { baseName } from './api';
import { mediaNow, musicNow, type Media } from './media';
import { fmtSpeed, SpeedLine } from './SpeedLine';
import { STRIP_H, STRIP_W, stripPicture, useFilmstrip } from './filmstrip';
import { fmtTime, useDrag } from './ui';
import { fmtJumpLength } from './gaugeMath';

/** Lines a dragged time up with what's nearby (hold ⌘ / Ctrl to drag freely). */
interface Snapper {
  /** `own`: the dragged item's id (it doesn't snap to itself); `noEdges`: ignore clip edges. */
  time(t: number, e: PointerEvent, own?: string, noEdges?: boolean): number;
  /** A block from `start` to `end`: returns the new start. */
  span(start: number, end: number, e: PointerEvent, own?: string): number;
}

export type EditTool = 'select' | 'roll' | 'slip' | 'slide';

interface Props {
  timeline: Timeline;
  time: number;
  playing: boolean;
  selectedClipId: string | null;
  selection: Selection;
  onSeek: (T: number) => void;
  onSelectClip: (id: string) => void;
  onSelect: (s: Selection) => void;
  /** Open (creating if needed) the transition into this clip. */
  onTransition: (clipId: string) => void;
  /** Live trim (media times). */
  onTrimClip: (id: string, inUs: number, outUs: number) => void;
  /** Change which part of a clip's subject track is used (media times). */
  onTrackRange: (id: string, from: number, to: number, edge: 'from' | 'to') => void;
  /** The keyframe picked on the timeline. */
  keyframe: { clipId: string; id: string } | null;
  onKeyframe: (clipId: string, id: string) => void;
  /** Dragged to a media time. */
  onMoveKeyframe: (clipId: string, id: string, t: number) => void;
  onKeyframeMenu: (clipId: string, id: string, x: number, y: number) => void;
  /** Show the speed line on every clip (it always shows on clips with a ramp). */
  speedLines: boolean;
  /** Mark the jumps (airtime) found in each clip. */
  jumpMarks: boolean;
  /** The speed point picked on the timeline. */
  speedPoint: { clipId: string; id: string } | null;
  onSpeedPoint: (clipId: string, id: string) => void;
  onMoveSpeedPoint: (clipId: string, id: string, t: number, speed: number) => void;
  onAddSpeedPoint: (clipId: string, t: number) => void;
  onSpeed: (clipId: string, speed: number) => void;
  onSpeedMenu: (clipId: string, id: string, x: number, y: number) => void;
  onReorderClip: (id: string, toIndex: number) => void;
  onMoveAudio: (id: string, startUs: number, inUs: number, outUs: number) => void;
  onMoveOverlay: (id: string, startUs: number, endUs: number) => void;
  /** A clip on a track above the main row: moved (and maybe to another track), or trimmed. */
  onMoveConnected: (id: string, startUs: number, trackId: string) => void;
  onTrimConnected: (id: string, startUs: number, inUs: number, outUs: number) => void;
  /** Show, lock or mute a track. */
  onTrack: (id: string, patch: Partial<Omit<VideoTrack, 'id'>>) => void;
  onDragEnd: () => void;
  /** What dragging a clip does: Select (trim = ripple, drag = reorder), Roll, Slip, Slide. */
  tool: EditTool;
  /** A roll/slip/slide drag: `d` is µs from where the drag started ('start' first). */
  onProEdit: (kind: 'roll' | 'slip' | 'slide', clipId: string, d: number, phase: 'start' | 'move') => void;
  /** Snap drags to edges, the playhead, markers and beats. */
  snapping: boolean;
  /** Set inside the timeline: lines drags up with things nearby. */
  snap?: Snapper;
  /** Markers: moved (timeline time), changed, removed. */
  onMarker: (id: string, patch: Partial<Omit<Marker, 'id'>>) => void;
  onRemoveMarker: (id: string) => void;
  /** Right-click (two-finger click) on a clip at timeline time T. */
  onClipMenu: (clipId: string, T: number, x: number, y: number) => void;
  /** Double-click on a compound clip: open it. */
  onOpenCompound: (clipId: string) => void;
  /** Pixels per second. */
  pps: number;
  onPps: (f: (v: number) => number) => void;
  /** The timeline's toolbar, above or below the tracks. */
  toolbar?: React.ReactNode;
  toolbarAt: 'top' | 'bottom';
}

const RULER_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const LANE = 26;
/** Overlay rows are slimmer: gauges usually span the whole edit, one row each. */
const OV_LANE = 18;
/** Width of the column of track names and buttons on the left. */
export const HEAD_W = 74;
/** Timeline zoom limits, pixels per second (zoomed out, an hour fits in about 700 pixels). */
export const MIN_PPS = 0.2;
export const MAX_PPS = 400;
/** Height of a video track above the main row: nearly as tall as the main row. */
const vtHeight = (mainH: number) => Math.max(36, Math.round(mainH * 0.85));

export function TimelineView(p: Props) {
  const { timeline: tl } = p;
  const { pps, onPps: setPps } = p;
  usePrefs((x) => x.theme.trackHeight); // redraw when the clip height changes
  const scroller = useRef<HTMLDivElement>(null);
  const videoTrack = useRef<HTMLDivElement>(null);
  const [trackH, setTrackH] = useState(60);
  // The part of the timeline in view (film strips are made only there).
  const [view, setView] = useState({ from: 0, to: 2000 });
  useEffect(() => {
    const el = scroller.current!;
    let raf = 0;
    const look = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setView({ from: el.scrollLeft, to: el.scrollLeft + el.clientWidth })); };
    look();
    el.addEventListener('scroll', look);
    const ro = new ResizeObserver(look);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', look); ro.disconnect(); cancelAnimationFrame(raf); };
  }, []);
  useEffect(() => {
    const ro = new ResizeObserver(() => setTrackH(videoTrack.current!.clientHeight));
    ro.observe(videoTrack.current!);
    return () => ro.disconnect();
  }, []);
  const VT_H = vtHeight(trackH);
  const duration = timelineDuration(tl);
  const starts = clipStarts(tl);
  const width = Math.max(800, (duration / 1e6) * pps + 300);
  const x = (us: number) => (us / 1e6) * pps;

  // --- Snapping ---
  const [guide, setGuide] = useState<number | null>(null);
  const snapRef = useRef<Snapper | null>(null);
  useBeatsVersion();
  useEffect(() => { for (const a of tl.audio) if (!a.linkedClipId) analyseBeats(a.path); });
  const targets: (SnapTarget & { id?: string })[] = [{ t: p.time, kind: 'playhead', id: 'playhead' }];
  starts.forEach((s0, i) => { const c = tl.clips[i]!; targets.push({ t: s0, kind: 'edge', id: c.id }, { t: s0 + clipDuration(c), kind: 'edge', id: c.id }); });
  for (const m of tl.markers) targets.push({ t: m.t, kind: 'marker', id: m.id });
  for (const o of tl.overlays) targets.push({ t: o.startUs, kind: 'item', id: o.id }, { t: o.endUs, kind: 'item', id: o.id });
  for (const c of tl.connected) { const sp = connectedSpan(c); targets.push({ t: sp.start, kind: 'edge', id: c.id }, { t: sp.end, kind: 'edge', id: c.id }); }
  for (const a of tl.audio) {
    const span = audioSpan(tl, a);
    targets.push({ t: span.start, kind: 'item', id: a.id }, { t: span.end, kind: 'item', id: a.id });
    const g = !a.linkedClipId ? beatsOf(a.path) : null;
    if (g) {
      const bars = new Set(g.downbeats);
      g.beats.forEach((b, k) => { const m = b * 1e6; if (m >= a.inUs && m <= a.outUs) targets.push({ t: span.start + localAt(a, m), kind: bars.has(k) ? 'bar' : 'beat', id: a.id }); });
    }
  }
  const reach = (8 / pps) * 1e6;
  const free = (e: PointerEvent) => !p.snapping || e.metaKey || e.ctrlKey;
  const pick = (own?: string, noEdges?: boolean) => snapTargets(targets.filter((t) => t.id !== own && !(noEdges && t.kind === 'edge')));
  const snap: Snapper = {
    time: (t, e, own, noEdges) => { if (free(e)) { setGuide(null); return t; } const r = snapTime(t, pick(own, noEdges), reach); setGuide(r.to ? r.t : null); return r.t; },
    span: (s0, e0, e, own) => { if (free(e)) { setGuide(null); return s0; } const r = snapSpan(s0, e0, pick(own), reach); setGuide(r.to ? r.to.t : null); return r.start; },
  };
  const q: Props = { ...p, snap, onDragEnd: () => { setGuide(null); p.onDragEnd(); } };
  snapRef.current = snap;

  // Fit the whole edit when clips are first added.
  const fitted = useRef(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !duration || fitted.current === tl.clips.length) return;
    fitted.current = tl.clips.length;
    setPps(() => Math.max(MIN_PPS, Math.min(MAX_PPS, ((el.clientWidth - 120 - HEAD_W) / duration) * 1e6)));
  }, [tl.clips.length, duration]);

  // Keep the playhead visible during playback.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !p.playing) return;
    const px = x(p.time);
    if (px < el.scrollLeft + 40 || px > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = px - el.clientWidth * 0.3;
  });

  const seekFromEvent = (clientX: number, e?: PointerEvent) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    const t = ((clientX - r.left + el.scrollLeft - HEAD_W) / pps) * 1e6;
    // Scrubbing the ruler stops on beats and markers, so a split (S) lands on the beat.
    p.onSeek(Math.max(0, Math.min(duration, e ? snapRef.current!.time(t, e, 'playhead', true) : t)));
  };

  const rulerStep = RULER_STEPS.find((s) => s * pps >= 70) ?? 600;
  const ticks: number[] = [];
  for (let s = 0; s <= duration / 1e6 + rulerStep; s += rulerStep) ticks.push(s);

  const ovLanes = assignLanes(tl.overlays, (o) => ({ start: o.startUs, end: o.endUs }));
  const ovRows = Math.max(1, ...[...ovLanes.values()].map((l) => l + 1));
  const auLanes = assignLanes(tl.audio, (a) => audioSpan(tl, a));
  const auRows = Math.max(1, ...[...auLanes.values()].map((l) => l + 1));
  const sel = p.selection;

  return (
    <div className={`timeline tool-${p.tool}`}>
      {p.toolbarAt === 'top' && p.toolbar}
      <div className="timeline-scroll" ref={scroller} onWheel={(e) => {
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); setPps((v) => Math.max(MIN_PPS, Math.min(MAX_PPS, v * Math.exp(-e.deltaY * 0.002)))); }
      }} data-pps={pps} data-head={HEAD_W}>
        <div className="timeline-inner" style={{ width: width + HEAD_W, '--head-w': `${HEAD_W}px` } as CSSProperties}>
          <div className="tl-row ruler-row">
          <div className="track-head corner" />
          <div className="ruler" style={{ '--minor': `${(rulerStep * pps) / (rulerStep === 0.25 || rulerStep >= 60 ? 5 : 4)}px` } as CSSProperties} onPointerDown={(e) => {
            seekFromEvent(e.clientX, e.nativeEvent);
            const move = (ev: PointerEvent) => seekFromEvent(ev.clientX, ev);
            const up = () => { setGuide(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
          }}>
            {tl.markers.map((m) => <MarkerFlag key={m.id} m={m} x={x(m.t)} usPerPx={1e6 / pps} duration={duration} {...q} />)}
            {ticks.map((s) => (
              <span key={s} className="tick" style={{ left: x(s * 1e6) }}>{fmtTime(s * 1e6).slice(0, rulerStep >= 1 ? -3 : rulerStep === 0.25 ? undefined : -1)}</span>
            ))}
          </div>
          </div>

          <div className="tl-row">
          <div className="track-head" title="Titles and gauges"><Icon name="text" size={11} /><span>Titles</span></div>
          <div className="track overlay-track" style={{ height: ovRows * OV_LANE }} onPointerDown={(e) => { if (e.target === e.currentTarget) p.onSelect(null); }}>
            {tl.overlays.length === 0 && <div className="track-empty"><Icon name="text" size={12} />Titles and gauges you add appear here</div>}
            {tl.overlays.map((o) => (
              <OverlayBlock key={o.id} {...q} o={o} lane={ovLanes.get(o.id) ?? 0} left={x(o.startUs)} widthPx={Math.max(8, x(o.endUs - o.startUs))} pps={pps} duration={duration} />
            ))}
          </div>
          </div>

          {tl.clips.length > 0 && tl.tracks.length < MAX_TRACKS && (
            <div className="tl-row">
            <div className="track-head" />
            <div className="track vtrack-add" data-track="new" title="Drag a clip from Media here to put it over the main row (or press E to add the selected one at the playhead)">
              <Icon name="layers" size={11} />{tl.tracks.length ? 'Drop here for a new track' : 'Drag clips here to layer them over the main row (picture in picture, split screen)'}
            </div>
            </div>
          )}
          {[...tl.tracks].reverse().map((t) => (
            <div key={t.id} className="tl-row">
              <div className="track-head vtrack-head" data-track={t.id} onPointerDown={(e) => e.stopPropagation()}>
                <b>{trackName(tl, t.id)}</b>
                <span className="head-buttons">
                <button className={t.hidden ? 'off' : ''} title={t.hidden ? 'Show this track' : 'Hide this track'} aria-label={t.hidden ? `Show ${trackName(tl, t.id)}` : `Hide ${trackName(tl, t.id)}`} onClick={() => p.onTrack(t.id, { hidden: !t.hidden })}><Icon name={t.hidden ? 'eyeoff' : 'eye'} size={12} /></button>
                <button className={t.locked ? 'on' : ''} title={t.locked ? 'Unlock this track' : 'Lock this track (its clips can’t be changed)'} aria-label={t.locked ? `Unlock ${trackName(tl, t.id)}` : `Lock ${trackName(tl, t.id)}`} onClick={() => p.onTrack(t.id, { locked: !t.locked })}><Icon name={t.locked ? 'lock' : 'unlock'} size={12} /></button>
                <button className={t.muted ? 'off' : ''} title={t.muted ? 'Turn this track’s sound on' : 'Mute this track'} aria-label={t.muted ? `Unmute ${trackName(tl, t.id)}` : `Mute ${trackName(tl, t.id)}`} onClick={() => p.onTrack(t.id, { muted: !t.muted })}><Icon name={t.muted ? 'speakeroff' : 'speaker'} size={12} /></button>
                </span>
              </div>
            <div className={`track vtrack${t.hidden ? ' is-hidden' : ''}${t.locked ? ' is-locked' : ''}`} data-track={t.id} style={{ height: VT_H }} onPointerDown={(e) => { if (e.target === e.currentTarget) p.onSelect(null); }}>
              {tl.connected.filter((c) => c.trackId === t.id).map((c) => {
                const sp = connectedSpan(c);
 return <ConnectedBlock key={c.id} {...q} c={c} track={t} left={x(sp.start)} widthPx={Math.max(6, x(sp.end - sp.start))} pps={pps} trackH={VT_H} view={view} />;
              })}
            </div>
            </div>
          ))}

          <div className="tl-row">
          <div className="track-head main-head" title="The main row: clips play one after another"><b>V1</b></div>
          <div className="track video-track" ref={videoTrack} onPointerDown={(e) => { if (e.target === e.currentTarget) seekFromEvent(e.clientX); }}>
            {tl.clips.length === 0 && <div className="track-empty"><Icon name="media" size={14} />Drag clips here from Media, or double-click one</div>}
            {tl.clips.map((c, i) => (
              <ClipBlock key={c.id} {...q} index={i} left={x(starts[i]!)} widthPx={x(clipDuration(c))} pps={pps} startUs={starts[i]!} trackH={trackH} view={view} />
            ))}
            {tl.clips.map((c, i) => {
              if (i === 0) return null;
              const d = transitionUs(tl, i);
              const on = sel?.kind === 'transition' && sel.id === c.id;
              if (c.transitionIn && d > 0) {
                const label = TRANSITIONS.find(([k]) => k === c.transitionIn!.kind)?.[1] ?? '';
                return (
                  <button
                    key={`t${c.id}`}
                    className={`transition-block${on ? ' selected' : ''}`}
                    style={{ left: x(starts[i]!), width: Math.max(14, x(d)) }}
                    title={`${label} · ${(d / 1e6).toFixed(2)}s (click to edit)`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => p.onTransition(c.id)}
                  >
                    ⧉
                  </button>
                );
              }
              return (
                <button
                  key={`t${c.id}`}
                  className="transition-add"
                  style={{ left: x(starts[i]!) }}
                  title="Add a transition between these clips"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => p.onTransition(c.id)}
                >
                  +
                </button>
              );
            })}
          </div>
          </div>

          <div className="tl-row">
          <div className="track-head" title="Music and detached sound"><Icon name="music" size={11} /><span>Audio</span></div>
          <div className="track audio-track" style={{ height: auRows * LANE + 4 }} onPointerDown={(e) => { if (e.target === e.currentTarget) p.onSelect(null); }}>
            {tl.audio.length === 0 && <div className="track-empty"><Icon name="music" size={12} />Music and detached sound go here</div>}
            {tl.audio.map((a) => {
              const span = audioSpan(tl, a);
              return <AudioBlock key={a.id} {...q} id={a.id} lane={auLanes.get(a.id) ?? 0} left={x(span.start)} widthPx={Math.max(8, x(span.end - span.start))} pps={pps} />;
            })}
          </div>
          </div>

          {guide !== null && x(guide) >= view.from - 1 && <div className="snap-guide" style={{ left: HEAD_W + x(guide) }} />}
          {/* (Hidden while it is scrolled under the column of track names.) */}
          <div className="playhead" style={{ left: HEAD_W + x(p.time), visibility: x(p.time) < view.from - 2 ? 'hidden' : undefined }} data-time={fmtTime(p.time)} />
        </div>
      </div>
      {p.toolbarAt === 'bottom' && p.toolbar}
    </div>
  );
}

/** "0.5×", or "0.25–4×" for a ramp ('' at normal speed). */
function speedText(c: Timeline['clips'][number]): string {
  if (!hasRamp(c)) return c.speed === 1 ? '' : fmtSpeed(c.speed);
  const r = speedRange(c);
  return r.max - r.min < 0.005 ? fmtSpeed(r.min) : `${fmtSpeed(r.min).slice(0, -1)}–${fmtSpeed(r.max)}`;
}

/** Pictures along a clip, for the part of it in view. */
function Strip(p: { clip: Timeline['clips'][number]; left: number; widthPx: number; pps: number; height: number; view: { from: number; to: number }; playhead: number }) {
  useFilmstrip();
  const media = mediaNow(p.clip.mediaPath);
  if (!media || p.widthPx < 4) return null;
  const h = Math.max(20, p.height), w = (h * STRIP_W) / STRIP_H;
  const first = Math.max(0, Math.floor((p.view.from - p.left) / w) - 1), last = Math.min(Math.ceil(p.widthPx / w) - 1, Math.ceil((p.view.to - p.left) / w) + 1);
  const tiles = [];
  for (let i = first; i <= last; i++) {
    const local = ((i + 0.5) * w * 1e6) / p.pps, at = Math.min(p.clip.outUs - 1, mediaAt(p.clip, Math.min(local, clipDuration(p.clip) - 1)));
    const x = p.left + (i + 0.5) * w;
    const { url, key } = stripPicture(p.clip, media, at, Math.abs(x - (p.view.from + p.view.to) / 2) + Math.abs(x - p.playhead) * 0.5);
    tiles.push(<i key={i} className="strip-tile" data-key={key} style={{ left: i * w, width: w, backgroundImage: url ? `url(${url})` : undefined }} />);
  }
  return <div className="clip-strip" style={{ height: h }}>{tiles}</div>;
}

function ClipBlock(p: Props & { index: number; left: number; widthPx: number; pps: number; startUs: number; trackH: number; view: { from: number; to: number } }) {
  const c = p.timeline.clips[p.index]!;
  const media = mediaNow(c.mediaPath);
  const compound = findSequence(p.timeline, sequenceIdOf(c));
  const orig = useRef(c);
  const [dragX, setDragX] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const usPerPx = 1e6 / p.pps;

  const prevId = p.timeline.clips[p.index - 1]?.id;
  const trimLeft = useDrag((dx, _dy, e) => {
    const o = orig.current;
    // Roll: the cut before this clip moves; the clip before gives or takes.
    if (p.tool === 'roll' && prevId) { p.onProEdit('roll', prevId, p.snap!.time(p.startUs + dx * usPerPx, e, o.id, true) - p.startUs, 'move'); return; }
    p.onTrimClip(o.id, mediaAt(o, dx * usPerPx), o.outUs);
  }, p.onDragEnd);
  const trimRight = useDrag((dx, _dy, e) => {
    const o = orig.current;
    // (The clips after it move along, so their edges aren't worth lining up with.)
    const end = p.snap!.time(p.startUs + clipDuration(o) + dx * usPerPx, e, o.id, true);
    if (p.tool === 'roll') { p.onProEdit('roll', o.id, end - (p.startUs + clipDuration(o)), 'move'); return; }
    p.onTrimClip(o.id, o.inUs, mediaAt(o, end - p.startUs));
  }, p.onDragEnd);
  // Slip and slide drag the clip body.
  const pro = useDrag((dx, _dy, e) => {
    const o = orig.current;
    if (p.tool === 'slip') p.onProEdit('slip', o.id, -dx * usPerPx * speedAt(o, o.inUs), 'move');
    else p.onProEdit('slide', o.id, p.snap!.time(p.startUs + dx * usPerPx, e, o.id) - p.startUs, 'move');
  }, p.onDragEnd);
  const move = useDrag((dx) => { dragRef.current = dx; setDragX(dx); }, () => {
    const dx = dragRef.current;
    dragRef.current = null;
    if (dx !== null && Math.abs(dx) > 4) {
      // Drop position → index among the other clips' midpoints.
      const centre = p.left + p.widthPx / 2 + dx;
      const starts = clipStarts(p.timeline);
      let idx = 0;
      p.timeline.clips.forEach((o, i) => {
        if (o.id === c.id) return;
        const mid = ((starts[i]! + clipDuration(o) / 2) / 1e6) * p.pps;
        if (centre > mid) idx++;
      });
      p.onReorderClip(c.id, idx);
    }
    setDragX(null);
  });

  return (
    <div
      className={`clip${p.selectedClipId === c.id ? ' selected' : ''}${dragX !== null ? ' dragging' : ''}${media?.is360 ? ' is360' : ''}${compound ? ' compound' : media ? '' : ' offline'}`}
      onDoubleClick={compound ? () => p.onOpenCompound(c.id) : undefined}
      style={{ left: p.left, width: Math.max(6, p.widthPx), zIndex: p.index + 1, transform: dragX !== null ? `translateX(${dragX}px)` : undefined, ...(media?.thumbnail ? ({ '--thumb': `url(${media.thumbnail})` } as CSSProperties) : {}) }}
      onPointerDown={(e) => {
        if (e.button !== 0 || e.ctrlKey) return;
        orig.current = c;
        p.onSelectClip(c.id);
        if (p.tool === 'slip' || p.tool === 'slide') { p.onProEdit(p.tool, c.id, 0, 'start'); pro(e); return; }
        move(e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const T = p.startUs + ((e.clientX - r.left) / p.pps) * 1e6;
        p.onClipMenu(c.id, Math.max(p.startUs, Math.min(p.startUs + clipDuration(c) - 1, T)), e.clientX, e.clientY);
      }}
      title={compound ? `${compound.name} (compound clip) · ${fmtTime(c.inUs)}–${fmtTime(c.outUs)} — double-click to open` : `${baseName(c.mediaPath)} · ${fmtTime(c.inUs)}–${fmtTime(c.outUs)}${speedText(c) ? ` · ${speedText(c)}` : ''}`}
    >
      <Strip clip={c} left={p.left} widthPx={p.widthPx} pps={p.pps} height={p.trackH} view={p.view} playhead={(p.time / 1e6) * p.pps} />
      <div className="clip-label">
        {media?.is360 && <b className="badge">360</b>}
        {speedText(c) && <b className="badge">{speedText(c)}</b>}
        {c.audioDetached && <b className="badge" title="Sound detached to the audio track">♪̸</b>}
        {c.soloSound && <b className="badge" title="Solo sound: other clips are silent while this one plays">Solo</b>}
        {compound && <b className="badge">Compound</b>}
        <span>{compound ? compound.name : baseName(c.mediaPath)}</span>
      </div>
      {!compound && <ClipMarks {...p} clip={c} startUs={p.startUs} widthPx={p.widthPx} trackH={p.trackH} onPick={() => p.onSelectClip(c.id)} />}
      <div className="trim left" onPointerDown={(e) => { orig.current = c; p.onSelectClip(c.id); if (p.tool === 'roll' && prevId) p.onProEdit('roll', prevId, 0, 'start'); trimLeft(e); }} />
      <div className="trim right" onPointerDown={(e) => { orig.current = c; p.onSelectClip(c.id); if (p.tool === 'roll') p.onProEdit('roll', c.id, 0, 'start'); trimRight(e); }} />
    </div>
  );
}

/** A clip on a track above the main row: drag to move it (up or down to change track), drag its edges to trim. */
function ConnectedBlock(p: Props & { c: ConnectedClip; track: VideoTrack; left: number; widthPx: number; pps: number; trackH: number; view: { from: number; to: number } }) {
  const { c } = p;
  const media = mediaNow(c.mediaPath);
  const orig = useRef(c);
  const usPerPx = 1e6 / p.pps;
  const locked = !!p.track.locked;
  const tracks = p.timeline.tracks;
  const move = useDrag((dx, dy, e) => {
    const o = orig.current;
    const len = playLength(o);
    const start = Math.max(0, p.snap!.span(o.startUs + dx * usPerPx, o.startUs + len + dx * usPerPx, e, o.id));
    // Rows are drawn top track first: dragging up goes to a higher track.
    const from = tracks.findIndex((t) => t.id === o.trackId);
    const to = Math.max(0, Math.min(tracks.length - 1, from - Math.round(dy / (p.trackH + 12))));
    p.onMoveConnected(o.id, start, tracks[to]!.id);
  }, p.onDragEnd);
  const trimLeft = useDrag((dx, _dy, e) => {
    const o = orig.current;
    const want = p.snap!.time(o.startUs + dx * usPerPx, e, o.id) - o.startUs;
    // Not before the start of the recording, nor past the end of the clip.
    const d = Math.max(localAt(o, 0), Math.min(want, playLength(o) - 200_000));
    p.onTrimConnected(o.id, Math.max(0, o.startUs + d), Math.max(0, Math.round(mediaAt(o, d))), o.outUs);
  }, p.onDragEnd);
  const trimRight = useDrag((dx, _dy, e) => {
    const o = orig.current;
    const end = p.snap!.time(o.startUs + playLength(o) + dx * usPerPx, e, o.id) - o.startUs;
    const max = media?.durationUs ?? o.outUs;
    p.onTrimConnected(o.id, o.startUs, o.inUs, Math.max(o.inUs + 200_000, Math.min(max, Math.round(mediaAt(o, Math.max(0, end))))));
  }, p.onDragEnd);
  const selected = p.selection?.kind === 'layer' && p.selection.id === c.id;
  const pick = () => { orig.current = c; p.onSelect({ kind: 'layer', id: c.id }); };
  return (
    <div
      className={`clip vclip${selected ? ' selected' : ''}${media?.is360 ? ' is360' : ''}${media ? '' : ' offline'}${locked ? ' locked' : ''}`}
      style={{ left: p.left, width: p.widthPx, ...(media?.thumbnail ? ({ '--thumb': `url(${media.thumbnail})` } as CSSProperties) : {}) }}
      onPointerDown={(e) => { if (e.button !== 0 || e.ctrlKey) return; pick(); if (!locked) move(e); }}
      onContextMenu={(e) => {
        e.preventDefault();
        pick();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        p.onClipMenu(c.id, c.startUs + Math.max(0, Math.min(playLength(c) - 1, ((e.clientX - r.left) / p.pps) * 1e6)), e.clientX, e.clientY);
      }}
      title={`${trackName(p.timeline, c.trackId)} · ${baseName(c.mediaPath)} · ${fmtTime(c.inUs)}–${fmtTime(c.outUs)}${locked ? ' · locked' : ''}`}
    >
      <Strip clip={c} left={p.left} widthPx={p.widthPx} pps={p.pps} height={p.trackH} view={p.view} playhead={(p.time / 1e6) * p.pps} />
      <div className="clip-label">
        {media?.is360 && <b className="badge">360</b>}
        {speedText(c) && <b className="badge">{speedText(c)}</b>}
        {c.soloSound && <b className="badge" title="Solo sound: other clips are silent while this one plays">Solo</b>}
        <span>{baseName(c.mediaPath)}</span>
      </div>
      <ClipMarks {...p} clip={c} startUs={c.startUs} widthPx={p.widthPx} trackH={p.trackH} onPick={pick} />
      {!locked && <div className="trim left" onPointerDown={(e) => { pick(); trimLeft(e); }} />}
      {!locked && <div className="trim right" onPointerDown={(e) => { pick(); trimRight(e); }} />}
    </div>
  );
}

/**
 * What is drawn on a clip besides its pictures: the tracked part, jumps, the speed line and
 * keyframes. The same on the main row and on V2–V6.
 */
function ClipMarks(p: Props & { clip: TimelineClip; startUs: number; widthPx: number; trackH: number; onPick: () => void }) {
  const c = p.clip;
  const media = mediaNow(c.mediaPath);
  const usPerPx = 1e6 / p.pps;
  const kfs = c.keyframes
    .filter((k) => k.t >= c.inUs && k.t <= c.outUs)
    .map((k) => ({ k, x: ((mediaToTimeline(p.startUs, c, k.t) - p.startUs) / 1e6) * p.pps }));
  const kfDrag = useRef<{ id: string; t: number; moved: boolean } | null>(null);
  const dragKf = useDrag((dx) => {
    const d = kfDrag.current;
    if (!d || (!d.moved && Math.abs(dx) < 4)) return; // a click, so far
    d.moved = true;
    p.onMoveKeyframe(c.id, d.id, mediaAt(c, localAt(c, d.t) + dx * usPerPx));
  }, p.onDragEnd);
  return (
    <>
      <TrackBand {...p} />
      {p.jumpMarks && media?.telemetry.hasAccel && <JumpMarks clip={c} media={media} pps={p.pps} startUs={p.startUs} onSeek={p.onSeek} />}
      {(p.speedLines || hasRamp(c)) && (
        <SpeedLine
          snapLocal={(l, e) => p.snap!.time(p.startUs + l, e, c.id, true) - p.startUs}
          clip={c}
          pps={p.pps}
          width={Math.max(6, p.widthPx)}
          height={Math.max(30, p.trackH)}
          selected={p.speedPoint?.clipId === c.id ? p.speedPoint.id : null}
          onSelect={(id) => p.onSpeedPoint(c.id, id)}
          onMenu={(id, x, y) => p.onSpeedMenu(c.id, id, x, y)}
          onPoint={(id, t, sp) => p.onMoveSpeedPoint(c.id, id, t, sp)}
          onAdd={(t) => p.onAddSpeedPoint(c.id, t)}
          onSpeed={(sp) => p.onSpeed(c.id, sp)}
          onGrab={p.onPick}
          onEnd={p.onDragEnd}
        />
      )}
      {kfs.map(({ k, x }) => (
        <button
          key={k.id}
          className={`clip-kf${p.keyframe?.id === k.id ? ' selected' : ''}`}
          style={{ left: Math.max(7, Math.min(p.widthPx - 11, x)) }}
          title={`Keyframe at ${fmtTime(k.t)} — click to go to it, drag to move, ⌫ or right-click to delete`}
          aria-label={`Keyframe at ${fmtTime(k.t)}`}
          onPointerDown={(e) => { if (e.button !== 0 || e.ctrlKey) return; e.stopPropagation(); kfDrag.current = { id: k.id, t: k.t, moved: false }; p.onKeyframe(c.id, k.id); dragKf(e); }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); p.onKeyframeMenu(c.id, k.id, e.clientX, e.clientY); }}
        />
      ))}
    </>
  );
}

/** Jumps in a clip: an arc over each one's time in the air; click to go to its takeoff. */
function JumpMarks({ clip: c, media, pps, startUs, onSeek }: { clip: TimelineClip; media: Media; pps: number; startUs: number; onSeek: (T: number) => void }) {
  const jumps = media.telemetry.jumps(c.airtime ?? {}).filter((j) => j.endUs > c.inUs && j.startUs < c.outUs);
  return (
    <>
      {jumps.map((j) => {
        const a = localAt(c, Math.max(c.inUs, j.startUs)), b = localAt(c, Math.min(c.outUs, j.endUs));
        const left = (a / 1e6) * pps, width = Math.max(6, ((b - a) / 1e6) * pps);
        return (
          <button
            key={j.startUs}
            className="clip-jump"
            style={{ left, width }}
            title={`Jump: ${(j.airMs / 1000).toFixed(2)} s in the air${j.distanceM !== undefined ? `, ${fmtJumpLength(j.distanceM)} long` : ''}, landing ${j.landingG.toFixed(1)} G — click to go there`}
            aria-label={`Jump, ${(j.airMs / 1000).toFixed(2)} seconds`}
            onPointerDown={(e) => { e.stopPropagation(); onSeek(startUs + a); }}
          ><span>{(j.airMs / 1000).toFixed(1)}s</span></button>
        );
      })}
    </>
  );
}

/** The tracked part of a clip: bright = used (drag its ends), dim = tracked but not used. */
function TrackBand(p: Props & { clip: TimelineClip; pps: number; onPick: () => void }) {
  const c = p.clip;
  const r = c.track && trackRange(c.track), e = c.track && trackExtent(c.track);
  const orig = useRef<[number, number]>([0, 0]);
  const by = (t: number, dx: number) => mediaAt(c, localAt(c, t) + (dx * 1e6) / p.pps);
  const left = useDrag((dx) => p.onTrackRange(c.id, Math.min(by(orig.current[0], dx), orig.current[1] - 100_000), orig.current[1], 'from'), p.onDragEnd);
  const right = useDrag((dx) => p.onTrackRange(c.id, orig.current[0], Math.max(by(orig.current[1], dx), orig.current[0] + 100_000), 'to'), p.onDragEnd);
  if (!r || !e) return null;
  const px = (t: number) => (localAt(c, t) / 1e6) * p.pps;
  const span = (a: number, b: number) => {
    const x0 = px(Math.max(c.inUs, a)), x1 = px(Math.min(c.outUs, b));
    return x1 > x0 ? { left: x0, width: Math.max(2, x1 - x0) } : null;
  };
  const all = span(e[0], e[1]), used = span(r[0], r[1]);
  const grab = (drag: (ev: React.PointerEvent) => void) => (ev: React.PointerEvent) => {
    orig.current = [r[0], r[1]];
    ev.stopPropagation();
    p.onPick();
    drag(ev);
  };
  return (
    <>
      {all && <i className="clip-track unused" style={all} />}
      {used && <i className="clip-track" style={used} title="Subject followed here" />}
      {r[0] >= c.inUs && r[0] <= c.outUs && <div className="track-handle start" style={{ left: px(r[0]) }} title={`Following starts ${fmtTime(r[0])} — drag to change`} onPointerDown={grab(left)} />}
      {r[1] >= c.inUs && r[1] <= c.outUs && <div className="track-handle end" style={{ left: px(r[1]) }} title={`Following stops ${fmtTime(r[1])} — drag to change`} onPointerDown={grab(right)} />}
    </>
  );
}

function OverlayBlock(p: Props & { o: Overlay; lane: number; left: number; widthPx: number; pps: number; duration: number }) {
  const o = p.o;
  const orig = useRef(o);
  const usPerPx = 1e6 / p.pps;
  const min = 200_000;
  const move = useDrag((dx, _dy, e) => {
    const v = orig.current;
    const len = v.endUs - v.startUs;
    const s0 = p.snap!.span(v.startUs + dx * usPerPx, v.endUs + dx * usPerPx, e, v.id);
    const s = Math.max(0, Math.min(p.duration - len, s0));
    p.onMoveOverlay(v.id, s, s + len);
  }, p.onDragEnd);
  const trimLeft = useDrag((dx, _dy, e) => {
    const v = orig.current;
    p.onMoveOverlay(v.id, Math.max(0, Math.min(v.endUs - min, p.snap!.time(v.startUs + dx * usPerPx, e, v.id))), v.endUs);
  }, p.onDragEnd);
  const trimRight = useDrag((dx, _dy, e) => {
    const v = orig.current;
    p.onMoveOverlay(v.id, v.startUs, Math.min(p.duration, Math.max(v.startUs + min, p.snap!.time(v.endUs + dx * usPerPx, e, v.id))));
  }, p.onDragEnd);
  const selected = p.selection?.kind === 'overlay' && p.selection.id === o.id;
  const name = o.kind === 'text' ? o.text.split('\n')[0] || 'Text' : GAUGES.find(([k]) => k === o.kind)?.[1] ?? o.kind;
  return (
    <div
      className={`ov-item ${o.kind === 'text' ? 'is-text' : 'is-gauge'}${selected ? ' selected' : ''}`}
      style={{ left: p.left, width: p.widthPx, top: p.lane * OV_LANE, height: OV_LANE - 2 }}
      onPointerDown={(e) => { orig.current = o; p.onSelect({ kind: 'overlay', id: o.id }); move(e); }}
      title={`${name} · ${fmtTime(o.startUs)}–${fmtTime(o.endUs)}`}
    >
      <Icon name={o.kind === 'text' ? 'text' : 'gauge'} size={11} /><span>{name}</span>
      <div className="trim left" onPointerDown={(e) => { orig.current = o; p.onSelect({ kind: 'overlay', id: o.id }); trimLeft(e); }} />
      <div className="trim right" onPointerDown={(e) => { orig.current = o; p.onSelect({ kind: 'overlay', id: o.id }); trimRight(e); }} />
    </div>
  );
}

function AudioBlock(p: Props & { id: string; lane: number; left: number; widthPx: number; pps: number }) {
  const a = p.timeline.audio.find((x) => x.id === p.id)!;
  const music = musicNow.get(a.path);
  const orig = useRef(a);
  const usPerPx = 1e6 / p.pps;
  const max = music?.durationUs ?? a.outUs;
  const move = useDrag((dx, _dy, e) => {
    const o = orig.current;
    const len = localAt(o, o.outUs);
    p.onMoveAudio(o.id, Math.max(0, p.snap!.span(o.startUs + dx * usPerPx, o.startUs + len + dx * usPerPx, e, o.id)), o.inUs, o.outUs);
  }, p.onDragEnd);
  const trimLeft = useDrag((dx, _dy, e) => {
    const o = orig.current;
    const want = p.snap!.time(o.startUs + dx * usPerPx, e, o.id) - o.startUs;
    const d = Math.max(localAt(o, 0), Math.min(want, localAt(o, o.outUs) - 500_000));
    p.onMoveAudio(o.id, Math.max(0, o.startUs + d), Math.max(0, mediaAt(o, d)), o.outUs);
  }, p.onDragEnd);
  const trimRight = useDrag((dx, _dy, e) => {
    const o = orig.current;
    const end = p.snap!.time(o.startUs + localAt(o, o.outUs) + dx * usPerPx, e, o.id) - o.startUs;
    p.onMoveAudio(o.id, o.startUs, o.inUs, Math.max(o.inUs + 500_000, Math.min(max, mediaAt(o, end))));
  }, p.onDragEnd);
  // The music's beats, as ticks (bars taller); only when they're far enough apart to read.
  const grid = !a.linkedClipId ? beatsOf(a.path) : null;
  const ticks: { x: number; bar: boolean }[] = [];
  if (grid) {
    const bars = new Set(grid.downbeats);
    const spacing = (60 / Math.max(1, grid.bpm)) * p.pps;
    grid.beats.forEach((b, k) => {
      const m = b * 1e6;
      if (m < a.inUs || m > a.outUs || (spacing < 6 && !bars.has(k))) return;
      ticks.push({ x: (localAt(a, m) / 1e6) * p.pps, bar: bars.has(k) });
    });
  }
  const selected = p.selection?.kind === 'audio' && p.selection.id === a.id;
  return (
    <div
      className={`music${a.linkedClipId ? ' linked' : ''}${selected ? ' selected' : ''}`}
      style={{ left: p.left, width: p.widthPx, top: p.lane * LANE + 2, height: LANE - 3 }}
      onPointerDown={(e) => { orig.current = a; p.onSelect({ kind: 'audio', id: a.id }); move(e); }}
      title={grid ? `${baseName(a.path)} · ${Math.round(grid.bpm)} BPM` : undefined}
    >
      {ticks.length > 0 && <div className="beat-ticks" aria-hidden>{ticks.map((t, i) => <i key={i} className={t.bar ? 'bar' : ''} style={{ left: t.x }} />)}</div>}
      <Icon name={a.linkedClipId ? 'detach' : 'music'} size={12} /><span>{baseName(a.path)}</span>
      <div className="trim left" onPointerDown={(e) => { orig.current = a; p.onSelect({ kind: 'audio', id: a.id }); trimLeft(e); }} />
      <div className="trim right" onPointerDown={(e) => { orig.current = a; p.onSelect({ kind: 'audio', id: a.id }); trimRight(e); }} />
    </div>
  );
}

/** A marker on the ruler: drag to move, click to go there, double-click to write its note. */
function MarkerFlag(p: Props & { m: Marker; x: number; usPerPx: number; duration: number }) {
  const { m } = p;
  const orig = useRef(m.t);
  const moved = useRef(false);
  const [editing, setEditing] = useState(false);
  const drag = useDrag((dx, _dy, e) => {
    if (Math.abs(dx) > 2) moved.current = true;
    if (moved.current) p.onMarker(m.id, { t: Math.max(0, Math.min(p.duration, p.snap!.time(orig.current + dx * p.usPerPx, e, m.id))) });
  }, () => { if (!moved.current) p.onSeek(m.t); p.onDragEnd(); });
  return (
    <>
      <button
        className="marker-flag"
        style={{ left: p.x, '--mk': MARKER_HEX[m.color] } as CSSProperties}
        title={`${m.note || 'Marker'} · ${fmtTime(m.t)} (double-click to edit, right-click or Shift+M to delete)`}
        aria-label={`Marker at ${fmtTime(m.t)}${m.note ? `: ${m.note}` : ''}`}
        onPointerDown={(e) => { orig.current = m.t; moved.current = false; drag(e); }}
        onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setEditing(false); p.onRemoveMarker(m.id); }}
      />
      {editing && (
        <div className="marker-pop" style={{ left: p.x }} onPointerDown={(e) => e.stopPropagation()}>
          <input
            autoFocus
            value={m.note}
            placeholder="Note"
            aria-label="Marker note"
            onChange={(e) => p.onMarker(m.id, { note: e.target.value })}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') setEditing(false); }}
            onBlur={(e) => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) setEditing(false); }}
          />
          <div className="marker-swatches">
            {(Object.keys(MARKER_HEX) as MarkerColor[]).map((c) => (
              <button key={c} className={c === m.color ? 'on' : ''} style={{ background: MARKER_HEX[c] }} aria-label={c} onClick={() => p.onMarker(m.id, { color: c })} />
            ))}
            <button className="marker-pop-del" title="Delete marker" aria-label="Delete marker" onClick={() => { setEditing(false); p.onRemoveMarker(m.id); }}><Icon name="trash" size={12} /></button>
          </div>
        </div>
      )}
    </>
  );
}
