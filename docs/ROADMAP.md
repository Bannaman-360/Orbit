# Roadmap: pro editing features

The user asked for 17 pro features (2026-11-23). They are built in five milestones, in order.
After each one the user tries it before the next starts: finish a milestone, give a short list of
what to try, then wait for the go-ahead.

## Decisions the user made
- **One milestone at a time**, each checked by the user.
- **AI models are downloaded on first use**, once each, with progress, into `userData/models`, with
  pinned versions and SHA-256 checks. Ask the user before downloading any model during development.
- **Loudness:** exports aim for −14 LUFS by default; export presets set their own target.
- **Licensing:** nothing GPL (the app is sold). OK: onnxruntime-web (MIT), transformers.js
  (Apache-2.0), RIFE (MIT), Real-ESRGAN (BSD-3), Whisper (MIT).
- **Branches:** each milestone is built on its own branch, then merged into `main` and released as
  the next beta (see Releasing in CLAUDE.md).

## Status
| Milestone | Items | Status |
|---|---|---|
| 1. Editing core | 3, 10, 15, 16 + project format 2 | **Done**: released in 0.1.0-beta.5 |
| 2. Layers | 1, 2, 4, 14 | **In progress**: tracks, N-layer pipeline, Transform and layouts released in beta 7; masks and tracked blur done on `features/m2-masks`; compound clips and multicam next |
| 3. Motion and sound | 5, 6, 7, 9 | Planned |
| 4. Colour and finishing | 11, 12, 13, 17 | Planned |
| 5. AI tools | 8 | Planned |

The numbers are the user's original list:
1. Multiple video tracks and layering: picture-in-picture, split screen.
2. Multicam, synced by audio or timecode, cut live.
3. Beat detection with snapping.
4. Masks and tracked blur.
5. Keyframe curve editor.
6. Motion titles.
7. Audio tools: wind reduction, loudness, ducking, EQ and compressor.
8. AI tools: frame interpolation, upscaling, smart 9:16 reframe, auto subtitles.
9. Export presets, render queue and batch export.
10. Markers and ratings.
11. Advanced grading and scopes.
12. Noise reduction.
13. Optical-flow stabilization.
14. Compound clips and nested timelines.
15. Media management.
16. Pro trimming.
17. Effects and transitions library.

## How the app works today (what the milestones build on)
- **Timeline model** (`packages/project/src/timeline.ts`):
  - The main row is magnetic. `TimelineClip` has no start time; `clipStarts` derives starts from
    clip order and transitions.
  - `layersAt` returns at most two layers, used for transitions.
  - Overlays, audio and markers float freely with their own `startUs`.
  - The project format is version 2 (`TIMELINE_VERSION`); `loadTimeline` upgrades older files.
- **Two-layer pipeline:**
  - Preview: two canvases and two `ReframeRenderer`s, chosen by clip `index % 2` (`App.tsx`), and
    styled by `styleLayers` / `layerCss`.
  - Export: `Compositor` with a fixed pair of renderers (`exporter.ts`), and `compositeLayers` in
    `overlayRender.ts`, which is hard-wired to two sources.
  - `drawLayer` already applies alpha, translate, scale, rotate and blur to a layer.
- **Player** (`timelinePlayer.ts`): one slot per visible clip plus a 1.2 s pre-roll.
- **Colour:** one WGSL finish pass (`packages/media360/src/finish.ts`): blend → grade → LUT →
  effects. Its uniforms are vec4s packed in `renderer.ts present()`.
- **Keyframes:** each one snapshots the whole look, with easing `smooth|linear|hold`
  (`keyframes.ts`). Speed keys have their own easing (`speed.ts`).
- **Audio:** WebAudio. `voices()` in `audioEngine.ts` serves both live playback and the offline
  export mix.
- **Tracking:** MOSSE (`tracker.ts`). It outputs view directions (`TrackPoint{t, yaw, pitch, size}`),
  not boxes. Use `trackAt` with `worldToClipView` (`frameRender.ts`) to place things in the picture.

## Milestone 2: Layers (items 1, 2, 4, 14)
Done so far (self-test mode `layers`): tracks V2–V6 (`tl.tracks`, `tl.connected`, project format 3),
`stackAt` in `packages/project/src/layers.ts`, renderer pools in preview and export, `compositeLayers`
taking an array, the transform as `look.xf` (keyframed with the look), layout templates, track sound.
Masks (self-test mode `masks`): `clip.masks` (`packages/project/src/masks.ts`, up to 4, own keyframes),
coverage drawn in `masksRender.ts` into one RGBA texture (one mask per channel) read by the finish
pass; "Follow subject" uses the clip's track (`steer: false` = masks only, view stays put).
- **Tracks V2–V6** above the main row (like Final Cut's connected clips):
  - Clips on these tracks are placed freely with a `startUs` and draw over the main row.
  - The main row keeps working exactly as now.
  - Each track header has show, lock and mute.
  - A Transform section: position, scale, crop, rotation, opacity, corner radius, border, shadow.
    All keyframeable.
  - Layout templates: picture-in-picture in the four corners, split 2 (side by side or stacked),
    split 3, a 2×2 grid, and a vertical stack for 9:16.
- **N-layer pipeline:**
  - `layersAt` returns `LayerFrame[]`, each with a placement.
  - A pool of renderers replaces `index % 2`, for up to 6 visible layers.
  - `compositeLayers` takes an array. Preview (CSS) and export (2D) must still match.
  - Performance budget: 2 × 4K layers in real time at Full; 4 layers on proxies.
- **Masks and tracked blur:**
  - Shapes: rectangle, ellipse, freehand. Each has feather, invert and expand.
  - Effects: blur, pixelate, hide.
  - Each mask is drawn per frame as a small mask texture and sampled in the finish pass.
  - "Follow subject" uses the existing tracker. Masks are keyframeable.
  - The same masks become colour power windows in milestone 4.
- **Compound clips and nested timelines:**
  - A clip can point to a sequence instead of a file. It's evaluated by flattening into layers, not
    by rendering to a texture.
  - Several timelines per project, with a breadcrumb to go back up.
- **Multicam:**
  - Sync by audio cross-correlation (FFT of envelopes), or by camera clock, timecode or GPS time.
  - A 2×2 angle viewer (from proxies), with live cutting on keys 1–4 while playing.
  - Cuts are written as ordinary main-row cuts, tagged with a group. "Switch angle" works on any
    cut later.

## Milestone 3: Motion and sound (items 5, 6, 7, 9)
- **Curve editor:**
  - Bézier handles per keyframe segment, plus per-value overrides.
  - A Curves panel for any keyframed value.
  - Presets: ease in, ease out, overshoot, bounce. The existing smooth / linear / hold become
    named curves.
- **Motion titles:**
  - About 20 templates: lower thirds, title cards, end cards, location tags.
  - Text on a path: arc, wave, circle, freehand.
  - Drawn in Canvas2D, the same code as overlays.
- **Audio tools:**
  - Per-clip 3-band EQ with a low cut, and a compressor with presets.
  - Wind reduction as an AudioWorklet: STFT with gated low-band suppression.
  - Auto-duck music under voice.
  - BS.1770 loudness with a true-peak limiter at −1 dBTP, and a meter in Export.
  - These sit in the `voices()` chain, so playback and export match.
- **Export presets, render queue and batch:**
  - Presets: YouTube 4K / 1080, Reels, TikTok, Shorts (9:16), Archive (ProRes), plus the user's
    own.
  - A background queue with pause and cancel.
  - Batch export of several Media clips.

## Milestone 4: Colour and finishing (items 11, 12, 13, 17)
- **Grading:**
  - Wheels: lift, gamma, gain, offset.
  - Curves: RGB, luma, hue vs sat, hue vs hue, as a 1D LUT texture.
  - An HSL qualifier.
  - Power windows: milestone 2's masks applied to a second grade.
- **Scopes:** waveform, RGB parade, vectorscope and histogram, as GPU compute in a Scopes panel.
- **Noise reduction:** spatial (edge-preserving) and temporal (a motion-checked blend of the
  motion-blur history frames).
- **Optical-flow stabilization** for clips without gyro data: FAST corners and pyramidal
  Lucas–Kanade give a camera path, which goes through the existing smoothing and `planCrop`.
- **More effects and transitions:**
  - Effects: bloom and glow, halation, our own film LUTs, VHS, light leaks, shake, RGB split.
  - Transitions: about 15 more, with animated previews.

## Milestone 5: AI tools (item 8)
- **Smooth slow motion:** RIFE frames for slow parts of speed ramps. Cached; preview plays the
  cache, and export always uses it.
- **Upscale:** 2× and 4× with Real-ESRGAN compact. Cached.
- **Smart reframe to 9:16** (no model needed):
  - Follows the tracker, or motion saliency after background compensation (`background.ts`).
  - On 360 clips, follows the direction of travel.
  - Produces an editable keyframed path.
- **Auto subtitles:** Whisper (base, or small for better accuracy) makes a captions track and an
  `.srt` file.

## Verification for every milestone
- **Unit tests** for the model and maths.
- **Hidden self-tests** for each feature. Preview and export must match.
- **Performance budgets** in `perf`.
- **A full regression** with `scripts/regress.sh`.
- **Screenshots** in light and dark.
- **A try-list** for the user at the end.
