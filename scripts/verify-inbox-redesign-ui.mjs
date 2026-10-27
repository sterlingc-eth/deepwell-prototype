/**
 * npm run verify:inbox-redesign (browser half). The REAL Inbox over a synthetic inbox of 400 papers (scripts/inbox-harness/):
 * counts, the five groups, one-click and bulk Link / Approve with confirm and Undo, every safety rule, keyboard, and that
 * nothing ever covers the footer banner or the floating Help button at desktop, tablet and phone sizes.
 *   node scripts/verify-inbox-redesign-ui.mjs [screenshotDir]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.argv[2] ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
process.chdir(REPO);
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`); };

const { createServer } = await import('vite');
const reactPlugin = (await import('@vitejs/plugin-react')).default;
const { chromium } = await import('playwright');
const tailwindcss = (await import('tailwindcss')).default;
const autoprefixer = (await import('autoprefixer')).default;
const server = await createServer({
  root: REPO, configFile: false, envFile: false, logLevel: 'error',
  define: { 'import.meta.env.VITE_DEMO_MODE': JSON.stringify('true') },
  resolve: { alias: [{ find: '@clerk/clerk-react', replacement: path.join(REPO, 'scripts', 'desktop-harness', 'clerk-mock.tsx') }] },
  css: { postcss: { plugins: [tailwindcss(path.join(REPO, 'tailwind.config.ts')), autoprefixer()] } },
  plugins: [reactPlugin()],
  server: { port: 5192, strictPort: false, fs: { allow: [REPO] } },
});
await server.listen();
const addr = server.httpServer.address();
const port = typeof addr === 'object' && addr ? addr.port : addr;
const URL_ = `http://localhost:${port}/scripts/inbox-harness/index.html?n=400&theme=light`;
const browser = await chromium.launch();

const open = async (vp, mobile = false) => {
  const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="inbox-triage"]');
  return { ctx, page, errs };
};
const groupCounts = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid="inbox-triage"] h3 button')].map((b) => [b.querySelector('span span')?.textContent?.trim(), Number(b.querySelector('.font-mono')?.textContent)])));
const openGroup = async (page, label) => { const b = page.locator('[data-testid="inbox-triage"] h3 button', { hasText: label }); if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click(); await page.waitForTimeout(100); };
const graph = (page, fn, arg) => page.evaluate(fn, arg);
const statusText = (page) => page.locator('[data-testid="inbox-triage"] [role="status"]').first().innerText().catch(() => '');

try {
  // ---------- counts and groups ----------
  {
    const { ctx, page, errs } = await open({ width: 1440, height: 900 });
    const g = await groupCounts(page);
    console.log('groups:', JSON.stringify(g));
    const total = Object.values(g).reduce((a, b) => a + b, 0);
    check('five groups at most, easiest first', Object.keys(g).join('|') === 'Confirm customer|Check and approve|Add missing info|Choose a customer|Take a look', Object.keys(g).join('|'));
    check('summary shows the total to clear', (await page.locator('[data-testid="triage-summary"]').innerText()).includes(`${total} to clear`), await page.locator('[data-testid="triage-summary"]').innerText());
    check('only the first group is open (everything else collapsed)', (await page.locator('[data-testid="inbox-triage"] h3 button[aria-expanded="true"]').count()) === 1);
    check('a long inbox never draws hundreds of rows at once', (await page.locator('[data-doc-id]').count()) <= 100);
    // Reasons are short chips, not sentences
    const longest = await page.evaluate(() => Math.max(...[...document.querySelectorAll('[data-testid="inbox-triage"] li [data-doc-id] span span')].map((e) => e.textContent.length)));
    check('reason chips are short (under 32 characters)', longest < 32, String(longest));
    // nothing linked or approved just by opening the screen
    const linked = await graph(page, () => Object.values(window.__dwGraph.getState().docs).filter((d) => d.stage !== 'verified' && d.linkedEntityIds.length === 0 && (d.linkSuggestionIds ?? []).length > 0).length);
    check('opening the Inbox links nothing and approves nothing (suggestions stay suggestions)', linked === g['Confirm customer'] + 0 + (await graph(page, () => Object.values(window.__dwGraph.getState().docs).filter((d) => d.linkedEntityIds.length === 0 && (d.linkSuggestionIds ?? []).length > 1).length)), `${linked}`);
    check('no page errors on open', errs.length === 0, errs.join('; '));
    check('the rarely used controls are folded away until "Tools and filters" is pressed', !(await page.getByText('Everyone', { exact: true }).isVisible()));
    await page.getByRole('button', { name: /Tools and filters/ }).click();
    check('...and are all there when it is', await page.getByText('Everyone', { exact: true }).isVisible() && await page.locator('input[aria-label="Hide company files"]').isVisible());
    await page.getByRole('button', { name: /Tools and filters/ }).click();
    // "Take a look" and the old views are still reachable
    await page.getByRole('tab', { name: /More views/ }).click().catch(async () => { await page.getByRole('button', { name: /More views/ }).click(); });
    check('older views are one tap away under "More views"', (await page.getByRole('tab', { name: /Needs linking/ }).count()) === 1);
    await ctx.close();
  }

  // ---------- one-click link + undo, bulk link with confirm + undo ----------
  {
    const { ctx, page } = await open({ width: 1440, height: 900 });
    const g0 = await groupCounts(page);
    const nConfirm = g0['Confirm customer'];
    const first = await page.locator('[data-testid="inbox-triage"] ul ul li').first();
    const firstId = await first.locator('[data-doc-id]').getAttribute('data-doc-id');
    const sugg = await graph(page, (id) => window.__dwGraph.getState().docs[id].linkSuggestionIds[0], firstId);
    await first.getByRole('button', { name: /^Link to / }).click();
    await page.waitForTimeout(500);
    const after1 = await graph(page, (id) => window.__dwGraph.getState().docs[id].linkedEntityIds, firstId);
    check('one click links that paper to its one suggested customer', after1.length === 1 && after1[0] === sugg, JSON.stringify(after1));
    check('the status line says so and offers Undo', /Linked to/.test(await statusText(page)) && (await page.getByRole('button', { name: /Undo/ }).count()) === 1);
    check('the group shrinks by one', (await groupCounts(page))['Confirm customer'] === nConfirm - 1);
    await page.getByRole('button', { name: /Undo/ }).click();
    await page.waitForTimeout(900);
    const undone = await graph(page, (id) => window.__dwGraph.getState().docs[id].linkedEntityIds.length, firstId);
    check('Undo puts it back (unlinked again, suggestion still offered)', undone === 0 && (await groupCounts(page))['Confirm customer'] === nConfirm);

    // bulk: only clear (strong) matches; weak ones stay one-at-a-time
    const nStrong = await graph(page, () => Object.values(window.__dwGraph.getState().docs).filter((d) => (d.linkSuggestionStrongIds ?? []).length === 1 && (d.linkSuggestionIds ?? []).length === 1 && d.linkedEntityIds.length === 0).length);
    const bulk = page.getByRole('button', { name: new RegExp(`^Link all ${nStrong} with a clear match`) });
    check('bulk button counts only clear matches (fewer than the group)', nStrong > 0 && nStrong < nConfirm, `${nStrong} of ${nConfirm}`);
    await bulk.click();
    check('bulk link asks first (dialog with the count)', (await page.getByRole('dialog').innerText()).includes(`Link ${nStrong} papers?`));
    await page.getByRole('button', { name: 'Cancel' }).click();
    check('Cancel changes nothing', (await groupCounts(page))['Confirm customer'] === nConfirm);
    const twoBefore = await graph(page, () => Object.values(window.__dwGraph.getState().docs).filter((d) => (d.linkSuggestionIds ?? []).length > 1 && d.linkedEntityIds.length === 0).length);
    const weakBefore = nConfirm - nStrong;
    await bulk.click();
    await page.getByRole('button', { name: new RegExp(`^Link ${nStrong}$`) }).click();
    await page.waitForFunction(() => /Linked \d+ papers/.test(document.querySelector('[data-testid="inbox-triage"] [role="status"]')?.textContent ?? ''), null, { timeout: 60000 });
    const g1 = await groupCounts(page);
    check('bulk link leaves the weak matches for one-at-a-time', g1['Confirm customer'] === weakBefore, JSON.stringify(g1));
    const twoAfter = await graph(page, () => Object.values(window.__dwGraph.getState().docs).filter((d) => (d.linkSuggestionIds ?? []).length > 1 && d.linkedEntityIds.length === 0).length);
    check('papers with two possible customers are NOT linked by the bulk button', twoAfter === twoBefore && twoBefore > 0, `${twoBefore} -> ${twoAfter}`);
    await page.getByRole('button', { name: /Undo/ }).click();
    await page.waitForFunction(() => /Undone/.test(document.querySelector('[data-testid="inbox-triage"] [role="status"]')?.textContent ?? ''), null, { timeout: 60000 });
    const g2 = await groupCounts(page);
    check('Undo brings every one back', g2['Confirm customer'] === nConfirm, JSON.stringify(g2));
    await ctx.close();
  }

  // ---------- bulk approve: only what passed, never a typed value, undo ----------
  {
    const { ctx, page } = await open({ width: 1440, height: 900 });
    const g0 = await groupCounts(page);
    // a person-typed value on one of the "passed" papers must survive untouched
    const typedId = await graph(page, () => {
      const s = window.__dwGraph.getState();
      const d = Object.values(s.docs).find((x) => x.stage === 'linked' && x.issues.length === 0 && x.typeId === 'invoice');
      s.correctField(d.id, 'cost', '4321.00', 'Pat');
      return d.id;
    });
    const doneBefore = await graph(page, () => Object.values(window.__dwGraph.getState().docs).filter((d) => d.stage === 'verified').length);
    const nApprove = (await groupCounts(page))['Check and approve'];
    await openGroup(page, 'Check and approve');
    await page.getByRole('button', { name: new RegExp(`^Approve all ${nApprove} that passed checks`) }).click();
    check('bulk approve asks first, and says nothing typed is changed', /No value anyone typed or confirmed is changed/.test(await page.getByRole('dialog').innerText()));
    await page.getByRole('button', { name: new RegExp(`^Approve ${nApprove}$`) }).click();
    await page.waitForFunction(() => /Approved \d+ papers/.test(document.querySelector('[data-testid="inbox-triage"] [role="status"]')?.textContent ?? ''), null, { timeout: 60000 });
    const st = await graph(page, (id) => { const s = window.__dwGraph.getState(); const d = s.docs[id]; const all = Object.values(s.docs); return { cost: d.extracted.find((f) => f.name === 'cost').correctedValue, by: d.extracted.find((f) => f.name === 'cost').correctedBy, verified: all.filter((x) => x.stage === 'verified').length, badVerified: all.filter((x) => x.stage === 'verified' && (x.issues.length > 0)).length, hardVerified: all.filter((x) => x.stage === 'verified' && x.filename.includes('blurry')).length, missingVerified: all.filter((x) => x.stage === 'verified' && x.filename.startsWith('Invoice scan')).length, suspectVerified: all.filter((x) => x.stage === 'verified' && x.filename.includes('INV-95')).length }; }, typedId);
    check('a value a person typed is never overwritten by a bulk approve', st.cost === '4321.00' && st.by === 'Pat', JSON.stringify(st));
    check('exactly the papers that passed were approved', st.verified === doneBefore + nApprove, `${doneBefore} + ${nApprove} vs ${st.verified}`);
    check('nothing hard to read, missing a fact, or with a value to check was approved', st.badVerified === 0 && st.hardVerified === 0 && st.missingVerified === 0 && st.suspectVerified === 0, JSON.stringify(st));
    check('the group is gone, the others are untouched', !('Check and approve' in (await groupCounts(page))) && (await groupCounts(page))['Add missing info'] === g0['Add missing info']);
    await page.keyboard.press('u');
    await page.waitForFunction(() => /Undone/.test(document.querySelector('[data-testid="inbox-triage"] [role="status"]')?.textContent ?? ''), null, { timeout: 60000 });
    const back = await graph(page, (id) => { const s = window.__dwGraph.getState(); const d = s.docs[id]; return { verified: Object.values(s.docs).filter((x) => x.stage === 'verified').length, cost: d.extracted.find((f) => f.name === 'cost').correctedValue }; }, typedId);
    check('"u" undoes it: back to where it was, typed value still there', back.verified === doneBefore && back.cost === '4321.00', JSON.stringify(back));
    await ctx.close();
  }

  // ---------- keyboard ----------
  {
    const { ctx, page } = await open({ width: 1440, height: 900 });
    const id0 = await page.locator('[data-doc-id]').first().getAttribute('data-doc-id');
    await page.keyboard.press('j');
    await page.waitForTimeout(150);
    const sel = await page.evaluate(() => document.querySelector('[data-doc-id][aria-current="true"]')?.getAttribute('data-doc-id'));
    check('j moves the selection down the open group', !!sel && sel !== id0);
    await page.keyboard.press('a');
    await page.waitForTimeout(500);
    const linked = await graph(page, (id) => window.__dwGraph.getState().docs[id].linkedEntityIds.length, sel);
    check('"a" does the one-click action on the selected paper', linked === 1);
    await page.keyboard.press('u');
    await page.waitForTimeout(900);
    check('"u" undoes it', (await graph(page, (id) => window.__dwGraph.getState().docs[id].linkedEntityIds.length, sel)) === 0);
    await ctx.close();
  }

  // ---------- the banner / footer never gets covered ----------
  for (const [name, vp, mobile] of [['desktop 1440', { width: 1440, height: 900 }, false], ['laptop 1280', { width: 1280, height: 720 }, false], ['tablet 1024', { width: 1024, height: 768 }, false], ['tablet 768', { width: 768, height: 1024 }, true], ['phone 390', { width: 390, height: 844 }, true], ['small phone 360', { width: 360, height: 640 }, true]]) {
    const { ctx, page } = await open(vp, mobile);
    let bad = [];
    const measure = async (label) => {
      const m = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="needs-list"]').getBoundingClientRect();
        const detail = document.querySelector('[data-testid="needs-detail"]')?.getBoundingClientRect() ?? null;
        const footer = [...document.querySelectorAll('footer')].pop().getBoundingClientRect();
        const launcher = document.querySelector('[aria-label="Open DeepWell Help chat"]')?.getBoundingClientRect() ?? null;
        const h = window.innerHeight;
        const overlapsRect = (a, b) => !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        // The working area is "in place" once it fits the screen (desktop) or has docked under the top edge (phone, after a scroll);
        // before that it is just the top of a long page, partly below the fold, and the Help button floats over the page as it does everywhere.
        const inPlace = list.bottom <= h + 1;
        return {
          listOverFooter: footer.height > 0 && overlapsRect(list, footer),
          detailOverFooter: !!detail && overlapsRect(detail, footer),
          listUnderLauncher: inPlace && overlapsRect(list, launcher),
          detailUnderLauncher: inPlace && !!detail && overlapsRect(detail, launcher),
          listBottomInView: list.top > 90 || list.bottom <= h + 1,
          pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      });
      if (m.listOverFooter || m.detailOverFooter || m.listUnderLauncher || m.detailUnderLauncher || !m.listBottomInView || m.pageScrollsSideways) bad.push(`${label}: ${JSON.stringify(m)}`);
    };
    await measure('top');
    for (const y of [200, 600, 1200, 99999]) {
      await page.mouse.move(vp.width - 3, 3);
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(150);
      await measure(`page y=${y}`);
    }
    // scrolling INSIDE the list must not move the page and must keep the footer clear
    const y0 = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => { const l = document.querySelector('[data-testid="needs-list"]'); l.scrollTop = 800; });
    await measure('list scrolled');
    check(`${name}: the footer banner and Help button are never covered (top, mid, end of page, list scrolled)`, bad.length === 0, bad.slice(0, 2).join(' | '));
    check(`${name}: the list scrolls inside its own area`, await page.evaluate(() => { const l = document.querySelector('[data-testid="needs-list"]'); return l.scrollHeight > l.clientHeight && l.scrollTop > 0; }));
    check(`${name}: scrolling the list does not scroll the page`, (await page.evaluate(() => window.scrollY)) === y0);
    if (SHOTS) {
      await page.evaluate(() => { document.querySelector('[data-testid="needs-list"]').scrollTop = 0; window.scrollTo(0, 99999); });
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(SHOTS, `verify_${name.replace(/\W+/g, '-')}_page-end.png`) });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
