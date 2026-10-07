// QA walk: drives the real App via scripts/app-qa-harness (fake backend, no network). Writes screenshots to
// /home/claude/work/walk-shots and observations to /home/claude/work/sec-out/walk-obs.json.
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startServer } from '../app-qa-harness/serve.mjs';
import { installBackend } from '../app-qa-harness/backend.mjs';

import { tmpdir } from 'node:os';
const SHOTS = `${tmpdir()}/deepwell-walk-shots`;
mkdirSync(SHOTS, { recursive: true });
const obs = [];
const note = (id, data) => { obs.push({ id, ...data }); console.log(id, JSON.stringify(data).slice(0, 400)); };
const { chromium } = await import('playwright');
const { server, base } = await startServer();
const mobileBase = base.replace('index.html', 'mobile.html');
const browser = await chromium.launch();
const D = { width: 1280, height: 800 }, P = { width: 390, height: 844 };

async function open({ auth = {}, backend = {}, vp = D, mobile = false, url = '' } = {}) {
  const ctx = await browser.newContext({ viewport: vp, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.__errs = [];
  page.on('pageerror', (e) => page.__errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) page.__errs.push('console: ' + m.text().slice(0, 150)); });
  await page.addInitScript((a) => { window.__QA_AUTH = a; }, auth);
  await installBackend(page, backend);
  await page.goto((mobile ? mobileBase : base) + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  return page;
}
const go = async (page, s) => { await page.evaluate((x) => window.__store.getState().setCurrentScreen(x), s); await page.waitForTimeout(500); };
const shot = (page, n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });
const text = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');

// generic a11y/tap-target audit of what is on screen right now
async function audit(page, id, phone) {
  const r = await page.evaluate((phone) => {
    const vis = (el) => { const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.innerText || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || (el.id && document.querySelector(`label[for="${el.id}"]`)?.innerText) || el.closest('label')?.innerText || '').trim();
    const out = { small: [], unnamed: [], noAlt: [], overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, h1: document.querySelectorAll('h1').length, landmarks: { main: document.querySelectorAll('main,[role=main]').length, nav: document.querySelectorAll('nav').length } };
    document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=tab]').forEach((el) => {
      if (!vis(el)) return; const b = el.getBoundingClientRect();
      if (phone && (b.height < 43.5 || b.width < 43.5) && !(el.tagName === 'A' && el.closest('p,li,span') && b.height < 43.5 && el.parentElement?.innerText.length > (el.innerText || '').length + 5)) out.small.push(`${el.tagName.toLowerCase()}:${name(el).slice(0, 30)}:${Math.round(b.width)}x${Math.round(b.height)}`);
      if (!name(el)) out.unnamed.push(el.outerHTML.slice(0, 90));
    });
    document.querySelectorAll('img').forEach((i) => { if (vis(i) && !i.hasAttribute('alt')) out.noAlt.push(i.src.slice(-40)); });
    return out;
  }, phone);
  note('audit:' + id, { small: [...new Set(r.small)].slice(0, 12), nSmall: r.small.length, unnamed: r.unnamed.slice(0, 5), noAlt: r.noAlt.slice(0, 3), overflow: r.overflow, h1: r.h1, landmarks: r.landmarks, errs: page.__errs.slice(0, 3) });
}
const safe = async (id, fn) => { try { await fn(); } catch (e) { note('ERR:' + id, { msg: String(e.message).slice(0, 300) }); } };
const answer = (data, extra = {}) => async (page) => page.route('**/api/ask', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }), ...extra }));
async function askQ(page, q) {
  const box = page.locator('textarea, input:not([type=checkbox]):not([type=file])').first();
  await box.fill(q); await box.press('Enter'); await page.waitForTimeout(1500);
}
const src = (n = 1, page = 2) => Array.from({ length: n }, () => ({ documentId: '44444444-4444-4444-8444-000000000001', location: { page, field: 'Serial No.' }, excerpt: 'Serial No. 4A7C2B9' }));

try {
 for (const [vn, vp] of [['d', D], ['p', P]]) {
  const phone = vn === 'p';
  const mobile = phone;
  // ---- sign-in states (desktop app path; phone uses same App? mobile.html is MobileApp)
  for (const [n, auth] of [['signedout', { isSignedIn: false }], ['loading', { isLoaded: false }], ['noorg', { orgId: null }], ['member', { orgRole: 'org:member' }]]) {
    await safe('auth-' + n + vn, async () => {
      const page = await open({ auth, vp });
      await shot(page, `auth-${n}-${vn}`); note(`auth-${n}-${vn}`, { text: (await text(page)).slice(0, 300) }); await audit(page, `auth-${n}-${vn}`, phone);
      await page.context().close();
    });
  }
  // ---- empty shop
  await safe('empty' + vn, async () => {
    const page = await open({ vp, backend: { docs: 0, customers: 0 } });
    for (const s of ['ask', 'ingest', 'browse', 'dashboard', 'warranty-export', 'team', 'billing', 'outreach', 'review']) {
      await go(page, s); await shot(page, `empty-${s}-${vn}`); note(`empty-${s}-${vn}`, { text: (await text(page)).slice(0, 350) }); await audit(page, `empty-${s}-${vn}`, phone);
    }
    await page.context().close();
  });
  // ---- populated screens
  await safe('pop' + vn, async () => {
    const page = await open({ vp, backend: { docs: 12, customers: 6 } });
    for (const s of ['ask', 'ingest', 'browse', 'dashboard', 'warranty-export', 'team', 'billing', 'outreach', 'review']) {
      await go(page, s); await shot(page, `pop-${s}-${vn}`); note(`pop-${s}-${vn}`, { text: (await text(page)).slice(0, 500) }); await audit(page, `pop-${s}-${vn}`, phone);
    }
    // customers tab + profile
    await go(page, 'browse');
    await page.getByRole('tab', { name: 'Customers' }).click().catch(() => {}); await page.waitForTimeout(500);
    await shot(page, `customers-${vn}`); await audit(page, `customers-${vn}`, phone);
    await page.getByText('Carol Rios').first().click().catch(() => {}); await page.waitForTimeout(800);
    await shot(page, `customer-profile-${vn}`); note(`customer-profile-${vn}`, { text: (await text(page)).slice(0, 500) }); await audit(page, `customer-profile-${vn}`, phone);
    // equipment tab
    await go(page, 'browse');
    for (const t of ['Equipment', 'Documents']) { await page.getByRole('tab', { name: t }).click().catch(() => note('notab-' + t + vn, {})); await page.waitForTimeout(500); await shot(page, `tab-${t}-${vn}`); note(`tab-${t}-${vn}`, { text: (await text(page)).slice(0, 300) }); }
    // open a document
    await page.getByText('work-order-1.pdf').first().click().catch(() => {}); await page.waitForTimeout(900);
    await shot(page, `docviewer-${vn}`); note(`docviewer-${vn}`, { text: (await text(page)).slice(0, 600) }); await audit(page, `docviewer-${vn}`, phone);
    await page.context().close();
  });
  // ---- billing states
  for (const b of ['trialing', 'active', 'past_due', 'canceled', 'none', 'unpaid', 'incomplete']) {
    await safe('bill-' + b + vn, async () => {
      const page = await open({ vp, backend: { billing: b } });
      await shot(page, `billing-${b}-${vn}-gate`); const t0 = (await text(page)).slice(0, 300);
      await go(page, 'billing'); await shot(page, `billing-${b}-${vn}`); note(`billing-${b}-${vn}`, { gate: t0, text: (await text(page)).slice(0, 700) }); await audit(page, `billing-${b}-${vn}`, phone);
      await page.context().close();
    });
  }
  await safe('overlimit' + vn, async () => {
    const page = await open({ vp, backend: {} });
    await page.route('**/api/**', async (route) => {
      const u = new URL(route.request().url()); let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch {}
      const act = b.action || u.searchParams.get('action');
      if ((u.pathname === '/api/billing' && act === 'status')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plan: 'solo', status: 'active', limits: { logins: 2, documentsStored: 25000, pagesPerMonth: 750 }, usage: { documentsStored: 25000, pagesThisMonth: 790, asksThisMonth: 300, resetsOn: new Date(Date.now() + 5 * 864e5).toISOString() }, currentPeriodEnd: new Date(Date.now() + 5 * 864e5).toISOString() }) });
      return route.fallback();
    });
    await go(page, 'billing'); await page.reload({ waitUntil: 'networkidle' }); await go(page, 'billing');
    await shot(page, 'billing-overlimit-' + vn); note('billing-overlimit-' + vn, { text: (await text(page)).slice(0, 700) });
    await page.context().close();
  });
  // ---- team
  await safe('team' + vn, async () => {
    const page = await open({ vp });
    await go(page, 'team'); await shot(page, 'team-admin-' + vn); note('team-admin-' + vn, { text: (await text(page)).slice(0, 900) }); await audit(page, 'team-admin-' + vn, phone);
    for (const name of [/invite/i, /remove/i]) { const b = page.getByRole('button', { name }).first(); if (await b.count()) { await b.click().catch(() => {}); await page.waitForTimeout(500); await shot(page, `team-${name.source.slice(0,6)}-${vn}`); note(`team-click-${name.source}-${vn}`, { text: (await text(page)).slice(0, 500) }); } else note(`team-no-${name.source}-${vn}`, {}); }
    await page.context().close();
    const p2 = await open({ vp, auth: { orgRole: 'org:member' } });
    await go(p2, 'team'); await shot(p2, 'team-member-' + vn); note('team-member-' + vn, { text: (await text(p2)).slice(0, 500) });
    await go(p2, 'billing'); note('billing-member-' + vn, { text: (await text(p2)).slice(0, 400) });
    await p2.context().close();
  });
  // ---- Donovan
  const good = { kind: 'answer', text: 'The Trane unit at 1000 N 20th St has serial 4A7C2B9 and is under warranty until March 15, 2029.', facts: [{ label: 'Serial number', value: '4A7C2B9', sources: src(1) }, { label: 'Warranty ends', value: 'March 15, 2029', status: 'ok', sources: src(1, 1) }], sources: src(2), confidence: 0.9, verifiedCount: 1, unverifiedCount: 0, closest: [] };
  const long = { ...good, text: 'This is a very long answer. '.repeat(60), facts: Array.from({ length: 25 }, (_, i) => ({ label: `Fact label number ${i} that is quite long to see wrapping`, value: 'Value '.repeat(25), sources: src(1) })) };
  const decline = { kind: 'no-answer', text: 'Nothing in your records answers that.', facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [{ documentId: '44444444-4444-4444-8444-000000000002', location: { page: 1 } }] };
  const clar = { ...decline, text: 'Which customer do you mean?', interpretation: 'Two customers match "Harbor".' };
  const scen = [['good', answer(good)], ['long', answer(long)], ['decline', answer(decline)], ['clarify', answer(clar)]];
  for (const [n, setup] of scen) await safe('ask-' + n + vn, async () => {
    const page = await open({ vp, mobile, backend: { docs: 12 }, url: mobile ? '?tab=ask' : '' });
    await setup(page); await askQ(page, 'What is the serial number at 1000 N 20th St?');
    await shot(page, `ask-${n}-${vn}`); note(`ask-${n}-${vn}`, { text: (await text(page)).slice(0, 700) }); await audit(page, `ask-${n}-${vn}`, phone);
    if (n === 'good') {
      const link = page.locator('main button, main a').filter({ hasText: /page 2|p\. ?2|Serial No|source/i }).first();
      note('ask-source-link-' + vn, { found: await link.count() });
      if (await link.count()) { await link.click().catch(() => {}); await page.waitForTimeout(900); await shot(page, 'ask-source-open-' + vn); note('ask-source-open-' + vn, { text: (await text(page)).slice(0, 500) }); }
    }
    await page.context().close();
  });
  for (const [n, f] of [['429', { status: 429, match: /api\/ask/, message: 'Too many requests' }], ['402', { status: 402, match: /api\/ask/, message: 'A subscription is required', url: '/app/?screen=billing' }], ['500', { status: 500, html: true, match: /api\/ask/ }], ['404', { status: 404, match: /api\/ask/, message: 'Not found' }], ['offline', null]]) {
    await safe('askerr-' + n + vn, async () => {
      const page = await open({ vp, mobile, backend: f ? { fail: f } : { offline: true }, url: mobile ? '?tab=ask' : '' });
      await askQ(page, 'What is the serial number at 1000 N 20th St?');
      await shot(page, `askerr-${n}-${vn}`); note(`askerr-${n}-${vn}`, { text: (await text(page)).slice(0, 500), buttons: await page.locator('main button:visible').allInnerTexts() });
      await page.context().close();
    });
  }
  await safe('ask-slow' + vn, async () => {
    const page = await open({ vp, mobile, backend: { delayMs: 0 }, url: mobile ? '?tab=ask' : '' });
    await page.route('**/api/ask', async (r) => { await new Promise((x) => setTimeout(x, 4000)); r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: good }) }); });
    const box = page.locator('textarea, input:not([type=checkbox]):not([type=file])').first(); await box.fill('serial?'); await box.press('Enter'); await page.waitForTimeout(1500);
    await shot(page, 'ask-slow-' + vn); note('ask-slow-' + vn, { text: (await text(page)).slice(0, 400), busy: await page.locator('[aria-busy=true],[role=status]').count() });
    await page.context().close();
  });
  // ---- uploads (desktop Inbox / phone Scan)
  const files = {
    good: [{ name: 'ticket.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 good') }],
    wrongtype: [{ name: 'notes.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') }],
    toobig: [{ name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(40 * 1024 * 1024, 1) }],
    dup: [{ name: 'work-order-1.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 dup') }],
  };
  for (const [n, f] of Object.entries(files)) for (const bk of [{}, { fail: { status: 413, match: /upload/, message: 'File too large' } }, { offline: true }, { fail: { status: 409, match: /upload/, message: 'Already uploaded' } }]) {
    const tag = n + '-' + (bk.offline ? 'offline' : bk.fail ? bk.fail.status : 'ok');
    if (n !== 'good' && !bk.offline && bk.fail && bk.fail.status !== 413 && n !== 'dup') continue;
    await safe('up-' + tag + vn, async () => {
      const page = await open({ vp, mobile, backend: { docs: 3, ...bk }, url: mobile ? '?tab=scan' : '' });
      if (!mobile) await go(page, 'ingest');
      const inp = page.locator('input[type=file]').first();
      note(`upload-input-${tag}-${vn}`, { accept: await inp.getAttribute('accept').catch(() => null), n: await page.locator('input[type=file]').count() });
      await inp.setInputFiles(f).catch((e) => note('setfiles-err', { m: e.message.slice(0, 100) })); await page.waitForTimeout(2500);
      await shot(page, `upload-${tag}-${vn}`); note(`upload-${tag}-${vn}`, { text: (await text(page)).slice(0, 600) });
      await page.context().close();
    });
  }
  // ---- sync errors, export/delete, help, settings
  await safe('exp' + vn, async () => {
    const page = await open({ vp });
    await go(page, 'warranty-export'); note('export-' + vn, { buttons: await page.locator('main button:visible').allInnerTexts() });
    await page.getByText(/export|download/i).first().click().catch(() => {}); await page.waitForTimeout(500); await shot(page, 'export-click-' + vn);
    const helpBtn = page.getByRole('button', { name: /help|\?/i }).first(); note('help-btn-' + vn, { found: await helpBtn.count() });
    if (await helpBtn.count()) { await helpBtn.click().catch(() => {}); await page.waitForTimeout(700); await shot(page, 'help-' + vn); note('help-' + vn, { text: (await text(page)).slice(0, 600) }); await audit(page, 'help-' + vn, phone); }
    await page.keyboard.press('Escape');
    // settings/delete discovery
    const t = await page.locator('body').innerText();
    note('settings-words-' + vn, { delete: /delete (my|your|all)/i.test(t), settings: /settings/i.test(t), export: /export/i.test(t) });
    await page.context().close();
  });
  await safe('keyboard' + vn, async () => {
    const page = await open({ vp, backend: { docs: 3 } });
    const seq = [];
    for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); seq.push(await page.evaluate(() => { const e = document.activeElement; const cs = e && getComputedStyle(e); return `${e?.tagName}:${(e?.getAttribute('aria-label') || e?.innerText || '').trim().slice(0, 24)}:${cs?.outlineStyle}/${cs?.boxShadow !== 'none' ? 'ring' : ''}`; })); }
    note('tab-order-' + vn, { seq });
    await page.context().close();
  });
 }
} finally {
  writeFileSync(`${tmpdir()}/deepwell-walk-obs.json`, JSON.stringify(obs, null, 1));
  await browser.close(); await server.close();
}
