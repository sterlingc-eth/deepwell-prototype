/**
 * DeepWell Help (support assistant) UI check. Mounts the REAL SupportWidget / SupportAssistant / mobile Sheet
 * via scripts/support-ui-harness/ with /api/support mocked in-page (same "bare components, mocked network"
 * technique as scripts/support-access-harness). Desktop 1440x900 and mobile 390x844, Office (dark) and
 * Field (light).
 *
 * Checks: launcher size/position/pulse policy, dialog semantics, focus trap, Esc + focus return, Enter/
 * Shift+Enter, auto-grow cap, counter, safe rendering of reply text (no HTML injection), sources line,
 * Ask-Donovan redirect, hand-off form + confirmation, 429 and 500 handling, 12-turn limit, offline state,
 * sessionStorage restore, reduced motion, mobile header button + Sheet + visualViewport keyboard inset,
 * 44px targets, no horizontal overflow, no console errors.
 *
 *   npx tsx scripts/verify-support-ui.mjs [screenshotDir]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const SHOT_DIR = process.argv[2] ?? '/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad/support-shots-app';
mkdirSync(SHOT_DIR, { recursive: true });

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

let base = '';
let server;
try {
  server = spawn('npx', ['vite', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  let port = null;
  const ready = await Promise.race([
    new Promise((resolve) => {
      const chk = () => { const m = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)\//.exec(out); if (m) { port = Number(m[1]); resolve(true); } };
      server.stdout.on('data', (d) => { out += String(d); chk(); });
      server.stderr.on('data', (d) => { out += String(d); chk(); });
    }),
    new Promise((resolve) => server.once('exit', () => resolve(false))),
    new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
  ]);
  if (!ready || !port) throw new Error(`vite dev server did not report a port:\n${out}`);
  base = `http://localhost:${port}/scripts/support-ui-harness/index.html`;
  await new Promise((r) => setTimeout(r, 400));

  const browser = await chromium.launch();

  async function newPage(viewport, { reduced = false, mobile = false } = {}) {
    const ctx = await browser.newContext({ viewport, reducedMotion: reduced ? 'reduce' : 'no-preference', isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(`console: ${m.text()}`); });
    return { ctx, page, errors };
  }
  const go = (page, mode, field) => page.goto(`${base}?mode=${mode}&field=${field ? 1 : 0}`, { waitUntil: 'networkidle' });
  const box = async (loc) => loc.boundingBox();
  const inDialog = (page) => page.evaluate(() => { const d = document.querySelector('[role=dialog]'); return !!d && d.contains(document.activeElement); });
  const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  const lastReply = (page) => page.locator('[role=log] .dw-support-msg-in').last();

  // ------------------------------------------------------------------ desktop
  for (const field of [false, true]) {
    const theme = field ? 'light' : 'dark';
    const tag = `desktop-${theme}`;
    const { ctx, page, errors } = await newPage({ width: 1440, height: 900 });
    await go(page, 'desktop', field);

    // Launcher
    const launcher = page.getByRole('button', { name: 'Open DeepWell Help chat' });
    const lb = await box(launcher);
    check(`[${tag}] launcher is 52-56px`, lb && lb.width >= 52 && lb.width <= 56 && lb.height >= 52 && lb.height <= 56, JSON.stringify(lb));
    check(`[${tag}] launcher bottom-right with >=16px margins`, lb && 1440 - (lb.x + lb.width) >= 16 && 900 - (lb.y + lb.height) >= 16, JSON.stringify(lb));
    check(`[${tag}] launcher pulses on first load (rings animate)`, await launcher.evaluate((b) => {
      const ring = b.querySelector('.dw-sl-ring');
      return !!b.querySelector('.dw-sl-pulsing') && !!ring && getComputedStyle(ring).animationName.includes('dw-sl-ripple') && getComputedStyle(ring).animationDuration === '2.8s';
    }));
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-1-launcher.png` });

    // Open
    await launcher.click();
    const dialog = page.getByRole('dialog', { name: 'DeepWell Help' });
    await dialog.waitFor();
    await page.waitForTimeout(400);
    const db = await box(dialog);
    check(`[${tag}] panel is 380x560, anchored bottom-right`, db && Math.round(db.width) === 380 && Math.round(db.height) === 560 && Math.abs(1440 - 16 - (db.x + db.width)) <= 1 && Math.abs(900 - 16 - (db.y + db.height)) <= 1, JSON.stringify(db));
    check(`[${tag}] launcher hidden while open (no pulse)`, (await launcher.count()) === 0);
    check(`[${tag}] focus lands inside the dialog`, await inDialog(page));
    check(`[${tag}] starter greeting + 3 chips`, (await page.getByText("Hi, I'm DeepWell Help").count()) === 1 && (await dialog.locator('[aria-label="Suggested questions"] button').count()) === 3);
    check(`[${tag}] GET starter used surface=app`, (await page.evaluate(() => window.__calls.some((c) => c.method === 'GET' && c.url.includes('starter=1') && c.url.includes('surface=app')))));
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-2-open-starter.png` });

    // Focus trap
    let escaped = false;
    for (let i = 0; i < 25; i++) { await page.keyboard.press('Tab'); if (!(await inDialog(page))) escaped = true; }
    for (let i = 0; i < 25; i++) { await page.keyboard.press('Shift+Tab'); if (!(await inDialog(page))) escaped = true; }
    check(`[${tag}] focus trap holds through Tab and Shift+Tab`, !escaped);

    // Enter / Shift+Enter / auto-grow / counter
    const ta = dialog.getByRole('textbox', { name: 'Message DeepWell Help' });
    await ta.focus();
    const h1 = (await box(ta)).height;
    await ta.type('line one');
    await page.keyboard.press('Shift+Enter');
    await ta.type('line two');
    check(`[${tag}] Shift+Enter inserts a newline, does not send`, (await ta.inputValue()) === 'line one\nline two' && (await page.evaluate(() => window.__calls.filter((c) => c.method === 'POST').length)) === 0);
    for (let i = 0; i < 8; i++) { await page.keyboard.press('Shift+Enter'); await ta.type(`more ${i}`); }
    const grown = await ta.evaluate((el) => ({ h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight), oy: getComputedStyle(el).overflowY, sh: el.scrollHeight }));
    check(`[${tag}] textarea grows but caps at 4 lines then scrolls`, grown.h > h1 && grown.h <= grown.lh * 4 + 30 && grown.oy === 'auto' && grown.sh > grown.h, JSON.stringify({ h1, ...grown }));
    await ta.fill('');
    await ta.fill('x'.repeat(520));
    check(`[${tag}] counter shows near 600`, await dialog.getByText('520/600').isVisible());
    await ta.fill('y'.repeat(700));
    check(`[${tag}] input capped at 600 chars`, (await ta.inputValue()).length === 600);
    await ta.fill('');

    // Send
    await ta.type('How do I upload documents?');
    await page.keyboard.press('Enter');
    await dialog.getByText('DeepWell Help is typing').waitFor({ state: 'attached' });
    check(`[${tag}] typing indicator shown (pulsing circles)`, (await dialog.locator('.dw-sl-pulsing').count()) >= 1);
    await dialog.getByText('From: Uploading and scanning').waitFor();
    const reply = lastReply(page);
    check(`[${tag}] reply renders **bold**, list and https link`, (await reply.locator('strong').first().textContent()) === 'Inbox' && (await reply.locator('a[href="https://deepwelltechnology.com/get"][target=_blank][rel*=noopener]').count()) === 1);
    check(`[${tag}] sources line is deduped ("From: Uploading and scanning")`, (await dialog.getByText(/^From: /).allTextContents()).every((t) => t === 'From: Uploading and scanning'));
    const c1 = await page.evaluate(() => window.__calls.filter((c) => c.method === 'POST')[0]?.body);
    check(`[${tag}] POST body: message, surface=app, page, no history yet`, c1 && c1.message === 'How do I upload documents?' && c1.surface === 'app' && c1.page === 'ask' && Array.isArray(c1.history) && c1.history.length === 0, JSON.stringify(c1));
    check(`[${tag}] follow-up suggestion chips appear`, (await dialog.getByRole('button', { name: 'What file types work?' }).count()) === 1);
    check(`[${tag}] conversation region is aria-live`, (await dialog.locator('[role=log][aria-live=polite]').count()) === 1);
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-3-chat.png` });
    await dialog.getByRole('button', { name: 'What file types work?' }).click();
    await dialog.getByText('From: Uploading and scanning').nth(1).waitFor();
    const c2 = await page.evaluate(() => window.__calls.filter((c) => c.method === 'POST')[1]?.body);
    check(`[${tag}] second POST carries history (last turns as {role,text})`, c2 && c2.history.length === 2 && c2.history[0].role === 'user' && c2.history[1].role === 'assistant' && typeof c2.history[1].text === 'string', JSON.stringify(c2?.history?.map((h) => h.role)));

    // Safe rendering
    await ta.type('html please');
    await page.keyboard.press('Enter');
    await dialog.getByText('Bold text').waitFor();
    check(`[${tag}] reply HTML is shown as text, never parsed`, (await dialog.locator('img').count()) === 0 && (await page.evaluate(() => window.__xss)) === undefined && (await dialog.getByText('<img src=x', { exact: false }).count()) >= 1);
    check(`[${tag}] bare email + trailing-dot URL linked correctly`, (await dialog.locator('a[href="mailto:support@deepwelltechnology.com"]').count()) >= 1 && (await dialog.locator('a[href="https://deepwelltechnology.com/pricing"]').count()) === 1);

    // Redirect to Ask
    await ta.type('When was the Trane installed at 123 Main?');
    await page.keyboard.press('Enter');
    const askBtn = dialog.getByRole('button', { name: 'Ask Donovan about your records →' });
    await askBtn.waitFor();
    await askBtn.click();
    await page.waitForTimeout(150);
    check(`[${tag}] "Ask Donovan" hands the question over and closes the panel`, (await page.evaluate(() => window.__askDonovan)) === 'When was the Trane installed at 123 Main?' && (await dialog.count()) === 0);
    check(`[${tag}] focus returns to the launcher after close`, await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Open DeepWell Help chat'));

    // Reopen keeps conversation, Esc closes + returns focus
    await launcher.click();
    await dialog.waitFor();
    check(`[${tag}] reopening keeps the conversation`, (await dialog.getByText('How do I upload documents?').count()) === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    check(`[${tag}] Esc closes; focus returns to launcher`, (await dialog.isHidden()) && (await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Open DeepWell Help chat')));

    // 429 + 500
    await launcher.click();
    await dialog.waitFor();
    await page.evaluate(() => { window.__rateLimit = true; });
    await ta.type('question after quick sends');
    await page.keyboard.press('Enter');
    const alert = dialog.locator('[role=alert]').first();
    await alert.waitFor();
    check(`[${tag}] 429 shows friendly wait message`, /You're sending messages quickly — try again in 3s\./.test(await alert.textContent()), await alert.textContent());
    check(`[${tag}] 429 disables retry during cooldown`, await dialog.getByRole('button', { name: /Try again in \d+s/ }).isDisabled());
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-4-rate-limit.png` });
    await page.waitForTimeout(3600);
    const retry = dialog.getByRole('button', { name: 'Try again' });
    check(`[${tag}] retry enabled after cooldown`, await retry.isEnabled());
    await retry.click();
    await dialog.getByText('From: Uploading and scanning').nth(2).waitFor();
    check(`[${tag}] retry does not duplicate the user message`, (await dialog.getByText('question after quick sends').count()) === 1);
    await ta.type('boom');
    await page.keyboard.press('Enter');
    await alert.waitFor();
    check(`[${tag}] 500 shows friendly error with support email`, (await alert.textContent()).includes('support@deepwelltechnology.com') && !(await alert.textContent()).includes('internal'));
    await dialog.getByRole('button', { name: 'New chat' }).click();

    // Hand-off
    await ta.type('I want a refund');
    await page.keyboard.press('Enter');
    const offer = dialog.getByRole('button', { name: 'Send this to a person' }).first();
    await offer.waitFor();
    await offer.click();
    const form = dialog.getByRole('form', { name: 'Send this conversation to a person' });
    await form.waitFor();
    check(`[${tag}] hand-off email prefilled from the signed-in user`, (await form.getByLabel('Your email').inputValue()) === 'pat@sunrisehvac.com');
    check(`[${tag}] hand-off message prefilled with the last question`, (await form.getByLabel('What do you need help with?').inputValue()) === 'I want a refund');
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-5-handoff.png` });
    await form.getByLabel('Name (optional)').fill('Pat');
    await form.getByRole('button', { name: 'Send' }).click();
    await dialog.getByText('Sent to the DeepWell team.').waitFor();
    const hc = await page.evaluate(() => window.__calls.find((c) => c.body?.action === 'handoff')?.body);
    check(`[${tag}] hand-off POST shape (action, email, name, message, transcript, surface)`, hc && hc.email === 'pat@sunrisehvac.com' && hc.name === 'Pat' && hc.message === 'I want a refund' && hc.surface === 'app' && Array.isArray(hc.transcript) && hc.transcript.length >= 2, JSON.stringify(hc));
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-6-handoff-sent.png` });

    // Layout
    check(`[${tag}] no horizontal overflow`, !(await overflowX(page)));

    // Persistence across reload
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Open DeepWell Help chat' }).click();
    await page.getByRole('dialog').getByText('I want a refund').first().waitFor();
    check(`[${tag}] conversation restored from sessionStorage after reload`, (await page.getByRole('dialog').getByText('I want a refund').count()) >= 1 && (await page.getByText('Sent to the DeepWell team.').count()) === 1);

    // 12-turn limit (seed storage)
    await page.evaluate(() => {
      const msgs = [];
      for (let i = 0; i < 12; i++) { msgs.push({ id: `u${i}`, role: 'user', text: `Question ${i + 1}` }); msgs.push({ id: `a${i}`, role: 'assistant', text: `Answer ${i + 1}` }); }
      sessionStorage.setItem('deepwell.support.chat.v1.app', JSON.stringify({ msgs, handoffSent: false }));
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Open DeepWell Help chat' }).click();
    const dlg = page.getByRole('dialog', { name: 'DeepWell Help' });
    await dlg.getByText('For more help, email').waitFor();
    check(`[${tag}] after 12 user turns: email prompt + hand-off, input gone`, (await dlg.getByRole('textbox', { name: 'Message DeepWell Help' }).count()) === 0 && (await dlg.getByRole('button', { name: 'Send this to a person' }).count()) >= 1 && (await dlg.locator('a[href="mailto:support@deepwelltechnology.com"]').count()) >= 1);
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-7-turn-limit.png` });
    await page.evaluate(() => sessionStorage.clear());

    // Offline
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Open DeepWell Help chat' }).click();
    await page.getByRole('dialog').waitFor();
    const before = await page.evaluate(() => window.__calls.length);
    await ctx.setOffline(true);
    await page.getByText('Help chat needs a connection').waitFor();
    check(`[${tag}] offline: message + support email, composer replaced, nothing sent`, (await page.getByRole('dialog').getByRole('textbox', { name: 'Message DeepWell Help' }).count()) === 0 && (await page.evaluate(() => window.__calls.length)) === before);
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-8-offline.png` });
    await ctx.setOffline(false);

    check(`[${tag}] no console/page errors`, errors.length === 0, errors.join('\n      '));
    await ctx.close();
  }

  // Desktop: pulse policy (fake clock), reduced motion
  {
    const { ctx, page } = await newPage({ width: 1440, height: 900 });
    await page.clock.install();
    await go(page, 'desktop', false);
    const pulsing = () => page.getByRole('button', { name: 'Open DeepWell Help chat' }).locator('.dw-sl-pulsing').count();
    check('pulse policy: pulsing at load', (await pulsing()) === 1);
    await page.clock.runFor(21_000);
    check('pulse policy: stops after ~20s', (await pulsing()) === 0);
    await page.clock.runFor(41_000);
    check('pulse policy: brief burst again at ~60s', (await pulsing()) === 1);
    await page.clock.runFor(7_000);
    check('pulse policy: burst ends', (await pulsing()) === 0);
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage({ width: 1440, height: 900 }, { reduced: true });
    await go(page, 'desktop', false);
    const anim = await page.getByRole('button', { name: 'Open DeepWell Help chat' }).evaluate((b) => ({ ring: getComputedStyle(b.querySelector('.dw-sl-ring')).animationName, halo: getComputedStyle(b).animationName }));
    check('reduced motion: ring + halo animations disabled', anim.ring === 'none' && anim.halo === 'none', JSON.stringify(anim));
    await ctx.close();
  }

  // ------------------------------------------------------------------- mobile
  for (const field of [false, true]) {
    const theme = field ? 'light' : 'dark';
    const tag = `mobile-${theme}`;
    const { ctx, page, errors } = await newPage({ width: 390, height: 844 }, { mobile: true });
    await go(page, 'mobile', field);
    const btn = page.getByRole('button', { name: 'Open DeepWell Help chat' });
    const bb = await box(btn);
    const nb = await box(page.locator('nav'));
    check(`[${tag}] header help button is 44px, right side, above the tab bar`, bb && Math.round(bb.width) === 44 && Math.round(bb.height) === 44 && bb.x > 195 && bb.y + bb.height < nb.y, JSON.stringify({ bb, nb }));
    check(`[${tag}] tab bar still 3 tabs`, (await page.locator('nav button').count()) === 3);
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-1-header.png` });

    // Fake visualViewport so the keyboard inset logic is exercised
    await page.evaluate(() => {
      const vv = Object.assign(new EventTarget(), { height: window.innerHeight, width: window.innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
      window.__vv = vv;
    });
    await btn.tap();
    const sheet = page.getByRole('dialog', { name: 'DeepWell Help' });
    await sheet.waitFor();
    await page.getByText("Hi, I'm DeepWell Help").waitFor();
    await page.waitForTimeout(200);
    const sb = await box(sheet.locator('div.rounded-t-2xl'));
    check(`[${tag}] opens in the Sheet: full width, max ~88dvh, bottom-anchored`, sb && Math.round(sb.width) === 390 && sb.height <= 844 * 0.88 + 1 && Math.abs(sb.y + sb.height - 844) <= 1, JSON.stringify(sb));
    const tab = sheet.getByRole('textbox', { name: 'Message DeepWell Help' });
    const fs = await tab.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    check(`[${tag}] input font >= 16px (no iOS zoom)`, fs >= 16, String(fs));
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-2-open-starter.png` });

    await tab.tap();
    await tab.fill('How do I upload documents?');
    await page.keyboard.press('Enter');
    await sheet.getByText('From: Uploading and scanning').waitFor();
    const mc = await page.evaluate(() => window.__calls.filter((c) => c.method === 'POST')[0]?.body);
    check(`[${tag}] POST body has surface=mobile, page=mobile:ask`, mc && mc.surface === 'mobile' && mc.page === 'mobile:ask', JSON.stringify(mc));
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-3-chat.png` });

    // keyboard: shrink visual viewport to 480px
    await page.evaluate(() => { window.__vv.height = 480; window.dispatchEvent(new Event('resize')); window.__vv.dispatchEvent(new Event('resize')); });
    await page.waitForTimeout(150);
    const sb2 = await box(sheet.locator('div.rounded-t-2xl'));
    const tb2 = await box(tab);
    check(`[${tag}] with keyboard up the sheet and input sit above the visual viewport bottom (480)`, sb2.y + sb2.height <= 481 && tb2.y + tb2.height <= 480, JSON.stringify({ sb2, tb2 }));
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-4-keyboard.png` });
    await page.evaluate(() => { window.__vv.height = 844; window.__vv.dispatchEvent(new Event('resize')); });
    await page.waitForTimeout(100);

    // 44px sweep (buttons; inline text links are exempt)
    const small = await sheet.evaluate((root) => Array.from(root.querySelectorAll('button:not([tabindex="-1"])')).filter((el) => el.getClientRects().length).map((el) => { const r = el.getBoundingClientRect(); return { t: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((x) => x.h < 43.5 || x.w < 43.5));
    check(`[${tag}] every button in the sheet is >=44px`, small.length === 0, JSON.stringify(small));

    // Redirect closes sheet, hands question over
    await tab.fill('When was the Trane installed?');
    await page.keyboard.press('Enter');
    await sheet.getByRole('button', { name: 'Ask Donovan about your records →' }).click();
    await page.waitForTimeout(150);
    check(`[${tag}] "Ask Donovan" hands question over and closes the sheet`, (await page.evaluate(() => window.__askDonovan)) === 'When was the Trane installed?' && (await sheet.count()) === 0);

    // Esc + focus return
    await btn.tap();
    await sheet.waitFor();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    check(`[${tag}] Esc closes the sheet; focus returns to the header button`, (await sheet.count()) === 0 && (await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Open DeepWell Help chat')));

    // Offline
    await btn.tap();
    await sheet.waitFor();
    await ctx.setOffline(true);
    await sheet.getByText('Help chat needs a connection').waitFor();
    check(`[${tag}] offline: "Help chat needs a connection" + support email`, (await sheet.locator('a[href="mailto:support@deepwelltechnology.com"]').count()) >= 1);
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-5-offline.png` });
    await ctx.setOffline(false);
    check(`[${tag}] no horizontal overflow`, !(await overflowX(page)));
    check(`[${tag}] no console/page errors`, errors.length === 0, errors.join('\n      '));
    await ctx.close();
  }

  await browser.close();
} catch (e) {
  failures++;
  console.log(`FAIL  harness crashed: ${e?.stack ?? e}`);
} finally {
  try { if (server?.pid) process.kill(-server.pid); } catch { /* already gone */ }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
