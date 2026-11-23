// The timeline: ruler, overlay track (text & gauges), video track (clips and the
// transitions between them), audio track (music and detached clip audio), playhead.
// Drag clip edges to trim, drag a clip to reorder, drag overlays/audio to move them.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from './ui/Icon';
import { usePrefs } from './ui/prefs';
import {
  assignLanes, audioSpan, clipDuration, clipStarts, GAUGES, hasRamp, localAt, mediaAt, mediaToTimeline, speedRange, timelineDuration, trackExtent, trackRange, transitionUs, TRANSITIONS,
  type Overlay, type Timeline, type TimelineClip,
} from '@ace/project';
import type { Selection } from './App';
import { baseName } from './api';
import { mediaNow, musicNow, type Media } from './media';
import { fmtSpeed, SpeedLine } from './SpeedLine';
import { STRIP_H, STRIP_W, stripPicture, useFilmstrip } from './filmstrip';
import { fmtTime, useDrag } from './ui';
import { fmtJumpLength } from './gaugeMath';

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
          <div className="ruler" style={{ '--minor': `${(rulerStep * pps) / (rulerStep === 0.25 || rulerStep >= 60 ? 5 : 4)}px` } as CSSProperties} onPointerDown={(e) => {
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
            {tl.overlays.length === 0 && <div className="track-empty"><Icon name="text" size={12} />Titles and gauges you add appear here</div>}
            {tl.overlays.map((o) => (
              <OverlayBlock key={o.id} {...p} o={o} lane={ovLanes.get(o.id) ?? 0} left={x(o.startUs)} widthPx={Math.max(8, x(o.endUs - o.startUs))} pps={pps} duration={duration} />
            ))}
          </div>

          <div className="track video-track" ref={videoTrack} onPointerDown={(e) => { if (e.target === e.currentTarget) seekFromEvent(e.clientX); }}>
            {tl.clips.length === 0 && <div className="track-empty"><Icon name="media" size={14} />Drag clips here from Media, or double-click one</div>}
            {tl.clips.map((c, i) => (
              <ClipBlock key={c.id} {...p} index={i} left={x(starts[i]!)} widthPx={x(clipDuration(c))} pps={pps} startUs={starts[i]!} trackH={trackH} view={view} />
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
            {tl.audio.length === 0 && <div className="track-empty"><Icon name="music" size={12} />Music and detached sound go here</div>}
            {tl.audio.map((a) => {
              const span = audioSpan(tl, a);
              return <AudioBlock key={a.id} {...p} id={a.id} lane={auLanes.get(a.id) ?? 0} left={x(span.start)} widthPx={Math.max(8, x(span.end - span.start))} pps={pps} />;
            })}
          </div>

          <div className="playhead" style={{ left: x(p.time) }} data-time={fmtTime(p.time)} />
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
  const orig = useRef(c);
  const [dragX, setDragX] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const usPerPx = 1e6 / p.pps;

  const trimLeft = useDrag((dx) => {
    const o = orig.current;
    p.onTrimClip(o.id, mediaAt(o, dx * usPerPx), o.outUs);
  }, p.onDragEnd);
  const trimRight = useDrag((dx) => {
    const o = orig.current;
    p.onTrimClip(o.id, o.inUs, mediaAt(o, clipDuration(o) + dx * usPerPx));
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
    p.onMoveKeyframe(c.id, d.id, mediaAt(c, localAt(c, d.t) + dx * usPerPx));
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
      title={`${baseName(c.mediaPath)} · ${fmtTime(c.inUs)}–${fmtTime(c.outUs)}${speedText(c) ? ` · ${speedText(c)}` : ''}`}
    >
      <Strip clip={c} left={p.left} widthPx={p.widthPx} pps={p.pps} height={p.trackH} view={p.view} playhead={(p.time / 1e6) * p.pps} />
      <div className="clip-label">
        {media?.is360 && <b className="badge">360</b>}
        {speedText(c) && <b className="badge">{speedText(c)}</b>}
        {c.audioDetached && <b className="badge" title="Sound detached to the audio track">♪̸</b>}
        <span>{baseName(c.mediaPath)}</span>
      </div>
      <TrackBand {...p} />
      {p.jumpMarks && media?.telemetry.hasAccel && <JumpMarks clip={c} media={media} pps={p.pps} startUs={p.startUs} onSeek={p.onSeek} />}
      {(p.speedLines || hasRamp(c)) && (
        <SpeedLine
          clip={c}
          pps={p.pps}
          width={Math.max(6, p.widthPx)}
          height={Math.max(30, p.trackH)}
          selected={p.speedPoint?.clipId === c.id ? p.speedPoint.id : null}
          onSelect={(id) => p.onSpeedPoint(c.id, id)}
          onMenu={(id, x, y) => p.onSpeedMenu(c.id, id, x, y)}
          onPoint={(id, t, s) => p.onMoveSpeedPoint(c.id, id, t, s)}
          onAdd={(t) => p.onAddSpeedPoint(c.id, t)}
          onSpeed={(s) => p.onSpeed(c.id, s)}
          onGrab={() => p.onSelectClip(c.id)}
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
          onPointerDown={(e) => { if (e.button !== 0 || e.ctrlKey) return; kfDrag.current = { id: k.id, t: k.t, moved: false }; p.onKeyframe(c.id, k.id); dragKf(e); }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); p.onKeyframeMenu(c.id, k.id, e.clientX, e.clientY); }}
        />
      ))}
      <div className="trim left" onPointerDown={(e) => { orig.current = c; p.onSelectClip(c.id); trimLeft(e); }} />
      <div className="trim right" onPointerDown={(e) => { orig.current = c; p.onSelectClip(c.id); trimRight(e); }} />
    </div>
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
function TrackBand(p: Props & { index: number; pps: number }) {
  const c = p.timeline.clips[p.index]!;
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
  const move = useDrag((dx) => {
    const o = orig.current;
    p.onMoveAudio(o.id, Math.max(0, o.startUs + dx * usPerPx), o.inUs, o.outUs);
  }, p.onDragEnd);
  const trimLeft = useDrag((dx) => {
    const o = orig.current;
    const d = Math.max(localAt(o, 0), Math.min(dx * usPerPx, localAt(o, o.outUs) - 500_000));
    p.onMoveAudio(o.id, Math.max(0, o.startUs + d), Math.max(0, mediaAt(o, d)), o.outUs);
  }, p.onDragEnd);
  const trimRight = useDrag((dx) => {
    const o = orig.current;
    p.onMoveAudio(o.id, o.startUs, o.inUs, Math.max(o.inUs + 500_000, Math.min(max, mediaAt(o, localAt(o, o.outUs) + dx * usPerPx))));
  }, p.onDragEnd);
  const selected = p.selection?.kind === 'audio' && p.selection.id === a.id;
  return (
    <div
      className={`music${a.linkedClipId ? ' linked' : ''}${selected ? ' selected' : ''}`}
      style={{ left: p.left, width: p.widthPx, top: p.lane * LANE + 2, height: LANE - 3 }}
      onPointerDown={(e) => { orig.current = a; p.onSelect({ kind: 'audio', id: a.id }); move(e); }}
    >
      <Icon name={a.linkedClipId ? 'detach' : 'music'} size={12} /><span>{baseName(a.path)}</span>
      <div className="trim left" onPointerDown={(e) => { orig.current = a; p.onSelect({ kind: 'audio', id: a.id }); trimLeft(e); }} />
      <div className="trim right" onPointerDown={(e) => { orig.current = a; p.onSelect({ kind: 'audio', id: a.id }); trimRight(e); }} />
    </div>
  );
}
