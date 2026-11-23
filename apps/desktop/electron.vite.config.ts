import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    // Workspace packages are TypeScript source, so bundle them instead of externalising.
    build: { externalizeDeps: { exclude: ['@ace/telemetry', '@ace/media360', '@ace/engine'] } },
  },
  preload: {},
  renderer: {
    plugins: [react()],
  },
});
