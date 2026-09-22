/**
 * API-key authentication, layered on top of Clerk sessions.
 *
 * requireAuth() (./auth.js, owned by another engineer, not edited here) only
 * ever accepts a Clerk-issued JWT. That is fine for the browser app and wrong
 * for everything else that needs to call this API: a Chrome extension, an MMS
 * intake worker, an MCP server, a partner integration — none of them can hold
 * a Clerk session, and none of them should have to.
 *
 * requireAuthOrKey() is the drop-in replacement every route in this file's
 * "FILES YOU OWN" list uses instead of requireAuth(): if the bearer token
 * looks like one of our keys, verify it as a key; otherwise fall through to
 * requireAuth() UNCHANGED, so nothing about the existing Clerk-session path
 * moves.
 *
 * KEY FORMAT
 *   dw_live_<64 lowercase hex chars>   (crypto.randomBytes(32).toString('hex'))
 *
 * Chosen so a key can never be mistaken for a Clerk JWT (which is three
 * base64url segments joined by '.', and always starts "eyJ" — the base64 of
 * '{"'). Checking the "dw_live_" prefix is enough on its own; a Clerk JWT
 * containing "eyJ..." never starts with "dw_live_" and a key we minted never
 * starts with "eyJ", so isApiKey() below never has to guess.
 *
 * A key is shown to its creator exactly once, at creation (see api/keys.js).
 * Only its sha256 hash is ever persisted — this file hashes whatever it is
 * given and compares hashes, and never logs or returns a raw key.
 *
 * RLS SUBTLETY — read this before touching resolve_api_key
 *   The whole point of a key is to establish the tenant; a request carrying
 *   one has no tenant yet at the moment it is verified, so it cannot go
 *   through withTenant() (recordsStore.js), which requires a tenant key
 *   BEFORE it can SET LOCAL app.tenant_id and run anything. api_keys is RLS-
 *   protected (FORCE ROW LEVEL SECURITY) like every other table, so an
 *   ordinary query against it with no app.tenant_id set returns zero rows,
 *   always — that is not a bug to work around with a wider policy, it is the
 *   isolation model working as designed.
 *
 *   The fix already exists in this codebase for the identical problem:
 *   resolve_tenant() in M3-config/02-tenancy-fix.sql is a SECURITY DEFINER
 *   function that runs outside RLS to answer exactly one narrow question
 *   ("what tenant uuid does this Clerk org map to") before a tenant context
 *   exists. resolve_api_key() (M3-config/10-api-keys.sql) is the same pattern
 *   applied to key lookup: it takes only a hash, and returns only
 *   (id, tenant_id, scopes, tenant_key) for an unrevoked key with that exact
 *   hash — never a listing, never another tenant's rows, never the key
 *   material. No policy on api_keys is relaxed to make this work; the
 *   function is the only door.
 *
 *   ONE MORE STEP, specific to this codebase: every route reaches Postgres
 *   through withTenant({tenantKey, tenantName}), and withTenant ALWAYS calls
 *   resolve_tenant(tenantKey, ...) — it has no "I already know the uuid" path,
 *   because recordsStore.js is owned by another engineer and is not edited
 *   here. resolve_tenant looks a tenant up (or creates one) BY tenants.
 *   clerk_org_id. So verifyApiKey() below sets auth.tenantId to the tenant's
 *   real clerk_org_id (returned by resolve_api_key as tenant_key), not to the
 *   uuid resolve_api_key also returns — exactly the value a Clerk session
 *   would have produced. Passing the uuid instead would make resolve_tenant
 *   look for a tenant whose clerk_org_id EQUALS that uuid string, find
 *   nothing, and silently INSERT a second, spurious tenant — a real
 *   cross-tenant-adjacent bug this file must not introduce. The uuid itself
 *   is discarded once tenant_key is read off the row; every query still goes
 *   through the ordinary withTenant()/resolve_tenant() path unchanged.
 *
 * THE AUX POOL (POOL CONSOLIDATION, scale-readiness build, 2026-09)
 *   This file, rateLimit.js and usage.js all need to run a query outside — or
 *   before — an ordinary withTenant() transaction (resolve_api_key() has no
 *   tenant yet; the daily-cap and usage queries run against a small aux pool
 *   rather than opening a full tenant transaction for one narrow lookup).
 *   `getAuxPool()` used to open its own separate pg.Pool for exactly that.
 *   It now delegates to recordsStore.js's exported `getPool()` instead — one
 *   Postgres pool per warm instance, not two — while keeping its name and
 *   shape unchanged, since rateLimit.js and usage.js both import it by name.
 *   None of the SECURITY DEFINER-function reasoning below changes: no
 *   app.tenant_id is ever set on a connection checked out this way, and none
 *   is needed, because resolve_api_key()/get_tenant_limits()/
 *   increment_usage_counters()/get_usage_counters() are all SECURITY DEFINER
 *   and RLS never applies to them in the first place.
 */
import crypto from "node:crypto";
import { getPool } from "./recordsStore.js";
import { requireAuth, AuthError } from "./auth.js";
import { logStage } from "./perf.js";

export const KEY_PREFIX = "dw_live_";
const HEX64 = /^[0-9a-f]{64}$/;

export const SCOPES = Object.freeze(["read", "ingest", "ask"]);

/**
 * Shared by every file in this auth/limiting group (apiKeyAuth, rateLimit,
 * usage), all of which need to run a query outside — or before — an ordinary
 * withTenant() transaction: a handful of narrow, fast queries, never a
 * transaction of their own. Kept as its own named export (rather than having
 * each of those files import recordsStore.js's `getPool()` directly) so this
 * group's "we run outside a tenant transaction" pattern stays named and
 * greppable as one thing, even though the connections themselves now come
 * from recordsStore.js's single shared pool.
 */
export const getAuxPool = getPool;

/** Constant-shape check: does this bearer token look like one of our keys? */
export function isApiKey(token) {
  return typeof token === "string" && token.startsWith(KEY_PREFIX);
}

/** sha256, hex-encoded. The only form of a key that ever reaches the database. */
export function hashKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey, "utf8").digest("hex");
}

/**
 * Mint a new key. Returns the raw key (show once, never persisted) alongside
 * the fields that ARE persisted (hash + display prefix).
 */
export function generateKey() {
  const random = crypto.randomBytes(32).toString("hex"); // 64 hex chars
  const rawKey = `${KEY_PREFIX}${random}`;
  return {
    rawKey,
    keyPrefix: random.slice(0, 8),
    keyHash: hashKey(rawKey),
  };
}

function extractBearer(req) {
  const header = req?.headers?.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

/**
 * Look up a raw key and return the same shape requireAuth() returns, plus the
 * key-specific fields callers need for scope checks.
 *
 * @returns {Promise<{userId: string, orgId: null, tenantId: string, scopes: string[], viaKey: true, keyId: string}>}
 * @throws {AuthError}
 */
export async function verifyApiKey(rawKey) {
  const start = Date.now();
  if (!HEX64.test(rawKey.slice(KEY_PREFIX.length))) {
    // Right prefix, wrong shape — refuse before touching the database rather
    // than sending an obviously-malformed value into a query parameter.
    throw new AuthError("Invalid API key");
  }
  const keyHash = hashKey(rawKey);

  // NOT cached, deliberately (API_PERF_2026-09-22): a revoked key must stop
  // working on its very next request, not up to a cache TTL later. This is
  // already a single indexed round trip (resolve_api_key is SECURITY DEFINER,
  // one query), so there is no redundant work here to remove.
  let rows;
  try {
    ({ rows } = await getAuxPool().query("SELECT * FROM resolve_api_key($1)", [keyHash]));
  } catch (err) {
    console.error("API key lookup failed:", err?.message);
    throw new AuthError("Server is not configured for authentication", 500);
  } finally {
    logStage({ t: "auth_key", ms: Date.now() - start });
  }

  const row = rows[0];
  if (!row) throw new AuthError("Invalid or revoked API key");
  if (!row.tenant_key) {
    // Every tenant that can hold an api key was created through
    // resolve_tenant(), which always sets clerk_org_id. A missing one here
    // means data corruption, not a normal auth failure — refuse loudly rather
    // than guess a tenantKey and risk resolve_tenant minting a duplicate
    // tenant (see the file header).
    console.error(`api key ${row.id}: tenant ${row.tenant_id} has no clerk_org_id`);
    throw new AuthError("Server is not configured for authentication", 500);
  }

  return {
    userId: `key:${row.id}`,
    orgId: null,
    // The tenant's real Clerk-org key, NOT row.tenant_id — see file header.
    // Every downstream call is withTenant({ tenantKey: auth.tenantId, ... }),
    // unchanged from the Clerk-session path.
    tenantId: row.tenant_key,
    scopes: row.scopes ?? [],
    viaKey: true,
    keyId: row.id,
  };
}

/**
 * Drop-in replacement for requireAuth() that also accepts an API key.
 *
 * A Clerk session gets every scope implicitly (a signed-in human can do
 * anything the UI lets them do); a key only ever gets the scopes it was
 * minted with. Callers that need a specific scope should check
 * `auth.viaKey ? auth.scopes.includes(scope) : true` — assertScope() below
 * does exactly that.
 */
export async function requireAuthOrKey(req) {
  const token = extractBearer(req);
  if (isApiKey(token)) return verifyApiKey(token);
  return requireAuth(req);
}

/**
 * Enforce a scope on a resolved auth. No-op for a Clerk session (viaKey is
 * false/undefined); for a key, the scope must be present or this throws a 403
 * — distinct from AuthError's default 401, because the caller IS
 * authenticated, they just are not allowed to do this particular thing.
 */
export function assertScope(auth, scope) {
  if (!auth?.viaKey) return;
  if (!auth.scopes?.includes(scope)) {
    throw new AuthError(`This API key does not have the "${scope}" scope`, 403);
  }
}
