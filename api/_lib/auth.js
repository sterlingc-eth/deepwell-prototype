/**
 * Server-side request authentication.
 *
 * Every api/ handler must call requireAuth() before doing any work. The UI gate
 * in src/App.tsx protects only the UI; these functions are a separate, publicly
 * reachable surface and have to verify the caller themselves.
 *
 * The tenant is derived from the verified token and is never read from the
 * request body — otherwise any caller could name any tenant and read their data.
 *
 * ---------------------------------------------------------------------------
 * MULTI-USER SHOPS (2026-09-18)
 *
 * Clerk Organizations are how a five-technician HVAC shop shares one account:
 * the org IS the tenant, and every technician who joins it lands in the same
 * `tenantId`. Before this change nothing ever read org claims, so every sign-up
 * fell through to the `user_${userId}` solo fallback below and each technician
 * silently got their own empty, unshared account.
 *
 * Clerk ships two session-token shapes and this file has to read both, because
 * a token minted under either can reach this endpoint:
 *
 *   - v2 (current, "compact") tokens carry org data under a single `o` claim:
 *       o: { id: "org_...", slg: "acme-hvac", rol: "admin", per: "...", fpm: "..." }
 *     `rol` has NO "org:" prefix — Clerk's built-in roles are "admin" or
 *     "member" here.
 *   - v1 (legacy, deprecated 2025-04-14 but still honored) tokens carry the
 *     same information as separate top-level claims:
 *       org_id: "org_...", org_slug: "acme-hvac", org_role: "org:admin"
 *     `org_role` DOES carry the "org:" prefix.
 *
 * Verified against Clerk's docs on 2026-09-18:
 *   - https://clerk.com/docs/guides/sessions/session-tokens (v1 vs v2 claim
 *     shapes, the "org:" prefix on legacy org_role, `o.{id,slg,rol,per,fpm}`)
 *   - https://clerk.com/docs/reference/backend/types/auth-object (the `Auth`
 *     object's orgId/orgRole/orgSlug fields, and that the v2 default session
 *     token includes an `email` claim)
 *
 * One thing this file could NOT fully pin down from the docs: whether `email`
 * is present on every account's default v2 session token, or only appears once
 * a project has customized its token (Clerk's own pages disagree in how they
 * describe this, and nothing here can be verified against a live Clerk
 * instance). `deriveAuth` below treats `email` as optional either way and
 * upsertMember (../_lib/members.js) never depends on it being present — see
 * the fallback there.
 * ---------------------------------------------------------------------------
 */
import { verifyToken } from "@clerk/backend";
import { upsertMember } from "./members.js";
import { TTLCache, logStage } from "./perf.js";

/** Origins whose tokens this API will accept. */
const AUTHORIZED_PARTIES = [
  "https://deepwellinc.vercel.app",
  "https://deepwelltechnology.com",
  "https://www.deepwelltechnology.com",
  "http://localhost:5173",
  "http://localhost:4173",
];

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

/**
 * Clerk's two built-in org roles are "admin" and "member"; a shop can also
 * define custom roles (Clerk Organizations supports custom roles/permissions).
 * requireRole() below only ever gates on "admin" vs. "everyone else", so any
 * role string that isn't literally "admin" collapses to "member" — the
 * least-privileged bucket — rather than guessing what a custom role should be
 * allowed to do.
 */
function normalizeOrgRole(rawRole) {
  if (rawRole == null) return null;
  const bare = String(rawRole).replace(/^org:/, "").trim().toLowerCase();
  if (!bare) return null;
  return bare === "admin" ? "admin" : "member";
}

/** A blank or whitespace-only string is not an id — treated the same as absent, so it can never masquerade as a real (falsy-but-truthy) tenant key. */
function cleanId(v) {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}

/**
 * Reads org claims defensively across both v1 and v2 token shapes. See the
 * module header for the exact shapes and the Clerk docs they were checked
 * against.
 */
function readOrgClaims(claims) {
  const orgId = cleanId(claims?.org_id) ?? cleanId(claims?.o?.id);
  const rawRole = claims?.org_role ?? claims?.o?.rol ?? null;
  return { orgId, orgRole: orgId ? normalizeOrgRole(rawRole) : null };
}

/**
 * Pure claim -> auth mapping, split out from requireAuth() so it can be unit
 * tested (scripts/verify-auth.mjs) against fabricated claim objects without a
 * network call, a real Clerk secret key, or mocking the SDK's internals.
 *
 * @param {Record<string, unknown>} claims  a verified Clerk JWT payload
 * @returns {{userId: string, orgId: string|null, orgRole: 'admin'|'member'|null,
 *            tenantId: string, email?: string}|null}
 *   null when the claims carry no usable subject — the caller should treat
 *   that the same as a failed verification.
 */
export function deriveAuth(claims) {
  const userId = claims?.sub ?? null;
  if (!userId || typeof userId !== "string") return null;

  const { orgId, orgRole } = readOrgClaims(claims ?? {});

  // Not load-bearing for tenancy (tenantId never depends on it), only used to
  // seed users.email on first upsert — see the module header's caveat above.
  const email =
    typeof claims?.email === "string"
      ? claims.email
      : typeof claims?.email_address === "string"
        ? claims.email_address
        : undefined;

  return {
    userId,
    orgId,
    orgRole,
    // Solo fallback: a user with no org is their own tenant, so isolation
    // holds either way and a shop joining later does not change this
    // contract. M3-config/07-multi-user.sql's merge_tenant() is exactly the
    // migration path off this fallback, for someone who uploaded solo and
    // then joined (or created) a shop.
    tenantId: orgId ?? `user_${userId}`,
    email,
  };
}

/** True once this identity belongs to a real shop (a Clerk organization), rather than the solo `user_<id>` fallback tenant. Routes and the UI gate onboarding / multi-user-only behavior on this instead of re-deriving it from tenantId's shape. */
export function hasShop(auth) {
  return Boolean(auth?.orgId);
}

const ROLE_RANK = { member: 1, admin: 2 };

/**
 * Throws AuthError(403) unless `auth`'s org role outranks or matches `role`
 * ("admin" satisfies a "member" requirement; "member" does not satisfy an
 * "admin" one). A solo tenant (no shop) has no org role at all and therefore
 * never satisfies any role requirement — see hasShop().
 *
 * Wired in wherever an admin-only action needs it: api/billing.js
 * (checkout/portal), api/_lib/routes/{keys,tenant-delete,tenant-export,
 * document-delete}.js — each guards with `if (hasShop(auth)) requireRole(auth, 'admin')`.
 *
 * @param {{orgRole: 'admin'|'member'|null}|null|undefined} auth
 * @param {'admin'|'member'} role
 */
export function requireRole(auth, role) {
  const need = ROLE_RANK[role];
  if (!need) throw new Error(`requireRole: unknown role "${role}"`);
  const have = ROLE_RANK[auth?.orgRole] ?? 0;
  if (have < need) {
    throw new AuthError(`This action requires the '${role}' role in your shop.`, 403);
  }
  return auth;
}

/**
 * @param {*} req
 * @param {{verify?: typeof verifyToken}} [deps]  Injectable for tests
 *   (scripts/verify-auth.mjs passes a fake `verify` so the suite runs with no
 *   network and no real Clerk secret key). Every real call site omits this and
 *   gets the actual `verifyToken` from @clerk/backend.
 * @returns {Promise<{userId: string, orgId: string|null, orgRole: 'admin'|'member'|null, tenantId: string, email?: string}>}
 * @throws {AuthError}
 */
/**
 * API_PERF_2026-09-22: requireAuth() used to run upsertMember() — its own
 * resolve_tenant() + SET LOCAL + INSERT...ON CONFLICT UPDATE, three more
 * sequential round trips — on EVERY single authenticated request from a shop
 * tenant, unconditionally, every time. The row it writes changes only when
 * the member's email or role changes (both rare — a role change is an admin
 * action, an email change is a Clerk account edit), so this cache skips the
 * write whenever the last successful upsert for this exact (orgId, userId,
 * orgRole, email) combination is still fresh. A role/email change is picked
 * up as soon as the NEXT token carrying it arrives (Clerk session tokens are
 * short-lived and reissued constantly), and worst case — this cache's own
 * TTL — is a few minutes' staleness on a denormalized directory row that
 * nothing security-relevant reads (requireRole() checks auth.orgRole straight
 * off the verified JWT claims, never this table).
 */
const MEMBER_UPSERT_TTL_MS = 5 * 60_000;
const memberUpsertCache = new TTLCache(MEMBER_UPSERT_TTL_MS, 1000);

function memberUpsertCacheKey(auth) {
  return `${auth.orgId}:${auth.userId}:${auth.orgRole ?? ""}:${auth.email ?? ""}`;
}

/** Test-only: clear the member-upsert cache between fixtures. */
export function _resetMemberUpsertCache() {
  memberUpsertCache.map.clear();
}

export async function requireAuth(req, { verify = verifyToken } = {}) {
  const timerStart = Date.now();
  const header = req?.headers?.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) throw new AuthError("Sign in required");

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    // Misconfiguration, not a client error — but never hand the caller detail.
    console.error("CLERK_SECRET_KEY is not set; refusing all API requests.");
    throw new AuthError("Server is not configured for authentication", 500);
  }

  let claims;
  const verifyStart = Date.now();
  try {
    claims = await verify(token, {
      secretKey,
      // Without this, ANY token minted by this Clerk instance is accepted —
      // including one issued to a different frontend or a JWT template.
      authorizedParties: AUTHORIZED_PARTIES,
    });
  } catch (err) {
    console.error("Token verification failed:", err?.message);
    throw new AuthError("Session is invalid or has expired");
  }
  const verifyMs = Date.now() - verifyStart;

  const auth = deriveAuth(claims);
  if (!auth) throw new AuthError("Session is invalid or has expired");

  // Best-effort, and only when there's a shop to be a member of: a solo
  // tenant has nobody but its one user, and `users` exists to answer "who is
  // in this shop", not to track solo accounts. Awaited (not fire-and-forget)
  // so the write has actually happened before a serverless instance can
  // freeze mid-request — see members.js's header for the connection-pool
  // trade-off this accepts. Never allowed to fail the request: a hiccup
  // writing a membership row must not take down every authenticated
  // endpoint in the product.
  let upsertMs = 0;
  let upsertSkipped = false;
  if (hasShop(auth)) {
    const cacheKey = memberUpsertCacheKey(auth);
    if (memberUpsertCache.get(cacheKey)) {
      upsertSkipped = true;
    } else {
      const upsertStart = Date.now();
      try {
        await upsertMember(auth);
        memberUpsertCache.set(cacheKey, true);
      } catch (err) {
        console.error("upsertMember failed (non-fatal):", err?.message);
      }
      upsertMs = Date.now() - upsertStart;
    }
  }

  logStage({ t: "auth", ms: Date.now() - timerStart, verifyMs, upsertMs, upsertSkipped, hasShop: hasShop(auth) });
  return auth;
}

/** Uniform 401/500 response. Never leaks internals to the caller. */
export function denyAuth(res, err) {
  const status = err?.status ?? 401;
  return res.status(status).json({ error: err?.message ?? "Sign in required" });
}
