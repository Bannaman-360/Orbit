# Action Cam Editor

An Electron editor for GoPro and action-camera footage (Mac and Windows), meant to be sold.
"Action Cam Editor" is a placeholder name. The user tests; Claude writes the code.

## Layout
- `apps/desktop/`: the Electron app (electron-vite).
  - `src/main/`: main process (file access, card import, ffmpeg encoder, diagnostics).
  - `src/preload/`: the `ace` bridge.
  - `src/renderer/src/`: React UI, player, exporter, self-tests (`selftest*.ts`).
- `packages/engine`: MP4 reading, chapters.
- `packages/media360`: WebGPU reframe renderer.
- `packages/telemetry`: GPMF, stabilizer, airtime and jump distance.
- `packages/project`: timeline, overlays, gauge designs.
- `fixtures/`: local test footage, never committed.
  - `max2/` has the real rides, including `GS010004.360` (7.7 min, 6.7 GB, has GPS).
  - `synthetic/` has generated files; `synthetic/odd/` has broken and unusual ones.
- `scripts/build-ffmpeg-mac.sh`: builds the bundled LGPL ffmpeg into `apps/desktop/resources/ffmpeg/`.
- `docs/INSTALL.md` (install and build), `docs/BETA.md` (testers' guide), `CHANGELOG.md`.
- `docs/ROADMAP.md`: the pro-features plan in five milestones (milestone 1 is released; milestone 2 is done in beta 8; milestone 3 is done in beta 10; milestone 4 is done in beta 11; milestone 5 is next), with the user's decisions. Read it before starting milestone work.

## Commands
Node comes from fnm. In a fresh shell run: `export PATH="$HOME/.local/share/fnm:$PATH"; eval "$(fnm env)"`

- Checks: `pnpm typecheck` and `pnpm test` (Vitest, no footage needed).
- Build the renderer: `cd apps/desktop && npx electron-vite build`
- **Self-tests (use these):** `scripts/selftest.sh <mode>...` runs modes hidden, rebuilding only when sources changed (`--build` forces a build); it prints `<mode> pass` or the fails, and keeps `selftest-out/report-<mode>.json`. `scripts/regress.sh --quick` runs about 5 minutes of checks; `scripts/regress.sh` runs everything (about 45 minutes) and retries a failed mode once.
- Underlying command: `cd apps/desktop && npx electron . --selftest --selftest-mode=<mode>`
  - It writes `selftest-out/report.json`; `fails: []` means it passed. Screenshots land in `selftest-out/`.
  - Modes:
    - interface and app: `ui`, `tour`, `drop`, `report`, `startup`
    - playback and editing: `perf`, `full`, `speed`, `scrubback`, `strip`, `zoom`, `follow`, `stab`, `flat`, `protrim` (roll/slip/slide, JKL, Source view), `snap` (snapping, beats), `markers` (markers, project v2, missing files)
    - colour, lens and 360: `color`, `lens`, `lenslook`, `equirect`, `seamcheck`
    - files: `chapters`, `card`, `odd`, `long`, `pool` (ratings, folders, relink, preview copies)
    - regular videos: `regular` (360 vs regular detection, project shape from the first clip, Fit by default, drag/scroll/crop as a picture; preview vs export)
    - layers: `layers` (tracks V2–V6, picture in picture, split screen; preview vs export, 2×4K playback)
    - masks: `masks` (blur, pixelate, hide; soft edge, invert, keyframes, follow subject; preview vs export)
    - beta 8 and the rest of milestone 2: `beta8` (track header column, cuts on track clips, gauge trimming and source, solo sound, on/off switches, social export presets and loudness, compound clips, multicam)
    - milestone 3: `motion` (curves, motion titles and text paths, sound tools and ducking, true-peak loudness, export queue, presets and batch)
    - milestone 4: `finish` (colour wheels, curves, qualifier, power windows, film looks, noise reduction, new effects and transitions, scopes, stabilizing from the picture; preview vs export; 4K grading playback)
    - ride data and export: `gauges`, `airtime`, `export`, `tenbitexport`, `rider`
  - A full regression runs all of them and takes about 45 minutes. Timing checks (`gauges`, `scrubback`) can fail once when the machine is busy: rerun before treating it as a bug.
- Installers: `pnpm --filter action-cam-editor dist:mac`. This builds Apple Silicon and Intel dmgs into `apps/desktop/release/`. Windows is built by `.github/workflows/installers.yml`.
- Releasing: set the version in `apps/desktop/package.json`, give `CHANGELOG.md` a heading with it, then run Actions → Installers → Run workflow on main (Claude can start it with the GitHub tools): it tags main, builds Windows and publishes the release. Then, on the Mac: `git fetch origin --tags && git checkout v<version> && scripts/release-mac.sh` builds the Mac half, checks the app starts, and adds it to the release (GitHub's Mac machines often never start, so the Mac half is built locally). Each platform's installed apps update once their half is in the release (`src/main/updater.ts`).
- Packaged self-test: run `<App>.app/Contents/MacOS/Action Cam Editor --selftest --selftest-mode=<mode>` with `ACE_REPO_ROOT` set to this repo.

## Rules
- **Tests run hidden.** Never use `--selftest-show` or anything that takes the user's screen, focus or sound.
- **Work on your own:** do as much as possible without the user. Claude may commit, push, open and merge its own pull requests, start workflows and release without asking; ask only when something truly needs the user (their Mac, a purchase, a decision about the product).
- **Commits:** Claude may commit without asking. All commits must use the user's GitHub no-reply email (`360384248+Bannaman-360@users.noreply.github.com`), never their personal one. The remote is `github.com/Bannaman-360/Orbit`.
- **Ask before every download:** packages, runtimes, ffmpeg builds, tools via `npx`.
- **Licensing:** ffmpeg must stay LGPL; never add x264/x265 or other GPL parts. The app is unsigned for now.
- **UI:** Apple-like and customizable through the theme tokens in `src/renderer/src/ui/theme.ts`; use the CSS variables, not fixed colours. It must not hurt playback performance (`perf` mode).
- **Copy:** plain words a rider understands, sentence case; errors say what happened and what to do.
- **Hardware limits:** WebCodecs on this Mac can't write 10-bit, so 10-bit and ProRes go through the bundled ffmpeg. The bundled ffmpeg is minimal: no lavfi and no H.264 encoder (HEVC via VideoToolbox only).
