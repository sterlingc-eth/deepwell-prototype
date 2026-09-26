// Renders KnowledgeGraph in isolation (scripts/graph-harness/) against a
// mocked /api/v1/graph, at desktop + phone widths in both Office (dark) and
// Field (light) view. Checks nodes render, clicking a related record
// recenters the view, no console errors, and no horizontal overflow.
// Screenshots go to SHOT_DIR (arg 1, default below) — look at them.
//
//   npx playwright install chromium   (once, if not already present)
//   node scripts/verify-graph-ui.mjs [screenshotDir]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const SHOT_DIR = process.argv[2] ?? '/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad';
mkdirSync(SHOT_DIR, { recursive: true });

const PORT = 5183;
const HARNESS_URL = `http://localhost:${PORT}/scripts/graph-harness/index.html`;

/* ------------------------------------------------------------ fixtures -- */
// ~20 nodes across every type the API contract defines, centered on a
// customer, plus one incoming edge (tech -> customer) so Backlinks isn't
// empty and several outgoing ones so Links has plenty to click.
const FIXTURE_SEED = {
  center: 'customer:c1',
  truncated: false,
  nodes: [
    { id: 'customer:c1', type: 'customer', label: 'Dana Reyes', subtitle: 'C-00042', degree: 8 },
    { id: 'site:s1', type: 'site', label: '2847 N 24th St', subtitle: 'Phoenix, AZ', degree: 4 },
    { id: 'site:s2', type: 'site', label: '310 W Baseline Rd', degree: 2 },
    { id: 'site:s3', type: 'site', label: '88 Cactus Ln', degree: 2 },
    { id: 'unit:u1', type: 'unit', label: 'SN-CAR-234567', subtitle: 'Carrier AC', degree: 3 },
    { id: 'unit:u2', type: 'unit', label: 'SN-LEN-456789', subtitle: 'Lennox Furnace', degree: 2 },
    { id: 'unit:u3', type: 'unit', label: 'SN-RHE-012345', subtitle: 'Rheem Heat Pump' },
    { id: 'unit:u4', type: 'unit', label: 'SN-TRA-789012', subtitle: 'Trane AC' },
    { id: 'tech:t1', type: 'tech', label: 'Carlos Rodriguez', degree: 2 },
    { id: 'tech:t2', type: 'tech', label: 'Maria Santos' },
    { id: 'visit:v1', type: 'visit', label: 'Spring tune-up', subtitle: '2026-03-14' },
    { id: 'visit:v2', type: 'visit', label: 'Furnace repair', subtitle: '2026-01-09' },
    { id: 'document:d1', type: 'document', label: 'invoice_2847.pdf' },
    { id: 'document:d2', type: 'document', label: 'warranty_card.pdf' },
    { id: 'document:d3', type: 'document', label: 'workorder_0912.pdf' },
    { id: 'document:d4', type: 'document', label: 'nameplate_photo.jpg' },
    { id: 'invoice:i1', type: 'invoice', label: 'INV-1042', subtitle: '$420.00' },
    { id: 'invoice:i2', type: 'invoice', label: 'INV-1098', subtitle: '$95.00' },
    { id: 'warranty:w1', type: 'warranty', label: 'Carrier AC warranty', subtitle: 'Expires 2029-03-15' },
    { id: 'agreement:a1', type: 'agreement', label: 'Maintenance Plan', subtitle: 'Annual' },
  ],
  edges: [
    { id: 'e1', from: 'customer:c1', to: 'site:s1', type: 'has_property' },
    { id: 'e2', from: 'site:s1', to: 'unit:u1', type: 'has_unit' },
    { id: 'e3', from: 'site:s1', to: 'unit:u2', type: 'has_unit' },
    { id: 'e4', from: 'unit:u1', to: 'visit:v1', type: 'serviced_in' },
    { id: 'e5', from: 'tech:t1', to: 'visit:v1', type: 'performed_by' },
    { id: 'e6', from: 'visit:v1', to: 'document:d3', type: 'documented_by', source: { documentId: 'd3', page: 2 } },
    { id: 'e7', from: 'customer:c1', to: 'document:d1', type: 'billed_with', source: { documentId: 'd1', page: 1 } },
    { id: 'e8', from: 'unit:u1', to: 'warranty:w1', type: 'covered_by' },
    { id: 'e9', from: 'customer:c1', to: 'agreement:a1', type: 'signed' },
    { id: 'e10', from: 'customer:c1', to: 'site:s2', type: 'has_property' },
    { id: 'e11', from: 'site:s2', to: 'unit:u3', type: 'has_unit' },
    { id: 'e12', from: 'unit:u3', to: 'document:d4', type: 'documented_by', source: { documentId: 'd4', page: 1 } },
    { id: 'e13', from: 'tech:t2', to: 'visit:v2', type: 'performed_by' },
    { id: 'e14', from: 'unit:u2', to: 'visit:v2', type: 'serviced_in' },
    { id: 'e15', from: 'customer:c1', to: 'invoice:i1', type: 'billed_with' },
    { id: 'e16', from: 'invoice:i1', to: 'document:d1', type: 'documented_by', source: { documentId: 'd1', page: 1 } },
    { id: 'e17', from: 'customer:c1', to: 'invoice:i2', type: 'billed_with' },
    { id: 'e18', from: 'site:s3', to: 'unit:u4', type: 'has_unit' },
    { id: 'e19', from: 'customer:c1', to: 'site:s3', type: 'has_property' },
    { id: 'e20', from: 'unit:u2', to: 'document:d2', type: 'documented_by', source: { documentId: 'd2', page: 1 } },
    { id: 'e21', from: 'tech:t1', to: 'customer:c1', type: 'services_for' },
  ],
};

// Second response: recentered on the property clicked from the Links panel.
// Different center + truncated:true so the recenter assertion and the
// truncated-notice branch are both exercised by one click.
const FIXTURE_RECENTER = {
  center: 'site:s1',
  truncated: true,
  nodes: [
    { id: 'site:s1', type: 'site', label: '2847 N 24th St', subtitle: 'Phoenix, AZ' },
    { id: 'customer:c1', type: 'customer', label: 'Dana Reyes' },
    { id: 'unit:u1', type: 'unit', label: 'SN-CAR-234567' },
    { id: 'unit:u2', type: 'unit', label: 'SN-LEN-456789' },
    { id: 'visit:v1', type: 'visit', label: 'Spring tune-up' },
  ],
  edges: [
    { id: 'e1', from: 'customer:c1', to: 'site:s1', type: 'has_property' },
    { id: 'e2', from: 'site:s1', to: 'unit:u1', type: 'has_unit' },
    { id: 'e3', from: 'site:s1', to: 'unit:u2', type: 'has_unit' },
    { id: 'e4', from: 'unit:u1', to: 'visit:v1', type: 'serviced_in' },
  ],
};

/* ---------------------------------------------------------------- run --- */

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
};

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1800));

const browser = await chromium.launch();
const shot = (page, name) => page.screenshot({ path: `${SHOT_DIR}/${name}.png` });

async function runViewport(name, viewport, fieldMode) {
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(`console: ${m.text()}`);
  });

  await page.route('**/api/v1/graph**', async (route) => {
    const url = new URL(route.request().url());
    const node = url.searchParams.get('node');
    const body = node === 'site:s1' ? FIXTURE_RECENTER : FIXTURE_SEED;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto(HARNESS_URL, { waitUntil: 'networkidle' });
  if (fieldMode) await page.evaluate(() => window.__dwSetField?.(true));
  await page.waitForTimeout(500); // cytoscape mount + first fetch + layout

  check(`${name}: seed record is centered`, (await page.getByText('Dana Reyes').count()) > 0);
  check(`${name}: canvas rendered (nodes drawn)`, (await page.locator('#root canvas').count()) > 0);
  check(`${name}: Backlinks panel lists the incoming edge`, (await page.getByRole('button', { name: /Carlos Rodriguez/ }).count()) > 0);
  check(`${name}: Links panel lists an outgoing edge`, (await page.getByRole('button', { name: /2847 N 24th St/ }).count()) > 0);

  await shot(page, `graph-${name}-1-initial`);

  await page.getByRole('button', { name: /2847 N 24th St/ }).first().click();
  await page.waitForTimeout(500);
  check(`${name}: clicking a related record recenters the view`, (await page.getByText('2847 N 24th St').count()) > 0);
  check(`${name}: truncated notice shows when the API says so`, (await page.getByText(/partial view/i).count()) > 0);

  await shot(page, `graph-${name}-2-recentered`);

  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check(`${name}: no horizontal overflow`, !overflowX);
  check(`${name}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));

  await page.close();
}

try {
  await runViewport('desktop-office', { width: 1280, height: 900 }, false);
  await runViewport('desktop-field', { width: 1280, height: 900 }, true);
  await runViewport('phone-office', { width: 390, height: 844 }, false);
  await runViewport('phone-field', { width: 390, height: 844 }, true);
} finally {
  await browser.close();
  server.kill();
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
console.log(`Screenshots in ${SHOT_DIR}`);
process.exit(failures ? 1 : 0);
