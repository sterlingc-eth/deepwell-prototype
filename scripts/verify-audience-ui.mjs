// Audience filter chip + "Team only" badge (round 18, part 2, owner ask (a)): RecordsBrowser
// (desktop) rendered alone against a mocked /api/records (same harness verify-records-ui.mjs
// already set up — scripts/records-harness/), at 1280px and 390px, in both Office (dark) and
// Field (light) theme. Checks: default view shows only customer documents; the Internal tab
// narrows to internal-only and shows the "Team only" badge; the All tab shows both; the URL
// reflects the choice; no horizontal overflow; no console errors. Screenshots go to SHOT_DIR —
// look at them.
//
//   npx playwright install chromium   (once, if not already present)
//   node scripts/verify-audience-ui.mjs [screenshotDir]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const SHOT_DIR = process.argv[2] ?? '/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad';
mkdirSync(SHOT_DIR, { recursive: true });

// A port unlikely to collide with another engineer's own dev server (see verify-records-ui.mjs's
// own comment on this exact convention).
const PORT = 5231;
const BASE = `http://localhost:${PORT}/scripts/records-harness`;

/* ------------------------------------------------------------ fixtures -- */
function row(n, f) {
  return {
    id: `d${n}`, filename: f.file, displayName: null, documentType: f.type,
    stage: 'verified', stageBucket: 'verified', verifiedBy: null, uploadedBy: null,
    createdAt: f.created, serviceDate: null,
    customerId: f.customer ? `c-${f.customer.replace(/\s+/g, '')}` : null, customerName: f.customer,
    siteAddress: f.site ?? null, technician: f.tech ?? null, brand: null,
    warrantyExpiry: null, warrantyBucket: 'unknown',
    amount: null, balanceDue: null, moneyStatus: null, hasMoney: false,
    audience: f.audience,
  };
}
const ROWS = [
  row(1, { file: 'abernathy-invoice.pdf', type: 'invoice', customer: 'Karen Abernathy', site: '412 Elm St, Mesa, AZ', created: '2026-09-10T12:00:00Z', audience: 'customer' }),
  row(2, { file: 'whitmore-workorder.pdf', type: 'work-order', customer: 'Bill Whitmore', site: '88 Whitmore Ave, Mesa, AZ', created: '2026-09-15T09:00:00Z', audience: 'customer' }),
  row(3, { file: 'all-techs-safety-memo.pdf', type: 'internal', customer: null, site: null, tech: 'D. Ramirez', created: '2026-09-18T08:00:00Z', audience: 'internal' }),
  row(4, { file: 'parts-count-truck4.pdf', type: 'internal', customer: null, site: null, tech: 'M. Ortiz', created: '2026-09-20T08:00:00Z', audience: 'internal' }),
];

function matches(r, f) {
  if (f.audience && f.audience !== 'all' && r.audience !== f.audience) return false;
  return true;
}

function mockBrowse(filters) {
  const f = filters || { audience: 'customer' };
  const kept = ROWS.filter((r) => matches(r, f));
  return {
    rows: kept, total: kept.length, hasMore: false, nextCursor: null,
    facets: [
      { key: 'audience', options: [
        { value: 'customer', label: 'customer', count: ROWS.filter((r) => r.audience === 'customer').length },
        { value: 'internal', label: 'internal', count: ROWS.filter((r) => r.audience === 'internal').length },
      ] },
    ],
    sort: f.sort || 'upload-date', limit: 50,
  };
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
const shot = (page, name) => page.screenshot({ path: `${SHOT_DIR}/audience-${name}.png`, fullPage: true });

async function mockApi(page) {
  await page.route('**/api/records', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.action !== 'browseDocuments') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockBrowse(body.filters)) });
  });
}

async function run(name, viewport, dark) {
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(`console: ${m.text()}`); });
  await mockApi(page);

  await page.goto(`${BASE}/desktop.html`, { waitUntil: 'networkidle' });
  await page.evaluate((on) => window.__dwSetDark?.(on), dark);
  await page.waitForTimeout(400);

  // Default state: 'Customer' selected, only customer rows shown, no "Team only" badge visible.
  check(`${name}: default shows only customer rows`, (await page.getByText('abernathy-invoice.pdf').count()) > 0 && (await page.getByText('all-techs-safety-memo.pdf').count()) === 0);
  check(`${name}: no "Team only" badge in the default (customer) view`, (await page.getByText('Team only').count()) === 0);
  await shot(page, `${name}-1-customer-default`);

  // Internal tab: narrows to internal-only, badge appears.
  const internalTab = page.getByRole('tab', { name: 'Internal' });
  await internalTab.click();
  await page.waitForTimeout(400);
  check(`${name}: Internal tab narrows to internal-only rows`, (await page.getByText('all-techs-safety-memo.pdf').count()) > 0 && (await page.getByText('abernathy-invoice.pdf').count()) === 0);
  check(`${name}: "Team only" badge shown on internal rows`, (await page.getByText('Team only').count()) >= 2);
  check(`${name}: URL reflects audience=internal`, page.url().includes('audience=internal'));
  await shot(page, `${name}-2-internal`);

  // All tab: both kinds shown together.
  const allTab = page.getByRole('tab', { name: 'All' });
  await allTab.click();
  await page.waitForTimeout(400);
  check(`${name}: All tab shows both customer and internal rows`, (await page.getByText('abernathy-invoice.pdf').count()) > 0 && (await page.getByText('all-techs-safety-memo.pdf').count()) > 0);
  check(`${name}: "Team only" badge still shown only on the internal rows`, (await page.getByText('Team only').count()) === 2);
  await shot(page, `${name}-3-all`);

  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check(`${name}: no horizontal overflow`, !overflowX);
  check(`${name}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));
  await page.close();
}

try {
  await run('desktop-office-dark', { width: 1280, height: 900 }, true);
  await run('desktop-field-light', { width: 1280, height: 900 }, false);
  await run('phone-office-dark', { width: 390, height: 844 }, true);
  await run('phone-field-light', { width: 390, height: 844 }, false);
} finally {
  await browser.close();
  try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill(); }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
console.log(`Screenshots in ${SHOT_DIR} — look at them before calling this done.`);
process.exit(failures ? 1 : 0);
