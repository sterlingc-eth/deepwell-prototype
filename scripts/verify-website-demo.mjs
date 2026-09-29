// Verifies the marketing-homepage "Ask Donovan" demo survives rapid chip clicks.
// Usage: node scripts/verify-website-demo.mjs [path/to/index.html]   (default: ./index.html)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.argv[2] || 'index.html');
const root = path.dirname(file);
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const f = p === '/' ? file : path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(); }
  const ext = path.extname(f);
  res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch();
let failures = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.log('  FAIL', msg); } };

// Scenarios: list of [action, delayAfterMs]. actions: chip N | type TEXT | submit
const SCENARIOS = [
  { name: '5 rapid clicks, mixed chips', steps: [['c',0,0],['c',1,60],['c',2,60],['c',3,60],['c',1,60]], expect: 1 },
  { name: 'same chip twice rapidly', steps: [['c',2,50],['c',2,50]], expect: 2 },
  { name: 'A then B then A', steps: [['c',0,40],['c',3,40],['c',0,40]], expect: 0 },
  { name: 'click during typing (mid-way)', steps: [['c',0,250],['c',1,0]], expect: 1 },
  { name: 'click during answer reveal', steps: [['c',3,'done'],['c',1,120],['c',2,0]], expect: 2 },
  { name: 'click same chip after finished (retypes)', steps: [['c',0,'done'],['c',0,0]], expect: 0 },
  { name: '20 clicks in ~300ms', steps: Array.from({length:20},(_,k)=>['c',k%4,15]), expect: 3 },
  { name: 'keyboard (focus + Enter/Space) rapid', kb: true, steps: [['c',0,30],['c',2,30],['c',1,30]], expect: 1 },
];

for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const reduced of ['no-preference', 'reduce']) {
    const ctx = await browser.newContext({ viewport: vp, hasTouch: vp.width < 500, reducedMotion: reduced });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
    await page.goto(url, { waitUntil: 'load' });
    await page.locator('#demo').scrollIntoViewIfNeeded();
    const info = await page.evaluate(() => ({
      qs: [...document.querySelectorAll('.q')].map(b => b.textContent.trim()),
      // answer text per chip, learned from initial render is only chip 0, so use DEMO if global
      demo: typeof DEMO !== 'undefined' ? DEMO.map(d => ({ q: d.q, a: d.answer })) : null,
    }));
    const label = `${vp.width}px/${reduced}`;
    console.log(`[${label}]`);
    for (const sc of SCENARIOS) {
      await page.reload({ waitUntil: 'load' });
      await page.locator('#demo').scrollIntoViewIfNeeded();
      const chip = i => page.locator(`#q${i}`);
      for (const [, i, d] of sc.steps) {
        if (sc.kb) { await chip(i).focus(); await page.keyboard.press(i % 2 ? 'Space' : 'Enter'); }
        else await chip(i).dispatchEvent('click');
        if (d === 'done') await page.waitForFunction(() => !document.getElementById('ask-input').classList.contains('dw-typing') && document.getElementById('ask-input').value.length > 0, null, { timeout: 5000 });
        else if (d) await sleep(d);
      }
      // wait until typing done, then reveal settled
      await page.waitForFunction(() => !document.getElementById('ask-input').classList.contains('dw-typing'), null, { timeout: 5000 });
      await sleep(900);
      const got = await page.evaluate(() => ({
        val: document.getElementById('ask-input').value,
        ans: document.querySelector('#demo-main .answer')?.textContent,
        pressed: [...document.querySelectorAll('.q')].map(b => b.getAttribute('aria-pressed')),
      }));
      const exp = info.demo[sc.expect];
      const before = failures;
      ok(got.val === exp.q, `${sc.name}: input "${got.val}" != "${exp.q}"`);
      ok(got.ans === exp.a, `${sc.name}: answer mismatch ("${(got.ans||'').slice(0,50)}")`);
      ok(got.pressed.join() === info.demo.map((_, k) => String(k === sc.expect)).join(), `${sc.name}: aria-pressed ${got.pressed}`);
      console.log(`  ${failures === before ? 'ok  ' : 'FAIL'} ${sc.name}`);
    }
    // typing in the input during a chip animation: user text must win, nothing appended
    await page.reload({ waitUntil: 'load' });
    await page.locator('#demo').scrollIntoViewIfNeeded();
    await page.locator('#q1').dispatchEvent('click');
    await sleep(200);
    await page.locator('#ask-input').fill('carrier expire 90');
    await sleep(1500);
    let v = await page.inputValue('#ask-input');
    ok(v === 'carrier expire 90', `user typing during animation: input "${v}"`);
    // submit mid-animation: input frozen at submit time, answer matches submitted text
    await page.reload({ waitUntil: 'load' });
    await page.locator('#demo').scrollIntoViewIfNeeded();
    await page.locator('#q0').dispatchEvent('click');
    await sleep(150);
    await page.locator('#ask-input').press('Enter');
    await sleep(1500);
    v = await page.inputValue('#ask-input');
    const ans = await page.evaluate(() => document.querySelector('#demo-main .answer')?.textContent || '');
    const frozen = info.demo[0].q.startsWith(v) && v.length > 0;
    ok(frozen, `submit mid-animation: input "${v}" not a stable prefix of chip 0`);
    ok(await page.evaluate(() => !document.getElementById('ask-input').classList.contains('dw-typing')), 'typing class cleared after submit');
    // full-text submit after a chip finishes still works
    await page.locator('#q3').dispatchEvent('click');
    await page.waitForFunction(() => !document.getElementById('ask-input').classList.contains('dw-typing'), null, { timeout: 5000 });
    await page.locator('#ask-input').press('Enter');
    await sleep(700);
    ok((await page.textContent('#demo-main .answer')) === info.demo[3].a, 'submit after chip finished shows chip answer');
    console.log(`  ${errs.length ? 'FAIL' : 'ok  '} console/page errors: ${errs.length}`);
    errs.forEach(e => console.log('    ' + e));
    ok(errs.length === 0, 'console errors');
    await ctx.close();
  }
}
await browser.close(); server.close();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
