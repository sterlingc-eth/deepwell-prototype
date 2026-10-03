// Verifies the "How it works" chain-reaction animation on the marketing page
// (index.html #how-it-works). Serves the repo root statically, then checks at
// 1440 / 1280 / 768 / 390 in dark + light:
//   - the section renders (stage ready, token, cards, keyboard, answer built)
//   - the loop actually completes (data-loops increments in real time)
//   - it pauses when scrolled offscreen
//   - timeline states at key times (via the test hook root.__hiw.seek)
//   - prefers-reduced-motion shows the static, captioned overview
//   - no console errors, no horizontal overflow, no long tasks (>50 ms) while playing
// Screenshots (every 0.5 s of one loop at 1440 + 390, dark + light, plus the
// reduced-motion frame) go to SHOT_DIR (arg 1, default /tmp/r27w-shots).
//
//   node scripts/verify-how-it-works.mjs [screenshotDir]
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = process.argv[2] ?? '/tmp/r27w-shots';
mkdirSync(SHOT_DIR, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/json' };

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT)) throw new Error('bad path');
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, r));
const URL_ = `http://localhost:${server.address().port}/index.html`;

let failures = 0;
const ok = (c, msg) => { if (!c) { failures++; console.error('FAIL', msg); } else console.log('ok  ', msg); };

const browser = await chromium.launch();

async function open(width, height, scheme, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL_, { waitUntil: 'load' });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), scheme);
  await page.locator('#how-it-works .hiw-stage').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}
const seek = (page, t) => page.evaluate((t) => document.getElementById('how-it-works').__hiw.seek(t), t);
const opacityOf = (page, sel) => page.evaluate((s) => +getComputedStyle(document.querySelector('#how-it-works ' + s)).opacity, sel);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/* ---- 1. desktop dark: render, timeline states, playing loop, pause, long tasks ---- */
{
  const { ctx, page, errors } = await open(1440, 900, 'dark');
  const ready = await page.evaluate(() => {
    const s = document.querySelector('#how-it-works .hiw');
    return { ready: s.classList.contains('is-ready'), keys: s.querySelectorAll('.hiw-key').length, ticks: s.querySelectorAll('.hiw-tick').length, hidden: s.querySelector('.hiw-stage').getAttribute('aria-hidden'), steps: s.querySelectorAll('.hiw-steps li').length, sr: !!s.querySelector('.hiw-sr') };
  });
  ok(ready.ready, 'stage is ready');
  ok(ready.keys === 28 && ready.ticks === 11, `keyboard (28 keys) and slider ticks (11) built: ${ready.keys}/${ready.ticks}`);
  ok(ready.hidden === 'true' && ready.sr && ready.steps === 3, 'stage aria-hidden, sr summary + 3 real-text steps present');

  await seek(page, 0);
  ok((await opacityOf(page, '.hiw-cur')) < 0.05, 't=0: cursor not yet in, ball hidden: ' + (await opacityOf(page, '.hiw-ball')));
  await seek(page, 2.0);
  const tip = await page.evaluate(() => document.querySelector('#how-it-works .hiw-tip').textContent);
  ok(/^\d+%$/.test(tip) && parseInt(tip) > 30 && parseInt(tip) < 100, `t=2.0: slider tooltip counting (${tip})`);
  await seek(page, 3.6);
  ok((await opacityOf(page, '[data-n=c2]')) > 0.9, 't=3.6: all three notification cards in');
  await seek(page, 5.5);
  const typed = await page.evaluate(() => document.querySelector('#how-it-works [data-n=txt]').textContent);
  ok(typed.length > 3 && 'smith contract'.startsWith(typed), `t=5.5: question typing itself ("${typed}")`);
  await seek(page, 8.0);
  ok((await opacityOf(page, '.hiw-ans')) > 0.95 && (await opacityOf(page, '[data-n=chip]')) > 0.95, 't=8.0: cited answer card + source chip visible');
  await seek(page, 10.4);
  ok((await opacityOf(page, '[data-n=cap0]')) > 0.95 && (await opacityOf(page, '[data-n=cap2]')) > 0.95, 't=10.4: overview captions visible');
  const on = await page.evaluate(() => document.querySelectorAll('#how-it-works .hiw-steps li[data-on]').length);
  ok(on === 3, 't=10.4: all three step captions lit');
  await seek(page, 0.05);
  ok((await page.evaluate(() => document.querySelectorAll('#how-it-works .hiw-steps li[data-on]').length)) === 0, 'loop start: step captions reset');

  // real-time play: long tasks + loop completion
  await page.evaluate(() => {
    window.__lt = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(Math.round(e.duration)))).observe({ entryTypes: ['longtask'] });
    document.getElementById('how-it-works').__hiw.resume();
  });
  await page.waitForTimeout(19500); // loop is 18s since SPEED=12/18
  const st = await page.evaluate(() => ({ loops: document.querySelector('#how-it-works .hiw-stage').dataset.loops, state: document.querySelector('#how-it-works .hiw-stage').dataset.state, lt: window.__lt }));
  ok(st.state === 'playing', 'playing when in view (' + st.state + ')');
  ok(+st.loops >= 1, `loop completed in real time (loops=${st.loops})`);
  ok(st.lt.length === 0, `no long tasks >50 ms while playing (${JSON.stringify(st.lt)})`);
  // pause offscreen
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  ok((await page.evaluate(() => document.querySelector('#how-it-works .hiw-stage').dataset.state)) === 'paused', 'pauses when scrolled offscreen');
  ok((await overflow(page)) <= 0, 'no horizontal overflow @1440');
  ok(errors.length === 0, 'no console errors @1440 ' + JSON.stringify(errors));
  await ctx.close();
}

/* ---- 2. every width x theme: no overflow, no errors, screenshots ---- */
for (const [w, h] of [[1440, 900], [1280, 800], [768, 1024], [390, 844]]) {
  for (const scheme of ['dark', 'light']) {
    const { ctx, page, errors } = await open(w, h, scheme);
    ok((await overflow(page)) <= 0, `no horizontal overflow @${w} ${scheme}`);
    const box = await page.locator('#how-it-works .hiw-stage').boundingBox();
    ok(box && box.width > 300 && box.height > 200 && box.x >= 0 && box.x + box.width <= w, `stage fits @${w} ${scheme} (${Math.round(box.width)}x${Math.round(box.height)})`);
    const sec = await page.locator('#how-it-works').boundingBox();
    console.log(`     section height @${w}: ${Math.round(sec.height)}px`);
    if (w === 1440 || w === 390) {
      const stage = page.locator('#how-it-works .hiw-stage');
      for (let t = 0; t < 12; t += 0.5) {
        await seek(page, t);
        await page.waitForTimeout(40);
        await stage.screenshot({ path: join(SHOT_DIR, `${scheme[0]}${w}_${String(Math.round(t * 10)).padStart(3, '0')}.png`) });
      }
    } else {
      await seek(page, 5.5);
      await page.locator('#how-it-works .hiw-stage').screenshot({ path: join(SHOT_DIR, `${scheme[0]}${w}_055.png`) });
      await seek(page, 10.4);
      await page.locator('#how-it-works .hiw-stage').screenshot({ path: join(SHOT_DIR, `${scheme[0]}${w}_104.png`) });
    }
    ok(errors.length === 0, `no console errors @${w} ${scheme} ${JSON.stringify(errors)}`);
    await ctx.close();
  }
}

/* ---- 3. reduced motion: static captioned overview, no rAF loop ---- */
for (const [w, h] of [[1440, 900], [390, 844]]) {
  const { ctx, page, errors } = await open(w, h, 'dark', { reducedMotion: 'reduce' });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({ state: document.querySelector('#how-it-works .hiw-stage').dataset.state, loops: document.querySelector('#how-it-works .hiw-stage').dataset.loops || '0' }));
  ok(r.state === 'static' && r.loops === '0', `reduced motion @${w}: static state, no loop (${r.state})`);
  ok((await opacityOf(page, '.hiw-ans')) > 0.95 && (await opacityOf(page, '[data-n=cap1]')) > 0.95, `reduced motion @${w}: answer + captions shown`);
  ok((await page.evaluate(() => document.querySelectorAll('#how-it-works .hiw-steps li[data-on]').length)) === 3, `reduced motion @${w}: steps lit`);
  await page.locator('#how-it-works .hiw-stage').screenshot({ path: join(SHOT_DIR, `reduced${w}.png`) });
  ok((await overflow(page)) <= 0 && errors.length === 0, `reduced motion @${w}: no overflow/errors`);
  await ctx.close();
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll how-it-works checks passed');
process.exit(failures ? 1 : 0);
