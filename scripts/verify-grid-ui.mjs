// Grid view UI (round 13, H3): GridView rendered alone (scripts/grid-harness/)
// against a mocked /api/records (Documents row type reuses useRecordsBrowse)
// and /api/account?action=grid (documentCells + units ops), at 390px and
// 1280px, in both Office (dark) and Field (light) theme. Checks: rows +
// columns render for both row types, column picker toggles a column, sort
// reorders, a cell's source popover shows a document id, CSV export button
// is present and enabled, no horizontal page overflow (the grid's own
// overflow-x-auto container is allowed to scroll internally), no console
// errors. Screenshots go to SHOT_DIR — look at them.
//
//   npx playwright install chromium   (once, if not already present)
//   node scripts/verify-grid-ui.mjs [screenshotDir]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const SHOT_DIR = process.argv[2] ?? '/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad';
mkdirSync(SHOT_DIR, { recursive: true });

// Dedicated port distinct from every other engineer's harness server
// (records-ui: 5219, graph-ui: 5183) so a real collision fails loudly
// instead of silently hitting someone else's dev server.
const PORT = 5246;
const BASE = `http://localhost:${PORT}/scripts/grid-harness`;

/* ------------------------------------------------------------ fixtures -- */
const DOC_ROWS = [
  { id: 'd00000000-0000-0000-0000-000000000001', filename: 'karen-invoice.pdf', displayName: null, documentType: 'invoice', stage: 'verified', stageBucket: 'verified', verifiedBy: null, uploadedBy: null, createdAt: '2026-09-10T12:00:00Z', serviceDate: '2026-09-05', customerId: 'c-karen', customerName: 'Karen Abernathy', siteAddress: '412 Elm St, Mesa, AZ', technician: 'D. Ramirez', brand: 'Trane', warrantyExpiry: '2026-11-01', warrantyBucket: 'active', amount: 500, balanceDue: 0, moneyStatus: 'paid', hasMoney: true },
  { id: 'd00000000-0000-0000-0000-000000000002', filename: 'whitmore-workorder.pdf', displayName: null, documentType: 'work-order', stage: 'read', stageBucket: 'needs-review', verifiedBy: null, uploadedBy: null, createdAt: '2026-09-15T09:00:00Z', serviceDate: '2026-09-12', customerId: 'c-whitmore', customerName: 'Bill Whitmore', siteAddress: '88 Whitmore Ave, Mesa, AZ', technician: 'M. Ortiz', brand: 'Goodman', warrantyExpiry: '2020-01-01', warrantyBucket: 'expired', amount: 250, balanceDue: 250, moneyStatus: 'unpaid', hasMoney: true },
  { id: 'd00000000-0000-0000-0000-000000000003', filename: 'garcia-permit.pdf', displayName: 'Garcia Permit', documentType: 'permit', stage: 'verified', stageBucket: 'verified', verifiedBy: null, uploadedBy: null, createdAt: '2026-08-02T10:00:00Z', serviceDate: '2026-08-01', customerId: 'c-garcia', customerName: 'Ana Garcia', siteAddress: '19 Cactus Ln, Tempe, AZ', technician: 'D. Ramirez', brand: 'Carrier', warrantyExpiry: '2026-10-20', warrantyBucket: 'active', amount: null, balanceDue: null, moneyStatus: null, hasMoney: false },
];

function mockBrowse(filters) {
  const f = filters || {};
  const kept = DOC_ROWS.filter((r) => !f.documentType || r.documentType === f.documentType);
  return {
    rows: kept, total: kept.length, hasMore: false, nextCursor: null,
    facets: [], sort: f.sort || 'upload-date', limit: f.limit || 50,
  };
}

const UNIT_ROWS = [
  { id: 'u1', cells: {
    serial: { value: 'SN-100', sources: [{ documentId: DOC_ROWS[0].id }] },
    model: { value: 'XR16', sources: [{ documentId: DOC_ROWS[0].id, page: 2 }] },
    manufacturer: { value: 'Trane', sources: [{ documentId: DOC_ROWS[0].id }] },
    equipmentType: { value: 'condenser', sources: [{ documentId: DOC_ROWS[0].id }] },
    customerName: { value: 'Karen Abernathy', sources: [{ documentId: DOC_ROWS[0].id }] },
    siteAddress: { value: '412 Elm St, Mesa, AZ', sources: [{ documentId: DOC_ROWS[0].id }] },
    warrantyStatus: { value: 'active', sources: [{ documentId: DOC_ROWS[0].id }] },
    warrantyExpiry: { value: '2026-11-01', sources: [{ documentId: DOC_ROWS[0].id }] },
    lastService: { value: '2026-09-05', sources: [{ documentId: DOC_ROWS[0].id }] },
    technician: { value: 'D. Ramirez', sources: [{ documentId: DOC_ROWS[0].id }] },
    balance: { value: 0, sources: [] },
    openQuestions: { value: 0, sources: [] },
  } },
  { id: 'u2', cells: {
    serial: { value: 'SN-200', sources: [{ documentId: DOC_ROWS[1].id }] },
    model: { value: 'GSX16', sources: [{ documentId: DOC_ROWS[1].id }] },
    manufacturer: { value: 'Goodman', sources: [{ documentId: DOC_ROWS[1].id }] },
    equipmentType: { value: 'condenser', sources: [{ documentId: DOC_ROWS[1].id }] },
    customerName: { value: 'Bill Whitmore', sources: [{ documentId: DOC_ROWS[1].id }] },
    siteAddress: { value: '88 Whitmore Ave, Mesa, AZ', sources: [{ documentId: DOC_ROWS[1].id }] },
    warrantyStatus: { value: 'expired', sources: [{ documentId: DOC_ROWS[1].id }] },
    warrantyExpiry: { value: '2020-01-01', sources: [{ documentId: DOC_ROWS[1].id }] },
    lastService: { value: '2026-09-12', sources: [{ documentId: DOC_ROWS[1].id }] },
    technician: { value: 'M. Ortiz', sources: [{ documentId: DOC_ROWS[1].id }] },
    balance: { value: 250, sources: [{ documentId: DOC_ROWS[1].id }] },
    openQuestions: { value: 1, sources: [] },
  } },
];

function mockUnits(body) {
  const q = (body.filters?.q || '').toLowerCase();
  const kept = q ? UNIT_ROWS.filter((r) => JSON.stringify(r.cells).toLowerCase().includes(q)) : UNIT_ROWS;
  return { rowType: 'units', columns: body.columns, rows: kept, total: kept.length, hasMore: false, nextCursor: null };
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
const shot = (page, name) => page.screenshot({ path: `${SHOT_DIR}/grid-${name}.png`, fullPage: true });

async function mockApi(page) {
  await page.route('**/api/records', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.action !== 'browseDocuments') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockBrowse(body.filters)) });
  });
  await page.route('**/api/account?action=grid', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.op === 'documentCells') {
      const cells = {};
      for (const id of body.documentIds) {
        cells[id] = {};
        for (const col of body.columns) {
          if (col === 'model') cells[id][col] = { value: 'XR16', sources: [{ documentId: id, page: 2 }] };
          else if (col === 'serial') cells[id][col] = { value: 'SN-100', sources: [{ documentId: id }] };
          else if (col === 'agreement') cells[id][col] = { value: null, sources: [] };
        }
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rowType: 'documents', cells }) });
    }
    if (body.op === 'units') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockUnits(body)) });
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'unknown op' }) });
  });
}

async function run(name, dark, width) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(`console: ${m.text()}`); });
  await mockApi(page);

  await page.goto(`${BASE}/desktop.html`, { waitUntil: 'networkidle' });
  await page.evaluate((on) => window.__dwSetDark?.(on), dark);
  await page.waitForTimeout(400);

  // Documents row type (default tab).
  check(`${name}: documents grid shows fixture rows`, (await page.getByText('karen-invoice.pdf').count()) > 0 || (await page.getByText('Garcia Permit').count()) > 0);
  await shot(page, `${name}-${width}-1-documents`);

  // Column picker: open it, turn on "Model" (a computed, non-default column —
  // proves documentCells wiring), toggle "Amount" off, confirm both take effect.
  const colBtn = page.getByRole('button', { name: /columns \(/i }).first();
  if (await colBtn.count()) {
    await colBtn.click();
    await page.waitForTimeout(200);
    const modelLabel = page.locator('label', { hasText: 'Model' }).first();
    if (await modelLabel.count()) {
      await modelLabel.locator('input[type=checkbox]').click();
      await page.waitForTimeout(400);
      check(`${name}: a computed column (Model) resolved via documentCells`, (await page.getByText('XR16').count()) > 0);
    } else {
      check(`${name}: column picker lists Model`, false);
    }
    const amountLabel = page.locator('label', { hasText: 'Amount' }).first();
    if (await amountLabel.count()) {
      await amountLabel.locator('input[type=checkbox]').click();
      await page.waitForTimeout(200);
      check(`${name}: unchecking a column removes it from the header`, (await page.getByRole('columnheader', { name: 'Amount' }).count()) === 0);
    } else {
      check(`${name}: column picker lists Amount`, false);
    }
    await page.mouse.click(10, 10);
  } else {
    check(`${name}: column picker button is present`, false);
  }
  await shot(page, `${name}-${width}-2-columns`);

  // Sort: click a sortable header, expect aria-sort to flip to ascending.
  const nameHeader = page.getByRole('columnheader', { name: /^name$/i }).first();
  if (await nameHeader.count()) {
    await nameHeader.click();
    await page.waitForTimeout(200);
    check(`${name}: clicking a header sorts it (aria-sort set)`, (await nameHeader.getAttribute('aria-sort')) === 'ascending');
  } else {
    check(`${name}: Name column header is present`, false);
  }

  // Source popover: open a cell's source list, confirm a document id shows.
  const sourceBtn = page.getByRole('button', { name: /show source for model/i }).first();
  if (await sourceBtn.count()) {
    await sourceBtn.click();
    await page.waitForTimeout(200);
    check(`${name}: cell source popover shows a document id + page`, (await page.getByText(/p\.2/).count()) > 0);
    await shot(page, `${name}-${width}-3-source-popover`);
    await page.mouse.click(10, 10);
  } else {
    check(`${name}: a cell with sources exposes a "show source" control`, false);
  }

  // CSV export button present and enabled once rows are loaded.
  const exportBtn = page.getByRole('button', { name: /export csv/i }).first();
  check(`${name}: CSV export button present`, (await exportBtn.count()) > 0);
  if (await exportBtn.count()) check(`${name}: CSV export enabled with rows loaded`, await exportBtn.isEnabled());

  // Switch to Units row type.
  const unitsTab = page.getByRole('tab', { name: /^units$/i }).first();
  if (await unitsTab.count()) {
    await unitsTab.click();
    await page.waitForTimeout(400);
    check(`${name}: units grid shows fixture rows`, (await page.getByText('SN-100').count()) > 0 && (await page.getByText('SN-200').count()) > 0);
    await shot(page, `${name}-${width}-4-units`);

    const search = page.getByPlaceholder(/filter by model or serial/i).first();
    if (await search.count()) {
      await search.fill('SN-200');
      await page.waitForTimeout(400);
      check(`${name}: units search narrows the list`, (await page.getByText('SN-100').count()) === 0 && (await page.getByText('SN-200').count()) > 0);
    } else {
      check(`${name}: units search input present`, false);
    }
    await shot(page, `${name}-${width}-5-units-filtered`);
  } else {
    check(`${name}: Units tab is present`, false);
  }

  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check(`${name}: no horizontal page overflow (grid's own overflow-x-auto is fine)`, !overflowX);
  check(`${name}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));
  await page.close();
}

try {
  await run('office-dark-1280', true, 1280);
  await run('field-light-1280', false, 1280);
  await run('office-dark-390', true, 390);
  await run('field-light-390', false, 390);
} finally {
  await browser.close();
  try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill(); }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
console.log(`Screenshots in ${SHOT_DIR} — look at them before calling this done.`);
process.exit(failures ? 1 : 0);
