#!/usr/bin/env node
/**
 * Startup performance measurement (handoffs/STARTUP_PERF_R13.md).
 *
 * Builds the real /app/ entry twice — once from a "before" ref (default:
 * the r13-int merge base this round branched from) and once from this
 * working tree ("after") — with '@clerk/clerk-react' aliased to a small
 * mock (scripts/perf/mockClerk.tsx) so the REAL App.tsx / AskScreen /
 * usePostgresSync / useBootstrap code runs completely unmodified against
 * mocked network, instead of a real Clerk session this offline test cannot
 * reach (no real network / no real Clerk or Neon — see R11_RULES.md).
 *
 * Each build is served locally and driven with Playwright, with every
 * /api/** call intercepted and answered after a realistic delay (500ms
 * each, plus an extra 1.5s on the very first request of the run — a cold
 * Vercel function + a Neon compute waking from scale-to-zero). Three
 * milestones are timed from navigation start:
 *   - shell     : <header> (AppShell) is in the DOM
 *   - ask       : the Ask screen's <textarea> is in the DOM (interactive)
 *   - all-data  : the network settles (no in-flight /api/** requests for
 *                 500ms straight) — everything the app fetched has landed
 *
 * Caveats, reported alongside the numbers, not hidden:
 *   - Building only the /app/ entry (not site+app+mobile+expenses together,
 *     as the real `npm run build` does) changes Rollup's cross-entry chunk
 *     splitting, so bundle SIZES from this harness are not the real ones —
 *     this script reports its own harness sizes separately from the real
 *     `npm run build` sizes quoted in the round's final report.
 *   - `getToken`/session details are mocked; this measures render/network
 *     TIMING, not auth correctness (that's what verify:auth is for).
 *
 * Usage: node scripts/perf/startup.mjs [--before <ref>] [--skip-build]
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const BEFORE_REF = flag('--before', 'r13-int');
const SKIP_BUILD = args.includes('--skip-build');

const BASE_LATENCY_MS = 500;
const COLD_EXTRA_MS = 1500;
const SETTLE_MS = 500; // "network idle" window for the all-data milestone

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

/* --------------------------------------------------------------- build -- */

function run(cmd, cmdArgs, cwd, env = {}) {
  execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
}

/** Builds the /app/ perf harness bundle for a given worktree dir into <dir>/dist-perf. */
function buildHarness(dir) {
  run('npx', ['vite', 'build', '--config', 'scripts/perf/vite.perf.config.mjs'], dir, {
    VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_dummy',
  });
}

/** Checks out `ref` into a fresh detached worktree and copies this tree's
 *  perf harness files into it (they're test infra, not product code, so a
 *  historical ref won't have them yet). Returns the worktree path. */
async function prepareBeforeWorktree(ref) {
  const dir = await mkdtemp(join(tmpdir(), 'dw-perf-before-'));
  await rm(dir, { recursive: true, force: true }); // mkdtemp made it; worktree add wants to create it itself
  const sha = execFileSync('git', ['rev-parse', ref], { cwd: REPO_ROOT }).toString().trim();
  run('git', ['worktree', 'add', '--detach', dir, sha], REPO_ROOT);
  run('cp', ['-r', join(REPO_ROOT, 'scripts', 'perf'), join(dir, 'scripts', 'perf')], REPO_ROOT);
  const nodeModules = join(dir, 'node_modules');
  if (!existsSync(nodeModules)) run('ln', ['-s', join(REPO_ROOT, 'node_modules'), nodeModules], REPO_ROOT);
  return dir;
}

/* --------------------------------------------------------------- serve -- */

function serveDist(distDir) {
  const server = createServer(async (req, res) => {
    try {
      let p = req.url.split('?')[0];
      if (p === '/' || p === '') p = '/app/index.html';
      let filePath = join(distDir, p);
      if (!existsSync(filePath)) filePath = join(distDir, 'app', 'index.html'); // SPA fallback
      const data = await readFile(filePath);
      res.setHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream');
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  return new Promise((resolvePort) => {
    server.listen(0, '127.0.0.1', () => resolvePort({ server, port: server.address().port }));
  });
}

/* ----------------------------------------------------------- API mocks -- */

const NOW_ISO = new Date().toISOString();

const BILLING_STATUS = {
  plan: 'shop',
  status: 'active',
  trialEndsAt: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  limits: { technicians: 4, documentsStored: 100000, pagesPerMonth: 2000, asksPerMonth: 9000 },
  usage: { documentsStored: 412, pagesThisMonth: 88, asksThisMonth: 61, resetsOn: NOW_ISO.slice(0, 10) },
};

function documentRow(i) {
  return {
    id: `doc-${i}`,
    batch_id: 'synced',
    original_filename: `service-ticket-${i}.pdf`,
    document_type: 'service-ticket',
    stage: 'linked',
    created_at: NOW_ISO,
    content_type: 'application/pdf',
    page_count: 2,
    extract_error: null,
    verified_by: null,
    verified_at: null,
    display_name: `Service ticket ${i}`,
    uploaded_by: 'perf-user',
  };
}
const RECORD_ROWS = Array.from({ length: 20 }, (_, i) => documentRow(i));

function actionOf(url, postData) {
  const u = new URL(url);
  if (u.searchParams.get('action')) return u.searchParams.get('action');
  try {
    const body = postData ? JSON.parse(postData) : {};
    return body.action ?? null;
  } catch {
    return null;
  }
}

function bodyFor(pathname, action) {
  if (pathname === '/api/records') {
    if (action === 'bootstrap') {
      return {
        billing: BILLING_STATUS,
        notifications: { items: [], unreadCount: 2 },
        records: { rows: RECORD_ROWS.slice(0, 20), total: RECORD_ROWS.length },
      };
    }
    if (action === 'listDocuments') return RECORD_ROWS;
    if (action === 'listEntities') return [];
    if (action === 'listExtractionsByDocuments') return [];
    return {};
  }
  if (pathname === '/api/review') {
    if (action === 'listLinks') return { links: [] };
    if (action === 'listCorrections') return { corrections: [] };
    if (action === 'integrityFix') return { documentsLinked: [], equipmentLinked: [] };
    return {};
  }
  if (pathname === '/api/document-status') return { documents: [] };
  if (pathname === '/api/billing') return BILLING_STATUS;
  if (pathname === '/api/account') return { items: [], unreadCount: 2, emailDigest: true };
  return {};
}

/** Installs the mocked network + returns a function reporting ms-since-t0
 *  of the last response to settle (used for the all-data milestone). */
function installApiMocks(page, t0) {
  let firstSeen = false;
  let lastResponseAt = 0;
  page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const action = actionOf(req.url(), req.postData());
    const delay = BASE_LATENCY_MS + (!firstSeen ? COLD_EXTRA_MS : 0);
    firstSeen = true;
    await new Promise((r) => setTimeout(r, delay));
    const body = bodyFor(url.pathname, action);
    lastResponseAt = Date.now() - t0;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return () => lastResponseAt;
}

/* ------------------------------------------------------------- measure -- */

async function measure(port, label) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__PERF_CLERK_INIT_MS = 850; // matches the round's own warm measurement of real Clerk init
  });

  const t0 = Date.now();
  const getLastResponseMs = installApiMocks(page, t0);
  await page.goto(`http://127.0.0.1:${port}/app/index.html`, { waitUntil: 'commit' });

  const since = () => Date.now() - t0;
  let shellMs = null;
  let askMs = null;
  try {
    await page.waitForSelector('header', { timeout: 20000 });
    shellMs = since();
  } catch {
    /* never appeared — reported as null below */
  }
  try {
    await page.waitForSelector('textarea', { timeout: 20000 });
    askMs = since();
  } catch {
    /* never appeared */
  }

  // All-data: wait until nothing has responded for SETTLE_MS, capped so a
  // genuinely stuck run doesn't hang the whole script.
  const deadline = Date.now() + 20000;
  let allDataMs = null;
  while (Date.now() < deadline) {
    const last = getLastResponseMs();
    if (last > 0 && Date.now() - t0 - last >= SETTLE_MS) {
      allDataMs = last;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  await browser.close();
  return { label, shellMs, askMs, allDataMs };
}

/* ---------------------------------------------------------------- main -- */

async function main() {
  console.log(`Startup perf: before=${BEFORE_REF} after=<working tree> (skip-build=${SKIP_BUILD})\n`);

  let beforeDir = REPO_ROOT;
  let cleanupBefore = async () => {};
  if (!SKIP_BUILD) {
    beforeDir = await prepareBeforeWorktree(BEFORE_REF);
    cleanupBefore = async () => {
      try {
        run('git', ['worktree', 'remove', '--force', beforeDir], REPO_ROOT);
      } catch {
        await rm(beforeDir, { recursive: true, force: true });
      }
    };
    console.log(`Building "before" (${BEFORE_REF}) in ${beforeDir} ...`);
    buildHarness(beforeDir);
    console.log('Building "after" (working tree) ...');
    buildHarness(REPO_ROOT);
  }

  const beforeDist = join(beforeDir, 'dist-perf');
  const afterDist = join(REPO_ROOT, 'dist-perf');
  const beforeSrv = await serveDist(beforeDist);
  const afterSrv = await serveDist(afterDist);

  const results = [];
  results.push(await measure(beforeSrv.port, 'before'));
  results.push(await measure(afterSrv.port, 'after'));

  beforeSrv.server.close();
  afterSrv.server.close();
  await cleanupBefore();

  const fmt = (ms) => (ms == null ? 'TIMEOUT' : `${ms}ms`);
  console.log('\n| metric               | before      | after       |');
  console.log('|-----------------------|-------------|-------------|');
  const b = results[0];
  const a = results[1];
  console.log(`| time-to-shell         | ${fmt(b.shellMs).padEnd(11)} | ${fmt(a.shellMs).padEnd(11)} |`);
  console.log(`| time-to-interactive-ask | ${fmt(b.askMs).padEnd(11)} | ${fmt(a.askMs).padEnd(11)} |`);
  console.log(`| time-to-all-data       | ${fmt(b.allDataMs).padEnd(11)} | ${fmt(a.allDataMs).padEnd(11)} |`);
  console.log('\n(measured against mocked APIs: 500ms/call + 1.5s cold on the first request; Clerk init mocked at 850ms)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
