# Next update (beta 8): fixes and additions

All done in 0.1.0-beta.8 (see CHANGELOG.md), with the rest of milestone 2.

From the user's testing of beta 7 (2026-11-25). Grouped by area; numbers are the user's.

## Fixes
- [x] **1. Updater stuck on "Checking for updates"** (seen in beta 6). Check whether beta 7 still does it; add a time limit and a clear message if a check never finishes.
- [x] **4. Airtime and jump distance count only from where the clip starts on the timeline.** Count over the whole recording, so totals and jumps are right even when the clip is trimmed.
- [x] **5. Split / delete left / delete right act on the main row even when a V2–V6 clip is selected.** They should act on the selected track clip.
- [x] **9. Gauges and effects run past the video after a cut.** Trim them to match when footage is cut or deleted.
- [x] **12. Track buttons (hide, lock, mute) cover clips at the start of V2–V6**, so the left edge can't be trimmed. Move the buttons into a header column beside the tracks.

## Tracks V2–V6
- [x] **2. Gauges for clips on V2–V6** (use that clip's ride data).
- [x] **6. Subject tracking and other clip features on V2–V6 clips.**
- [x] **7. Make V2–V6 tracks nearly as tall as the main row**, with keyframes, speed ramps and the rest working the same.
- [x] **10. Solo sound:** an option to mute every other clip playing at the same time, so a V2–V6 clip can be heard on its own.

## Colour and effects
- [x] **3. A small on/off button for each change** in Color and Effects (like Lightroom), to compare with and without it.

## Interface
- [x] **8. Let the timeline run under one or both side panels** (one tall side panel and one short one).
- [x] **13. Zoom the timeline out further** with the zoom slider.

## Export
- [x] **11. One-press export presets for social media:** TikTok, Instagram (Reels), Facebook, YouTube (long form), YouTube Shorts, Snapchat. Research each platform's current best settings (size, frame rate, codec, bit rate, loudness) and offer them as buttons on the Export page. (Overlaps with milestone 3's export presets.)
