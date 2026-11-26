
## Trying the beta

Thanks for testing. Download the file for your computer from this page:

| Computer | File |
|---|---|
| Mac with Apple Silicon (M1 and later) | `Action-Cam-Editor-…-mac-arm64.dmg` |
| Mac with an Intel processor | `Action-Cam-Editor-…-mac-x64.dmg` |
| Windows 10 or 11 (64-bit) | `Action-Cam-Editor-…-setup.exe` (or `…-portable.exe` to run without installing) |

Not sure which Mac you have? Apple menu → About This Mac: “Chip: Apple M…” is Apple Silicon.

### Installing

**Mac:** open the .dmg and drag the app onto Applications. The app isn't signed by Apple yet, so
the first time it opens macOS says it can't check it:
- macOS 15 and later: click **Done**, open **System Settings → Privacy & Security**, scroll down,
  click **Open Anyway** next to “Action Cam Editor”, then **Open**.
- macOS 12–14: right-click the app in Applications, choose **Open**, then **Open**.

**Windows:** run the setup file. If “Windows protected your PC” appears, click **More info →
Run anyway**. It installs for your user only and starts the app.

### Updates

From 0.1.0-beta.3 on, the app updates itself: when a new version is out it downloads it and shows
**Version … is ready** at the top of the window. Click **Restart to update** (your work is saved
first). On a Mac, keep the app in the Applications folder so it can replace itself. The portable
Windows version can't, so it shows a **Download** link instead.

### Worth trying

1. Drag a few videos (or a whole folder from your card) onto the window.
2. Put clips on the timeline, trim and split them, try a speed ramp.
3. For 360 videos: drag in the preview to aim, and try subject tracking.
4. Add gauges (speed, G-force, airtime, jump distance) and try a few designs.
5. Grade a clip with the color wheels and curves, with View ▸ Scopes open, and try a film look.
6. A phone or older action-camera clip: Stabilize ▸ Stabilize from the picture.
7. AI tools: Smart reframe for 9:16, Auto subtitles on a clip where someone talks, Smooth slow motion on a clip slowed to 0.25×.
8. Export: H.264, then 10-bit HEVC.

### Windows checklist

If you're on Windows, please tell us whether each of these worked:
- [ ] The installer ran (and what SmartScreen said)
- [ ] Dropping videos onto the window imported them
- [ ] The preview plays smoothly
- [ ] Gauges show data from your camera
- [ ] Export to H.264
- [ ] Export to 10-bit HEVC (is it offered? did the file play?)
- [ ] Help → Report a Problem opened and copied

### Something went wrong?

Choose **Help → Report a Problem…**, click **Copy**, and send it with a few words about what you
were doing. It contains the app version, your system and graphics, and recent problems; folder
names, videos and locations are never included.
