/**
 * Regression checks for the observability/ops build (telemetry, ingestion
 * idempotency, tenant export/delete, cron sweep).
 *
 * No database, no network — every function under test here is pure, or (for
 * telemetry) deliberately exercised with SENTRY_DSN unset so it never
 * attempts one.
 *
 *   node scripts/verify-ops.mjs
 */
import { captureException, captureMessage, scrubContext } from '../api/_lib/telemetry.js';
import { alreadyIngested } from '../api/_lib/readDocument.js';
import { DELETE_ORDER } from '../api/_lib/opsStore.js';
import { isValidCronAuth } from '../api/_lib/routes/cron-sweep.js';
import { isValidConfirm } from '../api/_lib/routes/tenant-delete.js';
import { hashQuestion } from '../api/ask.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ------------------------------------------------------- telemetry no-op */
//
// SENTRY_DSN ships as a literal placeholder ("https://<your-sentry-dsn>") in
// every env file this codebase has, and that must resolve to the console
// fallback, not an attempted network call to a URL that isn't a real DSN.
{
  delete process.env.SENTRY_DSN;

  let threw = false;
  try {
    await captureException(new Error('boom'), { route: '/test', tenantId: 't_1' });
  } catch {
    threw = true;
  }
  check('captureException never throws with no SENTRY_DSN set', !threw);

  threw = false;
  try {
    await captureMessage('a summary', { route: '/test' });
  } catch {
    threw = true;
  }
  check('captureMessage never throws with no SENTRY_DSN set', !threw);

  process.env.SENTRY_DSN = 'https://<your-sentry-dsn>';
  threw = false;
  try {
    await captureException(new Error('boom'));
  } catch {
    threw = true;
  }
  check('a placeholder SENTRY_DSN is treated as unconfigured, not a real DSN', !threw);
  delete process.env.SENTRY_DSN;

  const scrubbed = scrubContext({
    route: '/api/ask',
    tenantId: 't_1',
    token: 'secret-token',
    body: { question: 'what is my address' },
    connectionString: 'postgresql://user:pass@host/db',
    authorization: 'Bearer xyz',
  });
  check('scrubContext drops everything off the allowlist', !('token' in scrubbed) && !('body' in scrubbed) && !('connectionString' in scrubbed) && !('authorization' in scrubbed));
  check('scrubContext keeps allowlisted keys', scrubbed.route === '/api/ask' && scrubbed.tenantId === 't_1');
}

/* ------------------------------------------------------ idempotency guard */
//
// The bug: ingestDocument had no idempotency check at all, so a double-click
// or a retried request re-paid for a full Sonnet transcription of a document
// already read.
{
  check('a fresh, never-read document is not already ingested',
    !alreadyIngested({ stage: 'received', page_count: 0, extract_error: null }));
  check('a document that failed extraction is not already ingested (must retry)',
    !alreadyIngested({ stage: 'received', page_count: 0, extract_error: 'boom' }));
  check('a document with pages but still at stage received is not already ingested',
    !alreadyIngested({ stage: 'received', page_count: 4, extract_error: null }));
  check('a successfully read document (stage read, pages, no error) is already ingested',
    alreadyIngested({ stage: 'read', page_count: 4, extract_error: null }));
  check('a document further along the pipeline (mapped) is still recognized as already ingested',
    alreadyIngested({ stage: 'mapped', page_count: 4, extract_error: null }));
  check('a re-extracted document that cleared a stale error is already ingested',
    alreadyIngested({ stage: 'read', page_count: 2, extract_error: null }));
  check('null/undefined document is never already ingested', !alreadyIngested(null) && !alreadyIngested(undefined));
}

/* ------------------------------------------------------- FK deletion order */
//
// Derived from M3-config/01-create-schema.sql's actual foreign keys: a child
// table (one whose row references another table's id, ON DELETE CASCADE)
// must be deleted before the parent it points at, or an explicit ordered
// DELETE running ahead of the CASCADE would otherwise be redundant at best
// and, if the order were ever inverted, would rely entirely on CASCADE to
// paper over it.
{
  // Eight content tables from 01-create-schema.sql, plus the four that later
  // migrations add (users' tenant scoping, api_keys, usage_counters,
  // document_entity_links). All twelve hold per-tenant data and all twelve
  // must go on a "delete all my data" request — the tenants row is kept, so
  // nothing cascades on its own.
  const TENANT_TABLES = ['api_keys', 'audit_log', 'document_entity_links', 'document_pages', 'documents', 'entities', 'extractions', 'facets', 'proposals', 'schema_versions', 'usage_counters', 'users'];
  eq('DELETE_ORDER contains exactly the twelve tenant-scoped tables, no more, no fewer',
    [...DELETE_ORDER].sort(), TENANT_TABLES);

  // child -> [parents that must come later in the order]
  const MUST_PRECEDE = {
    extractions: ['documents', 'facets'],
    document_pages: ['documents'],
    facets: ['documents'],
  };
  for (const [child, parents] of Object.entries(MUST_PRECEDE)) {
    const childIdx = DELETE_ORDER.indexOf(child);
    for (const parent of parents) {
      const parentIdx = DELETE_ORDER.indexOf(parent);
      check(`${child} is deleted before ${parent} (FK: ${child} -> ${parent})`,
        childIdx !== -1 && parentIdx !== -1 && childIdx < parentIdx,
        `${child} at ${childIdx}, ${parent} at ${parentIdx}`);
    }
  }

  check('tenants is never in DELETE_ORDER (resolve_tenant must keep working after a wipe)',
    !DELETE_ORDER.includes('tenants'));
  check('members, api keys and usage counters are wiped too (not just documents)',
    ['users', 'api_keys', 'usage_counters'].every((t) => DELETE_ORDER.includes(t)));
}

/* -------------------------------------------------------- cron auth check */
{
  check('the correct bearer secret authorizes', isValidCronAuth('Bearer abc123', 'abc123'));
  check('the wrong secret is rejected', !isValidCronAuth('Bearer wrong', 'abc123'));
  check('a missing Authorization header is rejected', !isValidCronAuth(undefined, 'abc123'));
  check('a header with no Bearer prefix is rejected', !isValidCronAuth('abc123', 'abc123'));
  check('an unset CRON_SECRET fails closed and authorizes nothing, ever',
    !isValidCronAuth('Bearer ', '') && !isValidCronAuth(undefined, undefined) && !isValidCronAuth('Bearer undefined', undefined));
}

/* ----------------------------------------------------- confirm-match check */
{
  check('an exact tenant-id match confirms', isValidConfirm('org_abc123', 'org_abc123'));
  check('a mismatched confirm is refused', !isValidConfirm('org_other', 'org_abc123'));
  check('an empty confirm is refused', !isValidConfirm('', 'org_abc123'));
  check('a non-string confirm is refused', !isValidConfirm(undefined, 'org_abc123') && !isValidConfirm(null, 'org_abc123'));
  check('a missing tenantId never confirms, even against an empty string', !isValidConfirm('', ''));
}

/* --------------------------------------------------------- question hashing */
{
  const q = 'What is the warranty on the furnace at 12 Elm St for the Andersons?';
  const h1 = hashQuestion(q);
  check('hashQuestion returns a 64-character hex sha256 digest', /^[0-9a-f]{64}$/.test(h1), h1);
  eq('the same question hashes identically every time', hashQuestion(q), h1);
  check('a different question hashes differently', hashQuestion(q + '?') !== h1);
  check('the hash never contains the literal question text or a customer name from it',
    !h1.toLowerCase().includes('anderson') && !h1.includes('Elm'));
}

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
