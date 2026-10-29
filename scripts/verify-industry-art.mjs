// verify:industry-art — the themed industry heroes (public/industries/*): one scene + one palette per industry, reduced-motion fallback,
// accessibility markup, size budget, links intact, facts only from the demo data. Also runs inside verify:industries-site.
// Static only (plain Node). The browser side (frames, timing, keyboard, reduced motion) is in verify-site-clicks / verify-site-placement and the QA harness.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadData, renderAll, renderHandwritten, pageFile, demoLink } from './industries-site/lib.mjs';
import { THEMES, CHOREOS, BACKDROPS, HANDWRITTEN, ART_CSS, ART_JS, STAGE_BUDGET_BYTES, paletteKey, pickStory } from './industries-site/art.mjs';
import { GLYPHS } from './industries-site/glyphs.mjs';

const stripBlocks = (css, head) => { // remove balanced @media blocks that start with `head`
  let out = '', i = 0;
  for (;;) {
    const at = css.indexOf(head, i);
    if (at < 0) return out + css.slice(i);
    out += css.slice(i, at);
    let depth = 0, j = css.indexOf('{', at);
    for (; j < css.length; j++) { if (css[j] === '{') depth++; else if (css[j] === '}' && --depth === 0) break; }
    i = j + 1;
  }
};

export function artChecks(ok, read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8'), exists = (rel) => fs.existsSync(path.join(ROOT, rel))) {
  const data = loadData();
  const slugs = data.industries.map((d) => d.slug);
  const extras = HANDWRITTEN.map(([, k]) => k).filter((k) => !slugs.includes(k));
  const keys = Object.keys(THEMES);

  // 1. a theme for every industry + the hand-written extras; every scene/palette/glyph distinct
  for (const s of [...slugs, ...extras]) ok(!!THEMES[s], `art theme exists for ${s}`);
  ok(keys.length === slugs.length + extras.length, `art themes cover exactly the demo industries + hand-written extras (${keys.length})`);
  const scenes = keys.map((k) => THEMES[k].scene), pals = keys.map((k) => paletteKey(THEMES[k])), glyphs = keys.map((k) => THEMES[k].glyph);
  ok(new Set(scenes).size === keys.length, 'no two industries share a scene id');
  ok(new Set(pals).size === keys.length, 'no two industries share a palette');
  ok(new Set(glyphs).size === keys.length, 'no two industries share a hero glyph');
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const a = THEMES[keys[i]], b = THEMES[keys[j]];
    const dh = (x, y) => Math.min(Math.abs(x - y), 360 - Math.abs(x - y));
    ok(dh(a.hue, b.hue) + dh(a.hue2, b.hue2) >= 30, `${keys[i]} and ${keys[j]} are visually distinct palettes (hue pairs differ by >= 30 degrees in total)`);
    ok(!(a.glyph === b.glyph || (a.bd === b.bd && a.ch === b.ch && dh(a.hue, b.hue) < 25)), `${keys[i]} and ${keys[j]} differ in scene (glyph, or backdrop+choreography+hue)`);
  }
  for (const k of keys) {
    const t = THEMES[k];
    ok(!!GLYPHS[t.glyph], `${k}: glyph ${t.glyph} exists`);
    ok(CHOREOS.includes(t.ch) && BACKDROPS.includes(t.bd), `${k}: choreography ${t.ch} and backdrop ${t.bd} are defined`);
    ok(new RegExp(`\\[data-ch=${t.ch}\\]`).test(ART_CSS), `${k}: css defines choreography ${t.ch}`);
  }

  // 2. shared css/js: reduced-motion fallback, gating, no libraries
  ok(exists('public/industries/ia.css') && read('public/industries/ia.css') === ART_CSS, 'public/industries/ia.css is the built art.css');
  ok(exists('public/industries/ia.js') && read('public/industries/ia.js') === ART_JS, 'public/industries/ia.js is the built art.js');
  ok(/@media \(prefers-reduced-motion:reduce\)\{[^}]*animation:none!important/.test(ART_CSS), 'css: prefers-reduced-motion:reduce turns every stage animation off');
  const outside = stripBlocks(stripBlocks(ART_CSS, '@media (prefers-reduced-motion:no-preference)'), '@media (prefers-reduced-motion:reduce)');
  ok(!/animation\s*:|@keyframes|transition\s*:/.test(outside), 'css: all animation/keyframes live inside prefers-reduced-motion:no-preference (the static final frame is the default)');
  ok(/\.ia-arm\b/.test(ART_CSS) && !/\.ia-stage\s+\.ia-(chip|q|a|s)\s*\{[^}]*opacity:0/.test(ART_CSS), 'css: hidden start states exist only under .ia-arm (no content is hidden without JS)');
  ok(/IntersectionObserver/.test(ART_JS) && /prefers-reduced-motion: reduce/.test(ART_JS) && /visibilitychange/.test(ART_JS), 'js: starts on visibility, honours reduced motion, pauses when the tab is hidden');
  ok(/aria-pressed/.test(ART_JS) && /ia-paused/.test(ART_JS), 'js: pause control updates aria-pressed and pauses the stage');
  ok(!/https?:|fetch\(|XMLHttpRequest|import\(|new Audio|AudioContext|<audio/i.test(ART_JS + ART_CSS), 'art css/js: no network calls, no audio, no external urls');
  ok(!/url\(/i.test(ART_CSS.replace(/url\(#/g, '')), 'art css: no external images or fonts');

  // 3. every page: stage markup, a11y, facts, links, size
  const targets = [];
  for (const d of data.industries) targets.push([`public/industries/${pageFile(d.slug)}`, d.slug, d.slug]);
  for (const [file, key] of HANDWRITTEN) { const rel = `public/industries/${file}`; if (!targets.some((t) => t[0] === rel)) targets.push([rel, key, THEMES[key].data || key]); }
  const nHand = HANDWRITTEN.length;
  const hw = renderHandwritten(data, read);
  for (const [rel, key, srcSlug] of targets) {
    if (!exists(rel)) { ok(false, `${rel} exists`); continue; }
    const html = read(rel), t = THEMES[key];
    const m = html.match(/<!--ia-hero-->([\s\S]*?)<!--\/ia-hero-->/);
    ok(!!m, `${rel}: has the themed stage (<!--ia-hero--> markers)`);
    if (!m) continue;
    const stage = m[0], d = data.industries.find((x) => x.slug === srcSlug), story = pickStory(d, key);
    ok((html.match(/class="ia-stage"/g) || []).length === 1, `${rel}: exactly one stage`);
    ok(stage.includes(`data-scene="${t.scene}"`) && stage.includes(`data-ch="${t.ch}"`), `${rel}: stage carries its own scene id (${t.scene}) and choreography`);
    ok(/role="group" aria-label="[^"]{80,}"/.test(stage), `${rel}: stage has a text alternative describing the example`);
    ok(/<div class="ia-art" aria-hidden="true">/.test(stage) && /<svg [^>]*aria-hidden="true"/.test(stage), `${rel}: decorative art is aria-hidden`);
    ok(/<button class="ia-pb" type="button" aria-pressed="false" aria-label="Pause the animation">/.test(stage), `${rel}: keyboard-reachable pause button`);
    ok(stage.includes(story.q.replace(/&/g, '&amp;')) || stage.includes(story.q.replace(/'/g, '&#39;')) || stage.includes(story.q), `${rel}: question comes from the demo data`);
    ok(t.story || d.questions.some((q) => q.q === story.q && q.answer === story.a), `${rel}: question + answer are a real pair in data.json (or fixed from the sample records)`);
    ok(t.story || (story.s ? d.questions.some((q) => q.q === story.q && q.source === story.s) : true), `${rel}: source is the real source of that answer`);
    ok(story.docs.every((x) => d.docTypes.some((dt) => dt.label === x)), `${rel}: document chips are real document types`);
    ok(/made-up company/.test(stage), `${rel}: labels the records as example / made-up`);
    const vis = stage.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
    ok(!/%|\b(accura|precision|guarantee|testimonial|trusted by|customers love)/i.test(vis), `${rel}: stage text has no percentages, accuracy claims or testimonials`);
    ok(!/<img\b|<audio|<video|<iframe|https?:\/\//i.test(stage), `${rel}: stage uses no images, media or external urls`);
    ok(html.includes('href="/industries/ia.css"') && html.includes('src="/industries/ia.js"'), `${rel}: loads the shared art css/js`);
    const demoWant = data.industries.some((x) => x.slug === key) ? key : (key === 'plumbing' ? 'plumbing-hvac' : null);
    if (demoWant) ok(stage.includes(`href="${demoLink(demoWant)}"`) && html.includes(`href="${demoLink(demoWant)}"`), `${rel}: demo link ${demoLink(demoWant)} intact`);
    ok(/<a class="crumb" href="\/industries\/">Any Business, One App<\/a>/.test(html), `${rel}: Any Business, One App breadcrumb intact`);
    ok(/<nav class="nav"/.test(html) && /nav-dropdown-menu/.test(html), `${rel}: nav and mega-menu intact`);
    const added = Buffer.byteLength(stage) + Buffer.byteLength(ART_CSS) + Buffer.byteLength(ART_JS) + 160;
    ok(added <= STAGE_BUDGET_BYTES, `${rel}: art adds ${(added / 1024).toFixed(1)} KB (budget ${(STAGE_BUDGET_BYTES / 1024).toFixed(0)} KB incl. shared css/js)`);
    ok(html.indexOf('<!--ia-hero-->') > html.indexOf('class="hero-block"') && html.indexOf('<!--ia-hero-->') < html.indexOf('</main>'), `${rel}: stage sits after the hero block, inside main`);
  }
  // hand-written pages are exactly what the injector would produce on their current content (idempotent)
  for (const [rel, next] of hw) ok(read(rel) === next, `${rel}: stage is current (run scripts/industries-site/build.mjs)`);
  ok(targets.length === slugs.length + nHand - HANDWRITTEN.filter(([, k]) => slugs.includes(k)).length, 'every industry page and hand-written page was checked');

  // 4. hub preview: a themed mark on every card, within budget
  const hub = read('public/industries/index.html');
  const icons = hub.match(/<svg class="ia-ic"[\s\S]*?<\/svg>/g) || [];
  ok(icons.length === slugs.length, `hub: every industry card has its themed mark (${icons.length}/${slugs.length})`);
  ok(hub.includes('href="/industries/ia.css"'), 'hub: loads the shared art css');
  ok(Buffer.byteLength(icons.join('')) + Buffer.byteLength(ART_CSS) <= STAGE_BUDGET_BYTES + 12 * 1024, `hub: marks + css add ${((Buffer.byteLength(icons.join('')) + Buffer.byteLength(ART_CSS)) / 1024).toFixed(1)} KB`);
  ok(new Set(icons.map((i) => i.match(/--a:(#\w+);--b:(#\w+)/)?.[0])).size === slugs.length, 'hub: no two cards share a palette');
  ok(!/<img /i.test(hub), 'hub: still no images');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  let fails = 0, checks = 0;
  artChecks((c, msg) => { checks++; if (!c) { fails++; console.error('FAIL: ' + msg); } });
  console.log(`verify-industry-art: ${checks - fails}/${checks} checks passed`);
  process.exit(fails ? 1 : 0);
}
