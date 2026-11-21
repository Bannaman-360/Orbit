# Action Cam Editor (working name)

Cross-platform (macOS + Windows) desktop editor for action-camera footage, starting with GoPro Max / Max 2 360 video.

Stack: Electron + TypeScript + React, WebCodecs decode, WebGPU rendering, pnpm monorepo.

| Package | Purpose |
|---|---|
| `apps/desktop` | Electron main/preload, file system, device detection |
| `packages/ui` | React screens |
| `packages/engine` | Decode scheduling, frame cache, GPU compositor, audio |
| `packages/media360` | `.360` parsing, EAC reprojection shaders, horizon leveling |
| `packages/telemetry` | GPMF extraction and overlay widgets |
| `packages/project` | Timeline model, undo/redo, versioned project schema |
| `packages/library` | SQLite catalog + `StorageProvider` (local now, cloud later) |
| `packages/export` | Render queue and encode presets |

Sample footage for testing goes in `fixtures/` (see `fixtures/README.md`).

## Running

```bash
pnpm install
pnpm dev            # opens the app
pnpm test           # unit tests
pnpm selftest       # renders test views to selftest-out/ and writes selftest-out/report.json
```

The self-test generates a synthetic `.360` file, then also opens every real clip in `fixtures/`.
