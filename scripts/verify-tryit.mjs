// Checks the marketing-page "Try it" industry picker.
//  1. Data: every industry has example documents and questions, every answer cites a document that exists.
//  2. index.html carries an up-to-date copy of src/data/tryIt.json.
//  3. In a browser: default industry, ?industry= links, picker (chips on desktop, menu on a phone), no sideways scroll.
// Usage: node scripts/verify-tryit.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'src/data/tryIt.json'), 'utf8'));
let failures = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { failures++; console.log('  FAIL', m); } };

const WANT = ['real-estate', 'property-management', 'hvac', 'plumbing', 'electrical', 'general-contractor', 'landscaping', 'cleaning-facilities', 'auto-repair', 'nonprofit', 'office-professional'];
const inds = data.industries;
ok(inds.map(i => i.slug).join() === WANT.join(), 'industries are the agreed eleven, real estate first');
for (const i of inds) {
  const t = `[${i.slug}]`;
  ok(typeof i.label === 'string' && i.label.length > 0, `${t} has a label`);
  ok(Array.isArray(i.documents) && i.documents.length >= 3 && i.documents.length <= 5, `${t} has 3-5 documents`);
  ok(Array.isArray(i.questions) && i.questions.length >= 4 && i.questions.length <= 6, `${t} has 4-6 questions`);
  const ids = new Set();
  for (const d of i.documents || []) {
    ok(d.id && !ids.has(d.id), `${t} document id unique: ${d.id}`); ids.add(d.id);
    ok(d.name && d.type && d.icon && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.fields?.length >= 2, `${t} document ${d.id} has name, type, icon, date and key fields`);
  }
  const qs = new Set();
  for (const q of i.questions || []) {
    ok(!qs.has(q.q), `${t} question unique: ${q.q}`); qs.add(q.q);
    ok(q.answer && q.fields?.length >= 2 && q.keys?.s?.length && q.keys?.w?.length, `${t} "${q.q}" has an answer, fields and match keys`);
    ok(q.sources?.length >= 1, `${t} "${q.q}" cites at least one source`);
    for (const s of q.sources || []) {
      ok(ids.has(s.doc), `${t} "${q.q}" cites a document that exists (${s.doc})`);
      ok(/^page \d+/.test(s.where), `${t} "${q.q}" source names a page (${s.where})`);
    }
  }
  // each sample question finds itself, and no other question in the same industry
  const score = (k, text) => k.s.filter(x => text.includes(x)).length * 2 + k.w.filter(x => text.includes(x)).length;
  i.questions.forEach((q, n) => {
    const scores = i.questions.map(o => score(o.keys, q.q.toLowerCase()));
    ok(scores[n] >= 2 && scores.every((s, m) => m === n || s < scores[n] || s < 2), `${t} "${q.q}" matches itself best`);
  });
}

// index.html in step with the data file
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const m = /<script type="application\/json" id="tryit-data">([\s\S]*?)<\/script>/.exec(html);
ok(!!m && JSON.stringify(JSON.parse(m[1])) === JSON.stringify(data), 'index.html copy matches src/data/tryIt.json (run node scripts/build-tryit.mjs)');

// browser checks
let chromium;
try { ({ chromium } = await import('playwright')); } catch { console.log('  (playwright not installed: browser checks skipped)'); }
if (chromium) {
  const file = path.join(root, 'index.html');
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const f = p === '/' ? file : path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(f)] || 'application/octet-stream');
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const phone = vp.width < 500;
    const ctx = await browser.newContext({ viewport: vp, hasTouch: phone, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', x => { if (x.type() === 'error' && !/Failed to load resource/.test(x.text())) errs.push(x.text()); });
    const t = `[${vp.width}px]`;
    await page.goto(base, { waitUntil: 'load' });
    ok(await page.inputValue('#ind-select') === 'real-estate', `${t} real estate is the default`);
    ok((await page.textContent('#q0')).includes('closing date on 412 Elm St'), `${t} default questions are real estate`);
    ok(await page.locator('#docs-row .doc').count() === inds[0].documents.length, `${t} example documents shown`);
    await page.goto(base + '?industry=plumbing', { waitUntil: 'load' });
    ok(await page.inputValue('#ind-select') === 'plumbing', `${t} ?industry=plumbing selects plumbing`);
    ok((await page.textContent('#docs-label')).includes('Plumbing'), `${t} documents follow the link`);
    await page.goto(base + '?industry=nope', { waitUntil: 'load' });
    ok(await page.inputValue('#ind-select') === 'real-estate', `${t} unknown industry falls back to real estate`);
    // pick each industry with the control a visitor actually sees
    for (const i of inds) {
      if (phone) await page.selectOption('#ind-select', i.slug);
      else await page.locator(`.ind-chip[data-slug="${i.slug}"]`).click();
      ok(new URL(page.url()).searchParams.get('industry') === i.slug, `${t} address keeps ${i.slug}`);
      ok(await page.locator('#q-list .q').count() === i.questions.length, `${t} ${i.slug} shows its questions`);
      ok(await page.locator('#docs-row .doc').count() === i.documents.length, `${t} ${i.slug} shows its documents`);
      ok((await page.textContent('#demo-main .answer')) === i.questions[0].answer, `${t} ${i.slug} first answer shown`);
      ok(await page.locator('#ind-chips [aria-pressed="true"]').count() === 1, `${t} one chip marked pressed`);
      // ask each sample question by typing it; the answer and its cited documents come back
      for (const q of i.questions) {
        await page.fill('#ask-input', q.q); await page.press('#ask-input', 'Enter'); await sleep(30);
        ok((await page.textContent('#demo-main .answer')) === q.answer, `${t} ${i.slug}: "${q.q}" returns its answer`);
        const shown = await page.locator('#demo-main .src b').allTextContents();
        const names = q.sources.map(s => i.documents.find(d => d.id === s.doc).name);
        ok(shown.join('|') === names.join('|'), `${t} ${i.slug}: "${q.q}" cites its documents`);
      }
    }
    const control = phone ? '#ind-select' : '.ind-chip';
    ok(await page.locator(control).first().isVisible(), `${t} the ${phone ? 'menu' : 'chips'} are visible`);
    ok(!(await page.locator(phone ? '.ind-chip' : '#ind-select').first().isVisible()), `${t} the other control is hidden`);
    const box = await page.locator(control).first().boundingBox();
    ok(box.height >= 44, `${t} tap target is at least 44px tall (${Math.round(box.height)})`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${t} no sideways page scroll`);
    ok(errs.length === 0, `${t} no console errors ${errs.join('; ')}`);
    await ctx.close();
  }
  await browser.close(); server.close();
}
console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
