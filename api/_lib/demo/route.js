/**
 * /api/account?action=demo  -  the industry demo account's own server side.
 *
 *   POST {op:'status'}        any signed-in member: is this a demo company, its industry, how many scans it holds
 *   POST {op:'clear-scans'}   any signed-in member OF A DEMO COMPANY: remove the prospect's documents and put the company
 *                             back to its sample paperwork (resetDemoTenant). Refused (403) for every real company.
 *   GET  ?op=reset-all        cron only (Authorization: Bearer CRON_SECRET, as Vercel sends it): the nightly reset of
 *                             every demo company listed by list_demo_tenants() (M3-config/73). Never touches anything else.
 *
 * No route here can MAKE a company a demo company: that is only M3-config/demo/D1, run by hand in the SQL editor.
 */
import { requireAuth, denyAuth } from '../auth.js';
import { requireAuthOrKey as requireAuthOrApiKey, assertScope } from '../apiKeyAuth.js';
import { handleCors, handleError } from '../claude.js';
import { limit } from '../rateLimit.js';
import { getPool } from '../recordsStore.js';
import { isValidCronAuth } from '../routes/cron-sweep.js';
import { resetDemoTenant, demoStatus, DemoResetError } from './reset.js';
import { isDemoAuth, sendDemoRestricted } from './index.js';


export const config = { api: { bodyParser: { sizeLimit: '8kb' } }, maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleCors(res, req).status(204).end();
  const op = String(req.body?.op ?? req.query?.op ?? '');

  if (op === 'reset-all') {
    if (!isValidCronAuth(req.headers?.authorization, process.env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    return resetAll(res);
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let auth;
  try {
    // status may also be read with an import key that has the "read" scope (the seeding tool's health check);
    // clear-scans needs a person signed in to the demo company.
    if (op === 'status') { auth = await requireAuthOrApiKey(req); assertScope(auth, 'read'); }
    else auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }
  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };
  try {
    if (op === 'status') return handleCors(res, req).status(200).json(await demoStatus(ctx));
    if (op === 'clear-scans') {
      if (!(await isDemoAuth(auth))) return sendDemoRestricted(handleCors(res, req), req);
      if (!(await limit(req, res, auth, 'write'))) return;
      const r = await resetDemoTenant(ctx, { reason: 'clear-scans', actor: auth.userId ?? null });
      return handleCors(res, req).status(200).json({ ok: true, removedDocuments: r.removedDocuments, failedStorage: r.failedStorage });
    }
    return res.status(400).json({ error: 'Unknown op', ops: ['status', 'clear-scans'] });
  } catch (err) {
    if (err instanceof DemoResetError) return handleCors(res, req).status(err.status).json({ error: err.message });
    return handleError(res, err, req, { tenantId: auth.tenantId });
  }
}

async function resetAll(res) {
  const started = Date.now();
  let tenants = [];
  try {
    ({ rows: tenants } = await getPool().query('SELECT tenant_id, tenant_key FROM list_demo_tenants()'));
  } catch (err) {
    console.warn('demo reset: skipped, demo tables not installed yet (M3-config/73):', err?.message);
    return res.status(200).json({ ok: true, skipped: 'not installed', reset: 0 });
  }
  const results = [];
  for (const t of tenants) {
    if (Date.now() - started > 240_000) { results.push({ tenant: t.tenant_key, skipped: 'deadline' }); continue; }
    try {
      const r = await resetDemoTenant({ tenantKey: t.tenant_key, tenantName: t.tenant_key }, { reason: 'nightly' });
      results.push({ tenant: t.tenant_key, removedDocuments: r.removedDocuments, failedStorage: r.failedStorage });
    } catch (err) {
      results.push({ tenant: t.tenant_key, error: String(err?.message ?? err).slice(0, 160) });
    }
  }
  const failed = results.filter((r) => r.error).length;
  console.log(JSON.stringify({ route: 'demo-reset', tenants: tenants.length, failed, ms: Date.now() - started }));
  return res.status(200).json({ ok: failed === 0, reset: results.length - failed, failed, results });
}
