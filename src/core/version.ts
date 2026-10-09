// The app version shown discreetly in the signed-in app footer. The build
// (vite.config.ts) injects it from src/data/releases.json, so the full release
// file (notes, commit ids, unreleased drafts) never ships inside the app.
declare const __APP_VERSION__: string | undefined

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
