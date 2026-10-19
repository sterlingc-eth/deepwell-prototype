/** Production wiring for the backup engine: real database, real R2 (read), the separate backup bucket (write), the owner alert. */
import { parseMasterKey } from './crypto.js';
import { createS3Storage, storageConfigFromEnv } from './s3.js';
import { retentionFromEnv } from './retention.js';
import * as source from './source.js';
import { listTenantKeys } from '../opsStore.js';
import { getObject, keyBelongsToTenant } from '../r2.js';
import { sendEmail } from '../email.js';
import { parseOwnerAlertEmails } from '../missDigest.js';
import { captureMessage } from '../telemetry.js';

/** The whole feature is OFF unless DEEPWELL_BACKUP=1. */
export const backupEnabled = (env = process.env) => env.DEEPWELL_BACKUP === '1';

/** Owner alert: Sentry (if configured) AND email to DEEPWELL_OWNER_ALERT_EMAILS (the same list the weekly miss digest uses). Never throws. */
export async function ownerAlert({ subject, text, kind }) {
  await captureMessage(`backup: ${subject}`, { kind }, { level: 'error', fingerprint: ['backup', String(kind)] }).catch(() => {});
  const to = parseOwnerAlertEmails(process.env.DEEPWELL_OWNER_ALERT_EMAILS);
  if (!to.length) { console.error(`backup alert (no DEEPWELL_OWNER_ALERT_EMAILS set): ${subject}`); return; }
  const html = `<p>${String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`;
  await sendEmail({ to, subject, text, html }).catch((err) => console.error('backup alert email failed:', err?.message));
}

export function makeDeps(env = process.env) {
  return {
    storage: createS3Storage(storageConfigFromEnv(env)),
    masterKey: parseMasterKey(env.BACKUP_ENCRYPTION_KEY),
    source,
    skipTables: source.skipTablesFromEnv(env),
    policy: retentionFromEnv(env),
    listTenants: listTenantKeys,
    getObject,
    keyBelongsToTenant,
    alert: ownerAlert,
    runId: Math.random().toString(36).slice(2),
  };
}
