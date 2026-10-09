// Release history for the two DeepWell version tracks (the app and Donovan).
// ONE data file (src/data/releases.json) drives the public Patch Notes page,
// the version label in the signed-in app and the releases test. This module is
// pure TypeScript (no DOM, no JSON import) so the build config, the test and
// the page renderer can all share it.

export type Track = 'app' | 'donovan'
export type ReleaseType = 'update' | 'patch' | 'hotfix'

export interface Release {
  track: Track
  version: string
  /** The day it went (or goes) live, YYYY-MM-DD. */
  date: string
  type: ReleaseType
  /** false while a release is being prepared: nothing shows anywhere. */
  released: boolean
  /** false keeps a released entry off the public page (the app label still counts it). */
  public: boolean
  /** Two or three plain customer-facing sentences, one per entry. */
  notes: string[]
  /** Never shown to customers and removed from every built file. */
  internal: { sha: string }
}

export interface ReleaseFile {
  schema: 1
  releases: Release[]
}

export const TRACKS: readonly Track[] = ['app', 'donovan']
export const TYPES: readonly ReleaseType[] = ['update', 'patch', 'hotfix']
export const TYPE_LABEL: Record<ReleaseType, string> = {
  update: 'Update',
  patch: 'Patch',
  hotfix: 'Hotfix',
}

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Customer-visible wording must stay positive and free of internal detail.
// These words never belong in a note (defects, security, internal names).
const FORBIDDEN_RE =
  /\b(bugs?|defects?|vulnerabilit\w*|security|exploit\w*|crash\w*|outages?|broke\w*|broken|regressions?|fix(?:ed|es|ing)?|issues?|problems?|errors?|fail\w*|agents?|sentinel|brandy|isaac|claude|rounds?\s*\d+|r\d{1,2}|test(?:s|ed|ing)?|sha)\b/i

export function parseVersion(v: string): [number, number, number] | null {
  const m = VERSION_RE.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
}

function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Returns a list of plain-language problems; an empty list means the file is fine. */
export function validateReleases(data: unknown): string[] {
  const errs: string[] = []
  if (typeof data !== 'object' || data === null) return ['The file is not a JSON object.']
  const file = data as Record<string, unknown>
  if (file.schema !== 1) errs.push('"schema" must be 1.')
  if (!Array.isArray(file.releases)) return [...errs, '"releases" must be a list.']

  const seen = new Set<string>()
  const lastByTrack = new Map<string, Release>()

  file.releases.forEach((raw: unknown, i: number) => {
    const where = `Entry ${i + 1}`
    if (typeof raw !== 'object' || raw === null) {
      errs.push(`${where}: must be an object.`)
      return
    }
    const r = raw as Record<string, unknown>
    const track = r.track
    const label = `${where} (${String(track)} ${String(r.version)})`
    let ok = true
    const bad = (m: string) => {
      errs.push(`${label}: ${m}`)
      ok = false
    }
    if (track !== 'app' && track !== 'donovan') bad('"track" must be "app" or "donovan".')
    if (typeof r.version !== 'string' || !parseVersion(r.version)) bad('"version" must look like 1.2.3.')
    if (typeof r.date !== 'string' || !validDate(r.date)) bad('"date" must be a real day written YYYY-MM-DD.')
    if (!TYPES.includes(r.type as ReleaseType)) bad('"type" must be "update", "patch" or "hotfix".')
    if (typeof r.released !== 'boolean') bad('"released" must be true or false.')
    if (typeof r.public !== 'boolean') bad('"public" must be true or false.')
    const internal = r.internal as Record<string, unknown> | undefined
    if (!internal || typeof internal.sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(internal.sha)) {
      bad('"internal.sha" must be a git commit id (7 to 40 letters and digits).')
    }
    if (!Array.isArray(r.notes) || r.notes.length < 2 || r.notes.length > 3) {
      bad('"notes" must be a list of two or three sentences.')
    } else {
      r.notes.forEach((n: unknown, j: number) => {
        if (typeof n !== 'string' || n.trim() === '') return bad(`note ${j + 1} is empty.`)
        if (n.length > 260) bad(`note ${j + 1} is too long (keep each sentence under 260 characters).`)
        if (!/[.]$/.test(n.trim())) bad(`note ${j + 1} must be one sentence ending in a full stop.`)
        if (/[.!?]\s+[A-Z]/.test(n)) bad(`note ${j + 1} looks like more than one sentence; use one sentence per note.`)
        const hit = FORBIDDEN_RE.exec(n)
        if (hit) bad(`note ${j + 1} uses the word "${hit[0]}", which is not allowed in customer wording.`)
      })
    }
    if (!ok) return

    const rel = r as unknown as Release
    const key = `${rel.track}@${rel.version}`
    if (seen.has(key)) bad('this version already exists on this track.')
    seen.add(key)

    const prev = lastByTrack.get(rel.track)
    if (prev) {
      if (compareVersions(rel.version, prev.version) <= 0) {
        bad(`version must be higher than ${prev.version}, the entry above it on this track.`)
      } else {
        const [pM, pm] = parseVersion(prev.version)!
        const [cM, cm, cp] = parseVersion(rel.version)!
        const sameLine = cM === pM && cm === pm
        if (rel.type === 'update' && sameLine) bad('an Update must raise the first or second number (for example 1.1.0).')
        if ((rel.type === 'patch' || rel.type === 'hotfix') && !sameLine) {
          bad('a Patch or Hotfix may only raise the last number (for example 1.0.1).')
        }
        if (rel.type === 'update' && cm > pm && cp !== 0) bad('an Update ends in .0 (for example 1.1.0).')
        if (rel.date < prev.date) bad(`date is earlier than ${prev.date}, the entry above it on this track.`)
      }
    }
    lastByTrack.set(rel.track, rel)
  })

  for (const t of TRACKS) {
    const any = (file.releases as Release[]).some((r) => r && r.track === t && r.released === true)
    if (!any) errs.push(`The "${t}" track has no released entry, so there is no current version to show.`)
  }
  return errs
}

/** Releases of one track that may be shown, newest first. */
export function visibleReleases(file: ReleaseFile, track: Track, audience: 'public' | 'app'): Release[] {
  return file.releases
    .filter((r) => r.track === track && r.released && (audience === 'app' || r.public))
    .sort((a, b) => compareVersions(b.version, a.version))
}

export function currentRelease(file: ReleaseFile, track: Track, audience: 'public' | 'app'): Release | null {
  return visibleReleases(file, track, audience)[0] ?? null
}
