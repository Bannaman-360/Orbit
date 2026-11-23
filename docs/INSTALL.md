# Installing and building Action Cam Editor

## For people installing it

**Mac** (macOS 12 or later, Apple Silicon or Intel): open `Action-Cam-Editor-<version>-mac.dmg` and
drag the app onto **Applications**.

The app isn't signed by Apple yet, so the first time it opens macOS says it can't check it.
- macOS 15 and later: click **Done**, then open **System Settings → Privacy & Security**, scroll
  down and click **Open Anyway** next to "Action Cam Editor", then **Open**.
- macOS 12–14: right-click (or Control-click) the app in Applications, choose **Open**, then **Open**.

This is needed once. After that it opens like any other app.

**Windows** (10 or 11, 64-bit): run `Action-Cam-Editor-<version>-setup.exe`. It installs for your
user (no administrator password), adds Start menu and desktop shortcuts, and starts the app.
If SmartScreen says "Windows protected your PC", click **More info → Run anyway** (shown until
the app is signed). `…-portable.exe` runs without installing.

Double-clicking a project (`.acproj`) opens it in the app. Videos can be opened with it
(right-click → Open With).

## For building it

```
pnpm install
scripts/build-ffmpeg-mac.sh      # once: the LGPL ffmpeg used for 10-bit and ProRes export (Mac)
pnpm --filter action-cam-editor dist:mac
```
The .dmg lands in `apps/desktop/release/`. `build-ffmpeg-mac.sh` needs the official source
tarball in `build-deps/ffmpeg-dl/` (see the script). Without ffmpeg the app still works; only the
10-bit HEVC and ProRes export choices are unavailable.

Windows installers are built by the **Installers** GitHub Actions workflow (run it by hand), which
also fetches an LGPL ffmpeg for Windows. 10-bit HEVC on Windows uses the graphics chip's encoder
(Nvidia, AMD or Intel); ProRes works on any PC.

## Licences

The bundled ffmpeg is an LGPL 2.1 build with no GPL or non-free parts; its licence and the source
it was built from are listed in `resources/ffmpeg/` inside the app. Electron and Chromium licences
are in the app's `Resources` folder.

## Later

- **Signing** (no warnings on first launch): see the top of `apps/desktop/electron-builder.yml`.
  Mac needs an Apple Developer ID ($99/year); Windows a code-signing certificate.
- **Automatic updates**: needs a place to publish releases (for example GitHub Releases) and, on
  Mac, signing. electron-builder's `publish` setting plus `electron-updater` add it.
