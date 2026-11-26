# Changes

## Unreleased

**Regular (not 360) videos edit like in any video editor**
- A regular video, such as a phone clip or an edit from another app, is now moved, sized and cropped as a picture. Drag it on the preview to move it, and scroll or pinch to make it bigger or smaller. Transform (now in the Reframe panel, at every level) sets position, size, turn and crop, and the crop is a share of the video itself.
- Regular videos start whole (Fit), with black where they don't reach the frame's edges. Fill is one click away under Framing.
- A new project takes the shape of its first regular video: a portrait phone clip makes a 9:16 project. A note says so, and Frame shape in the toolbar changes it back.
- The 360 view controls (Pan, Tilt, Roll) are only shown for 360 videos. Lens tools are only shown for regular clips from a known camera, such as a GoPro.

## 0.1.0-beta.12

Fixes and additions from testing.

**Getting started**
- Choose how much editing you have done: Beginner, Intermediate or Pro, on the welcome screen, in the Layouts menu, or Customize ▸ Layout. Beginner shows just the essentials (fewer panels, toolbar buttons and settings); Pro opens Markers and Scopes too. Anything hidden can be shown again.

**Text and gauges**
- Cut a selected text or gauge at the playhead: S splits it, Q and W cut off the part before or after. They also snap to clip ends, markers and music beats while dragged.
- Alignment guides: while dragging text or a gauge on the picture it snaps to the middle, the safe margins and the edges and middles of the other items, with a line showing what it lined up with. Hold ⌘ to place it freely.
- Gauges count only the footage under them: distance, airtime, jump totals and the timer start at zero where the gauge starts, skip anything cut out, and start again at each cut in the video (turn on “Keep counting across cuts” to carry on through cuts). A gauge you cut in two starts again from the cut.
- New Sound level gauge: how loud the clip's own sound is, as a number, dial, meter, bar or scrolling graph.

**Fixes and settings**
- A regular video is no longer treated as 360 because of its name and shape (for example one exported from a 360 video): only files tagged as 360, or GoPro's own 360 files, are.
- Markers: right-click a marker on the ruler to delete it, or press Shift+M at the playhead.
- Stabilization presets are now Low 50 ms, Medium 100 ms and High 300 ms.
- Windy ride sound preset: wind reduction 80%, low cut 200 Hz, mids +1 dB, treble +3 dB.

## 0.1.0-beta.11

Milestone 4: colour and finishing.

**Grading** (Color panel)
- Color wheels: Lift (shadows), Gamma (mid-tones), Gain (highlights) and Offset (everything). Drag a wheel's dot towards a colour to tint that part of the picture (Shift for fine steps, double-click to centre); the slider under each makes it brighter or darker. Wheels keyframe with the rest of the colour.
- Curves: Luma, Red, Green and Blue, plus Hue vs sat, Hue vs hue and Luma vs sat. Click to add a point and drag it; double-click a point, or drag it away, to remove it. One press for a gentle S-curve.
- Qualifier: changes one range of colours only, like making the sky bluer or the grass greener. Start from Sky, Greenery, Skin, Dirt or Water, set the hue, saturation and brightness it picks, and see what it picks in white with “Show what is picked”.
- Power windows: a mask can now have its own colour (Effects ▸ Masks ▸ Color): exposure, contrast, saturation and temperature inside the shape, with soft edges, keyframes and following a tracked rider like any mask.
- Film looks: nine looks of our own (Warm print, Teal and orange, Faded 70s, Slide film, Bleach bypass, Cross process, Night city, Silver mono, Sepia) with a strength slider, over your grade and LUT. “Save as .cube…” takes a look to other apps.
- Every new tool has an on/off switch to compare with and without it.

**Scopes** (View ▸ Scopes, or the Color & effects layout)
- Waveform, RGB parade, vectorscope (with colour targets and the skin-tone line) and histogram of the clip you are grading, worked out on the graphics card as you play and grade.

**Noise reduction** (Color panel)
- In each frame: smooths grain and colour speckle and keeps edges sharp.
- Across frames: averages each pixel with the frames before it where nothing moved, the cleanest result for night and indoor shots. It shows while playing and in exports.

**Stabilizing clips without motion data**
- Phones, action cameras without a gyro and edited files can now be stabilized: Stabilize ▸ “Stabilize from the picture” works out the shake from the picture itself, once per file (it takes about as long as the clip), then Low, Medium, High, Custom and Crop work as for GoPro footage. The result is kept on this computer.

**Effects**
- New: Bloom and Halation (Film & light), and a Glitch & tape section with VHS, RGB split and Camera shake. New quick looks: VHS tape, Glitch, Film print, Handheld.

**Transitions**
- 17 more (40 in all): Split open, Corner, Fan, Blinds, Checkerboard, Diamond, Star; Cover from left, Cover up, Cover down, Uncover, Drop in, Whip up, Whip down; Zoom out, Shake and Glitch.
- The transition picker shows each one as a small picture that plays when you point at it.

Older versions open these projects without the new grading.

## 0.1.0-beta.10

Milestone 3: motion and sound.

**Curves**
- A Curves section (Reframe) shows how the picture moves between two keyframes. Pick Ease in and out, Linear, Ease in, Ease out, Overshoot, Bounce or Hold, or drag the two handles for a curve of your own (Shift keeps a handle level).
- Framing, Position and size, Colour and Effects can each move on a curve of their own (for example, colour holds while the framing glides).

**Motion titles**
- Toolbar ▸ Titles: 21 titles that move in and out by themselves, in your colours and font. Lower thirds, title cards, end cards (Thanks for watching, Credits roll, Fade out card) and location tags (Map pin, Coordinates, Date stamp, Trail sign). Point at one in the Inspector to see it move.
- Titles fill in ride words: {gps}, {alt}, {date}, {time} and {speed} come from the camera's GPS and clock.
- Text path (Inspector, for plain text): text runs along an arc, a wave, a circle, or a line you draw.

**Sound tools** (Inspector ▸ Sound tools, for clips and music)
- Wind reduction: turns down the low roar of wind across the microphones and keeps voices and engine sound.
- Low cut, a three-band EQ (bass, middle, treble) and a compressor (Gentle, Voice, Punchy, Even out), with one-press settings for a windy ride, talking, engine sound and a clean-up.
- Ducking: tick “This is talking” on clips where someone speaks, and set music to “Lower under talking”: the music goes down while they talk and comes back after.
- What you hear while editing is what you export.

**Export**
- Sound level for every export (not only the one-press settings): −14 LUFS for YouTube and social media, −16, −23, or as mixed. Peaks are now held under −1 dB true peak (between samples, too), and peaky sound still reaches the level.
- After an export, a meter shows its loudness and peak.
- Export queue: “Add to queue…” exports in the background while you keep editing. Toolbar ▸ Queue shows each export with Pause, Resume, Cancel and reordering.
- New one-press settings: YouTube 1080p and Archive (ProRes). Save your own settings under a name.
- Media ▸ ••• ▸ Export several videos: each chosen video is exported on its own, with one set of settings, into one folder.

Projects with curves, titles or sound settings open only in this version or later.

## 0.1.0-beta.9

- Fixed the update check getting stuck on “Checking for updates” on Mac (seen since beta 6). Clearing away the previous update’s download never finished, because of how the app’s own files are stored, and every later check waited for it. It now finishes, and a clean-up that takes too long no longer holds up an update. Macs on beta 6, 7 or 8 need to install this version once by hand (download the .dmg); updates work by themselves after that.

## 0.1.0-beta.8

Fixes from testing beta 7, and the rest of milestone 2 (layers).

**Fixes**
- The update check no longer stays on “Checking for updates”: it gives up after a while with a clear message, and the next check starts afresh. A download that stops arriving is given up too.
- Airtime and jump distance count every jump in the recording, so totals and bests are right when a clip is trimmed.
- Split, delete left and delete right act on the selected clip on V2–V6 (and say why when the playhead isn’t over it or its track is locked).
- Gauges and titles are trimmed with the footage: after a cut or a deleted clip they end with the video, and those only over the cut part go. Deleting a clip closes the gap for everything after it.
- Track buttons (show, lock, mute) sit in a column beside the tracks, so the start of a clip on V2–V6 can be trimmed.

**Tracks V2–V6**
- Tracks are nearly as tall as the main row, and show keyframes, speed ramps, jumps and the tracked part, all editable as on the main row.
- Subject tracking, speed ramps and keyframes work on clips on V2–V6 (right-click ▸ Track subject from here).
- Gauges can show a V2–V6 clip’s ride data (Gauge ▸ Look ▸ Ride data from). A gauge added while such a clip is selected uses it.
- Solo sound (Clip ▸ Audio, or right-click): while that clip plays, the other clips are silent.

**Colour and effects**
- A small switch beside each setting in Color and Effects turns it off to compare (the setting is kept).

**Interface**
- Two new layouts where the timeline runs under one side panel: Tall inspector and Tall media.
- The timeline zooms out much further (an hour fits on screen).

**Export**
- One-press settings for YouTube, YouTube Shorts, TikTok, Instagram Reels, Facebook and Snapchat: size, frame rate, bit rate, and sound brought to −14 LUFS with peaks under −1 dB. The edit is reframed to the platform’s shape for that export only, and you’re warned when it’s longer than the platform takes.

**Compound clips**
- Right-click a clip ▸ Make compound clip (with the next clip, or to the end): the clips, with what is over them on V2–V6, become one clip. Double-click it to open it; a bar above the timeline leads back. Break it apart again from the same menu.

**Multicam**
- Timeline toolbar ▸ Multicam: pick 2 to 4 videos of the same moment; they’re lined up by sound (or the cameras’ clocks).
- While it plays, press 1–4 (or click an angle above the timeline) to cut to that camera. Right-click any cut ▸ Switch angle to change it later.

Projects with compound clips or multicam open only in this version or later.

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
