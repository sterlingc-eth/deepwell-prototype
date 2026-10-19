import { timingSafeEqual } from 'node:crypto';
import { requireAuth, denyAuth } from '../auth.js';
import { isPlatformOperator } from '../missDigest.js';
import { captureException } from '../telemetry.js';
import { backupEnabled, makeDeps, ownerAlert } from './prod.js';
import { runBackup, checkBackupHealth, backupStatus } from './engine.js';

/**
 * /api/account?action=backup        (lazy-imported by api/account.js; OFF unless DEEPWELL_BACKUP=1)
 *
 *   GET/POST with  Authorization: Bearer $CRON_SECRET   -> run (or resume) tonight's backup. Vercel cron calls this several
 *                                                          times each morning; once everything is done each call costs a handful of
 *                                                          cheap checks and returns { complete: true }.
 *   POST { op: 'status' }  signed-in platform operator   -> { lastSuccessAt, ageHours, stale, today } for the operator view
 *   POST { op: 'run' }     signed-in platform operator   -> start/resume a backup now
 *
 * Read-only against production data. No company can call any of this: operator or cron secret only.
 */
export const config = { api: { bodyParser: { sizeLimit: '4kb' } }, maxDuration: 300 };
const RUN_BUDGET_MS = 240_000;

function cronAuthOk(header, secret) {
  if (!secret || typeof header !== 'string') return false;
  const a = Buffer.from(header); const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const op = String(req.body?.op ?? '');
  const isCron = cronAuthOk(req.headers?.authorization, process.env.CRON_SECRET);

  if (!backupEnabled()) {
    // Off: reveal nothing, and do nothing. The status op answers {enabled:false} so the operator card can say "not turned on".
    if (!isCron && op === 'status') {
      try { const auth = await requireAuth(req); if (!isPlatformOperator(auth)) return res.status(404).json({ error: 'Not available.' }); } catch (err) { return denyAuth(res, err); }
      return res.status(200).json({ enabled: false });
    }
    return res.status(isCron ? 200 : 404).json(isCron ? { enabled: false } : { error: 'Not available.' });
  }

  let operator = false;
  if (!isCron) {
    try { const auth = await requireAuth(req); operator = isPlatformOperator(auth); } catch (err) { return denyAuth(res, err); }
    if (!operator) return res.status(404).json({ error: 'Not available.' });
  }

  let deps;
  try { deps = makeDeps(); } catch (err) {
    // Misconfigured (missing key/bucket): say which setting, never the value, and tell the owner.
    await ownerAlert({ kind: 'config', subject: 'DeepWell backup is not configured', text: `${err.message}. See BACKUP_RUNBOOK.md ("Turning it on").` });
    return res.status(503).json({ enabled: true, ok: false, error: err.message });
  }

  try {
    if (!isCron && op === 'status') return res.status(200).json({ enabled: true, ...(await backupStatus(deps)) });
    if (isCron || op === 'run') {
      const health = await checkBackupHealth(deps);
      const result = await runBackup(deps, { deadlineAt: Date.now() + RUN_BUDGET_MS });
      return res.status(200).json({ enabled: true, health, date: result.date, complete: result.complete, done: result.done, tenantsTotal: result.tenantsTotal, failed: result.failed?.length ?? 0, partial: result.partial });
    }
    return res.status(400).json({ error: 'Unknown op' });
  } catch (err) {
    await captureException(err, { route: '/api/account', action: 'backup' });
    await ownerAlert({ kind: 'crash', subject: 'DeepWell backup run crashed', text: `The backup run stopped with: ${String(err?.message ?? err).slice(0, 200)}` });
    return res.status(500).json({ enabled: true, ok: false, error: 'Backup run failed.' });
  }
}
