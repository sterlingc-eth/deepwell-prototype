// Intake Queue UI (Round 13, H2, research #2/#7): IntakeQueuePanel rendered
// alone against a mocked GET /api/v1/intake-status(?queue=1) and
// POST /api/account?action=intake (see scripts/intake-harness/), at 1280px
// and 390px, in both Office (dark) and Field (light) theme. Checks: header
// STP rate + open-document count render, cards render with the one
// question + candidate options + evidence + filled-field chips, picking a
// candidate resolves and removes the card, "Type it instead" resolves via
// a typed value, snooze removes a card, keyboard shortcuts (1/S) work, no
// horizontal overflow, no console errors. Screenshots go to SHOT_DIR —
// look at them.
//
//   npx playwright install chromium   (once, if not already present)
//   node scripts/verify-intake-ui.mjs [screenshotDir]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const SHOT_DIR = process.argv[2] ?? '/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad';
mkdirSync(SHOT_DIR, { recursive: true });

// A port unlikely to collide with another engineer's own dev server running
// concurrently in a sibling worktree (records-ui uses 5219, graph-ui 5183).
const PORT = 5231;
const BASE = `http://localhost:${PORT}/scripts/intake-harness`;

/* ------------------------------------------------------------ fixtures -- */
const STATUS_BASE = { total: 62, autoVerified: 58, autoVerifiedCount: 58, humanVerified: 4, openQuestions: 2, resolvedQuestions: 11, straightThroughRate: 0.9354838709677419, needsInfoTracked: true };

function item(n, overrides) {
  return {
    needsInfoId: `n${n}`,
    documentId: `d${n}`,
    entityId: `e${n}`,
    documentType: 'invoice',
    documentTypeLabel: 'Invoice',
    displayName: null,
    filename: `warranty-card-${n}.pdf`,
    stage: 'read',
    fieldKey: 'serial_number',
    fieldLabel: 'Serial',
    question: 'Which serial number is right for this unit?',
    candidates: [
      { kind: 'value', label: '4V7834521', value: '4V7834521', entityId: null, address: null, documentId: `d${n}`, page: 1, sourceDocumentLabel: 'Warranty registration', evidence: 'Serial No: 4V7834521 — Trane XR16' },
      { kind: 'value', label: '4V7834251', value: '4V7834251', entityId: null, address: null, documentId: `d${n + 10}`, page: 2, sourceDocumentLabel: 'Install invoice', evidence: 'S/N 4V7834251 installed 2026-08-01' },
    ],
    moreQuestions: 0,
    filledFields: [
      { fieldKey: 'manufacturer', label: 'Manufacturer', value: 'Trane', confidence: 0.97, source: 'inferred', correctedBy: null, provenance: 'Inferred from Warranty registration p.1' },
      { fieldKey: 'model', label: 'Model', value: 'XR16', confidence: 0.92, source: 'stated', correctedBy: null, provenance: null },
    ],
    extracted: [],
    createdAt: '2026-09-25T10:00:00Z',
    ...overrides,
  };
}

const ITEMS = [
  item(1),
  item(2, {
    fieldKey: 'customer_name',
    fieldLabel: 'Customer',
    question: 'Which customer is this document for?',
    filename: 'unlabeled-scan-2.pdf',
    candidates: [
      { kind: 'entity', label: 'Bill Whitmore — 88 Whitmore Ave, Mesa, AZ', value: 'Bill Whitmore', entityId: 'c-whitmore', address: '88 Whitmore Ave, Mesa, AZ', documentId: null, page: null, sourceDocumentLabel: null, evidence: null },
      { kind: 'entity', label: 'William Whitmore Jr — 90 Whitmore Ave, Mesa, AZ', value: 'William Whitmore Jr', entityId: 'c-whitmore-jr', address: '90 Whitmore Ave, Mesa, AZ', documentId: null, page: null, sourceDocumentLabel: null, evidence: null },
    ],
    filledFields: [],
  }),
];

let queueState = { items: ITEMS, nextCursor: null, openDocumentCount: ITEMS.length, tracked: true };

function statusResponse(withQueue) {
  return withQueue ? { ...STATUS_BASE, queue: queueState } : STATUS_BASE;
}

/* ---------------------------------------------------------------- run --- */
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
};

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
await new Promise((r) => setTimeout(r, 1800));
if (server.exitCode !== null) {
  console.error(`FAIL  dev server did not start on port ${PORT} (already in use by another worktree?):\n${serverLog}`);
  process.exit(1);
}

const browser = await chromium.launch();
const shot = (page, name) => page.screenshot({ path: `${SHOT_DIR}/intake-${name}.png`, fullPage: true });

async function mockApi(page) {
  await page.route('**/api/v1/intake-status*', async (route) => {
    const url = new URL(route.request().url());
    const withQueue = url.searchParams.get('queue') === '1';
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(statusResponse(withQueue)) });
  });
  await page.route('**/api/account?action=intake', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const idx = queueState.items.findIndex((it) => it.documentId === body.documentId && it.fieldKey === body.fieldKey);
    if (idx >= 0) {
      if (body.op === 'resolve' || body.op === 'dismiss' || body.op === 'snooze') {
        queueState = { ...queueState, items: queueState.items.filter((_, i) => i !== idx), openDocumentCount: Math.max(0, queueState.openDocumentCount - 1) };
      }
    }
    const okBody =
      body.op === 'resolve'
        ? { ok: true, resolvedValue: body.value ?? body.entityId ?? '', autofill: { ok: true, filled: [], questions: [], verified: false } }
        : body.op === 'dismiss'
          ? { ok: true, dismissed: true }
          : { ok: true, snoozed: true, until: new Date(Date.now() + 3600_000).toISOString() };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(okBody) });
  });
}

async function run(viewport, name, dark) {
  queueState = { items: ITEMS.map((i) => ({ ...i })), nextCursor: null, openDocumentCount: ITEMS.length, tracked: true };
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(`console: ${m.text()}`); });
  await mockApi(page);

  await page.goto(`${BASE}/desktop.html`, { waitUntil: 'networkidle' });
  await page.evaluate((on) => window.__dwSetDark?.(on), dark);
  await page.waitForTimeout(400);

  check(`${name}: STP header renders the rate`, (await page.getByText(/94%|93%/).count()) > 0, 'expected the straight-through rate text');
  check(`${name}: open-document count renders`, (await page.getByText(/2.*need.*a decision|need.*decision/i).count()) > 0);
  check(`${name}: both cards render`, (await page.getByText('warranty-card-1.pdf').count()) > 0 && (await page.getByText(/whitmore/i).first().count()) > 0);
  check(`${name}: filled-field confidence chip renders with provenance`, (await page.getByText(/Trane/).count()) > 0);
  await shot(page, `${name}-1-initial`);

  // "Why are we asking?" reveals evidence.
  const whyBtn = page.getByRole('button', { name: /why are we asking/i }).first();
  if (await whyBtn.count()) {
    await whyBtn.click();
    await page.waitForTimeout(200);
    check(`${name}: evidence text appears after "Why are we asking?"`, (await page.getByText(/Serial No: 4V7834521/).count()) > 0);
    await shot(page, `${name}-2-evidence`);
  } else {
    check(`${name}: "Why are we asking?" control is present`, false);
  }

  // Pick the first candidate option on the first card -> it resolves and disappears.
  const pickBtn = page.getByRole('button', { name: /4V7834521/ }).first();
  if (await pickBtn.count()) {
    await pickBtn.click();
    await page.waitForTimeout(500);
    check(`${name}: picking a candidate removes that card`, (await page.getByText('warranty-card-1.pdf').count()) === 0);
    check(`${name}: the other card is still there`, (await page.getByText(/whitmore/i).first().count()) > 0);
    await shot(page, `${name}-3-after-resolve`);
  } else {
    check(`${name}: a candidate option button is present`, false);
  }

  // "Type it instead" on the remaining card.
  const typeToggle = page.getByRole('button', { name: /type it instead/i }).first();
  if (await typeToggle.count()) {
    await typeToggle.click();
    await page.waitForTimeout(200);
    const input = page.getByRole('textbox').first();
    await input.fill('Someone Else');
    const confirm = page.getByRole('button', { name: /confirm|save|submit/i }).first();
    if (await confirm.count()) {
      await confirm.click();
      await page.waitForTimeout(500);
      check(`${name}: "Type it instead" resolves and clears the queue`, (await page.getByText(/whitmore/i).count()) === 0);
    } else {
      check(`${name}: a confirm control follows "Type it instead"`, false);
    }
  } else {
    check(`${name}: "Type it instead" control is present`, false);
  }

  check(`${name}: empty state shows once the queue clears`, (await page.getByText(/nothing needs a decision/i).count()) > 0);
  await shot(page, `${name}-4-empty`);

  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check(`${name}: no horizontal overflow`, !overflowX);
  check(`${name}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));
  await page.close();
}

async function runKeyboard(name) {
  queueState = { items: ITEMS.map((i) => ({ ...i })), nextCursor: null, openDocumentCount: ITEMS.length, tracked: true };
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await mockApi(page);
  await page.goto(`${BASE}/desktop.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.keyboard.press('1'); // pick candidate #1 on the active (first) card
  await page.waitForTimeout(500);
  check(`${name}: pressing "1" resolves the active card`, (await page.getByText('warranty-card-1.pdf').count()) === 0);
  await page.keyboard.press('s'); // snooze the now-active (second) card
  await page.waitForTimeout(500);
  check(`${name}: pressing "s" snoozes the active card`, (await page.getByText(/nothing needs a decision/i).count()) > 0);
  await page.close();
}

try {
  await run({ width: 1280, height: 900 }, 'desktop-office-dark', true);
  await run({ width: 1280, height: 900 }, 'desktop-field-light', false);
  await run({ width: 390, height: 844 }, 'mobile-office-dark', true);
  await run({ width: 390, height: 844 }, 'mobile-field-light', false);
  await runKeyboard('keyboard');
} finally {
  await browser.close();
  try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill(); }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
console.log(`Screenshots in ${SHOT_DIR} — look at them before calling this done.`);
process.exit(failures ? 1 : 0);
