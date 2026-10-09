// Turns src/data/releases.json into the HTML of the public Patch Notes page.
// Runs at build time (vite.config.ts) and in the releases test, so the page
// is complete without JavaScript and a release edit is one file.
import {
  TYPE_LABEL,
  currentRelease,
  visibleReleases,
  type Release,
  type ReleaseFile,
  type Track,
} from './releases.ts'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 2026-10-08 -> "Oct 8, 2026" (fixed format, no time zone surprises). */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return `${MONTHS[(m ?? 1) - 1]} ${d}, ${y}`
}

function entry(r: Release, index: number): string {
  const label = TYPE_LABEL[r.type]
  const bullets = r.notes.map((n) => `<li>${esc(n)}</li>`).join('')
  return (
    `<li class="pn-rel" data-type="${r.type}" style="--i:${index}">` +
    `<span class="pn-node" aria-hidden="true"></span>` +
    `<article class="pn-card">` +
    `<header class="pn-meta"><span class="pn-tag pn-tag--${r.type}">${label}</span>` +
    `<h3 class="pn-v">${esc(r.version)}</h3>` +
    `<time datetime="${r.date}">${formatDate(r.date)}</time></header>` +
    `<ul class="pn-notes">${bullets}</ul></article></li>`
  )
}

export function renderTimeline(file: ReleaseFile, track: Track): string {
  const rels = visibleReleases(file, track, 'public')
  if (!rels.length) return '<p class="pn-empty">Nothing has been released here yet.</p>'
  return `<ol class="pn-tl">${rels.map(entry).join('')}</ol>`
}

export function renderCurrent(file: ReleaseFile, track: Track): { version: string; since: string } {
  const cur = currentRelease(file, track, 'public')
  return cur
    ? { version: esc(cur.version), since: formatDate(cur.date) }
    : { version: '', since: '' }
}

/** Fills the %%TOKENS%% in the page template. */
export function renderPage(template: string, file: ReleaseFile): string {
  const app = renderCurrent(file, 'app')
  const dv = renderCurrent(file, 'donovan')
  return template
    .replace(/%%APP_VERSION%%/g, app.version)
    .replace(/%%APP_SINCE%%/g, app.since)
    .replace('%%APP_TIMELINE%%', () => renderTimeline(file, 'app'))
    .replace(/%%DONOVAN_VERSION%%/g, dv.version)
    .replace(/%%DONOVAN_SINCE%%/g, dv.since)
    .replace('%%DONOVAN_TIMELINE%%', () => renderTimeline(file, 'donovan'))
}
