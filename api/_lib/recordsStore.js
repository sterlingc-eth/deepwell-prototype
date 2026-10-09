/**
 * Postgres records store.
 *
 * Lives in api/_lib/ as plain JS on purpose. The previous implementation was
 * imported from ../src/services/postgresRecordsStore, outside the function's
 * own directory — Vercel bundles each function from its folder, so that module
 * was never shipped and every request died with ERR_MODULE_NOT_FOUND before a
 * line of handler code ran.
 *
 * Isolation model, matching M3-config/02-tenancy-fix.sql:
 *   - connect as a NON-OWNER role with NOBYPASSRLS (deepwell_rls)
 *   - every request runs in its own transaction
 *   - `SET LOCAL app.tenant_id` scopes RLS to that transaction only, so a warm
 *     serverless instance can never leak one request's tenant into the next
 *   - resolve_tenant() maps a Clerk org id (a string) to the tenant uuid; it is
 *     SECURITY DEFINER because the caller cannot read `tenants` until the
 *     context is set, which is the chicken-and-egg this solves
 *   - by-id reads and updates ALSO carry an explicit tenant predicate. RLS
 *     should make that redundant; it is here so a future `NO FORCE` or a
 *     platform role with BYPASSRLS cannot silently open a cross-tenant read.
 */
import { serializeClient, assertTenantUuid, isNonBlankId, explicitPgSsl } from './util/pgClient.js';
import pg from 'pg';
import { keyBelongsToTenant } from './r2.js';
import { DOCX_CONTENT_TYPE, XLSX_CONTENT_TYPE } from './uploadTypes.js';
import {
  ESTIMATE_DOCX_FIXED_BYTES, ESTIMATE_DOCX_BYTES_PER_PAGE, ESTIMATE_XLSX_FIXED_BYTES, ESTIMATE_XLSX_BYTES_PER_PAGE, ESTIMATE_CSV_BYTES_PER_PAGE, ESTIMATE_DOCX_MAX_PAGES, ESTIMATE_SHEET_MAX_PAGES,
} from './office/limits.js';
import { staffImportWindowFor, noteDatabaseClock } from './staffImport.js';
import {
  customerMatchScore, CUSTOMER_MATCH_THRESHOLD, normalizeSurname, normalizeAddressKey, normalizeUnitKey,
  addressOnlyCustomerName, isAddressOnlyCustomer, isLikelyShopAddress, houseNumberOf,
  normalizePhoneKey, normalizeEmailKey, compareNamesStrict, chooseUpgradedCustomerName,
  extractNameMention, matchNameMention,
} from './integrity.js';
import { TTLCache, memoAsync, logStage, registerTenantCache, bustTenantCaches } from './perf.js';
// Search by meaning (api/_lib/search/*): inert unless VOYAGE_API_KEY is set and M3-config/31 has run.
import { startSemantic, keywordCandidateLimit, finishHybrid } from './search/hybrid.js';
// Records Browse (round 12, G2): read-only reuse of the financials layer's own
// "is the table there yet" probe, so browseDocuments never needs a second copy
// of that memoization — see financials/store.js's own doc comment.
import { financialsTableExists } from './financials/store.js';
// Records Browse audience filter chip (round 18, part 2, owner ask (a)): leaf probe only (see
// audience/probe.js's own header on why this imports THAT file and never audience/store.js).
import { documentsHaveAudience } from './audience/probe.js';
import { AUDIENCE_FALLBACK_FIELD_KEY } from './audience/sql.js';
// Round 22 (S2, privacy): the skip-shop-address log below used to print the raw tenant id and a
// normalized ADDRESS out of the request — a real (if the shop's own) street address — into the log.
import { hashForLog } from './privacy/redact.js';

let pool;

/**
 * EXPORTED (scale-readiness build, 2026-09): members.js, opsStore.js,
 * reviewStore.js and apiKeyAuth.js used to each open their own single-purpose
 * pg.Pool against this same NEON_CONNECTION_STRING / deepwell_rls role —
 * every one of them said so in its own header, and each was right that this
 * module's `withTenant()` had no way to hand them a raw client. It does now:
 * this is that raw client's pool, exported so those four files can open
 * connections through it directly instead of maintaining four more copies of
 * the same pg.Pool setup. They still run their own BEGIN/resolve_tenant/
 * SET LOCAL/COMMIT dance on whatever client they check out — that transaction
 * and RLS-scoping logic is unchanged and does not belong here — this only
 * removes the redundant pools underneath it.
 *
 * `max` raised 3 -> 5 for exactly this reason: one instance's connection
 * budget used to be spread across up to five separate pools (this one at 3,
 * plus opsStore's 2, reviewStore's 3, members' 1, apiKeyAuth's 2 — as many as
 * 11 connections from one warm instance), each capped low specifically
 * because each was "supposedly small". Consolidated onto one pool, 5 is
 * fewer total connections than before, not more, while still leaving several
 * of those old call sites able to check out a connection without waiting on
 * each other. Still well under Neon's pooler limits for a single instance.
 */
/**
 * API_PERF_2026-09-22: warn ONCE per warm instance if NEON_CONNECTION_STRING
 * doesn't look like Neon's pooled (PgBouncer, "-pooler") endpoint. Reads only
 * whether the env var's hostname CONTAINS "-pooler" — never logs the value
 * itself (host, credentials, or otherwise). A direct (non-pooled) endpoint
 * caps out around 100 concurrent Postgres connections per Neon's own docs;
 * the pooled endpoint multiplexes thousands, which matters far more under
 * Fluid compute (many concurrent invocations per warm instance, each wanting
 * a connection from this one pool) than the pool's own `max` does. This is a
 * warning, not an enforcement — a self-hosted/non-Neon Postgres URL would
 * never match "-pooler" and should not be treated as misconfigured.
 */
function warnIfNotPooledHost(connectionString) {
  try {
    const host = new URL(connectionString).hostname;
    if (host && !host.includes('-pooler')) {
      console.warn(
        'recordsStore: NEON_CONNECTION_STRING does not look like Neon\'s pooled endpoint ' +
        '(hostname has no "-pooler" segment). See handoffs/API_PERF_2026-09-22.md — pasting ' +
        "Neon's pooled connection string (same dashboard page as the direct one) usually cuts " +
        'connection setup latency under serverless load. Not logged: the value itself.'
      );
    }
  } catch {
    /* not a parseable URL (e.g. a non-standard DSN) — nothing to warn about */
  }
}

export function getPool() {
  if (!pool) {
    const connectionString = process.env.NEON_CONNECTION_STRING;
    if (!connectionString) throw new Error('NEON_CONNECTION_STRING is not set');
    warnIfNotPooledHost(connectionString);
    // Explicit verify-full-equivalent ssl (no behavior change, no pg SECURITY WARNING) — see explicitPgSsl.
    const { connectionString: pgConnectionString, ssl } = explicitPgSsl(connectionString);
    pool = new pg.Pool({
      connectionString: pgConnectionString,
      ...(ssl ? { ssl } : {}),
      // 3 (Reviewer NO-GO, 2026-09-22 — was 10, and 5 before that). CAUTION,
      // read before changing again: this was raised to 10 on 2026-09-20
      // after 5 was exhausted under one user's UI polling + one Ask under
      // Fluid compute, which funnels MANY concurrent requests through a
      // single warm instance — that incident is real and this file's history
      // says so. Lowered back down now on the reasoning that this same
      // 2026-09-22 change cut the sequential-query count (and therefore the
      // time each request holds a connection) on every endpoint it touched —
      // see handoffs/API_PERF_2026-09-22.md — so 3 concurrent connections go
      // further than they used to. If "timeout exceeded when trying to
      // connect" reappears in Vercel logs, that reasoning was wrong for this
      // traffic pattern; raise PG_POOL_MAX (env override, no code change)
      // before assuming anything else is broken.
      max: Number(process.env.PG_POOL_MAX) || 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      // API_PERF_2026-09-22: reuse TCP connections across requests on a warm
      // instance instead of renegotiating (and re-TLS-handshaking) one per
      // checkout. Cheap and safe — pg/node's default is `false`.
      keepAlive: true,
      keepAliveInitialDelayMillis: 5_000,
    });
    // R35: an IDLE pooled connection that the server drops (Neon suspending the compute, a pooler restart, a network
    // blip) emits 'error' on the pool. With no listener, Node treats that as an uncaught exception and kills the warm
    // instance - every request in flight on it fails with FUNCTION_INVOCATION_FAILED. The pool already discards the dead
    // client; all that is needed is to say so, once, and carry on.
    pool.on('error', (err) => {
      console.error('recordsStore: idle Postgres connection error (the pool drops it and reconnects):', err?.code ?? '', err?.message);
    });
  }
  return pool;
}

/**
 * API_PERF_2026-09-22: tenant identity + billing/plan lookup, cached per
 * warm instance so the request path that used to run resolve_tenant() (in
 * withTenant, below) AND get_tenant_limits() (rateLimit.js) AND a raw
 * `tenants` row SELECT (plan.js, upload-url.js) as three-plus separate
 * round trips now runs at most one query, and typically zero once warm.
 *
 * 5-minute TTL: a tenant's uuid never changes once minted, so that part is
 * safe to cache indefinitely, but this same entry also carries plan/limits,
 * which DO change (a Stripe webhook can flip them at any moment) — 5 minutes
 * bounds that staleness for plan/limits. Billing-STATUS-driven gating
 * ('none'/'canceled' must flip fast) is deliberately NOT read from this
 * cache — see plan.js's own, shorter-TTL cache for that decision.
 *
 * Falls back to the pre-existing three-query path (resolve_tenant, then a
 * plain SELECT, then get_tenant_limits) when M3-config/27-request-context.sql
 * has not been pasted yet (function undefined, Postgres error 42883) — same
 * "degrade, don't break" contract as documentsHaveUpdatedAt/
 * extractionsHaveUnitIndex above.
 */
export const TENANT_CONTEXT_TTL_MS = 5 * 60_000;
const tenantContextCache = new TTLCache(TENANT_CONTEXT_TTL_MS, 1000);
registerTenantCache(tenantContextCache);

/**
 * uuid -> tenantKey, populated every time fetchRequestContextRow resolves a
 * tenant (below). Exists ONLY so bustTenantCache() can translate the uuid a
 * Stripe webhook has (billing_tenant_by_customer() returns a uuid, never a
 * tenantKey) into the string every per-tenant cache is actually keyed by. Same
 * TTL/bound as tenantContextCache itself — a mapping this instance never
 * learned, or has forgotten, simply means there is nothing on this instance
 * to bust, which is a correct no-op (see bustTenantCache's own comment).
 */
const uuidToTenantKey = new TTLCache(TENANT_CONTEXT_TTL_MS, 1000);

/** Pure: is this the Postgres "undefined_function" error — i.e. is
 *  M3-config/27-request-context.sql simply not pasted into this database yet,
 *  as opposed to a real failure get_request_context() should surface? Split
 *  out so scripts/verify-perf.mjs can assert the exact fallback condition
 *  with a fabricated error object, no database required. */
export function isUndefinedFunctionError(err) {
  return err?.code === '42883';
}

/** null = not yet probed; true/false once known. Same memoization pattern as documentsHaveUpdatedAt. */
let requestContextFnExists = null;

async function fetchRequestContextRow(tenantKey, tenantName) {
  if (requestContextFnExists !== false) {
    try {
      // R43: now() rides along so every staff-import decision uses the DATABASE's clock (staffImport.js noteDatabaseClock).
      const { rows } = await getPool().query('SELECT *, now() AS db_now FROM get_request_context($1, $2)', [tenantKey, tenantName]);
      requestContextFnExists = true;
      const row = rows[0];
      if (row) noteDatabaseClock(row.db_now);
      // Empty/absent id (function returned no row, or a blank id): never hand
      // it to a caller that will feed it to SQL as a uuid — take the
      // multi-query path below, which validates the id itself.
      if (row && isNonBlankId(row.tenant_id)) {
        return {
          id: row.tenant_id,
          plan: row.plan ?? null,
          billingStatus: row.billing_status ?? null,
          trialEndsAt: row.trial_ends_at ?? null,
          currentPeriodEnd: row.current_period_end ?? null,
          limits: row.limits ?? {},
        };
      }
    } catch (err) {
      if (isUndefinedFunctionError(err)) {
        // undefined_function — migration 27 not pasted yet. Fall through to
        // the old multi-query path below, and stop trying the fast path
        // until the next cold start (re-probing every call would cost a
        // failed round trip every time, forever, on a database that never
        // gets the migration).
        requestContextFnExists = false;
      } else {
        throw err;
      }
    }
  }

  // Fallback: the exact calls this replaces. resolve_tenant / get_tenant_limits
  // are SECURITY DEFINER and safe on a bare pool connection; the billing row
  // is NOT — `tenants` has FORCE ROW LEVEL SECURITY, so it must be read inside
  // a transaction with app.tenant_id SET LOCAL exactly as withTenant does
  // (PRODUCTION INCIDENT 2026-09-22: reading it on a bare connection threw on
  // every request — RLS's current_setting('app.tenant_id')::uuid cast on an
  // empty/absent GUC — and took every endpoint down with a 500).
  const { rows: idRows } = await getPool().query('SELECT resolve_tenant($1, $2) AS id', [tenantKey, tenantName]);
  const id = assertTenantUuid(idRows[0]?.id);
  const { rows: lRows } = await getPool().query('SELECT get_tenant_limits($1) AS limits', [id]);
  let t = {};
  const client = serializeClient(await getPool().connect());
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [assertTenantUuid(id)]);
    const { rows: tRows } = await client.query(
      'SELECT plan, billing_status, trial_ends_at, current_period_end, now() AS db_now FROM tenants WHERE id = $1',
      [id]
    );
    await client.query('COMMIT');
    t = tRows[0] ?? {};
    noteDatabaseClock(t.db_now);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return {
    id,
    plan: t.plan ?? null,
    billingStatus: t.billing_status ?? null,
    trialEndsAt: t.trial_ends_at ?? null,
    currentPeriodEnd: t.current_period_end ?? null,
    limits: lRows[0]?.limits ?? {},
  };
}

/**
 * Cached tenant context for a request. Exported for rateLimit.js and
 * plan.js, so all three files share ONE cache entry (and one cache miss
 * query) per tenant instead of three separate caches disagreeing about
 * freshness.
 * @param {string} tenantKey
 * @param {string} [tenantName]
 * @returns {Promise<{id: string, plan: string|null, billingStatus: string|null, trialEndsAt: *, currentPeriodEnd: *, limits: object}>}
 */
export async function getTenantContext(tenantKey, tenantName) {
  // An empty/whitespace/non-string key must never reach SQL (or the cache): it
  // used to surface as `invalid input syntax for type uuid: ""` 500s. A clean
  // 401 (handlers honor err.status) is the honest answer — there is no tenant.
  if (!isNonBlankId(tenantKey)) {
    const err = new Error('Sign in required');
    err.status = 401;
    err.code = 'NO_TENANT';
    throw err;
  }
  const start = Date.now();
  const cacheKeyBefore = tenantContextCache.get(tenantKey) !== undefined;
  const result = await memoAsync(
    tenantContextCache,
    tenantKey,
    () => fetchRequestContextRow(tenantKey, isNonBlankId(tenantName) ? tenantName : tenantKey),
    TENANT_CONTEXT_TTL_MS
  );
  // Learn the uuid<->tenantKey mapping every time — see uuidToTenantKey's own
  // comment above — so a later bustTenantCache(uuid) on this instance can
  // find the tenantKey every OTHER cache is actually keyed by.
  if (result?.id) uuidToTenantKey.set(result.id, tenantKey);
  logStage({ t: 'tenant_context', ms: Date.now() - start, cacheHit: cacheKeyBefore });
  return result;
}

/**
 * Clear one tenant's entry out of EVERY registered per-tenant cache
 * (tenantContextCache here, plan.js's billingRowCache, and any future one)
 * on THIS warm instance. Call this the moment a tenant's billing/plan state
 * changes server-side — today, api/billing.js's webhook handler, right after
 * `billing_apply()` commits. See perf.js's bustTenantCaches for the
 * same-instance-only scope and why that's still correct.
 * @param {string|null|undefined} tenantKeyOrUuid  either the tenantKey
 *   (Clerk org id / `user_<id>`) or the tenant's uuid — whichever the caller
 *   has on hand. A webhook only ever has the uuid; everything else in this
 *   codebase has the tenantKey.
 */
export function bustTenantCache(tenantKeyOrUuid) {
  bustTenantCaches(tenantKeyOrUuid, uuidToTenantKey);
}

/**
 * H-4: has M3-config/67 (page_usage_monthly + its read helpers) been run? Same migration-tolerance contract as
 * financialsTableExists: to_regclass()/to_regproc() are catalogue reads that cannot abort the transaction (a failed SELECT
 * would), a positive answer is remembered for the life of the warm instance, a negative one is re-checked every 20 s so
 * pasting the migration takes effect without a redeploy. A transient failure is never remembered and means "not ready" (the
 * live count is used, exactly as before the migration).
 * @param {(sql: string, params?: any[]) => Promise<{rows: any[]}>} q
 */
let pageCounterKnown = null; // true | {falseUntil: number}
const PAGE_COUNTER_NEGATIVE_TTL_MS = 20_000;
export async function pageCounterReady(q) {
  if (pageCounterKnown === true) return true;
  if (pageCounterKnown && pageCounterKnown.falseUntil > Date.now()) return false;
  try {
    const r = await q(
      `SELECT (to_regclass('public.page_usage_monthly') IS NOT NULL
               AND to_regprocedure('public.page_usage_current_month()') IS NOT NULL
               AND to_regprocedure('public.page_usage_months(date,date)') IS NOT NULL) AS ok`, []
    );
    const ok = r.rows?.[0]?.ok === true;
    pageCounterKnown = ok ? true : { falseUntil: Date.now() + PAGE_COUNTER_NEGATIVE_TTL_MS };
    return ok;
  } catch {
    return false;
  }
}
/** Test-only: forget what pageCounterReady learned. */
export function _resetPageCounterProbe() { pageCounterKnown = null; }

/** Test-only: clear the tenant context cache between fixtures. */
export function _resetTenantContextCache() {
  tenantContextCache.map.clear();
  uuidToTenantKey.map.clear();
  requestContextFnExists = null;
}

const TENANT = 'tenant_id = (current_setting(\'app.tenant_id\', true))::uuid';

/* ============================================================================
 * RECORDS BROWSE (round 12 contract) — server-side filter/sort/paging/search/
 * facets behind the records screen, replacing listDocuments' LIMIT 500 with
 * real (offset) cursor paging. See browseDocuments() below for the DB half;
 * everything in this section is pure — no db, no I/O — so it's directly
 * testable from scripts/verify-records-browse.mjs with no database.
 *
 * Data model this queries against (no new tables):
 *   - documents            — the row itself (filename, type, stage, dates).
 *   - document_entity_links -> entities — a document's linked customer
 *     (name + service_address) and equipment (manufacturer/"brand" +
 *     warranty.expires). There is no separate 'property' or 'technician'
 *     entity in this schema (see BrowseScreen.tsx's Kind comment) — "site" is
 *     the linked customer's (falling back to a linked equipment's own)
 *     service_address, and "technician" is the extracted field below, not a
 *     linked record.
 *   - extractions           — field_key = 'service_date' | 'technician'
 *     (extractFields.js), highest-confidence value per document.
 *   - document_financials   — amount/status/balance, LEFT JOINed (M3-config/22,
 *     may not exist — see documentsHaveFinancials-style guards elsewhere;
 *     browseDocuments probes it the same way).
 *
 * A document linked to more than one equipment unit (a multi-unit service
 * ticket) picks an arbitrary one for brand/warranty via MAX() — a browse
 * list's job is to help a person FIND the document, not stand in for its
 * full detail view.
 * ============================================================================ */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Sort id -> {expr, dir}. `expr` is a column on the `base` CTE (see
 *  sharedBrowseCtes below), never user input — safe to embed literally. */
export const BROWSE_SORTS = {
  'service-date': { expr: 'service_date', dir: 'DESC' },
  'upload-date': { expr: 'created_at', dir: 'DESC' },
  customer: { expr: 'customer_name', dir: 'ASC' },
  type: { expr: 'document_type', dir: 'ASC' },
  amount: { expr: 'amount', dir: 'DESC' },
};
export const DEFAULT_BROWSE_SORT = 'upload-date';

export const STAGE_BUCKETS = ['verified', 'needs-review', 'missing-info'];
export const WARRANTY_BUCKETS = ['expired', 'expiring', 'active', 'unknown'];

/** Same "verified / needs a person" split as isAttention (ReviewScreen.tsx),
 *  expressed from server-only signals — there is no server-side `issues`
 *  computation (that's a client graph derivation), so this is a deliberately
 *  simpler, DB-native approximation: nothing extracted yet (or never
 *  classified) is 'missing-info'; anything short of verified beyond that is
 *  'needs-review'. Safe to embed literally: no user input inside it. */
const STAGE_BUCKET_CASE = `
  CASE
    WHEN d.stage = 'verified' THEN 'verified'
    WHEN d.stage = 'received' OR d.document_type IS NULL THEN 'missing-info'
    ELSE 'needs-review'
  END`;

/** TEXT comparison against ISO 'YYYY-MM-DD' strings (not a ::date cast) —
 *  same "never let one malformed value 500 the whole list" rule as
 *  listWarrantyAttention above; lexicographic order matches chronological
 *  order for zero-padded ISO dates. $1/$2 are always today / today+90d,
 *  reserved at the front of every browse query's param list (see
 *  renderBrowseFragments). */
const WARRANTY_BUCKET_CASE = `
  CASE
    WHEN linked.warranty_expiry IS NULL THEN 'unknown'
    WHEN linked.warranty_expiry < $1 THEN 'expired'
    WHEN linked.warranty_expiry <= $2 THEN 'expiring'
    ELSE 'active'
  END`;

/** Round 18, part 2 (owner ask (a)): the browse query's own audience expression — `d.audience`
 *  once M3-config/57 is pasted (probed once via documentsHaveAudience, same "detect, don't
 *  assume" contract as every other optional column here), else the pre-migration fallback
 *  (`fields.audience_fallback`, the newest '_audience' extractions row for this document — see
 *  the `fields` CTE below and audience/sql.js's own AUDIENCE_FALLBACK_FIELD_KEY). Safe to embed
 *  literally: `hasAudienceColumn` is a boolean this file computed itself, never user input — same
 *  trust model as STAGE_BUCKET_CASE/WARRANTY_BUCKET_CASE above. */
const AUDIENCE_EXPR = (hasAudienceColumn) => (hasAudienceColumn ? "COALESCE(d.audience, 'customer')" : "COALESCE(fields.audience_fallback, 'customer')");

/** today+days as an ISO 'YYYY-MM-DD' string, UTC — pure, so a fixed `today`
 *  makes every bucket boundary reproducible in tests. */
export function isoPlusDays(todayIso, days) {
  const d = new Date(`${todayIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Whitelists/validates raw filter input into a clean, DB-safe shape. Never
 * trusts a caller-supplied enum value into SQL text (every value below is
 * only ever used as a bound $n parameter — see renderBrowseFragments/
 * buildBrowseFragments) — this function's job is predictable behavior (a
 * bogus value is dropped, not a crash), not injection safety, which comes
 * from parameterization regardless of what passes through here.
 */
export function normalizeBrowseFilters(raw = {}) {
  const f = {};
  const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const bool = (v) => (v === true ? true : v === false ? false : null);
  const isoDate = (v) => (typeof v === 'string' && ISO_DATE_RE.test(v) ? v : null);

  f.documentType = str(raw.documentType);
  f.customerId = str(raw.customerId, 100);
  f.site = str(raw.site, 300);
  f.technician = str(raw.technician, 200);
  f.brand = str(raw.brand, 200);
  f.stageBucket = STAGE_BUCKETS.includes(raw.stageBucket) ? raw.stageBucket : null;
  f.warrantyBucket = WARRANTY_BUCKETS.includes(raw.warrantyBucket) ? raw.warrantyBucket : null;
  f.hasMoney = bool(raw.hasMoney);
  f.openBalance = bool(raw.openBalance);
  f.uploadedByMe = raw.uploadedByMe === true ? true : null;
  // Round 18, part 2 (owner ask (a)): the records browser's audience chip. 'customer' is the
  // default (matches the chip's own default state) so an omitted/invalid value never accidentally
  // surfaces internal (tech-only) documents in a plain, unfiltered browse.
  f.audience = ['customer', 'internal', 'all'].includes(raw.audience) ? raw.audience : 'customer';
  f.serviceDateFrom = isoDate(raw.serviceDateFrom);
  f.serviceDateTo = isoDate(raw.serviceDateTo);
  f.uploadDateFrom = isoDate(raw.uploadDateFrom);
  f.uploadDateTo = isoDate(raw.uploadDateTo);
  f.q = str(raw.q, 200);
  f.sort = Object.prototype.hasOwnProperty.call(BROWSE_SORTS, raw.sort) ? raw.sort : DEFAULT_BROWSE_SORT;
  f.limit = Number.isFinite(Number(raw.limit)) && Number(raw.limit) >= 1 ? Math.min(Math.trunc(Number(raw.limit)), 200) : 50;
  f.cursor = typeof raw.cursor === 'string' && raw.cursor ? raw.cursor : null;
  return f;
}

/** Stable string key for a normalized filters+sort combo — used to detect a
 *  cursor being replayed against a DIFFERENT filter/sort (stale tab, edited
 *  URL); a mismatch just restarts at offset 0 rather than returning a
 *  confusing page. Not a security boundary — just a "did the query change"
 *  check, so a plain sorted JSON string is enough. Excludes `limit` (a page
 *  size change shouldn't invalidate a cursor) and `cursor` itself. */
export function browseFiltersKey(filters) {
  const { limit: _limit, cursor: _cursor, ...rest } = filters;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

export function encodeBrowseCursor(offset, filtersKey) {
  return Buffer.from(JSON.stringify({ o: offset, f: filtersKey }), 'utf8').toString('base64url');
}

/** Returns the offset to resume at, or 0 if the cursor is missing, malformed,
 *  or was minted for a different filters/sort combination. */
export function decodeBrowseCursor(cursor, filtersKey) {
  if (typeof cursor !== 'string' || !cursor) return 0;
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Number.isInteger(obj?.o) && obj.o >= 0 && obj.f === filtersKey) return obj.o;
  } catch {
    /* fall through */
  }
  return 0;
}

/**
 * R36: keyset cursor for the default (newest-first) sort. Offset paging made page N cost N rows; this resumes from
 * (created_at, id) of the last row served. `k` is [created_at as full-precision text, id], `t` the total counted when the
 * browse started (so a "load more" never recounts). Falls back to "no keyset" (null) on anything malformed or minted for a
 * different filters/sort combination, exactly like decodeBrowseCursor.
 */
export function encodeBrowseKeysetCursor(createdAtText, id, filtersKey, total) {
  return Buffer.from(JSON.stringify({ k: [createdAtText, id], f: filtersKey, t: total }), 'utf8').toString('base64url');
}
const KEYSET_TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;
const KEYSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function decodeBrowseKeysetCursor(cursor, filtersKey) {
  if (typeof cursor !== 'string' || !cursor) return null;
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (obj?.f !== filtersKey || !Array.isArray(obj.k) || obj.k.length !== 2) return null;
    const [ts, id] = obj.k;
    if (typeof ts !== 'string' || !KEYSET_TS_RE.test(ts) || typeof id !== 'string' || !KEYSET_ID_RE.test(id)) return null;
    const t = Number.isInteger(obj.t) && obj.t >= 0 ? obj.t : null;
    return { ts, id, total: t };
  } catch {
    return null;
  }
}

/** Filter dimensions that read only `documents` columns (so a page and its total can be answered from `documents` alone,
 *  with no per-document joins). Everything else needs the linked customer / extracted fields / financials. */
const BROWSE_DOC_LOCAL_DIMS = new Set(['documentType', 'stageBucket', 'uploadedByMe', 'uploadDateFrom', 'uploadDateTo', 'q']);

/**
 * One WHERE fragment, keyed by the filter dimension it came from so a facet
 * count for that SAME dimension can be computed with every filter EXCEPT it
 * (so picking "Invoice" never makes "Invoice" disappear from the Type
 * facet's own options). `template` uses `??` placeholders, filled in order
 * from `values` — see renderBrowseFragments.
 */
function buildBrowseFragments(f, hasDisplayName, hasFinancials, hasAudienceColumn, searchFn = false) {
  const frags = [];
  const add = (dim, template, ...values) => frags.push({ dim, template, values });

  // Round 18, part 2 (owner ask (a)): 'all' means no restriction at all (the exact same "no
  // fragment for this dimension" idiom every other filter here already uses when unset).
  if (f.audience !== 'all') add('audience', `(${AUDIENCE_EXPR(hasAudienceColumn)}) = ??`, f.audience);
  if (f.documentType) add('documentType', 'd.document_type = ??', f.documentType);
  if (f.stageBucket) add('stageBucket', `(${STAGE_BUCKET_CASE}) = ??`, f.stageBucket);
  if (f.warrantyBucket) add('warrantyBucket', `(${WARRANTY_BUCKET_CASE}) = ??`, f.warrantyBucket);
  if (f.customerId) add('customerId', 'linked.customer_id = ??', f.customerId);
  if (f.site) add('site', 'linked.site_address = ??', f.site);
  if (f.technician) add('technician', 'fields.technician_name = ??', f.technician);
  if (f.brand) add('brand', 'linked.brand = ??', f.brand);
  // document_financials (M3-config/22) may not exist yet — these two filters
  // degrade to "not offered" rather than a 42P01 on a database that hasn't
  // pasted that migration (see hasFinancials below and financialsTableExists).
  if (hasFinancials && f.hasMoney !== null) add('hasMoney', '(df.id IS NOT NULL) = ??', f.hasMoney);
  if (hasFinancials && f.openBalance !== null) add('openBalance', '(COALESCE(df.balance_due, 0) > 0) = ??', f.openBalance);
  if (f.uploadedByMe && f.currentUserId) add('uploadedByMe', 'd.uploaded_by = ??', f.currentUserId);
  if (f.serviceDateFrom) add('serviceDateFrom', 'fields.service_date >= ??', f.serviceDateFrom);
  if (f.serviceDateTo) add('serviceDateTo', 'fields.service_date <= ??', f.serviceDateTo);
  if (f.uploadDateFrom) add('uploadDateFrom', 'd.created_at::date >= ??::date', f.uploadDateFrom);
  if (f.uploadDateTo) add('uploadDateTo', 'd.created_at::date <= ??::date', f.uploadDateTo);
  if (f.q) {
    // R36: search is a CANDIDATE set (document ids) built from index-friendly arms and then joined, instead of an OR of
    // ILIKEs over the per-document aggregates (which forced every document's customer / fields to be computed before a
    // single row could be tested: 7.5 s at 50,000 documents). Arms, each tenant-scoped:
    //   1. the file name / display name (trigram indexes, M3-config/41 + 42)
    //   2. a linked customer's name or address, a linked unit's address or manufacturer (trigram expression indexes,
    //      M3-config/64 - the query is correct without them, only slower)
    //   3. the technician an extraction read off the document (extractions_tenant_value_trgm_idx, M3-config/17)
    //   4. words in the page text (document_pages_tenant_tsv_idx, M3-config/17)
    // A document linked to two customers now matches on either (the old test only looked at one of them).
    const like = `%${f.q}%`;
    const T = (alias) => TENANT.replace('tenant_id', `${alias}.tenant_id`);
    const arms = [];
    const vals = [];
    arms.push(`SELECT x.id FROM documents x WHERE ${T('x')} AND (x.original_filename ILIKE ??${hasDisplayName ? ' OR x.display_name ILIKE ??' : ''})`);
    vals.push(like, ...(hasDisplayName ? [like] : []));
    arms.push(`SELECT del.document_id AS id FROM entities e JOIN document_entity_links del ON del.entity_id = e.id AND ${T('del')}
        WHERE ${T('e')} AND e.merged_into IS NULL
          AND (e.data->>'customer_name' ILIKE ?? OR e.data->>'service_address' ILIKE ?? OR e.data->>'manufacturer' ILIKE ??)`);
    vals.push(like, like, like);
    arms.push(`SELECT x.document_id AS id FROM extractions x WHERE ${T('x')} AND x.field_key = 'technician' AND x.value ILIKE ??`);
    vals.push(like);
    arms.push(`SELECT x.document_id AS id FROM document_pages x WHERE ${T('x')} AND x.tsv @@ websearch_to_tsquery('english', ??)`);
    vals.push(f.q);
    // R36 (RLS): the app's database role is subject to row-level security, and Postgres will not push an operator that is
    // not "leakproof" (ILIKE, tsvector @@) into an index scan under a row-security policy: the same arms ran as sequential
    // scans of documents / entities / document_pages. M3-config/64 therefore also installs records_search_candidates(), a
    // SECURITY DEFINER function that runs these four arms with an explicit tenant predicate (so the indexes are usable).
    // Used when it exists; the inline arms above are the fallback, and the "walk" form below needs neither.
    const T2 = (alias) => TENANT.replace('tenant_id', `${alias}.tenant_id`);
    const walk = {
      template: `(d.original_filename ILIKE ??${hasDisplayName ? ' OR d.display_name ILIKE ??' : ''}
        OR EXISTS (SELECT 1 FROM document_entity_links wl JOIN entities we ON we.id = wl.entity_id AND ${T2('we')} AND we.merged_into IS NULL
                    WHERE wl.document_id = d.id AND ${T2('wl')}
                      AND (we.data->>'customer_name' ILIKE ?? OR we.data->>'service_address' ILIKE ?? OR we.data->>'manufacturer' ILIKE ??))
        OR EXISTS (SELECT 1 FROM extractions wx WHERE wx.document_id = d.id AND ${T2('wx')} AND wx.field_key = 'technician' AND wx.value ILIKE ??)
        OR EXISTS (SELECT 1 FROM document_pages wp WHERE wp.document_id = d.id AND ${T2('wp')} AND wp.tsv @@ websearch_to_tsquery('english', ??)))`,
      values: [like, ...(hasDisplayName ? [like] : []), like, like, like, like, f.q],
    };
    if (searchFn && hasDisplayName) {
      frags.push({ dim: 'q', template: 'SELECT c.id FROM records_search_candidates(??, ??) AS c(id)', values: [like, f.q], candidate: true, walk });
    } else {
      frags.push({ dim: 'q', template: arms.join('\n        UNION\n        '), values: vals, candidate: true, walk });
    }
  }
  return frags;
}

/** Renders a subset of fragments (already excluding whichever dim a facet
 *  count is being computed for) into one WHERE-safe SQL string plus its OWN
 *  freshly-numbered params array — `baseParams` (today/today+90d, always)
 *  come first so $1/$2 stay stable across every query variant. */
function renderBrowseFragments(fragments, baseParams, { walk = false } = {}) {
  const params = [...baseParams];
  let candidateSql = null;
  const clauses = fragments.map((f) => {
    let i = 0;
    const useWalk = walk && f.candidate && f.walk;
    const vals = useWalk ? f.walk.values : f.values;
    const rendered = (useWalk ? f.walk.template : f.template).replace(/\?\?/g, () => {
      params.push(vals[i++]);
      return `$${params.length}`;
    });
    if (useWalk) return rendered; // the search as a per-document test (no candidate set): see browsePageSelect's `window`
    if (!f.candidate) return rendered;
    // R36: the search candidate set is its own MATERIALIZED CTE (`cand`) so the other CTEs can be restricted to it.
    candidateSql = rendered;
    return 'd.id IN (SELECT id FROM cand)';
  });
  return { sql: clauses.length ? clauses.join(' AND ') : 'TRUE', params, clauses, candidateSql };
}

/** The columns of one browse row (the `base` of every browse query). Shared by the CTE form (sharedBrowseCtes) and the
 *  per-page form (browsePageSelect) so the two can never drift apart. */
function browseBaseColumns(hasDisplayName, hasFinancials, hasAudienceColumn) {
  return `d.id, d.original_filename,
             ${hasDisplayName ? 'd.display_name' : 'NULL::text AS display_name'},
             d.document_type, d.stage, d.created_at, d.created_at::text AS created_at_raw, d.verified_by, d.uploaded_by,
             linked.customer_id, linked.customer_name, linked.site_address, linked.brand, linked.warranty_expiry,
             fields.service_date, fields.technician_name,
             (${AUDIENCE_EXPR(hasAudienceColumn)}) AS audience,
             ${hasFinancials
               ? "df.total AS amount, df.balance_due, df.status AS money_status, (df.id IS NOT NULL) AS has_money,"
               : 'NULL::numeric AS amount, NULL::numeric AS balance_due, NULL::text AS money_status, FALSE AS has_money,'}
             (${STAGE_BUCKET_CASE}) AS stage_bucket,
             (${WARRANTY_BUCKET_CASE}) AS warranty_bucket`;
}

/** The two per-document sub-selects, correlated on `d` (LATERAL) - the per-page form computes them only for the rows
 *  of the page it is about to return. Same output columns as the grouped `linked` / `fields` CTEs. */
function browseLateralJoins(hasAudienceColumn) {
  return `LEFT JOIN LATERAL (
        SELECT MAX(CASE WHEN e.entity_type = 'customer' THEN e.id::text END) AS customer_id,
               MAX(CASE WHEN e.entity_type = 'customer' THEN e.data->>'customer_name' END) AS customer_name,
               COALESCE(
                 MAX(CASE WHEN e.entity_type = 'customer' THEN e.data->>'service_address' END),
                 MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->>'service_address' END)
               ) AS site_address,
               MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->>'manufacturer' END) AS brand,
               MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->'warranty'->>'expires' END) AS warranty_expiry
          FROM document_entity_links del
          JOIN entities e ON e.id = del.entity_id AND ${TENANT.replace('tenant_id', 'e.tenant_id')} AND e.merged_into IS NULL
         WHERE del.document_id = d.id AND ${TENANT.replace('tenant_id', 'del.tenant_id')}
      ) linked ON TRUE
      LEFT JOIN LATERAL (
        SELECT MAX(value) FILTER (WHERE field_key = 'service_date') AS service_date,
               MAX(value) FILTER (WHERE field_key = 'technician') AS technician_name,
               ${hasAudienceColumn
                 ? 'NULL::text AS audience_fallback'
                 : `MAX(value) FILTER (WHERE field_key = '${AUDIENCE_FALLBACK_FIELD_KEY}') AS audience_fallback`}
          FROM (
            SELECT DISTINCT ON (field_key) field_key, value
              FROM extractions
             WHERE ${TENANT} AND document_id = d.id AND field_key IN ('service_date', 'technician'${hasAudienceColumn ? '' : `, '${AUDIENCE_FALLBACK_FIELD_KEY}'`})
             ORDER BY field_key, confidence DESC NULLS LAST, id
          ) best
      ) fields ON TRUE`;
}

/** The shared CTEs every browse query (list + every facet) is built on top
 *  of. `hasDisplayName`: M3-config/41 (owned by G3) may not be pasted yet —
 *  same "detect once" contract as documentsHaveUpdatedAt. `wherePart` is the
 *  already-rendered fragment SQL (see renderBrowseFragments) for THIS
 *  particular query (full set for the list, N-1 for a facet count).
 *  R36: `candidateSql` (a search) becomes the first CTE, and the two grouped CTEs are restricted to it, so a search no
 *  longer aggregates every document in the shop before filtering. `materialize` forces `base` to be computed once when
 *  several statements below read it (facets). */
function sharedBrowseCtes(hasDisplayName, hasFinancials, wherePart, hasAudienceColumn, { candidateSql = null, extraColumns = '', materialize = false } = {}) {
  const inCand = (col) => (candidateSql ? `AND ${col} IN (SELECT id FROM cand)` : '');
  return `
    WITH ${candidateSql ? `cand AS MATERIALIZED (${candidateSql}),` : ''}
    linked AS (
      SELECT del.document_id,
             MAX(CASE WHEN e.entity_type = 'customer' THEN e.id::text END) AS customer_id,
             MAX(CASE WHEN e.entity_type = 'customer' THEN e.data->>'customer_name' END) AS customer_name,
             COALESCE(
               MAX(CASE WHEN e.entity_type = 'customer' THEN e.data->>'service_address' END),
               MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->>'service_address' END)
             ) AS site_address,
             MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->>'manufacturer' END) AS brand,
             MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->'warranty'->>'expires' END) AS warranty_expiry
        FROM document_entity_links del
        JOIN entities e ON e.id = del.entity_id AND ${TENANT.replace('tenant_id', 'e.tenant_id')} AND e.merged_into IS NULL
       WHERE ${TENANT.replace('tenant_id', 'del.tenant_id')} ${inCand('del.document_id')}
       GROUP BY del.document_id
    ),
    fields AS (
      SELECT document_id,
             MAX(value) FILTER (WHERE field_key = 'service_date') AS service_date,
             MAX(value) FILTER (WHERE field_key = 'technician') AS technician_name,
             ${hasAudienceColumn
               ? 'NULL::text AS audience_fallback'
               : `MAX(value) FILTER (WHERE field_key = '${AUDIENCE_FALLBACK_FIELD_KEY}') AS audience_fallback`}
        FROM (
          SELECT DISTINCT ON (document_id, field_key) document_id, field_key, value
            FROM extractions
           WHERE ${TENANT} AND field_key IN ('service_date', 'technician'${hasAudienceColumn ? '' : `, '${AUDIENCE_FALLBACK_FIELD_KEY}'`}) ${inCand('document_id')}
           ORDER BY document_id, field_key, confidence DESC NULLS LAST, id
        ) best
       GROUP BY document_id
    ),
    base AS ${materialize ? 'MATERIALIZED ' : ''}(
      SELECT ${browseBaseColumns(hasDisplayName, hasFinancials, hasAudienceColumn)}${extraColumns}
        FROM documents d
        LEFT JOIN linked ON linked.document_id = d.id
        LEFT JOIN fields ON fields.document_id = d.id
        ${hasFinancials ? `LEFT JOIN document_financials df ON df.document_id = d.id AND ${TENANT.replace('tenant_id', 'df.tenant_id')}` : ''}
       WHERE ${TENANT.replace('tenant_id', 'd.tenant_id')} AND ${wherePart}
    )`;
}

/** R36: the per-page form of a browse list for the newest-first sort. Walks `documents` in (created_at, id) order and
 *  computes the customer / field sub-selects only for rows it actually tests, stopping at `limit`. Fragments are the same
 *  ones the CTE form uses (they reference d.*, linked.*, fields.*, df.*). */
function browsePageSelect(hasDisplayName, hasFinancials, wherePart, hasAudienceColumn, { candidateSql = null, keysetSql = '', windowSize = 0, windowKeysetSql = '', limit, offset = 0 }) {
  return `
    WITH ${candidateSql ? `cand AS MATERIALIZED (${candidateSql})` : 'noop AS (SELECT 1)'}
    SELECT ${browseBaseColumns(hasDisplayName, hasFinancials, hasAudienceColumn)}
      FROM ${windowSize
        ? `(SELECT * FROM documents dw WHERE ${TENANT.replace('tenant_id', 'dw.tenant_id')} ${windowKeysetSql} ORDER BY dw.created_at DESC, dw.id DESC LIMIT ${windowSize}) d`
        : 'documents d'}
      ${browseLateralJoins(hasAudienceColumn)}
      ${hasFinancials ? `LEFT JOIN document_financials df ON df.document_id = d.id AND ${TENANT.replace('tenant_id', 'df.tenant_id')}` : ''}
     WHERE ${TENANT.replace('tenant_id', 'd.tenant_id')} AND ${wherePart} ${windowSize ? '' : keysetSql}
     ORDER BY d.created_at DESC, d.id DESC
     OFFSET ${offset} LIMIT ${limit}`;
}


/* ----------------------------------------------------------------------------------------------------------------------
 * R36: browse helpers (module level so browseDocuments and browseFacets share one context builder).
 * -------------------------------------------------------------------------------------------------------------------- */

/** Facet cache: tenant uuid + filters key + caller -> facets, 60 s. Only browseFacets (the dedicated action) reads it. */
const browseFacetCache = new TTLCache(60_000, 400);
export function _resetBrowseFacetCache() { browseFacetCache.map.clear(); }

/** Is M3-config/64's records_search_candidates() installed AND callable by this role (a missing grant must not break search)? A yes is remembered; a no is re-checked each minute, so pasting the SQL takes effect without a restart. */
let searchFnState = { ok: false, at: 0 };
export function _resetSearchFnProbe() { searchFnState = { ok: false, at: 0 }; }
async function searchFunctionExists(db) {
  if (searchFnState.ok) return true;
  if (Date.now() - searchFnState.at < 60_000) return false;
  try {
    const r = await db.query(`SELECT (to_regprocedure('records_search_candidates(text,text)') IS NOT NULL AND has_function_privilege('records_search_candidates(text,text)', 'EXECUTE')) AS ok`);
    searchFnState = { ok: Boolean(r.rows[0]?.ok), at: Date.now() };
  } catch {
    searchFnState = { ok: false, at: Date.now() };
  }
  return searchFnState.ok;
}

/** R41: is M3-config/65's Donovan page finder (donovan_pages_by_text / donovan_pages_by_like) installed AND callable by this role?
 *  Same contract as the 64 probe above: a yes is remembered, a no is re-checked each minute, so pasting the SQL takes effect
 *  without a restart. Never throws. */
let passageFnState = { ok: false, at: 0 };
export function _resetPassageFnProbe() { passageFnState = { ok: false, at: 0 }; }
async function passageFunctionsExist(db) {
  if (passageFnState.ok) return true;
  if (Date.now() - passageFnState.at < 60_000) return false;
  try {
    const r = await db.query(
      `SELECT (has_function_privilege(to_regprocedure('donovan_pages_by_text(text,integer,uuid[])'), 'EXECUTE')
           AND has_function_privilege(to_regprocedure('donovan_pages_by_like(text,integer,uuid[])'), 'EXECUTE')) AS ok`
    );
    passageFnState = { ok: r.rows[0]?.ok === true, at: Date.now() };
  } catch {
    passageFnState = { ok: false, at: Date.now() };
  }
  return passageFnState.ok;
}

/** R41: is M3-config/65's customer_activity summary installed, callable by this role, and complete (the table, both tables'
 *  privileges, the refresh function and ALL TEN triggers that keep it current)? A half-pasted file is NOT used: without its
 *  triggers the numbers would go stale. A yes is remembered; a no is re-checked each minute. Never throws. */
let customerSummaryState = { ok: false, at: 0 };
export function _resetCustomerSummaryProbe() { customerSummaryState = { ok: false, at: 0 }; }
export const CUSTOMER_ACTIVITY_TRIGGER_COUNT = 10;
async function customerSummaryReady(db) {
  if (customerSummaryState.ok) return true;
  if (Date.now() - customerSummaryState.at < 60_000) return false;
  try {
    const r = await db.query(
      `SELECT (has_table_privilege(to_regclass('customer_activity'), 'SELECT, INSERT, UPDATE, DELETE')
           AND has_table_privilege(to_regclass('customer_activity_dirty'), 'SELECT, INSERT, UPDATE, DELETE')
           AND has_function_privilege(to_regprocedure('customer_activity_refresh()'), 'EXECUTE')
           AND (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'customer\\_activity\\_%' AND NOT tgisinternal) = ${CUSTOMER_ACTIVITY_TRIGGER_COUNT}) AS ok`
    );
    customerSummaryState = { ok: r.rows[0]?.ok === true, at: Date.now() };
  } catch {
    customerSummaryState = { ok: false, at: Date.now() };
  }
  return customerSummaryState.ok;
}

/** Newest documents the dense-search probe tests before falling back to the candidate set. */
const SEARCH_WALK_WINDOW = 1000;

/** Normalises the caller's filters and runs the once-per-process schema probes every browse query needs. */
async function browseContext(db, rawFilters, currentUserId) {
  const f = normalizeBrowseFilters(rawFilters);
  f.currentUserId = f.uploadedByMe ? currentUserId : null;
  const hasDisplayName = await documentsHaveDisplayName(db);
  // financialsTableExists expects a store-shaped object with `.raw` (that is how api/_lib/financials/store.js's own callers
  // use it, via makeStore) - this function receives the low-level driver, which only has `.query`, so adapt it.
  const hasFinancials = await financialsTableExists({ raw: (sql, params) => db.query(sql, params) });
  // Round 18, part 2 (owner ask (a)): same "detect once" contract, for the audience chip.
  const hasAudienceColumn = await documentsHaveAudience({ query: (sql, params) => db.query(sql, params) });
  const today = new Date().toISOString().slice(0, 10);
  const baseParams = [today, isoPlusDays(today, 90)];
  const filtersKey = browseFiltersKey(f);
  const searchFn = f.q ? await searchFunctionExists(db) : false;
  const allFrags = buildBrowseFragments(f, hasDisplayName, hasFinancials, hasAudienceColumn, searchFn);
  return { f, hasDisplayName, hasFinancials, hasAudienceColumn, baseParams, filtersKey, allFrags };
}

/** How many documents match the fragments. Only `documents` is touched when every active filter is a documents column
 *  (or the search); otherwise the joined form is needed to evaluate the customer / field / money filters. */
async function countBrowseMatches(db, ctxB, frags) {
  const { hasDisplayName, hasFinancials, hasAudienceColumn, baseParams } = ctxB;
  const docLocal = (x) => BROWSE_DOC_LOCAL_DIMS.has(x.dim) || (x.dim === 'audience' && hasAudienceColumn);
  const { sql: wherePart, params, candidateSql } = renderBrowseFragments(frags, baseParams);
  if (frags.every(docLocal)) {
    const r = await db.query(
      `${candidateSql ? `WITH cand AS MATERIALIZED (${candidateSql})` : ''}
       SELECT count(*)::int AS n FROM documents d WHERE ${TENANT.replace('tenant_id', 'd.tenant_id')} AND ${wherePart}
          AND $1::text IS NOT NULL AND $2::text IS NOT NULL`, // $1/$2 (today, +90d) are always bound; this just gives them a type

      params
    );
    return r.rows[0]?.n ?? 0;
  }
  const r = await db.query(
    `${sharedBrowseCtes(hasDisplayName, hasFinancials, wherePart, hasAudienceColumn, { candidateSql })} SELECT count(*)::int AS n FROM base`,
    params
  );
  return r.rows[0]?.n ?? 0;
}

const FACET_ENUMERATED = [
  ['documentType', 'document_type', 'document_type', 'document_type IS NOT NULL', 30],
  ['stageBucket', 'stage_bucket', 'stage_bucket', 'TRUE', 10],
  ['warrantyBucket', 'warranty_bucket', 'warranty_bucket', 'TRUE', 10],
  ['audience', 'audience', 'audience', 'TRUE', 2],
  ['site', 'site_address', 'site_address', 'site_address IS NOT NULL', 20],
  ['technician', 'technician_name', 'technician_name', 'technician_name IS NOT NULL', 20],
  ['brand', 'brand', 'brand', 'brand IS NOT NULL', 20],
];

/**
 * Every facet in ONE pass. `base` is computed once (MATERIALIZED) for the set the search restricts to, each active filter
 * becomes a boolean column, and each facet then counts the rows where every OTHER filter's flag holds (so picking an
 * option never removes its siblings - the same rule as before). Before: ten statements, each re-building `base`.
 * Returns the same `[{key, options}] / [{key, trueCount}]` list, in the same order, as the old per-facet code.
 */
async function runBrowseFacets(db, ctxB, currentUserId) {
  const { hasDisplayName, hasFinancials, hasAudienceColumn, baseParams, allFrags } = ctxB;
  const { params, clauses, candidateSql } = renderBrowseFragments(allFrags, baseParams);
  // The search restricts `base` itself (cand), so its clause is never a per-facet flag.
  const flagged = allFrags
    .map((frag, i) => ({ dim: frag.dim, clause: clauses[i] }))
    .filter((x) => x.dim !== 'q');
  const flagCols = flagged.map((x, i) => `(${x.clause}) AS ok_${i}`).join(', ');
  const okExcept = (dim) => {
    const parts = flagged.map((x, i) => (x.dim === dim ? null : `ok_${i}`)).filter(Boolean);
    return parts.length ? parts.join(' AND ') : 'TRUE';
  };
  const wantMine = Boolean(currentUserId);
  const mineIdx = params.length + 1;
  const arms = [];
  for (const [dim, valueCol, labelCol, having, cap] of FACET_ENUMERATED) {
    arms.push(`(SELECT '${dim}'::text AS dim, ${valueCol}::text AS value, ${labelCol}::text AS label, count(*)::int AS n FROM base
       WHERE ${okExcept(dim)} AND ${having} GROUP BY ${valueCol}, ${labelCol} ORDER BY n DESC, label ASC LIMIT ${cap})`);
  }
  arms.push(`(SELECT 'customerId'::text, customer_id::text, customer_name::text, count(*)::int AS n FROM base
       WHERE ${okExcept('customerId')} AND customer_id IS NOT NULL GROUP BY customer_id, customer_name ORDER BY n DESC, customer_name ASC LIMIT 20)`);
  arms.push(`(SELECT 'hasMoney'::text, NULL::text, NULL::text, count(*) FILTER (WHERE ${hasFinancials ? 'has_money' : 'FALSE'})::int FROM base WHERE ${okExcept('hasMoney')})`);
  arms.push(`(SELECT 'openBalance'::text, NULL::text, NULL::text, count(*) FILTER (WHERE ${hasFinancials ? '(COALESCE(balance_due, 0) > 0)' : 'FALSE'})::int FROM base WHERE ${okExcept('openBalance')})`);
  if (wantMine) {
    arms.push(`(SELECT 'uploadedByMe'::text, NULL::text, NULL::text, count(*) FILTER (WHERE uploaded_by = $${mineIdx})::int FROM base WHERE ${okExcept('uploadedByMe')})`);
    params.push(currentUserId);
  }
  // `base` carries no per-filter WHERE here (the flags do that job per facet); only the search restricts it.
  const sql = `${sharedBrowseCtes(hasDisplayName, hasFinancials, candidateSql ? 'd.id IN (SELECT id FROM cand)' : 'TRUE', hasAudienceColumn, {
    candidateSql,
    extraColumns: flagCols ? `, ${flagCols}` : '',
    materialize: true,
  })}
    ${arms.join('\n    UNION ALL\n    ')}`;
  const { rows } = await db.query(sql, params);
  const byDim = new Map();
  for (const r of rows) {
    const list = byDim.get(r.dim);
    if (list) list.push(r); else byDim.set(r.dim, [r]);
  }
  const out = [];
  for (const [dim] of FACET_ENUMERATED) {
    out.push({
      key: dim,
      options: (byDim.get(dim) ?? [])
        .filter((r) => r.value !== null && r.value !== '')
        .map((r) => ({ value: String(r.value), label: r.label != null ? String(r.label) : String(r.value), count: Number(r.n) })),
    });
  }
  out.push({
    key: 'customerId',
    options: (byDim.get('customerId') ?? [])
      .filter((r) => r.value !== null && r.value !== '')
      .map((r) => ({ value: String(r.value), label: r.label != null ? String(r.label) : String(r.value), count: Number(r.n) })),
  });
  out.push({ key: 'hasMoney', trueCount: Number(byDim.get('hasMoney')?.[0]?.n ?? 0) });
  out.push({ key: 'openBalance', trueCount: Number(byDim.get('openBalance')?.[0]?.n ?? 0) });
  if (wantMine) out.push({ key: 'uploadedByMe', trueCount: Number(byDim.get('uploadedByMe')?.[0]?.n ?? 0) });
  return out;
}

/** Shapes a browse page (rows straight from SQL) into the wire response. */
function browseResult(rows, { total, hasMore, nextCursor, facets, sort, limit }) {
  return {
    rows: rows.map((r) => ({
      id: r.id,
      filename: r.original_filename,
      displayName: r.display_name ?? null,
      documentType: r.document_type,
      stage: r.stage,
      stageBucket: r.stage_bucket,
      verifiedBy: r.verified_by,
      uploadedBy: r.uploaded_by,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      serviceDate: r.service_date ?? null,
      customerId: r.customer_id,
      customerName: r.customer_name,
      siteAddress: r.site_address,
      technician: r.technician_name,
      brand: r.brand,
      warrantyExpiry: r.warranty_expiry,
      warrantyBucket: r.warranty_bucket,
      amount: r.amount != null ? Number(r.amount) : null,
      balanceDue: r.balance_due != null ? Number(r.balance_due) : null,
      moneyStatus: r.money_status,
      hasMoney: r.has_money,
      // Round 18, part 2 (owner ask (a)): drives the "Team only" badge (src/components/records/RecordsBrowser.tsx) -
      // always 'customer' or 'internal', never null (AUDIENCE_EXPR's own COALESCE).
      audience: r.audience === 'internal' ? 'internal' : 'customer',
    })),
    total,
    hasMore,
    nextCursor,
    facets,
    sort,
    limit,
  };
}

/**
 * Marks the facets this extractor owns, so a re-read replaces its own rows and
 * only its own. `mapping_method` would have been the natural home, but it
 * carries a CHECK constraint limited to registry/synonym/learned/human.
 */
export const FIELD_EXTRACT_SEGMENT = 'field-extract';
/** R33: facets written by a $0 re-check of a stored document (api/_lib/recheck.js) — the provenance marker for
 * `method: 'recheck'` (facets.mapping_method is CHECK-constrained, segment_id is not). Swept by the same
 * replace-on-re-extraction as FIELD_EXTRACT_SEGMENT, so a later full re-read converges instead of stacking. */
export const FIELD_RECHECK_SEGMENT = 'field-recheck';

/**
 * Collapse whitespace and refuse a value that is only punctuation or
 * whitespace ("   ", "---", "—", "N/A" survives — it has letters, and whether
 * that's a real customer name is a data-quality problem the extractor should
 * catch, not this store). Used wherever customer-matching text is compared, so
 * "   " or "---" can never become a customer named "---".
 *
 * No length limit here on purpose: `extractFields.js` already caps a value at
 * 500 characters before it reaches this store, and equality comparison (never
 * ILIKE, never a functional index) is exactly as cheap on a 5-character string
 * as a 5,000-character one, so there is nothing here that needs defending by
 * truncating.
 *
 * Exported (with selectCustomerMatch below) purely so the customer-matching
 * decision can be unit tested without a database — see
 * scripts/verify-customer-link.mjs. Neither function touches `db`.
 */
/**
 * Serial values that identify nothing. Deliberately a small exact list rather
 * than a clever pattern: a real serial can look like almost anything, so
 * anything heuristic here risks discarding a genuine one. Compared after
 * lowercasing and collapsing every non-alphanumeric run to a single space.
 */
const PLACEHOLDER_SERIALS = new Set([
  'n a', 'na', 'none', 'no serial', 'no serial number', 'unknown', 'unk',
  'tbd', 'pending', 'illegible', 'unreadable', 'missing', 'not legible',
  'not readable', 'not available', 'nil', 'null', 'test', 'sample',
  'see photo', 'see above', 'see attached',
]);

export function isPlaceholderSerial(raw) {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return true;
  // The repeated-character test below is a backtracking regex: it overflows the
  // stack somewhere past a couple of million characters. normalizeFields caps
  // values at 500 chars today so nothing can reach that, but this function is
  // exported and a future bulk-import path would not go through that cap.
  // Returning false (not a placeholder) is the safe direction — a wrongly
  // rejected serial loses a unit's whole history.
  if (s.length > 200) return false;
  if (PLACEHOLDER_SERIALS.has(s)) return true;
  // A single repeated character once separators are gone ("-----", "0000",
  // "XXXX") is a filler mark on a form, not an identifier.
  const bare = s.replace(/ /g, '');
  if (/^(.)\1*$/.test(bare)) return true;
  return false;
}

/**
 * The only columns a generic update may touch on `documents`.
 *
 * Exported so a test can assert what is NOT here — `stage` and `storage_key`
 * are absent on purpose and their absence is a security boundary. The reasoning
 * is at the updateDocument call site.
 */
export const DOCUMENT_UPDATE_COLUMNS = Object.freeze([
  'document_type', 'processed_at', 'file_size_bytes', 'content_type', 'page_count',
]);

export function normalizeMatchText(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  // Unicode letters and numbers, not ASCII. The old test was /[A-Za-z0-9]/,
  // which meant a customer named Иванов, 王芳, محمد or Παπαδόπουλος normalized
  // to the empty string — and findOrCreateCustomer reads an empty string as
  // "this document names nobody", exactly as it reads "---" or "   ". So those
  // customers silently never got a record and their equipment was never linked
  // to them. Not an edge case: an ordinary customer list in most American
  // cities contains names this rejected, and it failed quietly every time.
  return /[\p{L}\p{N}]/u.test(s) ? s : '';
}

/**
 * findOrCreateCustomer's `matchBasis` -> the `linked_by` value every caller
 * (extractDocument.js, reviewStore.js, routes/integrity.js) should stamp on
 * the resulting document_entity_links row. Both 'name-only' and, since Round
 * 4 item 4 (2026-09-21), 'name-mention' are weaker-than-address matches that
 * a later same-surname customer can make ambiguous — routes/integrity.js's
 * isEligibleForRelink/ambiguousNameOnlyLinks treat 'ai:name-mention' exactly
 * like 'ai:name-only' (eligible for relink, ambiguity flag applies). One
 * function so every call site stays in sync instead of five copies of the
 * same ternary.
 */
export function linkedByForMatchBasis(matchBasis) {
  if (matchBasis === 'name-only' || matchBasis === 'name-mention') return `ai:${matchBasis}`;
  return 'ai';
}

/**
 * Given every existing customer whose name already matches (case-insensitive
 * — that filtering happens in SQL, findOrCreateCustomer's candidate query),
 * decide which one, if any, the incoming document is about.
 *
 * A candidate is disqualified only when it has an address ON FILE that
 * DISAGREES with the incoming one — a candidate with no address yet cannot
 * disagree, so it stays eligible. Exactly one eligible candidate is a match;
 * zero or several is treated as "don't know" and returns null, the same
 * "refuse rather than guess" rule as normalizeBrand() in warrantyRules.js.
 *
 * @param {{id: string, data: object}[]} candidates  same-name customer rows
 * @param {string} address  normalized incoming service_address, or '' if the
 *                          document did not state one
 * @returns {{id: string, data: object}|null}
 */
/**
 * @param {{id: string, data: object}[]} candidates
 * @param {string|{name?: string, address?: string}} incoming  a plain address
 *   string (legacy call shape, still supported) or {name, address} — passing
 *   `name` enables the fuzzy path below.
 */
export function selectCustomerMatch(candidates, incoming) {
  const { name = '', address = '' } = typeof incoming === 'string' ? { address: incoming } : (incoming ?? {});

  if (!address) {
    // No address to disambiguate with. Only a single same-named candidate is
    // safe, and even that is a judgement call — see the header note.
    return candidates.length === 1 ? candidates[0] : null;
  }

  // The incoming document HAS an address, so require a positive match on it.
  //
  // This used to also accept a candidate with no address on file, on the
  // reasoning that it was probably the same person and we were just filling in
  // a blank. That is wrong often enough to matter: a customer whose first
  // document never captured an address (a phone quote, an informal ticket)
  // leaves a name-only row that then swallows the NEXT person of the same name,
  // and "Smith" is not rare. The result is one customer seeing another's
  // equipment and warranty dates, which this file calls a privacy defect
  // rather than an untidy table.
  //
  // The cost is real and accepted: the same person whose first document had no
  // address now gets a second customer row. That is a duplicate a human can see
  // and merge. A false merge is neither visible nor reversible.
  const eligible = candidates.filter((c) => {
    const existingAddr = normalizeMatchText(c.data?.service_address);
    if (existingAddr && existingAddr.toLowerCase() === address.toLowerCase()) {
      // Bug C fix (2026-09-20 limit test): an exact address match used to be
      // eligible REGARDLESS OF NAME — which is exactly how "Desert Ridge
      // Dental" (a different business at the same suite) got silently
      // absorbed into the pre-existing "Plaza Dental Group". An address
      // match is no longer enough on its own: when both sides actually name
      // someone, the names must agree at least at the surname level (equal,
      // subset, or same surname — never a bare 'surname-fuzzy' near-miss or
      // 'no-match'). A candidate with no name on file, or an incoming
      // document with no name at all, has nothing to disagree on and stays
      // eligible on the address alone — the address-only path
      // (findOrCreateCustomerByAddress) never reaches this function at all,
      // so `name` here is always a real extracted customer_name when set.
      const candidateName = normalizeMatchText(c.data?.customer_name);
      if (!name || !candidateName) return true;
      const rel = compareNamesStrict(name, candidateName);
      return rel === 'equal' || rel === 'subset' || rel === 'surname';
    }
    // Fuzzy path (2026-09-20, bug A): the same household under a differently
    // worded name/address — "Castillo" @ "1519 W Juniper" and "Ray & Linda
    // Castillo" @ "1519 W Juniper Ave, Mesa AZ 85202". Only reached when the
    // caller passed a name AND the candidate has one; see integrity.js's
    // customerMatchScore for the actual rule (address normalization +
    // surname/substring name matching). A 'surname-fuzzy' near-miss (limit-
    // test defect B: "Paterson" vs "Patterson") scores at most 0.6 there,
    // well under CUSTOMER_MATCH_THRESHOLD, so it never auto-links here either
    // — it surfaces instead as a 'suggest'-tier pair in the duplicates
    // banner (findDuplicateCustomerPairs).
    if (name && c.data?.customer_name) {
      return customerMatchScore(
        { name, address },
        { name: c.data.customer_name, address: c.data.service_address }
      ) >= CUSTOMER_MATCH_THRESHOLD;
    }
    return false;
  });
  return eligible.length === 1 ? eligible[0] : null;
}

/**
 * Link a document to the customer entity it names — regardless of whether it
 * ALSO has an equipment entity linked. Shared by extractDocument.js (right
 * after extraction) and reviewStore.js's aiVerifyDocument (to repair a
 * document extracted before this existed, with no re-extraction — pressing
 * "Reclassify & verify all" must fix it too).
 *
 * BUG B FIX (2026-09-20, handoffs/DATA_INTEGRITY_2026-09-20.md): this used to
 * run only when the document had NO equipment entity, on the theory that an
 * equipment link already got it to stage 'linked' so a customer link was
 * redundant. That left `entities.customer_id` (set via setEquipmentCustomer)
 * as the ONLY record of the customer relationship for any document that also
 * named equipment — nothing in `document_entity_links` pointed at the
 * customer entity itself, so a document could show its equipment linked and
 * its customer "not linked to a customer yet" at the same time (the
 * Margaret Henderson production defect). Now unconditional: every document
 * with a resolved customer gets its own document_entity_links row to that
 * customer, on top of whatever equipment links it also has. Idempotent via
 * ON CONFLICT DO NOTHING, so calling this from both the equipment and
 * customer-only paths is safe.
 *
 * Uses `db.raw` for document_entity_links and the stage transition, which
 * recordsStore.js's curated store deliberately does not otherwise expose —
 * see the module comment on `raw` above. Mirrors reviewStore.linkDocument's
 * forward-only stage UPDATE exactly, just triggered by an AI link instead of
 * a human's.
 *
 * @returns {Promise<boolean>} whether a link was actually inserted (false
 *   when one already existed — not an error).
 */
export async function linkDocumentToCustomer(db, { documentId, customerId, confidence = 0.6, linkedBy = 'ai' } = {}) {
  if (!documentId || !customerId) return false;

  // `linkedBy` carries provenance beyond "a person did this or the AI did"
  // (see the 'ai'/'human' values elsewhere in this file): limit-test defect D
  // (2026-09-20) marks a match resolved with no address at all — the single
  // same-name candidate, findOrCreateCustomer's matchBasis: 'name-only' — as
  // 'ai:name-only' rather than plain 'ai', so routes/integrity.js's
  // ambiguousNameOnlyLinks scan can find exactly these links later without a
  // schema change.
  const inserted = await db.raw(
    `INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (tenant_id, document_id, entity_id) DO NOTHING`,
    [db.tenantId, documentId, customerId, confidence, linkedBy]
  );

  await db.raw(
    `UPDATE documents SET stage = 'linked'
      WHERE id = $1 AND ${TENANT} AND stage IN ('received', 'read', 'mapped')`,
    [documentId]
  );
  return inserted.rowCount > 0;
}

/**
 * Link a document to an ADDITIONAL entity beyond its primary one.
 *
 * Multi-unit support (2026-09-19): a maintenance agreement covering two
 * rooftop units gets ONE primary entity_id on its `extractions` rows (the
 * first unit, for backward compatibility with everything that still reads
 * a document's "the" entity) but must show up against BOTH units' entity
 * screens. This is that second, third, ... link. No stage transition here —
 * markLinked (already called for the primary unit inside the same
 * transaction) owns 'mapped' -> 'linked'; this only adds the join row.
 */
export async function linkDocumentToEntity(db, { documentId, entityId, confidence = 0.6 } = {}) {
  if (!documentId || !entityId) return false;
  const r = await db.raw(
    `INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at)
     VALUES ($1,$2,$3,$4,'ai',NOW())
     ON CONFLICT (tenant_id, document_id, entity_id) DO NOTHING`,
    [db.tenantId, documentId, entityId, confidence]
  );
  return r.rowCount > 0;
}

/**
 * CUSTOMER REMINDERS (2026-09-22): every existing customer whose name
 * plausibly matches `name` — exact/subset first (matchNameMention, the same
 * strict bar findOrCreateCustomer's own bare-mention path uses), else same
 * surname (exact, or one edit apart — compareNamesStrict's own
 * 'surname'/'surname-fuzzy' categories, the same ones selectCustomerMatch
 * above already treats as a real candidate elsewhere in this file). Pure DB
 * read: never creates or links anything, so a caller can safely use "zero",
 * "one", or "many" candidates for whatever its own purpose needs (auto-link
 * on exactly one, offer a pick on many, offer "create new" on zero). Capped
 * at 200 same-surname rows, same ceiling findOrCreateCustomer's own
 * surname-ILIKE scan uses.
 */
export async function findCustomerNameCandidates(db, name) {
  const normalized = normalizeMatchText(name);
  if (!normalized) return [];
  const surname = normalizeSurname(normalized).replace(/[%_]/g, '\\$&');
  if (!surname) return [];

  const { rows } = await db.raw(
    `SELECT id, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address, customer_number
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT}
        AND lower(data->>'customer_name') LIKE '%' || $1 || '%' ESCAPE '\\'
      ORDER BY created_at LIMIT 200`,
    [surname]
  );
  if (!rows.length) return [];

  // 'equal'/'subset' first (a real name match — "Karen Abernathy" against
  // itself, or against a surname-only search); if that's ambiguous (2+ rows
  // legitimately satisfy it — e.g. a bare surname search against BOTH "Karen
  // Abernathy" and "John Abernathy", each a 'subset' match on their own),
  // return all of them rather than silently narrowing to one. Only when
  // NOTHING matches at that strict bar does the looser same-surname fallback
  // ('surname'/'surname-fuzzy') get a look.
  const relation = (r) => compareNamesStrict(normalized, r.customer_name);
  const strong = rows.filter((r) => { const rel = relation(r); return rel === 'equal' || rel === 'subset'; });
  if (strong.length) return strong;

  return rows.filter((r) => { const rel = relation(r); return rel === 'surname' || rel === 'surname-fuzzy'; });
}

/**
 * Resolve a customer named only in a document's reminder text — see
 * extractFields.js's reminder_customer_name and extractDocument.js's own
 * caller. Same "don't know, don't guess" rule as findOrCreateCustomer: 0 or
 * 2+ candidates both return null rather than picking one. Never creates a
 * customer — an unmatched name stays unlinked; reviewStore.js's
 * createCustomerAndAttachReminder is the human's one-click fix for that case.
 */
export async function findCustomerByReminderName(db, name) {
  const candidates = await findCustomerNameCandidates(db, name);
  return candidates.length === 1 ? candidates[0] : null;
}

/** Words too common to identify a page on their own; skipped by the plain-text fallback in searchPassages. */
const STOPWORDS = new Set(['what','when','where','which','whose','does','did','the','this','that','these','those','with','from','have','has','had','was','were','will','still','under','about','there','their','them','they','into','onto','over','last','next','much','many','more','most','some','any','how','why','who','and','for','are','not','but','can','could','should','would','been','being','than','then','also','just','ever','every','each','tell','show','find','give','need','want','know','like','make','made','get','got','all','one','two','our','your','you','we','us','it','its','is','an','on','at','to','of','in','by','or','if','so','do','a','i','me','my','be','as','up','no','yes','year','years','month','months','week','weeks','day','days','ago','summer','winter','spring','fall','back','call','called','called','unit','units','system','job','work']);

/**
 * Run `fn` inside a transaction scoped to the caller's tenant.
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {(store: ReturnType<typeof makeStore>) => Promise<any>} fn
 */
export async function withTenant(ctx, fn) {
  // API_PERF_2026-09-22: resolve the tenant id from the shared, cached
  // context (see getTenantContext above) instead of always running
  // resolve_tenant() as this transaction's first statement. Cache hit ->
  // this connection's very first query is the caller's own work, not a
  // lookup. A cache MISS still calls resolve_tenant() (via
  // fetchRequestContextRow), just on a separate connection borrowed briefly
  // from the same pool — resolve_tenant() is SECURITY DEFINER and
  // idempotent (it upserts), so running it outside this transaction changes
  // nothing about its result or its one-row-per-org guarantee.
  const tenantId = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;

  const client = serializeClient(await getPool().connect());
  // R35: if even ROLLBACK fails the connection is broken; release(true) destroys it instead of handing a dead client
  // to the next request on this warm instance (which then failed once, for someone else).
  let destroy = false;
  try {
    await client.query('BEGIN');
    // `true` = SET LOCAL: reverts on COMMIT/ROLLBACK, never outlives the request.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [assertTenantUuid(tenantId)]);

    const result = await fn(makeStore(client, tenantId));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { destroy = true; });
    throw err;
  } finally {
    client.release(destroy ? true : undefined);
  }
}

/** Memoized per warm instance: does documents.updated_at exist yet
 *  (M3-config/17)? null = unknown. Re-probed only on cold start, same
 *  contract as askCache.js's tableExists. Exported for reviewStore.js. */
let documentsUpdatedAt = null;
export async function documentsHaveUpdatedAt(db) {
  if (documentsUpdatedAt !== null) return documentsUpdatedAt;
  try {
    const r = await db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'updated_at'`
    );
    documentsUpdatedAt = r.rowCount > 0;
  } catch {
    return false; // don't memoize a transient failure
  }
  return documentsUpdatedAt;
}
export function _resetDocumentsUpdatedAtProbe() { documentsUpdatedAt = null; }

/** Same contract as documentsHaveUpdatedAt, for extractions.unit_index
 *  (M3-config/19). Guards every read/write of that column so a deploy that
 *  lands before the migration is pasted degrades to "always NULL" instead of
 *  a 42703 undefined_column error. */
let extractionsUnitIndex = null;
export async function extractionsHaveUnitIndex(db) {
  if (extractionsUnitIndex !== null) return extractionsUnitIndex;
  try {
    const r = await db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'extractions' AND column_name = 'unit_index'`
    );
    extractionsUnitIndex = r.rowCount > 0;
  } catch {
    return false;
  }
  return extractionsUnitIndex;
}
export function _resetExtractionsUnitIndexProbe() { extractionsUnitIndex = null; }

/** Same contract as documentsHaveUpdatedAt, for documents.uploaded_by
 *  (M3-config/20). Guards createDocument's INSERT so a deploy that lands
 *  before that migration is pasted just writes nothing for uploaded_by,
 *  instead of a 42703 undefined_column error. */
let documentsUploadedBy = null;
export async function documentsHaveUploadedBy(db) {
  if (documentsUploadedBy !== null) return documentsUploadedBy;
  try {
    const r = await db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'uploaded_by'`
    );
    documentsUploadedBy = r.rowCount > 0;
  } catch {
    return false;
  }
  return documentsUploadedBy;
}
export function _resetDocumentsUploadedByProbe() { documentsUploadedBy = null; }

/** Same contract as documentsHaveUpdatedAt, for documents.display_name
 *  (M3-config/41, owned by G3 — round 12 contract). browseDocuments below
 *  SELECTs it (as `displayName`) only once this is true; before that, every
 *  browse row's name falls back client-side to documentName()'s next rule
 *  (a derived name from type + fields, then the original filename) exactly
 *  as the contract requires. */
let documentsDisplayName = null;
export async function documentsHaveDisplayName(db) {
  if (documentsDisplayName !== null) return documentsDisplayName;
  try {
    const r = await db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'display_name'`
    );
    documentsDisplayName = r.rowCount > 0;
  } catch {
    return false;
  }
  return documentsDisplayName;
}
export function _resetDocumentsDisplayNameProbe() { documentsDisplayName = null; }

/**
 * Builds the `{tenantAddressKey, letterheadCounts}` isLikelyShopAddress needs
 * (reviewer follow-up, 2026-09-20: the address-only path above can otherwise
 * mint a "customer" out of the CONTRACTOR'S OWN letterhead address).
 *
 *   - tenantAddressKey: the tenant's own configured address, from
 *     tenants.settings->>'address' — that jsonb column has existed since
 *     M3-config/01-create-schema.sql (no new migration); a tenant that has
 *     never set one just yields null, and the letterhead-pattern signal below
 *     still applies on its own.
 *   - letterheadCounts: one row per normalized address key, counting how
 *     often it was extracted as shop_address vs. service_address, and how
 *     many DISTINCT customer_names accompanied it as a service_address.
 *     Built by scanning `extractions` once and grouping in JS — normalizeAddressKey
 *     has no SQL equivalent, and a tenant's extraction volume is small enough
 *     that this is one query, not N.
 *
 * Both halves are best-effort: a failure here must never break ordinary
 * customer resolution, so each degrades to "no signal" rather than throwing.
 * Callers that run this once per row in a loop (routes/integrity.js's bulk
 * fixes) should call it ONCE and pass the result back into findOrCreateCustomer
 * as `shopContext` instead of leaving every call to recompute it.
 */
async function computeShopAddressContext(db, tenantId) {
  let tenantAddressKey = null;
  let tenantPhoneKey = null;
  let tenantEmailKey = null;
  let knownShopPhoneKeys = [];
  let knownShopEmailKeys = [];
  try {
    // Same row, same query, as the phone/email tenant lookup below
    // (loadTenantContactKeys) — folded in here too so a caller that already
    // has a `shopContext` (routes/integrity.js's bulk loops) gets the
    // contact-leak signal (limit-test defect A) for free, with no second
    // round trip. `known_shop_contacts` (round-3 fix, 2026-09-21) is the
    // same tenant row too — see recordKnownShopContact's doc comment.
    const r = await db.query(
      `SELECT settings->>'address' AS address, settings->>'phone' AS phone, settings->>'email' AS email,
              settings->'known_shop_contacts' AS known_shop_contacts
         FROM tenants WHERE id = $1`,
      [tenantId]
    );
    tenantAddressKey = normalizeAddressKey(r.rows[0]?.address ?? '') || null;
    tenantPhoneKey = normalizePhoneKey(r.rows[0]?.phone ?? '') || null;
    tenantEmailKey = normalizeEmailKey(r.rows[0]?.email ?? '') || null;
    const known = r.rows[0]?.known_shop_contacts ?? {};
    knownShopPhoneKeys = Array.isArray(known?.phones) ? known.phones.filter((v) => typeof v === 'string') : [];
    knownShopEmailKeys = Array.isArray(known?.emails) ? known.emails.filter((v) => typeof v === 'string') : [];
  } catch (err) {
    console.error('computeShopAddressContext: tenant address lookup failed (skipping that signal):', err?.message);
  }

  const letterheadCounts = {};
  try {
    const rows = (await db.query(
      `SELECT document_id, field_key, value FROM extractions
        WHERE field_key IN ('shop_address','service_address','customer_name') AND value IS NOT NULL AND ${TENANT}
        LIMIT 20000`,
      []
    )).rows;

    const byDoc = new Map();
    for (const r of rows) {
      let d = byDoc.get(r.document_id);
      if (!d) { d = {}; byDoc.set(r.document_id, d); }
      if (r.field_key === 'shop_address' && d.shopAddress === undefined) d.shopAddress = r.value;
      if (r.field_key === 'service_address' && d.serviceAddress === undefined) d.serviceAddress = r.value;
      if (r.field_key === 'customer_name' && d.customerName === undefined) d.customerName = r.value;
    }

    const buckets = new Map();
    const bucketFor = (key) => {
      let b = buckets.get(key);
      if (!b) { b = { shopAddressDocs: new Set(), serviceAddressDocs: new Set(), customerNames: new Set() }; buckets.set(key, b); }
      return b;
    };
    for (const [docId, d] of byDoc) {
      if (d.shopAddress) {
        const key = normalizeAddressKey(d.shopAddress);
        if (key) bucketFor(key).shopAddressDocs.add(docId);
      }
      if (d.serviceAddress) {
        const key = normalizeAddressKey(d.serviceAddress);
        if (key) {
          const b = bucketFor(key);
          b.serviceAddressDocs.add(docId);
          const name = normalizeMatchText(d.customerName).toLowerCase();
          if (name) b.customerNames.add(name);
        }
      }
    }
    for (const [key, b] of buckets) {
      letterheadCounts[key] = {
        shopAddressDocs: b.shopAddressDocs.size,
        serviceAddressDocs: b.serviceAddressDocs.size,
        distinctCustomerNames: b.customerNames.size,
      };
    }
  } catch (err) {
    console.error('computeShopAddressContext: letterhead aggregate failed (skipping that signal):', err?.message);
  }

  return { tenantAddressKey, tenantPhoneKey, tenantEmailKey, knownShopPhoneKeys, knownShopEmailKeys, letterheadCounts };
}

/**
 * Cheap, tenant-row-only counterpart of computeShopAddressContext's tenant
 * lookup, for findOrCreateCustomer's per-document phone/email filtering
 * (limit-test defect A) — that path runs on every single extraction, so it
 * does NOT pay for the full letterheadCounts extraction scan the way the
 * address-only path's shopContext does; it only needs the tenant's own
 * configured phone/email plus the learned `known_shop_contacts` list (same
 * row, no extra round trip). A caller that already has a full shopContext
 * (routes/integrity.js's bulk loops, or a repeat call within one document)
 * should pass that instead — it carries the same keys for free.
 */
async function loadTenantContactKeys(db, tenantId) {
  try {
    const r = await db.query(
      `SELECT settings->>'phone' AS phone, settings->>'email' AS email, settings->'known_shop_contacts' AS known_shop_contacts
         FROM tenants WHERE id = $1`,
      [tenantId]
    );
    const known = r.rows[0]?.known_shop_contacts ?? {};
    return {
      tenantPhoneKey: normalizePhoneKey(r.rows[0]?.phone ?? '') || null,
      tenantEmailKey: normalizeEmailKey(r.rows[0]?.email ?? '') || null,
      knownShopPhoneKeys: Array.isArray(known?.phones) ? known.phones.filter((v) => typeof v === 'string') : [],
      knownShopEmailKeys: Array.isArray(known?.emails) ? known.emails.filter((v) => typeof v === 'string') : [],
    };
  } catch (err) {
    console.error('loadTenantContactKeys: tenant contact lookup failed (skipping that signal):', err?.message);
    return { tenantPhoneKey: null, tenantEmailKey: null, knownShopPhoneKeys: [], knownShopEmailKeys: [] };
  }
}

/** Cap on each of `known_shop_contacts.phones`/`.emails` — round-3 fix
 *  (2026-09-21). FIFO: the oldest learned value is dropped first once the cap
 *  is hit, same tradeoff as everywhere else in this file that bounds an
 *  unbounded list (a stale shop number aging out is cheap; an unbounded
 *  tenant-settings blob is not). */
export const KNOWN_SHOP_CONTACTS_CAP = 50;

/**
 * Persists a newly-seen shop phone/email into `tenants.settings.
 * known_shop_contacts` (`{phones: [...], emails: [...]}`, normalized keys) —
 * the fix for the round-3 live-retest gap: `isLikelyShopPhone`'s
 * distinct-address-count heuristic only sees a shop number WHILE it is
 * spread across >= SHOP_CONTACT_ADDRESS_FLOOR customers. The moment
 * `stripShopContact` cleans those customers up, only whichever customer is
 * created/relinked NEXT still carries it — never enough addresses for the
 * heuristic to fire again, so the same leaked number comes right back. This
 * makes "we've seen this number before" a durable fact instead of a
 * recomputed-every-time inference. Two write triggers use this (both
 * best-effort — a failure here must never break extraction or the fix that
 * calls it): (1) findOrCreateCustomer/findOrCreateCustomerByAddress, every
 * time a document's own `shop_phone`/`shop_email` extraction is non-empty;
 * (2) routes/integrity.js's `stripShopContact`, for the exact value it just
 * removed from a customer.
 *
 * A no-op (no write at all) when both values are blank or already known —
 * this runs on the ingest hot path, so it must not turn into a write on
 * every single document once a tenant's shop numbers are already learned.
 */
export async function recordKnownShopContact(db, tenantId, { phone, email } = {}) {
  const phoneKey = normalizePhoneKey(phone ?? '');
  const emailKey = normalizeEmailKey(email ?? '');
  if (!phoneKey && !emailKey) return;
  try {
    const { knownShopPhoneKeys, knownShopEmailKeys } = await loadTenantContactKeys(db, tenantId);
    let phones = knownShopPhoneKeys;
    let emails = knownShopEmailKeys;
    let changed = false;
    if (phoneKey && !phones.includes(phoneKey)) {
      phones = [...phones, phoneKey].slice(-KNOWN_SHOP_CONTACTS_CAP);
      changed = true;
    }
    if (emailKey && !emails.includes(emailKey)) {
      emails = [...emails, emailKey].slice(-KNOWN_SHOP_CONTACTS_CAP);
      changed = true;
    }
    if (!changed) return;
    await db.query(
      `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('known_shop_contacts', $2::jsonb) WHERE id = $1`,
      [tenantId, { phones, emails }]
    );
  } catch (err) {
    console.error('recordKnownShopContact: write failed (best-effort, skipping):', err?.message);
  }
}

/**
 * Shared by findOrCreateCustomer and findOrCreateCustomerByAddress
 * (round-3 fix, 2026-09-21 — "findOrCreateCustomerByAddress... consult it"):
 * filters a document's customer_phone/customer_email against every shop
 * signal this tenant has — the document's OWN shop_phone/shop_email
 * extraction, the tenant's configured contact, and every previously-learned
 * `known_shop_contacts` value — and, whenever THIS document itself names a
 * shop_phone/shop_email, learns it (recordKnownShopContact) so a LATER
 * document with no shop_phone extraction of its own (an old-prompt document,
 * or one where the customer's own row simply carries no name at all) still
 * gets it filtered. Returns `{phone, email}`, each `''` when filtered out or
 * absent. `shopContext`, optional, is the same precomputed context
 * findOrCreateCustomer/findOrCreateCustomerByAddress already accept.
 */
async function resolveCustomerContact(db, tenantId, facts, shopContext) {
  const docShopPhoneKey = normalizePhoneKey(facts?.shop_phone ?? '');
  const docShopEmailKey = normalizeEmailKey(facts?.shop_email ?? '');
  if (docShopPhoneKey || docShopEmailKey) {
    await recordKnownShopContact(db, tenantId, { phone: facts?.shop_phone, email: facts?.shop_email });
  }

  let phone = String(facts?.customer_phone ?? '').trim();
  let email = String(facts?.customer_email ?? '').trim();
  if (!phone && !email) return { phone, email };

  const phoneKey = normalizePhoneKey(phone);
  const emailKey = normalizeEmailKey(email);
  if (phone && docShopPhoneKey && phoneKey === docShopPhoneKey) phone = '';
  if (email && docShopEmailKey && emailKey === docShopEmailKey) email = '';
  if (phone || email) {
    const tenantKeys = shopContext ?? await loadTenantContactKeys(db, tenantId);
    if (phone && tenantKeys.tenantPhoneKey && phoneKey === tenantKeys.tenantPhoneKey) phone = '';
    if (email && tenantKeys.tenantEmailKey && emailKey === tenantKeys.tenantEmailKey) email = '';
    if (phone && tenantKeys.knownShopPhoneKeys?.includes(phoneKey)) phone = '';
    if (email && tenantKeys.knownShopEmailKeys?.includes(emailKey)) email = '';
  }
  return { phone, email };
}

/**
 * findOrCreateCustomer's address-only path (2026-09-20 root-cause fix,
 * handoffs/LINKING_ROOT_CAUSE_2026-09-20.md): a document that states a
 * service_address but no customer_name (a permit, a dispatch note, a
 * nameplate photo) used to make findOrCreateCustomer return null outright —
 * the document then never had an owner, for its whole life, since nothing
 * ever revisits an already-extracted document to try again. The owner's
 * rule is "never sit unowned silently": match an existing customer at that
 * exact address (ambiguous — more than one candidate — still refuses to
 * guess, same philosophy as selectCustomerMatch), or create a placeholder
 * customer named from the address (data.name_source='address', see
 * integrity.js's addressOnlyCustomerName) so a LATER document naming the
 * real occupant upgrades it in place (see the name-path's own placeholder
 * check below) instead of creating a duplicate.
 *
 * Address matching here is EXACT (normalizeAddressKey equality, plus
 * normalizeUnitKey when the incoming address names a unit — round-2 gap-4
 * fix, 2026-09-21) — no fuzzy scoring — because there is no name to
 * disambiguate with; two different candidates at the same normalized address
 * (and, when a unit is named, the same unit) is exactly the "don't know, so
 * don't guess" case selectCustomerMatch already refuses on the name side.
 *
 * Reviewer follow-up (2026-09-20): refuses outright for a likely SHOP address
 * (isLikelyShopAddress — the tenant's own address, or the letterhead pattern:
 * extracted as shop_address anywhere, or as service_address on several
 * documents naming several different customers). `shopContext` is the
 * `{tenantAddressKey, letterheadCounts}` a bulk caller (routes/integrity.js)
 * precomputed once for its whole loop; left undefined, it's computed here
 * (cheap — this only runs once per document at ingest/verify time).
 *
 * Reviewer NO-GO (2026-09-21, round 2, gap 4): live data showed a NAMED
 * customer ("Deborah Ortega @ 544 E Ray Rd...") coexisting with an
 * address-only placeholder ("Customer at 544 E Ray Rd...") for the identical
 * address — the permit that should have matched Deborah instead minted a
 * second row. Root cause: the candidate query below was `ORDER BY created_at
 * LIMIT 500` — for a tenant with more than 500 customers on file, that
 * silently drops any customer NOT among the oldest 500, so a real match sitting
 * just outside that window was never even considered before falling through
 * to "create a placeholder".
 *
 * Reviewer NO-GO (2026-09-21, round 3, item 1): the round-2 fix removed the
 * cap ENTIRELY, trading a silent-truncation bug for a full-tenant table scan
 * on every single address-only document — fine at 144 documents, not at
 * scale. Narrowed in SQL first, exact match still decides: extract the
 * incoming address's leading house number (houseNumberOf) and ILIKE-filter
 * service_address to values starting with "<number> " or "<number>,",
 * LIMIT 200 — a customer at a genuinely different street never shares that
 * exact house-number prefix, so this is a cheap, safe narrowing, not a
 * guess. When the address has no leading house number at all (rare — a rural
 * route, a lot number), falls back to a 200-row ILIKE prefix on the first 12
 * characters of normalizeAddressKey's own output. Either way this is a
 * pre-filter, not the decision: `matches` below still requires the EXACT
 * normalizeAddressKey(+unit) equality this function has always required, so
 * the only risk this narrowing adds is missing a real match that (a) shares
 * no house-number/12-char prefix with the incoming address — cannot happen,
 * both are the SAME address — or (b) sits outside the 200-row cap because
 * 200+ OTHER customers happen to share this exact house number across
 * different streets, the same "safe fallback" ceiling `findOrCreateCustomer`
 * already accepts for its own 200-row name cap (see its own KNOWN
 * LIMITATIONS note). houseNumberOf itself lives in integrity.js, shared with
 * routes/integrity.js's loadAddressPlaceholderCandidates so both call sites
 * narrow the identical way.
 */
async function findOrCreateCustomerByAddress(db, tenantId, address, facts, shopContext) {
  const addrKey = normalizeAddressKey(address);
  if (!addrKey) return null; // too sparse (a bare "Suite 4", say) to match safely
  const unitKey = normalizeUnitKey(address);

  const ctx = shopContext ?? await computeShopAddressContext(db, tenantId);
  if (isLikelyShopAddress(addrKey, ctx)) {
    console.log(JSON.stringify({ event: 'integrity.skip_shop_address', tenantIdHash: hashForLog(tenantId), addrKeyHash: hashForLog(addrKey) }));
    return null;
  }

  // Same per-tenant serialization as the name path below, keyed on the
  // address instead of a name: two documents for a brand-new address
  // arriving at the same instant must not both decide "create new".
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${tenantId}:customeraddr:${addrKey}`]);

  // Narrowed candidate query — see the round-3 doc comment above.
  const houseNumber = houseNumberOf(address);
  const candidates = houseNumber
    ? (await db.query(
        `SELECT id, data, customer_number FROM entities
          WHERE entity_type = 'customer' AND ${TENANT} AND merged_into IS NULL
            AND data->>'service_address' IS NOT NULL
            AND (data->>'service_address' ILIKE $1 OR data->>'service_address' ILIKE $2)
          LIMIT 200`,
        [`${houseNumber} %`, `${houseNumber},%`]
      )).rows
    : (await db.query(
        `SELECT id, data, customer_number FROM entities
          WHERE entity_type = 'customer' AND ${TENANT} AND merged_into IS NULL
            AND data->>'service_address' IS NOT NULL
            AND data->>'service_address' ILIKE $1
          LIMIT 200`,
        [`${addrKey.slice(0, 12)}%`]
      )).rows;
  let matches = candidates.filter((c) => normalizeAddressKey(c.data?.service_address) === addrKey);
  // A unit named on the incoming address (an apartment/suite complex) narrows
  // among several same-street candidates to the one sharing that unit, same
  // as planAddressPlaceholderAbsorptions (integrity.js) does for the heal
  // step — never widens a single unambiguous street match into a guess.
  if (matches.length > 1 && unitKey) {
    const unitMatches = matches.filter((c) => normalizeUnitKey(c.data?.service_address) === unitKey);
    if (unitMatches.length) matches = unitMatches;
  }

  // Round-3 fix (2026-09-21): the address-only path can carry a
  // customer_phone/customer_email too (a permit with a phone number but no
  // name field) — filtered against the same shop signals as the name path,
  // and it learns from this document's own shop_phone/shop_email either way.
  const { phone, email } = await resolveCustomerContact(db, tenantId, facts, ctx);

  if (matches.length === 1) {
    const existing = matches[0];
    const rawAddress = String(facts?.service_address ?? '').trim();
    const data = { ...(existing.data ?? {}) };
    let changed = false;
    if (rawAddress && (data.service_address == null || String(data.service_address).trim() === '')) {
      data.service_address = rawAddress;
      changed = true;
    }
    if (phone && (data.phone == null || String(data.phone).trim() === '')) { data.phone = phone; changed = true; }
    if (email && (data.email == null || String(data.email).trim() === '')) { data.email = email; changed = true; }
    if (changed) {
      await db.query(`UPDATE entities SET data = $2, updated_at = NOW() WHERE id = $1 AND ${TENANT}`, [existing.id, data]);
    }
    return { id: existing.id, created: false, customerNumber: existing.customer_number, matchBasis: 'address' };
  }
  if (matches.length > 1) return null; // ambiguous (a landlord/HOA address) — refuse, don't guess

  const rawAddress = String(facts?.service_address ?? '').trim();
  const numRow = (await db.query('SELECT next_customer_number($1) AS num', [tenantId])).rows[0];
  const initialData = { service_address: rawAddress, customer_name: addressOnlyCustomerName(rawAddress), name_source: 'address' };
  if (phone) initialData.phone = phone;
  if (email) initialData.email = email;
  const created = (await db.query(
    `INSERT INTO entities (tenant_id, entity_type, data, customer_number, created_at, updated_at)
     VALUES ($1,'customer',$2,$3,NOW(),NOW()) RETURNING id, customer_number`,
    [tenantId, initialData, numRow?.num ?? null]
  )).rows[0];
  return { id: created.id, created: true, customerNumber: created.customer_number, matchBasis: 'created' };
}

function makeStore(db, tenantId) {
  const one = async (sql, params) => (await db.query(sql, params)).rows[0] ?? null;
  const ownedBy = (table, param) => `EXISTS (SELECT 1 FROM ${table} WHERE id = ${param} AND ${TENANT})`;
  const notFound = (msg) => Object.assign(new Error(msg), { status: 404, statusCode: 404, code: 'NOT_FOUND' });
  const many = async (sql, params) => (await db.query(sql, params)).rows;

  /** Build "SET a=$2, b=$3" from an allowlist. Never interpolates caller keys. */
  const setClause = (updates, allowed, startAt = 2) => {
    const cols = Object.keys(updates).filter((k) => allowed.includes(k));
    const sets = cols.map((c, i) => `${c} = $${i + startAt}`);
    return { sets, values: cols.map((c) => updates[c]) };
  };

  // `touch`: tables the Ask answer cache's corpus_stamp watches via
  // max(updated_at) (api/_lib/askCache.js) — every update must bump it, or a
  // cached answer can outlive the change it no longer reflects. Guarded by
  // documentsHaveUpdatedAt() so a deploy that lands before migration 17 is
  // pasted degrades to "no bump" instead of breaking ingestion with 42703.
  const updater = (table, allowed, { touch = false } = {}) => async (id, updates) => {
    const { sets, values } = setClause(updates, allowed);
    if (!sets.length) return;
    if (touch && (await documentsHaveUpdatedAt(db))) sets.push('updated_at = NOW()');
    await db.query(
      `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 AND ${TENANT}`,
      [id, ...values]
    );
  };

  return {
    tenantId,

    // ---- documents ----
    // uploaded_by (M3-config/20): the Clerk user id that requested this
    // upload (api/upload-url.js), guarded by documentsHaveUploadedBy() —
    // see that probe's own comment. Left NULL/never overwritten on a repeat
    // upload of the same bytes (COALESCE keeps whoever uploaded it first).
    createDocument: async (d) => {
      // R30 H1 (defence in depth; api/records.ts also strips it): a storage_key is only ever `<tenantId>/...`.
      // The INSERT below would otherwise store a foreign key AND overwrite the existing one on conflict.
      if (d.storage_key != null && !keyBelongsToTenant(d.storage_key, tenantId)) {
        const err = new Error('storage_key is not in this tenant');
        err.status = 400;
        throw err;
      }
      if (await documentsHaveUploadedBy(db)) {
        return one(
          `INSERT INTO documents (tenant_id, batch_id, original_filename, document_type,
                                  sha256_hash, file_size_bytes, stage, storage_key,
                                  content_type, uploaded_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'received'),$8,$9,$10,NOW())
           ON CONFLICT (tenant_id, sha256_hash) DO UPDATE
             SET storage_key = COALESCE(EXCLUDED.storage_key, documents.storage_key),
                 uploaded_by = COALESCE(documents.uploaded_by, EXCLUDED.uploaded_by)
           RETURNING id, (xmax = 0) AS inserted`,
          [tenantId, d.batch_id ?? null, d.original_filename, d.document_type ?? null,
           d.sha256_hash, d.file_size_bytes ?? null, d.stage,
           d.storage_key ?? null, d.content_type ?? null, d.uploaded_by ?? null]
        );
      }
      return one(
        `INSERT INTO documents (tenant_id, batch_id, original_filename, document_type,
                                sha256_hash, file_size_bytes, stage, storage_key,
                                content_type, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'received'),$8,$9,NOW())
         ON CONFLICT (tenant_id, sha256_hash) DO UPDATE
           SET storage_key = COALESCE(EXCLUDED.storage_key, documents.storage_key)
         RETURNING id, (xmax = 0) AS inserted`,
        [tenantId, d.batch_id ?? null, d.original_filename, d.document_type ?? null,
         d.sha256_hash, d.file_size_bytes ?? null, d.stage,
         d.storage_key ?? null, d.content_type ?? null]
      );
    },
    getDocument: (id) => one(`SELECT * FROM documents WHERE id = $1 AND ${TENANT}`, [id]),
    // Cascades to document_pages, facets and extractions through their FKs.
    // The tenant predicate is belt-and-braces next to RLS: a delete that
    // silently crossed a tenant boundary is not a bug you find later.
    deleteDocument: async (id) => {
      const r = await db.query(`DELETE FROM documents WHERE id = $1 AND ${TENANT}`, [id]);
      return r.rowCount;
    },
    listDocuments: (f = {}) => {
      const where = [TENANT];
      const vals = [];
      for (const [k, col] of [['stage', 'stage'], ['document_type', 'document_type'], ['batch_id', 'batch_id']]) {
        if (f[k] != null) { vals.push(f[k]); where.push(`${col} = $${vals.length}`); }
      }
      return many(`SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`, vals);
    },

    /**
     * R36: accurate totals for the whole shop, not for the newest-500 window the client graph loads. One pass over
     * `documents` (index-only on (tenant_id, stage) once M3-config/40 is pasted): the headline counts the Inbox badge,
     * the Intake pipeline strip and the "delete everything" confirmation need. `needsReview` is every document that is not
     * verified (the superset of the client's "Needs a person"; the client narrows it with the issues it can compute from
     * extractions, which is why those documents are also fetched, below).
     * @returns {Promise<{total: number, byStage: Record<string, number>, needsReview: number, verified: number}>}
     */
    reviewSummary: async () => {
      const r = await one(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE stage = 'received')::int AS received,
                count(*) FILTER (WHERE stage = 'read')::int AS read,
                count(*) FILTER (WHERE stage = 'mapped')::int AS mapped,
                count(*) FILTER (WHERE stage = 'linked')::int AS linked,
                count(*) FILTER (WHERE stage = 'verified')::int AS verified
           FROM documents WHERE ${TENANT}`,
        []
      );
      const byStage = { received: r?.received ?? 0, read: r?.read ?? 0, mapped: r?.mapped ?? 0, linked: r?.linked ?? 0, verified: r?.verified ?? 0 };
      const total = r?.total ?? 0;
      return { total, byStage, needsReview: total - byStage.verified, verified: byStage.verified };
    },

    /**
     * Live import progress for the Inbox (src/components/intake/ImportProgressPanel.tsx): how many documents are still
     * waiting to be read, how many finished reading in the last 10 minutes (the pace the time-left estimate uses) and
     * how many recent ones could not be read. "Still to read" is a received document with no error from the last three
     * days, plus a read document still inside its field-extraction window (15 minutes): anything older that never moved
     * is not an import in progress and must not hold the panel open forever. Also returns the same shop-wide stage
     * counts as reviewSummary so the panel can refresh them. One pass over `documents`, tenant-scoped like every read here.
     */
    importProgress: async () => {
      const r = await one(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE stage = 'received')::int AS received,
                count(*) FILTER (WHERE stage = 'read')::int AS read,
                count(*) FILTER (WHERE stage = 'mapped')::int AS mapped,
                count(*) FILTER (WHERE stage = 'linked')::int AS linked,
                count(*) FILTER (WHERE stage = 'verified')::int AS verified,
                count(*) FILTER (WHERE extract_error IS NULL AND (
                    (stage = 'received' AND created_at > NOW() - INTERVAL '3 days')
                 OR (stage = 'read' AND extracted_at > NOW() - INTERVAL '15 minutes')))::int AS pending,
                count(*) FILTER (WHERE extracted_at > NOW() - INTERVAL '10 minutes')::int AS read_last_10m,
                count(*) FILTER (WHERE extract_error IS NOT NULL AND created_at > NOW() - INTERVAL '3 days')::int AS failed_recent
           FROM documents WHERE ${TENANT}`,
        []
      );
      const byStage = { received: r?.received ?? 0, read: r?.read ?? 0, mapped: r?.mapped ?? 0, linked: r?.linked ?? 0, verified: r?.verified ?? 0 };
      const total = r?.total ?? 0;
      return {
        total, byStage, needsReview: total - byStage.verified, verified: byStage.verified,
        pending: r?.pending ?? 0, readLast10m: r?.read_last_10m ?? 0, failedRecent: r?.failed_recent ?? 0,
      };
    },

    /**
     * R36: the needs-review list, paged. Every document that is not verified, newest first, `limit` (max 200) per page,
     * resumed by an opaque keyset cursor (created_at, id), with the exact `total` (counted on the first page, carried in the
     * cursor after that). Rows are the plain `documents` rows listDocuments returns, so the client turns them into graph
     * documents exactly as it does for the newest 500. The "newest 500" cap is why a needs-review document older than that
     * was invisible; this has no cap.
     * @param {{cursor?: string|null, limit?: number}} [opts]
     */
    listUnverifiedDocuments: async ({ cursor = null, limit = 200 } = {}) => {
      const n = Number.isFinite(Number(limit)) && Number(limit) >= 1 ? Math.min(Math.trunc(Number(limit)), 200) : 200;
      const key = decodeBrowseKeysetCursor(cursor, 'unverified');
      const vals = [];
      let keysetSql = '';
      if (key) { vals.push(key.ts, key.id); keysetSql = 'AND (created_at, id) < ($1::timestamptz, $2::uuid)'; }
      const rows = await many(
        `SELECT *, created_at::text AS _created_at_raw FROM documents
          WHERE ${TENANT} AND stage <> 'verified' ${keysetSql}
          ORDER BY created_at DESC, id DESC LIMIT ${n + 1}`,
        vals
      );
      const more = rows.length > n;
      const page = more ? rows.slice(0, n) : rows;
      let total = key?.total ?? null;
      if (total == null) total = (await one(`SELECT count(*)::int AS n FROM documents WHERE ${TENANT} AND stage <> 'verified'`, []))?.n ?? 0;
      const last = page[page.length - 1];
      const nextCursor = more && last ? encodeBrowseKeysetCursor(last._created_at_raw, last.id, 'unverified', total) : null;
      return { rows: page.map(({ _created_at_raw, ...row }) => row), total, nextCursor };
    },

    /**
     * Records Browse (round 12 contract) — the paginated, filtered, faceted,
     * sortable, searchable replacement for the records screen's old "every
     * doc, capped at 500" list. See the big doc comment above TENANT (search
     * "RECORDS BROWSE") for the data model and every pure helper this calls.
     *
     * `rawFilters` is caller input, normalized here (never trusted directly);
     * `currentUserId` powers the `uploadedByMe` filter/facet only — nothing
     * else about the caller reaches SQL except through a bound parameter.
     *
     * Returns `{ rows, total, hasMore, nextCursor, facets }`. `facets` is one
     * entry per filterable dimension: `{ key, options: [{value, label, count}] }`
     * for an enumerated one, `{ key, trueCount }` for a boolean toggle — each
     * counted with every OTHER active filter applied but never its own, so
     * picking a facet option never removes it (or its siblings) from view.
     */
    /** @param {Record<string, unknown>} [rawFilters] @param {{currentUserId?: string|null, facets?: 'inline'|'none'}} [opts] */
    browseDocuments: async (rawFilters = {}, { currentUserId = null, facets: facetMode = 'inline' } = {}) => {
      const ctxB = await browseContext(db, rawFilters, currentUserId);
      const { f, hasDisplayName, hasFinancials, hasAudienceColumn, baseParams, filtersKey, allFrags } = ctxB;
      const limit = f.limit;
      const sortDef = BROWSE_SORTS[f.sort] ?? BROWSE_SORTS[DEFAULT_BROWSE_SORT];
      const wantFacets = facetMode === 'inline';
      const facetsPromiseFor = (offset) => (wantFacets && offset === 0 ? runBrowseFacets(db, ctxB, currentUserId) : Promise.resolve([]));

      // ---- R36 fast path: newest-first, answered page by page from `documents` -----------------------------------------
      // The default sort needs no per-document aggregates to ORDER, so the page is taken from documents in index order
      // and only those rows get their customer / fields looked up (a 50,000-document shop: first page ~2 s -> tens of ms).
      // A "load more" resumes from a keyset (created_at, id) instead of OFFSET, and carries the total it already counted.
      if (f.sort === 'upload-date') {
        const keyset = decodeBrowseKeysetCursor(f.cursor, filtersKey);
        const offset = keyset ? 0 : decodeBrowseCursor(f.cursor, filtersKey);
        const { sql: wherePart, params, candidateSql } = renderBrowseFragments(allFrags, baseParams);
        let keysetSql = '';
        let windowKeysetSql = '';
        const pageParams = [...params];
        if (keyset) {
          pageParams.push(keyset.ts, keyset.id);
          keysetSql = `AND (d.created_at, d.id) < ($${pageParams.length - 1}::timestamptz, $${pageParams.length}::uuid)`;
        }
        // A search that matches a lot (a common word) is best answered by walking the newest documents and testing each,
        // which stops after one page; a rare one by the indexed candidate set. Probe the newest SEARCH_WALK_WINDOW documents
        // with the per-document test: if they fill the page the term is dense and that IS the answer, otherwise use the set.
        let pageResult = null;
        if (f.q && !offset) {
          const w = renderBrowseFragments(allFrags, baseParams, { walk: true });
          const walkParams = [...w.params];
          if (keyset) {
            walkParams.push(keyset.ts, keyset.id);
            windowKeysetSql = `AND (dw.created_at, dw.id) < ($${walkParams.length - 1}::timestamptz, $${walkParams.length}::uuid)`;
          }
          const probe = await db.query(
            browsePageSelect(hasDisplayName, hasFinancials, w.sql, hasAudienceColumn, { windowSize: SEARCH_WALK_WINDOW, windowKeysetSql, limit: limit + 1 }),
            walkParams
          );
          if (probe.rows.length > limit) pageResult = probe;
        }
        // +1 row tells us whether another page exists without counting.
        if (!pageResult) {
          pageResult = await db.query(
            browsePageSelect(hasDisplayName, hasFinancials, wherePart, hasAudienceColumn, { candidateSql, keysetSql, limit: limit + 1, offset }),
            pageParams
          );
        }
        const hasMoreRows = pageResult.rows.length > limit;
        const rows = hasMoreRows ? pageResult.rows.slice(0, limit) : pageResult.rows;

        let total;
        if (keyset && keyset.total != null) total = keyset.total;
        else if (!hasMoreRows && offset === 0 && !keyset) total = rows.length; // the whole answer fit on one page
        else total = await countBrowseMatches(db, ctxB, allFrags);

        const facets = await facetsPromiseFor(keyset ? 1 : offset);
        const last = rows[rows.length - 1];
        return browseResult(rows, {
          total: Math.max(total, (keyset ? 0 : offset) + rows.length),
          hasMore: hasMoreRows,
          nextCursor: hasMoreRows && last ? encodeBrowseKeysetCursor(last.created_at_raw, last.id, filtersKey, total) : null,
          facets, sort: f.sort, limit,
        });
      }

      // ---- other sorts: ORDER BY needs the joined values, so the whole filtered set is built (as before) ----------------
      const offset = decodeBrowseCursor(f.cursor, filtersKey);
      const { sql: wherePart, params, candidateSql } = renderBrowseFragments(allFrags, baseParams);
      const listResult = await db.query(
        `${sharedBrowseCtes(hasDisplayName, hasFinancials, wherePart, hasAudienceColumn, { candidateSql })}
          SELECT *, count(*) OVER() AS total_matching FROM base
          ORDER BY ${sortDef.expr} ${sortDef.dir} NULLS LAST, id ${sortDef.dir}
          OFFSET ${offset} LIMIT ${limit}`,
        params
      );
      const facets = await facetsPromiseFor(offset);
      const rows = listResult.rows;
      const total = rows[0]?.total_matching != null ? Number(rows[0].total_matching) : 0;
      // Zero rows on this page doesn't mean zero total (a cursor past the end, or filters just changed) - the window
      // count above is only present on an actual row, so re-ask cheaply when the page itself came back empty.
      const trueTotal = rows.length ? total : await countBrowseMatches(db, ctxB, allFrags);
      return browseResult(rows, {
        total: trueTotal,
        hasMore: offset + rows.length < trueTotal,
        nextCursor: offset + rows.length < trueTotal ? encodeBrowseCursor(offset + rows.length, filtersKey) : null,
        facets, sort: f.sort, limit,
      });
    },

    /**
     * R36: the facets on their own (the same counts browseDocuments(…, {facets: 'inline'}) returns), so the Records screen
     * can paint the first page the moment it is ready and fill the filter chips in behind it. One pass over the filtered
     * set instead of ten, and a 60 s per-tenant cache for the same filters (they describe the whole set, change only when
     * documents arrive, and nobody needs them to the second).
     */
    /** @param {Record<string, unknown>} [rawFilters] @param {{currentUserId?: string|null, cache?: boolean}} [opts] */
    browseFacets: async (rawFilters = {}, { currentUserId = null, cache = true } = {}) => {
      const ctxB = await browseContext(db, rawFilters, currentUserId);
      const key = `${tenantId}|${ctxB.filtersKey}|${currentUserId ?? ''}`;
      if (cache) {
        const hit = browseFacetCache.get(key);
        if (hit !== undefined) return { facets: hit, cached: true };
      }
      const facets = await runBrowseFacets(db, ctxB, currentUserId);
      if (cache) browseFacetCache.set(key, facets);
      return { facets, cached: false };
    },

    // ---- billing read helpers (api/_lib/billing.js, api/_lib/plan.js) -------
    // Real COUNT queries, not listDocuments' capped-at-500 rows — billing caps
    // (tenants.limits.documentsStored / pagesPerMonth) need the true total.
    countDocuments: async () => {
      const r = await one(`SELECT count(*)::int AS n FROM documents WHERE ${TENANT}`, []);
      return r?.n ?? 0;
    },
    // Pages ingested since `sinceIso` (a document's page rows land at ingest
    // time, so "this month's pages" = document_pages created since the 1st).
    //
    // R35: the count never reaches back before the 1st (UTC) of the CURRENT month. Callers pass "now minus 30 days", but
    // the Billing screen, the 402 text and BILLING_RULES all promise the allowance resets on the 1st ("resets Oct 1"):
    // a shop that scanned 2,000 pages on Sep 25 was told it reset Oct 1 and was refused until Oct 25.
    // R43: the pages a staff import read (tenants.limits.staffImport, see staffImport.js) are left out of the count, so a
    // backfill never uses up (or is blocked by) the customer's monthly allowance. `excludeWindow` ({from, to} ISO strings)
    // may be passed when the caller already holds the tenant row (the upload gate does, so it costs nothing extra there);
    // `undefined` = look the company's own window up here (one primary-key read); null = exclude nothing. Still one index
    // range count for the pages themselves.
    // H-4: the page meter cannot be reset by deleting documents. M3-config/67 keeps a monthly tally (page_usage_monthly) that
    // only ever goes up (a trigger on document_pages adds each really-inserted page; staff-import pages are skipped by the same
    // rule as the live count). The number shown and enforced everywhere is GREATEST(this UTC month's tally, the live count
    // below): deleting lowers only the live part; if the tally is behind (migration just run, or pages written by older code)
    // the live part backstops it; and with the migration not run (probe says no table) it is exactly the live count as before.
    // The tally is for the CURRENT month, so it is used only when the caller's window reaches back to the 1st (callers pass
    // "now minus 30 days", which the month floor below clamps to the 1st).
    countPagesSince: async (sinceIso, excludeWindow = undefined) => {
      if (excludeWindow === undefined) {
        const t = await one(`SELECT limits -> 'staffImport' AS si FROM tenants WHERE id = (current_setting('app.tenant_id', true))::uuid`, []);
        excludeWindow = staffImportWindowFor({ limits: { staffImport: t?.si } });
      }
      const live =
        // No join to documents: document_pages carries its own tenant_id (RLS filters on it), and with
        // M3-config/63-page-count-index.sql this is an index range count (240k pages: 421 ms -> 4 ms). It runs on every
        // upload gate and every bootstrap, so it must not grow with the shop's whole history.
        `SELECT count(*)::int AS n FROM document_pages dp
          WHERE ${TENANT.replace('tenant_id', 'dp.tenant_id')}
            AND dp.created_at >= GREATEST($1::timestamptz, date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
            AND ($2::timestamptz IS NULL OR dp.created_at < $2::timestamptz OR dp.created_at >= $3::timestamptz)`;
      const params = [sinceIso, excludeWindow?.from ?? null, excludeWindow?.to ?? null];
      if (await pageCounterReady((sql, p) => db.query(sql, p))) {
        // page_usage_current_month() answers 0 (never an error) if the table vanished behind a warm probe.
        const r = await one(
          `SELECT GREATEST(
                    (${live}),
                    CASE WHEN $1::timestamptz <= (date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
                         THEN page_usage_current_month() ELSE 0 END
                  )::bigint AS n`,
          params
        );
        return Number(r?.n) || 0;
      }
      const r = await one(live, params);
      return r?.n ?? 0;
    },
    // R43: pages read between two instants (the staff import window), for the import page budget. Index range count.
    countPagesBetween: async (fromIso, toIso) => {
      const r = await one(
        `SELECT count(*)::int AS n FROM document_pages dp
          WHERE ${TENANT.replace('tenant_id', 'dp.tenant_id')}
            AND dp.created_at >= $1::timestamptz AND dp.created_at < $2::timestamptz`,
        [fromIso, toIso]
      );
      return r?.n ?? 0;
    },
    // R30 M6: estimated pages of documents that have been accepted (row exists) but not read yet, so the
    // monthly page cap counts work that is queued or in flight and not only pages already written. Recent
    // (24h, after which the cron sweep has re-attempted or given up), stage 'received', no error, no pages.
    // Per-document estimate, deliberately not below 1: photos 1; PDFs ~200 KB/page (max 200); text 6,000
    // chars/page (readDocument PAGE_CHARS). An estimate for gating only - nothing is billed from it.
    estimatePendingPages: async () => {
      const r = await one(
        `SELECT COALESCE(SUM(CASE
                  WHEN d.content_type ILIKE 'image/%' THEN 1
                  WHEN d.content_type ILIKE 'application/pdf' THEN GREATEST(1, LEAST(200, CEIL(COALESCE(d.file_size_bytes, 0) / 204800.0)))
                  -- Office build: Word / Excel / CSV by the same rule as plan.js estimatePagesForUpload (constants from office/limits.js)
                  WHEN d.content_type = '${DOCX_CONTENT_TYPE}' THEN GREATEST(1, LEAST(${ESTIMATE_DOCX_MAX_PAGES}, CEIL(GREATEST(0, COALESCE(d.file_size_bytes, 0) - ${ESTIMATE_DOCX_FIXED_BYTES}) / ${ESTIMATE_DOCX_BYTES_PER_PAGE}.0)))
                  WHEN d.content_type = '${XLSX_CONTENT_TYPE}' THEN GREATEST(1, LEAST(${ESTIMATE_SHEET_MAX_PAGES}, CEIL(GREATEST(0, COALESCE(d.file_size_bytes, 0) - ${ESTIMATE_XLSX_FIXED_BYTES}) / ${ESTIMATE_XLSX_BYTES_PER_PAGE}.0)))
                  WHEN d.content_type IN ('text/csv', 'text/tab-separated-values') THEN GREATEST(1, LEAST(${ESTIMATE_SHEET_MAX_PAGES}, CEIL(COALESCE(d.file_size_bytes, 0) / ${ESTIMATE_CSV_BYTES_PER_PAGE}.0)))
                  ELSE GREATEST(1, LEAST(200, CEIL(COALESCE(d.file_size_bytes, 0) / 6000.0)))
                END), 0)::int AS n
           FROM documents d
          WHERE ${TENANT.replace('tenant_id', 'd.tenant_id')}
            AND d.stage = 'received' AND d.extract_error IS NULL
            AND d.created_at >= NOW() - INTERVAL '24 hours'
            AND NOT EXISTS (SELECT 1 FROM document_pages dp WHERE dp.document_id = d.id)`
      );
      return r?.n ?? 0;
    },
    // `stage` and `storage_key` are DELIBERATELY NOT in this list, and that is
    // a security boundary rather than tidiness.
    //
    // api/records.ts hands `payload.updates` straight to this function, and
    // updater() allowlists column NAMES but never values. With `stage` here, an
    // authenticated caller could roll their own document backwards from
    // 'mapped' to 'received' — defeating the forward-only progression that
    // markExtracted and replaceDocumentFields carefully enforce everywhere else.
    //
    // `storage_key` was worse. This row is tenant-scoped, so a caller can only
    // update their OWN document — but the key it points at is not validated
    // against the tenant prefix anywhere, and getObject takes a bare key. Set
    // your own document's storage_key to another tenant's key, call
    // /api/read-document, and the pipeline fetches their bytes and transcribes
    // them into your account. A narrow primitive (it needs a known key) but a
    // real cross-tenant read, riding a column nobody meant to expose.
    //
    // Nothing legitimate loses anything: the only server-side caller of this
    // function writes document_type, and no client screen calls it at all.
    // Both columns are still written by the code that owns them —
    // markExtracted for stage, createDocument for storage_key.
    /**
     * Raw, tenant-scoped query. The transaction already has app.tenant_id set,
     * so RLS applies to every statement run through here exactly as it does
     * to the curated helpers. Exists so members.js, reviewStore.js and
     * opsStore.js can stop carrying private pools that re-implement the
     * SET LOCAL dance — three copies of a tenancy mechanism is three places
     * for it to drift.
     */
    raw: (sql, params) => db.query(sql, params),

    updateDocument: updater('documents', DOCUMENT_UPDATE_COLUMNS, { touch: true }),

    /**
     * Clear a stale extraction error after a successful extraction.
     *
     * Deliberately its own function rather than a column added to the allowlist
     * above — see the note there. The asymmetry it fixes: extract_error is SET
     * by a failed extraction but was only ever CLEARED by a successful READ. So
     * a document that failed extraction once and then extracted fine on retry
     * kept its error forever, and the browser treats any extract_error as
     * terminal. The user was told a document had failed while looking at a row
     * that held all of its data.
     */
    /**
     * mapped -> linked, forward-only, and only when there is something to link.
     *
     * Extraction already creates or matches the equipment entity and writes
     * entity_id onto every extraction row. That IS what "linked" means; the
     * stage just never said so, because nothing ever advanced past 'mapped'.
     * Same forward-only idiom as replaceDocumentFields' advance(): a stage is
     * never moved backwards from here, whatever the caller thinks.
     */
    markLinked: async (documentId) => {
      const r = await db.query(
        `UPDATE documents SET stage = 'linked'
          WHERE id = $1 AND ${TENANT} AND stage = 'mapped'
            AND EXISTS (SELECT 1 FROM extractions x
                         WHERE x.document_id = documents.id AND x.entity_id IS NOT NULL)`,
        [documentId]
      );
      return r.rowCount;
    },

    /**
     * ('read'|'mapped'|'linked') -> 'verified', set by the AI itself once
     * documentTypes.js's completenessFor says every required field is in and
     * confident. Same forward-only idiom as markLinked: guarded in SQL, never
     * trusts the caller's idea of the current stage, and re-checks the entity
     * link itself rather than trusting a pre-check done in JS. A document
     * already 'verified' (by a human or a previous AI pass) is left alone —
     * this never re-stamps verified_at or flips verified_by back to 'ai'.
     */
    verifyByAi: async (documentId) => {
      const r = await db.query(
        `UPDATE documents SET stage = 'verified', verified_by = 'ai', verified_at = NOW()
          WHERE id = $1 AND ${TENANT} AND stage IN ('read','mapped','linked')
            AND (
                  EXISTS (SELECT 1 FROM extractions x
                           WHERE x.document_id = documents.id AND x.entity_id IS NOT NULL)
               OR EXISTS (SELECT 1 FROM document_entity_links l
                           WHERE l.document_id = documents.id)
            )`,
        [documentId]
      );
      return r.rowCount;
    },

    clearExtractError: async (documentId) => {
      const r = await db.query(
        `UPDATE documents SET extract_error = NULL
          WHERE id = $1 AND ${TENANT} AND extract_error IS NOT NULL`,
        [documentId]
      );
      return r.rowCount;
    },

    // ---- facets ----
    // Parent ids are ownership-checked in the same statement: FK checks bypass RLS,
    // so without this a company could attach rows to another company's document.
    createFacet: async (f) => {
      const row = await one(
        `INSERT INTO facets (tenant_id, document_id, page_no, segment_id, label_raw, value_raw,
                             value_type_guess, confidence, created_at)
         SELECT $1,$2::uuid,$3,$4,$5,$6,$7,$8,NOW()
          WHERE ${ownedBy('documents', '$2::uuid')}
         RETURNING id`,
        [tenantId, f.document_id, f.page_no ?? null, f.segment_id ?? null,
         f.label_raw, f.value_raw, f.value_type_guess ?? null, f.confidence ?? null]
      );
      if (!row) throw notFound('document not found');
      return row;
    },
    getFacet: (id) => one(`SELECT * FROM facets WHERE id = $1 AND ${TENANT}`, [id]),
    listFacetsByDocument: (documentId) =>
      many(`SELECT * FROM facets WHERE document_id = $1 AND ${TENANT} ORDER BY page_no, id`, [documentId]),
    updateFacet: updater('facets', ['mapped_entity_type', 'mapped_field_key', 'mapping_confidence', 'mapping_method', 'value_raw']),

    // ---- extractions ----
    createExtraction: async (e) => {
      if (await extractionsHaveUnitIndex(db)) {
        const row = await one(
          `INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value,
                                    confidence, source_facet_id, unit_index, created_at)
           SELECT $1,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,$8,NOW()
            WHERE ${ownedBy('documents', '$2::uuid')} AND ($3::uuid IS NULL OR ${ownedBy('entities', '$3::uuid')})
              AND ($7::uuid IS NULL OR ${ownedBy('facets', '$7::uuid')})
           RETURNING id`,
          [tenantId, e.document_id, e.entity_id ?? null, e.field_key, e.value ?? null,
           e.confidence ?? null, e.source_facet_id ?? null, e.unit_index ?? null]
        );
        if (!row) throw notFound('document, entity or facet not found');
        return row;
      }
      const row = await one(
        `INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value,
                                  confidence, source_facet_id, created_at)
         SELECT $1,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,NOW()
          WHERE ${ownedBy('documents', '$2::uuid')} AND ($3::uuid IS NULL OR ${ownedBy('entities', '$3::uuid')})
              AND ($7::uuid IS NULL OR ${ownedBy('facets', '$7::uuid')})
         RETURNING id`,
        [tenantId, e.document_id, e.entity_id ?? null, e.field_key, e.value ?? null,
         e.confidence ?? null, e.source_facet_id ?? null]
      );
      if (!row) throw notFound('document, entity or facet not found');
      return row;
    },
    getExtraction: (id) => one(`SELECT * FROM extractions WHERE id = $1 AND ${TENANT}`, [id]),
    listExtractionsByDocument: (documentId) =>
      many(`SELECT * FROM extractions WHERE document_id = $1 AND ${TENANT} ORDER BY id`, [documentId]),
    listExtractionsByEntity: (entityId) =>
      many(`SELECT * FROM extractions WHERE entity_id = $1 AND ${TENANT} ORDER BY id`, [entityId]),

    /**
     * Every extraction for many documents in ONE query.
     *
     * The sync hook loads up to 500 documents at once. Fetching each one's
     * fields separately was 500 round trips, so the hook never fetched them at
     * all — it hardcoded `extracted: []` and `linkedEntityIds: []` on every
     * synced document. That single shortcut is why a record built from a
     * document you just uploaded showed no facts and said "no documents are
     * linked" about the document that created it. One query, capped so a
     * document dense with repeatable fields cannot blow up the response.
     */
    listExtractionsByDocuments: async (documentIds) => {
      const ids = [...new Set((documentIds ?? []).filter((x) => typeof x === 'string'))].slice(0, 500);
      if (!ids.length) return [];
      // Guarded select (M3-config/19): NULL AS unit_index on a warm instance
      // that hasn't picked up the migration yet, same idiom as touch/
      // documentsHaveUpdatedAt above.
      const unitIndexCol = (await extractionsHaveUnitIndex(db)) ? 'unit_index' : 'NULL::smallint AS unit_index';
      return many(
        `SELECT id, document_id, entity_id, field_key, value, confidence, corrected_value, ${unitIndexCol}
           FROM extractions
          WHERE document_id = ANY($1::uuid[]) AND ${TENANT}
          ORDER BY document_id, id
          LIMIT 8000`,
        [ids]
      );
    },
    updateExtraction: async (id, updates) => {
      if (updates && updates.entity_id != null) {
        const ok = await one(`SELECT 1 AS ok FROM entities WHERE id = $1::uuid AND ${TENANT}`, [updates.entity_id]);
        if (!ok) throw notFound('entity not found');
      }
      return updater('extractions', ['value', 'confidence', 'entity_id'])(id, updates);
    },

    // ---- entities ----
    createEntity: (e) => one(
      `INSERT INTO entities (tenant_id, entity_type, data, created_at, updated_at)
       VALUES ($1,$2,$3,NOW(),NOW()) RETURNING id`,
      [tenantId, e.entity_type, e.data ?? {}]
    ),
    getEntity: (id) => one(`SELECT * FROM entities WHERE id = $1 AND ${TENANT}`, [id]),
    // R36: entities by id (the customers / units a needs-review document older than the newest 500 points at).
    listEntitiesByIds: async (ids) => {
      const list = [...new Set((ids ?? []).filter((x) => typeof x === 'string' && KEYSET_ID_RE.test(x)))].slice(0, 500);
      if (!list.length) return [];
      return many(`SELECT * FROM entities WHERE id = ANY($1::uuid[]) AND ${TENANT}`, [list]);
    },
    listEntities: (type) => type
      ? many(`SELECT * FROM entities WHERE entity_type = $1 AND ${TENANT} ORDER BY updated_at DESC LIMIT 500`, [type])
      : many(`SELECT * FROM entities WHERE ${TENANT} ORDER BY updated_at DESC LIMIT 500`, []),
    updateEntity: async (id, updates) => {
      if (updates.data === undefined) return;
      await db.query(
        `UPDATE entities SET data = $2, updated_at = NOW() WHERE id = $1 AND ${TENANT}`,
        [id, updates.data]
      );
    },

    // ---- proposals ----
    createProposal: (p) => one(
      `INSERT INTO proposals (tenant_id, kind, label, target_entity_type, target_field_key,
                              evidence, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'pending'),NOW()) RETURNING id`,
      [tenantId, p.kind, p.label, p.target_entity_type ?? null,
       p.target_field_key ?? null, p.evidence ?? {}, p.status]
    ),
    getProposal: (id) => one(`SELECT * FROM proposals WHERE id = $1 AND ${TENANT}`, [id]),
    listProposals: (status) => status
      ? many(`SELECT * FROM proposals WHERE status = $1 AND ${TENANT} ORDER BY created_at DESC`, [status])
      : many(`SELECT * FROM proposals WHERE ${TENANT} ORDER BY created_at DESC`, []),
    updateProposal: updater('proposals', ['status', 'resolved_at', 'resolved_by', 'label']),

    // ---- audit ----
    logAction: async (a) => {
      // audit_log.user_id is a uuid FK into `users`; the caller only has a
      // Clerk user id (a string like "user_2ab..."). Resolve it, and fall back
      // to NULL rather than failing the write — an audit row with an unknown
      // actor is worth more than no audit row.
      let userId = null;
      if (a.clerk_user_id) {
        const u = await one(
          `SELECT id FROM users WHERE clerk_user_id = $1 AND ${TENANT}`,
          [a.clerk_user_id]
        );
        userId = u?.id ?? null;
      }
      const changes = { ...(a.changes ?? {}) };
      if (!userId && a.clerk_user_id) changes.clerk_user_id = a.clerk_user_id;
      await db.query(
        `INSERT INTO audit_log (tenant_id, user_id, action, resource_type, resource_id, changes, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [tenantId, userId, a.action, a.resource_type ?? null,
         a.resource_id ?? null, changes]
      );
    },
    getAuditLog: (f = {}) => {
      const where = [TENANT];
      const vals = [];
      for (const k of ['action', 'resource_type', 'resource_id', 'user_id']) {
        if (f[k] != null) { vals.push(f[k]); where.push(`${k} = $${vals.length}`); }
      }
      return many(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, vals);
    },

    // ---- pages: what the documents actually say -------------------------
    //
    // This is the retrieval half of the system. R2 holds the bytes; these rows
    // hold the text plus a pointer back, so every answer can name the document
    // and page it came from.

    upsertPages: async (documentId, pages) => {
      // One statement, not one per page: a 40-page PDF should be one round trip.
      if (!pages?.length) return 0;
      const vals = [];
      const tuples = pages.map((pg, i) => {
        const b = i * 5;
        vals.push(tenantId, documentId, pg.page_no, pg.text ?? null, pg.r2_path ?? null);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
      });
      const r = await db.query(
        `INSERT INTO document_pages (tenant_id, document_id, page_no, text, r2_path)
         VALUES ${tuples.join(',')}
         ON CONFLICT (document_id, page_no)
         DO UPDATE SET text = EXCLUDED.text, r2_path = COALESCE(EXCLUDED.r2_path, document_pages.r2_path)`,
        vals
      );
      return r.rowCount;
    },

    // R35: "does this document already have page text?" - what the upload dedupe actually needs. upload-url used to call
    // listPages(), which returns EVERY page's full text, once per file: a batch of 50 already-uploaded multi-page
    // documents pulled megabytes out of Postgres only to look at `.length > 0`.
    hasPages: async (documentId) => {
      const r = await one(
        `SELECT EXISTS (SELECT 1 FROM document_pages WHERE document_id = $1 AND ${TENANT}) AS has`,
        [documentId]
      );
      return r?.has === true;
    },

    // One page's text (the cited page/sheet chunk of a Word/Excel/CSV file shown in the app). Tenant-scoped like every read here.
    getPage: (documentId, pageNo) => one(
      `SELECT page_no, text FROM document_pages WHERE document_id = $1 AND page_no = $2 AND ${TENANT}`,
      [documentId, pageNo]
    ),

    listPages: (documentId) => many(
      `SELECT id, page_no, text, r2_path FROM document_pages
        WHERE document_id = $1 AND ${TENANT} ORDER BY page_no`, [documentId]
    ),

    /**
     * Find the passages that could answer `question`.
     *
     * Two passes on purpose. Full-text ranking is right for prose ("when was
     * the compressor replaced"), and wrong for identifiers — Postgres's english
     * config mangles "CG-4021-A" into tokens that rank badly or not at all, and
     * a serial number is the single most common thing an HVAC dispatcher asks
     * about. So identifier-shaped tokens get a separate trigram/ILIKE pass and
     * are merged in, deduplicated by page.
     *
     * Returns excerpts via ts_headline, not whole pages: a scanned page can be
     * 4 KB of text, and shipping 20 of them into a prompt is what made the old
     * client-side "send everything" approach cost what it did.
     */
    // `documentIds`, when given, restricts every pass below to that set —
    // used by ask.js to scope a "C-00012: ..." question to one customer's own
    // documents (see api/ask.js's customer-number resolution). A non-null,
    // EMPTY array means "restrict to nothing", not "no restriction" — the
    // caller already knows this customer has zero documents and wants that
    // reflected, not silently ignored.
    searchPassages: async (question, limit = 12, { documentIds = null } = {}) => {
      const rows = new Map();
      const push = (list, source) => {
        for (const r of list) if (!rows.has(r.id)) rows.set(r.id, { ...r, matched_by: source });
      };
      if (documentIds && documentIds.length === 0) return [];
      // SEMANTIC HYBRID (api/_lib/search/hybrid.js): null when off. Otherwise the question's embedding is
      // requested NOW so the Voyage round trip overlaps the keyword queries below instead of following them.
      const sem = startSemantic(question);
      // R41: with M3-config/65 pasted, the page search runs through donovan_pages_by_text / donovan_pages_by_like (tenant-scoped,
      // index-using functions; see that file's header) and only the few pages that win are read in full and highlighted. Without
      // it, the inline queries below run exactly as before.
      const viaFn = await passageFunctionsExist(db);
      const identifierPageIds = new Set(); // pages an identifier/serial token matched (kept on top by the hybrid step)
      const scopeSql = documentIds ? ' AND p.document_id = ANY($__ids__::uuid[])' : '';
      const withIds = (params) => documentIds ? [...params, documentIds] : params;
      // The scoped queries below append documentIds as their LAST bind param;
      // $__ids__ is replaced with that param's real position so the same
      // scopeSql string works regardless of how many params precede it.
      const scoped = (sql, params) => {
        const withScope = documentIds ? sql.replace('__SCOPE__', scopeSql.replace('$__ids__', `$${params.length + 1}`)) : sql.replace('__SCOPE__', '');
        return db.query(withScope, withIds(params));
      };

      // OR, not AND. websearch_to_tsquery ANDs every term, so a real question
      // like "when does the warranty on the Whitmore Ave condenser expire"
      // matched nothing: the address is on page 1 and the warranty on page 2.
      // Building an OR query from the question's lexemes lets ts_rank_cd do the
      // work it is for — the page matching the most terms wins — instead of
      // requiring one page to contain all of them.
      const ftsSql = `
        WITH q AS (
          SELECT NULLIF(array_to_string(
                   tsvector_to_array(to_tsvector('english', $1)), ' | '
                 ), '')::tsquery AS tsq
        )
        SELECT p.id, p.document_id, p.page_no,
               d.original_filename, d.document_type, d.stage,
               ts_headline('english', p.text, q.tsq,
                 'MaxFragments=2, MaxWords=55, MinWords=20, FragmentDelimiter=" … ", StartSel="", StopSel=""') AS excerpt,
               ts_rank_cd(p.tsv, q.tsq) AS rank
          FROM document_pages p
          JOIN documents d ON d.id = p.document_id
          CROSS JOIN q
         WHERE p.${TENANT} AND q.tsq IS NOT NULL AND p.tsv @@ q.tsq __SCOPE__
         ORDER BY rank DESC
         LIMIT $2`;
      const ftsViaFnSql = `
        WITH q AS (
          SELECT NULLIF(array_to_string(
                   tsvector_to_array(to_tsvector('english', $1)), ' | '
                 ), '')::tsquery AS tsq
        )
        SELECT p.id, p.document_id, p.page_no,
               d.original_filename, d.document_type, d.stage,
               ts_headline('english', p.text, q.tsq,
                 'MaxFragments=2, MaxWords=55, MinWords=20, FragmentDelimiter=" … ", StartSel="", StopSel=""') AS excerpt,
               h.rank AS rank
          FROM donovan_pages_by_text($1, $2, $3::uuid[]) WITH ORDINALITY AS h(id, rank, ord)
          JOIN document_pages p ON p.id = h.id AND p.${TENANT}
          JOIN documents d ON d.id = p.document_id
          CROSS JOIN q
         ORDER BY h.ord`;
      push(
        (viaFn
          ? await db.query(ftsViaFnSql, [question, keywordCandidateLimit(limit, sem), documentIds ?? null])
          : await scoped(ftsSql, [question, keywordCandidateLimit(limit, sem)])).rows,
        'text'
      );

      // Belt and braces: if full-text search found nothing (an empty or
      // stale tsv column did exactly this in production once), fall back to
      // a plain case-insensitive match on the question's meaningful words so
      // a name or address still finds its page.
      if (rows.size === 0) {
        const words = [...new Set(
          (question.match(/[A-Za-z][A-Za-z'-]{3,}/g) ?? [])
            .map((w) => w.toLowerCase())
            .filter((w) => !STOPWORDS.has(w))
        )].slice(0, 6);
        for (const w of words) {
          const r = viaFn
            ? await db.query(
              `SELECT p.id, p.document_id, p.page_no,
                      d.original_filename, d.document_type, d.stage,
                      substring(p.text from greatest(1, position(lower($2) in lower(p.text)) - 120) for 320) AS excerpt,
                      0.5 AS rank
                 FROM donovan_pages_by_like($1, 4, $3::uuid[]) WITH ORDINALITY AS h(id, ord)
                 JOIN document_pages p ON p.id = h.id AND p.${TENANT}
                 JOIN documents d ON d.id = p.document_id
                ORDER BY h.ord`,
              [`%${w}%`, w, documentIds ?? null]
            )
            : await scoped(
            `SELECT p.id, p.document_id, p.page_no,
                    d.original_filename, d.document_type, d.stage,
                    substring(p.text from greatest(1, position(lower($2) in lower(p.text)) - 120) for 320) AS excerpt,
                    0.5 AS rank
               FROM document_pages p
               JOIN documents d ON d.id = p.document_id
              WHERE p.${TENANT} AND p.text ILIKE $1 __SCOPE__
              LIMIT 4`,
            [`%${w}%`, w]
          );
          push(r.rows, `word:${w}`);
        }
      }

      // Identifier-shaped tokens: anything with a digit and some length.
      // "1234ABC", "CG-4021-A", "40x25x1", "2019" all qualify; "the" does not.
      const ids = [...new Set(
        (question.match(/[A-Za-z0-9][A-Za-z0-9/-]{3,}/g) ?? [])
          .filter((t) => /\d/.test(t))
      )].slice(0, 5);

      for (const token of ids) {
        const like = `%${token}%`;
        const r = viaFn
          ? await db.query(
            `SELECT p.id, p.document_id, p.page_no,
                    d.original_filename, d.document_type, d.stage,
                    substring(p.text from greatest(1, position($2 in p.text) - 120) for 320) AS excerpt,
                    1.0 AS rank
               FROM donovan_pages_by_like($1, 5, $3::uuid[]) WITH ORDINALITY AS h(id, ord)
               JOIN document_pages p ON p.id = h.id AND p.${TENANT}
               JOIN documents d ON d.id = p.document_id
              ORDER BY h.ord`,
            [like, token, documentIds ?? null]
          )
          : await scoped(
          `SELECT p.id, p.document_id, p.page_no,
                  d.original_filename, d.document_type, d.stage,
                  substring(p.text from greatest(1, position($2 in p.text) - 120) for 320) AS excerpt,
                  1.0 AS rank
             FROM document_pages p
             JOIN documents d ON d.id = p.document_id
            WHERE p.${TENANT} AND p.text ILIKE $1 __SCOPE__
            LIMIT 5`,
          [like, token]
        );
        push(r.rows, `identifier:${token}`);
        for (const x of r.rows) identifierPageIds.add(x.id);
      }

      // SEMANTIC HYBRID: with `sem` null this is exactly the old keyword-only
      // `.sort(...).slice(0, limit)`; otherwise fuse in the vector hits (RRF), identifiers pinned.
      return finishHybrid(db, sem, {
        tenantId, question, limit, documentIds, identifierPageIds,
        // Pages an identifier/serial token matched come FIRST even when full-text found them with a lower rank (hybrid.js
        // pins them the same way once the semantic step runs; without it a part number / ticket number in a long sheet lost
        // to pages that merely repeat the question's common words).
        keywordRows: [...rows.values()].sort((a, b) =>
          (identifierPageIds.has(b.id) ? 1 : 0) - (identifierPageIds.has(a.id) ? 1 : 0) || b.rank - a.rank),
      });
    },

    /**
     * Structured facts the tenant already has mapped. Cheaper and far more
     * reliable than re-reading a page when the question is about a field the
     * pipeline has already extracted ("what's the model on unit 3").
     */
    searchExtractions: async (question, limit = 25, { documentIds = null } = {}) => {
      if (documentIds && documentIds.length === 0) return [];
      const tokens = [...new Set(
        (question.match(/[A-Za-z0-9][A-Za-z0-9/-]{3,}/g) ?? []).filter((t) => /\d/.test(t))
      )].slice(0, 5);
      if (!tokens.length) return [];
      const scopeSql = documentIds ? ' AND x.document_id = ANY($3::uuid[])' : '';
      const params = documentIds
        ? [tokens.map((t) => `%${t}%`), limit, documentIds]
        : [tokens.map((t) => `%${t}%`), limit];
      return many(
        `SELECT x.id, x.document_id, x.entity_id, x.field_key, x.value, x.confidence,
                d.original_filename, d.stage, e.entity_type, e.data
           FROM extractions x
           JOIN documents d ON d.id = x.document_id
      LEFT JOIN entities  e ON e.id = x.entity_id
          WHERE x.${TENANT} AND x.value ILIKE ANY($1::text[])${scopeSql}
          LIMIT $2`,
        params
      );
    },

    markExtracted: async (documentId, { page_count, error } = {}) => {
      await db.query(
        `UPDATE documents
            SET extracted_at = CASE WHEN $3::text IS NULL THEN NOW() ELSE extracted_at END,
                extract_error = $3,
                page_count = COALESCE($2, page_count),
                stage = CASE WHEN $3::text IS NULL AND stage = 'received' THEN 'read' ELSE stage END
          WHERE id = $1 AND ${TENANT}`,
        [documentId, page_count ?? null, error ?? null]
      );
    },

    /**
     * What the browser polls while ingestion runs in the queue.
     *
     * Reports the three things a progress row needs — did it finish, how many
     * pages, did it fail and why — plus how many fields came out, so a document
     * that read cleanly but yielded nothing is visibly different from one still
     * in flight.
     */
    getIngestStatus: (documentIds) => many(
      `SELECT d.id,
              d.original_filename,
              d.stage,
              d.document_type,
              d.verified_by,
              d.page_count,
              d.extracted_at,
              d.extract_error,
              (SELECT count(*) FROM extractions x
                WHERE x.document_id = d.id AND x.${TENANT}) AS field_count
         FROM documents d
        WHERE d.id = ANY($1::uuid[]) AND d.${TENANT}`,
      [documentIds]
    ),

    // ---- structured field extraction ------------------------------------
    //
    // Two rows per field, on purpose. `facets` carries the raw observation and
    // the PAGE it was read from; `extractions` carries the canonical field_key
    // and points back at the facet through source_facet_id. `extractions` has
    // no page column, so without that hop a warranty date on the entity screen
    // would be a number with nothing behind it — the one thing this product
    // promises never to show.
    //
    // Replace, never append. Re-reading a document has to converge on one set
    // of fields rather than stacking a second copy on the first. The delete is
    // scoped by segment_id to this extractor's own rows, so a human correction
    // or another pipeline's facets are never swept away with it — and it runs
    // before the facet delete, because source_facet_id is ON DELETE SET NULL
    // and would otherwise erase the link the delete needs.
    //
    // Residual gap, deliberately left: if a facet is ever deleted by something
    // OTHER than this function, its extraction's source_facet_id becomes NULL
    // and no longer matches the IN (...) below, so that row survives every
    // future re-run. Nothing deletes facets independently today. The fix is a
    // marker column on `extractions`, not a wider delete here — widening it to
    // NULL source_facet_id would sweep away human-entered corrections, which is
    // a far worse failure than one stale row.

    replaceDocumentFields: async (documentId, fields, { entityId = null } = {}) => {
      const doc = await one(`SELECT id FROM documents WHERE id = $1 AND ${TENANT}`, [documentId]);
      if (!doc) throw new Error('Document not found');

      await db.query(
        `DELETE FROM extractions
          WHERE document_id = $1 AND ${TENANT}
            AND source_facet_id IN (
                  SELECT id FROM facets
                   WHERE document_id = $1 AND ${TENANT} AND segment_id = ANY($2::text[]))`,
        [documentId, [FIELD_EXTRACT_SEGMENT, FIELD_RECHECK_SEGMENT]]
      );
      const delFacets = await db.query(
        `DELETE FROM facets WHERE document_id = $1 AND ${TENANT} AND segment_id = ANY($2::text[])`,
        [documentId, [FIELD_EXTRACT_SEGMENT, FIELD_RECHECK_SEGMENT]]
      );

      // Advance the pipeline stage so the browser can tell "read but not yet
      // mapped" apart from "finished". Only ever forwards: a document a human
      // has already linked or verified must not be walked backwards by a
      // re-read.
      //
      // This runs BEFORE the empty-fields return, not only after the insert. A
      // document that genuinely states nothing extractable is a real answer,
      // and it HAS finished — if the stage only advanced on the insert path,
      // every such document would sit at 'read' forever and the browser, which
      // waits for 'mapped', would poll it until the timeout and then report a
      // failure on work that had actually succeeded.
      const advance = () => db.query(
        `UPDATE documents SET stage = 'mapped'
          WHERE id = $1 AND ${TENANT} AND stage IN ('received', 'read')`,
        [documentId]
      );

      if (!fields?.length) {
        await advance();
        return { facets: 0, extractions: 0, replaced: delFacets.rowCount };
      }

      // The CTE below joins each new extraction to its facet on
      // (mapped_field_key, value_raw). normalizeFields() already guarantees that
      // pair is unique, but the SQL does not enforce it: a duplicate would make
      // the join fan out and write N x N extraction rows with no error at all.
      // Fail loudly here rather than let a future caller corrupt the table.
      const seen = new Set();
      for (const f of fields) {
        const pair = `${f.field_key}\u0000${f.value}`;
        if (seen.has(pair)) {
          throw new Error(`Duplicate field ${f.field_key}="${f.value}" passed to replaceDocumentFields`);
        }
        seen.add(pair);
      }

      // One statement for the whole document. The CTE joins each new extraction
      // to its own facet on (mapped_field_key, value_raw), which is unique here
      // because normalizeFields() has already collapsed duplicates — relying on
      // RETURNING coming back in VALUES order would be relying on luck.
      //
      // unit_index (M3-config/19) rides along in the same `input` unnest
      // either way — it costs nothing as an extra virtual column even before
      // the migration lands — but is only projected into the extractions
      // INSERT when the real column exists, guarded the same way as every
      // other unit_index read/write in this file (extractionsHaveUnitIndex).
      const hasUnitIndex = await extractionsHaveUnitIndex(db);
      const extractionsInsert = hasUnitIndex
        ? `INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value,
                                    confidence, source_facet_id, unit_index, created_at)
           SELECT $1, $2, $9, i.field_key, i.value, i.confidence, ins.id, i.unit_index, NOW()
             FROM input i
             JOIN ins ON ins.mapped_field_key = i.field_key AND ins.value_raw = i.value
           RETURNING id`
        : `INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value,
                                    confidence, source_facet_id, created_at)
           SELECT $1, $2, $9, i.field_key, i.value, i.confidence, ins.id, NOW()
             FROM input i
             JOIN ins ON ins.mapped_field_key = i.field_key AND ins.value_raw = i.value
           RETURNING id`;
      const r = await db.query(
        `WITH input AS (
           SELECT * FROM unnest($3::text[], $4::text[], $5::int[], $6::numeric[], $7::text[], $10::smallint[])
                     AS t(field_key, value, page_no, confidence, verbatim, unit_index)
         ), ins AS (
           INSERT INTO facets (tenant_id, document_id, page_no, segment_id, label_raw,
                               value_raw, confidence, mapped_field_key, mapping_method, created_at)
           SELECT $1, $2, i.page_no, $8, COALESCE(i.verbatim, i.field_key),
                  i.value, i.confidence, i.field_key, 'registry', NOW()
             FROM input i
           RETURNING id, mapped_field_key, value_raw
         )
         ${extractionsInsert}`,
        [
          tenantId,
          documentId,
          fields.map((f) => f.field_key),
          fields.map((f) => f.value),
          fields.map((f) => f.page_no ?? null),
          fields.map((f) => f.confidence ?? null),
          fields.map((f) => f.verbatim ?? null),
          FIELD_EXTRACT_SEGMENT,
          entityId,
          fields.map((f) => f.unit_index ?? null),
        ]
      );

      await advance();

      return { facets: fields.length, extractions: r.rowCount, replaced: delFacets.rowCount };
    },

    /**
     * The equipment this document is about, created if this is the first time
     * we have seen its serial.
     *
     * Serial number is the key because it is the only identifier an HVAC office
     * can be relied on to have: model numbers repeat across a fleet, addresses
     * change hands, and internal unit labels ("Unit 3") are only unique inside
     * one building. Returns null without one rather than inventing an entity.
     *
     * Merge is fill-only: a field already on the entity is never overwritten by
     * a later read. A blurry photo of a plate must not be able to clobber a
     * value a human already confirmed.
     */
    findOrCreateEquipment: async (facts) => {
      const serial = String(facts?.serial_number ?? '').trim();
      if (!serial) return null;
      // A placeholder is not an identity. "N/A" on an illegible nameplate is a
      // technician saying "I could not read this", and matching on it merges
      // every unreadable plate in the account into one entity — a Carrier
      // furnace and a Trane condenser at different addresses becoming a single
      // unit carrying one of their warranties. Treated the same as no serial.
      if (isPlaceholderSerial(serial)) return null;

      const incoming = {};
      // `warranty_expires` is deliberately NOT copied here. The warranty lives
      // in data.warranty, written by setEquipmentWarranty, which carries the
      // expiry together with whether it was printed or computed. Keeping a
      // second flat copy meant a fill-once field (never updated) sitting beside
      // a field rewritten on every extraction — two answers to the same
      // question on one row, guaranteed to disagree eventually.
      // The warranty-bearing fields are in this list ON PURPOSE. They were not,
      // and that was the hole: only these identity fields get the fill-once
      // protection below, so warranty_registered_date and friends flowed freely
      // from EVERY document that mentioned this serial straight into
      // deriveWarranty, and setEquipmentWarranty replaces the whole warranty
      // object. Any later document asserting a registration date — a forwarded
      // PDF, a customer's own paperwork, anything that reaches OCR — could
      // silently grant a unit a 10-year registered term it never earned, or
      // close a window that was still open. Fill-once means the first document
      // to state a warranty fact establishes it, and a later one cannot quietly
      // overwrite it; a correction is a human decision, not a side effect of
      // scanning the mail.
      for (const k of ['serial_number', 'model', 'manufacturer', 'equipment_type',
                       'tonnage', 'refrigerant', 'service_address', 'customer_name',
                       'installation_date', 'warranty_registered_date',
                       'warranty_expires', 'warranty_term', 'installed_by']) {
        const v = String(facts?.[k] ?? '').trim();
        if (v) incoming[k] = v;
      }

      // B2 (2026-09-19 adversarial audit, PROVEN against real Postgres): two
      // concurrent extraction transactions for the same tenant naming the
      // same brand-new serial (an install invoice split into two files, an
      // install + a same-day filter-change ticket) both reached the SELECT
      // below before either committed its INSERT, both saw "nothing exists",
      // and both inserted — two equipment rows for one physical unit, its
      // history split between them forever after (nothing self-heals it:
      // later documents deterministically match the earlier-created row).
      //
      // pg_advisory_xact_lock serializes concurrent creators of the SAME
      // (tenant, serial) pair without a schema change: the second transaction
      // blocks here until the first COMMITs or ROLLBACKs, at which point its
      // own SELECT sees the just-inserted row and takes the existing-entity
      // path instead of creating a duplicate. Session-level (`_xact_`, not
      // the non-transactional variant) so the lock releases automatically at
      // COMMIT/ROLLBACK regardless of how this function returns — no matching
      // unlock call to forget. hashtext() collapses the key to a bigint;
      // Postgres advisory locks take an integer, not a string, and a 64-bit
      // hash collision between two different (tenant, serial) pairs would
      // only ever cost unrelated inserts a moment of serialization, never a
      // wrong match (the SELECT itself is still keyed on the real serial).
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${tenantId}:equipment:${serial.toLowerCase()}`]);

      const existing = await one(
        `SELECT id, data FROM entities
          WHERE entity_type = 'equipment' AND ${TENANT}
            AND merged_into IS NULL
            AND lower(data->>'serial_number') = lower($1)
          ORDER BY created_at LIMIT 1`,
        [serial]
      );

      if (!existing) {
        const created = await one(
          `INSERT INTO entities (tenant_id, entity_type, data, created_at, updated_at)
           VALUES ($1,'equipment',$2,NOW(),NOW()) RETURNING id`,
          [tenantId, incoming]
        );
        return { id: created.id, created: true, data: incoming };
      }

      const data = { ...(existing.data ?? {}) };
      let changed = false;
      for (const [k, v] of Object.entries(incoming)) {
        if (data[k] == null || String(data[k]).trim() === '') { data[k] = v; changed = true; }
      }
      if (changed) {
        await db.query(
          `UPDATE entities SET data = $2, updated_at = NOW() WHERE id = $1 AND ${TENANT}`,
          [existing.id, data]
        );
      }
      // `data` goes back to the caller so warranty derivation can see what the
      // entity already knows. Without it, a service ticket that names no
      // manufacturer derives an EMPTY warranty and overwrites a correct one.
      return { id: existing.id, created: false, data };
    },

    // ---- customers ----------------------------------------------------
    //
    // See M3-config/05-customer-link.sql for the other half of this: the
    // entities.customer_id column, and the trigger that stops it pointing
    // anywhere but a customer row in the SAME tenant. A CHECK constraint can
    // enforce the single-row part of that (customer_id only on an equipment
    // row); it cannot look up the target row to check its type and tenant,
    // so that part is a trigger, not written here.

    /**
     * Find-or-create the customer a document is about.
     *
     * There is no serial-number equivalent for a person. `customer_name` is
     * free text off an invoice or work order, and two people can share a name
     * the way no two units share a serial. So identity here is INFERRED, not
     * read off a plate, and the rule is built to fail toward MORE customer
     * rows rather than merging two different people into one — a customer
     * record that quietly carries someone else's equipment (and someone
     * else's warranty status) is a privacy problem, not just an untidy table.
     *
     * MATCHING KEY: normalized customer_name, narrowed by service_address
     * when both the incoming document and a same-named candidate have one.
     *
     *   1. Collect every existing customer whose name matches, case-
     *      insensitively, with whitespace collapsed.
     *   2. If the incoming document states an address, drop any candidate
     *      that already has a DIFFERENT address on file. A candidate with no
     *      address yet is kept — nothing on it disagrees with this document.
     *   3. Exactly one candidate left -> that's the customer; a fill-only
     *      merge backfills whatever it was missing, same rule as
     *      findOrCreateEquipment: a value already there is never overwritten.
     *      Zero, or more than one, candidate left -> create a new customer
     *      instead of guessing. Two-or-more IS the "two Smiths" case this
     *      function must not merge through; a duplicate row a human can
     *      merge later is a far smaller defect than showing one customer
     *      another's equipment.
     *
     * KNOWN LIMITATIONS — accepted trade-offs, not bugs:
     *   - Two genuinely different customers with the SAME name at the SAME
     *     address (a duplex, or a parent and child at one house) will merge.
     *     Nothing in the documents this pipeline reads can tell them apart.
     *   - One real customer whose documents spell their address two
     *     different ways ("123 Main St" vs "123 Main Street") gets a second
     *     customer row instead of being recognized as the same person.
     *     Chosen on purpose: fragmentation is a visible, fixable annoyance;
     *     a false merge is a silent leak between two customers.
     *   - A customer with equipment at several real addresses (a landlord, an
     *     HOA) is created once per address for the same reason — this
     *     function has no signal that would tell "one customer, several
     *     properties" apart from "two customers who happen to share a name".
     *   - Candidate lookup is capped at 200 same-named rows (LIMIT below). A
     *     tenant with more than 200 customers sharing one exact name — not a
     *     real HVAC office — degrades to "always create new" for that name,
     *     which is the same safe fallback as a genuine ambiguous match.
     *
     * Returns null only when the document names NOBODY at all — no
     * customer_name AND no service_address (a name that is only whitespace
     * or punctuation counts as "no name" — normalizeMatchText). A
     * service_address with no name still resolves: see
     * findOrCreateCustomerByAddress above (owner root-cause fix, 2026-09-20)
     * — "never sit unowned silently" — but never for a likely SHOP address
     * (that function's own shop-address guard).
     *
     * @param {object} facts
     * @param {{tenantAddressKey: string|null, letterheadCounts: object}} [shopContext]
     *   optional precomputed shop-address signal (loadShopAddressContext
     *   below) — pass this from a bulk caller's loop so it isn't recomputed
     *   on every row; omitted, the address-only path computes it itself.
     */
    findOrCreateCustomer: async (facts, shopContext) => {
      const name = normalizeMatchText(facts?.customer_name);
      const address = normalizeMatchText(facts?.service_address);
      if (!name) {
        if (address) return findOrCreateCustomerByAddress(db, tenantId, address, facts, shopContext);

        // Round 4 item 4 (2026-09-21): no customer_name, no service_address —
        // but notes/status text sometimes still names someone ("Sarah Chen's
        // account", "for Mike Torres") without the model ever extracting a
        // customer_name fact. Narrow SQL only, same surname-LIKE shape as the
        // exact-name lookup below — never a full-tenant customer load (round-3
        // NO-GO on exactly that pattern). Only ever LINKS to an existing
        // customer, never creates one: a bare mention is not enough evidence
        // to mint a new customer record.
        const mention = extractNameMention(`${facts?.notes ?? ''} ${facts?.status ?? ''}`);
        if (mention) {
          const mentionSurname = normalizeSurname(mention).replace(/[%_]/g, '\\$&');
          const mentionCandidates = mentionSurname
            ? await many(
                `SELECT id, data, customer_number FROM entities
                  WHERE entity_type = 'customer' AND ${TENANT}
                    AND merged_into IS NULL
                    AND lower(data->>'customer_name') LIKE '%' || $1 || '%' ESCAPE '\\'
                  ORDER BY created_at LIMIT 200`,
                [mentionSurname]
              )
            : [];
          const match = matchNameMention(
            mention,
            mentionCandidates.map((c) => ({ id: c.id, name: c.data?.customer_name }))
          );
          if (match) {
            const row = mentionCandidates.find((c) => c.id === match.id);
            return { id: row.id, created: false, customerNumber: row.customer_number, matchBasis: 'name-mention' };
          }
        }
        return null;
      }

      const incoming = {};
      for (const k of ['customer_name', 'service_address']) {
        const v = String(facts?.[k] ?? '').trim();
        if (v) incoming[k] = v;
      }
      // customer_phone/customer_email (extractFields.js FIELD_SPECS) map onto
      // the customer's data.phone/data.email — see
      // handoffs/CUSTOMER_PROFILES_BRIEF_2026-09-20.md section A. Same
      // fill-once merge as every other field on this row (below): a value
      // already on file is never overwritten by a later document.
      //
      // Limit-test defect A (2026-09-20), round-3 fix (2026-09-21): a value
      // equal to THIS document's own shop_phone/shop_email extraction, the
      // tenant's configured phone/email, OR a previously-learned
      // known_shop_contacts value is never written as a customer's contact
      // info — that is the contractor's own letterhead number, not the
      // customer's, and writing it here is exactly how every customer ended
      // up sharing the shop's phone. resolveCustomerContact also LEARNS this
      // document's own shop_phone/shop_email (if any) into known_shop_contacts,
      // so a LATER document extracted with no shop_phone field of its own —
      // an old-prompt document, or a relink that never re-reads the page —
      // still gets the number filtered.
      const { phone, email } = await resolveCustomerContact(db, tenantId, facts, shopContext);
      if (phone) incoming.phone = phone;
      if (email) incoming.email = email;

      // B2, same race as findOrCreateEquipment above, same fix: serialize
      // concurrent creators of the same (tenant, normalized name) before the
      // candidate SELECT so two documents naming a brand-new customer at the
      // same moment can't both decide "nobody exists yet" and both insert.
      // Keyed on the customer name alone (not name+address): the whole point
      // of selectCustomerMatch's address-narrowing below is that MULTIPLE
      // real customers can share a name, and every one of them still needs to
      // serialize against every other insert under that same name — locking
      // only by the more specific key would let two inserts for the address-
      // ambiguous case race past each other.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${tenantId}:customer:${name.toLowerCase()}`]);

      // Bug A fix (2026-09-20): exact-name-only candidates missed the same
      // household spelled two ways ("Castillo" vs "Ray & Linda Castillo").
      // Widened with a surname ILIKE, so selectCustomerMatch's fuzzy path
      // (customerMatchScore: normalized address + surname/substring name
      // match) gets a chance to see the row at all. `%` and `_` are escaped
      // since a real customer name essentially never contains them, but a
      // stray one must not turn into an unbounded LIKE wildcard.
      const surname = normalizeSurname(name).replace(/[%_]/g, '\\$&');
      let candidates = await many(
        `SELECT id, data, customer_number FROM entities
          WHERE entity_type = 'customer' AND ${TENANT}
            AND merged_into IS NULL
            AND ( lower(data->>'customer_name') = lower($1)
               OR ($2::text <> '' AND lower(data->>'customer_name') LIKE '%' || $2 || '%' ESCAPE '\\') )
          ORDER BY created_at LIMIT 200`,
        [name, surname]
      );

      // Bug B fix (2026-09-20 limit test): a misspelled surname at the same
      // address ("Paterson" vs "Patterson") never matched the surname ILIKE
      // above — different strings, not substrings of each other — so
      // selectCustomerMatch never even saw the near-miss candidate to decide
      // on. normalizeAddressKey has no SQL equivalent, so this is a broader
      // SELECT (every customer with an address on file, capped the same as
      // findOrCreateCustomerByAddress's own query) filtered in JS and merged
      // in, deduplicated by id. selectCustomerMatch still decides: a
      // surname-fuzzy near-miss scores well under CUSTOMER_MATCH_THRESHOLD
      // (integrity.js's compareNamesStrict/evaluateCustomerMatch) and is
      // never auto-linked — this only makes sure it's SEEN, so a new
      // customer is created (not silently missed) and the pair surfaces in
      // the duplicates banner instead of vanishing entirely.
      if (address) {
        const addrKey = normalizeAddressKey(address);
        if (addrKey) {
          const byId = new Map(candidates.map((c) => [c.id, c]));
          const addressRows = await many(
            `SELECT id, data, customer_number FROM entities
              WHERE entity_type = 'customer' AND ${TENANT}
                AND merged_into IS NULL
                AND data->>'service_address' IS NOT NULL
              ORDER BY created_at LIMIT 200`,
            []
          );
          for (const row of addressRows) {
            if (byId.has(row.id)) continue;
            if (normalizeAddressKey(row.data?.service_address) === addrKey) byId.set(row.id, row);
          }
          candidates = [...byId.values()];
        }
      }

      const existing = selectCustomerMatch(candidates, { name, address });

      if (!existing) {
        // Upgrade-by-fuller-name (owner root-cause fix, 2026-09-20): before
        // creating a brand-new customer, check whether an ADDRESS-ONLY
        // placeholder (findOrCreateCustomerByAddress, above) already sits at
        // this exact address — an earlier document that named the address
        // but not the person. If so this document's real name replaces the
        // placeholder outright (never a fill-only merge: "Customer at 3247
        // Elm St" is not a name worth keeping once the real one is known),
        // so the same person never ends up as two customer rows.
        if (address) {
          const addrKey = normalizeAddressKey(address);
          if (addrKey) {
            const placeholders = await many(
              `SELECT id, data, customer_number FROM entities
                WHERE entity_type = 'customer' AND ${TENANT} AND merged_into IS NULL
                  AND data->>'name_source' = 'address'
                  AND data->>'service_address' IS NOT NULL
                ORDER BY created_at LIMIT 200`,
              []
            );
            const placeholder = placeholders.find((c) => isAddressOnlyCustomer(c.data) && normalizeAddressKey(c.data?.service_address) === addrKey);
            if (placeholder) {
              const data = { ...(placeholder.data ?? {}) };
              delete data.name_source;
              data.customer_name = incoming.customer_name;
              for (const [k, v] of Object.entries(incoming)) {
                if (k === 'customer_name') continue;
                if (data[k] == null || String(data[k]).trim() === '') data[k] = v;
              }
              await db.query(
                `UPDATE entities SET data = $2, updated_at = NOW() WHERE id = $1 AND ${TENANT}`,
                [placeholder.id, data]
              );
              return { id: placeholder.id, created: false, customerNumber: placeholder.customer_number, matchBasis: 'address-upgrade' };
            }
          }
        }
        // SECURITY DEFINER, advisory-locked per tenant (M3-config/15-customer-
        // profiles.sql) — serializes concurrent customer creations for the
        // SAME tenant the same way the pg_advisory_xact_lock just above
        // serializes concurrent creations of the same NAME, so two different
        // brand-new customers created in the same instant never race for the
        // same next number.
        const numRow = await one('SELECT next_customer_number($1) AS num', [tenantId]);
        const created = await one(
          `INSERT INTO entities (tenant_id, entity_type, data, customer_number, created_at, updated_at)
           VALUES ($1,'customer',$2,$3,NOW(),NOW()) RETURNING id, customer_number`,
          [tenantId, incoming, numRow?.num ?? null]
        );
        return { id: created.id, created: true, customerNumber: created.customer_number, matchBasis: 'created' };
      }

      const data = { ...(existing.data ?? {}) };
      let changed = false;
      for (const [k, v] of Object.entries(incoming)) {
        if (data[k] == null || String(data[k]).trim() === '') { data[k] = v; changed = true; }
      }
      // Round-3 fix (2026-09-21): the survivor's name used to be frozen at
      // whatever the FIRST document happened to spell it as ("Nguyen, T.")
      // even once a fuller name showed up later ("Tom & Mai Nguyen") — the
      // fill-only loop above only ever fills a BLANK customer_name, never
      // upgrades a non-blank one. chooseUpgradedCustomerName pins the exact
      // upgrade rule as a plain function (see scripts/verify-integrity.mjs).
      const storedName = String(existing.data?.customer_name ?? '').trim();
      const incomingName = String(incoming.customer_name ?? '').trim();
      const upgradedName = chooseUpgradedCustomerName(storedName, incomingName);
      if (upgradedName !== storedName) { data.customer_name = upgradedName; changed = true; }
      if (changed) {
        await db.query(
          `UPDATE entities SET data = $2, updated_at = NOW() WHERE id = $1 AND ${TENANT}`,
          [existing.id, data]
        );
      }
      // Limit-test defect D (2026-09-20): a name-only match (no incoming
      // address at all — selectCustomerMatch's `!address` branch, the single
      // same-name candidate) is right most of the time but is genuinely
      // ambiguous the moment a second same-surname customer shows up later —
      // order-dependent at link time, invisible after. `matchBasis` records
      // which path resolved this so the caller (extractDocument.js,
      // reviewStore.js, routes/integrity.js) can mark the resulting link
      // 'ai:name-only' instead of plain 'ai', which is what
      // routes/integrity.js's ambiguousNameOnlyLinks scan looks for.
      return { id: existing.id, created: false, customerNumber: existing.customer_number, matchBasis: address ? 'address' : 'name-only' };
    },

    /**
     * Read-only sibling of findOrCreateCustomer: same candidate query and the
     * same selectCustomerMatch decision, but never creates anything. Used by
     * api/_lib/routes/integrity.js's scan/fix, which must never mutate data
     * while merely looking for a suggestion.
     */
    suggestCustomer: async ({ customer_name, service_address } = {}) => {
      const name = normalizeMatchText(customer_name);
      if (!name) return null;
      const address = normalizeMatchText(service_address);
      const surname = normalizeSurname(name).replace(/[%_]/g, '\\$&');
      const candidates = await many(
        `SELECT id, data, customer_number FROM entities
          WHERE entity_type = 'customer' AND ${TENANT}
            AND merged_into IS NULL
            AND ( lower(data->>'customer_name') = lower($1)
               OR ($2::text <> '' AND lower(data->>'customer_name') LIKE '%' || $2 || '%' ESCAPE '\\') )
          ORDER BY created_at LIMIT 200`,
        [name, surname]
      );
      const match = selectCustomerMatch(candidates, { name, address });
      return match?.id ?? null;
    },

    /** Precompute the shop-address signal ONCE for a whole bulk loop (see
     *  computeShopAddressContext above) and pass the result into
     *  findOrCreateCustomer's `shopContext` param on every row, instead of
     *  each row recomputing it. Used by routes/integrity.js's linkDocuments/
     *  linkEquipmentCustomers fixes and its integrityScan report. */
    loadShopAddressContext: () => computeShopAddressContext(db, tenantId),

    /** Learn a newly-seen shop phone/email (see recordKnownShopContact's own
     *  doc comment) — exposed for routes/integrity.js's stripShopContact,
     *  which calls this for the exact value it just removed. */
    recordKnownShopContact: (args) => recordKnownShopContact(db, tenantId, args),

    /**
     * Link equipment to the customer a document said it belongs to.
     *
     * Fill-only, same principle as everywhere else in this file: it links
     * only when the equipment has NO customer yet (`customer_id IS NULL` is
     * part of the WHERE, not a separate read-then-write — one round trip, no
     * race between checking and setting). A later document naming a
     * different customer for the same serial — an OCR misread, or two
     * different customers' paperwork scanned into the same batch — does not
     * silently move the unit to someone else. Reassigning an already-linked
     * unit (a genuine resale) is a deliberate action this store does not
     * perform on the strength of one more document; it would need an
     * explicit admin action, out of scope here.
     *
     * Returns the row count (0 or 1) so a caller can tell "already linked,
     * no-op" apart from a real link — 0 is not an error.
     */
    setEquipmentCustomer: async (equipmentId, customerId) => {
      if (!equipmentId || !customerId) return 0;
      const r = await db.query(
        `UPDATE entities
            SET customer_id = $2, updated_at = NOW()
          WHERE id = $1 AND entity_type = 'equipment' AND customer_id IS NULL AND ${TENANT}`,
        [equipmentId, customerId]
      );
      return r.rowCount;
    },

    /**
     * Everything a customer screen needs in one query: each of the
     * customer's units together with the warranty state already computed and
     * stored on it (data->'warranty' — see setEquipmentWarranty). No join
     * back to `extractions` here on purpose: that table answers "what did
     * the paperwork say"; this answers "what units does this customer have
     * and is any of them due for something", which is exactly what already
     * lives on the equipment row.
     *
     * The TENANT predicate is the only tenancy check this needs. It is not
     * possible for an equipment row in tenant A to carry a customer_id
     * belonging to tenant B — the trigger in 05-customer-link.sql refuses
     * that at write time — so a caller cannot fish for another tenant's
     * equipment by guessing a foreign customerId: the WHERE below only ever
     * matches rows already confined to the caller's own tenant.
     */
    listCustomerEquipment: (customerId) => many(
      `SELECT id,
              data->>'serial_number'    AS serial_number,
              data->>'model'            AS model,
              data->>'manufacturer'     AS manufacturer,
              data->>'equipment_type'   AS equipment_type,
              data->>'service_address'  AS service_address,
              data->>'installation_date' AS installation_date,
              data->'warranty'          AS warranty,
              updated_at
         FROM entities
        WHERE entity_type = 'equipment' AND customer_id = $1 AND merged_into IS NULL AND ${TENANT}
        ORDER BY updated_at DESC`,
      [customerId]
    ),

    // ---- customer profiles (read side) ---------------------------------
    //
    // Backs api/_lib/routes/customers.js. `entities.customer_id` already
    // links an equipment row to its customer (M3-config/05-customer-link.sql);
    // what's missing for a profile screen is which DOCUMENTS belong to that
    // customer, and there is no single column for that — a document can name
    // a customer three different ways (see the module doc comment on
    // getCustomerDocumentLinks below). These queries return raw rows; the
    // union/dedupe and warranty-tier math are pure functions in
    // api/_lib/routes/customers.js so they're testable with no database.

    getCustomerByIdOrNumber: ({ id, number } = {}) => {
      if (id) return one(`SELECT * FROM entities WHERE id = $1 AND entity_type = 'customer' AND ${TENANT}`, [id]);
      if (number) return one(`SELECT * FROM entities WHERE customer_number = $1 AND entity_type = 'customer' AND ${TENANT}`, [number]);
      return Promise.resolve(null);
    },

    /**
     * Every (document_id, via) pair a customer's documents can be found
     * through, EXCEPT the name-match path (see listNameMatchedDocuments) —
     * kept separate because it takes its own params and is skipped entirely
     * when the customer has no address on file.
     *
     *   'direct'    — document_entity_links straight to this customer entity
     *                 (a customer-only document, or a human's manual link)
     *   'equipment' — this customer's equipment, reached either through
     *                 document_entity_links (secondary units on a multi-unit
     *                 document, or a manual link) OR extractions.entity_id
     *                 (the PRIMARY unit link every extracted document gets —
     *                 see extractDocument.js's markLinked/linkDocumentToEntity)
     *
     * UNION ALL, not UNION: a document reachable through more than one path
     * is intentionally returned more than once here; mergeDocumentVia()
     * collapses that in JS by priority, so the priority rule lives in one
     * testable place instead of being encoded twice (once in SQL dedup logic,
     * once in JS).
     */
    listCustomerDocumentLinks: (customerId) => many(
      `SELECT l.document_id AS document_id, 'direct' AS via, NULL::text AS serial
         FROM document_entity_links l
        WHERE l.entity_id = $1 AND ${TENANT.replace('tenant_id', 'l.tenant_id')}
        UNION ALL
       SELECT l.document_id, 'equipment' AS via, e.data->>'serial_number' AS serial
         FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
        WHERE e.customer_id = $1 AND e.entity_type = 'equipment' AND ${TENANT.replace('tenant_id', 'l.tenant_id')}
        UNION ALL
       SELECT x.document_id, 'equipment' AS via, e.data->>'serial_number' AS serial
         FROM extractions x JOIN entities e ON e.id = x.entity_id
        WHERE e.customer_id = $1 AND e.entity_type = 'equipment' AND ${TENANT.replace('tenant_id', 'x.tenant_id')}`,
      [customerId]
    ),

    /**
     * The one path above that is NOT keyed off any link: a document whose
     * extracted customer_name and service_address both match this customer's,
     * but that has never been linked to any entity at all — an unreviewed
     * document sitting loose in the inbox that nonetheless names this exact
     * customer. Requires BOTH facts to match (never name alone — see
     * selectCustomerMatch's reasoning on why an address-free match is unsafe);
     * skipped by the caller entirely when the customer has no address on file.
     */
    listNameMatchedDocuments: (name, address) => {
      if (!name || !address) return Promise.resolve([]);
      return many(
        `SELECT cn.document_id AS document_id, 'name-match' AS via, NULL::text AS serial
           FROM (SELECT document_id FROM extractions
                  WHERE field_key = 'customer_name' AND lower(value) = lower($1) AND ${TENANT}) cn
           JOIN (SELECT document_id FROM extractions
                  WHERE field_key = 'service_address' AND lower(value) = lower($2) AND ${TENANT}) sa
             ON sa.document_id = cn.document_id
          LIMIT 200`,
        [name, address]
      );
    },

    /** Document rows for a customer profile's Documents tab, one query for
     *  however many ids the union above produced. `service_date` is the
     *  single highest-confidence reading for that document, same "one extra
     *  correlated subquery, not a join that fans out" shape as
     *  getIngestStatus above. */
    listDocumentDetails: (documentIds) => {
      const ids = [...new Set((documentIds ?? []).filter((x) => typeof x === 'string'))].slice(0, 500);
      if (!ids.length) return Promise.resolve([]);
      return many(
        `SELECT d.id, d.original_filename, to_jsonb(d)->>'display_name' AS display_name, d.document_type, d.stage, d.verified_by, d.created_at,
                (SELECT x.value FROM extractions x
                  WHERE x.document_id = d.id AND x.field_key = 'service_date' AND ${TENANT.replace('tenant_id', 'x.tenant_id')}
                  ORDER BY x.confidence DESC NULLS LAST, x.id LIMIT 1) AS service_date
           FROM documents d WHERE d.id = ANY($1::uuid[]) AND ${TENANT.replace('tenant_id', 'd.tenant_id')}`,
        [ids]
      );
    },

    /** Other customers sharing this one's normalized name or address —
     *  merge candidates for the profile screen's "Merge duplicates" panel.
     *  Capped at 25: this is a hint list for a human, not an exhaustive
     *  report, and a name/address common enough to exceed 25 hits is not a
     *  real HVAC customer list. */
    listDuplicateCustomers: (customerId, name, address) => many(
      `SELECT id, customer_number, data
         FROM entities
        WHERE entity_type = 'customer' AND merged_into IS NULL AND id <> $1 AND ${TENANT}
          AND ( ($2::text <> '' AND lower(data->>'customer_name') = lower($2))
             OR ($3::text <> '' AND lower(data->>'service_address') = lower($3)) )
        LIMIT 25`,
      [customerId, name ?? '', address ?? '']
    ),

    /**
     * The Customers tab's list: one row per customer with the counts and
     * warranty JSON a profile card needs. `q` (already wrapped in '%...%' by
     * the caller, or null) matches name, address or customer number.
     * `warranties` is the raw jsonb array of each owned unit's
     * data->'warranty' — alertTier() (warrantyRules.js) is applied to it in
     * JS (see customers.js's tallyWarrantyAlerts), not here, so this store
     * never has to duplicate that date math in SQL. `last_activity` is the
     * max of: a linked document's created_at, a unit's extracted
     * service_date, and a unit's own updated_at (install/warranty edits) —
     * so a customer whose only recent event is a new/edited piece of
     * equipment doesn't read as stale.
     */
    listCustomersSummary: async ({ like = null, sort = 'recent', limit = 200, offset = 0, cap = 200 } = {}) => {
      // R35: `cap` is the page ceiling (200 for every screen). The customers CSV export passes a bigger one: it asked for
      // 10,000 rows and silently got 200, so a 10k-customer shop's "export everything" was missing 98% of its customers.
      const ceiling = Math.min(Math.max(Math.trunc(Number(cap)) || 200, 1), 20000);
      const lim = Math.min(Math.max(Number(limit) || 200, 1), ceiling);
      // `offset` (default 0 = the historical behaviour) backs the paging API: GET /api/v1/customers?limit=&cursor=.
      const off = Math.max(Math.trunc(Number(offset)) || 0, 0);
      const orderBy = sort === 'name' ? "c.data->>'customer_name' ASC NULLS LAST, c.id"
        : sort === 'docs' ? 'doc_count DESC NULLS LAST, c.id'
        : 'last_activity DESC NULLS LAST, c.id';
      // R41: with M3-config/65 pasted, the ORDER and the two numbers it sorts by (last_activity, doc_count) come from the
      // customer_activity summary (kept current by triggers; customer_activity_refresh() recomputes whatever changed, in this
      // same transaction, just before the list is read) and only the page's own rows are built up: a page costs the same at
      // 6,000 customers as at 60,000. Same rows, same order, same numbers as the query below (scripts/verify-r41-scale-queries.mjs
      // compares them on seeded data); that query is what runs when 65 has not been pasted.
      if (await customerSummaryReady(db)) {
        await db.query('SELECT customer_activity_refresh()');
        const filter = `AND ($1::text IS NULL OR c.data->>'customer_name' ILIKE $1
                                              OR c.data->>'service_address' ILIKE $1
                                              OR c.customer_number ILIKE $1)`;
        const caTenant = TENANT.replace('tenant_id', 'ca.tenant_id');
        const cTenant = TENANT.replace('tenant_id', 'c.tenant_id');
        const eTenant = TENANT.replace('tenant_id', 'e.tenant_id');
        const page = sort === 'name'
          ? `SELECT c.id, c.customer_number, c.data, ca.last_activity, ca.doc_count
               FROM entities c
               LEFT JOIN customer_activity ca ON ca.customer_id = c.id AND ${caTenant}
              WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND ${cTenant} ${filter}
              ORDER BY c.data->>'customer_name' ASC NULLS LAST, c.id
              LIMIT $2 OFFSET $3`
          : `SELECT c.id, c.customer_number, c.data, ca.last_activity, ca.doc_count
               FROM customer_activity ca
               JOIN entities c ON c.id = ca.customer_id
              WHERE ${caTenant} AND c.entity_type = 'customer' AND c.merged_into IS NULL AND ${cTenant} ${filter}
              ORDER BY ${sort === 'docs' ? 'ca.doc_count DESC, ca.customer_id' : 'ca.last_activity DESC NULLS LAST, ca.customer_id'}
              LIMIT $2 OFFSET $3`;
        const outerOrder = sort === 'name' ? "p.data->>'customer_name' ASC NULLS LAST, p.id"
          : sort === 'docs' ? 'p.doc_count DESC, p.id'
          : 'p.last_activity DESC NULLS LAST, p.id';
        return many(
          `WITH p AS (${page})
           SELECT p.id, p.customer_number, p.data,
                  COALESCE(p.doc_count, 0)::int AS doc_count,
                  ec.n AS equipment_count,
                  p.last_activity,
                  COALESCE(wa.warranties, '[]'::jsonb) AS warranties
             FROM p
            CROSS JOIN LATERAL (
              SELECT COUNT(*)::int AS n FROM entities e
               WHERE e.entity_type = 'equipment' AND e.customer_id = p.id AND ${eTenant}
            ) ec
             LEFT JOIN LATERAL (
              SELECT jsonb_agg(jsonb_build_object('id', e.id) || (e.data->'warranty') ORDER BY e.id) AS warranties
                FROM entities e
               WHERE e.entity_type = 'equipment' AND e.customer_id = p.id AND ${eTenant} AND e.data->'warranty' IS NOT NULL
            ) wa ON TRUE
            ORDER BY ${outerOrder}`,
          [like, lim, off]
        );
      }
      return many(
        `WITH c AS (
           SELECT id, customer_number, data, updated_at
             FROM entities
            WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT}
              AND ($1::text IS NULL OR data->>'customer_name' ILIKE $1
                                    OR data->>'service_address' ILIKE $1
                                    OR customer_number ILIKE $1)
         ),
         -- R41: only the units of the customers being listed (a name search lists a handful; this used to read every unit
         -- in the shop and every document of all of them before keeping a few rows).
         equip AS (
           SELECT id, customer_id, data->'warranty' AS warranty, updated_at
             FROM entities WHERE entity_type = 'equipment' AND customer_id IN (SELECT id FROM c) AND ${TENANT}
         ),
         doc_union AS (
           SELECT l.document_id, c.id AS customer_id
             FROM document_entity_links l JOIN c ON c.id = l.entity_id
            WHERE ${TENANT.replace('tenant_id', 'l.tenant_id')}
           UNION
           SELECT l.document_id, eq.customer_id
             FROM document_entity_links l JOIN equip eq ON eq.id = l.entity_id
            WHERE ${TENANT.replace('tenant_id', 'l.tenant_id')}
           UNION
           SELECT x.document_id, eq.customer_id
             FROM extractions x JOIN equip eq ON eq.id = x.entity_id
            WHERE ${TENANT.replace('tenant_id', 'x.tenant_id')}
         ),
         doc_agg AS (
           SELECT du.customer_id, COUNT(DISTINCT du.document_id) AS doc_count, MAX(d.created_at) AS last_doc
             FROM doc_union du JOIN documents d ON d.id = du.document_id
            GROUP BY du.customer_id
         ),
         service_agg AS (
           SELECT eq.customer_id, MAX(x.value::date) AS last_service
             FROM extractions x JOIN equip eq ON eq.id = x.entity_id
            WHERE x.field_key = 'service_date' AND x.value ~ '^\\d{4}-\\d{2}-\\d{2}$'
              AND ${TENANT.replace('tenant_id', 'x.tenant_id')}
            GROUP BY eq.customer_id
         ),
         equip_agg AS (
           SELECT customer_id, COUNT(*) AS n, MAX(updated_at) AS last_equip_update FROM equip GROUP BY customer_id
         ),
         -- R35: this used to be a correlated subquery in the SELECT list ("SELECT jsonb_agg(...) FROM equip eq WHERE
         -- eq.customer_id = c.id"), which scans EVERY unit once per customer row the sort has to look at: customers x
         -- units. At 10,000 customers x 20,000 units the last page of the Customers list took ~19 s (page one ~0.6 s
         -- only because LIMIT stopped it early). One grouped pass, joined, is the same answer in a single scan.
         warranty_agg AS (
           SELECT customer_id, jsonb_agg(jsonb_build_object('id', id) || warranty) AS warranties
             FROM equip WHERE warranty IS NOT NULL GROUP BY customer_id
         )
         SELECT c.id, c.customer_number, c.data,
                COALESCE(da.doc_count, 0)::int AS doc_count,
                COALESCE(ea.n, 0)::int         AS equipment_count,
                GREATEST(da.last_doc, sa.last_service::timestamptz, ea.last_equip_update) AS last_activity,
                -- 'id' merged onto each warranty object (owner defect report 2026-09-22, item 2a) so a dismissal can be
                -- keyed per unit, not just per tier — see routes/customers.js's tallyWarrantyAlerts/dismissedAlertKey.
                COALESCE(wa.warranties, '[]'::jsonb) AS warranties
           FROM c
           LEFT JOIN warranty_agg wa ON wa.customer_id = c.id
           LEFT JOIN doc_agg da ON da.customer_id = c.id
           LEFT JOIN service_agg sa ON sa.customer_id = c.id
           LEFT JOIN equip_agg ea ON ea.customer_id = c.id
          ORDER BY ${orderBy}
          LIMIT $2 OFFSET $3`,
        [like, lim, off]
      );
    },

    /** How many customers match `like` (same filter as listCustomersSummary) — the paging API's `total`. */
    countCustomersSummary: async ({ like = null } = {}) => {
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n FROM entities
          WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT}
            AND ($1::text IS NULL OR data->>'customer_name' ILIKE $1
                                  OR data->>'service_address' ILIKE $1
                                  OR customer_number ILIKE $1)`,
        [like]
      );
      return rows[0]?.n ?? 0;
    },

    // ---- warranty ---------------------------------------------------------
    //
    // The derivation lives on the equipment entity, NOT in `extractions`.
    // `extractions` is the table of things a page actually said, and every row
    // in it points back at a facet and a page number. A computed expiry has no
    // page behind it, so putting it there would quietly turn arithmetic into a
    // citation — the exact failure this product exists to avoid.
    //
    // Only stable values are stored: dates, term length, and whether the expiry
    // was printed or calculated. Never day counts. "19 days left to register"
    // is true for one day; storing it would mean every row is wrong by
    // tomorrow. Urgency is computed at read time from the dates below.

    setEquipmentWarranty: async (entityId, warranty) => {
      if (!entityId) return 0;
      const r = await db.query(
        `UPDATE entities
            SET data = COALESCE(data, '{}'::jsonb) || jsonb_build_object('warranty', $2::jsonb),
                updated_at = NOW()
          WHERE id = $1 AND entity_type = 'equipment' AND ${TENANT}`,
        [entityId, JSON.stringify(warranty ?? {})]
      );
      return r.rowCount;
    },

    /**
     * The units that need someone to do something, soonest first.
     *
     * Two populations in one pass:
     *   - registration deadline near or recently past, with nothing on file
     *     saying it was registered. This is the urgent one: the window is
     *     around 60 days from installation and missing it costs the homeowner
     *     five years of parts coverage.
     *   - parts warranty approaching its end, which is when an extended
     *     warranty is worth selling.
     *
     * All bounds are computed by the caller and passed as plain strings.
     * Comparisons are TEXT comparisons on ISO dates, which sort chronologically
     * — deliberately not a ::date cast, because a cast raises on any malformed
     * value and would turn one bad row into a 500 for the whole list.
     */
    listWarrantyAttention: ({ registerFrom, registerTo, expiringFrom, expiringTo, limit = 200 }) => many(
      `SELECT e.id,
              e.data->'warranty'            AS warranty,
              e.data->>'serial_number'      AS serial_number,
              e.data->>'model'              AS model,
              e.data->>'manufacturer'       AS manufacturer,
              e.data->>'service_address'    AS service_address,
              e.data->>'customer_name'      AS customer_name,
              e.data->'warranty'->>'registrationDeadline' AS registration_deadline,
              e.data->'warranty'->>'expires'              AS expires
         FROM entities e
        WHERE e.entity_type = 'equipment' AND e.${TENANT}
          AND (
                (    e.data->'warranty'->>'registrationOnFile' IS NULL
                 AND e.data->'warranty'->>'registrationDeadline' BETWEEN $1 AND $2 )
             OR (    e.data->'warranty'->>'expires' BETWEEN $3 AND $4 )
          )
        ORDER BY COALESCE(
                   e.data->'warranty'->>'registrationDeadline',
                   e.data->'warranty'->>'expires'
                 )
        LIMIT $5`,
      [registerFrom, registerTo, expiringFrom, expiringTo, limit]
    ),

    // ---- schema version ----
    getSchemaVersion: async () => {
      const r = await one(`SELECT version FROM schema_versions WHERE ${TENANT} ORDER BY version DESC LIMIT 1`, []);
      return r?.version ?? 1;
    },
    incrementSchemaVersion: async (description, changeKind) => {
      const r = await one(`SELECT version FROM schema_versions WHERE ${TENANT} ORDER BY version DESC LIMIT 1`, []);
      const next = (r?.version ?? 0) + 1;
      await db.query(
        `INSERT INTO schema_versions (tenant_id, version, change_kind, description, created_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [tenantId, next, changeKind ?? 'manual', description ?? null]
      );
      return next;
    },
  };
}
