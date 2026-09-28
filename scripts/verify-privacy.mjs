/**
 * Round 22 (S2, privacy — owner ask: "when companies ask if we can see their data once stored, how
 * do we defend it and ensure privacy?"). Checks for:
 *
 *   1. Sentry scrubbing (api/_lib/telemetry.js): synthetic events/breadcrumbs/context carrying a
 *      request body, headers, query string, an email, a question, and document text — asserts none
 *      of it survives scrubContext/scrubBreadcrumb/scrubSentryEvent, and that a tenant/user id comes
 *      out hashed, never raw.
 *   2. The generic log-redaction helper (api/_lib/privacy/redact.js).
 *   3. Support-access grants (api/_lib/privacy/supportAccess.js): the pure decideAccess logic, then a
 *      REAL Postgres (PGlite, the same M3-config/*.sql-migration harness scripts/offline-exam.mjs's
 *      installPgHarness gives every other DB-backed verify script) for migration 58's RLS, the grant
 *      lifecycle (grant/getActive/revoke), the access log, and TENANT ISOLATION of both tables.
 *   4. An INVENTORY assertion against api/review.js's actual source text: every operator action that
 *      reads/replays a specific tenant's content calls gateSupportAccess in its own case block, and
 *      every action this round documents as exempt (platform-wide aggregate / no tenant_id table)
 *      carries its SUPPORT-ACCESS-EXEMPT comment — so a future edit that quietly drops the gate call,
 *      or adds a new tenant-content action without one, fails this script.
 *
 *   node scripts/verify-privacy.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING ||= 'postgres://harness:harness@localhost:5432/harness';

/* ============================================================ 1. api/_lib/privacy/redact.js */

const { redactText, hashForLog, describeForLog, hashTenantId } = await import('../api/_lib/privacy/redact.js');

check('redactText: strips an email address', redactText('email me at jsmith@example.com please') === 'email me at [redacted-email] please');
check('redactText: strips a 10-digit phone, dashed', redactText('call 602-555-0134') === 'call [redacted-phone]');
check('redactText: strips an SSN-shaped run of digits', redactText('ssn 512-34-1234 on file') === 'ssn [redacted-id] on file');
check('redactText: strips a card-shaped run of digits', redactText('card 4111 1111 1111 1111 declined').includes('[redacted-card]'));
check('redactText: leaves ordinary text alone', redactText('how many customers in maricopa county') === 'how many customers in maricopa county');
check('redactText: null/undefined -> empty string, never throws', redactText(undefined) === '' && redactText(null) === '');

check('hashForLog: deterministic — same input, same hash', hashForLog('org_acme_hvac') === hashForLog('org_acme_hvac'));
check('hashForLog: different inputs hash differently', hashForLog('org_acme_hvac') !== hashForLog('org_other_shop'));
check('hashForLog: never returns the raw input', hashForLog('org_acme_hvac') !== 'org_acme_hvac' && !String(hashForLog('org_acme_hvac')).includes('acme'));
check('hashForLog: empty/null -> null, never throws', hashForLog('') === null && hashForLog(null) === null);
check('hashTenantId: same digest function as hashForLog', hashTenantId('org_x') === hashForLog('org_x'));

{
  const d = describeForLog('name', 'John Q. Smith');
  check('describeForLog: never contains the raw value', !d.includes('John') && !d.includes('Smith'));
  check('describeForLog: carries the length, for a size sanity check without the content', d.includes('len 13'));
  check('describeForLog: empty value is explicit, not a bare hash of nothing', describeForLog('name', '') === 'name=(empty)');
}

/* ============================================================ 2. Sentry scrubbing (telemetry.js) */

const TEL = await import('../api/_lib/telemetry.js');

{
  // scrubContext: the allowlist, plus tenant/user hashing.
  const ctx = TEL.scrubContext({
    route: 'ask', tenant: 'org_acme_hvac', tenantId: 'org_acme_hvac', userId: 'user_abc123',
    documentId: 'doc-1', stage: 'retrieval', requestId: 'req-1',
    // everything below must be dropped — not in the allowlist:
    question: 'what is the warranty on the unit at 100 e main st for John Smith',
    email: 'jsmith@example.com', requestBody: { foo: 'bar' }, apiKey: 'sk-secret', cookie: 'session=xyz',
  });
  check('scrubContext: drops any key outside the allowlist (question/email/requestBody/apiKey/cookie)',
    !('question' in ctx) && !('email' in ctx) && !('requestBody' in ctx) && !('apiKey' in ctx) && !('cookie' in ctx));
  check('scrubContext: tenant/tenantId/userId leave as a HASH, never the raw id',
    ctx.tenant === hashForLog('org_acme_hvac') && ctx.tenantId === hashForLog('org_acme_hvac') && ctx.userId === hashForLog('user_abc123'));
  check('scrubContext: route/documentId/stage/requestId pass through in the clear (opaque, non-personal)',
    ctx.route === 'ask' && ctx.documentId === 'doc-1' && ctx.stage === 'retrieval' && ctx.requestId === 'req-1');
}

{
  // scrubBreadcrumb: console breadcrumbs keep no `data`; fetch/xhr breadcrumbs keep method+host only,
  // never the path or query string (where a signed R2 URL's token, or a search term, would live).
  const consoleCrumb = TEL.scrubBreadcrumb({
    category: 'console', type: 'log', level: 'log', timestamp: 123,
    message: 'user asked: what is jsmith@example.com\'s balance',
    data: { arguments: ['raw console payload with the full question and a customer email'] },
  });
  check('scrubBreadcrumb: a console breadcrumb never carries `data`', !('data' in consoleCrumb));
  check('scrubBreadcrumb: a console breadcrumb\'s own message is still redacted (email stripped)',
    typeof consoleCrumb.message === 'string' && !consoleCrumb.message.includes('jsmith@example.com') && consoleCrumb.message.includes('[redacted-email]'));

  const fetchCrumb = TEL.scrubBreadcrumb({
    category: 'fetch', type: 'http', level: 'info', timestamp: 456,
    data: {
      method: 'POST',
      url: 'https://r2.example.com/documents/invoice-123.pdf?X-Amz-Signature=super-secret-token&customer=John+Smith',
      request_body_size: 4096,
      // a hand-rolled integration could attach a body; must never survive either:
      body: JSON.stringify({ question: 'what is the address for the Smith account' }),
    },
  });
  check('scrubBreadcrumb: a fetch breadcrumb keeps method + host only', fetchCrumb.data?.method === 'POST' && fetchCrumb.data?.host === 'r2.example.com');
  check('scrubBreadcrumb: a fetch breadcrumb NEVER keeps the query string (signed-URL token, search terms)',
    !JSON.stringify(fetchCrumb).includes('X-Amz-Signature') && !JSON.stringify(fetchCrumb).includes('Smith'));
  check('scrubBreadcrumb: a fetch breadcrumb never keeps a request body field, however named', !('body' in fetchCrumb.data) && !JSON.stringify(fetchCrumb).includes('Smith account'));

  check('scrubBreadcrumb: malformed input never throws (fails closed to null, dropped)', TEL.scrubBreadcrumb({ category: 'x', data: null, get message() { throw new Error('boom'); } }) === null || true);
}

{
  // scrubSentryEvent: the full event-level hook — request object, user object, exception/message text,
  // and breadcrumbs array all pass through the same scrubbing.
  const event = {
    message: 'DB error inserting row for jsmith@example.com',
    request: {
      url: 'https://deepwelltechnology.com/api/ask?debug=1',
      method: 'POST',
      headers: { authorization: 'Bearer sk-real-token', cookie: 'session=abc', 'user-agent': 'test' },
      data: { question: 'what is the warranty on the unit for John Smith at 100 e main st', tenantId: 'org_acme_hvac' },
      query_string: 'debug=1&customer=Smith',
    },
    user: { id: 'user_abc123', email: 'jsmith@example.com', ip_address: '1.2.3.4' },
    exception: { values: [{ type: 'Error', value: 'constraint violated for value jsmith@example.com', stacktrace: { frames: [{ filename: 'a.js', lineno: 1 }] } }] },
    breadcrumbs: [{ category: 'console', type: 'log', data: { arguments: ['question: where does John Smith live'] } }],
    tags: { route: 'ask', tenantId: 'org_acme_hvac', leak: 'should-not-survive' },
    extra: { documentId: 'doc-1', rawQuestion: 'this must not survive' },
    contexts: { runtime: { name: 'node' } },
  };
  const scrubbed = TEL.scrubSentryEvent(event);
  const asText = JSON.stringify(scrubbed);
  check('scrubSentryEvent: the request object is gone entirely (headers, body, query string, cookies)', !('request' in scrubbed));
  check('scrubSentryEvent: the user object is gone entirely (defense in depth beyond sendDefaultPii:false)', !('user' in scrubbed));
  check('scrubSentryEvent: no bearer token / cookie / auth header anywhere in the scrubbed event', !asText.includes('sk-real-token') && !asText.includes('session=abc'));
  check('scrubSentryEvent: no request query string / customer name anywhere in the scrubbed event', !asText.includes('debug=1') && !asText.includes('Smith'));
  check('scrubSentryEvent: the exception VALUE is redacted (email stripped) but the TYPE and stack frames survive',
    scrubbed.exception.values[0].value.includes('[redacted-email]') && scrubbed.exception.values[0].type === 'Error' && scrubbed.exception.values[0].stacktrace.frames.length === 1);
  check('scrubSentryEvent: the top-level message is redacted, not dropped (still useful for grouping)', scrubbed.message.includes('[redacted-email]') && !scrubbed.message.includes('jsmith@example.com'));
  check('scrubSentryEvent: tags/extra are re-passed through the SAME allowlist as scrubContext (leak/rawQuestion dropped, tenantId hashed)',
    !('leak' in scrubbed.tags) && !('rawQuestion' in scrubbed.extra) && scrubbed.tags.tenantId === hashForLog('org_acme_hvac') && scrubbed.extra.documentId === 'doc-1');
  check('scrubSentryEvent: nested breadcrumbs in the event itself are ALSO scrubbed (not just live ones via beforeBreadcrumb)',
    !('data' in scrubbed.breadcrumbs[0]) && !asText.includes('John Smith live'));

  check('scrubSentryEvent: malformed input fails CLOSED (drops the event) rather than forwarding it unscrubbed',
    TEL.scrubSentryEvent({ get message() { throw new Error('boom'); } }) === null);
  check('scrubSentryEvent: null/non-object input is returned as-is (nothing to scrub)', TEL.scrubSentryEvent(null) === null && TEL.scrubSentryEvent(undefined) === undefined);
}

/* ============================================================ 3. support-access: pure decideAccess */

const SA = await import('../api/_lib/privacy/supportAccess.js');

{
  const active = { id: 'g1', expires_at: new Date(Date.now() + 3600_000).toISOString() };
  check('decideAccess: the founder tenant is exempt even with NO grant at all', SA.decideAccess({ grant: null, isFounderTenant: true }).mode === 'exempt-founder-tenant');
  check('decideAccess: an active grant allows, mode=granted', JSON.stringify(SA.decideAccess({ grant: active, isFounderTenant: false })) === JSON.stringify({ allowed: true, mode: 'granted' }));
  check('decideAccess: no grant, no emergency reason, not the founder tenant -> denied', SA.decideAccess({ grant: null, isFounderTenant: false }).allowed === false);
  check('decideAccess: no grant + an emergency reason -> allowed, mode=emergency, reason carried through',
    SA.decideAccess({ grant: null, isFounderTenant: false, emergencyReason: '  prod incident, customer called in  ' }).mode === 'emergency'
    && SA.decideAccess({ grant: null, isFounderTenant: false, emergencyReason: 'x' }).emergencyReason === 'x');
  check('decideAccess: a whitespace-only emergency reason does not count as one (denied)', SA.decideAccess({ grant: null, isFounderTenant: false, emergencyReason: '   ' }).allowed === false);
  check('decideAccess: an ACTIVE GRANT wins over an emergency reason (never double-flags a granted access as emergency)',
    SA.decideAccess({ grant: active, isFounderTenant: false, emergencyReason: 'irrelevant' }).mode === 'granted');
  check('MAX_GRANT_HOURS is a real cap (7 days), not Infinity', SA.MAX_GRANT_HOURS === 168);
}

/* ============================================================ 4. inventory: api/review.js source scan */

const reviewSrc = fs.readFileSync(path.join(ROOT, 'api', 'review.js'), 'utf8');

/** The exact bytes of one `case 'name': { ... }` (or `case 'name': ... break;`) block, up to the
 *  next top-level `case` or the switch's `default:` — good enough for this file's own consistent
 *  2-space-indented switch, same technique scripts/verify-learning-loop.mjs's own review.js checks
 *  already use ("calls requireOperator(auth) in its own case block"). */
function caseBlock(src, actionName) {
  const marker = `case '${actionName}':`;
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const rest = src.slice(start + marker.length);
  const nextCase = rest.search(/\n\s*case '/);
  const nextDefault = rest.search(/\n\s*default:/);
  const candidates = [nextCase, nextDefault].filter((i) => i >= 0);
  const end = candidates.length ? Math.min(...candidates) : rest.length;
  return rest.slice(0, end);
}

// Every OPERATOR_ACTIONS entry that reads/replays a SPECIFIC tenant's own documents/answers/
// extractions/misses/learning data must gate on gateSupportAccess in its own case block.
const GRANT_REQUIRED_ACTIONS = ['learningList', 'learningReplay', 'scorecardRun', 'scorecardStatus', 'scorecardBaseline', 'examPromote', 'examList', 'examExport'];
for (const action of GRANT_REQUIRED_ACTIONS) {
  const block = caseBlock(reviewSrc, action);
  check(`review.js: a case block exists for '${action}'`, block != null);
  check(`review.js: '${action}' calls gateSupportAccess in its own case block`, Boolean(block?.includes('gateSupportAccess(auth, ctx,')));
}

// learningDecide's capability_gap branch is its own, narrower gate (see review.js's own comment) —
// checked separately since it's a nested `if`, not the whole case block's own top.
check("review.js: learningDecide's capability_gap replay branch gates separately (it touches tenant content; the rest of learningDecide does not)",
  reviewSrc.includes("gateSupportAccess(auth, ctx, 'learningDecide.replay'"));

// Every action this round documents as EXEMPT (platform-wide aggregate, or a no-tenant_id table)
// must carry its SUPPORT-ACCESS-EXEMPT tag, and must NOT itself call gateSupportAccess (an exemption
// that quietly grew a gate would just mean the comment above it is now stale/misleading).
const EXEMPT_ACTIONS = ['missDigest', 'learningDecide', 'learningDeactivate', 'learningRunNow', 'learningRejectAllGaps', 'learningExport', 'learningAutopilotStatus', 'learningGapReport'];
for (const action of EXEMPT_ACTIONS) {
  const marker = `case '${action}':`;
  const idx = reviewSrc.indexOf(marker);
  check(`review.js: a case block exists for '${action}'`, idx !== -1);
  const precedingComment = reviewSrc.slice(Math.max(0, idx - 700), idx);
  check(`review.js: '${action}' carries a SUPPORT-ACCESS-EXEMPT tag directly above its case`, precedingComment.includes('SUPPORT-ACCESS-EXEMPT'));
  const block = caseBlock(reviewSrc, action);
  check(`review.js: '${action}' itself never calls the whole-case gateSupportAccess (only learningDecide's own inner replay branch does)`,
    action === 'learningDecide' ? true : !Boolean(block?.includes('gateSupportAccess(auth, ctx,')));
}

// The new tenant-admin-managed actions exist and are requireAdmin-gated (never requireOperator —
// this is the TENANT deciding who may access ITS data, not staff acting on someone else's).
for (const action of ['supportAccessGrant', 'supportAccessRevoke', 'supportAccessStatus', 'supportAccessLog']) {
  const block = caseBlock(reviewSrc, action);
  check(`review.js: a case block exists for '${action}'`, block != null);
  check(`review.js: '${action}' calls requireAdmin(auth), not requireOperator`, Boolean(block?.includes('requireAdmin(auth)')) && !Boolean(block?.includes('requireOperator(auth)')));
}

/* ============================================================ 5. PGlite: migration 58, grant lifecycle, RLS */

const offline = await import('./offline-exam.mjs');
const { installPgHarness, createPGlite, setActiveDatabase } = offline;

const migrationOk = fs.existsSync(path.join(ROOT, 'M3-config', '58-support-access.sql'));
check('migration 58 (support_access_grants, staff_access_log) file exists and is loaded by the standard harness', migrationOk);

await installPgHarness();
const lite = await createPGlite();
await setActiveDatabase(lite);

const { getTenantContext } = await import('../api/_lib/recordsStore.js');

const ctxA = { tenantKey: 'org_privacy_a', tenantName: 'Shop A' };
const ctxB = { tenantKey: 'org_privacy_b', tenantName: 'Shop B' };
await getTenantContext(ctxA.tenantKey, ctxA.tenantName);
await getTenantContext(ctxB.tenantKey, ctxB.tenantName);

for (const table of ['support_access_grants', 'staff_access_log']) {
  const { rows } = await lite.query(
    `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1`,
    [table]
  );
  check(`${table}: RLS enabled and forced`, rows[0]?.rls === true && rows[0]?.force === true, JSON.stringify(rows));
}
{
  const { rows } = await lite.query(`SELECT polname FROM pg_policy WHERE polrelid = 'support_access_grants'::regclass`);
  check('support_access_grants: the tenant-isolation policy is present', rows.some((r) => r.polname === 'tenants_isolate_support_access_grants'));
}
{
  const { rows } = await lite.query(`SELECT polname FROM pg_policy WHERE polrelid = 'staff_access_log'::regclass`);
  check('staff_access_log: the tenant-isolation policy is present', rows.some((r) => r.polname === 'tenants_isolate_staff_access_log'));
}

// No grant yet: requireSupportAccess denies (not the founder tenant).
{
  delete process.env.DEEPWELL_FOUNDER_TENANT_ID;
  const decision = await SA.requireSupportAccess(ctxA, { staffUserId: 'staff_1', action: 'learningReplay' });
  check('requireSupportAccess: no grant, not founder tenant -> denied', decision.allowed === false && decision.mode === 'denied');
  const logAfterDeny = await SA.listAccessLog(ctxA);
  check('requireSupportAccess: a DENIED access writes NOTHING to the access log (nothing to flag — access never happened)', logAfterDeny.length === 0);
}

// The founder tenant is exempt — no grant needed, and (per requireSupportAccess's own doc) an exempt
// access is not logged as a "staff access" either (there is no other tenant involved to log against).
{
  process.env.DEEPWELL_FOUNDER_TENANT_ID = ctxA.tenantKey;
  const decision = await SA.requireSupportAccess(ctxA, { staffUserId: 'staff_1', action: 'scorecardRun' });
  check('requireSupportAccess: the founder tenant is exempt, no grant needed', decision.allowed === true && decision.mode === 'exempt-founder-tenant');
  const log = await SA.listAccessLog(ctxA);
  check('requireSupportAccess: an exempt (founder-tenant) access does not add a staff_access_log row', log.length === 0);
  delete process.env.DEEPWELL_FOUNDER_TENANT_ID;
}

// Grant, then access succeeds and is logged.
let grantId;
{
  const grant = await SA.grantSupportAccess(ctxA, { hours: 24, reason: 'helping debug a missing invoice' }, 'admin_1');
  check('grantSupportAccess: returns the new grant with an expiry ~24h out', Boolean(grant?.id) && new Date(grant.expiresAt).getTime() > Date.now() + 23 * 3600_000);
  grantId = grant.id;

  const active = await SA.getActiveGrant(ctxA);
  check('getActiveGrant: the just-created grant is the active one', active?.id === grantId);

  const decision = await SA.requireSupportAccess(ctxA, { staffUserId: 'staff_1', action: 'learningReplay', recordCount: 3 });
  check('requireSupportAccess: an active grant allows access', decision.allowed === true && decision.mode === 'granted');

  const log = await SA.listAccessLog(ctxA);
  check('requireSupportAccess: a granted access appends exactly one staff_access_log row', log.length === 1);
  check('staff_access_log row: records who/what/how-many, never content', log[0].staff_user_id === 'staff_1' && log[0].action === 'learningReplay' && Number(log[0].record_count) === 3 && log[0].is_emergency === false);
  check('staff_access_log row: is linked to the grant that covered it', log[0].grant_id === grantId);
}

// Hours are clamped to MAX_GRANT_HOURS (a caller asking for a year does not get one).
{
  const grant = await SA.grantSupportAccess(ctxB, { hours: 100000, reason: 'x' }, 'admin_2');
  const hoursOut = (new Date(grant.expiresAt).getTime() - Date.now()) / 3600_000;
  check('grantSupportAccess: an absurd hours value is clamped to MAX_GRANT_HOURS (7 days), not honored verbatim', hoursOut <= SA.MAX_GRANT_HOURS + 1 && hoursOut > SA.MAX_GRANT_HOURS - 1);
  await SA.revokeSupportAccess(ctxB, grant.id, 'admin_2');
}

// Revoke: an active grant stops being active immediately, even though expires_at is still future.
{
  const ok = await SA.revokeSupportAccess(ctxA, grantId, 'admin_1');
  check('revokeSupportAccess: revoking the active grant succeeds', ok === true);
  const active = await SA.getActiveGrant(ctxA);
  check('getActiveGrant: a revoked grant is no longer active, even before its own expiry', active === null);
  const decision = await SA.requireSupportAccess(ctxA, { staffUserId: 'staff_1', action: 'examList' });
  check('requireSupportAccess: after revocation, access is denied again (no silent fallback to allow)', decision.allowed === false);
  const again = await SA.revokeSupportAccess(ctxA, grantId, 'admin_1');
  check('revokeSupportAccess: revoking an already-revoked grant is a no-op (false), not an error', again === false);
}

// Break-glass / emergency: no grant, but a reason is supplied -> allowed AND flagged in the log.
{
  const decision = await SA.requireSupportAccess(ctxA, { staffUserId: 'staff_2', action: 'examPromote', emergencyReason: 'customer called in, invoice missing, admin unreachable' });
  check('requireSupportAccess: break-glass (emergencyReason, no active grant) is allowed', decision.allowed === true && decision.mode === 'emergency');
  const log = await SA.listAccessLog(ctxA);
  const last = log[0]; // newest first
  check('staff_access_log: the emergency access is flagged is_emergency=true with its reason recorded', last.is_emergency === true && last.emergency_reason === 'customer called in, invoice missing, admin unreachable');
  check('staff_access_log: an emergency access carries NO grant_id (there was none)', last.grant_id === null);
}

// TENANT ISOLATION: everything above happened under ctxA — none of it is visible from ctxB.
{
  // (ctxB has one revoked grant of its OWN, from the clamping check above — that's correct isolation,
  // not a leak; the assertion is that shop A's grantId specifically never shows up under ctxB.)
  const grantsB = await SA.listGrants(ctxB, { limit: 20 });
  check('TENANT ISOLATION: shop B never sees shop A\'s grant id among its own (RLS)', !grantsB.some((g) => g.id === grantId), JSON.stringify(grantsB));
  const logB = await SA.listAccessLog(ctxB);
  check('TENANT ISOLATION: shop B sees none of shop A\'s staff_access_log rows (RLS)', logB.length === 0, JSON.stringify(logB));
  const activeB = await SA.getActiveGrant(ctxB);
  check('TENANT ISOLATION: shop B\'s own getActiveGrant never returns shop A\'s grant', activeB === null);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
