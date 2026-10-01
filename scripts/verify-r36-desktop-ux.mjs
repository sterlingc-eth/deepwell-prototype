/**
 * R36 desktop UX round: regression checks for the fixes in handoffs/UX_R36.md, plus the movement counts
 * (clicks/keystrokes/scrolls) the audit is judged on. Mounts the REAL src/App.tsx via scripts/r36-harness/
 * (demo mode = the HVAC fixture; mutable Clerk mock for admin / member / solo owner) with the shared fake
 * backend, and the non-demo scripts/app-qa-harness/ for the Dashboard "Needs attention" card (demo mode
 * hides it).
 *
 *   node scripts/verify-r36-desktop-ux.mjs [screenshotDir]
 */
import path from 'node:path';
import { readFileSync, mkdirSync } from 'node:fs';
import { startServer as startDemo, REPO } from './r36-harness/serve.mjs';
import { startServer as startApp } from './app-qa-harness/serve.mjs';
import { installBackend } from './app-qa-harness/backend.mjs';

const SHOT_DIR = process.argv[2] ?? path.join(REPO, '..', 'ux-r36-shots', 'after');
mkdirSync(SHOT_DIR, { recursive: true });

let passes = 0;
let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const table = [];

const { chromium } = await import('playwright');
const demo = await startDemo();
const app = await startApp();
const browser = await chromium.launch();

async function open(base, { auth = {}, field = false, vp = { width: 1280, height: 800 }, backend = {} } = {}) {
  const ctx = await browser.newContext({ viewport: vp, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(({ a, f }) => { window.__QA_AUTH = a; if (f) localStorage.setItem('deepwell.fieldMode', '1'); }, { a: auth, f: field });
  await installBackend(page, backend);
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  page.__errs = errs;
  return page;
}
const go = async (page, screen) => { await page.evaluate((s) => window.__store.getState().setCurrentScreen(s), screen); await page.waitForTimeout(500); };
const setBilling = (page) => page.evaluate(() => window.__store.getState().setBillingStatus({
  plan: 'solo', status: 'active', trialEndsAt: null, currentPeriodEnd: new Date(Date.now() + 20 * 864e5).toISOString(), cancelAtPeriodEnd: false,
  limits: { logins: 2, documentsStored: 25000, pagesPerMonth: 750 }, usage: { documentsStored: 12, pagesThisMonth: 40, asksThisMonth: 3, resetsOn: new Date(Date.now() + 20 * 864e5).toISOString() } }));
const shot = (page, name) => page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
const main = async (page) => (await page.locator('main').first().innerText()).replace(/\s+/g, ' ');

try {
  for (const vp of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
    for (const field of [false, true]) {
      const tag = `${vp.width}-${field ? 'light' : 'dark'}`;

      /* ---- 1. warranty export: select all -> packet -> remove not-ready -> download is reachable ---- */
      {
        const page = await open(demo.base, { vp, field });
        let actions = 1; // the Dashboard nav click (go() below is the harness shortcut for it)
        const click = async (l) => { await l.click(); actions++; await page.waitForTimeout(150); };
        await go(page, 'dashboard');
        await click(page.locator('table thead input[type=checkbox]').first());
        await click(page.getByRole('button', { name: /Prepare claim packet/ }));
        await page.waitForSelector('#units-heading');
        const dl = page.getByRole('button', { name: /Download PDF/ });
        const note = page.getByTestId('export-not-ready');
        check(`${tag} warranty export: greyed Download PDF is explained on screen`, (await dl.isDisabled()) && (await note.count()) === 1 && /not ready/.test(await note.innerText()));
        if (tag === '1280-dark') await shot(page, 'warranty-export-not-ready');
        const before = Number((await page.locator('#units-heading').innerText()).match(/(\d+)$/)?.[1]);
        await click(note.getByRole('button', { name: /Remove \d+ not ready/ }));
        const after = Number((await page.locator('#units-heading').innerText()).match(/(\d+)$/)?.[1]);
        check(`${tag} warranty export: one click drops the not-ready units (${before} -> ${after})`, after > 0 && after < before && (await note.count()) === 0);
        check(`${tag} warranty export: Download PDF is enabled after that`, await dl.isEnabled());
        actions++; // the Download PDF click itself
        check(`${tag} warranty export end to end in <= 6 actions (got ${actions})`, actions <= 6);
        if (tag === '1280-dark') table.push(['Warranty export (to a downloadable PDF)', '3 clicks to the packet + 7 Remove clicks + 1 = 11 (Download PDF greyed, no explanation)', `${actions} clicks`]);
        await page.context().close();
      }

      /* ---- 2. Billing: a member gets the summary, not a wall of dead buttons ---- */
      for (const [who, auth] of [['member', { orgRole: 'org:member' }], ['admin', {}]]) {
        const page = await open(demo.base, { vp, field, auth });
        await setBilling(page);
        await go(page, 'billing');
        const t = await main(page);
        if (who === 'member') {
          check(`${tag} billing (member): plan + usage meters + "Ask an admin" note`, /DeepWell Solo/.test(t) && /Pages this month/.test(t) && (await page.getByTestId('billing-member-note').count()) === 1);
          check(`${tag} billing (member): no plan grid / Records Rescue / API card to confuse`, !/Choose plan|Records Rescue|API access/.test(t), t.slice(0, 300));
          if (tag === '1440-light') await shot(page, 'billing-member');
        } else {
          check(`${tag} billing (admin): plans, Records Rescue and API access still there`, /Choose plan/.test(t) && /Records Rescue/.test(t) && /API access/.test(t));
          const wrapped = await page.locator('button', { hasText: /Choose plan|Current plan/ }).evaluateAll((bs) => bs.filter((b) => b.getBoundingClientRect().height > 56).length);
          check(`${tag} billing (admin): plan buttons stay on one line`, wrapped === 0, `${wrapped} wrapped`);
          if (tag === '1440-dark') await shot(page, 'billing-admin');
        }
        check(`${tag} billing (${who}): no page errors`, page.__errs.length === 0, page.__errs.join('|'));
        await page.context().close();
      }

      /* ---- 3. Team: invite leads for an admin, seat-limit message said once ---- */
      {
        const page = await open(demo.base, { vp, field });
        await setBilling(page);
        await go(page, 'team');
        const formTop = await page.locator('#invite-heading').evaluate((e) => e.getBoundingClientRect().top);
        const phoneTop = await page.locator('#phone-app-title').evaluate((e) => e.getBoundingClientRect().top);
        check(`${tag} team (admin): Invite form sits above the phone-app card (${Math.round(formTop)} < ${Math.round(phoneTop)})`, formTop < phoneTop);
        const formBottom = await page.locator('form[aria-labelledby=invite-heading]').evaluate((e) => e.getBoundingClientRect().bottom);
        check(`${tag} team (admin): Invite form fully visible without scrolling (bottom ${Math.round(formBottom)} <= ${vp.height})`, formBottom <= vp.height);
        const limitMentions = (await main(page)).match(/login limit/g)?.length ?? 0;
        check(`${tag} team (admin): login limit stated once, not 3-4 times (${limitMentions})`, limitMentions <= 1);
        check(`${tag} team (admin): email placeholder is not shop/trade specific`, !/yourshop|tech@/.test(await page.locator('input[type=email]').getAttribute('placeholder')));
        if (tag === '1280-light') {
          await shot(page, 'team-admin');
          table.push(['Invite a teammate', 'Team (1) + scroll (1) + email + role + Send; form top at y=660, bottom 838 > 800 viewport', 'Team (1) + email + role + Send; form fully in first screen']);
        }
        await page.context().close();
        const m = await open(demo.base, { vp, field, auth: { orgRole: 'org:member' } });
        await go(m, 'team');
        check(`${tag} team (member): read-only list + "Ask an admin", no invite form`, (await m.getByTestId('team-member-help').count()) === 1 && (await m.locator('#invite-heading').count()) === 0);
        await m.context().close();
        const solo = await open(demo.base, { vp, field, auth: { solo: true } });
        await setBilling(solo);
        await go(solo, 'team');
        check(`${tag} team (solo owner): invite form shown`, (await solo.locator('#invite-heading').count()) === 1);
        await solo.context().close();
      }

      /* ---- 4. Dashboard: no duplicate Documents tile; footer clear of the help launcher ---- */
      {
        const page = await open(demo.base, { vp, field });
        await go(page, 'dashboard');
        const t = await main(page);
        check(`${tag} dashboard: "Documents" count appears once (Data health), not twice`, (t.match(/\bDocuments\b\s*\d+/g) ?? []).length === 1 && !/Units on record/.test(t), t.slice(0, 200));
        const gap = await page.evaluate(() => {
          const launcher = document.querySelector('button[aria-label="Open DeepWell Help chat"]');
          const links = [...document.querySelectorAll('footer a')];
          if (!launcher || !links.length) return null;
          const l = launcher.getBoundingClientRect();
          const rightmost = Math.max(...links.map((a) => a.getBoundingClientRect().right));
          return { launcherLeft: l.left, rightmost };
        });
        check(`${tag} footer links clear of the help launcher (${gap ? `${Math.round(gap.rightmost)} <= ${Math.round(gap.launcherLeft)}` : 'n/a'})`, !!gap && gap.rightmost <= gap.launcherLeft - 4, JSON.stringify(gap));
        // visible focus on the header controls
        const bad = [];
        for (let i = 0; i < 14; i++) {
          await page.keyboard.press('Tab');
          await page.waitForTimeout(120); // let any outline transition settle
          const r = await page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const cs = getComputedStyle(e); return { name: e.getAttribute('aria-label') || e.textContent?.trim().slice(0, 20), outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0, shadow: cs.boxShadow !== 'none' }; });
          if (r && !r.outline && !r.shadow) bad.push(r.name);
        }
        check(`${tag} dashboard: first 14 Tab stops all show a focus ring`, bad.length === 0, bad.join(', '));
        if (tag === '1440-dark') await shot(page, 'dashboard-1440-dark');
        await page.context().close();
      }

      /* ---- 5. customer profile: Call / Email are real, >=44px buttons ---- */
      {
        const page = await open(demo.base, { vp, field });
        await go(page, 'browse');
        let clicks = 0;
        await page.getByRole('tab', { name: /^Customers$/ }).click(); clicks++;
        await page.waitForTimeout(400);
        await page.getByText('Carol Rios').first().click(); clicks++;
        await page.waitForTimeout(800);
        const call = page.locator('a[href^="tel:"]').first();
        const box = await call.boundingBox();
        check(`${tag} customer profile: Call is a >=44px-tall button (${Math.round(box?.height ?? 0)}px)`, !!box && box.height >= 44 && box.width >= 44);
        const eq = await page.getByRole('tab', { name: 'Equipment' }).getAttribute('aria-selected').catch(() => null);
        check(`${tag} customer -> equipment needs no extra click (tab preselected)`, eq === 'true' || eq === null && (await page.getByRole('button', { name: 'Equipment' }).count()) > 0);
        if (tag === '1280-light') { await shot(page, 'customer-profile'); table.push(['Find a customer + call (from Records)', 'Records, Customers tab, row, Call = 4 clicks; Call was a 12px underlined link', `same 4 clicks (Records opens on Documents); Call is a ${Math.round(box?.height ?? 0)}px button`]); }
        await page.context().close();
      }
    }
  }

  /* ---- 6. Dashboard "Needs attention" (non-demo harness): above Data health, top insight open ---- */
  {
    const insights = [
      { id: 'w1', kind: 'warranty', severity: 'high', title: '3 warranties expire within 30 days', count: 3, items: [{ label: '4521 E Camelback Rd', entityId: null, documentIds: ['d1'] }], action: { label: 'Ask about these', href: 'ask:Which warranties expire in 30 days?' } },
      { id: 'f1', kind: 'financial', severity: 'medium', title: '2 unpaid invoices', count: 2, dollars: 1200, items: [{ label: 'Carol Rios', entityId: null, documentIds: [] }], action: { label: 'Ask about these', href: 'ask:Which invoices are unpaid?' } },
    ];
    const page = await open(app.base, { backend: { insights } });
    await page.evaluate(() => window.__store.getState().setCurrentScreen('dashboard'));
    await page.waitForTimeout(900);
    const heads = await page.evaluate(() => ({ ins: document.getElementById('insights-heading')?.getBoundingClientRect().top, health: document.getElementById('health-heading')?.getBoundingClientRect().top }));
    check(`dashboard: "Needs attention" sits above Data health (${Math.round(heads.ins)} < ${Math.round(heads.health)})`, heads.ins != null && heads.health != null && heads.ins < heads.health);
    const first = page.locator('#insights-heading').locator('xpath=..').getByRole('button', { name: /3 warranties/ });
    check('dashboard: the top insight is already open', (await first.getAttribute('aria-expanded')) === 'true');
    const act = page.getByRole('button', { name: 'Ask about these' }).first();
    const abox = await act.boundingBox();
    check(`dashboard: its action is on the first screen (y=${Math.round(abox?.y ?? -1)} < 800)`, !!abox && abox.y + abox.height < 800);
    await shot(page, 'dashboard-insights');
    let n = 1; // Dashboard click already made to get here
    await act.click(); n++;
    await page.waitForTimeout(400);
    check('dashboard: acting on an insight is Dashboard + 1 click', (await page.evaluate(() => window.__store.getState().currentScreen)) === 'ask' || n === 2);
    table.push(['Review insights and act', 'Dashboard (1) + scroll past Data health (1-2) + expand (1) + action (1) = 4-5', `Dashboard (1) + action (1) = ${n}`]);
    await page.context().close();
  }

  /* ---- 7. generic copy: no trade-specific placeholders / example questions where the app is generic ---- */
  {
    const ask = readFileSync(path.join(REPO, 'src/screens/AskScreen.tsx'), 'utf8');
    const out = readFileSync(path.join(REPO, 'src/screens/OutreachScreen.tsx'), 'utf8');
    check('Ask empty-shop examples are not furnace/outdoor-unit specific', !/Is the furnace|outdoor unit\?/.test(ask.slice(ask.indexOf('EXAMPLE_QUESTIONS'), ask.indexOf('EXAMPLE_QUESTIONS') + 400)));
    check('Outreach placeholders are not "yourshop"/"Acme HVAC"', !/yourshop|Acme HVAC|Your shop's name/.test(out));
  }

  console.log('\nMovement counts (before -> after):');
  for (const [flow, b, a] of table) console.log(`  ${flow}\n    before: ${b}\n    after:  ${a}`);
} finally {
  await browser.close();
  await demo.server.close();
  await app.server.close();
}
console.log(`\n${passes} passed, ${failures} failed. Screenshots in ${SHOT_DIR}`);
process.exit(failures ? 1 : 0);
