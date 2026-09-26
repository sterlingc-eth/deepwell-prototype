/**
 * Startup performance measurement (handoffs/STARTUP_PERF_R13.md).
 *
 * Builds ONLY the /app/ entry (the desktop app — what this measurement is
 * about), with '@clerk/clerk-react' aliased to mockClerk.tsx (see that
 * file's doc comment for why) so real App.tsx/AskScreen/usePostgresSync/
 * useBootstrap code runs unmodified against mocked network instead of a
 * real Clerk session this offline test cannot reach. Never used by the real
 * build (vite.config.ts, unmodified) — invoked only by scripts/perf/
 * startup.mjs, with its own outDir so it never collides with `dist/`.
 */
import reactPlugin from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..', '..');

export default defineConfig({
  root,
  resolve: {
    alias: {
      '@clerk/clerk-react': resolve(here, 'mockClerk.tsx'),
    },
  },
  plugins: [reactPlugin()],
  build: {
    outDir: resolve(root, 'dist-perf'),
    emptyOutDir: true,
    rollupOptions: {
      input: { app: resolve(root, 'app/index.html') },
    },
  },
});
