# Changes

## Unreleased

New:
- **Projects page** (toolbar button, File → Projects…, ⌘⇧P / Ctrl+Shift+P): every saved project
  with a picture, when it was last changed, how many clips and how long. Click one to switch to
  it; right-click to rename, duplicate, show it in Finder / File Explorer, or move it to the Trash.
- **Save without exporting**: Save (⌘S / Ctrl+S) asks for a name the first time and puts the
  project in Projects; after that, changes are saved as you go. Save Project As… saves anywhere
  else, and New Project (⌘N / Ctrl+N) starts a clean edit.
- Switching projects never loses work: the one you leave is saved first, and an edit that was
  never saved is kept in Projects under the date.

## 0.1.0-beta.2

Fixes:
- The app could open to an empty grey window, after a newer version of it had been used on the
  same computer. Projects saved by newer versions now open (with a note about what they added that
  this version doesn't show).
- If the window ever fails to draw, it now says so and offers Try again, Start fresh (your last
  session is kept) and a problem report, instead of staying blank.

## 0.1.0-beta.1

The first beta.

**Editing**
- GoPro Max and Max 2 360° footage (`.360`) and regular action-camera videos: aim the shot after
  riding, follow a subject, stabilize, straighten the horizon.
- Import by dragging videos or whole folders onto the window, or straight from a memory card
  (every file copied and checked; recordings split into chapters are joined back up).
- Timeline with trimming, splitting, speed ramps and slow motion, transitions, music and titles.
- Colour tools, LUTs, lens looks and motion blur.

**Ride data**
- Gauges for speed, G-force, altitude, distance, airtime, jump distance, a GPS map, a timer and the
  time of day, in 12 designs, or a matching set in one click.
- Airtime: every jump is found from the camera's motion sensor, marked on the timeline, and listed
  with its time in the air, its distance (with GPS) and its landing.

**Export**
- H.264 and HEVC; 10-bit HEVC and ProRes 422 HQ for further grading.

**Getting started**
- A welcome screen and a short tour (Help → Show Tour Again).
- Help → Report a Problem copies what's needed to look into a problem.

Known limits: the app isn't signed yet, so the first launch needs one extra step (see below).
Jump distances need the camera to have a GPS fix while riding.
