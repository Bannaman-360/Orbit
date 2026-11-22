// The timeline: ruler, overlay track (text & gauges), video track (clips and the
// transitions between them), audio track (music and detached clip audio), playhead.
// Drag clip edges to trim, drag a clip to reorder, drag overlays/audio to move them.

import { useEffect, useRef, useState } from 'react';
import { usePrefs } from './ui/prefs';
import {
  assignLanes, audioSpan, clipDuration, clipStarts, GAUGES, mediaToTimeline, timelineDuration, trackExtent, trackRange, transitionUs, TRANSITIONS,
  type Overlay, type Timeline,
} from '@ace/project';
import type { Selection } from './App';
import { baseName } from './api';
import { mediaNow, musicNow } from './media';
import { fmtTime, useDrag } from './ui';

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
  onReorderClip: (id: string, toIndex: number) => void;
  onMoveAudio: (id: string, startUs: number, inUs: number, outUs: number) => void;
  onMoveOverlay: (id: string, startUs: number, endUs: number) => void;
  onDragEnd: () => void;
  /** Right-click (two-finger click) on a clip at timeline time T. */
  onClipMenu: (clipId: string, T: number, x: number, y: number) => void;
  /** Pixels per second. */
  pps: number;
  onPps: (f: (v: number) => number) => void;
  /** The timeline's toolbar, above or below the tracks. */
  toolbar?: React.ReactNode;
  toolbarAt: 'top' | 'bottom';
}

const RULER_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const LANE = 26;
/** Overlay rows are slimmer: gauges usually span the whole edit, one row each. */
const OV_LANE = 18;

export function TimelineView(p: Props) {
  const { timeline: tl } = p;
  const { pps, onPps: setPps } = p;
  usePrefs((x) => x.theme.trackHeight); // redraw when the clip height changes
  const scroller = useRef<HTMLDivElement>(null);
  const duration = timelineDuration(tl);
  const starts = clipStarts(tl);
  const width = Math.max(800, (duration / 1e6) * pps + 300);
  const x = (us: number) => (us / 1e6) * pps;

  // Fit the whole edit when clips are first added.
  const fitted = useRef(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !duration || fitted.current === tl.clips.length) return;
    fitted.current = tl.clips.length;
    setPps(() => Math.max(4, Math.min(400, ((el.clientWidth - 120) / duration) * 1e6)));
  }, [tl.clips.length, duration]);

  // Keep the playhead visible during playback.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !p.playing) return;
    const px = x(p.time);
    if (px < el.scrollLeft + 40 || px > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = px - el.clientWidth * 0.3;
  });

  const seekFromEvent = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    p.onSeek(Math.max(0, Math.min(duration, ((clientX - r.left + el.scrollLeft) / pps) * 1e6)));
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
    <div className="timeline">
      {p.toolbarAt === 'top' && p.toolbar}
      <div className="timeline-scroll" ref={scroller} onWheel={(e) => {
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); setPps((v) => Math.max(4, Math.min(400, v * Math.exp(-e.deltaY * 0.002)))); }
      }}>
        <div className="timeline-inner" style={{ width }}>
          <div className="ruler" onPointerDown={(e) => {
            seekFromEvent(e.clientX);
            const move = (ev: PointerEvent) => seekFromEvent(ev.clientX);
            const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
          }}>
            {ticks.map((s) => (
              <span key={s} className="tick" style={{ left: x(s * 1e6) }}>{fmtTime(s * 1e6).slice(0, rulerStep >= 1 ? -3 : rulerStep === 0.25 ? undefined : -1)}</span>
            ))}
          </div>

          <div className="track overlay-track" style={{ height: ovRows * OV_LANE }} onPointerDown={(e) => { if (e.target === e.currentTarget) p.onSelect(null); }}>
            {tl.overlays.length === 0 && <div className="track-empty">Text &amp; gauges: use “T Text” or “Gauges” above</div>}
            {tl.overlays.map((o) => (
              <OverlayBlock key={o.id} {...p} o={o} lane={ovLanes.get(o.id) ?? 0} left={x(o.startUs)} widthPx={Math.max(8, x(o.endUs - o.startUs))} pps={pps} duration={duration} />
            ))}
          </div>

          <div className="track video-track" onPointerDown={(e) => { if (e.target === e.currentTarget) seekFromEvent(e.clientX); }}>
            {tl.clips.length === 0 && <div className="track-empty">Drop clips here from the media bin (or double-click them)</div>}
            {tl.clips.map((c, i) => (
              <ClipBlock key={c.id} {...p} index={i} left={x(starts[i]!)} widthPx={x(clipDuration(c))} pps={pps} startUs={starts[i]!} />
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

          <div className="track audio-track" style={{ height: auRows * LANE + 4 }} onPointerDown={(e) => { if (e.target === e.currentTarget) p.onSelect(null); }}>
            {tl.audio.length === 0 && <div className="track-empty">Audio: “Add music” above, or “Detach audio” on a clip</div>}
            {tl.audio.map((a) => {
              const span = audioSpan(tl, a);
              return <AudioBlock key={a.id} {...p} id={a.id} lane={auLanes.get(a.id) ?? 0} left={x(span.start)} widthPx={Math.max(8, x(span.end - span.start))} pps={pps} />;
            })}
          </div>

          <div className="playhead" style={{ left: x(p.time) }} />
        </div>
      </div>
      {p.toolbarAt === 'bottom' && p.toolbar}
    </div>
  );
}

function ClipBlock(p: Props & { index: number; left: number; widthPx: number; pps: number; startUs: number }) {
  const c = p.timeline.clips[p.index]!;
  const media = mediaNow(c.mediaPath);
  const orig = useRef(c);
  const [dragX, setDragX] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const usPerPx = 1e6 / p.pps;

  const trimLeft = useDrag((dx) => {
    const o = orig.current;
    p.onTrimClip(o.id, o.inUs + dx * usPerPx * o.speed, o.outUs);
  }, p.onDragEnd);
  const trimRight = useDrag((dx) => {
    const o = orig.current;
    p.onTrimClip(o.id, o.inUs, o.outUs + dx * usPerPx * o.speed);
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

  const kfs = c.keyframes
    .filter((k) => k.t >= c.inUs && k.t <= c.outUs)
    .map((k) => ({ k, x: ((mediaToTimeline(p.startUs, c, k.t) - p.startUs) / 1e6) * p.pps }));
  const kfDrag = useRef<{ id: string; t: number; moved: boolean } | null>(null);
  const dragKf = useDrag((dx) => {
    const d = kfDrag.current;
    if (!d || (!d.moved && Math.abs(dx) < 4)) return; // a click, so far
    d.moved = true;
    p.onMoveKeyframe(c.id, d.id, d.t + dx * usPerPx * c.speed);
  }, p.onDragEnd);

  return (
    <div
      className={`clip${p.selectedClipId === c.id ? ' selected' : ''}${dragX !== null ? ' dragging' : ''}${media?.is360 ? ' is360' : ''}`}
      style={{ left: p.left, width: Math.max(6, p.widthPx), zIndex: p.index + 1, transform: dragX !== null ? `translateX(${dragX}px)` : undefined, ...(media?.thumbnail ? ({ '--thumb': `url(${media.thumbnail})` } as React.CSSProperties) : {}) }}
      onPointerDown={(e) => {
        if (e.button !== 0 || e.ctrlKey) return;
        orig.current = c;
        p.onSelectClip(c.id);
        move(e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const T = p.startUs + ((e.clientX - r.left) / p.pps) * 1e6;
        p.onClipMenu(c.id, Math.max(p.startUs, Math.min(p.startUs + clipDuration(c) - 1, T)), e.clientX, e.clientY);
      }}
      title={`${baseName(c.mediaPath)} · ${fmtTime(c.inUs)}–${fmtTime(c.outUs)}${c.speed !== 1 ? ` · ${c.speed}×` : ''}`}
    >
      <div className="clip-label">
        {media?.is360 && <b className="badge">360</b>}
        {c.speed !== 1 && <b className="badge">{c.speed}×</b>}
        {c.audioDetached && <b className="badge" title="Sound detached to the audio track">♪̸</b>}
        <span>{baseName(c.mediaPath)}</span>
      </div>
      <TrackBand {...p} />
      {kfs.map(({ k, x }) => (
        <button
          key={k.id}
          className={`clip-kf${p.keyframe?.id === k.id ? ' selected' : ''}`}
          style={{ left: Math.max(7, Math.min(p.widthPx - 11, x)) }}
          title={`Keyframe at ${fmtTime(k.t)} — click to go to it, drag to move, ⌫ or right-click to delete`}
          aria-label={`Keyframe at ${fmtTime(k.t)}`}
          onPointerDown={(e) => { if (e.button !== 0 || e.ctrlKey) return; kfDrag.current = { id: k.id, t: k.t, moved: false }; p.onKeyframe(c.id, k.id); dragKf(e); }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); p.onKeyframeMenu(c.id, k.id, e.clientX, e.clientY); }}
        />
      ))}
      <div className="trim left" onPointerDown={(e) => { orig.current = c; p.onSelectClip(c.id); trimLeft(e); }} />
      <div className="trim right" onPointerDown={(e) => { orig.current = c; p.onSelectClip(c.id); trimRight(e); }} />
    </div>
  );
}

/** The tracked part of a clip: bright = used (drag its ends), dim = tracked but not used. */
function TrackBand(p: Props & { index: number; pps: number }) {
  const c = p.timeline.clips[p.index]!;
  const r = c.track && trackRange(c.track), e = c.track && trackExtent(c.track);
  const orig = useRef<[number, number]>([0, 0]);
  const usPerPx = (1e6 / p.pps) * c.speed;
  const left = useDrag((dx) => p.onTrackRange(c.id, Math.min(orig.current[0] + dx * usPerPx, orig.current[1] - 100_000), orig.current[1], 'from'), p.onDragEnd);
  const right = useDrag((dx) => p.onTrackRange(c.id, orig.current[0], Math.max(orig.current[1] + dx * usPerPx, orig.current[0] + 100_000), 'to'), p.onDragEnd);
  if (!r || !e) return null;
  const px = (t: number) => ((t - c.inUs) / c.speed / 1e6) * p.pps;
  const span = (a: number, b: number) => {
    const x0 = px(Math.max(c.inUs, a)), x1 = px(Math.min(c.outUs, b));
    return x1 > x0 ? { left: x0, width: Math.max(2, x1 - x0) } : null;
  };
  const all = span(e[0], e[1]), used = span(r[0], r[1]);
  const grab = (drag: (ev: React.PointerEvent) => void) => (ev: React.PointerEvent) => {
    orig.current = [r[0], r[1]];
    p.onSelectClip(c.id);
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
  const move = useDrag((dx) => {
    const v = orig.current;
    const len = v.endUs - v.startUs;
    const s = Math.max(0, Math.min(p.duration - len, v.startUs + dx * usPerPx));
    p.onMoveOverlay(v.id, s, s + len);
  }, p.onDragEnd);
  const trimLeft = useDrag((dx) => {
    const v = orig.current;
    p.onMoveOverlay(v.id, Math.max(0, Math.min(v.endUs - min, v.startUs + dx * usPerPx)), v.endUs);
  }, p.onDragEnd);
  const trimRight = useDrag((dx) => {
    const v = orig.current;
    p.onMoveOverlay(v.id, v.startUs, Math.min(p.duration, Math.max(v.startUs + min, v.endUs + dx * usPerPx)));
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
      <span>{o.kind === 'text' ? 'T' : '◔'} {name}</span>
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
  const rate = a.speed ?? 1;
  const max = music?.durationUs ?? a.outUs;
  const move = useDrag((dx) => {
    const o = orig.current;
    p.onMoveAudio(o.id, Math.max(0, o.startUs + dx * usPerPx), o.inUs, o.outUs);
  }, p.onDragEnd);
  const trimLeft = useDrag((dx) => {
    const o = orig.current;
    const d = Math.max(-o.inUs / rate, Math.min(dx * usPerPx, (o.outUs - o.inUs) / rate - 500_000));
    p.onMoveAudio(o.id, Math.max(0, o.startUs + d), o.inUs + d * rate, o.outUs);
  }, p.onDragEnd);
  const trimRight = useDrag((dx) => {
    const o = orig.current;
    p.onMoveAudio(o.id, o.startUs, o.inUs, Math.max(o.inUs + 500_000, Math.min(max, o.outUs + dx * usPerPx * rate)));
  }, p.onDragEnd);
  const selected = p.selection?.kind === 'audio' && p.selection.id === a.id;
  return (
    <div
      className={`music${a.linkedClipId ? ' linked' : ''}${selected ? ' selected' : ''}`}
      style={{ left: p.left, width: p.widthPx, top: p.lane * LANE + 2, height: LANE - 3 }}
      onPointerDown={(e) => { orig.current = a; p.onSelect({ kind: 'audio', id: a.id }); move(e); }}
    >
      <span>{a.linkedClipId ? '🎙' : '♪'} {baseName(a.path)}</span>
      <div className="trim left" onPointerDown={(e) => { orig.current = a; p.onSelect({ kind: 'audio', id: a.id }); trimLeft(e); }} />
      <div className="trim right" onPointerDown={(e) => { orig.current = a; p.onSelect({ kind: 'audio', id: a.id }); trimRight(e); }} />
    </div>
  );
}
