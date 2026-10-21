import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'
import { currentRelease, validateReleases, type ReleaseFile } from './src/core/releases.ts'
import { renderPage } from './src/core/releasesPage.ts'

// Release notes: ONE data file (src/data/releases.json) drives the public
// Patch Notes page (rendered here at build time, so it is complete without
// JavaScript) and the version label in the signed-in app. Only the version
// string reaches the app bundle; notes, commit ids and unreleased drafts never do.
const RELEASES_PATH = resolve(__dirname, 'src/data/releases.json')
function loadReleases(): ReleaseFile {
  const data: unknown = JSON.parse(readFileSync(RELEASES_PATH, 'utf8'))
  const errs = validateReleases(data)
  if (errs.length) throw new Error(`src/data/releases.json has problems:\n- ${errs.join('\n- ')}`)
  return data as ReleaseFile
}
function releaseNotesPlugin(): Plugin {
  return {
    name: 'deepwell-release-notes',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!ctx.filename.endsWith('patch-notes.html')) return html
        return renderPage(html, loadReleases())
      },
    },
  }
}
const appRelease = currentRelease(loadReleases(), 'app', 'app')

// Five pages: the marketing site at /, the public Patch Notes page at
// /patch-notes.html, the app at /app/, the lite field app
// (installable PWA) at /m/, and the standalone founders' business-expense
// site at /expenses/ (not linked from the app)
// Demo mode (/demo/, industry demo workspaces with synthetic sample data) is built only when VITE_DEEPWELL_DEMO is "true".
// Off (the default): the page is not in the build at all.
export default defineConfig(({ mode }) => ({
  plugins: [react(), releaseNotesPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(appRelease ? appRelease.version : ''),
  },
  build: {
    rollupOptions: {
      input: {
        site: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app/index.html'),
        mobile: resolve(__dirname, 'm/index.html'),
        expenses: resolve(__dirname, 'expenses/index.html'),
        patchNotes: resolve(__dirname, 'patch-notes.html'),
        ...((process.env.VITE_DEEPWELL_DEMO ?? loadEnv(mode, __dirname, 'VITE_').VITE_DEEPWELL_DEMO) === 'true'
          ? { demo: resolve(__dirname, 'demo/index.html') }
          : {}),
      },
    },
  },
}))
