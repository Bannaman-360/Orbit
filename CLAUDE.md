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

## Commands
Node comes from fnm. In a fresh shell run: `export PATH="$HOME/.local/share/fnm:$PATH"; eval "$(fnm env)"`

- Checks: `pnpm typecheck` and `pnpm test` (Vitest, no footage needed).
- Build the renderer: `cd apps/desktop && npx electron-vite build`
- Hidden self-test: `cd apps/desktop && npx electron . --selftest --selftest-mode=<mode>`
  - It writes `selftest-out/report.json`; `fails: []` means it passed. Screenshots land in `selftest-out/`.
  - Modes:
    - interface and app: `ui`, `tour`, `drop`, `report`, `startup`
    - playback and editing: `perf`, `full`, `speed`, `scrubback`, `strip`, `zoom`, `follow`, `stab`, `flat`
    - colour, lens and 360: `color`, `lens`, `lenslook`, `equirect`, `seamcheck`
    - files: `chapters`, `card`, `odd`, `long`
    - ride data and export: `gauges`, `airtime`, `export`, `tenbitexport`, `rider`
  - A full regression runs all of them and takes about 40 minutes. Timing checks (`gauges`, `scrubback`) can fail once when the machine is busy: rerun before treating it as a bug.
- Installers: `pnpm --filter action-cam-editor dist:mac`. This builds Apple Silicon and Intel dmgs into `apps/desktop/release/`. Windows is built by `.github/workflows/installers.yml`.
- Releasing: set the version in `apps/desktop/package.json`, give `CHANGELOG.md` a heading with it, then run Actions → Installers → Run workflow on main (Claude can start it with the GitHub tools). It tags main with the version, builds, and publishes the release, which sends the update to every installed app (`src/main/updater.ts`). Pushing a tag `v<version>` does the same; this session can't push tags.
- Packaged self-test: run `<App>.app/Contents/MacOS/Action Cam Editor --selftest --selftest-mode=<mode>` with `ACE_REPO_ROOT` set to this repo.

## Rules
- **Tests run hidden.** Never use `--selftest-show` or anything that takes the user's screen, focus or sound.
- **Commits:** Claude may commit without asking. All commits must use the user's GitHub no-reply email (`360384248+Bannaman-360@users.noreply.github.com`), never their personal one. The remote is `github.com/Bannaman-360/Orbit`.
- **Ask before every download:** packages, runtimes, ffmpeg builds, tools via `npx`.
- **Licensing:** ffmpeg must stay LGPL; never add x264/x265 or other GPL parts. The app is unsigned for now.
- **UI:** Apple-like and customizable through the theme tokens in `src/renderer/src/ui/theme.ts`; use the CSS variables, not fixed colours. It must not hurt playback performance (`perf` mode).
- **Copy:** plain words a rider understands, sentence case; errors say what happened and what to do.
- **Hardware limits:** WebCodecs on this Mac can't write 10-bit, so 10-bit and ProRes go through the bundled ffmpeg. The bundled ffmpeg is minimal: no lavfi and no H.264 encoder (HEVC via VideoToolbox only).
