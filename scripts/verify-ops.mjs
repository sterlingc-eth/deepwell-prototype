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
import { hashForLog } from '../api/_lib/privacy/redact.js';
import { alreadyIngested, failureMessageFor, isProviderRetryable, PROVIDER_RETRY_MESSAGES, PROVIDER_GIVE_UP_MESSAGE, GENERIC_READ_FAILURE_MESSAGE, IngestError } from '../api/_lib/readDocument.js';
import { DAILY_BUDGET_EXCEEDED_MESSAGE } from '../api/_lib/queue.js';
import { readFileSync } from 'node:fs';
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
  // Round 22 (S2, privacy): tenantId now leaves this file as a hash, never the raw Clerk org id — see
  // telemetry.js's own HASHED_CONTEXT_KEYS / scripts/verify-privacy.mjs's own Sentry-scrubbing section.
  check('scrubContext keeps allowlisted keys (tenantId hashed, route in the clear)', scrubbed.route === '/api/ask' && scrubbed.tenantId === hashForLog('t_1') && scrubbed.tenantId !== 't_1');
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
  // The twelve tables this list started with (01-create-schema.sql plus users, api_keys, usage_counters,
  // document_entity_links). Round 25 extended DELETE_ORDER to EVERY table with a tenant_id column; the full
  // schema-derived completeness check (fails if any tenant table is missing) lives in scripts/verify-readiness.mjs.
  const ORIGINAL_TWELVE = ['api_keys', 'audit_log', 'document_entity_links', 'document_pages', 'documents', 'entities', 'extractions', 'facets', 'proposals', 'schema_versions', 'usage_counters', 'users'];
  check('DELETE_ORDER still contains the original twelve tenant-scoped tables (and now more: see verify-readiness)',
    ORIGINAL_TWELVE.every((t) => DELETE_ORDER.includes(t)) && DELETE_ORDER.length > ORIGINAL_TWELVE.length);

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

/* ------------------------------------------- readiness P1: provider-failure messages + capped retry */
{
  const credit = { status: 400, error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Claude API.' } };
  const rate = { status: 429, name: 'RateLimitError', message: '429 rate limited req_abc' };
  check('credit outage is retryable', isProviderRetryable(credit));
  check('transient 5xx is retryable', isProviderRetryable({ status: 503, message: 'x' }));
  check('IngestError 415 / unknown error are not retryable', !isProviderRetryable(new IngestError('nope', 415)) && !isProviderRetryable(new Error('boom')));
  // attempt cap: null -> retry1 -> retry2 -> give up, and give-up is never in the retry list
  const m1 = failureMessageFor(credit, null, 'received');
  const m2 = failureMessageFor(credit, m1, 'received');
  const m3 = failureMessageFor(rate, m2, 'received');
  const m4 = failureMessageFor(rate, m3, 'received');
  eq('attempt 1 -> first retry message', m1, PROVIDER_RETRY_MESSAGES[0]);
  eq('attempt 2 -> second retry message', m2, PROVIDER_RETRY_MESSAGES[1]);
  eq('attempt 3 -> give-up message (cap)', m3, PROVIDER_GIVE_UP_MESSAGE);
  check('give-up message is not in the sweep retry list (never retried forever)', !PROVIDER_RETRY_MESSAGES.includes(PROVIDER_GIVE_UP_MESSAGE));
  eq('a manual retry after give-up restarts the capped cycle, not an infinite one', m4, PROVIDER_RETRY_MESSAGES[0]);
  eq('a document already past "received" gets the give-up message (sweep only re-reads unread documents)', failureMessageFor(credit, null, 'read'), PROVIDER_GIVE_UP_MESSAGE);
  // no raw text, credits, costs or keys in anything a customer reads
  const all = [...PROVIDER_RETRY_MESSAGES, PROVIDER_GIVE_UP_MESSAGE, GENERIC_READ_FAILURE_MESSAGE, failureMessageFor(new Error('ECONNxyz secret sk-ant-123 at /var/task/x.js:9'), null, 'received')];
  check('no customer message mentions credits, cost, balance, key, provider or raw error text', all.every((t) => !/credit|balance|\$|key|provider|billing|sk-ant|\/var\/task|ECONN/i.test(t)), all.join(' | '));
  eq('unknown internal error -> fixed generic message', failureMessageFor(new Error('relation "documents" does not exist'), null, 'received'), GENERIC_READ_FAILURE_MESSAGE);
  eq('our curated IngestError text passes through', failureMessageFor(new IngestError('This PDF is password protected.', 415), null, 'received'), 'This PDF is password protected.');
  eq('daily-limit deferral text still passes through unchanged (the sweep matches it exactly)', failureMessageFor(new Error(DAILY_BUDGET_EXCEEDED_MESSAGE), null, 'received'), DAILY_BUDGET_EXCEEDED_MESSAGE);
  // static: the customer-visible handleError body no longer names credits/keys; the sweep is scheduled
  const claudeSrc = readFileSync(new URL('../api/_lib/claude.js', import.meta.url), 'utf8');
  check('handleError provider-outage body has no "out of credits" / "key is invalid" text', !/is out of credits\.",|key is invalid\."/.test(claudeSrc.slice(claudeSrc.indexOf('recordProviderOutage(providerOutage)'), claudeSrc.indexOf('recordProviderOutage(providerOutage)') + 900)));
  const vj = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const paths = vj.crons.map((c) => c.path);
  check('vercel.json keeps the nightly sweep', paths.includes('/api/account?action=sweep'));
  const docsCron = vj.crons.find((c) => c.path === '/api/account?action=sweep&mode=docs');
  check('vercel.json schedules the light docs-only sweep every 15-30 minutes', Boolean(docsCron) && /^\*\/(15|20|30) \* \* \* \*$/.test(docsCron.schedule), JSON.stringify(docsCron));
  check('vercel.json keeps the CSP header', vj.headers.some((h) => h.headers.some((x) => x.key === 'Content-Security-Policy')));
}

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
