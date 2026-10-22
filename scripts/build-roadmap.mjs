// Renders docs/roadmap.json (the one source of truth) into:
//   (a) the "What we're building" section of index.html, between <!-- roadmap:start --> and <!-- roadmap:end -->
//   (b) the "What features are coming soon?" answer in docs/help/18-known-limits-and-coming-soon.md
// Usage: node scripts/build-roadmap.mjs          write both
//        node scripts/build-roadmap.mjs --check  exit 1 if either is out of sync, or if a "Coming soon" pill on
//                                                index.html (or an industries page) has no matching roadmap item.
// After changing the help article also run: node scripts/build-support-kb.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_PATH = path.join(ROOT, 'docs', 'roadmap.json');
const HTML_PATH = path.join(ROOT, 'index.html');
const HELP_PATH = path.join(ROOT, 'docs', 'help', '18-known-limits-and-coming-soon.md');
const INDUSTRIES_DIR = path.join(ROOT, 'public', 'industries');
const CHECK = process.argv.includes('--check');
const START = '<!-- roadmap:start -->';
const END = '<!-- roadmap:end -->';
const HELP_Q = '### What features are coming soon?';
const SUPPORT_MAIL = 'support@deepwelltechnology.com';

const problems = [];
const fail = (m) => problems.push(m);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ------------------------------------------------------------ load + validate */
const road = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const GROUPS = ['live', 'next', 'later'];
for (const g of GROUPS) {
  if (!Array.isArray(road[g]) || !road[g].length) fail(`roadmap.json: group "${g}" is missing or empty`);
  for (const it of road[g] ?? []) {
    if (!it.title || !it.text) fail(`roadmap.json: ${g}/${it.id ?? '?'} needs a title and a text`);
    if (g !== 'live' && !(Array.isArray(it.match) && it.match.length)) fail(`roadmap.json: ${g}/${it.id ?? '?'} needs a non-empty "match" list`);
    if (/\b(20\d\d|q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(`${it.title} ${it.text}`)) fail(`roadmap.json: ${g}/${it.id} must not carry a date`);
  }
}
if (problems.length) { console.error(problems.map((p) => `build-roadmap: ${p}`).join('\n')); process.exit(1); }

/* ------------------------------------------------------------ (a) website section */
// Layout: "Live now" is a full-width deep-green panel; "In progress" and "Coming next" sit side by side under it
// (stacked on phones). Styles live in index.html <style id="dw-roadmap">.
const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function stage(cls, heading, sub, items) {
  const lis = items.map((it) => `<li>${cls === 'rmx-live' ? `<i class="rmx-ic" aria-hidden="true">${CHECK_SVG}</i>` : '<i class="rmx-ic" aria-hidden="true"></i>'}<div><b>${esc(it.title)}</b><span>${esc(it.text)}</span></div></li>`).join('\n          ');
  return `      <li class="rmx-col ${cls} dw-observe dw-once" aria-labelledby="${cls}-h">
        <div class="rmx-head"><span class="rmx-dot" aria-hidden="true"></span><h3 id="${cls}-h">${esc(heading)}</h3><span class="rmx-count">${items.length} ${esc(sub)}</span></div>
        <ul class="rmx-list">
          ${lis}
        </ul>
      </li>`;
}
const sectionHtml = `${START}
<section id="roadmap" aria-labelledby="roadmap-h">
  <div class="wrap">
    <div class="sec-head dw-observe dw-once">
      <div>
        <div class="eyebrow">Roadmap</div>
        <h2 id="roadmap-h">What we're building</h2>
      </div>
      <p class="lede">What works today, what we're building right now, and what comes after. No dates. We'd rather ship it than promise it.</p>
    </div>
    <ol class="rmx" id="rm-stages" aria-label="Roadmap: live now, in progress, coming next">
${stage('rmx-live', 'Live now', road.live.length === 1 ? 'feature' : 'features', road.live)}
${stage('rmx-next', 'In progress', 'being built', road.next)}
${stage('rmx-later', 'Coming next', 'planned', road.later)}
    </ol>
    <div class="rm-foot">
      <button type="button" class="rm-toggle" id="rm-toggle" aria-expanded="false" aria-controls="rm-stages">Show details</button>
      <p class="rm-ask">Need something that isn't here? <a href="mailto:${SUPPORT_MAIL}?subject=Feature%20request">Tell us what to build <span aria-hidden="true">→</span></a></p>
    </div>
  </div>
</section>
${END}`;

// keep each file's own line endings (the Windows checkout has CRLF), compare and splice in LF
const eolOf = (t) => (t.includes('\r\n') ? '\r\n' : '\n');
const htmlRaw = fs.readFileSync(HTML_PATH, 'utf8');
const html = htmlRaw.replace(/\r\n/g, '\n');
const si = html.indexOf(START);
const ei = html.indexOf(END);
let newHtml;
if (si >= 0 && ei > si) {
  newHtml = html.slice(0, si) + sectionHtml + html.slice(ei + END.length);
} else {
  // first run: insert before the pricing section
  const marker = '<section id="plans">';
  const pi = html.indexOf(marker);
  if (pi < 0) { console.error('build-roadmap: index.html has no roadmap markers and no <section id="plans"> to insert before'); process.exit(1); }
  newHtml = html.slice(0, pi) + sectionHtml + '\n\n' + html.slice(pi);
}

/* ------------------------------------------------------------ (b) help article answer */
const list = (items) => items.map((i) => i.title.toLowerCase()).join(', ');
const answer = [
  `Nothing here has a date, and I can't promise one. Live today: ${list(road.live)}.`,
  `In progress, being built now: ${list(road.next)}.`,
  `Coming next, not available today (marked **coming soon** on the site): ${list(road.later)}.`,
].join(' ');

const helpRaw = fs.readFileSync(HELP_PATH, 'utf8');
const help = helpRaw.replace(/\r\n/g, '\n');
const qi = help.indexOf(HELP_Q);
if (qi < 0) { console.error(`build-roadmap: help 18 has no "${HELP_Q}" entry`); process.exit(1); }
const lines = help.split('\n');
const qLine = lines.findIndex((l) => l.trim() === HELP_Q);
if (!lines[qLine + 1]?.startsWith('~ ')) { console.error('build-roadmap: help 18 entry has no ~ line'); process.exit(1); }
const WANT_SYNS = ['roadmap', 'what are you building', "what's next", 'whats next', 'what is next'];
const terms = lines[qLine + 1].slice(2).split(',').map((t) => t.trim()).filter(Boolean);
for (const s of WANT_SYNS) if (!terms.includes(s)) terms.push(s);
lines[qLine + 1] = `~ ${terms.join(', ')}`;
let aEnd = qLine + 2;
while (aEnd < lines.length && lines[aEnd].trim() !== '' && !lines[aEnd].startsWith('### ')) aEnd++;
lines.splice(qLine + 2, aEnd - (qLine + 2), answer);
const newHelp = lines.join('\n');

/* ------------------------------------------------------------ check or write */
if (CHECK) {
  if (newHtml !== html) fail('index.html roadmap section is out of sync with docs/roadmap.json — run: node scripts/build-roadmap.mjs');
  if (newHelp !== help) fail('docs/help/18-known-limits-and-coming-soon.md is out of sync with docs/roadmap.json — run: node scripts/build-roadmap.mjs');

  // every "Coming soon" pill outside the roadmap block must be covered by a next/later item
  const outside = html.slice(0, si >= 0 ? si : html.length) + (ei > si ? html.slice(ei + END.length) : '');
  const covered = [...road.next, ...road.later];
  const text = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  const re = /<span class="pill-soon">/g;
  let m, n = 0;
  while ((m = re.exec(outside))) {
    // the pill-soon legend inside the pricing note is explanatory, not a feature
    const pStart = outside.lastIndexOf('<p class="plans-note"', m.index);
    if (pStart >= 0 && !outside.slice(pStart, m.index).includes('</p>')) continue;
    n++;
    const lead = text(outside.slice(Math.max(0, m.index - 160), m.index)).slice(-70);
    const hit = covered.find((it) => it.match.some((k) => lead.includes(k.toLowerCase())));
    if (!hit) fail(`index.html "Coming soon" pill after "…${lead.trim()}" has no matching item in roadmap.json next/later`);
  }
  if (!n) fail('verify: found no "Coming soon" pills on index.html — the scan is broken');
  // industries pages marked coming soon must be covered by an "In progress" or "Coming next" item
  for (const f of fs.readdirSync(INDUSTRIES_DIR).filter((x) => x.endsWith('.html'))) {
    const page = fs.readFileSync(path.join(INDUSTRIES_DIR, f), 'utf8');
    if (!/status-pill soon/.test(page)) continue;
    const slug = f.replace(/\.html$/, '').replace(/-/g, ' ');
    if (!covered.some((it) => it.match.some((k) => k.toLowerCase() === slug))) fail(`public/industries/${f} is marked Coming soon but roadmap.json next/later has no item matching "${slug}"`);
  }
  // fleet / equipment rental must stay on the roadmap
  if (!road.later.some((it) => it.id === 'fleet-equipment-rental')) fail('roadmap.json "later" lost Fleet and equipment rental');
  // help 18 must stay public so the public support bot can answer roadmap questions
  if (!/^audience: public$/m.test(help)) fail('help 18 must stay "audience: public"');
  if (problems.length) { console.error(problems.map((p) => `build-roadmap --check: ${p}`).join('\n')); process.exit(1); }
  console.log(`build-roadmap --check: ok (${road.live.length} live, ${road.next.length} next, ${road.later.length} later; ${n} site pills covered)`);
} else {
  if (newHtml !== html) fs.writeFileSync(HTML_PATH, newHtml.replace(/\n/g, eolOf(htmlRaw)));
  if (newHelp !== help) fs.writeFileSync(HELP_PATH, newHelp.replace(/\n/g, eolOf(helpRaw)));
  console.log(`build-roadmap: index.html ${newHtml !== html ? 'updated' : 'unchanged'}, help 18 ${newHelp !== help ? 'updated' : 'unchanged'}`);
}
