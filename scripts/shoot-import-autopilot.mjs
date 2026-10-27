/**
 * Import autopilot: screenshots of the onboarding summary and the decisions view at 1440 and 390 px, over the REAL Inbox screen (scripts/inbox-harness)
 * with /api/review answered by the REAL server code on a synthetic 5,000-paper import (PGlite). Nothing is sent anywhere.
 *   node scripts/shoot-import-autopilot.mjs <outDir> [papers=5000]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { startPglite } from './lib/pglite-tenant.mjs';
import { buildSynthetic } from './lib/import-synth.mjs';
import { loadSynthetic } from './lib/import-load.mjs';
import { fileAll } from './lib/import-run.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] ?? path.join(REPO, '..', 'import-autopilot-shots');
const N = Number(process.argv[3] ?? 5000);
mkdirSync(OUT, { recursive: true });
process.chdir(REPO);

// ---- real server answers
const h = await startPglite(REPO);
const IA = await import(path.join(REPO, 'api/_lib/importAutopilot.js'));
const ctx = { tenantKey: 'org_shoot', tenantName: 'Mesa Mechanical Services' };
const ten = (await h.getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
const batch = h.nid(); const scope = { batchId: batch };
const synth = buildSynthetic(N);
await loadSynthetic(h, ten, synth, batch);
// state 1: a third of the papers are still being read
const reading = synth.docs.filter((d) => d.stage !== 'verified').slice(-Math.round(N * 0.33)).map((d) => d.id);
await h.lite.query(`UPDATE documents SET stage = 'received', extracted_at = NULL WHERE id = ANY($1::uuid[])`, [reading]);
await fileAll(IA, ctx, scope);
IA._clearAnalysisCache();
const planProgress = await IA.importPlan(ctx, { ...scope, fresh: true });
// state 2: everything read and filed
await h.lite.query(`UPDATE documents SET stage = 'read', extracted_at = NOW() - INTERVAL '2 hours' WHERE id = ANY($1::uuid[])`, [reading]);
IA._clearAnalysisCache();
await fileAll(IA, ctx, scope);
IA._clearAnalysisCache();
const planFinal = await IA.importPlan(ctx, { ...scope, fresh: true });
const lite = { ...planFinal, decisions: planFinal.decisions.map((d) => ({ ...d, documentIds: d.documentIds.slice(0, d.count) })) };
console.log('progress', JSON.stringify(planProgress.counts), '\nfinal', JSON.stringify(planFinal.summary), planFinal.decisions.length, 'decisions');
await h.lite.close?.();

// ---- browser
const { createServer } = await import('vite');
const reactPlugin = (await import('@vitejs/plugin-react')).default;
const { chromium } = await import('playwright');
const tailwindcss = (await import('tailwindcss')).default;
const autoprefixer = (await import('autoprefixer')).default;
const server = await createServer({
  root: REPO, configFile: false, envFile: false, logLevel: 'warn',
  define: { 'import.meta.env.VITE_DEMO_MODE': JSON.stringify('true') },
  resolve: { alias: [{ find: '@clerk/clerk-react', replacement: path.join(REPO, 'scripts', 'desktop-harness', 'clerk-mock.tsx') }] },
  css: { postcss: { plugins: [tailwindcss(path.join(REPO, 'tailwind.config.ts')), autoprefixer()] } },
  plugins: [reactPlugin()],
  server: { port: 5193, strictPort: false, fs: { allow: [REPO] } },
});
await server.listen();
const addr = server.httpServer.address();
const port = typeof addr === 'object' && addr ? addr.port : addr;
const browser = await chromium.launch();
const errs = [];
try {
  for (const [name, vp, mobile] of [['1440', { width: 1440, height: 900 }, false], ['390', { width: 390, height: 844 }, true]]) {
    for (const theme of ['light', 'dark']) {
      const bctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
      const page = await bctx.newPage();
      page.on('pageerror', (e) => errs.push(`${name}/${theme}: ${e.message}`));
      let plan = planProgress; let applied = null;
      await page.route('**/api/review', async (route) => {
        const body = JSON.parse(route.request().postData() ?? '{}');
        const j = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
        switch (body.action) {
          case 'importList': return j({ imports: [{ batchId: batch, total: N, filed: plan.counts.filed, startedAt: new Date().toISOString(), lastAt: new Date().toISOString(), paused: false }], settings: plan.settings });
          case 'importPlan': return j(plan);
          case 'importAutoFile': return j({ filed: 0, skipped: 0, remaining: 0, off: false, runId: null });
          case 'importApply': { const d = plan.decisions.find((x) => x.id.endsWith(String(body.key))); applied = d ?? null; plan = { ...plan, decisions: plan.decisions.filter((x) => x !== d), summary: { ...plan.summary, decisions: plan.summary.decisions - 1 } }; return j({ applied: d?.count ?? 0, skipped: [], runId: '00000000-0000-4000-8000-0000000000aa', customerId: d?.params.customerId }); }
          case 'importUndoDecision': return j({ undone: applied?.count ?? 0, restored: applied?.count ?? 0, unfiled: 0, left: 0, customersRemoved: 0, more: false });
          default: return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"harness"}' });
        }
      });
      await page.goto(`http://localhost:${port}/scripts/inbox-harness/index.html?n=60&theme=${theme}`, { waitUntil: 'networkidle' });
      const panel = page.locator('[data-testid="import-autopilot"]');
      await panel.waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);
      const tag = `${name}_${theme}`;
      await panel.scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollTo(0, document.querySelector('[data-testid="import-autopilot"]').getBoundingClientRect().top + window.scrollY - 70)); await page.screenshot({ path: path.join(OUT, `01_progress_${tag}.png`) });
      await panel.screenshot({ path: path.join(OUT, `01_progress_panel_${tag}.png`) });
      // everything read: the onboarding summary and the decisions
      plan = planFinal;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.reload({ waitUntil: 'networkidle' });
      await panel.waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);
      await page.evaluate(() => window.scrollTo(0, document.querySelector('[data-testid="import-autopilot"]').getBoundingClientRect().top + window.scrollY - 70)); await page.screenshot({ path: path.join(OUT, `02_summary_${tag}.png`) });
      await panel.screenshot({ path: path.join(OUT, `02_decisions_panel_${tag}.png`) });
      // confirm step on the first card (nothing is applied until Yes)
      await panel.locator('[data-testid="import-decision"] button.dw-btn-primary').first().click();
      await page.waitForTimeout(300);
      await panel.screenshot({ path: path.join(OUT, `03_confirm_panel_${tag}.png`) });
      // apply, then the Undo row
      await panel.locator('[role="group"] button.dw-btn-primary').first().click();
      await page.waitForSelector('[data-testid^="decision-done-"]', { timeout: 10000 });
      await page.waitForTimeout(300);
      await panel.screenshot({ path: path.join(OUT, `04_applied_undo_panel_${tag}.png`) });
      // no horizontal page scroll
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) errs.push(`${tag}: horizontal overflow ${overflow}px`);
      await bctx.close();
    }
  }
} finally { await browser.close(); await server.close(); }
console.log(errs.length ? 'PROBLEMS\n' + errs.join('\n') : 'no page errors, no horizontal overflow');
process.exit(errs.length ? 1 : 0);
