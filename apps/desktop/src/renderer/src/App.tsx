import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MIN_FISHEYE, parseCube, ReframeRenderer } from '@ace/media360';
import {
  addClip, designFor, GAUGE_DESIGNS, gaugeSet, clipDuration, clipStarts, localAt, deleteSideAt, detachAudio, duplicateClip, emptyTimeline, FRAMINGS, framingAspect, GAUGES, keyframeNear, loadTimeline, locate,
  mediaToTimeline, moveClip, newAudioClip, newClip, newGaugeOverlay, newTextOverlay, nextKeyTime, prevKeyTime, reattachAudio, removeAudio,
  removeClip, removeKeyframe, removeOverlay, setEasing, setKeyframe, splitAt, timelineDuration, transitionLook, trimClip, updateAudio,
  updateClip, updateOverlay,
  hasRamp, mediaAt, moveSpeedKey, rippleItems, DEFAULT_LENS_LOOK, fisheyeForLook, lookAt, removeSpeedKey, setClipSpeed, setSpeedEase, setSpeedKey, speedAt, speedKeyNear,
  COMFORT_FOV, fitSubjectFrac, fracForFov, moveKeyframe, trackWeight, DEFAULT_TRACK_MAX_FOV, MAX_ZOOM_FOV, setTrackRange, trackActive, trackExtent, trackHeld, trackRange,
  type ClipTrack, type Easing, type GaugeDesign, type GaugeKind, type Grade, type Look, type Overlay, type Timeline, type TimelineClip, type Transition,
} from '@ace/project';
import { ace, baseName, type FoundMedia } from './api';
import { AudioPlayer } from './audioEngine';
import { hasTwoLenses, lensUi, matchClipLenses, setLensUi } from './lensMatching';
import { cardOf, running, startCards, useCards } from './cardImport';
import { ExportDialog } from './ExportDialog';
import { pauseFilmstrip } from './filmstrip';
import { ImportWindow } from './ImportWindow';
import { grabFrame, loadLut } from './exporter';
import { adoptReframe, canReframe, lensLookOf, clipLens, clipLookAt, flatDirection, flatShot, FOLLOW_ROOM, ownLookAt, roomFov, shareOf, shownFov, withoutEffects, presentLook, pushClipFrame, reframeSignature } from './frameRender';
import { angleBetween, directionAt, trackSubject } from './tracker';
import { InspectorPanel, SelectionPanel, type InspectorProps } from './Inspector';
import { MediaBin, type BinItem } from './MediaBin';
import { AppMenu, ShortcutsDialog } from './Menu';
import { getMedia, loadMusic, mediaNow, wholeRecordings } from './media';
import { ensureProxies, onProxyChange, PREVIEW_LEVELS, setPreviewLevel, type PreviewLevel } from './proxy';
import { drawOverlays, hitOverlay, layerCss } from './overlayRender';
import { runSelftest, type EditorApi } from './selftest';
import { TimelinePlayer, type TickResult } from './timelinePlayer';
import { TimelineView } from './TimelineView';
import { fmtTime, openSection, Range, toggleAllSections } from './ui';
import { Bar, dragItem, type ToolItem } from './ui/Bars';
import { comboLabel, comboOf, combosOf, COMMANDS, keyOf, KeyMatcher } from './ui/commands';
import { ArrangeBar, Customize, reopenPanel, type CustomizePage } from './ui/Customize';
import { Tour, Welcome } from './Tour';
import { Dock, type PanelDef } from './ui/Dock';
import { closePanel, openPanels } from './ui/dockModel';
import { Icon } from './ui/Icon';
import { getPrefs, isArranging, LAYOUTS, onNativeTheme, PANELS, platformMac, setArranging, setPrefs, undoPrefs, useArranging, usePrefs } from './ui/prefs';

interface SaveFile { version: 1; timeline: Timeline; library: string[] }

/** What is selected besides the clip under the playhead. */
export type Selection = { kind: 'audio' | 'overlay' | 'transition'; id: string } | null;

/** True when the element takes typed text (so shortcuts must not fire). */
function isTextEntry(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const t = (el as HTMLInputElement).type;
  return !['range', 'checkbox', 'radio', 'button', 'color', 'submit'].includes(t);
}

const speedId = (c: { speed?: number; speedKeys?: { t: number; speed: number; ease?: string }[] }) => c.speedKeys?.map((k) => `${k.t}@${k.speed}${k.ease ?? ''}`).join() ?? c.speed;
/** Clips' media paths, in/out, order, speed and transitions: changes that need the player to re-seek. */
const structureKey = (tl: Timeline) =>
  tl.clips.map((c) => `${c.id}:${c.mediaPath}:${c.inUs}:${c.outUs}:${speedId(c)}:${c.transitionIn?.durationUs ?? 0}`).join('|');
const audioKey = (tl: Timeline) =>
  `${structureKey(tl)}#${tl.clips.map((c) => `${c.volume}${c.audioDetached ? 'd' : ''}${c.muteBelow ?? ''}${c.keepPitch === false ? 'p' : ''}`).join(',')}#${tl.audio
    .map((a) => `${a.path}:${a.startUs}:${a.inUs}:${a.outUs}:${a.volume}:${a.fadeInUs}:${a.fadeOutUs}:${speedId(a)}:${a.muteBelow ?? ''}:${a.keepPitch === false ? 'p' : ''}`)
    .join('|')}`;

export function App() {
  // --- Timeline state with undo -------------------------------------------------------------
  const [tl, setTl] = useState<Timeline>(emptyTimeline());
  const tlRef = useRef(tl);
  tlRef.current = tl;
  const hist = useRef({ past: [] as Timeline[], future: [] as Timeline[], lastKey: '', lastAt: 0 });

  /** Applies an edit. Edits with the same `key` within a second merge into one undo step. */
  const commit = useCallback((next: Timeline, key = '') => {
    const h = hist.current;
    const now = performance.now();
    if (!key || key !== h.lastKey || now - h.lastAt > 1000) {
      h.past.push(tlRef.current);
      if (h.past.length > 200) h.past.shift();
      h.future = [];
    }
    h.lastKey = key;
    h.lastAt = now;
    tlRef.current = next;
    setTl(next);
  }, []);
  const endGesture = useCallback(() => (hist.current.lastKey = ''), []);
  const undo = useCallback(() => {
    const h = hist.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push(tlRef.current);
    h.lastKey = '';
    tlRef.current = prev;
    setTl(prev);
  }, []);
  const redo = useCallback(() => {
    const h = hist.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(tlRef.current);
    h.lastKey = '';
    tlRef.current = next;
    setTl(next);
  }, []);

  // --- Preview quality (proxies) -----------------------------------------------------------
  const [level, setLevel] = useState<PreviewLevel>(() => {
    try {
      const v = Number(localStorage.getItem('ace.previewLevel'));
      return ([1, 2, 4, 8] as const).includes(v as PreviewLevel) ? (v as PreviewLevel) : 1;
    } catch {
      return 1;
    }
  });
  const [, proxyTick] = useState(0);
  useEffect(() => { const off = onProxyChange(() => proxyTick((n) => n + 1)); return () => { off(); }; }, []);
  const binMedia = () => binRef.current.flatMap((b) => (b.media ? [b.media] : []));
  useEffect(() => {
    setPreviewLevel(level, binMedia());
    try { localStorage.setItem('ace.previewLevel', String(level)); } catch { /* private mode */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level]);

  // --- Media bin ------------------------------------------------------------------------------
  const [bin, setBin] = useState<BinItem[]>([]);
  const binRef = useRef(bin);
  binRef.current = bin;
  const [, bump] = useState(0);

  const importPaths = useCallback(async (picked: string[]) => {
    const paths = await wholeRecordings(picked);
    const fresh = paths.filter((p) => !binRef.current.some((b) => b.path === p));
    if (!fresh.length) return paths;
    setBin((b) => [...b, ...fresh.map((path) => ({ path }))]);
    await Promise.all(
      fresh.map(async (path) => {
        try {
          const media = await getMedia(path);
          setBin((b) => b.map((x) => (x.path === path ? { path, media } : x)));
          ensureProxies([media]);
        } catch (e) {
          setBin((b) => b.map((x) => (x.path === path ? { path, error: String(e) } : x)));
        }
      }),
    );
    return paths;
  }, []);

  const addToTimeline = useCallback((path: string, index?: number) => {
    const m = mediaNow(path);
    if (!m) return;
    const t = tlRef.current;
    const made0 = newClip(path, m.durationUs, m.is360);
    // 360 clips keep their lens look while zooming.
    const made = m.is360 ? { ...made0, lensLook: DEFAULT_LENS_LOOK } : made0;
    // Without motion data there is nothing to stabilize with (stitched videos have it built in).
    const c = m.layout?.equirect && !m.stabilizer.hasOrientation ? { ...made, stabilize: { ...made.stabilize, smoothing: 'off' as const, horizon: false } } : made;
    // Regular clips start as recorded, ready to be reframed; steadied when the camera's motion data
    // allows it and the camera didn't steady them itself.
    const steady = m.lens && m.stabilizer.hasOrientation && !m.camera.stabilizedInCamera;
    commit(addClip(t, m.lens ? { ...c, lensMode: 'source', look: { ...c.look, fov: m.lens.hfov }, ...(steady ? { stabilize: { ...c.stabilize, smoothing: 'medium' as const, crop: 'auto' as const } } : {}) } : c, index ?? t.clips.length));
  }, [commit]);

  // --- Playback & rendering --------------------------------------------------------------------
  const canvas0 = useRef<HTMLCanvasElement>(null);
  const canvas1 = useRef<HTMLCanvasElement>(null);
  const canvasRefs = [canvas0, canvas1];
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const dipRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const renderersRef = useRef<ReframeRenderer[]>([]);
  const player = useMemo(() => new TimelinePlayer(() => tlRef.current), []);
  const audio = useMemo(() => new AudioPlayer(), []);
  const lastResult = useRef<TickResult | null>(null);
  const renderWaiters = useRef<(() => void)[]>([]);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const showRawRef = useRef(showRaw);
  showRawRef.current = showRaw;
  /** Held down: show the picture without any effects (before / after). */
  const [compare, setCompare] = useState(false);
  const compareRef = useRef(compare);
  compareRef.current = compare;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection>(null);
  const selRef = useRef(sel);
  selRef.current = sel;
  const [exportOpen, setExportOpen] = useState(false);
  /** New pictures shown per second while playing, and how often the screen is redrawn. */
  const [rate, setRate] = useState({ video: 0, screen: 0 });

  useEffect(() => {
    player.onTransport = (isPlaying, t) => {
      if (isPlaying) audio.play(tlRef.current, t);
      else audio.stop();
    };
  }, [player, audio]);

  // Re-seek when clips change shape; restart audio when anything audible changes.
  const sKey = structureKey(tl);
  useEffect(() => player.invalidate(), [sKey, player]);
  const aKey = audioKey(tl);
  useEffect(() => {
    let cancelled = false;
    void audio.prepare(tlRef.current).then(() => {
      if (!cancelled && player.playing) audio.play(tlRef.current, player.time);
    });
    return () => { cancelled = true; };
  }, [aKey, audio, player]);

  // LUT.
  useEffect(() => {
    for (const r of renderersRef.current) loadLut(r, tl.lutPath).catch((e) => setError(`LUT: ${e}`));
  }, [tl.lutPath]);

  // Size the preview to the output framing, as large as fits.
  const aspect = framingAspect(tl.framing);
  useEffect(() => {
    const stage = stageRef.current!;
    const fit = () => {
      // (Hidden behind another tab: keep the last size.)
      if (!stage.clientWidth || !stage.clientHeight) return;
      const pad = parseFloat(getComputedStyle(stage).paddingLeft) * 2;
      const W = stage.clientWidth - pad, H = stage.clientHeight - pad;
      const w = Math.max(2, Math.min(W, H * aspect)), h = w / aspect;
      frameRef.current!.style.width = `${Math.floor(w)}px`;
      frameRef.current!.style.height = `${Math.floor(h)}px`;
      // Lower preview quality also draws fewer pixels (big saving on slow graphics).
      const full = window.devicePixelRatio || 1;
      const dpr = level === 1 ? full : level === 2 ? Math.min(full, 1) : level === 4 ? 0.75 : 0.5;
      // More pixels than the footage has only costs speed (a full-screen Retina preview would be
      // drawn at twice the detail of the 360 source).
      const cap = Math.min(dpr, 2048 / Math.max(w, h));
      for (const c of [canvas0.current!, canvas1.current!]) {
        c.width = Math.max(2, Math.round(w * cap));
        c.height = Math.max(2, Math.round(h * cap));
      }
      // Gauges and titles stay sharp at every preview quality: drawn at the screen's own pixels
      // (a lower-resolution layer stretched by the browser makes thin lines shimmer as they move).
      const ov = overlayRef.current!;
      ov.width = Math.max(2, Math.round(w * full));
      ov.height = Math.max(2, Math.round(h * full));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [aspect, level]);

  /** Positions the two video layers (and the colour dip) for the current transition. */
  const styleLayers = (res: TickResult) => {
    const layers = res.layers!;
    const look = layers.length > 1 && res.transition ? transitionLook(res.transition.kind, res.progress) : null;
    canvasRefs.forEach((ref, ri) => {
      const c = ref.current!;
      const li = layers.findIndex((l) => l.index % 2 === ri);
      if (li < 0) {
        c.style.visibility = 'hidden';
        return;
      }
      c.style.visibility = 'visible';
      c.style.zIndex = String(li + 1);
      const css = look
        ? layerCss(li === 0 ? look.a : look.b, c.clientWidth, li === 0 ? null : look.reveal)
        : { opacity: '1', transform: '', filter: '', clipPath: '' };
      Object.assign(c.style, css);
    });
    const dip = dipRef.current!;
    dip.style.opacity = look?.dip ? String(look.dipAlpha) : '0';
    if (look?.dip) dip.style.background = look.dip;
  };

  const drawOverlayLayer = () => {
    const c = overlayRef.current;
    if (!c) return;
    // Nothing on it and nothing to draw: leave the (large) layer alone.
    if (!tlRef.current.overlays.length && !c.dataset.drawn) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (tlRef.current.overlays.length) c.dataset.drawn = '1'; else delete c.dataset.drawn;
    const s = selRef.current;
    drawOverlays(ctx, c.width, c.height, tlRef.current, player.time, s?.kind === 'overlay' ? s.id : null);
  };
  const styleLayersRef = useRef(styleLayers);
  styleLayersRef.current = styleLayers;
  const drawOverlayRef = useRef(drawOverlayLayer);
  drawOverlayRef.current = drawOverlayLayer;

  // Render loop.
  useEffect(() => {
    let raf = 0, stop = false;
    let frames = 0, pictures = 0, lastPicture = -1, fpsT = performance.now(), uiT = 0;
    // Per renderer: which clip it shows and what it last drew.
    const state = [0, 1].map(() => ({ clipKey: '', lastTs: -1, lastSig: '' }));
    (async () => {
      try {
        renderersRef.current = await Promise.all([canvas0, canvas1].map((r) => ReframeRenderer.create(r.current!)));
        for (const r of renderersRef.current) await loadLut(r, tlRef.current.lutPath).catch(() => {});
      } catch (e) {
        setError(`GPU: ${e}`);
        return;
      }
      const loop = (now: number) => {
        if (stop) return;
        const res = player.tick(now);
        if (!res) {
          // Nothing on the timeline: don't leave the last picture up.
          for (const c of [canvas0.current, canvas1.current]) if (c) c.style.visibility = 'hidden';
          for (const st of state) st.clipKey = '';
        }
        if (res?.layers) {
          lastResult.current = res;
          res.layers.forEach((l, li) => {
            // Clips alternate between the two renderers, so a clip keeps its renderer (and
            // motion-blur history) for its whole time on screen, transitions included.
            const ri = l.index % 2;
            const r = renderersRef.current[ri]!;
            const st = state[ri]!;
            const clipKey = `${l.clip.id}|${l.media.path}|${l.level}`;
            if (clipKey !== st.clipKey) {
              r.setLayout(l.layout);
              st.clipKey = clipKey;
              st.lastTs = -1;
            }
            // Stabilisation and keyframes use the shown frame's own timestamp, not the playhead
            // (which runs on the display clock and can be up to a frame later → visible shake).
            const ts = l.frames[0]!.timestamp;
            const raw = showRawRef.current && li === 0;
            const look = clipLookAt(l.clip, ts);
            // (Before / after also leaves out what is done to each lens.)
            const shownClip = compareRef.current && l.clip.lenses ? { ...l.clip, lenses: undefined } : l.clip;
            const sig = reframeSignature(shownClip, look, `${raw}|${r.canvas.width}x${r.canvas.height}`);
            let push = false;
            if (ts !== st.lastTs) {
              if (!player.playing || ts < st.lastTs || sig !== st.lastSig) r.resetHistory();
              push = true;
            } else if (sig !== st.lastSig) {
              r.resetHistory();
              push = true;
            }
            if (push) {
              pushClipFrame(r, shownClip, l.media, ts, l.frames, { raw, showTiles: true });
              st.lastTs = ts;
              st.lastSig = sig;
            }
            const mark = lensUi();
            r.highlight = mark.highlight && !raw && hasTwoLenses(l.media) ? mark.lens : null;
            presentLook(r, compareRef.current ? withoutEffects(look) : look, { raw: raw && l.media.is360, time: ts });
          });
          styleLayersRef.current(res);
          frames++;
          const shown = res.layers[0]!.frames[0]!.timestamp;
          if (shown !== lastPicture) { pictures++; lastPicture = shown; }
          renderWaiters.current.splice(0).forEach((f) => f());
        }
        drawOverlayRef.current();
        if (now - uiT > 33) {
          uiT = now;
          setTime(player.time);
          setPlaying(player.playing);
          pauseFilmstrip(player.playing);
        }
        if (now - fpsT > 1000) {
          setRate({ video: (pictures * 1000) / (now - fpsT), screen: (frames * 1000) / (now - fpsT) });
          frames = 0;
          pictures = 0;
          fpsT = now;
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();
    return () => { stop = true; cancelAnimationFrame(raf); };
  }, [player]);

  // Have the sound at the playhead ready before play is pressed.
  useEffect(() => {
    if (playing) return;
    const id = setTimeout(() => audio.prime(tlRef.current, time), 120);
    return () => clearTimeout(id);
  }, [time, playing, tl, audio]);

  // --- Current clip & edits --------------------------------------------------------------------
  const at = locate(tl, time);
  const clip = at?.clip ?? null;
  const media = clip ? mediaNow(clip.mediaPath) ?? null : null;
  const look = clip && at ? clipLookAt(clip, at.mediaUs) : null;
  const snapUs = media ? 1e6 / media.fps : 20_000;
  const duration = timelineDuration(tl);

  const seek = useCallback((T: number) => player.seek(T), [player]);
  const togglePlay = useCallback(() => (player.playing ? player.pause() : player.play()), [player]);

  const editClip = (patch: Partial<TimelineClip>, key: string) => clip && commit(updateClip(tlRef.current, clip.id, patch), `${key}:${clip.id}`);

  const editLook = (patchIn: Partial<Look>, key: string) => {
    let patch = patchIn;
    const cur = locate(tlRef.current, player.time);
    if (!cur) return;
    // A regular clip from before reframing existed starts from its picture as recorded.
    const c = adoptReframe(cur.clip);
    const adopted: Partial<TimelineClip> = c === cur.clip ? {} : { lensMode: c.lensMode, look: c.look, keyframes: c.keyframes };
    // With a lens look kept while zooming, setting the fisheye sets the look (at this field of view).
    const look = lensLookOf(c);
    if (look && patch.fisheye !== undefined) {
      const { fisheye, ...restPatch } = patch;
      commit(updateClip(tlRef.current, c.id, { ...adopted, lensLook: { fov: patch.fov ?? ownLookAt(c, cur.mediaUs).fov, fisheye } }), `${key}:${c.id}`);
      if (!Object.keys(restPatch).length) return;
      patch = restPatch;
    }
    const own = ownLookAt(c, cur.mediaUs), now = clipLookAt(c, cur.mediaUs);
    /** Stores settings on the clip itself (or its keyframe here): never what tracking shows. */
    const store = (p: Partial<Look>): Partial<TimelineClip> => {
      const next = { ...own, ...p };
      // (A fisheye that follows the field of view isn't stored: the clip keeps its own.)
      if (look) next.fisheye = lookAt(c.keyframes, c.look, cur.mediaUs).fisheye;
      return c.keyframes.length ? { keyframes: setKeyframe(c.keyframes, cur.mediaUs, next, snapUs) } : { look: next };
    };
    const put = (p: Partial<TimelineClip>) => commit(updateClip(tlRef.current, c.id, { ...adopted, ...p }), `${key}:${c.id}`);
    const { yaw, pitch, fov, ...rest } = patch;
    const aimed = yaw !== undefined || pitch !== undefined || fov !== undefined;
    const w = c.track ? trackWeight(c.track, cur.mediaUs) : 0;
    // The lens may be bent by tracking: change our own by as much as was asked.
    if (rest.fisheye !== undefined && w > 0) rest.fisheye = Math.max(MIN_FISHEYE, Math.min(1, own.fisheye + (rest.fisheye - now.fisheye)));
    if (!c.track || w <= 0) { put(store(patch)); return; }
    const others = Object.keys(rest).length ? store(rest) : {};
    if (!aimed) { put(others); return; }
    const dy = yaw !== undefined ? ((yaw - now.yaw + 540) % 360) - 180 : 0;
    const dp = pitch !== undefined ? pitch - now.pitch : 0;
    const dz = fov !== undefined ? Math.log(fov / now.fov) : 0;
    // After a track that holds its last view, pan / tilt / zoom set the view it settles on.
    if (trackHeld(c.track, cur.mediaUs)) {
      const { end: _e, ...noEnd } = c.track;
      const base = c.track.end ?? clipLookAt({ ...c, track: noEnd }, cur.mediaUs + 60e6);
      const end = { yaw: ((base.yaw + dy + 540) % 360) - 180, pitch: Math.max(-90, Math.min(90, base.pitch + dp)), fov: Math.max(1, Math.min(360, base.fov * Math.exp(dz))) };
      put({ ...others, track: { ...c.track, end } });
      return;
    }
    // Mostly the clip's own view still (easing in or out): move that, by enough to show.
    if (w < 0.5) {
      put(store({ ...rest, yaw: ((own.yaw + dy / (1 - w) + 540) % 360) - 180, pitch: Math.max(-90, Math.min(90, own.pitch + dp / (1 - w))), fov: Math.max(1, Math.min(360, own.fov * Math.exp(dz / (1 - w)))) }));
      return;
    }
    // Following: pan / tilt move the framing around the subject, zoom sets how big it is kept.
    const track: ClipTrack = { ...c.track, offsetYaw: c.track.offsetYaw + dy / w, offsetPitch: Math.max(-90, Math.min(90, c.track.offsetPitch + dp / w)) };
    if (fov !== undefined) {
      if ((track.autoZoom ?? 0) > 0 && track.subjectFrac) {
        const target = Math.exp((Math.log(fov) - (1 - w) * Math.log(own.fov)) / w);
        track.subjectFrac = fracForFov(c.track, cur.mediaUs, target, look ? (f: number) => fisheyeForLook(look, f) : own.fisheye, shareOf(mediaNow(c.mediaPath), c)) ?? track.subjectFrac;
        // Zooming out past the limit moves the limit.
        if (target > (track.maxFov ?? DEFAULT_TRACK_MAX_FOV)) track.maxFov = Math.min(MAX_ZOOM_FOV, target);
      } else Object.assign(others, store({ ...rest, fov }));
    }
    put({ ...others, track });
  };
  const editGrade = (patch: Partial<Grade>, key: string) => {
    const cur = locate(tlRef.current, player.time);
    if (!cur) return;
    editLook({ grade: { ...ownLookAt(cur.clip, cur.mediaUs).grade, ...patch } }, key);
  };

  const addKeyframe = () => {
    if (!clip || !at) return;
    // (The clip's own view, not where tracking has taken it.)
    editClip({ keyframes: setKeyframe(clip.keyframes, at.mediaUs, ownLookAt(clip, at.mediaUs), snapUs) }, 'addkey');
  };
  /** Deletes a keyframe. Removing the last one leaves the clip looking like it did there. */
  const deleteKeyframeById = (clipId: string, id: string) => {
    const c = tlRef.current.clips.find((x) => x.id === clipId);
    const k = c?.keyframes.find((x) => x.id === id);
    if (!c || !k) return;
    const rest = removeKeyframe(c.keyframes, id);
    commit(updateClip(tlRef.current, c.id, rest.length ? { keyframes: rest } : { keyframes: [], look: k.look }));
    setKfSel(null);
  };
  const deleteKeyframe = () => {
    const k = clip && at ? keyframeNear(clip.keyframes, at.mediaUs, snapUs) : undefined;
    if (clip && k) deleteKeyframeById(clip.id, k.id);
  };
  /** The keyframe picked on the timeline (for ⌫), as long as the playhead is still on it. */
  const [kfSel, setKfSel] = useState<{ clipId: string; id: string } | null>(null);
  const kfTime = (clipId: string, id: string) => {
    const t = tlRef.current, i = t.clips.findIndex((x) => x.id === clipId), c = t.clips[i];
    const k = c?.keyframes.find((x) => x.id === id);
    return c && k ? mediaToTimeline(clipStarts(t)[i]!, c, Math.max(c.inUs, Math.min(c.outUs - 1, k.t))) : null;
  };
  const pickKeyframe = (clipId: string, id: string) => {
    setSel(null);
    setSpeedSel(null);
    setKfSel({ clipId, id });
    player.pause();
    const T = kfTime(clipId, id);
    if (T !== null) seek(T);
  };
  const pickedKf = () => {
    const T = kfSel && kfTime(kfSel.clipId, kfSel.id);
    return kfSel && T !== null && Math.abs(T - player.time) < 60_000 ? kfSel : null;
  };
  const dragKeyframe = (clipId: string, id: string, t: number) => {
    const c = tlRef.current.clips.find((x) => x.id === clipId);
    if (!c) return;
    const m = mediaNow(c.mediaPath), frame = m ? 1e6 / m.fps : 20_000;
    let to = Math.max(c.inUs, Math.min(c.outUs - frame, t));
    // Two keyframes can't share a frame: stop just short of the neighbour.
    const other = c.keyframes.find((k) => k.id !== id && Math.abs(k.t - to) < frame * 1.5);
    if (other) to = other.t + (to < other.t ? -1 : 1) * frame * 1.5;
    if (to < c.inUs || to > c.outUs || c.keyframes.some((k) => k.id !== id && Math.abs(k.t - to) < frame)) return;
    commit(updateClip(tlRef.current, clipId, { keyframes: moveKeyframe(c.keyframes, id, to) }), `kfmove:${id}`);
    const T = kfTime(clipId, id);
    if (T !== null && !player.playing) player.seek(T);
  };
  const jumpKey = (dir: -1 | 1) => {
    if (!clip || !at) return;
    const t = dir < 0 ? prevKeyTime(clip.keyframes, at.mediaUs) : nextKeyTime(clip.keyframes, at.mediaUs);
    if (t !== undefined) seek(mediaToTimeline(at.startUs, clip, Math.max(clip.inUs, Math.min(clip.outUs - 1, t))));
  };

  // --- Speed ---------------------------------------------------------------------------------------
  /** Changes a clip's speed, staying on the picture that is showing. */
  const changeSpeed = (clipId: string, patch: Parameters<typeof setClipSpeed>[2], key: string) => {
    const before = locate(tlRef.current, player.time);
    const next = rippleItems(tlRef.current, setClipSpeed(tlRef.current, clipId, patch), clipId);
    commit(next, `${key}:${clipId}`);
    if (!before || player.playing) return;
    const i = next.clips.findIndex((c) => c.id === before.clip.id), c = next.clips[i];
    // (The length of this clip or one before it changed.)
    if (c) player.seek(mediaToTimeline(clipStarts(next)[i]!, c, before.mediaUs));
  };
  const [speedLines, setSpeedLines] = useState(() => { try { return localStorage.getItem('ace.speedLines') === 'true'; } catch { return false; } });
  const [jumpMarks, setJumpMarks] = useState(() => { try { return localStorage.getItem('ace.jumpMarks') !== 'false'; } catch { return true; } });
  const toggleJumpMarks = () => setJumpMarks((v) => { try { localStorage.setItem('ace.jumpMarks', String(!v)); } catch { /* private mode */ } return !v; });
  const toggleSpeedLines = () => setSpeedLines((v) => { try { localStorage.setItem('ace.speedLines', String(!v)); } catch { /* private mode */ } return !v; });
  const [speedSel, setSpeedSel] = useState<{ clipId: string; id: string } | null>(null);
  const [speedMenu, setSpeedMenu] = useState<{ clipId: string; id: string; x: number; y: number } | null>(null);
  const clipById = (id: string) => tlRef.current.clips.find((c) => c.id === id);
  const pickSpeedPoint = (clipId: string, id: string) => { setSel(null); setKfSel(null); setSpeedSel({ clipId, id }); };
  const moveSpeedPoint = (clipId: string, id: string, t: number, speed: number) => {
    const c = clipById(clipId);
    if (c?.speedKeys) changeSpeed(clipId, { speedKeys: moveSpeedKey(c.speedKeys, id, t, speed, c.inUs, c.outUs) }, `speedpt-${id}`);
  };
  const addSpeedPoint = (clipId: string, t: number) => {
    const c = clipById(clipId);
    if (!c) return;
    const keys = setSpeedKey(c, t);
    // A point added to a clip at normal speed: slow sound is only kept down to half speed.
    changeSpeed(clipId, { speedKeys: keys, ...(hasRamp(c) || c.muteBelow !== undefined ? {} : { muteBelow: 0.5 }) }, 'speedadd');
    const k = speedKeyNear({ ...c, speedKeys: keys }, t);
    if (k) pickSpeedPoint(clipId, k.id);
  };
  const deleteSpeedPoint = (clipId: string, id: string) => {
    const c = clipById(clipId);
    if (c?.speedKeys) changeSpeed(clipId, removeSpeedKey(c, id), 'speeddel');
    setSpeedSel(null);
  };
  const pickedSpeed = speedSel && tl.clips.find((c) => c.id === speedSel.clipId)?.speedKeys?.some((k) => k.id === speedSel.id) ? speedSel : null;

  // --- Lens match ----------------------------------------------------------------------------------
  const [lensBusy, setLensBusy] = useState(false);
  const matchLensesNow = async (which?: 'front' | 'back') => {
    const cur = locate(tlRef.current, player.time), m = cur && mediaNow(cur.clip.mediaPath);
    if (!cur || !m || !hasTwoLenses(m) || lensBusy) return;
    setLensBusy(true);
    try {
      const r = await matchClipLenses(m, cur.clip, cur.mediaUs, which);
      if (!r) { setNotice('The lenses couldn’t be compared here: too little of the strip both of them see is lit and in view.'); return; }
      const now = tlRef.current.clips.find((c) => c.id === cur.clip.id);
      if (!now) return;
      if (!Object.keys(r.adjust).length || r.before - r.after < 0.5) { setNotice(`The lenses already match about as well as they can (they differ by ${r.before.toFixed(1)} of 255), so nothing was changed.`); return; }
      commit(updateClip(tlRef.current, now.id, { lenses: { [r.lens]: r.adjust as Record<string, number> } }));
      setLensUi({ lens: r.lens });
      setNotice(`Corrected the ${r.lens} lens: where both lenses see the same thing, the difference went from ${r.before.toFixed(1)} to ${r.after.toFixed(1)} of 255.`);
    } catch (e) {
      setError(`Lens match: ${e}`);
    } finally {
      setLensBusy(false);
    }
  };

  const split = () => splitHere();
  const deleteCurrent = () => {
    const t = tlRef.current;
    const s = selRef.current;
    const kf = pickedKf();
    if (!s && pickedSpeed) { deleteSpeedPoint(pickedSpeed.clipId, pickedSpeed.id); return; }
    if (!s && kf) { deleteKeyframeById(kf.clipId, kf.id); return; }
    if (s?.kind === 'audio') commit(removeAudio(t, s.id));
    else if (s?.kind === 'overlay') commit(removeOverlay(t, s.id));
    else if (s?.kind === 'transition') commit(updateClip(t, s.id, { transitionIn: undefined }));
    else if (clip) commit(removeClip(t, clip.id));
    setSel(null);
  };

  const selectClip = (id: string) => {
    setSel(null);
    setKfSel(null);
    setSpeedSel(null);
    const t = tlRef.current;
    const i = t.clips.findIndex((c) => c.id === id);
    const cur = locate(t, player.time);
    if (cur?.clip.id !== id && i >= 0) seek(clipStarts(t)[i]! + 1);
  };

  const step = (frames: number) => {
    player.pause();
    seek(player.time + (frames * 1e6) / (media?.fps ?? 30));
  };

  // --- Overlays, transitions, audio ------------------------------------------------------------
  const addText = () => {
    const t = tlRef.current;
    const total = timelineDuration(t);
    if (!t.clips.length) return;
    const T = Math.min(player.time, Math.max(0, total - 500_000));
    const o = newTextOverlay(T, Math.min(total, T + 4_000_000));
    commit({ ...t, overlays: [...t.overlays, o] });
    setSel({ kind: 'overlay', id: o.id });
  };
  const addGauge = (kind: GaugeKind) => {
    const t = tlRef.current;
    if (!t.clips.length) return;
    const o = newGaugeOverlay(kind, 0, timelineDuration(t));
    commit({ ...t, overlays: [...t.overlays, o] });
    setSel({ kind: 'overlay', id: o.id });
  };
  /** A matching set of gauges in one design, over the whole edit. */
  const addGaugeSet = (design: GaugeDesign) => {
    const t = tlRef.current;
    if (!t.clips.length) return;
    commit({ ...t, overlays: [...t.overlays, ...gaugeSet(design, 0, timelineDuration(t))] });
  };
  const gaugeDesignAll = (design: GaugeDesign) => {
    const t = tlRef.current;
    commit({ ...t, overlays: t.overlays.map((o) => (o.kind === 'text' ? o : { ...o, ...designFor(o.kind, design, o.style) })) });
  };
  const selectedOverlay = sel?.kind === 'overlay' ? tl.overlays.find((o) => o.id === sel.id) ?? null : null;
  const editOverlay = (patch: Partial<Overlay>, key: string) =>
    selectedOverlay && commit(updateOverlay(tlRef.current, selectedOverlay.id, patch), `${key}:${selectedOverlay.id}`);

  const openTransition = (clipId: string) => {
    const t = tlRef.current;
    const c = t.clips.find((x) => x.id === clipId);
    if (!c) return;
    if (!c.transitionIn) commit(updateClip(t, clipId, { transitionIn: { kind: 'crossfade', durationUs: 1_000_000 } }));
    setSel({ kind: 'transition', id: clipId });
  };
  const transitionClip = sel?.kind === 'transition' ? tl.clips.find((c) => c.id === sel.id) ?? null : null;
  const editTransition = (patch: Partial<Transition>, key: string) => {
    if (!transitionClip?.transitionIn) return;
    commit(updateClip(tlRef.current, transitionClip.id, { transitionIn: { ...transitionClip.transitionIn, ...patch } }), `${key}:${transitionClip.id}`);
  };

  const selectedAudio = sel?.kind === 'audio' ? tl.audio.find((a) => a.id === sel.id) ?? null : null;
  const detach = (clipId = clip?.id) => {
    const c = tlRef.current.clips.find((x) => x.id === clipId);
    if (!c) return;
    const next = detachAudio(tlRef.current, c.id);
    const a = next.audio.find((x) => x.linkedClipId === c.id);
    setBusy('Loading audio…');
    // Load the sound for the audio track before switching, so it keeps playing.
    void loadMusic(c.mediaPath)
      .then(() => {
        commit(next);
        if (a) setSel({ kind: 'audio', id: a.id });
      })
      .catch((e) => setError(`Audio: ${e}`))
      .finally(() => setBusy(null));
  };

  // --- Cutting at a point (toolbar, keyboard, right-click menu) ------------------------------------
  const splitHere = (T = player.time) => commit(splitAt(tlRef.current, T));
  const deleteSide = (side: 'left' | 'right', T = player.time) => {
    const t = tlRef.current;
    const at = locate(t, T);
    if (!at) return;
    const next = deleteSideAt(t, T, side);
    if (next === t) return;
    commit(next);
    setSel(null);
    // Land on the cut: the clip's new start (left) or its new end (right).
    const start = clipStarts(next)[at.index] ?? 0;
    seek(side === 'left' ? start + 1 : Math.max(start, T - 1));
  };
  const [kfMenu, setKfMenu] = useState<{ clipId: string; id: string; x: number; y: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ clipId: string; T: number; x: number; y: number } | null>(null);
  const ctxClip = ctxMenu ? tl.clips.find((c) => c.id === ctxMenu.clipId) ?? null : null;
  const ctxIndex = ctxClip ? tl.clips.indexOf(ctxClip) : -1;
  const ctxHasSound = !!(ctxClip && mediaNow(ctxClip.mediaPath)?.info.audioTracks.length);

  // --- Subject tracking ------------------------------------------------------------------------------
  const [trackPick, setTrackPick] = useState(false);
  const [trackBox, setTrackBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [trackJob, setTrackJob] = useState<{ progress: number; abort: AbortController } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const startTrackPick = () => {
    if (!clip || !media || !canReframe(media)) return setError('This clip can’t be reframed, so a subject can’t be followed.');
    player.pause();
    setSel(null);
    setTrackPick(true);
    setNotice('Drag a box around the subject on the preview (Esc to cancel).');
  };
  /** Box in preview pixels → start tracking from the frame on screen. */
  const runTracking = async (box: { x0: number; y0: number; x1: number; y1: number }) => {
    setTrackPick(false);
    setNotice(null);
    const res = lastResult.current;
    const frame = frameRef.current!;
    const W = frame.clientWidth, H = frame.clientHeight;
    if (!res?.layers || !canReframe(res.media)) return;
    const l = res.layers[0]!;
    const found = tlRef.current.clips.find((x) => x.id === l.clip.id);
    if (!found) return;
    const c = adoptReframe(found);
    const flat = clipLens(l.media, c);
    const startUs = l.frames[0]!.timestamp;
    const look = clipLookAt(c, startUs);
    const nx = (x: number) => (x / W) * 2 - 1, ny = (y: number) => 1 - (y / H) * 2;
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const spot = (x: number, y: number) => flatDirection(c, l.media, look, startUs, W / H, nx(x), ny(y));
    const apart = (x0: number, y0: number, x1: number, y1: number) => {
      if (!flat) return angleBetween(look, W / H, [nx(x0), ny(y0)], [nx(x1), ny(y1)]);
      const a = spot(x0, y0)?.camera, b = spot(x1, y1)?.camera;
      return a && b ? (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI : 20;
    };
    const dir = flat ? spot(cx, cy)?.world : directionAt(look, W / H, nx(cx), ny(cy));
    if (!dir) return;
    const size = Math.max(apart(box.x0, cy, box.x1, cy), apart(cx, box.y0, cx, box.y1));
    const abort = new AbortController();
    setTrackJob({ progress: 0, abort });
    try {
      const out = await trackSubject({ clip: c, media: l.media, startUs, yaw: dir.yaw, pitch: dir.pitch, sizeDeg: Math.max(3, size), world: !!flat }, (f) => setTrackJob({ progress: f, abort }), abort.signal);
      if (out.points.length < 3) {
        setError('Couldn’t lock on to that subject — try a box that fits it more tightly.');
        return;
      }
      const t = tlRef.current;
      const now = t.clips.find((x) => x.id === c.id);
      if (!now) return;
      const cur = adoptReframe(now);
      // Keep any earlier tracking before this point (re-track from where it was lost).
      const kept = cur.track?.space === 'world' ? cur.track.points.filter((p) => p.t < startUs) : [];
      const track: ClipTrack = {
        space: 'world',
        points: [...kept, ...out.points],
        smoothing: cur.track?.smoothing ?? 0.25,
        offsetYaw: 0,
        offsetPitch: 0,
        ease: cur.track?.ease,
        after: cur.track?.after,
        from: kept.length ? cur.track?.from : undefined,
        // Auto zoom keeps the subject the size it was framed at when tracking started (or
        // bigger, if its closest moment wouldn't fit a normal lens at that size).
        autoZoom: cur.track?.autoZoom ?? 1,
        lens: cur.track?.lens,
        maxFov: cur.track?.maxFov,
      };
      // How big it was framed: the box, as a share of the picture.
      const share = shareOf(l.media, cur), bend = ownLookAt(cur, startUs).fisheye;
      let framed = flat ? share(Math.max(3, size), flatShot(c, l.media, look, startUs, W / H)!.fov, bend) : Math.max(box.x1 - box.x0, box.y1 - box.y0) / W;
      // A regular clip showing its whole picture has nowhere to move: zoom in enough to follow.
      if (flat && !cur.track?.subjectFrac) framed = Math.max(framed, share(Math.max(3, size), FOLLOW_ROOM * roomFov(cur, l.media), bend));
      track.subjectFrac = fitSubjectFrac(track, cur.track?.subjectFrac ?? framed, bend, share, flat ? Math.min(COMFORT_FOV, 0.8 * roomFov(cur, l.media)) : undefined);
      commit(updateClip(t, c.id, { track, ...(cur === now ? {} : { lensMode: cur.lensMode, look: cur.look, keyframes: cur.keyframes }) }));
      openSection('Subject tracking');
      const end = out.points.at(-1)!.t;
      if (out.cancelled) setNotice(`Tracking stopped at ${fmtTime(end)}. The path so far is kept.`);
      else if (out.lostAt !== undefined && out.left) setNotice(`The subject left the picture at ${fmtTime(out.lostAt)} (clip time). When it comes back, use Track subject again to continue.`);
      else if (out.lostAt !== undefined) setNotice(`Lost the subject at ${fmtTime(out.lostAt)} (clip time). Go there and use Track subject again to continue.`);
      else setNotice(`Tracked the subject to the end of the clip.`);
    } catch (e) {
      setError(`Tracking: ${e}`);
    } finally {
      setTrackJob(null);
    }
  };

  /** Uses only part of a clip's tracked path; shows the frame at the edge being moved. */
  const setClipTrackRange = (id: string, from: number, to: number, edge: 'from' | 'to') => {
    const t = tlRef.current;
    const i = t.clips.findIndex((x) => x.id === id);
    const c = t.clips[i];
    if (!c?.track) return;
    const track = setTrackRange(c.track, from, to);
    commit(updateClip(t, id, { track }), `track-range-${edge}:${id}`);
    const r = trackRange(track);
    if (!r || player.playing) return;
    const m = mediaNow(c.mediaPath);
    const at0 = Math.max(c.inUs, Math.min(c.outUs - (m ? 1e6 / m.fps : 20_000), edge === 'from' ? r[0] : r[1]));
    const T = mediaToTimeline(clipStarts(t)[i]!, c, at0);
    // (Under a transition the playhead belongs to the other clip: leave it alone then.)
    if (locate(t, T)?.clip.id === id) player.seek(T);
  };

  const runTrackingRef = useRef(runTracking);
  runTrackingRef.current = runTracking;

  // --- Files -------------------------------------------------------------------------------------
  const restore = useCallback(async (text: string) => {
    const raw = JSON.parse(text) as Partial<SaveFile> & Partial<Timeline>;
    const timeline = loadTimeline(raw.timeline ?? raw);
    const library = [...new Set([...(raw.library ?? []), ...timeline.clips.map((c) => c.mediaPath)])];
    setBin([]);
    binRef.current = [];
    hist.current = { past: [], future: [], lastKey: '', lastAt: 0 };
    await importPaths(library);
    // (A clip may use one chapter of a recording the bin now shows as a whole.)
    await Promise.all([...new Set(timeline.clips.map((c) => c.mediaPath))].map((p) => getMedia(p).catch(() => {})));
    await Promise.all(timeline.audio.map((a) => loadMusic(a.path).catch(() => {})));
    // Only keep clips whose media opened.
    const ok = timeline.clips.filter((c) => mediaNow(c.mediaPath));
    tlRef.current = { ...timeline, clips: ok };
    setTl(tlRef.current);
    setSel(null);
    player.seek(0);
    if (ok.length < timeline.clips.length) setError(`${timeline.clips.length - ok.length} clip(s) could not be opened (moved or deleted?)`);
  }, [importPaths, player]);

  const saveText = () => JSON.stringify({ version: 1, timeline: tlRef.current, library: binRef.current.map((b) => b.path) } satisfies SaveFile);

  // Autosave.
  const [selftest, setSelftest] = useState(false);
  const restored = useRef(false);
  useEffect(() => {
    if (!restored.current || selftest) return;
    const id = setTimeout(() => void ace.autosaveSave(saveText()), 800);
    return () => clearTimeout(id);
  });

  // Startup: restore the last session (or run the self-test).
  useEffect(() => {
    void ace.info().then(async (info) => {
      if (info.selftest) {
        setSelftest(true);
        const api: EditorApi = {
          importPaths,
          getTimeline: () => tlRef.current,
          setTimeline: (t) => commit(t),
          player,
          setShowRaw,
          nextRender: () => new Promise((res) => renderWaiters.current.push(res)),
          lastResult: () => lastResult.current,
          versions: info.versions,
          mode: info.selftestMode,
          trackBox: (box) => runTrackingRef.current(box),
          run: (cmd) => runRef.current[cmd]?.(),
          dropPaths: async (paths, at) => importFoundRef.current(await ace.importPaths(paths), at),
        };
        void runSelftest(api);
        return;
      }
      const text = await ace.autosaveLoad();
      if (text) await restore(text).catch((e) => setError(`Could not restore last session: ${e}`));
      restored.current = true;
    });
  }, [commit, importPaths, player, restore]);

  const openProject = async () => {
    const r = await ace.openProjectDialog();
    if (!r) return;
    setBusy('Opening project…');
    try { await restore(r.text); } catch (e) { setError(String(e)); } finally { setBusy(null); }
  };
  const saveProject = async () => {
    const path = await ace.saveDialog('project', 'My edit.acproj');
    if (path) await ace.writeFile(path, saveText());
  };
  const importDialog = async () => importFound(await ace.openMediaDialog());
  /**
   * Brings in what a dialog or a drop found: videos to the media bin, sound to the music track.
   * Dropped on the timeline (at time `at`), the videos also go onto it there, in order.
   */
  const importFound = async (found: FoundMedia, at?: number) => {
    const { video, audio, skipped } = found;
    if (skipped.length) {
      const why = [...new Set(skipped.map((x) => x.why))];
      setNotice(skipped.length === 1 ? `“${skipped[0]!.name}” wasn’t imported: ${skipped[0]!.why}.` : `${skipped.length} items weren’t imported (${why.join('; ')}).`);
    } else if ([...video, ...audio].some(cardOf)) setNotice('These files are on a memory card, so they stop working when it’s taken out. “Import from memory card” copies them to the computer.');
    else if (!video.length && !audio.length) setNotice('Nothing there could be imported: videos (.360, .mp4, .mov) and sound (.mp3, .m4a, .wav…) can.');
    const paths = video.length ? await importPaths(video) : [];
    if (at !== undefined && paths.length) {
      const t = tlRef.current, d = timelineDuration(t);
      const hit = d > 0 ? locate(t, Math.min(at, d - 1)) : null;
      let index = hit ? hit.index + (at > hit.startUs + clipDuration(hit.clip) / 2 ? 1 : 0) : t.clips.length;
      if (at >= d) index = t.clips.length;
      for (const p of paths) if (mediaNow(p)) addToTimeline(p, index++);
    }
    if (audio.length) await addMusicPaths(audio, at);
  };
  const importFoundRef = useRef(importFound);
  importFoundRef.current = importFound;
  // Opened with the app from Finder / Explorer.
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  useEffect(() => {
    ace.onOpenMedia((f) => { setWelcome(false); void importFoundRef.current(f); });
    ace.onOpenProject((p) => { setWelcome(false); setBusy('Opening project…'); void restoreRef.current(p.text).catch((e) => setError(String(e))).finally(() => setBusy(null)); });
  }, []);
  // --- Files dragged in from the desktop ---------------------------------------------------------
  const [dropZone, setDropZone] = useState<null | 'app' | 'timeline'>(null);
  const dropAtRef = useRef<(x: number) => number | undefined>(() => undefined);
  useEffect(() => {
    const files = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const zone = (e: DragEvent) => ((e.target as Element | null)?.closest?.('.timeline-wrap') ? 'timeline' : 'app') as 'timeline' | 'app';
    let depth = 0;
    const enter = (e: DragEvent) => { if (!files(e)) return; depth++; setDropZone(zone(e)); };
    const over = (e: DragEvent) => { if (!files(e)) return; e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; setDropZone(zone(e)); };
    const leave = (e: DragEvent) => { if (!files(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDropZone(null); };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      setDropZone(null);
      const paths = ace.pathsOf([...e.dataTransfer!.files]);
      if (!paths.length) return;
      const at = zone(e) === 'timeline' ? dropAtRef.current(e.clientX) : undefined;
      void ace.importPaths(paths).then((f) => importFound(f, at), (err) => setError(String(err)));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); };
  });
  // --- Memory cards ------------------------------------------------------------------------------
  const [cardOpen, setCardOpen] = useState(false);
  const [cardFound, setCardFound] = useState<string | null>(null);
  const cardRun = useCards((s) => s.run), cards = useCards((s) => s.cards);
  useEffect(() => startCards((c) => setCardFound(c.root), (paths) => void importPaths(paths)), [importPaths]);
  useEffect(() => { if (cardOpen) { setCardFound(null); setNotice(null); } }, [cardOpen]);
  const foundCard = cards.find((c) => c.root === cardFound);
  const importing = running(cardRun);
  // An import that ends while its window is closed says so.
  const wasImporting = useRef(false);
  useEffect(() => {
    if (wasImporting.current && cardRun?.ended && !cardOpen) {
      const done = [...cardRun.states.values()].filter((x) => x.state === 'done').length, bad = cardRun.ids.length - done;
      if (cardRun.ended.error || (bad && !cardRun.ended.stopped)) setError(`Import: ${cardRun.ended.error ?? `${bad} recording${bad === 1 ? '' : 's'} couldn’t be copied.`} ${done} of ${cardRun.ids.length} imported.`);
      else if (!cardRun.ended.stopped) setNotice(`${done} recording${done === 1 ? '' : 's'} imported. The card can be taken out.`);
    }
    wasImporting.current = importing;
  }, [cardRun, importing, cardOpen]);
  const addMusic = async () => addMusicPaths(await ace.openAudioDialog());
  const addMusicPaths = async (paths: string[], at?: number) => {
    for (const p of paths) {
      try {
        setBusy(`Loading ${baseName(p)}…`);
        const m = await loadMusic(p);
        const t = tlRef.current;
        const start = at ?? (t.audio.length ? player.time : 0);
        const a = newAudioClip(p, m.durationUs, start);
        commit({ ...t, audio: [...t.audio, a] });
        setSel({ kind: 'audio', id: a.id });
      } catch (e) {
        setError(`${baseName(p)}: ${e}`);
      } finally {
        setBusy(null);
      }
    }
  };
  const loadLutFile = async () => {
    const p = await ace.openLutDialog();
    if (!p) return;
    try {
      parseCube(new TextDecoder().decode(await ace.readAll(p)));
      commit({ ...tlRef.current, lutPath: p });
    } catch (e) {
      setError(`LUT: ${e}`);
    }
  };
  const frameGrab = async () => {
    const res = lastResult.current;
    if (!res?.layers) return;
    const path = await ace.saveDialog('image', `${baseName(res.media.path).replace(/\.\w+$/, '')} ${fmtTime(res.mediaUs).replace(/[:.]/g, '-')}.jpg`);
    if (!path) return;
    setBusy('Saving frame…');
    try {
      await grabFrame(tlRef.current, player.time, res.layers, path);
    } catch (e) {
      setError(`Frame grab: ${e}`);
    } finally {
      setBusy(null);
    }
  };

  // --- Full screen ---------------------------------------------------------------------------------
  const viewerRef = useRef<HTMLElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const h = () => setFullscreen(document.fullscreenElement === viewerRef.current);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);
  /** Just the preview and playback controls, filling the screen. */
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void viewerRef.current?.requestFullscreen().catch((e) => setError(`Full screen: ${e}`));
  };

  // --- First launch: welcome screen and tour -----------------------------------------------------
  const [welcome, setWelcome] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [appName, setAppName] = useState('Action Cam Editor');
  useEffect(() => {
    void ace.info().then((info) => {
      if (info.name) setAppName(info.name);
      // (Self-tests start from a clean slate; only the tour's own test shows it.)
      if (!getPrefs().welcomed && (!info.selftest || info.selftestMode === 'tour')) setWelcome(true);
    });
  }, []);
  const closeWelcome = () => { setWelcome(false); if (!getPrefs().welcomed) setPrefs({ welcomed: true }); };

  // --- Keyboard ----------------------------------------------------------------------------------
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [customize, setCustomize] = useState<CustomizePage | null>(null);
  const arranging = useArranging();
  const shortcuts = usePrefs((p) => p.shortcuts);
  const togglePanel = (ids: string[]) =>
    setPrefs((p) => {
      const open = ids.filter((id) => openPanels(p.layout).includes(id));
      return { layout: open.length ? open.reduce(closePanel, p.layout) : ids.reduce(reopenPanel, p.layout) };
    });
  const toggleDetach = () => (clip?.audioDetached ? commit(reattachAudio(tlRef.current, clip.id)) : clip && detach());
  /** What each command does (menu bar, toolbars and shortcuts all use these). */
  const run: Record<string, () => void> = {
    play: togglePlay, prevFrame: () => step(-1), nextFrame: () => step(1), back10: () => step(-10), fwd10: () => step(10), start: () => seek(0), end: () => seek(timelineDuration(tlRef.current)), fullscreen: () => { if (tlRef.current.clips.length) toggleFullscreen(); },
    split, delLeft: () => deleteSide('left'), delRight: () => deleteSide('right'), keyframe: addKeyframe, delKey: deleteKeyframe, prevKey: () => jumpKey(-1), nextKey: () => jumpKey(1), text: addText, track: startTrackPick, detach: toggleDetach,
    duplicate: () => { if (clip) commit(duplicateClip(tlRef.current, clip.id)); }, delete: deleteCurrent, undo, redo,
    import: () => void importDialog(), card: () => setCardOpen(true), music: () => void addMusic(), open: () => void openProject(), save: () => void saveProject(), export: () => { if (tlRef.current.clips.length) setExportOpen(true); }, grab: () => void frameGrab(),
    customize: () => setCustomize((v) => (v ? null : 'themes')), arrange: () => { setArranging(!isArranging()); setCustomize(null); }, undoUi: undoPrefs, toggleMedia: () => togglePanel(['media']),
    toggleInspector: () => togglePanel(['reframe', 'stabilize', 'color', 'effects', 'clip', 'selection']), toggleTimeline: () => togglePanel(['timeline']), compare: () => setCompare(true), sections: toggleAllSections, speedline: toggleSpeedLines, jumps: toggleJumpMarks, shortcuts: () => setShortcutsOpen(true), tour: () => { setWelcome(false); setTourOpen(true); }, welcome: () => setWelcome(true),
  };
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    ace.onCommand((cmd) => {
      // Undo in a text field undoes the typing, not the edit.
      if ((cmd === 'undo' || cmd === 'redo') && isTextEntry(document.activeElement as HTMLElement)) { document.execCommand(cmd); return; }
      if (cmd === 'compare') { setCompare((v) => !v); return; }
      runRef.current[cmd]?.();
    });
    ace.onWindowFullscreen((on) => { document.documentElement.dataset.winfull = on ? 'on' : 'off'; });
    onNativeTheme((o) => void ace.setWindow(o));
  }, []);

  const matcher = useRef(new KeyMatcher());
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement;
    const typing = isTextEntry(el);
    // Space is always play/pause unless you are typing. Handled before anything else so a
    // focused button, checkbox or slider never receives it.
    if (e.code === 'Space' && !typing && !cardOpen) {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'keydown' && !e.repeat) togglePlay();
      return;
    }
    if (e.type === 'keyup') { matcher.current.release(e).forEach((c) => c !== 'compare' && run[c]?.()); setCompare(false); return; }
    if (typing) return;
    // Behind the import window, keys must not edit the timeline.
    if (cardOpen) { if (e.key === 'Escape') setCardOpen(false); return; }
    if (e.key === 'Escape') {
      if (isArranging()) { setArranging(false); return; }
      if (customize) { setCustomize(null); return; }
      setShortcutsOpen(false); setCtxMenu(null); setSel(null); setTrackPick(false); setTrackBox(null); setNotice(null);
      return;
    }
    // Sliders keep their own arrow, Home and End keys.
    const { mods, key: pressed } = keyOf(e);
    const slider = el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'range';
    if (slider && /^(Arrow\w+|Home|End)$/.test(pressed) && !mods.includes('Mod') && !mods.includes('Alt')) return;
    const r = matcher.current.press(e, shortcuts, performance.now());
    if (r.known) e.preventDefault();
    r.run.forEach((c) => run[c]?.());
    if (r.wait) setTimeout(() => matcher.current.flush(performance.now()).forEach((c) => runRef.current[c]?.()), Math.max(0, r.wait - performance.now()) + 5);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    // Capture phase: runs before the focused element's own key handling.
    window.addEventListener('keydown', h, true);
    window.addEventListener('keyup', h, true);
    const lost = () => { matcher.current.reset(); setCompare(false); };
    window.addEventListener('blur', lost);
    return () => {
      window.removeEventListener('blur', lost);
      window.removeEventListener('keydown', h, true);
      window.removeEventListener('keyup', h, true);
    };
  }, []);

  // --- Pointer on the preview: move overlays, or look around ---------------------------------------
  const drag = useRef<{ kind: 'look'; x: number; y: number; look: Look } | { kind: 'overlay'; x: number; y: number; o: Overlay } | null>(null);
  const boxStart = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (trackPick) {
      const r = frameRef.current!.getBoundingClientRect();
      boxStart.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      setTrackBox({ x0: boxStart.current.x, y0: boxStart.current.y, x1: boxStart.current.x, y1: boxStart.current.y });
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }
    const c = overlayRef.current!;
    const r = c.getBoundingClientRect();
    const sx = c.width / r.width;
    const hit = hitOverlay(tlRef.current, player.time, c.width, c.height, (e.clientX - r.left) * sx, (e.clientY - r.top) * sx);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (hit) {
      setSel({ kind: 'overlay', id: hit.id });
      drag.current = { kind: 'overlay', x: e.clientX, y: e.clientY, o: hit };
      return;
    }
    if (sel?.kind === 'overlay') setSel(null);
    if (look && media && canReframe(media)) drag.current = { kind: 'look', x: e.clientX, y: e.clientY, look };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (trackPick && boxStart.current) {
      const r = frameRef.current!.getBoundingClientRect();
      const x = Math.max(0, Math.min(r.width, e.clientX - r.left)), y = Math.max(0, Math.min(r.height, e.clientY - r.top));
      setTrackBox({ x0: Math.min(boxStart.current.x, x), y0: Math.min(boxStart.current.y, y), x1: Math.max(boxStart.current.x, x), y1: Math.max(boxStart.current.y, y) });
      return;
    }
    const d = drag.current;
    if (!d) return;
    const r = overlayRef.current!.getBoundingClientRect();
    if (d.kind === 'overlay') {
      const x = Math.max(0, Math.min(1, d.o.x + (e.clientX - d.x) / r.width));
      const y = Math.max(0, Math.min(1, d.o.y + (e.clientY - d.y) / r.height));
      commit(updateOverlay(tlRef.current, d.o.id, { x, y }), `ov-move:${d.o.id}`);
      return;
    }
    const flat = clip && media ? clipLens(media, clip) : null;
    // Regular clips: the field of view spans the picture, of which the output may show a part.
    const across = flat ? Math.min(1, aspect / (media!.width / media!.height)) : 1;
    const degPerPx = (Math.min(d.look.fov, 120) * across) / r.width;
    let yaw = d.look.yaw - (e.clientX - d.x) * degPerPx;
    yaw = ((yaw + 540) % 360) - 180;
    const pitch = Math.max(-90, Math.min(90, d.look.pitch + (e.clientY - d.y) * degPerPx));
    // Past the edge of a regular clip's picture the view zooms in; stop before that gets silly.
    if (flat && clip && media && clip.fit === 'fill' && !(clip.track && at && trackWeight(clip.track, at.mediaUs) > 0) && shownFov(adoptReframe(clip), media, { ...d.look, yaw, pitch }, aspect) < d.look.fov * 0.4) return;
    editLook({ yaw, pitch }, 'drag');
  };
  const onWheel = (e: React.WheelEvent) => {
    if (selectedOverlay) {
      editOverlay({ size: Math.max(0.02, Math.min(1, selectedOverlay.size * Math.exp(-e.deltaY * 0.0015))) }, 'ov-size');
      return;
    }
    if (!look || !media || !clip || !canReframe(media)) return;
    const flat = clipLens(media, clip);
    const max = !flat ? 360 : clip.lensMode === 'custom' ? 170 : flat.hfov;
    editLook({ fov: Math.max(flat ? 3 : 1, Math.min(max, look.fov * Math.exp(e.deltaY * 0.0015))) }, 'wheel');
  };

  // --- Toolbar items -------------------------------------------------------------------------------
  const [pps, setPps] = useState(60); // timeline zoom, pixels per second
  const key = (id: string) => { const c = combosOf(id, shortcuts); return c.length ? ` (${c.map(comboLabel).join(' or ')})` : ''; };
  const has = tl.clips.length > 0;
  const bars = usePrefs((p) => p.bars);
  const customPanels = usePrefs((p) => p.customPanels);
  const workspaces = usePrefs((p) => p.workspaces);
  const cmdItem = (id: string, label: string, icon: string, extra: Partial<ToolItem> = {}): ToolItem => ({ label, icon, title: `${COMMANDS.find((c) => c.id === id)?.label ?? label}${key(id)}`, run: run[id], ...extra });
  const status = (
    <span className="status" aria-live="polite">
      {trackJob && (
        <span className="busy track-status">
          <Icon name="track" size={15} /> Tracking subject… {Math.round(trackJob.progress * 100)}%
          <span className="mini-bar"><span style={{ width: `${trackJob.progress * 100}%` }} /></span>
          <button className="link" onClick={() => trackJob.abort.abort()}>Stop</button>
        </span>
      )}
      {importing && !cardOpen && (
        <span className="busy track-status">
          <Icon name="card" size={15} /> {cardRun.paused ? 'Import paused' : 'Importing'} {Math.round(cardRun.fraction * 100)}%
          <span className="mini-bar"><span style={{ width: `${cardRun.fraction * 100}%` }} /></span>
          <button className="link" onClick={() => setCardOpen(true)}>Show</button>
        </span>
      )}
      {foundCard && !importing && !cardOpen && (
        <span className="notice track-status">
          <Icon name="card" size={15} /> {foundCard.name} connected
          <button className="link" onClick={() => setCardOpen(true)}>Import…</button>
          <button className="link" aria-label="Dismiss" onClick={() => setCardFound(null)}>✕</button>
        </span>
      )}
      {notice && !trackJob && <span className="notice" onClick={() => setNotice(null)} title={`${notice} (click to dismiss)`}>{notice} ✕</span>}
      {busy && <span className="busy">{busy}</span>}
      {error && <span className="error" title={error} onClick={() => setError(null)}>{error} ✕</span>}
    </span>
  );
  // The clip's own rate; while playing, what is really being shown if that is less.
  const clipFps = media ? Math.min(media.fps * (clip && at ? speedAt(clip, at.mediaUs) : 1), rate.screen > 20 ? Math.max(rate.screen, 59) : 60) : 0;
  const behind = playing && clipFps > 0 && rate.video > 0 && rate.video < clipFps * 0.9;
  const fpsLabel = !media ? '' : behind ? `${rate.video.toFixed(0)} of ${Math.round(clipFps)} fps` : `${Math.round(clipFps)} fps`;
  const noClips = has ? undefined : 'Add a clip to the timeline first.';
  const items: Record<string, ToolItem> = {
    menu: {
      label: 'Menu', icon: 'menu',
      menu: [
        { label: 'Import media…', hint: comboLabel(comboOf('import', shortcuts)), onClick: run.import! },
        { label: 'Import from memory card…', hint: comboLabel(comboOf('card', shortcuts)), onClick: run.card! },
        { label: 'Add music…', onClick: run.music! },
        { label: 'Open project…', hint: comboLabel(comboOf('open', shortcuts)), onClick: run.open! },
        { label: 'Save project…', hint: comboLabel(comboOf('save', shortcuts)), onClick: run.save! },
        { label: 'Export video…', hint: comboLabel(comboOf('export', shortcuts)), onClick: run.export!, disabled: !has },
        'sep',
        { label: 'Customize…', hint: comboLabel(comboOf('customize', shortcuts)), onClick: () => setCustomize('themes') },
        { label: 'Arrange interface', hint: comboLabel(comboOf('arrange', shortcuts)), onClick: () => setArranging(true) },
        'sep',
        { label: 'Show raw camera streams', checked: showRaw, onClick: () => setShowRaw(!showRaw) },
        { label: 'Full screen preview', hint: comboLabel(comboOf('fullscreen', shortcuts)), onClick: toggleFullscreen, disabled: !has },
        'sep',
        ...PREVIEW_LEVELS.map(([l, label, desc]) => ({ label: `Preview quality: ${label}`, hint: l === 1 ? '' : desc.split(' ')[0], checked: level === l, onClick: () => setLevel(l) })),
        'sep',
        { label: 'Keyboard shortcuts', hint: comboLabel(comboOf('shortcuts', shortcuts)), onClick: () => setShortcutsOpen(true) },
      ],
    },
    import: cmdItem('import', 'Import', 'import'),
    card: cmdItem('card', 'Card', 'card', { on: cardOpen || importing }),
    music: cmdItem('music', 'Music', 'music'),
    open: cmdItem('open', 'Open', 'open'),
    save: cmdItem('save', 'Save', 'save'),
    undo: cmdItem('undo', 'Undo', 'undo', { disabled: !hist.current.past.length }),
    redo: cmdItem('redo', 'Redo', 'redo', { disabled: !hist.current.future.length }),
    text: cmdItem('text', 'Text', 'text', { locked: noClips }),
    gauges: { label: 'Gauges', icon: 'gauge', title: 'Add a telemetry gauge', locked: noClips, menu: [...GAUGES.map(([k, label]) => ({ label, onClick: () => addGauge(k) })), 'sep' as const, { label: 'A matching set of gauges:', disabled: true, onClick: () => {} }, ...GAUGE_DESIGNS.map((d) => ({ label: `${d.name} set`, onClick: () => addGaugeSet(d.id) }))] },
    track: cmdItem('track', 'Track', 'track', { locked: noClips ?? (trackJob ? 'A subject is being tracked. Wait for it to finish, or press Stop.' : undefined), on: trackPick }),
    status: { label: 'Messages', control: status, wide: true },
    frame: {
      label: 'Frame shape', title: 'Output shape',
      control: <label className="inline"><Icon name="frame" /><select aria-label="Frame shape" value={tl.framing} onChange={(e) => commit({ ...tl, framing: e.target.value })}>{FRAMINGS.map((f) => <option key={f.label}>{f.label}</option>)}</select></label>,
    },
    grab: cmdItem('grab', 'Frame grab', 'camera', { locked: noClips }),
    workspaces: {
      label: 'Layouts', icon: 'workspaces', title: 'Switch layout',
      menu: [
        ...LAYOUTS.map(([n, f]) => ({ label: n, onClick: () => setPrefs({ layout: f() }) })),
        ...(Object.keys(workspaces).length ? (['sep', ...Object.entries(workspaces).map(([n, w]) => ({ label: n, onClick: () => setPrefs({ layout: w.layout, bars: w.bars }) }))] as const) : []),
        'sep',
        ...[...Object.entries(PANELS), ...customPanels.map((c) => [c.id, c.title] as const)].map(([id, t]) => ({ label: t, checked: openPanels(getPrefs().layout).includes(id), onClick: () => togglePanel([id]) })),
        'sep',
        { label: 'Save or edit layouts…', onClick: () => setCustomize('layout') },
      ],
    },
    customize: cmdItem('customize', 'Customize', 'customize', { on: !!customize }),
    export: cmdItem('export', 'Export', 'export', { primary: true, locked: noClips }),
    start: cmdItem('start', 'Start', 'start'),
    prev: cmdItem('prevFrame', 'Previous', 'prev'),
    play: cmdItem('play', playing ? 'Pause' : 'Play', playing ? 'pause' : 'play', { disabled: !has }),
    next: cmdItem('nextFrame', 'Next', 'next'),
    end: cmdItem('end', 'End', 'end'),
    time: { label: 'Time', control: <code className="timecode">{fmtTime(time)} <span className="muted">/ {fmtTime(duration)}</span></code> },
    quality: {
      label: 'Preview quality', title: 'Preview quality: lower is smoother on slower computers. Export always uses the full-quality originals.',
      control: <label className="inline"><Icon name="quality" /><select aria-label="Preview quality" value={level} onChange={(e) => setLevel(Number(e.target.value) as PreviewLevel)}>{PREVIEW_LEVELS.map(([l, label]) => <option key={l} value={l}>{label}</option>)}</select></label>,
    },
    fps: {
      label: 'Frames per second',
      title: media ? `This clip is ${+media.fps.toFixed(2)} fps${clip && at && speedAt(clip, at.mediaUs) !== 1 ? `, played at ${+speedAt(clip, at.mediaUs).toFixed(2)}×` : ''}.${playing ? ` Showing ${rate.video.toFixed(0)} new pictures a second; the screen redraws ${rate.screen.toFixed(0)} times a second.` : ''}${player.skimming ? ' This is faster than this computer can decode, so the preview shows fewer pictures; a lower preview quality shows more. Exports have them all.' : ''}${player.stalls ? ` Playback has waited for the video ${player.stalls} times.` : ''}` : 'Frame rate of the clip under the playhead',
      control: <span className="muted small fps">{fpsLabel}</span>,
    },
    compare: cmdItem('compare', 'Before / after', 'compare', { title: `Hold to see the picture without color, LUT, effects and motion blur${key('compare')}`, disabled: !has, on: compare, hold: setCompare }),
    fullscreen: cmdItem('fullscreen', fullscreen ? 'Exit full screen' : 'Full screen', fullscreen ? 'exitfull' : 'fullscreen', { disabled: !has }),
    split: cmdItem('split', 'Split', 'split', { locked: noClips }),
    delLeft: cmdItem('delLeft', 'Delete left', 'delLeft', { locked: noClips }),
    delRight: cmdItem('delRight', 'Delete right', 'delRight', { locked: noClips }),
    detach: cmdItem('detach', clip?.audioDetached ? 'Reattach audio' : 'Detach audio', 'detach', { locked: noClips ?? (media && !media.info.audioTracks.length ? 'This clip has no sound to detach.' : undefined), on: !!clip?.audioDetached }),
    delete: cmdItem('delete', 'Delete', 'trash', { danger: true, disabled: !clip && !sel }),
    duplicate: cmdItem('duplicate', 'Duplicate', 'duplicate', { locked: noClips }),
    keyframe: cmdItem('keyframe', 'Keyframe', 'keyframe', { locked: noClips }),
    delKey: cmdItem('delKey', 'Delete keyframe', 'delKey', { locked: noClips ?? (clip && at && keyframeNear(clip.keyframes, at.mediaUs, snapUs) ? undefined : 'The playhead isn’t on a keyframe. Click a ◆ on the timeline first.') }),
    prevKey: cmdItem('prevKey', 'Previous keyframe', 'prev', { disabled: !clip?.keyframes.length }),
    nextKey: cmdItem('nextKey', 'Next keyframe', 'next', { disabled: !clip?.keyframes.length }),
    sections: cmdItem('sections', 'Sections', 'collapse'),
    arrange: cmdItem('arrange', 'Arrange', 'workspaces', { on: arranging }),
    shortcuts: cmdItem('shortcuts', 'Shortcuts', 'keyboard'),
    speedline: cmdItem('speedline', 'Speed line', 'speedline', { on: speedLines, locked: noClips }),
    jumps: cmdItem('jumps', 'Jumps', 'jumps', { on: jumpMarks, locked: noClips }),
    tlinfo: { label: 'Clip count', control: <span className="muted">{tl.clips.length} clip{tl.clips.length === 1 ? '' : 's'} · {fmtTime(duration)}</span> },
    tlzoom: { label: 'Timeline zoom', title: 'Timeline zoom', control: <label className="inline zoom"><Icon name="zoom" /><Range label="Timeline zoom" min={Math.log(4)} max={Math.log(400)} step={0.01} value={Math.log(pps)} onChange={(v) => setPps(Math.exp(v))} /></label> },
  };
  // A message must never be lost because its toolbar item was removed.
  const statusShown = (['main', 'transport', 'timeline'] as const).some((b) => !bars[b].hidden && bars[b].items.includes('status') && (b === 'main' || openPanels(getPrefs().layout).includes(b === 'transport' ? 'viewer' : 'timeline')));
  const anyStatus = trackJob || notice || busy || error || ((importing || foundCard) && !cardOpen);

  // --- Panels ------------------------------------------------------------------------------------------
  const inspector: InspectorProps = {
    clip: clip,
    clipIndex: at?.index ?? 0,
    clipCount: tl.clips.length,
    media: media,
    mediaUs: at?.mediaUs ?? 0,
    look: look,
    audio: selectedAudio,
    overlay: selectedOverlay,
    transitionClip: transitionClip,
    timeline: tl,
    lutPath: tl.lutPath,
    showRaw: showRaw,
    onShowRaw: setShowRaw,
    onLook: editLook,
    onGrade: editGrade,
    onAddKeyframe: addKeyframe,
    onDeleteKeyframe: deleteKeyframe,
    onDeleteKeyframeId: (id) => clip && deleteKeyframeById(clip.id, id),
    onGoToKeyframe: (id) => clip && pickKeyframe(clip.id, id),
    onClearKeyframes: () => clip && at && editClip({ keyframes: [], look: ownLookAt(clip, at.mediaUs) }, 'clearkeys'),
    onEasing: (e: Easing) => {
          const k = clip && at ? keyframeNear(clip.keyframes, at.mediaUs, snapUs) : undefined;
          if (k && clip) editClip({ keyframes: setEasing(clip.keyframes, k.id, e) }, 'easing');
        },
    onPrevKey: () => jumpKey(-1),
    onNextKey: () => jumpKey(1),
    onClip: editClip,
    lensBusy,
    onMatchLenses: (which) => void matchLensesNow(which),
    onLensesToAll: () => {
      if (!clip) return;
      const t = tlRef.current;
      commit({ ...t, clips: t.clips.map((c) => (hasTwoLenses(mediaNow(c.mediaPath)) ? { ...c, lenses: clip.lenses } : c)) });
    },
    onSpeed: (patch, key) => clip && changeSpeed(clip.id, patch, key),
    onGaugeDesignAll: gaugeDesignAll,
    speedLines,
    onSpeedLines: toggleSpeedLines,
    jumpMarks,
    onJumpMarks: toggleJumpMarks,
    onPreviewAt: (T) => { seek(T); if (!player.playing) player.play(); },
    onSeekMedia: (m) => { if (!clip) return; const i = tlRef.current.clips.findIndex((c) => c.id === clip.id); if (i >= 0) seek(clipStarts(tlRef.current)[i]! + localAt(clip, m)); },
    onGradeToAll: () => {
          if (!look) return;
          const t = tlRef.current;
          commit({ ...t, clips: t.clips.map((c) => ({ ...c, look: { ...c.look, grade: look.grade }, keyframes: c.keyframes.map((k) => ({ ...k, look: { ...k.look, grade: look.grade } })) })) });
        },
    onLoadLut: loadLutFile,
    onClearLut: () => commit({ ...tlRef.current, lutPath: null }),
    onAudio: (patch, key) => selectedAudio && commit(updateAudio(tlRef.current, selectedAudio.id, patch), `${key}:${selectedAudio.id}`),
    onDetachAudio: () => detach(),
    onReattachAudio: (clipId) => { commit(reattachAudio(tlRef.current, clipId)); setSel(null); },
    onOverlay: editOverlay,
    onTransition: editTransition,
    onRemoveSelected: deleteCurrent,
    onCloseSelection: () => setSel(null),
    onTrackSubject: startTrackPick,
    trackBusy: !!trackJob || trackPick,
    onTrackRange: (from, to, edge) => clip && setClipTrackRange(clip.id, from, to, edge),
    onClearTrack: () => clip && commit(updateClip(tlRef.current, clip.id, { track: undefined })),
    onTrackPatch: (patch, key) => clip?.track && commit(updateClip(tlRef.current, clip.id, { track: { ...clip.track, ...patch } }), `${key}:${clip.id}`),
    onSplit: split,
    onDuplicate: () => clip && commit(duplicateClip(tlRef.current, clip.id)),
    onDelete: deleteCurrent,
    onMove: (dir) => clip && at && commit(moveClip(tlRef.current, clip.id, at.index + dir)),
  };
  // Selecting something brings its settings to the front, until another tab is clicked.
  const selKey = sel ? `${sel.kind}:${sel.id}` : '';
  const [frontOff, setFrontOff] = useState('');
  useEffect(() => {
    if (selKey) setPrefs((p) => (openPanels(p.layout).includes('selection') ? {} : { layout: reopenPanel(p.layout, 'selection') }), 'selopen');
    else setFrontOff('');
  }, [selKey]);

  const viewerPanel = () => (
    <main className={`viewer${fullscreen ? ' is-fullscreen' : ''}`} ref={viewerRef} onDoubleClick={(e) => { if ((e.target as HTMLElement).closest('.frame') && !selectedOverlay) toggleFullscreen(); }}>
      {bars.transport.position === 'top' && transport}
      <div className="stage" ref={stageRef}>
          <div
            style={{ visibility: tl.clips.length ? 'visible' : 'hidden' }}
            className={`frame${trackPick ? ' picking' : media && canReframe(media) ? ' grab' : ''}`}
            ref={frameRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => {
              drag.current = null;
              endGesture();
              if (trackPick && boxStart.current && trackBox) {
                boxStart.current = null;
                // A click without dragging picks a box around that point.
                const b = trackBox.x1 - trackBox.x0 < 8 ? { x0: trackBox.x0 - 40, y0: trackBox.y0 - 40, x1: trackBox.x0 + 40, y1: trackBox.y0 + 40 } : trackBox;
                setTrackBox(null);
                void runTracking(b);
              }
            }}
            onWheel={onWheel}
            onContextMenu={(e) => {
              e.preventDefault();
              drag.current = null;
              if (clip) setCtxMenu({ clipId: clip.id, T: player.time, x: e.clientX, y: e.clientY });
            }}
          >
            <canvas ref={canvas0} className="layer" />
            <canvas ref={canvas1} className="layer" />
            <div ref={dipRef} className="dip" />
            <canvas ref={overlayRef} className="overlay-layer" />
            {compare && has && <span className="compare-tag">Before</span>}
            {trackBox && <div className="track-box" style={{ left: trackBox.x0, top: trackBox.y0, width: trackBox.x1 - trackBox.x0, height: trackBox.y1 - trackBox.y0 }} />}
          </div>
        {!has && <div className="empty"><div><Icon name="media" size={42} /><p>Drag videos or folders here,<br />or import them:</p><button className="primary" onClick={run.import}>Import media…</button> <button onClick={run.card}>From memory card…</button></div></div>}
      </div>
      {bars.transport.position === 'bottom' && transport}
    </main>
  );
  const transport = (!bars.transport.hidden || fullscreen) && (
    <div className="transport">
      {fullscreen && (
        <div className="fs-scrub">
          <Range label="Position" min={0} max={Math.max(1, duration)} step={1e6 / (media?.fps ?? 30)} value={Math.min(time, duration)} onPointerDown={() => player.pause()} onChange={seek} />
          {tl.clips.length > 1 && clipStarts(tl).slice(1).map((s0, i) => <i key={i} className="fs-cut" style={{ left: `${(s0 / Math.max(1, duration)) * 100}%` }} />)}
        </div>
      )}
      <Bar id="transport" items={items} />
    </div>
  );
  /** The timeline time under a point of the screen (where something dropped lands). */
  dropAtRef.current = (x: number) => {
    const scroller = document.querySelector<HTMLElement>('.timeline-wrap .timeline-scroll');
    const inner = scroller?.querySelector<HTMLElement>('.timeline-inner');
    if (!scroller || !inner) return undefined;
    const frac = (x - scroller.getBoundingClientRect().left + scroller.scrollLeft) / inner.clientWidth;
    return Math.max(0, frac * Math.max(duration, 1));
  };
  const timelinePanel = () => (
      <div
        className="timeline-wrap"
        onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-ace-media')) e.preventDefault(); }}
        onDrop={(e) => {
          const path = e.dataTransfer.getData('text/x-ace-media');
          if (!path) return;
          e.preventDefault();
          // Insert after the clip under the drop point (or at the end).
          const T = dropAtRef.current(e.clientX) ?? 0;
          const hit = duration > 0 ? locate(tlRef.current, T) : null;
          addToTimeline(path, hit ? hit.index + (T > hit.startUs + clipDuration(hit.clip) / 2 ? 1 : 0) : undefined);
        }}
      >
        <TimelineView
          timeline={tl}
          time={time}
          playing={playing}
          selectedClipId={sel ? null : clip?.id ?? null}
          selection={sel}
          onSeek={seek}
          onSelectClip={selectClip}
          onSelect={setSel}
          onTransition={openTransition}
          onTrimClip={(id, i, o) => {
            const c = tlRef.current.clips.find((x) => x.id === id);
            const m = c && mediaNow(c.mediaPath);
            if (m) commit(rippleItems(tlRef.current, trimClip(tlRef.current, id, i, o, m.durationUs), id), `trim:${id}`);
          }}
          onTrackRange={setClipTrackRange}
          keyframe={pickedKf()}
          onKeyframe={pickKeyframe}
          onMoveKeyframe={dragKeyframe}
          onKeyframeMenu={(clipId, id, x, y) => { pickKeyframe(clipId, id); setKfMenu({ clipId, id, x, y }); }}
          speedLines={speedLines}
          jumpMarks={jumpMarks}
          speedPoint={pickedSpeed}
          onSpeedPoint={pickSpeedPoint}
          onMoveSpeedPoint={moveSpeedPoint}
          onAddSpeedPoint={addSpeedPoint}
          onSpeed={(id, speed) => changeSpeed(id, { speed }, 'speed')}
          onSpeedMenu={(clipId, id, x, y) => { pickSpeedPoint(clipId, id); setSpeedMenu({ clipId, id, x, y }); }}
          onReorderClip={(id, to) => commit(moveClip(tlRef.current, id, to))}
          onMoveAudio={(id, startUs, inUs, outUs) => commit(updateAudio(tlRef.current, id, { startUs, inUs, outUs }), `music:${id}`)}
          onMoveOverlay={(id, startUs, endUs) => commit(updateOverlay(tlRef.current, id, { startUs, endUs }), `ov-time:${id}`)}
          onDragEnd={() => { endGesture(); bump((n) => n + 1); }}
          onClipMenu={(clipId, T, x, y) => setCtxMenu({ clipId, T, x, y })}
          pps={pps}
          onPps={setPps}
          toolbarAt={bars.timeline.position}
          toolbar={!bars.timeline.hidden && <Bar id="timeline" items={items} />}
        />
      </div>
  );
  const panels: Record<string, PanelDef> = {
    media: { title: 'Media', icon: 'media', render: () => <MediaBin level={level} items={bin} onImport={importDialog} onAdd={(p) => addToTimeline(p)} onRemove={(p) => setBin((b) => b.filter((x) => x.path !== p))} /> },
    viewer: { title: 'Preview', icon: 'viewer', bare: true, keep: true, render: viewerPanel },
    timeline: { title: 'Timeline', icon: 'timeline', bare: true, render: timelinePanel },
    ...Object.fromEntries((['reframe', 'stabilize', 'color', 'effects', 'clip'] as const).map((id) => [id, { title: PANELS[id], icon: id, render: () => <InspectorPanel {...inspector} panel={id} /> }])),
    selection: { title: PANELS.selection, icon: 'selection', idle: !sel, render: () => <SelectionPanel {...inspector} /> },
    ...Object.fromEntries(customPanels.map((c) => [c.id, { title: c.title, icon: 'custom', render: () => <InspectorPanel {...inspector} panel={c.id} /> }])),
  };
  const mainBar = !bars.main.hidden && <Bar id="main" items={items} />;
  const top = bars.main.position === 'top';

  return (
    <div className="app">
      {top && mainBar}
      {/* Without a toolbar at the top, the window still needs somewhere to be dragged from. */}
      {platformMac && (!mainBar || !top) && <div className="titlebar">Action Cam Editor</div>}
      <Dock panels={panels} front={sel && frontOff !== selKey ? 'selection' : null} onFront={(p) => setFrontOff(p === 'selection' ? '' : selKey)} />
      {!top && mainBar}

        <AppMenu
          open={!!ctxMenu && !!ctxClip}
          at={ctxMenu ? { x: ctxMenu.x, y: ctxMenu.y } : undefined}
          title={ctxClip ? `Clip ${ctxIndex + 1} · ${fmtTime(ctxMenu!.T)}` : undefined}
          onClose={() => setCtxMenu(null)}
          items={
            ctxMenu && ctxClip
              ? [
                  { label: 'Split here', hint: 'S', onClick: () => { splitHere(ctxMenu.T); seek(ctxMenu.T); } },
                  { label: 'Split and delete left', hint: 'Q', onClick: () => deleteSide('left', ctxMenu.T) },
                  { label: 'Split and delete right', hint: 'W', onClick: () => deleteSide('right', ctxMenu.T) },
                  'sep',
                  ctxClip.audioDetached
                    ? { label: 'Reattach audio', onClick: () => commit(reattachAudio(tlRef.current, ctxClip.id)) }
                    : { label: 'Detach audio', disabled: !ctxHasSound, onClick: () => detach(ctxClip.id) },
                  { label: 'Track subject from here…', disabled: !mediaNow(ctxClip.mediaPath), onClick: () => { seek(ctxMenu.T); setTimeout(startTrackPick, 150); } },
                  ...(() => {
                    const tr = ctxClip.track, r = tr && trackRange(tr), e = tr && trackExtent(tr);
                    if (!tr || !r || !e) return [];
                    const mUs = mediaAt(ctxClip, ctxMenu.T - clipStarts(tl)[ctxIndex]!);
                    return [
                      { label: 'Start following here', disabled: mUs < e[0] || mUs >= r[1], onClick: () => setClipTrackRange(ctxClip.id, mUs, r[1], 'from') },
                      { label: 'Stop following here', disabled: mUs > e[1] || mUs <= r[0], onClick: () => setClipTrackRange(ctxClip.id, r[0], mUs, 'to') },
                    ];
                  })(),
                  { label: ctxClip.transitionIn ? 'Edit transition in' : 'Add transition in', disabled: ctxIndex === 0, onClick: () => openTransition(ctxClip.id) },
                  { label: 'Duplicate clip', onClick: () => commit(duplicateClip(tlRef.current, ctxClip.id)) },
                  'sep',
                  { label: 'Delete clip', hint: '⌫', onClick: () => { commit(removeClip(tlRef.current, ctxClip.id)); setSel(null); } },
                ]
              : []
          }
        />

      <AppMenu
        open={!!kfMenu}
        at={kfMenu ?? undefined}
        title="Keyframe"
        onClose={() => setKfMenu(null)}
        items={(() => {
          const c = kfMenu && tl.clips.find((x) => x.id === kfMenu.clipId), k = c?.keyframes.find((x) => x.id === kfMenu!.id);
          if (!kfMenu || !c || !k) return [];
          const ease = (e: Easing) => () => commit(updateClip(tlRef.current, c.id, { keyframes: setEasing(c.keyframes, k.id, e) }));
          return [
            { label: 'Delete keyframe', icon: 'trash', hint: '⌫', onClick: () => deleteKeyframeById(c.id, k.id) },
            'sep',
            { label: 'Ease in / out', checked: k.easing === 'smooth', onClick: ease('smooth') },
            { label: 'Linear', checked: k.easing === 'linear', onClick: ease('linear') },
            { label: 'Hold', checked: k.easing === 'hold', onClick: ease('hold') },
            'sep',
            { label: `Delete all ${c.keyframes.length} keyframes`, onClick: () => commit(updateClip(tlRef.current, c.id, { keyframes: [], look: k.look })) },
          ];
        })()}
      />
      <AppMenu
        open={!!speedMenu}
        at={speedMenu ?? undefined}
        title="Speed point"
        onClose={() => setSpeedMenu(null)}
        items={(() => {
          const c = speedMenu && tl.clips.find((x) => x.id === speedMenu.clipId), k = c?.speedKeys?.find((x) => x.id === speedMenu!.id);
          if (!speedMenu || !c?.speedKeys || !k) return [];
          const keys = c.speedKeys, set = (patch: Parameters<typeof setClipSpeed>[2]) => () => changeSpeed(c.id, patch, 'speedmenu');
          return [
            { label: 'Delete point', icon: 'trash', hint: '⌫', onClick: () => deleteSpeedPoint(c.id, k.id) },
            { label: 'Normal speed here', onClick: set({ speedKeys: keys.map((x) => (x.id === k.id ? { ...x, speed: 1 } : x)) }) },
            'sep',
            { label: 'Ease to the next point', checked: (k.ease ?? 'smooth') === 'smooth', onClick: set({ speedKeys: setSpeedEase(keys, k.id, 'smooth') }) },
            { label: 'Change evenly', checked: k.ease === 'linear', onClick: set({ speedKeys: setSpeedEase(keys, k.id, 'linear') }) },
            { label: 'Jump', checked: k.ease === 'jump', onClick: set({ speedKeys: setSpeedEase(keys, k.id, 'jump') }) },
            'sep',
            { label: 'Remove the whole ramp', onClick: set({ speedKeys: undefined, speed: 1 }) },
          ];
        })()}
      />
      {anyStatus && !statusShown && <div className="toast">{status}</div>}
      {dropZone && (
        <div className={`drop-veil ${dropZone}`} aria-hidden>
          <div className="drop-card"><Icon name="media" size={34} /><b>{dropZone === 'timeline' ? 'Drop to add to the timeline' : 'Drop to import'}</b><span>Videos, folders and music</span></div>
        </div>
      )}
      {arranging && <ArrangeBar items={items} drag={(e, id, label) => dragItem(e, id, label, null)} onCustomize={() => setCustomize('layout')} onDone={() => setArranging(false)} />}
      {customize && <Customize page={customize} onPage={setCustomize} onClose={() => setCustomize(null)} items={items} />}
      {exportOpen && <ExportDialog timeline={tl} onClose={() => setExportOpen(false)} />}
      {cardOpen && <ImportWindow onClose={() => setCardOpen(false)} />}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {welcome && <Welcome name={appName} onClose={closeWelcome} onImport={run.import!} onCard={run.card!} onOpen={run.open!} onTour={() => setTourOpen(true)} />}
      {tourOpen && <Tour onClose={() => setTourOpen(false)} />}
    </div>
  );
}
