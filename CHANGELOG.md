# Changes

## 0.1.0-beta.7

The first part of milestone 2 (layers): clips over the main row.

**Picture in picture and split screen**
- Video tracks V2–V6 above the main row. Put a clip there with E, the layers button on a Media item, or by dragging it onto the row above the main row.
- Drag a clip on a track to move it (up or down to change track) and drag its edges to trim it. It moves along when the main row is trimmed or a clip is inserted.
- Each track can be hidden, locked or muted.
- Click a picture in the preview to select it; drag to move it, scroll to resize it.
- Layout (Inspector ▸ Clip): picture in picture in any corner, side by side, stacked, three across, a grid of four, three stacked for 9:16, or full frame.
- Transform (Inspector ▸ Clip): position, size, crop, turn, opacity, rounded corners, border and shadow. Keyframe it to animate.
- Clips on the tracks play their sound, and exports include them.

Projects with tracks open only in this version or later.

## 0.1.0-beta.6

- Checking for updates right after an update had installed could fail with “directory not empty”. The old download is now cleared safely, and a check no longer trips over it.
- When an update fails because of the disk rather than the internet, the message says to restart the app instead of checking the connection.

## 0.1.0-beta.5

**Editing**
- Markers with notes and colours (M); a Markers panel; copy them as YouTube chapters.
- Snapping (N) to clip edges, the playhead, markers and music beats; hold ⌘ (Ctrl on Windows) to drag freely.
- Beats are found in music automatically and shown on it; scrubbing stops on them, so cuts land on the beat.
- Roll, Slip and Slide tools (Shift+N, Y, U; A for Select).
- JKL: play backward and forward, faster with each press; K stops.
- Source view: look at a Media clip on its own, mark in (I) and out (O), then Insert (,) or Overwrite (.) at the playhead.

**Media**
- Star ratings, favourites and rejects, search and filters, and folders.
- Missing videos stay in the project (shown as missing) and can be found again in a folder or on a card, even when renamed.
- See how much room the preview copies take, and delete them.

## 0.1.0-beta.4

The first version that arrives by itself: copies on beta 3 download it in the background and
offer to restart into it (or choose Check for Updates).

- Project pictures on the Projects page now last after the app quits (beta 3 saved them in a way
  that was lost on restart; those show a plain icon until the project is saved again).
- Tests for updating and for the Projects page.

## 0.1.0-beta.3

New:
- **Updates by themselves** (from this version on): the app checks for a new version when it
  starts and every few hours, downloads it in the background, and shows “Version … is ready”.
  Click **Restart to update**: your work is saved, the new version is installed and the app opens
  again. Check by hand with **Check for Updates…** (app menu on Mac, Help on Windows). On a Mac the
  app must be in the Applications folder; the portable Windows version shows a download link.
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
