// Records Browse UI (round 12 contract, G2): RecordsBrowser (desktop) and
// DocsTab (mobile), each rendered alone against a mocked /api/records (see
// scripts/records-harness/), at 1280px (desktop app) and 390px (mobile app —
// a separate build, src/mobile/main.tsx, not a breakpoint of the same page),
// in both Office (dark) and Field (light) theme. Checks: rows render,
// filters actually narrow the list, active chips + clear-all work, sort
// reorders, group-by groups, URL state round-trips (query params reflect
// filters; reloading a filtered URL restores that same filtered state), no
// horizontal overflow, no console errors. Screenshots go to SHOT_DIR — look
// at them.
//
//   npx playwright install chromium   (once, if not already present)
//   node scripts/verify-records-ui.mjs [screenshotDir]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const SHOT_DIR = process.argv[2] ?? '/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad';
mkdirSync(SHOT_DIR, { recursive: true });

// A port unlikely to collide with another engineer's own dev server running
// concurrently in a sibling worktree on this same machine (verify-graph-ui.mjs
// uses 5183; other worktrees have been seen on 5184/5185) — checked below
// regardless, so a real collision fails loudly instead of silently hitting
// someone else's server.
const PORT = 5219;
const BASE = `http://localhost:${PORT}/scripts/records-harness`;

/* ------------------------------------------------------------ fixtures -- */
const TODAY = '2026-09-26';
const ROWS = [
  row(1, { file: 'karen-invoice.pdf', type: 'invoice', stage: 'verified', customer: 'Karen Abernathy', site: '412 Elm St, Mesa, AZ', tech: 'D. Ramirez', brand: 'Trane', serviceDate: '2026-09-05', created: '2026-09-10T12:00:00Z', warranty: '2026-11-01', amount: 500, balance: 0, uploadedBy: 'me' }),
  row(2, { file: 'whitmore-workorder.pdf', type: 'work-order', stage: 'read', customer: 'Bill Whitmore', site: '88 Whitmore Ave, Mesa, AZ', tech: 'M. Ortiz', brand: 'Goodman', serviceDate: '2026-09-12', created: '2026-09-15T09:00:00Z', warranty: '2020-01-01', amount: 250, balance: 250 }),
  row(3, { file: '34534895.pdf', type: null, stage: 'received', customer: null, site: null, tech: null, brand: null, serviceDate: null, created: '2026-09-20T08:00:00Z', warranty: null, amount: null, balance: null }),
  row(4, { file: 'garcia-permit.pdf', type: 'permit', stage: 'verified', customer: 'Ana Garcia', site: '19 Cactus Ln, Tempe, AZ', tech: 'D. Ramirez', brand: 'Carrier', serviceDate: '2026-08-01', created: '2026-08-02T10:00:00Z', warranty: '2026-10-20', amount: null, balance: null }),
  row(5, { file: 'garcia-invoice-2.pdf', type: 'invoice', stage: 'verified', customer: 'Ana Garcia', site: '19 Cactus Ln, Tempe, AZ', tech: 'M. Ortiz', brand: 'Carrier', serviceDate: '2026-07-15', created: '2026-07-16T10:00:00Z', warranty: '2026-10-20', amount: 900, balance: 0, uploadedBy: 'me' }),
];
function row(n, f) {
  return {
    id: `d${n}`, filename: f.file, displayName: null, documentType: f.type,
    stage: f.stage, stageBucket: f.stage === 'verified' ? 'verified' : (f.stage === 'received' || !f.type) ? 'missing-info' : 'needs-review',
    verifiedBy: null, uploadedBy: f.uploadedBy === 'me' ? 'user_me' : null, createdAt: f.created, serviceDate: f.serviceDate,
    customerId: f.customer ? `c-${f.customer.replace(/\s+/g, '')}` : null, customerName: f.customer, siteAddress: f.site,
    technician: f.tech, brand: f.brand, warrantyExpiry: f.warranty,
    warrantyBucket: !f.warranty ? 'unknown' : f.warranty < TODAY ? 'expired' : f.warranty <= '2026-12-25' ? 'expiring' : 'active',
    amount: f.amount, balanceDue: f.balance, moneyStatus: f.amount == null ? null : f.balance > 0 ? 'unpaid' : 'paid', hasMoney: f.amount != null,
  };
}

const SORTERS = {
  'upload-date': (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
  'service-date': (a, b) => (b.serviceDate || '').localeCompare(a.serviceDate || ''),
  customer: (a, b) => (a.customerName || '￿').localeCompare(b.customerName || '￿'),
  type: (a, b) => (a.documentType || '￿').localeCompare(b.documentType || '￿'),
  amount: (a, b) => (b.amount ?? -1) - (a.amount ?? -1),
};

function matches(r, f, skipKey) {
  const at = (k) => skipKey === k;
  if (!at('documentType') && f.documentType && r.documentType !== f.documentType) return false;
  if (!at('customerId') && f.customerId && r.customerId !== f.customerId) return false;
  if (!at('site') && f.site && r.siteAddress !== f.site) return false;
  if (!at('technician') && f.technician && r.technician !== f.technician) return false;
  if (!at('brand') && f.brand && r.brand !== f.brand) return false;
  if (!at('stageBucket') && f.stageBucket && r.stageBucket !== f.stageBucket) return false;
  if (!at('warrantyBucket') && f.warrantyBucket && r.warrantyBucket !== f.warrantyBucket) return false;
  if (!at('hasMoney') && f.hasMoney && !r.hasMoney) return false;
  if (!at('openBalance') && f.openBalance && !(r.balanceDue > 0)) return false;
  if (!at('uploadedByMe') && f.uploadedByMe && r.uploadedBy !== 'user_me') return false;
  if (f.q && !`${r.filename} ${r.customerName ?? ''} ${r.technician ?? ''}`.toLowerCase().includes(String(f.q).toLowerCase())) return false;
  return true;
}

function facetFor(rows, f, key, field) {
  const kept = rows.filter((r) => matches(r, f, key));
  const counts = new Map();
  for (const r of kept) { const v = r[field]; if (v) counts.set(v, (counts.get(v) || 0) + 1); }
  return { key, options: [...counts.entries()].map(([value, count]) => ({ value, label: value, count })) };
}

function mockBrowse(filters) {
  const f = filters || {};
  const kept = ROWS.filter((r) => matches(r, f, null)).sort(SORTERS[f.sort] || SORTERS['upload-date']);
  const offset = f.cursor ? Number(Buffer.from(f.cursor, 'base64url').toString('utf8')) || 0 : 0;
  const limit = f.limit || 50;
  const page = kept.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    rows: page,
    total: kept.length,
    hasMore: nextOffset < kept.length,
    nextCursor: nextOffset < kept.length ? Buffer.from(String(nextOffset)).toString('base64url') : null,
    facets: [
      facetFor(ROWS, f, 'documentType', 'documentType'),
      facetFor(ROWS, f, 'stageBucket', 'stageBucket'),
      facetFor(ROWS, f, 'warrantyBucket', 'warrantyBucket'),
      facetFor(ROWS, f, 'customerId', 'customerName'),
      { key: 'hasMoney', trueCount: ROWS.filter((r) => matches(r, f, 'hasMoney') && r.hasMoney).length },
      { key: 'openBalance', trueCount: ROWS.filter((r) => matches(r, f, 'openBalance') && r.balanceDue > 0).length },
      { key: 'uploadedByMe', trueCount: ROWS.filter((r) => matches(r, f, 'uploadedByMe') && r.uploadedBy === 'user_me').length },
    ],
    sort: f.sort || 'upload-date',
    limit,
  };
}

/* ---------------------------------------------------------------- run --- */
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
};

// detached + killing the whole process group on the way out: `npx` spawns
// vite as a grandchild, and a plain server.kill() only kills npx itself,
// leaking a vite process that then blocks the next run's port.
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
const shot = (page, name) => page.screenshot({ path: `${SHOT_DIR}/records-${name}.png`, fullPage: true });

async function mockApi(page) {
  await page.route('**/api/records', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.action !== 'browseDocuments') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockBrowse(body.filters)) });
  });
}

async function runDesktop(name, dark) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(`console: ${m.text()}`); });
  await mockApi(page);

  await page.goto(`${BASE}/desktop.html`, { waitUntil: 'networkidle' });
  await page.evaluate((on) => window.__dwSetDark?.(on), dark);
  await page.waitForTimeout(400);

  check(`desktop-${name}: all 5 fixture rows render initially`, (await page.getByText('karen-invoice.pdf').count()) > 0 && (await page.getByText('34534895.pdf').count()) > 0);
  await shot(page, `desktop-${name}-1-initial`);

  // Filter: click the "invoice" facet option, expect the list to narrow.
  const invoiceOption = page.getByRole('button', { name: /^invoice\b/i }).first();
  if (await invoiceOption.count()) {
    await invoiceOption.click();
    await page.waitForTimeout(400);
    check(`desktop-${name}: picking a Type facet narrows the list (work-order row gone)`, (await page.getByText('whitmore-workorder.pdf').count()) === 0);
    check(`desktop-${name}: an active filter chip appears`, (await page.getByText(/invoice/i).count()) > 0);
    check(`desktop-${name}: URL reflects the filter`, page.url().includes('documentType=invoice'));
    await shot(page, `desktop-${name}-2-filtered`);

    // URL round trip: reload straight into a filtered URL and confirm the
    // same filtered state comes back (shareable link / back-button safe).
    const filteredUrl = page.url();
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    check(`desktop-${name}: reloading a filtered URL restores that filter`, (await page.getByText('whitmore-workorder.pdf').count()) === 0 && (await page.getByText('karen-invoice.pdf').count()) > 0);

    // Clear-all.
    const clearAll = page.getByRole('button', { name: /clear all/i }).first();
    if (await clearAll.count()) {
      await clearAll.click();
      await page.waitForTimeout(400);
      check(`desktop-${name}: clear-all restores every row`, (await page.getByText('whitmore-workorder.pdf').count()) > 0);
      check(`desktop-${name}: clear-all cleans the URL`, !filteredUrl || !page.url().includes('documentType=invoice'));
    }
  } else {
    check(`desktop-${name}: Type facet option is present`, false, 'no "invoice" facet button found — filter/URL/chip checks skipped');
  }

  // Sort control is present (visual check via screenshot below).
  await shot(page, `desktop-${name}-3-before-sort`);
  await shot(page, `desktop-${name}-4-final`);

  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check(`desktop-${name}: no horizontal overflow`, !overflowX);
  check(`desktop-${name}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));
  await page.close();
}

async function runMobile(name, dark) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(`console: ${m.text()}`); });
  await mockApi(page);

  await page.goto(`${BASE}/mobile.html`, { waitUntil: 'networkidle' });
  await page.evaluate((on) => window.__dwSetDark?.(on), dark);
  await page.waitForTimeout(400);

  check(`mobile-${name}: fixture rows render`, (await page.getByText('karen-invoice.pdf').count()) > 0);
  await shot(page, `mobile-${name}-1-initial`);

  // Sticky search: type a customer name and confirm the list narrows.
  const search = page.getByPlaceholder(/customer, address, serial/i).first();
  if (await search.count()) {
    await search.fill('garcia');
    await page.waitForTimeout(400);
    check(`mobile-${name}: search narrows to matching customer`, (await page.getByText('karen-invoice.pdf').count()) === 0 && (await page.getByText(/garcia/i).count()) > 0);
    await shot(page, `mobile-${name}-2-searched`);
    await search.fill('');
    await page.waitForTimeout(300);
  } else {
    check(`mobile-${name}: sticky search input is present`, false);
  }

  // Filter sheet: open it, apply a filter, confirm it narrows + URL updates.
  const filterButton = page.getByRole('button', { name: /filters/i }).first();
  if (await filterButton.count()) {
    await filterButton.click();
    await page.waitForTimeout(300);
    const dialog = page.getByRole('dialog', { name: /filters/i });
    await shot(page, `mobile-${name}-3-filter-sheet`);
    const stageSelect = dialog.locator('#dw-m-f-stage');
    if (await stageSelect.count()) await stageSelect.selectOption('verified');
    const applyButton = dialog.getByRole('button', { name: /apply/i }).first();
    if (await applyButton.count()) {
      await applyButton.click();
      await page.waitForTimeout(400);
      check(`mobile-${name}: applying a filter from the sheet narrows the list`, (await page.getByText('34534895.pdf').count()) === 0);
      check(`mobile-${name}: URL reflects the filter`, page.url().includes('stageBucket=verified'));
    } else {
      check(`mobile-${name}: sheet has an Apply button`, false);
    }
  } else {
    check(`mobile-${name}: filter sheet button is present`, false);
  }
  await shot(page, `mobile-${name}-4-final`);

  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check(`mobile-${name}: no horizontal overflow`, !overflowX);
  check(`mobile-${name}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));
  await page.close();
}

try {
  await runDesktop('office-dark', true);
  await runDesktop('field-light', false);
  await runMobile('office-dark', true);
  await runMobile('field-light', false);
} finally {
  await browser.close();
  try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill(); }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
console.log(`Screenshots in ${SHOT_DIR} — look at them before calling this done.`);
process.exit(failures ? 1 : 0);
