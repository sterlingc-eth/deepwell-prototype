// npm run verify:releases
// Checks src/data/releases.json (the one file behind the Patch Notes page and
// the app version label) and the page it builds. Fails on a malformed file.
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateReleases, currentRelease, type ReleaseFile } from '../src/core/releases.ts'
import { renderPage } from '../src/core/releasesPage.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`) }
}

console.log('verify:releases')
const raw = readFileSync(resolve(root, 'src/data/releases.json'), 'utf8')
let data: unknown = null
try { data = JSON.parse(raw) } catch (e) { check('releases.json is valid JSON', false, String(e)) }
if (data !== null) {
  check('releases.json is valid JSON', true)
  const errs = validateReleases(data)
  check('releases.json passes every rule', errs.length === 0, errs.join(' | '))
  const file = data as ReleaseFile
  if (!errs.length) {
    const app = currentRelease(file, 'app', 'public')
    const dv = currentRelease(file, 'donovan', 'public')
    check('both tracks have a current public version', !!app && !!dv)
    const tpl = readFileSync(resolve(root, 'patch-notes.html'), 'utf8')
    const html = renderPage(tpl, file)
    check('page has no unfilled placeholders', !/%%[A-Z_]+%%/.test(html))
    check('page shows the current app version', !!app && html.includes(`data-v="${app.version}"`))
    check('page shows the current Donovan version', !!dv && html.includes(`data-v="${dv.version}"`))
    const hidden = file.releases.filter((r) => !r.released || !r.public)
    check('unreleased and non-public entries stay off the page', hidden.every((r) => !r.notes.some((n) => html.includes(n.replace(/&/g, '&amp;').replace(/'/g, "'")))))
    check('internal commit ids never reach the page', file.releases.every((r) => !html.includes(r.internal.sha)))
    const shown = (html.match(/class="pn-rel"/g) || []).length
    const expected = file.releases.filter((r) => r.released && r.public).length
    check('one timeline entry per public release', shown === expected, `${shown} vs ${expected}`)
  }
}

// The rules must reject bad files (the test of the test).
const good = { schema: 1, releases: [
  { track: 'app', version: '1.0.0', date: '2026-10-08', type: 'update', released: true, public: true, notes: ['One sentence here.', 'Another sentence here.'], internal: { sha: 'abc1234' } },
  { track: 'donovan', version: '1.0.0', date: '2026-10-08', type: 'update', released: true, public: true, notes: ['One sentence here.', 'Another sentence here.'], internal: { sha: 'abc1234' } },
] }
const mutate = (fn: (d: any) => void) => { const d = JSON.parse(JSON.stringify(good)); fn(d); return validateReleases(d).length > 0 }
check('a well-formed sample passes', validateReleases(good).length === 0, validateReleases(good).join(' | '))
check('rejects text that is not a release file', validateReleases('nope').length > 0)
check('rejects a missing date', mutate((d) => { delete d.releases[0].date }))
check('rejects an impossible date', mutate((d) => { d.releases[0].date = '2026-02-30' }))
check('rejects an unknown type', mutate((d) => { d.releases[0].type = 'feature' }))
check('rejects a bad version number', mutate((d) => { d.releases[0].version = '1.0' }))
check('rejects a missing commit id', mutate((d) => { delete d.releases[0].internal }))
check('rejects one sentence or four', mutate((d) => { d.releases[0].notes = ['Only one.'] }) && mutate((d) => { d.releases[0].notes = ['A.', 'B.', 'C.', 'D.'] }))
check('rejects a version that does not go up', mutate((d) => { d.releases.push({ ...d.releases[0], version: '1.0.0' }) }))
check('rejects a Patch that raises the middle number', mutate((d) => { d.releases.push({ ...d.releases[0], version: '1.1.0', type: 'patch' }) }))
check('rejects an Update that only raises the last number', mutate((d) => { d.releases.push({ ...d.releases[0], version: '1.0.1', type: 'update' }) }))
check('rejects defect or internal wording', mutate((d) => { d.releases[0].notes[0] = 'We fixed a bug in uploads.' }) && mutate((d) => { d.releases[0].notes[0] = 'Sentinel checked this.' }))
check('rejects a track with nothing released', mutate((d) => { d.releases[1].released = false }))
check('accepts a correct Hotfix after 1.0.0', !mutate((d) => { d.releases.push({ ...d.releases[0], version: '1.0.1', type: 'hotfix', date: '2026-10-09' }) }))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
